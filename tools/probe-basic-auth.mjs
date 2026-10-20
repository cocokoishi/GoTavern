#!/usr/bin/env node
// Capture the pinned global Basic Auth middleware using an isolated data root.

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
// @gotavern-oracle: fixture=sillytavern-1.19.0-basic-auth.json label="Basic Auth"
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
    console.error('usage: node tools/probe-basic-auth.mjs <pinned-source-clone> <gotavern-root>');
    process.exit(2);
}

const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim();
if (sourceCommit !== PINNED_COMMIT) throw new Error(`upstream checkout is ${sourceCommit}; expected ${PINNED_COMMIT}`);

const runtimeRoot = mkdtempSync(path.join(os.tmpdir(), 'gotavern-basic-auth-oracle-'));
const dataRoot = path.join(runtimeRoot, 'data');
const configPath = path.join(runtimeRoot, 'config.yaml');
const logs = [];
let child;

function sha256(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
}

function stableHeaders(response) {
    return Object.fromEntries([...response.headers.entries()]
        .filter(([name]) => !['connection', 'date', 'keep-alive', 'x-response-time'].includes(name))
        .sort(([left], [right]) => left.localeCompare(right)));
}

function safeCleanup() {
    const resolved = path.resolve(runtimeRoot);
    const parent = path.resolve(os.tmpdir());
    if (path.dirname(resolved).toLowerCase() !== parent.toLowerCase()
        || !path.basename(resolved).startsWith('gotavern-basic-auth-oracle-')) {
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

async function getResponse(origin, authorization, forwardedIP) {
    const headers = { 'X-Real-IP': forwardedIP };
    if (authorization !== null) headers.Authorization = authorization;
    const response = await fetch(`${origin}/version`, { headers, redirect: 'manual', signal: AbortSignal.timeout(10000) });
    const body = new Uint8Array(await response.arrayBuffer());
    const observedHeaders = stableHeaders(response);
    // The pinned retryAfter helper uses ceil(msBeforeNext / 1000), so the
    // exact value depends on when the request lands inside the 60-second
    // window. Preserve the source-verified range instead of wall-clock data.
    if (observedHeaders['retry-after'] !== undefined) observedHeaders['retry-after'] = '1..60';
    return {
        headers: observedHeaders,
        status: response.status,
        contentType: response.headers.get('content-type'),
        bytes: body.byteLength,
        sha256: sha256(body),
        body: Buffer.from(body).toString('utf8'),
    };
}

try {
    mkdirSync(dataRoot, { recursive: true });
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
        '  username: probe-user',
        '  password: "secret:with:colon"',
        'enableUserAccounts: false',
        'perUserBasicAuth: false',
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
        'server.js',
        '--configPath', configPath,
        '--dataRoot', dataRoot,
        '--listen', 'true',
        '--listenAddressIPv4', '127.0.0.1',
        '--enableIPv4', 'true',
        '--enableIPv6', 'false',
        '--port', String(port),
        '--browserLaunchEnabled', 'false',
        '--heartbeatInterval', '0',
    ], { cwd: sourceRoot, env: { ...process.env, NODE_ENV: 'test', ...PINNED_GIT_ENVIRONMENT }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => logs.push(chunk));
    child.stderr.on('data', chunk => logs.push(chunk));

    const validAuthorization = `Basic ${Buffer.from('probe-user:secret:with:colon').toString('base64')}`;
    let ready = false;
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error(`pinned server exited before becoming ready:\n${logs.join('').slice(-12000)}`);
        try {
            const response = await getResponse(origin, validAuthorization, '127.0.0.1');
            if (response.status === 200 && response.contentType?.includes('application/json')) {
                const version = JSON.parse(response.body);
                if (version.pkgVersion !== PINNED_VERSION || !String(version.agent).startsWith(`SillyTavern:${PINNED_VERSION}:`)) {
                    throw new Error(`unexpected /version payload: ${JSON.stringify(version)}`);
                }
                ready = true;
                break;
            }
        } catch (error) {
            if (error.message.startsWith('unexpected /version payload')) throw error;
        }
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (!ready) throw new Error(`pinned server did not become ready within 180 seconds:\n${logs.join('').slice(-12000)}`);

    const observations = {
        missingAuthorization: await getResponse(origin, null, '198.51.100.11'),
        wrongScheme: await getResponse(origin, 'Bearer dGVzdA==', '198.51.100.11'),
        invalidCredentialFirst: await getResponse(origin, 'Basic ' + Buffer.from('probe-user:wrong').toString('base64'), '198.51.100.12'),
        invalidCredentialSecond: await getResponse(origin, 'Basic ' + Buffer.from('probe-user:wrong').toString('base64'), '198.51.100.12'),
        invalidCredentialLimit: await getResponse(origin, 'Basic ' + Buffer.from('probe-user:wrong').toString('base64'), '198.51.100.12'),
        validCredentialWhileLimited: await getResponse(origin, validAuthorization, '198.51.100.12'),
        invalidCredentialBeforeSuccess: await getResponse(origin, 'Basic ' + Buffer.from('probe-user:wrong').toString('base64'), '198.51.100.13'),
        validCredentialClearsLimit: await getResponse(origin, validAuthorization, '198.51.100.13'),
        invalidCredentialAfterSuccess: await getResponse(origin, 'Basic ' + Buffer.from('probe-user:wrong').toString('base64'), '198.51.100.13'),
    };
    await stopServer();

    const fixture = {
        schemaVersion: 1,
        baseline: { version: PINNED_VERSION, commit: PINNED_COMMIT },
        probe: 'pinned global Basic Auth responses, credential parsing, per-IP rate limit, and successful-auth reset',
        source: 'src/middleware/basicAuth.js; src/express-common.js: retryAfter/getIpAddress; src/server-main.js: Basic Auth mount order',
        inputs: {
            username: 'probe-user',
            password: 'secret:with:colon',
            basicAuthMaxAttempts: 2,
            rateLimitDurationSeconds: 60,
            preferRealIPHeader: true,
        },
        observations,
    };
    const fixturePath = path.join(outputRoot, 'tests', 'oracle', 'sillytavern-1.19.0-basic-auth.json');
    mkdirSync(path.dirname(fixturePath), { recursive: true });
    writeFileSync(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);
    console.log(`Wrote ${path.relative(outputRoot, fixturePath)} from the pinned Node server`);
} finally {
    await stopServer();
    safeCleanup();
}
