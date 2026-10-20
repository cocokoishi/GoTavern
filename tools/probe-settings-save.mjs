#!/usr/bin/env node
// Capture pinned settings/save serialization, responses, and autosave effects.

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const PINNED_COMMIT = '06bde939fb1e9c4c8d8641d810f0a916b5bce127';
const PINNED_VERSION = '1.19.0';
// @gotavern-oracle: this declaration is read by tools/build-generated-lib.mjs,
// which auto-discovers probes so that adding one needs no edit there.
// @gotavern-oracle: fixture=sillytavern-1.19.0-settings-save.json label="settings-save"
const COOKIE_SECRET = 'gotavern-pinned-settings-save-cookie-secret';
const sourceRoot = path.resolve(process.argv[2] ?? '');
const repositoryRoot = path.resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3]) {
    console.error('usage: node tools/probe-settings-save.mjs <pinned-source-clone> <gotavern-root>');
    process.exit(2);
}
if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim() !== PINNED_COMMIT) {
    throw new Error(`upstream checkout is not pinned at ${PINNED_COMMIT}`);
}

const runtimeRoot = mkdtempSync(path.join(os.tmpdir(), 'gotavern-settings-save-oracle-'));
const dataRoot = path.join(runtimeRoot, 'data');
const configPath = path.join(runtimeRoot, 'config.yaml');
const logs = [];
let child;
let goChild;
const goLogs = [];

function sha256(value) {
    return createHash('sha256').update(value).digest('hex');
}

function safeCleanup() {
    const resolved = path.resolve(runtimeRoot);
    const parent = path.resolve(os.tmpdir());
    if (path.dirname(resolved).toLowerCase() !== parent.toLowerCase()
        || !path.basename(resolved).startsWith('gotavern-settings-save-oracle-')) {
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

async function stopGoServer(origin) {
    if (!goChild || goChild.exitCode !== null) return;
    try {
        await request(`${origin}/_gotavern-probe/shutdown`, 'POST');
    } catch {
        // The probe process may already have failed.
    }
    await Promise.race([
        new Promise(resolve => goChild.once('exit', resolve)),
        new Promise(resolve => setTimeout(resolve, 5000)),
    ]);
    if (goChild.exitCode === null) goChild.kill();
}

async function request(url, method = 'GET', headers = {}, body) {
    const response = await fetch(url, { method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(10000) });
    let parsedBody = Buffer.from(await response.arrayBuffer()).toString('utf8');
    try {
        parsedBody = parsedBody ? JSON.parse(parsedBody) : null;
    } catch {
        // Preserve plain-text response bodies.
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
    writeFileSync(path.join(dataRoot, '_storage', sha256(key)), JSON.stringify({ key, value }));
}

function backupState(directory) {
    return readdirSync(directory).sort().filter(name => name.startsWith('settings_default-user_')).map(name => {
        const absolute = path.join(directory, name);
        const info = statSync(absolute);
        if (!info.isFile()) return { name: name.replace(/\d{8}-\d{6}/g, '<timestamp>'), kind: 'non-file' };
        return {
            name: name.replace(/\d{8}-\d{6}/g, '<timestamp>'),
            bytes: readFileSync(absolute).toString('utf8'),
        };
    });
}

async function verifyGoSettingsRoundTrip(origin, sessionCookie, token, firstRequestBody) {
    const port = await choosePort();
    const goOrigin = `http://127.0.0.1:${port}`;
    goChild = spawn('go', ['run', './tools/settings-save-roundtrip', dataRoot, String(port)], {
        cwd: repositoryRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    goChild.stdout.setEncoding('utf8');
    goChild.stderr.setEncoding('utf8');
    goChild.stdout.on('data', chunk => goLogs.push(chunk));
    goChild.stderr.on('data', chunk => goLogs.push(chunk));
    const deadline = Date.now() + 90000;
    let ready = false;
    let lastError;
    while (Date.now() < deadline && !ready) {
        if (goChild.exitCode !== null) throw new Error(`Go settings server exited before readiness:\n${goLogs.join('').slice(-10000)}`);
        try {
            const result = await request(`${goOrigin}/version`);
            ready = result.response.status === 200;
            if (!ready) lastError = new Error(`Go /version returned ${result.response.status}`);
        } catch (error) {
            lastError = error;
        }
        if (!ready) await new Promise(resolve => setTimeout(resolve, 250));
    }
    if (!ready) throw new Error(`Go settings server did not become ready: ${lastError?.stack ?? 'none'}\n${goLogs.join('').slice(-10000)}`);

    let expectedSettings;
    try {
        expectedSettings = JSON.stringify(JSON.parse(firstRequestBody), null, 4);
        const save = await request(`${goOrigin}/api/settings/save`, 'POST', {
            'Content-Type': 'application/json',
        }, firstRequestBody);
        if (save.response.status !== 200 || save.body?.result !== 'ok') {
            throw new Error(`Go settings save returned ${save.response.status}: ${JSON.stringify(save.body)}\n${goLogs.join('').slice(-10000)}`);
        }
        const readback = await request(`${goOrigin}/api/settings/get`, 'POST', {
            'Content-Type': 'application/json',
        }, '{}');
        if (readback.response.status !== 200 || readback.body?.settings !== expectedSettings) {
            throw new Error(`Node could not read Go settings output: ${JSON.stringify(readback.body)}; expected ${JSON.stringify(expectedSettings)}`);
        }
    } finally {
        await stopGoServer(goOrigin);
    }
    const nodeReadback = await request(`${origin}/api/settings/get`, 'POST', {
        Cookie: sessionCookie,
        'Content-Type': 'application/json',
        'X-CSRF-Token': token,
    }, '{}');
    if (nodeReadback.response.status !== 200 || nodeReadback.body?.settings !== expectedSettings) {
        throw new Error(`pinned Node could not read Go settings output: ${JSON.stringify(nodeReadback.body)}`);
    }
    return { verified: true, settings: nodeReadback.body.settings };
}

try {
    mkdirSync(path.join(dataRoot, '_storage'), { recursive: true });
    writeFileSync(path.join(dataRoot, 'cookie-secret.txt'), COOKIE_SECRET);
    writeFileSync(configPath, 'enableUserAccounts: true\nskipContentCheck: true\nbackups:\n  common:\n    numberOfBackups: 2\n');
    seedUser('user:default-user', {
        handle: 'default-user', name: 'Settings Writer', created: 1700000000000,
        password: '', admin: true, enabled: true, salt: '',
        probeUnknownField: { preserve: true },
    });

    const port = await choosePort();
    const origin = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, [
        'server.js', '--configPath', configPath, '--dataRoot', dataRoot,
        '--listenAddressIPv4', '127.0.0.1', '--enableIPv4', 'true', '--enableIPv6', 'false',
        '--listen', 'false', '--port', String(port), '--browserLaunchEnabled', 'false', '--heartbeatInterval', '0',
    ], { cwd: sourceRoot, env: { ...process.env, NODE_ENV: 'test' }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => logs.push(chunk));
    child.stderr.on('data', chunk => logs.push(chunk));
    const deadline = Date.now() + 180000;
    let ready = false;
    let lastError;
    while (Date.now() < deadline && !ready) {
        if (child.exitCode !== null) throw new Error(`pinned server exited before readiness:\n${logs.join('').slice(-10000)}`);
        try {
            const result = await request(`${origin}/login?noauto=1`);
            ready = result.response.status === 200 && result.response.headers.get('content-type')?.includes('text/html');
            if (!ready) lastError = new Error(`login returned ${result.response.status}`);
        } catch (error) {
            lastError = error;
        }
        if (!ready) await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (!ready) throw new Error(`pinned server did not become ready: ${lastError?.stack ?? 'none'}\n${logs.join('').slice(-10000)}`);

    const userRoot = path.join(dataRoot, 'default-user');
    const settingsPath = path.join(userRoot, 'settings.json');
    const backupsRoot = path.join(userRoot, 'backups');
    const accountRecordPath = path.join(dataRoot, '_storage', sha256('user:default-user'));
    const accountRecordBefore = readFileSync(accountRecordPath);
    writeFileSync(settingsPath, '{"seed":"before settings/save"}');
    rmSync(backupsRoot, { recursive: true, force: true });
    mkdirSync(backupsRoot, { recursive: true });

    const csrf = await request(`${origin}/csrf-token`);
    const token = csrf.body.token;
    const csrfCookie = cookieHeader(cookiesFrom(csrf.response));
    const login = await request(`${origin}/api/users/login`, 'POST', {
        Cookie: csrfCookie,
        'Content-Type': 'application/json',
        'X-CSRF-Token': token,
    }, JSON.stringify({ handle: 'default-user', password: '' }));
    if (login.response.status !== 200) throw new Error(`could not login: ${login.response.status} ${JSON.stringify(login.body)}\n${logs.join('').slice(-10000)}`);
    const sessionCookie = cookieHeader(cookiesFrom(login.response));
    const post = (body, cookie = sessionCookie) => request(`${origin}/api/settings/save`, 'POST', {
        Cookie: cookie,
        'Content-Type': 'application/json',
        'X-CSRF-Token': token,
    }, body);

    const unauthorized = capture(await post('{"denied":true}', csrfCookie));
    const firstRequestBody = '{"10":"ten","2":"two","z":1e+20,"tiny":1e-6,"negativeZero":-0,"nested":{"b":true,"a":[null,"x"]}}';
    const secondRequestBody = '[{"later":"after throttle","first":{"nested":2}},true]';
    const first = capture(await post(firstRequestBody));
    const settingsAfterFirst = readFileSync(settingsPath, 'utf8');
    const backupsAfterFirst = backupState(backupsRoot);
    const second = capture(await post(secondRequestBody));
    const settingsAfterSecond = readFileSync(settingsPath, 'utf8');
    const backupsAfterSecond = backupState(backupsRoot);
    const accountRecordUnchanged = accountRecordBefore.equals(readFileSync(accountRecordPath));
    const roundTrip = await verifyGoSettingsRoundTrip(origin, sessionCookie, token, firstRequestBody);
    await stopServer();

    const fixture = {
        schemaVersion: 1,
        baseline: { version: PINNED_VERSION, commit: PINNED_COMMIT },
        probe: 'pinned settings/save JSON.parse/stringify formatting and throttled snapshot behavior',
        inputs: { cookieSecret: COOKIE_SECRET, firstRequestBody, secondRequestBody },
        responses: { unauthorized, first, second },
        state: {
            settingsAfterFirst, backupsAfterFirst,
            settingsAfterSecond, backupsAfterSecond,
            accountRecordUnchanged,
            roundTrip,
        },
    };
    const outputFile = path.join(repositoryRoot, 'tests', 'oracle', 'sillytavern-1.19.0-settings-save.json');
    mkdirSync(path.dirname(outputFile), { recursive: true });
    writeFileSync(outputFile, `${JSON.stringify(fixture, null, 2)}\n`);
    console.log(`Wrote ${path.relative(repositoryRoot, outputFile)} from pinned settings/save behavior`);
} catch (error) {
    console.error(error);
    process.exitCode = 1;
} finally {
    if (goChild && goChild.exitCode === null) goChild.kill();
    await stopServer();
    safeCleanup();
}
