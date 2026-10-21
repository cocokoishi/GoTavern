#!/usr/bin/env node
// Capture the pinned persona-avatar data URL: GET /api/users/me returns
//
//	{ handle, name, avatar, admin, password, created }
//
// where `avatar` is built by getUserAvatar (src/users.js:704-733) as
//
//	const mimeType = mime.lookup(avatarPath);            // :726
//	const base64Content = fs.readFileSync(avatarPath, 'base64');
//	return `data:${mimeType};base64,${base64Content}`;  // :728
//
// `mime` there is mime-types (src/users.js:12). That is a DIFFERENT pinned table
// from the mime@1.6.0 one every static path uses, and the two disagree, so this
// probe exists to make the difference observable: .avif and .heic resolve only
// through mime-types, mime-types appends no charset even for application/json,
// and an unknown extension makes mime.lookup return false, which the template
// literal interpolates as the literal string "false".
//
// Every avatar file is seeded with fixed bytes, so the recorded data URL is a
// property of the fixture rather than of the recording host.

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const PINNED_COMMIT = '06bde939fb1e9c4c8d8641d810f0a916b5bce127';
const PINNED_VERSION = '1.19.0';
// @gotavern-oracle: fixture=sillytavern-1.19.0-user-avatar-data-url.json label="persona-avatar data URL media type"
const COOKIE_SECRET = 'gotavern-pinned-user-avatar-cookie-secret';

const sourceRoot = path.resolve(process.argv[2] ?? '');
const repositoryRoot = path.resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3]) {
    console.error('usage: node tools/probe-user-avatar-data-url.mjs <pinned-source-clone> <gotavern-root>');
    process.exit(2);
}
if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim() !== PINNED_COMMIT) {
    throw new Error(`upstream checkout is not pinned at ${PINNED_COMMIT}`);
}

const runtimeRoot = mkdtempSync(path.join(os.tmpdir(), 'gotavern-user-avatar-'));
const dataRoot = path.join(runtimeRoot, 'data');
const configPath = path.join(runtimeRoot, 'config.yaml');
const logs = [];
let child;

function safeCleanup() {
    const resolved = path.resolve(runtimeRoot);
    const parent = path.resolve(os.tmpdir());
    if (path.dirname(resolved).toLowerCase() !== parent.toLowerCase()
        || !path.basename(resolved).startsWith('gotavern-user-avatar-')) {
        throw new Error(`refusing to remove unexpected runtime path: ${resolved}`);
    }
    rmSync(resolved, { recursive: true, force: true });
}

function rawRequest(origin, { method = 'GET', path: requestPath, headers = {}, body = null }) {
    const target = new URL(origin);
    return new Promise((resolve, reject) => {
        const request = http.request({
            host: target.hostname,
            port: target.port,
            method,
            path: requestPath,
            agent: false,
            headers: { 'Accept-Encoding': 'identity', ...headers },
        }, response => {
            const chunks = [];
            response.on('data', chunk => chunks.push(chunk));
            response.on('end', () => resolve({
                status: response.statusCode,
                headers: response.headers,
                body: Buffer.concat(chunks),
            }));
        });
        request.on('error', reject);
        request.end(body === null ? undefined : body);
    });
}

function cookiesFrom(headers) {
    const raw = headers['set-cookie'];
    if (!raw) return [];
    return Array.isArray(raw) ? raw : [raw];
}

function cookieHeader(cookies) {
    return cookies.map(cookie => cookie.split(';', 1)[0]).join('; ');
}

function sha256(value) {
    return createHash('sha256').update(value).digest('hex');
}

function seedUser(key, value) {
    writeFileSync(path.join(dataRoot, '_storage', sha256(key)), JSON.stringify({ key, value }));
}

async function waitForServer(origin) {
    const deadline = Date.now() + 180000;
    let lastError;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error(`pinned server exited before readiness:\n${logs.join('').slice(-10000)}`);
        try {
            const result = await rawRequest(origin, { path: '/login?noauto=1' });
            if (result.status === 200 && String(result.headers['content-type'] ?? '').includes('text/html')) return;
            lastError = new Error(`login returned ${result.status}`);
        } catch (error) {
            lastError = error;
        }
        await new Promise(resolve => setTimeout(resolve, 300));
    }
    throw new Error(`pinned server did not become ready: ${lastError?.stack ?? 'none'}\n${logs.join('').slice(-10000)}`);
}

async function stopServer() {
    if (!child || child.exitCode === null) return;
    child.kill('SIGINT');
    await Promise.race([
        new Promise(resolve => child.once('exit', resolve)),
        new Promise(resolve => setTimeout(resolve, 5000)),
    ]);
    if (child.exitCode === null) child.kill();
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

async function login(origin, handle) {
    const csrf = await rawRequest(origin, { path: '/csrf-token' });
    const token = JSON.parse(csrf.body.toString('utf8')).token;
    const csrfCookie = cookieHeader(cookiesFrom(csrf.headers));
    const body = JSON.stringify({ handle, password: '' });
    const result = await rawRequest(origin, {
        method: 'POST',
        path: '/api/users/login',
        headers: { Cookie: csrfCookie, 'Content-Type': 'application/json', 'X-CSRF-Token': token, 'Content-Length': Buffer.byteLength(body) },
        body,
    });
    if (result.status !== 200) {
        throw new Error(`could not login as ${handle}: ${result.status} ${result.body.toString('utf8')}\n${logs.join('').slice(-10000)}`);
    }
    return { cookie: cookieHeader(cookiesFrom(result.headers)) };
}

// One distinct byte pattern per avatar so a fixture that mixed two cases up
// would be visible in the recorded base64 rather than silently identical.
const AVATAR_FILES = {
    'probe.avif': Buffer.from('avatar-avif-bytes', 'utf8'),
    'probe.heic': Buffer.from('avatar-heic-bytes', 'utf8'),
    'probe.json': Buffer.from('{"avatar":"json"}', 'utf8'),
    'probe.png': Buffer.from('avatar-png-bytes', 'utf8'),
    'probe.zzz': Buffer.from('avatar-unknown-extension-bytes', 'utf8'),
};

try {
    mkdirSync(path.join(dataRoot, '_storage'), { recursive: true });
    writeFileSync(path.join(dataRoot, 'cookie-secret.txt'), COOKIE_SECRET);
    seedUser('user:default-user', {
        handle: 'default-user', name: 'Avatar Probe', created: 1700000000000,
        password: '', admin: true, enabled: true, salt: '',
    });

    const port = await choosePort();
    const origin = `http://127.0.0.1:${port}`;
    writeFileSync(configPath, 'enableUserAccounts: true\nskipContentCheck: true\n');
    child = spawn(process.execPath, [
        path.join(sourceRoot, 'server.js'),
        '--configPath', configPath, '--dataRoot', dataRoot,
        '--listenAddressIPv4', '127.0.0.1', '--enableIPv4', 'true', '--enableIPv6', 'false',
        '--listen', 'false', '--port', String(port), '--browserLaunchEnabled', 'false', '--heartbeatInterval', '0',
    ], { cwd: sourceRoot, env: { ...process.env, NODE_ENV: 'test' }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => logs.push(chunk));
    child.stderr.on('data', chunk => logs.push(chunk));
    await waitForServer(origin);

    const userRoot = path.join(dataRoot, 'default-user');
    const avatarsRoot = path.join(userRoot, 'User Avatars');
    mkdirSync(avatarsRoot, { recursive: true });
    for (const [name, content] of Object.entries(AVATAR_FILES)) {
        writeFileSync(path.join(avatarsRoot, name), content);
    }

    const admin = await login(origin, 'default-user');
    const authed = { Cookie: admin.cookie };

    const responses = {};
    const record = async (label, persona) => {
        // getUserAvatar reads settings.power_user.default_persona, then
        // settings.user_avatar, then the avatars directory.
        writeFileSync(path.join(userRoot, 'settings.json'), JSON.stringify({ power_user: { default_persona: persona }, user_avatar: persona }));
        const result = await rawRequest(origin, { path: '/api/users/me', headers: authed });
        const parsed = JSON.parse(result.body.toString('utf8'));
        responses[label] = { status: result.status, avatar: parsed.avatar };
    };

    for (const name of Object.keys(AVATAR_FILES)) {
        await record(name.replace('.', '_'), name);
    }
    // A persona whose file does not exist falls back to the public default.
    await record('missing_file', 'probe-missing.avif');
    // No usable persona at all falls back the same way.
    writeFileSync(path.join(userRoot, 'settings.json'), JSON.stringify({}));
    {
        const result = await rawRequest(origin, { path: '/api/users/me', headers: authed });
        responses.no_persona = { status: result.status, avatar: JSON.parse(result.body.toString('utf8')).avatar };
    }

    // ---- self-checks ------------------------------------------------------
    // The four cases the table choice actually distinguishes must differ from
    // one another, or the fixture would pass against either table.
    const avatarFor = label => responses[label].avatar ?? '';
    const distinct = new Set([avatarFor('probe_avif'), avatarFor('probe_heic'), avatarFor('probe_json'), avatarFor('probe_zzz')]);
    if (distinct.size !== 4) {
        throw new Error('the four discriminating avatar cases are not distinct, so the fixture could not discriminate the tables');
    }
    if (!avatarFor('probe_avif').startsWith('data:image/avif;base64,')) {
        throw new Error(`mime-types did not resolve .avif through the pinned avatar path: ${avatarFor('probe_avif').slice(0, 60)}`);
    }
    if (!avatarFor('probe_json').startsWith('data:application/json;base64,')) {
        throw new Error(`the avatar path appended a charset or the wrong type for .json: ${avatarFor('probe_json').slice(0, 60)}`);
    }
    if (!avatarFor('probe_zzz').startsWith('data:false;base64,')) {
        throw new Error(`an unknown extension did not interpolate mime.lookup's false: ${avatarFor('probe_zzz').slice(0, 60)}`);
    }
    if (!avatarFor('probe_png').startsWith('data:image/png;base64,')) {
        throw new Error(`the control case did not resolve .png: ${avatarFor('probe_png').slice(0, 60)}`);
    }
    if (responses.missing_file.avatar !== '/img/default-user.png' || responses.no_persona.avatar !== '/img/default-user.png') {
        throw new Error('the fallback path did not answer /img/default-user.png');
    }

    const fixture = {
        schemaVersion: 1,
        baseline: { version: PINNED_VERSION, commit: PINNED_COMMIT },
        probe: 'pinned persona-avatar data URL: GET /api/users/me avatar field resolved through mime-types (src/users.js:12,726) rather than the mime@1.6.0 table the static paths use, including the template literal interpolation of mime.lookup\'s false',
        normalizations: [
            'Every avatar file is seeded with fixed bytes, so the recorded data URL base64 is a property of the fixture rather than of the recording host.',
            'Only the avatar field is recorded. The same response also carries handle, name, admin, password and created, which are covered by the account routes.',
        ],
        gaps: [
            'Until this probe existed the path had no oracle at all: be12d79 changed it to the mime@1.6.0 table and nothing could fail, which is why the regression reached main unnoticed.',
            'An avatar filename whose sanitized form differs from the request (characters removed by sanitize-filename) is not probed.',
        ],
        inputs: {
            cookieSecret: COOKIE_SECRET,
            seededUsers: [
                { handle: 'default-user', name: 'Avatar Probe', created: 1700000000000, password: '', admin: true, enabled: true, salt: '' },
            ],
            avatarFiles: Object.fromEntries(Object.entries(AVATAR_FILES).map(([name, content]) => [name, content.toString('base64')])),
        },
        responses,
    };
    const outputFile = path.join(repositoryRoot, 'tests', 'oracle', 'sillytavern-1.19.0-user-avatar-data-url.json');
    mkdirSync(path.dirname(outputFile), { recursive: true });
    writeFileSync(outputFile, `${JSON.stringify(fixture, null, 2)}\n`);
    console.log(`Wrote ${path.relative(repositoryRoot, outputFile)} from pinned persona-avatar data URL behavior`);
} catch (error) {
    console.error(error);
    process.exitCode = 1;
} finally {
    await stopServer();
    safeCleanup();
}
