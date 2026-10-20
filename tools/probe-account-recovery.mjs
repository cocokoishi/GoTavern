#!/usr/bin/env node
// Capture pinned account recovery responses, recovery-code lifecycle, session
// version updates, and the node-persist record written by the recovery route.

import { execFileSync, spawn } from 'node:child_process';
import { createHash, scryptSync } from 'node:crypto';
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
// @gotavern-oracle: fixture=sillytavern-1.19.0-account-recovery.json label="account recovery"
const COOKIE_SECRET = 'gotavern-pinned-account-recovery-probe-secret';
const NEW_PASSWORD = 'pa\u0301ssword';
const sourceRoot = path.resolve(process.argv[2] ?? '');
const repositoryRoot = path.resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3]) {
    console.error('usage: node tools/probe-account-recovery.mjs <pinned-source-clone> <gotavern-root>');
    process.exit(2);
}
if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim() !== PINNED_COMMIT) {
    throw new Error(`upstream checkout is not pinned at ${PINNED_COMMIT}`);
}

const runtimeRoot = mkdtempSync(path.join(os.tmpdir(), 'gotavern-account-recovery-oracle-'));
const dataRoot = path.join(runtimeRoot, 'data');
const configPath = path.join(runtimeRoot, 'config.yaml');
const logs = [];
let child;

function sha256(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
}

function safeCleanup() {
    const resolved = path.resolve(runtimeRoot);
    const parent = path.resolve(os.tmpdir());
    if (path.dirname(resolved).toLowerCase() !== parent.toLowerCase()
        || !path.basename(resolved).startsWith('gotavern-account-recovery-oracle-')) {
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
    const bytes = new Uint8Array(await response.arrayBuffer());
    let parsedBody = Buffer.from(bytes).toString('utf8');
    try {
        parsedBody = parsedBody ? JSON.parse(parsedBody) : null;
    } catch {
        // Retain non-JSON bodies as text.
    }
    return { response, bytes, body: parsedBody };
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

function normalizeSetCookie(raw) {
    const [nameValue, ...attributes] = raw.split('; ');
    const separator = nameValue.indexOf('=');
    const name = nameValue.slice(0, separator).replace(/^session-[0-9a-f]{8}/, 'session-<host-hash>');
    const value = name.endsWith('.sig') ? '<signature>' : '<base64-session-json>';
    const normalizedAttributes = attributes.map(attribute => /^expires=/i.test(attribute) ? 'expires=<timestamp>' : attribute);
    return `${name}=${value}; ${normalizedAttributes.join('; ')}`;
}

function cookieHeader(cookies) {
    return cookies.map(cookie => cookie.split(';', 1)[0]).join('; ');
}

function sessionPayload(cookies) {
    const cookie = cookies.find(raw => raw.split('=', 1)[0].startsWith('session-') && !raw.split('=', 1)[0].endsWith('.sig'));
    if (!cookie) throw new Error(`session cookie missing from ${JSON.stringify(cookies)}`);
    return JSON.parse(Buffer.from(cookie.slice(cookie.indexOf('=') + 1).split(';', 1)[0], 'base64').toString('utf8'));
}

function capture(result) {
    return { status: result.response.status, headers: stableHeaders(result.response), body: result.body };
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

async function waitForPinnedServer(origin) {
    const deadline = Date.now() + 180000;
    let lastRequestError;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error(`pinned server exited before becoming ready:\n${logs.join('').slice(-12000)}`);
        try {
            const result = await request(`${origin}/login?noauto=1`);
            if (result.response.status === 200 && result.response.headers.get('content-type')?.includes('text/html')) return;
            lastRequestError = new Error(`login page returned ${result.response.status}`);
        } catch (error) {
            lastRequestError = error;
        }
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error(`pinned account server at ${origin} did not become ready: ${lastRequestError?.stack ?? 'none'}\n${logs.join('').slice(-12000)}`);
}

function seedUser(key, value) {
    const storagePath = path.join(dataRoot, '_storage', sha256(key));
    writeFileSync(storagePath, JSON.stringify({ key, value }));
}

try {
    mkdirSync(path.join(dataRoot, '_storage'), { recursive: true });
    writeFileSync(path.join(dataRoot, 'cookie-secret.txt'), COOKIE_SECRET);
    writeFileSync(configPath, 'enableUserAccounts: true\nskipContentCheck: true\nrateLimiting:\n  accountsRecoverMaxAttempts: 4\n');
    seedUser('user:default-user', {
        handle: 'default-user', name: 'Recovery User', created: 1700000000000,
        password: '', admin: true, enabled: true, salt: '',
        unknownField: { keep: ['recovery', 17, true] },
    });
    seedUser('user:disabled-user', {
        handle: 'disabled-user', name: 'Disabled User', created: 1700000000001,
        password: '', admin: false, enabled: false, salt: '',
    });
    seedUser('user:clear-user', {
        handle: 'clear-user', name: 'Clear Password User', created: 1700000000002,
        password: 'old-test-hash', admin: false, enabled: true, salt: 'old-test-salt',
        unknownField: { keep: ['clear', 19, true] },
    });

    const port = await choosePort();
    const origin = `http://127.0.0.1:${port}`;
    startPinnedServer(port);
    await waitForPinnedServer(origin);

    const csrf = await request(`${origin}/csrf-token`);
    const csrfCookies = cookiesFrom(csrf.response);
    const token = csrf.body.token;
    const csrfCookie = cookieHeader(csrfCookies);
    const requestHeaders = (cookies, body) => ({
        Cookie: cookies,
        'Content-Type': 'application/json',
        'X-CSRF-Token': token,
    });
    const post = (route, body, cookies = csrfCookie) => request(`${origin}/api/users/${route}`, 'POST', requestHeaders(cookies, body), JSON.stringify(body));

    const login = await post('login', { handle: 'default-user' });
    if (login.response.status !== 200) throw new Error(`could not establish recovery probe session: ${login.response.status} ${JSON.stringify(login.body)}\n${logs.join('').slice(-12000)}`);
    const loginCookies = cookiesFrom(login.response);
    let activeCookie = cookieHeader(loginCookies);
    writeFileSync(path.join(dataRoot, '_storage', 'unrelated-malformed-record'), '{');

    const missingStep1 = await post('recover-step1', {}, activeCookie);
    const unknownStep1 = await post('recover-step1', { handle: 'missing-user' }, activeCookie);
    const disabledStep1 = await post('recover-step1', { handle: 'disabled-user' }, activeCookie);
    const startedRecovery = await post('recover-step1', { handle: 'default-user' }, activeCookie);
    const strippedLogs = logs.join('').replace(/\u001b\[[0-9;]*m/g, '');
    const recoveryCode = strippedLogs.match(/password recovery code is: (\d{6})/)?.[1];
    if (!recoveryCode) throw new Error(`pinned server did not log the recovery code:\n${logs.join('').slice(-12000)}`);

    const missingStep2 = await post('recover-step2', { handle: 'default-user' }, activeCookie);
    const unknownStep2 = await post('recover-step2', { handle: 'missing-user', code: recoveryCode }, activeCookie);
    const disabledStep2 = await post('recover-step2', { handle: 'disabled-user', code: recoveryCode }, activeCookie);
    const incorrectCode = recoveryCode === '000000' ? '000001' : '000000';
    const wrongCode = await post('recover-step2', { handle: 'default-user', code: incorrectCode }, activeCookie);
    const successfulRecovery = await post('recover-step2', { handle: 'default-user', code: recoveryCode, newPassword: NEW_PASSWORD }, activeCookie);
    const recoveryCookies = cookiesFrom(successfulRecovery.response);
    if (recoveryCookies.length) activeCookie = cookieHeader(recoveryCookies);
    const recoveredSession = recoveryCookies.length ? sessionPayload(recoveryCookies) : {};

    const wrongPasswordLogin = await post('login', { handle: 'default-user', password: 'incorrect-password' }, activeCookie);
    const passwordLogin = await post('login', { handle: 'default-user', password: NEW_PASSWORD }, activeCookie);
    const startedClearRecovery = await post('recover-step1', { handle: 'clear-user' }, activeCookie);
    const recoveryCodes = [...logs.join('').replace(/\u001b\[[0-9;]*m/g, '').matchAll(/password recovery code is: (\d{6})/g)].map(match => match[1]);
    const clearUserCode = recoveryCodes.at(-1);
    if (!clearUserCode) throw new Error(`pinned server did not log the clear-user recovery code:\n${logs.join('').slice(-12000)}`);
    const clearedPasswordRecovery = await post('recover-step2', { handle: 'clear-user', code: clearUserCode }, activeCookie);
    const clearUserLogin = await post('login', { handle: 'clear-user' }, activeCookie);
    const recoveryReplay = await post('recover-step2', { handle: 'default-user', code: recoveryCode }, activeCookie);
    const rateLimitedAttempts = [];
    rateLimitedAttempts.push(recoveryReplay);
    for (let index = 1; index < 5; index++) {
        rateLimitedAttempts.push(await post('recover-step2', { handle: 'default-user', code: incorrectCode }, activeCookie));
    }
    const rateLimited = capture(rateLimitedAttempts.at(-1));
    if (rateLimited.headers['retry-after']) rateLimited.headers['retry-after'] = '<positive-seconds>';

    await stopServer();
    const requireFromPinned = createRequire(path.join(sourceRoot, 'package.json'));
    const storage = requireFromPinned('node-persist');
    await storage.init({ dir: path.join(dataRoot, '_storage'), ttl: false, expiredInterval: 0, writeQueue: false });
    const recoveredUser = await storage.getItem('user:default-user');
    const clearedUser = await storage.getItem('user:clear-user');
    const record = JSON.parse(readFileSync(path.join(dataRoot, '_storage', sha256('user:default-user')), 'utf8'));
    const clearedRecord = JSON.parse(readFileSync(path.join(dataRoot, '_storage', sha256('user:clear-user')), 'utf8'));
    const expectedHash = scryptSync(NEW_PASSWORD.normalize(), recoveredUser.salt, 64).toString('base64');
    const expectedVersion = createHash('shake256', { outputLength: 8 })
        .update(JSON.stringify([recoveredUser.handle, recoveredUser.password, recoveredUser.salt]))
        .digest('hex');

    const fixture = {
        schemaVersion: 1,
        baseline: { version: PINNED_VERSION, commit: PINNED_COMMIT },
        probe: 'pinned account recovery, rate limiter, active session update, and node-persist password mutation',
        inputs: { cookieSecret: COOKIE_SECRET, recoveryPoints: 4, newPassword: NEW_PASSWORD, unrelatedMalformedRecordPresent: true },
        missingStep1: capture(missingStep1),
        unknownStep1: capture(unknownStep1),
        disabledStep1: capture(disabledStep1),
        startedRecovery: { ...capture(startedRecovery), recoveryCodeDigits: recoveryCode.length },
        missingStep2: capture(missingStep2),
        unknownStep2: capture(unknownStep2),
        disabledStep2: capture(disabledStep2),
        wrongCode: capture(wrongCode),
        successfulRecovery: {
            status: successfulRecovery.response.status,
            headers: stableHeaders(successfulRecovery.response),
            setCookie: recoveryCookies.map(normalizeSetCookie),
            setCookieCount: recoveryCookies.length,
            sessionHandle: recoveredSession.handle ?? null,
            sessionVersionMatchesStoredAccount: recoveredSession.version === expectedVersion,
            sessionCSRFTokenBytes: Buffer.byteLength(recoveredSession.csrfToken ?? ''),
        },
        wrongPasswordLogin: capture(wrongPasswordLogin),
        passwordLogin: capture(passwordLogin),
        startedClearRecovery: { ...capture(startedClearRecovery), recoveryCodeDigits: clearUserCode.length },
        clearedPasswordRecovery: capture(clearedPasswordRecovery),
        clearUserLogin: capture(clearUserLogin),
        recoveryReplay: capture(recoveryReplay),
        rateLimitedAttempts: rateLimitedAttempts.map(result => result.response.status),
        rateLimited,
        persistedUser: {
            keys: Object.keys(recoveredUser),
            handle: recoveredUser.handle,
            name: recoveredUser.name,
            created: recoveredUser.created,
            enabled: recoveredUser.enabled,
            admin: recoveredUser.admin,
            passwordVerifies: recoveredUser.password === expectedHash,
            passwordHashBytes: Buffer.from(recoveredUser.password, 'base64').byteLength,
            saltBytes: Buffer.from(recoveredUser.salt, 'base64').byteLength,
            unknownField: recoveredUser.unknownField,
            nodePersistKeys: Object.keys(record),
            ttlPresent: Object.hasOwn(record, 'ttl'),
        },
        persistedClearedUser: {
            handle: clearedUser.handle,
            passwordCleared: clearedUser.password === '' && clearedUser.salt === '',
            unknownField: clearedUser.unknownField,
            nodePersistKeys: Object.keys(clearedRecord),
            ttlPresent: Object.hasOwn(clearedRecord, 'ttl'),
        },
        log: { recoveryCodePrinted: true, recoveryCodesPrinted: recoveryCodes.length, recoveryCodeDigits: recoveryCode.length },
    };
    const outputDirectory = path.join(repositoryRoot, 'tests', 'oracle');
    mkdirSync(outputDirectory, { recursive: true });
    const outputFile = path.join(outputDirectory, 'sillytavern-1.19.0-account-recovery.json');
    writeFileSync(outputFile, `${JSON.stringify(fixture, null, 2)}\n`);
    console.log(`Wrote ${path.relative(repositoryRoot, outputFile)} from pinned account recovery routes`);
} finally {
    await stopServer();
    safeCleanup();
}
