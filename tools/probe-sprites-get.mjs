#!/usr/bin/env node
// Capture the pinned Expressions sprite-list endpoint without touching its source data.

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const PINNED_COMMIT = '06bde939fb1e9c4c8d8641d810f0a916b5bce127';
const PINNED_VERSION = '1.19.0';
const COOKIE_SECRET = 'gotavern-pinned-sprites-get-cookie-secret';
const sourceRoot = path.resolve(process.argv[2] ?? '');
const repositoryRoot = path.resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3]) {
    console.error('usage: node tools/probe-sprites-get.mjs <pinned-source-clone> <gotavern-root>');
    process.exit(2);
}
if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim() !== PINNED_COMMIT) {
    throw new Error('upstream checkout is not pinned at ' + PINNED_COMMIT);
}

const runtimeRoot = mkdtempSync(path.join(os.tmpdir(), 'gotavern-sprites-get-oracle-'));
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
        || !path.basename(resolved).startsWith('gotavern-sprites-get-oracle-')) {
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

function capture(result, normalizeSpriteList = false) {
    let body = result.body;
    if (normalizeSpriteList && Array.isArray(body)) {
        // Pinned src/endpoints/sprites.js:126 builds the list from
        // fs.readdirSync(spritesPath) with no sort, so the array order is the
        // host filesystem's directory order (NTFS returns name-sorted entries,
        // ext4/overlayfs do not). Canonicalising the recorded entries by the
        // UTF-8 bytes of "path" makes the observation host independent; the Go
        // differential test compares the response as an unordered multiset for
        // the same reason. The filtered/labelled entry set is unchanged.
        body = [...body].sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
    }
    return { status: result.response.status, headers: stableHeaders(result.response), body };
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
                output.push({ path: relative, kind: 'directory', mtime: info.mtime.toISOString() });
                visit(target);
            } else if (info.isFile()) {
                output.push({
                    path: relative,
                    kind: 'file',
                    mtime: info.mtime.toISOString(),
                    sha256: sha256(readFileSync(target)),
                });
            } else {
                output.push({ path: relative, kind: 'other', mtime: info.mtime.toISOString() });
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
    const files = [
        { path: 'Alice/joy.png', kind: 'file' },
        { path: 'Alice/joy-1.PNG', kind: 'file' },
        { path: 'Alice/joy.expressive.jpg', kind: 'file' },
        { path: 'Alice/Sad.gif', kind: 'file' },
        { path: 'Alice/emoji🙂-tiny.avif', kind: 'file' },
        { path: 'Alice/.hidden.png', kind: 'file' },
        { path: 'Alice/.png', kind: 'file' },
        { path: 'Alice/folder.png', kind: 'directory' },
        { path: 'Alice/note.txt', kind: 'file' },
        { path: 'Alice/no-extension', kind: 'file' },
        { path: 'Alice/Expressions/annoyed.webp', kind: 'file' },
        { path: 'Alice/Expressions/annoyed-1.png', kind: 'file' },
        { path: 'Alice/Expressions/other.svg', kind: 'file' },
        { path: 'Alice/Expressions/ignore.txt', kind: 'file' },
    ];
    const fixedTime = 1700000000;
    for (const file of files) {
        const target = path.join(charactersRoot, ...file.path.split('/'));
        if (file.kind === 'directory') {
            mkdirSync(target);
        } else {
            writeFileSync(target, Buffer.from('sprite-probe:' + file.path));
        }
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
    const treeBefore = snapshotTree(charactersRoot);
    const get = (route, cookie = sessionCookie) => request(origin + route, 'GET', { Cookie: cookie });
    const responses = {
        unauthorized: capture(await get('/api/sprites/get?name=Alice', csrfCookie), true),
        base: capture(await get('/api/sprites/get?name=Alice'), true),
        nested: capture(await get('/api/sprites/get?name=Alice%2FExpressions'), true),
        extraSubfolderSegment: capture(await get('/api/sprites/get?name=Alice%2FExpressions%2Fignored'), true),
        invalidSubfolder: capture(await get('/api/sprites/get?name=Alice%2F..'), true),
        missing: capture(await get('/api/sprites/get?name=Missing'), true),
        absentName: capture(await get('/api/sprites/get'), true),
    };
    const treeAfter = snapshotTree(charactersRoot);
    const accountRecordUnchanged = accountRecordBefore.equals(readFileSync(accountRecordPath));
    const fixture = {
        schemaVersion: 1,
        baseline: { version: PINNED_VERSION, commit: PINNED_COMMIT },
        probe: 'pinned Expressions sprite listing filters image MIME types, maps labels and mtimes, handles nested paths, authenticates, and does not mutate data',
        inputs: { cookieSecret: COOKIE_SECRET, modifiedAtUnixSeconds: fixedTime, files },
        responses,
        state: {
            fileState: treeBefore,
            filesUnchanged: JSON.stringify(treeBefore) === JSON.stringify(treeAfter),
            accountRecordUnchanged,
        },
    };
    await stopServer();
    const outputFile = path.join(repositoryRoot, 'tests', 'oracle', 'sillytavern-1.19.0-sprites-get.json');
    mkdirSync(path.dirname(outputFile), { recursive: true });
    writeFileSync(outputFile, JSON.stringify(fixture, null, 2) + '\n');
    console.log('Wrote tests/oracle/sillytavern-1.19.0-sprites-get.json from pinned sprite-list behavior');
} catch (error) {
    console.error(error);
    process.exitCode = 1;
} finally {
    await stopServer();
    safeCleanup();
}
