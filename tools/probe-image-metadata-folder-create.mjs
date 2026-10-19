#!/usr/bin/env node
// Capture pinned virtual-folder creation and a Go-to-Node persistence round trip.

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const PINNED_COMMIT = '06bde939fb1e9c4c8d8641d810f0a916b5bce127';
const PINNED_VERSION = '1.19.0';
const COOKIE_SECRET = 'gotavern-pinned-image-metadata-folder-create-cookie-secret';
const sourceRoot = path.resolve(process.argv[2] ?? '');
const repositoryRoot = path.resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3]) {
    console.error('usage: node tools/probe-image-metadata-folder-create.mjs <pinned-source-clone> <gotavern-root>');
    process.exit(2);
}
if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim() !== PINNED_COMMIT) {
    throw new Error('upstream checkout is not pinned at ' + PINNED_COMMIT);
}

const runtimeRoot = mkdtempSync(path.join(os.tmpdir(), 'gotavern-image-metadata-folder-create-oracle-'));
const dataRoot = path.join(runtimeRoot, 'data');
const configPath = path.join(runtimeRoot, 'config.yaml');
const logs = [];
const goLogs = [];
let child;
let goChild;
let goServerOrigin = '';
const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi;

function sha256(value) {
    return createHash('sha256').update(value).digest('hex');
}

function safeCleanup() {
    const resolved = path.resolve(runtimeRoot);
    const parent = path.resolve(os.tmpdir());
    if (path.dirname(resolved).toLowerCase() !== parent.toLowerCase()
        || !path.basename(resolved).startsWith('gotavern-image-metadata-folder-create-oracle-')) {
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

function captureNormalized(result) {
    const value = capture(result);
    const original = JSON.stringify(value.body);
    const replaced = original?.replace(uuidPattern, '<uuid>');
    if (replaced !== original) {
        value.body = JSON.parse(replaced);
        if (value.headers.etag) value.headers.etag = '<uuid-etag>';
    }
    return value;
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
    existing: JSON.stringify({
        version: 3,
        images: {
            'backgrounds/forest.webp': { folderIds: ['preexisting'], isAnimated: true, probeImageField: { keep: true } },
            'custom/other.png': { unknown: 'retained' },
        },
        folders: [{ id: 'preexisting', name: 'Duplicate', thumbnailFile: 'cover.webp', unknownFolderField: { keep: true } }],
        probeRootField: { keep: true },
    }, null, 4),
    empty: JSON.stringify({ version: 7, images: {}, folders: [], probeRootField: 'retain' }, null, 4),
    malformed: '{"version":',
    missingFolders: JSON.stringify({ version: 1, images: {}, probeRootField: true }),
    nullFolders: JSON.stringify({ version: 1, images: {}, folders: null }),
    nullImagesFolders: JSON.stringify({ version: 1, images: null, folders: [], probeRootField: ['keep', 1] }),
    nullRoot: 'null',
    missing: null,
};

const requests = {
    duplicateName: { index: 'existing', body: { name: '  Duplicate  ' } },
    missingIndex: { index: 'missing', body: { name: 'Fresh' } },
    malformedIndex: { index: 'malformed', body: { name: 'Recovered' } },
    missingFolders: { index: 'missingFolders', body: { name: 'No folders' } },
    nullFolders: { index: 'nullFolders', body: { name: 'Null folders' } },
    nullImagesPreserved: { index: 'nullImagesFolders', body: { name: 'Null images' } },
    nullRoot: { index: 'nullRoot', body: { name: 'Null root' } },
    missingName: { index: 'empty', body: {} },
    emptyName: { index: 'empty', body: { name: '' } },
    nonStringName: { index: 'empty', body: { name: 7 } },
    arrayBody: { index: 'empty', body: [{ name: 'ignored' }] },
    whitespaceName: { index: 'empty', body: { name: ' \uFEFF\t\n ' } },
};

function writeIndex(indexPath, name) {
    const content = indexes[name];
    if (content === null) rmSync(indexPath, { force: true });
    else writeFileSync(indexPath, content);
}

function normalizedIndexContent(indexPath) {
    if (!existsSync(indexPath)) return null;
    return readFileSync(indexPath, 'utf8').replace(uuidPattern, '<uuid>');
}

try {
    mkdirSync(path.join(dataRoot, '_storage'), { recursive: true });
    writeFileSync(path.join(dataRoot, 'cookie-secret.txt'), COOKIE_SECRET);
    writeFileSync(configPath, 'enableUserAccounts: true\nskipContentCheck: true\n');
    seedUser('user:default-user', {
        handle: 'default-user', name: 'Image Metadata Folder Creator', created: 1700000000000,
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
    const indexPath = path.join(userRoot, 'image-metadata.json');
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
    const headers = { Cookie: sessionCookie, 'Content-Type': 'application/json', 'X-CSRF-Token': token };
    const responses = {
        unauthorized: capture(await request(origin + '/api/image-metadata/folders/create', 'POST', {
            Cookie: csrfCookie, 'Content-Type': 'application/json', 'X-CSRF-Token': token,
        }, JSON.stringify({ name: 'Blocked' }))),
        invalidCSRF: capture(await request(origin + '/api/image-metadata/folders/create', 'POST', {
            Cookie: sessionCookie, 'Content-Type': 'application/json',
        }, JSON.stringify({ name: 'Blocked' }))),
        wrongMethod: capture(await request(origin + '/api/image-metadata/folders/create', 'GET', { Cookie: sessionCookie })),
        wrongMethodHead: capture(await request(origin + '/api/image-metadata/folders/create', 'HEAD', { Cookie: sessionCookie })),
    };
    const fileContentsAfter = {};
    for (const [name, probeRequest] of Object.entries(requests)) {
        writeIndex(indexPath, probeRequest.index);
        const result = await request(origin + '/api/image-metadata/folders/create', 'POST', headers, JSON.stringify(probeRequest.body));
        if (result.response.status === 200 && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(result.body.id)) {
            throw new Error('folder creation returned a non-UUIDv4 id for ' + name + ': ' + JSON.stringify(result.body));
        }
        responses[name] = captureNormalized(result);
        fileContentsAfter[name] = normalizedIndexContent(indexPath);
    }

    const goRoundTripInput = {
        index: JSON.stringify({
            version: 11,
            images: { 'backgrounds/go.webp': { folderIds: ['kept-id'], probeImageField: { preserved: true } } },
            folders: [{ id: 'existing-go', name: 'Existing Go', thumbnailFile: 'go.webp', probeFolderField: ['keep'] }],
            probeRootField: { preserve: 'go-to-node' },
        }, null, 4),
        body: { name: 'Created by Go' },
    };
    writeFileSync(indexPath, goRoundTripInput.index);
    const goPort = await choosePort();
    goServerOrigin = 'http://127.0.0.1:' + goPort;
    goChild = spawn('go', ['run', './tools/image-metadata-create-roundtrip', dataRoot, String(goPort)], {
        cwd: repositoryRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    goChild.stdout.setEncoding('utf8');
    goChild.stderr.setEncoding('utf8');
    goChild.stdout.on('data', chunk => goLogs.push(chunk));
    goChild.stderr.on('data', chunk => goLogs.push(chunk));
    await waitForGoServer(goServerOrigin);
    const goCreate = await request(goServerOrigin + '/api/image-metadata/folders/create', 'POST', {
        Cookie: sessionCookie,
        'Content-Type': 'application/json',
        'X-CSRF-Token': token,
    }, JSON.stringify(goRoundTripInput.body));
    if (goCreate.response.status !== 200 || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(goCreate.body?.id ?? '')) {
        throw new Error('GoTavern folder creation failed: ' + goCreate.response.status + ' ' + JSON.stringify(goCreate.body) + '\n' + goLogs.join('').slice(-10000));
    }
    const nodeFoldersReadback = await request(origin + '/api/image-metadata/folders/get', 'POST', headers, '{}');
    const nodeIndexReadback = await request(origin + '/api/image-metadata/all', 'POST', headers, '{}');
    if (nodeFoldersReadback.response.status !== 200 || nodeIndexReadback.response.status !== 200) {
        throw new Error('pinned Node could not read the Go-created folder/index');
    }
    const goRoundTrip = {
        goResponse: captureNormalized(goCreate),
        nodeFoldersReadback: captureNormalized(nodeFoldersReadback),
        nodeIndexReadback: captureNormalized(nodeIndexReadback),
        fileContent: normalizedIndexContent(indexPath),
    };
    await stopGoServer();

    const accountRecordUnchanged = accountRecordBefore.equals(readFileSync(accountRecordPath));
    const fixture = {
        schemaVersion: 1,
        baseline: { version: PINNED_VERSION, commit: PINNED_COMMIT },
        probe: 'pinned virtual-folder creation validates names, trims with JavaScript semantics, atomically writes the shared metadata index, and preserves unknown fields',
        inputs: { cookieSecret: COOKIE_SECRET, indexes, requests, goRoundTripInput },
        responses,
        state: { fileContentsAfter, accountRecordUnchanged, goRoundTrip },
    };
    await stopServer();
    const outputFile = path.join(repositoryRoot, 'tests', 'oracle', 'sillytavern-1.19.0-image-metadata-folder-create.json');
    mkdirSync(path.dirname(outputFile), { recursive: true });
    writeFileSync(outputFile, JSON.stringify(fixture, null, 2) + '\n');
    console.log('Wrote tests/oracle/sillytavern-1.19.0-image-metadata-folder-create.json from pinned folder-create behavior');
} catch (error) {
    console.error(error);
    process.exitCode = 1;
} finally {
    await stopGoServer();
    await stopServer();
    safeCleanup();
}
