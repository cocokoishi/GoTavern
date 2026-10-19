#!/usr/bin/env node
// Capture pinned cached image metadata reads and unsupported generation cases.

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

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
let child;

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

async function waitForServer(origin) {
    const deadline = Date.now() + 180000;
    let lastError;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error('pinned Node server exited early:\n' + logs.join('').slice(-10000));
        try {
            const result = await request(origin + '/login?noauto=1');
            if (result.response.status === 200 && result.response.headers.get('content-type')?.includes('text/html')) return;
            lastError = new Error('login returned ' + result.response.status);
        } catch (error) {
            lastError = error;
        }
        await new Promise(resolve => setTimeout(resolve, 300));
    }
    throw new Error('pinned Node server did not become ready: ' + (lastError?.stack ?? 'none') + '\n' + logs.join('').slice(-10000));
}

const cases = {
    singleCached: { index: 'populated', body: { path: 'backgrounds/cached.png', type: 'bg' } },
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

function indexContent(indexPath) {
    return existsSync(indexPath) ? readFileSync(indexPath, 'utf8') : null;
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
        responses[name] = capture(await request(origin + route, 'POST', {
            Cookie: sessionCookie, 'Content-Type': 'application/json', 'X-CSRF-Token': token,
        }, JSON.stringify(probeCase.body)));
        mtimeUnchanged[name] = beforeMtime === statSync(indexPath).mtimeMs;
        fileContentsAfter[name] = indexContent(indexPath);
    }

    const fixture = {
        schemaVersion: 1,
        baseline: { version: PINNED_VERSION, commit: PINNED_COMMIT },
        probe: 'pinned metadata reads return unchanged cached values when mtime matches; uncached image decoding and metadata generation remain unsupported in Go',
        inputs: { cookieSecret: COOKIE_SECRET, indexes, cases, cachedMtime, uncachedMtime },
        responses,
        state: {
            fileContentsAfter,
            mtimeUnchanged,
            accountRecordUnchanged: accountRecordBefore.equals(readFileSync(accountRecordPath)),
        },
    };
    await stopServer();
    const outputFile = path.join(repositoryRoot, 'tests', 'oracle', 'sillytavern-1.19.0-image-metadata-get.json');
    mkdirSync(path.dirname(outputFile), { recursive: true });
    writeFileSync(outputFile, JSON.stringify(fixture, null, 2) + '\n');
    console.log('Wrote tests/oracle/sillytavern-1.19.0-image-metadata-get.json from pinned metadata-cache behavior');
} catch (error) {
    console.error(error);
    process.exitCode = 1;
} finally {
    await stopServer();
    safeCleanup();
}
