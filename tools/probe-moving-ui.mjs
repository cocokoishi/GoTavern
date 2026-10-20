#!/usr/bin/env node
// Capture pinned moving UI preset save behavior and file mutations.

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
// @gotavern-oracle: fixture=sillytavern-1.19.0-moving-ui.json label="moving UI preset"
const COOKIE_SECRET = 'gotavern-pinned-moving-ui-cookie-secret';
const sourceRoot = path.resolve(process.argv[2] ?? '');
const repositoryRoot = path.resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3]) {
    console.error('usage: node tools/probe-moving-ui.mjs <pinned-source-clone> <gotavern-root>');
    process.exit(2);
}
if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim() !== PINNED_COMMIT) {
    throw new Error(`upstream checkout is not pinned at ${PINNED_COMMIT}`);
}

const runtimeRoot = mkdtempSync(path.join(os.tmpdir(), 'gotavern-moving-ui-oracle-'));
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
        || !path.basename(resolved).startsWith('gotavern-moving-ui-oracle-')) {
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
        // The Go probe process may already have failed.
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

function capture(result) {
    return { status: result.response.status, headers: stableHeaders(result.response), body: result.body };
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

function movingUIFileState(directory) {
    return readdirSync(directory).sort().map(name => {
        const absolute = path.join(directory, name);
        const info = statSync(absolute);
        return {
            name,
            kind: info.isFile() ? 'file' : info.isDirectory() ? 'directory' : 'other',
            content: info.isFile() ? readFileSync(absolute).toString('utf8') : null,
        };
    });
}

async function verifyGoMovingUIRoundTrip(origin, sessionCookie, token) {
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
        if (goChild.exitCode !== null) throw new Error(`Go moving UI preset server exited before readiness:\n${goLogs.join('').slice(-10000)}`);
        try {
            const result = await request(`${goOrigin}/version`);
            ready = result.response.status === 200;
            if (!ready) lastError = new Error(`Go /version returned ${result.response.status}`);
        } catch (error) {
            lastError = error;
        }
        if (!ready) await new Promise(resolve => setTimeout(resolve, 250));
    }
    if (!ready) throw new Error(`Go moving UI preset server did not become ready: ${lastError?.stack ?? 'none'}\n${goLogs.join('').slice(-10000)}`);

    const body = JSON.stringify({ name: 'Go-written', movingUIState: { chat: { left: 200, top: 300 } }, roundtrip: 'visible to pinned Node' });
    try {
        const save = await request(`${goOrigin}/api/moving-ui/save`, 'POST', {
            'Content-Type': 'application/json',
        }, body);
        if (save.response.status !== 200 || save.body !== 'OK') {
            throw new Error(`Go moving UI save returned ${save.response.status}: ${JSON.stringify(save.body)}\n${goLogs.join('').slice(-10000)}`);
        }
    } finally {
        await stopGoServer(goOrigin);
    }

    const nodeReadback = await request(`${origin}/api/settings/get`, 'POST', {
        Cookie: sessionCookie,
        'Content-Type': 'application/json',
        'X-CSRF-Token': token,
    }, '{}');
        const preset = nodeReadback.body?.movingUIPresets?.find(item => item?.name === 'Go-written');
    if (nodeReadback.response.status !== 200 || preset?.movingUIState?.chat?.left !== 200 || preset?.roundtrip !== 'visible to pinned Node') {
        throw new Error(`pinned Node could not read Go moving UI preset data: status=${nodeReadback.response.status}, body=${JSON.stringify(nodeReadback.body)}, logs=${logs.join('').slice(-10000)}`);
    }
    return { verified: true, preset };
}

try {
    mkdirSync(path.join(dataRoot, '_storage'), { recursive: true });
    writeFileSync(path.join(dataRoot, 'cookie-secret.txt'), COOKIE_SECRET);
    writeFileSync(configPath, 'enableUserAccounts: true\nskipContentCheck: true\n');
    seedUser('user:default-user', {
        handle: 'default-user', name: 'Moving UI Writer', created: 1700000000000,
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
    const movingUIRoot = path.join(userRoot, 'movingUI');
    rmSync(movingUIRoot, { recursive: true, force: true });
    mkdirSync(movingUIRoot, { recursive: true });
    writeFileSync(path.join(userRoot, 'settings.json'), '{}');
    const accountRecordPath = path.join(dataRoot, '_storage', sha256('user:default-user'));
    const accountRecordBefore = readFileSync(accountRecordPath);

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
    const post = (route, body, cookie = sessionCookie) => request(`${origin}/api/moving-ui/${route}`, 'POST', {
        Cookie: cookie,
        'Content-Type': 'application/json',
        'X-CSRF-Token': token,
    }, body);
    const legacyPost = (route, body) => request(`${origin}/${route}`, 'POST', {
        Cookie: sessionCookie,
        'Content-Type': 'application/json',
        'X-CSRF-Token': token,
    }, body);

    const mainBody = '{"name":"Main","movingUIState":{"chat":{"left":10,"top":20}},"preserve":{"z":1e+20,"a":-0}}';
    const overwriteBody = '{"name":"Main","movingUIState":{"chat":{"left":100,"top":200}},"unknown":{"keep":true}}';
    const sanitizedBody = JSON.stringify({ name: 'A/../bad?:*|"<>', payload: 'sanitized name' });
    // Pinned src/endpoints/moving-ui.js:13-14 sanitizes `${name}.json` and
    // writes it with write-file-atomic, whose temp name appends a pid-derived
    // suffix. A name that sanitizes to the 255-byte limit therefore makes the
    // temp name longer than Linux's NAME_MAX (255 bytes) and the write fails
    // with ENAMETOOLONG, so the pinned server answers 500 with a stack trace
    // that embeds the pid-dependent temp path. Windows counts 255 UTF-16 units
    // and still succeeds. 59 emoji sanitize to 241 bytes, which keeps the
    // atomic temp name inside NAME_MAX on every host, so this case observes a
    // host-independent successful save; the sanitizer's 255-byte truncation
    // boundary is covered deterministically by probe-files-sanitize-filename.
    const longBody = JSON.stringify({ name: '🙂'.repeat(59), payload: 'utf8 truncation' });
    const arrayNameBody = JSON.stringify({ name: ['one', 'two'], payload: 'array coercion' });
    const objectNameBody = JSON.stringify({ name: { value: true }, payload: 'object coercion' });
    const invalidCharactersBody = JSON.stringify({ name: '/\\?<>:*|"', payload: 'invalid characters removed' });
    const controlCharactersBody = JSON.stringify({ name: 'control\u0000\u009fcharacters', payload: 'control characters removed' });
    const missingNameBody = '{}';
    const falsyNameBody = '{"name":0}';
    const responses = {};
    responses.unauthorizedSave = capture(await post('save', mainBody, csrfCookie));
    responses.legacySaveRedirect = capture(await legacyPost('savemovingui', mainBody));
    responses.saveMain = capture(await post('save', mainBody));
    const afterMain = movingUIFileState(movingUIRoot);
    responses.overwriteMain = capture(await post('save', overwriteBody));
    const afterOverwrite = movingUIFileState(movingUIRoot);
    responses.saveSanitized = capture(await post('save', sanitizedBody));
    responses.saveLong = capture(await post('save', longBody));
    responses.saveArrayName = capture(await post('save', arrayNameBody));
    responses.saveObjectName = capture(await post('save', objectNameBody));
    responses.saveInvalidCharacters = capture(await post('save', invalidCharactersBody));
    responses.saveControlCharacters = capture(await post('save', controlCharactersBody));
    responses.saveMissingName = capture(await post('save', missingNameBody));
    responses.saveFalsyName = capture(await post('save', falsyNameBody));
    const afterSaves = movingUIFileState(movingUIRoot);
    const accountRecordUnchanged = accountRecordBefore.equals(readFileSync(accountRecordPath));
    const roundTrip = await verifyGoMovingUIRoundTrip(origin, sessionCookie, token);
    await stopServer();

    const fixture = {
        schemaVersion: 1,
        baseline: { version: PINNED_VERSION, commit: PINNED_COMMIT },
        probe: 'pinned moving UI preset save authentication, filename sanitization, JSON formatting, and file mutation behavior',
        inputs: {
            cookieSecret: COOKIE_SECRET,
            mainBody, overwriteBody, sanitizedBody, longBody, arrayNameBody, objectNameBody,
            invalidCharactersBody, controlCharactersBody, missingNameBody, falsyNameBody,
        },
        responses,
        state: { afterMain, afterOverwrite, afterSaves, accountRecordUnchanged, roundTrip },
    };
    const outputFile = path.join(repositoryRoot, 'tests', 'oracle', 'sillytavern-1.19.0-moving-ui.json');
    mkdirSync(path.dirname(outputFile), { recursive: true });
    writeFileSync(outputFile, `${JSON.stringify(fixture, null, 2)}\n`);
    console.log(`Wrote ${path.relative(repositoryRoot, outputFile)} from pinned moving UI preset behavior`);
} catch (error) {
    console.error(error);
    process.exitCode = 1;
} finally {
    if (goChild && goChild.exitCode === null) goChild.kill();
    await stopServer();
    safeCleanup();
}
