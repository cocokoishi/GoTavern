#!/usr/bin/env node
// Capture pinned background deletion, thumbnail invalidation, and metadata cleanup.

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const PINNED_COMMIT = '06bde939fb1e9c4c8d8641d810f0a916b5bce127';
const PINNED_VERSION = '1.19.0';
// @gotavern-oracle: this declaration is read by tools/build-generated-lib.mjs,
// which auto-discovers probes so that adding one needs no edit there.
// @gotavern-oracle: fixture=sillytavern-1.19.0-backgrounds-delete.json label="backgrounds-delete"
const COOKIE_SECRET = 'gotavern-pinned-backgrounds-delete-cookie-secret';
const sourceRoot = path.resolve(process.argv[2] ?? '');
const repositoryRoot = path.resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3]) {
    console.error('usage: node tools/probe-backgrounds-delete.mjs <pinned-source-clone> <gotavern-root>');
    process.exit(2);
}
if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim() !== PINNED_COMMIT) {
    throw new Error('upstream checkout is not pinned at ' + PINNED_COMMIT);
}

const runtimeRoot = mkdtempSync(path.join(os.tmpdir(), 'gotavern-backgrounds-delete-oracle-'));
const dataRoot = path.join(runtimeRoot, 'data');
const configPath = path.join(runtimeRoot, 'config.yaml');
const logs = [];
const goLogs = [];
let child;
let goChild;
let goServerOrigin = '';

function sha256(value) {
    return createHash('sha256').update(value).digest('hex');
}

function safeCleanup() {
    const resolved = path.resolve(runtimeRoot);
    const parent = path.resolve(os.tmpdir());
    if (path.dirname(resolved).toLowerCase() !== parent.toLowerCase()
        || !path.basename(resolved).startsWith('gotavern-backgrounds-delete-oracle-')) {
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

async function request(url, method = 'GET', headers = {}, body) {
    const response = await fetch(url, { method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(10000) });
    let parsedBody = Buffer.from(await response.arrayBuffer()).toString('utf8');
    try {
        parsedBody = parsedBody ? JSON.parse(parsedBody) : null;
    } catch {
        // Preserve plain-text and HTML error bodies.
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

function seedUser(key, value) {
    writeFileSync(path.join(dataRoot, '_storage', sha256(key)), JSON.stringify({ key, value }));
}

function normalizeIndex(indexPath) {
    if (!existsSync(indexPath)) return null;
    return JSON.parse(readFileSync(indexPath, 'utf8'));
}

function cookiesFrom(response) {
    if (typeof response.headers.getSetCookie !== 'function') throw new Error('Node fetch does not expose getSetCookie()');
    return response.headers.getSetCookie();
}

function cookieHeader(cookies) {
    return cookies.map(cookie => cookie.split(';', 1)[0]).join('; ');
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

async function waitForServer(origin, processRef, output, label) {
    const deadline = Date.now() + 180000;
    let lastError;
    while (Date.now() < deadline) {
        if (processRef.exitCode !== null) throw new Error(label + ' exited early:\n' + output.join('').slice(-10000));
        try {
            const result = await request(origin + '/login?noauto=1');
            if (result.response.status === 200 && result.response.headers.get('content-type')?.includes('text/html')) return;
            lastError = new Error('login returned ' + result.response.status);
        } catch (error) {
            lastError = error;
        }
        await new Promise(resolve => setTimeout(resolve, 300));
    }
    throw new Error(label + ' did not become ready: ' + (lastError?.stack ?? 'none') + '\n' + output.join('').slice(-10000));
}

const files = {
    'delete-me.png': Buffer.from('delete me').toString('base64'),
    'keep.png': Buffer.from('keep me').toString('base64'),
    'malformed.png': Buffer.from('remove with malformed metadata index').toString('base64'),
    'thumbfail.png': Buffer.from('remove before invalid thumbnail error').toString('base64'),
    'outside.png': Buffer.from('must not be deleted by traversal').toString('base64'),
    'go-delete.png': Buffer.from('Go delete Node readback').toString('base64'),
};
const mainIndex = JSON.stringify({
    version: 6,
    images: {
        'backgrounds/delete-me.png': {
            hash: 'delete-hash', folderIds: ['forest'], isAnimated: false,
            unknownImageField: { preserve: true },
        },
        'backgrounds/keep.png': { hash: 'keep-hash', folderIds: ['forest'], isAnimated: true },
    },
    folders: [
        { id: 'forest', name: 'Forest', thumbnailFile: 'delete-me.png', unknownFolderField: 17 },
        { id: 'other', name: 'Other', thumbnailFile: 'keep.png' },
        { id: 'second', name: 'Second reference', thumbnailFile: 'delete-me.png' },
    ],
    unknownRoot: { preserve: true },
}, null, 4);
const goRoundTripIndex = JSON.stringify({
    version: 8,
    images: {
        'backgrounds/go-delete.png': { hash: 'go-delete-hash', folderIds: ['gone'], unknown: true },
        'backgrounds/retained.png': { hash: 'retained-hash', folderIds: ['kept'] },
    },
    folders: [
        { id: 'gone', name: 'Gone', thumbnailFile: 'go-delete.png' },
        { id: 'kept', name: 'Kept', thumbnailFile: 'retained.png', unknown: 'preserve' },
    ],
    unknownRoot: { retained: true },
}, null, 4);

try {
    mkdirSync(path.join(dataRoot, '_storage'), { recursive: true });
    writeFileSync(path.join(dataRoot, 'cookie-secret.txt'), COOKIE_SECRET);
    writeFileSync(configPath, 'enableUserAccounts: true\nskipContentCheck: true\n');
    seedUser('user:default-user', {
        handle: 'default-user', name: 'Background Delete Probe', created: 1700000000000,
        password: '', admin: true, enabled: true, salt: '', probeUnknownField: { preserve: true },
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
    await waitForServer(origin, child, logs, 'pinned Node server');

    const userRoot = path.join(dataRoot, 'default-user');
    const backgroundsRoot = path.join(userRoot, 'backgrounds');
    const thumbnailRoot = path.join(userRoot, 'thumbnails', 'bg');
    mkdirSync(backgroundsRoot, { recursive: true });
    mkdirSync(thumbnailRoot, { recursive: true });
    for (const [filename, content] of Object.entries(files)) {
        if (filename === 'go-delete.png') continue;
        writeFileSync(path.join(backgroundsRoot, filename), Buffer.from(content, 'base64'));
    }
    writeFileSync(path.join(thumbnailRoot, 'delete-me.png'), 'thumbnail');
    mkdirSync(path.join(backgroundsRoot, 'folder.png'));
    writeFileSync(path.join(userRoot, 'image-metadata.json'), mainIndex);
    const malformedIndexBytes = '{"version":6,"images":';

    const accountRecordPath = path.join(dataRoot, '_storage', sha256('user:default-user'));
    const accountRecordBefore = readFileSync(accountRecordPath);
    const csrf = await request(origin + '/csrf-token');
    const token = csrf.body.token;
    const csrfCookie = cookieHeader(cookiesFrom(csrf.response));
    const login = await request(origin + '/api/users/login', 'POST', {
        Cookie: csrfCookie, 'Content-Type': 'application/json', 'X-CSRF-Token': token,
    }, JSON.stringify({ handle: 'default-user', password: '' }));
    if (login.response.status !== 200) throw new Error('could not login: ' + login.response.status + ' ' + JSON.stringify(login.body));
    const sessionCookie = cookieHeader(cookiesFrom(login.response));
    const route = '/api/backgrounds/delete';
    const postHeaders = { Cookie: sessionCookie, 'Content-Type': 'application/json', 'X-CSRF-Token': token };
    const responses = {
        unauthorized: capture(await request(origin + route, 'POST', {
            Cookie: csrfCookie, 'Content-Type': 'application/json', 'X-CSRF-Token': token,
        }, JSON.stringify({ bg: 'delete-me.png' }))),
        invalidCSRF: capture(await request(origin + route, 'POST', {
            Cookie: sessionCookie, 'Content-Type': 'application/json',
        }, JSON.stringify({ bg: 'delete-me.png' }))),
        wrongMethod: capture(await request(origin + route, 'GET', { Cookie: sessionCookie })),
        wrongMethodHead: capture(await request(origin + route, 'HEAD', { Cookie: sessionCookie })),
        wrongMethodOptions: capture(await request(origin + route, 'OPTIONS', { Cookie: sessionCookie })),
        deleted: capture(await request(origin + route, 'POST', postHeaders, JSON.stringify({ bg: 'delete-me.png' }))),
    };
    const afterDelete = {
        backgroundExists: existsSync(path.join(backgroundsRoot, 'delete-me.png')),
        thumbnailExists: existsSync(path.join(thumbnailRoot, 'delete-me.png')),
        index: normalizeIndex(path.join(userRoot, 'image-metadata.json')),
    };
    responses.missingFile = capture(await request(origin + route, 'POST', postHeaders, JSON.stringify({ bg: 'delete-me.png' })));
    responses.sanitizedName = capture(await request(origin + route, 'POST', postHeaders, JSON.stringify({ bg: 'bad?name.png' })));
    responses.pathSeparator = capture(await request(origin + route, 'POST', postHeaders, JSON.stringify({ bg: '../outside.png' })));
    responses.missingField = capture(await request(origin + route, 'POST', postHeaders, '{}'));
    responses.noBody = capture(await request(origin + route, 'POST', { Cookie: sessionCookie, 'X-CSRF-Token': token }));
    responses.directoryTarget = capture(await request(origin + route, 'POST', postHeaders, JSON.stringify({ bg: 'folder.png' })));

    writeFileSync(path.join(backgroundsRoot, 'malformed.png'), Buffer.from(files['malformed.png'], 'base64'));
    writeFileSync(path.join(userRoot, 'image-metadata.json'), malformedIndexBytes);
    responses.malformedIndexDelete = capture(await request(origin + route, 'POST', postHeaders, JSON.stringify({ bg: 'malformed.png' })));
    const malformedIndexAfter = readFileSync(path.join(userRoot, 'image-metadata.json'), 'utf8');
    const malformedFileExistsAfter = existsSync(path.join(backgroundsRoot, 'malformed.png'));

    writeFileSync(path.join(backgroundsRoot, 'thumbfail.png'), Buffer.from(files['thumbfail.png'], 'base64'));
    mkdirSync(path.join(thumbnailRoot, 'thumbfail.png'));
    const thumbfailIndex = {
        version: 3,
        images: { 'backgrounds/thumbfail.png': { hash: 'thumbfail', folderIds: ['retain'] } },
        folders: [{ id: 'retain', name: 'Retain', thumbnailFile: 'thumbfail.png' }],
        unknownRoot: 'preserve',
    };
    writeFileSync(path.join(userRoot, 'image-metadata.json'), JSON.stringify(thumbfailIndex, null, 4));
    responses.thumbnailFailure = capture(await request(origin + route, 'POST', postHeaders, JSON.stringify({ bg: 'thumbfail.png' })));
    const afterThumbnailFailure = {
        backgroundExists: existsSync(path.join(backgroundsRoot, 'thumbfail.png')),
        thumbnailIsDirectory: existsSync(path.join(thumbnailRoot, 'thumbfail.png')),
        index: normalizeIndex(path.join(userRoot, 'image-metadata.json')),
    };

    const goFile = path.join(backgroundsRoot, 'go-delete.png');
    writeFileSync(goFile, Buffer.from(files['go-delete.png'], 'base64'));
    writeFileSync(path.join(thumbnailRoot, 'go-delete.png'), 'go thumbnail');
    writeFileSync(path.join(userRoot, 'image-metadata.json'), goRoundTripIndex);
    const goPort = await choosePort();
    goServerOrigin = 'http://127.0.0.1:' + goPort;
    goChild = spawn('go', ['run', './tools/image-metadata-roundtrip', dataRoot, String(goPort), '{}'], {
        cwd: repositoryRoot, stdio: ['ignore', 'pipe', 'pipe'],
    });
    goChild.stdout.setEncoding('utf8');
    goChild.stderr.setEncoding('utf8');
    goChild.stdout.on('data', chunk => goLogs.push(chunk));
    goChild.stderr.on('data', chunk => goLogs.push(chunk));
    await waitForServer(goServerOrigin, goChild, goLogs, 'GoTavern background deletion probe server');
    const goResponse = capture(await request(goServerOrigin + route, 'POST', postHeaders, JSON.stringify({ bg: 'go-delete.png' })));
    if (goResponse.status !== 200) {
        throw new Error('GoTavern background deletion returned ' + goResponse.status + ': ' + JSON.stringify(goResponse.body) + '\n' + goLogs.join('').slice(-10000));
    }
    const nodeReadback = capture(await request(origin + '/api/image-metadata/all', 'POST', postHeaders, JSON.stringify({ prefix: 'backgrounds/' })));
    const goRoundTripState = {
        goResponse,
        nodeReadback,
        backgroundExists: existsSync(goFile),
        thumbnailExists: existsSync(path.join(thumbnailRoot, 'go-delete.png')),
    };
    await stopGoServer();

    const fixture = {
        schemaVersion: 1,
        baseline: { version: PINNED_VERSION, commit: PINNED_COMMIT },
        probe: 'POST /api/backgrounds/delete removes the validated background and thumbnail, deletes its metadata and clears matching folder thumbnail references; removal tolerates malformed metadata JSON, while thumbnail unlink failures surface after the background is removed',
        inputs: {
            cookieSecret: COOKIE_SECRET,
            files,
            mainIndex,
            malformedIndexBytes,
            thumbfailIndex,
            goRoundTripIndex,
        },
        responses,
        state: {
            afterDelete,
            malformedIndexAfter,
            malformedFileExistsAfter,
            afterThumbnailFailure,
            goRoundTrip: goRoundTripState,
            accountRecordUnchanged: accountRecordBefore.equals(readFileSync(accountRecordPath)),
        },
    };
    const outputFile = path.join(repositoryRoot, 'tests', 'oracle', 'sillytavern-1.19.0-backgrounds-delete.json');
    mkdirSync(path.dirname(outputFile), { recursive: true });
    writeFileSync(outputFile, JSON.stringify(fixture, null, 2) + '\n');
    console.log('Wrote tests/oracle/sillytavern-1.19.0-backgrounds-delete.json from pinned deletion behavior');
} catch (error) {
    console.error(error);
    process.exitCode = 1;
} finally {
    await stopGoServer();
    await stopServer();
    safeCleanup();
}
