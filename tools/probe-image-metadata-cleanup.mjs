#!/usr/bin/env node
// Capture pinned orphan cleanup and a Go-to-Node persistence round trip.

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const PINNED_COMMIT = '06bde939fb1e9c4c8d8641d810f0a916b5bce127';
const PINNED_VERSION = '1.19.0';
const COOKIE_SECRET = 'gotavern-pinned-image-metadata-cleanup-cookie-secret';
const sourceRoot = path.resolve(process.argv[2] ?? '');
const repositoryRoot = path.resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3]) {
    console.error('usage: node tools/probe-image-metadata-cleanup.mjs <pinned-source-clone> <gotavern-root>');
    process.exit(2);
}
if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim() !== PINNED_COMMIT) {
    throw new Error('upstream checkout is not pinned at ' + PINNED_COMMIT);
}

const runtimeRoot = mkdtempSync(path.join(os.tmpdir(), 'gotavern-image-metadata-cleanup-oracle-'));
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
        || !path.basename(resolved).startsWith('gotavern-image-metadata-cleanup-oracle-')) {
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

async function waitForServer(origin, processRef, output, label) {
    const deadline = Date.now() + 180000;
    let lastError;
    while (Date.now() < deadline) {
        if (processRef.exitCode !== null) throw new Error(label + ' exited before readiness:\n' + output.join('').slice(-10000));
        try {
            const result = await request(origin + '/login?noauto=1');
            if (result.response.status === 200) return;
            lastError = new Error('login returned ' + result.response.status);
        } catch (error) {
            lastError = error;
        }
        await new Promise(resolve => setTimeout(resolve, 300));
    }
    throw new Error(label + ' did not become ready: ' + (lastError?.stack ?? 'none') + '\n' + output.join('').slice(-10000));
}

const indexes = {
    mixed: JSON.stringify({
        version: 2,
        images: {
            'backgrounds/forest.webp': { hash: 'keep', unknownImage: { retain: true } },
            'backgrounds/nested/keep.webp': { hash: 'nested' },
            'backgrounds/missing.webp': { hash: 'remove-missing' },
            '../escape.webp': { hash: 'remove-outside' },
            'backgrounds/sub/../../escape.webp': { hash: 'remove-traversal' },
        },
        folders: [{ id: 'forest', name: 'Forest', thumbnailFile: 'missing.webp', unknownFolder: true }],
        unknownRoot: { preserve: true },
    }, null, 4),
    allPresent: '{"version":3,"images":{"backgrounds/forest.webp":{"keep":1},"backgrounds/nested/keep.webp":{"keep":2}},"folders":[]}',
    allOrphaned: '{"version":4,"images":{"backgrounds/missing.webp":{"drop":1},"../escape.webp":{"drop":2}},"folders":[]}',
    arrayImages: '{"version":5,"images":[{"image":1},{"image":2}],"folders":[]}',
    stringImages: '{"version":6,"images":"abc","folders":[]}',
    numberImages: '{"version":7,"images":42,"folders":[]}',
    missingImages: '{"version":8,"folders":[]}',
    nullImages: '{"version":9,"images":null,"folders":[]}',
    nullRoot: 'null',
    malformed: '{"version":',
    missing: null,
};

const cases = {
    mixed: 'mixed',
    noOrphans: 'allPresent',
    allOrphaned: 'allOrphaned',
    arrayImages: 'arrayImages',
    stringImages: 'stringImages',
    numberImages: 'numberImages',
    missingImages: 'missingImages',
    nullImages: 'nullImages',
    nullRoot: 'nullRoot',
    malformedIndex: 'malformed',
    missingIndex: 'missing',
};

function writeIndex(indexPath, name, fixedDate) {
    const content = indexes[name];
    if (content === null) {
        rmSync(indexPath, { force: true });
        return;
    }
    writeFileSync(indexPath, content);
    utimesSync(indexPath, fixedDate, fixedDate);
}

function indexContent(indexPath) {
    return existsSync(indexPath) ? readFileSync(indexPath, 'utf8') : null;
}

try {
    mkdirSync(path.join(dataRoot, '_storage'), { recursive: true });
    writeFileSync(path.join(dataRoot, 'cookie-secret.txt'), COOKIE_SECRET);
    writeFileSync(configPath, 'enableUserAccounts: true\nskipContentCheck: true\n');
    seedUser('user:default-user', {
        handle: 'default-user', name: 'Image Metadata Cleanup Probe', created: 1700000000000,
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
    mkdirSync(path.join(backgroundsRoot, 'nested'), { recursive: true });
    writeFileSync(path.join(backgroundsRoot, 'forest.webp'), 'keep');
    writeFileSync(path.join(backgroundsRoot, 'nested', 'keep.webp'), 'keep');
    writeFileSync(path.join(dataRoot, 'escape.webp'), 'outside user root');
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
    const route = '/api/image-metadata/cleanup';
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
    };
    const fileContentsAfter = {};
    const fileExistsBeforeAndAfter = {};
    const mtimeUnchanged = {};
    const fixedDate = new Date('2001-02-03T04:05:06.000Z');
    for (const [name, indexName] of Object.entries(cases)) {
        writeIndex(indexPath, indexName, fixedDate);
        const existsBefore = existsSync(indexPath);
        const mtimeBefore = existsBefore ? statSync(indexPath).mtimeMs : null;
        responses[name] = capture(await request(origin + route, 'POST', { Cookie: sessionCookie, 'X-CSRF-Token': token }));
        const existsAfter = existsSync(indexPath);
        const mtimeAfter = existsAfter ? statSync(indexPath).mtimeMs : null;
        fileExistsBeforeAndAfter[name] = { before: existsBefore, after: existsAfter };
        mtimeUnchanged[name] = existsBefore === existsAfter && (!existsBefore || mtimeBefore === mtimeAfter);
        fileContentsAfter[name] = indexContent(indexPath);
    }

    const goRoundTripInput = {
        index: JSON.stringify({
            version: 20,
            images: {
                'backgrounds/forest.webp': { folderIds: ['forest'], unknownImage: { preserve: true } },
                'backgrounds/gone.webp': { folderIds: ['forest'] },
                '../escape.webp': { folderIds: ['forest'] },
            },
            folders: [{ id: 'forest', name: 'Forest', thumbnailFile: 'gone.webp', unknownFolder: true }],
            unknownRoot: { roundTrip: true },
        }, null, 4),
    };
    writeFileSync(indexPath, goRoundTripInput.index);
    const goPort = await choosePort();
    goServerOrigin = 'http://127.0.0.1:' + goPort;
    // image-metadata-roundtrip requires the configured thumbnail dimensions
    // (tools/image-metadata-roundtrip/main.go usage). This route never
    // generates metadata, so the empty default matches the probe's config.
    goChild = spawn('go', ['run', './tools/image-metadata-roundtrip', dataRoot, String(goPort), '{}'], { cwd: repositoryRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    goChild.stdout.setEncoding('utf8');
    goChild.stderr.setEncoding('utf8');
    goChild.stdout.on('data', chunk => goLogs.push(chunk));
    goChild.stderr.on('data', chunk => goLogs.push(chunk));
    await waitForServer(goServerOrigin, goChild, goLogs, 'GoTavern probe server');
    const goCleanup = await request(goServerOrigin + route, 'POST', {
        Cookie: sessionCookie, 'Content-Type': 'application/json', 'X-CSRF-Token': token,
    }, '{}');
    if (goCleanup.response.status !== 200) {
        throw new Error('GoTavern cleanup returned ' + goCleanup.response.status + ': ' + JSON.stringify(goCleanup.body) + '\n' + goLogs.join('').slice(-10000));
    }
    const nodeIndexReadback = await request(origin + '/api/image-metadata/all', 'POST', {
        Cookie: sessionCookie, 'Content-Type': 'application/json', 'X-CSRF-Token': token,
    }, '{}');
    const goRoundTrip = {
        goResponse: capture(goCleanup),
        nodeIndexReadback: capture(nodeIndexReadback),
        fileContent: indexContent(indexPath),
    };
    await stopGoServer();

    const fixture = {
        schemaVersion: 1,
        baseline: { version: PINNED_VERSION, commit: PINNED_COMMIT },
        probe: 'pinned cleanup removes missing and lexically out-of-root image keys in Object.keys order and writes only when entries are removed',
        inputs: { cookieSecret: COOKIE_SECRET, indexes, cases, goRoundTripInput },
        responses,
        state: {
            fileContentsAfter,
            fileExistsBeforeAndAfter,
            mtimeUnchanged,
            accountRecordUnchanged: accountRecordBefore.equals(readFileSync(accountRecordPath)),
            goRoundTrip,
        },
    };
    await stopServer();
    const outputFile = path.join(repositoryRoot, 'tests', 'oracle', 'sillytavern-1.19.0-image-metadata-cleanup.json');
    mkdirSync(path.dirname(outputFile), { recursive: true });
    writeFileSync(outputFile, JSON.stringify(fixture, null, 2) + '\n');
    console.log('Wrote tests/oracle/sillytavern-1.19.0-image-metadata-cleanup.json from pinned cleanup behavior');
} catch (error) {
    console.error(error);
    process.exitCode = 1;
} finally {
    await stopGoServer();
    await stopServer();
    safeCleanup();
}
