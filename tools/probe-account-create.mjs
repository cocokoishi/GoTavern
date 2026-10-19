#!/usr/bin/env node
// Capture pinned admin account creation, slugification, and settings seeding.

import { execFileSync, spawn } from 'node:child_process';
import { createHash, scryptSync } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const PINNED_COMMIT = '06bde939fb1e9c4c8d8641d810f0a916b5bce127';
const PINNED_VERSION = '1.19.0';
const COOKIE_SECRET = 'gotavern-pinned-account-create-probe-secret';
const PASSWORD = 'pa\u0301ssword';
const sourceRoot = path.resolve(process.argv[2] ?? '');
const repositoryRoot = path.resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3]) {
    console.error('usage: node tools/probe-account-create.mjs <pinned-source-clone> <gotavern-root>');
    process.exit(2);
}
if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim() !== PINNED_COMMIT) {
    throw new Error(`upstream checkout is not pinned at ${PINNED_COMMIT}`);
}

const runtimeRoot = mkdtempSync(path.join(os.tmpdir(), 'gotavern-account-create-oracle-'));
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
        || !path.basename(resolved).startsWith('gotavern-account-create-oracle-')) {
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
        // Keep plain text response bodies.
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

function directorySnapshot(root) {
    const directories = [];
    const files = [];
    function visit(current, relative = '') {
        for (const name of readdirSync(current).sort()) {
            const absolute = path.join(current, name);
            const childRelative = relative ? `${relative}/${name}` : name;
            const info = statSync(absolute);
            if (info.isDirectory()) {
                directories.push(childRelative);
                visit(absolute, childRelative);
            } else if (info.isFile()) {
                const bytes = readFileSync(absolute);
                files.push({ path: childRelative, sha256: sha256(bytes), bytes: bytes.length });
            }
        }
    }
    visit(root);
    return { directories, files };
}

function optionalDirectorySnapshot(root) {
    return existsSync(root) ? directorySnapshot(root) : { directories: [], files: [] };
}

function fileSummary(file) {
    if (!existsSync(file)) return null;
    const bytes = readFileSync(file);
    return { sha256: sha256(bytes), bytes: bytes.length };
}

try {
    mkdirSync(path.join(dataRoot, '_storage'), { recursive: true });
    writeFileSync(path.join(dataRoot, 'cookie-secret.txt'), COOKIE_SECRET);
    writeFileSync(configPath, 'enableUserAccounts: true\nskipContentCheck: true\n');
    seedUser('user:default-user', { handle: 'default-user', name: 'Admin', created: 1700000000000, password: '', admin: true, enabled: true, salt: '' });
    seedUser('user:creme-brulee', { handle: 'creme-brulee', name: 'Existing', created: 1700000000001, password: '', admin: false, enabled: true, salt: '' });

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
    const login = await post('login', csrfCookie, { handle: 'default-user' });
    if (login.response.status !== 200) throw new Error(`could not login admin: ${login.response.status} ${JSON.stringify(login.body)}\n${logs.join('').slice(-10000)}`);
    const adminCookie = cookieHeader(cookiesFrom(login.response));

    const slugifyInputs = [
        { name: 'latin', value: '  Crème brûlée / São Paulo  ' },
        { name: 'ligatures', value: 'Æther & Œuvre — Straße' },
        { name: 'latinExtended', value: 'Łódź Ĳsselmeer ſoft' },
        { name: 'combining', value: 'Cafe\u0301 & I\u0307stanbul' },
        { name: 'nonLatin', value: '東京' },
        { name: 'number', value: 42 },
        { name: 'numberScientific', value: 1e21 },
        { name: 'numberSmall', value: 1e-7 },
        { name: 'numberBoundary', value: 1e-6 },
        { name: 'array', value: ['Foo', 'Bar'] },
        { name: 'nestedArray', value: [1, null, [], {}] },
        { name: 'object', value: {} },
        { name: 'missing', value: null },
    ];
    const latinSweepCharacters = [];
    for (let codePoint = 0x00c0; codePoint <= 0x017f; codePoint++) {
        if (codePoint >= 0x00c0 && codePoint <= 0x00d6
            || codePoint >= 0x00d8 && codePoint <= 0x00f6
            || codePoint >= 0x00f8 && codePoint <= 0x00ff
            || codePoint >= 0x0100 && codePoint <= 0x017f) {
            latinSweepCharacters.push(`A${String.fromCodePoint(codePoint)}B`);
        }
    }
    const combiningSweepCharacters = [];
    for (let codePoint = 0x0300; codePoint <= 0x036f; codePoint++) combiningSweepCharacters.push(`A${String.fromCodePoint(codePoint)}B`);
    for (let codePoint = 0xfe20; codePoint <= 0xfe2f; codePoint++) combiningSweepCharacters.push(`A${String.fromCodePoint(codePoint)}B`);
    for (let codePoint = 0x20d0; codePoint <= 0x20ff; codePoint++) combiningSweepCharacters.push(`A${String.fromCodePoint(codePoint)}B`);
    slugifyInputs.push({ name: 'latinSweep', value: latinSweepCharacters.join(' | ') });
    slugifyInputs.push({ name: 'combiningSweep', value: combiningSweepCharacters.join(' | ') });
    const slugify = {};
    for (const item of slugifyInputs) slugify[item.name] = capture(await post('slugify', adminCookie, { text: item.value }));
    const responses = {
        nonAdminSlugify: capture(await post('slugify', csrfCookie, { text: 'hello' })),
        missingCreate: capture(await post('create', adminCookie, {})),
        missingName: capture(await post('create', adminCookie, { handle: 'new-user' })),
        missingHandle: capture(await post('create', adminCookie, { name: 'New User' })),
        invalidHandle: capture(await post('create', adminCookie, { handle: '東京', name: 'Tokyo' })),
        duplicateNormalizedHandle: capture(await post('create', adminCookie, { handle: '  Crème brûlée  ', name: 'Duplicate' })),
        createPasswordAdmin: capture(await post('create', adminCookie, {
            handle: '  Élodie / Rowan ', name: 'Élodie & Rowan', password: PASSWORD, admin: 'yes',
        })),
        createNoPassword: capture(await post('create', adminCookie, { handle: ['Guest', 'One'], name: 'Guest One' })),
    };
    await stopServer();

    const requireFromPinned = createRequire(path.join(sourceRoot, 'package.json'));
    const storage = requireFromPinned('node-persist');
    await storage.init({ dir: path.join(dataRoot, '_storage'), ttl: false, expiredInterval: 0, writeQueue: false });
    const users = {};
    for (const handle of ['elodie-rowan', 'guest-one']) users[handle] = await storage.getItem(`user:${handle}`);
    const allHandles = (await storage.keys(record => record.key.startsWith('user:')))
        .map(key => key.slice('user:'.length)).sort();
    const passwordValid = scryptSync(PASSWORD.normalize('NFC'), users['elodie-rowan'].salt, 64).toString('base64') === users['elodie-rowan'].password;
    const userDirs = {};
    for (const handle of Object.keys(users)) userDirs[handle] = directorySnapshot(path.join(dataRoot, handle));
    const storageRecords = {};
    for (const handle of Object.keys(users)) {
        const key = `user:${handle}`;
        const file = path.join(dataRoot, '_storage', sha256(key));
        const record = JSON.parse(readFileSync(file, 'utf8'));
        storageRecords[handle] = { keys: Object.keys(record), key: record.key, ttlPresent: Object.hasOwn(record, 'ttl') };
    }
    const fixture = {
        schemaVersion: 1,
        baseline: { version: PINNED_VERSION, commit: PINNED_COMMIT },
        probe: 'pinned admin account creation, lodash slugification, user directory creation, and settings seeding',
        inputs: { cookieSecret: COOKIE_SECRET, password: PASSWORD },
        slugify,
        responses,
        persisted: {
            createdHandles: Object.keys(users),
            allHandles,
            passwordAdmin: {
                name: users['elodie-rowan'].name,
                admin: users['elodie-rowan'].admin,
                enabled: users['elodie-rowan'].enabled,
                passwordPresent: Boolean(users['elodie-rowan'].password),
                saltBytes: Buffer.from(users['elodie-rowan'].salt, 'base64').byteLength,
                passwordValid,
                keys: Object.keys(users['elodie-rowan']),
            },
            noPassword: {
                name: users['guest-one'].name,
                admin: users['guest-one'].admin,
                enabled: users['guest-one'].enabled,
                password: users['guest-one'].password,
                saltBytes: Buffer.from(users['guest-one'].salt, 'base64').byteLength,
                keys: Object.keys(users['guest-one']),
            },
            storageRecords,
            userDirectories: userDirs,
            globalContent: {
                contentLog: fileSummary(path.join(dataRoot, 'content.log')),
                errors: optionalDirectorySnapshot(path.join(dataRoot, '_errors')),
                stylesheets: optionalDirectorySnapshot(path.join(dataRoot, '_css')),
            },
        },
    };
    if (!passwordValid || fixture.persisted.passwordAdmin.saltBytes !== 16 || fixture.persisted.noPassword.password !== '') {
        throw new Error(`pinned create persistence mismatch: ${JSON.stringify(fixture.persisted)}`);
    }
    const outputFile = path.join(repositoryRoot, 'tests', 'oracle', 'sillytavern-1.19.0-account-create.json');
    mkdirSync(path.dirname(outputFile), { recursive: true });
    writeFileSync(outputFile, `${JSON.stringify(fixture, null, 2)}\n`);
    console.log(`Wrote ${path.relative(repositoryRoot, outputFile)} from pinned account create and slugify routes`);
} finally {
    await stopServer();
    safeCleanup();
}
