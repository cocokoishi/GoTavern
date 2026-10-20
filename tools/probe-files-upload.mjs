#!/usr/bin/env node
// Capture pinned file-upload validation, base64 decoding, atomic overwrite, and Go readback.

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const PINNED_COMMIT = '06bde939fb1e9c4c8d8641d810f0a916b5bce127';
const PINNED_VERSION = '1.19.0';
const COOKIE_SECRET = 'gotavern-pinned-files-upload-cookie-secret';
const sourceRoot = path.resolve(process.argv[2] ?? '');
const repositoryRoot = path.resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3]) {
    console.error('usage: node tools/probe-files-upload.mjs <pinned-source-clone-with-dependencies> <gotavern-root>');
    process.exit(2);
}
if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim() !== PINNED_COMMIT) {
    throw new Error('upstream checkout is not pinned at ' + PINNED_COMMIT);
}

const runtimeRoot = mkdtempSync(path.join(os.tmpdir(), 'gotavern-files-upload-oracle-'));
const dataRoot = path.join(runtimeRoot, 'data');
const configPath = path.join(runtimeRoot, 'config.yaml');
const logs = [];
const goLogs = [];
let child;
let goChild;
let goServerOrigin = '';

function sha256(value) {
    return createHash('sha256').update(value).digest('hex');
}

function safeCleanup() {
    const resolved = path.resolve(runtimeRoot);
    const parent = path.resolve(os.tmpdir());
    if (path.dirname(resolved).toLowerCase() !== parent.toLowerCase()
        || !path.basename(resolved).startsWith('gotavern-files-upload-oracle-')) {
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

async function stopGoServer() {
    if (!goChild || goChild.exitCode !== null) return;
    try {
        await request(goServerOrigin + '/_gotavern-probe/shutdown', 'POST');
    } catch {
        // The process may already be stopping after a failed probe.
    }
    await Promise.race([
        new Promise(resolve => goChild.once('exit', resolve)),
        new Promise(resolve => setTimeout(resolve, 5000)),
    ]);
    if (goChild.exitCode === null) goChild.kill();
}

async function waitForServer(origin, processRef, output, label) {
    const deadline = Date.now() + 180000;
    let lastError;
    while (Date.now() < deadline) {
        if (processRef.exitCode !== null) throw new Error(label + ' exited early:\n' + output.join('').slice(-10000));
        try {
            const result = await request(origin + '/login?noauto=1');
            if (result.response.status === 200 && result.response.headers.get('content-type')?.includes('text/html')) return;
            lastError = new Error('login returned ' + result.response.status);
        } catch (error) {
            lastError = error;
        }
        await new Promise(resolve => setTimeout(resolve, 300));
    }
    throw new Error(label + ' did not become ready: ' + (lastError?.stack ?? 'none') + '\n' + output.join('').slice(-10000));
}

function jsonHeaders(cookie, token) {
    return { Cookie: cookie, 'X-CSRF-Token': token, 'Content-Type': 'application/json' };
}

async function upload(origin, route, headers, name, data) {
    return request(origin + route, 'POST', headers, JSON.stringify({ name, data }));
}

try {
    mkdirSync(path.join(dataRoot, '_storage'), { recursive: true });
    writeFileSync(path.join(dataRoot, 'cookie-secret.txt'), COOKIE_SECRET);
    writeFileSync(configPath, 'enableUserAccounts: true\nskipContentCheck: true\n');
    seedUser('user:default-user', {
        handle: 'default-user', name: 'Files Upload Probe', created: 1700000000000,
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
    await waitForServer(origin, child, logs, 'pinned Node server');

    const userRoot = path.join(dataRoot, 'default-user');
    const filesRoot = path.join(userRoot, 'user', 'files');
    mkdirSync(filesRoot, { recursive: true });
    writeFileSync(path.join(filesRoot, 'replace.png'), 'old replacement bytes');
    const accountRecordPath = path.join(dataRoot, '_storage', sha256('user:default-user'));
    const accountRecordBefore = readFileSync(accountRecordPath);

    const csrf = await request(origin + '/csrf-token');
    const token = csrf.body.token;
    const csrfCookie = cookieHeader(cookiesFrom(csrf.response));
    const login = await request(origin + '/api/users/login', 'POST', jsonHeaders(csrfCookie, token), JSON.stringify({ handle: 'default-user', password: '' }));
    if (login.response.status !== 200) throw new Error('could not login: ' + login.response.status + ' ' + JSON.stringify(login.body));
    const sessionCookie = cookieHeader(cookiesFrom(login.response));
    const route = '/api/files/upload';
    const postHeaders = jsonHeaders(sessionCookie, token);
    const responses = {
        unauthorized: capture(await upload(origin, route, jsonHeaders(csrfCookie, token), 'auth.png', 'AQIDBA==')),
        invalidCSRF: capture(await upload(origin, route, { Cookie: sessionCookie, 'Content-Type': 'application/json' }, 'csrf.png', 'AQIDBA==')),
        wrongMethod: capture(await request(origin + route, 'GET', { Cookie: sessionCookie })),
        wrongMethodHead: capture(await request(origin + route, 'HEAD', { Cookie: sessionCookie })),
        wrongMethodOptions: capture(await request(origin + route, 'OPTIONS', { Cookie: sessionCookie })),
        missingName: capture(await request(origin + route, 'POST', postHeaders, JSON.stringify({ data: 'AQIDBA==' }))),
        missingData: capture(await upload(origin, route, postHeaders, 'missing-data.bin', '')),
        illegalName: capture(await upload(origin, route, postHeaders, 'bad name.bin', 'AQIDBA==')),
        forbiddenExtension: capture(await upload(origin, route, postHeaders, 'blocked.EXE', 'AQIDBA==')),
        dotName: capture(await upload(origin, route, postHeaders, '.hidden.png', 'AQIDBA==')),
        longName: capture(await upload(origin, route, postHeaders, 'a'.repeat(256) + '.bin', 'AQIDBA==')),
        nonStringName: capture(await upload(origin, route, postHeaders, 42, 'AQIDBA==')),
        nonStringData: capture(await upload(origin, route, postHeaders, 'nonstring.bin', 42)),
        written: capture(await upload(origin, route, postHeaders, 'asset.png', 'AQIDBA==')),
        overwritten: capture(await upload(origin, route, postHeaders, 'replace.png', 'BQYHCA==')),
        looseBase64: capture(await upload(origin, route, postHeaders, 'loose.bin', 'AQID!junk==??')),
        urlSafeBase64: capture(await upload(origin, route, postHeaders, 'url-safe.bin', '-_8=')),
        emptyDecodedBase64: capture(await upload(origin, route, postHeaders, 'empty.bin', '!')),
        urlEncoded: capture(await request(origin + route, 'POST', {
            Cookie: sessionCookie, 'X-CSRF-Token': token, 'Content-Type': 'application/x-www-form-urlencoded',
        }, 'name=form.bin&data=AQIDBA%3D%3D')),
    };

    const afterNodeWrites = {
        files: Object.fromEntries(['asset.png', 'replace.png', 'loose.bin', 'url-safe.bin', 'empty.bin', 'nonstring.bin', 'form.bin'].map(filename => [
            filename, readFileSync(path.join(filesRoot, filename)).toString('base64'),
        ])),
    };
    const goInput = { name: 'go-roundtrip.bin', data: 'AQIDBA==' };
    const nodeResponse = capture(await upload(origin, route, postHeaders, goInput.name, goInput.data));
    const goFilePath = path.join(filesRoot, goInput.name);
    unlinkSync(goFilePath);

    const goPort = await choosePort();
    goServerOrigin = 'http://127.0.0.1:' + goPort;
    goChild = spawn('go', ['run', './tools/image-metadata-roundtrip', dataRoot, String(goPort), '{}'], {
        cwd: repositoryRoot, stdio: ['ignore', 'pipe', 'pipe'],
    });
    goChild.stdout.setEncoding('utf8');
    goChild.stderr.setEncoding('utf8');
    goChild.stdout.on('data', chunk => goLogs.push(chunk));
    goChild.stderr.on('data', chunk => goLogs.push(chunk));
    await waitForServer(goServerOrigin, goChild, goLogs, 'GoTavern files upload probe server');
    const goResponse = capture(await upload(goServerOrigin, route, postHeaders, goInput.name, goInput.data));
    if (goResponse.status !== 200) throw new Error('GoTavern file upload returned ' + goResponse.status + ': ' + JSON.stringify(goResponse.body) + '\n' + goLogs.join('').slice(-10000));
    const nodeReadback = capture(await request(origin + '/api/files/verify', 'POST', postHeaders, JSON.stringify({ urls: ['user/files/' + goInput.name] })));
    if (nodeReadback.status !== 200 || nodeReadback.body?.['user/files/' + goInput.name] !== true) {
        throw new Error('Node could not read back the Go file upload: ' + JSON.stringify(nodeReadback));
    }
    const goRoundTrip = {
        input: goInput,
        nodeResponse,
        goResponse,
        nodeReadback,
        content: readFileSync(goFilePath).toString('base64'),
    };
    await stopGoServer();

    const fixture = {
        schemaVersion: 1,
        baseline: { version: PINNED_VERSION, commit: PINNED_COMMIT },
        probe: 'POST /api/files/upload matches pinned auth/CSRF, filename and unsafe-extension validation, base64 decoding, atomic overwrite, relative response paths, and Node readback of Go-written files',
        inputs: {
            cookieSecret: COOKIE_SECRET,
            replaceOriginal: Buffer.from('old replacement bytes').toString('base64'),
            go: goInput,
        },
        responses,
        state: {
            afterNodeWrites,
            goRoundTrip,
            accountRecordUnchanged: accountRecordBefore.equals(readFileSync(accountRecordPath)),
        },
    };
    const outputFile = path.join(repositoryRoot, 'tests', 'oracle', 'sillytavern-1.19.0-files-upload.json');
    mkdirSync(path.dirname(outputFile), { recursive: true });
    writeFileSync(outputFile, JSON.stringify(fixture, null, 2) + '\n');
    console.log('Wrote tests/oracle/sillytavern-1.19.0-files-upload.json from pinned behavior and Go round-trip');
} catch (error) {
    console.error(error);
    process.exitCode = 1;
} finally {
    await stopGoServer();
    await stopServer();
    safeCleanup();
}
