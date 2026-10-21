#!/usr/bin/env node
// Capture the pinned user-data routes that need no provider and no multipart:
//
//	assets mode:   POST /api/assets/get, /delete, /character
//	backups mode:  POST /api/backups/chat/delete, /download
//
// DEFERRED this round (not probed, not implemented, recorded in the fixtures): /api/assets/download
// (needs the whitelistImportDomains config projection and a streamed-download write path),
// /api/backups/chat/get (needs the getChatInfo port), /api/sprites/upload and /upload-zip
// (multipart and zip part recording), and the four /api/data-maid routes (report/zip generation).
//
// HOST-DEPENDENCE. These routes create and enumerate files, so the probe (a) seeds every file with
// a fixed whole-second mtime, (b) records tree paths with '/', (c) sorts every enumerated list and
// object key before recording and classifies the ORDER as `shape` with the reason that readdir
// order and readdir object-key order are host-dependent while the set is not, and (d) never seeds
// names that differ only by case.
//
// @gotavern-oracle: this declaration is read by tools/build-generated-lib.mjs,
// which auto-discovers probes so that adding one needs no edit there.
// @gotavern-oracle: fixture=sillytavern-1.19.0-assets.json label="assets routes"
// @gotavern-oracle: fixture=sillytavern-1.19.0-backups.json label="chat backup routes" args=backups

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
    existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync,
} from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const PINNED_COMMIT = '06bde939fb1e9c4c8d8641d810f0a916b5bce127';
const PINNED_VERSION = '1.19.0';
const COOKIE_SECRET = 'gotavern-pinned-assets-cookie-secret';
const sourceRoot = path.resolve(process.argv[2] ?? '');
const repositoryRoot = path.resolve(process.argv[3] ?? '');
const mode = process.argv[4] ?? 'assets';
if (!process.argv[2] || !process.argv[3]) {
    console.error('usage: node tools/probe-assets.mjs <pinned-source-clone> <gotavern-root> [assets|backups]');
    process.exit(2);
}
if (mode !== 'assets' && mode !== 'backups') {
    console.error(`unknown mode: ${mode}`);
    process.exit(2);
}
if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim() !== PINNED_COMMIT) {
    throw new Error(`upstream checkout is not pinned at ${PINNED_COMMIT}`);
}

const runtimeRoot = mkdtempSync(path.join(os.tmpdir(), 'gotavern-assets-oracle-'));
const dataRoot = path.join(runtimeRoot, 'data');
const configPath = path.join(runtimeRoot, 'config.yaml');
const userRoot = path.join(dataRoot, 'default-user');
const FIXED_SECONDS = 1700000000;
const logs = [];
let child;

function sha256(value) {
    return createHash('sha256').update(value).digest('hex');
}

function safeCleanup() {
    const resolved = path.resolve(runtimeRoot);
    const parent = path.resolve(os.tmpdir());
    if (path.dirname(resolved).toLowerCase() !== parent.toLowerCase() || !path.basename(resolved).startsWith('gotavern-assets-oracle-')) {
        throw new Error(`refusing to remove unexpected runtime path: ${resolved}`);
    }
    for (let attempt = 0; attempt < 5; attempt++) {
        try {
            rmSync(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
            return;
        } catch (error) {
            if (attempt === 4) throw error;
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
        }
    }
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

async function stopServer() {
    if (!child || child.exitCode !== null) return;
    child.kill('SIGINT');
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 5000))]);
    if (child.exitCode === null) child.kill();
}

async function request(url, method = 'GET', headers = {}, body) {
    const response = await fetch(url, { method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(30000) });
    const buffer = Buffer.from(await response.arrayBuffer());
    return {
        status: response.status,
        setCookie: typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [],
        headers: {
            contentType: response.headers.get('content-type'),
            contentLength: response.headers.get('content-length'),
            etag: response.headers.get('etag'),
            contentDisposition: response.headers.get('content-disposition'),
        },
        buffer,
        sha256: sha256(buffer),
    };
}

function cookiesFrom(result) {
    return result.setCookie ?? [];
}

function cookieHeader(cookies) {
    return cookies.map(cookie => cookie.split(';', 1)[0]).join('; ');
}

function seedFile(relative, content) {
    const target = path.join(userRoot, ...relative.split('/'));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
    utimesSync(target, FIXED_SECONDS, FIXED_SECONDS);
}

function seedFixture() {
    mkdirSync(path.join(dataRoot, '_storage'), { recursive: true });
    writeFileSync(path.join(dataRoot, 'cookie-secret.txt'), COOKIE_SECRET);
    writeFileSync(configPath, 'enableUserAccounts: true\nskipContentCheck: true\n');
    writeFileSync(path.join(dataRoot, '_storage', sha256('user:default-user')), JSON.stringify({
        key: 'user:default-user',
        value: { handle: 'default-user', name: 'Assets Writer', created: 1700000000000, password: '', admin: true, enabled: true, salt: '' },
    }));
    if (mode === 'assets') {
        seedFile('assets/bgm/one.mp3', 'BGM-ONE');
        seedFile('assets/bgm/two.mp3', 'BGM-TWO');
        seedFile('assets/ambient/wind.ogg', 'AMBIENT');
        seedFile('assets/blip/.placeholder', '');
        seedFile('assets/live2d/modelA/model3.json', '{"model":"a"}');
        seedFile('assets/live2d/modelA/texture.png', 'PNG');
        seedFile('assets/vrm/model/avatar.vrm', 'VRM');
        seedFile('assets/vrm/model/skip.placeholder', '');
        seedFile('assets/vrm/animation/idle.anim', 'ANIM');
        seedFile('assets/character/char.png', 'CHAR');
        seedFile('assets/temp/ignored.png', 'TEMP');
        seedFile('characters/Seraphina/ambient/a.mp3', 'A');
        seedFile('characters/Seraphina/ambient/b.mp3', 'B');
        seedFile('characters/Seraphina/bgm/x.mp3', 'X');
        seedFile('characters/Seraphina/live2d/modelA/model.json', '{"model":"char"}');
        seedFile('characters/Seraphina/live2d/modelA/extra.json', '{}');
        seedFile('characters/Seraphina/live2d/modelA/tex.png', 'TEX');
    } else {
        seedFile('backups/chat_2024-01-01T00-00-00.jsonl', '{"user_name":"u"}\n{"mes":"hi"}\n');
        seedFile('backups/chat_alpha.jsonl', '{"user_name":"u"}\n{"mes":"a"}\n{"mes":"b"}\n');
        seedFile('backups/chat_empty.jsonl', '');
        seedFile('backups/other.jsonl', '{}\n');
        seedFile('backups/note.txt', 'note');
    }
}

// Deep normalisation for the recorded body: arrays sorted, object keys sorted. The ORDER of
// readdir output is host-dependent, so it is classified shape instead of being asserted.
const BACKSLASH = String.fromCharCode(92);

function normalizeValue(value) {
    if (typeof value === 'string') return value.split(BACKSLASH).join('/');
    if (Array.isArray(value)) return value.map(normalizeValue).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    if (value && typeof value === 'object') {
        const result = {};
        for (const key of Object.keys(value).sort()) result[key] = normalizeValue(value[key]);
        return result;
    }
    return value;
}

function captureResponse(result) {
    let body = null;
    let bodyText = null;
    let bodySha256 = result.sha256;
    const raw = result.buffer.toString('utf8');
    // Pinned path.join produces backslash separators on Windows and '/' on POSIX. Separators are
    // host-dependent, so JSON string values are normalised to '/' before recording and hashing;
    // the separator is classified shape, the path set is compared.
    let normalizedContentLength = null;
    try {
        body = normalizeValue(JSON.parse(raw));
        const canonicalBodyText = JSON.stringify(body);
        bodySha256 = sha256(canonicalBodyText);
        // Content-length is DERIVED FROM THE BODY, so it must be normalised with the body. On Windows
        // the live2d branch's path.join emits backslashes, and JSON escapes each one as `\\`: the wire
        // body is four bytes longer than the canonical `/` form. Recording the raw header would bake
        // the recording host into the fixture (53 vs 49). Record the canonical byte length instead and
        // classify the raw header shape ONLY for the steps where the two differ.
        normalizedContentLength = Buffer.byteLength(canonicalBodyText, 'utf8');
    } catch {
        bodyText = raw;
        bodySha256 = sha256(raw);
    }
    const compared = ['status', 'contentType', 'contentDisposition', 'body', 'bodyText', 'bodySha256'];
    const shape = ['etag', 'body order', 'path separators'];
    const shapeReason = {
        etag: 'the ETag is computed over the raw response bytes, which contain host-dependent path separators for live2d character listings',
        'body order': 'the pinned routes build arrays in readdir order, which differs between NTFS and ext4; the fixture records a sorted set instead',
        'path separators': 'pinned path.join uses the host separator; the fixture normalises to / and the replay does the same',
    };
    if (normalizedContentLength !== null) {
        compared.push('normalizedContentLength');
        if (result.headers.contentLength !== null && Number(result.headers.contentLength) !== normalizedContentLength) {
            shape.push('contentLength');
            shapeReason.contentLength = `the raw header (${result.headers.contentLength}) counts JSON-escaped path separators, which the host decides; the canonical body is ${normalizedContentLength} bytes, and normalizedContentLength is compared instead`;
        } else {
            compared.push('contentLength');
        }
    } else {
        compared.push('contentLength');
    }
    return {
        status: result.status,
        contentType: result.headers.contentType,
        contentLength: result.headers.contentLength,
        etag: result.headers.etag,
        contentDisposition: result.headers.contentDisposition,
        normalizedContentLength,
        body,
        bodyText,
        // Canonical bytes for JSON bodies so no recorded byte field depends on the recording host;
        // this field is not compared, but a host-dependent value in the file invites a future trap.
        bodyBase64: body !== null ? Buffer.from(JSON.stringify(body), 'utf8').toString('base64') : result.buffer.toString('base64'),
        bodySha256,
        comparison: { compared, shape, shapeReason },
    };
}

function snapshotTree(root) {
    const entries = [];
    const walk = (absolute, relative) => {
        if (!existsSync(absolute)) return;
        for (const name of readdirSync(absolute).sort()) {
            const childAbsolute = path.join(absolute, name);
            const childRelative = relative === '' ? name : `${relative}/${name}`;
            const info = statSync(childAbsolute);
            if (info.isDirectory()) {
                entries.push({ path: childRelative, kind: 'directory', size: 0, sha256: null });
                walk(childAbsolute, childRelative);
            } else {
                const content = readFileSync(childAbsolute);
                entries.push({ path: childRelative, kind: 'file', size: content.length, sha256: sha256(content) });
            }
        }
    };
    walk(root, '');
    return entries;
}

async function startPinnedServer() {
    const port = await choosePort();
    const origin = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, [
        'server.js', '--configPath', configPath, '--dataRoot', dataRoot,
        '--listenAddressIPv4', '127.0.0.1', '--enableIPv4', 'true', '--enableIPv6', 'false',
        '--listen', 'false', '--port', String(port), '--browserLaunchEnabled', 'false', '--heartbeatInterval', '0',
    ], { cwd: sourceRoot, env: { ...process.env, NODE_ENV: 'test' }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', chunk => logs.push(chunk.toString()));
    child.stderr.on('data', chunk => logs.push(chunk.toString()));
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error(`pinned server exited:\n${logs.join('').slice(-5000)}`);
        try {
            const result = await request(`${origin}/login?noauto=1`);
            if (result.status === 200 && (result.headers.contentType ?? '').includes('text/html')) return origin;
        } catch { /* not ready */ }
        await new Promise(resolve => setTimeout(resolve, 400));
    }
    throw new Error(`pinned server did not start:\n${logs.join('').slice(-5000)}`);
}

async function login(origin) {
    const csrf = await request(`${origin}/csrf-token`);
    const token = JSON.parse(csrf.buffer.toString('utf8')).token;
    const result = await request(`${origin}/api/users/login`, 'POST', {
        Cookie: cookieHeader(cookiesFrom(csrf)),
        'Content-Type': 'application/json',
        'X-CSRF-Token': token,
    }, JSON.stringify({ handle: 'default-user', password: '' }));
    if (result.status !== 200) throw new Error(`login failed: ${result.status}`);
    return { token, cookie: cookieHeader(cookiesFrom(result)) };
}

async function assetsScenarios(origin, auth) {
    const steps = [];
    const state = {};
    const post = async (route, body, query = '', contentType = 'application/json') => request(`${origin}/api/assets/${route}${query}`, 'POST', {
        Cookie: auth.cookie, 'Content-Type': contentType, 'X-CSRF-Token': auth.token,
    }, JSON.stringify(body ?? {}));
    const step = async (name, route, body, options = {}) => {
        const result = await post(route, body, options.query ?? '');
        const captured = captureResponse(result);
        // assets.get creates missing category folders as a side effect; snapshot both trees.
        steps.push({ name, route, body: body ?? {}, query: options.query ?? '', response: captured });
        state[name] = { assets: snapshotTree(path.join(userRoot, 'assets')), characters: snapshotTree(path.join(userRoot, 'characters')) };
    };
    await step('assets.get.seeded', 'get', {});
    await step('assets.get.characterQueryIgnored', 'get', { query: 'x' });
    await step('assets.delete.ok', 'delete', { category: 'bgm', filename: 'one.mp3' });
    await step('assets.delete.missing', 'delete', { category: 'bgm', filename: 'one.mp3' });
    await step('assets.delete.badCategory', 'delete', { category: 'nope', filename: 'two.mp3' });
    await step('assets.delete.invalidFilename', 'delete', { category: 'bgm', filename: '../two.mp3' });
    await step('assets.delete.traversalSanitized', 'delete', { category: 'bgm', filename: 'a/b.mp3' });
    await step('assets.character.ok', 'character', {}, { query: '?name=Seraphina&category=ambient' });
    await step('assets.character.live2d', 'character', {}, { query: '?name=Seraphina&category=live2d' });
    await step('assets.character.bgm', 'character', {}, { query: '?name=Seraphina&category=bgm' });
    await step('assets.character.noName', 'character', {}, { query: '?category=ambient' });
    await step('assets.character.badCategory', 'character', {}, { query: '?name=Seraphina&category=nope' });
    await step('assets.character.missingFolder', 'character', {}, { query: '?name=Nobody&category=ambient' });
    return { steps, state };
}

async function backupsScenarios(origin, auth) {
    const steps = [];
    const state = {};
    const post = async route => request(`${origin}/api/backups/chat/${route}`, 'POST', {
        Cookie: auth.cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': auth.token,
    }, JSON.stringify(activeBody));
    let activeBody = {};
    const step = async (name, route, body) => {
        activeBody = body ?? {};
        const result = await post(route);
        steps.push({ name, route, body: body ?? {}, response: captureResponse(result) });
        state[name] = { backups: snapshotTree(path.join(userRoot, 'backups')) };
    };
    await step('backups.download.ok', 'download', { name: 'chat_alpha.jsonl' });
    await step('backups.download.empty', 'download', { name: 'chat_empty.jsonl' });
    await step('backups.download.nonPrefix', 'download', { name: 'other.jsonl' });
    await step('backups.download.missing', 'download', { name: 'chat_missing.jsonl' });
    await step('backups.download.traversal', 'download', { name: '../backups/other.jsonl' });
    await step('backups.download.noName', 'download', {});
    await step('backups.delete.ok', 'delete', { name: 'chat_2024-01-01T00-00-00.jsonl' });
    await step('backups.delete.missing', 'delete', { name: 'chat_2024-01-01T00-00-00.jsonl' });
    await step('backups.delete.nonPrefix', 'delete', { name: 'other.jsonl' });
    await step('backups.delete.noName', 'delete', {});
    await step('backups.download.afterDelete', 'download', { name: 'chat_2024-01-01T00-00-00.jsonl' });
    return { steps, state };
}

try {
    seedFixture();
    const origin = await startPinnedServer();
    const auth = await login(origin);
    const report = mode === 'assets' ? await assetsScenarios(origin, auth) : await backupsScenarios(origin, auth);
    await stopServer();
    const fixture = {
        schemaVersion: 1,
        baseline: { version: PINNED_VERSION, commit: PINNED_COMMIT },
        probe: mode === 'assets'
            ? 'pinned /api/assets get, delete and character routes'
            : 'pinned /api/backups/chat delete and download routes',
        oracle: { file: mode === 'assets' ? 'src/endpoints/assets.js' : 'src/endpoints/backups.js' },
        conventions: {
            fixedMtimes: `every seeded file has mtime ${FIXED_SECONDS} (whole seconds) so no recorded value depends on host mtime precision`,
            paths: 'snapshot paths use forward slashes and are sorted; responses whose order comes from readdir are normalised by sorting arrays and object keys before recording',
        },
        fixtureFields: {
            compared: ['steps[].response.status', 'steps[].response.contentType', 'steps[].response.contentLength', 'steps[].response.etag', 'steps[].response.contentDisposition', 'steps[].response.body (normalised: arrays and object keys sorted)', 'steps[].response.bodySha256', 'state[<step>] tree (path, kind, size, sha256)', 'deleted files (absence from the next snapshot)'],
            shape: ['response.body order (readdir order is host-dependent; the sorted set is compared instead)'],
            shapeReason: {
                'response.body order': 'the pinned routes build their arrays in readdir order, which differs between NTFS and ext4; the fixture records the sorted set and the replay compares the sorted set, so order is not asserted',
            },
        },
        steps: report.steps,
        state: report.state,
        knownDifferences: mode === 'assets' ? [{
            routes: ['/api/assets/download'],
            status: 'not implemented',
            reason: 'the route checks config whitelistImportDomains and streams the download to a temp file before moving it; the whitelist config is not projected into HTTPHandlerOptions and a streamed write would be a second write path, so it is deferred rather than faked',
        }] : [{
            routes: ['/api/backups/chat/get'],
            status: 'not implemented',
            reason: 'the route depends on getChatInfo (chats.js:393): file stats, formatBytes, first-message parsing and chat_items counting; porting it without an oracle for chats.js internals would be a derivation, so it is deferred',
        }],
    };
    const outputFile = path.join(repositoryRoot, 'tests', 'oracle', mode === 'assets'
        ? 'sillytavern-1.19.0-assets.json'
        : 'sillytavern-1.19.0-backups.json');
    writeFileSync(outputFile, `${JSON.stringify(fixture, null, 2)}\n`);
    console.log(`Wrote ${path.relative(repositoryRoot, outputFile)} from pinned ${mode} behaviour`);
} catch (error) {
    console.error(error);
    process.exitCode = 1;
} finally {
    await stopServer();
    safeCleanup();
}
