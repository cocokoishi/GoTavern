#!/usr/bin/env node
// Capture pinned POST /api/chats/import.
//
// Timing and host-dependence notes:
//  - every imported message carries new Date().toISOString() and every written
//    file is named `${characterName} - ${humanizedDateTime()} imported.jsonl`,
//    so both are recorded as markers;
//  - the file name has millisecond resolution, so two imports inside one
//    millisecond would write the same file and the second would overwrite the
//    first. The probe waits for the clock to pass the previous import's
//    timestamp before the next import, the same way the groups probe spaces its
//    creates. That is a timing dependence, not a platform one;
//  - directory listings are recorded sorted because pinned fs.readdirSync order
//    differs between NTFS and ext4.

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
// @gotavern-oracle: fixture=sillytavern-1.19.0-chats-import.json label="chats import"
const COOKIE_SECRET = 'gotavern-pinned-chats-import-cookie-secret';
const sourceRoot = path.resolve(process.argv[2] ?? '');
const repositoryRoot = path.resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3]) {
    console.error('usage: node tools/probe-chats-import.mjs <pinned-source-clone-with-dependencies> <gotavern-root>');
    process.exit(2);
}
if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim() !== PINNED_COMMIT) {
    throw new Error('upstream checkout is not pinned at ' + PINNED_COMMIT);
}

const runtimeRoot = mkdtempSync(path.join(os.tmpdir(), 'gotavern-chats-import-oracle-'));
const dataRoot = path.join(runtimeRoot, 'data');
const logs = [];
let child;

const HUMANIZED_PATTERN = /\d{4}-\d{2}-\d{2}@\d{2}h\d{2}m\d{2}s\d{3}ms/g;
const HUMANIZED_PARTS = /(\d{4})-(\d{2})-(\d{2})@(\d{2})h(\d{2})m(\d{2})s(\d{3})ms/;
const ISO_PATTERN = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g;

function sha256(value) {
    return createHash('sha256').update(value).digest('hex');
}

function safeCleanup() {
    const resolved = path.resolve(runtimeRoot);
    const parent = path.resolve(os.tmpdir());
    if (path.dirname(resolved).toLowerCase() !== parent.toLowerCase()
        || !path.basename(resolved).startsWith('gotavern-chats-import-oracle-')) {
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

function normalizeText(text) {
    return text.replace(HUMANIZED_PATTERN, '<humanizedDateTime>').replace(ISO_PATTERN, '<isoDate>');
}

function normalizeValue(value) {
    if (typeof value === 'string') return normalizeText(value);
    if (Array.isArray(value)) return value.map(normalizeValue);
    if (value && typeof value === 'object') {
        const result = {};
        for (const [key, child] of Object.entries(value)) result[key] = normalizeValue(child);
        return result;
    }
    return value;
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
            const relative = normalizeText(prefix ? `${prefix}/${name}` : name);
            if (statSync(target).isDirectory()) {
                entries.push({ path: relative, kind: 'directory' });
                walk(target, prefix ? `${prefix}/${name}` : name);
                continue;
            }
            // Imported messages embed new Date().toISOString(), so the digest is
            // taken over the normalized content: it still asserts the imported
            // text, the message order and the JSON shape without depending on
            // when the import ran.
            entries.push({ path: relative, kind: 'file', sha256: sha256(Buffer.from(normalizeText(readFileSync(target, 'utf8')), 'utf8')), bytes: statSync(target).size });
        }
    };
    walk(root, '');
    return entries;
}

// The generated file name carries humanizedDateTime(), which uses local time.
function humanizedMillis(text) {
    const match = HUMANIZED_PARTS.exec(text ?? '');
    if (!match) return 0;
    return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6]), Number(match[7])).getTime();
}

// ---- Upload payloads ----

const KOBOLD_LITE = {
    savedsettings: { chatname: 'Kobold User', chatopponent: 'Kobold Char||$||extra' },
    prompt: '{{[INPUT]}}kobold prompt',
    actions: ['{{[OUTPUT]}}kobold reply', '{{[INPUT]}}kobold follow-up'],
};
const OOBA = { data_visible: [['ooba user', 'ooba char'], ['', 'ooba char only'], ['ooba user only', '']] };
const AGNAI = { messages: [{ userId: 'u1', msg: 'agnai user' }, { msg: 'agnai char' }] };
const RISU = {
    type: 'risuChat',
    data: { message: [
        { role: 'user', data: 'risu user', time: 1717000000000 },
        { role: 'char', name: 'Named Char', data: 'risu char', time: 1717000001000 },
    ] },
};
const CAI_EMPTY = { histories: { histories: [] } };
const CAI_ONE_HISTORY = { histories: { histories: [{ msgs: [{ src: { is_human: true }, text: 'cai user' }] }] } };
const UNKNOWN_JSON = { nothing: 'useful' };

const PLAIN_JSONL = [
    JSON.stringify({ chat_metadata: { integrity: 'probe' }, user_name: 'unused', character_name: 'unused' }),
    JSON.stringify({ name: 'Alice', is_user: true, send_date: '2024-07-01T00:00:00.000Z', mes: 'plain jsonl message' }),
].join('\n');
const CHUB_JSONL = [
    JSON.stringify({ user_name: 'unused', character_name: 'unused', chat_metadata: {} }),
    JSON.stringify({ name: 'Chub Char', is_user: false, mes: { message: 'chub nested message' }, swipes: [{ message: 'swipe one' }, 'swipe two'] }),
].join('\n');
const BAD_HEADER_JSONL = ['not json at all', JSON.stringify({ name: 'Alice', mes: 'x' })].join('\n');
const WRONG_HEADER_JSONL = [JSON.stringify({ unrelated: true }), JSON.stringify({ name: 'Alice', mes: 'x' })].join('\n');

const UPLOADS = {
    importKoboldLite: { file_type: 'json', body: JSON.stringify(KOBOLD_LITE) },
    importOoba: { file_type: 'json', body: JSON.stringify(OOBA) },
    importAgnai: { file_type: 'json', body: JSON.stringify(AGNAI) },
    importRisu: { file_type: 'json', body: JSON.stringify(RISU) },
    importCAIEmpty: { file_type: 'json', body: JSON.stringify(CAI_EMPTY) },
    importCAIWithHistory: { file_type: 'json', body: JSON.stringify(CAI_ONE_HISTORY) },
    importUnknownJSON: { file_type: 'json', body: JSON.stringify(UNKNOWN_JSON) },
    importInvalidJSON: { file_type: 'json', body: 'this is not json' },
    importJSONLPlain: { file_type: 'jsonl', body: PLAIN_JSONL },
    importJSONLChub: { file_type: 'jsonl', body: CHUB_JSONL },
    importJSONLBadHeader: { file_type: 'jsonl', body: BAD_HEADER_JSONL },
    importJSONLWrongHeader: { file_type: 'jsonl', body: WRONG_HEADER_JSONL },
};

try {
    mkdirSync(path.join(dataRoot, '_storage'), { recursive: true });
    writeFileSync(path.join(dataRoot, 'cookie-secret.txt'), COOKIE_SECRET);
    writeFileSync(path.join(dataRoot, '_storage', sha256('user:default-user')), JSON.stringify({
        key: 'user:default-user',
        value: {
            handle: 'default-user', name: 'Chats Import Probe', created: 1700000000000,
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
    const chatsRoot = path.join(dataRoot, 'default-user', 'chats');
    // The pinned route never creates the character chats directory, and
    // write-file-atomic does not create parents, so an import into a character
    // that has never chatted fails with { error: true }. Seed one character
    // directory so the happy paths are reachable, and probe the missing one
    // separately.
    mkdirSync(path.join(chatsRoot, 'Alice'), { recursive: true });

    let lastImportMillis = 0;
    const waitForDistinctImportName = async () => {
        while (Date.now() <= lastImportMillis) {
            await new Promise(resolve => setTimeout(resolve, 1));
        }
    };

    const scenarios = {};
    const runImport = async (name, { file_type, body }, options = {}) => {
        console.error('scenario: ' + name);
        if (options.spaced !== false) {
            await waitForDistinctImportName();
        }
        const form = new FormData();
        form.set('file_type', file_type);
        form.set('avatar_url', options.avatarUrl ?? 'Alice.png');
        form.set('character_name', options.characterName ?? 'Imported Char');
        form.set('user_name', options.userName ?? 'Imported User');
        form.append('avatar', new Blob([Buffer.from(body, 'utf8')], { type: 'application/octet-stream' }), options.filename ?? 'chat.txt');
        const result = await request(origin + '/api/chats/import', 'POST', { Cookie: sessionCookie, 'X-CSRF-Token': token }, form);

        const captured = {
            status: result.response.status,
            headers: stableHeaders(result.response),
            body: normalizeValue(result.body),
            bodyIsJSON: result.bodyIsJSON,
            bodyText: '',
        };
        captured.bodyText = captured.bodyIsJSON ? JSON.stringify(captured.body) : (typeof captured.body === 'string' ? captured.body : '');
        const fileNames = result.body?.fileNames;
        if (Array.isArray(fileNames) && fileNames.length > 0) {
            lastImportMillis = Math.max(lastImportMillis, humanizedMillis(fileNames[fileNames.length - 1]));
        }
        scenarios[name] = {
            route: '/api/chats/import',
            multipart: {
                fields: [['file_type', file_type], ['avatar_url', options.avatarUrl ?? 'Alice.png'], ['character_name', options.characterName ?? 'Imported Char'], ['user_name', options.userName ?? 'Imported User']],
                field: 'avatar',
                filename: options.filename ?? 'chat.txt',
                bytesHex: Buffer.from(body, 'utf8').toString('hex'),
            },
            response: captured,
            chats: treeSnapshot(chatsRoot),
        };
    };

    for (const [name, upload] of Object.entries(UPLOADS)) {
        await runImport(name, upload);
    }

    // Empty names exercise the pinned sanitize(name) || 'Character' and
    // || 'User' fallbacks, which change the generated file name and the
    // imported message names.
    await runImport('importEmptyNames', UPLOADS.importKoboldLite, { characterName: '', userName: '' });

    // A character whose chats directory does not exist: write-file-atomic does
    // not create parents, so the pinned route reports { error: true }.
    await runImport('importMissingCharacterDirectory', UPLOADS.importKoboldLite, { avatarUrl: 'Bob.png', spaced: false });

    // Guards that do not reach the import logic.
    console.error('scenario: importForbiddenAvatar');
    const forbidden = new FormData();
    forbidden.set('file_type', 'json');
    forbidden.set('avatar_url', '../escape.png');
    forbidden.set('character_name', 'Imported Char');
    forbidden.set('user_name', 'Imported User');
    forbidden.append('avatar', new Blob([Buffer.from('{}', 'utf8')], { type: 'application/octet-stream' }), 'chat.txt');
    const forbiddenResult = await request(origin + '/api/chats/import', 'POST', { Cookie: sessionCookie, 'X-CSRF-Token': token }, forbidden);
    scenarios.importForbiddenAvatar = {
        route: '/api/chats/import',
        multipart: { fields: [['file_type', 'json'], ['avatar_url', '../escape.png'], ['character_name', 'Imported Char'], ['user_name', 'Imported User']], field: 'avatar', filename: 'chat.txt', bytesHex: Buffer.from('{}', 'utf8').toString('hex') },
        response: { status: forbiddenResult.response.status, headers: stableHeaders(forbiddenResult.response), body: normalizeValue(forbiddenResult.body), bodyIsJSON: forbiddenResult.bodyIsJSON, bodyText: forbiddenResult.bodyIsJSON ? JSON.stringify(normalizeValue(forbiddenResult.body)) : (typeof forbiddenResult.body === 'string' ? forbiddenResult.body : '') },
        chats: treeSnapshot(chatsRoot),
    };

    console.error('scenario: importMissingFile');
    const missingFile = await request(origin + '/api/chats/import', 'POST', { Cookie: sessionCookie, 'X-CSRF-Token': token, 'Content-Type': 'application/json' }, JSON.stringify({ file_type: 'json', avatar_url: 'Alice.png', character_name: 'Imported Char', user_name: 'Imported User' }));
    scenarios.importMissingFile = {
        route: '/api/chats/import',
        json: JSON.stringify({ file_type: 'json', avatar_url: 'Alice.png', character_name: 'Imported Char', user_name: 'Imported User' }),
        response: { status: missingFile.response.status, headers: stableHeaders(missingFile.response), body: missingFile.body, bodyIsJSON: missingFile.bodyIsJSON, bodyText: missingFile.bodyIsJSON ? JSON.stringify(missingFile.body) : (typeof missingFile.body === 'string' ? missingFile.body : '') },
        chats: treeSnapshot(chatsRoot),
    };

    // The pinned handler sends no response at all for an unknown file_type, so
    // that case is deliberately not probed: it would hang the probe.
    const fixture = {
        schemaVersion: 1,
        baseline: { version: PINNED_VERSION, commit: PINNED_COMMIT },
        probe: 'pinned POST /api/chats/import',
        normalization: [
            'Imported messages carry new Date().toISOString() and the written file is named `${characterName} - ${humanizedDateTime()} imported.jsonl`, so both are recorded as <isoDate> and <humanizedDateTime>.',
            'The file name has millisecond resolution, so the probe waits for the clock to pass the previous import timestamp before each import; without that, two imports inside one millisecond would write the same file. This is a timing dependence, not a platform one.',
            'Directory listings are recorded sorted because pinned fs.readdirSync order is filesystem-dependent (NTFS is sorted, ext4 is not).',
            'Imported file digests are taken over the content with the generated timestamps normalized, so a digest still asserts the imported text, message order and JSON shape without depending on when the import ran.',
            'Express-derived ETag and content-length are recorded as <derived-from-normalized-body> for responses whose body carries a generated timestamp, because they are functions of the un-normalized bytes.',
            'The unknown-file_type case is not probed: the pinned handler sends no response and the request hangs until the client times out. GoTavern answers 400 and the gap is recorded in docs/compat-matrix.md.',
        ],
        inputs: {
            cookieSecret: COOKIE_SECRET,
            uploads: UPLOADS,
        },
        scenarioOrder: Object.keys(scenarios),
        scenarios,
    };

    // A response whose body carries a generated timestamp cannot have a
    // reproducible ETag or content-length, because both are functions of the
    // un-normalized bytes.
    for (const scenario of Object.values(scenarios)) {
        const text = scenario.response.bodyText ?? '';
        if (text.includes('<humanizedDateTime>') || text.includes('<isoDate>')) {
            scenario.response.headers.etag = '<derived-from-normalized-body>';
            scenario.response.headers['content-length'] = '<derived-from-normalized-body>';
        }
    }

    const outputFile = path.join(repositoryRoot, 'tests', 'oracle', 'sillytavern-1.19.0-chats-import.json');
    mkdirSync(path.dirname(outputFile), { recursive: true });
    writeFileSync(outputFile, JSON.stringify(fixture, null, 2) + '\n');
    console.log('Wrote tests/oracle/sillytavern-1.19.0-chats-import.json from pinned behavior');
} catch (error) {
    console.error(error);
    process.exitCode = 1;
} finally {
    await stopServer();
    safeCleanup();
}
