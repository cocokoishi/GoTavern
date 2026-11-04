#!/usr/bin/env node

// BENCHMARK PROFILE CAPTURE AND BASELINE GATE (GOAL 15.2; M2 row "pprof/benchstat capture").
//
// WHAT THIS DOES, in one run:
//   1. builds the package test binary once (`go test -c`) so every mode below measures the SAME binary and
//      `go tool pprof` can resolve symbols without a disappearing temp binary;
//   2. runs the benchmark set for `--rounds` rounds with `-benchmem`, parses ns/op, B/op and allocs/op per
//      benchmark, takes the MEDIAN of each, and compares it with the committed `tests/perf/bench-baseline.txt`;
//   3. runs the same set with -cpuprofile / -memprofile / -blockprofile / -mutexprofile, and a bounded subset
//      with -trace (a full-set trace is hundreds of megabytes and answers nothing extra);
//   4. writes the raw stdout, environment facts, pprof top tables and a comparison table into `--out-dir`,
//      which CI uploads as an artifact. NO NUMBER IN THE BASELINE LACKS A RAW ARTIFACT: the baseline header
//      names the raw run and the run id.
//
// WHY A HOST-FACTS GUARD. GOAL 15.2 forbids splicing numbers from different hosts. The baseline records
// goos/goarch/go version/GOMAXPROCS/runner image; this script REFUSES to compare when they differ (exit 2)
// unless `--ignore-host` is passed for a deliberate triage run. A local Windows number is therefore never
// compared with the CI baseline by accident.
//
// REGENERATION (only when an OBSERVATION legitimately changed -- GOAL 15.2 and the differential doctrine):
//
//   node scripts/bench-profiles.mjs --update-baseline --out-dir tests/perf/out
//
// That writes tests/perf/bench-baseline.txt and tests/perf/bench-baseline-raw.txt from a clean tree, with the
// commit, Go version and host facts in the header. On a CI runner it must be the runner that produced the
// baseline, and the raw output must be committed next to it.
//
// TEETH (documented in the lane report, reproduced by the workflow): a benchmark that stops calling
// `b.ReportAllocs` loses its B/op and allocs/op columns, and a benchmark that stops exercising the real route
// changes its ns/op by orders of magnitude. The first is caught by the MISSING-METRIC rule (a baseline metric
// that current output does not contain is a failure, never a skipped comparison); the second by the
// two-sided tolerance on ns/op, because a change that is dramatically FASTER is as suspect as one that is
// slower: it means the benchmark no longer measures the same work, and the baseline must be regenerated
// deliberately rather than silently accepted.
//
// USAGE
//   node scripts/bench-profiles.mjs                        # compare + profiles + trace
//   node scripts/bench-profiles.mjs --mode compare         # fast: comparison only
//   node scripts/bench-profiles.mjs --mode profiles        # profiles only (no baseline compare)
//   node scripts/bench-profiles.mjs --update-baseline      # regenerate the committed baseline (full set only)
//   node scripts/bench-profiles.mjs --bench 'ChatSummary' --rounds 2 --ignore-host   # local triage
//
// EXIT CODES: 0 all phases passed; 1 comparison regression or profile/trace failure; 2 usage error or
// incomparable host; 3 committed baseline absent (a candidate is written to --out-dir for review).

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const benchmarkPackageDirectory = path.join(repositoryRoot, 'internal', 'server');
const defaultBaseline = path.join(repositoryRoot, 'tests', 'perf', 'bench-baseline.txt');
const defaultRawBaseline = path.join(repositoryRoot, 'tests', 'perf', 'bench-baseline-raw.txt');
const defaultOutDirectory = path.join(repositoryRoot, 'tests', 'perf', 'out');

// TOLERANCES ARE PER METRIC, and the asymmetry is deliberate. ns/op is wall-clock on a shared runner, so it
// moves with CPU steal and scheduling; B/op and allocs/op are far more stable for the same binary and input.
// Every tolerance is TWO-SIDED (see the header): a large move in either direction means "same input is no
// longer being measured", which is exactly the failure the baseline exists to catch.
const METRIC_TOLERANCES = {
  'ns/op': 0.6,
  'B/op': 0.15,
  'allocs/op': 0.15,
};
const COMPARED_METRICS = ['ns/op', 'B/op', 'allocs/op'];
const TRACE_BENCHMARKS = 'BenchmarkChatSummary/chats_10_x_2MB|BenchmarkStaticPageLoad|BenchmarkChatCompletionAssemble/largest_recorded';

function usage(message) {
  if (message) console.error(`bench-profiles: ${message}\n`);
  console.error(`Usage: node scripts/bench-profiles.mjs [options]

  --mode <compare|profiles|trace|all>   phases to run (default all)
  --rounds <n>                          benchmark rounds for the comparison (default 3)
  --bench <regexp>                       benchmark selection (default 'Benchmark'; full set required to write a baseline)
  --baseline <file>                      committed baseline (default tests/perf/bench-baseline.txt)
  --out-dir <dir>                        artifact directory (default tests/perf/out)
  --update-baseline                      rewrite the committed baseline from this run (clean tree + full set only)
  --ignore-host                          triage only: compare despite a host-facts mismatch
  --no-build                             reuse an existing test binary in --out-dir
  --help`);
  process.exit(2);
}

function parseArguments(argv) {
  const options = {
    mode: 'all',
    rounds: 3,
    bench: 'Benchmark',
    baseline: defaultBaseline,
    outDir: defaultOutDirectory,
    updateBaseline: false,
    ignoreHost: false,
    build: true,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) usage(`missing value for ${argument}`);
      return argv[index];
    };
    switch (argument) {
      case '--mode': options.mode = next(); break;
      case '--rounds': options.rounds = Number(next()); break;
      case '--bench': options.bench = next(); break;
      case '--baseline': options.baseline = path.resolve(next()); break;
      case '--out-dir': options.outDir = path.resolve(next()); break;
      case '--update-baseline': options.updateBaseline = true; break;
      case '--ignore-host': options.ignoreHost = true; break;
      case '--no-build': options.build = false; break;
      case '--help': usage(); break;
      default: usage(`unknown argument ${argument}`);
    }
  }
  if (!['compare', 'profiles', 'trace', 'all'].includes(options.mode)) usage(`--mode ${options.mode} is not compare|profiles|trace|all`);
  if (!Number.isInteger(options.rounds) || options.rounds < 1 || options.rounds > 20) usage('--rounds must be 1..20');
  if (options.updateBaseline && options.bench !== 'Benchmark') usage('--update-baseline requires the full benchmark set');
  // Writing a baseline IS the compare phase: it needs the full set and does not need profiles/trace, which
  // would slow the measurement the baseline records.
  if (options.updateBaseline) options.mode = 'compare';
  return options;
}

function commandLine(command, args) {
  return `${command} ${args.map((argument) => (/\s/.test(argument) ? JSON.stringify(argument) : argument)).join(' ')}`;
}

function run(command, args, { cwd = repositoryRoot, allowFailure = false } = {}) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (result.error) {
    throw new Error(`could not run ${commandLine(command, args)}: ${result.error.message}`);
  }
  if (result.status !== 0 && !allowFailure) {
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
    throw new Error(`${commandLine(command, args)} exited ${result.status}\n${output.slice(-4000)}`);
  }
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function readTrackedFile(file, fallback) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return fallback;
  }
}

function goEnvironment() {
  const goVersion = run('go', ['version']).stdout.trim();
  const goEnv = run('go', ['env', 'GOOS', 'GOARCH', 'GOVERSION', 'GOTOOLCHAIN', 'GOFLAGS']).stdout.trim().split(/\r?\n/);
  return {
    go: goVersion,
    goos: goEnv[0] ?? '',
    goarch: goEnv[1] ?? '',
    goversion: goEnv[2] ?? '',
    gotoolchain: goEnv[3] ?? '',
    goflags: goEnv[4] ?? '',
  };
}

function environmentFacts(extra = {}) {
  const environment = goEnvironment();
  const git = run('git', ['rev-parse', 'HEAD'], { allowFailure: true });
  const dirty = run('git', ['status', '--porcelain'], { allowFailure: true }).stdout.trim();
  const cpus = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  return {
    recordedAt: new Date().toISOString(),
    commit: git.status === 0 ? git.stdout.trim() : 'unknown',
    workingTree: dirty === '' ? 'clean' : 'dirty',
    go: environment.go,
    goos: environment.goos,
    goarch: environment.goarch,
    goversion: environment.goversion,
    gotoolchain: environment.gotoolchain,
    goflags: environment.goflags,
    hostname: os.hostname(),
    platform: `${os.type()} ${os.release()}`,
    cpus: String(cpus),
    gomaxprocs: process.env.GOMAXPROCS ?? `default(${cpus})`,
    runnerOs: process.env.RUNNER_OS ?? 'not-ci',
    runnerImage: process.env.ImageOS ?? 'not-ci',
    runnerImageVersion: process.env.ImageVersion ?? 'not-ci',
    runnerName: process.env.RUNNER_NAME ?? os.hostname(),
    ...extra,
  };
}

function testBinaryName() {
  return process.platform === 'win32' ? 'server.test.exe' : 'server.test';
}

function buildTestBinary(options) {
  const binary = path.join(options.outDir, testBinaryName());
  fs.mkdirSync(options.outDir, { recursive: true });
  if (!options.build) {
    if (!fs.existsSync(binary)) throw new Error(`--no-build was passed but ${binary} does not exist`);
    return binary;
  }
  console.log(`bench-profiles: building the package test binary -> ${path.relative(repositoryRoot, binary)}`);
  run('go', ['test', '-c', '-o', binary, './internal/server']);
  if (!fs.existsSync(binary)) throw new Error('go test -c produced no test binary');
  return binary;
}

function benchArguments(options, extra) {
  const args = [
    '-test.run=^$',
    `-test.bench=${options.bench}`,
    '-test.benchmem',
    '-test.timeout=45m',
    ...extra,
  ];
  return args;
}

// parseBenchOutput turns one `go test -bench` stdout into one entry per benchmark ROUND. It reads the metric
// PAIRS from the line rather than assuming column order, so a line with MB/s does not shift the others.
function parseBenchOutput(output) {
  const rounds = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line.startsWith('Benchmark')) continue;
    const fields = line.trim().split(/\s+/);
    const name = fields[0].replace(/-\d+$/, '');
    if (!name.startsWith('Benchmark')) continue;
    const metrics = {};
    for (let index = 1; index < fields.length - 1; index += 1) {
      const value = Number(fields[index]);
      if (!Number.isFinite(value)) continue;
      const unit = fields[index + 1];
      if (Object.prototype.hasOwnProperty.call(METRIC_TOLERANCES, unit) || unit === 'MB/s') {
        metrics[unit] = value;
        index += 1;
      }
    }
    if (Object.keys(metrics).length === 0) continue;
    rounds.push({ name, metrics });
  }
  return rounds;
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

// aggregateRounds groups the same benchmark's rounds and takes a median per metric. It returns both the
// medians and the round count, because a single round is a data point and not a median.
function aggregateRounds(rounds) {
  const byName = new Map();
  for (const round of rounds) {
    if (!byName.has(round.name)) byName.set(round.name, []);
    byName.get(round.name).push(round.metrics);
  }
  const aggregated = new Map();
  for (const [name, metricRounds] of byName) {
    const metrics = {};
    for (const metric of new Set(metricRounds.flatMap((entry) => Object.keys(entry)))) {
      metrics[metric] = median(metricRounds.filter((entry) => entry[metric] !== undefined).map((entry) => entry[metric]));
    }
    aggregated.set(name, { metrics, rounds: metricRounds.length });
  }
  return aggregated;
}

function formatNumber(value) {
  if (value === undefined) return 'missing';
  if (value >= 100) return String(Math.round(value));
  if (value >= 1) return value.toFixed(2);
  return value.toFixed(4);
}

function formatBaseline(facts, aggregated) {
  const lines = [];
  lines.push('# GoTavern in-process benchmark baseline');
  lines.push('#');
  lines.push('# THIS FILE IS A GATE INPUT, NOT A WISH. scripts/bench-profiles.mjs compares the current run against');
  lines.push('# it and fails on a two-sided change beyond the per-metric tolerances, so a benchmark that starts');
  lines.push('# measuring different work is red until the baseline is regenerated DELIBERATELY (GOAL 15.2).');
  lines.push('#');
  lines.push('# The paired raw run is tests/perf/bench-baseline-raw.txt; every number here has it as its artifact.');
  lines.push('#');
  lines.push('# regenerate: node scripts/bench-profiles.mjs --update-baseline --out-dir tests/perf/out');
  lines.push('#             (from a CLEAN tree, on the same host facts as the comparison; commit both files)');
  for (const [key, value] of Object.entries(facts)) {
    lines.push(`# ${key}: ${value}`);
  }
  lines.push('#');
  lines.push('# benchmark\tmetric=value per column; medians over --rounds rounds of `go test -bench` on this host');
  lines.push('');
  const names = [...aggregated.keys()].sort();
  for (const name of names) {
    const metrics = aggregated.get(name).metrics;
    const columns = COMPARED_METRICS.map((metric) => `${metric}=${metrics[metric] ?? 'missing'}`);
    lines.push(`${name}\t${columns.join('\t')}`);
  }
  return `${lines.join('\n')}\n`;
}

function parseBaseline(text) {
  const facts = {};
  const benchmarks = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('# ') && line.includes(':')) {
      const separator = line.indexOf(':', 2);
      if (separator > 0) facts[line.slice(2, separator).trim()] = line.slice(separator + 1).trim();
      continue;
    }
    if (line.startsWith('#') || line.trim() === '') continue;
    const [name, ...columns] = line.split('\t');
    const metrics = {};
    for (const column of columns) {
      const [metric, value] = column.split('=');
      if (!metric || value === undefined) continue;
      const numeric = Number(value);
      if (Number.isFinite(numeric)) metrics[metric.trim()] = numeric;
    }
    benchmarks.set(name.trim(), metrics);
  }
  return { facts, benchmarks };
}

const HOST_FACT_KEYS = ['goos', 'goarch', 'goversion', 'gomaxprocs', 'runnerImage', 'runnerImageVersion'];

function compareBaseline(facts, baseline, current) {
  const incompatible = [];
  for (const key of HOST_FACT_KEYS) {
    const wanted = baseline.facts[key];
    const observed = facts[key];
    if (wanted !== undefined && observed !== undefined && wanted !== observed) {
      incompatible.push(`${key}: baseline ${wanted}, current ${observed}`);
    }
  }
  const rows = [];
  const failures = [];
  for (const name of [...baseline.benchmarks.keys()].sort()) {
    const baseMetrics = baseline.benchmarks.get(name);
    const currentMetrics = current.get(name)?.metrics;
    if (!currentMetrics) {
      rows.push({ name, verdict: 'MISSING BENCHMARK', detail: 'baseline has it, current run did not produce it' });
      failures.push(`${name}: benchmark disappeared from the current run`);
      continue;
    }
    const row = { name, verdict: 'PASS', deltas: {}, detail: '' };
    for (const metric of COMPARED_METRICS) {
      const baseValue = baseMetrics[metric];
      if (baseValue === undefined) continue;
      const currentValue = currentMetrics[metric];
      if (currentValue === undefined) {
        // THE REPORTALLOCS TEETH: a baseline metric that current output cannot supply is a failure, never a
        // silently skipped column. The usual cause is deleting b.ReportAllocs, and tolerating it would make
        // every allocation regression invisible.
        row.verdict = 'MISSING METRIC';
        row.detail = `${metric} missing from current output (b.ReportAllocs removed?)`;
        failures.push(`${name}: ${row.detail}`);
        continue;
      }
      const delta = baseValue === 0 ? (currentValue === 0 ? 0 : Infinity) : (currentValue - baseValue) / baseValue;
      row.deltas[metric] = delta;
      const tolerance = METRIC_TOLERANCES[metric];
      if (Number.isFinite(delta) && Math.abs(delta) > tolerance) {
        row.verdict = delta > 0 ? 'REGRESSION' : 'SPEEDUP';
        row.detail = `${metric} moved ${(delta * 100).toFixed(1)}% (tolerance +/-${(tolerance * 100).toFixed(0)}%); same input no longer measured, regenerate the baseline deliberately if the change is intended`;
        failures.push(`${name}: ${row.detail}`);
      } else if (!Number.isFinite(delta)) {
        row.verdict = 'REGRESSION';
        row.detail = `${metric} changed from 0 to ${currentValue}`;
        failures.push(`${name}: ${row.detail}`);
      }
    }
    rows.push(row);
  }
  for (const name of [...current.keys()].sort()) {
    if (!baseline.benchmarks.has(name)) {
      rows.push({ name, verdict: 'NEW BENCHMARK', detail: 'not in the committed baseline; commit a regenerated baseline' });
      failures.push(`${name}: benchmark is not in the committed baseline`);
    }
  }
  return { incompatible, rows, failures };
}

function writeComparisonTable(target, rows, baselinePath) {
  const lines = [];
  lines.push(`baseline: ${path.relative(repositoryRoot, baselinePath)}`);
  lines.push('');
  lines.push('benchmark\tns/op base\tns/op cur\tns/op delta\tB/op delta\tallocs delta\tverdict');
  for (const row of rows) {
    const detail = row.detail ? `  ${row.detail}` : '';
    const delta = (metric) => (row.deltas?.[metric] === undefined ? '-' : `${(row.deltas[metric] * 100).toFixed(1)}%`);
    lines.push(`${row.name}\t-\t-\t${delta('ns/op')}\t${delta('B/op')}\t${delta('allocs/op')}\t${row.verdict}${detail}`);
  }
  fs.writeFileSync(target, `${lines.join('\n')}\n`, 'utf8');
  return `${lines.join('\n')}\n`;
}

function printComparison(rows, failures) {
  console.log('\nbench-profiles: comparison against the committed baseline');
  console.log('benchmark'.padEnd(64) + 'ns/op'.padStart(9) + 'B/op'.padStart(9) + 'allocs'.padStart(9) + '  verdict');
  for (const row of rows) {
    const delta = (metric) => (row.deltas?.[metric] === undefined ? '-' : `${(row.deltas[metric] * 100).toFixed(1)}%`);
    console.log(`${row.name.padEnd(64)}${delta('ns/op').padStart(9)}${delta('B/op').padStart(9)}${delta('allocs/op').padStart(9)}  ${row.verdict}`);
  }
  if (failures.length > 0) {
    console.log(`\nbench-profiles: ${failures.length} comparison failure(s):`);
    for (const failure of failures) console.log(`  - ${failure}`);
  }
}

function profilePhase(options, binary) {
  const outputDirectory = options.outDir;
  const profileFlags = [
    '-test.count=1',
    `-test.cpuprofile=${path.join(outputDirectory, 'cpu.pprof')}`,
    `-test.memprofile=${path.join(outputDirectory, 'mem.pprof')}`,
    '-test.memprofilerate=65536',
    `-test.blockprofile=${path.join(outputDirectory, 'block.pprof')}`,
    '-test.blockprofilerate=10000',
    `-test.mutexprofile=${path.join(outputDirectory, 'mutex.pprof')}`,
    '-test.mutexprofilefraction=10',
  ];
  console.log('\nbench-profiles: profile run (cpu, heap/alloc, block, mutex)');
  const result = run(binary, benchArguments(options, profileFlags), { cwd: benchmarkPackageDirectory, allowFailure: true });
  fs.writeFileSync(path.join(outputDirectory, 'profiles-run.txt'), `${result.stdout}${result.stderr}`, 'utf8');
  const profileFailures = [];
  if (result.status !== 0) profileFailures.push(`profiled benchmark run exited ${result.status}`);
  for (const profile of ['cpu.pprof', 'mem.pprof', 'block.pprof', 'mutex.pprof']) {
    const profilePath = path.join(outputDirectory, profile);
    if (!fs.existsSync(profilePath) || fs.statSync(profilePath).size === 0) {
      profileFailures.push(`${profile} was not produced`);
    }
  }

  const tops = [
    { name: 'pprof-cpu-top.txt', source: 'cpu.pprof', sampleIndex: 'cpu' },
    { name: 'pprof-alloc-space-top.txt', source: 'mem.pprof', sampleIndex: 'alloc_space' },
    { name: 'pprof-alloc-objects-top.txt', source: 'mem.pprof', sampleIndex: 'alloc_objects' },
    { name: 'pprof-block-top.txt', source: 'block.pprof', sampleIndex: 'cpu' },
    { name: 'pprof-mutex-top.txt', source: 'mutex.pprof', sampleIndex: 'cpu' },
  ];
  for (const top of tops) {
    const source = path.join(outputDirectory, top.source);
    const args = top.sampleIndex === 'cpu'
      ? ['-top', '-nodecount=30', binary, source]
      : [`-sample_index=${top.sampleIndex}`, '-top', '-nodecount=30', '-lines', binary, source];
    const profileTop = run('go', ['tool', 'pprof', ...args], { allowFailure: true });
    fs.writeFileSync(path.join(outputDirectory, top.name), `${profileTop.stdout}${profileTop.stderr}`, 'utf8');
    if (profileTop.status !== 0) profileFailures.push(`go tool pprof for ${top.name} exited ${profileTop.status}`);
  }
  const topOfFile = path.join(outputDirectory, 'pprof-cpu-top.txt');
  if (fs.existsSync(topOfFile)) {
    console.log(readTrackedFile(topOfFile, '').split(/\r?\n/).slice(0, 26).join('\n'));
  }
  return profileFailures;
}

function runToFile(command, args, target, { cwd = repositoryRoot } = {}) {
  const descriptor = fs.openSync(target, 'w');
  try {
    const result = spawnSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', descriptor, 'pipe'] });
    if (result.error) throw new Error(`could not run ${commandLine(command, args)}: ${result.error.message}`);
    return { status: result.status, stderr: result.stderr ?? '' };
  } finally {
    fs.closeSync(descriptor);
  }
}

function tracePhase(options, binary) {
  console.log('\nbench-profiles: trace run (bounded subset, 2 iterations each)');
  const traceResult = run(binary, [
    '-test.run=^$',
    `-test.bench=${TRACE_BENCHMARKS}`,
    '-test.benchmem',
    '-test.benchtime=2x',
    '-test.count=1',
    `-test.trace=${path.join(options.outDir, 'trace.out')}`,
    '-test.timeout=10m',
  ], { cwd: benchmarkPackageDirectory, allowFailure: true });
  fs.writeFileSync(path.join(options.outDir, 'trace-run.txt'), `${traceResult.stdout}${traceResult.stderr}`, 'utf8');
  const failures = [];
  if (traceResult.status !== 0) failures.push(`trace run exited ${traceResult.status}`);
  const tracePath = path.join(options.outDir, 'trace.out');
  if (!fs.existsSync(tracePath) || fs.statSync(tracePath).size === 0) {
    failures.push('trace.out was not produced');
    return failures;
  }
  // READABILITY PROOF, without launching a browser (CI has none): Go 1.27's trace CLI no longer has a
  // `-tool=dump`, but it can project the trace into a pprof profile. A scheduler profile that `go tool pprof`
  // can read proves the trace file is a complete, parseable capture and adds a useful view.
  const schedulerProfile = path.join(options.outDir, 'trace-sched.pprof');
  const projection = runToFile('go', ['tool', 'trace', '-pprof=sched', tracePath], schedulerProfile);
  if (projection.status !== 0 || !fs.existsSync(schedulerProfile) || fs.statSync(schedulerProfile).size === 0) {
    failures.push(`go tool trace -pprof=sched exited ${projection.status} or produced no profile`);
    return failures;
  }
  const schedulerTop = run('go', ['tool', 'pprof', '-top', '-nodecount=25', binary, schedulerProfile], { allowFailure: true });
  fs.writeFileSync(path.join(options.outDir, 'pprof-trace-sched-top.txt'), `${schedulerTop.stdout}${schedulerTop.stderr}`, 'utf8');
  if (schedulerTop.status !== 0) failures.push(`go tool pprof on the trace-derived scheduler profile exited ${schedulerTop.status}`);
  return failures;
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  fs.mkdirSync(options.outDir, { recursive: true });
  // Facts are captured BEFORE the binary build so the artifact states the commit the run started from.
  const facts = environmentFacts();
  fs.writeFileSync(path.join(options.outDir, 'environment.txt'), Object.entries(facts).map(([key, value]) => `${key}: ${value}`).join('\n') + '\n', 'utf8');
  const binary = buildTestBinary(options);

  const failures = [];
  let comparisonOutcome = 'not-run';

  if (options.mode === 'compare' || options.mode === 'all') {
    console.log(`\nbench-profiles: comparison run (${options.rounds} round(s), bench=${options.bench})`);
    const result = run(binary, benchArguments(options, [`-test.count=${options.rounds}`]), { cwd: benchmarkPackageDirectory });
    const rawOutputPath = path.join(options.outDir, 'bench-current.txt');
    fs.writeFileSync(rawOutputPath, result.stdout, 'utf8');
    const rounds = parseBenchOutput(result.stdout);
    const aggregated = aggregateRounds(rounds);
    if (aggregated.size === 0) {
      failures.push('the benchmark run produced no parseable ns/op lines; refusing to compare an empty set');
      comparisonOutcome = 'failed';
    } else {
      const roundCounts = [...aggregated.values()].map((entry) => entry.rounds);
      const expectedRounds = options.rounds;
      for (const [name, entry] of aggregated) {
        if (entry.rounds !== expectedRounds) failures.push(`${name}: ${entry.rounds} round(s) parsed, expected ${expectedRounds}`);
      }
      if (options.updateBaseline) {
        if (facts.workingTree !== 'clean') {
          failures.push('--update-baseline refuses a dirty working tree: the baseline must name a commit whose bytes were measured');
        } else {
          fs.writeFileSync(options.baseline, formatBaseline(facts, aggregated), 'utf8');
          fs.copyFileSync(rawOutputPath, defaultRawBaseline);
          console.log(`bench-profiles: wrote ${path.relative(repositoryRoot, options.baseline)} and ${path.relative(repositoryRoot, defaultRawBaseline)}; commit both`);
          comparisonOutcome = 'baseline-written';
        }
      } else if (!fs.existsSync(options.baseline)) {
        const candidate = path.join(options.outDir, 'bench-baseline-candidate.txt');
        fs.writeFileSync(candidate, formatBaseline(facts, aggregated), 'utf8');
        fs.copyFileSync(rawOutputPath, path.join(options.outDir, 'bench-baseline-candidate-raw.txt'));
        console.log(`bench-profiles: NO COMMITTED BASELINE at ${path.relative(repositoryRoot, options.baseline)}`);
        console.log(`bench-profiles: wrote a candidate baseline to ${path.relative(repositoryRoot, candidate)}`);
        console.log('bench-profiles: commit it (with its raw run) as tests/perf/bench-baseline.txt, then re-run');
        comparisonOutcome = 'missing-baseline';
        failures.push('committed baseline absent; candidate written for review');
      } else {
        const baseline = parseBaseline(fs.readFileSync(options.baseline, 'utf8'));
        const comparison = compareBaseline(facts, baseline, aggregated);
        fs.writeFileSync(path.join(options.outDir, 'comparison.txt'), writeComparisonTable(path.join(options.outDir, 'comparison.txt'), comparison.rows, options.baseline), 'utf8');
        printComparison(comparison.rows, comparison.failures);
        if (comparison.incompatible.length > 0) {
          if (options.ignoreHost) {
            console.log(`\nbench-profiles: --ignore-host: proceeding despite incomparable host facts:\n  ${comparison.incompatible.join('\n  ')}`);
            failures.push(...comparison.failures);
            comparisonOutcome = comparison.failures.length === 0 ? 'passed-ignoring-host' : 'failed';
          } else {
            console.error('\nbench-profiles: refusing to compare numbers from different hosts (GOAL 15.2):');
            for (const difference of comparison.incompatible) console.error(`  ${difference}`);
            console.error('bench-profiles: regenerate the baseline on this host, or pass --ignore-host for triage only');
            console.error('bench-profiles: regeneration: node scripts/bench-profiles.mjs --update-baseline --out-dir tests/perf/out');
            fs.writeFileSync(path.join(options.outDir, 'comparison.txt'), `INCOMPARABLE HOST\n${comparison.incompatible.join('\n')}\n`, 'utf8');
            comparisonOutcome = 'incomparable-host';
          }
        } else {
          failures.push(...comparison.failures);
          comparisonOutcome = comparison.failures.length === 0 ? 'passed' : 'failed';
        }
      }
    }
  }

  if (options.mode === 'profiles' || options.mode === 'all') {
    failures.push(...profilePhase(options, binary));
  }
  if (options.mode === 'trace' || options.mode === 'all') {
    failures.push(...tracePhase(options, binary));
  }

  const summary = [
    `mode: ${options.mode}`,
    `rounds: ${options.rounds}`,
    `bench selection: ${options.bench}`,
    `comparison: ${comparisonOutcome}`,
    `failures: ${failures.length}`,
    ...failures.map((failure) => `  - ${failure}`),
  ].join('\n');
  fs.writeFileSync(path.join(options.outDir, 'verdict.txt'), `${summary}\n`, 'utf8');
  console.log(`\nbench-profiles: ${summary}`);

  if (comparisonOutcome === 'incomparable-host') return 2;
  if (comparisonOutcome === 'missing-baseline') return 3;
  return failures.length === 0 ? 0 : 1;
}

try {
  process.exit(main());
} catch (error) {
  console.error(`bench-profiles: ${error.message}`);
  process.exit(1);
}
