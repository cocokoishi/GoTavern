#!/usr/bin/env node
// Capture pinned settings aggregation and request-compression config behavior.

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const PINNED_COMMIT = '06bde939fb1e9c4c8d8641d810f0a916b5bce127';
const PINNED_VERSION = '1.19.0';
const COOKIE_SECRET = 'gotavern-pinned-settings-get-cookie-secret';
const sourceRoot = path.resolve(process.argv[2] ?? '');
const repositoryRoot = path.resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3]) {
    console.error('usage: node tools/probe-settings-get.mjs <pinned-source-clone> <gotavern-root>');
    process.exit(2);
}
if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim() !== PINNED_COMMIT) {
    throw new Error(`upstream checkout is not pinned at ${PINNED_COMMIT}`);
}

const runtimeRoot = mkdtempSync(path.join(os.tmpdir(), 'gotavern-settings-get-oracle-'));
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
        || !path.basename(resolved).startsWith('gotavern-settings-get-oracle-')) {
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

function directorySnapshot(root) {
    const directories = [];
    const files = [];
    function visit(current, relative = '') {
        for (const name of readdirSync(current).sort()) {
            const absolute = path.join(current, name);
            const childRelative = relative ? `${relative}/${name}` : name;
            const info = statSync(absolute);
            if (info.isDirectory()) {
                directories.push(childRelative);
                visit(absolute, childRelative);
            } else if (info.isFile()) {
                const bytes = readFileSync(absolute);
                files.push({ path: childRelative, sha256: sha256(bytes), bytes: bytes.length });
            }
        }
    }
    visit(root);
    return { directories, files };
}

try {
    mkdirSync(path.join(dataRoot, '_storage'), { recursive: true });
    writeFileSync(path.join(dataRoot, 'cookie-secret.txt'), COOKIE_SECRET);
    writeFileSync(configPath, `enableUserAccounts: true\nskipContentCheck: true\nextensions:\n  enabled: false\n  autoUpdate: false\nperformance:\n  requestCompression:\n    enabled: true\n    minPayloadSize: 1.5kb\n    maxPayloadSize: 3.5mb\n    timeout: 1234.5\n`);
    seedUser('user:default-user', {
        handle: 'default-user', name: 'Settings Reader', created: 1700000000000,
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
    const directoryNames = [
        'worlds', 'NovelAI Settings', 'OpenAI Settings', 'TextGen Settings', 'KoboldAI Settings',
        'themes', 'movingUI', 'QuickReplies', 'instruct', 'context', 'sysprompt', 'reasoning',
    ];
    for (const name of directoryNames) {
        rmSync(path.join(userRoot, name), { recursive: true, force: true });
        mkdirSync(path.join(userRoot, name), { recursive: true });
    }

    const write = (directory, name, contents) => writeFileSync(path.join(userRoot, directory, name), contents);
    write('', 'settings.json', '{"settings":"exact raw settings","unknown":{"keep":true}}\n');
    write('OpenAI Settings', 'alpha.json', '{\n  "marker": "openai alpha",\n  "nested": { "value": 1 }\n}\n');
    write('OpenAI Settings', 'beta.json', '{"marker":"openai beta"}');
    write('OpenAI Settings', 'invalid.json', '{not valid json');
    write('OpenAI Settings', 'ignored.JSON', '{"marker":"uppercase extension"}');
    write('NovelAI Settings', 'novel.json', '{"marker":"novel preset"}');
    write('KoboldAI Settings', 'kobold.json', '{"marker":"kobold preset"}');
    write('TextGen Settings', 'textgen.json', '{"marker":"textgen preset"}');
    write('worlds', 'alpha.json', 'not parsed by settings/get');
    write('worlds', 'beta.JSON', 'also not parsed');
    write('worlds', 'ignored.txt', 'ignored');
    write('themes', 'dark.json', '{ "name": "dark", "colors": ["black", "white"] }');
    write('themes', 'invalid.json', '{bad');
    write('themes', 'ignored.JSON', '{"name":"ignored"}');
    write('movingUI', 'layout.json', '{"layout":"compact"}');
    write('QuickReplies', 'quick.json', '[{"label":"hello"}]');
    write('instruct', 'template.json', '{ "name": "chat", "input": "{{prompt}}" }');
    write('context', 'context.json', '{"name":"default context"}');
    write('sysprompt', 'system.json', '{"name":"system"}');
    write('reasoning', 'reasoning.json', '{"name":"reasoning"}');

    const accountRecordPath = path.join(dataRoot, '_storage', sha256('user:default-user'));
    const accountRecordBefore = readFileSync(accountRecordPath);
    const userTreeBefore = directorySnapshot(userRoot);
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
    const post = (cookie = sessionCookie) => request(`${origin}/api/settings/get`, 'POST', {
        Cookie: cookie,
        'Content-Type': 'application/json',
        'X-CSRF-Token': token,
    }, '{}');

    const unauthorized = capture(await post(csrfCookie));
    const settings = capture(await post());
    const userTreeAfter = directorySnapshot(userRoot);
    const accountRecordUnchanged = accountRecordBefore.equals(readFileSync(accountRecordPath));
    const filesystemUnchanged = JSON.stringify(userTreeBefore) === JSON.stringify(userTreeAfter);
    rmSync(path.join(userRoot, 'settings.json'));
    const missingSettings = capture(await post());
    await stopServer();

    const fixture = {
        schemaVersion: 1,
        baseline: { version: PINNED_VERSION, commit: PINNED_COMMIT },
        probe: 'pinned private settings aggregation, preset parsing/order, and request-compression configuration',
        inputs: { cookieSecret: COOKIE_SECRET },
        responses: { unauthorized, settings, missingSettings },
        state: { filesystemUnchanged, accountRecordUnchanged },
    };
    const outputFile = path.join(repositoryRoot, 'tests', 'oracle', 'sillytavern-1.19.0-settings-get.json');
    mkdirSync(path.dirname(outputFile), { recursive: true });
    writeFileSync(outputFile, `${JSON.stringify(fixture, null, 2)}\n`);
    console.log(`Wrote ${path.relative(repositoryRoot, outputFile)} from pinned settings aggregation behavior`);
} catch (error) {
    console.error(error);
    process.exitCode = 1;
} finally {
    await stopServer();
    safeCleanup();
}
