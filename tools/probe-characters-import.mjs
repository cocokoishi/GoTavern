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

function buildPng(textChunks, pixels) {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(2, 0);
    ihdr.writeUInt32BE(2, 4);
    ihdr[8] = 8;
    ihdr[9] = 2;
    const raw = pixels ?? Buffer.from([0, 1, 2, 3, 4, 5, 6, 0, 7, 8, 9, 10, 11, 12]);
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
const EXISTING_CARDS = [
    { file: 'EditTarget.png', bytes: charaPng(JSON.stringify(EXISTING_CARD)) },
    { file: 'NotACard.png', bytes: Buffer.from('not a png at all') },
];
const UPLOAD_PNG = buildPng([], Buffer.from([0, 200, 201, 202, 203, 204, 205, 0, 206, 207, 208, 209, 210, 211]));

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

    const charactersSnapshot = (normalizeCreateDate) => {
        const entries = [];
        for (const name of readdirSync(charactersRoot).sort()) {
            const filePath = path.join(charactersRoot, name);
            if (!statSync(filePath).isFile()) continue;
            let charaJSON = null;
            try {
                charaJSON = normalizeCardText(readPngCard(readFileSync(filePath)), normalizeCreateDate);
            } catch {
                charaJSON = null;
            }
            let width = null;
            let height = null;
            let digest = null;
            try {
                const decoded = PNG.sync.read(readFileSync(filePath));
                width = decoded.width;
                height = decoded.height;
                digest = sha256(decoded.data);
            } catch {
                // Not a decodable PNG.
            }
            entries.push({ name, charaJSON, width, height, digest });
        }
        return entries;
    };

    const scenarios = {};
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
        scenarios[name] = {
            route,
            fields,
            file: file ? { field: file.field, filename: file.filename, bytesHex: file.bytes.toString('hex') } : null,
            json,
            normalizeCreateDate: true,
            response: capture(result),
            characters: charactersSnapshot(true),
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

    const fixture = {
        schemaVersion: 1,
        baseline: { version: PINNED_VERSION, commit: PINNED_COMMIT },
        probe: 'pinned POST /api/characters/import and /api/characters/edit-avatar',
        normalization: [
            'Card `chat` values embed humanizedDateTime(), which is normalized to <humanizedDateTime>.',
            '`create_date` values that the import routes generate are normalized to <isoDate>.',
            'PNG bytes are compared by decoded chara JSON, dimensions and an RGBA pixel digest because pinned writeCharacterData re-encodes through Jimp.',
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
