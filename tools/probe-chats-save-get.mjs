#!/usr/bin/env node
// Capture pinned chat save/load behavior: avatar_url middleware, JSONL writing,
// directory creation, and malformed-line tolerance.

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const PINNED_COMMIT = '06bde939fb1e9c4c8d8641d810f0a916b5bce127';
const PINNED_VERSION = '1.19.0';
// @gotavern-oracle: this declaration is read by tools/build-generated-lib.mjs,
// which auto-discovers probes so that adding one needs no edit there.
// @gotavern-oracle: fixture=sillytavern-1.19.0-chats-save-get.json label="chats-save-get"
const COOKIE_SECRET = 'gotavern-pinned-chats-save-get-cookie-secret';
const sourceRoot = path.resolve(process.argv[2] ?? '');
const repositoryRoot = path.resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3]) {
    console.error('usage: node tools/probe-chats-save-get.mjs <pinned-source-clone-with-dependencies> <gotavern-root>');
    process.exit(2);
}
if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim() !== PINNED_COMMIT) {
    throw new Error('upstream checkout is not pinned at ' + PINNED_COMMIT);
}

const runtimeRoot = mkdtempSync(path.join(os.tmpdir(), 'gotavern-chats-save-get-oracle-'));
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
        || !path.basename(resolved).startsWith('gotavern-chats-save-get-oracle-')) {
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

// Directory snapshot used to prove what the routes wrote to disk.
function snapshotDirectory(root) {
    if (!existsSync(root)) return null;
    const entries = [];
    const walk = (current, prefix) => {
        for (const name of readdirSync(current).sort()) {
            const target = path.join(current, name);
            const relative = prefix ? prefix + '/' + name : name;
            const info = statSync(target);
            if (info.isDirectory()) {
                entries.push({ path: relative, kind: 'directory' });
                walk(target, relative);
            } else {
                entries.push({ path: relative, kind: 'file', sha256: sha256(readFileSync(target)), bytes: info.size });
            }
        }
    };
    walk(root, '');
    return entries;
}

try {
    mkdirSync(path.join(dataRoot, '_storage'), { recursive: true });
    writeFileSync(path.join(dataRoot, 'cookie-secret.txt'), COOKIE_SECRET);
    writeFileSync(configPath, 'enableUserAccounts: true\nskipContentCheck: true\n');
    seedUser('user:default-user', {
        handle: 'default-user', name: 'Chats Save Get Probe', created: 1700000000000,
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
    const chatsRoot = path.join(userRoot, 'chats');
    const aliceDirectory = path.join(chatsRoot, 'Alice');
    mkdirSync(aliceDirectory, { recursive: true });
    // A chat with one good line and one unparseable line proves the pinned
    // tryParse filter drops malformed JSONL rows instead of failing the read.
    writeFileSync(path.join(aliceDirectory, 'existing.jsonl'), '{"mes":"one"}\nnot json\n{"mes":"two"}');
    writeFileSync(path.join(aliceDirectory, 'empty.jsonl'), '');
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

    const jsonHeaders = { Cookie: sessionCookie, 'X-CSRF-Token': token, 'Content-Type': 'application/json' };
    const saveRoute = '/api/chats/save';
    const getRoute = '/api/chats/get';
    const saveBody = value => JSON.stringify(value);

    const responses = {
        saveUnauthorized: capture(await request(origin + saveRoute, 'POST', {
            Cookie: csrfCookie, 'X-CSRF-Token': token, 'Content-Type': 'application/json',
        }, saveBody({ avatar_url: 'Alice.png', file_name: 'auth', chat: [] }))),
        saveInvalidCSRF: capture(await request(origin + saveRoute, 'POST', {
            Cookie: sessionCookie, 'Content-Type': 'application/json',
        }, saveBody({ avatar_url: 'Alice.png', file_name: 'auth', chat: [] }))),
        saveWrongMethod: capture(await request(origin + saveRoute, 'GET', { Cookie: sessionCookie })),
        saveWrongMethodHead: capture(await request(origin + saveRoute, 'HEAD', { Cookie: sessionCookie })),
        saveWrongMethodOptions: capture(await request(origin + saveRoute, 'OPTIONS', { Cookie: sessionCookie })),
        saveMissingChat: capture(await request(origin + saveRoute, 'POST', jsonHeaders,
            saveBody({ avatar_url: 'Alice.png', file_name: 'nochat' }))),
        saveNonArrayChat: capture(await request(origin + saveRoute, 'POST', jsonHeaders,
            saveBody({ avatar_url: 'Alice.png', file_name: 'nochat', chat: { a: 1 } }))),
        saveEmptyArrayChat: capture(await request(origin + saveRoute, 'POST', jsonHeaders,
            saveBody({ avatar_url: 'Alice.png', file_name: 'empty-array', chat: [] }))),
        saveNormalChat: capture(await request(origin + saveRoute, 'POST', jsonHeaders,
            saveBody({ avatar_url: 'Alice.png', file_name: 'normal', chat: [{ mes: 'one' }, { mes: 'two', extra: 1 }] }))),
        saveAvatarUrlWithSlash: capture(await request(origin + saveRoute, 'POST', jsonHeaders,
            saveBody({ avatar_url: '../evil.png', file_name: 'evil', chat: [] }))),
        // A separator that would still resolve inside the chats directory proves
        // the middleware runs before path resolution rather than being masked by
        // the isPathUnderParent check.
        saveAvatarUrlSubdirectory: capture(await request(origin + saveRoute, 'POST', jsonHeaders,
            saveBody({ avatar_url: 'sub/Alice.png', file_name: 'subdir', chat: [] }))),
        saveSanitizedFileName: capture(await request(origin + saveRoute, 'POST', jsonHeaders,
            saveBody({ avatar_url: 'Alice.png', file_name: 'a/b', chat: [{ mes: 'sanitized' }] }))),
        getUnauthorized: capture(await request(origin + getRoute, 'POST', {
            Cookie: csrfCookie, 'X-CSRF-Token': token, 'Content-Type': 'application/json',
        }, saveBody({ avatar_url: 'Alice.png', file_name: 'existing' }))),
        getWrongMethod: capture(await request(origin + getRoute, 'GET', { Cookie: sessionCookie })),
        getWrongMethodHead: capture(await request(origin + getRoute, 'HEAD', { Cookie: sessionCookie })),
        getExistingChat: capture(await request(origin + getRoute, 'POST', jsonHeaders,
            saveBody({ avatar_url: 'Alice.png', file_name: 'existing' }))),
        getEmptyChat: capture(await request(origin + getRoute, 'POST', jsonHeaders,
            saveBody({ avatar_url: 'Alice.png', file_name: 'empty' }))),
        getMissingFile: capture(await request(origin + getRoute, 'POST', jsonHeaders,
            saveBody({ avatar_url: 'Alice.png', file_name: 'does-not-exist' }))),
        getMissingFileName: capture(await request(origin + getRoute, 'POST', jsonHeaders,
            saveBody({ avatar_url: 'Alice.png' }))),
        getMissingCharacterDirectory: capture(await request(origin + getRoute, 'POST', jsonHeaders,
            saveBody({ avatar_url: 'BrandNew.png', file_name: 'anything' }))),
    };

    const savedNormalPath = path.join(aliceDirectory, 'normal.jsonl');
    const savedEmptyArrayPath = path.join(aliceDirectory, 'empty-array.jsonl');
    const fixture = {
        schemaVersion: 1,
        baseline: { version: PINNED_VERSION, commit: PINNED_COMMIT },
        probe: 'POST /api/chats/save and /api/chats/get match pinned avatar_url validation, JSONL serialization, directory creation, and malformed-line tolerance',
        inputs: {
            cookieSecret: COOKIE_SECRET,
            normalChat: [{ mes: 'one' }, { mes: 'two', extra: 1 }],
            existingChatFile: '{"mes":"one"}\nnot json\n{"mes":"two"}',
        },
        responses,
        state: {
            savedNormalJsonl: existsSync(savedNormalPath) ? readFileSync(savedNormalPath, 'utf8') : null,
            savedEmptyArrayJsonl: existsSync(savedEmptyArrayPath) ? readFileSync(savedEmptyArrayPath, 'utf8') : null,
            escapedSave: existsSync(path.join(userRoot, 'evil.jsonl')),
            newCharacterDirectoryCreated: existsSync(path.join(chatsRoot, 'BrandNew')),
            chatsTree: snapshotDirectory(chatsRoot),
            accountRecordUnchanged: accountRecordBefore.equals(readFileSync(accountRecordPath)),
        },
    };
    const outputFile = path.join(repositoryRoot, 'tests', 'oracle', 'sillytavern-1.19.0-chats-save-get.json');
    mkdirSync(path.dirname(outputFile), { recursive: true });
    writeFileSync(outputFile, JSON.stringify(fixture, null, 2) + '\n');
    console.log('Wrote tests/oracle/sillytavern-1.19.0-chats-save-get.json from pinned behavior');
} catch (error) {
    console.error(error);
    process.exitCode = 1;
} finally {
    await stopServer();
    safeCleanup();
}
