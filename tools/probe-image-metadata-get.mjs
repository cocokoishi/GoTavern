#!/usr/bin/env node
// Capture pinned image metadata cache reads, generation, and persistence behavior.

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
const COOKIE_SECRET = 'gotavern-pinned-image-metadata-get-cookie-secret';
const sourceRoot = path.resolve(process.argv[2] ?? '');
const repositoryRoot = path.resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3]) {
    console.error('usage: node tools/probe-image-metadata-get.mjs <pinned-source-clone> <gotavern-root>');
    process.exit(2);
}
if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim() !== PINNED_COMMIT) {
    throw new Error('upstream checkout is not pinned at ' + PINNED_COMMIT);
}

const runtimeRoot = mkdtempSync(path.join(os.tmpdir(), 'gotavern-image-metadata-get-oracle-'));
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
        || !path.basename(resolved).startsWith('gotavern-image-metadata-get-oracle-')) {
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

async function waitForServer(origin, processRef = child, output = logs, label = 'pinned Node server') {
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

const cases = {
    singleCached: { index: 'populated', body: { path: 'backgrounds/cached.png', type: 'bg' } },
    singleGeneratedPng: {
        index: 'generationBase', body: { path: 'backgrounds/pixels.png', type: 'bg' },
        generatedPaths: ['backgrounds/pixels.png'],
    },
    singleGeneratedJpeg: {
        index: 'generationBase', body: { path: 'backgrounds/photo.jpg', type: 'avatar' },
        generatedPaths: ['backgrounds/photo.jpg'],
    },
    batchGeneratedPngAndGif: {
        index: 'generationBase', body: { paths: ['backgrounds/pixels.png', 'backgrounds/flat.gif', 'backgrounds/missing.png'], type: 'persona' },
        generatedPaths: ['backgrounds/pixels.png', 'backgrounds/flat.gif'],
    },
    singleUnsupportedBmp: {
        index: 'generationBase', body: { path: 'backgrounds/unsupported.bmp', type: 'bg' },
        generatedPaths: ['backgrounds/unsupported.bmp'], goUnsupported: true,
    },
    batchCachedMissingAndOutside: { index: 'populated', body: { paths: ['backgrounds/cached.png', 'backgrounds/missing.png', '../escape.png'], type: 'persona' } },
    bothPathAndEmptyPaths: { index: 'populated', body: { path: 'backgrounds/cached.png', paths: [], type: 'avatar' } },
    singleMissing: { index: 'populated', body: { path: 'backgrounds/missing.png' } },
    singleOutside: { index: 'populated', body: { path: '../escape.png' } },
    singleUncachedInvalid: { index: 'populated', body: { path: 'backgrounds/uncached.png' } },
    batchUncachedInvalid: { index: 'populated', body: { paths: ['backgrounds/uncached.png'] } },
    noPath: { index: 'populated', body: {} },
    emptyBatch: { index: 'populated', body: { paths: [] } },
    invalidPathsType: { index: 'populated', body: { paths: 'backgrounds/cached.png' } },
    nullImages: { index: 'nullImages', body: { path: 'backgrounds/cached.png' } },
    missingImages: { index: 'missingImages', body: { path: 'backgrounds/cached.png' } },
};

function writeIndex(indexPath, indexes, name, fixedDate) {
    const content = indexes[name];
    if (content === null) rmSync(indexPath, { force: true });
    else {
        writeFileSync(indexPath, content);
        utimesSync(indexPath, fixedDate, fixedDate);
    }
}

function indexContent(indexPath, generatedPaths = []) {
    if (!existsSync(indexPath)) return null;
    const content = readFileSync(indexPath, 'utf8');
    if (!generatedPaths.length) return content;
    const index = JSON.parse(content);
    for (const generatedPath of generatedPaths) {
        const metadata = index.images?.[generatedPath];
        if (metadata && Object.hasOwn(metadata, 'addedTimestamp')) metadata.addedTimestamp = '__ADDED_TIMESTAMP__';
    }
    return JSON.stringify(index, null, 4);
}

function normalizeResponseAddedTimestamps(response, generatedPaths = []) {
    if (generatedPaths.length && response.headers?.etag) response.headers.etag = '__ADDED_TIMESTAMP_ETAG__';
    const body = response.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return response;
    const metadataValues = Object.hasOwn(body, 'addedTimestamp') ? [body] : Object.values(body);
    for (const metadata of metadataValues) {
        if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) continue;
        if (generatedPaths.length && typeof metadata.addedTimestamp === 'number') metadata.addedTimestamp = '__ADDED_TIMESTAMP__';
    }
    return response;
}

try {
    mkdirSync(path.join(dataRoot, '_storage'), { recursive: true });
    writeFileSync(path.join(dataRoot, 'cookie-secret.txt'), COOKIE_SECRET);
    writeFileSync(configPath, 'enableUserAccounts: true\nskipContentCheck: true\n');
    seedUser('user:default-user', {
        handle: 'default-user', name: 'Image Metadata Cache Probe', created: 1700000000000,
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
    await waitForServer(origin);

    const userRoot = path.join(dataRoot, 'default-user');
    const backgroundsRoot = path.join(userRoot, 'backgrounds');
    mkdirSync(backgroundsRoot, { recursive: true });
    const fixedDate = new Date('2001-02-03T04:05:06.123Z');
    const { Jimp, JimpMime } = await import(pathToFileURL(path.join(sourceRoot, 'src', 'jimp.js')).href);
    const requireUpstream = createRequire(path.join(sourceRoot, 'package.json'));
    const { PNG } = requireUpstream('pngjs');
    const pixelsImage = new PNG({ width: 3, height: 2 });
    const rgbaPixels = [
        [255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255],
        [255, 255, 255, 255], [255, 255, 0, 0], [0, 0, 0, 255],
    ];
    rgbaPixels.forEach((pixel, index) => pixelsImage.data.set(pixel, index * 4));
    const jpegPixels = Buffer.alloc(3 * 2 * 4);
    for (let index = 0; index < 3 * 2; index++) jpegPixels.set([96, 154, 210, 255], index * 4);
    const jpegBytes = requireUpstream('jpeg-js').encode({ data: jpegPixels, width: 3, height: 2 }, 100).data;
    const flatGifImage = new Jimp({ width: 2, height: 1, color: 0xff0000ff });
    flatGifImage.setPixelColor(0x0000ffff, 1, 0);
    const bmpImage = new Jimp({ width: 2, height: 2, color: 0xff0000ff });
    bmpImage.setPixelColor(0x0000ffff, 1, 0);
    bmpImage.setPixelColor(0x00ff00ff, 0, 1);
    bmpImage.setPixelColor(0xffffffff, 1, 1);
    const generatedFiles = {
        'backgrounds/pixels.png': PNG.sync.write(pixelsImage).toString('base64'),
        'backgrounds/roundtrip.png': PNG.sync.write(pixelsImage).toString('base64'),
        'backgrounds/photo.jpg': jpegBytes.toString('base64'),
        'backgrounds/flat.gif': (await flatGifImage.getBuffer(JimpMime.gif)).toString('base64'),
        'backgrounds/unsupported.bmp': (await bmpImage.getBuffer(JimpMime.bmp)).toString('base64'),
    };
    for (const [relativePath, base64] of Object.entries(generatedFiles)) {
        const fullPath = path.join(userRoot, ...relativePath.split('/'));
        mkdirSync(path.dirname(fullPath), { recursive: true });
        writeFileSync(fullPath, Buffer.from(base64, 'base64'));
        utimesSync(fullPath, fixedDate, fixedDate);
    }
    writeFileSync(path.join(backgroundsRoot, 'cached.png'), 'cached bytes');
    writeFileSync(path.join(backgroundsRoot, 'uncached.png'), 'not an image');
    utimesSync(path.join(backgroundsRoot, 'cached.png'), fixedDate, fixedDate);
    utimesSync(path.join(backgroundsRoot, 'uncached.png'), fixedDate, fixedDate);
    writeFileSync(path.join(dataRoot, 'escape.png'), 'outside user root');
    const indexPath = path.join(userRoot, 'image-metadata.json');
    const accountRecordPath = path.join(dataRoot, '_storage', sha256('user:default-user'));
    const accountRecordBefore = readFileSync(accountRecordPath);
    const cachedMtime = statSync(path.join(backgroundsRoot, 'cached.png')).mtimeMs;
    const uncachedMtime = statSync(path.join(backgroundsRoot, 'uncached.png')).mtimeMs;
    const indexes = {
        populated: JSON.stringify({
            version: 4,
            images: {
                'backgrounds/cached.png': {
                    hash: 'cached-sha256', mtime: cachedMtime, aspectRatio: 1.5, isAnimated: false,
                    dominantColor: '#123456', folderIds: ['forest'], addedTimestamp: 980000000000,
                    thumbnailResolution: 14400, unknownCacheField: { preserve: true },
                },
                'backgrounds/uncached.png': { hash: 'old', mtime: uncachedMtime - 1000, folderIds: ['beta'], oldField: true },
            },
            folders: [{ id: 'forest', name: 'Forest', thumbnailFile: 'cached.png' }],
            unknownRoot: { preserve: true },
        }, null, 4),
        generationBase: JSON.stringify({
            version: 7,
            images: {
                'backgrounds/pixels.png': {
                    hash: 'stale', mtime: cachedMtime - 1000, folderIds: ['preserve-this-folder'],
                    unknownCacheField: { dropWhenRegenerated: true },
                },
            },
            folders: [{ id: 'retain', name: 'Keep this folder', thumbnailFile: '' }],
            unknownRoot: { preserve: true },
        }, null, 4),
        nullImages: '{"version":5,"images":null,"folders":[]}',
        missingImages: '{"version":6,"folders":[]}',
    };

    const csrf = await request(origin + '/csrf-token');
    const token = csrf.body.token;
    const csrfCookie = cookieHeader(cookiesFrom(csrf.response));
    const login = await request(origin + '/api/users/login', 'POST', {
        Cookie: csrfCookie, 'Content-Type': 'application/json', 'X-CSRF-Token': token,
    }, JSON.stringify({ handle: 'default-user', password: '' }));
    if (login.response.status !== 200) throw new Error('could not login: ' + login.response.status + ' ' + JSON.stringify(login.body));
    const sessionCookie = cookieHeader(cookiesFrom(login.response));
    const route = '/api/image-metadata';
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
        trailingSlashPost: capture(await request(origin + route + '/', 'POST', {
            Cookie: sessionCookie, 'Content-Type': 'application/json', 'X-CSRF-Token': token,
        }, '{}')),
        unknownSubpathPost: capture(await request(origin + route + '/unknown', 'POST', {
            Cookie: sessionCookie, 'Content-Type': 'application/json', 'X-CSRF-Token': token,
        }, '{}')),
    };
    const fileContentsAfter = {};
    const mtimeUnchanged = {};
    const indexFixedDate = new Date('2001-02-03T04:05:06.000Z');
    for (const [name, probeCase] of Object.entries(cases)) {
        writeIndex(indexPath, indexes, probeCase.index, indexFixedDate);
        const beforeMtime = statSync(indexPath).mtimeMs;
        responses[name] = normalizeResponseAddedTimestamps(capture(await request(origin + route, 'POST', {
            Cookie: sessionCookie, 'Content-Type': 'application/json', 'X-CSRF-Token': token,
        }, JSON.stringify(probeCase.body))), probeCase.generatedPaths);
        mtimeUnchanged[name] = beforeMtime === statSync(indexPath).mtimeMs;
        fileContentsAfter[name] = indexContent(indexPath, probeCase.generatedPaths);
    }

    const fixture = {
        schemaVersion: 1,
        baseline: { version: PINNED_VERSION, commit: PINNED_COMMIT },
        probe: 'pinned metadata reads preserve cached values by mtime and generate metadata for PNG/JPEG/GIF; Go-generated metadata is read back through the pinned Node endpoint',
        inputs: { cookieSecret: COOKIE_SECRET, indexes, cases, cachedMtime, uncachedMtime, generatedFiles },
        responses,
        state: {
            fileContentsAfter,
            mtimeUnchanged,
            accountRecordUnchanged: accountRecordBefore.equals(readFileSync(accountRecordPath)),
            goRoundTrip: null,
        },
    };
    const goRoundTripInput = {
        index: JSON.stringify({
            version: 8,
            images: {},
            folders: [{ id: 'keep', name: 'Round trip', thumbnailFile: '' }],
            unknownRoot: { retain: true },
        }, null, 4),
        body: { path: 'backgrounds/roundtrip.png', type: 'bg' },
        generatedPaths: ['backgrounds/roundtrip.png'],
    };
    const goRoundTripPath = path.join(backgroundsRoot, 'roundtrip.png');
    writeFileSync(goRoundTripPath, Buffer.from(generatedFiles['backgrounds/pixels.png'], 'base64'));
    utimesSync(goRoundTripPath, fixedDate, fixedDate);
    writeFileSync(indexPath, goRoundTripInput.index);
    const goPort = await choosePort();
    goServerOrigin = 'http://127.0.0.1:' + goPort;
    goChild = spawn('go', ['run', './tools/image-metadata-roundtrip', dataRoot, String(goPort)], {
        cwd: repositoryRoot, stdio: ['ignore', 'pipe', 'pipe'],
    });
    goChild.stdout.setEncoding('utf8');
    goChild.stderr.setEncoding('utf8');
    goChild.stdout.on('data', chunk => goLogs.push(chunk));
    goChild.stderr.on('data', chunk => goLogs.push(chunk));
    await waitForServer(goServerOrigin, goChild, goLogs, 'GoTavern image-metadata probe server');
    const goResponse = normalizeResponseAddedTimestamps(capture(await request(goServerOrigin + route, 'POST', {
        Cookie: sessionCookie, 'Content-Type': 'application/json', 'X-CSRF-Token': token,
    }, JSON.stringify(goRoundTripInput.body))), goRoundTripInput.generatedPaths);
    if (goResponse.status !== 200) {
        throw new Error('GoTavern generated image metadata returned ' + goResponse.status + ': ' + JSON.stringify(goResponse.body) + '\n' + goLogs.join('').slice(-10000));
    }
    const nodeReadback = normalizeResponseAddedTimestamps(capture(await request(origin + route, 'POST', {
        Cookie: sessionCookie, 'Content-Type': 'application/json', 'X-CSRF-Token': token,
    }, JSON.stringify(goRoundTripInput.body))), goRoundTripInput.generatedPaths);
    fixture.inputs.goRoundTrip = goRoundTripInput;
    fixture.state.goRoundTrip = {
        goResponse,
        nodeReadback,
        fileContent: indexContent(indexPath, goRoundTripInput.generatedPaths),
    };
    await stopGoServer();
    await stopServer();
    const outputFile = path.join(repositoryRoot, 'tests', 'oracle', 'sillytavern-1.19.0-image-metadata-get.json');
    mkdirSync(path.dirname(outputFile), { recursive: true });
    writeFileSync(outputFile, JSON.stringify(fixture, null, 2) + '\n');
    console.log('Wrote tests/oracle/sillytavern-1.19.0-image-metadata-get.json from pinned metadata-cache behavior');
} catch (error) {
    console.error(error);
    process.exitCode = 1;
} finally {
    await stopGoServer();
    await stopServer();
    safeCleanup();
}
