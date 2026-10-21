#!/usr/bin/env node
// @gotavern-oracle: fixture=sillytavern-1.19.0-openai-models.json label="openai model lists"
// Probe the pinned /api/openai/* model-list routes against the REAL pinned server with its
// node-fetch replaced by a controlled peer (tools/lib/pinned-outbound.mjs explains why a module hook
// is the only honest option for these hardcoded URLs).
//
// Each route has a DIFFERENT projection over the third-party answer, so each projection is pinned
// against a controlled payload: ElectronHub unwraps `data.data`, Chutes unwraps `items`, NanoGPT and
// SiliconFlow unwrap `data.data`, and Workers AI unwraps `result` and adds `id: m.name` through an
// object spread (which keeps the member ORDER of the source object and OMITS an undefined id).

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

import {
    PINNED_COMMIT, PINNED_VERSION, captureHttp, startPinnedProviderServer, writeFixture,
} from './lib/pinned-outbound.mjs';

const sourceRoot = path.resolve(process.argv[2] ?? '');
const repositoryRoot = path.resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3]) {
    console.error('usage: node tools/probe-openai-models.mjs <pinned-source-clone> <gotavern-root>');
    process.exit(2);
}
if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim() !== PINNED_COMMIT) {
    throw new Error(`upstream checkout is not pinned at ${PINNED_COMMIT}`);
}

const UPSTREAM = {
    electronhub: 'https://api.electronhub.ai',
    chutes: 'https://api.chutes.ai',
    nanogpt: 'https://nano-gpt.com',
    siliconflowCN: 'https://api.siliconflow.cn',
    siliconflowCOM: 'https://api.siliconflow.com',
    cloudflare: 'https://api.cloudflare.com',
};

const KEYS = {
    electronhub: 'sk-synthetic-electronhub',
    chutes: 'sk-synthetic-chutes',
    nanogpt: 'sk-synthetic-nanogpt',
    siliconflow: 'sk-synthetic-siliconflow',
    workersai: 'sk-synthetic-workers-ai',
};

function secretEntry(key, value) {
    return { [key]: [{ id: `sid-${key}`, value, label: key, active: true }] };
}

// Every route's controlled peer answer and the exact projection the pinned handler applies.
const MODELS_PAYLOAD = { data: [{ id: 'model-b', name: 'Model B', object: 'model' }, { id: 'model-a' }] };
const CHUTES_PAYLOAD = { items: [{ chute_id: 'chute-2', name: 'Chute Two' }, { chute_id: 'chute-1', name: 'Chute One' }] };
const WORKERS_PAYLOAD = { result: [{ name: 'worker-b', task: { name: 'Text Embeddings' } }, { name: 'worker-a', task: { name: 'Text Embeddings' }, properties: { dim: 768 } }] };

// label, route, request body, secrets, and the controlled peer rule.
const SCENARIOS = [
    // â”€â”€ ElectronHub: unwraps data.data, answers the array as-is â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    { label: 'electronhubNoKey', route: '/api/openai/electronhub/models', body: '{}', secrets: {}, match: 'api.electronhub.ai' },
    { label: 'electronhubOk', route: '/api/openai/electronhub/models', body: '{}', secrets: secretEntry('api_key_electronhub', KEYS.electronhub), match: 'api.electronhub.ai', payload: MODELS_PAYLOAD },
    { label: 'electronhubNotArray', route: '/api/openai/electronhub/models', body: '{}', secrets: secretEntry('api_key_electronhub', KEYS.electronhub), match: 'api.electronhub.ai', payload: { data: 'nope' } },
    { label: 'electronhubNonOk', route: '/api/openai/electronhub/models', body: '{}', secrets: secretEntry('api_key_electronhub', KEYS.electronhub), match: 'api.electronhub.ai', status: 503, statusText: 'Service Unavailable', text: 'upstream exploded' },
    { label: 'electronhubInvalidJSON', route: '/api/openai/electronhub/models', body: '{}', secrets: secretEntry('api_key_electronhub', KEYS.electronhub), match: 'api.electronhub.ai', raw: 'not json' },
    { label: 'electronhubThrows', route: '/api/openai/electronhub/models', body: '{}', secrets: secretEntry('api_key_electronhub', KEYS.electronhub), match: 'api.electronhub.ai', throws: true },

    // â”€â”€ Chutes: unwraps items â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    { label: 'chutesNoKey', route: '/api/openai/chutes/models/embedding', body: '{}', secrets: {}, match: 'api.chutes.ai' },
    { label: 'chutesOk', route: '/api/openai/chutes/models/embedding', body: '{}', secrets: secretEntry('api_key_chutes', KEYS.chutes), match: 'api.chutes.ai', payload: CHUTES_PAYLOAD },
    { label: 'chutesNotArray', route: '/api/openai/chutes/models/embedding', body: '{}', secrets: secretEntry('api_key_chutes', KEYS.chutes), match: 'api.chutes.ai', payload: { items: null } },
    { label: 'chutesNonOk', route: '/api/openai/chutes/models/embedding', body: '{}', secrets: secretEntry('api_key_chutes', KEYS.chutes), match: 'api.chutes.ai', status: 500, statusText: 'Internal Server Error', text: 'chutes says no' },
    { label: 'chutesThrows', route: '/api/openai/chutes/models/embedding', body: '{}', secrets: secretEntry('api_key_chutes', KEYS.chutes), match: 'api.chutes.ai', throws: true },

    // â”€â”€ NanoGPT: unwraps data.data â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    { label: 'nanogptNoKey', route: '/api/openai/nanogpt/models/embedding', body: '{}', secrets: {}, match: 'nano-gpt.com' },
    { label: 'nanogptOk', route: '/api/openai/nanogpt/models/embedding', body: '{}', secrets: secretEntry('api_key_nanogpt', KEYS.nanogpt), match: 'nano-gpt.com', payload: MODELS_PAYLOAD },
    { label: 'nanogptNotArray', route: '/api/openai/nanogpt/models/embedding', body: '{}', secrets: secretEntry('api_key_nanogpt', KEYS.nanogpt), match: 'nano-gpt.com', payload: { data: {} } },
    { label: 'nanogptNonOk', route: '/api/openai/nanogpt/models/embedding', body: '{}', secrets: secretEntry('api_key_nanogpt', KEYS.nanogpt), match: 'nano-gpt.com', status: 429, statusText: 'Too Many Requests', text: 'slow down' },
    { label: 'nanogptThrows', route: '/api/openai/nanogpt/models/embedding', body: '{}', secrets: secretEntry('api_key_nanogpt', KEYS.nanogpt), match: 'nano-gpt.com', throws: true },

    // â”€â”€ SiliconFlow: endpoint selection changes the URL, unwraps data.data â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    { label: 'siliconflowNoKey', route: '/api/openai/siliconflow/models/embedding', body: '{}', secrets: {}, match: 'api.siliconflow.' },
    { label: 'siliconflowGlobal', route: '/api/openai/siliconflow/models/embedding', body: '{"siliconflow_endpoint":"global"}', secrets: secretEntry('api_key_siliconflow', KEYS.siliconflow), match: 'api.siliconflow.', payload: MODELS_PAYLOAD },
    { label: 'siliconflowCN', route: '/api/openai/siliconflow/models/embedding', body: '{"siliconflow_endpoint":"cn"}', secrets: secretEntry('api_key_siliconflow', KEYS.siliconflow), match: 'api.siliconflow.', payload: MODELS_PAYLOAD },
    { label: 'siliconflowNotArray', route: '/api/openai/siliconflow/models/embedding', body: '{}', secrets: secretEntry('api_key_siliconflow', KEYS.siliconflow), match: 'api.siliconflow.', payload: { data: 5 } },
    { label: 'siliconflowNonOk', route: '/api/openai/siliconflow/models/embedding', body: '{}', secrets: secretEntry('api_key_siliconflow', KEYS.siliconflow), match: 'api.siliconflow.', status: 500, statusText: 'Internal Server Error', text: 'siliconflow says no' },
    { label: 'siliconflowThrows', route: '/api/openai/siliconflow/models/embedding', body: '{}', secrets: secretEntry('api_key_siliconflow', KEYS.siliconflow), match: 'api.siliconflow.', throws: true },

    // â”€â”€ Workers AI: account id in the body, unwraps result and adds id: name â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    { label: 'workersNoKey', route: '/api/openai/workers-ai/models/embedding', body: '{"workers_ai_account_id":"account-id"}', secrets: {}, match: 'api.cloudflare.com' },
    { label: 'workersNoAccount', route: '/api/openai/workers-ai/models/embedding', body: '{}', secrets: secretEntry('api_key_workers_ai', KEYS.workersai), match: 'api.cloudflare.com' },
    { label: 'workersZeroAccount', route: '/api/openai/workers-ai/models/embedding', body: '{"workers_ai_account_id":0}', secrets: secretEntry('api_key_workers_ai', KEYS.workersai), match: 'api.cloudflare.com' },
    { label: 'workersAccountTrimmed', route: '/api/openai/workers-ai/models/embedding', body: '{"workers_ai_account_id":"  probe account/id  "}', secrets: secretEntry('api_key_workers_ai', KEYS.workersai), match: 'api.cloudflare.com', payload: WORKERS_PAYLOAD },
    { label: 'workersNumericAccount', route: '/api/openai/workers-ai/models/embedding', body: '{"workers_ai_account_id":12345}', secrets: secretEntry('api_key_workers_ai', KEYS.workersai), match: 'api.cloudflare.com', payload: WORKERS_PAYLOAD },
    { label: 'workersNotArray', route: '/api/openai/workers-ai/models/embedding', body: '{"workers_ai_account_id":"a"}', secrets: secretEntry('api_key_workers_ai', KEYS.workersai), match: 'api.cloudflare.com', payload: { result: {} } },
    { label: 'workersNonOk', route: '/api/openai/workers-ai/models/embedding', body: '{"workers_ai_account_id":"a"}', secrets: secretEntry('api_key_workers_ai', KEYS.workersai), match: 'api.cloudflare.com', status: 403, statusText: 'Forbidden', text: 'no workers for you' },
    { label: 'workersThrows', route: '/api/openai/workers-ai/models/embedding', body: '{"workers_ai_account_id":"a"}', secrets: secretEntry('api_key_workers_ai', KEYS.workersai), match: 'api.cloudflare.com', throws: true },
];

const server = await startPinnedProviderServer({ sourceRoot, prefix: 'gotavern-openai-models-oracle-', mocks: [] });
const scenarios = {};
let bootOutbound = [];
try {
    bootOutbound = server.bootOutbound;
    for (const scenario of SCENARIOS) {
        const rule = {
            match: scenario.match,
            status: scenario.status ?? 200,
            statusText: scenario.statusText ?? 'OK',
            headers: { 'content-type': 'application/json' },
            body: scenario.raw ?? (scenario.text !== undefined ? scenario.text : JSON.stringify(scenario.payload ?? {})),
            throws: scenario.throws === true,
        };
        server.setMocks([rule]);
        server.writeSecrets(scenario.secrets);
        const result = await server.post(scenario.route, scenario.body);
        const requests = server.outbound();
        scenarios[scenario.label] = {
            route: scenario.route,
            requestBody: scenario.body,
            mocks: [rule],
            secrets: server.readSecrets(),
            response: captureHttp(result),
            outbound: requests.map(request => ({ url: request.url, method: request.method, headers: request.headers })),
        };
    }
} finally {
    await server.stop();
}

// â”€â”€ assertions: each route's projection, not merely its status â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
assert.equal(scenarios.electronhubNoKey.response.status, 400, 'a missing ElectronHub key answers 400');
assert.equal(scenarios.electronhubNoKey.outbound.length, 0, 'a missing key must not reach the peer');
assert.deepEqual(scenarios.electronhubOk.response.body, MODELS_PAYLOAD.data,
    'ElectronHub answers data.data unchanged, preserving member order and omitted fields');
assert.equal(scenarios.electronhubNotArray.response.status, 200, 'a non-array data.data answers [] with 200');
assert.deepEqual(scenarios.electronhubNotArray.response.body, [], 'a non-array data.data answers an empty list');
assert.equal(scenarios.electronhubNonOk.response.status, 500, 'a non-ok ElectronHub answer is a 500');
assert.equal(scenarios.electronhubNonOk.response.body, 'upstream exploded', 'the peer TEXT is forwarded for ElectronHub');
assert.deepEqual(scenarios.chutesOk.response.body, CHUTES_PAYLOAD.items, 'Chutes answers data.items unchanged');
assert.equal(scenarios.chutesNotArray.response.status, 500, 'a non-array items is a 500 for Chutes');
assert.deepEqual(scenarios.chutesNotArray.response.bodyText, 'Internal Server Error', 'sendStatus(500) writes the status text');
assert.equal(scenarios.chutesNonOk.response.body, 'chutes says no', 'the peer TEXT is forwarded for Chutes');
assert.deepEqual(scenarios.nanogptOk.response.body, MODELS_PAYLOAD.data, 'NanoGPT answers data.data unchanged');
assert.equal(scenarios.nanogptNonOk.response.status, 500, 'a non-ok NanoGPT answer is a 500');
assert.deepEqual(scenarios.siliconflowGlobal.response.body, MODELS_PAYLOAD.data, 'SiliconFlow answers data.data unchanged');
assert.equal(scenarios.siliconflowCN.outbound[0].url.includes('api.siliconflow.cn'), true,
    'siliconflow_endpoint:"cn" selects the .cn upstream');
assert.equal(scenarios.siliconflowGlobal.outbound[0].url.includes('api.siliconflow.com'), true,
    'any other endpoint selects the .com upstream');
assert.deepEqual(scenarios.workersNoKey.response.status, 400, 'a missing Workers AI key answers 400');
assert.equal(scenarios.workersNoAccount.response.status, 400, 'a missing account id answers 400');
assert.equal(scenarios.workersZeroAccount.response.status, 400, 'a ZERO account id is falsy, so it answers 400');
assert.equal(scenarios.workersAccountTrimmed.outbound[0].url.includes('probe%20account%2Fid'), true,
    'the account id is trimmed and encodeURIComponent-encoded into the path');
assert.equal(scenarios.workersNumericAccount.outbound[0].url.includes('/accounts/12345/'), true,
    'a numeric account id is String()-coerced');
assert.deepEqual(scenarios.workersAccountTrimmed.response.body, [
    { name: 'worker-b', task: { name: 'Text Embeddings' }, id: 'worker-b' },
    { name: 'worker-a', task: { name: 'Text Embeddings' }, properties: { dim: 768 }, id: 'worker-a' },
], 'Workers AI spreads each result and APPENDS id: m.name after the existing members');
assert.equal(scenarios.workersNotArray.response.status, 500, 'a non-array result is a 500');
assert.equal(scenarios.workersNonOk.response.body, 'no workers for you', 'the peer TEXT is forwarded for Workers AI');

const fixture = {
    schemaVersion: 1,
    baseline: { version: PINNED_VERSION, commit: PINNED_COMMIT },
    probe: 'tools/probe-openai-models.mjs',
    pinnedSource: {
        'src/endpoints/openai.js:387-416': 'POST /electronhub/models: data.data array, non-ok forwards the peer text',
        'src/endpoints/openai.js:461-495': 'POST /chutes/models/embedding: data.items array, invalid shape is sendStatus(500)',
        'src/endpoints/openai.js:497-532': 'POST /nanogpt/models/embedding: data.data array, Accept-Encoding: identity',
        'src/endpoints/openai.js:534-573': 'POST /siliconflow/models/embedding: SILICONFLOW_ENDPOINT selects .cn or .com',
        'src/endpoints/openai.js:575-617': 'POST /workers-ai/models/embedding: account id encodeURIComponent, result.map(m => ({...m, id: m.name}))',
    },
    mechanism: 'The pinned server runs unmodified; only its node-fetch module is replaced by a controlled peer (tools/lib/pinned-outbound.mjs), because every upstream here is a hardcoded literal with no seam. Each recorded answer required a recorded outbound request.',
    upstream: UPSTREAM,
    fields: [
        { path: 'scenarios.*.response.status', comparison: 'compared', reason: 'the pinned handler chooses 200/400/500 itself' },
        { path: 'scenarios.*.response.headers', comparison: 'compared', reason: 'Express and the pinned middleware stack set them' },
        { path: 'scenarios.*.response.body', comparison: 'compared', reason: 'the pinned unwrapping/projection over a controlled payload, including member order and omitted fields' },
        { path: 'scenarios.*.outbound[].url', comparison: 'compared', reason: 'the constructed upstream URL (endpoint selection, trims, encodeURIComponent) is endpoint behaviour' },
        { path: 'scenarios.*.outbound[].method', comparison: 'compared', reason: 'pinned always uses GET' },
        { path: 'scenarios.*.outbound[].headers', comparison: 'shape', reason: 'only the declared Authorization/Accept headers are asserted' },
        { path: 'model list content', comparison: 'shape', reason: 'third-party data: the fixture supplies the payload and asserts the transformation, never a live list' },
    ],
    normalizations: [
        'No third-party content is recorded as a constant: each payload is supplied by the controlled peer.',
        'Synthetic credentials only; the recorded outbound Authorization values are synthetic.',
    ],
    inputs: { keys: KEYS, payloads: { models: MODELS_PAYLOAD, chutes: CHUTES_PAYLOAD, workers: WORKERS_PAYLOAD } },
    bootOutbound,
    scenarios,
};

const outputFile = writeFixture(repositoryRoot, 'sillytavern-1.19.0-openai-models.json', fixture);
console.log(`scenarios: ${Object.keys(scenarios).length}, boot outbound: ${bootOutbound.length}`);
console.log(`fixture written to ${outputFile}`);
