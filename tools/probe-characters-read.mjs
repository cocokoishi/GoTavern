#!/usr/bin/env node
// Capture pinned character read behavior: /api/characters/all, /get and /chats.
//
// The pinned card reader (src/character-card-parser.js) reads base64 character
// JSON out of the PNG `chara`/`ccv3` tEXt chunks. This probe builds those PNGs
// itself so the exact chunk layout under test is visible in the fixture inputs.

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import zlib from 'node:zlib';

const PINNED_COMMIT = '06bde939fb1e9c4c8d8641d810f0a916b5bce127';
const PINNED_VERSION = '1.19.0';
// @gotavern-oracle: this declaration is read by tools/build-generated-lib.mjs,
// which auto-discovers probes so that adding one needs no edit there.
// @gotavern-oracle: fixture=sillytavern-1.19.0-characters-read.json label="character read"
const COOKIE_SECRET = 'gotavern-pinned-characters-read-cookie-secret';
const sourceRoot = path.resolve(process.argv[2] ?? '');
const repositoryRoot = path.resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3]) {
    console.error('usage: node tools/probe-characters-read.mjs <pinned-source-clone-with-dependencies> <gotavern-root>');
    process.exit(2);
}
if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim() !== PINNED_COMMIT) {
    throw new Error('upstream checkout is not pinned at ' + PINNED_COMMIT);
}

const runtimeRoot = mkdtempSync(path.join(os.tmpdir(), 'gotavern-characters-read-oracle-'));
const dataRoot = path.join(runtimeRoot, 'data');
const logs = [];
let child;

// Fixed timestamps keep mtime-derived fields reproducible across runs.
const FIXED_MTIME_MS = 1700000500000;

function sha256(value) {
    return createHash('sha256').update(value).digest('hex');
}

function safeCleanup() {
    const resolved = path.resolve(runtimeRoot);
    const parent = path.resolve(os.tmpdir());
    if (path.dirname(resolved).toLowerCase() !== parent.toLowerCase()
        || !path.basename(resolved).startsWith('gotavern-characters-read-oracle-')) {
        throw new Error('refusing to remove unexpected runtime path: ' + resolved);
    }
    rmSync(resolved, { recursive: true, force: true });
}

// ---- Minimal deterministic PNG encoder (IHDR/IDAT/IEND + tEXt chunks) ----

const CRC_TABLE = (() => {
    const table = new Int32Array(256);
    for (let index = 0; index < 256; index++) {
        let value = index;
        for (let bit = 0; bit < 8; bit++) {
            value = value & 1 ? 0xEDB88320 ^ (value >>> 1) : value >>> 1;
        }
        table[index] = value;
    }
    return table;
})();

function crc32(buffer) {
    let crc = 0 ^ -1;
    for (const byte of buffer) {
        crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xFF];
    }
    return (crc ^ -1) >>> 0;
}

function pngChunk(name, data) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(name, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([length, body, crc]);
}

function textChunk(keyword, text) {
    return pngChunk('tEXt', Buffer.concat([Buffer.from(keyword, 'latin1'), Buffer.from([0]), Buffer.from(text, 'latin1')]));
}

/** Builds a 2x2 RGB PNG carrying the requested tEXt chunks. */
function buildPng(textChunks) {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(2, 0);
    ihdr.writeUInt32BE(2, 4);
    ihdr[8] = 8;
    ihdr[9] = 2;
    const raw = Buffer.from([0, 1, 2, 3, 4, 5, 6, 0, 7, 8, 9, 10, 11, 12]);
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
        pngChunk('IHDR', ihdr),
        ...textChunks,
        // Level 0 emits stored deflate blocks, whose bytes are fixed by the
        // format rather than by the linked zlib build, and these PNG bytes are
        // recorded in the fixture.
        pngChunk('IDAT', zlib.deflateSync(raw, { level: 0 })),
        pngChunk('IEND', Buffer.alloc(0)),
    ]);
}

function charaPng(cardJSON) {
    return buildPng([textChunk('chara', Buffer.from(cardJSON, 'utf8').toString('base64'))]);
}

// ---- Server lifecycle ----

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
    const response = await fetch(url, { method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(20000) });
    const text = Buffer.from(await response.arrayBuffer()).toString('utf8');
    let parsedBody = null;
    let bodyIsJSON = false;
    if (text) {
        try {
            parsedBody = JSON.parse(text);
            bodyIsJSON = true;
        } catch {
            // Preserve plain text and HTML errors verbatim.
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
    if (typeof response.headers.getSetCookie !== 'function') throw new Error('Node fetch does not expose getSetCookie()');
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

async function startServer(configText) {
    writeFileSync(path.join(runtimeRoot, 'config.yaml'), configText);
    const port = await choosePort();
    const origin = 'http://127.0.0.1:' + port;
    logs.length = 0;
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
    return origin;
}

async function login(origin) {
    const csrf = await request(origin + '/csrf-token');
    const token = csrf.body.token;
    const csrfCookie = cookieHeader(cookiesFrom(csrf.response));
    const result = await request(origin + '/api/users/login', 'POST', {
        Cookie: csrfCookie, 'Content-Type': 'application/json', 'X-CSRF-Token': token,
    }, JSON.stringify({ handle: 'default-user', password: '' }));
    if (result.response.status !== 200) throw new Error('could not login: ' + result.response.status + ' ' + JSON.stringify(result.body));
    return { token, sessionCookie: cookieHeader(cookiesFrom(result.response)) };
}

// ---- Fixture card payloads ----

// A complete Spec V2 card with unrelated/unknown top-level, data and extension
// fields so unknown-field preservation is directly observable.
const CARD_V2 = {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    name: 'Alice V2',
    description: 'alice description',
    personality: 'alice personality',
    scenario: 'alice scenario',
    first_mes: 'alice first message',
    mes_example: '<START>\n{{user}}: hi\n{{char}}: hello',
    creatorcomment: 'alice creator notes',
    avatar: 'none',
    chat: 'Alice V2 - 2024-01-01@00h00m00s000ms',
    talkativeness: 0.5,
    fav: false,
    tags: ['alpha', 'beta'],
    create_date: '2024-01-01T00:00:00.000Z',
    probeUnknownTopLevel: { keep: [1, 2, 3], nested: 'value' },
    data: {
        name: 'Alice V2',
        description: 'alice description',
        personality: 'alice personality',
        scenario: 'alice scenario',
        first_mes: 'alice first message',
        mes_example: '<START>\n{{user}}: hi\n{{char}}: hello',
        creator_notes: 'alice creator notes',
        system_prompt: 'alice system prompt',
        post_history_instructions: 'alice post history instructions',
        tags: ['alpha', 'beta'],
        creator: 'alice creator',
        character_version: '1.2',
        alternate_greetings: ['alt one', 'alt two'],
        extensions: {
            talkativeness: 0.5,
            fav: false,
            world: 'AliceWorld',
            depth_prompt: { prompt: 'alice depth prompt', depth: 4, role: 'system' },
            probeUnknownExtension: { keep: true },
        },
        probeUnknownDataField: 42,
    },
};

// Spec V2 card missing the backfilled ST extension fields.
const CARD_V2_BACKFILL = {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    name: 'Backfill V2',
    chat: 'Backfill V2 - 2024-01-01@00h00m00s000ms',
    create_date: '2024-02-02T00:00:00.000Z',
    data: {
        name: 'Backfill V2',
        description: 'backfill description',
        tags: [],
        extensions: {},
    },
};

// Spec V2 card whose name is empty: excluded from /all by the truthiness filter.
const CARD_V2_NONAME = {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    name: '',
    chat: 'NoName - 2024-01-01@00h00m00s000ms',
    create_date: '2024-03-03T00:00:00.000Z',
    data: { name: '', description: 'no name description', tags: [], extensions: {} },
};

// Legacy Spec V1 card exercising convertToV2 + readFromV2.
const CARD_V1 = {
    name: 'Bob V1',
    description: 'bob description',
    personality: 'bob personality',
    scenario: 'bob scenario',
    first_mes: 'bob first message',
    mes_example: 'bob example',
    creatorcomment: 'bob creator notes',
    avatar: 'none',
    chat: 'Bob V1 - 2024-01-01@00h00m00s000ms',
    talkativeness: 0.7,
    fav: 'true',
    tags: 'x, y ,z',
    create_date: '2024-04-04T00:00:00.000Z',
    probeUnknownV1: 'keep me',
};

// Spec V3 card delivered only through the `ccv3` chunk.
const CARD_V3 = {
    spec: 'chara_card_v3',
    spec_version: '3.0',
    name: 'Carol V3',
    chat: 'Carol V3 - 2024-01-01@00h00m00s000ms',
    create_date: '2024-05-05T00:00:00.000Z',
    data: { name: 'Carol V3', description: 'carol description', tags: ['gamma'], extensions: {} },
};

// A card carrying both chunks with conflicting names: `ccv3` takes precedence.
const CARD_DUAL_V2 = {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    name: 'Dual V2',
    chat: 'Dual V2 - 2024-01-01@00h00m00s000ms',
    create_date: '2024-06-06T00:00:00.000Z',
    data: { name: 'Dual V2', description: 'from chara', tags: [], extensions: {} },
};
const CARD_DUAL_V3 = {
    spec: 'chara_card_v3',
    spec_version: '3.0',
    name: 'Dual V3',
    chat: 'Dual V3 - 2024-01-01@00h00m00s000ms',
    create_date: '2024-06-06T00:00:00.000Z',
    data: { name: 'Dual V3', description: 'from ccv3', tags: [], extensions: {} },
};

const CARDS = [
    { file: 'Alice V2.png', json: JSON.stringify(CARD_V2) },
    { file: 'Backfill V2.png', json: JSON.stringify(CARD_V2_BACKFILL) },
    { file: 'NoName.png', json: JSON.stringify(CARD_V2_NONAME) },
    { file: 'Bob V1.png', json: JSON.stringify(CARD_V1) },
    {
        file: 'Carol V3.png',
        bytes: buildPng([textChunk('ccv3', Buffer.from(JSON.stringify(CARD_V3), 'utf8').toString('base64'))]),
    },
    {
        file: 'Dual.png',
        bytes: buildPng([
            textChunk('chara', Buffer.from(JSON.stringify(CARD_DUAL_V2), 'utf8').toString('base64')),
            textChunk('ccv3', Buffer.from(JSON.stringify(CARD_DUAL_V3), 'utf8').toString('base64')),
        ]),
    },
    { file: 'Invalid JSON.png', json: 'this is not json' },
    { file: 'No Metadata.png', bytes: buildPng([]) },
    { file: 'Broken.png', bytes: Buffer.from('not a png at all') },
];
for (const card of CARDS) {
    card.bytes = card.bytes ?? charaPng(card.json);
}

const CHAT_FILES = {
    'chat-a.jsonl': [
        JSON.stringify({ chat_metadata: { integrity: 'probe-integrity', probeUnknownMetadata: 7 }, user_name: 'user', character_name: 'Alice V2' }),
        JSON.stringify({ name: 'Alice V2', is_user: false, is_system: false, send_date: '2024-01-02T00:00:00.000Z', mes: 'hello from alice', extra: { probe: true } }),
    ].join('\n'),
    'chat-empty.jsonl': '',
    'chat-corrupt.jsonl': [
        JSON.stringify({ chat_metadata: {}, user_name: 'user', character_name: 'Alice V2' }),
        '{"name":"Alice V2","mes":"truncated"',
    ].join('\n'),
    'notes.txt': 'ignored because the extension is not .jsonl',
};

// Distinct mtimes so the newest-wins semantic of calculateChatSize's
// date_last_chat is observable: with one shared timestamp max and min are the
// same value and an oldest-wins implementation would pass unnoticed. The newest
// entry keeps the recorded epoch, so the expected date_last_chat stays fixed.
//
// The newest entry is deliberately the zero-byte chat-empty.jsonl, so "newest
// over every entry" is also discriminated from "newest over non-empty entries".
// The all-entries summation is covered separately by chat_size: notes.txt is
// not a .jsonl file yet its 43 bytes are part of the 409 total, so an
// implementation that only counted .jsonl files would fail that assertion.
const CHAT_FILE_MTIMES = {
    'chat-empty.jsonl': FIXED_MTIME_MS,
    'chat-a.jsonl': FIXED_MTIME_MS - 1000,
    'chat-corrupt.jsonl': FIXED_MTIME_MS - 2000,
    'notes.txt': FIXED_MTIME_MS - 3000,
};

// A chats directory whose character card no longer exists. It carries a
// subdirectory named `nested.jsonl` so only the pinned `file.isFile()` check can
// exclude it (the extension check alone would keep it), plus a non-.jsonl file
// for the extension check. It stays outside every chat_size computation: a
// directory's stat size is host-dependent (Linux ext4 reports 4096, Windows
// reports 0), so no counted chats directory may contain one.
const ORPHAN_CHATS = 'OrphanChats';
const ORPHAN_CHATS_DIRECTORIES = ['nested.jsonl'];
const ORPHAN_CHAT_FILES = {
    'orphan.jsonl': [
        JSON.stringify({ chat_metadata: {}, user_name: 'user', character_name: ORPHAN_CHATS }),
        JSON.stringify({ name: ORPHAN_CHATS, is_user: false, send_date: '2024-03-03T00:00:00.000Z', mes: 'orphan message' }),
    ].join('\n'),
    'orphan-notes.txt': 'ignored because the extension is not .jsonl',
};

// Host-independence guard: bodyText is the raw response text the Go test
// compares against, so it must stay consistent with the normalized body. A
// normalization that only edits the parsed body (sorting, markers) would
// otherwise leave the probe host's raw bytes in the fixture.
function assertRecordedBodiesMatchTheirJSON(fixture) {
    for (const [name, captured] of Object.entries(fixture.responses)) {
        if (!captured.bodyIsJSON || captured.bodyText.includes('\n')) continue;
        const expected = JSON.stringify(captured.body);
        if (captured.bodyText !== expected) {
            throw new Error(`scenario ${name} bodyText does not match its normalized body:\n recorded: ${captured.bodyText}\n expected: ${expected}`);
        }
    }
}

// Sorts with the default Array.prototype.sort code-unit order, which is also
// Go's byte order for os.ReadDir. localeCompare would additionally depend on the
// host's ICU collation data.
function sortByFile(entries) {
    return [...entries].sort((left, right) => {
        const leftName = left.file_name ?? left.avatar ?? '';
        const rightName = right.file_name ?? right.avatar ?? '';
        return leftName < rightName ? -1 : leftName > rightName ? 1 : 0;
    });
}

// Records a sorted array response. bodyText is the raw response text that the
// Go test compares against, so it has to be re-serialized from the sorted body;
// otherwise it would keep the probe host's fs.readdirSync order, which happens
// to be sorted on NTFS but is not on ext4.
function sortedArrayResponse(captured) {
    const body = sortByFile(captured.body);
    return { ...captured, body, bodyText: JSON.stringify(body) };
}

async function main() {
    mkdirSync(path.join(dataRoot, '_storage'), { recursive: true });
    writeFileSync(path.join(dataRoot, 'cookie-secret.txt'), COOKIE_SECRET);
    writeFileSync(path.join(dataRoot, '_storage', sha256('user:default-user')), JSON.stringify({
        key: 'user:default-user',
        value: {
            handle: 'default-user', name: 'Characters Read Probe', created: 1700000000000,
            password: '', admin: true, enabled: true, salt: '', probeUnknownField: { preserve: true },
        },
    }));

    const origin = await startServer('enableUserAccounts: true\nskipContentCheck: true\nperformance:\n  lazyLoadCharacters: false\n');
    const { token, sessionCookie } = await login(origin);
    const jsonHeaders = { Cookie: sessionCookie, 'X-CSRF-Token': token, 'Content-Type': 'application/json' };
    const post = (route, body) => request(origin + route, 'POST', jsonHeaders, body);

    const userRoot = path.join(dataRoot, 'default-user');
    const charactersRoot = path.join(userRoot, 'characters');
    mkdirSync(charactersRoot, { recursive: true });
    for (const card of CARDS) {
        const target = path.join(charactersRoot, card.file);
        writeFileSync(target, card.bytes);
        const fixed = new Date(FIXED_MTIME_MS);
        utimesSync(target, fixed, fixed);
    }

    const chatsRoot = path.join(userRoot, 'chats');
    const fixedTime = new Date(FIXED_MTIME_MS);
    // Alice's chats directory holds files only, so its chat_size is exactly the
    // sum of the file sizes on every host.
    const aliceChats = path.join(chatsRoot, 'Alice V2');
    mkdirSync(aliceChats, { recursive: true });
    for (const [name, body] of Object.entries(CHAT_FILES)) {
        const target = path.join(aliceChats, name);
        writeFileSync(target, body);
        const mtime = new Date(CHAT_FILE_MTIMES[name] ?? FIXED_MTIME_MS);
        utimesSync(target, mtime, mtime);
    }
    // Empty chat directory: exists but has no .jsonl files.
    mkdirSync(path.join(chatsRoot, 'Backfill V2'), { recursive: true });

    const orphanChats = path.join(chatsRoot, ORPHAN_CHATS);
    for (const directory of ORPHAN_CHATS_DIRECTORIES) {
        mkdirSync(path.join(orphanChats, directory), { recursive: true });
    }
    for (const [name, body] of Object.entries(ORPHAN_CHAT_FILES)) {
        const target = path.join(orphanChats, name);
        writeFileSync(target, body);
        utimesSync(target, fixedTime, fixedTime);
    }
    // getChatInfo only stats the .jsonl files it lists, but keep the directory
    // mtimes deterministic anyway.
    for (const directory of ORPHAN_CHATS_DIRECTORIES) {
        utimesSync(path.join(orphanChats, directory), fixedTime, fixedTime);
    }

    const accountRecordPath = path.join(dataRoot, '_storage', sha256('user:default-user'));
    const accountRecordBefore = readFileSync(accountRecordPath);

    const fullAll = capture(await post('/api/characters/all', '{}'));
    const fullGet = capture(await post('/api/characters/get', JSON.stringify({ avatar_url: 'Alice V2.png' })));
    const fullGetV1 = capture(await post('/api/characters/get', JSON.stringify({ avatar_url: 'Bob V1.png' })));
    const fullGetV3 = capture(await post('/api/characters/get', JSON.stringify({ avatar_url: 'Carol V3.png' })));
    const fullGetDual = capture(await post('/api/characters/get', JSON.stringify({ avatar_url: 'Dual.png' })));
    const fullGetBackfill = capture(await post('/api/characters/get', JSON.stringify({ avatar_url: 'Backfill V2.png' })));
    const fullGetNoName = capture(await post('/api/characters/get', JSON.stringify({ avatar_url: 'NoName.png' })));

    const responses = {
        all: sortedArrayResponse(fullAll),
        getExisting: fullGet,
        getV1: fullGetV1,
        getV3: fullGetV3,
        getDual: fullGetDual,
        getBackfill: fullGetBackfill,
        getNoName: fullGetNoName,
        getInvalidJSON: capture(await post('/api/characters/get', JSON.stringify({ avatar_url: 'Invalid JSON.png' }))),
        getNoMetadata: capture(await post('/api/characters/get', JSON.stringify({ avatar_url: 'No Metadata.png' }))),
        getBroken: capture(await post('/api/characters/get', JSON.stringify({ avatar_url: 'Broken.png' }))),
        getMissing: capture(await post('/api/characters/get', JSON.stringify({ avatar_url: 'Missing.png' }))),
        getForbiddenPath: capture(await post('/api/characters/get', JSON.stringify({ avatar_url: '../escape.png' }))),
        getNullAvatar: capture(await post('/api/characters/get', JSON.stringify({ avatar_url: null }))),
        getNumericAvatar: capture(await post('/api/characters/get', JSON.stringify({ avatar_url: 7 }))),
        getObjectAvatar: capture(await post('/api/characters/get', JSON.stringify({ avatar_url: { toString: 'x' } }))),
        getEmptyBody: capture(await request(origin + '/api/characters/get', 'POST', jsonHeaders, '')),
        getWrongMethod: capture(await request(origin + '/api/characters/get', 'GET', { Cookie: sessionCookie })),
        chatsDefault: sortedArrayResponse(capture(await post('/api/characters/chats', JSON.stringify({ avatar_url: 'Alice V2.png' })))),
        chatsSimple: sortedArrayResponse(capture(await post('/api/characters/chats', JSON.stringify({ avatar_url: 'Alice V2.png', simple: true })))),
        chatsMetadata: sortedArrayResponse(capture(await post('/api/characters/chats', JSON.stringify({ avatar_url: 'Alice V2.png', metadata: true })))),
        chatsEmptyDirectory: capture(await post('/api/characters/chats', JSON.stringify({ avatar_url: 'Backfill V2.png' }))),
        chatsMissingDirectory: capture(await post('/api/characters/chats', JSON.stringify({ avatar_url: 'Missing.png' }))),
        chatsForbiddenPath: capture(await post('/api/characters/chats', JSON.stringify({ avatar_url: '../x.png' }))),
        // A leftover chats directory with a subdirectory and a non-.jsonl file.
        chatsOrphanDirectory: sortedArrayResponse(capture(await post('/api/characters/chats', JSON.stringify({ avatar_url: ORPHAN_CHATS + '.png' })))),
        chatsOrphanSimple: sortedArrayResponse(capture(await post('/api/characters/chats', JSON.stringify({ avatar_url: ORPHAN_CHATS + '.png', simple: true })))),
    };

    // The same directory listing under performance.lazyLoadCharacters = true.
    await stopServer();
    const shallowOrigin = await startServer('enableUserAccounts: true\nskipContentCheck: true\nperformance:\n  lazyLoadCharacters: true\n');
    const shallowLogin = await login(shallowOrigin);
    const shallowAll = await request(shallowOrigin + '/api/characters/all', 'POST', {
        Cookie: shallowLogin.sessionCookie, 'X-CSRF-Token': shallowLogin.token, 'Content-Type': 'application/json',
    }, '{}');
    const shallowCaptured = capture(shallowAll);
    responses.allShallow = sortedArrayResponse(shallowCaptured);

    // A missing characters directory is the non-overflow /all failure branch.
    // This runs last because it removes the directory the other scenarios read.
    rmSync(charactersRoot, { recursive: true, force: true });
    responses.allMissingDirectory = capture(await request(shallowOrigin + '/api/characters/all', 'POST', {
        Cookie: shallowLogin.sessionCookie, 'X-CSRF-Token': shallowLogin.token, 'Content-Type': 'application/json',
    }, '{}'));

    const accountRecordUnchanged = accountRecordBefore.equals(readFileSync(accountRecordPath));
    const characterFilesState = ['Alice V2.png', 'Backfill V2.png', 'NoName.png', 'Bob V1.png', 'Carol V3.png', 'Dual.png', 'Invalid JSON.png', 'No Metadata.png', 'Broken.png']
        .map(name => ({ name, exists: existsSync(path.join(charactersRoot, name)) }));

    const fixture = {
        schemaVersion: 1,
        baseline: { version: PINNED_VERSION, commit: PINNED_COMMIT },
        probe: 'POST /api/characters/all, /get and /chats match pinned PNG card parsing, shallow projection, chat listing, validation and error responses',
        normalization: [
            'date_added is the file ctime in milliseconds, which cannot be reproduced in a separate fixture tree, so it is recorded as "<ctimeMs>".',
            'For bodies that carry the ctime marker, Express-derived content-length and ETag are recorded as "<derived-from-normalized-body>" because they are functions of the normalized bytes.',
            'The /all and /chats arrays are sorted with Array.prototype.sort code-unit order because pinned fs.readdirSync order is filesystem-dependent and not part of the route contract; Go compares its byte-sorted os.ReadDir order, which agrees for these names.',
            'Chat file mtimes are seeded to distinct fixed values in both the probe and the Go test, with the newest equal to the recorded epoch, so date_last_chat and empty-chat last_mes are reproducible and the newest-wins semantic is observable.',
            'No chats directory that participates in a chat_size is given a subdirectory: a directory stat size is host-dependent (Linux ext4 reports 4096, Windows reports 0), so the exact chat_size assertion would otherwise encode the probe host. The directory-skipping behavior of /api/characters/chats is covered by the OrphanChats directory, which has no character card and therefore contributes to no chat_size; its subdirectory is named `nested.jsonl` so only the pinned file.isFile() check can exclude it.',
        ],
        inputs: {
            cookieSecret: COOKIE_SECRET,
            fixedMtimeMs: FIXED_MTIME_MS,
            cards: CARDS.map(card => ({ file: card.file, bytesHex: card.bytes.toString('hex') })),
            chatFiles: CHAT_FILES,
            chatFileMtimesMs: CHAT_FILE_MTIMES,
            chatCharacter: 'Alice V2',
            orphanChats: {
                character: ORPHAN_CHATS,
                files: ORPHAN_CHAT_FILES,
                directories: ORPHAN_CHATS_DIRECTORIES,
            },
        },
        responses,
        state: {
            accountRecordUnchanged,
            characterFiles: characterFilesState,
        },
    };

    // Replace the ctime-derived field with a stable marker.
    const marker = value => {
        if (value && typeof value === 'object' && Object.hasOwn(value, 'date_added')) {
            value.date_added = '<ctimeMs>';
        }
        return value;
    };
    for (const key of ['getExisting', 'getV1', 'getV3', 'getDual', 'getBackfill', 'getNoName']) {
        marker(responses[key].body);
    }
    for (const entry of responses.all.body) marker(entry);
    for (const entry of responses.allShallow.body) marker(entry);

    // Pinned Node gzips compressible JSON bodies, which removes content-length;
    // GoTavern does not implement that middleware yet.
    for (const captured of Object.values(responses)) {
        if (captured.headers['content-encoding'] === 'gzip') {
            captured.headers['content-length'] = '<derived-from-uncompressed-body>';
        }
    }

    // Express derives content-length and ETag from the serialized body, so any
    // body carrying the normalized ctime cannot have reproducible header
    // values. Record them as derived markers instead of inventing a value.
    for (const captured of Object.values(responses)) {
        if (JSON.stringify(captured.body).includes('<ctimeMs>')) {
            captured.headers['content-length'] = '<derived-from-normalized-body>';
            captured.headers['etag'] = '<derived-from-normalized-body>';
            captured.bodyText = captured.bodyText.replace(/"date_added":-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g, '"date_added":"<ctimeMs>"');
        }
    }

    // Host-independence guards. Both checks fail the probe instead of silently
    // recording an observation that only holds on the machine that ran it.
    //
    // 1. chat_size sums the stat size of every directory entry, and a
    //    directory's stat size is host-dependent (Linux ext4 reports 4096,
    //    Windows reports 0), so no counted chats directory may contain one.
    for (const character of fullAll.body) {
        const directory = path.join(chatsRoot, character.avatar.replace('.png', ''));
        if (!existsSync(directory)) continue;
        const nested = readdirSync(directory).filter(name => statSync(path.join(directory, name)).isDirectory());
        if (nested.length > 0) {
            throw new Error(`chats directory ${character.avatar} contains the subdirectories ${nested.join(', ')}; `
                + 'a directory stat size is host-dependent and would leak into chat_size');
        }
    }
    // 2. Every ctime-derived date_added must have been normalized to the marker.
    for (const [name, captured] of Object.entries(responses)) {
        if (typeof captured.bodyText === 'string' && /"date_added":-?\d{10,}/.test(captured.bodyText)) {
            throw new Error(`scenario ${name} still records a raw ctime-derived date_added value`);
        }
    }
    // 3. Every array response must be recorded in sorted order. Recording a
    //    route's raw fs.readdirSync order would pass on NTFS and fail on ext4.
    for (const [name, captured] of Object.entries(responses)) {
        if (!Array.isArray(captured.body)) continue;
        if (JSON.stringify(sortByFile(captured.body)) !== JSON.stringify(captured.body)) {
            throw new Error(`scenario ${name} records its array in the probe host's directory order instead of sorted order`);
        }
    }

    assertRecordedBodiesMatchTheirJSON(fixture);

    const outputFile = path.join(repositoryRoot, 'tests', 'oracle', 'sillytavern-1.19.0-characters-read.json');
    mkdirSync(path.dirname(outputFile), { recursive: true });
    writeFileSync(outputFile, JSON.stringify(fixture, null, 2) + '\n');
    console.log('Wrote tests/oracle/sillytavern-1.19.0-characters-read.json from pinned behavior');
}

try {
    await main();
} catch (error) {
    console.error(error);
    process.exitCode = 1;
} finally {
    await stopServer();
    safeCleanup();
}
