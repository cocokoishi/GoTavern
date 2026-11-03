#!/usr/bin/env node
// RUN ONE CORPUS MODE: all-20 simultaneous, capability-cluster pairs, or the soak.
//
// The runner owns BOTH subjects so that a restart is a real new server process on the same data root:
// stock SillyTavern through run-against-pinned.mjs (which boots/kills it around the child probe) and
// GoTavern through a direct spawn guarded by port-lease + waitForIdentity. The probe itself never boots
// anything; it is handed PROBE_BASE_URL and drives one browser leg.
//
// EVERY RUN IS THE SAME PHYSICAL DRIVE ON BOTH LEGS: one identical data-root tree per subject (same
// installed extension checkouts, same config bytes seeded from the pinned default, same committed card
// copied to both), the same probe file, the same timeouts, and the same browser. A leg that cannot reach
// the page writes its own named failure and the pair is not compared as a product difference.
//
// ARTIFACT: schemaVersion 1, surface 'third-party-extension-corpus', provenance with GITHUB_* fallbacks,
// the stock SHA, the lock digest, mode and runner platform; one row per run (and per extension inside it)
// with the comparator's taxonomy verdict; and a failure bundle (leg reports + comparison + subject logs)
// for every run that did not PASS.
//
// Usage:
//   GOTAVERN_BINARY=<bin> node extension-corpus-run.mjs --mode all20|clusters|soak --work-root <dir>
//     [--soak-minutes N] [--keep] [--lock <lock>] [--only <name>]

import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

import { loadLock } from './third-party-extensions.mjs';
import { clusterPlan, namesForMode } from './extension-corpus-clusters.mjs';
import { allocatePort, releasePort, waitForIdentity } from './port-lease.mjs';
import { ensurePinnedExtensionInstalled, userExtensionsDirectory } from './install-pinned-extension.mjs';
import { seedLegConfig } from './seed-leg-config.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const CARD_NAME = 'Real Structure Card';
const CARD_RELATIVE = path.join(here, 'fixtures', 'real', 'card-a.png');
const STOCK_SHA = '06bde939fb1e9c4c8d8641d810f0a916b5bce127';

function argument(name, fallback = null) {
    const index = process.argv.indexOf(name);
    if (index === -1) return fallback;
    const value = process.argv[index + 1];
    return value === undefined ? fallback : value;
}

const mode = argument('--mode', 'all20');
if (!['all20', 'clusters', 'soak'].includes(mode)) {
    console.error(`REFUSING: --mode must be all20, clusters or soak; got ${JSON.stringify(mode)}`);
    process.exit(2);
}
const soakMinutes = Number(argument('--soak-minutes', '5'));
if (mode === 'soak' && (!Number.isFinite(soakMinutes) || soakMinutes <= 0)) {
    console.error(`REFUSING: --mode soak needs --soak-minutes > 0; got ${JSON.stringify(argument('--soak-minutes'))}`);
    process.exit(2);
}
const workRoot = path.resolve(argument('--work-root', path.join(os.tmpdir(), `gotavern-corpus-${process.pid}`)));
const keep = process.argv.includes('--keep');
const only = argument('--only');
const lockPath = path.resolve(argument('--lock', path.join(here, 'third-party-extensions.lock.json')));
const lockInfo = loadLock(lockPath);
const lock = lockInfo.lock;

const binary = process.env.GOTAVERN_BINARY ?? '';
if (!binary || !existsSync(binary)) {
    console.error(`REFUSING: GOTAVERN_BINARY must point at a built GoTavern binary; got ${JSON.stringify(binary)}`);
    process.exit(2);
}
const pinnedReference = process.env.GOTAVERN_REFERENCE
    ?? (existsSync(path.join(repoRoot, '.reference', 'SillyTavern', 'server.js')) ? path.join(repoRoot, '.reference', 'SillyTavern') : path.resolve(repoRoot, '..', 'SillyTavern'));
if (!existsSync(path.join(pinnedReference, 'server.js'))) {
    console.error(`REFUSING: no pinned SillyTavern checkout at ${pinnedReference}`);
    process.exit(2);
}
if (!existsSync(CARD_RELATIVE)) {
    console.error(`REFUSING: the committed card is not readable at ${CARD_RELATIVE}`);
    process.exit(2);
}
const cardBytes = await fs.readFile(CARD_RELATIVE);
const cardSha256 = createHash('sha256').update(cardBytes).digest('hex');

// THE PLAN: all20/soak is one whole-corpus run; clusters is one run per DISTINCT representative pair,
// with every cluster that shares the pair recorded against it. Cluster membership is deterministic from
// the lock (extension-corpus-clusters.mjs), never hand-listed.
let plan;
if (mode === 'clusters') {
    const clusters = clusterPlan(lock);
    plan = {
        mode,
        runs: clusters.runs.map(run => ({ names: run.names, clusters: run.clusters })),
        pairs: clusters.pairs,
        coverage: clusters.coverage,
        capabilityCoverage: clusters.capabilityCoverage,
        uncovered: clusters.uncovered,
    };
} else {
    const names = namesForMode(lock, mode);
    plan = { mode, runs: [{ names: [...names], clusters: [mode] }], coverage: { selectedCount: names.length, pairedCount: names.length, uncoveredCount: 0, statement: `${mode} drives the whole lock` }, pairs: [{ cluster: mode, names }], uncovered: [] };
}
if (only) {
    plan.runs = plan.runs.map(run => ({ ...run, names: run.names.filter(name => name === only) })).filter(run => run.names.length > 0);
    if (plan.runs.length === 0) {
        console.error(`REFUSING: --only ${JSON.stringify(only)} is not in any run's set`);
        process.exit(2);
    }
}
if (mode === 'all20' || mode === 'soak') {
    if (plan.runs[0].names.length !== 20) {
        console.error(`REFUSING: ${mode} must drive exactly 20 extensions; got ${plan.runs[0].names.length}`);
        process.exit(2);
    }
}

const startedAt = new Date().toISOString();
await fs.mkdir(workRoot, { recursive: true });
const reportsDir = path.join(workRoot, 'legs');
const comparisonsDir = path.join(workRoot, 'comparisons');
const bundlesDir = path.join(workRoot, 'failure-bundles');
await fs.mkdir(reportsDir, { recursive: true });
await fs.mkdir(comparisonsDir, { recursive: true });
await fs.mkdir(bundlesDir, { recursive: true });

// THE SUBJECT MUST BE AN INSTALLATION: a bare binary beside no tokenizer tree counts tokens by estimate,
// which is a property of the harness's build directory, not of the product. Stage the same bytes the
// release archive ships (the whole-session lane measured the ~25%-high signature this removes).
const installRoot = path.dirname(path.resolve(binary));
if (!existsSync(path.join(installRoot, 'tokenizers', 'tiktoken', 'model_to_encoding.json'))
    && !existsSync(path.join(installRoot, 'src', 'tokenizers', 'tiktoken', 'model_to_encoding.json'))) {
    await fs.cp(path.join(repoRoot, 'upstream', 'tokenizers'), path.join(installRoot, 'tokenizers'), { recursive: true });
}

function runNode(args, env, label) {
    const started = Date.now();
    console.log(`\n--- ${label} ---`);
    // A compare run can emit tens of megabytes; give the child room and keep the artifact file authoritative.
    const result = spawnSync(process.execPath, args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ...env } });
    const elapsedMs = Date.now() - started;
    if (result.stdout) process.stdout.write(result.stdout.slice(-30000));
    if (result.stderr) process.stderr.write(result.stderr.slice(-30000));
    console.log(`[${label}] exit ${result.status} in ${Math.round(elapsedMs / 1000)}s`);
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', elapsedMs };
}

function waitExit(child, timeoutMs = 25000) {
    if (child.exitCode !== null) return Promise.resolve();
    return new Promise(resolve => {
        const timer = setTimeout(resolve, timeoutMs);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
}

async function bootGoTavern(dataRoot) {
    const port = await allocatePort();
    const baseURL = `http://127.0.0.1:${port}`;
    const log = [];
    const server = spawn(path.resolve(binary), [
        'start', '--port', String(port), '--dataRoot', dataRoot,
        '--configPath', path.join(dataRoot, 'config.yaml'), '--browserLaunchEnabled', 'false',
    ], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    const collect = chunk => { if (log.length < 400) log.push(String(chunk).slice(0, 500)); };
    server.stdout.on('data', collect);
    server.stderr.on('data', collect);
    let exited = false;
    server.on('exit', () => { exited = true; });
    const identity = await waitForIdentity({
        baseURL, port,
        childAlive: () => !exited,
        childPid: server.pid,
        expectedPkgVersion: '1.19.0',
        deadlineMs: 180000,
        logTail: () => log.join(''),
    });
    return {
        baseURL, port, server, log, identity,
        close: async () => {
            server.kill();
            await waitExit(server);
            if (server.exitCode === null) server.kill('SIGKILL');
            releasePort(port);
        },
    };
}

async function installIntoRoot(root, extension, seedRoot) {
    const previous = process.env.GOTAVERN_EXTENSION_SEED_ROOT;
    // A SEED ROOT THE CALLER DID NOT PASS MUST NOT LEAK IN FROM THE AMBIENT ENV: the one-time seed install
    // is what may reach the pinned remote; every per-leg copy must be a local copy of that seed.
    if (seedRoot) process.env.GOTAVERN_EXTENSION_SEED_ROOT = seedRoot;
    else delete process.env.GOTAVERN_EXTENSION_SEED_ROOT;
    try {
        return await ensurePinnedExtensionInstalled(root, extension);
    } finally {
        if (previous === undefined) delete process.env.GOTAVERN_EXTENSION_SEED_ROOT;
        else process.env.GOTAVERN_EXTENSION_SEED_ROOT = previous;
    }
}

// ONE SEED CHECKOUT PER EXTENSION, then copied into each subject's root: neither leg reaches the network
// during the measurement, and both legs provably serve the same pinned tree.
async function prepareSeed(extension, seedRootFor) {
    if (seedRootFor.has(extension.name)) return seedRootFor.get(extension.name);
    const seedDataRoot = path.join(workRoot, 'seed', extension.name.replace(/[^A-Za-z0-9._-]/g, '_'));
    await fs.mkdir(seedDataRoot, { recursive: true });
    const installed = await installIntoRoot(seedDataRoot, extension, null);
    const seedRoot = userExtensionsDirectory(seedDataRoot);
    const record = { seedRoot, installed };
    seedRootFor.set(extension.name, record);
    return record;
}

async function stageRoot(root, names, seedRootFor) {
    await fs.mkdir(root, { recursive: true });
    const extensions = names.map(name => lock.selected.find(entry => entry.name === name));
    for (const extension of extensions) {
        const seed = await prepareSeed(extension, seedRootFor);
        const installed = await installIntoRoot(root, extension, seed.seedRoot);
        if (installed.revision !== extension.commit) throw new Error(`installed ${extension.name} at ${installed.revision}, not the pinned ${extension.commit}`);
    }
    const config = await seedLegConfig(root);
    const characters = path.join(root, 'default-user', 'characters');
    await fs.mkdir(characters, { recursive: true });
    const cardPath = path.join(characters, `${CARD_NAME}.png`);
    await fs.writeFile(cardPath, cardBytes);
    const writtenCard = await fs.readFile(cardPath);
    return {
        config,
        card: { path: `${CARD_NAME}.png`, sha256: createHash('sha256').update(writtenCard).digest('hex'), matchesSource: createHash('sha256').update(writtenCard).digest('hex') === cardSha256 },
        extensions: extensions.map(extension => ({ name: extension.name, commit: extension.commit })),
    };
}

async function runGoProbe({ root, names, phase, runMode, report, label, legConfig }) {
    const server = await bootGoTavern(root);
    try {
        const args = [
            path.join(here, 'extension-corpus-probe.mjs'),
            '--names', names.join(','), '--data-root', root, '--report', report,
            '--phase', phase, '--mode', runMode, '--subject', 'gotavern',
        ];
        if (runMode === 'soak') args.push('--soak-minutes', String(soakMinutes));
        const result = runNode(args, {
            PROBE_BASE_URL: server.baseURL,
            PROBE_SERVER_PID: String(server.server.pid),
            PROBE_LEG_CONFIG_JSON: JSON.stringify(legConfig),
        }, label);
        return { ...result, serverLog: server.log.join(''), identity: server.identity };
    } finally {
        await server.close();
    }
}

async function runPinnedProbe({ root, names, phase, runMode, report, label }) {
    const args = [
        path.join(here, 'run-against-pinned.mjs'), 'extension-corpus-probe.mjs', '--',
        '--names', names.join(','), '--data-root', root, '--report', report,
        '--phase', phase, '--mode', runMode, '--subject', 'pinned',
    ];
    if (runMode === 'soak') args.push('--soak-minutes', String(soakMinutes));
    const result = runNode(args, { PINNED_READY_MS: '420000', GOTAVERN_REFERENCE: pinnedReference }, label);
    return result;
}

const seedRootFor = new Map();
const rows = [];
const runStarted = Date.now();
let goConfigSha = null;

for (const [index, run] of plan.runs.entries()) {
    const runName = mode === 'clusters' ? `pair-${index + 1}-${run.names.join('+')}` : mode;
    const runDir = path.join(workRoot, 'runs', runName.replace(/[^A-Za-z0-9._+-]/g, '_'));
    await fs.rm(runDir, { recursive: true, force: true });
    await fs.mkdir(runDir, { recursive: true });
    const roots = { gotavern: path.join(runDir, 'tree-gotavern'), pinned: path.join(runDir, 'tree-pinned') };
    const row = { run: runName, mode, names: run.names, clusters: run.clusters ?? [], verdict: null, reasons: [], durationMs: 0, legs: {}, comparisons: [], extensions: [], soak: null, failureBundle: null };
    const started = Date.now();
    try {
        const goStage = await stageRoot(roots.gotavern, run.names, seedRootFor);
        const pinStage = await stageRoot(roots.pinned, run.names, seedRootFor);
        if (goStage.config.sha256 !== pinStage.config.sha256) throw new Error(`the two roots were seeded from different config bytes: ${goStage.config.sha256} vs ${pinStage.config.sha256}`);
        if (goStage.card.sha256 !== pinStage.card.sha256) throw new Error('the committed card was not staged identically into both roots');
        goConfigSha = goStage.config.sha256;

        const reports = {
            goBefore: path.join(reportsDir, `${runName}-go-before.json`),
            pinBefore: path.join(reportsDir, `${runName}-pinned-before.json`),
            goAfter: path.join(reportsDir, `${runName}-go-after.json`),
            pinAfter: path.join(reportsDir, `${runName}-pinned-after.json`),
        };
        const goBefore = await runGoProbe({ root: roots.gotavern, names: run.names, phase: 'before', runMode: mode === 'soak' ? 'soak' : 'load', report: reports.goBefore, label: `go ${runName} before`, legConfig: goStage.config });
        row.legs.gotavernBefore = goBefore.status;
        const pinBefore = await runPinnedProbe({ root: roots.pinned, names: run.names, phase: 'before', runMode: mode === 'soak' ? 'soak' : 'load', report: reports.pinBefore, label: `pinned ${runName} before` });
        row.legs.pinnedBefore = pinBefore.status;
        // RESTART: a new process on the SAME data root for both subjects.
        const goAfter = await runGoProbe({ root: roots.gotavern, names: run.names, phase: 'after', runMode: mode === 'soak' ? 'soak' : 'load', report: reports.goAfter, label: `go ${runName} after`, legConfig: goStage.config });
        row.legs.gotavernAfter = goAfter.status;
        const pinAfter = await runPinnedProbe({ root: roots.pinned, names: run.names, phase: 'after', runMode: mode === 'soak' ? 'soak' : 'load', report: reports.pinAfter, label: `pinned ${runName} after` });
        row.legs.pinnedAfter = pinAfter.status;

        const comparisonPath = path.join(comparisonsDir, `${runName}.json`);
        const compare = runNode([
            path.join(here, 'compare-extension-corpus.mjs'),
            reports.goBefore, reports.pinBefore,
            '--after', reports.goAfter, reports.pinAfter,
            '--expected', run.names.join(','),
            '--mode', mode === 'soak' ? 'soak' : 'load',
            '--out', comparisonPath,
        ], {}, `compare ${runName}`);
        let comparison = null;
        try { comparison = JSON.parse(await fs.readFile(comparisonPath, 'utf8')); } catch { comparison = null; }
        row.comparisons.push({ run: runName, comparison: path.relative(workRoot, comparisonPath).replace(/\\/g, '/'), status: compare.status, verdict: comparison?.verdict ?? null, failedGuards: comparison?.failedGuards ?? null });
        row.verdict = comparison?.verdict ?? 'FAIL';
        row.reasons = comparison?.failedGuards ?? ['the comparator produced no readable comparison'];
        row.extensions = (comparison?.extensions ?? []).map(entry => ({ name: entry.name, verdict: entry.verdict, reason: entry.reason, loaded: entry.loaded }));
        if (mode === 'soak' && comparison?.soak) row.soak = comparison.soak;
        if (row.verdict !== 'PASS' || compare.status !== 0) {
            const bundle = path.join(bundlesDir, runName.replace(/[^A-Za-z0-9._+-]/g, '_'));
            await fs.mkdir(bundle, { recursive: true });
            await fs.writeFile(path.join(bundle, 'failure.json'), `${JSON.stringify({ run: runName, verdict: row.verdict, failedGuards: row.reasons, legs: row.legs, reports, comparison: path.relative(workRoot, comparisonPath) }, null, 2)}\n`);
            for (const [key, file] of Object.entries(reports)) {
                await fs.copyFile(file, path.join(bundle, path.basename(file))).catch(() => {});
            }
            if (comparisonPath) await fs.copyFile(comparisonPath, path.join(bundle, 'comparison.json')).catch(() => {});
            await fs.writeFile(path.join(bundle, 'gotavern-before.server.log'), String(goBefore.serverLog ?? '').slice(-200000));
            await fs.writeFile(path.join(bundle, 'gotavern-after.server.log'), String(goAfter.serverLog ?? '').slice(-200000));
            row.failureBundle = path.relative(workRoot, bundle).replace(/\\/g, '/');
        }
        if (row.verdict === 'PASS' && compare.status !== 0) row.verdict = 'FAIL';
    } catch (error) {
        row.verdict = 'FAIL';
        row.reasons = [String(error.message ?? error)];
        const bundle = path.join(bundlesDir, runName.replace(/[^A-Za-z0-9._+-]/g, '_'));
        await fs.mkdir(bundle, { recursive: true });
        await fs.writeFile(path.join(bundle, 'failure.json'), `${JSON.stringify({ run: runName, verdict: 'FAIL', reasons: row.reasons }, null, 2)}\n`);
        row.failureBundle = path.relative(workRoot, bundle).replace(/\\/g, '/');
        console.error(`[${runName}] FAILED: ${row.reasons.join('; ')}`);
    }
    row.durationMs = Date.now() - started;
    rows.push(row);
    console.log(`\n=== ${runName}: ${row.verdict} (${Math.round(row.durationMs / 1000)}s)${row.reasons?.length ? ` -- ${row.reasons.join('; ')}` : ''}`);
    if (!keep) {
        await fs.rm(runDir, { recursive: true, force: true });
    }
}

const counts = rows.reduce((accumulator, row) => { accumulator[row.verdict] = (accumulator[row.verdict] ?? 0) + 1; return accumulator; }, {});
const provenance = {
    repository: process.env.GITHUB_REPOSITORY ?? 'cocokoishi/GoTavern',
    workflow: process.env.GITHUB_WORKFLOW ?? 'local',
    runId: process.env.GITHUB_RUN_ID ?? null,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
    headSha: process.env.GITHUB_SHA ?? null,
    ref: process.env.GITHUB_REF ?? null,
    event: process.env.GITHUB_EVENT_NAME ?? 'local',
    stockSillyTavernSha: STOCK_SHA,
    lockSha256: lockInfo.sha256,
    lockPath: path.basename(lockInfo.path),
    mode,
    soakMinutes: mode === 'soak' ? soakMinutes : null,
    startedAt,
    durationMs: Date.now() - runStarted,
    runnerOs: process.platform,
    runnerArch: process.arch,
    node: process.version,
    configSha256: goConfigSha,
    cardSha256,
    binary: path.basename(path.resolve(binary)),
};
const artifact = {
    schemaVersion: 1,
    surface: 'third-party-extension-corpus',
    question: 'With the pinned third-party corpus installed at once, does the pinned frontend load every extension, issue the same API surface, reach the same final state and survive a restart (and, in soak mode, a repeated drive) identically on stock SillyTavern and GoTavern?',
    mode,
    verdict: rows.length > 0 && rows.every(row => row.verdict === 'PASS') ? 'PASS' : 'FAIL',
    plan,
    provenance,
    rows,
    counts,
    failureBundles: rows.filter(row => row.failureBundle).map(row => row.failureBundle),
};
const artifactPath = path.join(workRoot, `${mode}.json`);
await fs.writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);
console.log(`\n=== corpus ${mode}: ${artifact.verdict} ===`);
for (const row of rows) console.log(`${String(row.verdict).padEnd(13)} ${row.run}`);
console.log(`artifact: ${artifactPath}`);
if (artifact.verdict !== 'PASS') {
    console.error(`::error::${rows.filter(row => row.verdict !== 'PASS').length} run(s) did not PASS: ${rows.filter(row => row.verdict !== 'PASS').map(row => `${row.run}=${row.verdict}`).join(', ')}`);
    process.exitCode = 1;
}
