#!/usr/bin/env node
// Capture pinned admin account listing, status/role changes, and deletion.

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const PINNED_COMMIT = '06bde939fb1e9c4c8d8641d810f0a916b5bce127';
const PINNED_VERSION = '1.19.0';
// @gotavern-oracle: this declaration is read by tools/build-generated-lib.mjs,
// which auto-discovers probes so that adding one needs no edit there.
// @gotavern-oracle: fixture=sillytavern-1.19.0-account-admin.json label="account-admin"
const COOKIE_SECRET = 'gotavern-pinned-account-admin-probe-secret';
const sourceRoot = path.resolve(process.argv[2] ?? '');
const repositoryRoot = path.resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3]) {
    console.error('usage: node tools/probe-account-admin.mjs <pinned-source-clone> <gotavern-root>');
    process.exit(2);
}
if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim() !== PINNED_COMMIT) {
    throw new Error(`upstream checkout is not pinned at ${PINNED_COMMIT}`);
}

const runtimeRoot = mkdtempSync(path.join(os.tmpdir(), 'gotavern-account-admin-oracle-'));
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
        || !path.basename(resolved).startsWith('gotavern-account-admin-oracle-')) {
        throw new Error(`refusing to remove unexpected runtime path: ${resolved}`);
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
        // Retain non-JSON response bodies.
    }
    return { response, body: parsedBody };
}

function stableHeaders(response) {
    return Object.fromEntries([...response.headers.entries()]
        .filter(([name]) => !['connection', 'date', 'keep-alive', 'last-modified', 'set-cookie', 'x-response-time'].includes(name))
        .sort(([left], [right]) => left.localeCompare(right)));
}

function cookiesFrom(response) {
    if (typeof response.headers.getSetCookie !== 'function') throw new Error('Node fetch does not expose getSetCookie()');
    return response.headers.getSetCookie();
}

function cookieHeader(cookies) {
    return cookies.map(cookie => cookie.split(';', 1)[0]).join('; ');
}

function capture(result) {
    return { status: result.response.status, headers: stableHeaders(result.response), body: result.body };
}

function seedUser(key, value) {
    const file = path.join(dataRoot, '_storage', sha256(key));
    writeFileSync(file, JSON.stringify({ key, value }));
}

function startPinnedServer(port) {
    child = spawn(process.execPath, [
        'server.js', '--configPath', configPath, '--dataRoot', dataRoot,
        '--listenAddressIPv4', '127.0.0.1', '--enableIPv4', 'true', '--enableIPv6', 'false',
        '--listen', 'false', '--port', String(port), '--browserLaunchEnabled', 'false', '--heartbeatInterval', '0',
    ], { cwd: sourceRoot, env: { ...process.env, NODE_ENV: 'test' }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => logs.push(chunk));
    child.stderr.on('data', chunk => logs.push(chunk));
}

async function waitForServer(origin) {
    const deadline = Date.now() + 180000;
    let lastError;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error(`pinned server exited before readiness:\n${logs.join('').slice(-10000)}`);
        try {
            const result = await request(`${origin}/login?noauto=1`);
            if (result.response.status === 200 && result.response.headers.get('content-type')?.includes('text/html')) return;
            lastError = new Error(`login page returned ${result.response.status}`);
        } catch (error) {
            lastError = error;
        }
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error(`pinned server at ${origin} did not become ready: ${lastError?.stack ?? 'none'}\n${logs.join('').slice(-10000)}`);
}

try {
    mkdirSync(path.join(dataRoot, '_storage'), { recursive: true });
    writeFileSync(path.join(dataRoot, 'cookie-secret.txt'), COOKIE_SECRET);
    writeFileSync(configPath, 'enableUserAccounts: true\nskipContentCheck: true\n');
    const users = [
        { handle: 'default-user', name: 'Admin', created: 1700000000000, password: '', admin: true, enabled: true, salt: '', futureField: { keep: true } },
        { handle: 'second-admin', name: 'Second Admin', created: 1700000000001, password: '', admin: true, enabled: true, salt: '' },
        { handle: 'regular-user', name: 'Regular User', created: 1700000000002, password: '', admin: false, enabled: true, salt: '' },
        { handle: 'disabled-user', name: 'Disabled User', created: 1700000000003, password: '', admin: false, enabled: false, salt: '' },
        { handle: 'promote-user', name: 'Promote User', created: 1700000000004, password: '', admin: false, enabled: true, salt: '' },
        { handle: 'demote-user', name: 'Demote User', created: 1700000000005, password: '', admin: true, enabled: true, salt: '' },
        { handle: 'retain-user', name: 'Retain Directory User', created: 1700000000006, password: '', admin: false, enabled: true, salt: '' },
        { handle: 'purge-user', name: 'Purge Directory User', created: 1700000000007, password: '', admin: false, enabled: true, salt: '' },
    ];
    for (const user of users) {
        seedUser(`user:${user.handle}`, user);
        const userRoot = path.join(dataRoot, user.handle);
        mkdirSync(userRoot, { recursive: true });
        writeFileSync(path.join(userRoot, 'admin-probe-sentinel.txt'), user.handle);
    }
    seedUser('avatar:regular-user', 'data:image/png;base64,AQ==');

    const port = await choosePort();
    const origin = `http://127.0.0.1:${port}`;
    startPinnedServer(port);
    await waitForServer(origin);
    const csrf = await request(`${origin}/csrf-token`);
    const token = csrf.body.token;
    const csrfCookie = cookieHeader(cookiesFrom(csrf.response));
    const post = (route, cookie, body = {}) => request(`${origin}/api/users/${route}`, 'POST', {
        Cookie: cookie,
        'Content-Type': 'application/json',
        'X-CSRF-Token': token,
    }, JSON.stringify(body));
    const login = async handle => {
        const result = await post('login', csrfCookie, { handle });
        if (result.response.status !== 200) throw new Error(`could not login ${handle}: ${result.response.status} ${JSON.stringify(result.body)}\n${logs.join('').slice(-10000)}`);
        return cookieHeader(cookiesFrom(result.response));
    };
    const adminCookie = await login('default-user');
    const regularCookie = await login('regular-user');
    const secondAdminCookie = await login('second-admin');

    const responses = {
        usersBefore: capture(await post('get', adminCookie)),
        nonAdminGet: capture(await post('get', regularCookie)),
        missingDisable: capture(await post('disable', adminCookie, {})),
        selfDisable: capture(await post('disable', adminCookie, { handle: 'default-user' })),
        unknownDisable: capture(await post('disable', adminCookie, { handle: 'missing-user' })),
        disable: capture(await post('disable', adminCookie, { handle: 'regular-user' })),
        loginDisabled: capture(await post('login', csrfCookie, { handle: 'regular-user' })),
        missingEnable: capture(await post('enable', adminCookie, {})),
        unknownEnable: capture(await post('enable', adminCookie, { handle: 'missing-user' })),
        enable: capture(await post('enable', adminCookie, { handle: 'regular-user' })),
        missingPromote: capture(await post('promote', adminCookie, {})),
        unknownPromote: capture(await post('promote', adminCookie, { handle: 'missing-user' })),
        promote: capture(await post('promote', adminCookie, { handle: 'promote-user' })),
        missingDemote: capture(await post('demote', adminCookie, {})),
        selfDemote: capture(await post('demote', secondAdminCookie, { handle: 'second-admin' })),
        unknownDemote: capture(await post('demote', adminCookie, { handle: 'missing-user' })),
        demote: capture(await post('demote', adminCookie, { handle: 'demote-user' })),
        usersAfterRoleChanges: capture(await post('get', adminCookie)),
        missingDelete: capture(await post('delete', adminCookie, {})),
        selfDelete: capture(await post('delete', secondAdminCookie, { handle: 'second-admin' })),
        defaultDelete: capture(await post('delete', secondAdminCookie, { handle: 'default-user' })),
        unknownDelete: capture(await post('delete', adminCookie, { handle: 'missing-user' })),
        deleteRetain: capture(await post('delete', adminCookie, { handle: 'retain-user' })),
        deletePurge: capture(await post('delete', adminCookie, { handle: 'purge-user', purge: true })),
        usersAfterDeletes: capture(await post('get', adminCookie)),
    };
    await stopServer();

    const requireFromPinned = createRequire(path.join(sourceRoot, 'package.json'));
    const storage = requireFromPinned('node-persist');
    await storage.init({ dir: path.join(dataRoot, '_storage'), ttl: false, expiredInterval: 0, writeQueue: false });
    const remainingHandles = users.filter(user => user.handle !== 'retain-user' && user.handle !== 'purge-user').map(user => user.handle);
    const persistedUsers = {};
    for (const handle of remainingHandles) persistedUsers[handle] = await storage.getItem(`user:${handle}`);
    const retainDirectoryExists = await import('node:fs').then(({ existsSync }) => existsSync(path.join(dataRoot, 'retain-user')));
    const purgeDirectoryExists = await import('node:fs').then(({ existsSync }) => existsSync(path.join(dataRoot, 'purge-user')));
    const fixture = {
        schemaVersion: 1,
        baseline: { version: PINNED_VERSION, commit: PINNED_COMMIT },
        probe: 'pinned account admin list, enable/disable, promote/demote, and delete behavior',
        inputs: { cookieSecret: COOKIE_SECRET },
        responses,
        persisted: {
            remainingHandles,
            disabledUserEnabled: persistedUsers['disabled-user'].enabled,
            regularUserEnabled: persistedUsers['regular-user'].enabled,
            promotedAdmin: persistedUsers['promote-user'].admin,
            demotedAdmin: persistedUsers['demote-user'].admin,
            unknownFieldPreserved: persistedUsers['default-user'].futureField.keep,
            retainRecordExists: (await storage.getItem('user:retain-user')) !== undefined,
            purgeRecordExists: (await storage.getItem('user:purge-user')) !== undefined,
            retainDirectoryExists,
            purgeDirectoryExists,
        },
    };
    if (fixture.persisted.retainRecordExists || fixture.persisted.purgeRecordExists || fixture.persisted.retainDirectoryExists !== true || fixture.persisted.purgeDirectoryExists !== false) {
        throw new Error(`pinned delete persistence mismatch: ${JSON.stringify(fixture.persisted)}`);
    }
    const outputFile = path.join(repositoryRoot, 'tests', 'oracle', 'sillytavern-1.19.0-account-admin.json');
    mkdirSync(path.dirname(outputFile), { recursive: true });
    writeFileSync(outputFile, `${JSON.stringify(fixture, null, 2)}\n`);
    console.log(`Wrote ${path.relative(repositoryRoot, outputFile)} from pinned account admin routes`);
} finally {
    await stopServer();
    safeCleanup();
}
