#!/usr/bin/env node
// Capture pinned POST /api/characters/import and /api/characters/edit-avatar.

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';

const PINNED_COMMIT = '06bde939fb1e9c4c8d8641d810f0a916b5bce127';
const PINNED_VERSION = '1.19.0';
// @gotavern-oracle: this declaration is read by tools/build-generated-lib.mjs,
// which auto-discovers probes so that adding one needs no edit there.
// @gotavern-oracle: fixture=sillytavern-1.19.0-characters-import.json label="character import"
const COOKIE_SECRET = 'gotavern-pinned-characters-import-cookie-secret';
const sourceRoot = path.resolve(process.argv[2] ?? '');
const repositoryRoot = path.resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3]) {
    console.error('usage: node tools/probe-characters-import.mjs <pinned-source-clone-with-dependencies> <gotavern-root>');
    process.exit(2);
}
if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim() !== PINNED_COMMIT) {
    throw new Error('upstream checkout is not pinned at ' + PINNED_COMMIT);
}

const { PNG } = createRequire(path.join(sourceRoot, 'package.json'))('pngjs');

const runtimeRoot = mkdtempSync(path.join(os.tmpdir(), 'gotavern-characters-import-oracle-'));
const dataRoot = path.join(runtimeRoot, 'data');
const logs = [];
let child;

function sha256(value) {
    return createHash('sha256').update(value).digest('hex');
}

function safeCleanup() {
    const resolved = path.resolve(runtimeRoot);
    const parent = path.resolve(os.tmpdir());
    if (path.dirname(resolved).toLowerCase() !== parent.toLowerCase()
        || !path.basename(resolved).startsWith('gotavern-characters-import-oracle-')) {
        throw new Error('refusing to remove unexpected runtime path: ' + resolved);
    }
    rmSync(resolved, { recursive: true, force: true });
}

// ---- PNG helpers (same conventions as the other characters probes) ----

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

function buildPng(textChunks, pixels, width = 2, height = 2) {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;
    ihdr[9] = 2;
    const raw = pixels ?? Buffer.from([0, 1, 2, 3, 4, 5, 6, 0, 7, 8, 9, 10, 11, 12]);
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

function readPngCard(image) {
    let index = 8;
    const texts = [];
    while (index < image.length) {
        const length = image.readUInt32BE(index);
        index += 4;
        const name = image.subarray(index, index + 4).toString('latin1');
        if (name === 'IEND') break;
        const data = image.subarray(index + 4, index + 4 + length);
        if (name === 'tEXt') {
            const separator = data.indexOf(0);
            texts.push({ keyword: data.subarray(0, separator).toString('latin1'), text: data.subarray(separator + 1).toString('latin1') });
        }
        index += 4 + length + 4;
    }
    for (const keyword of ['ccv3', 'chara']) {
        const found = texts.find(entry => entry.keyword.toLowerCase() === keyword);
        if (found) return Buffer.from(found.text, 'base64').toString('utf8');
    }
    throw new Error('no character metadata');
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

// Guards the recorded order: readdirSync is not sorted on every filesystem, so
// a snapshot that is recorded in the raw order would pass on NTFS and fail on
// ext4. Go compares its byte-sorted os.ReadDir order, which agrees with the
// default Array.prototype.sort code-unit order for these ASCII names.
function assertSortedNames(names, label) {
    const sorted = [...names].sort();
    if (names.join('\n') !== sorted.join('\n')) {
        throw new Error(`${label} is recorded in the probe host's directory order instead of sorted order`);
    }
}

// Host-independence guard: bodyText is the raw response text the Go test
// compares against, so it must stay consistent with the normalized body. A
// normalization that only edits the parsed body (sorting, markers) would
// otherwise leave the probe host's raw bytes in the fixture.
function assertRecordedBodiesMatchTheirJSON(fixture) {
    for (const [name, scenario] of Object.entries(fixture.scenarios)) {
        const captured = scenario.response;
        if (!captured.bodyIsJSON || captured.bodyText.includes('\n')) continue;
        const expected = JSON.stringify(captured.body);
        if (captured.bodyText !== expected) {
            throw new Error(`scenario ${name} bodyText does not match its normalized body:\n recorded: ${captured.bodyText}\n expected: ${expected}`);
        }
    }
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

// ---- Fixture inputs ----

function specV2Card(name) {
    return {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        name,
        description: name + ' description',
        personality: name + ' personality',
        scenario: name + ' scenario',
        first_mes: name + ' first message',
        mes_example: name + ' example',
        creatorcomment: name + ' creator notes',
        avatar: 'none',
        chat: name + ' - 2024-01-01@00h00m00s000ms',
        talkativeness: 0.5,
        fav: false,
        tags: ['alpha'],
        create_date: '2024-01-01T00:00:00.000Z',
        probeUnknownTopLevel: { keep: true },
        data: {
            name,
            description: name + ' description',
            personality: name + ' personality',
            scenario: name + ' scenario',
            first_mes: name + ' first message',
            mes_example: name + ' example',
            creator_notes: name + ' creator notes',
            system_prompt: '',
            post_history_instructions: '',
            tags: ['alpha'],
            creator: name + ' creator',
            character_version: '1.0',
            alternate_greetings: [],
            extensions: { talkativeness: 0.5, fav: false, world: '', depth_prompt: { prompt: '', depth: 4, role: 'system' } },
        },
    };
}

const V1_CARD = {
    name: 'Imported V1',
    description: 'v1 description',
    personality: 'v1 personality',
    scenario: 'v1 scenario',
    first_mes: 'v1 first message',
    mes_example: 'v1 example',
    creatorcomment: 'v1 creator notes',
    avatar: 'none',
    chat: 'Imported V1 - 2024-01-01@00h00m00s000ms',
    talkativeness: 0.7,
    fav: 'true',
    tags: 'x, y',
    create_date: '2024-04-04T00:00:00.000Z',
    probeUnknownV1: 'keep',
};

const GRADIO_CARD = {
    char_name: 'Imported Gradio',
    char_persona: 'gradio persona',
    char_greeting: 'gradio greeting',
    example_dialogue: 'gradio example',
    world_scenario: 'gradio scenario',
    creator_notes: "Creator's notes go here.",
    talkativeness: 0.4,
    creator: 'gradio creator',
    tags: 'g1, g2',
};

const YAML_DOCUMENT = 'name: Imported Yaml\ncontext: yaml context\ngreeting: yaml greeting\n';

const EXISTING_CARD = specV2Card('EditTarget');
// A non-ISO sentinel keeps this card's create_date verifiable while every
// generated ISO timestamp is normalized out of the snapshots.
EXISTING_CARD.create_date = 'seeded-create-date';
const CROP_CARD = specV2Card('CropTarget');
CROP_CARD.create_date = 'seeded-create-date';
const CROP_CARD_FIXED = specV2Card('CropTargetFixed');
CROP_CARD_FIXED.create_date = 'seeded-create-date';
const EXISTING_CARDS = [
    { file: 'EditTarget.png', bytes: charaPng(JSON.stringify(EXISTING_CARD)) },
    { file: 'CropTarget.png', bytes: charaPng(JSON.stringify(CROP_CARD)) },
    { file: 'CropTargetFixed.png', bytes: charaPng(JSON.stringify(CROP_CARD_FIXED)) },
    { file: 'NotACard.png', bytes: Buffer.from('not a png at all') },
];
const UPLOAD_PNG = buildPng([], Buffer.from([0, 200, 201, 202, 203, 204, 205, 0, 206, 207, 208, 209, 210, 211]));

// ---- Format fixtures: deterministic ZIP archives and image buffers ----------
//
// THE ZIP BYTES ARE BUILT BY HAND, not with a writer library, because the probe
// re-records this fixture in CI and every byte of the upload is recorded. A
// hand-built "stored" archive (no compression, fixed 1980-01-01 DOS timestamp)
// is byte-deterministic across hosts and Node/zlib builds.

function buildZip(entries) {
    const localParts = [];
    const centralParts = [];
    let offset = 0;
    const dosTime = 0;
    const dosDate = (1 << 5) | 1; // 1980-01-01
    for (const entry of entries) {
        const name = Buffer.from(entry.name, 'utf8');
        const data = entry.data;
        const crc = crc32(data) >>> 0;
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034B50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0, 6);
        local.writeUInt16LE(0, 8);
        local.writeUInt16LE(dosTime, 10);
        local.writeUInt16LE(dosDate, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(data.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(name.length, 26);
        local.writeUInt16LE(0, 28);
        localParts.push(local, name, data);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014B50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(0, 8);
        central.writeUInt16LE(0, 10);
        central.writeUInt16LE(dosTime, 12);
        central.writeUInt16LE(dosDate, 14);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(data.length, 20);
        central.writeUInt32LE(data.length, 24);
        central.writeUInt16LE(name.length, 28);
        central.writeUInt16LE(0, 30);
        central.writeUInt16LE(0, 32);
        central.writeUInt16LE(0, 34);
        central.writeUInt16LE(0, 36);
        central.writeUInt32LE(0, 38);
        central.writeUInt32LE(offset, 42);
        centralParts.push(central, name);
        offset += local.length + name.length + data.length;
    }
    const centralSize = centralParts.reduce((total, part) => total + part.length, 0);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054B50, 0);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(centralSize, 12);
    eocd.writeUInt32LE(offset, 16);
    return Buffer.concat([...localParts, ...centralParts, eocd]);
}

// A 2x2 PNG whose pixels differ per call site, so an avatar and an aux asset
// cannot be confused by a digest comparison.
function tinyPng(seed) {
    return buildPng([], Buffer.from([0, seed, seed + 1, seed + 2, seed + 3, seed + 4, seed + 5, 0, seed + 6, seed + 7, seed + 8, seed + 9, seed + 10, seed + 11]));
}

// An 8x8 PNG with a 1px white border and a solid red 6x6 interior. The crop
// scenario uses this to tell cover (which crops the border away) from stretch
// (which keeps it), by sampling interior points where both resamplers are exact.
function cropProbePng() {
    const width = 8;
    const height = 8;
    const raw = Buffer.alloc(height * (1 + width * 3)); // buildPng is color type 2 (RGB)
    for (let y = 0; y < height; y++) {
        const rowStart = y * (1 + width * 3);
        raw[rowStart] = 0; // no filter
        for (let x = 0; x < width; x++) {
            const border = x === 0 || y === 0 || x === width - 1 || y === height - 1;
            const offset = rowStart + 1 + x * 3;
            const [r, g, b] = border ? [255, 255, 255] : [220, 30, 40];
            raw[offset] = r;
            raw[offset + 1] = g;
            raw[offset + 2] = b;
        }
    }
    return buildPng([], raw, width, height);
}

function charxCard(name) {
    return {
        spec: 'chara_card_v3',
        spec_version: '3.0',
        data: {
            name,
            description: name + ' description',
            personality: name + ' personality',
            scenario: name + ' scenario',
            first_mes: name + ' first message',
            mes_example: name + ' example',
            creator_notes: name + ' creator notes',
            system_prompt: name + ' system prompt',
            post_history_instructions: name + ' post history',
            alternate_greetings: [name + ' alternate one', name + ' alternate two'],
            character_book: {
                name: name + ' lorebook',
                entries: [{
                    keys: ['glade'],
                    content: name + ' lore entry',
                    extensions: { position: 'before_char' },
                    enabled: true,
                    insertion_order: 0,
                    name: 'lore one',
                }],
                extensions: { probe: 'keep' },
            },
            tags: ['tag-a', 'tag-b'],
            creator: name + ' creator',
            character_version: '2.5',
            extensions: { talkativeness: '0.4', fav: true, world: name + ' world', depth_prompt: { prompt: 'depth', depth: 3, role: 'system' } },
            group_only_greetings: [name + ' group greeting'],
            assets: [
                { type: 'icon', name: 'main', uri: 'embeded://assets/icon/main.png', ext: 'png' },
                { type: 'emotion', name: 'happy', uri: 'embedded://assets/sprite/happy.png', ext: 'png' },
                { type: 'expression', name: 'sad face', uri: '__asset:assets/sprite/sad.png', ext: 'png' },
                { type: 'background', name: 'bg 1', uri: 'embeded://assets/bg/bg one.png', ext: 'png' },
                { type: 'user_icon', name: 'user', uri: 'embeded://assets/user/user.png', ext: 'png' },
                { type: 'document', name: 'notes', uri: 'embeded://assets/misc/notes.txt', ext: 'txt' },
                { type: 'misc', name: 'note image.png', uri: 'embeded://assets/misc/note.png', ext: 'png' },
            ],
            probeUnknownDataField: { keep: true },
        },
        probeUnknownTopLevel: 'keep',
    };
}

const CHARX_ASSETS = {
    'assets/icon/main.png': tinyPng(10),
    'assets/sprite/happy.png': tinyPng(20),
    'assets/sprite/sad.png': tinyPng(30),
    'assets/bg/bg one.png': tinyPng(40),
    'assets/user/user.png': tinyPng(50),
    'assets/misc/notes.txt': Buffer.from('not an image'),
    'assets/misc/note.png': tinyPng(60),
};

const CHARX_ARCHIVE = buildZip([
    { name: 'card.json', data: Buffer.from(JSON.stringify(charxCard('CharX Hero'))) },
    ...Object.entries(CHARX_ASSETS).map(([name, data]) => ({ name, data })),
]);
const CHARX_NO_CARD_ARCHIVE = buildZip([{ name: 'other.json', data: Buffer.from('{}') }]);
const CHARX_NO_SPEC_ARCHIVE = buildZip([{ name: 'card.json', data: Buffer.from(JSON.stringify({ data: { name: 'No Spec' } })) }]);
const CHARX_TRUNCATED = CHARX_ARCHIVE.subarray(0, Math.floor(CHARX_ARCHIVE.length / 2));
const CHARX_OVERSIZED_ASSET = Buffer.alloc(128 * 1024);
for (let index = 0; index < CHARX_OVERSIZED_ASSET.length; index++) CHARX_OVERSIZED_ASSET[index] = index % 251;
const CHARX_OVERSIZED_ARCHIVE = buildZip([
    { name: 'card.json', data: Buffer.from(JSON.stringify(charxCard('CharX Oversized'))) },
    { name: 'assets/icon/main.png', data: tinyPng(70) },
    { name: 'assets/misc/big.png', data: CHARX_OVERSIZED_ASSET },
]);

function byafScenario(title, options = {}) {
    return {
        title,
        narrative: title + ' narrative for {{user}} and {character}',
        firstMessages: [{ text: title + ' first #{user}: and #{character}: text' }],
        exampleMessages: [{ text: title + ' example {user} says' }],
        formattingInstructions: title + ' format {user}',
        messages: options.messages ?? [],
        ...(options.backgroundImage ? { backgroundImage: options.backgroundImage } : {}),
        ...(options.model ? { model: options.model, temperature: 0.7, topK: 33, topP: 0.8, minP: 0.05, minPEnabled: false, repeatPenalty: 1.11, repeatLastN: 111, promptTemplate: 'alpaca', grammar: 'root ::= "x"' } : {}),
    };
}

const BYAF_SCENARIO_ONE = byafScenario('Opening', {
    backgroundImage: 'scenarios/bg.png',
    model: 'byaf-model',
    messages: [
        { type: 'human', text: 'hello {user}', createdAt: 1700000100000 },
        {
            type: 'ai',
            outputs: [
                { text: 'older answer', activeTimestamp: 1700000150000 },
                { text: 'newest answer', activeTimestamp: 1700000200000 },
            ],
        },
    ],
});
const BYAF_SCENARIO_TWO = byafScenario('Second', { backgroundImage: 'scenarios/bg.png' });
const BYAF_CHARACTER = {
    name: 'ByafHero',
    displayName: 'Byaf Display',
    persona: 'persona of {user} and #{character}:',
    isNSFW: true,
    loreItems: [
        { key: 'glade, forest', value: 'lore about {user}' },
        { key: 'lantern', value: 'light without fuel' },
    ],
    images: [
        { path: 'images/main.png', label: 'Main' },
        { path: 'images/alt.png', label: 'Alt Look' },
    ],
};
const BYAF_ARCHIVE = buildZip([
    {
        name: 'manifest.json',
        data: Buffer.from(JSON.stringify({
            author: { name: 'Byaf Author', backyardURL: 'https://example.invalid/backyard' },
            characters: ['characters/hero.json'],
            scenarios: ['scenarios/one.json', 'scenarios/two.json'],
        })),
    },
    { name: 'characters/hero.json', data: Buffer.from(JSON.stringify(BYAF_CHARACTER)) },
    { name: 'scenarios/one.json', data: Buffer.from(JSON.stringify(BYAF_SCENARIO_ONE)) },
    { name: 'scenarios/two.json', data: Buffer.from(JSON.stringify(BYAF_SCENARIO_TWO)) },
    { name: 'characters/images/main.png', data: tinyPng(80) },
    { name: 'characters/images/alt.png', data: tinyPng(90) },
    { name: 'scenarios/bg.png', data: tinyPng(100) },
]);
const BYAF_NO_MANIFEST_ARCHIVE = buildZip([{ name: 'characters/hero.json', data: Buffer.from('{}') }]);
const BYAF_EMPTY_CHARACTERS_ARCHIVE = buildZip([{ name: 'manifest.json', data: Buffer.from(JSON.stringify({ characters: [] })) }]);
const BYAF_MINIMAL_CHARACTER = { name: 'Byaf Minimal', persona: 'minimal persona' };
const BYAF_MINIMAL_ARCHIVE = buildZip([
    { name: 'manifest.json', data: Buffer.from(JSON.stringify({ characters: ['hero.json'] })) },
    { name: 'hero.json', data: Buffer.from(JSON.stringify(BYAF_MINIMAL_CHARACTER)) },
]);

function risuCard(name) {
    return {
        spec: 'risu',
        spec_version: '3.0',
        data: {
            name,
            description: name + ' description',
            first_mes: name + ' first message',
            extensions: {
                talkativeness: '0.6',
                risuai: {
                    additionalAssets: [
                        ['happy', tinyPng(110).toString('base64')],
                        ['sad', tinyPng(120).toString('base64')],
                    ],
                    emotions: [
                        ['happy', tinyPng(130).toString('base64')],
                        ['angry', tinyPng(140).toString('base64')],
                    ],
                },
            },
        },
    };
}
const RISU_JSON = Buffer.from(JSON.stringify(risuCard('Risu Hero')));
const RISU_PNG = charaPng(JSON.stringify(risuCard('Risu PNG')));

// Sample coordinates are recorded for every card PNG: the last two exist to
// discriminate cover (border cropped away -> red) from stretch (border kept ->
// white) in the avatar-crop scenarios.
const CARD_SAMPLE_POINTS = [
    [0, 0],
    [1, 1],
    [30, 384],
    [256, 384],
];

try {
    mkdirSync(path.join(dataRoot, '_storage'), { recursive: true });
    writeFileSync(path.join(dataRoot, 'cookie-secret.txt'), COOKIE_SECRET);
    writeFileSync(path.join(dataRoot, '_storage', sha256('user:default-user')), JSON.stringify({
        key: 'user:default-user',
        value: {
            handle: 'default-user', name: 'Characters Import Probe', created: 1700000000000,
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
    const authHeaders = { Cookie: sessionCookie, 'X-CSRF-Token': token };

    const charactersRoot = path.join(dataRoot, 'default-user', 'characters');
    mkdirSync(charactersRoot, { recursive: true });
    const fixedTime = new Date(1700000500000);
    for (const card of EXISTING_CARDS) {
        writeFileSync(path.join(charactersRoot, card.file), card.bytes);
        utimesSync(path.join(charactersRoot, card.file), fixedTime, fixedTime);
    }

    const normalizeCardText = (text, normalizeCreateDate) => {
        let normalized = text.replace(/\d{4}-\d{2}-\d{2}@\d{2}h\d{2}m\d{2}s\d{3}ms/g, '<humanizedDateTime>');
        if (normalizeCreateDate) {
            normalized = normalized.replace(/"create_date":"[^"]*"/g, '"create_date":"<isoDate>"');
        }
        return normalized;
    };

    // Card snapshots carry the OBSERVABLE pixels (dimensions + sampled colours),
    // never PNG byte equality: pinned re-encodes every stored avatar through Jimp
    // (ARCHITECTURE.md boundary 3). The sampled colours are the geometry proof:
    // inside solid regions both resamplers are exact, and the cover-vs-stretch
    // discriminator points read red only when the border was cropped away.
    const cardSnapshot = (filePath, options = {}) => {
        const bytes = readFileSync(filePath);
        let charaJSON = null;
        try {
            charaJSON = normalizeCardText(readPngCard(bytes), true);
        } catch {
            charaJSON = null;
        }
        let width = null;
        let height = null;
        let digest = null;
        let samples = null;
        try {
            const decoded = PNG.sync.read(bytes);
            width = decoded.width;
            height = decoded.height;
            const omitDigest = Array.isArray(options.omitDigestFor) && options.omitDigestFor.includes(path.basename(filePath));
            digest = omitDigest ? null : sha256(decoded.data);
            samples = [];
            for (const [x, y] of CARD_SAMPLE_POINTS) {
                const clampedX = Math.max(0, Math.min(decoded.width - 1, x));
                const clampedY = Math.max(0, Math.min(decoded.height - 1, y));
                const offset = (clampedY * decoded.width + clampedX) * 4;
                samples.push({
                    x: clampedX, y: clampedY,
                    rgba: [decoded.data[offset], decoded.data[offset + 1], decoded.data[offset + 2], decoded.data[offset + 3]],
                });
            }
        } catch {
            // Not a decodable PNG.
        }
        return { charaJSON, width, height, digest, samples };
    };

    const charactersSnapshot = (normalizeCreateDate, options = {}) => {
        const entries = [];
        for (const name of readdirSync(charactersRoot).sort()) {
            const filePath = path.join(charactersRoot, name);
            if (!statSync(filePath).isFile()) continue;
            const snapshot = cardSnapshot(filePath, options);
            if (!normalizeCreateDate && snapshot.charaJSON !== null) {
                snapshot.charaJSON = snapshot.charaJSON.replace(/"create_date":"[^"]*"/g, '"create_date":"<isoDate>"');
            }
            entries.push({ name, ...snapshot });
        }
        assertSortedNames(entries.map(entry => entry.name), 'characters snapshot');
        return entries;
    };

    // THE WHOLE USER TREE the three archive formats touch: character cards and
    // their sprite/background/icon folders, the chats the BYAF importer creates,
    // and the user/images gallery entries. Recorded as path -> observable, with
    // generated clock values normalized so the fixture is host- and run-stable.
    const normalizeGeneratedText = text => String(text)
        .replace(/\d{4}-\d{2}-\d{2}@\d{2}h\d{2}m\d{2}s\d{3}ms/g, '<humanizedDateTime>')
        .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, '<isoDate>');

    const walkUserFiles = (root, prefix, collected) => {
        let entries;
        try {
            entries = readdirSync(root, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
        } catch {
            return;
        }
        for (const entry of entries) {
            const fullPath = path.join(root, entry.name);
            const relativePath = normalizeGeneratedText(prefix + '/' + entry.name);
            if (entry.isDirectory()) {
                walkUserFiles(fullPath, prefix + '/' + entry.name, collected);
                continue;
            }
            collected.push({ fullPath, relativePath });
        }
    };

    const userTreeSnapshot = options => {
        const collected = [];
        walkUserFiles(charactersRoot, 'characters', collected);
        walkUserFiles(path.join(dataRoot, 'default-user', 'chats'), 'chats', collected);
        walkUserFiles(path.join(dataRoot, 'default-user', 'user', 'images'), 'user/images', collected);
        const entries = [];
        for (const item of collected) {
            const relativePath = item.relativePath;
            const isTopLevelCard = /^characters\/[^/]+\.png$/.test(relativePath);
            if (isTopLevelCard) {
                const snapshot = cardSnapshot(item.fullPath, options);
                entries.push({
                    path: relativePath,
                    kind: 'card',
                    charaJSON: snapshot.charaJSON === null ? null : normalizeGeneratedText(snapshot.charaJSON),
                    width: snapshot.width,
                    height: snapshot.height,
                    digest: snapshot.digest,
                    samples: snapshot.samples,
                });
                continue;
            }
            const bytes = readFileSync(item.fullPath);
            if (relativePath.endsWith('.jsonl')) {
                entries.push({ path: relativePath, kind: 'jsonl', text: normalizeGeneratedText(bytes.toString('utf8')) });
                continue;
            }
            entries.push({ path: relativePath, kind: 'file', sha256: sha256(bytes), bytes: bytes.length });
        }
        entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
        assertSortedNames(entries.map(entry => entry.path), 'user tree snapshot');
        return entries;
    };

    const scenarios = {};
    const omitDigestCards = [];
    const runScenario = async (name, route, { fields = [], file = null, json = null }, options = {}) => {
        console.error('scenario: ' + name);
        let result;
        if (json !== null) {
            result = await request(origin + route, 'POST', { ...authHeaders, 'Content-Type': 'application/json' }, json);
        } else {
            const form = new FormData();
            for (const [key, value] of fields) form.set(key, value);
            if (file) form.set(file.field, new Blob([file.bytes], { type: 'application/octet-stream' }), file.filename);
            result = await request(origin + route, 'POST', authHeaders, form);
        }
        const effectiveOptions = { ...options, omitDigestFor: options.omitDigestFor ?? omitDigestCards.slice() };
        scenarios[name] = {
            route,
            fields,
            file: file ? { field: file.field, filename: file.filename, bytesHex: file.bytes.toString('hex') } : null,
            json,
            normalizeCreateDate: true,
            omitDigestFor: effectiveOptions.omitDigestFor,
            response: capture(result),
            characters: charactersSnapshot(true, effectiveOptions),
            userTree: userTreeSnapshot(effectiveOptions),
        };
    };

    const jsonFile = (body, filename) => ({ field: 'avatar', filename, bytes: Buffer.from(body, 'utf8') });

    await runScenario('importJSONv2', '/api/characters/import', {
        fields: [['file_type', 'json']], file: jsonFile(JSON.stringify(specV2Card('Imported V2')), 'v2.json'),
    }, { normalizeCreateDate: true });
    await runScenario('importJSONv1', '/api/characters/import', {
        fields: [['file_type', 'json']], file: jsonFile(JSON.stringify(V1_CARD), 'v1.json'),
    }, { normalizeCreateDate: true });
    await runScenario('importJSONGradio', '/api/characters/import', {
        fields: [['file_type', 'json']], file: jsonFile(JSON.stringify(GRADIO_CARD), 'gradio.json'),
    }, { normalizeCreateDate: true });
    await runScenario('importJSONPreserved', '/api/characters/import', {
        fields: [['file_type', 'json'], ['preserved_name', 'Preserved.json']], file: jsonFile(JSON.stringify(specV2Card('Preserved Source')), 'v2.json'),
    }, { normalizeCreateDate: true });
    await runScenario('importJSONInvalid', '/api/characters/import', {
        fields: [['file_type', 'json']], file: jsonFile('this is not json', 'broken.json'),
    });
    await runScenario('importJSONNoName', '/api/characters/import', {
        fields: [['file_type', 'json']], file: jsonFile(JSON.stringify({ description: 'no name' }), 'nameless.json'),
    });
    await runScenario('importPNGv2', '/api/characters/import', {
        fields: [['file_type', 'png']], file: { field: 'avatar', filename: 'card.png', bytes: charaPng(JSON.stringify(specV2Card('Imported PNG'))) },
    }, { normalizeCreateDate: true });
    await runScenario('importPNGv1', '/api/characters/import', {
        fields: [['file_type', 'png']], file: { field: 'avatar', filename: 'card.png', bytes: charaPng(JSON.stringify(V1_CARD)) },
    }, { normalizeCreateDate: true });
    await runScenario('importYaml', '/api/characters/import', {
        fields: [['file_type', 'yaml']], file: jsonFile(YAML_DOCUMENT, 'card.yaml'),
    }, { normalizeCreateDate: true });
    await runScenario('importUnsupportedFormat', '/api/characters/import', {
        fields: [['file_type', 'charx']], file: jsonFile('PK', 'card.charx'),
    });
    await runScenario('importMissingFile', '/api/characters/import', { json: JSON.stringify({ file_type: 'json' }) });

    await runScenario('editAvatarSuccess', '/api/characters/edit-avatar', {
        fields: [['avatar_url', 'EditTarget.png']],
        file: { field: 'avatar', filename: 'new.png', bytes: UPLOAD_PNG },
    });
    await runScenario('editAvatarNoFile', '/api/characters/edit-avatar', { fields: [['avatar_url', 'EditTarget.png']] });
    await runScenario('editAvatarMissingAvatarUrl', '/api/characters/edit-avatar', {
        file: { field: 'avatar', filename: 'new.png', bytes: UPLOAD_PNG },
    });
    await runScenario('editAvatarMissingCharacter', '/api/characters/edit-avatar', {
        fields: [['avatar_url', 'Nope.png']],
        file: { field: 'avatar', filename: 'new.png', bytes: UPLOAD_PNG },
    });
    await runScenario('editAvatarBadCard', '/api/characters/edit-avatar', {
        fields: [['avatar_url', 'NotACard.png']],
        file: { field: 'avatar', filename: 'new.png', bytes: UPLOAD_PNG },
    });

    // ---- Avatar crop/resize probed against the pinned geometry -------------
    // The `crop` query is what the frontend sends from the avatar cropper
    // (public/script.js sends tryParse(request.query.crop) through this route).
    // want_resize=true is the 512x768 branch; the sampled colours prove cover
    // (border cropped away -> red) rather than stretch (border kept -> white).
    const cropResizeQuery = '?crop=' + encodeURIComponent(JSON.stringify({ x: 0, y: 0, width: 8, height: 8, want_resize: true }));
    await runScenario('editAvatarCropResize', '/api/characters/edit-avatar' + cropResizeQuery, {
        fields: [['avatar_url', 'CropTarget.png']],
        file: { field: 'avatar', filename: 'crop.png', bytes: cropProbePng() },
    }, { omitDigestFor: ['CropTarget.png'] });
    omitDigestCards.push('CropTarget.png');
    const cropFixedQuery = '?crop=' + encodeURIComponent(JSON.stringify({ x: 2, y: 2, width: 4, height: 4, want_resize: false }));
    await runScenario('editAvatarCropNoResize', '/api/characters/edit-avatar' + cropFixedQuery, {
        fields: [['avatar_url', 'CropTargetFixed.png']],
        file: { field: 'avatar', filename: 'crop-fixed.png', bytes: cropProbePng() },
    });
    await runScenario('editAvatarCropMalformedQuery', '/api/characters/edit-avatar?crop=not-json', {
        fields: [['avatar_url', 'EditTarget.png']],
        file: { field: 'avatar', filename: 'new.png', bytes: UPLOAD_PNG },
    });

    // ---- CharX (ZIP) -------------------------------------------------------
    await runScenario('importCharX', '/api/characters/import', {
        fields: [['file_type', 'charx']], file: { field: 'avatar', filename: 'hero.charx', bytes: CHARX_ARCHIVE },
    });
    const CHARX_NO_AVATAR = buildZip([
        { name: 'card.json', data: Buffer.from(JSON.stringify({ spec: 'chara_card_v3', spec_version: '3.0', data: { name: 'CharX No Avatar', description: 'no icon' } })) },
    ]);
    await runScenario('importCharXNoAvatar', '/api/characters/import', {
        fields: [['file_type', 'charx']], file: { field: 'avatar', filename: 'no-avatar.charx', bytes: CHARX_NO_AVATAR },
    });
    await runScenario('importCharXNoCardJSON', '/api/characters/import', {
        fields: [['file_type', 'charx']], file: { field: 'avatar', filename: 'broken.charx', bytes: CHARX_NO_CARD_ARCHIVE },
    });
    await runScenario('importCharXMissingSpec', '/api/characters/import', {
        fields: [['file_type', 'charx']], file: { field: 'avatar', filename: 'no-spec.charx', bytes: CHARX_NO_SPEC_ARCHIVE },
    });
    await runScenario('importCharXTruncated', '/api/characters/import', {
        fields: [['file_type', 'charx']], file: { field: 'avatar', filename: 'truncated.charx', bytes: CHARX_TRUNCATED },
    });
    await runScenario('importCharXWrongBytes', '/api/characters/import', {
        fields: [['file_type', 'charx']], file: { field: 'avatar', filename: 'wrong.charx', bytes: Buffer.from('PK not really a zip') },
    });
    await runScenario('importCharXOversizedAsset', '/api/characters/import', {
        fields: [['file_type', 'charx']], file: { field: 'avatar', filename: 'oversized.charx', bytes: CHARX_OVERSIZED_ARCHIVE },
    });

    // ---- BYAF (ZIP) --------------------------------------------------------
    await runScenario('importByaf', '/api/characters/import', {
        fields: [['file_type', 'byaf']], file: { field: 'avatar', filename: 'hero.byaf', bytes: BYAF_ARCHIVE },
    });
    await runScenario('importByafMinimal', '/api/characters/import', {
        fields: [['file_type', 'byaf']], file: { field: 'avatar', filename: 'minimal.byaf', bytes: BYAF_MINIMAL_ARCHIVE },
    });
    await runScenario('importByafNoManifest', '/api/characters/import', {
        fields: [['file_type', 'byaf']], file: { field: 'avatar', filename: 'no-manifest.byaf', bytes: BYAF_NO_MANIFEST_ARCHIVE },
    });
    await runScenario('importByafEmptyCharacters', '/api/characters/import', {
        fields: [['file_type', 'byaf']], file: { field: 'avatar', filename: 'empty.byaf', bytes: BYAF_EMPTY_CHARACTERS_ARCHIVE },
    });
    await runScenario('importByafTruncated', '/api/characters/import', {
        fields: [['file_type', 'byaf']], file: { field: 'avatar', filename: 'truncated.byaf', bytes: BYAF_ARCHIVE.subarray(0, Math.floor(BYAF_ARCHIVE.length / 2)) },
    });

    // ---- RisuAI (the JSON and PNG spec branches plus sprite side effects) ---
    await runScenario('importRisuJSON', '/api/characters/import', {
        fields: [['file_type', 'json']], file: jsonFile(RISU_JSON.toString('utf8'), 'risu.json'),
    });
    await runScenario('importRisuPNG', '/api/characters/import', {
        fields: [['file_type', 'png']], file: { field: 'avatar', filename: 'risu.png', bytes: RISU_PNG },
    });

    const fixture = {
        schemaVersion: 1,
        baseline: { version: PINNED_VERSION, commit: PINNED_COMMIT },
        probe: 'pinned POST /api/characters/import and /api/characters/edit-avatar',
        normalization: [
            'Card `chat` values embed humanizedDateTime(), which is normalized to <humanizedDateTime>.',
            '`create_date` values that the import routes generate are normalized to <isoDate>.',
            'PNG bytes are compared by decoded chara JSON, dimensions and an RGBA pixel digest because pinned writeCharacterData re-encodes through Jimp.',
            'Card pixel DIGESTS are omitted for the want_resize crop scenario (omitDigestFor) because the codec is a deliberate divergence; its geometry is proven by sampled colours at cover-vs-stretch discriminating points instead.',
            '`userTree` records the whole user tree the import formats touch (character cards and their subfolders, chats/, user/images/), with generated timestamps normalized; aux asset bytes are compared by sha256.',
        ],
        inputs: {
            cookieSecret: COOKIE_SECRET,
            fixedMtimeMs: 1700000500000,
            existingCards: EXISTING_CARDS.map(card => ({ file: card.file, bytesHex: card.bytes.toString('hex') })),
        },
        scenarioOrder: Object.keys(scenarios),
        scenarios,
    };

    for (const scenario of Object.values(scenarios)) {
        if (scenario.response.headers['content-encoding'] === 'gzip') {
            scenario.response.headers['content-length'] = '<derived-from-uncompressed-body>';
        }
    }

    assertRecordedBodiesMatchTheirJSON(fixture);

    const outputFile = path.join(repositoryRoot, 'tests', 'oracle', 'sillytavern-1.19.0-characters-import.json');
    mkdirSync(path.dirname(outputFile), { recursive: true });
    writeFileSync(outputFile, JSON.stringify(fixture, null, 2) + '\n');
    console.log('Wrote tests/oracle/sillytavern-1.19.0-characters-import.json from pinned behavior');
} catch (error) {
    console.error(error);
    process.exitCode = 1;
} finally {
    await stopServer();
    safeCleanup();
}
