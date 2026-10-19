#!/usr/bin/env node
// Capture the pinned server's cookie-session and CSRF request contract.

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import process from 'node:process';

const PINNED_COMMIT = '06bde939fb1e9c4c8d8641d810f0a916b5bce127';
const PINNED_VERSION = '1.19.0';
const COOKIE_SECRET = 'gotavern-pinned-csrf-session-probe-secret';
const sourceRoot = path.resolve(process.argv[2] ?? '');
const outputRoot = path.resolve(process.argv[3] ?? '');
const probeMode = process.argv[4] ?? 'enabled';
if (!process.argv[2] || !process.argv[3] || !['enabled', 'disabled'].includes(probeMode)) {
    console.error('usage: node tools/probe-csrf-session.mjs <pinned-source-clone> <gotavern-root> [enabled|disabled]');
    process.exit(2);
}

if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim() !== PINNED_COMMIT) {
    throw new Error(`upstream checkout is not pinned at ${PINNED_COMMIT}`);
}

const runtimeRoot = mkdtempSync(path.join(os.tmpdir(), 'gotavern-csrf-session-oracle-'));
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
        || !path.basename(resolved).startsWith('gotavern-csrf-session-oracle-')) {
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

async function getResponse(url, method = 'GET', headers = {}) {
    const response = await fetch(url, { method, headers, redirect: 'manual', signal: AbortSignal.timeout(10000) });
    const body = new Uint8Array(await response.arrayBuffer());
    return { response, body };
}

function stableHeaders(response) {
    return Object.fromEntries([...response.headers.entries()]
        .filter(([name]) => !['connection', 'date', 'keep-alive', 'set-cookie', 'x-response-time'].includes(name))
        .sort(([left], [right]) => left.localeCompare(right)));
}

function normalizeSetCookie(raw) {
    const [nameValue, ...attributes] = raw.split('; ');
    const separator = nameValue.indexOf('=');
    const name = nameValue.slice(0, separator);
    const value = nameValue.slice(separator + 1);
    const canonicalName = name.replace(/^session-[0-9a-f]{8}/, 'session-<host-hash>');
    const canonicalValue = name.endsWith('.sig') ? '<signature>' : '<base64-session-json>';
    const canonicalAttributes = attributes.map(attribute => /^expires=/i.test(attribute) ? 'expires=<timestamp>' : attribute);
    return `${canonicalName}=${canonicalValue}; ${canonicalAttributes.join('; ')}`;
}

function sessionFromCookies(cookies) {
    const session = cookies.find(cookie => cookie.split('=', 1)[0].startsWith('session-') && !cookie.split('=', 1)[0].endsWith('.sig'));
    if (!session) throw new Error(`session cookie missing from ${JSON.stringify(cookies)}`);
    const value = session.slice(session.indexOf('=') + 1);
    return JSON.parse(Buffer.from(value, 'base64').toString('utf8'));
}

function cookiesFrom(response) {
    if (typeof response.headers.getSetCookie !== 'function') throw new Error('Node fetch does not expose getSetCookie()');
    return response.headers.getSetCookie();
}

try {
    mkdirSync(dataRoot, { recursive: true });
    writeFileSync(path.join(dataRoot, 'cookie-secret.txt'), COOKIE_SECRET);
    writeFileSync(configPath, `skipContentCheck: true\n${probeMode === 'disabled' ? 'disableCsrfProtection: true\n' : ''}`);
    const port = await choosePort();
    const origin = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, [
        'server.js',
        '--configPath', configPath,
        '--dataRoot', dataRoot,
        '--listenAddressIPv4', '127.0.0.1',
        '--enableIPv4', 'true',
        '--enableIPv6', 'false',
        '--listen', 'false',
        '--port', String(port),
        '--browserLaunchEnabled', 'false',
        '--heartbeatInterval', '0',
    ], { cwd: sourceRoot, env: { ...process.env, NODE_ENV: 'test' }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => logs.push(chunk));
    child.stderr.on('data', chunk => logs.push(chunk));

    const deadline = Date.now() + 180000;
    let ready = false;
    let lastRequestError;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error(`pinned server exited before becoming ready:\n${logs.join('').slice(-12000)}`);
        try {
            const { response, body } = await getResponse(`${origin}/version`);
            if (response.status === 200) {
                const version = JSON.parse(Buffer.from(body).toString('utf8'));
                if (version.pkgVersion !== PINNED_VERSION || !String(version.agent).startsWith(`SillyTavern:${PINNED_VERSION}:`)) {
                    throw new Error(`unexpected /version payload: ${JSON.stringify(version)}`);
                }
                ready = true;
                break;
            }
        } catch (error) {
            if (error.message.startsWith('unexpected /version payload')) throw error;
            lastRequestError = error;
        }
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (!ready) throw new Error(`pinned server at ${origin} did not become ready within 180 seconds; last request error: ${lastRequestError?.stack ?? 'none'}\n${logs.join('').slice(-12000)}`);

    if (probeMode === 'disabled') {
        const tokenResult = await getResponse(`${origin}/csrf-token`);
        const ping = await getResponse(`${origin}/api/ping`, 'POST');
        await stopServer();
        const fixture = {
            schemaVersion: 1,
            baseline: { version: PINNED_VERSION, commit: PINNED_COMMIT },
            probe: 'pinned disableCsrfProtection route and request behavior',
            csrfToken: {
                status: tokenResult.response.status,
                contentType: tokenResult.response.headers.get('content-type'),
                headers: stableHeaders(tokenResult.response),
                body: JSON.parse(Buffer.from(tokenResult.body).toString('utf8')),
                setCookieCount: cookiesFrom(tokenResult.response).length,
            },
            pingWithoutToken: {
                status: ping.response.status,
                contentType: ping.response.headers.get('content-type'),
                headers: stableHeaders(ping.response),
                bytes: ping.body.byteLength,
                sha256: sha256(ping.body),
            },
        };
        const outputDirectory = path.join(outputRoot, 'tests', 'oracle');
        mkdirSync(outputDirectory, { recursive: true });
        const outputFile = path.join(outputDirectory, 'sillytavern-1.19.0-csrf-disabled.json');
        writeFileSync(outputFile, `${JSON.stringify(fixture, null, 2)}\n`);
        console.log(`Wrote ${path.relative(outputRoot, outputFile)} from the pinned Node server`);
    } else {
        const tokenResult = await getResponse(`${origin}/csrf-token`);
        const tokenPayload = JSON.parse(Buffer.from(tokenResult.body).toString('utf8'));
        const cookies = cookiesFrom(tokenResult.response);
        const cookieHeader = cookies.map(cookie => cookie.split(';', 1)[0]).join('; ');
        const repeatedTokenResult = await getResponse(`${origin}/csrf-token`, 'GET', { Cookie: cookieHeader });
        const repeatedTokenPayload = JSON.parse(Buffer.from(repeatedTokenResult.body).toString('utf8'));
        const validPing = await getResponse(`${origin}/api/ping`, 'POST', {
            Cookie: cookieHeader,
            'X-CSRF-Token': tokenPayload.token,
        });
        const invalidPing = await getResponse(`${origin}/api/ping`, 'POST', {
            Cookie: cookieHeader,
            'X-CSRF-Token': 'invalid-token',
        });

        const require = createRequire(pathToFileURL(path.join(sourceRoot, 'package.json')));
        const Keygrip = require('keygrip');
        const hostname = os.hostname() || 'localhost';
        const cookieName = `session-${createHash('sha256').update(hostname).digest('hex').slice(0, 8)}`;
        const keygripInput = 'session-probe=eyJjc3JmVG9rZW4iOiJwcm9iZSJ9';
        const keygripSignature = new Keygrip([COOKIE_SECRET]).sign(keygripInput);
        const sessionPayload = sessionFromCookies(cookies);
        const unknownFields = { futureField: { enabled: true, values: [1, 'two'] }, csrfToken: 'preserved-token' };
        const unknownSessionValue = Buffer.from(JSON.stringify(unknownFields)).toString('base64');
        const unknownSessionSignature = new Keygrip([COOKIE_SECRET]).sign(`${cookieName}=${unknownSessionValue}`);
        const extendedPing = await getResponse(`${origin}/api/ping?extend=1`, 'POST', {
            Cookie: `${cookieName}=${unknownSessionValue}; ${cookieName}.sig=${unknownSessionSignature}`,
            'X-CSRF-Token': unknownFields.csrfToken,
        });
        const extendedCookies = cookiesFrom(extendedPing.response);
        const extendedSessionPayload = sessionFromCookies(extendedCookies);

        const emptyTokenValue = Buffer.from(JSON.stringify({ csrfToken: '' })).toString('base64');
        const emptyTokenSignature = new Keygrip([COOKIE_SECRET]).sign(`${cookieName}=${emptyTokenValue}`);
        const emptyTokenCookie = `${cookieName}=${emptyTokenValue}; ${cookieName}.sig=${emptyTokenSignature}`;
        const emptyTokenResponse = await getResponse(`${origin}/csrf-token`, 'GET', { Cookie: emptyTokenCookie });
        const emptyTokenPing = await getResponse(`${origin}/api/ping`, 'POST', {
            Cookie: emptyTokenCookie,
            'X-CSRF-Token': '',
        });
        await stopServer();

        const csrfHeaders = stableHeaders(tokenResult.response);
        csrfHeaders.etag = '<weak-etag-derived-from-random-token>';
        const fixture = {
            schemaVersion: 1,
            baseline: { version: PINNED_VERSION, commit: PINNED_COMMIT },
            probe: 'pinned cookie-session signing, csrf-sync token persistence, and protected ping behavior',
            inputs: { cookieSecret: COOKIE_SECRET, sessionTimeout: -1 },
            cookieName: 'session-<first-8-hex-of-sha256(os.hostname())>',
            keygrip: { input: keygripInput, signature: keygripSignature, algorithm: 'HMAC-SHA1/base64url-no-padding' },
            csrfToken: {
                status: tokenResult.response.status,
                contentType: tokenResult.response.headers.get('content-type'),
                headers: csrfHeaders,
                body: { token: '<64-lowercase-hex>' },
                tokenBytes: typeof tokenPayload.token === 'string' ? Buffer.byteLength(tokenPayload.token) : null,
                sessionPayload: { ...sessionPayload, csrfToken: '<64-lowercase-hex>' },
                setCookie: cookies.map(normalizeSetCookie),
                setCookieCount: cookies.length,
            },
            repeatedToken: {
                status: repeatedTokenResult.response.status,
                contentType: repeatedTokenResult.response.headers.get('content-type'),
                tokenMatchesFirst: repeatedTokenPayload.token === tokenPayload.token,
                setCookieCount: cookiesFrom(repeatedTokenResult.response).length,
            },
            validPing: {
                status: validPing.response.status,
                contentType: validPing.response.headers.get('content-type'),
                headers: stableHeaders(validPing.response),
                bytes: validPing.body.byteLength,
                sha256: sha256(validPing.body),
            },
            invalidPing: {
                status: invalidPing.response.status,
                contentType: invalidPing.response.headers.get('content-type'),
                headers: stableHeaders(invalidPing.response),
                bytes: invalidPing.body.byteLength,
                sha256: sha256(invalidPing.body),
                body: Buffer.from(invalidPing.body).toString('utf8'),
            },
            extendedPing: {
                status: extendedPing.response.status,
                headers: stableHeaders(extendedPing.response),
                setCookie: extendedCookies.map(normalizeSetCookie),
                setCookieCount: extendedCookies.length,
                sessionPayload: { ...extendedSessionPayload, touch: '<unix-milliseconds>' },
            },
            emptyStringToken: {
                csrfTokenStatus: emptyTokenResponse.response.status,
                csrfTokenBody: JSON.parse(Buffer.from(emptyTokenResponse.body).toString('utf8')),
                csrfTokenSetCookieCount: cookiesFrom(emptyTokenResponse.response).length,
                pingStatus: emptyTokenPing.response.status,
                pingBytes: emptyTokenPing.body.byteLength,
            },
        };
        const outputDirectory = path.join(outputRoot, 'tests', 'oracle');
        mkdirSync(outputDirectory, { recursive: true });
        const outputFile = path.join(outputDirectory, 'sillytavern-1.19.0-csrf-session.json');
        writeFileSync(outputFile, `${JSON.stringify(fixture, null, 2)}\n`);
        console.log(`Wrote ${path.relative(outputRoot, outputFile)} from the pinned Node server`);
    }
} finally {
    await stopServer();
    safeCleanup();
}
