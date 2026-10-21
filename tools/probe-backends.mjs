#!/usr/bin/env node
// Capture the cheap, deterministic /api/backends/* routes against a controlled peer:
// the nine multimodal-model lists, chat-completions bias, kobold status/embed, llama.cpp
// props/slots, ollama download/caption-image, tabby download, and text-completions status/props.
//
// SCOPE. The streaming/multipart routes (kobold/generate, kobold/transcribe-audio,
// text-completions/generate) and chat-completions/status are NOT probed here; see
// src/endpoints/backends/*.js and the Go implementation notes for the reason they are deferred
// (streaming framing + multipart parsing need their own differential harness, and
// chat-completions/status is a 380-line provider matrix whose source-specific branches each need
// their own provider oracle).
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

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

import {
    PINNED_COMMIT, PINNED_VERSION, startPinnedProviderServer, writeFixture,
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

// ---- fixture assembly ----------------------------------------------------------------------
function stubRule(upstream) {
    return {
        match: upstream.match ?? upstream.path,
        status: upstream.status,
        headers: upstream.headers ?? {},
        body: upstream.body,
        throws: upstream.throws === true,
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

await main();
