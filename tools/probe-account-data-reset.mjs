#!/usr/bin/env node
// Capture pinned whole-user-data reset codes, throttling, and reseeding.

import { execFileSync, spawn } from 'node:child_process';
import { createHash, scryptSync } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const PINNED_COMMIT = '06bde939fb1e9c4c8d8641d810f0a916b5bce127';
const PINNED_VERSION = '1.19.0';
// @gotavern-oracle: this declaration is read by tools/build-generated-lib.mjs,
// which auto-discovers probes so that adding one needs no edit there.
// @gotavern-oracle: fixture=sillytavern-1.19.0-account-data-reset.json label="account-data-reset"
const COOKIE_SECRET = 'gotavern-pinned-account-data-reset-probe-secret';
const PASSWORD = 'account-data-reset-protected-password';
const SALT = Buffer.from('account-data-reset-salt').toString('base64');
const RESET_POINTS = 2;
const sourceRoot = path.resolve(process.argv[2] ?? '');
const repositoryRoot = path.resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3]) {
    console.error('usage: node tools/probe-account-data-reset.mjs <pinned-source-clone> <gotavern-root>');
    process.exit(2);
}
if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim() !== PINNED_COMMIT) {
    throw new Error(`upstream checkout is not pinned at ${PINNED_COMMIT}`);
}

const runtimeRoot = mkdtempSync(path.join(os.tmpdir(), 'gotavern-account-data-reset-oracle-'));
const dataRoot = path.join(runtimeRoot, 'data');
const configPath = path.join(runtimeRoot, 'config.yaml');
let logText = '';
let child;

function sha256(value) {
    return createHash('sha256').update(value).digest('hex');
}

function safeCleanup() {
    const resolved = path.resolve(runtimeRoot);
    const parent = path.resolve(os.tmpdir());
    if (path.dirname(resolved).toLowerCase() !== parent.toLowerCase()
        || !path.basename(resolved).startsWith('gotavern-account-data-reset-oracle-')) {
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
        .filter(([name]) => !['connection', 'date', 'keep-alive', 'last-modified', 'retry-after', 'set-cookie', 'x-response-time'].includes(name))
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
    const retryAfter = result.response.headers.get('retry-after');
    return {
        status: result.response.status,
        headers: stableHeaders(result.response),
        body: result.body,
        retryAfterPositive: retryAfter !== null && Number.parseInt(retryAfter, 10) > 0,
    };
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
    child.stdout.on('data', chunk => { logText += chunk; });
    child.stderr.on('data', chunk => { logText += chunk; });
}

async function waitForServer(origin) {
    const deadline = Date.now() + 180000;
    let lastError;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error(`pinned server exited before readiness:\n${logText.slice(-10000)}`);
        try {
            const result = await request(`${origin}/login?noauto=1`);
            if (result.response.status === 200 && result.response.headers.get('content-type')?.includes('text/html')) return;
            lastError = new Error(`login page returned ${result.response.status}`);
        } catch (error) {
            lastError = error;
        }
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error(`pinned server at ${origin} did not become ready: ${lastError?.stack ?? 'none'}\n${logText.slice(-10000)}`);
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

async function extractLatestCode(startAt) {
    const deadline = Date.now() + 1000;
    let found;
    while (Date.now() < deadline && !found) {
        const plain = logText.slice(startAt).replace(/\u001b\[[0-9;]*m/g, '');
        const matches = [...plain.matchAll(/your account reset code is: (\d{6})/g)];
        found = matches.at(-1)?.[1];
        if (!found) await new Promise(resolve => setTimeout(resolve, 20));
    }
    if (!found) throw new Error(`could not read six-digit reset code from pinned server output:\n${logText.slice(startAt - 500, startAt + 2000)}`);
    return found;
}

async function normalizeSettingsBackups() {
    const deadline = Date.now() + 30000;
    let pending = true;
    while (Date.now() < deadline && pending) {
        pending = ['default-user', 'guest-user'].some(handle => {
            const backupRoot = path.join(dataRoot, handle, 'backups');
            return !existsSync(backupRoot) || !readdirSync(backupRoot).some(name => name.startsWith(`settings_${handle}_`) && name.endsWith('.json'));
        });
        if (pending) await new Promise(resolve => setTimeout(resolve, 25));
    }
    if (pending) throw new Error(`settings startup backups were not created:\n${logText.slice(-5000)}`);
    for (const handle of ['default-user', 'guest-user']) {
        const backupRoot = path.join(dataRoot, handle, 'backups');
        const names = readdirSync(backupRoot).filter(name => name.startsWith(`settings_${handle}_`) && name.endsWith('.json'));
        if (names.length !== 1) throw new Error(`expected one startup settings backup for ${handle}, found ${names.join(', ')}`);
        renameSync(path.join(backupRoot, names[0]), path.join(backupRoot, `settings_${handle}_20250101-000000.json`));
    }
}

try {
    mkdirSync(path.join(dataRoot, '_storage'), { recursive: true });
    writeFileSync(path.join(dataRoot, 'cookie-secret.txt'), COOKIE_SECRET);
    writeFileSync(configPath, `enableUserAccounts: true\nskipContentCheck: false\nrateLimiting:\n  accountsResetMaxAttempts: ${RESET_POINTS}\n`);
    const passwordHash = scryptSync(PASSWORD.normalize('NFC'), SALT, 64).toString('base64');
    seedUser('user:default-user', {
        handle: 'default-user', name: 'Protected User', created: 1700000000000,
        password: passwordHash, admin: true, enabled: true, salt: SALT,
    });
    seedUser('user:guest-user', {
        handle: 'guest-user', name: 'Passwordless User', created: 1700000000001,
        password: '', admin: false, enabled: true, salt: '',
    });

    let port = await choosePort();
    let origin = `http://127.0.0.1:${port}`;
    startPinnedServer(port);
    await waitForServer(origin);
    await normalizeSettingsBackups();
    // Pin startup-only time data so full user-tree snapshots stay repeatable.
    for (const handle of ['default-user', 'guest-user']) {
        writeFileSync(path.join(dataRoot, handle, 'stats.json'), '{"timestamp":1735689600000}');
    }
    const requireFromPinned = createRequire(path.join(sourceRoot, 'package.json'));
    const storage = requireFromPinned('node-persist');
    await storage.init({ dir: path.join(dataRoot, '_storage'), ttl: false, expiredInterval: 0, writeQueue: false });
    const records = Object.fromEntries(['default-user', 'guest-user'].map(handle => [
        handle,
        readFileSync(path.join(dataRoot, '_storage', sha256(`user:${handle}`))),
    ]));

    const csrf = await request(`${origin}/csrf-token`);
    let token = csrf.body.token;
    let csrfCookie = cookieHeader(cookiesFrom(csrf.response));
    const post = (cookie, route, body) => request(`${origin}/api/users/${route}`, 'POST', {
        Cookie: cookie,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        'X-CSRF-Token': token,
    }, body === undefined ? undefined : JSON.stringify(body));
    const login = async (handle, password) => {
        const result = await request(`${origin}/api/users/login`, 'POST', {
            Cookie: csrfCookie,
            'Content-Type': 'application/json',
            'X-CSRF-Token': token,
        }, JSON.stringify({ handle, password }));
        if (result.response.status !== 200) throw new Error(`could not login ${handle}: ${result.response.status} ${JSON.stringify(result.body)}\n${logText.slice(-10000)}`);
        return cookieHeader(cookiesFrom(result.response));
    };
    const adminCookie = await login('default-user', PASSWORD);
    const guestCookie = await login('guest-user', '');
    const step1 = async cookie => {
        const startAt = logText.length;
        const response = await post(cookie, 'reset-step1');
        if (response.response.status === 204) return { response, code: await extractLatestCode(startAt) };
        return { response, code: '' };
    };
    const step2 = (cookie, body) => post(cookie, 'reset-step2', body);

    const handles = ['default-user', 'guest-user'];
    for (const handle of handles) {
        writeFileSync(path.join(dataRoot, handle, 'reset-data-probe.sentinel'), `remove:${handle}`);
        mkdirSync(path.join(dataRoot, handle, 'chats', 'reset-probe'), { recursive: true });
        writeFileSync(path.join(dataRoot, handle, 'chats', 'reset-probe', 'nested.json'), '{"remove":true}');
        writeFileSync(path.join(dataRoot, handle, 'settings.json'), JSON.stringify({ customBeforeReset: handle }));
    }

    const beforeProtectedReset = directorySnapshot(path.join(dataRoot, 'default-user'));
    const beforeGuestReset = directorySnapshot(path.join(dataRoot, 'guest-user'));
    const responses = {};
    responses.unauthorizedStep1 = capture(await post(csrfCookie, 'reset-step1'));
    responses.unauthorizedStep2 = capture(await step2(csrfCookie, { code: '246810', password: PASSWORD }));
    const firstAdminCode = await step1(adminCookie);
    responses.adminStep1 = capture(firstAdminCode.response);
    const initialCode = firstAdminCode.code;
    responses.missingCode = capture(await step2(adminCookie, { password: PASSWORD }));
    responses.missingPassword = capture(await step2(adminCookie, { code: initialCode }));
    responses.wrongPassword = capture(await step2(adminCookie, { code: initialCode, password: 'incorrect' }));
    responses.wrongCode = capture(await step2(adminCookie, { code: 'not-a-six-digit-code', password: PASSWORD }));

    const replacement = await step1(adminCookie);
    responses.adminStep1Replacement = capture(replacement.response);
    let replacementCode = replacement.code;
    while (replacementCode === initialCode) {
        const retry = await step1(adminCookie);
        replacementCode = retry.code;
    }
    responses.oldCode = capture(await step2(adminCookie, { code: initialCode, password: PASSWORD }));
    const afterProtectedFailures = directorySnapshot(path.join(dataRoot, 'default-user'));
    responses.adminSuccess = capture(await step2(adminCookie, { code: replacementCode, password: PASSWORD }));
    const afterProtectedReset = directorySnapshot(path.join(dataRoot, 'default-user'));
    responses.adminReplay = capture(await step2(adminCookie, { code: replacementCode, password: PASSWORD }));
    const afterProtectedReplay = directorySnapshot(path.join(dataRoot, 'default-user'));
    const guestAfterProtectedReset = directorySnapshot(path.join(dataRoot, 'guest-user'));

    const guestCode = await step1(guestCookie);
    responses.guestStep1 = capture(guestCode.response);
    responses.guestSuccess = capture(await step2(guestCookie, { code: guestCode.code, password: 'ignored for passwordless account' }));
    const afterGuestReset = directorySnapshot(path.join(dataRoot, 'guest-user'));

    const guestLimitedCode = await step1(guestCookie);
    responses.guestLimitedStep1 = capture(guestLimitedCode.response);
    const badAttempts = [];
    for (let attempt = 0; attempt < RESET_POINTS + 1; attempt++) {
        const response = capture(await step2(guestCookie, { code: 'not-a-six-digit-code', password: '' }));
        badAttempts.push(response);
        if (attempt === 0) responses.guestWrongCode1 = response;
        if (attempt === 1) responses.guestWrongCode2 = response;
        if (attempt === RESET_POINTS) responses.guestRateLimited = response;
    }
    responses.guestStep1RateLimited = capture((await step1(guestCookie)).response);
    const afterGuestFailures = directorySnapshot(path.join(dataRoot, 'guest-user'));
    await stopServer();

    writeFileSync(configPath, `enableUserAccounts: true\nskipContentCheck: true\nrateLimiting:\n  accountsResetMaxAttempts: ${RESET_POINTS}\n`);
    port = await choosePort();
    origin = `http://127.0.0.1:${port}`;
    startPinnedServer(port);
    await waitForServer(origin);
    const skipCSRF = await request(`${origin}/csrf-token`);
    token = skipCSRF.body.token;
    csrfCookie = cookieHeader(cookiesFrom(skipCSRF.response));
    const skipLogin = await request(`${origin}/api/users/login`, 'POST', {
        Cookie: csrfCookie,
        'Content-Type': 'application/json',
        'X-CSRF-Token': token,
    }, JSON.stringify({ handle: 'guest-user', password: '' }));
    if (skipLogin.response.status !== 200) throw new Error(`could not login after skipContentCheck restart: ${skipLogin.response.status} ${JSON.stringify(skipLogin.body)}\n${logText.slice(-10000)}`);
    const skipGuestCookie = cookieHeader(cookiesFrom(skipLogin.response));
    const skipCode = await step1(skipGuestCookie);
    responses.skipContentStep1 = capture(skipCode.response);
    responses.skipContentSuccess = capture(await step2(skipGuestCookie, { code: skipCode.code, password: '' }));
    const afterSkipContentReset = directorySnapshot(path.join(dataRoot, 'guest-user'));
    await stopServer();

    const fixture = {
        schemaVersion: 1,
        baseline: { version: PINNED_VERSION, commit: PINNED_COMMIT },
        probe: 'pinned private account reset-code, password verification, per-IP throttling, complete user-data deletion, and content reseeding',
        inputs: { cookieSecret: COOKIE_SECRET, password: PASSWORD, salt: SALT, resetPoints: RESET_POINTS },
        responses,
        filesystem: {
            beforeProtectedReset,
            beforeGuestReset,
            afterProtectedFailures,
            afterProtectedReset,
            afterProtectedReplay,
            guestAfterProtectedReset,
            afterGuestReset,
            afterGuestFailures,
            afterSkipContentReset,
            globalContent: {
                contentLog: fileSummary(path.join(dataRoot, 'content.log')),
                errors: optionalDirectorySnapshot(path.join(dataRoot, '_errors')),
                stylesheets: optionalDirectorySnapshot(path.join(dataRoot, '_css')),
            },
            accountRecordsUnchanged: {
                protectedUser: records['default-user'].equals(readFileSync(path.join(dataRoot, '_storage', sha256('user:default-user')))),
                passwordlessUser: records['guest-user'].equals(readFileSync(path.join(dataRoot, '_storage', sha256('user:guest-user')))),
            },
            resetCodeDigits: 6,
            rateLimitedAttemptCount: badAttempts.length,
        },
    };
    if (responses.guestRateLimited.status !== 429 || !responses.guestRateLimited.retryAfterPositive
        || responses.guestStep1RateLimited.status !== 429 || !responses.guestStep1RateLimited.retryAfterPositive) {
        throw new Error(`reset rate limiter did not match the pinned setup: ${JSON.stringify({ guestRateLimited: responses.guestRateLimited, guestStep1RateLimited: responses.guestStep1RateLimited })}`);
    }
    const outputFile = path.join(repositoryRoot, 'tests', 'oracle', 'sillytavern-1.19.0-account-data-reset.json');
    mkdirSync(path.dirname(outputFile), { recursive: true });
    writeFileSync(outputFile, `${JSON.stringify(fixture, null, 2)}\n`);
    console.log(`Wrote ${path.relative(repositoryRoot, outputFile)} from pinned account-reset behavior`);
} finally {
    await stopServer();
    safeCleanup();
}
