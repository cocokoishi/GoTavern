#!/usr/bin/env node
// Capture the pinned background listing response and metadata-index effects.

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const PINNED_COMMIT = '06bde939fb1e9c4c8d8641d810f0a916b5bce127';
const PINNED_VERSION = '1.19.0';
// @gotavern-oracle: this declaration is read by tools/build-generated-lib.mjs,
// which auto-discovers probes so that adding one needs no edit there.
// @gotavern-oracle: fixture=sillytavern-1.19.0-backgrounds-all.json label="backgrounds-all"
const COOKIE_SECRET = 'gotavern-pinned-backgrounds-all-cookie-secret';
const THUMBNAIL_DIMENSIONS = { bg: [81, 46] };
const sourceRoot = path.resolve(process.argv[2] ?? '');
const repositoryRoot = path.resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3]) {
    console.error('usage: node tools/probe-backgrounds-all.mjs <pinned-source-clone> <gotavern-root>');
    process.exit(2);
}
if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim() !== PINNED_COMMIT) {
    throw new Error('upstream checkout is not pinned at ' + PINNED_COMMIT);
}

const runtimeRoot = mkdtempSync(path.join(os.tmpdir(), 'gotavern-backgrounds-all-oracle-'));
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
        || !path.basename(resolved).startsWith('gotavern-backgrounds-all-oracle-')) {
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

function normalizeMetadataResponse(response) {
    const body = response.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return response;
    for (const metadata of Object.values(body)) {
        if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) continue;
        for (const key of ['addedTimestamp', 'mtime']) {
            if (typeof metadata[key] === 'number') metadata[key] = '__' + key.toUpperCase() + '__';
        }
    }
    if (response.headers?.etag) response.headers.etag = '__METADATA_ETAG__';
    return response;
}

function normalizeIndex(indexPath) {
    if (!existsSync(indexPath)) return null;
    const index = JSON.parse(readFileSync(indexPath, 'utf8'));
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

const fixedDate = new Date('2001-02-03T04:05:06.123Z');
const fixedMtime = fixedDate.getTime();
const indexTemplate = JSON.stringify({
    version: 9,
    images: {
        'backgrounds/cached.png': {
            hash: 'cached-hash', mtime: '__CACHED_MTIME__', isAnimated: 'cached-value',
            folderIds: ['keep-cached'], unknownCacheField: { preserve: true },
        },
        'backgrounds/stale.png': {
            hash: 'stale-hash', mtime: '__STALE_MTIME__', isAnimated: true,
            folderIds: ['keep-stale'], unknownCacheField: 'retained after generation failure',
        },
        'backgrounds/Alpha.png': {
            hash: 'old-alpha-hash', mtime: '__STALE_MTIME__', folderIds: ['keep-alpha'],
            unknownCacheField: 'replaced when regenerated',
        },
    },
    folders: [{ id: 'keep', name: 'Keep unknown fields', thumbnailFile: '', probeUnknownField: { retained: true } }],
    probeUnknownRoot: { retained: true },
}, null, 4);

try {
    mkdirSync(path.join(dataRoot, '_storage'), { recursive: true });
    writeFileSync(path.join(dataRoot, 'cookie-secret.txt'), COOKIE_SECRET);
    writeFileSync(configPath, [
        'enableUserAccounts: true',
        'skipContentCheck: true',
        'thumbnails:',
        '  dimensions:',
        '    bg: [81, 46]',
        '',
    ].join('\n'));
    seedUser('user:default-user', {
        handle: 'default-user', name: 'Background Listing Probe', created: 1700000000000,
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
    mkdirSync(backgroundsRoot, { recursive: true });
    const requireUpstream = createRequire(path.join(sourceRoot, 'package.json'));
    const { PNG } = requireUpstream('pngjs');
    const { Jimp, JimpMime } = await import(pathToFileURL(path.join(sourceRoot, 'src', 'jimp.js')).href);
    const png = new PNG({ width: 2, height: 1 });
    png.data.set([255, 0, 0, 255, 0, 0, 255, 255]);
    const pngBytes = PNG.sync.write(png);
    const gif = new Jimp({ width: 2, height: 1, color: 0xff0000ff });
    const gifBytes = await gif.getBuffer(JimpMime.gif);
    const files = {
        'Alpha.png': pngBytes.toString('base64'),
        'zebra.gif': gifBytes.toString('base64'),
        'cached.png': Buffer.from('cached non-image bytes').toString('base64'),
        'stale.png': Buffer.from('stale non-image bytes').toString('base64'),
        'notes.txt': Buffer.from('ignored text file').toString('base64'),
        '.png': Buffer.from('ignored dotfile').toString('base64'),
    };
    for (const [filename, content] of Object.entries(files)) {
        const fullPath = path.join(backgroundsRoot, filename);
        writeFileSync(fullPath, Buffer.from(content, 'base64'));
        utimesSync(fullPath, fixedDate, fixedDate);
    }
    mkdirSync(path.join(backgroundsRoot, 'folder.png'));

    const indexPath = path.join(userRoot, 'image-metadata.json');
    const cachedMtime = statSync(path.join(backgroundsRoot, 'cached.png')).mtimeMs;
    const initialIndex = JSON.parse(indexTemplate);
    initialIndex.images['backgrounds/cached.png'].mtime = cachedMtime;
    initialIndex.images['backgrounds/stale.png'].mtime = cachedMtime - 1000;
    initialIndex.images['backgrounds/Alpha.png'].mtime = cachedMtime - 1000;
    writeFileSync(indexPath, JSON.stringify(initialIndex, null, 4));

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
    const route = '/api/backgrounds/all';
    const postHeaders = { Cookie: sessionCookie, 'Content-Type': 'application/json', 'X-CSRF-Token': token };
    const responses = {
        unauthorized: capture(await request(origin + route, 'POST', {
            Cookie: csrfCookie, 'Content-Type': 'application/json', 'X-CSRF-Token': token,
        }, '{}')),
        invalidCSRF: capture(await request(origin + route, 'POST', {
            Cookie: sessionCookie, 'Content-Type': 'application/json',
        }, '{}')),
        wrongMethod: capture(await request(origin + route, 'GET', { Cookie: sessionCookie })),
        wrongMethodHead: capture(await request(origin + route, 'HEAD', { Cookie: sessionCookie })),
        wrongMethodOptions: capture(await request(origin + route, 'OPTIONS', { Cookie: sessionCookie })),
        main: capture(await request(origin + route, 'POST', postHeaders, '{}')),
    };
    const indexAfterMain = normalizeIndex(indexPath);
    const indexMtimeBeforeRepeat = statSync(indexPath).mtimeMs;
    responses.repeat = capture(await request(origin + route, 'POST', postHeaders, '{}'));
    const indexUnchangedOnRepeat = indexMtimeBeforeRepeat === statSync(indexPath).mtimeMs;

    const roundTripBytes = Buffer.from(files['Alpha.png'], 'base64');
    const roundTripPath = path.join(backgroundsRoot, 'roundtrip.png');
    const roundTripDate = new Date('2001-02-03T04:10:06.123Z');
    writeFileSync(roundTripPath, roundTripBytes);
    utimesSync(roundTripPath, roundTripDate, roundTripDate);
    const roundTripIndex = JSON.parse(readFileSync(indexPath, 'utf8'));
    roundTripIndex.images['backgrounds/roundtrip.png'] = {
        mtime: -1, folderIds: ['keep-roundtrip'], unknownCacheField: 'replaced by Go generation',
    };
    writeFileSync(indexPath, JSON.stringify(roundTripIndex, null, 4));

    const goPort = await choosePort();
    goServerOrigin = 'http://127.0.0.1:' + goPort;
    goChild = spawn('go', ['run', './tools/image-metadata-roundtrip', dataRoot, String(goPort), JSON.stringify(THUMBNAIL_DIMENSIONS)], {
        cwd: repositoryRoot, stdio: ['ignore', 'pipe', 'pipe'],
    });
    goChild.stdout.setEncoding('utf8');
    goChild.stderr.setEncoding('utf8');
    goChild.stdout.on('data', chunk => goLogs.push(chunk));
    goChild.stderr.on('data', chunk => goLogs.push(chunk));
    await waitForServer(goServerOrigin, goChild, goLogs, 'GoTavern background listing probe server');
    const goResponse = capture(await request(goServerOrigin + route, 'POST', postHeaders, '{}'));
    if (goResponse.status !== 200) {
        throw new Error('GoTavern background listing returned ' + goResponse.status + ': ' + JSON.stringify(goResponse.body) + '\n' + goLogs.join('').slice(-10000));
    }
    const nodeReadback = normalizeMetadataResponse(capture(await request(origin + '/api/image-metadata', 'POST', postHeaders, JSON.stringify({
        paths: ['backgrounds/roundtrip.png'], type: 'bg',
    }))));
    const goRoundTripIndex = normalizeIndex(indexPath);
    await stopGoServer();

    const accountRecordUnchanged = accountRecordBefore.equals(readFileSync(accountRecordPath));
    await stopServer();
    const fixture = {
        schemaVersion: 1,
        baseline: { version: PINNED_VERSION, commit: PINNED_COMMIT },
        probe: 'POST /api/backgrounds/all lists top-level image files in default collator order, returns the configured bg thumbnail dimensions and cached/generated animation values, and persists metadata for supported files',
        inputs: {
            cookieSecret: COOKIE_SECRET,
            files,
            fixedMtime: fixedMtime,
            indexTemplate,
            thumbnailDimensions: THUMBNAIL_DIMENSIONS,
            roundTripFilename: 'roundtrip.png',
            roundTripContent: files['Alpha.png'],
        },
        responses: Object.fromEntries(Object.entries(responses).map(([name, result]) => [name, result])),
        state: {
            indexAfterMain,
            indexUnchangedOnRepeat,
            goRoundTrip: {
                goResponse,
                nodeReadback,
                indexAfter: goRoundTripIndex,
            },
            accountRecordUnchanged,
        },
    };
    const outputFile = path.join(repositoryRoot, 'tests', 'oracle', 'sillytavern-1.19.0-backgrounds-all.json');
    mkdirSync(path.dirname(outputFile), { recursive: true });
    writeFileSync(outputFile, JSON.stringify(fixture, null, 2) + '\n');
    console.log('Wrote tests/oracle/sillytavern-1.19.0-backgrounds-all.json from pinned background listing behavior');
} catch (error) {
    console.error(error);
    process.exitCode = 1;
} finally {
    await stopGoServer();
    await stopServer();
    safeCleanup();
}
