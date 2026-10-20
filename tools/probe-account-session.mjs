#!/usr/bin/env node
// Capture account-enabled login, user-list, and session middleware behavior.

import { execFileSync, spawn } from 'node:child_process';
import { createHash, scryptSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const PINNED_COMMIT = '06bde939fb1e9c4c8d8641d810f0a916b5bce127';
const PINNED_VERSION = '1.19.0';
// @gotavern-oracle: this declaration is read by tools/build-generated-lib.mjs,
// which auto-discovers probes so that adding one needs no edit there.
// @gotavern-oracle: fixture=sillytavern-1.19.0-account-session.json label="account session"
const COOKIE_SECRET = 'gotavern-pinned-account-session-probe-secret';
// Pinned src/util.js:149 reports /version's gitRevision with
// `git rev-parse --short HEAD`, whose abbreviation length is derived from the
// checkout's object database (git's core.abbrev=auto): a full clone yields 9
// characters while CI's fetch-depth 1 checkout yields 7. That changes the
// recorded /version body, content-length and ETag per host. Forcing the length
// makes the pinned server report the same revision everywhere, so the
// observation is host independent without rewriting any recorded value.
const PINNED_GIT_ENVIRONMENT = {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.abbrev',
    GIT_CONFIG_VALUE_0: '9',
};
const sourceRoot = path.resolve(process.argv[2] ?? '');
const outputRoot = path.resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3]) {
    console.error('usage: node tools/probe-account-session.mjs <pinned-source-clone> <gotavern-root>');
    process.exit(2);
}
if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim() !== PINNED_COMMIT) {
    throw new Error(`upstream checkout is not pinned at ${PINNED_COMMIT}`);
}

const runtimeRoot = mkdtempSync(path.join(os.tmpdir(), 'gotavern-account-session-oracle-'));
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
        || !path.basename(resolved).startsWith('gotavern-account-session-oracle-')) {
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

async function getResponse(url, method = 'GET', headers = {}, body) {
    const response = await fetch(url, { method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(10000) });
    const bytes = new Uint8Array(await response.arrayBuffer());
    return { response, bytes };
}

function startPinnedServer(port) {
    child = spawn(process.execPath, [
        'server.js', '--configPath', configPath, '--dataRoot', dataRoot,
        '--listenAddressIPv4', '127.0.0.1', '--enableIPv4', 'true', '--enableIPv6', 'false',
        '--listen', 'false', '--port', String(port), '--browserLaunchEnabled', 'false', '--heartbeatInterval', '0',
    ], { cwd: sourceRoot, env: { ...process.env, NODE_ENV: 'test', ...PINNED_GIT_ENVIRONMENT }, stdio: ['ignore', 'pipe', 'pipe'] });
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
            const { response } = await getResponse(`${origin}/login?noauto=1`);
            if (response.status === 200 && response.headers.get('content-type')?.includes('text/html')) return;
            lastRequestError = new Error(`login page returned ${response.status}`);
        } catch (error) {
            lastRequestError = error;
        }
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error(`pinned account server at ${origin} did not become ready: ${lastRequestError?.stack ?? 'none'}\n${logs.join('').slice(-12000)}`);
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

function sessionPayload(cookies) {
    const cookie = cookies.find(raw => raw.split('=', 1)[0].startsWith('session-') && !raw.split('=', 1)[0].endsWith('.sig'));
    if (!cookie) throw new Error(`session cookie missing from ${JSON.stringify(cookies)}`);
    return JSON.parse(Buffer.from(cookie.slice(cookie.indexOf('=') + 1).split(';', 1)[0], 'base64').toString('utf8'));
}

try {
    mkdirSync(dataRoot, { recursive: true });
    writeFileSync(path.join(dataRoot, 'cookie-secret.txt'), COOKIE_SECRET);
    writeFileSync(configPath, 'enableUserAccounts: true\nskipContentCheck: true\n');
    const port = await choosePort();
    const origin = `http://127.0.0.1:${port}`;
    startPinnedServer(port);
    await waitForPinnedServer(origin);

    const anonymousRoot = await getResponse(`${origin}/`);
    const autoLogin = await getResponse(`${origin}/login`);
    const autoLoginCookies = cookiesFrom(autoLogin.response);
    const autoLoginPayload = sessionPayload(autoLoginCookies);
    const loginPage = await getResponse(`${origin}/login?noauto=1`, 'GET', { 'Accept-Encoding': 'identity' });
    const unauthenticatedVersion = await getResponse(`${origin}/version`);
    const csrf = await getResponse(`${origin}/csrf-token`);
    const token = JSON.parse(Buffer.from(csrf.bytes).toString('utf8')).token;
    const csrfCookies = cookiesFrom(csrf.response);
    const anonymousCookie = csrfCookies.map(cookie => cookie.split(';', 1)[0]).join('; ');
    const requestHeaders = {
        Cookie: anonymousCookie,
        'Content-Type': 'application/json',
        'X-CSRF-Token': token,
    };
    const userList = await getResponse(`${origin}/api/users/list`, 'POST', requestHeaders, '{}');
    const listBody = JSON.parse(Buffer.from(userList.bytes).toString('utf8'));
    for (const user of listBody) if (Number.isFinite(user.created)) user.created = '<timestamp>';
    const missingLogin = await getResponse(`${origin}/api/users/login`, 'POST', requestHeaders, '{}');
    const unknownLogin = await getResponse(`${origin}/api/users/login`, 'POST', requestHeaders, JSON.stringify({ handle: 'missing-user' }));
    const successfulLogin = await getResponse(`${origin}/api/users/login`, 'POST', requestHeaders, JSON.stringify({ handle: 'default-user' }));
    const successfulCookies = cookiesFrom(successfulLogin.response);
    const successfulPayload = sessionPayload(successfulCookies);
    if (typeof successfulPayload.csrfToken === 'string') successfulPayload.csrfToken = '<64-lowercase-hex>';
    const authenticatedCookie = successfulCookies.map(cookie => cookie.split(';', 1)[0]).join('; ');
    const authenticatedHeaders = { Cookie: authenticatedCookie, 'X-CSRF-Token': token };
    const authenticatedVersion = await getResponse(`${origin}/version`, 'GET', authenticatedHeaders);
    const authenticatedPing = await getResponse(`${origin}/api/ping`, 'POST', authenticatedHeaders);
    const passwordVector = {
        source: 'src/users.js:getPasswordHash uses crypto.scryptSync(password.normalize(), salt, 64)',
        password: 'pa\u0301ssword',
        salt: 'pinned-test-salt',
        hash: scryptSync('pa\u0301ssword'.normalize(), 'pinned-test-salt', 64).toString('base64'),
    };
    await stopServer();

    const accountRecordPath = path.join(dataRoot, '_storage', createHash('sha256').update('user:default-user').digest('hex'));
    const accountRecord = JSON.parse(readFileSync(accountRecordPath, 'utf8'));
    accountRecord.value.password = scryptSync('changed-password', 'changed-salt', 64).toString('base64');
    accountRecord.value.salt = 'changed-salt';
    writeFileSync(accountRecordPath, `${JSON.stringify(accountRecord)}\n`);
    const stalePort = await choosePort();
    const staleOrigin = `http://127.0.0.1:${stalePort}`;
    startPinnedServer(stalePort);
    await waitForPinnedServer(staleOrigin);
    const invalidatedSession = await getResponse(`${staleOrigin}/version`, 'GET', {
        Cookie: successfulCookies.map(cookie => cookie.split(';', 1)[0]).join('; '),
    });
    const invalidatedCookies = cookiesFrom(invalidatedSession.response);
    await stopServer();

    const csrfHeaders = stableHeaders(csrf.response);
    csrfHeaders.etag = '<weak-etag-derived-from-random-token>';
    const listHeaders = stableHeaders(userList.response);
    listHeaders.etag = '<weak-etag-derived-from-created-timestamp>';
    const fixture = {
        schemaVersion: 1,
        baseline: { version: PINNED_VERSION, commit: PINNED_COMMIT },
        probe: 'pinned accounts-enabled user-list, login, session identity, and authentication middleware',
        inputs: { cookieSecret: COOKIE_SECRET, enableUserAccounts: true },
        passwordHashVector: passwordVector,
        anonymousRoot: {
            status: anonymousRoot.response.status,
            location: anonymousRoot.response.headers.get('location'),
            contentType: anonymousRoot.response.headers.get('content-type'),
            body: Buffer.from(anonymousRoot.bytes).toString('utf8'),
        },
        autoLogin: {
            status: autoLogin.response.status,
            location: autoLogin.response.headers.get('location'),
            headers: stableHeaders(autoLogin.response),
            setCookie: autoLoginCookies.map(normalizeSetCookie),
            setCookieCount: autoLoginCookies.length,
            sessionPayload: autoLoginPayload,
        },
        loginPage: {
            status: loginPage.response.status,
            contentType: loginPage.response.headers.get('content-type'),
            headers: Object.fromEntries(['accept-ranges', 'cache-control', 'content-length', 'content-type']
                .map(name => [name, loginPage.response.headers.get(name)])),
            bytes: loginPage.bytes.byteLength,
            sha256: sha256(loginPage.bytes),
        },
        unauthenticatedVersion: {
            status: unauthenticatedVersion.response.status,
            contentType: unauthenticatedVersion.response.headers.get('content-type'),
            bytes: unauthenticatedVersion.bytes.byteLength,
            body: Buffer.from(unauthenticatedVersion.bytes).toString('utf8'),
        },
        csrf: {
            status: csrf.response.status,
            headers: csrfHeaders,
            setCookie: csrfCookies.map(normalizeSetCookie),
            setCookieCount: csrfCookies.length,
            tokenBytes: Buffer.byteLength(token),
        },
        userList: {
            status: userList.response.status,
            headers: listHeaders,
            body: listBody,
            bytes: userList.bytes.byteLength,
        },
        missingLogin: {
            status: missingLogin.response.status,
            headers: stableHeaders(missingLogin.response),
            body: JSON.parse(Buffer.from(missingLogin.bytes).toString('utf8')),
            setCookieCount: cookiesFrom(missingLogin.response).length,
        },
        unknownLogin: {
            status: unknownLogin.response.status,
            headers: stableHeaders(unknownLogin.response),
            body: JSON.parse(Buffer.from(unknownLogin.bytes).toString('utf8')),
            setCookieCount: cookiesFrom(unknownLogin.response).length,
        },
        successfulLogin: {
            status: successfulLogin.response.status,
            headers: stableHeaders(successfulLogin.response),
            body: JSON.parse(Buffer.from(successfulLogin.bytes).toString('utf8')),
            setCookie: successfulCookies.map(normalizeSetCookie),
            setCookieCount: successfulCookies.length,
            sessionPayload: successfulPayload,
        },
        authenticatedVersion: {
            status: authenticatedVersion.response.status,
            contentType: authenticatedVersion.response.headers.get('content-type'),
            body: JSON.parse(Buffer.from(authenticatedVersion.bytes).toString('utf8')),
        },
        authenticatedPing: {
            status: authenticatedPing.response.status,
            headers: stableHeaders(authenticatedPing.response),
            bytes: authenticatedPing.bytes.byteLength,
        },
        invalidatedSession: {
            status: invalidatedSession.response.status,
            contentType: invalidatedSession.response.headers.get('content-type'),
            body: Buffer.from(invalidatedSession.bytes).toString('utf8'),
            setCookie: invalidatedCookies.map(normalizeSetCookie),
            setCookieCount: invalidatedCookies.length,
        },
    };
    const outputDirectory = path.join(outputRoot, 'tests', 'oracle');
    mkdirSync(outputDirectory, { recursive: true });
    const outputFile = path.join(outputDirectory, 'sillytavern-1.19.0-account-session.json');
    writeFileSync(outputFile, `${JSON.stringify(fixture, null, 2)}\n`);
    console.log(`Wrote ${path.relative(outputRoot, outputFile)} from the pinned account-enabled server`);
} finally {
    await stopServer();
    safeCleanup();
}
