#!/usr/bin/env node
// @gotavern-oracle: fixture=sillytavern-1.19.0-anthropic-caption.json label="anthropic caption"
//
// Probe `POST /api/anthropic/caption-image` (src/endpoints/anthropic.js:8, the whole file is 66 lines).
//
// THE ROUTE IS SMALL AND ALMOST EVERY LINE IS A BRANCH that a happy path cannot reach, so the scenarios
// below are chosen for what they DISCRIMINATE rather than for coverage-by-count:
//
//   - `content[0].text` is read with NO guard. A response whose `content` is absent or empty makes that
//     property access THROW, and the catch answers 500 `Internal server error`. That is a DIFFERENT
//     branch from `No caption found` (the `if (!caption)` below it), which is why both are recorded and
//     asserted to differ.
//   - `!caption` is JavaScript truthiness. `''`, `0`, `false` and `null` all take `No caption found`,
//     and a Go implementation testing `caption == ""` (or nil) fails exactly one of them.
//   - the data URI is split twice with no guard: `image.split(';')[0].split(':')[1]` and
//     `image.split(',')[1]`. A URI MISSING the comma (or the colon) leaves that member `undefined`, and
//     `JSON.stringify` OMITS an undefined member -- so the omission itself is the observable, and a
//     fixture that only checked the resulting caption would not see it.
//   - `${baseUrl}/messages` is STRING CONCATENATION, not a url join, so a `reverse_proxy` with a
//     trailing slash produces a DOUBLE SLASH in the path. Both are recorded.
//   - the key is `request.body.reverse_proxy ? request.body.proxy_password : readSecret(..CLAUDE)`.
//
// TWO RECORDING MODES, and the difference is deliberate rather than cosmetic:
//
//   * `stub` -- the pinned server's `node-fetch` is replaced by the controlled peer from
//     tools/lib/pinned-outbound.mjs, which records the header object the ROUTE passed and answers from a
//     rule list. This is the convention every other provider fixture uses, and the Go side's WIRE headers
//     are reconstructed from `nodeFetchWireDefaults` plus these values.
//   * `wire` -- for the one question the stub CANNOT answer. When `reverse_proxy` is set and
//     `proxy_password` is ABSENT, the pinned handler passes `undefined` as a header value. The stub records
//     `String(undefined)`, which is the route's raw object and NOT what a peer receives; node-fetch's own
//     normalisation happens inside the module the stub replaces. So that scenario runs on a SECOND pinned
//     boot with NO hook, pointed at a real local HTTP listener that records the headers it actually
//     receives. Nothing is reasoned about: the value in the fixture is the value on the wire.
//
// A REAL CLOSED PORT, not a simulated rejection. The stub's `throws` rule rejects the promise BEFORE any
// connection exists, which reaches the same catch but proves nothing about a transport failure. The
// `transport.closedPort` scenario therefore runs on the UNHOOKED boot as well, with `reverse_proxy`
// pointing at a port the probe bound and then closed, so the pinned server's node-fetch really connects
// and is refused. Both rejections are recorded because they answer differently from a non-2xx RESPONSE --
// the route's `!result.ok` branch answers `{error:true}`, while a rejection answers `Internal server
// error` -- and an implementation that treated a transport failure as a non-ok response would pass the
// stub scenario and fail this one.
//
// NOT CLAIMED HERE, stated rather than left implicit: the route sets no timeout, so a peer that accepts
// the connection and never answers is not probed; the pinned `console.debug`/`console.warn` lines are not
// an HTTP observable and are not recorded.
//
// Usage: node tools/probe-anthropic-caption.mjs <pinned-source-clone> <gotavern-root>

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import {
    PINNED_COMMIT, PINNED_VERSION, captureHttp, choosePort, rawRequest, safeCleanup, sha256,
    startPinnedProviderServer, writeFixture,
} from './lib/pinned-outbound.mjs';

const sourceRoot = path.resolve(process.argv[2] ?? '');
const repositoryRoot = path.resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3]) {
    console.error('usage: node tools/probe-anthropic-caption.mjs <pinned-source-clone> <gotavern-root>');
    process.exit(2);
}
if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim() !== PINNED_COMMIT) {
    throw new Error(`upstream checkout is not pinned at ${PINNED_COMMIT}`);
}

const ROUTE = '/api/anthropic/caption-image';
const SAFE_ORIGIN = 'http://127.0.0.1:8765';
const COOKIE_SECRET = 'gotavern-pinned-anthropic-caption-cookie-secret';
const ACCOUNT = { handle: 'default-user', name: 'Anthropic Caption Probe', admin: true, password: '' };
const SEAM_DEFAULTS = { GOTAVERN_ANTHROPIC_CAPTION_BASE_URL: 'https://api.anthropic.com/v1' };
const CLAUDE_KEY = 'api_key_claude';
const CLAUDE_SECRET = 'synthetic-claude-key';
const CAPTION = 'a synthetic anthropic caption';

// The image is a real data URI shape: the route splits it twice, and both halves are observable in the
// outbound body as `media_type` and `data`.
const IMAGE = 'data:image/png;base64,' + Buffer.from('gotavern-synthetic-anthropic-image', 'utf8').toString('base64');

// Markers, never real hosts/ports: a recorded port would be host-derived (rule 18). The probe substitutes
// the live origin before sending and writes the marker into the fixture; the Go replay does the same
// substitution in the other direction.
const WIRE_MARKER = '<wire>';
const WIRE_HOST_MARKER = '<wire-host>';
const CLOSED_MARKER = '<closed>';

const CAPTION_ANSWER = { content: [{ type: 'text', text: CAPTION }] };

function secretValues(values) {
    const secrets = {};
    for (const [key, value] of Object.entries(values)) {
        secrets[key] = [{ id: `probe-id-${key}`, value, label: key, active: true }];
    }
    return secrets;
}

// A rule list is one mock per expected request, each bounded with `times: 1` so it cannot answer a later
// request of the same run (rule 20).
const jsonAnswer = (match, payload, status = 200) => ({
    match, times: 1, status, statusText: 'OK', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
});

const scenarios = [];
// `expectedOutbound` is the count asserted against BOTH sides: the probe refuses to write the fixture if
// the pinned route made a different number of requests than the branch implies.
const addScenario = definition => scenarios.push(definition);

// ── the happy path, and the two non-2xx shapes ──────────────────────────────────────────────────────
addScenario({
    label: 'success',
    note: 'the only scenario that reads a caption; pins the outbound URL, header set, body member order and the 200 body',
    body: { model: 'claude-3-haiku-20240307', prompt: 'describe this image', image: IMAGE },
    secrets: { [CLAUDE_KEY]: CLAUDE_SECRET },
    mocks: [jsonAnswer('api.anthropic.com', CAPTION_ANSWER)],
    expectedOutbound: 1,
    expect: { status: 200 },
});
addScenario({
    label: 'upstream.jsonError',
    note: 'a non-2xx upstream with a JSON body: the pinned code forwards the STATUS and answers {error:true}, NOT the provider body',
    body: { model: 'm', prompt: 'describe this image', image: IMAGE },
    secrets: { [CLAUDE_KEY]: CLAUDE_SECRET },
    mocks: [{ match: 'api.anthropic.com', times: 1, status: 429, statusText: 'Too Many Requests', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'error', error: { type: 'rate_limit_error' } }) }],
    expectedOutbound: 1,
    expect: { status: 429 },
});
addScenario({
    label: 'upstream.textError',
    note: 'the same branch with a TEXT body: the provider body is still discarded, so the body type cannot select a different answer',
    body: { model: 'm', prompt: 'describe this image', image: IMAGE },
    secrets: { [CLAUDE_KEY]: CLAUDE_SECRET },
    mocks: [{ match: 'api.anthropic.com', times: 1, status: 400, statusText: 'Bad Request', headers: { 'content-type': 'text/plain' }, body: 'provider said no' }],
    expectedOutbound: 1,
    expect: { status: 400 },
});

// ── `content[0].text`: a throw (catch) versus a falsy caption (its own branch) ──────────────────────
addScenario({
    label: 'ok.contentAbsent',
    note: 'no content member: content[0].text throws inside the try, so the CATCH answers 500 Internal server error -- not No caption found',
    body: { model: 'm', prompt: 'p', image: IMAGE },
    secrets: { [CLAUDE_KEY]: CLAUDE_SECRET },
    mocks: [jsonAnswer('api.anthropic.com', { id: 'msg_1', type: 'message' })],
    expectedOutbound: 1,
    expect: { status: 500, bodyText: 'Internal server error' },
});
addScenario({
    label: 'ok.contentEmptyArray',
    note: 'an EMPTY content array: content[0] is undefined, so the property access throws the same way',
    body: { model: 'm', prompt: 'p', image: IMAGE },
    secrets: { [CLAUDE_KEY]: CLAUDE_SECRET },
    mocks: [jsonAnswer('api.anthropic.com', { content: [] })],
    expectedOutbound: 1,
    expect: { status: 500, bodyText: 'Internal server error' },
});
addScenario({
    label: 'ok.notJson',
    note: 'a 2xx whose body is not JSON: `result.json()` throws inside the try, so the CATCH answers -- NOT No caption found, which is what a reader that treated a parse failure as an empty caption would answer',
    body: { model: 'm', prompt: 'p', image: IMAGE },
    secrets: { [CLAUDE_KEY]: CLAUDE_SECRET },
    mocks: [{ match: 'api.anthropic.com', times: 1, status: 200, statusText: 'OK', headers: { 'content-type': 'text/plain' }, body: 'not json at all' }],
    expectedOutbound: 1,
    expect: { status: 500, bodyText: 'Internal server error' },
});
addScenario({
    label: 'ok.arrayBody',
    note: 'a 2xx whose body is a JSON ARRAY: `[].content` is undefined, so content[0].text throws and the catch answers',
    body: { model: 'm', prompt: 'p', image: IMAGE },
    secrets: { [CLAUDE_KEY]: CLAUDE_SECRET },
    mocks: [jsonAnswer('api.anthropic.com', [])],
    expectedOutbound: 1,
    expect: { status: 500, bodyText: 'Internal server error' },
});
// `content[0]` is JAVASCRIPT INDEXING, and the three shapes below are the ones a Go implementation that
// guarded on "is it a non-empty array" answers DIFFERENTLY from the pinned expression. Each is one request,
// and each direction of the difference is a distinct response.
addScenario({
    label: 'ok.contentNumericKey',
    note: 'content as an OBJECT with the member "0": a numeric index is the property "0", so content[0] is that object and the caption is returned',
    body: { model: 'm', prompt: 'p', image: IMAGE },
    secrets: { [CLAUDE_KEY]: CLAUDE_SECRET },
    mocks: [jsonAnswer('api.anthropic.com', { content: { 0: { type: 'text', text: 'a numeric key caption' } } })],
    expectedOutbound: 1,
    expect: { status: 200, bodyText: JSON.stringify({ caption: 'a numeric key caption' }) },
});
addScenario({
    label: 'ok.contentString',
    note: 'content as a STRING: "ab"[0] is "a" (strings are indexable) and "a".text is undefined, so this takes No caption found rather than the catch',
    body: { model: 'm', prompt: 'p', image: IMAGE },
    secrets: { [CLAUDE_KEY]: CLAUDE_SECRET },
    mocks: [jsonAnswer('api.anthropic.com', { content: 'ab' })],
    expectedOutbound: 1,
    expect: { status: 500, bodyText: 'No caption found' },
});
addScenario({
    label: 'ok.firstScalar',
    note: 'content[0] as a NUMBER: property access on a number is allowed and yields undefined, so this is No caption found and NOT a throw',
    body: { model: 'm', prompt: 'p', image: IMAGE },
    secrets: { [CLAUDE_KEY]: CLAUDE_SECRET },
    mocks: [jsonAnswer('api.anthropic.com', { content: [5] })],
    expectedOutbound: 1,
    expect: { status: 500, bodyText: 'No caption found' },
});
addScenario({
    label: 'ok.textNumber',
    note: 'a truthy NON-STRING text: `res.json({ caption })` forwards the VALUE, so the body is {"caption":42} and not {"caption":"42"}',
    body: { model: 'm', prompt: 'p', image: IMAGE },
    secrets: { [CLAUDE_KEY]: CLAUDE_SECRET },
    mocks: [jsonAnswer('api.anthropic.com', { content: [{ type: 'text', text: 42 }] })],
    expectedOutbound: 1,
    expect: { status: 200, bodyText: '{"caption":42}' },
});
for (const [label, value, why] of [
    ['ok.textEmptyString', '', 'an empty string is falsy'],
    ['ok.textZero', 0, 'the number 0 is falsy'],
    ['ok.textFalse', false, 'false is falsy'],
    ['ok.textNull', null, 'null is falsy'],
]) {
    addScenario({
        label,
        note: `${why}: \`if (!caption)\` takes the No caption found branch, which is a DIFFERENT branch from the catch above`,
        body: { model: 'm', prompt: 'p', image: IMAGE },
        secrets: { [CLAUDE_KEY]: CLAUDE_SECRET },
        mocks: [jsonAnswer('api.anthropic.com', { content: [{ type: 'text', text: value }] })],
        expectedOutbound: 1,
        expect: { status: 500, bodyText: 'No caption found' },
    });
}

// ── the double split, where an undefined member is OMITTED by JSON.stringify ────────────────────────
addScenario({
    label: 'image.noComma',
    note: 'no comma in the data URI: base64Data is undefined, so JSON.stringify OMITS `data` from source while media_type survives',
    body: { model: 'm', prompt: 'p', image: 'data:image/png;base64' },
    secrets: { [CLAUDE_KEY]: CLAUDE_SECRET },
    mocks: [jsonAnswer('api.anthropic.com', CAPTION_ANSWER)],
    expectedOutbound: 1,
    expect: { status: 200 },
});
addScenario({
    label: 'image.noColon',
    note: 'no colon in the data URI: mimeType is undefined, so JSON.stringify OMITS `media_type` while data survives',
    body: { model: 'm', prompt: 'p', image: 'image/png;base64,AAAA' },
    secrets: { [CLAUDE_KEY]: CLAUDE_SECRET },
    mocks: [jsonAnswer('api.anthropic.com', CAPTION_ANSWER)],
    expectedOutbound: 1,
    expect: { status: 200 },
});
addScenario({
    label: 'image.absent',
    note: 'no image member: `.split` on undefined throws before any request, so the catch answers with ZERO outbound requests',
    body: { model: 'm', prompt: 'p' },
    secrets: { [CLAUDE_KEY]: CLAUDE_SECRET },
    mocks: [],
    expectedOutbound: 0,
    expect: { status: 500, bodyText: 'Internal server error' },
});
addScenario({
    label: 'prompt.absent',
    note: 'no prompt member: `text: undefined` is omitted, so the text part is {"type":"text"} and the member is ABSENT',
    body: { model: 'm', image: IMAGE },
    secrets: { [CLAUDE_KEY]: CLAUDE_SECRET },
    mocks: [jsonAnswer('api.anthropic.com', CAPTION_ANSWER)],
    expectedOutbound: 1,
    expect: { status: 200 },
});
addScenario({
    label: 'model.absent',
    note: 'no model member: `model: undefined` is omitted from the outbound body',
    body: { prompt: 'p', image: IMAGE },
    secrets: { [CLAUDE_KEY]: CLAUDE_SECRET },
    mocks: [jsonAnswer('api.anthropic.com', CAPTION_ANSWER)],
    expectedOutbound: 1,
    expect: { status: 200 },
});
addScenario({
    label: 'secret.absent',
    note: 'no api_key_claude: the key is read anyway, so the outbound header carries the EMPTY value rather than the header being dropped',
    body: { model: 'm', prompt: 'p', image: IMAGE },
    secrets: {},
    mocks: [jsonAnswer('api.anthropic.com', CAPTION_ANSWER)],
    expectedOutbound: 1,
    expect: { status: 200 },
});

// ── reverse_proxy: string concatenation, and the proxy password REPLACING the stored key ────────────
addScenario({
    label: 'proxy.noTrailingSlash',
    note: 'reverse_proxy without a trailing slash: `${baseUrl}/messages` yields a single slash, and x-api-key becomes the PROXY PASSWORD',
    body: { model: 'm', prompt: 'p', image: IMAGE, reverse_proxy: 'https://proxy.example.test/v1', proxy_password: 'synthetic-proxy-password' },
    secrets: { [CLAUDE_KEY]: CLAUDE_SECRET },
    mocks: [jsonAnswer('proxy.example.test', CAPTION_ANSWER)],
    expectedOutbound: 1,
    expect: { status: 200 },
});
addScenario({
    label: 'proxy.trailingSlash',
    note: 'reverse_proxy WITH a trailing slash: no url join happens, so the path carries a DOUBLE SLASH (/v1//messages)',
    body: { model: 'm', prompt: 'p', image: IMAGE, reverse_proxy: 'https://proxy.example.test/v1/', proxy_password: 'synthetic-proxy-password' },
    secrets: { [CLAUDE_KEY]: CLAUDE_SECRET },
    mocks: [jsonAnswer('proxy.example.test', CAPTION_ANSWER)],
    expectedOutbound: 1,
    expect: { status: 200 },
});

// ── the transport-failure branch, reached by a SIMULATED rejection (the wire/closed-port cases below
//    reach the same branch through the real transport) ──────────────────────────────────────────────
addScenario({
    label: 'transport.stubRejects',
    note: 'the stub rejects the fetch: the catch answers 500 Internal server error, which is DIFFERENT from the {error:true} a non-ok RESPONSE produces',
    body: { model: 'm', prompt: 'p', image: IMAGE, reverse_proxy: 'https://reject.example.test/v1', proxy_password: 'synthetic-proxy-password' },
    secrets: { [CLAUDE_KEY]: CLAUDE_SECRET },
    mocks: [{ match: 'reject.example.test', times: 1, throws: true }],
    expectedOutbound: 1,
    expect: { status: 500, bodyText: 'Internal server error' },
});

// ── a body the pinned express json middleware rejects before the handler runs ───────────────────────
addScenario({
    label: 'body.malformedJson',
    note: 'malformed JSON never reaches the handler, so this pins what the server (not the route) answers, with ZERO outbound requests',
    rawBody: '{"image":',
    secrets: { [CLAUDE_KEY]: CLAUDE_SECRET },
    mocks: [],
    expectedOutbound: 0,
});

// ── BOOT 1: the stub-mode scenarios ─────────────────────────────────────────────────────────────────
const server = await startPinnedProviderServer({ sourceRoot, prefix: 'gotavern-anthropic-caption-oracle-', mocks: [] });
const recorded = {};
try {
    if (server.bootOutbound.length !== 0) {
        throw new Error(`the pinned boot itself made ${server.bootOutbound.length} outbound request(s); the recording would not be a property of the route`);
    }
    for (const scenario of scenarios) {
        const rules = (scenario.mocks ?? []).map(rule => ({
            run: scenario.label,
            match: rule.match,
            ...(rule.throws === true ? { throws: true } : {}),
            status: rule.status ?? 200,
            statusText: rule.statusText ?? 'OK',
            headers: rule.headers ?? { 'content-type': 'application/json' },
            body: rule.body ?? '',
            ...(rule.times === undefined ? {} : { times: rule.times }),
        }));
        server.writeSecrets(secretValues(scenario.secrets ?? {}));
        server.setMocks(rules);
        let result;
        try {
            result = await server.post(ROUTE, scenario.rawBody ?? JSON.stringify(scenario.body));
        } catch (error) {
            console.error(`SCENARIO FAILED: ${scenario.label}`);
            console.error(`  mocks served: ${JSON.stringify(rules)}`);
            console.error(`  outbound captured: ${JSON.stringify(server.outbound())}`);
            throw error;
        }
        const outbound = server.outbound();
        if (outbound.length !== scenario.expectedOutbound) {
            throw new Error(`${scenario.label}: the pinned route made ${outbound.length} outbound request(s), this branch implies ${scenario.expectedOutbound}; recorded ${JSON.stringify(outbound.map(entry => entry.url))}`);
        }
        if (rules.length !== scenario.expectedOutbound) {
            throw new Error(`${scenario.label}: ${rules.length} mock rule(s) for ${scenario.expectedOutbound} expected request(s)`);
        }
        recorded[scenario.label] = {
            route: ROUTE,
            note: scenario.note,
            requestBody: scenario.rawBody ?? JSON.stringify(scenario.body),
            mocks: rules,
            secrets: scenario.secrets ?? {},
            response: captureHttp(result),
            outboundRecording: 'stub',
            // A REJECTED fetch never reaches a peer, so the only trace it leaves on this boot is the stub's
            // pre-throw record. The flag says so, and the Go replay reaches the same catch through a real
            // closed port (the stub cannot answer "what happens when no one is listening").
            transportFailure: (scenario.mocks ?? []).some(rule => rule.throws === true),
            outboundCount: outbound.length,
            outbound: outbound.map(entry => ({
                url: entry.url,
                method: entry.method,
                headers: entry.headers ?? {},
                body: entry.body ?? '',
            })),
        };
    }
} catch (error) {
    console.error('PROBE FAILED; pinned server log tail:');
    console.error(server.logs.join('').slice(-4000));
    throw error;
} finally {
    await server.stop();
}

// ── BOOT 2: the UNHOOKED pinned server, a real local listener, and a real closed port ───────────────
// The pinned server is booted exactly the way the helper boots it (same flags, same data root shape) but
// WITHOUT the node-fetch hook, so `reverse_proxy` reaches a real socket. Nothing here can touch the live
// network: both destinations are 127.0.0.1.
const UNHOOKED_CONFIG = [
    'enableUserAccounts: true',
    'skipContentCheck: true',
    'extensions:',
    '  enabled: false',
    'autoConnect: false',
    '',
].join('\n');

function startWireListener() {
    const state = { requests: [] };
    const listener = http.createServer((request, response) => {
        const chunks = [];
        request.on('data', chunk => chunks.push(chunk));
        request.on('end', () => {
            const body = Buffer.concat(chunks);
            state.requests.push({
                method: request.method,
                target: String(request.url),
                headers: { ...request.headers },
                body: body.toString('utf8'),
            });
            response.writeHead(200, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify(CAPTION_ANSWER));
        });
    });
    return new Promise((resolve, reject) => {
        listener.once('error', reject);
        listener.listen(0, '127.0.0.1', () => {
            const { port } = listener.address();
            resolve({
                origin: `http://127.0.0.1:${port}`,
                host: `127.0.0.1:${port}`,
                state,
                close: () => new Promise(done => listener.close(() => done())),
            });
        });
    });
}

// wireRule is the answer the REAL listener gave, written down as a rule so a wire scenario's fixture
// describes its own peer instead of leaving the response implicit. A wire recording has no stub, so without
// this a replay would have to invent the upstream answer it must serve.
function wireRule(target) {
    return [{
        run: 'wire',
        match: String(target),
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(CAPTION_ANSWER),
        times: 1,
    }];
}

function setCookieHeader(response) {    const values = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
    return values.map(value => String(value).split(';')[0]).join('; ');
}

async function startUnhookedPinnedServer({ prefix }) {
    const runtimeRoot = mkdtempSync(path.join(os.tmpdir(), prefix));
    const dataRoot = path.join(runtimeRoot, 'data');
    const configPath = path.join(runtimeRoot, 'config.yaml');
    mkdirSync(path.join(dataRoot, '_storage'), { recursive: true });
    writeFileSync(path.join(dataRoot, 'cookie-secret.txt'), COOKIE_SECRET);
    writeFileSync(path.join(dataRoot, '_storage', sha256('user:default-user')), JSON.stringify({
        key: 'user:default-user',
        value: { handle: ACCOUNT.handle, name: ACCOUNT.name, created: 1700000000000, password: ACCOUNT.password, admin: true, enabled: true, salt: '' },
    }));
    writeFileSync(configPath, UNHOOKED_CONFIG);
    const port = await choosePort();
    const origin = `http://127.0.0.1:${port}`;
    const logs = [];
    const child = spawn(process.execPath, [
        'server.js', '--configPath', configPath, '--dataRoot', dataRoot,
        '--listenAddressIPv4', '127.0.0.1', '--enableIPv4', 'true', '--enableIPv6', 'false',
        '--listen', 'false', '--port', String(port), '--browserLaunchEnabled', 'false', '--heartbeatInterval', '0',
    ], { cwd: sourceRoot, env: { ...process.env, NODE_ENV: 'test' }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => logs.push(chunk));
    child.stderr.on('data', chunk => logs.push(chunk));
    const stop = async () => {
        if (child.exitCode === null) {
            child.kill('SIGINT');
            await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 5000))]);
            if (child.exitCode === null) child.kill();
        }
        safeCleanup(runtimeRoot, prefix);
    };
    try {
        const deadline = Date.now() + 240000;
        let ready = false;
        let lastError = 'none';
        while (Date.now() < deadline && !ready) {
            if (child.exitCode !== null) throw new Error(`unhooked pinned server exited before readiness:\n${logs.join('').slice(-8000)}`);
            try {
                const result = await rawRequest(`${origin}/login?noauto=1`);
                ready = result.response.status === 200 && Boolean(result.response.headers.get('content-type')?.includes('text/html'));
                if (!ready) lastError = `login returned ${result.response.status}`;
            } catch (error) {
                lastError = error?.message ?? String(error);
            }
            if (!ready) await new Promise(resolve => setTimeout(resolve, 300));
        }
        if (!ready) throw new Error(`unhooked pinned server did not become ready: ${lastError}\n${logs.join('').slice(-8000)}`);
        const csrf = await rawRequest(`${origin}/csrf-token`);
        const token = csrf.body.token;
        const csrfCookie = setCookieHeader(csrf.response);
        const login = await rawRequest(`${origin}/api/users/login`, 'POST', {
            Cookie: csrfCookie, 'Content-Type': 'application/json', 'X-CSRF-Token': token,
        }, JSON.stringify({ handle: ACCOUNT.handle, password: ACCOUNT.password }));
        if (login.response.status !== 200) {
            throw new Error(`could not login to the unhooked pinned server: ${login.response.status} ${JSON.stringify(login.body)}\n${logs.join('').slice(-8000)}`);
        }
        const sessionCookie = setCookieHeader(login.response);
        const headers = { Cookie: sessionCookie, 'Content-Type': 'application/json', 'X-CSRF-Token': token };
        return {
            post: (route, body) => rawRequest(`${origin}${route}`, 'POST', headers, body),
            writeSecrets: values => {
                const userRoot = path.join(dataRoot, ACCOUNT.handle);
                mkdirSync(userRoot, { recursive: true });
                writeFileSync(path.join(userRoot, 'secrets.json'), JSON.stringify(secretValues(values), null, 4));
            },
            stop,
            logs,
        };
    } catch (error) {
        await stop();
        throw error;
    }
}

const wire = await startWireListener();
const wireServer = await startUnhookedPinnedServer({ prefix: 'gotavern-anthropic-caption-wire-' });
try {
    wireServer.writeSecrets({ [CLAUDE_KEY]: CLAUDE_SECRET });

    // (a) reverse_proxy SET with proxy_password ABSENT. The stub records String(undefined) for this, which
    // is the route's raw object; what a PEER receives is node-fetch's business, so it is measured here.
    const noPasswordBody = { model: 'm', prompt: 'p', image: IMAGE, reverse_proxy: `${WIRE_MARKER}/v1` };
    const noPasswordText = JSON.stringify(noPasswordBody);
    const noPasswordResult = await wireServer.post(ROUTE, noPasswordText.split(WIRE_MARKER).join(wire.origin));
    const noPasswordRequests = wire.state.requests.splice(0);
    if (noPasswordRequests.length !== 1) {
        throw new Error(`wire.noProxyPassword: the pinned server made ${noPasswordRequests.length} requests to the listener, expected 1`);
    }
    const wireHeaders = noPasswordRequests[0].headers;
    if (!Object.hasOwn(wireHeaders, 'anthropic-version') || !Object.hasOwn(wireHeaders, 'content-type')) {
        throw new Error(`wire.noProxyPassword: the listener did not receive the route's own headers: ${JSON.stringify(wireHeaders)}`);
    }
    if (wireHeaders['x-api-key'] === CLAUDE_SECRET) {
        throw new Error('wire.noProxyPassword: the stored CLAUDE key was sent even though reverse_proxy is set, so the key selection is not pinned by this scenario');
    }
    recorded['wire.noProxyPassword'] = {
        route: ROUTE,
        note: 'reverse_proxy SET and proxy_password ABSENT, on an UNHOOKED pinned boot pointed at a real listener: the x-api-key value recorded here is what a peer RECEIVES, not the route\'s raw object',
        requestBody: noPasswordText,
        // The answer the LISTENER gave, recorded as a rule so the fixture describes its own peer: a wire
        // scenario has no stub, and a fixture that left the answer implicit would make the Go replay invent
        // one. The rule is re-anchored on the recorded target by the test, which is the part the route builds.
        mocks: wireRule(noPasswordRequests[0].target),
        secrets: { [CLAUDE_KEY]: CLAUDE_SECRET },
        response: captureHttp(noPasswordResult),
        outboundRecording: 'wire',
        outboundCount: 1,
        outbound: [{
            url: `${WIRE_MARKER}/v1/messages`,
            method: noPasswordRequests[0].method,
            headers: wireHeaders,
            body: noPasswordRequests[0].body,
            target: noPasswordRequests[0].target,
        }],
        wireHeadersShape: { host: WIRE_HOST_MARKER },
    };

    // (b) the happy path over the REAL wire, so the node-fetch defaults recorded in the fixture are measured
    // rather than copied from another route's fixture.
    const wireBody = { model: 'claude-3-haiku-20240307', prompt: 'describe this image', image: IMAGE, reverse_proxy: `${WIRE_MARKER}/v1` };
    const wireText = JSON.stringify(wireBody);
    const wireResult = await wireServer.post(ROUTE, wireText.split(WIRE_MARKER).join(wire.origin));
    const wireRequests = wire.state.requests.splice(0);
    if (wireRequests.length !== 1) {
        throw new Error(`wire.success: the pinned server made ${wireRequests.length} requests to the listener, expected 1`);
    }
    recorded['wire.success'] = {
        route: ROUTE,
        note: 'the happy path over a REAL socket, with the wire headers recorded verbatim (defaults included)',
        requestBody: wireText,
        mocks: wireRule(wireRequests[0].target),
        secrets: { [CLAUDE_KEY]: CLAUDE_SECRET },
        response: captureHttp(wireResult),
        outboundRecording: 'wire',
        outboundCount: 1,
        outbound: [{
            url: `${WIRE_MARKER}/v1/messages`,
            method: wireRequests[0].method,
            headers: wireRequests[0].headers,
            body: wireRequests[0].body,
            target: wireRequests[0].target,
        }],
        wireHeadersShape: { host: WIRE_HOST_MARKER },
    };

    // (c) a REAL closed port: the probe binds a port, closes it, points reverse_proxy at it, and the pinned
    // server's node-fetch genuinely connects and is refused.
    const closedOrigin = `http://127.0.0.1:${await choosePort()}`;
    const closedProbe = await rawRequest(`${closedOrigin}/v1/messages`, 'POST', { 'Content-Type': 'application/json' }, '{}').then(
        () => 'answered',
        error => String(error?.cause?.code ?? error?.code ?? error?.message ?? error),
    );
    if (closedProbe === 'answered') {
        throw new Error(`transport.closedPort: ${closedOrigin} answered, so the port is not closed and the scenario would prove nothing`);
    }
    const closedBody = { model: 'm', prompt: 'p', image: IMAGE, reverse_proxy: `${CLOSED_MARKER}/v1` };
    const closedText = JSON.stringify(closedBody);
    const closedResult = await wireServer.post(ROUTE, closedText.split(CLOSED_MARKER).join(closedOrigin));
    recorded['transport.closedPort'] = {
        route: ROUTE,
        note: 'reverse_proxy points at a genuinely CLOSED loopback port on the UNHOOKED boot, so the rejection is a real ECONNREFUSED rather than the stub\'s simulated throw; no stub exists on this boot, so nothing records the attempt',
        requestBody: closedText,
        mocks: [],
        secrets: { [CLAUDE_KEY]: CLAUDE_SECRET },
        response: captureHttp(closedResult),
        outboundRecording: 'none',
        outboundCount: 0,
        outbound: [],
        closedPortRefusal: closedProbe,
    };
    if (wire.state.requests.length !== 0) {
        throw new Error(`transport.closedPort sent ${wire.state.requests.length} request(s) to the listener`);
    }
} catch (error) {
    console.error('WIRE PROBE FAILED; unhooked pinned server log tail:');
    console.error(wireServer.logs.join('').slice(-4000));
    throw error;
} finally {
    await wireServer.stop();
    await wire.close();
}

// ── ASSERTIONS: the fixture must be able to fail before it is written ───────────────────────────────
// Every claim below is a BRANCH the fixtures distinguished, checked against the recorded answer rather than
// against the source, so a probe that recorded the wrong request is caught here instead of in the Go test.
const expect = (label, predicate, message) => {
    if (!predicate) {
        throw new Error(`${label}: ${message} (recorded ${JSON.stringify(recorded[label]?.response?.bodyText)} / status ${recorded[label]?.response?.status})`);
    }
};
const outboundJSON = label => {
    const entry = recorded[label].outbound[0];
    if (!entry) throw new Error(`${label}: no outbound request recorded`);
    return JSON.parse(entry.body);
};

expect('success', recorded['success'].response.status === 200, 'the happy path answers 200');
expect('success', recorded['success'].response.bodyText === JSON.stringify({ caption: CAPTION }), 'the caption is returned verbatim');
for (const label of ['upstream.jsonError', 'upstream.textError']) {
    expect(label, recorded[label].response.bodyText === '{"error":true}', 'a non-2xx upstream is flattened to {error:true}, whatever the upstream body type');
    expect(label, String(recorded[label].response.headers['content-type'] ?? '').includes('application/json'), 'and that body is JSON');
}
expect('upstream.jsonError', recorded['upstream.jsonError'].response.status === 429, 'the upstream STATUS is forwarded');
expect('upstream.textError', recorded['upstream.textError'].response.status === 400, 'the forwarded status is not always 500');
for (const label of ['ok.contentAbsent', 'ok.contentEmptyArray', 'ok.notJson', 'ok.arrayBody']) {
    expect(label, recorded[label].response.bodyText === 'Internal server error', 'a throwing content access takes the CATCH branch');
}
expect('ok.contentNumericKey', recorded['ok.contentNumericKey'].response.status === 200,
    'an object content answers element "0", because a numeric index on an object is that property');
for (const label of ['ok.contentString', 'ok.firstScalar']) {
    expect(label, recorded[label].response.bodyText === 'No caption found',
        'property access that yields undefined (not a throw) takes the falsy branch, which is a DIFFERENT branch from the catch');
}
expect('ok.textNumber', recorded['ok.textNumber'].response.bodyText === '{"caption":42}',
    'a truthy non-string caption is forwarded as a VALUE, so String(caption) would fail here');
for (const label of ['ok.textEmptyString', 'ok.textZero', 'ok.textFalse', 'ok.textNull']) {
    expect(label, recorded[label].response.bodyText === 'No caption found', 'a falsy caption takes its OWN branch, which must differ from the catch');
}
expect('ok.contentAbsent', recorded['ok.contentAbsent'].response.bodyText !== recorded['ok.textEmptyString'].response.bodyText,
    'the catch branch and the no-caption branch are DIFFERENT, which is the whole reason both are recorded');
const noComma = outboundJSON('image.noComma').messages[0].content[0].source;
expect('image.noComma', noComma.media_type === 'image/png' && !Object.hasOwn(noComma, 'data'),
    'a data URI without a comma OMITS `data` from the outbound source');
const noColon = outboundJSON('image.noColon').messages[0].content[0].source;
expect('image.noColon', noColon.data === 'AAAA' && !Object.hasOwn(noColon, 'media_type'),
    'a data URI without a colon OMITS `media_type` from the outbound source');
const noPrompt = outboundJSON('prompt.absent').messages[0].content[1];
expect('prompt.absent', !Object.hasOwn(noPrompt, 'text') && noPrompt.type === 'text',
    'an absent prompt leaves the text member ABSENT rather than carrying "undefined"');
expect('model.absent', !Object.hasOwn(outboundJSON('model.absent'), 'model'), 'an absent model is omitted from the outbound body');
expect('secret.absent', recorded['secret.absent'].outbound[0].headers['x-api-key'] === '',
    'an absent secret sends an EMPTY x-api-key rather than dropping the header');
expect('proxy.noTrailingSlash', recorded['proxy.noTrailingSlash'].outbound[0].url === 'https://proxy.example.test/v1/messages',
    'the URL is string concatenation');
expect('proxy.trailingSlash', recorded['proxy.trailingSlash'].outbound[0].url === 'https://proxy.example.test/v1//messages',
    'a trailing slash produces a DOUBLE SLASH, because no url join happens');
expect('proxy.noTrailingSlash', recorded['proxy.noTrailingSlash'].outbound[0].headers['x-api-key'] === 'synthetic-proxy-password',
    'reverse_proxy REPLACES the stored key with proxy_password');
expect('transport.stubRejects', recorded['transport.stubRejects'].response.bodyText === 'Internal server error',
    'a rejected fetch takes the catch branch');
expect('transport.stubRejects', recorded['transport.closedPort'].response.bodyText === 'Internal server error',
    'and a REAL refused connection reaches the same branch');
expect('transport.closedPort', recorded['transport.closedPort'].response.status === 500, 'a refused connection is a 500');
expect('image.absent', recorded['image.absent'].outboundCount === 0, 'a throw before the fetch makes ZERO requests');

// The wire scenario's key facts, asserted rather than assumed.
const wireKey = recorded['wire.noProxyPassword'].outbound[0].headers['x-api-key'];
if (wireKey === CLAUDE_SECRET) {
    throw new Error('wire.noProxyPassword recorded the stored key, so the scenario does not pin the proxy_password selection');
}
const wireDefaults = { ...recorded['wire.success'].outbound[0].headers };
for (const managed of ['host', 'content-length', 'content-type', 'anthropic-version', 'x-api-key']) {
    delete wireDefaults[managed];
}
recorded['wire.success'].outbound[0].headers = { ...recorded['wire.success'].outbound[0].headers, host: WIRE_HOST_MARKER };
recorded['wire.noProxyPassword'].outbound[0].headers = { ...recorded['wire.noProxyPassword'].outbound[0].headers, host: WIRE_HOST_MARKER };

// ── CLASSIFICATION (rules 18 and 4): every observable is either COMPARED or declared shape with a reason ──
//
// The malformed-body scenario is the one place where the pinned answer is NOT product behaviour: a body
// express.json() cannot parse never reaches the handler, and the server answers finalhandler's DEVELOPMENT
// error page, whose body embeds the checkout path and a stack trace (measured: the recording contained
// `C:\Users\...\SillyTavern\node_modules\body-parser\...`). Recording those bytes would make the fixture
// host-derived, and its content-length and ETag are derived from exactly those bytes, so all three are
// nulled rather than classified-but-recorded (the sd-routes finalhandler precedent).
const MALFORMED = 'body.malformedJson';
recorded[MALFORMED].response = {
    ...recorded[MALFORMED].response,
    body: null,
    bodyText: null,
    headers: Object.fromEntries(Object.entries(recorded[MALFORMED].response.headers).filter(([name]) => name === 'content-type')),
};

const comparisonFor = label => {
    if (label === MALFORMED) {
        return {
            compared: ['status', 'outboundCount'],
            shape: ['contentType', 'contentLength', 'etag', 'bodyText', 'outbound', 'response.headers.*'],
            shapeReason: {
                bodyText: 'finalhandler renders a development error page whose body embeds the checkout path and a stack trace, so the bytes are host-derived; the VALUE is nulled and the scenario claims only the status and the zero outbound count',
                contentType: 'chosen by the same error renderer rather than by the route, so it is not a behaviour this project claims to reproduce',
                contentLength: 'derived from the nulled body bytes',
                etag: 'derived from the nulled body bytes',
                outbound: 'recorded as an EMPTY array because the handler never runs; the count is the compared observable and it is 0',
                'response.headers.*': 'the error renderer supplies them, not the route',
            },
        };
    }
    const rejected = recorded[label].transportFailure === true;
    if (rejected) {
        // A REJECTED fetch leaves the catch's answer, and NOTHING a peer can observe: the pinned record of
        // the attempt comes from the stub's pre-throw logging, and the Go replay reaches the same catch
        // through a closed port where no peer exists. Only the response is comparable, so only the response
        // is claimed -- the request SHAPE of the same route is pinned by the proxy scenarios.
        return {
            compared: ['status', 'contentType', 'contentLength', 'etag', 'bodyText'],
            shape: ['outboundCount', 'outbound', 'outbound[].url', 'outbound[].method', 'outbound[].body', 'outbound[].headers', 'response.headers.*'],
            shapeReason: {
                outboundCount: 'a rejected fetch never reaches a peer, so the count a peer can observe is 0 on both legs and the pinned count is what the STUB logged before rejecting; the scenario claims the response branch, not the attempt',
                outbound: 'the attempt is recorded from the stub, which the Go replay does not have (it reaches the catch through a real closed port)',
                'outbound[].url': 'recorded from the stub\'s pre-throw log; no peer receives it on either leg',
                'outbound[].method': 'recorded from the stub\'s pre-throw log',
                'outbound[].body': 'recorded from the stub\'s pre-throw log',
                'outbound[].headers': 'recorded from the stub\'s pre-throw log',
                'response.headers.*': 'express security middleware supplies them',
            },
        };
    }
    return {
        compared: ['status', 'contentType', 'contentLength', 'etag', 'bodyText', 'outboundCount', 'outbound[].url', 'outbound[].method', 'outbound[].body', 'outbound[].headers'],
        shape: [
            'response.headers.* other than content-type/content-length/etag',
            'outbound[].headers.connection',
            'outbound[].headers.content-length',
            'outbound[].headers.host',
            ...(recorded[label].outboundRecording === 'none' ? ['outbound'] : []),
        ],
        shapeReason: {
            'response.headers.* other than content-type/content-length/etag': 'express security middleware supplies them; the four named ones are compared because they describe the body',
            'outbound[].headers.connection': 'the TRANSPORT appends it, not the route: the pinned stub records the header object the route passed and a peer records the framing the client chose, so the value is not a route observable. Presence is still asserted, because a request without a Connection header is a different request',
            'outbound[].headers.content-length': 'derived from the body, which IS compared byte for byte, and whether a given recording peer exposes it is a property of that peer rather than of the request',
            'outbound[].headers.host': 'the authority differs per run and per peer; it is asserted as the fact that the request ARRIVED at the peer, plus the recorded path, rather than compared as a value',
            ...(recorded[label].outboundRecording === 'none' ? { outbound: 'the unhooked boot has no stub, so a refused connection leaves no record; the count is 0 and the refusal is recorded separately as closedPortRefusal' } : {}),
        },
    };
};
for (const label of Object.keys(recorded)) {
    recorded[label].comparison = comparisonFor(label);
}
// A classification with a HOLE is a fixture that silently stops comparing something, so the probe refuses
// to write one (rule 7: a step that cannot fail is decoration).
const OBSERVABLES = ['status', 'contentType', 'contentLength', 'etag', 'bodyText', 'outboundCount', 'outbound'];
const comparedSomewhere = new Set();
for (const [label, entry] of Object.entries(recorded)) {
    const compared = entry.comparison.compared ?? [];
    const shape = entry.comparison.shape ?? [];
    const classified = new Set([...compared, ...shape]);
    const covered = name => classified.has(name)
        || [...classified].some(value => value.startsWith(`${name}[`) || value.startsWith(`${name}.`));
    for (const name of OBSERVABLES) {
        if (!covered(name)) {
            throw new Error(`${label}: observable ${name} is neither compared nor shape-classified`);
        }
    }
    for (const name of shape) {
        if (String(entry.comparison.shapeReason?.[name] ?? '').trim() === '') {
            throw new Error(`${label}: shape field ${name} has no reason`);
        }
    }
    if (!String(entry.response.bodyText ?? '').includes('<!DOCTYPE html>')) {
        for (const name of compared) comparedSomewhere.add(name);
    }
}
for (const name of ['status', 'contentType', 'contentLength', 'etag', 'bodyText', 'outboundCount', 'outbound[].url', 'outbound[].method', 'outbound[].body', 'outbound[].headers']) {
    if (!comparedSomewhere.has(name)) {
        throw new Error(`no scenario compares ${name}, so that observable is unasserted`);
    }
}

const fixture = {
    schemaVersion: 1,
    baseline: { version: PINNED_VERSION, commit: PINNED_COMMIT },
    probe: 'pinned /api/anthropic/caption-image route',
    oracle: {
        file: 'src/endpoints/anthropic.js',
        route: 'POST /api/anthropic/caption-image',
        secretKey: CLAUDE_KEY,
        defaultBaseUrl: SEAM_DEFAULTS.GOTAVERN_ANTHROPIC_CAPTION_BASE_URL,
        concatenation: '`${baseUrl}/messages` -- a template literal, so a trailing slash in reverse_proxy survives as a double slash',
    },
    routing: {
        method: 'POST only; the pinned router has no other verb on this path',
        body: 'express.json(): a malformed body never reaches the handler, and the scenario records what the server answers instead',
    },
    conventions: {
        markers: 'request bodies and recorded URLs carry <wire>, <wire-host> and <closed> instead of the run\'s loopback origins, because a port is host-derived (rule 18); the probe substitutes the live origin before sending and the Go replay substitutes its own peer',
        recording: 'outboundRecording "stub" records the header object the ROUTE passed (the convention other provider fixtures use); "wire" records the headers a real listener received; "none" is the unhooked closed-port boot, where no stub exists to record an attempt',
        mocks: 'each rule is bounded with times:1 so it cannot answer a later request (rule 20)',
    },
    nodeFetchWireDefaults: {
        headers: Object.entries(wireDefaults).sort(([left], [right]) => left.localeCompare(right)),
        measuredBy: 'the wire.success scenario on an UNHOOKED pinned boot, with the route-managed headers (host, content-length, content-type, anthropic-version, x-api-key) removed; this is what a real peer received, not a claim copied from another route\'s fixture',
        host: 'the authority differs per run and per peer, so it is asserted separately as Host',
    },
    inputs: {
        cookieSecret: COOKIE_SECRET,
        account: ACCOUNT,
        seamDefaults: SEAM_DEFAULTS,
        caption: CAPTION,
    },
    scenarios: recorded,
    knownDifferences: [
        {
            routes: ['POST /api/anthropic/caption-image'],
            status: 'partial-by-claim',
            reason: 'the route sets NO timeout, so "the peer accepted the connection and never answered" is not probed on either leg; the pinned console.debug/console.warn lines are not HTTP observables and are not recorded',
        },
    ],
};

writeFixture(repositoryRoot, 'sillytavern-1.19.0-anthropic-caption.json', fixture);
console.log(`Wrote tests/oracle/sillytavern-1.19.0-anthropic-caption.json: ${Object.keys(recorded).length} scenarios`);
