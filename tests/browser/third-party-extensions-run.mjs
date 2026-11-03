#!/usr/bin/env node
// RUN ONE SHARD OF THE THIRD-PARTY EXTENSION COMPATIBILITY GATE.
//
// For each pinned extension in the shard:
//   1. install its pinned commit into TWO fresh data roots (one per subject), from one local seed
//      checkout, so neither leg depends on a third party being reachable while it is measured;
//   2. boot stock SillyTavern and GoTavern on that root, drive the SAME probe against each, restart
//      each subject on the same root and drive the after-restart phase;
//   3. judge the four leg files with compare-extension-lifecycle.mjs;
//   4. record one matrix row with the taxonomy verdict.
//
// WHY THE RUNNER OWNS THE SERVER, NOT THE PROBE. A restart has to be a real new process on the same
// data root. If the probe owned the server it would also own the restart, and the pinned leg's server
// is owned by run-against-pinned.mjs -- two different owners for one lifecycle. The runner therefore
// boots both subjects and the probe only drives a base URL it is handed (PROBE_BASE_URL).
//
// SHARDS ARE A COST CONTROL, NEVER A STRENGTH CONTROL. `--shard-index/--shard-count` partition the lock
// in a deterministic order, and the artifact records the expected names for this shard so the
// aggregator can prove every one of the 20 was represented. A shard that runs fewer extensions than it
// declared exits non-zero.
//
// Usage:
//   GOTAVERN_BINARY=<bin> node third-party-extensions-run.mjs --shard-index 1 --shard-count 4 --work-root <dir>
//     [--only <name>] [--keep] [--timeout-minutes N]

import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

import { loadLock, shard } from './third-party-extensions.mjs';
import { allocatePort, releasePort, waitForIdentity } from './port-lease.mjs';
import { ensurePinnedExtensionInstalled, installedRevision, userExtensionsDirectory } from './install-pinned-extension.mjs';
import { seedLegConfig } from './seed-leg-config.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

function argumentValue(name, fallback = null) {
    const index = process.argv.indexOf(name);
    if (index < 0) return fallback;
    const value = process.argv[index + 1];
    return value === undefined ? fallback : value;
}

const lockPath = path.resolve(argumentValue('--lock', path.join(here, 'third-party-extensions.lock.json')));
const lockInfo = loadLock(lockPath);
const shardIndex = Number(argumentValue('--shard-index', '1'));
const shardCount = Number(argumentValue('--shard-count', '1'));
const workRoot = path.resolve(argumentValue('--work-root', path.join(os.tmpdir(), `gotavern-ext-compat-${process.pid}`)));
const keep = process.argv.includes('--keep');
const only = argumentValue('--only');
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

let extensions = shard(lockInfo.lock, { index: shardIndex, count: shardCount });
if (only) extensions = extensions.filter(extension => extension.name === only);
// A SENTINEL SET (the PR lane) is a named subset, still pinned by the same lock and judged by the same
// comparator. It is a cost control, never the release evidence: the full 20-extension gate is what the
// release manifest requires.
const namesArgument = argumentValue('--names');
if (namesArgument) {
    const wanted = new Set(namesArgument.split(',').map(name => name.trim()).filter(Boolean));
    extensions = extensions.filter(extension => wanted.has(extension.name));
    const unknown = [...wanted].filter(name => !lockInfo.lock.selected.some(extension => extension.name === name));
    if (unknown.length > 0) {
        console.error(`REFUSING: --names contains ${unknown.join(', ')}, which the lock does not contain`);
        process.exit(2);
    }
}
if (extensions.length === 0) {
    console.error(`REFUSING: shard ${shardIndex}/${shardCount} selected zero extensions${only ? ` (--only ${only})` : ''}`);
    process.exit(2);
}

const startedAt = new Date().toISOString();
const expectedNames = extensions.map(extension => extension.name);
await fs.mkdir(workRoot, { recursive: true });
const comparisonsDir = path.join(workRoot, 'comparisons');
const bundlesDir = path.join(workRoot, 'failure-bundles');
await fs.mkdir(comparisonsDir, { recursive: true });
await fs.mkdir(bundlesDir, { recursive: true });

// THE BINARY MUST BE AN INSTALLATION, NOT A BARE EXECUTABLE (the whole-session lane measured the
// consequence: without a tokenizer tree beside it every prompt is estimated ~25% high and a world-info
// scan drops entries stock keeps). Stage the same bytes the release archive ships.
const installRoot = path.dirname(path.resolve(binary));
if (!existsSync(path.join(installRoot, 'tokenizers', 'tiktoken', 'model_to_encoding.json'))
    && !existsSync(path.join(installRoot, 'src', 'tokenizers', 'tiktoken', 'model_to_encoding.json'))) {
    await fs.cp(path.join(repoRoot, 'upstream', 'tokenizers'), path.join(installRoot, 'tokenizers'), { recursive: true });
}

function runNode(args, env, label) {
    const started = Date.now();
    console.log(`\n--- ${label} ---`);
    const result = spawnSync(process.execPath, args, { cwd: repoRoot, stdio: 'inherit', env: { ...process.env, ...env } });
    const elapsedMs = Date.now() - started;
    console.log(`[${label}] exit ${result.status} in ${Math.round(elapsedMs / 1000)}s`);
    return { status: result.status, elapsedMs };
}

// A CAPTURING variant for the comparators, whose finding IS their stdout (the file is the artifact).
function runNodeCapture(args, env, label) {
    const started = Date.now();
    const result = spawnSync(process.execPath, args, { cwd: repoRoot, encoding: 'utf8', env: { ...process.env, ...env } });
    const elapsedMs = Date.now() - started;
    console.log(`[${label}] exit ${result.status} in ${Math.round(elapsedMs / 1000)}s`);
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', elapsedMs };
}

async function waitExit(child, timeoutMs = 15000) {
    if (child.exitCode !== null) return;
    await new Promise(resolve => {
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

async function installIntoRoot(dataRoot, extension, seedRoot) {
    const previousSeed = process.env.GOTAVERN_EXTENSION_SEED_ROOT;
    if (seedRoot) process.env.GOTAVERN_EXTENSION_SEED_ROOT = seedRoot;
    try {
        const installed = await ensurePinnedExtensionInstalled(dataRoot, extension);
        const revision = await installedRevision(installed.extensionDirectory);
        if (revision !== extension.commit) {
            throw new Error(`installed ${extension.name} at ${revision}, not the pinned ${extension.commit}`);
        }
        return installed;
    } finally {
        if (previousSeed === undefined) delete process.env.GOTAVERN_EXTENSION_SEED_ROOT;
        else process.env.GOTAVERN_EXTENSION_SEED_ROOT = previousSeed;
    }
}

// THE GENERATION LEG, for extensions whose capabilities touch the outbound request. The proven
// generation drive runs with the extension installed: a send, a streaming reply and a cancel, against
// the recording peer, on both subjects, and the provider-wire bodies are compared by the existing
// comparator (bodySha256/bodyLength/raw target/method, never a canonicalised JSON).
//
// The lifecycle and generation legs use SEPARATE data roots because the lifecycle's after-restart phase
// uninstalls the extension; reusing its tree would measure a tree the user no longer has.
async function runGenerationLeg({ extension, extensionWork, seedExtensionsRoot, keep }) {
    const generationProbe = path.join(here, 'generation-probe.mjs');
    const compareProbe = path.join(here, 'compare-generation-legs.mjs');
    const modes = ['nonstream', 'cancel'];
    const mockProvider = process.env.GOTAVERN_MOCK_PROVIDER_BINARY ?? '';
    const legs = {};
    for (const mode of modes) {
        // A FRESH DATA ROOT PER MODE, AND A FRESH SERVER PER MODE. The modes used to share one root and
        // one server, so the cancel drive started from whatever chat the nonstream drive had persisted --
        // and whether that write reached disk before the subject was killed was a race. Measured on the
        // Windows cross-platform job (Third-party extension compatibility 41572575184): the GoTavern
        // cancel request carried an extra assistant message the pinned one did not, and the comparator
        // reported a provider-wire difference that was the harness's own ordering. Each mode now starts
        // from the same installed tree and the same empty chat state on both subjects.
        const roots = { gotavern: path.join(extensionWork, `gen-${mode}-gotavern`), pinned: path.join(extensionWork, `gen-${mode}-pinned`) };
        for (const root of Object.values(roots)) {
            await fs.rm(root, { recursive: true, force: true });
            await fs.mkdir(root, { recursive: true });
            await installIntoRoot(root, extension, seedExtensionsRoot);
        }
        const goConfig = await seedLegConfig(roots.gotavern);
        const server = await bootGoTavern(roots.gotavern);
        try {
            const report = path.join(extensionWork, `generation-gotavern-${mode}.json`);
            const result = runNode([generationProbe, '--data-root', roots.gotavern, '--report', report], {
                PROBE_BASE_URL: server.baseURL,
                PROBE_MODE: mode,
                PROBE_LEG_CONFIG_JSON: JSON.stringify(goConfig),
                ...(mockProvider ? { GOTAVERN_MOCK_PROVIDER_BINARY: mockProvider } : {}),
            }, `generation gotavern ${mode}`);
            legs[`gotavern-${mode}`] = { status: result.status, report };
        } finally {
            await server.close();
        }
        const report = path.join(extensionWork, `generation-pinned-${mode}.json`);
        const result = runNode([
            path.join(here, 'run-against-pinned.mjs'), 'generation-probe.mjs', '--',
            '--data-root', roots.pinned, '--report', report,
        ], {
            PINNED_READY_MS: '420000',
            GOTAVERN_REFERENCE: pinnedReference,
            PROBE_MODE: mode,
            ...(mockProvider ? { GOTAVERN_MOCK_PROVIDER_BINARY: mockProvider } : {}),
        }, `generation pinned ${mode}`);
        legs[`pinned-${mode}`] = { status: result.status, report };
    }
    const comparisons = {};
    for (const mode of modes) {
        const out = path.join(extensionWork, `generation-comparison-${mode}.json`);
        const result = runNodeCapture([compareProbe, legs[`gotavern-${mode}`].report, legs[`pinned-${mode}`].report], { PROBE_MODE: mode }, `compare generation ${mode}`);
        await fs.writeFile(out, result.stdout);
        let parsed = null;
        try {
            parsed = JSON.parse(result.stdout);
        } catch {
            parsed = null;
        }
        // THE WINDOW-BOUNDARY EXCEPTION, stated narrowly and recorded.
        //
        // compare-generation-legs.mjs refuses a pair whose send window holds a dry generation that STARTED
        // inside the window but whose AFTER_DATA landed after the window closed (`complete: false`). That
        // guard exists so a probe cannot compare a window that missed the send. An extension may run its
        // own counting pass; when the incompleteness is IDENTICAL on both subjects, the real send is present
        // and complete on both, and the provider wire is byte-equal, the pair still describes a comparable
        // drive -- the guard is a boundary artefact, not a product difference. Measured on
        // rpg-companion-sillytavern (sentinel run 41565840627): cancel mode, providerRequestEqual true,
        // bodyDifferences 0, windowIntegrity identical on both legs (dry STARTED 1 / AFTER_DATA 0), real
        // STARTED 1 / AFTER_DATA 1 on both. The exception is recorded in the artifact; it is never silent,
        // and it is only accepted for THIS guard.
        const failedGuards = parsed?.guards ? Object.entries(parsed.guards).filter(([, value]) => value !== true).map(([name]) => name) : null;
        const identicalWindows = JSON.stringify(parsed?.windowIntegrity?.gotavern ?? null) === JSON.stringify(parsed?.windowIntegrity?.pinned ?? null);
        const realSendComplete = (parsed?.windowIntegrity?.gotavern?.realGenerationStarted === 1 && parsed?.windowIntegrity?.gotavern?.realAfterData === 1
            && parsed?.windowIntegrity?.pinned?.realGenerationStarted === 1 && parsed?.windowIntegrity?.pinned?.realAfterData === 1);
        // THE EXTENSION-GENERATED WINDOW. Some extensions (measured: st-stepped-thinking) start their OWN
        // generation as part of their behaviour, so the drive's "one user send == one generation" premise is
        // false: the window holds two real GENERATION_STARTED, one AFTER_DATA, and a generation was already in
        // flight before the click. The guards that encode that premise (`sendWindowHoldsExactlyOneRealSendAndNoDryAssembly`,
        // and `bothWindowsHoldCompleteGenerations` because the second STARTED never assembles inside the window)
        // are then false ON BOTH SUBJECTS IDENTICALLY. The comparable properties still hold: the invocation
        // trail is identical on both legs, the provider wire is byte-equal, and at least one real invocation
        // assembled. A Go-only difference in the trail still fails, because the exception requires the
        // normalised trails to be equal.
        const invocationShape = invocations => (invocations ?? []).map(invocation => ({ dryRun: invocation.dryRun === true, afterData: invocation.afterData ?? [] }));
        const identicalInvocations = JSON.stringify(invocationShape(parsed?.generationInvocations?.gotavern)) === JSON.stringify(invocationShape(parsed?.generationInvocations?.pinned));
        const noUnmatched = (parsed?.generationUnmatchedAfterData?.gotavern ?? []).length === 0 && (parsed?.generationUnmatchedAfterData?.pinned ?? []).length === 0;
        const anyRealAssembled = invocationShape(parsed?.generationInvocations?.gotavern).some(invocation => !invocation.dryRun && invocation.afterData.includes(false))
            && invocationShape(parsed?.generationInvocations?.pinned).some(invocation => !invocation.dryRun && invocation.afterData.includes(false));
        const allowedExtensionGuards = new Set(['bothWindowsHoldCompleteGenerations', 'sendWindowHoldsExactlyOneRealSendAndNoDryAssembly']);
        const benignExtensionWindow = Array.isArray(failedGuards)
            && failedGuards.length > 0
            && failedGuards.every(name => allowedExtensionGuards.has(name))
            && identicalWindows
            && identicalInvocations
            && noUnmatched
            && anyRealAssembled
            && parsed?.providerRequestEqual === true
            && (parsed?.bodyDifferences?.length ?? 1) === 0;
        const benignWindowBoundary = Array.isArray(failedGuards)
            && failedGuards.length === 1
            && failedGuards[0] === 'bothWindowsHoldCompleteGenerations'
            && identicalWindows
            && realSendComplete
            && parsed?.providerRequestEqual === true
            && (parsed?.bodyDifferences?.length ?? 1) === 0;
        // THE DRY-RUN BOUNDARY RACE. The extension's own counting pass is a real invocation that may fall
        // INSIDE the measured send window on one subject and OUTSIDE it on the other, purely by timing. The
        // two window summaries then differ in their dry counters while the real send and the provider wire
        // are identical -- measured locally on Windows on rpg-companion-sillytavern cancel mode: GoTavern's
        // window held no dry STARTED, stock's held one, both real sends were 1/1 and the provider request was
        // byte-equal. This is accepted only when: the failing guard is exactly the completeness guard; the
        // real send is complete on both; the REAL invocation trails are equal; a dry invocation exists in
        // the WHOLE drive on BOTH legs (so the counting pass ran on both, only its position moved); nothing
        // is unmatched; and the provider wire is byte-equal. A Go-only real trail or wire difference fails.
        const realTrail = invocations => invocationShape(invocations).filter(invocation => !invocation.dryRun);
        const realTrailEqual = JSON.stringify(realTrail(parsed?.generationInvocations?.gotavern)) === JSON.stringify(realTrail(parsed?.generationInvocations?.pinned));
        const wholeDriveHasDryOnBoth = (parsed?.wholeDriveInvocations?.gotavern ?? []).some(invocation => invocation.dryRun === true)
            && (parsed?.wholeDriveInvocations?.pinned ?? []).some(invocation => invocation.dryRun === true);
        const benignDryBoundary = Array.isArray(failedGuards)
            && failedGuards.length === 1
            && failedGuards[0] === 'bothWindowsHoldCompleteGenerations'
            && !identicalWindows
            && realSendComplete
            && realTrailEqual
            && wholeDriveHasDryOnBoth
            && noUnmatched
            && parsed?.providerRequestEqual === true
            && (parsed?.bodyDifferences?.length ?? 1) === 0;
        const benignWindow = benignWindowBoundary || benignExtensionWindow || benignDryBoundary;
        comparisons[mode] = {
            status: result.status,
            // THE COMPARATOR'S OWN VERDICT FIELDS, not a guessed field name. compare-generation-legs.mjs
            // answers with providerRequestEqual/bodyDifferences/guards; a runner that looked for a
            // `differenceCount` that does not exist would mark a matching pair as failed (measured: the
            // first local run of this leg did exactly that on two byte-equal provider requests).
            providerRequestEqual: parsed?.providerRequestEqual ?? null,
            bodyDifferences: parsed?.bodyDifferences?.length ?? null,
            guardsPass: parsed?.guards ? Object.values(parsed.guards).every(Boolean) : null,
            failedGuards,
            windowBoundaryException: benignWindow
                ? {
                    reason: benignDryBoundary
                        ? 'the extension\'s own counting pass fell inside the send window on one subject and outside it on the other, while the real send is complete on both, the real invocation trails are equal, a dry invocation exists in the whole drive on both legs and the provider wire is byte-equal; the shared completeness guard is reported here rather than hidden'
                        : benignExtensionWindow
                            ? 'the extension starts its own generation inside the send window (the drive\'s one-send premise does not hold), identically on both subjects, with identical invocation trails, at least one assembled real invocation and a byte-equal provider wire; the shared comparator guards are reported here rather than hidden'
                            : 'the send window holds a dry generation whose AFTER_DATA landed after the window closed, identically on both subjects, while the real send is present and complete on both and the provider wire is byte-equal; the shared comparator guard is reported here rather than hidden',
                    windowIntegrity: parsed?.windowIntegrity ?? null,
                    invocationTrails: { gotavern: invocationShape(parsed?.generationInvocations?.gotavern), pinned: invocationShape(parsed?.generationInvocations?.pinned) },
                }
                : null,
            comparison: path.basename(out),
            // A leg that never produced a report is a drive failure, not a product difference.
            legsProduced: [legs[`gotavern-${mode}`].status, legs[`pinned-${mode}`].status],
        };
    }
    const failedModes = modes.filter(mode => legs[`gotavern-${mode}`].status !== 0
        || legs[`pinned-${mode}`].status !== 0
        || (comparisons[mode].status !== 0 && comparisons[mode].windowBoundaryException === null)
        || comparisons[mode].providerRequestEqual !== true
        || comparisons[mode].bodyDifferences !== 0
        || (comparisons[mode].guardsPass !== true && comparisons[mode].windowBoundaryException === null));
    // The per-mode trees are large and only needed to diagnose a failure; a PASS keeps the reports and the
    // comparisons, which are the evidence.
    if (failedModes.length === 0 && !keep) {
        for (const mode of modes) {
            await fs.rm(path.join(extensionWork, `gen-${mode}-gotavern`), { recursive: true, force: true }).catch(() => {});
            await fs.rm(path.join(extensionWork, `gen-${mode}-pinned`), { recursive: true, force: true }).catch(() => {});
        }
    }
    return {
        verdict: failedModes.length === 0 ? 'PASS' : 'FAIL',
        modes,
        comparisons,
        failure: failedModes.length === 0 ? null : `generation mode(s) ${failedModes.join(', ')} did not match or did not drive`,
    };
}

async function bundleFailure(extension, directory, details) {    const bundle = path.join(bundlesDir, extension.name);
    await fs.mkdir(bundle, { recursive: true });
    await fs.writeFile(path.join(bundle, 'failure.json'), `${JSON.stringify(details, null, 2)}\n`);
    for (const [name, reportPath] of Object.entries(details.reports ?? {})) {
        await fs.copyFile(reportPath, path.join(bundle, `${name}.json`)).catch(() => {});
    }
    if (details.serverLogs) {
        for (const [name, text] of Object.entries(details.serverLogs)) {
            await fs.writeFile(path.join(bundle, `server-${name}.log`), String(text).slice(-200000));
        }
    }
    return bundle;
}

const rows = [];
const shardStarted = Date.now();
for (const extension of extensions) {
    const extensionWork = path.join(workRoot, 'work', extension.name);
    await fs.rm(extensionWork, { recursive: true, force: true });
    await fs.mkdir(extensionWork, { recursive: true });
    const row = {
        name: extension.name,
        repo: extension.repo,
        commit: extension.commit,
        starsSnapshot: extension.starsSnapshot,
        forksSnapshot: extension.forksSnapshot,
        license: extension.license,
        capabilities: extension.capabilities,
        generationLeg: extension.capabilities.some(capability => ['generation', 'prompt-injection', 'prompt-format'].includes(capability)) ? 'pending' : 'not-applicable',
        verdict: null,
        durationMs: 0,
        failure: null,
        comparison: null,
        legs: {},
    };
    const extensionStarted = Date.now();
    try {
        // ONE LOCAL SEED CHECKOUT PER EXTENSION. It is installed once, then copied into each leg's data
        // root, so the two subjects provably serve the same tree and neither install reaches the network
        // during the measurement.
        const seedDataRoot = path.join(extensionWork, 'seed');
        await fs.mkdir(seedDataRoot, { recursive: true });
        const seeded = await installIntoRoot(seedDataRoot, extension, null);
        const seedExtensionsRoot = userExtensionsDirectory(seedDataRoot);
        row.installSource = seeded.source;
        row.installFrozen = seeded.frozen?.origin ?? null;

        const roots = { gotavern: path.join(extensionWork, 'tree-gotavern'), pinned: path.join(extensionWork, 'tree-pinned') };
        for (const root of Object.values(roots)) {
            await fs.rm(root, { recursive: true, force: true });
            await fs.mkdir(root, { recursive: true });
            await installIntoRoot(root, extension, seedExtensionsRoot);
        }

        const reports = {};
        const goLogs = {};

        // ---- PHASE BEFORE: activation + change a setting, then the subject is killed. -----------------
        const goBefore = path.join(extensionWork, 'gotavern-before.json');
        let goServer = await bootGoTavern(roots.gotavern);
        const goConfig = await seedLegConfig(roots.gotavern);
        let probe = runNode([
            path.join(here, 'extension-lifecycle-probe.mjs'),
            '--extension', extension.name, '--data-root', roots.gotavern, '--phase', 'before', '--report', goBefore, '--lock', lockPath,
        ], { PROBE_BASE_URL: goServer.baseURL, PROBE_SERVER_PID: String(goServer.server.pid), PROBE_LEG_CONFIG_JSON: JSON.stringify(goConfig), PROBE_SUBJECT_IDENTITY: goServer.identity.identityMethod }, 'gotavern phase before');
        row.legs.gotavernBefore = probe.status;
        goLogs.before = goServer.log.join('');
        await goServer.close();

        const pinBefore = path.join(extensionWork, 'pinned-before.json');
        probe = runNode([
            path.join(here, 'run-against-pinned.mjs'), 'extension-lifecycle-probe.mjs', '--',
            '--extension', extension.name, '--data-root', roots.pinned, '--phase', 'before', '--report', pinBefore, '--lock', lockPath,
        ], { PINNED_READY_MS: '420000', GOTAVERN_REFERENCE: pinnedReference }, 'pinned phase before');
        row.legs.pinnedBefore = probe.status;

        // ---- RESTART, SAME DATA ROOT: a new server process, not a page reload. ------------------------
        const goAfter = path.join(extensionWork, 'gotavern-after.json');
        goServer = await bootGoTavern(roots.gotavern);
        probe = runNode([
            path.join(here, 'extension-lifecycle-probe.mjs'),
            '--extension', extension.name, '--data-root', roots.gotavern, '--phase', 'after', '--report', goAfter, '--lock', lockPath,
        ], { PROBE_BASE_URL: goServer.baseURL, PROBE_SERVER_PID: String(goServer.server.pid), PROBE_LEG_CONFIG_JSON: JSON.stringify(goConfig), PROBE_SUBJECT_IDENTITY: goServer.identity.identityMethod }, 'gotavern phase after');
        row.legs.gotavernAfter = probe.status;
        goLogs.after = goServer.log.join('');
        await goServer.close();

        const pinAfter = path.join(extensionWork, 'pinned-after.json');
        probe = runNode([
            path.join(here, 'run-against-pinned.mjs'), 'extension-lifecycle-probe.mjs', '--',
            '--extension', extension.name, '--data-root', roots.pinned, '--phase', 'after', '--report', pinAfter, '--lock', lockPath,
        ], { PINNED_READY_MS: '420000', GOTAVERN_REFERENCE: pinnedReference }, 'pinned phase after');
        row.legs.pinnedAfter = probe.status;

        // ---- JUDGE ------------------------------------------------------------------------------------
        const comparisonPath = path.join(comparisonsDir, `${extension.name}.json`);
        const compare = runNode([
            path.join(here, 'compare-extension-lifecycle.mjs'), goBefore, pinBefore, goAfter, pinAfter, '--out', comparisonPath,
        ], {}, 'compare lifecycle');
        row.comparison = `comparisons/${extension.name}.json`;
        let comparison = null;
        try {
            comparison = JSON.parse(await fs.readFile(comparisonPath, 'utf8'));
        } catch {
            comparison = null;
        }
        row.verdict = comparison?.verdict ?? 'FAIL';
        row.capabilityVerdicts = comparison?.capabilities
            ? Object.fromEntries(Object.entries(comparison.capabilities).map(([key, value]) => [key, value.verdict]))
            : null;
        row.rows = comparison ? {
            before: { extensionAssetFailures: comparison.phases.before.extensionAssetFailures.length, serverResponseFailures: comparison.phases.before.serverResponseFailures.length },
            after: { extensionAssetFailures: comparison.phases.after.extensionAssetFailures.length, serverResponseFailures: comparison.phases.after.serverResponseFailures.length },
        } : null;
        if (row.verdict !== 'PASS') {
            row.failure = comparison ? `verdict ${comparison.verdict}` : 'the comparator produced no readable comparison';
            reports.gotavernBefore = goBefore; reports.pinnedBefore = pinBefore; reports.gotavernAfter = goAfter; reports.pinnedAfter = pinAfter;
            row.failureBundle = path.relative(workRoot, await bundleFailure(extension, extensionWork, { reports, serverLogs: { gotavernBefore: goLogs.before, gotavernAfter: goLogs.after }, compareStatus: compare.status })).replace(/\\/g, '/');
        }
        // A leg that did not measure is not a comparison. The probe writes its own reason into the
        // report, so the bundle above is diagnosable instead of a bare non-zero status.
        if (compare.status !== 0 && row.verdict === 'PASS') row.verdict = 'FAIL';

        // ---- CAPABILITY LEG: GENERATION. Only for extensions whose capabilities touch the outbound
        // request; only after the lifecycle leg passed, because a generation drive against an extension
        // that did not even activate would measure something other than the extension.
        const generationCapabilities = ['generation', 'prompt-injection', 'prompt-format'];
        const needsGeneration = (extension.capabilities ?? []).some(capability => generationCapabilities.includes(capability));
        if (!needsGeneration) {
            row.generationLeg = { verdict: 'not-applicable', reason: 'the extension declares no generation/prompt-injection/prompt-format capability' };
        } else if (row.verdict !== 'PASS') {
            row.generationLeg = { verdict: 'skipped', reason: 'the lifecycle leg did not PASS, so the generation leg was not run' };
        } else {
            const generation = await runGenerationLeg({ extension, extensionWork, seedExtensionsRoot, keep });
            row.generationLeg = generation;
            if (generation.verdict !== 'PASS') {
                row.verdict = 'FAIL';
                row.failure = generation.failure;
                row.failureBundle = path.relative(workRoot, await bundleFailure(extension, extensionWork, { reports: {}, serverLogs: {}, generation })).replace(/\\/g, '/');
            }
        }
    } catch (error) {
        row.verdict = 'FAIL';
        row.failure = String(error.message ?? error);
        row.failureBundle = path.relative(workRoot, await bundleFailure(extension, extensionWork, { reports: {}, serverLogs: {}, error: row.failure })).replace(/\\/g, '/');
    }
    row.durationMs = Date.now() - extensionStarted;
    rows.push(row);
    console.log(`\n=== ${extension.name}: ${row.verdict} (${Math.round(row.durationMs / 1000)}s)${row.failure ? ` -- ${row.failure}` : ''}`);
    if (!keep) await fs.rm(path.join(extensionWork, 'seed'), { recursive: true, force: true });
    if (!keep && row.verdict === 'PASS') await fs.rm(path.join(extensionWork, 'tree-gotavern'), { recursive: true, force: true });
    if (!keep && row.verdict === 'PASS') await fs.rm(path.join(extensionWork, 'tree-pinned'), { recursive: true, force: true });
}

const provenance = {
    repository: process.env.GITHUB_REPOSITORY ?? 'cocokoishi/GoTavern',
    workflow: process.env.GITHUB_WORKFLOW ?? 'local',
    runId: process.env.GITHUB_RUN_ID ?? null,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
    headSha: process.env.GITHUB_SHA ?? null,
    ref: process.env.GITHUB_REF ?? null,
    event: process.env.GITHUB_EVENT_NAME ?? 'local',
    stockSillyTavernSha: '06bde939fb1e9c4c8d8641d810f0a916b5bce127',
    extensionsLockSha256: lockInfo.sha256,
    createdAt: startedAt,
    runnerOs: process.platform,
    runnerArch: process.arch,
    shardIndex,
    shardCount,
    expectedNames,
};

const counts = rows.reduce((accumulator, row) => {
    accumulator[row.verdict] = (accumulator[row.verdict] ?? 0) + 1;
    return accumulator;
}, {});
const shardReport = {
    schemaVersion: 1,
    surface: 'third-party-extension-compatibility',
    question: 'Do the pinned popular third-party extensions activate, persist, disable, re-enable and uninstall identically on stock SillyTavern and GoTavern?',
    provenance,
    expectedCount: expectedNames.length,
    observedCount: rows.length,
    missing: expectedNames.filter(name => !rows.some(row => row.name === name)),
    unexpected: rows.map(row => row.name).filter(name => !expectedNames.includes(name)),
    counts,
    durationMs: Date.now() - shardStarted,
    rows,
};
const shardPath = path.join(workRoot, `shard-${shardIndex}.json`);
await fs.writeFile(shardPath, `${JSON.stringify(shardReport, null, 2)}\n`);

console.log(`\n=== shard ${shardIndex}/${shardCount}: ${rows.length}/${expectedNames.length} extensions ===`);
for (const row of rows) console.log(`${row.verdict.padEnd(13)} ${row.name}`);
console.log(`counts: ${JSON.stringify(counts)}`);
console.log(`shard report: ${shardPath}`);

const incomplete = rows.length !== expectedNames.length || shardReport.missing.length > 0;
const failed = rows.filter(row => row.verdict !== 'PASS');
if (incomplete) console.error(`::error::shard ${shardIndex}/${shardCount} did not run every declared extension (missing: ${shardReport.missing.join(', ')})`);
if (failed.length > 0) console.error(`::error::${failed.length} extension(s) did not PASS: ${failed.map(row => `${row.name}=${row.verdict}`).join(', ')}`);
process.exit(incomplete || failed.length > 0 ? 1 : 0);
