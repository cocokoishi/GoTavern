#!/usr/bin/env node
// A15 P1 ON/OFF ARMS — the paired measurement of the identity-keyed card-text cache, at a QUIET host.
//
// WHY THIS EXISTS. The P1 cache was landed on allocation evidence (every warm row falls) and a ns win on the
// small-card/large-text rows, while the 10,000-card ns row did not move outside the shared host's spread. The
// decision the Lead recorded is "re-measure at the quiet host; if 10k still shows nothing, revert rather than keep
// an unmeasurable optimisation". This script is that measurement, prepared in advance so the quiet window is spent
// measuring instead of editing.
//
// WHAT IT DOES, exactly:
//   1. Saves the cache-enabled `readCharacterDataStrict` from the current tree and verifies the function really
//      consults `loadCharacterCardTextCache`.
//   2. Builds ONE test binary with the cache enabled.
//   3. Swaps in the pre-change `readCharacterDataStrict` (taken from an explicitly named commit, default
//      `--uncached-commit <sha>`, never assumed) and builds a SECOND test binary with the identical flags.
//   4. Restores the cache-enabled file IMMEDIATELY and verifies its sha256 equals the saved bytes; the product
//      file is never left in the swapped state (also restored from an exit/signal handler, and a final check
//      refuses to claim success if it is dirty).
//   5. Runs alternating rounds: cached arm then uncached arm on even rounds, reversed on odd rounds, so a slow
//      period on the host cannot favour one arm. Each invocation runs the same benchmarks over the same generated
//      trees with -benchmem and a fixed -benchtime; the two binaries differ ONLY in that one function.
//   6. Writes every raw output and a JSON artifact (commit, host facts, Go version, GOMAXPROCS, build flags, arm
//      order per round, per-round metrics, medians, ratios, raw paths, load label) under tests/perf/out/a15/.
//
// WHAT IT DOES NOT DO: it does not commit, does not touch any file outside the product function during the two
// builds, and does not run unless `--confirm-quiet` is passed — a shared host makes this measurement worthless and
// the Lead's protocol says so.
//
// USAGE
//   node scripts/a15-bench-p1-arms.mjs --confirm-quiet --load-label "quiet: no other lanes" \
//     --uncached-commit <sha-before-the-cache> [--rounds 3] [--benchtime 5x] [--work-dir DIR] [--out DIR]
// Exit codes: 0 measurement written; 1 a build/run/restore failed; 2 usage or the host was not declared quiet.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const PRODUCT_FILE = path.join(repoRoot, 'internal', 'server', 'characters_card.go');
const BENCH_SET = 'BenchmarkCharactersAllScale$|BenchmarkCharactersAllScaleColdFirstRequest$';

function usage(reason) {
    console.error(`${reason}\n\nusage: node scripts/a15-bench-p1-arms.mjs --confirm-quiet --uncached-commit <sha>`);
    process.exit(2);
}

function argumentValue(name, fallback = null) {
    const index = process.argv.indexOf(name);
    if (index < 0) return fallback;
    const value = process.argv[index + 1];
    return value === undefined ? fallback : value;
}

if (!process.argv.includes('--confirm-quiet')) usage('refusing to measure on an undeclared host: pass --confirm-quiet (Lead protocol: one arm per quiet window)');
const uncachedCommit = argumentValue('--uncached-commit');
if (!uncachedCommit) usage('--uncached-commit is required: it names the tree whose readCharacterDataStrict is the pre-change function');
const rounds = Number(argumentValue('--rounds', '3'));
const benchtime = argumentValue('--benchtime', '5x');
const loadLabel = argumentValue('--load-label', 'quiet');
const workDir = path.resolve(argumentValue('--work-dir', path.join(repoRoot, '..', 'a15-work', 'p1-arms')));
const outDir = path.resolve(argumentValue('--out', path.join(repoRoot, 'tests', 'perf', 'out', 'a15')));
if (!Number.isFinite(rounds) || rounds < 2) usage('--rounds must be at least 2 (alternating arms need a pair)');

const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const sha256 = buffer => createHash('sha256').update(buffer).digest('hex');

function runCapture(command, args, options = {}) {
    return spawnSyncCapture(command, args, options);
}

function spawnSyncCapture(command, args, options = {}) {
    const result = execFileSync(command, args, { encoding: 'utf8', ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    return result;
}

const FUNCTION_PATTERN = /func readCharacterDataStrict\(filePath string\) \(string, error\) \{[\s\S]*?\n\}\n/;

function currentFunctionBlock() {
    const text = fs.readFileSync(PRODUCT_FILE, 'utf8');
    const match = FUNCTION_PATTERN.exec(text);
    if (!match) throw new Error('readCharacterDataStrict block not found in the product file');
    return match[0];
}

function uncachedFunctionBlock() {
    const source = runCapture('git', ['show', `${uncachedCommit}:internal/server/characters_card.go`], { cwd: repoRoot });
    const match = FUNCTION_PATTERN.exec(source);
    if (!match) throw new Error(`no readCharacterDataStrict block in ${uncachedCommit}:internal/server/characters_card.go`);
    if (match[0].includes('loadCharacterCardTextCache')) throw new Error(`the named --uncached-commit ${uncachedCommit} already contains the cache; name a pre-cache commit`);
    return match[0];
}

function replaceFunction(block) {
    const text = fs.readFileSync(PRODUCT_FILE, 'utf8');
    fs.writeFileSync(PRODUCT_FILE, text.replace(FUNCTION_PATTERN, block), 'utf8');
}

let productFileSaved = null;
let productFileHashAtStart = null;

function restoreProductFile() {
    if (productFileSaved === null) return;
    fs.writeFileSync(PRODUCT_FILE, productFileSaved, 'utf8');
    const nowHash = sha256(fs.readFileSync(PRODUCT_FILE));
    if (nowHash !== productFileHashAtStart) {
        // This is the one failure that must be impossible to miss: a measurement that leaves the product tree
        // swapped is worse than no measurement.
        console.error(`FATAL: ${PRODUCT_FILE} was NOT restored (sha256 ${nowHash} != ${productFileHashAtStart})`);
        process.exitCode = 2;
        throw new Error('product file restore failed');
    }
    console.error(`restored ${path.relative(repoRoot, PRODUCT_FILE)} (sha256 ${nowHash.slice(0, 16)}…)`);
}

process.on('exit', () => { if (productFileSaved !== null && typeof process.exitCode === 'number' && process.exitCode !== 0) restoreProductFile(); });
process.on('SIGINT', () => { try { restoreProductFile(); } catch { /* reported */ } process.exit(130); });

function goEnvironment() {
    const version = runCapture('go', ['version'], { cwd: repoRoot }).trim();
    return { version, GOMAXPROCS: process.env.GOMAXPROCS ?? null };
}

function buildTestBinary(label) {
    const binary = path.join(workDir, `server-test-${label}.exe`);
    execFileSync('go', ['test', '-c', '-o', binary, './internal/server'], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    return binary;
}

function runBenchArm(binary, label, round) {
    const args = [
        '-test.run', '^$',
        '-test.bench', BENCH_SET,
        '-test.benchmem',
        `-test.benchtime=${benchtime}`,
        '-test.count=1',
    ];
    const rawPath = path.join(workDir, `raw-${label}-r${round}.txt`);
    const result = spawnSyncCapture(binary, args, { cwd: path.join(repoRoot, 'internal', 'server') });
    fs.writeFileSync(rawPath, result, 'utf8');
    return { rawPath, metrics: parseBenchOutput(result) };
}

function parseBenchOutput(text) {
    const metrics = {};
    for (const line of text.split('\n')) {
        if (!line.includes('ns/op')) continue;
        const name = /^\s*(Benchmark\S+)/.exec(line)?.[1];
        const ns = /([\d.]+) ns\/op/.exec(line)?.[1];
        const bytes = /([\d.]+) B\/op/.exec(line)?.[1];
        const allocs = /([\d.]+) allocs\/op/.exec(line)?.[1];
        if (!name || !ns) continue;
        metrics[name] = { nsPerOp: Number(ns), bytesPerOp: bytes === undefined ? null : Number(bytes), allocsPerOp: allocs === undefined ? null : Number(allocs) };
    }
    return metrics;
}

function median(values) {
    const sorted = [...values].filter(value => typeof value === 'number').sort((left, right) => left - right);
    if (sorted.length === 0) return null;
    return sorted[Math.floor(sorted.length / 2)];
}

async function main() {
    await fsp.mkdir(workDir, { recursive: true });
    await fsp.mkdir(outDir, { recursive: true });
    productFileSaved = fs.readFileSync(PRODUCT_FILE, 'utf8');
    productFileHashAtStart = sha256(productFileSaved);
    const cachedBlock = currentFunctionBlock();
    if (!cachedBlock.includes('loadCharacterCardTextCache')) throw new Error('the current product function does not consult the cache; this is not the cache-enabled tree');
    const uncachedBlock = uncachedFunctionBlock();
    if (uncachedBlock.includes('loadCharacterCardTextCache')) throw new Error('the uncached block still consults the cache');
    if (cachedBlock === uncachedBlock) throw new Error('the cached and uncached function blocks are identical; nothing to compare');

    if (process.argv.includes('--dry-run')) {
        productFileSaved = null;
        console.log(JSON.stringify({ dryRun: true, cachedFunctionBytes: cachedBlock.length, uncachedFunctionBytes: uncachedBlock.length, cachedHasCacheLookup: cachedBlock.includes('loadCharacterCardTextCache'), uncachedHasCacheLookup: uncachedBlock.includes('loadCharacterCardTextCache'), rounds, benchtime, benchSet: BENCH_SET, productFileSha256: productFileHashAtStart }, null, 2));
        return;
    }

    console.error(`building the cache-enabled test binary (rounds=${rounds}, benchtime=${benchtime})`);
    const cachedBinary = buildTestBinary('cached');
    replaceFunction(uncachedBlock);
    console.error('building the pre-change test binary');
    const uncachedBinary = buildTestBinary('uncached');
    restoreProductFile();
    productFileSaved = null; // restored and verified: the exit handler must not restore twice

    const binaries = { cached: cachedBinary, uncached: uncachedBinary };
    const arms = [];
    for (let round = 1; round <= rounds; round += 1) {
        const order = round % 2 === 1 ? ['cached', 'uncached'] : ['uncached', 'cached'];
        for (const arm of order) {
            console.error(`round ${round}/${rounds}: arm ${arm}`);
            const run = runBenchArm(binaries[arm], `${arm}-r${round}`, round);
            arms.push({ round, arm, order, rawPath: run.rawPath, metrics: run.metrics });
        }
    }

    // Per benchmark metric: gather per-round values per arm, report medians and the paired ratio.
    const benchmarkNames = [...new Set(arms.flatMap(arm => Object.keys(arm.metrics)))].sort();
    const summary = {};
    for (const name of benchmarkNames) {
        const perArm = { cached: [], uncached: [] };
        for (const arm of arms) {
            const row = arm.metrics[name];
            if (row) perArm[arm.arm].push(row);
        }
        const metricSummary = metric => {
            const cachedValues = perArm.cached.map(row => row[metric]).filter(value => typeof value === 'number');
            const uncachedValues = perArm.uncached.map(row => row[metric]).filter(value => typeof value === 'number');
            const cachedMedian = median(cachedValues);
            const uncachedMedian = median(uncachedValues);
            return {
                cachedMedian,
                uncachedMedian,
                ratioCachedOverUncached: (cachedMedian !== null && uncachedMedian) ? cachedMedian / uncachedMedian : null,
                cachedValues,
                uncachedValues,
            };
        };
        summary[name] = { nsPerOp: metricSummary('nsPerOp'), bytesPerOp: metricSummary('bytesPerOp'), allocsPerOp: metricSummary('allocsPerOp') };
    }

    const facts = {
        harness: 'scripts/a15-bench-p1-arms.mjs',
        commit: runCapture('git', ['rev-parse', 'HEAD'], { cwd: repoRoot }).trim(),
        uncachedCommit,
        workingTree: runCapture('git', ['status', '--porcelain'], { cwd: repoRoot }).trim().split('\n').filter(Boolean),
        go: goEnvironment(),
        host: {
            platform: process.platform,
            release: os.release(),
            arch: process.arch,
            cpuModel: os.cpus()[0]?.model ?? null,
            logicalCores: os.cpus().length,
            totalMemoryBytes: os.totalmem(),
        },
        buildFlags: 'go test -c (CGO_ENABLED inherited), identical for both arms',
        binaries: {
            cached: { path: cachedBinary, sha256: sha256(fs.readFileSync(cachedBinary)) },
            uncached: { path: uncachedBinary, sha256: sha256(fs.readFileSync(uncachedBinary)) },
        },
        rounds,
        benchtime,
        benchSet: BENCH_SET,
        loadLabel,
        declaredQuiet: true,
        startedAt: new Date().toISOString(),
        notes: [
            'Both arms are the SAME tree except readCharacterDataStrict; each arm is a separately built test binary.',
            'Rounds alternate the arm order so a slow host period cannot systematically favour one arm.',
            'ns/op is paired within one quiet window; B/op and allocs/op are the allocation claim.',
            'The product file was restored and verified before any arm ran; no timed work happens in the swapped state.',
        ],
    };
    const artifactPath = path.join(outDir, `p1-arms-${STAMP}.json`);
    await fsp.writeFile(artifactPath, `${JSON.stringify({ schemaVersion: 1, facts, arms, summary }, null, 2)}\n`, 'utf8');
    console.log(`artifact: ${artifactPath}`);
    for (const [name, row] of Object.entries(summary)) {
        const line = (metric, unit) => {
            const value = row[metric];
            if (value.cachedMedian === null || value.uncachedMedian === null) return `${metric}: unmeasured`;
            return `${metric} ${value.uncachedMedian.toFixed(0)} -> ${value.cachedMedian.toFixed(0)} ${unit} (ratio ${value.ratioCachedOverUncached?.toFixed(3)})`;
        };
        console.log(`${name}: ${line('nsPerOp', 'ns/op')} | ${line('bytesPerOp', 'B/op')} | ${line('allocsPerOp', 'allocs')}`);
    }
}

try {
    await main();
} catch (error) {
    console.error(`a15-bench-p1-arms: ${error?.stack ?? error}`);
    try { restoreProductFile(); } catch { /* already reported */ }
    process.exit(1);
}
