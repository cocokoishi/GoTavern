#!/usr/bin/env node
// Capture pinned preset save/delete/restore behavior: the apiId -> directory
// mapping, sanitize-filename coercion, JavaScript four-space serialization, the
// restore path through the pinned content index, and a Node -> Go -> Node round
// trip for preset files.

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const PINNED_COMMIT = '06bde939fb1e9c4c8d8641d810f0a916b5bce127';
const PINNED_VERSION = '1.19.0';
// @gotavern-oracle: fixture=sillytavern-1.19.0-presets-routes.json label="preset routes"
const COOKIE_SECRET = 'gotavern-pinned-presets-cookie-secret';
const PRESET_DIRECTORIES = [
    'KoboldAI Settings', 'NovelAI Settings', 'OpenAI Settings', 'TextGen Settings',
    'instruct', 'context', 'sysprompt', 'reasoning',
];
const sourceRoot = path.resolve(process.argv[2] ?? '');
const repositoryRoot = path.resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3]) {
    console.error('usage: node tools/probe-presets-routes.mjs <pinned-source-clone> <gotavern-root>');
    process.exit(2);
}
if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim() !== PINNED_COMMIT) {
    throw new Error(`upstream checkout is not pinned at ${PINNED_COMMIT}`);
}

const runtimeRoot = mkdtempSync(path.join(os.tmpdir(), 'gotavern-presets-oracle-'));
const dataRoot = path.join(runtimeRoot, 'data');
const configPath = path.join(runtimeRoot, 'config.yaml');
const logs = [];
const goLogs = [];
let child;
let goChild;

function sha256(value) {
    return createHash('sha256').update(value).digest('hex');
}

function safeCleanup() {
    const resolved = path.resolve(runtimeRoot);
    const parent = path.resolve(os.tmpdir());
    if (path.dirname(resolved).toLowerCase() !== parent.toLowerCase()
        || !path.basename(resolved).startsWith('gotavern-presets-oracle-')) {
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

// sanitize-filename 1.6.3 throws `Input must be string` for a non-string name.
// Express renders that throw as its finalhandler error page, whose <pre> block is
// the V8 stack with host-absolute source paths and pinned line numbers, so those
// responses are recorded as a status only. Fail loudly if the response is not
// that HTML error page.
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

// Sorted per-directory snapshot of the eight preset folders: names and exact
// bytes, never sizes or mtimes.
function presetState(userRoot) {
    const state = {};
    for (const directory of PRESET_DIRECTORIES) {
        const absolute = path.join(userRoot, directory);
        state[directory] = existsSync(absolute)
            ? readdirSync(absolute).sort().map(name => ({
                name,
                content: readFileSync(path.join(absolute, name)).toString('utf8'),
            }))
            : null;
    }
    return state;
}

// The pinned /api/settings/get aggregation lists preset file names and contents
// in index-aligned arrays, so a preset written by one server can be found by name
// and read through the other server.
function presetContent(body, name) {
    const names = Array.isArray(body?.openai_setting_names) ? body.openai_setting_names : [];
    const index = names.indexOf(name);
    if (index < 0) return null;
    const contents = Array.isArray(body?.openai_settings) ? body.openai_settings : [];
    return contents[index] ?? null;
}

async function verifyRoundTrip(origin, sessionCookie, token, userRoot) {
    const nodeWrittenBody = JSON.stringify({ apiId: 'openai', name: 'Node-written', preset: { marker: 'written by pinned Node', unknown: { keep: true } } });
    const nodeWrite = await request(`${origin}/api/presets/save`, 'POST', {
        Cookie: sessionCookie, 'Content-Type': 'application/json', 'X-CSRF-Token': token,
    }, nodeWrittenBody);
    if (nodeWrite.response.status !== 200) {
        throw new Error(`pinned Node could not write the round-trip preset: ${nodeWrite.response.status}`);
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

    const goWrittenBody = JSON.stringify({ apiId: 'openai', name: 'Go-written', preset: { marker: 'written by GoTavern', unknown: { keep: 'go' } } });
    let goRead;
    let goWrite;
    try {
        goRead = await request(`${goOrigin}/api/settings/get`, 'POST', { 'Content-Type': 'application/json' }, '{}');
        goWrite = await request(`${goOrigin}/api/presets/save`, 'POST', { 'Content-Type': 'application/json' }, goWrittenBody);
    } finally {
        await stopGoServer(goOrigin);
    }
    if (goWrite.response.status !== 200 || goWrite.body?.name !== 'Go-written') {
        throw new Error(`GoTavern could not write the round-trip preset: ${goWrite.response.status} ${JSON.stringify(goWrite.body)}\n${goLogs.join('').slice(-10000)}`);
    }

    const nodeRead = await request(`${origin}/api/settings/get`, 'POST', {
        Cookie: sessionCookie, 'Content-Type': 'application/json', 'X-CSRF-Token': token,
    }, '{}');
    const goSeen = presetContent(goRead.body, 'Node-written');
    const nodeSeen = presetContent(nodeRead.body, 'Go-written');
    if (goSeen === null || nodeSeen === null) {
        throw new Error(`preset round trip failed: Go saw ${JSON.stringify(goSeen)}, Node saw ${JSON.stringify(nodeSeen)}\n${goLogs.join('').slice(-10000)}`);
    }
    return {
        verified: true,
        nodeWrittenBody,
        goWrittenBody,
        nodeWrittenPresetReadByGo: goSeen,
        goWrittenPresetReadByNode: nodeSeen,
        goWrittenPresetBytes: readFileSync(path.join(userRoot, 'OpenAI Settings', 'Go-written.json'), 'utf8'),
    };
}

try {
    mkdirSync(path.join(dataRoot, '_storage'), { recursive: true });
    writeFileSync(path.join(dataRoot, 'cookie-secret.txt'), COOKIE_SECRET);
    writeFileSync(configPath, 'enableUserAccounts: true\nskipContentCheck: true\n');
    writeFileSync(path.join(dataRoot, '_storage', sha256('user:default-user')), JSON.stringify({
        key: 'user:default-user',
        value: {
            handle: 'default-user', name: 'Presets Probe', created: 1700000000000,
            password: '', admin: true, enabled: true, salt: '',
            probeUnknownField: { preserve: true },
        },
    }));

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
    for (const directory of PRESET_DIRECTORIES) {
        const absolute = path.join(userRoot, directory);
        rmSync(absolute, { recursive: true, force: true });
        mkdirSync(absolute, { recursive: true });
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
    const post = (route, body) => request(`${origin}/api/presets/${route}`, 'POST', jsonHeaders, body);

    const responses = {};
    const errorPages = {};
    const record = (label, result) => { responses[label] = capture(result); };
    const recordErrorPage = (label, result) => { errorPages[label] = captureErrorPage(label, result); };

    const mainPreset = '{"chat_completion_source":"openai","temperature":0.75,"prompts":[{"identifier":"main","content":"preset marker"}]}';
    const bodies = {
        saveMain: `{"apiId":"openai","name":"MyPreset","preset":${mainPreset}}`,
        saveOverwrite: '{"apiId":"openai","name":"MyPreset","preset":{"marker":"overwritten","unknown":{"keep":[1,2]}}}',
        saveKobold: '{"apiId":"kobold","name":"KoboldPreset","preset":{"marker":"kobold"}}',
        saveKoboldHorde: '{"apiId":"koboldhorde","name":"HordePreset","preset":{"marker":"horde"}}',
        saveNovel: '{"apiId":"novel","name":"NovelPreset","preset":{"marker":"novel"}}',
        saveTextGen: '{"apiId":"textgenerationwebui","name":"TextGenPreset","preset":{"marker":"textgen"}}',
        saveInstruct: '{"apiId":"instruct","name":"MyInstruct","preset":{"marker":"instruct"}}',
        saveContext: '{"apiId":"context","name":"MyContext","preset":{"marker":"context"}}',
        saveSysprompt: '{"apiId":"sysprompt","name":"MySysprompt","preset":{"marker":"sysprompt"}}',
        saveReasoning: '{"apiId":"reasoning","name":"MyReasoning","preset":{"marker":"reasoning"}}',
        saveUnknownAPI: '{"apiId":"nope","name":"Unknown","preset":{"marker":"unknown"}}',
        saveMissingPreset: '{"apiId":"openai","name":"NoPreset"}',
        saveFalsyPreset: '{"apiId":"openai","name":"FalsyPreset","preset":0}',
        saveEmptyName: '{"apiId":"openai","name":"","preset":{"marker":"empty"}}',
        saveMissingName: '{"apiId":"openai","preset":{"marker":"missing"}}',
        saveNumericName: '{"apiId":"openai","name":5,"preset":{"marker":"numeric"}}',
        saveArrayName: '{"apiId":"openai","name":["a"],"preset":{"marker":"array"}}',
        saveNullName: '{"apiId":"openai","name":null,"preset":{"marker":"null"}}',
        saveNumericAPI: '{"apiId":5,"name":"NumericAPI","preset":{"marker":"numericapi"}}',
        saveReservedName: '{"apiId":"openai","name":"con","preset":{"marker":"reserved"}}',
        saveSanitizedName: '{"apiId":"openai","name":"a/b","preset":{"marker":"sanitized"}}',
        saveTrailingSpace: '{"apiId":"openai","name":"Trail  ","preset":{"marker":"trailing"}}',
        saveNumberPreset: '{"apiId":"openai","name":"NumberPreset","preset":5}',
        saveStringPreset: '{"apiId":"openai","name":"StringPreset","preset":"text"}',
        saveTruePreset: '{"apiId":"openai","name":"TruePreset","preset":true}',
        saveArrayPreset: '{"apiId":"openai","name":"ArrayPreset","preset":[1,2]}',
        saveJsNumbers: '{"apiId":"openai","name":"Numbers","preset":{"big":1e21,"exp":1e20,"negZero":-0,"small":1e-7,"unsafe":9007199254740993,"float":0.1}}',
        deleteMissingName: '{"apiId":"openai"}',
        deleteEmptyName: '{"apiId":"openai","name":""}',
        deleteUnknownAPI: '{"apiId":"nope","name":"Unknown"}',
        deleteExisting: '{"apiId":"openai","name":"MyPreset"}',
        deleteAgain: '{"apiId":"openai","name":"MyPreset"}',
        deleteSanitizedName: '{"apiId":"openai","name":"a/b"}',
        deleteReservedName: '{"apiId":"openai","name":"con"}',
        deleteInstruct: '{"apiId":"instruct","name":"MyInstruct"}',
        restoreOpenAIDefault: '{"apiId":"openai","name":"Default"}',
        restoreInstructAlpaca: '{"apiId":"instruct","name":"Alpaca"}',
        restoreInstructDefault: '{"apiId":"instruct","name":"Default"}',
        restoreWrongFolder: '{"apiId":"openai","name":"Alpaca"}',
        restoreUnknownAPI: '{"apiId":"nope","name":"Default"}',
        restoreSyspromptBlank: '{"apiId":"sysprompt","name":"Blank"}',
        restoreReasoningBlank: '{"apiId":"reasoning","name":"Blank"}',
        restoreCaseSensitive: '{"apiId":"openai","name":"default"}',
        restoreMissingName: '{"apiId":"openai"}',
        restoreNumericName: '{"apiId":"openai","name":5}',
        restoreReservedName: '{"apiId":"openai","name":"con"}',
    };

    for (const label of [
        'saveMain', 'saveOverwrite', 'saveKobold', 'saveKoboldHorde', 'saveNovel', 'saveTextGen',
        'saveInstruct', 'saveContext', 'saveSysprompt', 'saveReasoning', 'saveUnknownAPI',
        'saveMissingPreset', 'saveFalsyPreset', 'saveEmptyName', 'saveNumericAPI', 'saveReservedName',
        'saveSanitizedName', 'saveTrailingSpace', 'saveNumberPreset', 'saveStringPreset', 'saveTruePreset',
        'saveArrayPreset', 'saveJsNumbers',
    ]) {
        record(label, await post('save', bodies[label]));
    }
    for (const label of ['saveMissingName', 'saveNumericName', 'saveArrayName', 'saveNullName']) {
        recordErrorPage(label, await post('save', bodies[label]));
    }
    const stateAfterSaves = presetState(userRoot);

    for (const label of ['deleteMissingName']) {
        // sanitize-filename throws before the route's name check, so this is the
        // Express error page rather than a 404.
        recordErrorPage(label, await post('delete', bodies[label]));
    }
    for (const label of ['deleteEmptyName', 'deleteUnknownAPI', 'deleteExisting', 'deleteAgain', 'deleteSanitizedName', 'deleteReservedName', 'deleteInstruct']) {
        record(label, await post('delete', bodies[label]));
    }
    record('deleteWrongMethod', await request(`${origin}/api/presets/delete`, 'GET', { Cookie: sessionCookie }));
    const stateAfterDeletes = presetState(userRoot);

    for (const label of [
        'restoreOpenAIDefault', 'restoreInstructAlpaca', 'restoreInstructDefault', 'restoreWrongFolder',
        'restoreUnknownAPI', 'restoreSyspromptBlank', 'restoreReasoningBlank', 'restoreCaseSensitive',
        'restoreReservedName',
    ]) {
        record(label, await post('restore', bodies[label]));
    }
    record('restoreMissingName', await post('restore', bodies.restoreMissingName));
    record('restoreNumericName', await post('restore', bodies.restoreNumericName));
    record('restoreUnknownMethod', await request(`${origin}/api/presets/restore`, 'GET', { Cookie: sessionCookie }));
    // The body parser rejects a malformed body with its own 400 error page,
    // whose <pre> block is a V8 stack with host-absolute paths.
    recordErrorPage('restoreMalformedBody', await post('restore', '{'));

    const accountRecordUnchanged = accountRecordBefore.equals(readFileSync(accountRecordPath));
    const roundTrip = await verifyRoundTrip(origin, sessionCookie, token, userRoot);
    await stopServer();

    const fixture = {
        schemaVersion: 1,
        baseline: { version: PINNED_VERSION, commit: PINNED_COMMIT },
        probe: 'pinned preset save/delete/restore responses, apiId directory mapping, sanitize-filename coercion and restore content-index matching',
        normalizations: [
            'Requests are sent with Accept-Encoding: identity so the recorded framing is a property of the route rather than of the pinned compression middleware.',
            'A non-string name makes sanitize-filename throw; Express answers with finalhandler\'s HTML page, whose <pre> block is the V8 stack with host-absolute source paths and pinned line numbers. Those responses are recorded in errorPages as a status only; GoTavern answers the same status with a plain-text body.',
            'The /restore route catches the same throw and answers sendStatus(500), so those responses are recorded in full.',
            'Preset file bytes are recorded, but never sizes or mtimes, so no observation depends on the host filesystem.',
        ],
        inputs: {
            cookieSecret: COOKIE_SECRET,
            presetDirectories: PRESET_DIRECTORIES,
            bodies,
        },
        responses,
        errorPages,
        state: { stateAfterSaves, stateAfterDeletes, accountRecordUnchanged },
        roundTrip,
    };
    const outputFile = path.join(repositoryRoot, 'tests', 'oracle', 'sillytavern-1.19.0-presets-routes.json');
    mkdirSync(path.dirname(outputFile), { recursive: true });
    writeFileSync(outputFile, `${JSON.stringify(fixture, null, 2)}\n`);
    console.log(`Wrote ${path.relative(repositoryRoot, outputFile)} from pinned preset behavior`);
} catch (error) {
    console.error(error);
    process.exitCode = 1;
} finally {
    if (goChild && goChild.exitCode === null) goChild.kill();
    await stopServer();
    safeCleanup();
}
