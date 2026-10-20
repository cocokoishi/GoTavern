#!/usr/bin/env node
// Capture pinned /api/groups/all, /create, /edit and /delete.
//
// Host-dependence notes:
//  - /all reports date_added/create_date from the group file's birthtimeMs,
//    which is filesystem-dependent (NTFS creation time, ext4 statx btime, 0
//    where unsupported) and cannot be seeded, so both fields are recorded as
//    markers and the Go test asserts the pinned derivation between them.
//  - /all iterates fs.readdirSync, so the recorded array is sorted.
//  - /create derives the group id and file name from Date.now(), recorded as a
//    marker.

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const PINNED_COMMIT = '06bde939fb1e9c4c8d8641d810f0a916b5bce127';
const PINNED_VERSION = '1.19.0';
const COOKIE_SECRET = 'gotavern-pinned-groups-cookie-secret';
const sourceRoot = path.resolve(process.argv[2] ?? '');
const repositoryRoot = path.resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3]) {
    console.error('usage: node tools/probe-groups.mjs <pinned-source-clone-with-dependencies> <gotavern-root>');
    process.exit(2);
}
if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim() !== PINNED_COMMIT) {
    throw new Error('upstream checkout is not pinned at ' + PINNED_COMMIT);
}

const runtimeRoot = mkdtempSync(path.join(os.tmpdir(), 'gotavern-groups-oracle-'));
const dataRoot = path.join(runtimeRoot, 'data');
const logs = [];
let child;

const NEWEST_MTIME_MS = 1700000700000;
const NOW_PATTERN = /\d{13}/g;

function sha256(value) {
    return createHash('sha256').update(value).digest('hex');
}

function safeCleanup() {
    const resolved = path.resolve(runtimeRoot);
    const parent = path.resolve(os.tmpdir());
    if (path.dirname(resolved).toLowerCase() !== parent.toLowerCase()
        || !path.basename(resolved).startsWith('gotavern-groups-oracle-')) {
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
    const text = Buffer.from(await response.arrayBuffer()).toString('utf8');
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
    return { response, body: parsedBody, bodyIsJSON, text };
}

function stableHeaders(response) {
    return Object.fromEntries([...response.headers.entries()]
        .filter(([name]) => !['connection', 'date', 'keep-alive', 'last-modified', 'set-cookie', 'x-response-time'].includes(name))
        .sort(([left], [right]) => left.localeCompare(right)));
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

function jsonl(entries) {
    return entries.map(entry => JSON.stringify(entry)).join('\n');
}

const CHAT_HEADER = { chat_metadata: { integrity: 'probe' }, user_name: 'unused', character_name: 'unused' };

const GROUP_ONE = {
    id: 'seed-group-one',
    name: 'Group One',
    members: ['Alice.png', 'Bob.png'],
    avatar_url: 'group-one.png',
    allow_self_responses: false,
    activation_strategy: 0,
    disabled_members: [],
    fav: false,
    chat_id: 'seed-group-one',
    chats: ['chat-one-a', 'chat-one-b'],
    auto_mode_delay: 5,
    generation_mode: 0,
    generation_mode_join_prefix: '',
    generation_mode_join_suffix: '',
    probeUnknownGroupField: { keep: true },
};
const GROUP_TWO = {
    id: 'seed-group-two',
    name: 'Group Two',
    members: ['Alice.png'],
    chats: ['chat-two-a'],
    chat_metadata: { deprecated: true },
    past_metadata: { deprecated: true },
};

const SEEDED_GROUP_FILES = {
    'group-one.json': { body: JSON.stringify(GROUP_ONE, null, 4) },
    'group-two.json': { body: JSON.stringify(GROUP_TWO, null, 4) },
    'notes.txt': { body: 'ignored because the extension is not .json' },
};
// Group files are seeded to a fixed mtime that is far from their creation time,
// so an implementation that reported the modification time instead of the
// pinned birthtime for date_added would be observable.
const GROUP_FILE_MTIME_MS = NEWEST_MTIME_MS - 900000;
const SEEDED_GROUP_CHAT_FILES = {
    'chat-one-a.jsonl': { body: jsonl([CHAT_HEADER, { name: 'Alice', is_user: true, send_date: '2024-05-01T00:00:00.000Z', mes: 'one a' }]), mtime: NEWEST_MTIME_MS - 1000 },
    'chat-one-b.jsonl': { body: jsonl([CHAT_HEADER, { name: 'Bob', is_user: false, send_date: '2024-05-02T00:00:00.000Z', mes: 'one b' }]), mtime: NEWEST_MTIME_MS - 2000 },
    'chat-two-a.jsonl': { body: jsonl([CHAT_HEADER, { name: 'Alice', is_user: true, send_date: '2024-05-03T00:00:00.000Z', mes: 'two a' }]), mtime: NEWEST_MTIME_MS },
    'unrelated.jsonl': { body: jsonl([CHAT_HEADER, { name: 'Nobody', is_user: true, send_date: '2024-05-04T00:00:00.000Z', mes: 'unrelated' }]), mtime: NEWEST_MTIME_MS - 3000 },
};

function normalizeGroupValue(value) {
    if (typeof value === 'string') return value.replace(NOW_PATTERN, '<nowMs>');
    if (Array.isArray(value)) return value.map(normalizeGroupValue);
    if (value && typeof value === 'object') {
        const result = {};
        for (const [key, child] of Object.entries(value)) result[key] = normalizeGroupValue(child);
        return result;
    }
    return value;
}

function normalizeGroupResponse(captured) {
    captured.body = normalizeGroupValue(captured.body);
    if (captured.bodyIsJSON) {
        captured.bodyText = JSON.stringify(captured.body);
    } else if (typeof captured.body === 'string') {
        captured.bodyText = captured.body;
    } else {
        captured.bodyText = '';
    }
    return captured;
}

// /all reports birthtime-derived fields, which cannot be seeded, so they are
// recorded as markers; every other member is recorded verbatim.
function normalizeGroupsAllBody(body) {
    return (body ?? []).map(group => {
        const copy = normalizeGroupValue(group);
        if (copy && typeof copy === 'object') {
            copy.date_added = '<birthtimeMs>';
            copy.create_date = '<birthtimeIso>';
        }
        return copy;
    });
}

function treeSnapshot(root) {
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
            const generated = NOW_PATTERN.test(name);
            NOW_PATTERN.lastIndex = 0;
            const relative = (prefix ? `${prefix}/${name}` : name).replace(NOW_PATTERN, '<nowMs>');
            if (statSync(target).isDirectory()) {
                entries.push({ path: relative, kind: 'directory' });
                walk(target, prefix ? `${prefix}/${name}` : name);
                continue;
            }
            // A file whose name carries the generated Date.now() id also embeds
            // that id in its content, so its digest cannot be reproduced; the
            // byte length is stable because Date.now() is always 13 digits.
            const digest = generated ? '<derived-from-generated-id>' : sha256(readFileSync(target));
            entries.push({ path: relative, kind: 'file', sha256: digest, bytes: statSync(target).size });
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
            handle: 'default-user', name: 'Groups Probe', created: 1700000000000,
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
    const groupsRoot = path.join(userRoot, 'groups');
    const groupChatsRoot = path.join(userRoot, 'group chats');
    mkdirSync(groupsRoot, { recursive: true });
    mkdirSync(groupChatsRoot, { recursive: true });
    for (const [name, seed] of Object.entries(SEEDED_GROUP_FILES)) {
        const target = path.join(groupsRoot, name);
        writeFileSync(target, seed.body);
        const fixed = new Date(GROUP_FILE_MTIME_MS);
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
        const result = await post(route, body);
        const captured = normalizeGroupResponse({
            status: result.response.status,
            headers: stableHeaders(result.response),
            body: result.body,
            bodyIsJSON: result.bodyIsJSON,
            bodyText: result.text,
        });
        if (options.birthtimeFields) {
            captured.body = normalizeGroupsAllBody(captured.body);
            captured.bodyText = JSON.stringify(captured.body);
        }
        scenarios[name] = {
            route,
            request: body,
            response: captured,
            groups: treeSnapshot(groupsRoot),
            groupChats: treeSnapshot(groupChatsRoot),
        };
    };
    const json = value => JSON.stringify(value);

    await runScenario('groupsAll', '/api/groups/all', '{}', { birthtimeFields: true });
    await runScenario('groupsCreate', '/api/groups/create', json({
        name: 'Created Group',
        members: ['Alice.png', 'Bob.png'],
        avatar_url: 'created.png',
        allow_self_responses: true,
        activation_strategy: 1,
        generation_mode: 2,
        disabled_members: ['Bob.png'],
        fav: true,
        auto_mode_delay: 9,
        generation_mode_join_prefix: 'pre',
        generation_mode_join_suffix: 'post',
        probeUnknownGroupField: { keep: true },
    }));
    await runScenario('groupsCreateDefaults', '/api/groups/create', json({}));
    await runScenario('groupsCreateDeprecatedKeys', '/api/groups/create', json({
        name: 'Deprecated Keys', chat_metadata: { drop: true }, past_metadata: { drop: true },
    }));
    await runScenario('groupsEdit', '/api/groups/edit', json({
        id: 'seed-group-one',
        name: 'Group One Edited',
        members: ['Alice.png'],
        chats: ['chat-one-a'],
        probeUnknownGroupField: { keep: 'edited' },
    }));
    await runScenario('groupsEditDeprecatedKeys', '/api/groups/edit', json({
        id: 'seed-group-two', name: 'Group Two', chat_metadata: { drop: true }, past_metadata: { drop: true },
    }));
    await runScenario('groupsEditNoId', '/api/groups/edit', json({ name: 'No Id' }));
    await runScenario('groupsEditForbiddenId', '/api/groups/edit', json({ id: '../escape', name: 'Escape' }));
    await runScenario('groupsDelete', '/api/groups/delete', json({ id: 'seed-group-one' }));
    await runScenario('groupsDeleteMissing', '/api/groups/delete', json({ id: '9999999999999' }));
    await runScenario('groupsDeleteNoId', '/api/groups/delete', json({}));
    await runScenario('groupsAllAfterMutations', '/api/groups/all', '{}', { birthtimeFields: true });

    const fixture = {
        schemaVersion: 1,
        baseline: { version: PINNED_VERSION, commit: PINNED_COMMIT },
        probe: 'pinned /api/groups/all, /create, /edit and /delete',
        normalization: [
            'date_added and create_date in /all come from the group file birthtime, which depends on the filesystem and cannot be seeded, so they are recorded as <birthtimeMs> and <birthtimeIso>; the Go test asserts the pinned derivation between them instead.',
            'The /all array is recorded sorted by id because pinned fs.readdirSync order is filesystem-dependent (NTFS is sorted, ext4 is not).',
            'Group ids and file names produced by Date.now() are recorded as <nowMs>, and a file whose name carries that id records its digest as <derived-from-generated-id> because the id is embedded in its content.',
            'Group chat mtimes are seeded to distinct fixed values so newest-wins comparisons are observable.',
        ],
        inputs: {
            cookieSecret: COOKIE_SECRET,
            newestMtimeMs: NEWEST_MTIME_MS,
            groupFileMtimeMs: GROUP_FILE_MTIME_MS,
            groupFiles: Object.fromEntries(Object.entries(SEEDED_GROUP_FILES).map(([key, seed]) => [key, { body: seed.body }])),
            groupChatFiles: Object.fromEntries(Object.entries(SEEDED_GROUP_CHAT_FILES).map(([key, seed]) => [key, { body: seed.body, mtime: seed.mtime }])),
        },
        scenarioOrder: Object.keys(scenarios),
        scenarios,
    };

    // /all returns fs.readdirSync order; record it sorted by id.
    for (const scenario of Object.values(scenarios)) {
        if (Array.isArray(scenario.response.body)) {
            scenario.response.body.sort((left, right) => String(left.id).localeCompare(String(right.id)));
            scenario.response.bodyText = JSON.stringify(scenario.response.body);
        }
        // The ETag digests the un-normalized bytes, so it cannot be reproduced
        // for a body carrying a generated id or a birthtime marker. A birthtime
        // value also has a variable number of fractional digits, which changes
        // the serialized length, so content-length is only asserted for bodies
        // whose only marker is the fixed-width Date.now() id.
        const text = scenario.response.bodyText ?? '';
        if (text.includes('<nowMs>') || text.includes('<birthtime')) {
            scenario.response.headers.etag = '<derived-from-normalized-body>';
        }
        if (text.includes('<birthtime')) {
            scenario.response.headers['content-length'] = '<derived-from-normalized-body>';
        }
    }

    const outputFile = path.join(repositoryRoot, 'tests', 'oracle', 'sillytavern-1.19.0-groups.json');
    mkdirSync(path.dirname(outputFile), { recursive: true });
    writeFileSync(outputFile, JSON.stringify(fixture, null, 2) + '\n');
    console.log('Wrote tests/oracle/sillytavern-1.19.0-groups.json from pinned behavior');
} catch (error) {
    console.error(error);
    process.exitCode = 1;
} finally {
    await stopServer();
    safeCleanup();
}
