#!/usr/bin/env node
// Capture pinned folder-thumbnail batch writes and a Go-to-Node persistence round trip.

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const PINNED_COMMIT = '06bde939fb1e9c4c8d8641d810f0a916b5bce127';
const PINNED_VERSION = '1.19.0';
const COOKIE_SECRET = 'gotavern-pinned-image-metadata-set-thumbnails-cookie-secret';
const sourceRoot = path.resolve(process.argv[2] ?? '');
const repositoryRoot = path.resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3]) {
    console.error('usage: node tools/probe-image-metadata-set-thumbnails.mjs <pinned-source-clone> <gotavern-root>');
    process.exit(2);
}
if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim() !== PINNED_COMMIT) {
    throw new Error('upstream checkout is not pinned at ' + PINNED_COMMIT);
}

const runtimeRoot = mkdtempSync(path.join(os.tmpdir(), 'gotavern-image-metadata-set-thumbnails-oracle-'));
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
        || !path.basename(resolved).startsWith('gotavern-image-metadata-set-thumbnails-oracle-')) {
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
            lastError = new Error('GoTavern login returned ' + result.response.status);
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

const indexes = {
    populated: JSON.stringify({
        version: 2,
        images: { 'backgrounds/forest.webp': { folderIds: ['alpha'], probeImageField: { preserve: true } } },
        folders: [
            { id: 'alpha', name: 'Alpha', thumbnailFile: '', probeFolderField: { keep: true } },
            { id: 7, name: 'Numeric', thumbnailFile: '', probeNumericID: true },
            { id: 'beta', name: 'Beta', thumbnailFile: 'preset.jpg', unknown: ['retain'] },
        ],
        probeRootField: { preserve: 1 },
    }, null, 4),
    empty: '{"version":4,"images":{},"folders":[],"unknown":"retain"}',
    missingFolders: '{"version":5,"images":{},"unknown":true}',
    nullFolders: '{"version":6,"images":{},"folders":null}',
    nullFolderEntry: '{"version":7,"images":{},"folders":[null]}',
    nullImages: '{"version":8,"images":null,"folders":[]}',
    malformed: '{"version":',
    nullRoot: 'null',
    missing: null,
};

const requests = {
    validBatch: {
        index: 'populated',
        body: { updates: [
            { id: 'alpha', thumbnailFile: 'forest.webp' },
            { id: 7, thumbnailFile: 'numeric.png' },
            { id: 'missing', thumbnailFile: 'ignored.webp' },
            { id: 'alpha', thumbnailFile: 'final.webp' },
        ] },
    },
    validEmpty: { index: 'empty', body: { updates: [] } },
    missingIndex: { index: 'missing', body: { updates: [{ id: 'new', thumbnailFile: 'new.png' }] } },
    malformedIndex: { index: 'malformed', body: { updates: [] } },
    missingFoldersEmpty: { index: 'missingFolders', body: { updates: [] } },
    missingFoldersUpdate: { index: 'missingFolders', body: { updates: [{ id: 'missing', thumbnailFile: 'x' }] } },
    nullFoldersEmpty: { index: 'nullFolders', body: { updates: [] } },
    nullFoldersUpdate: { index: 'nullFolders', body: { updates: [{ id: 'missing', thumbnailFile: 'x' }] } },
    nullFolderEntry: { index: 'nullFolderEntry', body: { updates: [{ id: 'missing', thumbnailFile: 'x' }] } },
    nullImages: { index: 'nullImages', body: { updates: [{ id: 'missing', thumbnailFile: 'x' }] } },
    nullRootEmpty: { index: 'nullRoot', body: { updates: [] } },
    nullRootUpdate: { index: 'nullRoot', body: { updates: [{ id: 'missing', thumbnailFile: 'x' }] } },
    missingUpdates: { index: 'populated', body: {} },
    nonArrayUpdates: { index: 'populated', body: { updates: {} } },
    nullUpdates: { index: 'populated', body: { updates: null } },
    missingID: { index: 'populated', body: { updates: [{ thumbnailFile: 'x' }] } },
    falseyID: { index: 'populated', body: { updates: [{ id: '', thumbnailFile: 'x' }] } },
    nonStringThumbnail: { index: 'populated', body: { updates: [{ id: 'alpha', thumbnailFile: null }] } },
    nullUpdate: { index: 'populated', body: { updates: [null] } },
};

function writeIndex(indexPath, name) {
    const content = indexes[name];
    if (content === null) rmSync(indexPath, { force: true });
    else writeFileSync(indexPath, content);
}

function indexContent(indexPath) {
    return existsSync(indexPath) ? readFileSync(indexPath, 'utf8') : null;
}

try {
    mkdirSync(path.join(dataRoot, '_storage'), { recursive: true });
    writeFileSync(path.join(dataRoot, 'cookie-secret.txt'), COOKIE_SECRET);
    writeFileSync(configPath, 'enableUserAccounts: true\nskipContentCheck: true\n');
    seedUser('user:default-user', {
        handle: 'default-user', name: 'Image Metadata Thumbnail Writer', created: 1700000000000,
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
    const indexPath = path.join(userRoot, 'image-metadata.json');
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
    const route = '/api/image-metadata/folders/set-thumbnails';
    const headers = { Cookie: sessionCookie, 'Content-Type': 'application/json', 'X-CSRF-Token': token };
    const responses = {
        unauthorized: capture(await request(origin + route, 'POST', {
            Cookie: csrfCookie, 'Content-Type': 'application/json', 'X-CSRF-Token': token,
        }, JSON.stringify({ updates: [] }))),
        invalidCSRF: capture(await request(origin + route, 'POST', {
            Cookie: sessionCookie, 'Content-Type': 'application/json',
        }, JSON.stringify({ updates: [] }))),
        wrongMethod: capture(await request(origin + route, 'GET', { Cookie: sessionCookie })),
        wrongMethodHead: capture(await request(origin + route, 'HEAD', { Cookie: sessionCookie })),
    };
    const fileContentsAfter = {};
    for (const [name, probeRequest] of Object.entries(requests)) {
        writeIndex(indexPath, probeRequest.index);
        responses[name] = capture(await request(origin + route, 'POST', headers, JSON.stringify(probeRequest.body)));
        fileContentsAfter[name] = indexContent(indexPath);
    }

    const goRoundTripInput = {
        index: JSON.stringify({
            version: 13,
            images: { 'backgrounds/tree.png': { folderIds: ['forest'], unknownImage: { preserve: true } } },
            folders: [
                { id: 'forest', name: 'Forest', thumbnailFile: '', unknownFolder: { keep: true } },
                { id: 'people', name: 'People', thumbnailFile: '', probe: ['retained'] },
            ],
            unknownRoot: { roundTrip: true },
        }, null, 4),
        body: { updates: [
            { id: 'forest', thumbnailFile: 'tree.png' },
            { id: 'missing', thumbnailFile: 'ignored.png' },
        ] },
    };
    writeFileSync(indexPath, goRoundTripInput.index);
    const goPort = await choosePort();
    goServerOrigin = 'http://127.0.0.1:' + goPort;
    goChild = spawn('go', ['run', './tools/image-metadata-roundtrip', dataRoot, String(goPort)], { cwd: repositoryRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    goChild.stdout.setEncoding('utf8');
    goChild.stderr.setEncoding('utf8');
    goChild.stdout.on('data', chunk => goLogs.push(chunk));
    goChild.stderr.on('data', chunk => goLogs.push(chunk));
    await waitForGoServer(goServerOrigin);
    const goSet = await request(goServerOrigin + route, 'POST', {
        Cookie: sessionCookie, 'Content-Type': 'application/json', 'X-CSRF-Token': token,
    }, JSON.stringify(goRoundTripInput.body));
    if (goSet.response.status !== 200) {
        throw new Error('GoTavern set-thumbnails returned ' + goSet.response.status + ': ' + JSON.stringify(goSet.body) + '\n' + goLogs.join('').slice(-10000));
    }
    const nodeFoldersReadback = await request(origin + '/api/image-metadata/folders/get', 'POST', headers, '{}');
    const nodeIndexReadback = await request(origin + '/api/image-metadata/all', 'POST', headers, '{}');
    const goRoundTrip = {
        goResponse: capture(goSet),
        nodeFoldersReadback: capture(nodeFoldersReadback),
        nodeIndexReadback: capture(nodeIndexReadback),
        fileContent: indexContent(indexPath),
    };
    await stopGoServer();

    const accountRecordUnchanged = accountRecordBefore.equals(readFileSync(accountRecordPath));
    const fixture = {
        schemaVersion: 1,
        baseline: { version: PINNED_VERSION, commit: PINNED_COMMIT },
        probe: 'pinned image-metadata thumbnail batch updates validate inputs, silently skip missing folders, atomically persist the shared index, and preserve unknown fields',
        inputs: { cookieSecret: COOKIE_SECRET, indexes, requests, goRoundTripInput },
        responses,
        state: { fileContentsAfter, accountRecordUnchanged, goRoundTrip },
    };
    await stopServer();
    const outputFile = path.join(repositoryRoot, 'tests', 'oracle', 'sillytavern-1.19.0-image-metadata-set-thumbnails.json');
    mkdirSync(path.dirname(outputFile), { recursive: true });
    writeFileSync(outputFile, JSON.stringify(fixture, null, 2) + '\n');
    console.log('Wrote tests/oracle/sillytavern-1.19.0-image-metadata-set-thumbnails.json from pinned thumbnail-update behavior');
} catch (error) {
    console.error(error);
    process.exitCode = 1;
} finally {
    await stopGoServer();
    await stopServer();
    safeCleanup();
}
