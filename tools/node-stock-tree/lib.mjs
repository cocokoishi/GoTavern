// SHARED MACHINERY FOR THE NODE-ORIGINATED STOCK TREE.
//
// This module exists for one reason: the stock tree the packaged drop-in gate boots is DERIVED from the pinned
// source (`scripts/build-stock-tree.sh` copies `upstream/**` and re-implements the pinned placement rules), and
// the one thing a derivation can never prove is that the ORIGINAL Node server ACCEPTS what we produce. So this
// pipeline boots the PINNED Node server and drives its own HTTP surface to create every user-data surface, then
// records the tree the pinned server itself wrote.
//
// It deliberately does not replace `scripts/build-stock-tree.sh`: that script produces a stock tree without
// Node (its gates boot a release archive), while this tree is a RECORDED pinned-Node session and is therefore
// allowed to be larger, slower and to contain the pinned server's own timestamps.
//
// EVERYTHING HERE IS EITHER A MECHANISM THE TWO GENERATORS SHARE OR A FACT ABOUT THE PINNED SERVER THAT WAS READ
// FROM ITS SOURCE. Nothing here decides what the product should do; the qualifier judges the product.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

export const PINNED_COMMIT = '06bde939fb1e9c4c8d8641d810f0a916b5bce127';
export const PINNED_VERSION = '1.19.0';

// The user the pinned server CREATES through its own admin API. It is not `default-user`: a second account is a
// real `/api/users/create` mutation, it makes the tree a multi-user tree, and it proves the data root is not
// silently rewritten into the default handle's shape. The password is deliberately empty ("no password"), which
// is the state a fresh install's default account is in and the state pinned's own login route accepts.
export const TREE_USER = Object.freeze({ handle: 'node-origin', name: 'Node Origin', password: '' });

// Marker vocabulary. Every surface the generator creates carries one of these, so a qualifier read is "did the
// value this generator wrote come back", never "did some plausible value come back".
export const MARKERS = Object.freeze({
    character: 'NODE_ORIGIN_KEEPER',
    characterSecond: 'NODE_ORIGIN_ARCHIVIST',
    chat: 'NODE_ORIGIN_CHAT_MARKER',
    swipe: 'NODE_ORIGIN_SWIPE',
    alternateGreeting: 'NODE_ORIGIN_ALT_GREETING',
    world: 'NODE_ORIGIN_WORLD',
    group: 'NODE_ORIGIN_ENSEMBLE',
    preset: 'NODE_ORIGIN_COMPLEX',
    quickReply: 'NODE_ORIGIN_QR',
    background: 'Node Origin Glade',
    persona: 'Node Origin Persona',
    theme: 'Node Origin Theme',
    extensionSetting: 'node_origin_extension_state',
    legacySetting: 'node_origin_legacy_state',
    chatVariable: 'node_origin_chat_variable',
    globalVariable: 'node_origin_global_variable',
});

// The deterministic clock the generator uses for values it CHOOSES (send dates, card create dates). Values the
// pinned server stamps itself (a card's `chat` binding, a group id, backup file names) cannot be chosen; those are
// declared volatile in the tree manifest instead of being rewritten.
export const FIXED_EPOCH = Date.UTC(2026, 9, 1, 12, 0, 0);

export function fixedIso(offsetSeconds) {
    return new Date(FIXED_EPOCH + offsetSeconds * 1000).toISOString();
}

export function sha256(value) {
    return createHash('sha256').update(value).digest('hex');
}

/**
 * Glob -> RegExp for the tree patterns in this pipeline.
 *
 * `*` matches within one path segment and `**` matches across segments (`**\/` also matches zero directories), so
 * `data/**\/.migrated` matches `data/node-origin/sysprompt/.migrated`. A hand-rolled `split('*')` join gets this
 * wrong for `**` and silently turns a declared exception into an assertion failure -- measured while qualifying
 * the first Node-originated tree, where `data/**\/.migrated` produced a regex requiring `//`.
 */
export function globToRegExp(pattern) {
    const text = String(pattern);
    let out = '^';
    for (let index = 0; index < text.length; index++) {
        const character = text[index];
        if (character === '*') {
            if (text[index + 1] === '*') {
                index += 1;
                if (text[index + 1] === '/') {
                    index += 1;
                    out += '(?:.*/)?';
                } else {
                    out += '.*';
                }
            } else {
                out += '[^/]*';
            }
            continue;
        }
        out += /[\\^$.|?+()[\]{}]/.test(character) ? `\\${character}` : character;
    }
    return new RegExp(`${out}$`);
}

export function globMatches(relative, pattern) {
    return globToRegExp(pattern).test(relative);
}

export async function readJSON(file) {
    return JSON.parse(await fs.readFile(file, 'utf8'));
}

export async function writeJSON(file, value) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `${JSON.stringify(value, null, 4)}\n`, 'utf8');
}

export function removeWithRetries(target) {
    return fs.rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
}

export async function choosePort() {
    const server = net.createServer();
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const port = server.address().port;
    await new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
    return port;
}

// ---------------------------------------------------------------------------------------------------------------
// THE PINNED SERVER. Booted from the pinned checkout with an EXPLICIT `--dataRoot` and `--configPath`, because the
// pinned server's webpack output root is `<dataRoot>/_webpack` (webpack.config.js getWebpackRoot) and its config
// write-back is `--configPath`. With both pointed into our scratch directory the checkout is never written to;
// `assertPinnedCheckoutClean` below proves that with git rather than asserting it in a comment.
// ---------------------------------------------------------------------------------------------------------------
export function pinnedBootArgv({ port, dataRoot, configPath }) {
    return [
        'server.js',
        '--configPath', configPath,
        '--dataRoot', dataRoot,
        '--listenAddressIPv4', '127.0.0.1',
        '--enableIPv4', 'true',
        '--enableIPv6', 'false',
        '--listen', 'false',
        '--port', String(port),
        // A generated tree is booted on a developer machine and in CI; opening a browser window is never part of
        // this gate. This is the same flag the packaged gates pass and tests/browser/browser-launch-gate.mjs
        // polices for browser probes.
        '--browserLaunchEnabled', 'false',
        // The whitelist is pinned's answer to a network-exposed server; this server is bound to 127.0.0.1 by the
        // flags above, so the whitelist only turns an isolated loopback run into a 403. Account creation and
        // login are still exercised: `enableUserAccounts` is a config value, not a whitelist value.
        '--whitelistMode', 'false',
        '--heartbeatInterval', '0',
    ];
}

// Readiness is asked of the LOGIN PAGE, because with accounts enabled every `/api/**` and `/version` request is
// behind `requireLoginMiddleware` and answers 403 until a session exists. The pinned server compiles its frontend
// before it listens (src/server-main.js:354), so readiness is a bounded poll and never a sleep.
export async function startPinnedServer({
    sourceRoot,
    runtimeRoot,
    dataRoot,
    configPath,
    port,
    logSink = () => {},
    readinessSeconds = 600,
}) {
    const logs = [];
    const child = spawn(process.execPath, pinnedBootArgv({ port, dataRoot, configPath }), {
        cwd: sourceRoot,
        env: { ...process.env, NODE_ENV: 'test' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
    });
    const collect = chunk => {
        const text = chunk.toString('utf8');
        logs.push(text);
        logSink(text);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);

    const origin = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + readinessSeconds * 1000;
    let lastError = null;
    let ready = false;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) {
            throw new Error(`the pinned server exited before readiness (code ${child.exitCode}):\n${logs.join('').slice(-8000)}`);
        }
        try {
            const response = await fetch(`${origin}/login?noauto=1`);
            const type = response.headers.get('content-type') ?? '';
            if (response.status === 200 && type.includes('text/html')) {
                ready = true;
                break;
            }
            lastError = new Error(`/login answered ${response.status} ${type}`);
        } catch (error) {
            lastError = error;
        }
        await new Promise(resolve => setTimeout(resolve, 250));
    }
    if (!ready) {
        await stopPinnedServer(child, logs);
        throw new Error(`the pinned server did not become ready in ${readinessSeconds}s: ${lastError?.message ?? 'no error'}\n${logs.join('').slice(-8000)}`);
    }

    let stopped = false;
    const stop = async () => {
        if (stopped) return { signal: 'already-stopped', exitCode: child.exitCode };
        stopped = true;
        const result = await stopPinnedServer(child, logs);
        return result;
    };
    return { origin, port, dataRoot, runtimeRoot, logs, child, stop };
}

async function stopPinnedServer(child, logs) {
    if (!child || child.exitCode !== null) return { signal: 'already-exited', exitCode: child?.exitCode ?? null };
    child.kill('SIGINT');
    const exited = await Promise.race([
        new Promise(resolve => child.once('exit', code => resolve({ signal: 'SIGINT', exitCode: code }))),
        new Promise(resolve => setTimeout(() => resolve(null), 15000)),
    ]);
    if (exited) return exited;
    child.kill('SIGKILL');
    const forced = await Promise.race([
        new Promise(resolve => child.once('exit', code => resolve({ signal: 'SIGKILL', exitCode: code }))),
        new Promise(resolve => setTimeout(() => resolve(null), 5000)),
    ]);
    if (!forced) throw new Error(`the pinned server did not exit after SIGKILL:\n${logs.join('').slice(-4000)}`);
    return forced;
}

// `git status --porcelain` on the pinned checkout, before and after every boot. The mission's pinned oracle is
// read-only; a boot that dirtied it would make every later "pinned says X" claim suspect, so this is asserted by
// the generator rather than promised in its header.
export async function pinnedCheckoutStatus(sourceRoot) {
    const { execFile } = await import('node:child_process');
    return new Promise((resolve, reject) => {
        execFile('git', ['status', '--porcelain'], { cwd: sourceRoot, encoding: 'utf8' }, (error, stdout) => {
            if (error) return reject(new Error(`cannot read the pinned checkout's git status: ${error.message}`));
            resolve(stdout.split('\n').filter(line => line.trim() !== ''));
        });
    });
}

// ---------------------------------------------------------------------------------------------------------------
// HTTP SESSIONS. A tiny cookie jar, because the pinned server's CSRF token lives in the signed session cookie and
// a probe that forgets the jar gets a 403 that looks exactly like a product refusal.
// ---------------------------------------------------------------------------------------------------------------
export class PinnedSession {
    constructor(origin, label) {
        this.origin = origin;
        this.label = label;
        this.cookies = new Map();
        this.csrfToken = null;
        this.handle = null;
        this.log = [];
    }

    cookieHeader() {
        return [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
    }

    absorb(response) {
        const getSetCookie = response.headers.getSetCookie?.bind(response.headers);
        const values = getSetCookie ? getSetCookie() : [];
        for (const raw of values) {
            const pair = String(raw).split(';')[0];
            const equals = pair.indexOf('=');
            if (equals > 0) this.cookies.set(pair.slice(0, equals).trim(), pair.slice(equals + 1).trim());
        }
    }

    async request(route, { method = 'POST', body = null, headers = {}, form = null, raw = false } = {}) {
        const requestHeaders = { ...headers };
        if (this.csrfToken && method !== 'GET') requestHeaders['x-csrf-token'] = this.csrfToken;
        if (this.cookies.size > 0) requestHeaders.cookie = this.cookieHeader();
        let payload = body;
        if (form) {
            payload = form;
        } else if (body !== null && typeof body !== 'string') {
            requestHeaders['content-type'] = 'application/json';
            payload = JSON.stringify(body);
        }
        const response = await fetch(`${this.origin}${route}`, { method, headers: requestHeaders, body: payload });
        this.absorb(response);
        const text = await response.text();
        let parsed = null;
        try {
            parsed = JSON.parse(text);
        } catch {
            parsed = null;
        }
        this.log.push({ route, method, status: response.status });
        if (raw) return { status: response.status, text, json: parsed, headers: response.headers };
        if (response.status >= 400) {
            throw new Error(`${this.label} ${method} ${route} answered ${response.status}: ${text.slice(0, 400)}`);
        }
        return { status: response.status, text, json: parsed, headers: response.headers };
    }

    async get(route) {
        return this.request(route, { method: 'GET' });
    }

    // A binary GET that still carries the session cookies. `/thumbnail` answers an image and is mounted behind
    // the login middleware, so an anonymous fetch answers 403 and the pinned server never writes the cache file.
    async getBinary(route) {
        const headers = {};
        if (this.cookies.size > 0) headers.cookie = this.cookieHeader();
        const response = await fetch(`${this.origin}${route}`, { method: 'GET', headers });
        this.absorb(response);
        const bytes = Buffer.from(await response.arrayBuffer());
        this.log.push({ route, method: 'GET', status: response.status });
        return { status: response.status, contentType: response.headers.get('content-type') ?? '', bytes };
    }

    async post(route, body) {
        return this.request(route, { method: 'POST', body });
    }

    async postRaw(route, body) {
        return this.request(route, { method: 'POST', body, raw: true });
    }

    async postForm(route, form, query = '') {
        return this.request(`${route}${query}`, { method: 'POST', form });
    }

    // GET /csrf-token, then POST /api/users/login. Both are public routes in pinned's middleware order
    // (src/server-main.js defines /csrf-token before `app.use(requireLoginMiddleware)` and
    // src/server-startup.js mounts the public users router first).
    async login(handle, password = '') {
        await this.get('/csrf-token').then(response => {
            this.csrfToken = response.json?.token ?? null;
        });
        if (!this.csrfToken) throw new Error(`${this.label}: /csrf-token answered without a token`);
        const response = await this.post('/api/users/login', { handle, password: password ?? '' });
        this.handle = handle;
        return response;
    }

    async getJSON(route) {
        const response = await this.get(route);
        if (response.json !== null) return response.json;
        try {
            return JSON.parse(response.text);
        } catch {
            return response.text;
        }
    }

    // PINNED'S READ ROUTES ARE POST-ONLY. `/api/settings/get`, `/api/users/me`, `/api/characters/all` and
    // `/api/worldinfo/get` are all `router.post(...)`, so a GET answers Express's final 404 -- which is a driver
    // defect that reads exactly like a missing route. Every generator read goes through this.
    async postJSON(route, body = {}) {
        const response = await this.post(route, body);
        if (response.json !== null) return response.json;
        try {
            return JSON.parse(response.text);
        } catch {
            return response.text;
        }
    }
}

export function formFromObject(fields, file) {
    const form = new FormData();
    for (const [name, value] of Object.entries(fields)) {
        if (value === undefined || value === null) continue;
        if (Array.isArray(value)) {
            for (const item of value) form.append(name, String(item));
            continue;
        }
        form.append(name, String(value));
    }
    if (file) form.append(file.field ?? 'avatar', new Blob([file.bytes], { type: file.type ?? 'image/png' }), file.name);
    return form;
}

// ---------------------------------------------------------------------------------------------------------------
// PNG CARD DOCUMENTS. The pinned server embeds the character document in a PNG `tEXt` chunk; pinned reads `ccv3`
// before `chara` (src/character-card-parser.js:54-78). This reader is used for ASSERTIONS only, and it reproduces
// that precedence instead of taking the first chunk in file order -- the Q21 probe recorded two runs lost to the
// opposite reader. The generator verifies the reader against a synthetic file where the two chunks differ.
// ---------------------------------------------------------------------------------------------------------------
export function cardTextChunks(bytes) {
    const chunks = [];
    let offset = 8;
    while (offset + 8 <= bytes.length) {
        const length = bytes.readUInt32BE(offset);
        const type = bytes.toString('latin1', offset + 4, offset + 8);
        const dataStart = offset + 8;
        if (dataStart + length > bytes.length) break;
        if (type === 'tEXt') {
            const chunk = bytes.subarray(dataStart, dataStart + length);
            const zero = chunk.indexOf(0);
            const keyword = zero > 0 ? chunk.toString('latin1', 0, zero) : '';
            if (/^(ccv3|chara)$/i.test(keyword)) {
                chunks.push({ keyword: keyword.toLowerCase(), base64: chunk.subarray(zero + 1).toString('latin1') });
            }
        }
        offset = dataStart + length + 4;
        if (type === 'IEND') break;
    }
    return chunks;
}

export function cardDocumentFromChunk(chunk) {
    const raw = Buffer.from(chunk.base64, 'base64').toString('utf8');
    const text = chunk.keyword === 'ccv3' ? raw : (() => {
        try {
            return decodeURIComponent(raw);
        } catch {
            return raw;
        }
    })();
    return JSON.parse(text);
}

export function cardDocument(bytes) {
    const chunks = cardTextChunks(bytes);
    const selected = chunks.find(chunk => chunk.keyword === 'ccv3') ?? chunks.find(chunk => chunk.keyword === 'chara');
    if (!selected) throw new Error('the PNG carries no chara/ccv3 tEXt chunk');
    return cardDocumentFromChunk(selected);
}

export function selfCheckCardReader() {
    const chunk = (keyword, name) => {
        const payload = Buffer.concat([
            Buffer.from(`${keyword}\0`, 'latin1'),
            Buffer.from(Buffer.from(JSON.stringify({ name: `root-${name}`, data: { name } }), 'utf8').toString('base64'), 'latin1'),
        ]);
        const length = Buffer.alloc(4);
        length.writeUInt32BE(payload.length);
        return Buffer.concat([length, Buffer.from('tEXt', 'latin1'), payload, Buffer.alloc(4)]);
    };
    const build = order => Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        ...order.map(([keyword, name]) => chunk(keyword, name)),
    ]);
    const charaFirst = cardDocument(build([['chara', 'V2'], ['ccv3', 'V3']]));
    const ccv3First = cardDocument(build([['ccv3', 'V3'], ['chara', 'V2']]));
    const name = document => document?.data?.name ?? document?.name ?? null;
    if (name(charaFirst) !== 'V3' || name(ccv3First) !== 'V3') {
        throw new Error(`the card reader is not equivalent to the server's: chara-first read ${JSON.stringify(name(charaFirst))}, ccv3-first read ${JSON.stringify(name(ccv3First))}`);
    }
    return { charaFirst: name(charaFirst), ccv3First: name(ccv3First) };
}

// ---------------------------------------------------------------------------------------------------------------
// TREE HASHING. Sorted relative path + sha256 + size + mode, and a digest over that listing.
//
// MODE IS PART OF THE RECORD because the round trip asserts permissions are not re-encoded. On Windows the mode
// bits Node reports are not POSIX permissions (0666/0444), so the qualifier records them and states the platform
// limit instead of pretending a Windows 0444 proves a Linux mode.
// ---------------------------------------------------------------------------------------------------------------
export async function walkTreeDetailed(root, { skip = [] } = {}) {
    const entries = [];
    const skipped = [];
    const skipMatches = relative => skip.some(pattern => globMatches(relative, pattern) || relative.startsWith(`${pattern.replace(/\/$/, '')}/`));
    const walk = async directory => {
        const children = await fs.readdir(directory, { withFileTypes: true });
        for (const child of children) {
            const full = path.join(directory, child.name);
            const relative = path.relative(root, full).split(path.sep).join('/');
            if (child.isDirectory()) {
                if (skipMatches(relative)) {
                    skipped.push(relative);
                    continue;
                }
                await walk(full);
            } else if (child.isFile()) {
                if (skipMatches(relative)) {
                    skipped.push(relative);
                    continue;
                }
                const body = await fs.readFile(full);
                const stat = await fs.stat(full);
                entries.push({
                    path: relative,
                    bytes: body.length,
                    sha256: sha256(body),
                    mode: (stat.mode & 0o777).toString(8).padStart(3, '0'),
                });
            }
        }
    };
    await walk(root);
    entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
    return { entries, skipped };
}

export function treeDigest(entries) {
    const listing = entries.map(entry => `${entry.sha256}  ${entry.bytes}  ${entry.mode}  ${entry.path}\n`).join('');
    return sha256(listing);
}

/**
 * A digest that MASKS only the values the pinned server stamps itself.
 *
 * The generator cannot choose a card's `chat` binding (`src/endpoints/characters.js` builds it from
 * `humanizedDateTime()`), a group id (`groups.js` uses `String(Date.now())`), a backup file name, or the
 * `created` timestamp in the account store. Those values are DECLARED here, once, and masked from a SECOND
 * digest; the raw digest above still records every byte. Meaningful data is never rewritten.
 *
 * `normalisers` maps a path pattern to a function over the file's bytes returning a canonical replacement buffer.
 */
export async function normalisedTreeDigest(root, entries, { pathPatterns = [], normalisers = [] } = {}) {
    const patternMatches = relative => pathPatterns.some(pattern => globMatches(relative, pattern));
    const lines = [];
    for (const entry of entries) {
        let body = null;
        if (patternMatches(entry.path)) {
            // THE PATH IS PART OF THE VOLATILE VALUE, NOT MERELY THE CONTENT. A group id is `String(Date.now())`
            // and names the file, and a settings backup name carries a timestamp; emitting the path here made
            // the "masked" digest differ between two identical builds (measured: 11 differing paths, 0
            // undeclared, `identicalNormalised: false`). One masked line per volatile file keeps the FILE COUNT
            // in the digest while dropping the name, and the declaration is what grants that permission.
            lines.push(`${'*'.repeat(64)}  *  *  <volatile>`);
            continue;
        }
        const normaliser = normalisers.find(candidate => candidate.path instanceof RegExp ? candidate.path.test(entry.path) : candidate.path === entry.path);
        if (normaliser) {
            body = await fs.readFile(path.join(root, entry.path));
            const canonical = normaliser.normalise(body);
            lines.push(`${sha256(canonical)}  ${canonical.length}  ${entry.mode}  ${entry.path}  (normalised:${normaliser.name})`);
            continue;
        }
        lines.push(`${entry.sha256}  ${entry.bytes}  ${entry.mode}  ${entry.path}`);
    }
    return sha256(lines.join('\n'));
}

export function diffEntries(before, after) {
    const beforeMap = new Map(before.map(entry => [entry.path, entry]));
    const afterMap = new Map(after.map(entry => [entry.path, entry]));
    const created = after.filter(entry => !beforeMap.has(entry.path));
    const deleted = before.filter(entry => !afterMap.has(entry.path));
    const changed = after.filter(entry => {
        const previous = beforeMap.get(entry.path);
        return previous !== undefined && (previous.sha256 !== entry.sha256 || previous.bytes !== entry.bytes || previous.mode !== entry.mode);
    });
    return { created, deleted, changed };
}

export async function copyTree(source, target, { skip = [] } = {}) {
    const { entries } = await walkTreeDetailed(source, { skip });
    for (const entry of entries) {
        const destination = path.join(target, entry.path);
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.copyFile(path.join(source, entry.path), destination);
        await fs.chmod(destination, parseInt(entry.mode, 8));
    }
    // Recreate empty directories too: a stock tree's empty `chats/`, `groups/` and `vectors/` are part of the
    // shape, and a copy that drops them would silently change the tree.
    const walkDirectories = async directory => {
        const children = await fs.readdir(directory, { withFileTypes: true });
        for (const child of children) {
            if (!child.isDirectory()) continue;
            const relative = path.relative(source, path.join(directory, child.name)).split(path.sep).join('/');
            if (skip.some(pattern => pattern === relative || relative.startsWith(`${pattern}/`))) continue;
            await fs.mkdir(path.join(target, relative), { recursive: true });
            await walkDirectories(path.join(directory, child.name));
        }
    };
    await walkDirectories(source);
    return entries.length;
}

export function tempRoot(prefix) {
    return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}
