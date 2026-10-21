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

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

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

function changedJSONPaths(left, right, location = '$', output = []) {
    if (Object.is(left, right) || output.length >= 40) return output;
    if (Array.isArray(left) && Array.isArray(right)) {
        if (left.length !== right.length) output.push(`${location}.length`);
        for (let index = 0; index < Math.min(left.length, right.length); index++) {
            changedJSONPaths(left[index], right[index], `${location}[${index}]`, output);
        }
        return output;
    }
    if (left && right && typeof left === 'object' && typeof right === 'object' && !Array.isArray(left) && !Array.isArray(right)) {
        const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
        for (const key of keys) {
            if (!(key in left) || !(key in right)) output.push(`${location}.${key}`);
            else changedJSONPaths(left[key], right[key], `${location}.${key}`, output);
            if (output.length >= 40) break;
        }
        return output;
    }
    output.push(location);
    return output;
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

function runAsync(command, args, cwd) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
        const output = [];
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', chunk => output.push(chunk));
        child.stderr.on('data', chunk => output.push(chunk));
        child.on('error', reject);
        child.on('close', code => {
            const text = output.join('');
            if (code === 0) resolve(text);
            else reject(new Error(`${command} ${args.join(' ')} exited ${code}\n${text}`));
        });
    });
}

// Paths under the build root that more than one probe could write.
//
// Pinned src/constants.js PUBLIC_DIRECTORIES are relative to the server
// directory, and pinned server.js:11 does `process.chdir(serverDirectory)`, so a
// probe that touches one of these writes into the shared build root no matter
// what cwd it was spawned with. Spawning with an isolated cwd cannot help.
//
// These are exactly the four PUBLIC_DIRECTORIES subtrees; `extensions` contains
// `third-party`, and both are listed because both are named upstream and either
// could be touched directly. Add a fifth explicitly, with a comment, rather than
// widening this to the whole build root: a blanket lock could break something
// legitimate for a reason nobody would connect to this change.
const sharedWritePaths = [
    'public/img',
    'public/sounds',
    'public/scripts/extensions',
    'public/scripts/extensions/third-party',
];

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

// Reports a write into a shared path with the probe that attempted it, so the
// failure reads as an instruction rather than as a mystery permission error.
function describeSharedWrite(label, output) {
    if (!/EACCES|EPERM|permission denied|read-only/i.test(output)) return null;
    const mentioned = sharedWritePaths.filter(relative => output.includes(relative));
    const where = mentioned.length > 0 ? mentioned.join(', ') : sharedWritePaths.join(', ');
    return `probe ${label} attempted to write under ${where}, which is shared with other probes. `
        + 'Declare sharedWrite=true on its @gotavern-oracle line to give it a private build root, or stop writing there.';
}

// Runs one probe twice and compares the two fixtures byte for byte. The
// double-run determinism check and the fixture comparison are the load-bearing
// parts of the oracle; parallelism changes only when probes run, and failure
// aggregation changes only whether a failure stops the other probes, never
// what is compared or how strictly.
function compareProbeRuns(label, first, second) {
    if (first.equals(second)) return;
    const paths = changedJSONPaths(JSON.parse(first), JSON.parse(second));
    recordProbeFailure(label, new Error(`oracle changed across identical pinned Node runs at: ${paths.join(', ')}`));
}

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

async function verifyProbe({ script, fixture, label, args = [], root = buildRoot }) {
    const scriptPath = path.join(root, `.gotavern-${script}`);
    materializeProbeLib(root);
    copyFileSync(path.join(repositoryRoot, 'tools', script), scriptPath);
    const fixturePath = path.join(repositoryRoot, 'tests', 'oracle', fixture);
    // Both runs always execute, even if the first one fails: the determinism
    // check must never be skipped for a probe, and a probe that fails once and
    // succeeds once is a finding, not something to hide. Output is buffered so
    // concurrent probes do not interleave, then echoed so the job log still
    // shows what each probe observed, exactly as the serial harness did.
    const outputs = [];
    let first;
    let second;
    let failure;
    try {
        outputs.push(await runAsync(process.execPath, [scriptPath, root, repositoryRoot, ...args], root));
        first = readFileSync(fixturePath);
    } catch (error) {
        failure = error;
    }
    try {
        outputs.push(await runAsync(process.execPath, [scriptPath, root, repositoryRoot, ...args], root));
        second = readFileSync(fixturePath);
    } catch (error) {
        failure = failure ?? error;
    }
    const observed = outputs.join('').trim();
    if (observed) console.log(observed);
    if (failure) {
        const sharedWrite = describeSharedWrite(label, `${observed}\n${failure.message}`);
        recordProbeFailure(label, sharedWrite ? new Error(`${failure.message}\n${sharedWrite}`) : failure);
        return null;
    }
    compareProbeRuns(label, first, second);
    return first;
}

function verifyProbeSerial({ script, fixture, label, args = [], root = buildRoot }) {
    const scriptPath = path.join(root, `.gotavern-${script}`);
    materializeProbeLib(root);
    copyFileSync(path.join(repositoryRoot, 'tools', script), scriptPath);
    const fixturePath = path.join(repositoryRoot, 'tests', 'oracle', fixture);
    let first;
    let second;
    let failure;
    try {
        run(process.execPath, [scriptPath, root, repositoryRoot, ...args], root);
        first = readFileSync(fixturePath);
    } catch (error) {
        failure = error;
    }
    try {
        run(process.execPath, [scriptPath, root, repositoryRoot, ...args], root);
        second = readFileSync(fixturePath);
    } catch (error) {
        failure = failure ?? error;
    }
    if (failure) {
        const sharedWrite = describeSharedWrite(label, failure.message);
        recordProbeFailure(label, sharedWrite ? new Error(`${failure.message}\n${sharedWrite}`) : failure);
        return null;
    }
    compareProbeRuns(label, first, second);
    return first;
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
async function runProbePool(probes, limit) {
    const queue = [...probes];
    const workers = Array.from({ length: Math.max(1, Math.min(limit, queue.length)) }, async () => {
        while (queue.length > 0) {
            const probe = queue.shift();
            await verifyProbe(probe.sharedWrite
                ? { ...probe, root: createPrivateBuildRoot(probe.script) }
                : probe);
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
    const earlyRuns = discoveredProbes.filter(probe => earlySerialProbes.has(probe.script));
    const lateRuns = discoveredProbes.filter(probe => lateSerialProbes.has(probe.script));
    const pooledRuns = discoveredProbes.filter(probe => !earlySerialProbes.has(probe.script) && !lateSerialProbes.has(probe.script));

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
            serialResults.set(probe.fixture, verifyProbeSerial(probe.sharedWrite
                ? { ...probe, root: createPrivateBuildRoot(probe.script) }
                : probe));
        }
        // probe-config-init's fixture also supplies the vendored default config.
        const configFixtureBytes = serialResults.get('sillytavern-1.19.0-config-init.json');
        if (configFixtureBytes) {
            writeFileSync(path.join(repositoryRoot, 'upstream', 'generated', 'default-config.yaml'), JSON.parse(configFixtureBytes).scenarios.fresh.outputYaml);
        }

        // Independent probes. Each is hermetic: it picks its own free port and
        // its own mkdtemp runtime root and writes only its own fixture, so they
        // can run concurrently without changing any observation. Every probe is
        // still run twice and the two fixtures are still compared byte for byte.
        // A failing probe is recorded, not thrown, so one breakage cannot hide
        // the rest; the step fails once at the end with the complete list.
        await runProbePool(pooledRuns, probeConcurrency);
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
        serialResults.set(probe.fixture, verifyProbeSerial(probe.sharedWrite
            ? { ...probe, root: createPrivateBuildRoot(probe.script) }
            : probe));
    }

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
