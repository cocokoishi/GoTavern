#!/usr/bin/env node
// Capture pinned CORS middleware behavior with configured origins and headers.

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const PINNED_COMMIT = '06bde939fb1e9c4c8d8641d810f0a916b5bce127';
const PINNED_VERSION = '1.19.0';
const sourceRoot = path.resolve(process.argv[2] ?? '');
const repositoryRoot = path.resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3]) {
    console.error('usage: node tools/probe-cors-middleware.mjs <pinned-source-clone> <gotavern-root>');
    process.exit(2);
}
if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim() !== PINNED_COMMIT) {
    throw new Error('upstream checkout is not pinned at ' + PINNED_COMMIT);
}

const runtimeRoot = mkdtempSync(path.join(os.tmpdir(), 'gotavern-cors-middleware-oracle-'));
const dataRoot = path.join(runtimeRoot, 'data');
const configPath = path.join(runtimeRoot, 'config.yaml');
const logs = [];
let child;

function safeCleanup() {
    const resolved = path.resolve(runtimeRoot);
    const parent = path.resolve(os.tmpdir());
    if (path.dirname(resolved).toLowerCase() !== parent.toLowerCase()
        || !path.basename(resolved).startsWith('gotavern-cors-middleware-oracle-')) {
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

async function request(url, method = 'GET', headers = {}, captureBody = false) {
    const response = await fetch(url, { method, headers, redirect: 'manual', signal: AbortSignal.timeout(10000) });
    const body = await response.text();
    const selectedHeaders = Object.fromEntries([...response.headers.entries()]
        .filter(([name]) => name.startsWith('access-control-') || name === 'vary' || name === 'allow'
            || (method === 'OPTIONS' && captureBody && (name === 'content-length' || name === 'content-type'))
            || (response.status === 204 && name === 'content-length'))
        .sort(([left], [right]) => left.localeCompare(right)));
    return { status: response.status, headers: selectedHeaders, ...(captureBody ? { body } : {}) };
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

async function waitForServer(origin) {
    const deadline = Date.now() + 180000;
    let lastError;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error('pinned Node server exited early:\n' + logs.join('').slice(-10000));
        try {
            const response = await fetch(origin + '/version', { redirect: 'manual', signal: AbortSignal.timeout(10000) });
            if (response.status === 200) return;
            lastError = new Error('/version returned ' + response.status);
        } catch (error) {
            lastError = error;
        }
        await new Promise(resolve => setTimeout(resolve, 300));
    }
    throw new Error('pinned Node server did not become ready: ' + (lastError?.stack ?? 'none') + '\n' + logs.join('').slice(-10000));
}

try {
    mkdirSync(dataRoot, { recursive: true });
    writeFileSync(configPath, [
        'enableUserAccounts: false',
        'skipContentCheck: true',
        'cors:',
        '  enabled: true',
        '  origin:',
        '    - "https://allowed.example"',
        '    - "null"',
        '  methods:',
        '    - POST',
        '    - PUT',
        '  allowedHeaders:',
        '    - Content-Type',
        '    - X-Custom',
        '  exposedHeaders:',
        '    - X-Exposed',
        '  credentials: true',
        '  maxAge: 600',
        '',
    ].join('\n'));

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
    await waitForServer(origin);

    const allowedHeaders = {
        Origin: 'https://allowed.example',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type,x-custom',
    };
    const deniedHeaders = { ...allowedHeaders, Origin: 'https://denied.example' };
    const responses = {
        allowedPreflight: await request(origin + '/api/image-metadata', 'OPTIONS', allowedHeaders),
        deniedPreflight: await request(origin + '/api/image-metadata', 'OPTIONS', deniedHeaders),
        preflightWithoutOrigin: await request(origin + '/route-not-registered', 'OPTIONS'),
        allowedActualRequest: await request(origin + '/version', 'GET', { Origin: 'https://allowed.example' }),
        deniedActualRequest: await request(origin + '/version', 'GET', { Origin: 'https://denied.example' }),
    };
    await stopServer();

    writeFileSync(configPath, 'enableUserAccounts: false\nskipContentCheck: true\ncors:\n  enabled: false\n');
    const disabledPort = await choosePort();
    const disabledOrigin = 'http://127.0.0.1:' + disabledPort;
    child = spawn(process.execPath, [
        'server.js', '--configPath', configPath, '--dataRoot', dataRoot,
        '--listenAddressIPv4', '127.0.0.1', '--enableIPv4', 'true', '--enableIPv6', 'false',
        '--listen', 'false', '--port', String(disabledPort), '--browserLaunchEnabled', 'false', '--heartbeatInterval', '0',
    ], { cwd: sourceRoot, env: { ...process.env, NODE_ENV: 'test' }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => logs.push(chunk));
    child.stderr.on('data', chunk => logs.push(chunk));
    await waitForServer(disabledOrigin);
    responses.disabledPreflight = await request(disabledOrigin + '/api/image-metadata', 'OPTIONS', allowedHeaders, true);
    responses.disabledGetPreflight = await request(disabledOrigin + '/api/sprites/get', 'OPTIONS', allowedHeaders, true);
    responses.disabledActualRequest = await request(disabledOrigin + '/version', 'GET', { Origin: 'https://allowed.example' });
    await stopServer();

    const fixture = {
        schemaVersion: 1,
        baseline: { version: PINNED_VERSION, commit: PINNED_COMMIT },
        probe: 'pinned cors@2.8.5 applies configured CORS headers before route dispatch and terminates enabled OPTIONS requests with status 204; when disabled, Express automatic OPTIONS returns its route method list for registered routes',
        inputs: {
            cors: {
                enabled: true,
                origin: ['https://allowed.example', 'null'],
                methods: ['POST', 'PUT'],
                allowedHeaders: ['Content-Type', 'X-Custom'],
                exposedHeaders: ['X-Exposed'],
                credentials: true,
                maxAge: 600,
            },
            corsDisabled: { enabled: false },
            allowedHeaders,
            deniedHeaders,
        },
        responses,
    };
    await stopServer();
    const outputFile = path.join(repositoryRoot, 'tests', 'oracle', 'sillytavern-1.19.0-cors-middleware.json');
    mkdirSync(path.dirname(outputFile), { recursive: true });
    writeFileSync(outputFile, JSON.stringify(fixture, null, 2) + '\n');
    console.log('Wrote tests/oracle/sillytavern-1.19.0-cors-middleware.json from pinned cors behavior');
} catch (error) {
    console.error(error);
    process.exitCode = 1;
} finally {
    await stopServer();
    safeCleanup();
}
