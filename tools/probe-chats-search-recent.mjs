#!/usr/bin/env node
// Capture pinned /api/chats/search and /api/chats/recent.
//
// Host-dependence and timing notes:
//  - both routes enumerate directories with fs.readdirSync, so the recorded
//    result arrays are sorted before they are written;
//  - /recent orders by mtime, so every seeded chat file gets a DISTINCT mtime;
//    equal mtimes would leave the order to the collectors' insertion order,
//    which is nondeterministic because the three collectors run concurrently;
//  - no generated ids or timestamps are involved in these two routes.

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const PINNED_COMMIT = '06bde939fb1e9c4c8d8641d810f0a916b5bce127';
const PINNED_VERSION = '1.19.0';
// @gotavern-oracle: this declaration is read by tools/build-generated-lib.mjs,
// which auto-discovers probes so that adding one needs no edit there.
// @gotavern-oracle: fixture=sillytavern-1.19.0-chats-search-recent.json label="chats search and recent"
const COOKIE_SECRET = 'gotavern-pinned-chats-search-recent-cookie-secret';
const sourceRoot = path.resolve(process.argv[2] ?? '');
const repositoryRoot = path.resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3]) {
    console.error('usage: node tools/probe-chats-search-recent.mjs <pinned-source-clone-with-dependencies> <gotavern-root>');
    process.exit(2);
}
if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim() !== PINNED_COMMIT) {
    throw new Error('upstream checkout is not pinned at ' + PINNED_COMMIT);
}

const runtimeRoot = mkdtempSync(path.join(os.tmpdir(), 'gotavern-chats-search-recent-oracle-'));
const dataRoot = path.join(runtimeRoot, 'data');
const logs = [];
let child;

// Distinct mtimes, newest first in creation order of this table.
const NEWEST_MTIME_MS = 1700000800000;

function sha256(value) {
    return createHash('sha256').update(value).digest('hex');
}

function safeCleanup() {
    const resolved = path.resolve(runtimeRoot);
    const parent = path.resolve(os.tmpdir());
    if (path.dirname(resolved).toLowerCase() !== parent.toLowerCase()
        || !path.basename(resolved).startsWith('gotavern-chats-search-recent-oracle-')) {
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

function jsonl(entries) {
    return entries.map(entry => JSON.stringify(entry)).join('\n');
}

const HEADER = { chat_metadata: { integrity: 'probe' }, user_name: 'unused', character_name: 'unused' };
const LONG_MESSAGE = 'tail-marker ' + 'x'.repeat(420);

const CHAT_FILES = {
    'Alice/chat-one.jsonl': {
        body: jsonl([HEADER, { name: 'Alice', is_user: true, send_date: '2024-06-01T00:00:00.000Z', mes: 'hello world from alice' }]),
        mtime: NEWEST_MTIME_MS,
    },
    'Alice/chat-two.jsonl': {
        body: jsonl([HEADER, { name: 'Alice', is_user: false, send_date: '2024-06-02T00:00:00.000Z', mes: 'a different topic' }, { name: 'Alice', is_user: true, send_date: '2024-06-03T00:00:00.000Z', mes: LONG_MESSAGE }]),
        mtime: NEWEST_MTIME_MS - 1000,
    },
    'Alice/notes.txt': { body: 'ignored because the extension is not .jsonl', mtime: NEWEST_MTIME_MS - 2000 },
    'Bob/chat-three.jsonl': {
        body: jsonl([HEADER, { name: 'Bob', is_user: false, send_date: '2024-06-04T00:00:00.000Z', mes: 'bob says hello' }]),
        mtime: NEWEST_MTIME_MS - 3000,
    },
    'root-one.jsonl': {
        body: jsonl([HEADER, { name: 'Root', is_user: true, send_date: '2024-06-05T00:00:00.000Z', mes: 'root chat message' }]),
        mtime: NEWEST_MTIME_MS - 4000,
    },
};
const GROUP_CHAT_FILES = {
    'group-chat-a.jsonl': {
        body: jsonl([HEADER, { name: 'Alice', is_user: true, send_date: '2024-06-06T00:00:00.000Z', mes: 'group chat message' }]),
        mtime: NEWEST_MTIME_MS - 5000,
    },
};
const GROUP_FILES = {
    'search-group.json': JSON.stringify({ id: 'seed-group-search', name: 'Search Group', chats: ['group-chat-a'], members: [] }, null, 4),
    'no-chats-group.json': JSON.stringify({ id: 'seed-group-no-chats', name: 'No Chats', members: [] }, null, 4),
};
// /recent lists character cards by filename only, so any .png works.
const CARD_FILES = { 'Alice.png': 'card bytes', 'Bob.png': 'card bytes' };

function sortByKeys(entries, keys) {
    return [...entries].sort((left, right) => {
        for (const key of keys) {
            const leftValue = String(left[key] ?? '');
            const rightValue = String(right[key] ?? '');
            if (leftValue !== rightValue) return leftValue < rightValue ? -1 : 1;
        }
        return 0;
    });
}

try {
    mkdirSync(path.join(dataRoot, '_storage'), { recursive: true });
    writeFileSync(path.join(dataRoot, 'cookie-secret.txt'), COOKIE_SECRET);
    writeFileSync(path.join(dataRoot, '_storage', sha256('user:default-user')), JSON.stringify({
        key: 'user:default-user',
        value: {
            handle: 'default-user', name: 'Chats Search Recent Probe', created: 1700000000000,
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
    for (const [relative, seed] of Object.entries(CHAT_FILES)) {
        const target = path.join(userRoot, 'chats', relative);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, seed.body);
        const fixed = new Date(seed.mtime);
        utimesSync(target, fixed, fixed);
    }
    for (const [name, seed] of Object.entries(GROUP_CHAT_FILES)) {
        const target = path.join(userRoot, 'group chats', name);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, seed.body);
        const fixed = new Date(seed.mtime);
        utimesSync(target, fixed, fixed);
    }
    for (const [name, body] of Object.entries(GROUP_FILES)) {
        writeFileSync(path.join(userRoot, 'groups', name), body);
    }
    for (const [name, body] of Object.entries(CARD_FILES)) {
        writeFileSync(path.join(userRoot, 'characters', name), body);
    }

    const scenarios = {};
    const runScenario = async (name, route, body, options = {}) => {
        console.error('scenario: ' + name);
        const result = await post(route, body);
        const captured = capture(result);
        // /search returns readdirSync order, which is filesystem-dependent, so
        // it is recorded sorted. /recent orders by mtime and its seeded mtimes
        // are distinct, so its order is deterministic and is recorded as-is:
        // sorting it would throw away the ordering assertion entirely.
        if (Array.isArray(captured.body) && route === '/api/chats/search') {
            captured.body = sortByKeys(captured.body, options.sortKeys ?? ['file_name']);
            captured.bodyText = JSON.stringify(captured.body);
        }
        scenarios[name] = { route, request: body, response: captured };
    };
    const json = value => JSON.stringify(value);

    await runScenario('searchByAvatar', '/api/chats/search', json({ avatar_url: 'Alice.png', query: 'hello' }));
    await runScenario('searchNoQuery', '/api/chats/search', json({ avatar_url: 'Alice.png' }));
    await runScenario('searchMultiFragment', '/api/chats/search', json({ avatar_url: 'Alice.png', query: 'hello world' }));
    // One fragment matches only chat-one and the other only chat-two, so this
    // distinguishes the pinned "every fragment must match somewhere in the chat"
    // rule from an "any fragment" implementation.
    await runScenario('searchFragmentsMustAllMatch', '/api/chats/search', json({ avatar_url: 'Alice.png', query: 'hello topic' }));
    await runScenario('searchMixedCase', '/api/chats/search', json({ avatar_url: 'Alice.png', query: '  HELLO   World  ' }));
    await runScenario('searchNoMatch', '/api/chats/search', json({ avatar_url: 'Alice.png', query: 'zzzznope' }));
    await runScenario('searchFileNameOnly', '/api/chats/search', json({ avatar_url: 'Alice.png', query: 'chat-two' }));
    await runScenario('searchMissingDirectory', '/api/chats/search', json({ avatar_url: 'Nope.png', query: 'x' }));
    await runScenario('searchGroup', '/api/chats/search', json({ group_id: 'seed-group-search', query: 'group' }));
    await runScenario('searchGroupNoQuery', '/api/chats/search', json({ group_id: 'seed-group-search' }));
    await runScenario('searchGroupMissing', '/api/chats/search', json({ group_id: 'nope' }));
    await runScenario('searchGroupWithoutChats', '/api/chats/search', json({ group_id: 'seed-group-no-chats' }));
    await runScenario('searchForbiddenAvatar', '/api/chats/search', json({ avatar_url: '../x.png', query: 'x' }));

    await runScenario('recentAll', '/api/chats/recent', json({ max: 100 }));
    await runScenario('recentMetadata', '/api/chats/recent', json({ max: 100, metadata: true }));
    await runScenario('recentPinnedAvatar', '/api/chats/recent', json({
        max: 100, pinned: [{ file_name: 'chat-three.jsonl', avatar: 'Bob.png' }],
    }));
    await runScenario('recentPinnedGroup', '/api/chats/recent', json({
        max: 100, pinned: [{ file_name: 'group-chat-a.jsonl', group: 'seed-group-search' }],
    }));
    await runScenario('recentMaxOne', '/api/chats/recent', json({ max: 1 }));
    await runScenario('recentMaxZero', '/api/chats/recent', json({ max: 0 }));
    await runScenario('recentPinnedNotArray', '/api/chats/recent', json({ max: 100, pinned: 'not an array' }));

    const fixture = {
        schemaVersion: 1,
        baseline: { version: PINNED_VERSION, commit: PINNED_COMMIT },
        probe: 'pinned /api/chats/search and /api/chats/recent',
        normalization: [
            'The /search result array is recorded sorted by file_name because it comes from fs.readdirSync, whose order differs between NTFS and ext4 and is not part of the route contract.',
            'The /recent result array is recorded in the order the route returned it: it is ordered by mtime descending with pinned entries first, and every seeded chat file has a distinct mtime, so the order is deterministic and is asserted rather than sorted away.',
            'No generated id, timestamp or random value is involved in these two routes.',
            'Express-derived content-length is recorded as <derived-from-uncompressed-body> for the responses pinned Node gzips, because GoTavern does not reproduce the compression middleware yet.',
        ],
        inputs: {
            cookieSecret: COOKIE_SECRET,
            newestMtimeMs: NEWEST_MTIME_MS,
            chatFiles: Object.fromEntries(Object.entries(CHAT_FILES).map(([key, seed]) => [key, { body: seed.body, mtime: seed.mtime }])),
            groupChatFiles: Object.fromEntries(Object.entries(GROUP_CHAT_FILES).map(([key, seed]) => [key, { body: seed.body, mtime: seed.mtime }])),
            groupFiles: GROUP_FILES,
            cardFiles: CARD_FILES,
            longMessage: LONG_MESSAGE,
        },
        scenarioOrder: Object.keys(scenarios),
        scenarios,
    };

    // Pinned Node gzips the larger JSON bodies, which removes content-length;
    // GoTavern does not implement that middleware yet.
    for (const scenario of Object.values(scenarios)) {
        if (scenario.response.headers['content-encoding'] === 'gzip') {
            scenario.response.headers['content-length'] = '<derived-from-uncompressed-body>';
        }
    }

    const outputFile = path.join(repositoryRoot, 'tests', 'oracle', 'sillytavern-1.19.0-chats-search-recent.json');
    mkdirSync(path.dirname(outputFile), { recursive: true });
    writeFileSync(outputFile, JSON.stringify(fixture, null, 2) + '\n');
    console.log('Wrote tests/oracle/sillytavern-1.19.0-chats-search-recent.json from pinned behavior');
} catch (error) {
    console.error(error);
    process.exitCode = 1;
} finally {
    await stopServer();
    safeCleanup();
}
