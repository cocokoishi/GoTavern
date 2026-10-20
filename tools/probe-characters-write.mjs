#!/usr/bin/env node
// Capture pinned character write behavior: create, rename, edit, edit-avatar,
// edit-attribute, merge-attributes, delete, duplicate and export.
//
// Every scenario records the HTTP response plus a snapshot of the resulting
// characters/chats trees. Character PNGs are compared by decoded `chara` JSON
// and by a pixel digest, because pinned writeCharacterData re-encodes every
// image through Jimp and PNG encoder bytes are therefore not comparable.

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';

const PINNED_COMMIT = '06bde939fb1e9c4c8d8641d810f0a916b5bce127';
const PINNED_VERSION = '1.19.0';
const COOKIE_SECRET = 'gotavern-pinned-characters-write-cookie-secret';
const sourceRoot = path.resolve(process.argv[2] ?? '');
const repositoryRoot = path.resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3]) {
    console.error('usage: node tools/probe-characters-write.mjs <pinned-source-clone-with-dependencies> <gotavern-root>');
    process.exit(2);
}
if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim() !== PINNED_COMMIT) {
    throw new Error('upstream checkout is not pinned at ' + PINNED_COMMIT);
}

// pngjs comes from the pinned checkout's installed dependency tree.
const { PNG } = createRequire(path.join(sourceRoot, 'package.json'))('pngjs');

const runtimeRoot = mkdtempSync(path.join(os.tmpdir(), 'gotavern-characters-write-oracle-'));
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
        || !path.basename(resolved).startsWith('gotavern-characters-write-oracle-')) {
        throw new Error('refusing to remove unexpected runtime path: ' + resolved);
    }
    rmSync(resolved, { recursive: true, force: true });
}

// ---- Deterministic PNG helpers ----

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
        pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
        pngChunk('IEND', Buffer.alloc(0)),
    ]);
}

function charaPng(cardJSON) {
    return buildPng([textChunk('chara', Buffer.from(cardJSON, 'utf8').toString('base64'))]);
}

// Reads the character JSON back out of a PNG the same way the pinned parser does.
function readPngCard(image) {
    if (image[0] !== 0x89 || image[1] !== 0x50 || image[2] !== 0x4E || image[3] !== 0x47) {
        throw new Error('not a png');
    }
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

/** Applies the documented date_added ctime normalization to raw response text. */
function normalizeCtimeText(text) {
    return text.replace(/"date_added":-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g, '"date_added":"<ctimeMs>"');
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

// ---- Cards under test ----

function specV2Card(name, extra = {}) {
    return {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        name,
        description: name + ' description',
        personality: name + ' personality',
        scenario: name + ' scenario',
        first_mes: name + ' first message',
        mes_example: '<START>\n{{user}}: hi\n{{char}}: hello',
        creatorcomment: name + ' creator notes',
        avatar: 'none',
        chat: name + ' - 2024-01-01@00h00m00s000ms',
        talkativeness: 0.5,
        fav: false,
        tags: ['alpha', 'beta'],
        create_date: '2024-01-01T00:00:00.000Z',
        probeUnknownTopLevel: { keep: [1, 2, 3] },
        data: {
            name,
            description: name + ' description',
            personality: name + ' personality',
            scenario: name + ' scenario',
            first_mes: name + ' first message',
            mes_example: '<START>\n{{user}}: hi\n{{char}}: hello',
            creator_notes: name + ' creator notes',
            system_prompt: name + ' system prompt',
            post_history_instructions: name + ' post history instructions',
            tags: ['alpha', 'beta'],
            creator: name + ' creator',
            character_version: '1.0',
            alternate_greetings: ['alt one'],
            extensions: { talkativeness: 0.5, fav: false, world: '', depth_prompt: { prompt: '', depth: 4, role: 'system' }, probeUnknownExtension: { keep: true } },
            probeUnknownDataField: 42,
        },
        ...extra,
    };
}

const CARD_BOB_V1 = {
    name: 'Rename V1',
    description: 'v1 description',
    personality: 'v1 personality',
    scenario: 'v1 scenario',
    first_mes: 'v1 first message',
    mes_example: 'v1 example',
    creatorcomment: 'v1 creator notes',
    avatar: 'none',
    chat: 'Rename V1 - 2024-01-01@00h00m00s000ms',
    talkativeness: 0.7,
    fav: 'true',
    tags: 'x, y ,z',
    create_date: '2024-04-04T00:00:00.000Z',
    probeUnknownV1: 'keep me',
};

const CARDS = [
    { file: 'Alice V2.png', json: JSON.stringify(specV2Card('Alice V2')) },
    { file: 'RenameMe.png', json: JSON.stringify(specV2Card('RenameMe')) },
    { file: 'RenameV1.png', json: JSON.stringify(CARD_BOB_V1) },
    { file: 'EditMe.png', json: JSON.stringify(specV2Card('EditMe')) },
    { file: 'AttrMe.png', json: JSON.stringify(specV2Card('AttrMe')) },
    { file: 'MergeMe.png', json: JSON.stringify(specV2Card('MergeMe')) },
    { file: 'MergeTwo.png', json: JSON.stringify(specV2Card('MergeTwo')) },
    { file: 'MergeBad.png', bytes: Buffer.from('not a png at all') },
    { file: 'MergeEmpty.png', bytes: buildPng([textChunk('chara', '')]) },
    { file: 'DeleteMe.png', json: JSON.stringify(specV2Card('DeleteMe')) },
    { file: 'DeleteChats.png', json: JSON.stringify(specV2Card('DeleteChats')) },
    { file: 'Dup.png', json: JSON.stringify(specV2Card('Dup')) },
    { file: 'Dup_1.png', json: JSON.stringify(specV2Card('Dup One')) },
    { file: 'ExportMe.png', json: JSON.stringify(specV2Card('ExportMe')) },
    { file: 'ImportTarget.png', json: JSON.stringify(specV2Card('ImportTarget')) },
];
for (const card of CARDS) {
    card.bytes = card.bytes ?? charaPng(card.json);
}

const WORLD_INFO = {
    name: 'AliceWorld',
    entries: {
        0: {
            uid: 0, key: ['alpha'], keysecondary: ['beta'], comment: 'first entry', content: 'world content zero',
            constant: false, selective: true, order: 100, disable: false, position: 0, depth: 2,
            extensions: { probeWorldExtension: 'keep' },
        },
        1: {
            uid: 1, key: ['gamma'], keysecondary: [], comment: 'second entry', content: 'world content one',
            constant: true, selective: false, order: 5, disable: true, position: 1,
        },
    },
};

const CHAT_FILES = {
    'chat-a.jsonl': [
        JSON.stringify({ chat_metadata: { integrity: 'probe' }, user_name: 'user', character_name: 'RenameMe' }),
        JSON.stringify({ name: 'RenameMe', is_user: false, send_date: '2024-01-02T00:00:00.000Z', mes: 'hello' }),
    ].join('\n'),
};

// ---- Observations ----


/** Replaces generated timestamps so the fixture is reproducible. */
function normalizeCardText(text, { normalizeCreateDate = false } = {}) {
    let normalized = text.replace(/\d{4}-\d{2}-\d{2}@\d{2}h\d{2}m\d{2}s\d{3}ms/g, '<humanizedDateTime>');
    if (normalizeCreateDate) {
        normalized = normalized.replace(/"create_date":"[^"]*"/g, '"create_date":"<isoDate>"');
    }
    return normalized;
}

async function pixelDigest(filePath) {
    try {
        // The pinned Jimp PNG decoder (a WASM module) cannot initialize in this
        // environment, so pixels are decoded with the pinned tree's pngjs.
        const decoded = PNG.sync.read(readFileSync(filePath));
        return {
            width: decoded.width,
            height: decoded.height,
            digest: sha256(decoded.data),
        };
    } catch {
        return { width: null, height: null, digest: null };
    }
}

async function charactersSnapshot(normalizeOptions) {
    const root = path.join(dataRoot, 'default-user', 'characters');
    let names = [];
    try {
        names = readdirSync(root).sort();
    } catch {
        return [];
    }
    const entries = [];
    for (const name of names) {
        const filePath = path.join(root, name);
        if (!statSync(filePath).isFile()) continue;
        const bytes = readFileSync(filePath);
        let charaJSON = null;
        try {
            charaJSON = normalizeCardText(readPngCard(bytes), normalizeOptions);
        } catch {
            charaJSON = null;
        }
        // The PNG byte digest is not recorded: pinned writeCharacterData
        // re-encodes through Jimp and the card metadata embeds generated
        // timestamps, so only the decoded card and the pixels are comparable.
        entries.push({ name, charaJSON, ...await pixelDigest(filePath) });
    }
    return entries;
}

function chatsSnapshot() {
    const root = path.join(dataRoot, 'default-user', 'chats');
    const entries = [];
    const visit = (directory, prefix) => {
        let names = [];
        try {
            names = readdirSync(directory).sort();
        } catch {
            return;
        }
        for (const name of names) {
            const filePath = path.join(directory, name);
            const relative = prefix ? `${prefix}/${name}` : name;
            if (statSync(filePath).isDirectory()) {
                entries.push({ path: relative + '/', kind: 'directory' });
                visit(filePath, relative);
            } else {
                entries.push({ path: relative, kind: 'file', sha256: sha256(readFileSync(filePath)) });
            }
        }
    };
    visit(root, '');
    return entries;
}

try {
    mkdirSync(path.join(dataRoot, '_storage'), { recursive: true });
    writeFileSync(path.join(dataRoot, 'cookie-secret.txt'), COOKIE_SECRET);
    writeFileSync(path.join(dataRoot, '_storage', sha256('user:default-user')), JSON.stringify({
        key: 'user:default-user',
        value: {
            handle: 'default-user', name: 'Characters Write Probe', created: 1700000000000,
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
    ], { cwd: sourceRoot, env: { ...process.env, NODE_ENV: 'test' }, stdout: 'pipe', stderr: 'pipe', stdio: ['ignore', 'pipe', 'pipe'] });
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
    const charactersRoot = path.join(userRoot, 'characters');
    mkdirSync(charactersRoot, { recursive: true });
    const fixedTime = new Date(1700000500000);
    for (const card of CARDS) {
        const target = path.join(charactersRoot, card.file);
        writeFileSync(target, card.bytes);
        utimesSync(target, fixedTime, fixedTime);
    }
    const worldsRoot = path.join(userRoot, 'worlds');
    mkdirSync(worldsRoot, { recursive: true });
    writeFileSync(path.join(worldsRoot, 'AliceWorld.json'), JSON.stringify(WORLD_INFO));
    for (const name of ['RenameMe', 'DeleteChats']) {
        const directory = path.join(userRoot, 'chats', name);
        mkdirSync(directory, { recursive: true });
        for (const [file, body] of Object.entries(CHAT_FILES)) {
            writeFileSync(path.join(directory, file), body);
            utimesSync(path.join(directory, file), fixedTime, fixedTime);
        }
    }


    const scenarios = {};
    const runScenario = async (name, route, body, options = {}) => {
        console.error('scenario: ' + name);
        const result = await post(route, body);
        const captured = capture(result);
        scenarios[name] = {
            route,
            request: body,
            binary: !!options.binary,
            normalizeCreateDate: !!options.normalizeCreateDate,
            response: captured,
            responseSha256: options.binary ? sha256(result.buffer) : null,
            responseCharaJSON: options.binary ? normalizeCardText(readPngCard(result.buffer), options) : null,
            characters: await charactersSnapshot(options),
            chats: chatsSnapshot(),
        };
    };

    // ---- create ----
    await runScenario('createBasic', '/api/characters/create', JSON.stringify({
        ch_name: 'Created One',
        description: 'created description',
        personality: 'created personality',
        scenario: 'created scenario',
        first_mes: 'created first message',
        mes_example: 'created example',
        creator_notes: 'created notes',
        creator: 'created creator',
        character_version: '9.9',
        tags: 'a, b ,c',
        fav: 'true',
        talkativeness: 0.75,
        system_prompt: 'created system',
        post_history_instructions: 'created post',
        depth_prompt_prompt: 'created depth',
        depth_prompt_depth: '6',
        depth_prompt_role: 'user',
        world: 'AliceWorld',
        extensions: '{"probeExtension":{"keep":true}}',
    }));
    await runScenario('createWithFileName', '/api/characters/create', JSON.stringify({ ch_name: 'Named Card', file_name: 'Custom Name' }));
    await runScenario('createDuplicateName', '/api/characters/create', JSON.stringify({ ch_name: 'Created One' }));
    await runScenario('createDotName', '/api/characters/create', JSON.stringify({ ch_name: '.' }));
    await runScenario('createNonStringName', '/api/characters/create', JSON.stringify({ ch_name: 7 }));
    await runScenario('createMissingName', '/api/characters/create', JSON.stringify({}));

    // ---- rename ----
    await runScenario('renameV2', '/api/characters/rename', JSON.stringify({ avatar_url: 'RenameMe.png', new_name: 'RenameMe Renamed' }));
    await runScenario('renameV1', '/api/characters/rename', JSON.stringify({ avatar_url: 'RenameV1.png', new_name: 'Rename V1 Renamed' }), { normalizeCreateDate: true });
    await runScenario('renameMissingNewName', '/api/characters/rename', JSON.stringify({ avatar_url: 'Dup.png' }));
    await runScenario('renameForbidden', '/api/characters/rename', JSON.stringify({ avatar_url: '../x.png', new_name: 'y' }));
    // NOTE: a non-string new_name calls sanitize() outside the handler's try
    // block, so pinned Node rejects the async handler and the process exits.
    // That crash is not a behavior GoTavern reproduces; see compat-matrix.md.

    // ---- edit ----
    await runScenario('editFull', '/api/characters/edit', JSON.stringify({
        avatar_url: 'EditMe.png',
        ch_name: 'EditMe Edited',
        description: 'edited description',
        personality: 'edited personality',
        scenario: 'edited scenario',
        first_mes: 'edited first message',
        mes_example: 'edited example',
        creator_notes: 'edited notes',
        creator: 'edited creator',
        character_version: '2.0',
        tags: ['edited'],
        fav: 'true',
        talkativeness: 0.25,
        chat: 'EditMe - 2024-08-08@01h02m03s004ms',
        create_date: '2024-08-08T01:02:03.004Z',
    }));
    await runScenario('editInvalidName', '/api/characters/edit', JSON.stringify({ avatar_url: 'EditMe.png', ch_name: '.' }));
    await runScenario('editMissingName', '/api/characters/edit', JSON.stringify({ avatar_url: 'EditMe.png' }));

    // ---- edit-attribute ----
    await runScenario('editAttributeTopLevel', '/api/characters/edit-attribute', JSON.stringify({
        avatar_url: 'AttrMe.png', ch_name: 'AttrMe', field: 'description', value: 'attribute description',
    }));
    await runScenario('editAttributeDataField', '/api/characters/edit-attribute', JSON.stringify({
        avatar_url: 'AttrMe.png', ch_name: 'AttrMe', field: 'creator', value: 'attribute creator',
    }));
    await runScenario('editAttributeJSONData', '/api/characters/edit-attribute', JSON.stringify({
        avatar_url: 'AttrMe.png', ch_name: 'AttrMe', field: 'json_data', value: 'x',
    }));
    await runScenario('editAttributeUnknownField', '/api/characters/edit-attribute', JSON.stringify({
        avatar_url: 'AttrMe.png', ch_name: 'AttrMe', field: 'not_a_field', value: 'x',
    }));

    // ---- merge-attributes ----
    await runScenario('mergeSingle', '/api/characters/merge-attributes', JSON.stringify({
        avatar: 'MergeMe.png',
        description: 'merged description',
        data: { creator: 'merged creator', extensions: { world: 'MergedWorld' } },
        probeUnknownTopLevel: { keep: [1, 2, 3] },
    }));
    await runScenario('mergeUnsetSentinel', '/api/characters/merge-attributes', JSON.stringify({
        avatar: 'MergeTwo.png',
        data: { extensions: { world: '__@@UNSET@@__', probeUnknownExtension: '__@@UNSET@@__' } },
    }));
    await runScenario('mergeInvalidCard', '/api/characters/merge-attributes', JSON.stringify({
        avatar: 'MergeBad.png', description: 'merged',
    }));
    await runScenario('mergeEmptyCard', '/api/characters/merge-attributes', JSON.stringify({
        avatar: 'MergeEmpty.png', description: 'merged',
    }));
    await runScenario('mergeBulk', '/api/characters/merge-attributes', JSON.stringify({
        avatars: ['MergeMe.png', 'MergeTwo.png'],
        data: { data: { character_version: '9.0' } },
    }));
    await runScenario('mergeBulkFiltered', '/api/characters/merge-attributes', JSON.stringify({
        avatars: ['MergeMe.png', 'MergeTwo.png'],
        data: { description: 'filtered description' },
        filter: { path: 'data.character_book' },
    }));
    await runScenario('mergeBulkInvalidAvatar', '/api/characters/merge-attributes', JSON.stringify({
        avatars: ['not-a-png.txt'], data: { description: 'x' },
    }));
    await runScenario('mergeBulkInvalidData', '/api/characters/merge-attributes', JSON.stringify({
        avatars: ['MergeMe.png'], data: 'not an object',
    }));

    // ---- delete ----
    await runScenario('deleteExisting', '/api/characters/delete', JSON.stringify({ avatar_url: 'DeleteMe.png' }));
    await runScenario('deleteWithChats', '/api/characters/delete', JSON.stringify({ avatar_url: 'DeleteChats.png', delete_chats: true }));
    await runScenario('deleteMissing', '/api/characters/delete', JSON.stringify({ avatar_url: 'Nope.png' }));
    // NOTE: a non-string avatar_url calls sanitize() outside the handler's try
    // block and crashes the pinned Node process, so it is not probed here.

    // ---- duplicate ----
    await runScenario('duplicatePlain', '/api/characters/duplicate', JSON.stringify({ avatar_url: 'Dup.png' }));
    await runScenario('duplicateNumbered', '/api/characters/duplicate', JSON.stringify({ avatar_url: 'Dup_1.png' }));
    await runScenario('duplicateMissing', '/api/characters/duplicate', JSON.stringify({ avatar_url: 'Nope.png' }));
    await runScenario('duplicateForbidden', '/api/characters/duplicate', JSON.stringify({ avatar_url: '../x.png' }));

    // ---- export ----
    await runScenario('exportJSON', '/api/characters/export', JSON.stringify({ avatar_url: 'ExportMe.png', format: 'json' }));
    await runScenario('exportPNG', '/api/characters/export', JSON.stringify({ avatar_url: 'ExportMe.png', format: 'png' }), { binary: true });
    await runScenario('exportBadFormat', '/api/characters/export', JSON.stringify({ avatar_url: 'ExportMe.png', format: 'txt' }));
    await runScenario('exportMissing', '/api/characters/export', JSON.stringify({ avatar_url: 'Nope.png', format: 'json' }));

    const fixture = {
        schemaVersion: 1,
        baseline: { version: PINNED_VERSION, commit: PINNED_COMMIT },
        probe: 'pinned character write routes (create/rename/edit/edit-avatar/edit-attribute/merge-attributes/delete/duplicate/export)',
        normalization: [
            'Card `chat` values embed humanizedDateTime(), which is normalized to <humanizedDateTime>.',
            '`create_date` values that the route generates are normalized to <isoDate>.',
            'PNG bytes are compared by decoded chara JSON, dimensions and an RGBA pixel digest because pinned writeCharacterData re-encodes through Jimp.',
            'The /merge-attributes bulk updated/skipped/failed arrays are sorted because the pinned batches resolve concurrently, and the ETag derived from the unsorted bytes is recorded as a marker.',
            'The full characters and chats trees are recorded after every scenario; chat file mtimes are pinned by the probe.',
        ],
        inputs: {
            cookieSecret: COOKIE_SECRET,
            fixedMtimeMs: 1700000500000,
            cards: CARDS.map(card => ({ file: card.file, bytesHex: card.bytes.toString('hex') })),
            worldInfo: WORLD_INFO,
            chatFiles: CHAT_FILES,
            chatCharacters: ['RenameMe', 'DeleteChats'],
        },
        scenarioOrder: Object.keys(scenarios),
        scenarios,
    };

    // Bulk results resolve concurrently in pinned Node; record them as sets and
    // mark the derived ETag, which is a function of the unsorted bytes.
    for (const scenario of Object.values(scenarios)) {
        for (const key of ['updated', 'skipped', 'failed']) {
            const list = scenario.response.body?.[key];
            if (Array.isArray(list)) {
                list.sort();
                scenario.response.headers.etag = '<derived-from-sorted-body>';
            }
        }
        // Pinned Node gzips compressible JSON bodies, which removes
        // content-length; GoTavern does not implement that middleware yet.
        if (scenario.response.headers['content-encoding'] === 'gzip') {
            scenario.response.headers['content-length'] = '<derived-from-uncompressed-body>';
        }
    }

    const outputFile = path.join(repositoryRoot, 'tests', 'oracle', 'sillytavern-1.19.0-characters-write.json');
    mkdirSync(path.dirname(outputFile), { recursive: true });
    writeFileSync(outputFile, JSON.stringify(fixture, null, 2) + '\n');
    console.log('Wrote tests/oracle/sillytavern-1.19.0-characters-write.json from pinned behavior');
} catch (error) {
    console.error(error);
    process.exitCode = 1;
} finally {
    await stopServer();
    safeCleanup();
}
