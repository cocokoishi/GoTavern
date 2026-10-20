#!/usr/bin/env node
// Capture pinned authenticated account profile and logout behavior in both
// accounts-enabled and default-user modes.

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const PINNED_COMMIT = '06bde939fb1e9c4c8d8641d810f0a916b5bce127';
const PINNED_VERSION = '1.19.0';
// @gotavern-oracle: this declaration is read by tools/build-generated-lib.mjs,
// which auto-discovers probes so that adding one needs no edit there.
// @gotavern-oracle: fixture=sillytavern-1.19.0-account-private.json label="account-private"
const COOKIE_SECRET = 'gotavern-pinned-account-private-probe-secret';
const AVATAR = 'data:image/png;base64,AA==';
const sourceRoot = path.resolve(process.argv[2] ?? '');
const repositoryRoot = path.resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3]) {
    console.error('usage: node tools/probe-account-private.mjs <pinned-source-clone> <gotavern-root>');
    process.exit(2);
}
if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim() !== PINNED_COMMIT) {
    throw new Error(`upstream checkout is not pinned at ${PINNED_COMMIT}`);
}

const runtimeRoot = mkdtempSync(path.join(os.tmpdir(), 'gotavern-account-private-oracle-'));
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
        || !path.basename(resolved).startsWith('gotavern-account-private-oracle-')) {
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
    const text = Buffer.from(bytes).toString('utf8');
    let parsedBody = text;
    try {
        parsedBody = text ? JSON.parse(text) : null;
    } catch {
        // Keep non-JSON response bodies as text.
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

function cookieHeader(cookies) {
    return cookies.map(cookie => cookie.split(';', 1)[0]).join('; ');
}

function normalizeSetCookie(raw) {
    const [nameValue, ...attributes] = raw.split('; ');
    const separator = nameValue.indexOf('=');
    const name = nameValue.slice(0, separator).replace(/^session-[0-9a-f]{8}/, 'session-<host-hash>');
    const rawValue = nameValue.slice(separator + 1);
    const value = name.endsWith('.sig') ? '<signature>' : (rawValue ? '<base64-session-json>' : '<empty>');
    const normalizedAttributes = attributes.map(attribute => /^expires=/i.test(attribute) ? 'expires=<timestamp>' : attribute);
    return `${name}=${value}; ${normalizedAttributes.join('; ')}`;
}

function capture(result) {
    return { status: result.response.status, headers: stableHeaders(result.response), body: result.body };
}

function startPinnedServer(port, accountsEnabled) {
    writeFileSync(configPath, `enableUserAccounts: ${accountsEnabled}\nskipContentCheck: true\n`);
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

async function waitForServer(origin, accountsEnabled) {
    const deadline = Date.now() + 180000;
    let lastError;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error(`pinned server exited before becoming ready:\n${logs.join('').slice(-10000)}`);
        try {
            const result = await request(`${origin}/login?noauto=1`);
            if (accountsEnabled && result.response.status === 200 && result.response.headers.get('content-type')?.includes('text/html')) return;
            if (!accountsEnabled && result.response.status === 302 && result.response.headers.get('location') === '/') return;
            lastError = new Error(`login page returned ${result.response.status}`);
        } catch (error) {
            lastError = error;
        }
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error(`pinned server at ${origin} did not become ready: ${lastError?.stack ?? 'none'}\n${logs.join('').slice(-10000)}`);
}

async function startAndWait(accountsEnabled) {
    const port = await choosePort();
    const origin = `http://127.0.0.1:${port}`;
    startPinnedServer(port, accountsEnabled);
    await waitForServer(origin, accountsEnabled);
    return origin;
}

async function getCSRF(origin) {
    const result = await request(`${origin}/csrf-token`);
    const cookies = cookiesFrom(result.response);
    return { result, cookies, token: result.body.token, cookie: cookieHeader(cookies) };
}

async function post(origin, route, cookie, token, body = {}) {
    return request(`${origin}/api/users/${route}`, 'POST', {
        Cookie: cookie,
        'Content-Type': 'application/json',
        'X-CSRF-Token': token,
    }, JSON.stringify(body));
}

try {
    mkdirSync(path.join(dataRoot, '_storage'), { recursive: true });
    writeFileSync(path.join(dataRoot, 'cookie-secret.txt'), COOKIE_SECRET);
    const user = {
        handle: 'default-user', name: 'Profile User', created: 1700000000000,
        password: '', admin: true, enabled: true, salt: '',
    };
    const userKey = 'user:default-user';
    const avatarKey = 'avatar:default-user';
    writeFileSync(path.join(dataRoot, '_storage', sha256(userKey)), JSON.stringify({ key: userKey, value: user }));
    writeFileSync(path.join(dataRoot, '_storage', sha256(avatarKey)), JSON.stringify({ key: avatarKey, value: AVATAR }));

    const enabledOrigin = await startAndWait(true);
    const csrf = await getCSRF(enabledOrigin);
    const anonymousMe = await request(`${enabledOrigin}/api/users/me`, 'GET', { Cookie: csrf.cookie });
    const anonymousLogout = await post(enabledOrigin, 'logout', csrf.cookie, csrf.token);
    const login = await post(enabledOrigin, 'login', csrf.cookie, csrf.token, { handle: user.handle });
    if (login.response.status !== 200) throw new Error(`account login failed: ${login.response.status} ${JSON.stringify(login.body)}\n${logs.join('').slice(-10000)}`);
    const loginCookies = cookiesFrom(login.response);
    const activeCookie = cookieHeader(loginCookies);
    const authenticatedMe = await request(`${enabledOrigin}/api/users/me`, 'GET', { Cookie: activeCookie });
    const logout = await post(enabledOrigin, 'logout', activeCookie, csrf.token);
    const loggedOutMe = await request(`${enabledOrigin}/api/users/me`);
    await stopServer();

    logs.length = 0;
    const disabledOrigin = await startAndWait(false);
    const disabledMe = await request(`${disabledOrigin}/api/users/me`);
    const disabledCSRF = await getCSRF(disabledOrigin);
    const disabledLogout = await post(disabledOrigin, 'logout', disabledCSRF.cookie, disabledCSRF.token);
    await stopServer();

    const disabledBody = { ...disabledMe.body };
    const disabledCreatedIsNumber = Number.isFinite(disabledBody.created);
    disabledBody.created = '<timestamp>';
    const disabledProfile = { ...capture(disabledMe), body: disabledBody };
    disabledProfile.headers.etag = '<weak-etag-derived-from-current-timestamp>';
    const fixture = {
        schemaVersion: 1,
        baseline: { version: PINNED_VERSION, commit: PINNED_COMMIT },
        probe: 'pinned authenticated account profile and logout, with accounts enabled and disabled',
        inputs: { cookieSecret: COOKIE_SECRET, avatar: AVATAR },
        anonymousMe: capture(anonymousMe),
        anonymousLogout: capture(anonymousLogout),
        authenticatedMe: capture(authenticatedMe),
        logout: {
            status: logout.response.status,
            headers: stableHeaders(logout.response),
            setCookie: cookiesFrom(logout.response).map(normalizeSetCookie),
            setCookieCount: cookiesFrom(logout.response).length,
            body: logout.body,
        },
        loggedOutMe: capture(loggedOutMe),
        disabledMe: disabledProfile,
        disabledCreatedIsNumber,
        disabledLogout: {
            status: disabledLogout.response.status,
            headers: stableHeaders(disabledLogout.response),
            setCookie: cookiesFrom(disabledLogout.response).map(normalizeSetCookie),
            setCookieCount: cookiesFrom(disabledLogout.response).length,
            body: disabledLogout.body,
        },
    };
    if (fixture.authenticatedMe.body.handle !== user.handle || fixture.authenticatedMe.body.avatar !== AVATAR) {
        throw new Error(`pinned /api/users/me returned unexpected profile: ${JSON.stringify(fixture.authenticatedMe.body)}`);
    }
    if (!disabledCreatedIsNumber) throw new Error(`disabled-account default user has a non-numeric created field: ${JSON.stringify(disabledMe.body)}`);

    const outputDirectory = path.join(repositoryRoot, 'tests', 'oracle');
    mkdirSync(outputDirectory, { recursive: true });
    const outputFile = path.join(outputDirectory, 'sillytavern-1.19.0-account-private.json');
    writeFileSync(outputFile, `${JSON.stringify(fixture, null, 2)}\n`);
    console.log(`Wrote ${path.relative(repositoryRoot, outputFile)} from pinned account profile and logout routes`);
} finally {
    await stopServer();
    safeCleanup();
}
