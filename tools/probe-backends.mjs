#!/usr/bin/env node
// Capture the cheap, deterministic /api/backends/* routes against a controlled peer:
// the nine multimodal-model lists, chat-completions bias, kobold status/embed, llama.cpp
// props/slots, ollama download/caption-image, tabby download, and text-completions status/props.
//
// SCOPE. This script has TWO waves, selected by argv[4]:
//
//   (default)          the cheap, deterministic routes: the nine multimodal-model lists,
//                      chat-completions bias and process, kobold status/embed, llama.cpp
//                      props/slots, ollama download/caption-image, tabby download, text-completions
//                      status/props, and chat-completions/status (custom source). Fixture
//                      sillytavern-1.19.0-backends.json.
//   args=deferred      the streaming and multipart routes: kobold/generate (a live proxy over an
//                      SSE stream, with the abort path and its error branches) and
//                      kobold/transcribe-audio (a multipart upload). Fixture
//                      sillytavern-1.19.0-backends-deferred.json. text-completions/generate is
//                      still NOT probed here: it is its own lane's route.
//
// The pinned server runs unmodified with its node-fetch module replaced by a controlled peer
// (tools/lib/pinned-outbound.mjs), so every outbound request is recorded and no probe run reaches
// the internet. Hardcoded-host routes are exercised through the stub; body-URL routes are pointed
// at the placeholder peer origin and normalised to <mock>.
//
// Known pinned crash, recorded rather than reproduced: kobold POST /status has no try/catch, so a
// request without api_server throws inside the async handler and the pinned process exits. The
// scenarios that would trigger it are recorded in knownDifferences, not replayed.
//
// @gotavern-oracle: this declaration is read by tools/build-generated-lib.mjs,
// which auto-discovers probes so that adding one needs no edit there.
// @gotavern-oracle: fixture=sillytavern-1.19.0-backends.json label="backend probe routes"
// The streaming/multipart wave is a SECOND run of this script with args=deferred: it needs its own
// fixture (different schema: framing + parsed multipart part lists + upload staging) and its own
// double-run determinism check.
// @gotavern-oracle: fixture=sillytavern-1.19.0-backends-deferred.json label="backend streaming and multipart routes" args=deferred

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';

import {
    PINNED_COMMIT, PINNED_VERSION, sha256, startPinnedProviderServer, writeFixture,
} from './lib/pinned-outbound.mjs';

const sourceRoot = path.resolve(process.argv[2] ?? '');
const repositoryRoot = path.resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3]) {
    console.error('usage: node tools/probe-backends.mjs <pinned-source-clone> <gotavern-root>');
    process.exit(2);
}
if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim() !== PINNED_COMMIT) {
    throw new Error(`upstream checkout is not pinned at ${PINNED_COMMIT}`);
}

const COOKIE_SECRET = 'gotavern-pinned-backends-cookie-secret';
const MOCK = '<mock>';
const PINNED_PEER = 'http://backend-peer.example';
// The localhost-rewrite scenarios need a port that is closed on the pinned side and points at the
// replay's own mock on the Go side; the fixture stores the marker <port> and substitutes per run.
const MOCK_PORT_MARKER = '<port>';
const PINNED_PORT = '59999';

const SECRETS = {
    api_key_chutes: 'probe-chutes-key',
    api_key_mistralai: 'probe-mistral-key',
    api_key_xai: 'probe-xai-key',
    api_key_moonshot: 'probe-moonshot-key',
    api_key_workers_ai: 'probe-workers-key',
    api_key_koboldcpp: 'probe-koboldcpp-key',
    api_key_generic: 'probe-generic-key',
    api_key_tabby: 'probe-tabby-key',
    api_key_custom: 'probe-custom-key',
};

const SEAMS = {
    multimodalPollinations: 'GOTAVERN_BACKENDS_POLLINATIONS_URL',
    multimodalAimlapi: 'GOTAVERN_BACKENDS_AIMLAPI_URL',
    multimodalNanogpt: 'GOTAVERN_BACKENDS_NANOGPT_URL',
    multimodalElectronhub: 'GOTAVERN_BACKENDS_ELECTRONHUB_URL',
    multimodalChutes: 'GOTAVERN_BACKENDS_CHUTES_URL',
    multimodalMistral: 'GOTAVERN_BACKENDS_MISTRAL_URL',
    multimodalXai: 'GOTAVERN_BACKENDS_XAI_URL',
    multimodalMoonshot: 'GOTAVERN_BACKENDS_MOONSHOT_URL',
    multimodalWorkersAi: 'GOTAVERN_BACKENDS_WORKERSAI_URL',
};
const SEAM_DEFAULTS = {
    [SEAMS.multimodalPollinations]: 'https://gen.pollinations.ai',
    [SEAMS.multimodalAimlapi]: 'https://api.aimlapi.com',
    [SEAMS.multimodalNanogpt]: 'https://nano-gpt.com',
    [SEAMS.multimodalElectronhub]: 'https://api.electronhub.ai',
    [SEAMS.multimodalChutes]: 'https://llm.chutes.ai',
    [SEAMS.multimodalMistral]: 'https://api.mistral.ai',
    [SEAMS.multimodalXai]: 'https://api.x.ai',
    [SEAMS.multimodalMoonshot]: 'https://api.moonshot.ai',
    [SEAMS.multimodalWorkersAi]: 'https://api.cloudflare.com',
};

function secretFile(values) {
    const secrets = {};
    for (const [key, value] of Object.entries(values)) {
        secrets[key] = [{ id: `probe-id-${key}`, value, label: key, active: true }];
    }
    return secrets;
}

function materialize(value) {
    if (typeof value === 'string') return value.split(MOCK).join(PINNED_PEER).split('<port>').join(PINNED_PORT);
    if (Array.isArray(value)) return value.map(materialize);
    if (value && typeof value === 'object') {
        const result = {};
        for (const [key, item] of Object.entries(value)) result[key] = materialize(item);
        return result;
    }
    return value;
}

function normalize(value) {
    return typeof value === 'string' ? value.split(PINNED_PEER).join(MOCK) : value;
}

function explicitHeaders(headers) {
    return Object.entries(headers ?? {})
        .map(([name, value]) => [String(name).toLowerCase(), String(value)])
        .sort((left, right) => left[0].localeCompare(right[0]));
}

function captureResponse(result) {
    return {
        status: result.response.status,
        contentType: result.response.headers.get('content-type'),
        contentLength: result.response.headers.get('content-length'),
        etag: result.response.headers.get('etag'),
        specialHeader: result.response.headers.get('x-supports-tokenization'),
        body: normalize(result.text),
    };
}

// The route -> seam map for the hardcoded-host multimodal lists; body-URL routes have no seam.
const ROUTE_SEAMS = {
    'chat-completions/multimodal-models/pollinations': SEAMS.multimodalPollinations,
    'chat-completions/multimodal-models/aimlapi': SEAMS.multimodalAimlapi,
    'chat-completions/multimodal-models/nanogpt': SEAMS.multimodalNanogpt,
    'chat-completions/multimodal-models/electronhub': SEAMS.multimodalElectronhub,
    'chat-completions/multimodal-models/chutes': SEAMS.multimodalChutes,
    'chat-completions/multimodal-models/mistral': SEAMS.multimodalMistral,
    'chat-completions/multimodal-models/xai': SEAMS.multimodalXai,
    'chat-completions/multimodal-models/moonshot': SEAMS.multimodalMoonshot,
    'chat-completions/multimodal-models/workers_ai': SEAMS.multimodalWorkersAi,
};

const scenarios = [];
function addScenario(definition) {
    scenarios.push(definition);
}
const OK = { status: 200, headers: { 'Content-Type': 'application/json' } };

// ---- multimodal model lists -----------------------------------------------------------------
addScenario({
    name: 'multimodal.pollinations.ok',
    route: 'chat-completions/multimodal-models/pollinations',
    upstream: [{
        ...OK, path: '/models', body: JSON.stringify([
            { name: 'text-model', input_modalities: ['text'] },
            { name: 'vision-model', input_modalities: ['text', 'image'] },
            { name: 'no-modalities' },
            { name: 'bad-modalities', input_modalities: 'image' },
        ]),
    }],
});
addScenario({
    name: 'multimodal.pollinations.nonOk',
    route: 'chat-completions/multimodal-models/pollinations',
    upstream: [{ path: '/models', status: 500, body: 'nope' }],
});
addScenario({
    name: 'multimodal.pollinations.notArray',
    route: 'chat-completions/multimodal-models/pollinations',
    upstream: [{ ...OK, path: '/models', body: '{"models":[]}' }],
});
addScenario({
    name: 'multimodal.pollinations.throws',
    route: 'chat-completions/multimodal-models/pollinations',
    upstream: [{ path: '/models', throws: true }],
    // The Go replay cannot make a mock reject one path (the shared recorder has no such mode), so
    // this scenario is replayed through the convention's closed port: same rejected-fetch branch,
    // no outbound request reaches the peer.
    peer: 'closed',
});
addScenario({
    name: 'multimodal.aimlapi.ok',
    route: 'chat-completions/multimodal-models/aimlapi',
    upstream: [{
        ...OK, path: '/v1/models', body: JSON.stringify({ data: [
            { id: 'vision-a', features: ['openai/chat-completion', 'openai/chat-completion.vision'] },
            { id: 'text-b', features: ['openai/chat-completion'] },
            { id: 'no-features' },
        ] }),
    }],
});
addScenario({
    name: 'multimodal.aimlapi.notArray',
    route: 'chat-completions/multimodal-models/aimlapi',
    upstream: [{ ...OK, path: '/v1/models', body: '{}' }],
});
addScenario({
    name: 'multimodal.nanogpt.ok',
    route: 'chat-completions/multimodal-models/nanogpt',
    upstream: [{
        ...OK, path: '/api/v1/models', body: JSON.stringify({ data: [
            { id: 'nano-vision', capabilities: { vision: true } },
            { id: 'nano-text', capabilities: {} },
        ] }),
    }],
});
addScenario({
    name: 'multimodal.electronhub.ok',
    route: 'chat-completions/multimodal-models/electronhub',
    upstream: [{
        ...OK, path: '/v1/models', body: JSON.stringify({ data: [
            { id: 'hub-vision', metadata: { vision: true } },
            { id: 'hub-text', metadata: {} },
        ] }),
    }],
});
addScenario({
    name: 'multimodal.electronhub.missingData',
    route: 'chat-completions/multimodal-models/electronhub',
    upstream: [{ ...OK, path: '/v1/models', body: '{}' }],
});
addScenario({
    name: 'multimodal.chutes.ok',
    route: 'chat-completions/multimodal-models/chutes',
    upstream: [{
        ...OK, path: '/v1/models', body: JSON.stringify({ data: [
            { id: 'chutes-vision', input_modalities: ['text', 'image'] },
            { id: 'chutes-text', input_modalities: ['text'] },
        ] }),
    }],
});
addScenario({
    name: 'multimodal.chutes.noKey',
    route: 'chat-completions/multimodal-models/chutes',
    secrets: { ...SECRETS, api_key_chutes: '' },
});
addScenario({
    name: 'multimodal.mistral.ok',
    route: 'chat-completions/multimodal-models/mistral',
    upstream: [{
        ...OK, path: '/v1/models', body: JSON.stringify({ data: [
            { id: 'mistral-vision', capabilities: { vision: true } },
            { id: 'mistral-text', capabilities: { vision: false } },
        ] }),
    }],
});
addScenario({
    name: 'multimodal.xai.addsGrok',
    route: 'chat-completions/multimodal-models/xai',
    upstream: [{
        ...OK, path: '/v1/language-models', body: JSON.stringify({ models: [
            { id: 'grok-vision', input_modalities: ['text', 'image'] },
            { id: 'grok-text', input_modalities: ['text'] },
        ] }),
    }],
});
addScenario({
    name: 'multimodal.xai.keepsExistingGrok',
    route: 'chat-completions/multimodal-models/xai',
    upstream: [{
        ...OK, path: '/v1/language-models', body: JSON.stringify({ models: [
            { id: 'grok-4-0709', input_modalities: ['text', 'image'] },
        ] }),
    }],
});
addScenario({
    name: 'multimodal.moonshot.ok',
    route: 'chat-completions/multimodal-models/moonshot',
    upstream: [{
        ...OK, path: '/v1/models', body: JSON.stringify({ data: [
            { id: 'moonshot-vision', supports_image_in: true },
            { id: 'moonshot-text', supports_image_in: false },
        ] }),
    }],
});
addScenario({
    name: 'multimodal.workersai.ok',
    route: 'chat-completions/multimodal-models/workers_ai',
    body: { workers_ai_account_id: ' probe-account ' },
    upstream: [{
        ...OK, path: '/client/v4/accounts/probe-account/ai/models/search', body: JSON.stringify({ result: [
            { name: '@cf/vision', properties: [{ property_id: 'vision', value: 'true' }] },
            { name: '@cf/text', properties: [{ property_id: 'vision', value: 'false' }] },
            { name: '@cf/no-properties' },
        ] }),
    }],
});
addScenario({
    name: 'multimodal.workersai.noAccount',
    route: 'chat-completions/multimodal-models/workers_ai',
    body: {},
});

// ---- chat-completions process ---------------------------------------------------------------
const processMessages = [
    { role: 'system', content: 'You are helpful.' },
    { role: 'system', content: 'Be terse.' },
    { role: 'user', content: 'Hi', name: 'Iris' },
    { role: 'assistant', content: 'Hello', name: 'Bot' },
    { role: 'user', content: 'Again' },
    { role: 'tool', content: 'tool result', tool_call_id: 'call-1' },
];
addScenario({ name: 'process.merge', route: 'chat-completions/process', body: { messages: processMessages, type: 'merge', char_name: 'Bot', user_name: 'Iris' } });
addScenario({ name: 'process.mergeTools', route: 'chat-completions/process', body: { messages: processMessages, type: 'merge_tools', char_name: 'Bot', user_name: 'Iris' } });
addScenario({ name: 'process.semi', route: 'chat-completions/process', body: { messages: processMessages, type: 'semi', char_name: 'Bot', user_name: 'Iris' } });
addScenario({ name: 'process.strict', route: 'chat-completions/process', body: { messages: processMessages, type: 'strict', char_name: 'Bot', user_name: 'Iris' } });
addScenario({ name: 'process.single', route: 'chat-completions/process', body: { messages: processMessages, type: 'single', char_name: 'Bot', user_name: 'Iris' } });
addScenario({ name: 'process.none', route: 'chat-completions/process', body: { messages: [{ role: 'user', content: 'Hi' }], type: '' } });
addScenario({ name: 'process.unknownType', route: 'chat-completions/process', body: { messages: [], type: 'bogus' } });
addScenario({ name: 'process.notArray', route: 'chat-completions/process', body: { messages: 'nope', type: 'merge' } });
addScenario({ name: 'process.empty', route: 'chat-completions/process', body: { messages: [], type: 'merge' } });
addScenario({ name: 'process.mediaParts', route: 'chat-completions/process', body: { messages: [
    { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] },
    { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,BBBB' } }] },
], type: 'merge' } });
addScenario({ name: 'process.groupNames', route: 'chat-completions/process', body: {
    messages: [{ role: 'assistant', content: 'Already: prefixed' }, { role: 'assistant', content: 'plain' }],
    type: 'merge', char_name: 'Bot', user_name: 'Iris', group_names: ['Already', 'Other'],
} });

// ---- kobold status / embed ------------------------------------------------------------------
addScenario({
    name: 'kobold.status.ok',
    route: 'kobold/status',
    body: { api_server: `${MOCK}`, api_type: 'koboldcpp' },
    upstream: [
        { ...OK, path: '/v1/info/version', body: '{"result":"1.2.3"}' },
        { ...OK, path: '/extra/version', body: '{"result":"1.70"}' },
        { ...OK, path: '/v1/model', body: '{"result":"kobold-model"}' },
    ],
});
addScenario({
    name: 'kobold.status.modelError',
    route: 'kobold/status',
    body: { api_server: `${MOCK}` },
    upstream: [
        { ...OK, path: '/v1/info/version', body: '{"result":"1.2.3"}' },
        { ...OK, path: '/extra/version', body: '{"result":"1.70"}' },
        { path: '/v1/model', status: 500, body: 'nope' },
    ],
});
addScenario({
    name: 'kobold.status.readOnlyModel',
    route: 'kobold/status',
    body: { api_server: `${MOCK}` },
    upstream: [
        { ...OK, path: '/v1/info/version', body: '{"result":"0.0.1"}' },
        { ...OK, path: '/extra/version', body: '{"result":"1.71"}' },
        { ...OK, path: '/v1/model', body: '{"result":"ReadOnly"}' },
    ],
});
addScenario({
    name: 'kobold.status.versionsFail',
    route: 'kobold/status',
    body: { api_server: `${MOCK}` },
    upstream: [
        { path: '/v1/info/version', status: 500, body: 'nope' },
        { path: '/extra/version', status: 404, body: 'nope' },
        { path: '/v1/model', status: 500, body: 'nope' },
    ],
});
addScenario({
    name: 'kobold.status.localhostRewrite',
    route: 'kobold/status',
    body: { api_server: 'http://localhost:<port>' },
    upstream: [],
});
addScenario({
    name: 'kobold.embed.ok',
    route: 'kobold/embed',
    body: { server: `${MOCK}`, items: ['a', 'b'], api_type: 'koboldcpp' },
    upstream: [{ ...OK, path: '/api/extra/embeddings', body: JSON.stringify({ model: 'embed-model', data: [
        { index: 1, embedding: [2, 2] },
        { index: 0, embedding: [1, 1] },
    ] }) }],
});
addScenario({
    name: 'kobold.embed.arrayItems',
    route: 'kobold/embed',
    body: { server: `${MOCK}`, items: ['a'] },
    upstream: [{ ...OK, path: '/api/extra/embeddings', body: JSON.stringify({ data: [
        [{ index: 0, embedding: [9] }],
    ] }) }],
});
addScenario({
    name: 'kobold.embed.missingData',
    route: 'kobold/embed',
    body: { server: `${MOCK}`, items: ['a'], api_type: 'koboldcpp' },
    upstream: [{ ...OK, path: '/api/extra/embeddings', body: '{"model":"m"}' }],
});
addScenario({
    name: 'kobold.embed.noServer',
    route: 'kobold/embed',
    body: { items: ['a'] },
});
addScenario({
    name: 'kobold.embed.nonJson',
    route: 'kobold/embed',
    body: { server: `${MOCK}`, items: ['a'] },
    upstream: [{ status: 500, path: '/api/extra/embeddings', body: 'not json' }],
});

// ---- text-completions status / props --------------------------------------------------------
addScenario({
    name: 'textgen.status.ok',
    route: 'text-completions/status',
    body: { api_server: `${MOCK}/v1`, api_type: 'generic', api_key: 'x' },
    upstream: [{ ...OK, path: '/v1/models', body: '{"data":[{"id":"model-b"},{"id":"model-a"}]}' }],
});
addScenario({
    name: 'textgen.status.ooba',
    route: 'text-completions/status',
    body: { api_server: `${MOCK}`, api_type: 'ooba' },
    upstream: [
        { ...OK, path: '/v1/models', body: '{"data":[{"id":"loaded-model"}]}' },
        { ...OK, path: '/v1/internal/model/info', body: '{"model_name":"my-model"}' },
    ],
});
addScenario({
    name: 'textgen.status.tabby',
    route: 'text-completions/status',
    body: { api_server: `${MOCK}`, api_type: 'tabby' },
    upstream: [
        { ...OK, path: '/v1/model/list', body: '{"data":[{"id":"tabby-one"}]}' },
        { ...OK, path: '/v1/model', body: '{"id":"tabby-loaded"}' },
    ],
});
addScenario({
    name: 'textgen.status.tabbyNoModel',
    route: 'text-completions/status',
    body: { api_server: `${MOCK}`, api_type: 'tabby' },
    upstream: [
        { ...OK, path: '/v1/model/list', body: '{"data":[{"id":"tabby-one"}]}' },
        { path: '/v1/model', status: 400, body: '{"error":"no model"}' },
    ],
});
addScenario({
    name: 'textgen.status.ollama',
    route: 'text-completions/status',
    body: { api_server: `${MOCK}`, api_type: 'ollama' },
    upstream: [{ ...OK, path: '/api/tags', body: '{"models":[{"name":"llama3:latest"}]}' }],
});
addScenario({
    name: 'textgen.status.togetherai',
    route: 'text-completions/status',
    body: { api_server: `${MOCK}`, api_type: 'togetherai' },
    upstream: [{ ...OK, path: '/api/models', body: '[{"name":"together-model"}]' }],
});
addScenario({
    name: 'textgen.status.huggingface',
    route: 'text-completions/status',
    body: { api_server: `${MOCK}`, api_type: 'huggingface' },
    upstream: [{ ...OK, path: '/info', body: '{"data":[{"id":"hf-model"}]}' }],
});
addScenario({
    name: 'textgen.status.nonOk',
    route: 'text-completions/status',
    body: { api_server: `${MOCK}`, api_type: 'generic' },
    upstream: [{ path: '/v1/models', status: 500, body: 'nope' }],
});
addScenario({
    name: 'textgen.status.notArray',
    route: 'text-completions/status',
    body: { api_server: `${MOCK}`, api_type: 'generic' },
    upstream: [{ ...OK, path: '/v1/models', body: '{"models":[]}' }],
});
addScenario({
    name: 'textgen.status.localhostRewrite',
    route: 'text-completions/status',
    body: { api_server: 'http://localhost:<port>', api_type: 'generic' },
});
addScenario({
    name: 'textgen.status.koboldcppKey',
    route: 'text-completions/status',
    body: { api_server: `${MOCK}`, api_type: 'koboldcpp' },
    upstream: [{ ...OK, path: '/v1/models', body: '{"data":[]}' }],
});
addScenario({
    name: 'textgen.props.ok',
    route: 'text-completions/props',
    body: { api_server: `${MOCK}/v1`, api_type: 'ooba' },
    upstream: [{ ...OK, path: '/props', body: '{"chat_template":"{{prompt}}","n_ctx":4096}' }],
});
addScenario({
    name: 'textgen.props.llamacppNulTemplate',
    route: 'text-completions/props',
    body: { api_server: `${MOCK}`, api_type: 'llamacpp', model: 'some model' },
    upstream: [{ ...OK, path: '/props', body: '{"chat_template":"template\\u0000"}' }],
});
addScenario({
    name: 'textgen.props.missingTemplate',
    route: 'text-completions/props',
    body: { api_server: `${MOCK}`, api_type: 'generic' },
    upstream: [{ ...OK, path: '/props', body: '{"n_ctx":2048}' }],
});
addScenario({
    name: 'textgen.props.missingServer',
    route: 'text-completions/props',
    body: {},
});
addScenario({
    name: 'textgen.props.nonOk',
    route: 'text-completions/props',
    body: { api_server: `${MOCK}` },
    upstream: [{ path: '/props', status: 500, body: 'nope' }],
});
addScenario({
    name: 'textgen.props.nonJson',
    route: 'text-completions/props',
    body: { api_server: `${MOCK}` },
    upstream: [{ ...OK, path: '/props', body: 'not json' }],
});

// ---- llamacpp / ollama / tabby management ---------------------------------------------------
addScenario({
    name: 'llamacpp.props.ok',
    route: 'text-completions/llamacpp/props',
    body: { server_url: `${MOCK}/v1` },
    upstream: [{ ...OK, path: '/props', body: '{"n_ctx":4096,"model_path":"/models/x.gguf"}' }],
});
addScenario({
    name: 'llamacpp.props.missingServer',
    route: 'text-completions/llamacpp/props',
    body: {},
});
addScenario({
    name: 'llamacpp.props.nonOk',
    route: 'text-completions/llamacpp/props',
    body: { server_url: `${MOCK}` },
    upstream: [{ path: '/props', status: 500, body: 'nope' }],
});
addScenario({
    name: 'llamacpp.slots.info',
    route: 'text-completions/llamacpp/slots',
    body: { server_url: `${MOCK}`, action: 'info' },
    upstream: [{ ...OK, path: '/slots', body: '[{"id":0,"is_processing":false}]' }],
});
addScenario({
    name: 'llamacpp.slots.save',
    route: 'text-completions/llamacpp/slots',
    body: { server_url: `${MOCK}`, action: 'save', id_slot: 0, filename: 'slot.bin' },
    upstream: [{ ...OK, path: '/slots/0', body: '{"id_slot":0}' }],
});
addScenario({
    name: 'llamacpp.slots.erase',
    route: 'text-completions/llamacpp/slots',
    body: { server_url: `${MOCK}`, action: 'erase', id_slot: 1 },
    upstream: [{ ...OK, path: '/slots/1', body: '{"id_slot":1}' }],
});
addScenario({
    name: 'llamacpp.slots.invalidAction',
    route: 'text-completions/llamacpp/slots',
    body: { server_url: `${MOCK}`, action: 'bogus' },
});
addScenario({
    name: 'llamacpp.slots.invalidSlot',
    route: 'text-completions/llamacpp/slots',
    body: { server_url: `${MOCK}`, action: 'save', id_slot: 'x', filename: 'f' },
});
addScenario({
    name: 'llamacpp.slots.saveMissingFilename',
    route: 'text-completions/llamacpp/slots',
    body: { server_url: `${MOCK}`, action: 'save', id_slot: 0 },
});
addScenario({
    name: 'ollama.download.ok',
    route: 'text-completions/ollama/download',
    body: { name: 'llama3', api_server: `${MOCK}/` },
    upstream: [{ ...OK, path: '/api/pull', body: '{"status":"success"}' }],
});
addScenario({
    name: 'ollama.download.missingParams',
    route: 'text-completions/ollama/download',
    body: { name: 'llama3' },
});
addScenario({
    name: 'ollama.download.nonOk',
    route: 'text-completions/ollama/download',
    body: { name: 'llama3', api_server: `${MOCK}` },
    upstream: [{ path: '/api/pull', status: 500, body: 'nope' }],
});
addScenario({
    name: 'ollama.caption.ok',
    route: 'text-completions/ollama/caption-image',
    body: { server_url: `${MOCK}/v1`, model: 'llava', prompt: 'Describe', image: 'QUJD' },
    upstream: [{ ...OK, path: '/api/generate', body: '{"response":"A cat."}' }],
});
addScenario({
    name: 'ollama.caption.empty',
    route: 'text-completions/ollama/caption-image',
    body: { server_url: `${MOCK}`, model: 'llava', prompt: 'Describe', image: 'QUJD' },
    upstream: [{ ...OK, path: '/api/generate', body: '{"response":""}' }],
});
addScenario({
    name: 'ollama.caption.missingParams',
    route: 'text-completions/ollama/caption-image',
    body: { server_url: `${MOCK}`, prompt: 'Describe' },
});
addScenario({
    name: 'ollama.caption.nonOk',
    route: 'text-completions/ollama/caption-image',
    body: { server_url: `${MOCK}`, model: 'llava', prompt: 'Describe', image: 'QUJD' },
    upstream: [{ path: '/api/generate', status: 500, body: 'nope' }],
});
addScenario({
    name: 'tabby.download.ok',
    route: 'text-completions/tabby/download',
    body: { api_server: `${MOCK}/`, api_type: 'tabby', model_name: 'some-model' },
    upstream: [
        { ...OK, path: '/v1/auth/permission', body: '{"permission":"admin"}' },
        { ...OK, path: '/v1/download', body: '{"status":"ok"}' },
    ],
});
addScenario({
    name: 'tabby.download.notAdmin',
    route: 'text-completions/tabby/download',
    body: { api_server: `${MOCK}`, api_type: 'tabby', model_name: 'some-model' },
    upstream: [{ ...OK, path: '/v1/auth/permission', body: '{"permission":"read"}' }],
});
addScenario({
    name: 'tabby.download.permissionError',
    route: 'text-completions/tabby/download',
    body: { api_server: `${MOCK}`, api_type: 'tabby', model_name: 'some-model' },
    upstream: [{ path: '/v1/auth/permission', status: 500, body: 'nope' }],
});
addScenario({
    name: 'tabby.download.keyHeaders',
    route: 'text-completions/tabby/download',
    body: { api_server: `${MOCK}`, api_type: 'tabby', model_name: 'some-model', secret_id: null },
    upstream: [
        { ...OK, path: '/v1/auth/permission', body: '{"permission":"admin"}' },
        { ...OK, path: '/v1/download', body: '{}' },
    ],
});

// ---- biasing --------------------------------------------------------------------------------
addScenario({
    name: 'bias.emptyBody',
    route: 'chat-completions/bias',
    body: {},
    query: '?model=gpt-3.5-turbo',
});
addScenario({
    name: 'bias.claudeSkips',
    route: 'chat-completions/bias',
    body: [{ text: 'hello', value: 5 }],
    query: '?model=claude-3-haiku',
});
addScenario({
    name: 'bias.openai',
    route: 'chat-completions/bias',
    body: [{ text: 'hello', value: 5 }, { text: 'world', value: -3 }, { text: '', value: 1 }, { value: 2 }, null],
    query: '?model=gpt-3.5-turbo',
});
addScenario({
    name: 'bias.tokenIdJson',
    route: 'chat-completions/bias',
    body: [{ text: '[1, 2, 3]', value: 7 }, { text: '[1, "x"]', value: 8 }],
    query: '?model=gpt-3.5-turbo',
});
addScenario({
    name: 'bias.noModel',
    route: 'chat-completions/bias',
    body: [{ text: 'hello', value: 5 }],
});

// ---- chat-completions/status (custom source) ------------------------------------------------
// The pinned route joins urlJoin(custom_url, "/models"), GETs it with the custom key, passes an
// OK body through unchanged, and answers `{ error: true, data: { data: [] } }` for a non-OK
// response and `{ error: true }` when the fetch throws. Only the CUSTOM branch is implemented;
// every other source answers 501 in Go (rule 17) and is therefore not recorded here.
addScenario({
    name: 'status.custom.ok',
    route: 'chat-completions/status',
    body: { chat_completion_source: 'custom', custom_url: `${MOCK}/v1` },
    upstream: [{ ...OK, path: '/v1/models', body: JSON.stringify({ data: [{ id: 'model-b' }, { id: 'model-a' }] }) }],
});
addScenario({
    name: 'status.custom.noPath',
    route: 'chat-completions/status',
    body: { chat_completion_source: 'custom', custom_url: MOCK },
    upstream: [{ ...OK, path: '/models', body: JSON.stringify({ data: [{ id: 'only-model' }] }) }],
});
addScenario({
    name: 'status.custom.nonOk',
    route: 'chat-completions/status',
    body: { chat_completion_source: 'custom', custom_url: `${MOCK}/v1` },
    upstream: [{ path: '/v1/models', status: 401, headers: { 'Content-Type': 'application/json' }, body: '{"error":"bad key"}' }],
});
addScenario({
    name: 'status.custom.throws',
    route: 'chat-completions/status',
    body: { chat_completion_source: 'custom', custom_url: `${MOCK}/v1` },
    upstream: [{ path: '/v1/models', throws: true }],
    peer: 'closed',
});
addScenario({
    name: 'status.custom.includeHeaders',
    route: 'chat-completions/status',
    body: { chat_completion_source: 'custom', custom_url: `${MOCK}/v1`, custom_include_headers: 'X-Probe-Header: probe-value' },
    upstream: [{ ...OK, path: '/v1/models', body: '{"data":[]}' }],
});
addScenario({
    name: 'status.custom.missingUrl',
    route: 'chat-completions/status',
    body: { chat_completion_source: 'custom' },
});
// ---- CLAUDE has NO ARM in the status matrix ---------------------------------------------------
//
// chat-completions.js:1787-2065 is the chain of `chat_completion_source === ...` branches, and
// CHAT_COMPLETION_SOURCES.CLAUDE is not one of them (it appears only in the GENERATE dispatch at
// :2260). So `apiUrl` and `apiKey` keep their `''` initialisers and the shared guard at :2067 fires
// first -- 400 {"error":true} with NO outbound request. Both observables are recorded because a Go
// implementation that answered 501 (as it did before this wave) and one that invented a branch are
// different from the pinned answer in different ways.
addScenario({
    name: 'status.claude.noBranch',
    route: 'chat-completions/status',
    body: { chat_completion_source: 'claude' },
});
// With a reverse_proxy present the :2067 guard is skipped, and the next statement is
// `new URL(urlJoin('', '/models'))`, i.e. the RELATIVE URL '/models', which throws; the pinned catch
// answers 200 {"error":true} -- still with no outbound request.
addScenario({
    name: 'status.claude.reverseProxy',
    route: 'chat-completions/status',
    body: { chat_completion_source: 'claude', reverse_proxy: 'https://probe.invalid/v1', proxy_password: 'probe' },
});
// ---- deferred wave: kobold/generate (streaming) and kobold/transcribe-audio (multipart) ------
//
// WHY THIS WAVE OBSERVES OVER A RAW SOCKET. Every other scenario in this probe captures through
// fetch(), which decodes chunked framing. A streamed reply and a buffered one are byte-identical
// once the stream has FINISHED, so a fetch capture cannot tell them apart: it loses the
// Transfer-Encoding, the chunk boundaries and the presence or absence of the terminal chunk. Every
// scenario below is exchanged over a raw TCP socket and recorded as a status + header list + frame
// list + terminator. The NON-STREAM CONTROL (`kobold.generate.nonStream`) is recorded with the same
// reader and carries a Content-Length and no frames, so a buffered reply can never be read as a
// streamed one.
//
// THE UPSTREAM HOLDS ITS RESPONSE OPEN for the streaming scenarios (the stub's additive `holdOpen`
// rule). That is the only way to observe the property the route exists for: a client receives the
// upstream's bytes while the upstream has not finished, which a buffering implementation cannot do.
// Killing the client socket then exercises the pinned abort path (`request.socket.on('close')` ->
// POST `${api_server}/extra/abort` when `can_abort`), which is an outbound request and is recorded.
//
// MULTIPART. transcribe-audio reads `request.file`, and the only file the pinned server stages is
// the one the GLOBAL multer middleware accepts: `multer(...).single('avatar')`
// (src/server-main.js:269), so a part named anything else never becomes a file. The upload is built
// with a FIXED boundary so its bytes are deterministic, and it is recorded as a PARSED PART LIST
// (name order, filename, content type, digest, length). The probe asserts every part list is
// non-empty: a consumed stream would record zero parts, which looks exactly like "never sent". The
// staging directory (<dataRoot>/_uploads) is snapshotted before and after every transcribe
// scenario, because the pinned route unlinks its staged file on the paths that reach the fetch and
// LEAVES IT BEHIND on the two 400 paths; multer's random filename is recorded as <upload>.
//
// NOT PROBED, and recorded as a derivation instead (see derivedOnly in the fixture): the
// `if (!request.body) return sendStatus(400)` branch (body-parser sets `req.body = req.body || {}`
// before any handler, so it is unreachable) and the 403/503 retry loop (node-fetch does not throw
// on an HTTP status, so `error.status` is never 403/503 and the loop cannot be entered).

const DEFERRED_FIXTURE = 'sillytavern-1.19.0-backends-deferred.json';
const DEFERRED_BOUNDARY = 'gotavern-kobold-probe-boundary';
// Three SSE events in ONE upstream write. The frame list proves the reply was forwarded as the
// upstream wrote it; the SSE list proves the payload is the upstream payload.
const STREAM_COMPLETE_FRAMES = 'data: {"token":"Once"}\n\ndata: {"token":" upon"}\n\ndata: {"token":" a time."}\n\n';
// Deliberately the SAME bytes tests/mockprovider writes for its hold-open response, so the pinned
// capture and the Go replay can compare the held frame byte for byte.
const STREAM_HOLD_FRAME = 'data: {"held":true}\n\n';
const AUDIO_PAYLOAD = 'ID3v2 gbt-kobold-transcription-probe-payload';

// Both are wall-clock values: the pinned server and the Go server each stamp their own, so a
// recorded value could only be compared against an invented one. X-Response-Time's PRESENCE is
// asserted by the replay instead (it is the pinned global middleware, src/server-main.js:108).
const DEFERRED_RESPONSE_HEADERS_NOT_RECORDED = {
    date: 'the server clock, different on every request and on every host',
    'x-response-time': 'the pinned global middleware measures wall-clock latency; presence is asserted, the value is not',
};
// Recorded for the read, asserted by nothing, because they are not route-controlled.
const DEFERRED_RESPONSE_HEADERS_TRANSPORT = {
    connection: 'transport-owned: Node answers keep-alive, Go omits the header for HTTP/1.1',
    'keep-alive': 'transport-owned: Node announces its idle timeout, Go does not emit the header at all',
};

function deferredHeaderValue(headers, name) {
    for (const [key, value] of headers) if (key === name) return value;
    return undefined;
}

function parseRawResponseHead(rawHead) {
    const lines = rawHead.split('\r\n');
    const statusLine = lines.shift() ?? '';
    const status = Number((statusLine.split(' ')[1] ?? '0'));
    const headers = lines.filter(line => line !== '').map(line => {
        const colon = line.indexOf(':');
        return [line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim()];
    });
    return { statusLine, status, headers };
}

// exchangeRaw sends one request and reads the response itself, so the framing is visible.
// `stopAfterFirstFrame` resolves as soon as the first body frame has arrived, which is how a reply
// that is still open is observed; the caller then owns the socket and is expected to destroy it.
function exchangeRaw({ origin, route, headers, body, stopAfterFirstFrame = false, timeoutMs = 20000, label }) {
    return new Promise((resolve, reject) => {
        const target = new URL(origin);
        const socket = net.connect({ host: target.hostname, port: Number(target.port) });
        let buffer = Buffer.alloc(0);
        let head = null;
        let frames = [];
        let terminated = false;
        let serverEnded = false;
        let settled = false;
        const timer = setTimeout(() => {
            fail(new Error(`${label}: the raw exchange timed out after ${timeoutMs}ms `
                + `(head ${head ? 'received' : 'missing'}, frames ${frames.length}, terminated ${terminated})`));
        }, timeoutMs);
        const fail = error => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            socket.destroy();
            reject(error);
        };
        const settle = (extra = {}) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            const chunked = (deferredHeaderValue(head.headers, 'transfer-encoding') ?? '').toLowerCase().includes('chunked');
            const declared = deferredHeaderValue(head.headers, 'content-length');
            const payload = chunked
                ? Buffer.concat(frames.map(frame => Buffer.from(frame.hex, 'hex')))
                : buffer.slice(0, declared === undefined ? buffer.length : Math.min(Number(declared), buffer.length));
            resolve({
                socket,
                status: head.status,
                headers: head.headers,
                framing: {
                    transferEncoding: deferredHeaderValue(head.headers, 'transfer-encoding') ?? null,
                    contentLength: declared ?? null,
                    frames,
                    terminated,
                    serverEnded,
                },
                bodyBytes: payload,
                ...extra,
            });
        };
        const pump = () => {
            if (settled) return;
            if (head === null) {
                const split = buffer.indexOf('\r\n\r\n');
                if (split < 0) return;
                head = parseRawResponseHead(buffer.slice(0, split).toString('latin1'));
                buffer = buffer.slice(split + 4);
            }
            const chunked = (deferredHeaderValue(head.headers, 'transfer-encoding') ?? '').toLowerCase().includes('chunked');
            if (chunked) {
                for (;;) {
                    const lineEnd = buffer.indexOf('\r\n');
                    if (lineEnd < 0) break;
                    const sizeText = buffer.slice(0, lineEnd).toString('latin1').split(';')[0].trim();
                    const size = parseInt(sizeText, 16);
                    if (!Number.isFinite(size)) {
                        fail(new Error(`${label}: malformed chunk size ${JSON.stringify(sizeText)}`));
                        return;
                    }
                    if (size === 0) {
                        if (buffer.length < lineEnd + 4) break;
                        terminated = true;
                        buffer = buffer.slice(lineEnd + 4);
                        break;
                    }
                    if (buffer.length < lineEnd + 2 + size + 2) break;
                    const payload = buffer.slice(lineEnd + 2, lineEnd + 2 + size);
                    frames.push({ hex: payload.toString('hex'), text: payload.toString('utf8'), bytes: size });
                    buffer = buffer.slice(lineEnd + 2 + size + 2);
                }
            }
            if (stopAfterFirstFrame && frames.length > 0) {
                settle({ stoppedAfterFirstFrame: true });
                return;
            }
            const declared = deferredHeaderValue(head.headers, 'content-length');
            const complete = chunked
                ? terminated
                : (declared !== undefined ? buffer.length >= Number(declared) : serverEnded);
            if (complete) settle({ stoppedAfterFirstFrame: false });
        };
        socket.on('connect', () => {
            const head = [`POST ${route} HTTP/1.1`, `Host: ${target.host}`];
            for (const [name, value] of Object.entries(headers)) head.push(`${name}: ${value}`);
            head.push(`Content-Length: ${body.length}`, '', '');
            socket.write(Buffer.from(head.join('\r\n'), 'latin1'));
            if (body.length > 0) socket.write(body);
        });
        socket.on('data', chunk => {
            buffer = Buffer.concat([buffer, chunk]);
            pump();
        });
        socket.on('end', () => {
            serverEnded = true;
            pump();
        });
        socket.on('close', () => {
            serverEnded = true;
            pump();
        });
        socket.on('error', error => fail(new Error(`${label}: ${error.message}`)));
    });
}

function buildMultipart(parts) {
    const chunks = [];
    for (const part of parts) {
        let head = `--${DEFERRED_BOUNDARY}\r\nContent-Disposition: form-data; name="${part.name}"`;
        if (part.filename !== undefined) head += `; filename="${part.filename}"`;
        head += '\r\n';
        if (part.contentType !== undefined) head += `Content-Type: ${part.contentType}\r\n`;
        head += '\r\n';
        chunks.push(Buffer.from(head, 'utf8'));
        chunks.push(Buffer.from(String(part.value), 'utf8'));
        chunks.push(Buffer.from('\r\n', 'utf8'));
    }
    chunks.push(Buffer.from(`--${DEFERRED_BOUNDARY}--\r\n`, 'utf8'));
    return Buffer.concat(chunks);
}

// The parsed part list is what an upstream observes of a multipart body whose boundary is random.
function multipartPartList(parts) {
    // `value` is recorded (with the peer origin normalised to <mock>) because the replay has to
    // REBUILD the same upload: a part list without the part contents would describe a request the
    // Go side could not construct.
    return parts.map(part => ({
        name: part.name,
        filename: part.filename ?? null,
        contentType: part.contentType ?? null,
        value: normalizeDeferred(String(part.value)),
        bytes: Buffer.byteLength(String(part.value), 'utf8'),
        sha256: sha256(String(part.value)),
    }));
}

function snapshotUploads(directory) {
    if (!existsSync(directory)) return [];
    return readdirSync(directory).sort().map(name => {
        const full = path.join(directory, name);
        const content = readFileSync(full);
        return { name: '<upload>', bytes: content.length, sha256: sha256(content) };
    });
}

function describeOutbound(request) {
    return {
        method: request.method,
        url: normalizeDeferred(request.url),
        explicitHeaders: explicitHeaders(request.headers),
        body: request.body === null || request.body === undefined ? null : normalizeDeferred(String(request.body)),
    };
}

function parseSSE(text) {
    const events = [];
    let event = null;
    let data = [];
    const flush = () => {
        if (data.length > 0 || event !== null) events.push({ event, data: data.join('\n') });
        event = null;
        data = [];
    };
    for (const rawLine of text.split('\n')) {
        const line = rawLine.replace(/\r$/, '');
        if (line === '') { flush(); continue; }
        if (line.startsWith('event:')) event = line.slice('event:'.length).trim();
        else if (line.startsWith('data:')) data.push(line.slice('data:'.length).replace(/^ /, ''));
    }
    flush();
    return events;
}

// <port> marks the pinned localhost-rewrite port (a host-derived value); <mock> marks the peer origin.
function normalizeDeferred(value) {
    if (typeof value !== 'string') return value;
    return value.split(PINNED_PEER).join(MOCK).split(PINNED_PORT).join(MOCK_PORT_MARKER);
}

// A request that must NOT arrive needs a window in which its absence is observed. Returning as soon
// as the EXPECTED count is reached cannot see a LATE extra request, which is exactly the case the
// `can_abort` negative exists for: the abort request is issued from the socket-close handler, after
// the response the expected request produced. Without the settle window the fixture recorded a
// count that could not fail -- measured: mutation G3c (can_abort ignored) survived CI twice. So the
// drain always keeps collecting for `settleMs` after the expected count arrives, and the count
// assertion below sees anything that lands in that window.
const DEFERRED_OUTBOUND_SETTLE_MS = 400;

async function drainDeferredOutbound(server, expected, windowMs) {
    const collected = [];
    const deadline = Date.now() + windowMs;
    let settledAt = null;
    for (;;) {
        collected.push(...server.outbound());
        if (collected.length >= expected) {
            if (settledAt === null) settledAt = Date.now() + DEFERRED_OUTBOUND_SETTLE_MS;
            if (Date.now() >= settledAt) return collected;
        } else if (Date.now() > deadline) {
            return collected;
        }
        await new Promise(resolve => setTimeout(resolve, 25));
    }
}

const deferredScenarios = [];
function addDeferredScenario(definition) { deferredScenarios.push(definition); }

const KOBOLD_GENERATE_SETTINGS = {
    api_server: MOCK,
    prompt: 'Once upon a time',
    max_context_length: 2048,
    max_length: 120,
    rep_pen: 1.1,
    rep_pen_range: 320,
    rep_pen_slope: 0.7,
    temperature: 0.8,
    tfs: 0.9,
    top_a: 0.5,
    top_k: 40,
    top_p: 0.95,
    min_p: 0.05,
    typical: 1,
    sampler_order: [0, 1, 2, 3, 4, 5, 6],
    singleline: 'yes',
    use_default_badwordsids: false,
    mirostat: 2,
    mirostat_eta: 0.2,
    mirostat_tau: 5,
    grammar: 'root ::= "a"',
    sampler_seed: 42,
    stop_sequence: ['\nUser:'],
    streaming: false,
    can_abort: true,
    api_type: 'koboldcpp',
};

addDeferredScenario({
    name: 'kobold.generate.nonStream',
    route: 'kobold/generate',
    // `gui_settings` absent -> the FULL settings object. `singleline: 'yes'` is a truthy non-boolean
    // so `!!` is observable, and `api_type: koboldcpp` with the koboldcpp secret set proves the
    // route applies NO api-type key header (`getOverrideHeaders` only, not `setAdditionalHeaders`).
    body: { ...KOBOLD_GENERATE_SETTINGS, gui_settings: false },
    upstream: [{
        ...OK, path: '/v1/generate',
        body: '{"results":[{"text":"Once upon"}],"model":"kobold-model"}',
    }],
    expectedOutbound: 1,
});
addDeferredScenario({
    name: 'kobold.generate.guiSettings',
    // `gui_settings` truthy -> the seven-member object, and `stop_sequence` is NOT added there.
    body: {
        api_server: MOCK, prompt: 'hi', gui_settings: true, max_context_length: 512, max_length: 8,
        temperature: 2, sampler_seed: 7, stop_sequence: ['x'], singleline: 0, streaming: false,
    },
    upstream: [{ ...OK, path: '/v1/generate', body: '{"results":[{"text":"hi"}]}' }],
    expectedOutbound: 1,
});
addDeferredScenario({
    name: 'kobold.generate.missingPrompt',
    // No `prompt` member: JSON.stringify omits an undefined value, so the upstream body has none.
    body: { api_server: MOCK, gui_settings: true, max_context_length: 100, max_length: 10 },
    upstream: [{ ...OK, path: '/v1/generate', body: '{"results":[]}' }],
    expectedOutbound: 1,
});
addDeferredScenario({
    name: 'kobold.generate.localhostRewrite',
    body: { api_server: 'http://localhost:<port>', prompt: 'p', gui_settings: true, max_context_length: 1, max_length: 1 },
    upstream: [{ ...OK, path: '/v1/generate', body: '{"results":[{"text":"p"}]}' }],
    expectedOutbound: 1,
});
addDeferredScenario({
    name: 'kobold.generate.nonOkJson',
    body: { api_server: MOCK, prompt: 'too long', gui_settings: true, max_context_length: 1, max_length: 1 },
    upstream: [{ path: '/v1/generate', status: 400, headers: { 'Content-Type': 'application/json' }, body: '{"detail":{"msg":"context too long"}}' }],
    expectedOutbound: 1,
});
addDeferredScenario({
    name: 'kobold.generate.nonOkText',
    body: { api_server: MOCK, prompt: 'boom', gui_settings: true, max_context_length: 1, max_length: 1 },
    upstream: [{ path: '/v1/generate', status: 503, body: 'please retry later' }],
    expectedOutbound: 1,
});
addDeferredScenario({
    name: 'kobold.generate.transportFailure',
    // The stub throws for this rule; the Go replay uses the convention's closed port instead.
    body: { api_server: MOCK, prompt: 'boom', gui_settings: true, max_context_length: 1, max_length: 1 },
    upstream: [{ path: '/v1/generate', throws: true }],
    expectedOutbound: 1,
    peer: 'closed',
});
addDeferredScenario({
    name: 'kobold.generate.streamCompletes',
    // The full stream: one upstream write, one client frame, and the terminal zero-length chunk.
    body: { api_server: MOCK, prompt: 'Once upon a time', gui_settings: true, max_context_length: 64, max_length: 32, streaming: true, can_abort: false },
    upstream: [{ path: '/extra/generate/stream', status: 200, headers: { 'Content-Type': 'text/event-stream' }, body: STREAM_COMPLETE_FRAMES }],
    expectedOutbound: 1,
});
addDeferredScenario({
    name: 'kobold.generate.streamHoldOpenAbort',
    // The upstream never finishes. The client only receives anything at all if the reply is
    // FORWARDED, and destroying the socket then has to reach `${api_server}/extra/abort`.
    body: { api_server: MOCK, prompt: 'hold', gui_settings: true, max_context_length: 64, max_length: 32, streaming: true, can_abort: true },
    upstream: [
        { path: '/extra/abort', status: 200, body: '{"ok":true}' },
        { path: '/extra/generate/stream', status: 200, headers: { 'Content-Type': 'text/event-stream' }, body: STREAM_HOLD_FRAME, holdOpen: true },
    ],
    stopAfterFirstFrame: true,
    disconnectAfterFirstFrame: true,
    expectedOutbound: 2,
});
addDeferredScenario({
    name: 'kobold.generate.streamHoldOpenNoAbort',
    // Same held-open upstream with `can_abort` false: the abort POST must NOT happen. The positive
    // scenario above calibrates the drain window this negative one is measured with.
    body: { api_server: MOCK, prompt: 'hold', gui_settings: true, max_context_length: 64, max_length: 32, streaming: true },
    upstream: [
        { path: '/extra/abort', status: 200, body: '{"ok":true}' },
        { path: '/extra/generate/stream', status: 200, headers: { 'Content-Type': 'text/event-stream' }, body: STREAM_HOLD_FRAME, holdOpen: true },
    ],
    stopAfterFirstFrame: true,
    disconnectAfterFirstFrame: true,
    expectedOutbound: 1,
});
addDeferredScenario({
    name: 'kobold.generate.streamNonOk401',
    // A streamed reply rewrites 401 to 400 (`forwardFetchResponse`) and ends with the raw error text
    // as one chunk, with no content type.
    body: { api_server: MOCK, prompt: 'bad key', gui_settings: true, max_context_length: 8, max_length: 8, streaming: true, can_abort: false },
    upstream: [{ path: '/extra/generate/stream', status: 401, body: 'bad key' }],
    expectedOutbound: 1,
});

function transcribeForm(parts) { return parts; }
addDeferredScenario({
    name: 'kobold.transcribe.ok',
    route: 'kobold/transcribe-audio',
    // The only field name the global multer middleware accepts is `avatar`.
    form: transcribeForm([
        { name: 'server', value: MOCK },
        { name: 'avatar', filename: 'probe.mp3', contentType: 'audio/mpeg', value: AUDIO_PAYLOAD },
    ]),
    upstream: [{ ...OK, path: '/api/extra/transcribe', body: '{"text":"hello there"}' }],
    expectedOutbound: 1,
});
addDeferredScenario({
    name: 'kobold.transcribe.wrongFieldName',
    route: 'kobold/transcribe-audio',
    bodyShape: 'a rendered Express error page: multer rejects a file field it does not expect with LIMIT_UNEXPECTED_FILE, the pinned error handler renders it in dev mode, and the page embeds a stack trace with absolute paths',
    // A part named `file` is never `request.file`, so the route answers 400 and the staged upload is
    // LEFT in <dataRoot>/_uploads (the pinned leak).
    form: transcribeForm([
        { name: 'server', value: MOCK },
        { name: 'file', filename: 'probe.mp3', contentType: 'audio/mpeg', value: AUDIO_PAYLOAD },
    ]),
    upstream: [],
    expectedOutbound: 0,
});
addDeferredScenario({
    name: 'kobold.transcribe.noServer',
    route: 'kobold/transcribe-audio',
    form: transcribeForm([
        { name: 'avatar', filename: 'probe.mp3', contentType: 'audio/mpeg', value: AUDIO_PAYLOAD },
    ]),
    upstream: [],
    expectedOutbound: 0,
});
addDeferredScenario({
    name: 'kobold.transcribe.nonOk',
    route: 'kobold/transcribe-audio',
    form: transcribeForm([
        { name: 'server', value: MOCK },
        { name: 'avatar', filename: 'probe.mp3', contentType: 'audio/mpeg', value: AUDIO_PAYLOAD },
    ]),
    upstream: [{ path: '/api/extra/transcribe', status: 500, body: 'transcribe failed' }],
    expectedOutbound: 1,
});
addDeferredScenario({
    name: 'kobold.transcribe.invalidServer',
    route: 'kobold/transcribe-audio',
    // `new URL('not a url')` throws AFTER the staged file is read and unlinked, so the file is gone
    // and the catch answers 'Internal server error'.
    form: transcribeForm([
        { name: 'server', value: 'not a url' },
        { name: 'avatar', filename: 'probe.mp3', contentType: 'audio/mpeg', value: AUDIO_PAYLOAD },
    ]),
    upstream: [],
    expectedOutbound: 0,
});
addDeferredScenario({
    name: 'kobold.transcribe.secretAndQuery',
    route: 'kobold/transcribe-audio',
    // `url.pathname = '/api/extra/transcribe'` replaces the path and KEEPS the query, and the
    // koboldcpp secret reaches the upstream as a Bearer header.
    form: transcribeForm([
        { name: 'server', value: `${MOCK}/base/path?k=a%2Fb&j=k%3Dl` },
        { name: 'avatar', filename: 'probe.mp3', contentType: 'audio/mpeg', value: AUDIO_PAYLOAD },
    ]),
    upstream: [{ ...OK, path: '/api/extra/transcribe', body: '{"text":"query kept"}' }],
    expectedOutbound: 1,
});

async function captureDeferredScenario(server, scenario) {
    server.writeSecrets(secretFile(materialize(scenario.secrets ?? SECRETS)));
    server.setMocks((scenario.upstream ?? []).map(stubRule));
    const parts = scenario.form ? materialize(scenario.form) : null;
    const body = parts
        ? buildMultipart(parts)
        : Buffer.from(JSON.stringify(materialize(scenario.body ?? {})), 'utf8');
    const headers = {
        Cookie: server.session.cookie,
        'X-CSRF-Token': server.session.csrfToken,
    };
    if (parts) headers['Content-Type'] = `multipart/form-data; boundary=${DEFERRED_BOUNDARY}`;
    else headers['Content-Type'] = 'application/json';

    // Every generate scenario shares the route; the transcribe scenarios name it explicitly.
    const scenarioRoute = scenario.route ?? 'kobold/generate';
    const uploadsBefore = snapshotUploads(server.uploadsRoot);
    const exchange = await exchangeRaw({
        origin: server.origin,
        route: `/api/backends/${scenarioRoute}`,
        headers,
        body,
        stopAfterFirstFrame: scenario.stopAfterFirstFrame === true,
        label: scenario.name,
    });
    if (scenario.disconnectAfterFirstFrame === true) {
        // A client that stops a stream: the connection is aborted, which is the pinned
        // socket-close path. destroy() (RST) is what a browser's cancel produces.
        exchange.socket.destroy();
    } else {
        // A completed exchange: end() sends a FIN rather than an RST, so the server is never
        // left with an RST while it is still draining a request body.
        exchange.socket.end();
    }
    const outbound = await drainDeferredOutbound(server, scenario.expectedOutbound, scenario.disconnectAfterFirstFrame ? 8000 : 1500);
    const uploadsAfter = snapshotUploads(server.uploadsRoot);
    if (outbound.length !== scenario.expectedOutbound) {
        throw new Error(`${scenario.name}: ${outbound.length} outbound request(s), expected ${scenario.expectedOutbound}: `
            + JSON.stringify(outbound.map(request => `${request.method} ${request.url}`))
            + ` | response ${exchange.status} ${JSON.stringify(exchange.headers)} `
            + `body ${JSON.stringify(exchange.bodyBytes.toString('utf8').slice(0, 400))} `
            + `| mocks ${JSON.stringify((scenario.upstream ?? []).map(rule => rule.path))}`);
    }
    if (parts && parts.length === 0) {
        throw new Error(`${scenario.name}: the multipart request records zero parts, which looks exactly like "never sent"`);
    }

    // A rendered error page has no host-independent form: the pinned Express handler in dev mode
    // embeds a stack with absolute paths. Rule: classify from the host-INDEPENDENT property of the
    // scenario ("this body is a rendered error page"), record null, and null the DERIVED fields too
    // (content-length measures those bytes and the ETag hashes them).
    const bodyShape = scenario.bodyShape ?? null;
    const bodyText = exchange.bodyBytes.toString('utf8');
    // The REQUEST bytes, not the response body: the replay sends this text verbatim, so recording
    // anything else would describe a request the pinned server never received.
    const request = parts
        ? { kind: 'multipart', boundary: DEFERRED_BOUNDARY, parts: multipartPartList(parts) }
        : { kind: 'json', bodyText: normalizeDeferred(body.toString('utf8')) };
    if (bodyShape) {
        // The pinned answer is a RENDERED ERROR PAGE: its header set and body are the error
        // renderer's (a stack with absolute paths), so only the host-independent observables are
        // recorded -- the status it chose and the outbound requests it did not make.
        return {
            request,
            status: exchange.status,
            headers: null,
            framing: null,
            bodyText: null,
            bodyBytes: null,
            bodySha256: null,
            sse: null,
            outbound: outbound.map(describeOutbound),
            uploadsBefore,
            uploadsAfter,
            comparison: {
                compared: ['status', 'outbound', 'uploads'],
                shape: ['headers', 'framing', 'body'],
                shapeReason: {
                    headers: `the rendered error page's header set is the error renderer's, not this route's: ${bodyShape}`,
                    framing: `the rendered error page is framed by the error renderer: ${bodyShape}`,
                    body: bodyShape,
                },
                notCompared: [],
            },
        };
    }
    const compared = ['status', 'headers', 'framing', 'body', 'outbound', 'uploads'];
    const shape = ['headers.connection', 'headers.keep-alive'];
    return {
        request,
        status: exchange.status,
        headers: exchange.headers.filter(([name]) => !(name in DEFERRED_RESPONSE_HEADERS_NOT_RECORDED)),
        framing: exchange.framing,
        bodyText: normalizeDeferred(bodyText),
        bodyBytes: exchange.bodyBytes.length,
        bodySha256: sha256(exchange.bodyBytes),
        sse: parseSSE(bodyText),
        outbound: outbound.map(describeOutbound),
        uploadsBefore,
        uploadsAfter,
        comparison: {
            compared,
            shape,
            shapeReason: Object.fromEntries(shape
                .map(key => [key, DEFERRED_RESPONSE_HEADERS_TRANSPORT[key.slice('headers.'.length)]])),
            notCompared: Object.entries(DEFERRED_RESPONSE_HEADERS_TRANSPORT)
                .filter(([name]) => !shape.includes(`headers.${name}`))
                .map(([name, reason]) => ({ observable: `headers.${name}`, reason })),
        },
    };
}

async function recordDeferredWave() {
    const server = await startPinnedProviderServer({ sourceRoot, prefix: 'gotavern-backends-deferred-oracle-', mocks: [] });
    try {
        const scenarios = [];
        // A failure is COLLECTED rather than thrown on the first scenario: one pinned boot is
        // expensive, and a run that stops at scenario 2 says nothing about scenarios 3..17. Every
        // failure names its scenario and the mocks it was served, and NOTHING is written when one
        // occurred, so a partially recorded wave can never become a fixture.
        const failures = [];
        for (const scenario of deferredScenarios) {
            let observation;
            try {
                observation = await captureDeferredScenario(server, scenario);
            } catch (error) {
                failures.push(`${scenario.name}: ${error.message}\n    pinned server log tail:\n      `
                    + server.logs.join('').split(String.fromCharCode(10)).slice(-12).join(String.fromCharCode(10, 32, 32, 32, 32, 32, 32)));
                console.error(`${scenario.name}: FAILED ${error.message}`);
                continue;
            }
            const snippet = observation.status >= 300 && observation.bodyText !== null
                ? ` body ${JSON.stringify(observation.bodyText.slice(0, 160))}` : '';
            console.log(`${scenario.name}: status ${observation.status} outbound ${observation.outbound.length} `
                + `uploads ${observation.uploadsBefore.length}->${observation.uploadsAfter.length} `
                + (observation.framing === null ? 'framing not recorded (rendered error page)' : `frames ${observation.framing.frames.length} terminated ${observation.framing.terminated}`)
                + snippet);
            scenarios.push({
                name: scenario.name,
                route: scenario.route ?? 'kobold/generate',
                routePath: `/api/backends/${scenario.route ?? 'kobold/generate'}`,
                body: scenario.body ?? null,
                form: scenario.form ?? null,
                upstream: scenario.upstream ?? [],
                replayed: true,
                peer: scenario.peer ?? 'mock',
                stopAfterFirstFrame: scenario.stopAfterFirstFrame === true,
                disconnectAfterFirstFrame: scenario.disconnectAfterFirstFrame === true,
                expectedOutbound: scenario.expectedOutbound,
                observation,
            });
        }
        const fixture = {
            schemaVersion: 1,
            baseline: { version: PINNED_VERSION, commit: PINNED_COMMIT },
            probe: 'pinned /api/backends deferred routes: kobold generate (streaming, abort, error branches) and kobold transcribe-audio (multipart)',
            oracle: {
                file: 'src/endpoints/backends/kobold.js',
                routes: ['POST /api/backends/kobold/generate (kobold.js:11)', 'POST /api/backends/kobold/transcribe-audio (kobold.js:190)'],
                mountedAt: '/api/backends/kobold (src/server-startup.js:179)',
                uploadMiddleware: "multer({ dest: dataRoot/_uploads }).single('avatar') (src/server-main.js:269) plus multerMonkeyPatch",
            },
            conventions: {
                ordered: 'scenarios is an ARRAY and the replay MUST iterate it in order: every step shares ONE data root, and the transcribe 400 paths leave a staged upload behind, so step N sees what step N-1 left.',
                observation: 'each scenario is exchanged over a raw socket so the status, the FULL header list, the chunk framing and the terminator are observables; a fetch-based capture would decode all of them away',
                mock: 'body-URL peers are recorded as the <mock> marker and the pinned localhost-rewrite port as <port>; the Go replay substitutes its own local origin',
                outboundHeaderModel: 'explicitHeaders are the header object the route passed, lowercased and sorted; node-fetch 3 lowercases and SORTS them (node_modules/node-fetch/src/headers.js), so this is also the order they reach the peer relative to each other. Transport headers (Host, Connection) are not visible to the stub and are asserted on the Go side from nodeFetchWireDefaults instead.',
                multipart: 'the upload is built with a fixed boundary and recorded as a parsed part list; the real boundary is whatever the client sends, so the raw bytes are never compared',
                multipartParts: 'parts[].bytes and parts[].sha256 describe the value the PINNED server received, with the peer origin materialized; parts[].value is the same text with the <mock>/<port> markers restored, which is what the replay rebuilds and materializes against its own origin',
                uploads: "the staging directory is recorded as [{name: '<upload>', bytes, sha256}] because multer's filename is random",
                frames: 'framing.frames are the chunked-transfer payloads in arrival order; framing.terminated reports the terminal zero-length chunk. A reply that is still open when the client disconnects has terminated:false.',
            },
            nodeFetchWireDefaults: {
                headers: [['accept', '*/*'], ['accept-encoding', 'gzip, deflate, br'], ['user-agent', 'node-fetch']],
                verifiedBy: 'tests/oracle/sillytavern-1.19.0-sd-routes.json records the same defaults on the pinned wire',
                limitation: 'the stub sees the header OBJECT the route passed, before node-fetch adds its defaults, so a request with no body cannot show whether node-fetch would have added `content-length: 0`',
            },
            fixtureFields: {
                compared: ['scenarios[].observation.status', 'scenarios[].observation.headers', 'scenarios[].observation.framing', 'scenarios[].observation.bodyText', 'scenarios[].observation.bodySha256', 'scenarios[].observation.outbound[] (method, url, explicitHeaders, body)', 'scenarios[].observation.uploadsBefore/After', 'scenarios[].observation.sse'],
                shape: ['observation.headers connection/keep-alive (presence only)', 'observation.headers x-powered-by (recorded, asserted by nothing)'],
                notRecorded: ['Date', 'X-Response-Time value', 'the ephemeral peer authority', 'the pinned listen port', 'the multer staging filename', 'startup log'],
            },
            excludedHeaders: DEFERRED_RESPONSE_HEADERS_NOT_RECORDED,
            inputs: {
                cookieSecret: COOKIE_SECRET,
                account: { handle: 'default-user', name: 'Backends Deferred Probe', admin: true, password: '' },
                secrets: SECRETS,
                scenarios,
            },
            derivedOnly: [{
                branch: 'kobold/generate: `if (!request.body) return response_generate.sendStatus(400)`',
                reason: 'UNREACHABLE, so no oracle exists. Both global body parsers run before any handler and body-parser 1.20.4 starts with `req.body = req.body || {}` (node_modules/body-parser/lib/types/json.js:108), so request.body is always an object by the time the route runs. Probed instead: a JSON body that omits api_server (kobold.generate.missingPrompt) reaches the handler with a body and no prompt. The Go handler reproduces the observable, not the dead branch.',
            }, {
                branch: 'kobold/generate: the 403/503 retry loop (MAX_RETRIES 50, delay 2500ms)',
                reason: 'UNREACHABLE through the pinned transport, so no oracle exists: the switch reads `error.status`, and node-fetch throws a TypeError/FetchError with no `status` member only on a transport failure, while an HTTP 403/503 is a resolved response that takes the non-ok branch. A transport failure therefore falls to `default` and answers {error:true} on the first attempt, which IS recorded (kobold.generate.transportFailure). The Go handler makes one attempt and answers the same; it does not implement a retry loop it cannot observe.',
            }, {
                branch: 'kobold/generate: a missing or non-string api_server',
                reason: 'the pinned handler throws on `request.body.api_server.indexOf` inside an async handler with no try/catch and the process exits (the same crash the sibling /status row records). Not replayed against the pinned server, because it would kill the probe mid-wave. GoTavern answers 500, the documented deviation.',
            }, {
                branch: 'kobold/generate: requestOverrides config headers (getOverrideHeaders)',
                reason: 'the pinned config keys `requestOverrides[].hosts/.headers` are not projected into HTTPHandlerOptions, so GoTavern applies no override headers. The scenarios set none, so every capture records the object with only content-type.',
            }],
            knownDifferences: [{
                route: '/api/backends/kobold/generate',
                status: 'crash and dead branches recorded, not reproduced',
                reason: 'see derivedOnly: the body-parser guard and the 403/503 retry loop are unreachable, and a missing api_server exits the pinned process.',
            }],
        };
        if (failures.length > 0) {
            throw new Error(`${failures.length} deferred scenario(s) failed; the fixture was NOT written:\n  ${failures.join('\n  ')}`);
        }
        writeFixture(repositoryRoot, DEFERRED_FIXTURE, fixture);
        console.log(`Wrote tests/oracle/${DEFERRED_FIXTURE} from pinned /api/backends deferred behaviour (${scenarios.length} scenarios)`);
    } finally {
        await server.stop();
    }
}

// ---- fixture assembly ----------------------------------------------------------------------
function stubRule(upstream) {
    return {
        match: upstream.match ?? upstream.path,
        status: upstream.status,
        headers: upstream.headers ?? {},
        body: upstream.body,
        throws: upstream.throws === true,
        holdOpen: upstream.holdOpen === true,
    };
}

async function main() {
    const server = await startPinnedProviderServer({ sourceRoot, prefix: 'gotavern-backends-oracle-', mocks: [] });
    try {
        const observations = {};
        const inputs = {};
        for (const scenario of scenarios) {
            const secrets = materialize(scenario.secrets ?? SECRETS);
            server.writeSecrets(secretFile(secrets));
            server.setMocks((scenario.upstream ?? []).map(stubRule));
            const routeWithQuery = `${scenario.route}${scenario.query ?? ''}`;
            const body = materialize(scenario.body ?? {});
            const result = await server.post(`/api/backends/${routeWithQuery}`, JSON.stringify(body));
            const outbound = server.outbound().map(request => ({
                url: normalize(request.url),
                method: request.method,
                explicitHeaders: explicitHeaders(request.headers),
                body: normalize(request.body ?? ''),
            }));
            const captured = captureResponse(result);
            inputs[scenario.name] = {
                route: scenario.route,
                query: scenario.query ?? '',
                body: scenario.body ?? {},
                bodyText: JSON.stringify(scenario.body ?? {}),
                seam: scenario.seam ?? ROUTE_SEAMS[scenario.route] ?? null,
                secrets,
                upstream: scenario.upstream ?? [],
                replayed: scenario.replayed !== false,
                peer: scenario.peer ?? 'mock',
            };
            if (scenario.replayed === false) {
                observations[scenario.name] = { skipped: true, reason: scenario.reason ?? '' };
                continue;
            }
            const comparison = {
                compared: ['status', 'contentType', 'contentLength', 'etag', 'specialHeader', 'body', 'outbound'],
                shape: ['outbound[].transportConnection'],
                shapeReason: {
                    'outbound[].transportConnection': 'the stub records the headers the route passed, not the transport Connection Node would append; the value is a property of the shared outbound client, so the replay asserts presence only',
                },
            };
            if (captured.body.includes(MOCK)) {
                comparison.compared = comparison.compared.filter(key => key !== 'contentLength' && key !== 'etag');
                comparison.shape.push('contentLength', 'etag');
                comparison.shapeReason.contentLength = 'the response body embeds the <mock> peer origin, whose byte length differs from the replay mock authority';
                comparison.shapeReason.etag = 'the ETag derives from the same origin-bearing body';
            }
            observations[scenario.name] = { ...captured, outbound, comparison };
        }

        const knownDifferences = [{
            route: '/api/backends/kobold/status',
            status: 'pinned crash not reproduced',
            reason: 'the pinned handler has no try/catch; a request without api_server throws inside the async handler and the pinned process exits. GoTavern answers 500 and keeps serving. Recorded, not replayed.',
        }, {
            routesL: ['/api/backends/kobold/generate', '/api/backends/kobold/transcribe-audio', '/api/backends/text-completions/generate', '/api/backends/chat-completions/status'],
            status: 'not implemented this round',
            reason: 'the two generate routes proxy live provider streams (SSE and Ollama JSON-frame streams) with cancellation, retry and per-api-type body filtering; transcribe-audio needs multipart upload and a transcription peer; chat-completions/status is a 380-line source matrix. Each needs its own oracle and harness, so they are deferred rather than faked.',
        }];

        const fixture = {
            schemaVersion: 1,
            baseline: { version: PINNED_VERSION, commit: PINNED_COMMIT },
            probe: 'pinned /api/backends cheap routes: multimodal lists, process, kobold status/embed, textgen status/props, llamacpp/ollama/tabby management, bias',
            oracle: { file: 'src/endpoints/backends/chat-completions.js, kobold.js, text-completions.js', mountedAt: '/api/backends (src/server-startup.js)' },
            conventions: {
                mock: 'body-URL peers are recorded as the <mock> marker; the Go replay substitutes its own local mock origin',
                outboundHeaderModel: 'explicitHeaders are the header object the route passed, lowercased and sorted as node-fetch sends them; nodeFetchWireDefaults are asserted separately',
            },
            nodeFetchWireDefaults: {
                headers: [['accept', '*/*'], ['accept-encoding', 'gzip, deflate, br'], ['user-agent', 'node-fetch']],
                verifiedBy: 'tests/oracle/sillytavern-1.19.0-sd-routes.json records the same defaults on the pinned wire',
            },
            fixtureFields: {
                compared: ['observations.*.status', 'observations.*.contentType', 'observations.*.contentLength', 'observations.*.etag', 'observations.*.specialHeader', 'observations.*.body', 'observations.*.outbound[] (url, method, explicitHeaders, body)', 'nodeFetchWireDefaults.headers'],
                shape: ['observations.*.outbound[].transportConnection'],
                notRecorded: ['the ephemeral peer authority', 'the pinned server listen port', 'startup log'],
            },
            inputs: {
                cookieSecret: COOKIE_SECRET,
                account: { handle: 'default-user', name: 'Backends Probe', admin: true, password: '' },
                seamDefaults: SEAM_DEFAULTS,
                scenarios: inputs,
            },
            observations,
            knownDifferences,
        };
        writeFixture(repositoryRoot, 'sillytavern-1.19.0-backends.json', fixture);
        console.log('Wrote tests/oracle/sillytavern-1.19.0-backends.json from pinned /api/backends behaviour');
    } finally {
        await server.stop();
    }
}

if (process.argv[4] === 'deferred') {
    await recordDeferredWave();
} else {
    await main();
}
