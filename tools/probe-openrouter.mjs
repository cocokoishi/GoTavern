#!/usr/bin/env node
// @gotavern-oracle: fixture=sillytavern-1.19.0-openrouter.json label="openrouter"
// Probe the pinned /api/openrouter/* routes (credits and the four model lists) against the REAL
// pinned server with its node-fetch replaced by a controlled peer.
//
// Why a module hook: `API_OPENROUTER` is a module constant in src/endpoints/openrouter.js:8, so unlike
// the URLs that come from a secret there is no seam a probe can redirect. tools/lib/pinned-outbound.mjs
// documents the mechanism and the reasoning; the endpoint code itself is unmodified.
//
// Model-list content is third-party data, so the fixture classifies what it asserts: the FILTERING,
// the MAPPING and the ORDER are `compared` (they are pinned endpoint behaviour), while nothing about
// the upstream list itself is recorded as a constant.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

import {
    PINNED_COMMIT, PINNED_VERSION, assertOutbound, captureHttp, startPinnedProviderServer, writeFixture,
} from './lib/pinned-outbound.mjs';

const sourceRoot = path.resolve(process.argv[2] ?? '');
const repositoryRoot = path.resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3]) {
    console.error('usage: node tools/probe-openrouter.mjs <pinned-source-clone> <gotavern-root>');
    process.exit(2);
}
if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim() !== PINNED_COMMIT) {
    throw new Error(`upstream checkout is not pinned at ${PINNED_COMMIT}`);
}

const OPENROUTER_KEY = 'sk-or-synthetic-openrouter-key';
const OPENROUTER_API = 'https://openrouter.ai/api/v1';

// Plain lowercase ASCII ids only. The pinned comparator is `a.id.localeCompare(b.id)`, i.e. the
// HOST's default locale, so an accented or mixed-case id could sort differently on a different
// machine. Lowercase ASCII order is identical in every locale, which keeps the fixture
// host-independent while still discriminating: the payload is deliberately NOT in sorted order, so
// an implementation that skips the sort fails.
const MULTIMODAL_PAYLOAD = {
    data: [
        { id: 'zeta', name: 'Zeta', architecture: { input_modalities: ['image', 'text'], output_modalities: ['text'] } },
        { id: 'only-text', name: 'No Image', architecture: { input_modalities: ['text'], output_modalities: ['text'] } },
        { id: 'alpha', name: 'Alpha', architecture: { input_modalities: ['image'], output_modalities: ['text'] } },
        { id: 'beta', name: 'Beta', architecture: { input_modalities: ['image', 'text'], output_modalities: ['image'] } },
        { id: 'no-architecture' },
        { id: 'bad-modalities', architecture: { input_modalities: 'image', output_modalities: ['text'] } },
        { id: 'gamma', architecture: { input_modalities: ['image'], output_modalities: ['text'] } },
    ],
};
const EMBEDDING_PAYLOAD = {
    data: [
        { id: 'zeta-embed', name: 'Zeta Embed', architecture: { input_modalities: ['text'], output_modalities: ['embeddings'] } },
        { id: 'alpha-embed', name: 'Alpha Embed', architecture: { input_modalities: ['text'], output_modalities: ['embeddings'] } },
        { id: 'not-embedding', name: 'Image Out', architecture: { input_modalities: ['text'], output_modalities: ['image'] } },
    ],
};
const IMAGE_PAYLOAD = {
    data: [
        { id: 'zeta-image', name: 'Zeta Image', architecture: { input_modalities: ['text'], output_modalities: ['image'] } },
        { id: 'no-name', architecture: { input_modalities: ['text'], output_modalities: ['image'] } },
        { id: 'alpha-image', name: 'Alpha Image', architecture: { input_modalities: ['text'], output_modalities: ['image'] } },
    ],
};
const PROVIDERS_PAYLOAD = {
    data: {
        endpoints: [
            { provider_name: 'First Provider', context_length: 8192 },
            { provider_name: 'Second Provider' },
            { context_length: 1 },
        ],
    },
};

const server = await startPinnedProviderServer({ sourceRoot, prefix: 'gotavern-openrouter-oracle-', mocks: [] });
const scenarios = {};
let bootOutbound = [];

async function record(label, route, body, mocks) {
    server.setMocks(mocks);
    const result = await server.post(route, body);
    const requests = server.outbound();
    scenarios[label] = {
        route,
        requestBody: body,
        // The controls the pinned route answered, so the Go test replays the SAME controlled peer
        // instead of a hand-written expectation (rule 4).
        mocks,
        secrets: server.readSecrets(),
        response: captureHttp(result),
        // Provenance: a recorded answer must come from a request the pinned route actually made.
        outbound: requests.map(request => ({ url: request.url, method: request.method, headers: request.headers })),
    };
    return result;
}

const rules = payload => [{ match: OPENROUTER_API, status: 200, statusText: 'OK', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }];
const failing = status => [{ match: OPENROUTER_API, status, statusText: 'Stubbed Failure', headers: { 'content-type': 'text/plain' }, body: 'peer says no' }];
const throwing = () => [{ match: OPENROUTER_API, throws: true }];

try {
    bootOutbound = server.bootOutbound;

    // ── /models/providers ────────────────────────────────────────────────────────────────────────
    await record('providersNoModel', '/api/openrouter/models/providers', '{}', rules({ data: { endpoints: [{ provider_name: 'A' }] } }));
    await record('providersMapped', '/api/openrouter/models/providers', '{"model":"author/model-name"}', rules(PROVIDERS_PAYLOAD));
    await record('providersNoEndpoints', '/api/openrouter/models/providers', '{"model":"m"}', rules({ data: {} }));
    await record('providersNonOk', '/api/openrouter/models/providers', '{"model":"m"}', failing(500));
    await record('providersInvalidJSON', '/api/openrouter/models/providers', '{"model":"m"}', [{ match: OPENROUTER_API, status: 200, body: 'not json' }]);
    await record('providersThrows', '/api/openrouter/models/providers', '{"model":"m"}', throwing());

    // ── /models/multimodal ───────────────────────────────────────────────────────────────────────
    await record('multimodalFiltered', '/api/openrouter/models/multimodal', '{}', rules(MULTIMODAL_PAYLOAD));
    await record('multimodalNonOk', '/api/openrouter/models/multimodal', '{}', failing(503));
    await record('multimodalNotArray', '/api/openrouter/models/multimodal', '{}', rules({ data: 'nope' }));
    await record('multimodalThrows', '/api/openrouter/models/multimodal', '{}', throwing());

    // ── /models/embedding ────────────────────────────────────────────────────────────────────────
    await record('embeddingMapped', '/api/openrouter/models/embedding', '{}', rules(EMBEDDING_PAYLOAD));
    await record('embeddingNonOk', '/api/openrouter/models/embedding', '{}', failing(500));
    await record('embeddingThrows', '/api/openrouter/models/embedding', '{}', throwing());

    // ── /models/image ────────────────────────────────────────────────────────────────────────────
    await record('imageMapped', '/api/openrouter/models/image', '{}', rules(IMAGE_PAYLOAD));
    await record('imageNonOk', '/api/openrouter/models/image', '{}', failing(500));

    // ── /credits ─────────────────────────────────────────────────────────────────────────────────
    // No key: the pinned handler answers 400 BEFORE any request.
    server.writeSecrets({});
    await record('creditsNoKey', '/api/openrouter/credits', '{}', rules({ data: { total_credits: 1, total_usage: 1 } }));
    server.writeSecrets({
        api_key_openrouter: [{ id: 'sid-openrouter-1', value: OPENROUTER_KEY, label: 'or', active: true }],
    });
    await record('creditsComputed', '/api/openrouter/credits', '{}', rules({ data: { total_credits: 10, total_usage: 2.5 } }));
    // `?? 0` defaults only for null/undefined, and the subtraction coerces, so string totals are
    // echoed as strings while `remaining` is a number.
    await record('creditsStringTotals', '/api/openrouter/credits', '{}', rules({ data: { total_credits: '5.5', total_usage: '1.25' } }));
    await record('creditsMissingData', '/api/openrouter/credits', '{}', rules({ data: {} }));
    await record('creditsNonOk', '/api/openrouter/credits', '{}', failing(500));
    await record('creditsThrows', '/api/openrouter/credits', '{}', throwing());
} finally {
    await server.stop();
}

// ── assertions: the fixture must pin behaviour, not merely record a status ──────────────────────
assert.equal(scenarios.creditsNoKey.response.status, 400, 'a missing OpenRouter key answers 400');
assert.equal(scenarios.creditsNoKey.outbound.length, 0, 'a missing key must not reach the peer');
assert.equal(scenarios.providersNonOk.response.status, 200, 'a non-ok provider list is answered as [] with 200');
assert.deepEqual(scenarios.providersNonOk.response.body, [], 'a non-ok provider list is answered as []');
assert.equal(scenarios.providersMapped.response.body.length, 3, 'every endpoint is mapped, including the one without a provider_name');
assert.deepEqual(scenarios.providersMapped.response.body, ['First Provider', 'Second Provider', null],
    'an endpoint without provider_name maps to undefined, which JSON.stringify turns into null inside an array');
assert.deepEqual(scenarios.multimodalFiltered.response.body, ['alpha', 'gamma', 'zeta'],
    'only image->text models survive, mapped to id and sorted by id (localeCompare over lowercase ASCII)');
assert.deepEqual(scenarios.embeddingMapped.response.body, [
    { id: 'alpha-embed', name: 'Alpha Embed' },
    { id: 'zeta-embed', name: 'Zeta Embed' },
], 'embedding models map to {id, name} and are sorted');
assert.deepEqual(scenarios.imageMapped.response.body, [
    { value: 'alpha-image', text: 'Alpha Image' },
    { value: 'no-name', text: 'no-name' },
    { value: 'zeta-image', text: 'Zeta Image' },
], 'image models map to {value, text} where text falls back to the id, sorted by id');
assert.deepEqual(scenarios.creditsComputed.response.body, { remaining: 7.5, total_credits: 10, total_usage: 2.5 }, 'credits are computed from the peer payload');
assert.deepEqual(scenarios.creditsStringTotals.response.body, { remaining: 4.25, total_credits: '5.5', total_usage: '1.25' },
    'string totals are echoed as strings while remaining is coerced to a number');
assert.deepEqual(scenarios.creditsMissingData.response.body, { remaining: 0, total_credits: 0, total_usage: 0 }, 'missing totals default to 0');
assert.equal(scenarios.creditsComputed.outbound[0].headers.authorization, `Bearer ${OPENROUTER_KEY}`, 'the credits request carries the bearer key');
assert.equal(scenarios.providersNoModel.outbound[0].url, `${OPENROUTER_API}/models/undefined/endpoints`,
    'a missing model is interpolated literally as "undefined" in the upstream path');
assert.equal(scenarios.multimodalFiltered.outbound[0].url, `${OPENROUTER_API}/models?output_modalities=text`,
    'the modality query is the output modality, encodeURIComponent-encoded');

const fixture = {
    schemaVersion: 1,
    baseline: { version: PINNED_VERSION, commit: PINNED_COMMIT },
    probe: 'tools/probe-openrouter.mjs',
    pinnedSource: {
        'src/endpoints/openrouter.js:8': "const API_OPENROUTER = 'https://openrouter.ai/api/v1';",
        'src/endpoints/openrouter.js:45': 'fetch(`${API_OPENROUTER}${endpoint}?output_modalities=${encodeURIComponent(outputModality)}`)',
        'src/endpoints/openrouter.js:68': 'sort((a, b) => a?.id && b?.id ? a.id.localeCompare(b.id) : 0)',
        'src/endpoints/openrouter.js:127-131': 'remaining = totalCredits - totalUsage; res.json({ remaining, total_credits: totalCredits, total_usage: totalUsage })',
    },
    mechanism: 'The pinned server runs unmodified; only its node-fetch module is replaced by a controlled peer (tools/lib/pinned-outbound.mjs), because API_OPENROUTER is a hardcoded module constant with no seam. Every recorded answer required a recorded outbound request to the controlled peer.',
    fields: [
        { path: 'scenarios.*.response.status', comparison: 'compared', reason: 'the pinned handler chooses 200/400/500 itself' },
        { path: 'scenarios.*.response.headers', comparison: 'compared', reason: 'Express and the pinned middleware stack set them' },
        { path: 'scenarios.multimodalFiltered.response.body', comparison: 'compared', reason: 'the pinned filter, mapping and sort over a controlled payload' },
        { path: 'scenarios.embeddingMapped.response.body', comparison: 'compared', reason: 'the pinned mapping and sort over a controlled payload' },
        { path: 'scenarios.imageMapped.response.body', comparison: 'compared', reason: 'the pinned mapping and name fallback over a controlled payload' },
        { path: 'scenarios.providersMapped.response.body', comparison: 'compared', reason: 'the pinned provider_name projection' },
        { path: 'scenarios.credits.response*.body', comparison: 'compared', reason: 'the pinned remaining/total arithmetic' },
        { path: 'scenarios.*.outbound[].url', comparison: 'compared', reason: 'the constructed upstream URL is endpoint behaviour' },
        { path: 'scenarios.*.outbound[].method', comparison: 'compared', reason: 'pinned always uses GET' },
        { path: 'scenarios.*.outbound[].headers', comparison: 'shape', reason: 'only Accept/Authorization are asserted; node-fetch adds transport headers the Go seam does not have to reproduce' },
        { path: 'model list content', comparison: 'shape', reason: 'third-party data: the fixture feeds a controlled payload and asserts the transformation, never the live list' },
    ],
    normalizations: [
        'Model identifiers are plain lowercase ASCII so the pinned localeCompare sort is host-independent; a locale-sensitive ordering is therefore NOT pinned.',
        'No third-party content is recorded as a constant: each payload is supplied by the controlled peer and the assertion covers the transformation.',
    ],
    inputs: {
        openRouterApi: OPENROUTER_API,
        openRouterKey: OPENROUTER_KEY,
        payloads: {
            multimodal: MULTIMODAL_PAYLOAD,
            embedding: EMBEDDING_PAYLOAD,
            image: IMAGE_PAYLOAD,
            providers: PROVIDERS_PAYLOAD,
        },
    },
    bootOutbound,
    scenarios,
};

const outputFile = writeFixture(repositoryRoot, 'sillytavern-1.19.0-openrouter.json', fixture);
console.log(`boot outbound requests: ${bootOutbound.length}`);
console.log(`fixture written to ${outputFile}`);
