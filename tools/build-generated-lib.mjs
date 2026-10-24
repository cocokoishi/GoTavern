#!/usr/bin/env node
// Build SillyTavern's generated frontend library in an isolated temporary clone.
// The supplied upstream checkout is only read; all npm and Webpack writes stay
// outside it.
//
// Probes are auto-discovered: every tools/probe-*.mjs declares its own oracle
// runs in a header comment, so registering a new probe needs no edit to this
// file. Each declaration is one run:
//
//     // @gotavern-oracle: fixture=sillytavern-1.19.0-<name>.json label="<label>"
//     // @gotavern-oracle: fixture=... label="..." args=<extra argv>
//
// A probe that declares nothing is reported as an undeclared probe and fails
// the step, so discovery cannot silently skip one. The probes that must run
// alone are listed explicitly below with the reason each is serial.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

// The execution core. Everything about HOW MANY TIMES a probe runs lives there, because that is the one
// question no fixture can answer: a fixture records what a probe observed, never how often the harness
// executed it. This file owns the SCHEDULING (which probes run, in what order, with which build root) and
// nothing about the execution itself.
import {
    doubleRunFor,
    executeProbe,
    formatDoubleRunDecision,
    formatTimingReport,
    parseProbeFilter,
    runProbeBuffered,
    runProbeInherited,
    selectProbes,
    sharedWritePaths,
} from './oracle/execution.mjs';

const PINNED_COMMIT = '06bde939fb1e9c4c8d8641d810f0a916b5bce127';
const PINNED_VERSION = '1.19.0';
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const upstreamRoot = path.resolve(process.argv[2] ?? '');

if (!process.argv[2]) {
    console.error('usage: node tools/build-generated-lib.mjs <pinned-SillyTavern-checkout>');
    process.exit(2);
}

function run(command, args, cwd, options = {}) {
    return execFileSync(command, args, { cwd, encoding: 'utf8', stdio: 'inherit', ...options });
}

function runNpm(args, cwd, options = {}) {
    if (process.platform === 'win32') {
        const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
        if (!existsSync(npmCli)) throw new Error(`npm CLI not found beside Node.js: ${npmCli}`);
        return execFileSync(process.execPath, [npmCli, ...args], { cwd, encoding: 'utf8', stdio: 'inherit', ...options });
    }
    return execFileSync('npm', args, { cwd, encoding: 'utf8', stdio: 'inherit', ...options });
}

function generatedManifest(directory) {
    const entries = [];
    function visit(current, prefix = '') {
        for (const entry of readdirSync(current, { withFileTypes: true })) {
            const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
            const absolute = path.join(current, entry.name);
            if (entry.isDirectory()) {
                visit(absolute, relative);
            } else if (entry.isFile()) {
                const digest = createHash('sha256').update(readFileSync(absolute)).digest('hex');
                entries.push({ path: relative, digest });
            } else {
                throw new Error(`unsupported generated asset type: ${absolute}`);
            }
        }
    }
    visit(directory);
    entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
    return `${entries.map(entry => `${entry.digest}  ${entry.path}`).join('\n')}\n`;
}

const probeFailures = [];

function recordProbeFailure(label, error) {
    probeFailures.push({ label, message: (error && error.message) ? error.message : String(error) });
}

// Records the mode of every entry under the shared paths so the lock can be
// undone exactly, and detects a write that happened anyway (which is how the
// enforcement reports itself on a platform where it cannot be applied).
function fingerprintSharedPaths(root) {
    const entries = [];
    for (const relative of sharedWritePaths) {
        const target = path.join(root, relative);
        if (!existsSync(target)) continue;
        const stack = [target];
        while (stack.length > 0) {
            const current = stack.pop();
            const info = statSync(current);
            entries.push({ path: current, mode: info.mode, mtimeMs: info.mtimeMs, isDirectory: info.isDirectory() });
            if (info.isDirectory()) {
                for (const name of readdirSync(current)) stack.push(path.join(current, name));
            }
        }
    }
    return entries;
}

// Makes the shared subtrees read-only for the probe phase. Preventive rather
// than detective on purpose: a probe that writes and then restores leaves a
// clean tree, so no after-the-fact check can see the race.
function lockSharedPaths(root) {
    if (process.platform === 'win32') {
        console.log('shared-write enforcement is INACTIVE on Windows: the read-only lock is POSIX-only, so a local run does not prove probes are isolated.');
        return null;
    }
    const before = fingerprintSharedPaths(root);
    for (const entry of before) {
        chmodSync(entry.path, entry.isDirectory ? 0o555 : 0o444);
    }
    console.log(`shared-write lock applied to ${sharedWritePaths.join(', ')} (${before.length} entries)`);
    return before;
}

function unlockSharedPaths(before) {
    if (!before) return;
    for (const entry of before.slice().reverse()) {
        chmodSync(entry.path, entry.mode);
    }
    console.log('shared-write lock released');
}

// The failure diagnostic and the fixture comparison moved to tools/oracle/execution.mjs with the primitive
// that uses them: a scheduling site that owns a private copy of either is a second execution path, and a
// second execution path is how the policy came to apply to nobody. What stays here is PROVISIONING, which is
// genuinely per-root rather than per-execution.
//
// A probe may import a shared helper from `tools/lib/`. Probes are copied into the build root as
// `.gotavern-<name>.mjs`, so a relative `./lib/...` import resolves against the build root and the
// directory has to be copied there too. Without this, three probes ran on the developer's machine
// and failed in CI with ERR_MODULE_NOT_FOUND: the helper was in the repository, but the harness
// materializes probe FILES and never their siblings. Copying is idempotent, so every probe can ask
// for it without the harness needing to know which probes import what.
function materializeProbeLib(root) {
    const source = path.join(repositoryRoot, 'tools', 'lib');
    if (!existsSync(source)) return;
    cpSync(source, path.join(root, 'lib'), { recursive: true, force: true });
}

// Copies the probe (and the shared helpers it may import) into the root it will run against, and returns the
// path the execution primitive will spawn. Identical for both scheduling shapes: a probe's argv must not
// depend on whether it happens to be serial.
function prepareProbeScript(script, root) {
    const scriptPath = path.join(root, `.gotavern-${script}`);
    materializeProbeLib(root);
    copyFileSync(path.join(repositoryRoot, 'tools', script), scriptPath);
    return scriptPath;
}

// WHERE THE ORACLE'S TIME ACTUALLY GOES. A declaration costs one execution per run, so the count is what
// makes the number actionable. Two corrections over the version this replaces: the report is emitted AFTER
// every phase (it used to be printed before the late serial runs, so their time was missing altogether), and
// it is rendered from the executions that happened rather than from a hardcoded "x2 runs" label.
const probeTimings = [];

function reportProbeTimings() {
    const report = formatTimingReport(probeTimings);
    if (report) console.log(`\n${report}`);
}

// ONE OPTION SET PER DECLARED PROBE, so the two scheduling shapes cannot drift in what they hand the
// primitive. What deliberately does NOT live here is the double-run decision: every call site passes
// `doubleRun` explicitly, so the policy is visible at each point where a probe is actually executed.
function probeExecutionOptions(probe, root) {
    return {
        label: probe.label,
        scriptPath: prepareProbeScript(probe.script, root),
        root,
        repositoryRoot,
        args: probe.args,
        readFixture: () => readFileSync(path.join(repositoryRoot, 'tests', 'oracle', probe.fixture)),
        timings: probeTimings,
        recordFailure: failure => recordProbeFailure(failure.label, new Error(failure.message)),
    };
}

// Probes declare their own runs so registering one needs no edit here:
//   // @gotavern-oracle: fixture=<oracle file> label="<label>" [args=a,b]
// One declaration per run; a probe that records two fixtures declares two
// lines. A probe with no declaration is reported as undeclared rather than
// silently skipped, which keeps this a discovery mechanism and not a hole.
function discoverProbes() {
    const directory = path.join(repositoryRoot, 'tools');
    const discovered = [];
    const scripts = readdirSync(directory).filter(name => name.startsWith('probe-') && name.endsWith('.mjs')).sort();
    for (const script of scripts) {
        const probeSource = readFileSync(path.join(directory, script), 'utf8');
        for (const line of probeSource.split('\n')) {
            const declaration = /^\/\/ @gotavern-oracle: (.*)$/.exec(line.trim());
            if (!declaration || !declaration[1].includes('fixture=')) continue;
            const fields = {};
            for (const match of declaration[1].matchAll(/(\w+)=("[^"]*"|\S+)/g)) {
                fields[match[1]] = match[2].replace(/^"|"$/g, '');
            }
            discovered.push({
                script,
                fixture: fields.fixture,
                label: fields.label ?? fields.fixture,
                args: fields.args ? fields.args.split(',') : [],
                // A probe that writes under a shared PUBLIC_DIRECTORIES subtree
                // declares it and gets a private build root. Declaring it is the
                // author's job; enforcing it is not, which is why an undeclared
                // writer hits the read-only lock and fails loudly instead.
                sharedWrite: fields.sharedWrite === 'true',
            });
        }
    }
    return discovered;
}

// Gives one probe its own build root, so its writes under PUBLIC_DIRECTORIES
// cannot reach any other probe. This is what removes the reader problem rather
// than scheduling around it: a reader without sharedWrite reads the shared root
// while the writer writes its own, so they cannot collide at all.
//
// `git clone --shared` reuses the pinned checkout's objects, and npm ci is the
// only real cost. It is paid once per declared probe, not per run, and the root
// is deleted with the harness's temporary root.
function createPrivateBuildRoot(script) {
    const privateRoot = path.join(tempRoot, `private-${script.replace(/\.mjs$/, '')}`);
    run('git', ['clone', '--shared', '--no-checkout', upstreamRoot, privateRoot], repositoryRoot);
    run('git', ['checkout', '--force', '-B', 'release', PINNED_COMMIT], privateRoot);
    runNpm(['ci', '--no-audit', '--no-fund'], privateRoot);
    console.log(`probe ${script} declares sharedWrite and received a private build root at ${privateRoot}`);
    return privateRoot;
}

// Runs every probe even when some fail, so a single breakage cannot hide the
// ones behind it. At 25 minutes per CI cycle the discovery cost of aborting
// early is what let six broken probes stay invisible until an unrelated fix.
//
// This is the POOLED scheduling shape. It differs from the serial one only in the runner it hands the
// primitive (buffered output here, inherited stdio there); the execution accounting, the double-run
// comparison and the failure aggregation are the primitive's, so the two shapes cannot diverge.
async function runProbePool(probes, limit, doubleRunPolicy) {
    const queue = [...probes];
    const workers = Array.from({ length: Math.max(1, Math.min(limit, queue.length)) }, async () => {
        while (queue.length > 0) {
            const probe = queue.shift();
            const root = probe.sharedWrite ? createPrivateBuildRoot(probe.script) : buildRoot;
            const result = await executeProbe({
                ...probeExecutionOptions(probe, root),
                doubleRun: doubleRunPolicy.double,
                run: runProbeBuffered,
            });
            // Buffered so concurrent probes cannot interleave, then echoed so the job log still shows what
            // each probe observed, exactly as the serial harness did.
            if (result.output) console.log(result.output);
        }
    });
    await Promise.all(workers);
}

// Probe parallelism. Each probe boots its own pinned server, so this is kept
// low: the runner has 4 vCPUs and CPU contention is the one risk parallelism
// introduces for probes that observe timing. Raise only after a run shows
// stable fixtures. A bad value falls back to 3 rather than to zero workers,
// which would silently run nothing and report success.
const probeConcurrency = Math.max(1, Number.parseInt(process.env.GOTAVERN_ORACLE_CONCURRENCY ?? '3', 10) || 3);
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: upstreamRoot, encoding: 'utf8' }).trim();
if (sourceCommit !== PINNED_COMMIT) {
    throw new Error(`upstream checkout is ${sourceCommit}; expected ${PINNED_COMMIT}`);
}

const dirty = execFileSync('git', ['status', '--porcelain', '--', 'public', 'src/public/lib.js', 'webpack.config.js', 'package.json', 'package-lock.json'], {
    cwd: upstreamRoot,
    encoding: 'utf8',
});
if (dirty.trim()) {
    throw new Error('upstream build inputs have local changes; refusing to build from a modified oracle');
}

// The pinned checkout must have LF line endings. `git status` cannot detect a
// CRLF checkout when core.autocrlf is true, because git converts on read and
// reports the tree as clean, yet every recorded response body and every seeded
// default file then carries an extra CR per line. That is how the vendored
// upstream/** assets drifted from the pinned blobs: the assets were committed
// from a CRLF checkout, so their manifests were self-consistent with the wrong
// bytes. Fail loudly rather than record host-converted observations again.
for (const relative of [
    'public/index.html',
    'public/login.html',
    'public/script.js',
    'default/config.yaml',
    'default/content/presets/kobold/Deterministic.json',
]) {
    const candidate = path.join(upstreamRoot, relative);
    if (!existsSync(candidate)) continue;
    if (readFileSync(candidate).includes(13)) {
        throw new Error(
            `pinned checkout ${relative} contains CR; re-check out the oracle with core.autocrlf=false `
            + '(for example: git -c core.autocrlf=false checkout-index -a -f) before recording fixtures');
    }
}

const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'gotavern-upstream-webpack-'));
const buildRoot = path.join(tempRoot, 'source');
const outputPath = path.join(repositoryRoot, 'upstream', 'generated', 'lib.js');

try {
    run('git', ['clone', '--shared', '--no-checkout', upstreamRoot, buildRoot], repositoryRoot);
    // Give the isolated runtime probe a stable branch name. The checkout is
    // still pinned to the exact commit, but /version's branch field is now a
    // real and reproducible observation instead of a machine-dependent value.
    run('git', ['checkout', '--force', '-B', 'release', PINNED_COMMIT], buildRoot);
    runNpm(['ci', '--no-audit', '--no-fund'], buildRoot);

    const inventoryScript = path.join(buildRoot, '.gotavern-generate-inventories.mjs');
    copyFileSync(path.join(repositoryRoot, 'tools', 'generate-upstream-inventories.mjs'), inventoryScript);
    run(process.execPath, [inventoryScript, buildRoot, repositoryRoot], buildRoot);

    // Discovery replaces the per-probe registration list: every
    // tools/probe-*.mjs declares its own runs, so adding a probe needs no
    // edit to this file. A probe that declares nothing is reported below.
    const discoveredProbes = discoverProbes();
    // OPTIONAL NARROWING of the RECORDING step, for the per-push gate.
    //
    // A full run re-records every declared probe twice and boots the pinned server for each, which is
    // measured in hours; on a push that changed one route that is most of this repository's CI cost for
    // no extra information. GOTAVERN_ORACLE_PROBES=<comma-separated probe file names> records only those.
    // An EMPTY value keeps the historical behaviour and records everything, which is what the
    // scheduled/dispatched run and any shared-input change (`tools/lib/**`, `tools/oracle/**`, this file,
    // the inventories generator, `upstream/**`, `tests/provider-wire/scenarios/**`) uses.
    //
    // WHAT NARROWING COSTS. A probe that is NOT recorded is NOT VERIFIED, and this comment used to claim
    // the opposite ("this narrows what is RECORDED, never what is VERIFIED"). That was false. The
    // zero-diff gate diffs the WORKING TREE against the commit, so a probe that never ran leaves its
    // fixture byte-identical BY CONSTRUCTION and the gate cannot see that its output would have moved.
    // Narrowing therefore reduces recording work AND reduces detection to exactly the probes that ran;
    // the scheduled or dispatched full sweep is what covers the rest, and it is the only thing that does.
    // A narrowed green is a statement about the selected probes, never about the oracle as a whole.
    //
    // The undeclared-probe check below deliberately uses the FULL discovery list, so narrowing cannot
    // hide a probe that declares nothing.
    //
    // Selection is resolved in the execution core, because "this run selected nothing" is an execution
    // outcome and not a formatting decision: zero discovered probes (a broken declaration regex, a moved
    // directory) used to record nothing and exit 0, which the zero-diff gate then read as a pass.
    const oracleProbeFilter = parseProbeFilter(process.env.GOTAVERN_ORACLE_PROBES ?? '');
    const { selected: selectedProbes, failures: selectionFailures, selectionIsFull } = selectProbes({
        discovered: discoveredProbes,
        filter: oracleProbeFilter,
    });
    probeFailures.push(...selectionFailures);
    if (oracleProbeFilter.length > 0 && selectedProbes.length > 0) {
        console.log(`oracle probe filter: recording ${selectedProbes.length} of ${discoveredProbes.length} probes`);
        for (const probe of selectedProbes) console.log(`  ${probe.script} -> ${probe.fixture}`);
    }

    // THE DOUBLE-RUN DECISION, TAKEN ONCE AND PRINTED ONCE.
    //
    // Every probe costs one execution per run, and the second run is what catches a probe that is
    // INTERMITTENTLY unstable -- one whose two runs disagree while at least one still matches the commit.
    // The zero-diff gate already proves run 1 equals the COMMITTED bytes, so the second run buys exactly
    // that one failure class (it is how the sd-routes arrival-order race was found) and costs half of a
    // sweep. The policy is therefore scope-based rather than a per-probe guess: twice when EVERY probe is
    // recording (the stability pass), once when the run is narrowed, and GOTAVERN_ORACLE_DOUBLE_RUN can
    // force either. The decision is printed below so nobody has to infer which mode they got, and it is
    // handed to every execution site, which is the part that was missing before.
    const doubleRunPolicy = doubleRunFor(selectionIsFull);
    console.log(formatDoubleRunDecision(doubleRunPolicy));

    const declaredScripts = new Set(discoveredProbes.map(probe => probe.script));
    const undeclaredProbes = readdirSync(path.join(repositoryRoot, 'tools'))
        .filter(name => name.startsWith('probe-') && name.endsWith('.mjs'))
        .filter(name => !declaredScripts.has(name))
        .sort();
    if (undeclaredProbes.length > 0) {
        probeFailures.push({
            label: 'undeclared probes',
            message: 'probe scripts declare no oracle metadata; add a line such as '
                + '// @gotavern-oracle: fixture=sillytavern-1.19.0-<name>.json label="<label>" '
                + '(and args=<arg> for an extra argv) to each of: ' + undeclaredProbes.join(', '),
        });
    }

    // Probes that must run alone, before the pool. This list is explicit and
    // commented rather than inferred from probe metadata, because the reason
    // is a property of the observation the probe makes, not of the probe's
    // own description, and a silent regression here would be a flake.
    const earlySerialProbes = new Map([
        ['probe-csrf-session.mjs', 'records two fixtures (default and disabled) through one copied script path'],
        ['probe-config-init.mjs', 'its fixture also supplies upstream/generated/default-config.yaml, which the command-line probe consumes'],
        ['probe-heartbeat.mjs', 'observes the heartbeat file over wall-clock time, so CPU contention can change what it sees'],
        ['probe-server-protocols.mjs', 'binds IPv4 and IPv6 listeners and asserts which family wins, which port/socket contention can perturb'],
        ['probe-access-log-migration.mjs', 'asserts access-log write ordering, which depends on request timing'],
    ]);
    // Probes that must run alone, after the webpack build.
    const lateSerialProbes = new Map([
        ['probe-node-reference.mjs', 'fetches the generated /lib.js and asserts it matches the vendored artifact, so it needs the webpack build first'],
    ]);
    const earlyRuns = selectedProbes.filter(probe => earlySerialProbes.has(probe.script));
    const lateRuns = selectedProbes.filter(probe => lateSerialProbes.has(probe.script));
    const pooledRuns = selectedProbes.filter(probe => !earlySerialProbes.has(probe.script) && !lateSerialProbes.has(probe.script));

    // Every probe without sharedWrite runs against a read-only shared build root
    // for the whole probe phase, so an undeclared write fails immediately with a
    // permission error instead of racing a sibling. The lock is released before
    // the harness's own webpack step, which writes dist/_webpack under the build
    // root. Probes that declare sharedWrite get a private root and never touch
    // the shared one.
    const sharedLock = lockSharedPaths(buildRoot);
    const serialResults = new Map();
    try {
        for (const probe of earlyRuns) {
            const root = probe.sharedWrite ? createPrivateBuildRoot(probe.script) : buildRoot;
            // The SERIAL scheduling shape: same primitive, same accounting, its own single-execution runner.
            const { fixture } = await executeProbe({
                ...probeExecutionOptions(probe, root),
                doubleRun: doubleRunPolicy.double,
                run: runProbeInherited,
            });
            serialResults.set(probe.fixture, fixture);
        }
        // probe-config-init's fixture also supplies the vendored default config.
        const configFixtureBytes = serialResults.get('sillytavern-1.19.0-config-init.json');
        if (configFixtureBytes) {
            writeFileSync(path.join(repositoryRoot, 'upstream', 'generated', 'default-config.yaml'), JSON.parse(configFixtureBytes).scenarios.fresh.outputYaml);
        }

        // Independent probes. Each is hermetic: it picks its own free port and
        // its own mkdtemp runtime root and writes only its own fixture, so they
        // can run concurrently without changing any observation. Every probe is
        // still run the number of times the policy decided, and the two fixtures
        // of a double run are still compared byte for byte.
        // A failing probe is recorded, not thrown, so one breakage cannot hide
        // the rest; the step fails once at the end with the complete list.
        await runProbePool(pooledRuns, probeConcurrency, doubleRunPolicy);
    } finally {
        unlockSharedPaths(sharedLock);
    }
    const compiler = `
import { copyFileSync } from 'node:fs';
import path from 'node:path';
import webpack from 'webpack';
import getPublicLibConfig from './webpack.config.js';

const config = getPublicLibConfig({ forceDist: true, pruneCache: true });
const stats = await new Promise((resolve, reject) => {
  const compiler = webpack(config);
  compiler.run((error, result) => {
    if (error) {
      compiler.close(() => reject(error));
      return;
    }
    if (result.hasErrors()) {
      compiler.close(() => reject(new Error(result.toString(config.stats))));
      return;
    }
    compiler.close((closeError) => closeError ? reject(closeError) : resolve(result));
  });
});
console.log(stats.toString(config.stats));
copyFileSync(path.join(config.output.path, config.output.filename), process.argv[2]);
`;
    const compilerPath = path.join(buildRoot, '.gotavern-build-lib.mjs');
    const tempOutput = path.join(tempRoot, 'lib.js');
    writeFileSync(compilerPath, compiler);
    run(process.execPath, [compilerPath, tempOutput], buildRoot);

    copyFileSync(tempOutput, outputPath);
    // probe-node-reference must run after the webpack build because it fetches
    // the generated /lib.js and asserts it matches the vendored artifact.
    for (const probe of lateRuns) {
        const root = probe.sharedWrite ? createPrivateBuildRoot(probe.script) : buildRoot;
        const { fixture } = await executeProbe({
            ...probeExecutionOptions(probe, root),
            doubleRun: doubleRunPolicy.double,
            run: runProbeInherited,
        });
        serialResults.set(probe.fixture, fixture);
    }

    // The timing report comes AFTER every phase, including these late serial runs, which the version it
    // replaces printed before and therefore never measured.
    reportProbeTimings();

    // Report every probe failure together instead of stopping at the first one.
    // Aborting early is only defensible when failures are cheap to rediscover;
    // at ~25 minutes per CI cycle they are not, and an earlier abort hid six
    // broken probes behind one unrelated fix. Nothing is written past this point
    // unless every probe passed, so a partial run can never report success.
    if (probeFailures.length > 0) {
        console.error('');
        console.error(`Oracle probes failed: ${probeFailures.length}`);
        for (const failure of probeFailures) {
            console.error(`  - ${failure.label}: ${failure.message}`);
        }
        throw new Error(`${probeFailures.length} oracle probe(s) failed; every probe was still run, see the list above`);
    }

    const packageJson = JSON.parse(readFileSync(path.join(buildRoot, 'package.json'), 'utf8'));
    const webpackPackage = JSON.parse(readFileSync(path.join(buildRoot, 'node_modules', 'webpack', 'package.json'), 'utf8'));
    const digest = createHash('sha256').update(readFileSync(outputPath)).digest('hex');
    const metadata = {
        source: 'SillyTavern',
        version: PINNED_VERSION,
        commit: PINNED_COMMIT,
        packageVersion: packageJson.version,
        nodeVersion: process.version,
        npmVersion: runNpm(['--version'], repositoryRoot, { stdio: 'pipe' }).trim(),
        webpackVersion: webpackPackage.version,
        output: 'lib.js',
        sha256: digest,
    };
    writeFileSync(path.join(repositoryRoot, 'upstream', 'generated', 'build-info.json'), `${JSON.stringify(metadata, null, 2)}\n`);
    writeFileSync(path.join(repositoryRoot, 'upstream', 'manifests', 'generated.sha256'), generatedManifest(path.join(repositoryRoot, 'upstream', 'generated')));
    console.log(`Built upstream/generated/lib.js (${digest})`);
} finally {
    const resolvedTempRoot = path.resolve(tempRoot);
    const resolvedTempParent = path.resolve(os.tmpdir());
    const tempPathIsContained = path.dirname(resolvedTempRoot).toLowerCase() === resolvedTempParent.toLowerCase()
        && path.basename(resolvedTempRoot).startsWith('gotavern-upstream-webpack-');
    if (!tempPathIsContained) {
        throw new Error(`refusing to remove unexpected temporary path: ${resolvedTempRoot}`);
    }
    rmSync(resolvedTempRoot, { recursive: true, force: true });
}
