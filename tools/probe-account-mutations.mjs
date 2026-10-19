#!/usr/bin/env node
// Capture pinned account name, avatar, and password mutation behavior.

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
const COOKIE_SECRET = 'gotavern-pinned-account-mutations-probe-secret';
const OLD_PASSWORD = 'old-user-password';
const NEW_PASSWORD = 'pa\u0301ssword';
const NEW_AVATAR = 'data:image/png;base64,AA==';
const SALT = Buffer.from('0123456789abcdef').toString('base64');
const sourceRoot = path.resolve(process.argv[2] ?? '');
const repositoryRoot = path.resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3]) {
    console.error('usage: node tools/probe-account-mutations.mjs <pinned-source-clone> <gotavern-root>');
    process.exit(2);
}
if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim() !== PINNED_COMMIT) {
    throw new Error(`upstream checkout is not pinned at ${PINNED_COMMIT}`);
}

const runtimeRoot = mkdtempSync(path.join(os.tmpdir(), 'gotavern-account-mutations-oracle-'));
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
        || !path.basename(resolved).startsWith('gotavern-account-mutations-oracle-')) {
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
    const bytes = new Uint8Array(await response.arrayBuffer());
    let parsedBody = Buffer.from(bytes).toString('utf8');
    try {
        parsedBody = parsedBody ? JSON.parse(parsedBody) : null;
    } catch {
        // Keep non-JSON response bodies as text.
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

function normalizeSetCookie(raw) {
    const [nameValue, ...attributes] = raw.split('; ');
    const separator = nameValue.indexOf('=');
    const name = nameValue.slice(0, separator).replace(/^session-[0-9a-f]{8}/, 'session-<host-hash>');
    const value = name.endsWith('.sig') ? '<signature>' : '<base64-session-json>';
    const normalizedAttributes = attributes.map(attribute => /^expires=/i.test(attribute) ? 'expires=<timestamp>' : attribute);
    return `${name}=${value}; ${normalizedAttributes.join('; ')}`;
}

function cookieHeader(cookies) {
    return cookies.map(cookie => cookie.split(';', 1)[0]).join('; ');
}

function sessionPayload(cookies) {
    const cookie = cookies.find(raw => raw.split('=', 1)[0].startsWith('session-') && !raw.split('=', 1)[0].endsWith('.sig'));
    if (!cookie) throw new Error(`session cookie missing from ${JSON.stringify(cookies)}`);
    return JSON.parse(Buffer.from(cookie.slice(cookie.indexOf('=') + 1).split(';', 1)[0], 'base64').toString('utf8'));
}

function capture(result) {
    return { status: result.response.status, headers: stableHeaders(result.response), body: result.body };
}

function seedUser(key, value) {
    const file = path.join(dataRoot, '_storage', sha256(key));
    writeFileSync(file, JSON.stringify({ key, value }));
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
        if (child.exitCode !== null) throw new Error(`pinned server exited before becoming ready:\n${logs.join('').slice(-10000)}`);
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

try {
    mkdirSync(path.join(dataRoot, '_storage'), { recursive: true });
    writeFileSync(path.join(dataRoot, 'cookie-secret.txt'), COOKIE_SECRET);
    writeFileSync(configPath, 'enableUserAccounts: true\nskipContentCheck: true\n');
    const passwordHash = scryptSync(OLD_PASSWORD.normalize(), SALT, 64).toString('base64');
    const defaultUser = {
        handle: 'default-user', name: 'Mutation Admin', created: 1700000000000,
        password: passwordHash, admin: true, enabled: true, salt: SALT,
        unknownField: { keep: ['mutation', 29, true] },
    };
    const regularUser = {
        handle: 'regular-user', name: 'Regular User', created: 1700000000001,
        password: passwordHash, admin: false, enabled: true, salt: SALT,
        unknownField: { keep: ['regular', 31, false] },
    };
    const disabledUser = {
        handle: 'disabled-user', name: 'Disabled User', created: 1700000000002,
        password: '', admin: false, enabled: false, salt: '',
    };
    seedUser('user:default-user', defaultUser);
    seedUser('user:regular-user', regularUser);
    seedUser('user:disabled-user', disabledUser);

    const port = await choosePort();
    const origin = `http://127.0.0.1:${port}`;
    startPinnedServer(port);
    await waitForServer(origin);
    const csrf = await request(`${origin}/csrf-token`);
    const token = csrf.body.token;
    const csrfCookie = cookieHeader(cookiesFrom(csrf.response));
    const post = (route, body, cookie) => request(`${origin}/api/users/${route}`, 'POST', {
        Cookie: cookie,
        'Content-Type': 'application/json',
        'X-CSRF-Token': token,
    }, JSON.stringify(body));
    const login = async (handle, password) => {
        const result = await post('login', { handle, password }, csrfCookie);
        if (result.response.status !== 200) throw new Error(`could not login ${handle}: ${result.response.status} ${JSON.stringify(result.body)}\n${logs.join('').slice(-10000)}`);
        return cookiesFrom(result.response);
    };

    const adminCookies = await login('default-user', OLD_PASSWORD);
    let adminCookie = cookieHeader(adminCookies);
    const regularCookies = await login('regular-user', OLD_PASSWORD);
    const regularCookie = cookieHeader(regularCookies);

    const missingName = await post('change-name', {}, adminCookie);
    const unauthorizedName = await post('change-name', { handle: 'default-user', name: 'Hijacked' }, regularCookie);
    const unknownName = await post('change-name', { handle: 'missing-user', name: 'No User' }, adminCookie);
    const changeName = await post('change-name', { handle: 'default-user', name: 'Renamed Mutation Admin' }, adminCookie);

    const missingAvatar = await post('change-avatar', { avatar: NEW_AVATAR }, adminCookie);
    const unauthorizedAvatar = await post('change-avatar', { handle: 'default-user', avatar: NEW_AVATAR }, regularCookie);
    const invalidAvatar = await post('change-avatar', { handle: 'default-user', avatar: 'https://example.test/avatar.png' }, adminCookie);
    const unknownAvatar = await post('change-avatar', { handle: 'missing-user', avatar: NEW_AVATAR }, adminCookie);
    const changeAvatar = await post('change-avatar', { handle: 'default-user', avatar: NEW_AVATAR }, adminCookie);

    const missingPassword = await post('change-password', {}, adminCookie);
    const unauthorizedPassword = await post('change-password', { handle: 'default-user', newPassword: 'hijacked' }, regularCookie);
    const unknownPassword = await post('change-password', { handle: 'missing-user', newPassword: 'ignored' }, adminCookie);
    const disabledPassword = await post('change-password', { handle: 'disabled-user', newPassword: 'ignored' }, adminCookie);
    const incorrectOldPassword = await post('change-password', {
        handle: 'regular-user', oldPassword: 'incorrect-password', newPassword: 'ignored',
    }, regularCookie);
    const changePassword = await post('change-password', { handle: 'default-user', newPassword: NEW_PASSWORD }, adminCookie);
    const passwordCookies = cookiesFrom(changePassword.response);
    if (passwordCookies.length) adminCookie = cookieHeader(passwordCookies);
    const updatedSession = passwordCookies.length ? sessionPayload(passwordCookies) : {};
    const profileAfterMutations = await request(`${origin}/api/users/me`, 'GET', { Cookie: adminCookie });
    const staleSessionProfile = await request(`${origin}/api/users/me`, 'GET', { Cookie: cookieHeader(adminCookies) });
    const newPasswordLogin = await post('login', { handle: 'default-user', password: NEW_PASSWORD }, csrfCookie);
    await stopServer();

    const requireFromPinned = createRequire(path.join(sourceRoot, 'package.json'));
    const storage = requireFromPinned('node-persist');
    await storage.init({ dir: path.join(dataRoot, '_storage'), ttl: false, expiredInterval: 0, writeQueue: false });
    const storedUser = await storage.getItem('user:default-user');
    const storedAvatar = await storage.getItem('avatar:default-user');
    const recordBytes = readFileSync(path.join(dataRoot, '_storage', sha256('user:default-user')));
    const avatarRecordBytes = readFileSync(path.join(dataRoot, '_storage', sha256('avatar:default-user')));
    const userRecord = JSON.parse(recordBytes.toString('utf8'));
    const avatarRecord = JSON.parse(avatarRecordBytes.toString('utf8'));
    const expectedHash = scryptSync(NEW_PASSWORD.normalize(), storedUser.salt, 64).toString('base64');
    const expectedVersion = createHash('shake256', { outputLength: 8 })
        .update(JSON.stringify([storedUser.handle, storedUser.password, storedUser.salt]))
        .digest('hex');

    const fixture = {
        schemaVersion: 1,
        baseline: { version: PINNED_VERSION, commit: PINNED_COMMIT },
        probe: 'pinned account profile mutations, authorization, password update, and session version refresh',
        inputs: {
            cookieSecret: COOKIE_SECRET, oldPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD, avatar: NEW_AVATAR,
            saltBytes: Buffer.from(SALT, 'base64').byteLength,
        },
        missingName: capture(missingName),
        unauthorizedName: capture(unauthorizedName),
        unknownName: capture(unknownName),
        changeName: capture(changeName),
        missingAvatar: capture(missingAvatar),
        unauthorizedAvatar: capture(unauthorizedAvatar),
        invalidAvatar: capture(invalidAvatar),
        unknownAvatar: capture(unknownAvatar),
        changeAvatar: capture(changeAvatar),
        missingPassword: capture(missingPassword),
        unauthorizedPassword: capture(unauthorizedPassword),
        unknownPassword: capture(unknownPassword),
        disabledPassword: capture(disabledPassword),
        incorrectOldPassword: capture(incorrectOldPassword),
        changePassword: {
            ...capture(changePassword),
            setCookie: passwordCookies.map(normalizeSetCookie),
            setCookieCount: passwordCookies.length,
            sessionHandle: updatedSession.handle,
            sessionVersionMatchesStoredAccount: updatedSession.version === expectedVersion,
            sessionCSRFTokenBytes: updatedSession.csrfToken?.length ?? 0,
        },
        profileAfterMutations: capture(profileAfterMutations),
        staleSessionProfile: {
            ...capture(staleSessionProfile),
            setCookie: cookiesFrom(staleSessionProfile.response).map(normalizeSetCookie),
            setCookieCount: cookiesFrom(staleSessionProfile.response).length,
        },
        newPasswordLogin: capture(newPasswordLogin),
        persisted: {
            userKeys: Object.keys(storedUser),
            name: storedUser.name,
            avatar: storedAvatar,
            passwordVerifies: storedUser.password === expectedHash,
            passwordHashBytes: Buffer.from(storedUser.password, 'base64').byteLength,
            saltBytes: Buffer.from(storedUser.salt, 'base64').byteLength,
            unknownField: storedUser.unknownField,
            userRecordKeys: Object.keys(userRecord),
            avatarRecordKeys: Object.keys(avatarRecord),
            avatarRecordValue: avatarRecord.value,
            ttlPresent: Object.hasOwn(userRecord, 'ttl') && userRecord.ttl !== null,
        },
    };
    if (changeName.response.status !== 204 || changeAvatar.response.status !== 204 || changePassword.response.status !== 204) {
        throw new Error(`pinned account mutation failed: name=${changeName.response.status}, avatar=${changeAvatar.response.status}, password=${changePassword.response.status}`);
    }
    if (!fixture.changePassword.sessionVersionMatchesStoredAccount || fixture.persisted.avatar !== NEW_AVATAR || !fixture.persisted.passwordVerifies) {
        throw new Error(`pinned account mutation persistence mismatch: ${JSON.stringify(fixture.persisted)}`);
    }

    const outputFile = path.join(repositoryRoot, 'tests', 'oracle', 'sillytavern-1.19.0-account-mutations.json');
    mkdirSync(path.dirname(outputFile), { recursive: true });
    writeFileSync(outputFile, `${JSON.stringify(fixture, null, 2)}\n`);
    console.log(`Wrote ${path.relative(repositoryRoot, outputFile)} from pinned account mutation routes`);
} finally {
    await stopServer();
    safeCleanup();
}
