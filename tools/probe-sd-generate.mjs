#!/usr/bin/env node
// @gotavern-oracle: fixture=sillytavern-1.19.0-sd-generate.json label="sd generate"
// Probe the pinned stable-diffusion generation routes, one wave at a time.
//
// WAVE 1: `/api/sd/pollinations/generate` and `/api/sd/together/generate` — a GET whose image comes back
// as bytes with a content type, and a POST whose JSON answer carries base64 or a URL to fetch.
//
// WAVE 2: the one-shot providers whose request is a single forwarded call —
// `huggingface`, `electronhub`, `chutes`, `nanogpt`, `xai`, `aimlapi`, `stability` (multipart) and
// `workersai` (account id in the path, and a flux-2 multipart branch).
//
// NOT recorded, and `notImplementedReasons` says why: `zai`, because the pinned route REFUSES any image
// URL whose hostname does not end in `.zai`/`.ufileos.com` and then fetches it as given, so a controlled
// local peer cannot receive that second request without a transport seam that would change production
// behaviour.
//
// An image payload is recorded as base64 + digest + length, never as text. Every provider input that is
// interpolated into a path or query carries RESERVED CHARACTERS in at least one scenario (AGENTS.md rule
// 15), because an encoding assertion with only plain ASCII input cannot fail.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';

import {
    PINNED_COMMIT, PINNED_VERSION, captureHttp, parseMultipart, startPinnedProviderServer, writeFixture,
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
const HUGGINGFACE = 'https://api-inference.huggingface.co';
const ELECTRONHUB = 'https://api.electronhub.ai';
const CHUTES = 'https://image.chutes.ai';
const NANOGPT = 'https://nano-gpt.com';
const XAI = 'https://api.x.ai';
const AIMLAPI = 'https://api.aimlapi.com';
const STABILITY = 'https://api.stability.ai';
const CLOUDFLARE = 'https://api.cloudflare.com';

const KEYS = {
    pollinations: 'synthetic-pollinations-key',
    together: 'synthetic-together-key',
    huggingface: 'synthetic-huggingface-key',
    electronhub: 'synthetic-electronhub-key',
    chutes: 'synthetic-chutes-key',
    nanogpt: 'synthetic-nanogpt-key',
    xai: 'synthetic-xai-key',
    aimlapi: 'synthetic-aimlapi-key',
    stability: 'synthetic-stability-key',
    workersai: 'synthetic-workers-ai-key',
};

const PNG_BYTES = Buffer.from('89504e470d0a1a0a-gotavern-synthetic-png', 'utf8');
const JPEG_BYTES = Buffer.from('ffd8ffe0-gotavern-synthetic-jpeg', 'utf8');
const FETCHED_BYTES = Buffer.from('89504e47-gotavern-fetched-image', 'utf8');
const BASE64_IMAGE = 'QUJD';

function secretEntry(key, value) {
    return { [key]: [{ id: `sid-${key}`, value, label: key, active: true }] };
}

const SCENARIOS = [
    // ── WAVE 1 ──────────────────────────────────────────────────────────────────────────────────
    { label: 'pollinationsNoKey', route: '/api/sd/pollinations/generate', body: '{"prompt":"a tree"}', secrets: {}, mocks: [] },
    { label: 'pollinationsPng', route: '/api/sd/pollinations/generate', body: '{"prompt":"a tree","model":"flux","negative_prompt":"ugly","seed":42,"width":512,"height":768}',
      secrets: secretEntry('api_key_pollinations', KEYS.pollinations),
      mocks: [{ match: '/image/', headers: { 'content-type': 'image/png' }, binary: PNG_BYTES }] },
    { label: 'pollinationsJpeg', route: '/api/sd/pollinations/generate', body: '{"prompt":"a tree","model":"flux","negative_prompt":"","seed":7,"width":512,"height":512,"enhance":true}',
      secrets: secretEntry('api_key_pollinations', KEYS.pollinations),
      mocks: [{ match: '/image/', headers: { 'content-type': 'image/jpeg' }, binary: JPEG_BYTES }] },
    { label: 'pollinationsDefaults', route: '/api/sd/pollinations/generate', body: '{"prompt":"a tree","model":"flux"}',
      secrets: secretEntry('api_key_pollinations', KEYS.pollinations),
      mocks: [{ match: '/image/', headers: { 'content-type': 'image/webp' }, binary: PNG_BYTES }] },
    { label: 'pollinationsReservedChars', route: '/api/sd/pollinations/generate', body: JSON.stringify({ prompt: 'a/b?c&d=e#f%20g', model: 'flux', seed: 1 }),
      secrets: secretEntry('api_key_pollinations', KEYS.pollinations),
      mocks: [{ match: '/image/', headers: { 'content-type': 'image/png' }, binary: PNG_BYTES }] },
    { label: 'pollinationsNonOk', route: '/api/sd/pollinations/generate', body: '{"prompt":"a tree","model":"flux"}',
      secrets: secretEntry('api_key_pollinations', KEYS.pollinations),
      mocks: [{ match: '/image/', status: 500, text: 'pollinations says no' }] },
    { label: 'pollinationsThrows', route: '/api/sd/pollinations/generate', body: '{"prompt":"a tree","model":"flux"}',
      secrets: secretEntry('api_key_pollinations', KEYS.pollinations), mocks: [{ match: '/image/', throws: true }] },
    { label: 'togetherNoKey', route: '/api/sd/together/generate', body: '{"prompt":"a tree"}', secrets: {}, mocks: [] },
    { label: 'togetherBase64', route: '/api/sd/together/generate', body: '{"prompt":"a tree","negative_prompt":"ugly","model":"flux","steps":20,"width":512,"height":768,"seed":42}',
      secrets: secretEntry('api_key_togetherai', KEYS.together),
      mocks: [{ match: '/v1/images/generations', payload: { data: [{ b64_json: BASE64_IMAGE }] } }] },
    { label: 'togetherUrlFallback', route: '/api/sd/together/generate', body: '{"prompt":"a tree","model":"flux"}',
      secrets: secretEntry('api_key_togetherai', KEYS.together),
      mocks: [
          { match: '/v1/images/generations', payload: { data: [{ url: 'https://img.example.test/one.png' }] } },
          { match: 'img.example.test/one.png', headers: { 'content-type': 'image/png' }, binary: FETCHED_BYTES },
      ] },
    { label: 'togetherDefaults', route: '/api/sd/together/generate', body: '{"prompt":"a tree","model":"flux"}',
      secrets: secretEntry('api_key_togetherai', KEYS.together),
      mocks: [{ match: '/v1/images/generations', payload: { data: [{ b64_json: BASE64_IMAGE }] } }] },
    { label: 'togetherNonOk', route: '/api/sd/together/generate', body: '{"prompt":"a tree","model":"flux"}',
      secrets: secretEntry('api_key_togetherai', KEYS.together),
      mocks: [{ match: '/v1/images/generations', status: 500, text: 'together says no' }] },
    { label: 'togetherNoData', route: '/api/sd/together/generate', body: '{"prompt":"a tree","model":"flux"}',
      secrets: secretEntry('api_key_togetherai', KEYS.together),
      mocks: [{ match: '/v1/images/generations', payload: { data: [] } }] },

    // ── WAVE 2: huggingface ────────────────────────────────────────────────────────────────────
    { label: 'huggingfaceNoKey', route: '/api/sd/huggingface/generate', body: '{"prompt":"a tree","model":"m"}', secrets: {}, mocks: [] },
    { label: 'huggingfaceOk', route: '/api/sd/huggingface/generate', body: '{"prompt":"a tree","model":"black-forest-labs/FLUX.1-schnell"}',
      secrets: secretEntry('api_key_huggingface', KEYS.huggingface),
      mocks: [{ match: '/models/', headers: { 'content-type': 'image/png' }, binary: PNG_BYTES }] },
    { label: 'huggingfaceReservedModel', route: '/api/sd/huggingface/generate', body: '{"prompt":"a tree","model":"org/model v1?x=1"}',
      secrets: secretEntry('api_key_huggingface', KEYS.huggingface),
      mocks: [{ match: '/models/', headers: { 'content-type': 'image/png' }, binary: PNG_BYTES }] },
    { label: 'huggingfaceNonOk', route: '/api/sd/huggingface/generate', body: '{"prompt":"a tree","model":"m"}',
      secrets: secretEntry('api_key_huggingface', KEYS.huggingface), mocks: [{ match: '/models/', status: 500, text: 'hf says no' }] },

    // ── WAVE 2: electronhub ────────────────────────────────────────────────────────────────────
    { label: 'electronhubNoKey', route: '/api/sd/electronhub/generate', body: '{"prompt":"a tree"}', secrets: {}, mocks: [] },
    { label: 'electronhubOk', route: '/api/sd/electronhub/generate', body: '{"prompt":"a tree","model":"flux","size":"1024x1024","quality":"high"}',
      secrets: secretEntry('api_key_electronhub', KEYS.electronhub),
      mocks: [{ match: '/v1/images/generations', payload: { data: [{ b64_json: BASE64_IMAGE }] } }] },
    { label: 'electronhubOptionalFields', route: '/api/sd/electronhub/generate', body: '{"prompt":"a tree","model":"flux","size":"","quality":""}',
      secrets: secretEntry('api_key_electronhub', KEYS.electronhub),
      mocks: [{ match: '/v1/images/generations', payload: { data: [{ b64_json: BASE64_IMAGE }] } }] },
    { label: 'electronhubNoImage', route: '/api/sd/electronhub/generate', body: '{"prompt":"a tree","model":"flux"}',
      secrets: secretEntry('api_key_electronhub', KEYS.electronhub), mocks: [{ match: '/v1/images/generations', payload: { data: [] } }] },

    // ── WAVE 2: chutes ─────────────────────────────────────────────────────────────────────────
    { label: 'chutesNoKey', route: '/api/sd/chutes/generate', body: '{"prompt":"a tree"}', secrets: {}, mocks: [] },
    { label: 'chutesDefaults', route: '/api/sd/chutes/generate', body: '{"prompt":"a tree","model":"flux","negative_prompt":"ugly"}',
      secrets: secretEntry('api_key_chutes', KEYS.chutes),
      mocks: [{ match: '/generate', headers: { 'content-type': 'image/png' }, binary: PNG_BYTES }] },
    { label: 'chutesExplicit', route: '/api/sd/chutes/generate', body: '{"prompt":"a tree","model":"flux","negative_prompt":"ugly","guidance_scale":3.5,"width":256,"height":384,"steps":4}',
      secrets: secretEntry('api_key_chutes', KEYS.chutes),
      mocks: [{ match: '/generate', headers: { 'content-type': 'image/png' }, binary: PNG_BYTES }] },
    { label: 'chutesNonOk', route: '/api/sd/chutes/generate', body: '{"prompt":"a tree","model":"flux"}',
      secrets: secretEntry('api_key_chutes', KEYS.chutes), mocks: [{ match: '/generate', status: 500, text: 'chutes says no' }] },

    // ── WAVE 2: nanogpt ────────────────────────────────────────────────────────────────────────
    { label: 'nanogptNoKey', route: '/api/sd/nanogpt/generate', body: '{"prompt":"a tree"}', secrets: {}, mocks: [] },
    { label: 'nanogptBodyPassthrough', route: '/api/sd/nanogpt/generate', body: '{"prompt":"a tree","model":"flux","params":{ "width" : 256 , "scale" : 0.70 }}',
      secrets: secretEntry('api_key_nanogpt', KEYS.nanogpt),
      mocks: [{ match: '/api/generate-image', payload: { data: [{ b64_json: BASE64_IMAGE }] } }] },
    { label: 'nanogptNoImage', route: '/api/sd/nanogpt/generate', body: '{"prompt":"a tree"}',
      secrets: secretEntry('api_key_nanogpt', KEYS.nanogpt), mocks: [{ match: '/api/generate-image', payload: { data: [] } }] },

    // ── WAVE 2: xai ────────────────────────────────────────────────────────────────────────────
    { label: 'xaiNoKey', route: '/api/sd/xai/generate', body: '{"prompt":"a tree"}', secrets: {}, mocks: [] },
    { label: 'xaiPlainBase64', route: '/api/sd/xai/generate', body: '{"prompt":"a tree","model":"grok-2-image","aspect_ratio":"16:9","resolution":"1k"}',
      secrets: secretEntry('api_key_xai', KEYS.xai),
      mocks: [{ match: '/v1/images/generations', payload: { data: [{ b64_json: BASE64_IMAGE }] } }] },
    { label: 'xaiDataUrl', route: '/api/sd/xai/generate', body: '{"prompt":"a tree","model":"grok-2-image"}',
      secrets: secretEntry('api_key_xai', KEYS.xai),
      mocks: [{ match: '/v1/images/generations', payload: { data: [{ b64_json: `data:image/png;base64,${BASE64_IMAGE}` }] } }] },
    { label: 'xaiEmptyImage', route: '/api/sd/xai/generate', body: '{"prompt":"a tree","model":"grok-2-image"}',
      secrets: secretEntry('api_key_xai', KEYS.xai), mocks: [{ match: '/v1/images/generations', payload: { data: [{}] } }] },

    // ── WAVE 2: aimlapi ────────────────────────────────────────────────────────────────────────
    { label: 'aimlapiNoKey', route: '/api/sd/aimlapi/generate-image', body: '{"prompt":"a tree"}', secrets: {}, mocks: [] },
    { label: 'aimlapiB64', route: '/api/sd/aimlapi/generate-image', body: '{"prompt":"a tree","model":"flux","image_size":"square"}',
      secrets: secretEntry('api_key_aimlapi', KEYS.aimlapi),
      mocks: [{ match: '/v1/images/generations', payload: { images: [{ b64_json: BASE64_IMAGE }] } }] },
    { label: 'aimlapiBase64Field', route: '/api/sd/aimlapi/generate-image', body: '{"prompt":"a tree"}',
      secrets: secretEntry('api_key_aimlapi', KEYS.aimlapi),
      mocks: [{ match: '/v1/images/generations', payload: { data: [{ base64: BASE64_IMAGE }] } }] },
    { label: 'aimlapiUrlFallback', route: '/api/sd/aimlapi/generate-image', body: '{"prompt":"a tree"}',
      secrets: secretEntry('api_key_aimlapi', KEYS.aimlapi),
      mocks: [
          { match: '/v1/images/generations', payload: { data: [{ url: 'https://img.example.test/two.png' }] } },
          { match: 'img.example.test/two.png', headers: { 'content-type': 'image/png' }, binary: FETCHED_BYTES },
      ] },
    { label: 'aimlapiNoImage', route: '/api/sd/aimlapi/generate-image', body: '{"prompt":"a tree"}',
      secrets: secretEntry('api_key_aimlapi', KEYS.aimlapi), mocks: [{ match: '/v1/images/generations', payload: {} }] },
    { label: 'aimlapiNonOk', route: '/api/sd/aimlapi/generate-image', body: '{"prompt":"a tree"}',
      secrets: secretEntry('api_key_aimlapi', KEYS.aimlapi), mocks: [{ match: '/v1/images/generations', status: 500, text: 'aimlapi says no' }] },

    // ── WAVE 2: stability ──────────────────────────────────────────────────────────────────────
];

function normalizeSeed(value) {
    if (typeof value !== 'string') return value;
    return value.replace(/"seed":\d+/g, '"seed":"<seed>"').replace(/seed=\d+/g, 'seed=<seed>');
}

const server = await startPinnedProviderServer({ sourceRoot, prefix: 'gotavern-sd-generate-oracle-', mocks: [] });
const scenarios = {};
let bootOutbound = [];
try {
    bootOutbound = server.bootOutbound;
    for (const scenario of SCENARIOS) {
        const rules = (scenario.mocks ?? []).map(rule => ({
            run: scenario.label,
            match: rule.match,
            status: rule.status ?? 200,
            statusText: rule.statusText ?? 'OK',
            headers: rule.headers ?? { 'content-type': 'application/json' },
            body: rule.binary !== undefined ? rule.binary.toString('base64') : rule.text !== undefined ? rule.text : JSON.stringify(rule.payload ?? {}),
            binaryBody: rule.binary !== undefined,
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
            outbound: requests.map(request => {
                const record = {
                    url: normalizeSeed(request.url),
                    method: request.method,
                    headers: request.headers,
                };
                if (request.bodyBase64 !== undefined) {
                    record.parts = parseMultipart(request.headers['content-type'] ?? '', request.bodyBase64);
                } else {
                    record.body = normalizeSeed(request.body);
                }
                return record;
            }),
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



// ── WAVE 1 ──────────────────────────────────────────────────────────────────────────────────────
assert.deepEqual(scenarios.pollinationsPng.response.body, { image: PNG_BYTES.toString('base64'), format: 'png' }, 'pollinations projection');
assert.equal(requireOutbound('pollinationsPng', 0).url,
    `${POLLINATIONS}/image/a%20tree?model=flux&negative_prompt=ugly&seed=<seed>&width=512&height=768`, 'pollinations query order');
assert.equal(requireOutbound('pollinationsReservedChars', 0).url,
    `${POLLINATIONS}/image/a%2Fb%3Fc%26d%3De%23f%2520g?model=flux&negative_prompt=undefined&seed=<seed>&width=1024&height=1024`,
    'a reserved-character prompt is percent-encoded in the path (rule 15)');
assert.equal(scenarios.pollinationsNoKey.response.status, 400, 'pollinations without a key is 400');
assert.deepEqual(scenarios.togetherBase64.response.body, { format: 'jpg', data: BASE64_IMAGE }, 'together projection');
assert.deepEqual(JSON.parse(requireOutbound('togetherBase64', 0).body), {
    prompt: 'a tree', negative_prompt: 'ugly', height: 768, width: 512, model: 'flux', steps: 20, n: 1, seed: '<seed>',
}, 'together body order');
assert.equal(scenarios.togetherUrlFallback.outbound.length, 2, 'together url fallback is a second request');

assert.deepEqual(scenarios.huggingfaceOk.response.body, { image: PNG_BYTES.toString('base64') }, 'huggingface returns the image bytes only');
assert.equal(requireOutbound('huggingfaceOk', 0).url, `${HUGGINGFACE}/models/black-forest-labs/FLUX.1-schnell`,
    'the huggingface model is interpolated into the path WITHOUT encoding, so a slash stays a path separator');
assert.equal(requireOutbound('huggingfaceReservedModel', 0).url, `${HUGGINGFACE}/models/org/model v1?x=1`,
    'a reserved-character model is interpolated raw, which is the pinned behaviour to reproduce');
assert.deepEqual(JSON.parse(requireOutbound('huggingfaceOk', 0).body), { inputs: 'a tree' }, 'huggingface body is {inputs}');
assert.equal(requireOutbound('huggingfaceOk', 0).headers.authorization, `Bearer ${KEYS.huggingface}`, 'huggingface bearer key');
assert.equal(scenarios.huggingfaceNoKey.response.status, 400, 'huggingface without a key is 400');
assert.equal(scenarios.huggingfaceNonOk.response.status, 500, 'huggingface non-ok is 500');

assert.deepEqual(scenarios.electronhubOk.response.body, { image: BASE64_IMAGE }, 'electronhub returns {image}');
assert.deepEqual(JSON.parse(requireOutbound('electronhubOk', 0).body), {
    model: 'flux', prompt: 'a tree', response_format: 'b64_json', size: '1024x1024', quality: 'high',
}, 'electronhub body order with the optional fields appended');
assert.deepEqual(JSON.parse(requireOutbound('electronhubOptionalFields', 0).body), {
    model: 'flux', prompt: 'a tree', response_format: 'b64_json',
}, 'falsy size and quality are omitted');
assert.equal(scenarios.electronhubNoImage.response.status, 500, 'electronhub without b64_json is 500');
assert.equal(scenarios.electronhubNoKey.response.status, 400, 'electronhub without a key is 400');

assert.deepEqual(scenarios.chutesDefaults.response.body, { image: PNG_BYTES.toString('base64') }, 'chutes returns the bytes as base64');
assert.deepEqual(JSON.parse(requireOutbound('chutesDefaults', 0).body), {
    model: 'flux', prompt: 'a tree', negative_prompt: 'ugly', guidance_scale: 7, width: 1024, height: 1024, num_inference_steps: 10,
}, 'chutes defaults come from ||, not ??');
assert.deepEqual(JSON.parse(requireOutbound('chutesExplicit', 0).body), {
    model: 'flux', prompt: 'a tree', negative_prompt: 'ugly', guidance_scale: 3.5, width: 256, height: 384, num_inference_steps: 4,
}, 'chutes explicit values pass through');
assert.equal(scenarios.chutesNoKey.response.status, 400, 'chutes without a key is 400');

assert.deepEqual(scenarios.nanogptBodyPassthrough.response.body, { image: BASE64_IMAGE }, 'nanogpt returns {image}');
assert.equal(requireOutbound('nanogptBodyPassthrough', 0).body, '{"prompt":"a tree","model":"flux","params":{"width":256,"scale":0.7}}',
    'nanogpt forwards the WHOLE request body, re-serialized');
assert.equal(requireOutbound('nanogptBodyPassthrough', 0).headers['x-api-key'], KEYS.nanogpt, 'nanogpt authenticates with x-api-key');
assert.equal(scenarios.nanogptNoImage.response.status, 500, 'nanogpt without b64_json is 500');

assert.deepEqual(scenarios.xaiPlainBase64.response.body, { image: BASE64_IMAGE, format: 'jpg' }, 'a plain base64 answer is JPEG');
assert.deepEqual(scenarios.xaiDataUrl.response.body, { image: BASE64_IMAGE, format: 'png' }, 'a data URL answer yields its mime extension');
assert.deepEqual(JSON.parse(requireOutbound('xaiPlainBase64', 0).body), {
    prompt: 'a tree', model: 'grok-2-image', aspect_ratio: '16:9', resolution: '1k', response_format: 'b64_json',
}, 'xai body order');
assert.equal(scenarios.xaiEmptyImage.response.status, 500, 'xai without an image is 500');
assert.equal(scenarios.xaiNoKey.response.status, 400, 'xai without a key is 400');

assert.deepEqual(scenarios.aimlapiB64.response.body, { format: 'png', data: BASE64_IMAGE }, 'aimlapi projects {format,data}');
assert.equal(requireOutbound('aimlapiB64', 0).body, '{"prompt":"a tree","model":"flux","image_size":"square"}', 'aimlapi forwards the whole body');
assert.equal(requireOutbound('aimlapiB64', 0).headers['http-referer'], 'https://sillytavern.app', 'the AIMLAPI referer header');
assert.equal(requireOutbound('aimlapiB64', 0).headers['x-title'], 'SillyTavern', 'the AIMLAPI title header');
assert.deepEqual(scenarios.aimlapiBase64Field.response.body, { format: 'png', data: BASE64_IMAGE }, 'the base64 field is accepted as well');
assert.equal(scenarios.aimlapiUrlFallback.response.body.data, FETCHED_BYTES.toString('base64'), 'the url fallback re-encodes the fetched bytes');
assert.equal(scenarios.aimlapiUrlFallback.outbound.length, 2, 'the aimlapi url fallback is a second request');
assert.equal(scenarios.aimlapiNoImage.response.status, 500, 'aimlapi without an image is 500');
assert.equal(scenarios.aimlapiNonOk.response.status, 500, 'aimlapi non-ok is 500');
assert.equal(scenarios.aimlapiNonOk.response.bodyText, 'aimlapi says no', 'aimlapi forwards the provider TEXT on failure');
const fixture = {
    schemaVersion: 1,
    baseline: { version: PINNED_VERSION, commit: PINNED_COMMIT },
    probe: 'tools/probe-sd-generate.mjs',
    waves: {
        1: ['/api/sd/pollinations/generate', '/api/sd/together/generate'],
        2: [
            '/api/sd/huggingface/generate', '/api/sd/electronhub/generate', '/api/sd/chutes/generate',
            '/api/sd/nanogpt/generate', '/api/sd/xai/generate', '/api/sd/aimlapi/generate-image',
        ],
    },
    implementedRoutes: [
        '/api/sd/pollinations/generate', '/api/sd/together/generate',
        '/api/sd/huggingface/generate', '/api/sd/electronhub/generate', '/api/sd/chutes/generate',
        '/api/sd/nanogpt/generate', '/api/sd/xai/generate', '/api/sd/aimlapi/generate-image',
    ],
    notImplementedRoutes: [
        '/api/sd/generate', '/api/sd/bfl/generate', '/api/sd/comfy/generate', '/api/sd/comfyrunpod/generate',
        '/api/sd/drawthings/generate', '/api/sd/falai/generate', '/api/sd/sdcpp/generate', '/api/sd/zai/generate',
        '/api/sd/zai/generate-video', '/api/sd/stability/generate', '/api/sd/workersai/generate',
    ],
    notImplementedReasons: {
        '/api/sd/zai/generate': 'The pinned route refuses any image URL whose hostname does not end in .zai or .ufileos.com and then fetches that URL as given, so a controlled local peer cannot receive that second request without a transport-level seam that would change production behaviour.',
        '/api/sd/stability/generate': 'The pinned route builds NATIVE FormData (stable-diffusion.js imports no form-data package, so it uses the global implementation), whose parts are not observable through the probe peer today. Pinning it needs a coordinated tools/lib capability that captures native FormData entries.',
        '/api/sd/workersai/generate': 'Its flux-2 branch also sends NATIVE FormData, so the same tools/lib capability is required before the whole route can be pinned; the JSON branch alone would leave half the route unverified.',
    },
    pinnedSource: {
        'src/endpoints/stable-diffusion.js:1038': 'pollinations: GET /image/<encodeURIComponent(prompt)> with a URLSearchParams query',
        'src/endpoints/stable-diffusion.js:778': 'together: POST /v1/images/generations with the pinned body order and a URL fallback',
        'src/endpoints/stable-diffusion.js:1145': 'huggingface: POST /models/<model> with the model interpolated RAW, body {inputs}',
        'src/endpoints/stable-diffusion.js:1224': 'electronhub: body order model,prompt,response_format then optional size/quality',
        'src/endpoints/stable-diffusion.js:1343': 'chutes: POST image.chutes.ai/generate with || defaults and a raw byte answer',
        'src/endpoints/stable-diffusion.js:1430': 'nanogpt: POST /api/generate-image with the WHOLE request body re-serialized',
        'src/endpoints/stable-diffusion.js:1738': 'xai: b64_json or a data URL, format from the mime type',
        'src/endpoints/stable-diffusion.js:1837': 'aimlapi: whole body forwarded, AIMLAPI_HEADERS, images[0] or data[0], url fallback',
        'src/endpoints/stable-diffusion.js:1085': 'stability: multipart from payload entries in object order, endpoint by model, raw base64 answer',
        'src/endpoints/stable-diffusion.js:2108': 'workersai: account id encodeURIComponent into the path, flux-2 multipart branch, JSON or binary answer',
    },
    mechanism: 'Every upstream is a hardcoded literal, so the probe replaces the `node-fetch` module and the global `fetch` with a controlled peer (tools/lib/pinned-outbound.mjs); the Go side reuses the sd seams and replays the same peer through a real local listener.',
    fields: [
        { path: 'scenarios.*.response.status', comparison: 'compared', reason: 'the pinned handlers choose 200/400/500 themselves' },
        { path: 'scenarios.*.response.headers', comparison: 'compared', reason: 'Express and the pinned middleware stack set them; a string body is html-typed' },
        { path: 'scenarios.*.response.body/bodyText', comparison: 'compared', reason: 'the projection, including base64 image payloads and the raw stability base64 body' },
        { path: 'scenarios.*.outbound[].url', comparison: 'compared', reason: 'path encoding and interpolation are endpoint behaviour; seeds are normalized' },
        { path: 'scenarios.*.outbound[].body', comparison: 'compared', reason: 'JSON member order, omitted undefined members and whole-body passthrough' },
        { path: 'scenarios.*.outbound[].parts', comparison: 'compared', reason: 'multipart bodies as parsed parts: the boundary is random per request' },
        { path: 'scenarios.*.outbound[].headers', comparison: 'compared', reason: 'the declared provider headers, asserted in BOTH directions by the test' },
        { path: 'image bytes', comparison: 'compared', reason: 'synthetic peer answers with known digests; live provider content would be shape only' },
    ],
    normalizations: [
        'The Pollinations and Together seeds are randomized when absent or negative, so they are replaced by a marker in the recorded URL/body.',
        'Multipart boundaries are random per request, so multipart bodies are recorded as parsed parts.',
        'Synthetic credentials and synthetic image bytes only.',
    ],
    inputs: {
        imageSha256: sha256(PNG_BYTES),
        jpegSha256: sha256(JPEG_BYTES),
        fetchedSha256: sha256(FETCHED_BYTES),
        keys: KEYS,
    },
    bootOutbound,
    scenarios,
};

const outputFile = writeFixture(repositoryRoot, 'sillytavern-1.19.0-sd-generate.json', fixture);
console.log(`scenarios: ${Object.keys(scenarios).length}, boot outbound: ${bootOutbound.length}`);
console.log(`fixture written to ${outputFile}`);

// â”€â”€ Refusal guards â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// An assertion that dereferences `outbound[0]` turns a fixture difference into a stack trace, and it
// would have been a SILENT PASS had the expected value also been undefined. Every dereference goes
// through requireOutbound, which REFUSES with the evidence needed to tell a probe defect from a product
// difference: the recorded status, the recorded body and the pinned server's own log tail.
function refuseProbe(message) {
    console.error('PROBE REFUSES: ' + message);
    try {
        const logs = typeof server !== 'undefined' && server && Array.isArray(server.logs) ? server.logs.join('') : '';
        console.error('pinned server log tail:');
        console.error(logs.slice(-4000));
    } catch (error) {
        console.error('could not read the pinned server log: ' + error);
    }
    process.exit(1);
}

function requireOutbound(label, index = 0) {
    const scenario = scenarios[label];
    if (!scenario) {
        refuseProbe(`scenario ${label} is missing from the recording`);
    }
    if (scenario.outbound.length <= index) {
        const response = scenario.response ?? {};
        const body = response.bodyText ?? response.sha256 ?? '';
        refuseProbe(`scenario ${label} recorded ${scenario.outbound.length} outbound request(s), so request ${index} cannot be compared`
            + ` | recorded status ${response.status}`
            + ` | recorded body ${String(body).slice(0, 500)}`
            + ` | scenario request body ${String(scenario.requestBody).slice(0, 300)}`);
    }
    return scenario.outbound[index];
}