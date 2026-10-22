#!/usr/bin/env node
// @gotavern-oracle: fixture=sillytavern-1.19.0-runtime-roundtrip.json label="runtime round trip"
// Record what a GoTavern-written runtime tree looks like to the PINNED SillyTavern server, and what
// a second boot of either subject changes. This is the differential for the one direction nobody has
// run: pinned Node booting over data GoTavern created.
//
// WHY THIS EXISTS. `tests/oracle/sillytavern-1.19.0-fresh-start.json` pins what an EMPTY directory
// becomes after one pinned boot and what GoTavern must reproduce. It says nothing about a runtime that
// already exists, and nothing at all about GoTavern's output being read back by pinned. A tree that
// GoTavern writes but pinned cannot parse (or silently rewrites) is user-data corruption, and no
// fixture covered it before this one.
//
// WHAT IS ASSERTED WHERE, because a reader must never mistake one for the other:
//   - the probe (HERE, at record time) asserts the cross-subject properties: pinned's rewrites over a
//     GoTavern tree equal pinned's rewrites over an empty tree, no user-data path changes, nothing is
//     deleted, and each subject's second boot is idempotent (the pinned second boot is recorded as the
//     CONTROL, so "pinned also re-normalises this" and "GoTavern broke something" stay distinguishable);
//   - internal/startup/runtime_roundtrip_test.go asserts FIXTURE COHERENCE at replay time plus the
//     GoTavern side of idempotence, which it can actually execute;
//   - the cross-subject properties are re-asserted by the CI oracle job, which re-records this fixture
//     and requires zero diff. They are NOT replayed by a Go test, because a Go test cannot boot pinned
//     Node, and pretending otherwise would be the fake-oracle mistake this project has already made.
//
// THE BINARY. This probe REQUIRES `GOTAVERN_BINARY` and fails when it is absent; it never compiles one
// and never skips a step. CI publishes the executables as the `gotavern-lane-binaries` artifact
// (`gotavern-linux-amd64` on the oracle job, `gotavern-windows-amd64.exe` for a Windows recording).
//
// NOTHING HERE IS HOST-DERIVED. Snapshots are relative paths with `type`, `bytes` and `sha256`; no
// absolute path, no port, no timestamp and no file mode is recorded. Every exclusion is declared in
// `comparisonExclusions`/`normalization` with a reason and the replay REFUSES an undeclared one.

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
    cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import {
    PINNED_COMMIT, PINNED_VERSION, choosePort, safeCleanup, writeFixture,
} from './lib/pinned-outbound.mjs';

const sourceRoot = path.resolve(process.argv[2] ?? '');
const repositoryRoot = path.resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3]) {
    console.error('usage: node tools/probe-runtime-roundtrip.mjs <pinned-source-clone> <gotavern-root>');
    process.exit(2);
}
const gotavernBinary = path.resolve(process.env.GOTAVERN_BINARY ?? '');
if (!process.env.GOTAVERN_BINARY) {
    console.error('GOTAVERN_BINARY is required: point it at a CI-built gotavern executable '
        + '(the `gotavern-lane-binaries` artifact). This probe never compiles one and never skips.');
    process.exit(2);
}
if (!existsSync(gotavernBinary)) {
    console.error(`GOTAVERN_BINARY does not exist: ${gotavernBinary}`);
    process.exit(2);
}
if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim() !== PINNED_COMMIT) {
    throw new Error(`upstream checkout is not pinned at ${PINNED_COMMIT}`);
}

// Pinned runs git at startup; pinning core.abbrev keeps any abbreviation out of the observation.
const PINNED_GIT_ENVIRONMENT = {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.abbrev',
    GIT_CONFIG_VALUE_0: '9',
};

const ROOT_PREFIX = 'gotavern-runtime-roundtrip-';
const RUNTIME_ROOT_PREFIX = 'gotavern-roundtrip-step-';

// The one directory whose CONTENTS are Node's webpack disk cache. It is excluded from EVERY
// cross-subject comparison, not merely normalized, because only the Node middleware compiler creates
// it: GoTavern embeds the generated bundle, so its tree has no `_webpack` at all and a set comparison
// would fail for a reason that is not a defect. The Go replay of `fresh-start` skips it for the same
// reason (internal/startup/data_startup_test.go), so this is the project's existing rule.
const COMPARISON_EXCLUSIONS = {
    'data/_webpack/**': 'the Node webpack middleware cache: only pinned Node writes it, so the PATH SET legitimately differs between subjects. Retained in each subject\'s own snapshot with size and contents omitted; excluded from every cross-subject and idempotence comparison.',
};

const NORMALIZATION = {
    // The REASON strings are the ones internal/startup/snapshotStartupDataRoot already stamps on the
    // same paths for fresh-start, so the two fixtures read as one convention rather than two.
    'data/cookie-secret.txt': 'generated secret value omitted',
    'data/_storage/**': 'account-store bytes can contain generated timestamps',
    'data/_webpack/**': 'Webpack cache is runtime-generated; size and contents vary between starts',
    'data/<handle>/stats.json': 'startup statistics are time-dependent',
    'data/<handle>/backups/settings_<handle>_<timestamp>.json': 'the upstream startup backup name contains a local timestamp; the path is normalised to <timestamp> and the content hash is retained',
    // MEASURED, not assumed: two consecutive recordings disagreed on this file's sha256, and decoding
    // the embedded card showed why. The import route REWRITES the card it stores with `chat`
    // ("<name> - YYYY-MM-DD@HHhMMmSSsMMMms") and `create_date` (an ISO timestamp), both stamped from
    // the current time to the millisecond, and both inside the base64 that is the tEXt chunk. The SIZE
    // is recorded because both formats are fixed width; the bytes are not, because rewriting a card to
    // mask one field would mean rebuilding a PNG, and what the card SAYS is recorded by reading it back
    // through pinned instead (see `readBack`).
    'data/<handle>/characters/*.png': 'the import route rewrites the stored card with a generated `chat` name (ending YYYY-MM-DD@HHhMMmSSsMMMms) and an ISO `create_date`, both from the current time; the size is recorded, the bytes are not, and the card content is recorded by reading it back through pinned',
    'data/_cache/characters/**': 'the character disk cache. Its file name is a hash of the character, which embeds the generated chat name and create_date above, so the key differs on every run; reported as a count in the read-back delta rather than as paths',
};

const sha256 = value => createHash('sha256').update(value).digest('hex');

// ---- snapshots -------------------------------------------------------------------------------

// normalizePath applies the recorded filename normalisation: only the timestamped backup name.
function normalizePath(relative) {
    // EXACTLY fresh-start's rule: only the timestamp becomes a placeholder, the handle stays
    // literal, so the two fixtures record the same path for the same file.
    return relative.replace(/(settings_[^/]+_)\d{8}-\d{6}(?=\.json$)/, '$1<timestamp>');
}

function isWebpackPath(relative) {
    return relative === '_webpack' || relative.startsWith('_webpack/');
}

function isNormalizedBody(relative) {
    if (relative === 'cookie-secret.txt') return NORMALIZATION['data/cookie-secret.txt'];
    if (relative.startsWith('_storage/') || relative.startsWith('_storage\\')) return NORMALIZATION['data/_storage/**'];
    if (isWebpackPath(relative)) return NORMALIZATION['data/_webpack/**'];
    if (relative === 'default-user/stats.json') return NORMALIZATION['data/<handle>/stats.json'];
    return null;
}

// isCardPath matches a stored character card's file, without deciding whether it needs normalising:
// the decision is made from the bytes (see cardCarriesGeneratedTimestamp).
function isCardPath(relative) {
    return /^default-user\/characters\/[^/]+\.png$/.test(relative);
}

// cardCarriesGeneratedTimestamp reads the `chara`/`ccv3` tEXt chunk and reports whether the embedded
// card holds the import route's generated chat name (`<name> - YYYY-MM-DD@HHhMMmSSsMMMms`). A seeded
// default card does not, and is therefore compared byte for byte like any other seeded asset.
function cardCarriesGeneratedTimestamp(body) {
    if (body.length < 8 || body.readUInt32BE(0) !== 0x89504e47) return false;
    let index = 8;
    while (index + 8 <= body.length) {
        const length = body.readUInt32BE(index);
        const type = body.subarray(index + 4, index + 8).toString('latin1');
        const data = body.subarray(index + 8, index + 8 + length);
        if (type === 'tEXt') {
            const separator = data.indexOf(0);
            if (separator > 0) {
                const keyword = data.subarray(0, separator).toString('latin1').toLowerCase();
                if (keyword === 'chara' || keyword === 'ccv3') {
                    let card = null;
                    try {
                        card = JSON.parse(Buffer.from(data.subarray(separator + 1).toString('latin1'), 'base64').toString('utf8'));
                    } catch {
                        card = null;
                    }
                    if (card && typeof card.chat === 'string' && / - \d{4}-\d{2}-\d{2}@\d{2}h\d{2}m\d{2}s\d{3}ms$/.test(card.chat)) {
                        return true;
                    }
                }
            }
        }
        if (type === 'IEND') break;
        index += 12 + length;
    }
    return false;
}

// snapshotRuntime records ONE logical runtime — the config file plus the whole data tree — in the same
// shape `fresh-start` uses, so the two fixtures can be diffed by eye.
function snapshotRuntime(runtimeRoot) {
    const configPath = path.join(runtimeRoot, 'config.yaml');
    const configBytes = existsSync(configPath) ? readFileSync(configPath) : null;
    const config = configBytes === null
        ? { path: 'config.yaml', present: false }
        : { path: 'config.yaml', present: true, bytes: configBytes.length, sha256: sha256(configBytes) };
    const entries = [];
    const dataRoot = path.join(runtimeRoot, 'data');
    if (existsSync(dataRoot)) walk(dataRoot, '');
    entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
    return { config, entries };

    function walk(directory, prefix) {
        for (const name of readdirSync(directory)) {
            const full = path.join(directory, name);
            const relative = prefix ? `${prefix}/${name}` : name;
            const info = statSync(full);
            const normalizedRelative = normalizePath(relative);
            if (info.isDirectory()) {
                entries.push({ path: normalizedRelative, type: 'directory' });
                walk(full, relative);
                continue;
            }
            if (!info.isFile()) {
                entries.push({ path: normalizedRelative, type: 'special' });
                continue;
            }
            const normalized = isNormalizedBody(relative);
            if (normalized !== null) {
                // Size is retained even where contents are omitted, so a path that suddenly grows is
                // still visible; only the webpack cache drops it (its sizes vary by compression).
                if (isWebpackPath(relative)) {
                    entries.push({ path: normalizedRelative, type: 'file', normalized });
                } else {
                    entries.push({ path: normalizedRelative, type: 'file', bytes: info.size, normalized });
                }
                continue;
            }
            const body = readFileSync(full);
            // A card the IMPORT ROUTE rewrote is normalised; a seeded default card is not. The
            // distinction is measured from the bytes (does the embedded card carry the generated
            // `chat` name?), not guessed from the path, so a seeded asset keeps its sha256 compared.
            if (isCardPath(relative) && cardCarriesGeneratedTimestamp(body)) {
                entries.push({
                    path: normalizedRelative,
                    type: 'file',
                    bytes: body.length,
                    normalized: NORMALIZATION['data/<handle>/characters/*.png'],
                });
                continue;
            }
            entries.push({ path: normalizedRelative, type: 'file', bytes: body.length, sha256: sha256(body) });
        }
    }
}

// entriesByPath indexes a snapshot for comparison, dropping the one excluded directory.
function entriesByPath(snapshot) {
    const map = new Map();
    for (const entry of snapshot.entries) {
        if (isWebpackPath(entry.path)) continue;
        map.set(entry.path, entry);
    }
    return map;
}

function sameEntry(left, right) {
    if (left === undefined || right === undefined) return false;
    if (left.type !== right.type) return false;
    if (left.type !== 'file') return true;
    if (left.normalized !== undefined || right.normalized !== undefined) {
        return left.normalized === right.normalized;
    }
    return left.bytes === right.bytes && left.sha256 === right.sha256;
}

function diffSnapshots(before, after) {
    const beforeMap = entriesByPath(before);
    const afterMap = entriesByPath(after);
    const added = [];
    const removed = [];
    const changed = [];
    for (const [entryPath, entry] of afterMap) {
        if (!beforeMap.has(entryPath)) {
            added.push(entry);
            continue;
        }
        if (!sameEntry(beforeMap.get(entryPath), entry)) changed.push({ before: beforeMap.get(entryPath), after: entry });
    }
    for (const entryPath of beforeMap.keys()) {
        if (!afterMap.has(entryPath)) removed.push(beforeMap.get(entryPath));
    }
    return { added, removed, changed };
}

function describeDiff(diff) {
    return {
        added: diff.added.map(entry => entry.path).sort(),
        removed: diff.removed.map(entry => entry.path).sort(),
        changed: diff.changed.map(item => item.after.path).sort(),
    };
}

// ---- booting the two subjects ----------------------------------------------------------------

function bootArguments(runtimeRoot, port) {
    // IDENTICAL argument list for both subjects, because the flags are the pinned CLI surface and
    // GoTavern's commandline package implements the same names. Only the launcher differs.
    return [
        '--configPath', path.join(runtimeRoot, 'config.yaml'),
        '--dataRoot', path.join(runtimeRoot, 'data'),
        '--listenAddressIPv4', '127.0.0.1',
        '--enableIPv4', 'true',
        '--enableIPv6', 'false',
        '--listen', 'false',
        '--port', String(port),
        '--browserLaunchEnabled', 'false',
        '--heartbeatInterval', '0',
    ];
}

async function request(url, options = {}) {
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(20000), ...options });
    const body = Buffer.from(await response.arrayBuffer());
    return { response, body };
}

async function boot(subject, runtimeRoot, logs) {
    const port = await choosePort();
    const origin = `http://127.0.0.1:${port}`;
    const args = bootArguments(runtimeRoot, port);
    const child = subject === 'pinned'
        ? spawn(process.execPath, ['server.js', ...args], {
            cwd: sourceRoot,
            env: { ...process.env, NODE_ENV: 'test', ...PINNED_GIT_ENVIRONMENT },
            stdio: ['ignore', 'pipe', 'pipe'],
        })
        : spawn(gotavernBinary, ['start', ...args], {
            cwd: runtimeRoot,
            env: { ...process.env },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => logs.push(chunk));
    child.stderr.on('data', chunk => logs.push(chunk));

    const stop = async () => {
        if (child.exitCode !== null) return;
        child.kill('SIGINT');
        await Promise.race([
            new Promise(resolve => child.once('exit', resolve)),
            new Promise(resolve => setTimeout(resolve, 10000)),
        ]);
        if (child.exitCode === null) child.kill();
    };

    const deadline = Date.now() + 900000;
    let lastError = null;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) {
            await stop();
            throw new Error(`${subject} exited before becoming ready:\n${logs.join('').slice(-12000)}`);
        }
        try {
            const { response } = await request(`${origin}/version`);
            if (response.status === 200) return { origin, stop, port };
        } catch (error) {
            lastError = error;
        }
        await new Promise(resolve => setTimeout(resolve, 300));
    }
    await stop();
    throw new Error(`${subject} did not become ready: ${lastError?.message ?? 'none'}\n${logs.join('').slice(-12000)}`);
}

// ---- user data, written through GoTavern's OWN routes -----------------------------------------

const EXTENSION_MANIFEST = JSON.stringify({
    display_name: 'Runtime Round Trip Probe',
    loading_order: 10,
    requires: [],
    optional: [],
    js: 'index.js',
    css: '',
    author: 'GoTavern probe',
    version: '1.0.0',
    homePage: 'https://example.invalid/',
}, null, 4);
const EXTENSION_INDEX_JS = '// synthetic extension written by tools/probe-runtime-roundtrip.mjs\nexport const probe = true;\n';

// A valid 1x1 greyscale PNG carrying the character JSON base64 in a `chara` tEXt chunk, which is the
// V2 card format the import route reads. The bytes are fixed here, so the avatar the import stores is
// deterministic: a JSON card instead makes the route GENERATE a placeholder avatar whose bytes differ
// per run, which is how this was found (two recordings disagreed on its sha256 and on its cache key).
const PNG_CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let index = 0; index < 256; index++) {
        let value = index;
        for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
        table[index] = value >>> 0;
    }
    return table;
})();
const crc32 = buffer => {
    let crc = 0xffffffff;
    for (const byte of buffer) crc = (crc >>> 8) ^ PNG_CRC_TABLE[(crc ^ byte) & 0xff];
    return (crc ^ 0xffffffff) >>> 0;
};
const adler32 = buffer => {
    let low = 1;
    let high = 0;
    for (const byte of buffer) {
        low = (low + byte) % 65521;
        high = (high + low) % 65521;
    }
    return ((high << 16) | low) >>> 0;
};
const u32be = value => {
    const buffer = Buffer.alloc(4);
    buffer.writeUInt32BE(value >>> 0, 0);
    return buffer;
};
function pngChunk(type, data) {
    const typeBytes = Buffer.from(type, "ascii");
    return Buffer.concat([u32be(data.length), typeBytes, data, u32be(crc32(Buffer.concat([typeBytes, data])))]);
}
function cardPng(card) {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(1, 0);
    ihdr.writeUInt32BE(1, 4);
    ihdr[8] = 8;
    const raw = Buffer.from([0x00, 0x5a]);
    const stored = Buffer.alloc(5);
    stored[0] = 0x01;
    stored.writeUInt16LE(raw.length, 1);
    stored.writeUInt16LE((~raw.length) & 0xffff, 3);
    const idat = Buffer.concat([Buffer.from([0x78, 0x01]), stored, raw, u32be(adler32(raw))]);
    const chara = Buffer.concat([Buffer.from("chara", "latin1"), Buffer.from([0]), Buffer.from(Buffer.from(card, "utf8").toString("base64"), "latin1")]);
    return Buffer.concat([
        Buffer.from("89504e470d0a1a0a", "hex"),
        pngChunk("IHDR", ihdr),
        pngChunk("tEXt", chara),
        pngChunk("IDAT", idat),
        pngChunk("IEND", Buffer.alloc(0)),
    ]);
}

const CHARACTER_CARD = JSON.stringify({
    name: 'Round Trip Probe',
    description: 'A synthetic character card written through /api/characters/import.',
    personality: 'methodical',
    scenario: 'a differential test',
    first_mes: 'Hello from the runtime round trip probe.',
    mes_example: '',
    creator_notes: 'synthetic fixture data',
    system_prompt: '',
    post_history_instructions: '',
    tags: ['probe'],
    creator: 'GoTavern probe',
    character_version: '1.0.0',
    alternate_greetings: [],
    extensions: {},
}, null, 2);

// Built once, here, because it embeds the card above.
const CARD_PNG = cardPng(CHARACTER_CARD);


async function userDataSession(origin) {
    const csrf = await request(`${origin}/csrf-token`);
    if (csrf.response.status !== 200) throw new Error(`csrf-token = ${csrf.response.status}`);
    const token = JSON.parse(csrf.body.toString('utf8')).token;
    const cookie = csrf.response.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ');
    return { token, cookie };
}

async function writeUserData(origin, session, log, dataRoot) {
    const headers = { cookie: session.cookie, 'x-csrf-token': session.token };
    const post = async (label, route, body, contentType = 'application/json') => {
        const { response, body: payload } = await request(`${origin}${route}`, {
            method: 'POST',
            headers: { ...headers, 'content-type': contentType },
            body,
        });
        log.push({ label, route, status: response.status, bodyText: payload.toString('utf8').slice(0, 400) });
        if (response.status !== 200) {
            throw new Error(`${label}: ${route} answered ${response.status}: ${payload.toString('utf8').slice(0, 400)}`);
        }
        return payload;
    };

    // 1. a character card, through the import route. The multipart shape is the one the recorded
    // oracle already pins (tools/probe-characters-import.mjs): ONE file part named `avatar` plus a TEXT
    // field `file_type`. A probe that guessed the part names gets the route's own 400 from
    // `!request.body || !request.file`, which is how this line was found.
    const form = new FormData();
    form.append('file_type', 'png');
    form.append('avatar', new Blob([CARD_PNG], { type: 'image/png' }), 'round-trip-probe.png');
    const imported = await request(`${origin}/api/characters/import`, { method: 'POST', headers, body: form });
    log.push({ label: 'characterImport', route: '/api/characters/import', status: imported.response.status, bodyText: imported.body.toString('utf8').slice(0, 400) });
    if (imported.response.status !== 200) {
        throw new Error(`character import answered ${imported.response.status}: ${imported.body.toString('utf8').slice(0, 400)}`);
    }

    // 2. a chat, through the save route.
    await post('chatSave', '/api/chats/save', JSON.stringify({
        avatar_url: 'Round Trip Probe.png',
        ch_name: 'Round Trip Probe',
        file_name: 'round-trip-probe',
        chat_metadata: { probe: true },
        user_name: 'User',
        chat: [
            { name: 'User', is_user: true, send_date: 'January 1, 2025 12:00am', mes: 'Hello.', extra: {} },
            { name: 'Round Trip Probe', is_user: false, send_date: 'January 1, 2025 12:00am', mes: 'Hello from the round trip probe.', extra: {} },
        ],
    }));

    // 3. a world info file, through the edit route.
    await post('worldEdit', '/api/worldinfo/edit', JSON.stringify({
        name: 'round-trip-world',
        data: { entries: { '0': { uid: 0, key: ['probe'], keysecondary: [], content: 'World entry written by the round trip probe.', selective: true } } },
    }));

    // 4. a preset, through the save route.
    await post('presetSave', '/api/presets/save', JSON.stringify({
        name: 'round-trip-preset',
        apiId: 'openai',
        preset: { temperature: 0.5, prompt: 'a synthetic preset' },
    }));

    // 5. an extension directory. `writtenBy: probe` in the fixture says so plainly: there is no
    // route that can create one without git or a network fetch, so the probe writes these two files
    // itself rather than implying GoTavern created them.
    const extensionDirectory = path.join(dataRoot, 'default-user', 'extensions', 'third-party', 'runtime-round-trip-probe');
    mkdirSync(extensionDirectory, { recursive: true });
    writeFileSync(path.join(extensionDirectory, 'manifest.json'), EXTENSION_MANIFEST);
    writeFileSync(path.join(extensionDirectory, 'index.js'), EXTENSION_INDEX_JS);
}


// readBackThroughPinned proves the OTHER half of the claim: that pinned can actually READ what GoTavern
// wrote. A boot that leaves the tree alone only shows pinned tolerated it; a 200 from the character,
// chat and world routes shows the data was parsed. Only a PROJECTION is recorded (names, message texts,
// one world entry) because the full bodies carry `date_added`-style timestamps, which are host-derived.
async function readBackThroughPinned(origin, log) {
    const session = await userDataSession(origin);
    const headers = { cookie: session.cookie, "x-csrf-token": session.token, "content-type": "application/json" };
    const call = async (route, body) => {
        const result = await request(`${origin}${route}`, { method: "POST", headers, body: JSON.stringify(body) });
        return { status: result.response.status, parsed: safeJSON(result.body) };
    };
    const characters = await call("/api/characters/all", {});
    const chat = await call("/api/chats/get", { avatar_url: "Round Trip Probe.png", ch_name: "Round Trip Probe", file_name: "round-trip-probe" });
    const world = await call("/api/worldinfo/get", { name: "round-trip-world" });

    const characterNames = Array.isArray(characters.parsed)
        ? characters.parsed.map(entry => String(entry?.name ?? "")).sort()
        : null;
    const conversation = Array.isArray(chat.parsed)
        ? chat.parsed.map(entry => ({ isUser: entry?.is_user === true, mes: String(entry?.mes ?? "") }))
        : Array.isArray(chat.parsed?.chat)
            ? chat.parsed.chat.map(entry => ({ isUser: entry?.is_user === true, mes: String(entry?.mes ?? "") }))
            : null;
    const entries = world.parsed?.entries && typeof world.parsed.entries === "object" ? world.parsed.entries : null;
    const firstEntry = entries === null ? null : Object.values(entries)[0] ?? null;
    const observation = {
        characters: { status: characters.status, count: characterNames?.length ?? null, names: characterNames },
        chat: { status: chat.status, messages: conversation },
        world: { status: world.status, entryCount: entries === null ? null : Object.keys(entries).length, firstEntryContent: firstEntry === null ? null : String(firstEntry?.content ?? "") },
    };
    log.push({ label: "readBack", route: "/api/{characters/all,chats/get,worldinfo/get}", status: observation.characters.status, bodyText: JSON.stringify(observation).slice(0, 400) });

    // The assertions: pinned must have PARSED the data, not merely left it on disk.
    if (observation.characters.status !== 200 || !characterNames?.includes("Round Trip Probe")) {
        throw new Error(`pinned did not list the imported character: ${JSON.stringify(observation.characters)}`);
    }
    if (observation.chat.status !== 200 || !conversation || conversation.length !== 2
        || !conversation.some(entry => entry.mes === "Hello from the round trip probe.")) {
        throw new Error(`pinned did not read the saved chat: ${JSON.stringify(observation.chat)}`);
    }
    if (observation.world.status !== 200 || observation.world.entryCount !== 1
        || observation.world.firstEntryContent !== "World entry written by the round trip probe.") {
        throw new Error(`pinned did not read the saved world info: ${JSON.stringify(observation.world)}`);
    }
    return observation;
}

function safeJSON(buffer) {
    try {
        return JSON.parse(buffer.toString("utf8"));
    } catch {
        return null;
    }
}

// ---- steps -----------------------------------------------------------------------------------

const STEPS = [
    { name: 'freshPinned', subject: 'pinned', seed: 'empty' },
    { name: 'freshGotavern', subject: 'gotavern', seed: 'empty' },
    { name: 'gotavernUserData', subject: 'gotavern', seed: 'freshGotavern', writesUserData: true },
    // THE CLAIM: pinned boots over the tree GoTavern produced, including data written through
    // GoTavern's own routes.
    { name: 'pinnedOverGotavern', subject: 'pinned', seed: 'gotavernUserData', readBack: true },
    { name: 'gotavernAgain', subject: 'gotavern', seed: 'gotavernUserData' },
    // The CONTROL for the idempotence comparison: pinned's second boot over its own output.
    { name: 'pinnedAgain', subject: 'pinned', seed: 'freshPinned' },
];

async function main() {
    const binaryVersion = execFileSync(gotavernBinary, ['version', '--json'], { encoding: 'utf8' });
    const binaryInfo = JSON.parse(binaryVersion);

    const roots = {};
    const recorded = {};
    const cleanupRoots = [];
    const logs = [];
    try {
        for (const step of STEPS) {
            const runtimeRoot = mkdtempSync(path.join(os.tmpdir(), RUNTIME_ROOT_PREFIX));
            cleanupRoots.push(runtimeRoot);
            if (step.seed !== 'empty') {
                cpSync(roots[step.seed], runtimeRoot, { recursive: true });
            }
            roots[step.name] = runtimeRoot;
            const instance = await boot(step.subject, runtimeRoot, logs);
            let before = null;
            let http = null;
            let readBack = null;
            try {
                if (step.writesUserData) {
                    before = snapshotRuntime(runtimeRoot);
                    const session = await userDataSession(instance.origin);
                    http = [];
                    await writeUserData(instance.origin, session, http, path.join(runtimeRoot, 'data'));
                }
                // The boot snapshot is taken BEFORE any read: `/api/characters/all` makes pinned
                // build its character disk cache under `_cache/characters/`, so a read taken first
                // would put a cache file it only wrote because WE asked into the boot delta.
                const snapshot = snapshotRuntime(runtimeRoot);
                let readBackSnapshot = null;
                if (step.readBack) {
                    http = [];
                    readBack = await readBackThroughPinned(instance.origin, http);
                    readBackSnapshot = snapshotRuntime(runtimeRoot);
                }
                // The bytes are read HERE, while the tree is alive: every runtime root is removed in
                // the finally block before the assertions run, so a post-loop read could only ENOENT.
                let writes = null;
                let writeDiff = null;
                if (step.writesUserData) {
                    writeDiff = diffSnapshots(before, snapshot);
                    writes = [];
                    for (const entry of [...writeDiff.added, ...writeDiff.changed.map(item => item.after)]) {
                        if (entry.type !== "file") continue;
                        if (entry.normalized !== undefined) {
                            // A normalized entry keeps its path and SIZE but not its bytes: the stored
                            // character card carries the import route's generated chat name and
                            // create_date. Recording a body of the same length is what lets the replay
                            // materialise the file without inventing content that claims to be real.
                            writes.push({
                                path: entry.path,
                                bytes: entry.bytes,
                                normalized: entry.normalized,
                                writtenBy: entry.path.startsWith("default-user/extensions/") ? "probe" : "gotavern",
                            });
                            continue;
                        }
                        const body = readFileSync(path.join(runtimeRoot, "data", ...entry.path.split("/")));
                        writes.push({
                            path: entry.path,
                            bytes: body.length,
                            sha256: sha256(body),
                            bodyBase64: body.toString("base64"),
                            writtenBy: entry.path.startsWith("default-user/extensions/") ? "probe" : "gotavern",
                        });
                    }
                    writes.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
                }
                recorded[step.name] = { step, before, snapshot, http, writes, writeDiff, readBack, readBackSnapshot };
            } finally {
                await instance.stop();
            }
            console.log(`  step ${step.name} (${step.subject}) recorded ${recorded[step.name].snapshot.entries.length} entries`);
        }
    } catch (error) {
        console.error('PROBE FAILED; subject log tail:');
        console.error(logs.join('').slice(-12000));
        throw error;
    } finally {
        for (const root of cleanupRoots) {
            try {
                safeCleanup(root, RUNTIME_ROOT_PREFIX);
            } catch {
                // A leftover temp root is reported by the harness's own cleanup; never mask the failure.
            }
        }
    }

    // ---- record-time assertions ---------------------------------------------------------------
    const snapshotOf = name => recorded[name].snapshot;
    const t0 = snapshotOf('freshPinned');
    const t1 = snapshotOf('freshGotavern');
    const t2 = snapshotOf('gotavernUserData');
    const t3 = snapshotOf('pinnedOverGotavern');
    const t4 = snapshotOf('gotavernAgain');
    const t5 = snapshotOf('pinnedAgain');

    // The user data is whatever GoTavern's own routes added or changed, read off the T1 -> T2 diff so
    // nothing is hardcoded; the extension directory is the only probe-written part and is labelled.
    const writeDiff = recorded.gotavernUserData.writeDiff;
    const userData = recorded.gotavernUserData.writes;
    if (writeDiff.added.length === 0 && writeDiff.changed.length === 0) {
        throw new Error("the user-data step wrote nothing: the tree is unchanged, so the leg would prove nothing");
    }
    const gotavernWritten = userData.filter(entry => entry.writtenBy === "gotavern");
    if (gotavernWritten.length < 4) {
        throw new Error(`only ${gotavernWritten.length} GoTavern-written files were recorded; the four routes should each leave at least one`);
    }
    for (const wanted of ["characters", "chats", "worlds", "OpenAI Settings"]) {
        if (!gotavernWritten.some(entry => entry.path.includes(`/${wanted}/`))) {
            throw new Error(`no GoTavern-written user data under ${wanted}/; the route did not persist`);
        }
    }
    // (a) THE CLAIM: every user-data file is byte-identical after pinned booted over the tree. A
    // normalized entry (the stored character card) is compared by SIZE instead, because its bytes carry
    // the import route's generated timestamps; `readBack` is what proves pinned still parsed its内容.
    const pinnedOverGotavern = entriesByPath(t3);
    for (const entry of userData) {
        const after = pinnedOverGotavern.get(entry.path);
        if (after === undefined) throw new Error(`pinned REMOVED user data: ${entry.path}`);
        if (after.type !== 'file') throw new Error(`pinned changed the type of ${entry.path} to ${after.type}`);
        if (entry.normalized !== undefined) {
            if (after.bytes !== entry.bytes) {
                throw new Error(`pinned RESIZED user data ${entry.path}: ${entry.bytes} -> ${after.bytes}`);
            }
            continue;
        }
        if (after.normalized !== undefined) throw new Error(`user data ${entry.path} became a normalized path`);
        if (after.sha256 !== entry.sha256) {
            throw new Error(`pinned REWROTE user data ${entry.path}: ${entry.sha256} -> ${after.sha256}`);
        }
    }

    // (b) pinned's rewrites over a GoTavern tree equal its rewrites over an empty tree.
    const pinnedDeltaOverGotavern = diffSnapshots(t2, t3);
    const freshPinnedByPath = entriesByPath(t0);
    for (const entry of [...pinnedDeltaOverGotavern.added, ...pinnedDeltaOverGotavern.changed.map(item => item.after)]) {
        const reference = freshPinnedByPath.get(entry.path);
        if (reference === undefined) {
            throw new Error(`pinned created ${entry.path} over a GoTavern tree but not over an empty one`);
        }
        if (!sameEntry(reference, entry)) {
            throw new Error(`pinned's rewrite of ${entry.path} differs from its fresh value: pinned fresh ${JSON.stringify(reference)} vs over-GoTavern ${JSON.stringify(entry)}`);
        }
    }
    // (c) nothing user-owned is deleted.
    if (pinnedDeltaOverGotavern.removed.length > 0) {
        throw new Error(`pinned deleted ${pinnedDeltaOverGotavern.removed.map(entry => entry.path).join(', ')} from a GoTavern tree`);
    }
    // (d) nothing appears that pinned does not also create on an empty tree.
    const userDataPaths = new Set(userData.map(entry => entry.path));
    for (const entry of pinnedDeltaOverGotavern.added) {
        if (!freshPinnedByPath.has(entry.path) && !userDataPaths.has(entry.path)) {
            throw new Error(`pinned created ${entry.path} over a GoTavern tree that it does not create over an empty one`);
        }
    }

    // The config file is compared separately from the data entries, because a boot that rewrites
    // config.yaml is exactly the silent mutation this leg exists to catch.
    if (t0.config.sha256 !== t1.config.sha256 || t0.config.bytes !== t1.config.bytes) {
        throw new Error(`GoTavern's fresh config differs from pinned's: pinned ${JSON.stringify(t0.config)} vs gotavern ${JSON.stringify(t1.config)}`);
    }
    if (t2.config.sha256 !== t3.config.sha256) {
        throw new Error(`pinned REWROTE the config GoTavern wrote: ${t2.config.sha256} -> ${t3.config.sha256}`);
    }
    if (t2.config.sha256 !== t4.config.sha256) {
        throw new Error(`GoTavern rewrote its own config on a second boot: ${t2.config.sha256} -> ${t4.config.sha256}`);
    }
    if (t0.config.sha256 !== t5.config.sha256) {
        throw new Error(`pinned rewrote its own config on a second boot: ${t0.config.sha256} -> ${t5.config.sha256}`);
    }

    // Reading through pinned may ADD its own cache; it must not touch user data.
    // The cache key is a hash of the character, which embeds the generated timestamps, so the KEYS
    // differ per run even though the fact that a cache file appeared does not. Counted, not listed.
    const isCacheKey = entryPath => entryPath.startsWith('_cache/characters/');
    const rawReadBackDelta = diffSnapshots(t3, recorded.pinnedOverGotavern.readBackSnapshot);
    const readBackDelta = {
        added: rawReadBackDelta.added.filter(entry => !isCacheKey(entry.path)),
        removed: rawReadBackDelta.removed.filter(entry => !isCacheKey(entry.path)),
        changed: rawReadBackDelta.changed.filter(item => !isCacheKey(item.after.path)),
    };
    const readBackCacheKeys = rawReadBackDelta.added.filter(entry => isCacheKey(entry.path)).length;
    const readBackTouchedUserData = [...readBackDelta.removed.map(entry => entry.path), ...readBackDelta.changed.map(item => item.after.path)]
        .filter(entryPath => userDataPaths.has(entryPath));
    if (readBackTouchedUserData.length > 0) {
        throw new Error(`reading through pinned modified user data: ${readBackTouchedUserData.join(", ")}`);
    }
    const readBackSnapshotEntries = entriesByPath(recorded.pinnedOverGotavern.readBackSnapshot);
    for (const entry of userData) {
        const after = readBackSnapshotEntries.get(entry.path);
        if (entry.normalized !== undefined) {
            if (after === undefined || after.bytes !== entry.bytes) {
                throw new Error(`user data ${entry.path} did not survive pinned reading it back`);
            }
            continue;
        }
        if (after === undefined || after.sha256 !== entry.sha256) {
            throw new Error(`user data ${entry.path} did not survive pinned reading it back`);
        }
    }
    // L4: a second boot of either subject must not disturb the tree, and the PINNED control is what
    // makes the comparison honest.
    const gotavernSecondBoot = diffSnapshots(t2, t4);
    const pinnedSecondBoot = diffSnapshots(t0, t5);
    for (const diff of [gotavernSecondBoot, pinnedSecondBoot]) {
        const described = describeDiff(diff);
        if (described.added.length || described.removed.length || described.changed.length) {
            throw new Error(`a second boot changed its own tree: ${JSON.stringify(described)}`);
        }
    }

    // The fresh-install cross-check against the existing fixture, which is this probe's staleness
    // detector: if the two ever disagree about the fresh tree, one of them is stale.
    const freshStartPath = path.join(repositoryRoot, 'tests', 'oracle', 'sillytavern-1.19.0-fresh-start.json');
    const freshStart = JSON.parse(readFileSync(freshStartPath, 'utf8'));
    if (freshStart.filesystem.config.sha256 !== t0.config.sha256 || freshStart.filesystem.config.bytes !== t0.config.bytes) {
        throw new Error(`fresh-start records config ${JSON.stringify(freshStart.filesystem.config)} but this probe recorded ${JSON.stringify(t0.config)}`);
    }
    const freshStartPaths = new Set(freshStart.filesystem.dataRoot.map(entry => entry.path));
    for (const entry of entriesByPath(t0).keys()) {
        if (!freshStartPaths.has(entry)) {
            throw new Error(`this probe's fresh pinned tree records ${entry}, which fresh-start does not: one of the fixtures is stale`);
        }
    }

    const fixture = {
        schemaVersion: 1,
        baseline: { version: PINNED_VERSION, commit: PINNED_COMMIT },
        probe: 'tools/probe-runtime-roundtrip.mjs',
        question: 'What does the pinned server do to a runtime tree that GoTavern wrote, and does a second boot of either subject disturb its own tree?',
        subjects: {
            pinned: 'the pinned SillyTavern server (node server.js)',
            gotavern: 'the CI-built gotavern executable, `gotavern start`',
        },
        binaryIdentity: {
            version: binaryInfo.gotavern_version,
            sillyTavernVersion: binaryInfo.sillytavern_version,
            reason: 'the version payload is recorded instead of the executable hash: a hash is a property of one build and would break the zero-diff gate on the next commit',
        },
        bootArguments: 'IDENTICAL flag list for both subjects (the pinned CLI surface, which GoTavern\'s commandline package implements); only the launcher differs. Readiness is /version answering 200.',
        stepShape: '{ name, subject, seed: "empty"|"<step>", snapshot } in an ORDERED ARRAY: every step consumes a COPY of its parent\'s runtime root, so the order is the only possible interpretation and no step can observe another step\'s mutations.',
        assertionSplit: {
            'record-time (this probe, re-run by the CI oracle job)': 'pinned preserves every GoTavern-written user-data byte; pinned\'s rewrites over a GoTavern tree equal its own fresh values; nothing user-owned is deleted; nothing is created that pinned does not also create over an empty tree; a second boot of EITHER subject leaves its tree unchanged; the fresh pinned tree agrees with tests/oracle/sillytavern-1.19.0-fresh-start.json.',
            'replay-time (internal/startup/runtime_roundtrip_test.go)': 'fixture coherence (the recorded user-data paths are consistent between the steps, every normalized path is declared, the fresh tree matches fresh-start) and the GoTavern side of idempotence, which a Go test can actually execute. The cross-subject properties are NOT replayed by a Go test: a Go test cannot boot pinned Node.',
        },
        comparisonExclusions: COMPARISON_EXCLUSIONS,
        normalization: NORMALIZATION,
        steps: STEPS.map(step => ({
            name: step.name,
            subject: step.subject,
            seed: step.seed,
            ...(step.writesUserData ? { writesUserData: true } : {}),
            ...(step.readBack ? { readBack: true } : {}),
        })),
        userData,
        notRecorded: [
            'the installer and any executable replacement: pinned has no installer, so there is no differential for it. That belongs to the archive/installer qualification script.',
            'a downgrade across upstream baselines: only one pinned checkout exists, and docs/INSTALLATION.md §9 refuses to promise arbitrary downgrades. The same-baseline round trip recorded here is the strongest claim available.',
            'file modes and timestamps: not recorded, so the fixture is host-independent by construction.',
            'the tokenizer data resolution of a release install: the CI-built binary used here has no adjacent tokenizers/ tree, which does not affect the runtime tree this fixture compares.',
        ],
        inputs: {
            cookieSecretNote: 'accounts are disabled in the pinned default config, so the step that writes user data uses only the CSRF token and session cookie; no login is performed.',
            userDataSources: {
                character: 'POST /api/characters/import (multipart: avatar PNG + JSON file)',
                chat: 'POST /api/chats/save',
                world: 'POST /api/worldinfo/edit',
                preset: 'POST /api/presets/save',
                extension: 'written by the probe under default-user/extensions/ and marked writtenBy "probe", because no route can create an extension without git or a network fetch',
            },
            syntheticBytes: {
                extensionManifest: EXTENSION_MANIFEST,
                extensionIndexJs: EXTENSION_INDEX_JS,
            },
        },
        snapshots: {
            freshPinned: t0,
            freshGotavern: t1,
            gotavernUserData: t2,
            pinnedOverGotavern: t3,
            gotavernAgain: t4,
            pinnedAgain: t5,
        },
        http: recorded.gotavernUserData.http,
        readBack: recorded.pinnedOverGotavern.readBack,
        readBackDelta: { ...describeDiff(readBackDelta), excludedCacheKeys: readBackCacheKeys },
        readBackNote: "reading the imported character makes pinned build its character disk cache under _cache/characters/; those files are ADDED by the read, not by the boot, and the boot snapshot (T3) is taken before the read so the two stay separable. No user-data path is added, changed or removed by the read.",
        deltas: {
            userDataWritten: describeDiff(writeDiff),
            pinnedOverGotavern: describeDiff(pinnedDeltaOverGotavern),
            gotavernSecondBoot: describeDiff(gotavernSecondBoot),
            pinnedSecondBoot: describeDiff(pinnedSecondBoot),
        },
    };

    const outputFile = writeFixture(repositoryRoot, 'sillytavern-1.19.0-runtime-roundtrip.json', fixture);
    console.log(`entries: freshPinned ${t0.entries.length}, freshGotavern ${t1.entries.length}, userData ${userData.length} (${gotavernWritten.length} GoTavern-written)`);
    console.log(`pinned deltas over GoTavern: added ${pinnedDeltaOverGotavern.added.length}, changed ${pinnedDeltaOverGotavern.changed.length}, removed ${pinnedDeltaOverGotavern.removed.length}`);
    console.log(`fixture written to ${outputFile}`);
}

await main();
