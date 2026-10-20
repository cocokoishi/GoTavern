#!/usr/bin/env node
// Capture pinned background upload middleware, endpoint, and Go round-trip behavior.

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const PINNED_COMMIT = '06bde939fb1e9c4c8d8641d810f0a916b5bce127';
const PINNED_VERSION = '1.19.0';
const COOKIE_SECRET = 'gotavern-pinned-backgrounds-upload-cookie-secret';
const sourceRoot = path.resolve(process.argv[2] ?? '');
const repositoryRoot = path.resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3]) {
    console.error('usage: node tools/probe-backgrounds-upload.mjs <pinned-source-clone-with-dependencies> <gotavern-root>');
    process.exit(2);
}
if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim() !== PINNED_COMMIT) {
    throw new Error('upstream checkout is not pinned at ' + PINNED_COMMIT);
}

const runtimeRoot = mkdtempSync(path.join(os.tmpdir(), 'gotavern-backgrounds-upload-oracle-'));
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
        || !path.basename(resolved).startsWith('gotavern-backgrounds-upload-oracle-')) {
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
        // Preserve plain text and HTML errors.
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

function captureStatus(result) {
    return {
        status: result.response.status,
        headers: { 'content-type': result.response.headers.get('content-type') ?? '' },
        body: null,
    };
}

function normalizeIndex(indexPath) {
    if (!existsSync(indexPath)) return null;
    return normalizeIndexValue(JSON.parse(readFileSync(indexPath, 'utf8')));
}

function normalizeIndexValue(index) {
    index = structuredClone(index);
    for (const metadata of Object.values(index.images ?? {})) {
        if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) continue;
        for (const key of ['addedTimestamp', 'mtime']) {
            if (typeof metadata[key] === 'number') metadata[key] = '__' + key.toUpperCase() + '__';
        }
    }
    return index;
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

function uploadForm(field, filename, bytes) {
    const form = new FormData();
    form.append(field, new Blob([bytes], { type: 'image/png' }), filename);
    return form;
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

try {
    mkdirSync(path.join(dataRoot, '_storage'), { recursive: true });
    writeFileSync(path.join(dataRoot, 'cookie-secret.txt'), COOKIE_SECRET);
    writeFileSync(configPath, 'enableUserAccounts: true\nskipContentCheck: true\n');
    seedUser('user:default-user', {
        handle: 'default-user', name: 'Background Upload Probe', created: 1700000000000,
        password: '', admin: true, enabled: true, salt: '', probeUnknownField: { preserve: true },
    });

    const requireUpstream = createRequire(path.join(sourceRoot, 'package.json'));
    const { PNG } = requireUpstream('pngjs');
    const png = new PNG({ width: 3, height: 2 });
    const pixels = [
        [255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255],
        [255, 255, 255, 255], [255, 255, 0, 0], [0, 0, 0, 255],
    ];
    pixels.forEach((pixel, index) => png.data.set(pixel, index * 4));
    const imageBytes = PNG.sync.write(png);

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
    writeFileSync(path.join(backgroundsRoot, 'overwrite.png'), 'old image bytes');
    writeFileSync(path.join(thumbnailRoot, 'overwrite.png'), 'cached thumbnail');
    const indexPath = path.join(userRoot, 'image-metadata.json');
    const initialIndex = JSON.stringify({
        version: 17,
        images: {
            'backgrounds/overwrite.png': { mtime: -1, hash: 'old-hash', folderIds: ['forest'], oldUnknown: true },
        },
        folders: [{ id: 'forest', name: 'Forest', thumbnailFile: 'overwrite.png', unknownFolderField: 31 }],
        unknownRoot: { preserved: true },
    }, null, 4);
    writeFileSync(indexPath, initialIndex);
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
    const route = '/api/backgrounds/upload';
    const responses = {
        unauthorized: capture(await request(origin + route, 'POST', {
            Cookie: csrfCookie, 'X-CSRF-Token': token,
        }, uploadForm('avatar', 'unauthorized.png', imageBytes))),
        invalidCSRF: capture(await request(origin + route, 'POST', {
            Cookie: sessionCookie,
        }, uploadForm('avatar', 'csrf-fail.png', imageBytes))),
        wrongMethod: capture(await request(origin + route, 'GET', { Cookie: sessionCookie })),
        wrongMethodHead: capture(await request(origin + route, 'HEAD', { Cookie: sessionCookie })),
        wrongMethodOptions: capture(await request(origin + route, 'OPTIONS', { Cookie: sessionCookie })),
        missingFile: capture(await request(origin + route, 'POST', {
            Cookie: sessionCookie, 'X-CSRF-Token': token,
        }, new FormData())),
        wrongFileField: captureStatus(await request(origin + route, 'POST', {
            Cookie: sessionCookie, 'X-CSRF-Token': token,
        }, uploadForm('image', 'wrong-field.png', imageBytes))),
    };

    const postHeaders = { Cookie: sessionCookie, 'X-CSRF-Token': token };
    responses.overwrite = capture(await request(origin + route, 'POST', postHeaders, uploadForm('avatar', 'overwrite.png', imageBytes)));
    const afterOverwrite = {
        content: readFileSync(path.join(backgroundsRoot, 'overwrite.png')).toString('base64'),
        thumbnailExists: existsSync(path.join(thumbnailRoot, 'overwrite.png')),
        uploads: readdirSync(path.join(dataRoot, '_uploads')),
        index: normalizeIndex(indexPath),
    };
    responses.sanitizedFilename = capture(await request(origin + route, 'POST', postHeaders, uploadForm('avatar', 'adventure?land.png', imageBytes)));
    responses.unicodeFilename = capture(await request(origin + route, 'POST', postHeaders, uploadForm('avatar', '森の背景.png', imageBytes)));
    const afterNodeUploads = {
        sanitizedExists: existsSync(path.join(backgroundsRoot, 'adventureland.png')),
        unicodeExists: existsSync(path.join(backgroundsRoot, '森の背景.png')),
        uploads: readdirSync(path.join(dataRoot, '_uploads')),
        index: normalizeIndex(indexPath),
    };
    mkdirSync(path.join(thumbnailRoot, 'thumbnail-fail.png'));
    responses.thumbnailFailure = capture(await request(origin + route, 'POST', postHeaders, uploadForm('avatar', 'thumbnail-fail.png', imageBytes)));
    const afterThumbnailFailure = {
        backgroundExists: existsSync(path.join(backgroundsRoot, 'thumbnail-fail.png')),
        thumbnailDirectoryExists: existsSync(path.join(thumbnailRoot, 'thumbnail-fail.png')),
        uploads: readdirSync(path.join(dataRoot, '_uploads')),
        index: normalizeIndex(indexPath),
    };
    const mainIndexBytes = readFileSync(indexPath);

    const goRoundTripNodeResponse = capture(await request(origin + route, 'POST', postHeaders, uploadForm('avatar', 'go-roundtrip.png', imageBytes)));
    const nodeOracleIndex = normalizeIndex(indexPath);
    unlinkSync(path.join(backgroundsRoot, 'go-roundtrip.png'));
    if (existsSync(path.join(thumbnailRoot, 'go-roundtrip.png'))) unlinkSync(path.join(thumbnailRoot, 'go-roundtrip.png'));
    writeFileSync(indexPath, mainIndexBytes);

    const goPort = await choosePort();
    goServerOrigin = 'http://127.0.0.1:' + goPort;
    goChild = spawn('go', ['run', './tools/image-metadata-roundtrip', dataRoot, String(goPort), '{}'], {
        cwd: repositoryRoot, stdio: ['ignore', 'pipe', 'pipe'],
    });
    goChild.stdout.setEncoding('utf8');
    goChild.stderr.setEncoding('utf8');
    goChild.stdout.on('data', chunk => goLogs.push(chunk));
    goChild.stderr.on('data', chunk => goLogs.push(chunk));
    await waitForServer(goServerOrigin, goChild, goLogs, 'GoTavern background upload probe server');
    const goResponse = capture(await request(goServerOrigin + route, 'POST', postHeaders, uploadForm('avatar', 'go-roundtrip.png', imageBytes)));
    if (goResponse.status !== 200) throw new Error('GoTavern upload returned ' + goResponse.status + ': ' + JSON.stringify(goResponse.body) + '\n' + goLogs.join('').slice(-10000));
    const nodeReadback = await request(origin + '/api/image-metadata/all', 'POST', {
        ...postHeaders, 'Content-Type': 'application/json',
    }, '{}');
    if (nodeReadback.response.status !== 200) throw new Error('Node metadata readback returned ' + nodeReadback.response.status + ': ' + JSON.stringify(nodeReadback.body));
    const goRoundTrip = {
        nodeResponse: goRoundTripNodeResponse,
        goResponse,
        nodeReadbackStatus: nodeReadback.response.status,
        nodeReadbackIndex: normalizeIndexValue(nodeReadback.body),
        goIndex: normalizeIndex(indexPath),
        content: readFileSync(path.join(backgroundsRoot, 'go-roundtrip.png')).toString('base64'),
        uploads: readdirSync(path.join(dataRoot, '_uploads')),
        nodeOracleIndex,
    };
    await stopGoServer();

    const fixture = {
        schemaVersion: 1,
        baseline: { version: PINNED_VERSION, commit: PINNED_COMMIT },
        probe: 'POST /api/backgrounds/upload matches pinned multipart field handling, filename decoding/sanitization, overwrite behavior, staged upload cleanup, thumbnail invalidation, best-effort metadata generation, and Node readback of Go-written metadata',
        inputs: {
            cookieSecret: COOKIE_SECRET,
            imageBytes: imageBytes.toString('base64'),
            initialBackgroundBytes: Buffer.from('old image bytes').toString('base64'),
            initialIndex,
        },
        responses,
        state: {
            afterOverwrite,
            afterNodeUploads,
            afterThumbnailFailure,
            goRoundTrip,
            accountRecordUnchanged: accountRecordBefore.equals(readFileSync(accountRecordPath)),
        },
    };
    const outputFile = path.join(repositoryRoot, 'tests', 'oracle', 'sillytavern-1.19.0-backgrounds-upload.json');
    mkdirSync(path.dirname(outputFile), { recursive: true });
    writeFileSync(outputFile, JSON.stringify(fixture, null, 2) + '\n');
    console.log('Wrote tests/oracle/sillytavern-1.19.0-backgrounds-upload.json from pinned upload behavior and Go round-trip');
} catch (error) {
    console.error(error);
    process.exitCode = 1;
} finally {
    await stopGoServer();
    await stopServer();
    safeCleanup();
}
