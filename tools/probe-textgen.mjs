#!/usr/bin/env node
// @gotavern-oracle: fixture=sillytavern-1.19.0-textgen.json label="textgen generate"
// Probe POST /api/backends/text-completions/generate (src/endpoints/backends/text-completions.js:272).
//
// WHY A NEW PROBE. tools/probe-backends.mjs owns tests/oracle/sillytavern-1.19.0-backends.json and
// states in its own header that /text-completions/generate is OUT of its scope; extending it would
// re-record a fixture another lane owns. This probe records the one route into its own fixture with
// the same mechanism (tools/lib/pinned-outbound.mjs replaces `node-fetch` AND the global `fetch`), so
// no run can reach the network and every outbound request is captured verbatim.
//
// WHAT THE ROUTE IS. A proxy with a per-api_type switch:
//   - the TARGET is `trimV1(api_server)` plus a suffix that depends on the type
//     (/v1/completions, /completion, /api/generate, /api/openai/v1/completions, /oai/v1/completions,
//     /v1/chat/completions), and a type the switch does not know leaves the base UNCHANGED — there is
//     NO unimplemented branch in this route, so there is nothing to answer 501 for;
//   - `localhost` in api_server is rewritten to `127.0.0.1` before anything else;
//   - the BODY is `JSON.stringify(request.body)` after a lodash `pickBy` allowlist per type, with
//     three types rewriting a member (generic slices `stop` to 4; openrouter folds `provider` +
//     `quantizations` into a provider object; ollama REBUILDS the whole body from an explicit literal);
//   - the HEADERS are `{ 'Content-Type': 'application/json' }` plus the secret header set selected by
//     the type and, for openrouter/featherless, two literal referer headers;
//   - a non-stream 2xx answer is parsed and re-sent (with the INFERMATICAI choice remap), a non-2xx
//     answer becomes `{ error: true, status, response: <provider text> }` at status 200, and a thrown
//     fetch becomes the same shape with status "UNKNOWN";
//   - `stream: true` pipes the provider reply through forwardFetchResponse (401 becomes 400, no
//     content type is set), and ollama's stream path re-frames newline-delimited JSON into SSE.
//
// WHAT IS NOT RECORDED, and why it is not dressed up as recorded (see `notRecorded`):
//   - NON-BUFFERING. The probe peer answers with one buffered chunk, so a recorded reply cannot tell a
//     piping route from a buffering one. The pinned behaviour is a SOURCE-DERIVED property
//     (`from.body.pipe(to)`, src/util.js forwardFetchResponse) and the GO side's non-buffering is
//     proved by an implementation test against a peer that writes a chunk and then BLOCKS.
//   - the koboldcpp ABORT leg (`/api/extra/abort` on client close): a peer that answers immediately
//     leaves no in-flight request to abandon. Covered by a labelled implementation test.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';

import { PINNED_COMMIT, PINNED_VERSION, startPinnedProviderServer, writeFixture } from './lib/pinned-outbound.mjs';

const sourceRoot = path.resolve(process.argv[2] ?? '');
const repositoryRoot = path.resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3]) {
    console.error('usage: node tools/probe-textgen.mjs <pinned-source-clone> <gotavern-root>');
    process.exit(2);
}
if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim() !== PINNED_COMMIT) {
    throw new Error(`upstream checkout is not pinned at ${PINNED_COMMIT}`);
}

const ROUTE = '/api/backends/text-completions/generate';
const MOCK = '<mock>';
const PINNED_PEER = 'http://textgen-peer.example';
// The localhost rewrite has to be READABLE in the fixture and reproducible by the replay, so the port
// is a marker: the pinned run substitutes a fixed synthetic port, the replay substitutes its own.
const PORT_MARKER = '<port>';
const PINNED_PORT = '59999';
const COOKIE_SECRET = 'gotavern-pinned-textgen-cookie-secret';

// One synthetic key per type that has a secret getter, so every header branch is exercised. OLLAMA has
// no getter in pinned setAdditionalHeadersByType, so it carries no header and has no key here.
const SECRETS = {
    api_key_ooba: 'probe-ooba-key',
    api_key_mancer: 'probe-mancer-key',
    api_key_vllm: 'probe-vllm-key',
    api_key_aphrodite: 'probe-aphrodite-key',
    api_key_tabby: 'probe-tabby-key',
    api_key_koboldcpp: 'probe-koboldcpp-key',
    api_key_togetherai: 'probe-togetherai-key',
    api_key_llamacpp: 'probe-llamacpp-key',
    api_key_infermaticai: 'probe-infermaticai-key',
    api_key_dreamgen: 'probe-dreamgen-key',
    api_key_openrouter: 'probe-openrouter-key',
    api_key_featherless: 'probe-featherless-key',
    api_key_huggingface: 'probe-huggingface-key',
    api_key_generic: 'probe-generic-key',
};

const OK_JSON = '{"choices":[{"text":"a tree","index":0,"logprobs":null}],"usage":{"total_tokens":3}}';
const STREAM_BODY = 'data: {"choices":[{"text":"a"}]}\n\ndata: {"choices":[{"text":"b"}]}\n\ndata: [DONE]\n\n';
const OLLAMA_FRAME = '{"response":"a","thinking":"t","done":false}';

// `probe` fields shared by the per-type families: one unknown member proves the allowlist, and the
// members below are in every allowlist so a missing member shows up as a body difference.
const BASE_BODY = { api_server: '<mock>', model: 'probe-model', prompt: 'a tree', max_tokens: 16, not_allowed: 'dropped' };

const SCENARIOS = [
    // ── one non-stream family per api_type: target suffix, allowlist body, header set ──────────
    { name: 'type.generic', body: { ...BASE_BODY, api_type: 'generic', stop: ['a', 'b', 'c', 'd', 'e'], logit_bias: { '1': 1 }, not_allowed: 'dropped' },
      upstream: [{ path: '/v1/completions', body: OK_JSON }] },
    { name: 'type.ooba', body: { ...BASE_BODY, api_type: 'ooba' }, upstream: [{ path: '/v1/completions', body: OK_JSON }] },
    { name: 'type.vllm', body: { ...BASE_BODY, api_type: 'vllm', best_of: 2, use_beam_search: true, not_allowed: 'dropped' }, upstream: [{ path: '/v1/completions', body: OK_JSON }] },
    { name: 'type.aphrodite', body: { ...BASE_BODY, api_type: 'aphrodite' }, upstream: [{ path: '/v1/completions', body: OK_JSON }] },
    { name: 'type.tabby', body: { ...BASE_BODY, api_type: 'tabby' }, upstream: [{ path: '/v1/completions', body: OK_JSON }] },
    { name: 'type.koboldcpp', body: { ...BASE_BODY, api_type: 'koboldcpp' }, upstream: [{ path: '/v1/completions', body: OK_JSON }] },
    { name: 'type.togetherai', body: { ...BASE_BODY, api_type: 'togetherai', stop: ['a'], logprobs: true, not_allowed: 'dropped' }, upstream: [{ path: '/v1/completions', body: OK_JSON }] },
    { name: 'type.llamacpp', body: { ...BASE_BODY, api_type: 'llamacpp' }, upstream: [{ path: '/completion', body: OK_JSON }] },
    { name: 'type.infermaticai', body: { ...BASE_BODY, api_type: 'infermaticai', min_tokens: 1, logprobs: true, not_allowed: 'dropped' },
      upstream: [{ path: '/v1/completions', body: '{"choices":[{"message":{"content":"from message"},"index":0,"logprobs":null},{"text":"from text","index":1},{"index":2}]}' }] },
    { name: 'type.dreamgen', body: { ...BASE_BODY, api_type: 'dreamgen', not_allowed: 'kept by dreamgen' },
      upstream: [{ path: '/api/openai/v1/completions', body: OK_JSON }] },
    { name: 'type.openrouter', body: { ...BASE_BODY, api_type: 'openrouter', provider: ['lambda', 'deepinfra'], allow_fallbacks: false, quantizations: ['fp8'], top_a: 0.5, not_allowed: 'dropped' },
      upstream: [{ path: '/v1/chat/completions', body: OK_JSON }] },
    { name: 'type.openrouterNoProvider', body: { ...BASE_BODY, api_type: 'openrouter', provider: [] },
      upstream: [{ path: '/v1/chat/completions', body: OK_JSON }] },
    { name: 'type.featherless', body: { ...BASE_BODY, api_type: 'featherless', best_of: 2, use_beam_search: true, not_allowed: 'dropped' }, upstream: [{ path: '/v1/completions', body: OK_JSON }] },
    { name: 'type.huggingface', body: { ...BASE_BODY, api_type: 'huggingface' }, upstream: [{ path: '/v1/completions', body: OK_JSON }] },
    { name: 'type.mancer', body: { ...BASE_BODY, api_type: 'mancer' }, upstream: [{ path: '/oai/v1/completions', body: OK_JSON }] },
    // ollama REBUILDS the body from an explicit literal, so the recorded body is the observation.
    { name: 'type.ollama', body: { ...BASE_BODY, api_type: 'ollama', num_predict: 5, num_ctx: 2048, temperature: 0.2, not_allowed: 'dropped' },
      upstream: [{ path: '/api/generate', body: '{"response":"a tree","done":true}' }] },
    { name: 'type.ollamaStream', body: { ...BASE_BODY, api_type: 'ollama', stream: true, num_predict: 5 },
      upstream: [{ path: '/api/generate', body: OLLAMA_FRAME }] },
    // A type the switch does not know leaves the base URL unchanged; there is no 501 branch here.
    { name: 'type.unknown', body: { ...BASE_BODY, api_type: 'not-a-real-type', not_allowed: 'forwarded' }, upstream: [{ match: '', body: OK_JSON }] },

    // ── target construction ───────────────────────────────────────────────────────────────────
    { name: 'target.trailingV1Trimmed', body: { api_server: `${MOCK}/v1/`, api_type: 'ooba', model: 'm', prompt: 'p' },
      upstream: [{ path: '/v1/completions', body: OK_JSON }] },
    { name: 'target.localhostRewrite', body: { api_server: `http://localhost:${PORT_MARKER}`, api_type: 'generic', model: 'm', prompt: 'p' },
      upstream: [{ path: '/v1/completions', body: OK_JSON }] },

    // ── response branches ────────────────────────────────────────────────────────────────────
    { name: 'response.nonOkForwarded', body: { api_server: MOCK, api_type: 'ooba', model: 'm', prompt: 'p' },
      upstream: [{ path: '/v1/completions', status: 500, statusText: 'Internal Server Error', text: '{"error":"backend exploded"}' }] },
    { name: 'response.nonJsonOk', body: { api_server: MOCK, api_type: 'ooba', model: 'm', prompt: 'p' },
      shape: 'the pinned `completionsReply.json()` throws a V8 SyntaxError and the catch answers that message; engine text is not reproducible, so only the status and the outbound count are compared',
      upstream: [{ path: '/v1/completions', text: 'not json at all' }] },
    { name: 'response.stream', body: { api_server: MOCK, api_type: 'ooba', model: 'm', prompt: 'p', stream: true },
      upstream: [{ path: '/v1/completions', headers: { 'content-type': 'text/event-stream' }, text: STREAM_BODY }] },
    { name: 'response.stream401', body: { api_server: MOCK, api_type: 'ooba', model: 'm', prompt: 'p', stream: true },
      upstream: [{ path: '/v1/completions', status: 401, statusText: 'Unauthorized', headers: { 'content-type': 'text/plain' }, text: 'bad key' }] },
    { name: 'response.streamNonOk', body: { api_server: MOCK, api_type: 'koboldcpp', model: 'm', prompt: 'p', stream: true },
      upstream: [{ path: '/v1/completions', status: 503, statusText: 'Service Unavailable', headers: { 'content-type': 'text/plain' }, text: 'backend down' }] },
    // A missing api_server makes `api_server.indexOf` throw INSIDE the pinned try, so the catch answers
    // its own error shape; the text is V8 engine text.
    { name: 'request.missingServer', body: { api_type: 'ooba', model: 'm', prompt: 'p' },
      shape: 'the pinned `request.body.api_server.indexOf` throws a V8 TypeError inside the try and the catch answers its message; engine text is not reproducible, so only the status and the zero outbound count are compared',
      upstream: [] },
    // A fetch that rejects: no provider text, so `error.statusText`/`message` decide the shape.
    { name: 'response.throws', body: { api_server: MOCK, api_type: 'ooba', model: 'm', prompt: 'p' },
      upstream: [{ path: '/v1/completions', throws: true }] },
];

function materialize(value) {
    if (typeof value === 'string') return value.split(MOCK).join(PINNED_PEER).split(PORT_MARKER).join(PINNED_PORT);
    if (Array.isArray(value)) return value.map(materialize);
    if (value && typeof value === 'object') {
        const result = {};
        for (const [key, item] of Object.entries(value)) result[key] = materialize(item);
        return result;
    }
    return value;
}

function normalize(value) {
    if (typeof value !== 'string') return value;
    return value.split(PINNED_PEER).join(MOCK).split(`127.0.0.1:${PINNED_PORT}`).join(`127.0.0.1:${PORT_MARKER}`);
}

function secretFile(values) {
    const secrets = {};
    for (const [key, value] of Object.entries(values)) {
        secrets[key] = [{ id: `probe-id-${key}`, value, label: key, active: true }];
    }
    return secrets;
}

function stubRule(run, upstream) {
    return {
        run,
        match: upstream.match ?? upstream.path,
        status: upstream.status ?? 200,
        statusText: upstream.statusText ?? 'OK',
        headers: upstream.headers ?? { 'content-type': 'application/json' },
        body: upstream.text !== undefined ? upstream.text : (upstream.body ?? '{}'),
        ...(upstream.throws === true ? { throws: true } : {}),
    };
}

function stableHeaders(response) {
    return Object.fromEntries([...response.headers.entries()]
        .filter(([name]) => !['connection', 'date', 'keep-alive', 'last-modified', 'set-cookie', 'transfer-encoding', 'x-response-time'].includes(name))
        .sort(([left], [right]) => left.localeCompare(right)));
}

const server = await startPinnedProviderServer({ sourceRoot, prefix: 'gotavern-textgen-oracle-', mocks: [] });
const scenarios = {};
let bootOutbound = [];
try {
    bootOutbound = server.bootOutbound;
    for (const scenario of SCENARIOS) {
        const rules = (scenario.upstream ?? []).map(upstream => stubRule(scenario.name, upstream));
        server.writeSecrets(secretFile(SECRETS));
        server.setMocks(rules);
        const body = materialize(scenario.body);
        const result = await server.post(ROUTE, JSON.stringify(body));
        const captured = {
            status: result.response.status,
            headers: stableHeaders(result.response),
            bodyText: normalize(result.text),
        };
        if (scenario.shape) {
            captured.bodyText = null;
            delete captured.headers['content-length'];
            delete captured.headers.etag;
            // Both shape branches answer 200 with the pinned catch envelope, so the guard is the
            // BODY, not the status: an empty body would mean the branch never ran.
            if (typeof result.text !== 'string' || result.text === '') {
                throw new Error(`${scenario.name}: the shape-classified branch answered an EMPTY body`);
            }
            if (!result.text.includes('"error":true')) {
                throw new Error(`${scenario.name}: the shape-classified branch did not answer the catch envelope`);
            }
        }
        const outbound = server.outbound().map(request => ({
            url: normalize(request.url),
            method: request.method,
            headers: Object.fromEntries(Object.entries(request.headers ?? {}).sort(([a], [b]) => a.localeCompare(b))),
            body: normalize(request.body ?? null),
        }));
        scenarios[scenario.name] = {
            route: ROUTE,
            body: scenario.body,
            bodyText: JSON.stringify(scenario.body),
            mocks: rules,
            response: captured,
            ...(scenario.shape === undefined ? {} : { responseShape: scenario.shape }),
            outbound,
        };
    }
} catch (error) {
    console.error('PROBE FAILED; pinned server log tail:');
    console.error(server.logs.join('').slice(-8000));
    throw error;
} finally {
    await server.stop();
}

const sha256 = value => createHash('sha256').update(value).digest('hex');

function refuse(message) {
    console.error('PROBE REFUSES: ' + message);
    try {
        console.error('pinned server log tail:');
        console.error(server.logs.join('').slice(-4000));
    } catch (error) {
        console.error('could not read the pinned server log: ' + error);
    }
    process.exit(1);
}

function requireOutbound(name, index = 0) {
    const scenario = scenarios[name];
    if (!scenario) refuse(`scenario ${name} is missing from the recording`);
    if (scenario.outbound.length <= index) {
        refuse(`scenario ${name} recorded ${scenario.outbound.length} outbound request(s), so request ${index} cannot be compared`
            + ` | status ${scenario.response.status} | body ${String(scenario.response.bodyText ?? '').slice(0, 400)}`);
        // Unreachable after refuse() exits; it exists so a diagnostic harness that reports instead of
        // refusing cannot turn a missing observation into a TypeError.
        return { url: '', method: '', headers: {}, body: null };
    }
    return scenario.outbound[index];
}

function bodyJSON(name) {
    try {
        return JSON.parse(scenarios[name].response.bodyText);
    } catch (error) {
        refuse(`scenario ${name} answered a body that is not JSON: ${String(scenarios[name].response.bodyText).slice(0, 200)}`);
        return {};
    }
}

// ── the target switch: one assertion per type, because the suffix IS the type's contract ──────
const SUFFIX = {
    'type.generic': '/v1/completions',
    'type.ooba': '/v1/completions',
    'type.vllm': '/v1/completions',
    'type.aphrodite': '/v1/completions',
    'type.tabby': '/v1/completions',
    'type.koboldcpp': '/v1/completions',
    'type.togetherai': '/v1/completions',
    'type.featherless': '/v1/completions',
    'type.huggingface': '/v1/completions',
    'type.llamacpp': '/completion',
    'type.infermaticai': '/v1/completions',
    'type.dreamgen': '/api/openai/v1/completions',
    'type.openrouter': '/v1/chat/completions',
    'type.mancer': '/oai/v1/completions',
    'type.ollama': '/api/generate',
    'type.ollamaStream': '/api/generate',
};
for (const [name, suffix] of Object.entries(SUFFIX)) {
    const request = requireOutbound(name, 0);
    if (request.url !== `${MOCK}${suffix}`) {
        refuse(`${name}: target is ${request.url}, the pinned switch appends ${suffix}`);
    }
    if (request.method !== 'POST') refuse(`${name}: method is ${request.method}`);
    if (scenarios[name].response.status !== 200) refuse(`${name}: status is ${scenarios[name].response.status}`);
}

// The unknown type has NO suffix: the switch falls through and the base URL is the target.
if (requireOutbound('type.unknown', 0).url !== MOCK) refuse(`unknown type target is ${requireOutbound('type.unknown', 0).url}`);

// ── the per-type allowlists: a member outside the list must be GONE, one inside must survive ──
function outboundBody(name) {
    const raw = requireOutbound(name, 0).body;
    try {
        return JSON.parse(raw);
    } catch (error) {
        refuse(`${name}: outbound body is not JSON: ${String(raw).slice(0, 200)}`);
    }
}
for (const name of ['type.generic', 'type.vllm', 'type.togetherai', 'type.infermaticai', 'type.openrouter', 'type.featherless']) {
    const body = outboundBody(name);
    if ('not_allowed' in body) refuse(`${name}: the unknown member survived the ${name} allowlist`);
}
for (const name of ['type.ooba', 'type.aphrodite', 'type.tabby', 'type.koboldcpp', 'type.llamacpp', 'type.huggingface', 'type.mancer', 'type.ollama']) {
    // These types forward `request.body` as given (ollama rebuilds it from a literal), so an unknown
    // member is either kept or replaced by the rebuild; the assertion is the recorded body itself.
    if (!scenarios[name].outbound.length) refuse(`${name} recorded no outbound request`);
}
if ((outboundBody('type.generic').stop || []).length !== 4) refuse('generic did not slice stop to four entries');
if (outboundBody('type.generic').logit_bias === undefined) refuse('generic dropped logit_bias');
if (outboundBody('type.dreamgen').not_allowed === undefined) refuse('dreamgen must forward the whole body');
if (outboundBody('type.unknown').not_allowed === undefined) refuse('an unknown type must forward the whole body');
if (outboundBody('type.vllm').use_beam_search !== true) refuse('vllm dropped use_beam_search');

const openRouter = outboundBody('type.openrouter');
if (JSON.stringify(openRouter.provider) !== JSON.stringify({ allow_fallbacks: false, order: ['lambda', 'deepinfra'], quantizations: ['fp8'] })) {
    refuse(`openrouter provider folding is wrong: ${JSON.stringify(openRouter.provider)}`);
}
if ('quantizations' in openRouter) refuse('openrouter kept the top-level quantizations member');
if ('provider' in outboundBody('type.openrouterNoProvider')) refuse('openrouter kept an empty provider');

const ollama = outboundBody('type.ollama');
if (Object.keys(ollama).join(',') !== 'model,prompt,stream,keep_alive,raw,options') {
    refuse(`ollama rebuilt body member order is ${Object.keys(ollama).join(',')}`);
}
if (ollama.raw !== true || ollama.stream !== false) refuse(`ollama literal members are wrong: ${JSON.stringify(ollama)}`);
if ((ollama.options || {}).num_predict !== 5 || 'not_allowed' in (ollama.options || {})) refuse(`ollama options allowlist is wrong: ${JSON.stringify(ollama.options)}`);

// ── headers: the secret set per type, plus the two literal referer headers ────────────────────
function header(name, key) {
    return requireOutbound(name, 0).headers[key];
}
if (header('type.generic', 'content-type') !== 'application/json') refuse('the JSON content type is missing');
if (header('type.generic', 'authorization') !== `Bearer ${SECRETS.api_key_generic}`) refuse('generic key header');
if (header('type.ooba', 'authorization') !== `Bearer ${SECRETS.api_key_ooba}`) refuse('ooba key header');
if (header('type.mancer', 'x-api-key') !== SECRETS.api_key_mancer) refuse('mancer x-api-key');
if (header('type.aphrodite', 'x-api-key') !== SECRETS.api_key_aphrodite) refuse('aphrodite x-api-key');
if (header('type.tabby', 'x-api-key') !== SECRETS.api_key_tabby) refuse('tabby x-api-key');
if (header('type.openrouter', 'http-referer') !== 'https://sillytavern.app') refuse('openrouter http-referer');
if (header('type.featherless', 'x-title') !== 'SillyTavern') refuse('featherless x-title');
if ('authorization' in (requireOutbound('type.ollama', 0).headers)) refuse('ollama has no secret getter and must send no authorization');

// ── response branches ────────────────────────────────────────────────────────────────────────
const nonOk = bodyJSON('response.nonOkForwarded');
if (nonOk.error !== true || nonOk.status !== 500 || nonOk.response !== '{"error":"backend exploded"}') {
    refuse(`a non-ok provider answer must become {error,status,response}: ${JSON.stringify(nonOk)}`);
}
if (scenarios['response.nonOkForwarded'].response.status !== 200) refuse('the error envelope is sent at status 200');

const stream = scenarios['response.stream'];
if (stream.response.status !== 200) refuse(`stream status is ${stream.response.status}`);
if (stream.response.bodyText !== STREAM_BODY) refuse(`the streamed bytes were not forwarded verbatim: ${JSON.stringify(stream.response.bodyText)}`);
if (stream.response.headers['content-type'] !== undefined) refuse(`the stream branch must not invent a content type: ${stream.response.headers['content-type']}`);

const stream401 = scenarios['response.stream401'];
if (stream401.response.status !== 400) refuse(`a streamed 401 must be rewritten to 400, got ${stream401.response.status}`);
if (stream401.response.bodyText !== 'bad key') refuse(`the streamed error text was not forwarded: ${JSON.stringify(stream401.response.bodyText)}`);

if (scenarios['response.streamNonOk'].response.status !== 503) refuse('a streamed 503 keeps its own status');
if (scenarios['request.missingServer'].response.bodyText !== null) refuse('the missing-server branch must be shape-classified');
if (scenarios['request.missingServer'].outbound.length !== 0) refuse('a missing api_server must send nothing');

const throwsEnvelope = bodyJSON('response.throws');
if (throwsEnvelope.error !== true) refuse('a rejected fetch must answer an error envelope');

// ── ollama's SSE re-framing ─────────────────────────────────────────────────────────────────
const ollamaStream = scenarios['type.ollamaStream'].response.bodyText;
const expectedFrame = `data: ${JSON.stringify({ choices: [{ text: 'a', thinking: 't' }] })}\n\n`;
if (ollamaStream !== `${expectedFrame}data: [DONE]\n\n`) {
    refuse(`ollama stream framing is ${JSON.stringify(ollamaStream)}`);
}

if (bootOutbound.length !== 0) refuse('the pinned boot made an outbound request, so a recording is not the route\'s');

const fixture = {
    schemaVersion: 1,
    baseline: { version: PINNED_VERSION, commit: PINNED_COMMIT },
    probe: 'tools/probe-textgen.mjs',
    route: ROUTE,
    pinnedSource: {
        'src/endpoints/backends/text-completions.js:272': 'POST /generate: localhost->127.0.0.1 rewrite, the api_type suffix switch, per-type pickBy allowlists, ollama body rebuild, stream vs JSON branch, catch envelope',
        'src/endpoints/backends/text-completions.js:29': 'parseOllamaStream: newline-delimited JSON re-framed as `data: {...}\\n\\n`, terminated by `data: [DONE]\\n\\n`',
        'src/endpoints/backends/text-completions.js:80': 'abortKoboldCppRequest: on client close POST `{base}/api/extra/abort` with the additional headers (NOT recorded, see notRecorded)',
        'src/util.js:732': 'forwardFetchResponse: 401 rewritten to 400, no content type set, `from.body.pipe(to)` (the piping is source-derived, not recorded)',
        'src/additional-headers.js': 'setAdditionalHeadersByType: the per-type secret header table plus requestOverrides',
    },
    mechanism: 'The upstream URL comes from request.body.api_server, so no seam exists or is needed: the URL is recorded as `<mock>` and the localhost rewrite port as `<port>`. The pinned server runs unmodified with `node-fetch` AND the global `fetch` replaced by tools/lib/pinned-outbound.mjs, so every outbound request is captured and nothing can reach the network.',
    fields: [
        { path: 'scenarios.*.response.status', comparison: 'compared', reason: 'the route chooses 200 itself and only the stream branch forwards the provider status (401->400)' },
        { path: 'scenarios.*.response.headers', comparison: 'compared', reason: 'Express framing, the JSON content type of res.send(object), and the ABSENCE of a content type on a streamed reply' },
        { path: 'scenarios.*.response.bodyText', comparison: 'compared', reason: 'the re-sent provider JSON, the {error,status,response} envelope, the InfermaticAI choice remap, and the raw streamed bytes' },
        { path: 'scenarios.request.missingServer/response.nonJsonOk.response.*', comparison: 'shape', reason: 'both answer a V8 engine message (a property-read TypeError and a JSON.parse SyntaxError); nulled with their derived content-length/ETag, status and outbound count still compared' },
        { path: 'scenarios.*.outbound[].url', comparison: 'compared', reason: 'the suffix switch, trimV1, and the localhost->127.0.0.1 rewrite are the route\'s destination contract' },
        { path: 'scenarios.*.outbound[].body', comparison: 'compared', reason: 'the per-type allowlist, member order, the generic stop slice, the openrouter provider folding and the ollama rebuild' },
        { path: 'scenarios.*.outbound[].headers', comparison: 'compared', reason: 'the per-type secret header table and the two literal referer headers, asserted in both directions' },
        { path: 'scenarios.*.outbound.length', comparison: 'compared', reason: 'a refusal or a missing api_server must send nothing' },
    ],
    normalizations: [
        'The api_server origin is recorded as `<mock>`; the localhost rewrite target as `127.0.0.1:<port>`. Neither the host nor the port is recorded.',
        'Synthetic secrets only.',
    ],
    notRecorded: [
        'NON-BUFFERING is not recorded: the peer answers one chunk, so a buffered reply cannot distinguish a piping route from a buffering one. The pinned property is source-derived (`from.body.pipe(to)` in src/util.js forwardFetchResponse) and the GO side is proved by an implementation test against a peer that writes a chunk and then BLOCKS. The `holdOpen` rule that would make it recordable lives on an unmerged lane branch and is deliberately NOT taken into this route lane.',
        'the koboldcpp ABORT leg POSTs `{base}/api/extra/abort` on client close; the peer answers immediately, so there is no in-flight request to abandon. Labelled implementation test, pinned parity unobserved.',
        'the Ollama replay of MULTIPLE frames: the peer delivers its body as ONE chunk, so `JSON.parse(partialData)` sees two concatenated objects and the frame loop emits nothing until end. The recorded scenario uses a single frame; multi-frame chunking is a peer property, not a route property.',
        'the two shape-classified bodies (V8 engine text).',
        'requestOverrides from config (the header override table) are not exercised: it needs a boot-time config, and the route reads it only through setAdditionalHeaders.',
    ],
    inputs: {
        cookieSecret: COOKIE_SECRET,
        account: { handle: 'default-user', name: 'Textgen Probe', admin: true, password: '' },
        secrets: SECRETS,
        peer: PINNED_PEER,
        portMarker: PORT_MARKER,
        pinnedPort: PINNED_PORT,
        streamBodySha256: sha256(STREAM_BODY),
    },
    bootOutbound,
    scenarios,
};

writeFixture(repositoryRoot, 'sillytavern-1.19.0-textgen.json', fixture);
console.log(`scenarios: ${Object.keys(scenarios).length}, boot outbound: ${bootOutbound.length}`);
