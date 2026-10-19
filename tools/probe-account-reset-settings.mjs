#!/usr/bin/env node
// Capture pinned reset-settings auth, password checks, and forced content seeding.

import { execFileSync, spawn } from 'node:child_process';
import { createHash, scryptSync } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const PINNED_COMMIT = '06bde939fb1e9c4c8d8641d810f0a916b5bce127';
const PINNED_VERSION = '1.19.0';
const COOKIE_SECRET = 'gotavern-pinned-account-reset-settings-probe-secret';
const PASSWORD = 'reset-settings-protected-password';
const SALT = Buffer.from('reset-settings-salt').toString('base64');
const sourceRoot = path.resolve(process.argv[2] ?? '');
const repositoryRoot = path.resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3]) {
    console.error('usage: node tools/probe-account-reset-settings.mjs <pinned-source-clone> <gotavern-root>');
    process.exit(2);
}
if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim() !== PINNED_COMMIT) {
    throw new Error(`upstream checkout is not pinned at ${PINNED_COMMIT}`);
}

const runtimeRoot = mkdtempSync(path.join(os.tmpdir(), 'gotavern-account-reset-settings-oracle-'));
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
        || !path.basename(resolved).startsWith('gotavern-account-reset-settings-oracle-')) {
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
        // Retain non-JSON response bodies.
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

function startPinnedServer(port) {
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

async function waitForServer(origin) {
    const deadline = Date.now() + 180000;
    let lastError;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error(`pinned server exited before readiness:\n${logs.join('').slice(-10000)}`);
        try {
            const result = await request(`${origin}/login?noauto=1`);
            if (result.response.status === 200 && result.response.headers.get('content-type')?.includes('text/html')) return;
            lastError = new Error(`login page returned ${result.response.status}`);
        } catch (error) {
            lastError = error;
        }
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error(`pinned server at ${origin} did not become ready: ${lastError?.stack ?? 'none'}\n${logs.join('').slice(-10000)}`);
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

function optionalDirectorySnapshot(root) {
    return existsSync(root) ? directorySnapshot(root) : { directories: [], files: [] };
}

function fileSummary(file) {
    if (!existsSync(file)) return null;
    const bytes = readFileSync(file);
    return { sha256: sha256(bytes), bytes: bytes.length };
}

try {
    mkdirSync(path.join(dataRoot, '_storage'), { recursive: true });
    writeFileSync(path.join(dataRoot, 'cookie-secret.txt'), COOKIE_SECRET);
    writeFileSync(configPath, 'enableUserAccounts: true\nskipContentCheck: true\n');
    const passwordHash = scryptSync(PASSWORD.normalize('NFC'), SALT, 64).toString('base64');
    seedUser('user:default-user', {
        handle: 'default-user', name: 'Protected User', created: 1700000000000,
        password: passwordHash, admin: true, enabled: true, salt: SALT,
    });
    seedUser('user:guest-user', {
        handle: 'guest-user', name: 'Passwordless User', created: 1700000000001,
        password: '', admin: false, enabled: true, salt: '',
    });

    const port = await choosePort();
    const origin = `http://127.0.0.1:${port}`;
    startPinnedServer(port);
    await waitForServer(origin);
    // The route must preserve unrelated startup data. Pin the timestamp so
    // filesystem snapshots remain deterministic across oracle rebuilds.
    for (const handle of ['default-user', 'guest-user']) {
        writeFileSync(path.join(dataRoot, handle, 'stats.json'), '{"timestamp":1735689600000}');
    }
    const requireFromPinned = createRequire(path.join(sourceRoot, 'package.json'));
    const storage = requireFromPinned('node-persist');
    await storage.init({ dir: path.join(dataRoot, '_storage'), ttl: false, expiredInterval: 0, writeQueue: false });
    const adminRecordPath = path.join(dataRoot, '_storage', sha256('user:default-user'));
    const guestRecordPath = path.join(dataRoot, '_storage', sha256('user:guest-user'));
    const initialAdminRecord = readFileSync(adminRecordPath);
    const initialGuestRecord = readFileSync(guestRecordPath);

    const csrf = await request(`${origin}/csrf-token`);
    const token = csrf.body.token;
    const csrfCookie = cookieHeader(cookiesFrom(csrf.response));
    const post = (cookie, body = {}) => request(`${origin}/api/users/reset-settings`, 'POST', {
        Cookie: cookie,
        'Content-Type': 'application/json',
        'X-CSRF-Token': token,
    }, JSON.stringify(body));
    const login = async (handle, password) => {
        const result = await request(`${origin}/api/users/login`, 'POST', {
            Cookie: csrfCookie,
            'Content-Type': 'application/json',
            'X-CSRF-Token': token,
        }, JSON.stringify({ handle, password }));
        if (result.response.status !== 200) throw new Error(`could not login ${handle}: ${result.response.status} ${JSON.stringify(result.body)}\n${logs.join('').slice(-10000)}`);
        return cookieHeader(cookiesFrom(result.response));
    };
    const adminCookie = await login('default-user', PASSWORD);
    const guestCookie = await login('guest-user', '');

    const settingsPath = handle => path.join(dataRoot, handle, 'settings.json');
    const sentinelPath = handle => path.join(dataRoot, handle, 'reset-settings-probe.sentinel');
    const customSettings = handle => Buffer.from(JSON.stringify({ probe: 'preserve until successful reset', handle, nested: [1, true] }));
    for (const handle of ['default-user', 'guest-user']) {
        writeFileSync(settingsPath(handle), customSettings(handle));
        writeFileSync(sentinelPath(handle), `keep:${handle}`);
    }

    const responses = {
        unauthorized: capture(await post(csrfCookie, {})),
        missingPassword: capture(await post(adminCookie, {})),
        wrongPassword: capture(await post(adminCookie, { password: 'incorrect' })),
        nonStringPassword: capture(await post(adminCookie, { password: 7 })),
    };
    const afterFailedAttempts = {
        protectedSettings: fileSummary(settingsPath('default-user')),
        passwordlessSettings: fileSummary(settingsPath('guest-user')),
        globalContentLogExists: existsSync(path.join(dataRoot, 'content.log')),
    };
    responses.protectedReset = capture(await post(adminCookie, { password: PASSWORD }));
    const afterProtectedReset = directorySnapshot(path.join(dataRoot, 'default-user'));
    writeFileSync(settingsPath('default-user'), customSettings('default-user'));
    responses.protectedResetAgain = capture(await post(adminCookie, { password: PASSWORD }));
    const afterProtectedResetAgain = directorySnapshot(path.join(dataRoot, 'default-user'));
    writeFileSync(settingsPath('guest-user'), customSettings('guest-user'));
    responses.passwordlessReset = capture(await post(guestCookie, { password: 'ignored' }));
    const afterPasswordlessReset = directorySnapshot(path.join(dataRoot, 'guest-user'));
    rmSync(settingsPath('guest-user'));
    responses.passwordlessResetMissingFile = capture(await post(guestCookie, {}));
    const afterPasswordlessResetMissingFile = directorySnapshot(path.join(dataRoot, 'guest-user'));
    await stopServer();

    const fixture = {
        schemaVersion: 1,
        baseline: { version: PINNED_VERSION, commit: PINNED_COMMIT },
        probe: 'pinned private reset-settings route authentication, password verification, forced settings reset, and default-content seeding',
        inputs: { cookieSecret: COOKIE_SECRET, password: PASSWORD, salt: SALT },
        responses,
        filesystem: {
            customSettingsSHA256: sha256(customSettings('default-user')),
            customSettingsBytes: customSettings('default-user').length,
            afterFailedAttempts,
            afterProtectedReset,
            afterProtectedResetAgain,
            afterPasswordlessReset,
            afterPasswordlessResetMissingFile,
            globalContent: {
                contentLog: fileSummary(path.join(dataRoot, 'content.log')),
                errors: optionalDirectorySnapshot(path.join(dataRoot, '_errors')),
                stylesheets: optionalDirectorySnapshot(path.join(dataRoot, '_css')),
            },
            accountRecordsUnchanged: {
                protectedUser: initialAdminRecord.equals(readFileSync(adminRecordPath)),
                passwordlessUser: initialGuestRecord.equals(readFileSync(guestRecordPath)),
            },
        },
    };
    if (afterFailedAttempts.protectedSettings.sha256 !== fixture.filesystem.customSettingsSHA256
        || afterFailedAttempts.passwordlessSettings.sha256 !== sha256(customSettings('guest-user'))
        || afterFailedAttempts.globalContentLogExists) {
        throw new Error(`failed reset attempts changed settings data: ${JSON.stringify(afterFailedAttempts)}`);
    }
    const outputFile = path.join(repositoryRoot, 'tests', 'oracle', 'sillytavern-1.19.0-account-reset-settings.json');
    mkdirSync(path.dirname(outputFile), { recursive: true });
    writeFileSync(outputFile, `${JSON.stringify(fixture, null, 2)}\n`);
    console.log(`Wrote ${path.relative(repositoryRoot, outputFile)} from pinned reset-settings behavior`);
} finally {
    await stopServer();
    safeCleanup();
}
