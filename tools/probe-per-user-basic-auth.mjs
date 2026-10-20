#!/usr/bin/env node
// Capture the pinned per-user Basic Auth gate and login-page auto-login path.

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
// @gotavern-oracle: fixture=sillytavern-1.19.0-per-user-basic-auth.json label="per-user Basic Auth"
const COOKIE_SECRET = 'gotavern-pinned-per-user-basic-auth-probe-secret';
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
    console.error('usage: node tools/probe-per-user-basic-auth.mjs <pinned-source-clone> <gotavern-root>');
    process.exit(2);
}

const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim();
if (sourceCommit !== PINNED_COMMIT) throw new Error(`upstream checkout is ${sourceCommit}; expected ${PINNED_COMMIT}`);

const requireFromPinned = createRequire(path.join(sourceRoot, 'package.json'));
const storage = requireFromPinned('node-persist');
const runtimeRoot = mkdtempSync(path.join(os.tmpdir(), 'gotavern-per-user-basic-auth-oracle-'));
const dataRoot = path.join(runtimeRoot, 'data');
const configPath = path.join(runtimeRoot, 'config.yaml');
const logs = [];
let child;

function sha256(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
}

function passwordHash(password, salt) {
    // src/users.js:getPasswordHash uses crypto.scryptSync(password.normalize(), salt, 64).
    return scryptSync(password.normalize(), salt, 64).toString('base64');
}

function stableHeaders(response) {
    return Object.fromEntries([...response.headers.entries()]
        .filter(([name]) => !['connection', 'date', 'keep-alive', 'last-modified', 'set-cookie', 'x-response-time'].includes(name))
        // Express's send-file ETag embeds the checkout file mtime in hex. It
        // changes when the pinned tree is freshly cloned, even though the page
        // bytes are identical, so retain the size and normalize that metadata.
        .map(([name, value]) => {
            const sendFileTag = name === 'etag' && /^W\/"(\d+)-[a-f\d]+"$/i.exec(value);
            return [name, sendFileTag ? `W/"${sendFileTag[1]}-<mtime>"` : value];
        })
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

function cookieHeader(cookies) {
    return cookies.map(raw => raw.split(';', 1)[0]).join('; ');
}

function fixtureObservation(observation) {
    const { cookie, ...stable } = observation;
    if (stable.headers['retry-after'] !== undefined) stable.headers['retry-after'] = '1..60';
    return stable;
}

function safeCleanup() {
    const resolved = path.resolve(runtimeRoot);
    const parent = path.resolve(os.tmpdir());
    if (path.dirname(resolved).toLowerCase() !== parent.toLowerCase()
        || !path.basename(resolved).startsWith('gotavern-per-user-basic-auth-oracle-')) {
        throw new Error(`refusing to remove unexpected runtime path: ${resolved}`);
    }
    rmSync(resolved, { recursive: true, force: true });
}

async function choosePort() {
    const listener = net.createServer();
    await new Promise((resolve, reject) => {
        listener.once('error', reject);
        listener.listen(0, '127.0.0.1', resolve);
    });
    const port = listener.address().port;
    await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
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

async function getResponse(origin, authorization, forwardedIP, route = '/login', cookie) {
    const headers = { 'X-Real-IP': forwardedIP };
    if (authorization !== null) headers.Authorization = authorization;
    if (cookie) headers.Cookie = cookie;
    const response = await fetch(`${origin}${route}`, { headers, redirect: 'manual', signal: AbortSignal.timeout(10000) });
    const body = new Uint8Array(await response.arrayBuffer());
    const cookies = cookiesFrom(response);
    return {
        headers: stableHeaders(response),
        status: response.status,
        contentType: response.headers.get('content-type'),
        bytes: body.byteLength,
        sha256: sha256(body),
        body: Buffer.from(body).toString('utf8'),
        setCookie: cookies.map(normalizeSetCookie),
        sessionPayload: cookies.some(raw => raw.split('=', 1)[0].startsWith('session-')) ? sessionPayload(cookies) : null,
        cookie: cookies.length > 0 ? cookieHeader(cookies) : null,
    };
}

try {
    mkdirSync(dataRoot, { recursive: true });
    writeFileSync(path.join(dataRoot, 'cookie-secret.txt'), COOKIE_SECRET);
    const users = [
        {
            handle: 'alice', name: 'Alice', created: 1700000000000,
            password: passwordHash('secret:with:colon', 'alice-salt'), admin: true, enabled: true, salt: 'alice-salt',
        },
        {
            handle: 'unicode', name: 'Unicode User', created: 1700000000001,
            password: passwordHash('café', 'unicode-salt'), admin: false, enabled: true, salt: 'unicode-salt',
        },
        {
            handle: 'disabled', name: 'Disabled User', created: 1700000000002,
            password: passwordHash('disabled-password', 'disabled-salt'), admin: false, enabled: false, salt: 'disabled-salt',
        },
    ];
    await storage.init({ dir: path.join(dataRoot, '_storage'), ttl: false, expiredInterval: 0, writeQueue: false });
    for (const user of users) await storage.setItem(`user:${user.handle}`, user);

    const port = await choosePort();
    writeFileSync(configPath, [
        'listen: true',
        'listenAddress:',
        '  ipv4: 127.0.0.1',
        'protocol:',
        '  ipv4: true',
        '  ipv6: false',
        'port: ' + port,
        'whitelistMode: false',
        'basicAuthMode: true',
        'basicAuthUser:',
        '  username: global-probe-user',
        '  password: global-probe-password',
        'enableUserAccounts: true',
        'perUserBasicAuth: true',
        'rateLimiting:',
        '  basicAuthMaxAttempts: 2',
        '  preferRealIpHeader: true',
        'forwardedHeaders:',
        '  xRealIp: true',
        '  xForwardedFor: false',
        '  cfConnectingIp: false',
        '',
    ].join('\n'));

    const origin = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, [
        'server.js', '--configPath', configPath, '--dataRoot', dataRoot,
        '--listen', 'true', '--listenAddressIPv4', '127.0.0.1', '--enableIPv4', 'true', '--enableIPv6', 'false',
        '--port', String(port), '--browserLaunchEnabled', 'false', '--heartbeatInterval', '0',
    ], { cwd: sourceRoot, env: { ...process.env, NODE_ENV: 'test', ...PINNED_GIT_ENVIRONMENT }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => logs.push(chunk));
    child.stderr.on('data', chunk => logs.push(chunk));

    const aliceAuthorization = `Basic ${Buffer.from('alice:secret:with:colon').toString('base64')}`;
    const unicodeAuthorization = `Basic ${Buffer.from('unicode:cafe\u0301').toString('base64')}`;
    const disabledAuthorization = `Basic ${Buffer.from('disabled:disabled-password').toString('base64')}`;
    const wrongPasswordAuthorization = `Basic ${Buffer.from('alice:wrong').toString('base64')}`;
    const globalAuthorization = `Basic ${Buffer.from('global-probe-user:global-probe-password').toString('base64')}`;
    let ready = false;
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error(`pinned server exited before becoming ready:\n${logs.join('').slice(-12000)}`);
        try {
            const response = await getResponse(origin, aliceAuthorization, '192.0.2.200', '/login?noauto=1');
            if (response.status === 200 && response.contentType?.includes('text/html')) {
                ready = true;
                break;
            }
        } catch {
            // Listener is not bound yet.
        }
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (!ready) throw new Error(`pinned server did not become ready within 180 seconds:\n${logs.join('').slice(-12000)}`);

    const autoLogin = await getResponse(origin, aliceAuthorization, '198.51.100.21');
    const observations = {
        missingAuthorization: fixtureObservation(await getResponse(origin, null, '198.51.100.11')),
        wrongScheme: fixtureObservation(await getResponse(origin, 'Bearer dGVzdA==', '198.51.100.11')),
        globalCredentialRejected: fixtureObservation(await getResponse(origin, globalAuthorization, '198.51.100.12')),
        wrongPassword: fixtureObservation(await getResponse(origin, wrongPasswordAuthorization, '198.51.100.13')),
        unknownUser: fixtureObservation(await getResponse(origin, `Basic ${Buffer.from('missing:password').toString('base64')}`, '198.51.100.14')),
        disabledUser: fixtureObservation(await getResponse(origin, disabledAuthorization, '198.51.100.15')),
        caseSensitiveHandle: fixtureObservation(await getResponse(origin, `Basic ${Buffer.from('Alice:secret:with:colon').toString('base64')}`, '198.51.100.16')),
        rateLimitedFirst: fixtureObservation(await getResponse(origin, wrongPasswordAuthorization, '198.51.100.17')),
        rateLimitedSecond: fixtureObservation(await getResponse(origin, wrongPasswordAuthorization, '198.51.100.17')),
        rateLimitedThird: fixtureObservation(await getResponse(origin, wrongPasswordAuthorization, '198.51.100.17')),
        validWhileLimited: fixtureObservation(await getResponse(origin, aliceAuthorization, '198.51.100.17')),
        invalidBeforeSuccess: fixtureObservation(await getResponse(origin, wrongPasswordAuthorization, '198.51.100.18')),
        validClearsLimit: fixtureObservation(await getResponse(origin, aliceAuthorization, '198.51.100.18')),
        invalidAfterSuccess: fixtureObservation(await getResponse(origin, wrongPasswordAuthorization, '198.51.100.18')),
        unicodeNFCPassword: fixtureObservation(await getResponse(origin, unicodeAuthorization, '198.51.100.19')),
        validCredentialNoAutoLogin: fixtureObservation(await getResponse(origin, aliceAuthorization, '198.51.100.20', '/login?noauto=1')),
        autoLogin: fixtureObservation(autoLogin),
        versionAfterAutoLogin: null,
    };
    observations.versionAfterAutoLogin = fixtureObservation(await getResponse(
        origin,
        aliceAuthorization,
        '198.51.100.22',
        '/version',
        autoLogin.cookie,
    ));
    await stopServer();

    const fixture = {
        schemaVersion: 1,
        baseline: { version: PINNED_VERSION, commit: PINNED_COMMIT },
        probe: 'pinned per-user Basic Auth middleware and login-page auto-login through account storage and session state',
        source: 'src/middleware/basicAuth.js; src/users.js: getPasswordHash/basicUserLogin/tryAutoLogin/loginPageMiddleware; src/express-common.js: retryAfter/getIpAddress; src/server-main.js: middleware and route order',
        inputs: {
            basicAuthMaxAttempts: 2,
            rateLimitDurationSeconds: 60,
            preferRealIPHeader: true,
            cookieSecret: COOKIE_SECRET,
            globalUsername: 'global-probe-user',
            globalPassword: 'global-probe-password',
            users,
            credentials: {
                alice: 'secret:with:colon',
                unicode: 'café',
                unicodeBasicHeader: 'cafe\u0301',
                disabled: 'disabled-password',
            },
        },
        observations,
    };
    const fixturePath = path.join(outputRoot, 'tests', 'oracle', 'sillytavern-1.19.0-per-user-basic-auth.json');
    mkdirSync(path.dirname(fixturePath), { recursive: true });
    writeFileSync(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);
    console.log(`Wrote ${path.relative(outputRoot, fixturePath)} from the pinned Node server`);
} finally {
    await stopServer();
    safeCleanup();
}
