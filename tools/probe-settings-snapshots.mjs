#!/usr/bin/env node
// Capture pinned per-user settings snapshot routes and filesystem effects.

import { execFileSync, spawn } from 'node:child_process';
import { createHash, scryptSync } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const PINNED_COMMIT = '06bde939fb1e9c4c8d8641d810f0a916b5bce127';
const PINNED_VERSION = '1.19.0';
// @gotavern-oracle: this declaration is read by tools/build-generated-lib.mjs,
// which auto-discovers probes so that adding one needs no edit there.
// @gotavern-oracle: fixture=sillytavern-1.19.0-settings-snapshots.json label="settings-snapshots"
const COOKIE_SECRET = 'gotavern-pinned-settings-snapshots-cookie-secret';
const PASSWORD = 'settings-snapshots-protected-password';
const SALT = Buffer.from('settings-snapshots-salt').toString('base64');
const sourceRoot = path.resolve(process.argv[2] ?? '');
const repositoryRoot = path.resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3]) {
    console.error('usage: node tools/probe-settings-snapshots.mjs <pinned-source-clone> <gotavern-root>');
    process.exit(2);
}
if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim() !== PINNED_COMMIT) {
    throw new Error(`upstream checkout is not pinned at ${PINNED_COMMIT}`);
}

const runtimeRoot = mkdtempSync(path.join(os.tmpdir(), 'gotavern-settings-snapshots-oracle-'));
const dataRoot = path.join(runtimeRoot, 'data');
const configPath = path.join(runtimeRoot, 'config.yaml');
const logs = [];
let child;

function sha256(value) {
    return createHash('sha256').update(value).digest('hex');
}

function safeCleanup() {
    const resolved = path.resolve(runtimeRoot);
    const parent = path.resolve(os.tmpdir());
    if (path.dirname(resolved).toLowerCase() !== parent.toLowerCase()
        || !path.basename(resolved).startsWith('gotavern-settings-snapshots-oracle-')) {
        throw new Error(`refusing to remove unexpected runtime path: ${resolved}`);
    }
    rmSync(resolved, { recursive: true, force: true });
}

async function choosePort() {
    const server = net.createServer();
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const port = server.address().port;
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    return port;
}

async function stopServer() {
    if (!child || child.exitCode !== null) return;
    child.kill('SIGINT');
    await Promise.race([
        new Promise(resolve => child.once('exit', resolve)),
        new Promise(resolve => setTimeout(resolve, 5000)),
    ]);
    if (child.exitCode === null) child.kill();
}

async function request(url, method = 'GET', headers = {}, body) {
    const response = await fetch(url, { method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(10000) });
    let parsedBody = Buffer.from(await response.arrayBuffer()).toString('utf8');
    try {
        parsedBody = parsedBody ? JSON.parse(parsedBody) : null;
    } catch {
        // Preserve plain-text responses.
    }
    return { response, body: parsedBody };
}

function stableHeaders(response) {
    return Object.fromEntries([...response.headers.entries()]
        .filter(([name]) => !['connection', 'date', 'keep-alive', 'last-modified', 'set-cookie', 'x-response-time'].includes(name))
        .sort(([left], [right]) => left.localeCompare(right)));
}

function cookiesFrom(response) {
    if (typeof response.headers.getSetCookie !== 'function') throw new Error('Node fetch does not expose getSetCookie()');
    return response.headers.getSetCookie();
}

function cookieHeader(cookies) {
    return cookies.map(cookie => cookie.split(';', 1)[0]).join('; ');
}

function capture(result, normalizeSnapshotList = false) {
    let body = result.body;
    const headers = stableHeaders(result.response);
    if (normalizeSnapshotList && Array.isArray(body)) {
        // Pinned src/endpoints/settings.js:300 lists snapshots with
        // fs.readdirSync(request.user.directories.backups) and no sort, so the
        // array order is the host filesystem's directory order (NTFS returns
        // name-sorted entries, ext4/overlayfs do not). Canonicalising the
        // recorded entries by the UTF-8 bytes of the raw snapshot name makes
        // the observation host independent; the Go differential test compares
        // the response as an unordered multiset for the same reason. The
        // filtered entry set, dates and sizes are unchanged.
        body = [...body].sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)));
        body = body.map(entry => ({ ...entry, date: '<ctime>', name: entry.name.replace(/\d{8}-\d{6}/g, '<timestamp>') }));
        headers['content-length'] = '<dynamic>';
        headers.etag = '<dynamic>';
    }
    return { status: result.response.status, headers, body };
}

function seedUser(dataRootPath, key, value) {
    writeFileSync(path.join(dataRootPath, '_storage', sha256(key)), JSON.stringify({ key, value }));
}

function backupState(directory) {
    const backups = [];
    if (!existsSync(directory)) return backups;
    for (const name of readdirSync(directory).sort()) {
        const absolute = path.join(directory, name);
        const info = statSync(absolute);
        if (!info.isFile()) continue;
        const bytes = readFileSync(absolute);
        backups.push({
            name: name.replace(/\d{8}-\d{6}/g, '<timestamp>'),
            sha256: sha256(bytes),
            bytes: bytes.length,
        });
    }
    return backups;
}

function fileState(file) {
    if (!existsSync(file)) return null;
    const bytes = readFileSync(file);
    return { sha256: sha256(bytes), bytes: bytes.length, content: bytes.toString('utf8') };
}

try {
    mkdirSync(path.join(dataRoot, '_storage'), { recursive: true });
    writeFileSync(path.join(dataRoot, 'cookie-secret.txt'), COOKIE_SECRET);
    writeFileSync(configPath, 'enableUserAccounts: true\nskipContentCheck: true\nbackups:\n  common:\n    numberOfBackups: 2\n');
    const passwordHash = scryptSync(PASSWORD.normalize('NFC'), SALT, 64).toString('base64');
    seedUser(dataRoot, 'user:default-user', {
        handle: 'default-user', name: 'Protected User', created: 1700000000000,
        password: passwordHash, admin: true, enabled: true, salt: SALT,
        probeUnknownField: { preserve: true },
    });

    const port = await choosePort();
    const origin = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, [
        'server.js', '--configPath', configPath, '--dataRoot', dataRoot,
        '--listenAddressIPv4', '127.0.0.1', '--enableIPv4', 'true', '--enableIPv6', 'false',
        '--listen', 'false', '--port', String(port), '--browserLaunchEnabled', 'false', '--heartbeatInterval', '0',
    ], { cwd: sourceRoot, env: { ...process.env, NODE_ENV: 'test' }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => logs.push(chunk));
    child.stderr.on('data', chunk => logs.push(chunk));
    const deadline = Date.now() + 180000;
    let ready = false;
    let lastError;
    while (Date.now() < deadline && !ready) {
        if (child.exitCode !== null) throw new Error(`pinned server exited before readiness:\n${logs.join('').slice(-10000)}`);
        try {
            const result = await request(`${origin}/login?noauto=1`);
            ready = result.response.status === 200 && result.response.headers.get('content-type')?.includes('text/html');
            if (!ready) lastError = new Error(`login returned ${result.response.status}`);
        } catch (error) {
            lastError = error;
        }
        if (!ready) await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (!ready) throw new Error(`pinned server did not become ready: ${lastError?.stack ?? 'none'}\n${logs.join('').slice(-10000)}`);

    const userRoot = path.join(dataRoot, 'default-user');
    const backupsRoot = path.join(userRoot, 'backups');
    const settingsPath = path.join(userRoot, 'settings.json');
    const accountRecordPath = path.join(dataRoot, '_storage', sha256('user:default-user'));
    const accountRecordBefore = readFileSync(accountRecordPath);
    rmSync(backupsRoot, { recursive: true, force: true });
    mkdirSync(backupsRoot, { recursive: true });
    const oldSnapshotName = 'settings_default-user_older.json';
    const newSnapshotName = 'settings_default-user_newer.json';
    const snapshots = [
        [oldSnapshotName, '{"snapshot":"older"}', Date.UTC(2024, 0, 1)],
        [newSnapshotName, '{"snapshot":"newer"}', Date.UTC(2024, 0, 2)],
        ['settings_another-user_private.json', '{"snapshot":"other user"}', Date.UTC(2024, 0, 3)],
    ];
    for (const [name, contents, modified] of snapshots) {
        const file = path.join(backupsRoot, name);
        writeFileSync(file, contents);
        const when = new Date(modified);
        utimesSync(file, when, when);
    }
    writeFileSync(settingsPath, '{"settings":"before snapshots"}');
    const seedBackupState = backupState(backupsRoot);

    const csrf = await request(`${origin}/csrf-token`);
    const token = csrf.body.token;
    const csrfCookie = cookieHeader(cookiesFrom(csrf.response));
    const login = await request(`${origin}/api/users/login`, 'POST', {
        Cookie: csrfCookie,
        'Content-Type': 'application/json',
        'X-CSRF-Token': token,
    }, JSON.stringify({ handle: 'default-user', password: PASSWORD }));
    if (login.response.status !== 200) throw new Error(`could not login: ${login.response.status} ${JSON.stringify(login.body)}\n${logs.join('').slice(-10000)}`);
    const sessionCookie = cookieHeader(cookiesFrom(login.response));
    const post = (route, body, cookie = sessionCookie) => request(`${origin}/api/settings/${route}`, 'POST', {
        Cookie: cookie,
        'Content-Type': 'application/json',
        'X-CSRF-Token': token,
    }, body === undefined ? undefined : JSON.stringify(body));

    const responses = {};
    responses.unauthorizedList = capture(await post('get-snapshots', {}, csrfCookie));
    responses.listInitial = capture(await post('get-snapshots', {}), true);
    responses.loadOlder = capture(await post('load-snapshot', { name: oldSnapshotName }));
    responses.loadForeign = capture(await post('load-snapshot', { name: 'settings_another-user_private.json' }));
    responses.loadMissing = capture(await post('load-snapshot', { name: 'settings_default-user_missing.json' }));
    responses.loadSlash = capture(await post('load-snapshot', { name: 'settings_default-user/older.json' }));
    responses.loadNoName = capture(await post('load-snapshot', {}));
    responses.restoreOlder = capture(await post('restore-snapshot', { name: oldSnapshotName }));
    const afterRestoreOlder = fileState(settingsPath);
    const backupsAfterRestore = backupState(backupsRoot);

    writeFileSync(settingsPath, '{"settings":"saved after restore"}');
    responses.makeSnapshot = capture(await post('make-snapshot'));
    const backupsAfterMake = backupState(backupsRoot);
    const listAfterMake = await post('get-snapshots', {});
    responses.listAfterMake = capture(listAfterMake, true);
    const newlyMade = listAfterMake.body.find(entry => entry.name.startsWith('settings_default-user_') && ![oldSnapshotName, newSnapshotName].includes(entry.name));
    if (!newlyMade) throw new Error(`make-snapshot did not create a new user snapshot: ${JSON.stringify(listAfterMake.body)}`);
    responses.loadNew = capture(await post('load-snapshot', { name: newlyMade.name }));
    responses.restoreNew = capture(await post('restore-snapshot', { name: newlyMade.name }));
    const afterRestoreNew = fileState(settingsPath);
    responses.restoreMissing = capture(await post('restore-snapshot', { name: 'settings_default-user_missing.json' }));
    responses.restoreSlash = capture(await post('restore-snapshot', { name: 'settings_default-user/older.json' }));
    responses.restoreNoName = capture(await post('restore-snapshot', {}));

    // A manual snapshot with a missing settings source still succeeds without
    // creating a backup, matching backupUserSettings()'s early return.
    rmSync(settingsPath);
    const beforeMissingSourceMake = backupState(backupsRoot);
    responses.makeSnapshotMissingSettings = capture(await post('make-snapshot'));
    const afterMissingSourceMake = backupState(backupsRoot);
    await stopServer();
    const accountRecordUnchanged = accountRecordBefore.equals(readFileSync(accountRecordPath));

    // Verify that the pinned Node installation can read a Go-created snapshot,
    // and that Go can restore a snapshot created by Node.
    const roundTripRoot = path.join(dataRoot, 'roundtrip-user');
    const roundTripBackups = path.join(roundTripRoot, 'backups');
    mkdirSync(roundTripBackups, { recursive: true });
    const nodeSettings = Buffer.from('{"roundtrip":"node settings read by Go"}');
    writeFileSync(path.join(roundTripRoot, 'settings.json'), nodeSettings);
    const goCreateOutput = execFileSync('go', [
        'run', './tools/settings-snapshot-roundtrip', 'create', dataRoot, 'roundtrip-user', '2',
    ], { cwd: repositoryRoot, encoding: 'utf8' });
    const goCreatedSnapshotName = JSON.parse(goCreateOutput).name;
    const goCreatedSnapshot = readFileSync(path.join(roundTripBackups, goCreatedSnapshotName));
    const nodeSnapshotName = 'settings_roundtrip-user_node-roundtrip.json';
    const nodeSnapshot = Buffer.from('{"roundtrip":"node snapshot restored by Go"}');
    writeFileSync(path.join(roundTripBackups, nodeSnapshotName), nodeSnapshot);
    const goRestoreOutput = execFileSync('go', [
        'run', './tools/settings-snapshot-roundtrip', 'restore', dataRoot, 'roundtrip-user', nodeSnapshotName,
    ], { cwd: repositoryRoot, encoding: 'utf8' });
    const goRestoredNodeSnapshot = readFileSync(path.join(roundTripRoot, 'settings.json'));
    const roundTrip = {
        nodeSettings: { sha256: sha256(nodeSettings), bytes: nodeSettings.length },
        goCreatedSnapshot: {
            name: goCreatedSnapshotName.replace(/\d{8}-\d{6}/g, '<timestamp>'),
            sha256: sha256(goCreatedSnapshot),
            bytes: goCreatedSnapshot.length,
            readableByNode: goCreatedSnapshot.equals(nodeSettings),
        },
        nodeSnapshot: { sha256: sha256(nodeSnapshot), bytes: nodeSnapshot.length },
        goRestoreResult: JSON.parse(goRestoreOutput),
        goRestoredNodeSnapshot: {
            sha256: sha256(goRestoredNodeSnapshot),
            bytes: goRestoredNodeSnapshot.length,
            readableByNode: goRestoredNodeSnapshot.equals(nodeSnapshot),
        },
    };

    const fixture = {
        schemaVersion: 1,
        baseline: { version: PINNED_VERSION, commit: PINNED_COMMIT },
        probe: 'pinned per-user settings snapshot list/load/create/restore authorization and filesystem behavior',
        inputs: { cookieSecret: COOKIE_SECRET, password: PASSWORD, salt: SALT },
        responses,
        roundTrip,
        filesystem: {
            settingsFileName: 'settings.json',
            initialSettings: { sha256: sha256(Buffer.from('{"settings":"before snapshots"}')), bytes: Buffer.byteLength('{"settings":"before snapshots"}') },
            seededBackups: seedBackupState,
            afterRestoreOlder: afterRestoreOlder && { sha256: afterRestoreOlder.sha256, bytes: afterRestoreOlder.bytes, content: afterRestoreOlder.content },
            backupsAfterRestore,
            backupsAfterMake,
            afterRestoreNew,
            backupsAfterMissingSourceMake: { before: beforeMissingSourceMake, after: afterMissingSourceMake },
            accountRecordUnchanged,
        },
    };
    const outputFile = path.join(repositoryRoot, 'tests', 'oracle', 'sillytavern-1.19.0-settings-snapshots.json');
    mkdirSync(path.dirname(outputFile), { recursive: true });
    writeFileSync(outputFile, `${JSON.stringify(fixture, null, 2)}\n`);
    console.log(`Wrote ${path.relative(repositoryRoot, outputFile)} from pinned settings snapshot behavior`);
} catch (error) {
    console.error(error);
    process.exitCode = 1;
} finally {
    await stopServer();
    safeCleanup();
}
