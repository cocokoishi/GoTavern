#!/usr/bin/env node
// Capture pinned folder assignments and Go-to-Node round trips for both mutations.

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const PINNED_COMMIT = '06bde939fb1e9c4c8d8641d810f0a916b5bce127';
const PINNED_VERSION = '1.19.0';
const COOKIE_SECRET = 'gotavern-pinned-image-metadata-folder-assignments-cookie-secret';
const sourceRoot = path.resolve(process.argv[2] ?? '');
const repositoryRoot = path.resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3]) {
    console.error('usage: node tools/probe-image-metadata-folder-assignments.mjs <pinned-source-clone> <gotavern-root>');
    process.exit(2);
}
if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim() !== PINNED_COMMIT) {
    throw new Error('upstream checkout is not pinned at ' + PINNED_COMMIT);
}

const runtimeRoot = mkdtempSync(path.join(os.tmpdir(), 'gotavern-image-metadata-folder-assignments-oracle-'));
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
        || !path.basename(resolved).startsWith('gotavern-image-metadata-folder-assignments-oracle-')) {
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
    populated: JSON.stringify({
        version: 2,
        images: {
            'backgrounds/forest.webp': { folderIds: ['beta'], unknownImage: { keep: true } },
            'backgrounds/legacy.webp': { folderIds: ['alpha', 'alpha', 'beta'], retain: ['unknown'] },
            'backgrounds/rebuild.webp': { folderIds: 'wrong-shape', unknown: true },
            'backgrounds/stale.webp': { folderIds: ['beta'] },
        },
        folders: [
            { id: 'alpha', name: 'Alpha', thumbnailFile: '', unknownFolder: { keep: true } },
            { id: 'beta', name: 'Beta', thumbnailFile: '', probe: 2 },
        ],
        unknownRoot: { preserve: true },
    }, null, 4),
    normalizedPaths: JSON.stringify({
        version: 3,
        images: {
            'backgrounds/forest.webp': { folderIds: ['alpha'], keep: true },
        },
        folders: [{ id: 'alpha', name: 'Alpha', thumbnailFile: '' }],
    }, null, 4),
    rawPaths: JSON.stringify({
        version: 4,
        images: {
            'backgrounds/a/../forest.webp': { folderIds: ['alpha'] },
            'backgrounds/forest.webp': { folderIds: ['alpha'] },
        },
        folders: [],
    }, null, 4),
    imagesArray: '{"version":15,"images":[{"folderIds":["alpha"]}],"folders":[{"id":"alpha"}]}',
    arrayMetadata: '{"version":16,"images":{"backgrounds/forest.webp":[1,2]},"folders":[{"id":"alpha"}]}',
    noFolders: '{"version":5,"images":{}}',
    nullFolders: '{"version":6,"images":{},"folders":null}',
    nullFolderEntry: '{"version":7,"images":{},"folders":[null]}',
    missingImages: '{"version":8,"folders":[{"id":"alpha"}]}',
    nullImages: '{"version":9,"images":null,"folders":[{"id":"alpha"}]}',
    missingFolderIndex: '{"version":10,"images":{},"folders":[]}',
    nullRoot: 'null',
    malformed: '{"version":',
    missing: null,
    primitiveMetadata: '{"version":11,"images":{"backgrounds/forest.webp":true},"folders":[{"id":"alpha"}]}',
    badFolderIDs: '{"version":12,"images":{"backgrounds/rebuild.webp":{"folderIds":"wrong","keep":true}},"folders":[{"id":"alpha"}]}',
    nullMeta: '{"version":13,"images":{"backgrounds/null.webp":null},"folders":[]}',
    nullKey: '{"version":14,"images":{"null":{"folderIds":["alpha"]}},"folders":[]}',
};

const assignCases = {
    validBatch: { index: 'populated', body: { id: 'alpha', paths: [
        'backgrounds/forest.webp', 'backgrounds/new.webp', 'backgrounds/forest.webp',
        'backgrounds/missing.webp', 'backgrounds/nested/../forest.webp',
    ] } },
    normalizedTraversal: { index: 'normalizedPaths', body: { id: 'alpha', paths: ['backgrounds/sub/../forest.webp'] } },
    invalidTraversal: { index: 'populated', body: { id: 'alpha', paths: ['backgrounds/../outside.webp'] } },
    invalidPrefix: { index: 'populated', body: { id: 'alpha', paths: ['outside.webp'] } },
    missingFolderBeforePathValidation: { index: 'populated', body: { id: 'absent', paths: ['outside.webp'] } },
    missingFolder: { index: 'missingFolderIndex', body: { id: 'absent', paths: [] } },
    missingFile: { index: 'populated', body: { id: 'alpha', paths: ['backgrounds/missing.webp'] } },
    emptyPaths: { index: 'populated', body: { id: 'alpha', paths: [] } },
    missingImagesMissingFile: { index: 'missingImages', body: { id: 'alpha', paths: ['backgrounds/missing.webp'] } },
    missingImagesExistingFile: { index: 'missingImages', body: { id: 'alpha', paths: ['backgrounds/forest.webp'] } },
    nullImagesExistingFile: { index: 'nullImages', body: { id: 'alpha', paths: ['backgrounds/forest.webp'] } },
    nullFolders: { index: 'nullFolders', body: { id: 'alpha', paths: [] } },
    nullFolderEntry: { index: 'nullFolderEntry', body: { id: 'alpha', paths: [] } },
    noFolders: { index: 'noFolders', body: { id: 'alpha', paths: [] } },
    malformedIndex: { index: 'malformed', body: { id: 'alpha', paths: [] } },
    missingIndex: { index: 'missing', body: { id: 'alpha', paths: [] } },
    missingID: { index: 'populated', body: { paths: [] } },
    emptyID: { index: 'populated', body: { id: '', paths: [] } },
    nonStringID: { index: 'populated', body: { id: 4, paths: [] } },
    missingPaths: { index: 'populated', body: { id: 'alpha' } },
    nonArrayPaths: { index: 'populated', body: { id: 'alpha', paths: 'backgrounds/forest.webp' } },
    nullPath: { index: 'populated', body: { id: 'alpha', paths: [null] } },
    truthyPrimitiveMetadata: { index: 'primitiveMetadata', body: { id: 'alpha', paths: ['backgrounds/forest.webp'] } },
    replaceBadFolderIds: {
        index: 'badFolderIDs',
        body: { id: 'alpha', paths: ['backgrounds/rebuild.webp'] },
    },
    imagesArrayNamedProperty: { index: 'imagesArray', body: { id: 'alpha', paths: ['backgrounds/forest.webp'] } },
    arrayImageMetadata: { index: 'arrayMetadata', body: { id: 'alpha', paths: ['backgrounds/forest.webp'] } },
};

const unassignCases = {
    removeDuplicates: { index: 'populated', body: { id: 'alpha', paths: ['backgrounds/legacy.webp', 'backgrounds/legacy.webp'] } },
    unknownFolderID: { index: 'populated', body: { id: 'absent', paths: ['backgrounds/legacy.webp'] } },
    noPathNormalization: { index: 'rawPaths', body: { id: 'alpha', paths: ['backgrounds/a/../forest.webp'] } },
    emptyPaths: { index: 'populated', body: { id: 'alpha', paths: [] } },
    nullRootEmpty: { index: 'nullRoot', body: { id: 'alpha', paths: [] } },
    nullRootNonEmpty: { index: 'nullRoot', body: { id: 'alpha', paths: ['backgrounds/forest.webp'] } },
    missingImagesEmpty: { index: 'missingImages', body: { id: 'alpha', paths: [] } },
    missingImagesNonEmpty: { index: 'missingImages', body: { id: 'alpha', paths: ['backgrounds/forest.webp'] } },
    nullImagesNonEmpty: { index: 'nullImages', body: { id: 'alpha', paths: ['backgrounds/forest.webp'] } },
    nullMetaSkipped: { index: 'nullMeta', body: { id: 'alpha', paths: ['backgrounds/null.webp'] } },
    nonArrayFolderIDs: { index: 'populated', body: { id: 'alpha', paths: ['backgrounds/rebuild.webp'] } },
    missingID: { index: 'populated', body: { paths: [] } },
    emptyID: { index: 'populated', body: { id: '', paths: [] } },
    nonStringID: { index: 'populated', body: { id: 4, paths: [] } },
    missingPaths: { index: 'populated', body: { id: 'alpha' } },
    nonArrayPaths: { index: 'populated', body: { id: 'alpha', paths: {} } },
    coerceNullPathKey: { index: 'nullKey', body: { id: 'alpha', paths: [null] } },
    missingIndex: { index: 'missing', body: { id: 'alpha', paths: [] } },
    malformedIndex: { index: 'malformed', body: { id: 'alpha', paths: [] } },
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
        handle: 'default-user', name: 'Image Metadata Folder Assignment Probe', created: 1700000000000,
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
    for (const filename of ['forest.webp', 'new.webp', 'rebuild.webp', 'tree.png']) {
        writeFileSync(path.join(backgroundsRoot, filename), 'probe image data');
    }
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
    const routeFor = operation => '/api/image-metadata/folders/' + operation;
    const headers = { Cookie: sessionCookie, 'Content-Type': 'application/json', 'X-CSRF-Token': token };
    const responses = { assign: {}, unassign: {} };
    for (const operation of ['assign', 'unassign']) {
        const route = routeFor(operation);
        responses[operation].unauthorized = capture(await request(origin + route, 'POST', {
            Cookie: csrfCookie, 'Content-Type': 'application/json', 'X-CSRF-Token': token,
        }, JSON.stringify({ id: 'alpha', paths: [] })));
        responses[operation].invalidCSRF = capture(await request(origin + route, 'POST', {
            Cookie: sessionCookie, 'Content-Type': 'application/json',
        }, JSON.stringify({ id: 'alpha', paths: [] })));
        responses[operation].wrongMethod = capture(await request(origin + route, 'GET', { Cookie: sessionCookie }));
        responses[operation].wrongMethodHead = capture(await request(origin + route, 'HEAD', { Cookie: sessionCookie }));
        responses[operation].wrongMethodOptions = capture(await request(origin + route, 'OPTIONS', { Cookie: sessionCookie }));
    }

    const assignFileContentsAfter = {};
    for (const [name, item] of Object.entries(assignCases)) {
        writeIndex(indexPath, item.index);
        responses.assign[name] = capture(await request(origin + routeFor('assign'), 'POST', headers, JSON.stringify(item.body)));
        assignFileContentsAfter[name] = indexContent(indexPath);
    }
    const unassignFileContentsAfter = {};
    for (const [name, item] of Object.entries(unassignCases)) {
        writeIndex(indexPath, item.index);
        responses.unassign[name] = capture(await request(origin + routeFor('unassign'), 'POST', headers, JSON.stringify(item.body)));
        unassignFileContentsAfter[name] = indexContent(indexPath);
    }

    const goRoundTripInput = {
        index: JSON.stringify({
            version: 20,
            images: {
                'backgrounds/tree.png': { folderIds: ['forest', 'forest', 'people'], unknownImage: { preserve: true } },
            },
            folders: [
                { id: 'forest', name: 'Forest', thumbnailFile: '', unknownFolder: { keep: true } },
                { id: 'people', name: 'People', thumbnailFile: '', probe: ['retained'] },
            ],
            unknownRoot: { roundTrip: true },
        }, null, 4),
        assignBody: { id: 'forest', paths: ['backgrounds/tree.png', 'backgrounds/missing.png'] },
        unassignBody: { id: 'forest', paths: ['backgrounds/tree.png', 'backgrounds/tree.png'] },
    };
    writeFileSync(indexPath, goRoundTripInput.index);
    const goPort = await choosePort();
    goServerOrigin = 'http://127.0.0.1:' + goPort;
    goChild = spawn('go', ['run', './tools/image-metadata-roundtrip', dataRoot, String(goPort)], { cwd: repositoryRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    goChild.stdout.setEncoding('utf8');
    goChild.stderr.setEncoding('utf8');
    goChild.stdout.on('data', chunk => goLogs.push(chunk));
    goChild.stderr.on('data', chunk => goLogs.push(chunk));
    await waitForServer(goServerOrigin, goChild, goLogs, 'GoTavern probe server');
    const goAssign = await request(goServerOrigin + routeFor('assign'), 'POST', {
        Cookie: sessionCookie, 'Content-Type': 'application/json', 'X-CSRF-Token': token,
    }, JSON.stringify(goRoundTripInput.assignBody));
    if (goAssign.response.status !== 200) {
        throw new Error('GoTavern folder assign returned ' + goAssign.response.status + ': ' + JSON.stringify(goAssign.body) + '\n' + goLogs.join('').slice(-10000));
    }
    const nodeFoldersAfterAssign = await request(origin + '/api/image-metadata/folders/get', 'POST', headers, '{}');
    const nodeIndexAfterAssign = await request(origin + '/api/image-metadata/all', 'POST', headers, '{}');
    const fileAfterAssign = indexContent(indexPath);
    const goUnassign = await request(goServerOrigin + routeFor('unassign'), 'POST', {
        Cookie: sessionCookie, 'Content-Type': 'application/json', 'X-CSRF-Token': token,
    }, JSON.stringify(goRoundTripInput.unassignBody));
    if (goUnassign.response.status !== 200) {
        throw new Error('GoTavern folder unassign returned ' + goUnassign.response.status + ': ' + JSON.stringify(goUnassign.body) + '\n' + goLogs.join('').slice(-10000));
    }
    const nodeFoldersAfterUnassign = await request(origin + '/api/image-metadata/folders/get', 'POST', headers, '{}');
    const nodeIndexAfterUnassign = await request(origin + '/api/image-metadata/all', 'POST', headers, '{}');
    const goRoundTrip = {
        goAssignResponse: capture(goAssign),
        nodeFoldersAfterAssign: capture(nodeFoldersAfterAssign),
        nodeIndexAfterAssign: capture(nodeIndexAfterAssign),
        fileAfterAssign,
        goUnassignResponse: capture(goUnassign),
        nodeFoldersAfterUnassign: capture(nodeFoldersAfterUnassign),
        nodeIndexAfterUnassign: capture(nodeIndexAfterUnassign),
        fileAfterUnassign: indexContent(indexPath),
    };
    await stopGoServer();

    const fixture = {
        schemaVersion: 1,
        baseline: { version: PINNED_VERSION, commit: PINNED_COMMIT },
        probe: 'pinned folder assign validates existing background paths and deduplicates IDs; unassign removes one ID per path without normalizing or validating paths',
        inputs: { cookieSecret: COOKIE_SECRET, indexes, assignCases, unassignCases, goRoundTripInput },
        responses,
        state: { assignFileContentsAfter, unassignFileContentsAfter, accountRecordUnchanged: accountRecordBefore.equals(readFileSync(accountRecordPath)), goRoundTrip },
    };
    await stopServer();
    const outputFile = path.join(repositoryRoot, 'tests', 'oracle', 'sillytavern-1.19.0-image-metadata-folder-assignments.json');
    mkdirSync(path.dirname(outputFile), { recursive: true });
    writeFileSync(outputFile, JSON.stringify(fixture, null, 2) + '\n');
    console.log('Wrote tests/oracle/sillytavern-1.19.0-image-metadata-folder-assignments.json from pinned assignment behavior');
} catch (error) {
    console.error(error);
    process.exitCode = 1;
} finally {
    await stopGoServer();
    await stopServer();
    safeCleanup();
}
