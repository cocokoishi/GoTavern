#!/usr/bin/env node
// Capture pinned persona-avatar deletion, validation, thumbnail cleanup, and redirect behavior.

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const PINNED_COMMIT = '06bde939fb1e9c4c8d8641d810f0a916b5bce127';
const PINNED_VERSION = '1.19.0';
const COOKIE_SECRET = 'gotavern-pinned-avatars-delete-cookie-secret';
const sourceRoot = path.resolve(process.argv[2] ?? '');
const repositoryRoot = path.resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3]) {
    console.error('usage: node tools/probe-avatars-delete.mjs <pinned-source-clone> <gotavern-root>');
    process.exit(2);
}
if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim() !== PINNED_COMMIT) {
    throw new Error('upstream checkout is not pinned at ' + PINNED_COMMIT);
}

const runtimeRoot = mkdtempSync(path.join(os.tmpdir(), 'gotavern-avatars-delete-oracle-'));
const dataRoot = path.join(runtimeRoot, 'data');
const configPath = path.join(runtimeRoot, 'config.yaml');
const logs = [];
let child;
let goChild;
let goServerOrigin = '';
const goLogs = [];

function sha256(value) {
    return createHash('sha256').update(value).digest('hex');
}

function safeCleanup() {
    const resolved = path.resolve(runtimeRoot);
    const parent = path.resolve(os.tmpdir());
    if (path.dirname(resolved).toLowerCase() !== parent.toLowerCase()
        || !path.basename(resolved).startsWith('gotavern-avatars-delete-oracle-')) {
        throw new Error('refusing to remove unexpected runtime path: ' + resolved);
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

async function stopGoServer() {
    if (!goChild || goChild.exitCode !== null) return;
    try {
        await request(goServerOrigin + '/_gotavern-probe/shutdown', 'POST');
    } catch {
        // The process may already be stopping after a failed probe.
    }
    await Promise.race([
        new Promise(resolve => goChild.once('exit', resolve)),
        new Promise(resolve => setTimeout(resolve, 5000)),
    ]);
    if (goChild.exitCode === null) goChild.kill();
}

async function waitForGoServer(origin) {
    const deadline = Date.now() + 60000;
    let lastError;
    while (Date.now() < deadline) {
        if (goChild.exitCode !== null) throw new Error('GoTavern probe server exited early:\n' + goLogs.join('').slice(-10000));
        try {
            const result = await request(origin + '/login?noauto=1');
            if (result.response.status === 200) return;
            lastError = new Error('GoTavern /version returned ' + result.response.status);
        } catch (error) {
            lastError = error;
        }
        await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw new Error('GoTavern probe server did not become ready: ' + (lastError?.stack ?? 'none') + '\n' + goLogs.join('').slice(-10000));
}

async function request(url, method = 'GET', headers = {}, body) {
    const response = await fetch(url, { method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(10000) });
    let parsedBody = Buffer.from(await response.arrayBuffer()).toString('utf8');
    try {
        parsedBody = parsedBody ? JSON.parse(parsedBody) : null;
    } catch {
        // Preserve plain-text response bodies.
    }
    return { response, body: parsedBody };
}

function stableHeaders(response) {
    return Object.fromEntries([...response.headers.entries()]
        .filter(([name]) => !['connection', 'date', 'keep-alive', 'last-modified', 'set-cookie', 'x-response-time'].includes(name))
        .sort(([left], [right]) => left.localeCompare(right)));
}

function capture(result) {
    return { status: result.response.status, headers: stableHeaders(result.response), body: result.body };
}

function cookiesFrom(response) {
    if (typeof response.headers.getSetCookie !== 'function') throw new Error('Node fetch does not expose getSetCookie()');
    return response.headers.getSetCookie();
}

function cookieHeader(cookies) {
    return cookies.map(cookie => cookie.split(';', 1)[0]).join('; ');
}

function seedUser(key, value) {
    writeFileSync(path.join(dataRoot, '_storage', sha256(key)), JSON.stringify({ key, value }));
}

try {
    mkdirSync(path.join(dataRoot, '_storage'), { recursive: true });
    writeFileSync(path.join(dataRoot, 'cookie-secret.txt'), COOKIE_SECRET);
    writeFileSync(configPath, 'enableUserAccounts: true\nskipContentCheck: true\n');
    seedUser('user:default-user', {
        handle: 'default-user', name: 'Avatar Reader', created: 1700000000000,
        password: '', admin: true, enabled: true, salt: '',
        probeUnknownField: { preserve: true },
    });

    const port = await choosePort();
    const origin = 'http://127.0.0.1:' + port;
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
        if (child.exitCode !== null) throw new Error('pinned server exited before readiness:\n' + logs.join('').slice(-10000));
        try {
            const result = await request(origin + '/login?noauto=1');
            ready = result.response.status === 200 && result.response.headers.get('content-type')?.includes('text/html');
            if (!ready) lastError = new Error('login returned ' + result.response.status);
        } catch (error) {
            lastError = error;
        }
        if (!ready) await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (!ready) throw new Error('pinned server did not become ready: ' + (lastError?.stack ?? 'none') + '\n' + logs.join('').slice(-10000));

    const userRoot = path.join(dataRoot, 'default-user');
    const avatarsRoot = path.join(userRoot, 'User Avatars');
    const thumbnailsRoot = path.join(userRoot, 'thumbnails', 'persona');
    mkdirSync(avatarsRoot, { recursive: true });
    mkdirSync(thumbnailsRoot, { recursive: true });
    const files = [
        { directory: 'avatars', name: 'persona.png', kind: 'file', content: 'persona-original' },
        { directory: 'avatars', name: 'other.png', kind: 'file', content: 'other-original' },
        { directory: 'thumbnailsPersona', name: 'persona.png', kind: 'file', content: 'persona-thumbnail' },
        { directory: 'thumbnailsPersona', name: 'other.png', kind: 'file', content: 'other-thumbnail' },
    ];
    for (const file of files) {
        const directory = file.directory === 'avatars' ? avatarsRoot : thumbnailsRoot;
        writeFileSync(path.join(directory, file.name), file.content);
    }
    const accountRecordPath = path.join(dataRoot, '_storage', sha256('user:default-user'));
    const accountRecordBefore = readFileSync(accountRecordPath);
    const csrf = await request(origin + '/csrf-token');
    const token = csrf.body.token;
    const csrfCookie = cookieHeader(cookiesFrom(csrf.response));
    const login = await request(origin + '/api/users/login', 'POST', {
        Cookie: csrfCookie,
        'Content-Type': 'application/json',
        'X-CSRF-Token': token,
    }, JSON.stringify({ handle: 'default-user', password: '' }));
    if (login.response.status !== 200) throw new Error('could not login: ' + login.response.status + ' ' + JSON.stringify(login.body));
    const sessionCookie = cookieHeader(cookiesFrom(login.response));
    const requests = {
        deleteAvatar: { avatar: 'persona.png' },
        missingAvatar: { avatar: 'missing.png' },
        invalidSeparator: { avatar: '../outside.png' },
        sanitizerMismatch: { avatar: 'bad?name.png' },
    };
    const post = (route, body, cookie = sessionCookie) => request(origin + route, 'POST', {
        Cookie: cookie,
        'Content-Type': 'application/json',
        'X-CSRF-Token': token,
    }, JSON.stringify(body));
    const snapshotFolder = directory => readdirSync(directory).sort().map(name => {
        const target = path.join(directory, name);
        const info = statSync(target);
        return {
            name,
            kind: info.isFile() ? 'file' : info.isDirectory() ? 'directory' : 'other',
            ...(info.isFile() ? { sha256: sha256(readFileSync(target)) } : {}),
        };
    });
    const snapshotState = () => ({ avatars: snapshotFolder(avatarsRoot), thumbnails: snapshotFolder(thumbnailsRoot) });
    const responses = {};
    const fileStates = { initial: snapshotState() };
    const perform = async (label, route, body, cookie = sessionCookie) => {
        responses[label] = capture(await post(route, body, cookie));
        fileStates[label] = snapshotState();
    };
    await perform('unauthorized', '/api/avatars/delete', requests.deleteAvatar, csrfCookie);
    await perform('legacyRedirect', '/deleteuseravatar', requests.deleteAvatar);
    await perform('deleteAvatar', '/api/avatars/delete', requests.deleteAvatar);
    await perform('deleteAvatarAgain', '/api/avatars/delete', requests.deleteAvatar);
    await perform('missingAvatar', '/api/avatars/delete', requests.missingAvatar);
    await perform('invalidSeparator', '/api/avatars/delete', requests.invalidSeparator);
    await perform('sanitizerMismatch', '/api/avatars/delete', requests.sanitizerMismatch);
    const goRoundTripInput = {
        avatar: 'go-route.png',
        avatarContent: 'go-roundtrip-avatar',
        thumbnailContent: 'go-roundtrip-thumbnail',
    };
    writeFileSync(path.join(avatarsRoot, goRoundTripInput.avatar), goRoundTripInput.avatarContent);
    writeFileSync(path.join(thumbnailsRoot, goRoundTripInput.avatar), goRoundTripInput.thumbnailContent);
    const goPort = await choosePort();
    goServerOrigin = 'http://127.0.0.1:' + goPort;
    goChild = spawn('go', ['run', './tools/avatars-delete-roundtrip', dataRoot, String(goPort)], {
        cwd: repositoryRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    goChild.stdout.setEncoding('utf8');
    goChild.stderr.setEncoding('utf8');
    goChild.stdout.on('data', chunk => goLogs.push(chunk));
    goChild.stderr.on('data', chunk => goLogs.push(chunk));
    await waitForGoServer(goServerOrigin);
    const goDelete = await request(goServerOrigin + '/api/avatars/delete', 'POST', {
        Cookie: sessionCookie,
        'Content-Type': 'application/json',
        'X-CSRF-Token': token,
    }, JSON.stringify({ avatar: goRoundTripInput.avatar }));
    if (goDelete.response.status !== 200) {
        throw new Error('GoTavern avatar delete returned ' + goDelete.response.status + ': ' + JSON.stringify(goDelete.body) + '\n' + goLogs.join('').slice(-10000));
    }
    const nodeReadback = await request(origin + '/api/avatars/get', 'POST', {
        Cookie: sessionCookie,
        'X-CSRF-Token': token,
    });
    if (nodeReadback.response.status !== 200 || nodeReadback.body.includes(goRoundTripInput.avatar)) {
        throw new Error('pinned Node did not observe GoTavern avatar deletion: ' + JSON.stringify(nodeReadback.body));
    }
    const goRoundTrip = {
        goResponse: capture(goDelete),
        nodeAvatarList: capture(nodeReadback),
        fileState: snapshotState(),
    };
    await stopGoServer();
    const accountRecordUnchanged = accountRecordBefore.equals(readFileSync(accountRecordPath));
    const fixture = {
        schemaVersion: 1,
        baseline: { version: PINNED_VERSION, commit: PINNED_COMMIT },
        probe: 'pinned persona-avatar deletion validates names, deletes matching files and thumbnails, authenticates, and preserves the legacy redirect',
        inputs: { cookieSecret: COOKIE_SECRET, files, requests, goRoundTripInput },
        responses,
        state: { fileStates, accountRecordUnchanged, goRoundTrip },
    };
    await stopServer();
    const outputFile = path.join(repositoryRoot, 'tests', 'oracle', 'sillytavern-1.19.0-avatars-delete.json');
    mkdirSync(path.dirname(outputFile), { recursive: true });
    writeFileSync(outputFile, JSON.stringify(fixture, null, 2) + '\n');
    console.log('Wrote tests/oracle/sillytavern-1.19.0-avatars-delete.json from pinned avatar-delete behavior');
} catch (error) {
    console.error(error);
    process.exitCode = 1;
} finally {
    await stopGoServer();
    await stopServer();
    safeCleanup();
}
