#!/usr/bin/env node
// Capture the pinned Expressions sprite-delete endpoint without touching its source data.

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const PINNED_COMMIT = '06bde939fb1e9c4c8d8641d810f0a916b5bce127';
const PINNED_VERSION = '1.19.0';
// @gotavern-oracle: this declaration is read by tools/build-generated-lib.mjs,
// which auto-discovers probes so that adding one needs no edit there.
// @gotavern-oracle: fixture=sillytavern-1.19.0-sprites-delete.json label="sprite-delete"
const COOKIE_SECRET = 'gotavern-pinned-sprites-delete-cookie-secret';
const sourceRoot = path.resolve(process.argv[2] ?? '');
const repositoryRoot = path.resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3]) {
    console.error('usage: node tools/probe-sprites-delete.mjs <pinned-source-clone> <gotavern-root>');
    process.exit(2);
}
if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim() !== PINNED_COMMIT) {
    throw new Error('upstream checkout is not pinned at ' + PINNED_COMMIT);
}

const runtimeRoot = mkdtempSync(path.join(os.tmpdir(), 'gotavern-sprites-delete-oracle-'));
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
        || !path.basename(resolved).startsWith('gotavern-sprites-delete-oracle-')) {
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

function snapshotTree(root) {
    const output = [];
    function visit(directory) {
        for (const name of readdirSync(directory)) {
            const target = path.join(directory, name);
            const info = statSync(target);
            const relative = path.relative(root, target).split(path.sep).join('/');
            if (info.isDirectory()) {
                output.push({ path: relative, kind: 'directory' });
                visit(target);
            } else if (info.isFile()) {
                output.push({
                    path: relative,
                    kind: 'file',
                    sha256: sha256(readFileSync(target)),
                });
            } else {
                output.push({ path: relative, kind: 'other' });
            }
        }
    }
    visit(root);
    return output.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

try {
    mkdirSync(path.join(dataRoot, '_storage'), { recursive: true });
    writeFileSync(path.join(dataRoot, 'cookie-secret.txt'), COOKIE_SECRET);
    writeFileSync(configPath, 'enableUserAccounts: true\nskipContentCheck: true\n');
    seedUser('user:default-user', {
        handle: 'default-user', name: 'Sprite Reader', created: 1700000000000,
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
    const charactersRoot = path.join(userRoot, 'characters');
    const spriteRoot = path.join(charactersRoot, 'Alice');
    const nestedRoot = path.join(spriteRoot, 'Expressions');
    mkdirSync(nestedRoot, { recursive: true });
    // Pinned src/endpoints/sprites.js:174 removes entries whose
    // path.parse(file).name equals spriteName exactly (case sensitive), so a
    // differently-cased basename must survive a lowercase delete. The fixture
    // must not express that with two names differing only by case: on a
    // case-insensitive host (Windows/NTFS) they are a single file, which makes
    // the recorded file-state observation host dependent. UPPER.png keeps the
    // case-sensitivity semantics while existing on every host.
    const files = [
        'Alice/same.png',
        'Alice/same.jpg',
        'Alice/same.txt',
        'Alice/same-1.png',
        'Alice/UPPER.png',
        'Alice/legacy.png',
        'Alice/legacy-1.png',
        'Alice/Expressions/happy.png',
        'Alice/Expressions/happy.webp',
        'Alice/Expressions/happy-1.png',
        'Alice/Expressions/other.png',
    ].map(filePath => ({ path: filePath, kind: 'file' }));
    const fixedTime = 1700000000;
    for (const file of files) {
        const target = path.join(charactersRoot, ...file.path.split('/'));
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, Buffer.from('sprite-delete-probe:' + file.path));
        utimesSync(target, fixedTime, fixedTime);
    }
    utimesSync(spriteRoot, fixedTime, fixedTime);
    utimesSync(nestedRoot, fixedTime, fixedTime);

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
    const requests = {
        deleteMulti: { name: 'Alice', label: 'ignored', spriteName: 'same' },
        deleteLabelFallback: { name: 'Alice', label: 'legacy', spriteName: '' },
        deleteNested: { name: 'Alice/Expressions', label: 'happy', spriteName: 'happy' },
        deleteNoMatch: { name: 'Alice', label: 'missing', spriteName: 'missing' },
        missingDirectory: { name: 'Missing', label: 'x', spriteName: 'x' },
        invalidSubfolder: { name: 'Alice/..', label: 'x', spriteName: 'x' },
        missingFields: {},
        emptyName: { name: '', label: 'x', spriteName: 'x' },
        nonStringSpriteName: { name: 'Alice', label: 'same', spriteName: 7 },
    };
    const post = (body, cookie = sessionCookie) => request(origin + '/api/sprites/delete', 'POST', {
        Cookie: cookie,
        'Content-Type': 'application/json',
        'X-CSRF-Token': token,
    }, JSON.stringify(body));
    const responses = {};
    const fileStates = { initial: snapshotTree(charactersRoot) };
    const perform = async (label, body, cookie = sessionCookie) => {
        responses[label] = capture(await post(body, cookie));
        fileStates[label] = snapshotTree(charactersRoot);
    };
    await perform('unauthorized', requests.deleteMulti, csrfCookie);
    await perform('deleteMulti', requests.deleteMulti);
    await perform('deleteLabelFallback', requests.deleteLabelFallback);
    await perform('deleteNested', requests.deleteNested);
    await perform('deleteNoMatch', requests.deleteNoMatch);
    await perform('missingDirectory', requests.missingDirectory);
    await perform('invalidSubfolder', requests.invalidSubfolder);
    await perform('missingFields', requests.missingFields);
    await perform('emptyName', requests.emptyName);
    await perform('nonStringSpriteName', requests.nonStringSpriteName);
    const accountRecordUnchanged = accountRecordBefore.equals(readFileSync(accountRecordPath));
    const fixture = {
        schemaVersion: 1,
        baseline: { version: PINNED_VERSION, commit: PINNED_COMMIT },
        probe: 'pinned Expressions sprite deletion authenticates, resolves character folders, removes exact basenames across extensions, applies label fallback, and preserves unrelated files',
        inputs: { cookieSecret: COOKIE_SECRET, files, requests },
        responses,
        state: { fileStates, accountRecordUnchanged },
    };
    await stopServer();
    const outputFile = path.join(repositoryRoot, 'tests', 'oracle', 'sillytavern-1.19.0-sprites-delete.json');
    mkdirSync(path.dirname(outputFile), { recursive: true });
    writeFileSync(outputFile, JSON.stringify(fixture, null, 2) + '\n');
    console.log('Wrote tests/oracle/sillytavern-1.19.0-sprites-delete.json from pinned sprite-delete behavior');
} catch (error) {
    console.error(error);
    process.exitCode = 1;
} finally {
    await stopServer();
    safeCleanup();
}
