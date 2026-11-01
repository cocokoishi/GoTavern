#!/usr/bin/env node
// Capture the pinned /api/tokenizers/remote/textgenerationwebui/encode route against a LOOPBACK
// text-generation backend.
//
// WHY A SECOND FIXTURE, AND WHY A PLAIN BOOT INSTEAD OF THE RECORDING-PEER SEAM. The tokenizer corpus
// (tools/probe-tokenizers.mjs) already records the six supported api_type wires, but it cannot record the
// FAILURE branches honestly: the recording-peer hook replaces node-fetch, so a malformed URL or an
// unreachable endpoint would be answered by the stub instead of throwing the way the real module does, and
// a TypeError from `fetch` is exactly what pinned's `catch` turns into `{error:true}`. This probe therefore
// boots the pinned server UNMODIFIED and points the route at a real local HTTP server, which also lets it
// toggle secrets.json between cases (readSecret re-reads the file on every call) to capture the
// setAdditionalHeaders wire and the requestOverrides override.
//
// WHAT IS RECORDED, per case: the request body sent to the route, the response status/headers/body bytes,
// and the EXACT provider request the pinned route built (method, path, content-type, content-length and the
// credential/override headers). A case with no provider request records `backendRequests: []`, which is how
// a refusal, a malformed URL and an unreachable endpoint are told apart from a successful call.
//
// NOT OBSERVABLE FROM PINNED, recorded as such rather than faked:
//   - TIMEOUT: the pinned handler calls fetch with NO timeout (src/endpoints/tokenizers.js:1085-1088,
//     `const args = { method: 'POST', headers: {...} }`, and no AbortSignal is ever added), so a timeout
//     branch cannot be recorded -- a request that never answers hangs pinned forever. The `slow_upstream`
//     case is the strongest available observation: a 250 ms backend reply is still accepted, which proves
//     there is no short deadline.
//   - CLIENT CANCEL: the handler never observes an aborted request and never passes a signal, so a cancelled
//     client produces no response and no provider abort that could be captured. GoTavern's cancellation is
//     covered by a labelled derivation test instead.
//
// @gotavern-oracle: fixture=sillytavern-1.19.0-tokenizer-textgen-remote.json label="tokenizer textgen remote"
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { PINNED_COMMIT, PINNED_VERSION, rawRequest, sha256, stableHeaders, writeFixture } from './lib/pinned-outbound.mjs';

const sourceRoot = path.resolve(process.argv[2] ?? '');
const repositoryRoot = path.resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3]) {
    console.error('usage: node tools/probe-tokenizer-textgen-remote.mjs <pinned-source-clone> <gotavern-root>');
    process.exit(2);
}
if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim() !== PINNED_COMMIT) {
    throw new Error(`upstream checkout is not pinned at ${PINNED_COMMIT}`);
}

const ROUTE = '/api/tokenizers/remote/textgenerationwebui/encode';
const COOKIE_SECRET = 'gotavern-pinned-tokenizer-textgen-cookie-secret';
const SECRET_FILE_NAME = 'secrets.json';

// The loopback backend. Longest suffix wins so `/api/extra/tokencount` is not served by `/extra/tokencount`.
const MOCK_RESPONSES = [
    ['/v1/token/encode', { length: 7, tokens: [4, 5, 6] }],
    ['/v1/internal/encode', { value: 5 }],
    ['/api/extra/tokencount', { count: 9, ids: [7, 8] }],
    ['/v1/tokenize', { ids: [12] }],
    ['/tokenize', { tokens: [10, 11] }],
];

const runtimeRoot = mkdtempSync(path.join(os.tmpdir(), 'gotavern-tokenizer-textgen-oracle-'));
const dataRoot = path.join(runtimeRoot, 'data');
const configPath = path.join(runtimeRoot, 'config.yaml');
const userRoot = path.join(dataRoot, 'default-user');
const secretsPath = path.join(userRoot, SECRET_FILE_NAME);
let child;
let mockServer;
let mockOrigin;
const mockRequests = [];
const logs = [];

function safeCleanup() {
    const resolved = path.resolve(runtimeRoot);
    const parent = path.resolve(os.tmpdir());
    if (path.dirname(resolved).toLowerCase() !== parent.toLowerCase()
        || !path.basename(resolved).startsWith('gotavern-tokenizer-textgen-oracle-')) {
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

async function stopServer() {
    if (!child || child.exitCode !== null) return;
    child.kill('SIGINT');
    await Promise.race([
        new Promise(resolve => child.once('exit', resolve)),
        new Promise(resolve => setTimeout(resolve, 5000)),
    ]);
    if (child.exitCode === null) child.kill();
}

function recordedMockHeaders(headers) {
    // Only headers that describe the tokenizer request are recorded. Transport headers such as host,
    // user-agent and accept are properties of the pinned node-fetch version, not of the route.
    const recorded = {};
    for (const name of ['content-type', 'content-length', 'authorization', 'x-api-key', 'x-probe-override']) {
        if (headers[name] !== undefined) recorded[name] = String(headers[name]);
    }
    return recorded;
}

async function startMockBackend() {
    mockServer = http.createServer((request, response) => {
        const chunks = [];
        request.on('data', chunk => chunks.push(chunk));
        request.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf8');
            mockRequests.push({ method: request.method, path: request.url, headers: recordedMockHeaders(request.headers), body });
            if (request.url.includes('/fail')) {
                response.writeHead(500, { 'content-type': 'application/json' });
                response.end('{"error":"mock failure"}');
                return;
            }
            if (request.url.includes('/notjson')) {
                response.writeHead(200, { 'content-type': 'text/plain' });
                response.end('not json');
                return;
            }
            const delay = request.url.includes('/slow') ? 250 : 0;
            const pathname = request.url.split('?', 1)[0];
            const target = pathname.replace(/\/slow/, '').replace(/\/notjson/, '');
            const match = MOCK_RESPONSES
                .filter(([route]) => target.endsWith(route))
                .sort((left, right) => right[0].length - left[0].length)[0];
            const answer = response;
            setTimeout(() => {
                if (!match) {
                    answer.writeHead(404, { 'content-type': 'application/json' });
                    answer.end('{"error":"unknown mock route"}');
                    return;
                }
                answer.writeHead(200, { 'content-type': 'application/json' });
                answer.end(JSON.stringify(match[1]));
            }, delay);
        });
    });
    await new Promise((resolve, reject) => {
        mockServer.once('error', reject);
        mockServer.listen(0, '127.0.0.1', resolve);
    });
    mockOrigin = `http://127.0.0.1:${mockServer.address().port}`;
}

async function stopMockBackend() {
    if (!mockServer) return;
    await new Promise(resolve => mockServer.close(resolve));
    mockServer = undefined;
}

function configText(overrideHost) {
    const lines = [
        'enableUserAccounts: true',
        'skipContentCheck: true',
        'extensions:',
        '  enabled: false',
        '  autoUpdate: false',
    ];
    if (overrideHost) {
        lines.push(
            'requestOverrides:',
            '  - hosts:',
            `      - ${overrideHost}`,
            '    headers:',
            '      X-Probe-Override: override-value',
            '      Authorization: Bearer override-token',
        );
    }
    lines.push('');
    return lines.join('\n');
}

async function startPinnedServer(overrideHost) {
    writeFileSync(configPath, configText(overrideHost));
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
    const deadline = Date.now() + 900000;
    let ready = false;
    let lastError;
    while (Date.now() < deadline && !ready) {
        if (child.exitCode !== null) throw new Error(`pinned server exited before readiness:\n${logs.join('').slice(-10000)}`);
        try {
            const result = await rawRequest(`${origin}/login?noauto=1`);
            ready = result.response.status === 200 && result.response.headers.get('content-type')?.includes('text/html');
            if (!ready) lastError = new Error(`login returned ${result.response.status}`);
        } catch (error) {
            lastError = error;
        }
        if (!ready) await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (!ready) throw new Error(`pinned server did not become ready: ${lastError?.stack ?? 'none'}\n${logs.join('').slice(-10000)}`);
    const csrf = await rawRequest(`${origin}/csrf-token`);
    const token = csrf.body.token;
    const csrfCookie = csrf.response.headers.getSetCookie().map(cookie => cookie.split(';', 1)[0]).join('; ');
    const login = await rawRequest(`${origin}/api/users/login`, 'POST', {
        Cookie: csrfCookie, 'Content-Type': 'application/json', 'X-CSRF-Token': token,
    }, JSON.stringify({ handle: 'default-user', password: '' }));
    if (login.response.status !== 200) throw new Error(`could not login: ${login.response.status} ${JSON.stringify(login.body)}`);
    const sessionCookie = login.response.headers.getSetCookie().map(cookie => cookie.split(';', 1)[0]).join('; ');
    return { origin, token, sessionCookie };
}

// Secrets are written in the ARRAY form the pinned server reads (`{key: [{id,value,label,active}]}`), so no
// migration runs and each case's header set is exactly the one that case declares.
function writeSecrets(values) {
    mkdirSync(userRoot, { recursive: true });
    if (Object.keys(values).length === 0) {
        rmSync(secretsPath, { force: true });
        return;
    }
    const file = {};
    for (const [key, value] of Object.entries(values)) {
        file[key] = [{ id: `probe-id-${key}`, value, label: key, active: true }];
    }
    writeFileSync(secretsPath, JSON.stringify(file, null, 4));
}

const MOCK = '<mock-origin>';
function materialize(value) {
    if (typeof value === 'string') return value.split(MOCK).join(mockOrigin);
    if (Array.isArray(value)) return value.map(materialize);
    if (value && typeof value === 'object') {
        const result = {};
        for (const [key, item] of Object.entries(value)) result[key] = materialize(item);
        return result;
    }
    return value;
}
const normalize = value => typeof value === 'string' ? value.split(mockOrigin).join(MOCK) : value;

const CASES = [
    // The six supported variants, all recorded without secrets so the BASE wire is unambiguous.
    { name: 'valid#tabby', body: { text: 'Hello, world!', url: MOCK, model: 'test-model', api_type: 'tabby' } },
    { name: 'valid#koboldcpp', body: { text: 'Hello, world!', url: MOCK, model: 'test-model', api_type: 'koboldcpp' } },
    { name: 'valid#llamacpp', body: { text: 'Hello, world!', url: MOCK, model: 'test-model', api_type: 'llamacpp' } },
    { name: 'valid#vllm', body: { text: 'Hello, world!', url: MOCK, model: 'test-model', api_type: 'vllm' } },
    { name: 'valid#aphrodite', body: { text: 'Hello, world!', url: MOCK, model: 'test-model', api_type: 'aphrodite' } },
    { name: 'valid#ooba', body: { text: 'Hello, world!', url: MOCK, model: 'test-model', api_type: 'ooba' } },
    // setAdditionalHeaders: the api_type selects a secret-backed credential set. Tabby and Aphrodite send
    // TWO headers (x-api-key AND Authorization); the other supported types send Authorization only.
    { name: 'auth#tabby', secrets: { api_key_tabby: 'probe-tabby-key' }, body: { text: 'Hello, world!', url: MOCK, model: 'test-model', api_type: 'tabby' } },
    { name: 'auth#aphrodite', secrets: { api_key_aphrodite: 'probe-aphrodite-key' }, body: { text: 'Hello, world!', url: MOCK, model: 'test-model', api_type: 'aphrodite' } },
    { name: 'auth#vllm', secrets: { api_key_vllm: 'probe-vllm-key' }, body: { text: 'Hello, world!', url: MOCK, model: 'test-model', api_type: 'vllm' } },
    { name: 'auth#koboldcpp', secrets: { api_key_koboldcpp: 'probe-koboldcpp-key' }, body: { text: 'Hello, world!', url: MOCK, model: 'test-model', api_type: 'koboldcpp' } },
    // requestOverrides is applied LAST and WINS over the type's own Authorization; the extra header is
    // added, not replaced. Both facts are on the recorded wire.
    { name: 'auth#tabby#request_overrides', secrets: { api_key_tabby: 'probe-tabby-key' }, body: { text: 'Hello, world!', url: MOCK, model: 'test-model', api_type: 'tabby' } },
    // String() coercion, not rejection: a number text and a missing model both reach the wire.
    { name: 'coerce#text_number', body: { text: 42, url: MOCK, model: 'test-model', api_type: 'tabby' } },
    { name: 'coerce#missing_text', body: { url: MOCK, model: 'test-model', api_type: 'tabby' } },
    { name: 'coerce#missing_model', body: { text: 'Hello, world!', url: MOCK, api_type: 'vllm' } },
    // trimV1: a trailing slash and a trailing /v1 are both removed BEFORE the suffix is appended.
    { name: 'url#trailing_v1', body: { text: 'Hello, world!', url: `${MOCK}/v1`, model: 'test-model', api_type: 'tabby' } },
    { name: 'url#trailing_slash', body: { text: 'Hello, world!', url: `${MOCK}/`, model: 'test-model', api_type: 'tabby' } },
    // Failure branches that need the REAL node-fetch: a malformed URL and an unreachable endpoint both
    // throw inside the handler's try and become {error:true} with NO provider request.
    { name: 'error#malformed_url', body: { text: 'Hello, world!', url: 'not a url', model: 'test-model', api_type: 'tabby' } },
    { name: 'error#unreachable', body: { text: 'Hello, world!', url: 'http://127.0.0.1:1', model: 'test-model', api_type: 'tabby' } },
    { name: 'error#missing_url', body: { text: 'Hello, world!', model: 'test-model', api_type: 'tabby' } },
    // Upstream non-2xx and a non-JSON 2xx body are DIFFERENT pinned branches (result.ok vs result.json()),
    // and both answer the same {error:true} envelope.
    { name: 'error#upstream_status', body: { text: 'Hello, world!', url: `${MOCK}/fail`, model: 'test-model', api_type: 'koboldcpp' } },
    { name: 'error#upstream_not_json', body: { text: 'Hello, world!', url: `${MOCK}/notjson`, model: 'test-model', api_type: 'tabby' } },
    // No timeout is installed by pinned; a 250 ms backend answer is still accepted.
    { name: 'no_timeout#slow_upstream', body: { text: 'Hello, world!', url: `${MOCK}/slow`, model: 'test-model', api_type: 'tabby' } },
    // The switch is over the RAW api_type, so an unsupported TEXTGEN_TYPE (generic) and an unknown one both
    // take the default branch: sendStatus(400), no provider request.
    { name: 'unsupported#generic', body: { text: 'Hello, world!', url: MOCK, model: 'test-model', api_type: 'generic' } },
    { name: 'unsupported#unknown', body: { text: 'Hello, world!', url: MOCK, model: 'test-model', api_type: 'not-a-type' } },
    // Request-shape branches of the pinned body parser / the `!request.body` guard.
    { name: 'body#missing_text_and_url', body: {}, contentType: 'application/json' },
    { name: 'body#array', body: '[]' },
    { name: 'body#no_body', body: undefined, contentType: 'application/json' },
];

// Cases whose route-level answer is Express's HTML error page: only the status and content type are
// recordable, because the page body is a V8 stack carrying host-absolute source paths.
const ERROR_PAGE_CASES = [
    { name: 'body#malformed_json', raw: '{' },
    { name: 'body#json_null', raw: 'null' },
];

// requestOverrides is a CONFIG-DRIVEN branch, and a config-driven branch cannot be observed on a boot whose
// config does not carry the key. The baseline cases run on a boot with NO requestOverrides (so the wire shows
// exactly setAdditionalHeaders' own headers); these cases run on a SECOND boot whose config overrides the
// same loopback host, which is what makes "the override is applied LAST and wins over Authorization" a
// measured difference rather than a claim.
const OVERRIDE_CASES = [
    { name: 'override#tabby', body: { text: 'Hello, world!', url: MOCK, model: 'test-model', api_type: 'tabby' } },
    { name: 'override#tabby_secret', secrets: { api_key_tabby: 'probe-tabby-key' }, body: { text: 'Hello, world!', url: MOCK, model: 'test-model', api_type: 'tabby' } },
];

try {
    await startMockBackend();
    mkdirSync(path.join(dataRoot, '_storage'), { recursive: true });
    writeFileSync(path.join(dataRoot, 'cookie-secret.txt'), COOKIE_SECRET);
    writeFileSync(path.join(dataRoot, '_storage', sha256('user:default-user')), JSON.stringify({
        key: 'user:default-user',
        value: { handle: 'default-user', name: 'Tokenizer Reader', created: 1700000000000, password: '', admin: true, enabled: true, salt: '' },
    }));

    const cases = {};
    const capture = async (name, action, { errorPage = false } = {}) => {
        if (cases[name]) throw new Error(`duplicate case name ${name}`);
        const before = mockRequests.length;
        const result = await action();
        const backendRequests = mockRequests.slice(before).map(request => ({
            method: request.method,
            path: normalize(request.path),
            headers: request.headers,
            body: normalize(request.body),
        }));
        if (errorPage) {
            const contentType = result.response.headers.get('content-type') ?? '';
            if (!contentType.startsWith('text/html')) {
                throw new Error(`${name}: expected the Express error page, got ${result.response.status} ${contentType}: ${String(result.text).slice(0, 200)}`);
            }
            cases[name] = { request: null, status: result.response.status, contentType, errorPage: true, backendRequests };
            return;
        }
        cases[name] = {
            status: result.response.status,
            headers: stableHeaders(result.response),
            body: normalize(result.body),
            bodySha256: sha256(result.bytes),
            backendRequests,
        };
    };
    const post = (session, rawBody) => rawRequest(`${session.origin}${ROUTE}`, 'POST', {
        Cookie: session.sessionCookie, 'Content-Type': 'application/json', 'X-CSRF-Token': session.token,
    }, rawBody);
    const runCases = async (session, scenarios, config) => {
        for (const scenario of scenarios) {
            writeSecrets(scenario.secrets ?? {});
            const rawBody = scenario.raw !== undefined
                ? scenario.raw
                : (scenario.body === undefined ? undefined : (typeof scenario.body === 'string' ? scenario.body : JSON.stringify(materialize(scenario.body))));
            await capture(scenario.name, () => post(session, rawBody), { errorPage: scenario.errorPage === true });
            cases[scenario.name].request = {
                // The MARKER spelling, not the materialized one: a fixture that stored the recording host's
                // loopback port would make the replay dial a dead port instead of its own backend.
                body: scenario.raw !== undefined ? scenario.raw : (scenario.body === undefined ? null : scenario.body),
                secrets: scenario.secrets ?? {},
                config,
            };
        }
    };

    const baseline = await startPinnedServer(null);
    await runCases(baseline, [...CASES, ...ERROR_PAGE_CASES.map(scenario => ({ ...scenario, errorPage: true }))], 'baseline');
    await stopServer();
    const override = await startPinnedServer(new URL(mockOrigin).host);
    await runCases(override, OVERRIDE_CASES, 'requestOverrides');
    await stopServer();
    await stopMockBackend();

    const fixture = {
        schemaVersion: 1,
        baseline: { version: PINNED_VERSION, commit: PINNED_COMMIT },
        probe: 'pinned /api/tokenizers/remote/textgenerationwebui/encode against a loopback text-generation backend: the six api_type wires, setAdditionalHeaders credentials, requestOverrides precedence, String() coercion, trimV1, malformed/unreachable URLs, upstream non-2xx and non-JSON answers, and the body-parser branches',
        normalizations: [
            'The loopback backend origin is recorded as <mock-origin>; its port differs on every run.',
            'Provider requests record method, path, content-type, content-length and the credential/override headers only; transport headers (host, user-agent, accept) belong to pinned node-fetch and are not route behaviour.',
            'Express-rendered HTML error pages are recorded as status + content type only, because the page body is a V8 stack with host-absolute source paths (repo convention, see docs/api-inventory.md).',
            'TWO BOOTS: the baseline cases come from a boot whose config has NO requestOverrides key, so their wire is exactly setAdditionalHeaders; the cases whose request.config is "requestOverrides" come from a second boot whose config overrides the loopback host, which is what makes the override precedence a measured difference.',
            'No case reaches the live network: the only non-loopback URL is a deliberately malformed one, and the unreachable case targets 127.0.0.1:1.',
        ],
        recordingConfigs: {
            baseline: 'enableUserAccounts: true, extensions disabled, no requestOverrides',
            requestOverrides: {
                requestOverrides: [{
                    hosts: ['<mock-host>'],
                    headers: { 'X-Probe-Override': 'override-value', Authorization: 'Bearer override-token' },
                }],
            },
        },
        cases,
        notObservable: [
            {
                scenario: 'timeout',
                why: 'the pinned handler calls fetch with no timeout and no AbortSignal (src/endpoints/tokenizers.js:1085-1088), so a never-answering provider hangs pinned and no timeout branch can be recorded; no_timeout#slow_upstream records that a 250 ms answer is accepted, which is the strongest observable form',
            },
            {
                scenario: 'client-cancel',
                why: 'the pinned handler never observes request aborts and never passes a signal to fetch, so a cancelled client produces neither a response nor a provider-side abort that a probe could capture; GoTavern cancellation is a labelled derivation test',
            },
        ],
    };
    const written = writeFixture(repositoryRoot, 'sillytavern-1.19.0-tokenizer-textgen-remote.json', fixture);
    console.log(`Wrote ${path.relative(repositoryRoot, written)} (${Object.keys(cases).length} cases)`);
} catch (error) {
    console.error(error);
    process.exitCode = 1;
} finally {
    await stopServer();
    await stopMockBackend();
    safeCleanup();
}
