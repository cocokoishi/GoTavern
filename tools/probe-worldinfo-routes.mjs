#!/usr/bin/env node
// Capture pinned world-info route behavior: the /list projection, the sanitized
// /get read (including every Express res.send() shape), /delete, the multipart
// /import staging rules and the /edit write, plus a Node -> Go -> Node round trip
// for world files.

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const PINNED_COMMIT = '06bde939fb1e9c4c8d8641d810f0a916b5bce127';
const PINNED_VERSION = '1.19.0';
// @gotavern-oracle: fixture=sillytavern-1.19.0-worldinfo-routes.json label="world-info routes"
const COOKIE_SECRET = 'gotavern-pinned-worldinfo-cookie-secret';
const sourceRoot = path.resolve(process.argv[2] ?? '');
const repositoryRoot = path.resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3]) {
    console.error('usage: node tools/probe-worldinfo-routes.mjs <pinned-source-clone> <gotavern-root>');
    process.exit(2);
}
if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim() !== PINNED_COMMIT) {
    throw new Error(`upstream checkout is not pinned at ${PINNED_COMMIT}`);
}

const runtimeRoot = mkdtempSync(path.join(os.tmpdir(), 'gotavern-worldinfo-oracle-'));
const dataRoot = path.join(runtimeRoot, 'data');
const configPath = path.join(runtimeRoot, 'config.yaml');
const logs = [];
const goLogs = [];
let child;
let goChild;

function safeCleanup() {
    const resolved = path.resolve(runtimeRoot);
    const parent = path.resolve(os.tmpdir());
    if (path.dirname(resolved).toLowerCase() !== parent.toLowerCase()
        || !path.basename(resolved).startsWith('gotavern-worldinfo-oracle-')) {
        throw new Error(`refusing to remove unexpected runtime path: ${resolved}`);
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

// Accept-Encoding: identity keeps every recorded response uncompressed. Node's
// fetch negotiates gzip by default, so without it the recorded framing would
// depend on the fetch implementation rather than on the route: a body above the
// pinned compression threshold comes back chunked with no content-length and an
// ETag computed from the uncompressed bytes, which GoTavern does not reproduce.
async function request(url, method = 'GET', headers = {}, body) {
    const response = await fetch(url, {
        method,
        headers: { 'Accept-Encoding': 'identity', ...headers },
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(10000),
    });
    let parsedBody = Buffer.from(await response.arrayBuffer()).toString('utf8');
    try {
        parsedBody = parsedBody ? JSON.parse(parsedBody) : null;
    } catch {
        // Preserve plain text and HTML response bodies.
    }
    return { response, body: parsedBody };
}

function stableHeaders(response) {
    return Object.fromEntries([...response.headers.entries()]
        .filter(([name]) => !['connection', 'date', 'keep-alive', 'last-modified', 'set-cookie', 'x-response-time'].includes(name))
        .sort(([left], [right]) => left.localeCompare(right)));
}

function capture(result) {
    return { status: result.response.status, headers: stableHeaders(result.response), body: result.body };
}

// The pinned routes throw for a missing world file, an unparsable world file and
// a name that cannot be stringified. Express answers those with its finalhandler
// error page, whose <pre> block is the V8 stack trace: it embeds host-absolute
// source paths and pinned line numbers, so the body and every body-derived
// header are host-dependent and cannot be recorded. Record the status, and fail
// loudly if the response is not the HTML error page this expects.
function captureErrorPage(label, result) {
    const contentType = result.response.headers.get('content-type') ?? '';
    if (!contentType.startsWith('text/html')) {
        throw new Error(`${label}: expected the Express error page, got ${result.response.status} ${contentType}: ${String(result.body).slice(0, 300)}`);
    }
    return { status: result.response.status };
}

function cookiesFrom(response) {
    if (typeof response.headers.getSetCookie !== 'function') throw new Error('Node fetch does not expose getSetCookie()');
    return response.headers.getSetCookie();
}

function cookieHeader(cookies) {
    return cookies.map(cookie => cookie.split(';', 1)[0]).join('; ');
}

function sha256(value) {
    return createHash('sha256').update(value).digest('hex');
}

function seedUser(key, value) {
    writeFileSync(path.join(dataRoot, '_storage', sha256(key)), JSON.stringify({ key, value }));
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

async function stopGoServer(origin) {
    if (!goChild || goChild.exitCode !== null) return;
    try {
        await request(`${origin}/_gotavern-probe/shutdown`, 'POST');
    } catch {
        // The Go probe process may already have failed.
    }
    await Promise.race([
        new Promise(resolve => goChild.once('exit', resolve)),
        new Promise(resolve => setTimeout(resolve, 5000)),
    ]);
    if (goChild.exitCode === null) goChild.kill();
}

async function waitForServer(origin) {
    const deadline = Date.now() + 180000;
    let lastError;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error(`pinned server exited before readiness:\n${logs.join('').slice(-10000)}`);
        try {
            const result = await request(`${origin}/login?noauto=1`);
            if (result.response.status === 200 && result.response.headers.get('content-type')?.includes('text/html')) return;
            lastError = new Error(`login returned ${result.response.status}`);
        } catch (error) {
            lastError = error;
        }
        await new Promise(resolve => setTimeout(resolve, 300));
    }
    throw new Error(`pinned server did not become ready: ${lastError?.stack ?? 'none'}\n${logs.join('').slice(-10000)}`);
}

// Sorted directory snapshot: names, kind and exact bytes. No sizes or mtimes, so
// the observation does not depend on the host filesystem.
function worldsState(directory) {
    return readdirSync(directory).sort().map(name => {
        const absolute = path.join(directory, name);
        const info = statSync(absolute);
        return {
            name,
            kind: info.isFile() ? 'file' : info.isDirectory() ? 'directory' : 'other',
            content: info.isFile() ? readFileSync(absolute).toString('utf8') : null,
        };
    });
}

function uploadsCount(directory) {
    return existsSync(directory) ? readdirSync(directory).length : null;
}

// Node writes a world through the pinned route, GoTavern reads it and writes its
// own, and pinned Node then reads the GoTavern-written file back. Both sides
// must see each other's bytes.
async function verifyRoundTrip(origin, sessionCookie, token, worldsRoot) {
    const nodeWrittenBody = JSON.stringify({
        name: 'nodewritten',
        data: { entries: { '0': { uid: 0, content: 'written by pinned Node' } }, probeUnknown: { keep: true } },
    });
    const nodeWrite = await request(`${origin}/api/worldinfo/edit`, 'POST', {
        Cookie: sessionCookie, 'Content-Type': 'application/json', 'X-CSRF-Token': token,
    }, nodeWrittenBody);
    if (nodeWrite.response.status !== 200) {
        throw new Error(`pinned Node could not write the round-trip world: ${nodeWrite.response.status}`);
    }

    const port = await choosePort();
    const goOrigin = `http://127.0.0.1:${port}`;
    goChild = spawn('go', ['run', './tools/settings-save-roundtrip', dataRoot, String(port)], {
        cwd: repositoryRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    goChild.stdout.setEncoding('utf8');
    goChild.stderr.setEncoding('utf8');
    goChild.stdout.on('data', chunk => goLogs.push(chunk));
    goChild.stderr.on('data', chunk => goLogs.push(chunk));
    const deadline = Date.now() + 120000;
    let ready = false;
    let lastError;
    while (Date.now() < deadline && !ready) {
        if (goChild.exitCode !== null) throw new Error(`Go round-trip server exited before readiness:\n${goLogs.join('').slice(-10000)}`);
        try {
            const result = await request(`${goOrigin}/version`);
            ready = result.response.status === 200;
            if (!ready) lastError = new Error(`Go /version returned ${result.response.status}`);
        } catch (error) {
            lastError = error;
        }
        if (!ready) await new Promise(resolve => setTimeout(resolve, 250));
    }
    if (!ready) throw new Error(`Go round-trip server did not become ready: ${lastError?.stack ?? 'none'}\n${goLogs.join('').slice(-10000)}`);

    const goWrittenBody = JSON.stringify({
        name: 'gowritten',
        data: { entries: { '0': { uid: 0, content: 'written by GoTavern' } }, probeUnknown: { keep: 'go' } },
    });
    let goRead;
    let goWrite;
    try {
        goRead = await request(`${goOrigin}/api/worldinfo/get`, 'POST', { 'Content-Type': 'application/json' },
            JSON.stringify({ name: 'nodewritten' }));
        goWrite = await request(`${goOrigin}/api/worldinfo/edit`, 'POST', { 'Content-Type': 'application/json' }, goWrittenBody);
    } finally {
        await stopGoServer(goOrigin);
    }
    if (goWrite.response.status !== 200 || goWrite.body?.ok !== true) {
        throw new Error(`GoTavern could not write the round-trip world: ${goWrite.response.status} ${JSON.stringify(goWrite.body)}\n${goLogs.join('').slice(-10000)}`);
    }

    const nodeRead = await request(`${origin}/api/worldinfo/get`, 'POST', {
        Cookie: sessionCookie, 'Content-Type': 'application/json', 'X-CSRF-Token': token,
    }, JSON.stringify({ name: 'gowritten' }));
    if (goRead.response.status !== 200 || nodeRead.response.status !== 200) {
        throw new Error(`world-info round trip failed: Go read ${goRead.response.status}, Node read ${nodeRead.response.status}\n${goLogs.join('').slice(-10000)}`);
    }
    return {
        verified: true,
        nodeWrittenBody,
        goWrittenBody,
        nodeWrittenWorldReadByGo: goRead.body,
        goWrittenWorldReadByNode: nodeRead.body,
        goWrittenWorldBytes: readFileSync(path.join(worldsRoot, 'gowritten.json'), 'utf8'),
    };
}

// Seeded worlds. Every JSON name is ASCII and differs from its neighbours in the
// first character, so the pinned localeCompare() sort order is the same under
// any host collation. `Zulu.json` is deliberately upper-case: localeCompare puts
// it after `textual`, while a byte-wise sort would put it first, so the recorded
// order can actually discriminate the pinned collation from a plain byte sort.
const SEEDED_WORLDS = {
    'Zulu.json': '{"name":"Zulu World","entries":{}}',
    'alpha.json': '{\n  "name": "Alpha World",\n  "entries": { "0": { "uid": 0, "key": ["alpha"], "content": "alpha content" } },\n  "extensions": { "marker": "alpha", "nested": { "keep": true } },\n  "probeUnknownTopLevel": { "keep": [1, 2, 3] }\n}\n',
    'boolean.json': 'true',
    'bravo.json': '{"entries":{"0":{"uid":0}},"extensions":[1,2]}',
    'charlie.json': '{"entries":{},"extensions":"not an object"}',
    'delta.json': 'this is not json at all',
    'echo.json': '[1,2,3]',
    'foxtrot.JSON': '{"name":"Foxtrot Upper","entries":{}}',
    'golf.txt': '{"entries":{}}',
    'invalid-number.json': '5',
    'nothing.json': 'null',
    'numeric.json': '404',
    'textual.json': '"just a string"',
};

try {
    mkdirSync(path.join(dataRoot, '_storage'), { recursive: true });
    writeFileSync(path.join(dataRoot, 'cookie-secret.txt'), COOKIE_SECRET);
    writeFileSync(configPath, 'enableUserAccounts: true\nskipContentCheck: true\n');
    seedUser('user:default-user', {
        handle: 'default-user', name: 'World Info Probe', created: 1700000000000,
        password: '', admin: true, enabled: true, salt: '',
        probeUnknownField: { preserve: true },
    });

    const port = await choosePort();
    const origin = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, [
        'server.js', '--configPath', configPath, '--dataRoot', dataRoot,
        '--listenAddressIPv4', '127.0.0.1', '--enableIPv4', 'true', '--enableIPv6', 'false',
        '--listen', 'false', '--port', String(port), '--browserLaunchEnabled', 'false', '--heartbeatInterval', '0',
    ], { cwd: sourceRoot, env: { ...process.env, NODE_ENV: 'test' }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => logs.push(chunk));
    child.stderr.on('data', chunk => logs.push(chunk));
    await waitForServer(origin);

    const userRoot = path.join(dataRoot, 'default-user');
    const worldsRoot = path.join(userRoot, 'worlds');
    const uploadsRoot = path.join(dataRoot, '_uploads');
    rmSync(worldsRoot, { recursive: true, force: true });
    mkdirSync(worldsRoot, { recursive: true });
    // A directory named like a world file and a non-JSON file prove the pinned
    // isFile() + extname() filter; neither is host-dependent.
    mkdirSync(path.join(worldsRoot, 'hotel.json'), { recursive: true });
    for (const [name, content] of Object.entries(SEEDED_WORLDS)) {
        writeFileSync(path.join(worldsRoot, name), content);
    }
    writeFileSync(path.join(userRoot, 'settings.json'), '{}');
    const accountRecordPath = path.join(dataRoot, '_storage', sha256('user:default-user'));
    const accountRecordBefore = readFileSync(accountRecordPath);

    const csrf = await request(`${origin}/csrf-token`);
    const token = csrf.body.token;
    const csrfCookie = cookieHeader(cookiesFrom(csrf.response));
    const login = await request(`${origin}/api/users/login`, 'POST', {
        Cookie: csrfCookie, 'Content-Type': 'application/json', 'X-CSRF-Token': token,
    }, JSON.stringify({ handle: 'default-user', password: '' }));
    if (login.response.status !== 200) {
        throw new Error(`could not login: ${login.response.status} ${JSON.stringify(login.body)}\n${logs.join('').slice(-10000)}`);
    }
    const sessionCookie = cookieHeader(cookiesFrom(login.response));
    const jsonHeaders = { Cookie: sessionCookie, 'Content-Type': 'application/json', 'X-CSRF-Token': token };
    const post = (route, body, headers = jsonHeaders) => request(`${origin}/api/worldinfo/${route}`, 'POST', headers, body);
    const json = value => JSON.stringify(value);

    const responses = {};
    const errorPages = {};
    const record = (label, result) => { responses[label] = capture(result); };
    const recordErrorPage = (label, result) => { errorPages[label] = captureErrorPage(label, result); };

    // ---- /list -------------------------------------------------------------
    record('listMain', await post('list', json({})));
    record('listWrongMethod', await request(`${origin}/api/worldinfo/list`, 'GET', { Cookie: sessionCookie }));
    record('listWrongMethodHead', await request(`${origin}/api/worldinfo/list`, 'HEAD', { Cookie: sessionCookie }));

    // ---- /get --------------------------------------------------------------
    record('getAlpha', await post('get', json({ name: 'alpha' })));
    record('getMissingFile', await post('get', json({ name: 'missing' })));
    record('getEmptyName', await post('get', json({ name: '' })));
    record('getAbsentName', await post('get', json({})));
    record('getNameNumber', await post('get', json({ name: 123 })));
    record('getNameArray', await post('get', json({ name: ['a', 'b'] })));
    record('getNameObject', await post('get', json({ name: { a: 1 } })));
    record('getNameWithSlash', await post('get', json({ name: 'a/b' })));
    record('getNameWithExtension', await post('get', json({ name: 'alpha.json' })));
    record('getTextual', await post('get', json({ name: 'textual' })));
    record('getNull', await post('get', json({ name: 'nothing' })));
    record('getBoolean', await post('get', json({ name: 'boolean' })));
    record('getNumericStatus', await post('get', json({ name: 'numeric' })));
    recordErrorPage('getInvalidJson', await post('get', json({ name: 'delta' })));
    recordErrorPage('getSanitizedToEmpty', await post('get', json({ name: 'con' })));
    recordErrorPage('getInvalidNumber', await post('get', json({ name: 'invalid-number' })));
    recordErrorPage('getMalformedBody', await post('get', '{'));
    recordErrorPage('getNonObjectBody', await post('get', '5'));
    record('getNonJsonContentType', await request(`${origin}/api/worldinfo/get`, 'POST',
        { Cookie: sessionCookie, 'Content-Type': 'text/plain', 'X-CSRF-Token': token }, json({ name: 'alpha' })));
    // The pinned JSON parser matches only application/json, so a +json suffix is
    // skipped exactly like text/plain and the route sees an empty body object.
    record('getPlusJSONContentType', await request(`${origin}/api/worldinfo/get`, 'POST',
        { Cookie: sessionCookie, 'Content-Type': 'application/vnd.api+json', 'X-CSRF-Token': token }, json({ name: 'alpha' })));
    record('getNoBody', await post('get', undefined));
    record('getWrongMethod', await request(`${origin}/api/worldinfo/get`, 'GET', { Cookie: sessionCookie }));

    // ---- /edit -------------------------------------------------------------
    const editCreated = json({ name: 'edited', data: { entries: { '0': { uid: 0, content: 'edited content' } }, probeUnknownTopLevel: { keep: 'edit' } } });
    record('editCreate', await post('edit', editCreated));
    // Integer-like keys enumerate in ascending numeric order, not document order.
    const editNumericKeys = json({ name: 'keyorder', data: { entries: { '10': { uid: 10 }, '2': { uid: 2 } } } });
    record('editNumericKeys', await post('edit', editNumericKeys));
    const editOverwrite = json({ name: 'bravo', data: { entries: { '0': { uid: 0, replaced: true } } } });
    record('editOverwrite', await post('edit', editOverwrite));
    record('editAbsentName', await post('edit', json({ data: { entries: {} } })));
    record('editEmptyName', await post('edit', json({ name: '', data: { entries: {} } })));
    record('editMissingData', await post('edit', json({ name: 'x' })));
    record('editNullData', await post('edit', json({ name: 'x', data: null })));
    record('editArrayData', await post('edit', json({ name: 'x', data: [] })));
    record('editStringData', await post('edit', json({ name: 'x', data: 'str' })));
    record('editMissingEntries', await post('edit', json({ name: 'x', data: { notEntries: true } })));
    record('editSanitizedName', await post('edit', json({ name: 'a/b', data: { entries: {} } })));
    record('editNameNumber', await post('edit', json({ name: 123, data: { entries: {} } })));
    recordErrorPage('editMalformedBody', await post('edit', 'not json'));
    record('editWrongMethod', await request(`${origin}/api/worldinfo/edit`, 'GET', { Cookie: sessionCookie }));

    const worldsAfterEdits = worldsState(worldsRoot);

    // ---- /import -----------------------------------------------------------
    const multipart = (fields, file) => {
        const form = new FormData();
        for (const [key, value] of fields) form.set(key, value);
        if (file) form.set('avatar', new Blob([Buffer.from(file.content, 'utf8')], { type: 'application/octet-stream' }), file.filename);
        return request(`${origin}/api/worldinfo/import`, 'POST', { Cookie: sessionCookie, 'X-CSRF-Token': token }, form);
    };
    const importedWorld = '{"entries":{"0":{"uid":0,"content":"imported"}},"probeUnknown":{"keep":true}}';
    const importCases = {
        importNoFile: { body: json({}) },
        importValid: { file: { filename: 'imported.json', content: importedWorld } },
        importDottedName: { file: { filename: 'my.world.json', content: '{"entries":{}}' } },
        importSlashName: { file: { filename: 'a/b.json', content: '{"entries":{}}' } },
        importEmptySanitizedName: { file: { filename: 'con.json', content: '{"entries":{}}' } },
        importTextExtension: { file: { filename: 'notes.txt', content: '{"entries":{"0":{"uid":0}}}' } },
        importMissingEntries: { file: { filename: 'noentries.json', content: '{"foo":1}' } },
        importArrayContent: { file: { filename: 'arraycontent.json', content: '[1,2]' } },
        importInvalidJson: { file: { filename: 'broken.json', content: 'not json' } },
        importConvertedData: { fields: [['convertedData', '{"entries":{"0":{"uid":0,"content":"converted"}}}']], file: { filename: 'converted.json', content: '{"entries":{}}' } },
        importConvertedDataInvalid: { fields: [['convertedData', 'not json']], file: { filename: 'converted-bad.json', content: '{"entries":{}}' } },
        importEmptyConvertedData: { fields: [['convertedData', '']], file: { filename: 'converted-empty.json', content: '{"entries":{"0":{"uid":0}}}' } },
    };
    const uploadsAfterImport = {};
    // The pinned multer instance creates DATA_ROOT/_uploads while server-main.js
    // is imported. If it is missing, every multipart observation below would
    // record multer's ENOENT instead of the route contract, so fail loudly
    // rather than recording that.
    if (!existsSync(uploadsRoot)) {
        throw new Error(`pinned server did not create ${uploadsRoot} during startup:\n${logs.join('').slice(-5000)}`);
    }
    for (const [label, definition] of Object.entries(importCases)) {
        console.error('DEBUG before', label, 'exists:', existsSync(uploadsRoot), 'entries:', JSON.stringify(existsSync(uploadsRoot) ? readdirSync(uploadsRoot) : null));
        const result = definition.file === undefined && definition.body !== undefined
            ? await post('import', definition.body)
            : await multipart(definition.fields ?? [], definition.file);
        record(label, result);
        uploadsAfterImport[label] = uploadsCount(uploadsRoot);
    }

    const worldsAfterImports = worldsState(worldsRoot);

    // ---- /delete -----------------------------------------------------------
    // The sanitized name `al/pha` must remove alpha.json, which also proves the
    // sanitize-then-join order rather than a containment check.
    record('deleteAbsentName', await post('delete', json({})));
    record('deleteSanitizedName', await post('delete', json({ name: 'al/pha' })));
    recordErrorPage('deleteAlphaGone', await post('delete', json({ name: 'alpha' })));
    record('deleteCharlie', await post('delete', json({ name: 'charlie' })));
    recordErrorPage('deleteMissingFile', await post('delete', json({ name: 'missing' })));
    record('deleteWrongMethod', await request(`${origin}/api/worldinfo/delete`, 'GET', { Cookie: sessionCookie }));

    const worldsAfterDeletes = worldsState(worldsRoot);
    const accountRecordUnchanged = accountRecordBefore.equals(readFileSync(accountRecordPath));
    const roundTrip = await verifyRoundTrip(origin, sessionCookie, token, worldsRoot);
    await stopServer();

    const fixture = {
        schemaVersion: 1,
        baseline: { version: PINNED_VERSION, commit: PINNED_COMMIT },
        probe: 'pinned world-info list/get/delete/import/edit responses, filename sanitization, res.send() shapes and multipart staging rules',
        normalizations: [
            'Requests are sent with Accept-Encoding: identity so the recorded framing is a property of the route rather than of the pinned compression middleware.',
            'Every request body-derived header is recorded as-is; the pinned responses are uncompressed because of the previous rule.',
            'A thrown route error answers with Express finalhandler\'s HTML page, whose <pre> block is the V8 stack with host-absolute source paths and pinned line numbers. Those responses are recorded in errorPages as a status only; GoTavern answers the same status with a plain-text body.',
            'The /list sort is the pinned localeCompare(); the seeded names are lower-case ASCII and differ in their first character so the order is collation-independent.',
            'World file bytes are recorded, but never sizes or mtimes, so no observation depends on the host filesystem.',
        ],
        inputs: {
            cookieSecret: COOKIE_SECRET,
            seededWorlds: SEEDED_WORLDS,
            seededDirectory: 'hotel.json',
            editCreated,
            editNumericKeys,
            editOverwrite,
            importedWorld,
            importCases: Object.fromEntries(Object.entries(importCases).map(([label, definition]) => [label, {
                fields: definition.fields ?? [],
                file: definition.file ?? null,
                body: definition.body ?? null,
            }])),
        },
        responses,
        errorPages,
        state: {
            worldsAfterEdits,
            worldsAfterImports,
            worldsAfterDeletes,
            uploadsAfterImport,
            accountRecordUnchanged,
        },
        roundTrip,
    };
    const outputFile = path.join(repositoryRoot, 'tests', 'oracle', 'sillytavern-1.19.0-worldinfo-routes.json');
    mkdirSync(path.dirname(outputFile), { recursive: true });
    writeFileSync(outputFile, `${JSON.stringify(fixture, null, 2)}\n`);
    console.log(`Wrote ${path.relative(repositoryRoot, outputFile)} from pinned world-info behavior`);
} catch (error) {
    console.error(error);
    process.exitCode = 1;
} finally {
    if (goChild && goChild.exitCode === null) goChild.kill();
    await stopServer();
    safeCleanup();
}
