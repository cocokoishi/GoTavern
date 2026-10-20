#!/usr/bin/env node
// Capture pinned chat rename/delete/export and the group-chat routes.
//
// Host-dependence notes for the recorded observations:
//  - /api/chats/group/import names the new file with humanizedDateTime(), which
//    is normalized to <humanizedDateTime> in the response and in the tree.
//  - every directory listing is sorted before it is recorded, because pinned
//    fs.readdirSync order differs between NTFS and ext4.
//  - mtimes are seeded explicitly and distinctly so max-mtime comparisons have
//    discriminating power.

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const PINNED_COMMIT = '06bde939fb1e9c4c8d8641d810f0a916b5bce127';
const PINNED_VERSION = '1.19.0';
// @gotavern-oracle: this declaration is read by tools/build-generated-lib.mjs,
// which auto-discovers probes so that adding one needs no edit there.
// @gotavern-oracle: fixture=sillytavern-1.19.0-chats-mutations.json label="chats rename/delete/export and group chats"
const COOKIE_SECRET = 'gotavern-pinned-chats-mutations-cookie-secret';
const sourceRoot = path.resolve(process.argv[2] ?? '');
const repositoryRoot = path.resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3]) {
    console.error('usage: node tools/probe-chats-mutations.mjs <pinned-source-clone-with-dependencies> <gotavern-root>');
    process.exit(2);
}
if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim() !== PINNED_COMMIT) {
    throw new Error('upstream checkout is not pinned at ' + PINNED_COMMIT);
}

const runtimeRoot = mkdtempSync(path.join(os.tmpdir(), 'gotavern-chats-mutations-oracle-'));
const dataRoot = path.join(runtimeRoot, 'data');
const logs = [];
let child;

// Distinct seeded mtimes; the newest is the recorded epoch.
const NEWEST_MTIME_MS = 1700000600000;
const HUMANIZED_PATTERN = /\d{4}-\d{2}-\d{2}@\d{2}h\d{2}m\d{2}s\d{3}ms/g;

function sha256(value) {
    return createHash('sha256').update(value).digest('hex');
}

function safeCleanup() {
    const resolved = path.resolve(runtimeRoot);
    const parent = path.resolve(os.tmpdir());
    if (path.dirname(resolved).toLowerCase() !== parent.toLowerCase()
        || !path.basename(resolved).startsWith('gotavern-chats-mutations-oracle-')) {
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
    const response = await fetch(url, { method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(30000) });
    const buffer = Buffer.from(await response.arrayBuffer());
    const text = buffer.toString('utf8');
    let parsedBody = null;
    let bodyIsJSON = false;
    if (text) {
        try {
            parsedBody = JSON.parse(text);
            bodyIsJSON = true;
        } catch {
            parsedBody = text;
        }
    }
    return { response, body: parsedBody, bodyIsJSON, buffer, text };
}

function stableHeaders(response) {
    return Object.fromEntries([...response.headers.entries()]
        .filter(([name]) => !['connection', 'date', 'keep-alive', 'last-modified', 'set-cookie', 'x-response-time'].includes(name))
        .sort(([left], [right]) => left.localeCompare(right)));
}

function capture(result) {
    return {
        status: result.response.status,
        headers: stableHeaders(result.response),
        body: result.body,
        bodyIsJSON: result.bodyIsJSON,
        bodyText: result.text,
    };
}

function cookiesFrom(response) {
    return response.headers.getSetCookie();
}

function cookieHeader(cookies) {
    return cookies.map(cookie => cookie.split(';', 1)[0]).join('; ');
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

// ---- Seeded chat content ----

function jsonl(entries) {
    return entries.map(entry => JSON.stringify(entry)).join('\n');
}

const CHAT_HEADER = { chat_metadata: { integrity: 'probe' }, user_name: 'unused', character_name: 'unused' };

const CHAT_A = jsonl([
    CHAT_HEADER,
    { name: 'Alice', is_user: true, send_date: '2024-01-01T00:00:00.000Z', mes: 'hello there' },
    { name: 'CharA', is_user: false, send_date: '2024-01-02T00:00:00.000Z', mes: 'first line\nsecond line' },
]);
const CHAT_B = jsonl([
    CHAT_HEADER,
    { name: 'CharA', is_user: false, is_system: true, send_date: '2024-02-01T00:00:00.000Z', mes: 'hidden system line' },
    { name: 'CharA', is_user: false, send_date: '2024-02-02T00:00:00.000Z', mes: 'visible line', extra: { display_text: 'displayed text' } },
    { name: 'Alice', is_user: true, send_date: '2024-02-03T00:00:00.000Z', mes: '' },
]);
const CHAT_C = jsonl([CHAT_HEADER, { name: 'CharA', is_user: false, send_date: '2024-03-01T00:00:00.000Z', mes: 'no extension chat' }]);
const GROUP_A = jsonl([CHAT_HEADER, { name: 'Alice', is_user: true, send_date: '2024-04-01T00:00:00.000Z', mes: 'group hello' }]);

const SEEDED_CHAT_FILES = {
    'CharA/chat-a.jsonl': { body: CHAT_A, mtime: NEWEST_MTIME_MS - 3000 },
    'CharA/chat-b.jsonl': { body: CHAT_B, mtime: NEWEST_MTIME_MS - 2000 },
    'CharA/chat-c.jsonl': { body: CHAT_C, mtime: NEWEST_MTIME_MS - 1000 },
    'CharA/chat-e.jsonl': { body: CHAT_C, mtime: NEWEST_MTIME_MS - 1500 },
    'CharA/notes.txt': { body: 'ignored because the extension is not .jsonl', mtime: NEWEST_MTIME_MS },
    'root-chat.jsonl': { body: CHAT_A, mtime: NEWEST_MTIME_MS - 4000 },
};
const SEEDED_GROUP_CHAT_FILES = {
    'group-a.jsonl': { body: GROUP_A, mtime: NEWEST_MTIME_MS - 5000 },
    'group-b.jsonl': { body: CHAT_B, mtime: NEWEST_MTIME_MS - 6000 },
};

function normalizeText(text) {
    return text.replace(HUMANIZED_PATTERN, '<humanizedDateTime>');
}

// Some pinned error messages echo an absolute server path (for example the
// export 404), which encodes both the data root and the host path separator.
// Any recorded string that embeds the runtime root is rewritten to a marker with
// forward slashes, so the observation does not depend on where the probe ran.
function normalizeAbsolutePaths(value) {
    if (typeof value === 'string') {
        if (!value.includes(runtimeRoot)) return value;
        return value.split(runtimeRoot).join('<runtimeRoot>').split('\\').join('/');
    }
    if (Array.isArray(value)) return value.map(normalizeAbsolutePaths);
    if (value && typeof value === 'object') {
        const result = {};
        for (const [key, child] of Object.entries(value)) result[key] = normalizeAbsolutePaths(child);
        return result;
    }
    return value;
}

function normalizeHumanized(value) {
    if (typeof value === 'string') return normalizeText(value);
    if (Array.isArray(value)) return value.map(normalizeHumanized);
    if (value && typeof value === 'object') {
        const result = {};
        for (const [key, child] of Object.entries(value)) result[key] = normalizeHumanized(child);
        return result;
    }
    return value;
}

// Applies both normalizations to a recorded response and keeps bodyText, which
// is what the Go test compares, consistent with the normalized body.
function normalizeResponse(captured) {
    captured.body = normalizeHumanized(normalizeAbsolutePaths(captured.body));
    if (captured.bodyIsJSON) {
        captured.bodyText = JSON.stringify(captured.body);
    } else if (typeof captured.body === 'string') {
        captured.bodyText = captured.body;
    } else {
        captured.bodyText = '';
    }
    return captured;
}

/** Directory walk with sorted names and humanized file names normalized. */
function treeSnapshot(root, relativeRoot) {
    const entries = [];
    const walk = (directory, prefix) => {
        let names = [];
        try {
            names = readdirSync(directory).sort();
        } catch {
            return;
        }
        for (const name of names) {
            const target = path.join(directory, name);
            const relative = normalizeText(prefix ? `${prefix}/${name}` : name);
            if (statSync(target).isDirectory()) {
                entries.push({ path: relative, kind: 'directory' });
                walk(target, prefix ? `${prefix}/${name}` : name);
                continue;
            }
            entries.push({ path: relative, kind: 'file', sha256: sha256(readFileSync(target)), bytes: statSync(target).size });
        }
    };
    walk(root, '');
    return entries;
}

try {
    mkdirSync(path.join(dataRoot, '_storage'), { recursive: true });
    writeFileSync(path.join(dataRoot, 'cookie-secret.txt'), COOKIE_SECRET);
    writeFileSync(path.join(dataRoot, '_storage', sha256('user:default-user')), JSON.stringify({
        key: 'user:default-user',
        value: {
            handle: 'default-user', name: 'Chats Mutations Probe', created: 1700000000000,
            password: '', admin: true, enabled: true, salt: '', probeUnknownField: { preserve: true },
        },
    }));

    writeFileSync(path.join(runtimeRoot, 'config.yaml'), 'enableUserAccounts: true\nskipContentCheck: true\n');
    const port = await choosePort();
    const origin = 'http://127.0.0.1:' + port;
    child = spawn(process.execPath, [
        'server.js', '--configPath', path.join(runtimeRoot, 'config.yaml'), '--dataRoot', dataRoot,
        '--listenAddressIPv4', '127.0.0.1', '--enableIPv4', 'true', '--enableIPv6', 'false',
        '--listen', 'false', '--port', String(port), '--browserLaunchEnabled', 'false', '--heartbeatInterval', '0',
    ], { cwd: sourceRoot, env: { ...process.env, NODE_ENV: 'test' }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => logs.push(chunk));
    child.stderr.on('data', chunk => logs.push(chunk));
    await waitForServer(origin);

    const csrf = await request(origin + '/csrf-token');
    const token = csrf.body.token;
    const csrfCookie = cookieHeader(cookiesFrom(csrf.response));
    const login = await request(origin + '/api/users/login', 'POST', {
        Cookie: csrfCookie, 'Content-Type': 'application/json', 'X-CSRF-Token': token,
    }, JSON.stringify({ handle: 'default-user', password: '' }));
    if (login.response.status !== 200) throw new Error('could not login: ' + login.response.status);
    const sessionCookie = cookieHeader(cookiesFrom(login.response));
    const jsonHeaders = { Cookie: sessionCookie, 'X-CSRF-Token': token, 'Content-Type': 'application/json' };
    const post = (route, body) => request(origin + route, 'POST', jsonHeaders, body);

    const userRoot = path.join(dataRoot, 'default-user');
    const chatsRoot = path.join(userRoot, 'chats');
    const groupChatsRoot = path.join(userRoot, 'group chats');
    const groupsRoot = path.join(userRoot, 'groups');
    mkdirSync(chatsRoot, { recursive: true });
    mkdirSync(groupChatsRoot, { recursive: true });
    mkdirSync(groupsRoot, { recursive: true });
    for (const [relative, seed] of Object.entries(SEEDED_CHAT_FILES)) {
        const target = path.join(chatsRoot, relative);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, seed.body);
        const fixed = new Date(seed.mtime);
        utimesSync(target, fixed, fixed);
    }
    for (const [name, seed] of Object.entries(SEEDED_GROUP_CHAT_FILES)) {
        const target = path.join(groupChatsRoot, name);
        writeFileSync(target, seed.body);
        const fixed = new Date(seed.mtime);
        utimesSync(target, fixed, fixed);
    }

    const scenarios = {};
    const runScenario = async (name, route, body, options = {}) => {
        console.error('scenario: ' + name);
        const result = options.multipart
            ? await request(origin + route, 'POST', { Cookie: sessionCookie, 'X-CSRF-Token': token }, options.multipart())
            : await post(route, body);
        scenarios[name] = {
            route,
            request: body ?? null,
            multipart: options.multipartDescription ?? null,
            response: normalizeResponse(capture(result)),
            chats: treeSnapshot(chatsRoot, 'chats'),
            groupChats: treeSnapshot(groupChatsRoot, 'group chats'),
        };
    };
    const json = value => JSON.stringify(value);

    // ---- export (before the renames and deletes so the richest chat exists) ----
    await runScenario('exportJsonl', '/api/chats/export', json({
        avatar_url: 'CharA.png', file: 'chat-a.jsonl', format: 'jsonl', exportfilename: 'out.jsonl',
    }));
    await runScenario('exportText', '/api/chats/export', json({
        avatar_url: 'CharA.png', file: 'chat-b.jsonl', format: 'text', exportfilename: 'out.txt',
    }));
    await runScenario('exportGroup', '/api/chats/export', json({
        is_group: true, file: 'group-a.jsonl', format: 'jsonl', exportfilename: 'group.jsonl',
    }));
    await runScenario('exportMissing', '/api/chats/export', json({
        avatar_url: 'CharA.png', file: 'nope.jsonl', format: 'jsonl', exportfilename: 'out.jsonl',
    }));
    await runScenario('exportNoFile', '/api/chats/export', json({ avatar_url: 'CharA.png' }));
    await runScenario('exportGroupWithoutAvatar', '/api/chats/export', json({ file: 'x.jsonl', is_group: false }));

    // ---- rename ----
    await runScenario('renameCharacter', '/api/chats/rename', json({
        avatar_url: 'CharA.png', original_file: 'chat-a.jsonl', renamed_file: 'chat-renamed.jsonl',
    }));
    await runScenario('renameGroup', '/api/chats/rename', json({
        is_group: true, original_file: 'group-a.jsonl', renamed_file: 'group-renamed.jsonl',
    }));
    await runScenario('renameSanitized', '/api/chats/rename', json({
        avatar_url: 'CharA.png', original_file: 'chat-c.jsonl', renamed_file: 'we:ird/name?.jsonl',
    }));
    await runScenario('renameMissingSource', '/api/chats/rename', json({
        avatar_url: 'CharA.png', original_file: 'nope.jsonl', renamed_file: 'whatever.jsonl',
    }));
    await runScenario('renameExistingDestination', '/api/chats/rename', json({
        avatar_url: 'CharA.png', original_file: 'notes.txt', renamed_file: 'chat-renamed.jsonl',
    }));
    await runScenario('renameMissingFields', '/api/chats/rename', json({ avatar_url: 'CharA.png' }));
    await runScenario('renameForbiddenAvatar', '/api/chats/rename', json({
        avatar_url: '../escape.png', original_file: 'chat-a.jsonl', renamed_file: 'x.jsonl',
    }));

    // ---- delete ----
    await runScenario('deleteChat', '/api/chats/delete', json({ avatar_url: 'CharA.png', chatfile: 'chat-b.jsonl' }));
    await runScenario('deleteWithoutExtension', '/api/chats/delete', json({ avatar_url: 'CharA.png', chatfile: 'chat-e' }));
    await runScenario('deleteMissing', '/api/chats/delete', json({ avatar_url: 'CharA.png', chatfile: 'nope.jsonl' }));
    await runScenario('deleteForbiddenAvatar', '/api/chats/delete', json({ avatar_url: '../x.png', chatfile: 'chat.jsonl' }));

    // ---- group chat routes ----
    await runScenario('groupGet', '/api/chats/group/get', json({ id: 'group-renamed' }));
    await runScenario('groupGetMissing', '/api/chats/group/get', json({ id: 'nope' }));
    await runScenario('groupGetNoId', '/api/chats/group/get', json({}));
    await runScenario('groupInfo', '/api/chats/group/info', json({ id: 'group-renamed' }));
    await runScenario('groupInfoMissing', '/api/chats/group/info', json({ id: 'nope' }));
    await runScenario('groupInfoNoId', '/api/chats/group/info', json({}));
    await runScenario('groupSave', '/api/chats/group/save', json({
        id: 'group-saved', chat: [{ chat_metadata: {}, user_name: 'unused', character_name: 'unused' }, { name: 'Alice', is_user: true, mes: 'saved' }],
    }));
    await runScenario('groupSaveNotArray', '/api/chats/group/save', json({ id: 'group-saved', chat: 'not an array' }));
    await runScenario('groupSaveNoId', '/api/chats/group/save', json({ chat: [] }));
    await runScenario('groupDelete', '/api/chats/group/delete', json({ id: 'group-saved' }));
    await runScenario('groupDeleteMissing', '/api/chats/group/delete', json({ id: 'nope' }));
    await runScenario('groupDeleteNoId', '/api/chats/group/delete', json({}));

    const importBody = Buffer.from(GROUP_A, 'utf8');
    await runScenario('groupImport', '/api/chats/group/import', null, {
        multipart: () => {
            const form = new FormData();
            form.set('avatar', new Blob([importBody], { type: 'application/octet-stream' }), 'imported.jsonl');
            return form;
        },
        multipartDescription: { field: 'avatar', filename: 'imported.jsonl', bytesHex: importBody.toString('hex') },
    });

    const fixture = {
        schemaVersion: 1,
        baseline: { version: PINNED_VERSION, commit: PINNED_COMMIT },
        probe: 'pinned /api/chats rename, delete, export and the group chat routes',
        normalization: [
            'File names and response fields produced by humanizedDateTime() are recorded as <humanizedDateTime>.',
            'Recorded strings that embed the probe runtime root (the export 404 message) are recorded as <runtimeRoot>/data with forward slashes.',
            'Express-derived content-length and ETag are recorded as <derived-from-normalized-body> for any response whose body carries one of those markers, because they are functions of the un-normalized bytes.',
            'Directory listings are recorded with sorted names because pinned fs.readdirSync order is filesystem-dependent (NTFS is sorted, ext4 is not).',
            'Chat file mtimes are seeded to distinct fixed values so newest-wins comparisons are observable.',
        ],
        inputs: {
            cookieSecret: COOKIE_SECRET,
            newestMtimeMs: NEWEST_MTIME_MS,
            chatFiles: Object.fromEntries(Object.entries(SEEDED_CHAT_FILES).map(([key, seed]) => [key, { body: seed.body, mtime: seed.mtime }])),
            groupChatFiles: Object.fromEntries(Object.entries(SEEDED_GROUP_CHAT_FILES).map(([key, seed]) => [key, { body: seed.body, mtime: seed.mtime }])),
        },
        scenarioOrder: Object.keys(scenarios),
        scenarios,
    };

    for (const scenario of Object.values(scenarios)) {
        const text = scenario.response.bodyText ?? '';
        if (text.includes('<humanizedDateTime>') || text.includes('<runtimeRoot>')) {
            scenario.response.headers['content-length'] = '<derived-from-normalized-body>';
            scenario.response.headers.etag = '<derived-from-normalized-body>';
        }
    }

    const outputFile = path.join(repositoryRoot, 'tests', 'oracle', 'sillytavern-1.19.0-chats-mutations.json');
    mkdirSync(path.dirname(outputFile), { recursive: true });
    writeFileSync(outputFile, JSON.stringify(fixture, null, 2) + '\n');
    console.log('Wrote tests/oracle/sillytavern-1.19.0-chats-mutations.json from pinned behavior');
} catch (error) {
    console.error(error);
    process.exitCode = 1;
} finally {
    await stopServer();
    safeCleanup();
}
