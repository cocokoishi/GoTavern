#!/usr/bin/env node
// THE TESTS OF THE THIRD-PARTY EXTENSION GATE'S TESTS.
//
// Every check here MUTATES the thing the gate claims to guard and requires the gate to go red for the
// named reason. It is cheap on purpose (no browser, no pinned boot): it runs before the expensive shards
// so a broken judge fails the run in seconds instead of after an hour of drives.
//
// Covered (the list is the alpha.13 requirement, not an aspiration):
//   * wrong identity: a 200 /version naming another product is refused;
//   * 404 is not ready: an error page is not readiness;
//   * port collision: the allocator never hands back a port that is occupied;
//   * listener ownership: a port answered by a process the harness did not spawn is refused;
//   * forced Go startup failure: a subject that exits before answering is refused;
//   * forced comparator mismatch: a changed status in one leg turns the verdict FAIL;
//   * forced stock failure: a stock leg that failed yields UPSTREAM_FAIL, not PASS;
//   * missing artifact: a missing leg file is an error, not an empty comparison;
//   * leg-failure preservation: the verdict carries the leg's own reason;
//   * aggregator: missing / duplicate / unexpected extension, stale lock hash and unknown schema are all
//     failures, and a complete 20-row set passes;
//   * lock validation: 19 selected entries, a short SHA, an unknown capability and a Tavern Helper row
//     are refused.
//
// Usage: node tests/browser/third-party-extensions-selftest.mjs

import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { allocatePort, releasePort, waitForIdentity } from './port-lease.mjs';
import { loadLock, validateLock } from './third-party-extensions.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'gotavern-ext-selftest-'));
const failures = [];
let checks = 0;

function check(name, condition, detail = '') {
    checks += 1;
    if (condition) {
        console.log(`ok   ${name}`);
    } else {
        failures.push(`${name}${detail ? `: ${detail}` : ''}`);
        console.log(`FAIL ${name}${detail ? `: ${detail}` : ''}`);
    }
}

async function expectReject(name, promise, expectedFragment) {
    try {
        await promise;
        check(name, false, 'the check accepted a state it must refuse');
    } catch (error) {
        const message = String(error.message ?? error);
        check(name, message.includes(expectedFragment), `refused for the wrong reason: ${message}`);
    }
}

function serveVersion({ status = 200, body = null }) {
    return new Promise(resolve => {
        const server = http.createServer((request, response) => {
            if (request.url === '/version') {
                response.writeHead(status, { 'content-type': 'application/json' });
                response.end(body ?? JSON.stringify({ pkgVersion: '1.19.0', gitRevision: '06bde939f' }));
                return;
            }
            response.writeHead(404, { 'content-type': 'text/html' });
            response.end('<html>not found</html>');
        });
        server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
    });
}

// ---- identity readiness ----------------------------------------------------------------------------
{
    const { server, port } = await serveVersion({ body: JSON.stringify({ pkgVersion: '0.0.0-other-product' }) });
    await expectReject('wrong product identity is refused',
        waitForIdentity({ baseURL: `http://127.0.0.1:${port}`, port, childAlive: () => true, childPid: process.pid, expectedPkgVersion: '1.19.0', deadlineMs: 3000 }),
        'not the pinned baseline product');
    server.close();
}
{
    const { server, port } = await serveVersion({ status: 404, body: 'nope' });
    await expectReject('404 is not readiness',
        waitForIdentity({ baseURL: `http://127.0.0.1:${port}`, port, childAlive: () => true, childPid: process.pid, expectedPkgVersion: '1.19.0', deadlineMs: 3000 }),
        'did not reach the expected identity');
    server.close();
}
{
    // A 200 from a process the harness did not spawn: the version payload is right, but the listener is
    // not the child. This is the alpha.12 wrong-peer shape one layer down.
    const { server, port } = await serveVersion({});
    await expectReject('a listener owned by another process is refused',
        waitForIdentity({ baseURL: `http://127.0.0.1:${port}`, port, childAlive: () => true, childPid: process.pid + 100000, expectedPkgVersion: '1.19.0', deadlineMs: 5000 }),
        'this harness spawned PID');
    server.close();
}

// ---- port allocation -------------------------------------------------------------------------------
{
    const occupied = await serveVersion({});
    const exclude = [occupied.port];
    let handedOccupied = false;
    for (let index = 0; index < 30; index += 1) {
        const port = await allocatePort({ exclude });
        if (port === occupied.port) handedOccupied = true;
        releasePort(port);
    }
    check('the allocator never returns an occupied port', !handedOccupied);
    const first = await allocatePort();
    const second = await allocatePort();
    check('two leases in one process are distinct', first !== second);
    releasePort(first);
    releasePort(second);
    occupied.server.close();
}

// ---- forced subject startup failure ------------------------------------------------------------------
{
    const port = await allocatePort();
    const child = spawnSync(process.execPath, ['-e', 'process.exit(3)'], { encoding: 'utf8' });
    let exited = child.status !== null;
    await expectReject('a subject that exits before answering is refused',
        waitForIdentity({ baseURL: `http://127.0.0.1:${port}`, port, childAlive: () => !exited, childPid: process.pid, expectedPkgVersion: '1.19.0', deadlineMs: 3000 }),
        'exited before it owned');
    releasePort(port);
}

// ---- comparator teeth ------------------------------------------------------------------------------
function report({ subject, phase, extensionName = 'probe-extension', failure = null, loaded = true, settingsReady = true, rows = [], lifecycle = {} }) {
    const base = {
        schemaVersion: 1,
        surface: 'third-party-extension-lifecycle',
        subject,
        phase,
        failure,
        provenance: {
            extension: { name: extensionName, repo: 'owner/probe-extension', commit: 'a'.repeat(40), capabilities: ['DOM'], lockSha256: 'f'.repeat(64) },
            installedRevision: 'a'.repeat(40),
            configFile: { sha256: 'e'.repeat(64) },
        },
        phases: {},
    };
    if (phase === 'before') {
        base.phases.activation = { extensionLoaded: loaded, reachedUserState: { settingsReady }, settle: { quiet: true }, pageErrors: [], httpFailures: [], consoleErrors: [], extensionRequests: [], rows };
        base.phases.settings = { available: true, key: extensionName };
    } else {
        base.phases.activationAfterRestart = { extensionLoaded: loaded, reachedUserState: { settingsReady }, settle: { quiet: true }, pageErrors: [], httpFailures: [], consoleErrors: [], extensionRequests: [], rows };
        base.phases.settingPersisted = { available: true, key: extensionName, probe: { marker: 'm' } };
        base.phases.disabledDrive = { extensionLoaded: false, reachedUserState: { settingsReady }, settle: { quiet: true }, pageErrors: [], httpFailures: [], consoleErrors: [], rows: [] };
        base.phases.enabledDrive = { extensionLoaded: true, reachedUserState: { settingsReady }, settle: { quiet: true }, pageErrors: [], httpFailures: [], consoleErrors: [], rows: [] };
        base.phases.uninstall = { status: 200 };
        base.phases.uninstalledDirectoryGone = true;
        base.phases.uninstalledDrive = { extensionLoaded: false, reachedUserState: { settingsReady }, settle: { quiet: true }, pageErrors: [], httpFailures: [], consoleErrors: [], rows: [] };
        Object.assign(base.phases, lifecycle);
    }
    return base;
}

const row = (pathName, status = 200, method = 'POST') => ({ method, path: pathName, status, contentType: 'application/json', bodyShape: { type: 'object', keys: { ok: 'boolean' } }, bodySha256: 'b'.repeat(64) });

async function runComparator(legs) {
    const fileNames = legs.map((leg, index) => {
        const file = path.join(temporary, `leg-${checks}-${index}.json`);
        return file;
    });
    await Promise.all(legs.map((leg, index) => fs.writeFile(fileNames[index], JSON.stringify(leg))));
    const result = spawnSync(process.execPath, [path.join(here, 'compare-extension-lifecycle.mjs'), ...fileNames], { encoding: 'utf8' });
    let parsed = null;
    try {
        parsed = JSON.parse(result.stdout);
    } catch {
        parsed = null;
    }
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, parsed };
}

const healthyRows = [row('/api/extensions/discover', 200, 'GET'), row('/api/settings/get'), row('/scripts/extensions/third-party/probe-extension/index.js', 200, 'GET')];
{
    const result = await runComparator([
        report({ subject: 'gotavern', phase: 'before', rows: healthyRows }),
        report({ subject: 'pinned', phase: 'before', rows: healthyRows }),
        report({ subject: 'gotavern', phase: 'after', rows: healthyRows }),
        report({ subject: 'pinned', phase: 'after', rows: healthyRows }),
    ]);
    check('a healthy pair PASSes', result.status === 0 && result.parsed?.verdict === 'PASS', `exit ${result.status} verdict ${result.parsed?.verdict}`);
}
{
    const mismatched = healthyRows.map(entry => entry.path === '/api/settings/get' ? { ...entry, status: 500 } : entry);
    const result = await runComparator([
        report({ subject: 'gotavern', phase: 'before', rows: mismatched }),
        report({ subject: 'pinned', phase: 'before', rows: healthyRows }),
        report({ subject: 'gotavern', phase: 'after', rows: healthyRows }),
        report({ subject: 'pinned', phase: 'after', rows: healthyRows }),
    ]);
    check('a changed status turns the verdict FAIL', result.status !== 0 && result.parsed?.verdict === 'FAIL', `exit ${result.status} verdict ${result.parsed?.verdict}`);
}
{
    const result = await runComparator([
        report({ subject: 'gotavern', phase: 'before', failure: 'the GoTavern drive never reached settingsReady' }),
        report({ subject: 'pinned', phase: 'before' }),
        report({ subject: 'gotavern', phase: 'after' }),
        report({ subject: 'pinned', phase: 'after' }),
    ]);
    check('a forced Go startup failure is FAIL', result.parsed?.verdict === 'FAIL', `verdict ${result.parsed?.verdict}`);
}
{
    const result = await runComparator([
        report({ subject: 'gotavern', phase: 'before' }),
        report({ subject: 'pinned', phase: 'before', failure: 'the pinned server exited before answering /version' }),
        report({ subject: 'gotavern', phase: 'after' }),
        report({ subject: 'pinned', phase: 'after', failure: 'the pinned server exited before answering /version' }),
    ]);
    check('a forced stock failure is UPSTREAM_FAIL, never PASS', result.parsed?.verdict === 'UPSTREAM_FAIL', `verdict ${result.parsed?.verdict}`);
}
{
    const file = path.join(temporary, 'one-leg.json');
    await fs.writeFile(file, JSON.stringify(report({ subject: 'gotavern', phase: 'before' })));
    const result = spawnSync(process.execPath, [path.join(here, 'compare-extension-lifecycle.mjs'), file, path.join(temporary, 'missing.json'), file, file], { encoding: 'utf8' });
    check('a missing leg artifact is an error, not a comparison', result.status !== 0, `exit ${result.status}`);
}
{
    const result = await runComparator([
        report({ subject: 'gotavern', phase: 'before', loaded: false }),
        report({ subject: 'pinned', phase: 'before' }),
        report({ subject: 'gotavern', phase: 'after' }),
        report({ subject: 'pinned', phase: 'after' }),
    ]);
    const activation = result.parsed?.capabilities?.activation;
    check('leg failure is preserved with a named reason', activation?.verdict === 'FAIL' && Array.isArray(activation.reasons), JSON.stringify(activation));
}

// ---- aggregator teeth ------------------------------------------------------------------------------
async function runAggregator(shardReports, { expectedSha = null, expectedRunId = null } = {}) {
    const directory = await fs.mkdtemp(path.join(temporary, 'aggregate-'));
    await Promise.all(shardReports.map((shard, index) => fs.writeFile(path.join(directory, `shard-${shard.provenance?.shardIndex ?? index + 1}.json`), JSON.stringify(shard))));
    const args = [path.join(here, 'third-party-extensions-aggregate.mjs'), '--shards', directory, '--out-dir', path.join(directory, 'out')];
    if (expectedSha) args.push('--expected-sha', expectedSha);
    if (expectedRunId) args.push('--expected-run-id', expectedRunId);
    const result = spawnSync(process.execPath, args, { encoding: 'utf8' });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, directory };
}

const realLock = loadLock();
const lockNames = realLock.lock.selected.map(extension => extension.name);
const lockByName = new Map(realLock.lock.selected.map(extension => [extension.name, extension]));
function shardReport(shardIndex, shardCount, names, overrides = {}) {
    return {
        schemaVersion: 1,
        surface: 'third-party-extension-compatibility',
        provenance: {
            extensionsLockSha256: realLock.sha256,
            headSha: 'a'.repeat(40),
            runId: '123',
            shardIndex,
            shardCount,
        },
        expectedNames: names,
        rows: names.map(name => ({
            name,
            repo: lockByName.get(name).repo,
            commit: lockByName.get(name).commit,
            verdict: 'PASS',
            failure: null,
            capabilityVerdicts: { activation: 'PASS', settings: 'PASS', disable: 'PASS', reenable: 'PASS', uninstall: 'PASS', activationAfterRestart: 'PASS' },
            durationMs: 1000,
        })),
        ...overrides,
    };
}
{
    const shards = [shardReport(1, 4, lockNames.filter((_, index) => index % 4 === 0)), shardReport(2, 4, lockNames.filter((_, index) => index % 4 === 1)), shardReport(3, 4, lockNames.filter((_, index) => index % 4 === 2)), shardReport(4, 4, lockNames.filter((_, index) => index % 4 === 3))];
    const result = await runAggregator(shards);
    check('a complete 20-row set passes the aggregator', result.status === 0, result.stderr.slice(-500));
}
{
    const shards = [shardReport(1, 4, lockNames.filter((_, index) => index % 4 === 0)), shardReport(2, 4, lockNames.filter((_, index) => index % 4 === 1)), shardReport(3, 4, lockNames.filter((_, index) => index % 4 === 2))];
    const result = await runAggregator(shards);
    check('a missing shard is a failure', result.status !== 0 && /shard 4 is missing/.test(result.stderr), result.stderr.slice(-400));
}
{
    const shards = [shardReport(1, 4, lockNames.filter((_, index) => index % 4 === 0)), shardReport(2, 4, lockNames.filter((_, index) => index % 4 === 1)), shardReport(3, 4, lockNames.filter((_, index) => index % 4 === 2)), shardReport(4, 4, lockNames.filter((_, index) => index % 4 === 3))];
    shards[3].rows = shards[3].rows.slice(0, -1);
    shards[3].expectedNames = shards[3].rows.map(entry => entry.name);
    const result = await runAggregator(shards);
    check('a silently dropped extension is a failure', result.status !== 0 && /no shard tested/.test(result.stderr), result.stderr.slice(-400));
}
{
    const shards = [shardReport(1, 4, lockNames.filter((_, index) => index % 4 === 0)), shardReport(2, 4, lockNames.filter((_, index) => index % 4 === 1)), shardReport(3, 4, lockNames.filter((_, index) => index % 4 === 2)), shardReport(4, 4, lockNames.filter((_, index) => index % 4 === 3))];
    shards[1].rows[0].name = shards[0].rows[0].name;
    const result = await runAggregator(shards);
    check('a duplicated extension is a failure', result.status !== 0 && /more than one shard/.test(result.stderr), result.stderr.slice(-400));
}
{
    const shards = [shardReport(1, 4, lockNames.filter((_, index) => index % 4 === 0)), shardReport(2, 4, lockNames.filter((_, index) => index % 4 === 1)), shardReport(3, 4, lockNames.filter((_, index) => index % 4 === 2)), shardReport(4, 4, lockNames.filter((_, index) => index % 4 === 3))];
    shards[0].provenance.extensionsLockSha256 = 'd'.repeat(64);
    const result = await runAggregator(shards);
    check('a stale lock hash is a failure', result.status !== 0 && /measured against lock/.test(result.stderr), result.stderr.slice(-400));
}
{
    const shards = [shardReport(1, 4, lockNames.filter((_, index) => index % 4 === 0)), shardReport(2, 4, lockNames.filter((_, index) => index % 4 === 1)), shardReport(3, 4, lockNames.filter((_, index) => index % 4 === 2)), shardReport(4, 4, lockNames.filter((_, index) => index % 4 === 3))];
    shards[0].schemaVersion = 99;
    const result = await runAggregator(shards);
    check('an unknown artifact schema is a failure', result.status !== 0 && /schemaVersion/.test(result.stderr), result.stderr.slice(-400));
}
{
    const shards = [shardReport(1, 4, lockNames.filter((_, index) => index % 4 === 0)), shardReport(2, 4, lockNames.filter((_, index) => index % 4 === 1)), shardReport(3, 4, lockNames.filter((_, index) => index % 4 === 2)), shardReport(4, 4, lockNames.filter((_, index) => index % 4 === 3))];
    const result = await runAggregator(shards, { expectedSha: 'b'.repeat(40) });
    check('a shard from another commit is a failure', result.status !== 0 && /headSha/.test(result.stderr), result.stderr.slice(-400));
}

// ---- lock validation teeth -------------------------------------------------------------------------
{
    const mutated = JSON.parse(JSON.stringify(realLock.lock));
    mutated.selected = mutated.selected.slice(0, 19);
    check('a 19-extension lock is refused', validateLock(mutated).some(problem => /exactly 20/.test(problem)));
}
{
    const mutated = JSON.parse(JSON.stringify(realLock.lock));
    mutated.selected[0].commit = 'abc123';
    check('a short SHA is refused', validateLock(mutated).some(problem => /40-hex/.test(problem)));
}
{
    const mutated = JSON.parse(JSON.stringify(realLock.lock));
    mutated.selected[0].capabilities = ['not-a-capability'];
    check('an unknown capability is refused', validateLock(mutated).some(problem => /unknown capability/.test(problem)));
}
{
    const mutated = JSON.parse(JSON.stringify(realLock.lock));
    mutated.selected[0].name = 'JS-Slash-Runner';
    mutated.selected[0].repo = 'N0VI028/JS-Slash-Runner';
    check('a Tavern Helper row is refused', validateLock(mutated).some(problem => /Tavern Helper/.test(problem)));
}

await fs.rm(temporary, { recursive: true, force: true }).catch(() => {});
console.log(`\n${checks - failures.length}/${checks} harness self-checks passed`);
if (failures.length > 0) {
    console.error('FAILED self-checks:');
    for (const failure of failures) console.error(` - ${failure}`);
    process.exit(1);
}
console.log('the third-party extension gate has teeth');
