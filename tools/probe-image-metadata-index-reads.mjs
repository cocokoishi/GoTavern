#!/usr/bin/env node
// Capture the pinned background virtual-folder endpoint and its metadata-index read behavior.

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const PINNED_COMMIT = '06bde939fb1e9c4c8d8641d810f0a916b5bce127';
const PINNED_VERSION = '1.19.0';
const COOKIE_SECRET = 'gotavern-pinned-image-metadata-index-reads-cookie-secret';
const sourceRoot = path.resolve(process.argv[2] ?? '');
const repositoryRoot = path.resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3]) {
    console.error('usage: node tools/probe-image-metadata-index-reads.mjs <pinned-source-clone> <gotavern-root>');
    process.exit(2);
}
if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim() !== PINNED_COMMIT) {
    throw new Error('upstream checkout is not pinned at ' + PINNED_COMMIT);
}

const runtimeRoot = mkdtempSync(path.join(os.tmpdir(), 'gotavern-image-metadata-index-reads-oracle-'));
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
        || !path.basename(resolved).startsWith('gotavern-image-metadata-index-reads-oracle-')) {
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

const indexes = {
    missing: null,
    malformed: '{"version":1,"images":',
    populated: (() => {
        const index = {
            version: 1,
            folders: [
                { id: 'forest', name: 'Forest', thumbnailFile: '', probeUnknownField: { preserved: true } },
                { id: 'people', name: 'People', thumbnailFile: 'friend.png' },
            ],
            images: {
                'backgrounds/nested/forest.webp': { folderIds: ['nested'], isAnimated: true },
                'backgrounds/forest.webp': { folderIds: ['forest', 'people'], probeUnknownField: 'kept on disk' },
                'characters/personas/friend.png': { folderIds: ['people'] },
                'backgrounds/empty.png': { folderIds: [] },
                'other/forest.webp': { folderIds: ['last-collision'] },
                'trailing/folder/': { folderIds: ['trailing'] },
            },
            probeUnknownField: 'preserved on disk',
        };
        Object.defineProperty(index.images, '__proto__', {
            value: { folderIds: ['prototype-key'] }, enumerable: true, configurable: true, writable: true,
        });
        return JSON.stringify(index, null, 2);
    })(),
    falseyFolders: JSON.stringify({ folders: false, images: {} }),
    missingImages: JSON.stringify({ version: 1, folders: [] }),
    nullImages: JSON.stringify({ version: 1, folders: [], images: null }),
    stringImages: JSON.stringify({ version: 1, folders: [{ id: 'string', name: 'String' }], images: 'abc' }),
    arrayImages: JSON.stringify({ version: 1, folders: [], images: [{ folderIds: ['array-entry'] }, { folderIds: [] }] }),
    serializeEdges: JSON.stringify({
        folders: [{ '10': 'ten', '2': 'two', name: '<>&\u2028', exponent: 1e21, small: 1e-7, negativeZero: -0 }],
        images: {
            'z/9': { folderIds: ['path-first'] },
            '10': { folderIds: ['ten'] },
            '2': { folderIds: ['two'] },
            'a/9': { folderIds: ['path-last'] },
        },
    }),
    nullRoot: 'null',
};

const imageMetadataAllRequests = {
    missing: { index: 'missing', body: {} },
    malformed: { index: 'malformed', body: {} },
    populated: { index: 'populated', body: {} },
    backgroundPrefix: { index: 'populated', body: { prefix: 'backgrounds/' } },
    otherPrefix: { index: 'populated', body: { prefix: 'other/' } },
    falseyPrefix: { index: 'populated', body: { prefix: 0 } },
    numericPrefix: { index: 'serializeEdges', body: { prefix: 2 } },
    arrayPrefix: { index: 'populated', body: { prefix: ['backgrounds/'] } },
    emptyArrayPrefix: { index: 'populated', body: { prefix: [] } },
    objectPrefix: { index: 'populated', body: { prefix: {} } },
    objectToStringError: { index: 'populated', body: { prefix: { toString: 'shadowed' } } },
    arrayBody: { index: 'populated', body: [{ prefix: 'backgrounds/' }] },
    missingImages: { index: 'missingImages', body: {} },
    missingImagesPrefix: { index: 'missingImages', body: { prefix: 'backgrounds/' } },
    nullImages: { index: 'nullImages', body: {} },
    nullImagesPrefix: { index: 'nullImages', body: { prefix: 'backgrounds/' } },
    stringImagesPrefix: { index: 'stringImages', body: { prefix: '1' } },
    arrayImagesPrefix: { index: 'arrayImages', body: { prefix: '0' } },
    serializedIndex: { index: 'serializeEdges', body: {} },
    nullRoot: { index: 'nullRoot', body: {} },
    nullRootPrefix: { index: 'nullRoot', body: { prefix: 'x' } },
};

try {
    mkdirSync(path.join(dataRoot, '_storage'), { recursive: true });
    writeFileSync(path.join(dataRoot, 'cookie-secret.txt'), COOKIE_SECRET);
    writeFileSync(configPath, 'enableUserAccounts: true\nskipContentCheck: true\n');
    seedUser('user:default-user', {
        handle: 'default-user', name: 'Background Folder Reader', created: 1700000000000,
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
    const responses = {
        unauthorized: capture(await request(origin + '/api/backgrounds/folders', 'POST', {
            Cookie: csrfCookie,
            'Content-Type': 'application/json',
            'X-CSRF-Token': token,
        }, '{}')),
        invalidCSRF: capture(await request(origin + '/api/backgrounds/folders', 'POST', {
            Cookie: sessionCookie,
            'Content-Type': 'application/json',
        }, '{}')),
        wrongMethod: capture(await request(origin + '/api/backgrounds/folders', 'GET', { Cookie: sessionCookie })),
        wrongMethodHead: capture(await request(origin + '/api/backgrounds/folders', 'HEAD', { Cookie: sessionCookie })),
    };
    const imageMetadataFoldersGetResponses = {
        unauthorized: capture(await request(origin + '/api/image-metadata/folders/get', 'POST', {
            Cookie: csrfCookie,
            'Content-Type': 'application/json',
            'X-CSRF-Token': token,
        }, '{}')),
        invalidCSRF: capture(await request(origin + '/api/image-metadata/folders/get', 'POST', {
            Cookie: sessionCookie,
            'Content-Type': 'application/json',
        }, '{}')),
        wrongMethod: capture(await request(origin + '/api/image-metadata/folders/get', 'GET', { Cookie: sessionCookie })),
        wrongMethodHead: capture(await request(origin + '/api/image-metadata/folders/get', 'HEAD', { Cookie: sessionCookie })),
    };
    const imageMetadataAllResponses = {
        unauthorized: capture(await request(origin + '/api/image-metadata/all', 'POST', {
            Cookie: csrfCookie,
            'Content-Type': 'application/json',
            'X-CSRF-Token': token,
        }, '{}')),
        invalidCSRF: capture(await request(origin + '/api/image-metadata/all', 'POST', {
            Cookie: sessionCookie,
            'Content-Type': 'application/json',
        }, '{}')),
        wrongMethod: capture(await request(origin + '/api/image-metadata/all', 'GET', { Cookie: sessionCookie })),
        wrongMethodHead: capture(await request(origin + '/api/image-metadata/all', 'HEAD', { Cookie: sessionCookie })),
    };
    const indexUnchanged = {};
    for (const [name, content] of Object.entries(indexes)) {
        if (content === null) {
            rmSync(indexPath, { force: true });
        } else {
            writeFileSync(indexPath, content);
        }
        const before = existsSync(indexPath) ? readFileSync(indexPath) : null;
        responses[name] = capture(await request(origin + '/api/backgrounds/folders', 'POST', {
            Cookie: sessionCookie,
            'Content-Type': 'application/json',
            'X-CSRF-Token': token,
        }, '{}'));
        imageMetadataFoldersGetResponses[name] = capture(await request(origin + '/api/image-metadata/folders/get', 'POST', {
            Cookie: sessionCookie,
            'Content-Type': 'application/json',
            'X-CSRF-Token': token,
        }, '{}'));
        const after = existsSync(indexPath) ? readFileSync(indexPath) : null;
        indexUnchanged[name] = before === null ? after === null : after !== null && before.equals(after);
    }
    const imageMetadataAllIndexUnchanged = {};
    for (const [name, probeRequest] of Object.entries(imageMetadataAllRequests)) {
        const content = indexes[probeRequest.index];
        if (content === null) {
            rmSync(indexPath, { force: true });
        } else {
            writeFileSync(indexPath, content);
        }
        const before = existsSync(indexPath) ? readFileSync(indexPath) : null;
        imageMetadataAllResponses[name] = capture(await request(origin + '/api/image-metadata/all', 'POST', {
            Cookie: sessionCookie,
            'Content-Type': 'application/json',
            'X-CSRF-Token': token,
        }, JSON.stringify(probeRequest.body)));
        const after = existsSync(indexPath) ? readFileSync(indexPath) : null;
        imageMetadataAllIndexUnchanged[name] = before === null ? after === null : after !== null && before.equals(after);
    }
    const accountRecordUnchanged = accountRecordBefore.equals(readFileSync(accountRecordPath));
    const fixture = {
        schemaVersion: 1,
        baseline: { version: PINNED_VERSION, commit: PINNED_COMMIT },
        probe: 'pinned background and image-metadata index read routes preserve folder, image, prefix, authentication, and read-only behavior',
        inputs: { cookieSecret: COOKIE_SECRET, indexes, imageMetadataAllRequests },
        responses,
        imageMetadataFoldersGetResponses,
        imageMetadataAllResponses,
        state: { indexUnchanged, imageMetadataAllIndexUnchanged, accountRecordUnchanged },
    };
    await stopServer();
    const outputFile = path.join(repositoryRoot, 'tests', 'oracle', 'sillytavern-1.19.0-image-metadata-index-reads.json');
    mkdirSync(path.dirname(outputFile), { recursive: true });
    writeFileSync(outputFile, JSON.stringify(fixture, null, 2) + '\n');
    console.log('Wrote tests/oracle/sillytavern-1.19.0-image-metadata-index-reads.json from pinned image-metadata behavior');
} catch (error) {
    console.error(error);
    process.exitCode = 1;
} finally {
    await stopServer();
    safeCleanup();
}
