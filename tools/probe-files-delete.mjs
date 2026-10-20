#!/usr/bin/env node
// Capture pinned file deletion behavior, including the files-directory prefix check.

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const PINNED_COMMIT = '06bde939fb1e9c4c8d8641d810f0a916b5bce127';
const PINNED_VERSION = '1.19.0';
const COOKIE_SECRET = 'gotavern-pinned-files-delete-cookie-secret';
const sourceRoot = path.resolve(process.argv[2] ?? '');
const repositoryRoot = path.resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3]) {
    console.error('usage: node tools/probe-files-delete.mjs <pinned-source-clone-with-dependencies> <gotavern-root>');
    process.exit(2);
}
if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim() !== PINNED_COMMIT) {
    throw new Error('upstream checkout is not pinned at ' + PINNED_COMMIT);
}

const runtimeRoot = mkdtempSync(path.join(os.tmpdir(), 'gotavern-files-delete-oracle-'));
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
        || !path.basename(resolved).startsWith('gotavern-files-delete-oracle-')) {
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

async function request(url, method = 'GET', headers = {}, body) {
    const response = await fetch(url, { method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(10000) });
    let parsedBody = Buffer.from(await response.arrayBuffer()).toString('utf8');
    try {
        parsedBody = parsedBody ? JSON.parse(parsedBody) : null;
    } catch {
        // Preserve plain text and HTML errors.
    }
    return { response, body: parsedBody };
}

function stableHeaders(response) {
    return Object.fromEntries([...response.headers.entries()]
        .filter(([name]) => !['connection', 'date', 'keep-alive', 'last-modified', 'set-cookie', 'x-response-time'].includes(name))
        .sort(([left], [right]) => left.localeCompare(right)));
}

function capture(result) {
    return { status: result.response.status, headers: stableHeaders(result.response), body: result.body };
}

function captureStatus(result) {
    return { status: result.response.status, headers: { 'content-type': result.response.headers.get('content-type') ?? '' }, body: null };
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
            const result = await request(origin + '/login?noauto=1');
            if (result.response.status === 200 && result.response.headers.get('content-type')?.includes('text/html')) return;
            lastError = new Error('login returned ' + result.response.status);
        } catch (error) {
            lastError = error;
        }
        await new Promise(resolve => setTimeout(resolve, 300));
    }
    throw new Error('pinned Node server did not become ready: ' + (lastError?.stack ?? 'none') + '\n' + logs.join('').slice(-10000));
}

try {
    mkdirSync(path.join(dataRoot, '_storage'), { recursive: true });
    writeFileSync(path.join(dataRoot, 'cookie-secret.txt'), COOKIE_SECRET);
    writeFileSync(configPath, 'enableUserAccounts: true\nskipContentCheck: true\n');
    seedUser('user:default-user', {
        handle: 'default-user', name: 'Files Delete Probe', created: 1700000000000,
        password: '', admin: true, enabled: true, salt: '', probeUnknownField: { preserve: true },
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
    await waitForServer(origin);

    const userRoot = path.join(dataRoot, 'default-user');
    const filesRoot = path.join(userRoot, 'user', 'files');
    const prefixSibling = path.join(userRoot, 'user', 'files2');
    const otherRoot = path.join(userRoot, 'user', 'other');
    mkdirSync(filesRoot, { recursive: true });
    mkdirSync(prefixSibling, { recursive: true });
    mkdirSync(otherRoot, { recursive: true });
    mkdirSync(path.join(filesRoot, 'directory'), { recursive: true });
    writeFileSync(path.join(filesRoot, 'existing.txt'), 'existing file');
    writeFileSync(path.join(filesRoot, 'urlencoded.txt'), 'urlencoded file');
    writeFileSync(path.join(prefixSibling, 'prefix.txt'), 'prefix sibling');
    writeFileSync(path.join(otherRoot, 'keep.txt'), 'outside files directory');
    const accountRecordPath = path.join(dataRoot, '_storage', sha256('user:default-user'));
    const accountRecordBefore = readFileSync(accountRecordPath);

    const csrf = await request(origin + '/csrf-token');
    const token = csrf.body.token;
    const csrfCookie = cookieHeader(cookiesFrom(csrf.response));
    const login = await request(origin + '/api/users/login', 'POST', {
        Cookie: csrfCookie, 'Content-Type': 'application/json', 'X-CSRF-Token': token,
    }, JSON.stringify({ handle: 'default-user', password: '' }));
    if (login.response.status !== 200) throw new Error('could not login: ' + login.response.status + ' ' + JSON.stringify(login.body));
    const sessionCookie = cookieHeader(cookiesFrom(login.response));
    const route = '/api/files/delete';
    const jsonHeaders = { Cookie: sessionCookie, 'X-CSRF-Token': token, 'Content-Type': 'application/json' };
    const pathExisting = 'user/files/existing.txt';
    const pathMissing = 'user/files/missing.txt';
    const pathDirectory = 'user/files/directory';
    const pathPrefixSibling = 'user/files2/prefix.txt';
    const pathURLencoded = 'user/files/urlencoded.txt';
    const pathOutsideFiles = 'user/other/keep.txt';
    const responses = {
        unauthorized: capture(await request(origin + route, 'POST', {
            Cookie: csrfCookie, 'X-CSRF-Token': token, 'Content-Type': 'application/json',
        }, JSON.stringify({ path: pathExisting }))),
        invalidCSRF: capture(await request(origin + route, 'POST', {
            Cookie: sessionCookie, 'Content-Type': 'application/json',
        }, JSON.stringify({ path: pathExisting }))),
        wrongMethod: capture(await request(origin + route, 'GET', { Cookie: sessionCookie })),
        wrongMethodHead: capture(await request(origin + route, 'HEAD', { Cookie: sessionCookie })),
        wrongMethodOptions: capture(await request(origin + route, 'OPTIONS', { Cookie: sessionCookie })),
        missingPath: capture(await request(origin + route, 'POST', jsonHeaders, JSON.stringify({}))),
        emptyPath: capture(await request(origin + route, 'POST', jsonHeaders, JSON.stringify({ path: '' }))),
        nullPath: capture(await request(origin + route, 'POST', jsonHeaders, JSON.stringify({ path: null }))),
        outsideFiles: capture(await request(origin + route, 'POST', jsonHeaders, JSON.stringify({ path: pathOutsideFiles }))),
        missingFile: capture(await request(origin + route, 'POST', jsonHeaders, JSON.stringify({ path: pathMissing }))),
        directory: capture(await request(origin + route, 'POST', jsonHeaders, JSON.stringify({ path: pathDirectory }))),
        deleteExisting: capture(await request(origin + route, 'POST', jsonHeaders, JSON.stringify({ path: pathExisting }))),
        deletePrefixSibling: capture(await request(origin + route, 'POST', jsonHeaders, JSON.stringify({ path: pathPrefixSibling }))),
        urlEncodedDelete: capture(await request(origin + route, 'POST', {
            Cookie: sessionCookie, 'X-CSRF-Token': token, 'Content-Type': 'application/x-www-form-urlencoded',
        }, new URLSearchParams({ path: pathURLencoded }))),
        nonStringPath: capture(await request(origin + route, 'POST', jsonHeaders, JSON.stringify({ path: 7 }))),
        malformedJSON: captureStatus(await request(origin + route, 'POST', jsonHeaders, '{')),
    };
    const fixture = {
        schemaVersion: 1,
        baseline: { version: PINNED_VERSION, commit: PINNED_COMMIT },
        probe: 'POST /api/files/delete matches pinned authentication/CSRF, path validation, prefix filtering, deletion responses, and filesystem changes',
        inputs: { cookieSecret: COOKIE_SECRET, paths: {
            existing: pathExisting, missing: pathMissing, directory: pathDirectory,
            prefixSibling: pathPrefixSibling, urlEncoded: pathURLencoded, outsideFiles: pathOutsideFiles,
        } },
        responses,
        state: {
            files: {
                existing: existsSync(path.join(filesRoot, 'existing.txt')),
                missing: existsSync(path.join(filesRoot, 'missing.txt')),
                directory: existsSync(path.join(filesRoot, 'directory')),
                prefixSibling: existsSync(path.join(prefixSibling, 'prefix.txt')),
                urlEncoded: existsSync(path.join(filesRoot, 'urlencoded.txt')),
                outsideFiles: existsSync(path.join(otherRoot, 'keep.txt')),
            },
            accountRecordUnchanged: accountRecordBefore.equals(readFileSync(accountRecordPath)),
        },
    };
    const outputFile = path.join(repositoryRoot, 'tests', 'oracle', 'sillytavern-1.19.0-files-delete.json');
    mkdirSync(path.dirname(outputFile), { recursive: true });
    writeFileSync(outputFile, JSON.stringify(fixture, null, 2) + '\n');
    console.log('Wrote tests/oracle/sillytavern-1.19.0-files-delete.json from pinned behavior');
} catch (error) {
    console.error(error);
    process.exitCode = 1;
} finally {
    await stopServer();
    safeCleanup();
}
