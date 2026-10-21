#!/usr/bin/env node
// @gotavern-oracle: fixture=sillytavern-1.19.0-sd-generate.json label="sd generate"
// Probe the pinned stable-diffusion generation routes, one wave at a time.
//
// WAVE 1 (this fixture): `/api/sd/pollinations/generate` and `/api/sd/together/generate`, the two
// single-request shapes — a GET whose image comes back as bytes with a content type, and a POST whose
// JSON answer carries base64 or a URL to fetch. They establish the pattern the remaining providers reuse
// (binary payloads recorded by digest, seeds normalized, both-directions header assertions).
//
// The rest of the 19 `/api/sd/*/generate*` routes are NOT recorded here and stay `not implemented`:
// they are the same family but each needs its own handler reading, and a correct subset is worth more
// than a fabricated whole. `tools/probe-sd-generate.mjs` is the file the next wave extends.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';

import {
    PINNED_COMMIT, PINNED_VERSION, captureHttp, startPinnedProviderServer, writeFixture,
} from './lib/pinned-outbound.mjs';

const sourceRoot = path.resolve(process.argv[2] ?? '');
const repositoryRoot = path.resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3]) {
    console.error('usage: node tools/probe-sd-generate.mjs <pinned-source-clone> <gotavern-root>');
    process.exit(2);
}
if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim() !== PINNED_COMMIT) {
    throw new Error(`upstream checkout is not pinned at ${PINNED_COMMIT}`);
}

const POLLINATIONS = 'https://gen.pollinations.ai';
const TOGETHER = 'https://api.together.xyz';
const POLLINATIONS_KEY = 'synthetic-pollinations-key';
const TOGETHER_KEY = 'synthetic-together-key';
const PNG_BYTES = Buffer.from('89504e470d0a1a0a-gotavern-synthetic-png', 'utf8');
const JPEG_BYTES = Buffer.from('ffd8ffe0-gotavern-synthetic-jpeg', 'utf8');
const FETCHED_BYTES = Buffer.from('89504e47-gotavern-fetched-image', 'utf8');

function secretEntry(key, value) {
    return { [key]: [{ id: `sid-${key}`, value, label: key, active: true }] };
}

const SCENARIOS = [
    // ── /api/sd/pollinations/generate: GET, bytes out, format from the content type ──────────────
    { label: 'pollinationsNoKey', route: '/api/sd/pollinations/generate', body: '{"prompt":"a tree"}', secrets: {}, mocks: [] },
    { label: 'pollinationsPng', route: '/api/sd/pollinations/generate', body: '{"prompt":"a tree","model":"flux","negative_prompt":"ugly","seed":42,"width":512,"height":768}',
      secrets: secretEntry('api_key_pollinations', POLLINATIONS_KEY),
      mocks: [{ match: '/image/', headers: { 'content-type': 'image/png' }, binary: PNG_BYTES }] },
    { label: 'pollinationsJpeg', route: '/api/sd/pollinations/generate', body: '{"prompt":"a tree","model":"flux","negative_prompt":"","seed":7,"width":512,"height":512,"enhance":true}',
      secrets: secretEntry('api_key_pollinations', POLLINATIONS_KEY),
      mocks: [{ match: '/image/', headers: { 'content-type': 'image/jpeg' }, binary: JPEG_BYTES }] },
    { label: 'pollinationsDefaults', route: '/api/sd/pollinations/generate', body: '{"prompt":"a tree","model":"flux"}',
      secrets: secretEntry('api_key_pollinations', POLLINATIONS_KEY),
      mocks: [{ match: '/image/', headers: { 'content-type': 'image/webp' }, binary: PNG_BYTES }] },
    // A prompt containing reserved characters distinguishes the pinned encodeURIComponent from a raw
    // interpolation: the transport re-encodes a space but NOT a slash, '?' or '=', so a raw prompt is
    // visible at the peer only for these characters. Without this scenario a mutation that dropped the
    // encoding passed, because a space is re-encoded on the wire either way.
    { label: 'pollinationsReservedChars', route: '/api/sd/pollinations/generate', body: JSON.stringify({ prompt: 'a/b?c&d=e#f%20g', model: 'flux', seed: 1 }),
      secrets: secretEntry('api_key_pollinations', POLLINATIONS_KEY),
      mocks: [{ match: '/image/', headers: { 'content-type': 'image/png' }, binary: PNG_BYTES }] },
    { label: 'pollinationsNonOk', route: '/api/sd/pollinations/generate', body: '{"prompt":"a tree","model":"flux"}',
      secrets: secretEntry('api_key_pollinations', POLLINATIONS_KEY),
      mocks: [{ match: '/image/', status: 500, text: 'pollinations says no' }] },
    { label: 'pollinationsThrows', route: '/api/sd/pollinations/generate', body: '{"prompt":"a tree","model":"flux"}',
      secrets: secretEntry('api_key_pollinations', POLLINATIONS_KEY), mocks: [{ match: '/image/', throws: true }] },

    // ── /api/sd/together/generate: POST JSON, base64 or a URL to fetch ───────────────────────────
    { label: 'togetherNoKey', route: '/api/sd/together/generate', body: '{"prompt":"a tree"}', secrets: {}, mocks: [] },
    { label: 'togetherBase64', route: '/api/sd/together/generate', body: '{"prompt":"a tree","negative_prompt":"ugly","model":"flux","steps":20,"width":512,"height":768,"seed":42}',
      secrets: secretEntry('api_key_togetherai', TOGETHER_KEY),
      mocks: [{ match: '/v1/images/generations', payload: { data: [{ b64_json: 'QUJD' }] } }] },
    { label: 'togetherUrlFallback', route: '/api/sd/together/generate', body: '{"prompt":"a tree","model":"flux"}',
      secrets: secretEntry('api_key_togetherai', TOGETHER_KEY),
      mocks: [
          { match: '/v1/images/generations', payload: { data: [{ url: 'https://img.example.test/one.png' }] } },
          { match: 'img.example.test/one.png', headers: { 'content-type': 'image/png' }, binary: FETCHED_BYTES },
      ] },
    { label: 'togetherDefaults', route: '/api/sd/together/generate', body: '{"prompt":"a tree","model":"flux"}',
      secrets: secretEntry('api_key_togetherai', TOGETHER_KEY),
      mocks: [{ match: '/v1/images/generations', payload: { data: [{ b64_json: 'QUJD' }] } }] },
    { label: 'togetherNonOk', route: '/api/sd/together/generate', body: '{"prompt":"a tree","model":"flux"}',
      secrets: secretEntry('api_key_togetherai', TOGETHER_KEY),
      mocks: [{ match: '/v1/images/generations', status: 500, text: 'together says no' }] },
    { label: 'togetherNoData', route: '/api/sd/together/generate', body: '{"prompt":"a tree","model":"flux"}',
      secrets: secretEntry('api_key_togetherai', TOGETHER_KEY),
      mocks: [{ match: '/v1/images/generations', payload: { data: [] } }] },
];

const SEED_PATTERN = /(seed=)\d+/g;
const SEED_JSON_PATTERN = /"seed":\d+/g;
function normalizeSeed(value) {
    if (typeof value !== 'string') return value;
    return value.replace(SEED_JSON_PATTERN, '"seed":"<seed>"').replace(SEED_PATTERN, '$1<seed>');
}

const server = await startPinnedProviderServer({ sourceRoot, prefix: 'gotavern-sd-generate-oracle-', mocks: [] });
const scenarios = {};
let bootOutbound = [];
try {
    bootOutbound = server.bootOutbound;
    for (const scenario of SCENARIOS) {
        const rules = (scenario.mocks ?? []).map((rule, index) => ({
            run: scenario.label,
            match: rule.match,
            status: rule.status ?? 200,
            statusText: rule.statusText ?? 'OK',
            headers: rule.headers ?? { 'content-type': 'application/json' },
            body: rule.binary !== undefined ? rule.binary.toString('base64') : rule.text !== undefined ? rule.text : JSON.stringify(rule.payload ?? {}),
            binaryBody: rule.binary !== undefined,
            ...(rule.times === undefined ? {} : { times: rule.times }),
            ...(rule.throws === true ? { throws: true } : {}),
        }));
        server.writeSecrets(scenario.secrets ?? {});
        server.setMocks(rules);
        const result = await server.post(scenario.route, scenario.body);
        const requests = server.outbound();
        scenarios[scenario.label] = {
            route: scenario.route,
            requestBody: scenario.body,
            mocks: rules,
            secrets: server.readSecrets(),
            response: captureHttp(result),
            outbound: requests.map(request => ({
                url: normalizeSeed(request.url),
                method: request.method,
                headers: request.headers,
                body: normalizeSeed(request.body),
            })),
        };
    }
} catch (error) {
    console.error('PROBE FAILED; pinned server log tail:');
    console.error(server.logs.join('').slice(-8000));
    throw error;
} finally {
    await server.stop();
}

// ── assertions: the two shapes, and the details a guess would get wrong ────────────────────────
assert.equal(scenarios.pollinationsPng.response.status, 200, 'pollinations answers 200');
assert.deepEqual(scenarios.pollinationsPng.response.body, {
    image: PNG_BYTES.toString('base64'),
    format: 'png',
}, 'the image is base64 and the format comes from the response content type');
assert.equal(scenarios.pollinationsJpeg.response.body.format, 'jpg', 'image/jpeg maps to jpg');
assert.equal(scenarios.pollinationsDefaults.response.body.format, 'webp', 'image/webp maps to webp');
assert.equal(scenarios.pollinationsDefaults.outbound[0].url,
    `${POLLINATIONS}/image/a%20tree?model=flux&negative_prompt=undefined&seed=<seed>&width=1024&height=1024`,
    'the prompt is path-encoded and the query is built in pinned order with String(undefined) and the 1024 defaults');
// The seed is normalized in every recording (an explicit seed and a random one are indistinguishable
// after masking), so what is pinned is that the parameter is present in that position with the caller
// width and height around it.
assert.equal(scenarios.pollinationsPng.outbound[0].url,
    `${POLLINATIONS}/image/a%20tree?model=flux&negative_prompt=ugly&seed=<seed>&width=512&height=768`,
    'the query keeps the pinned member order, the caller width and height, and a seed placeholder');
assert.equal(scenarios.pollinationsJpeg.outbound[0].url.includes('&enhance=true'), true, 'enhance is only present when truthy');
assert.equal(scenarios.pollinationsPng.outbound[0].headers.authorization, `Bearer ${POLLINATIONS_KEY}`, 'the key travels as a bearer token');
assert.equal(scenarios.pollinationsNoKey.response.status, 400, 'a missing Pollinations key answers 400');
assert.equal(scenarios.pollinationsNoKey.outbound.length, 0, 'a missing key reaches no peer');
assert.equal(scenarios.pollinationsNonOk.response.status, 500, 'a non-ok Pollinations answer is a 500');

assert.deepEqual(scenarios.togetherBase64.response.body, { format: 'jpg', data: 'QUJD' }, 'together answers {format,data}');
assert.equal(scenarios.togetherBase64.outbound[0].url, `${TOGETHER}/v1/images/generations`, 'together URL');
assert.equal(scenarios.togetherBase64.outbound[0].method, 'POST', 'together POSTs');
assert.deepEqual(JSON.parse(scenarios.togetherBase64.outbound[0].body), {
    prompt: 'a tree', negative_prompt: 'ugly', height: 768, width: 512, model: 'flux', steps: 20, n: 1, seed: '<seed>',
}, 'the together body member order and content are pinned');
assert.equal(scenarios.togetherDefaults.outbound[0].body.includes('"seed":"<seed>"'), true, 'a negative or absent seed is randomized');
assert.equal(scenarios.togetherUrlFallback.response.body.data, FETCHED_BYTES.toString('base64'),
    'a URL answer is fetched and re-encoded as base64');
assert.equal(scenarios.togetherUrlFallback.outbound.length, 2, 'the URL fallback is a second request');
assert.equal(scenarios.togetherNoKey.response.status, 400, 'a missing Together key answers 400');
assert.equal(scenarios.togetherNonOk.response.status, 500, 'a non-ok Together answer is a 500');
assert.equal(scenarios.togetherNoData.response.status, 500, 'an answer without data[0] throws and answers 500');

const fixture = {
    schemaVersion: 1,
    baseline: { version: PINNED_VERSION, commit: PINNED_COMMIT },
    probe: 'tools/probe-sd-generate.mjs',
    wave: 1,
    implementedRoutes: ['/api/sd/pollinations/generate', '/api/sd/together/generate'],
    notImplementedRoutes: [
        '/api/sd/generate', '/api/sd/aimlapi/generate-image', '/api/sd/bfl/generate', '/api/sd/chutes/generate',
        '/api/sd/comfy/generate', '/api/sd/comfyrunpod/generate', '/api/sd/drawthings/generate',
        '/api/sd/electronhub/generate', '/api/sd/falai/generate', '/api/sd/huggingface/generate',
        '/api/sd/nanogpt/generate', '/api/sd/sdcpp/generate', '/api/sd/stability/generate',
        '/api/sd/workersai/generate', '/api/sd/xai/generate', '/api/sd/zai/generate', '/api/sd/zai/generate-video',
    ],
    pinnedSource: {
        'src/endpoints/stable-diffusion.js:1038': 'pollinations generate: GET /image/<encodeURIComponent(prompt)> with a URLSearchParams query in fixed order and a content-type-derived format',
        'src/endpoints/stable-diffusion.js:778': 'together generate: POST /v1/images/generations with the pinned body order, then a URL fallback fetch when b64_json is absent',
    },
    mechanism: 'Both upstreams are hardcoded literals, so the probe replaces only the pinned server node-fetch module (and the global fetch) with a controlled peer (tools/lib/pinned-outbound.mjs); the Go side uses the existing sd seams (sdPollinationsURL / sdTogetherURL) and replays the same peer through a real local listener.',
    fields: [
        { path: 'scenarios.*.response.status', comparison: 'compared', reason: 'the pinned handlers choose 200/400/500 themselves' },
        { path: 'scenarios.*.response.headers', comparison: 'compared', reason: 'Express and the pinned middleware stack set them' },
        { path: 'scenarios.*.response.body', comparison: 'compared', reason: 'the projection, including the base64 image and the content-type-derived format' },
        { path: 'scenarios.*.outbound[].url', comparison: 'compared', reason: 'path encoding and the query order/values are endpoint behaviour; the random seed is normalized' },
        { path: 'scenarios.*.outbound[].method', comparison: 'compared', reason: 'pollinations GET versus together POST' },
        { path: 'scenarios.*.outbound[].body', comparison: 'compared', reason: 'the together body member order and omitted undefined members' },
        { path: 'scenarios.*.outbound[].headers', comparison: 'shape', reason: 'only the declared content-type and authorization headers are asserted' },
        { path: 'image bytes', comparison: 'compared', reason: 'the pinned image bytes are synthetic and known; a real provider answer would be `shape` only' },
    ],
    normalizations: [
        'The Pollinations and Together seeds are `Math.floor(Math.random() * 10_000_000)` when the request seed is negative or absent, so they are replaced by <seed> in the recorded URL/body. They are the only nondeterministic values.',
        'Synthetic credentials and synthetic image bytes only.',
    ],
    inputs: { pollinations: POLLINATIONS, together: TOGETHER, pollinationsKey: POLLINATIONS_KEY, togetherKey: TOGETHER_KEY, imageSha256: createHash('sha256').update(PNG_BYTES).digest('hex') },
    bootOutbound,
    scenarios,
};

const outputFile = writeFixture(repositoryRoot, 'sillytavern-1.19.0-sd-generate.json', fixture);
console.log(`scenarios: ${Object.keys(scenarios).length}, boot outbound: ${bootOutbound.length}`);
console.log(`fixture written to ${outputFile}`);
