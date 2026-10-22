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

    // ── WAVE 3: body-supplied URL, single shot ─────────────────────────────────────────────────
    // These two routes read `request.body.url`, so the caller names the server: there is no provider
    // seam and none is needed. The recorded body carries the placeholder `<mock>`, which the probe
    // substitutes with the pinned peer's origin when sending and the replay substitutes with its own
    // listener, so the fixture contains no port or host.
    { label: 'sdcppGenerateProjection', route: '/api/sd/sdcpp/generate',
      body: JSON.stringify({
          url: '<mock>', model: 'm1', prompt: 'a tree', negative_prompt: '', width: 512, height: 768,
          steps: 20, cfg_scale: 7, seed: 42, batch_size: 1, sampler_name: 'euler', scheduler: 'karras',
          clip_skip: 1, ignored: 'x',
      }),
      mocks: [{ match: '/sdapi/v1/txt2img', payload: { images: ['QUJD'], info: { seed: 42 } } }] },
    { label: 'sdcppClipSkipIncluded', route: '/api/sd/sdcpp/generate',
      body: JSON.stringify({ url: '<mock>', prompt: 'a tree', clip_skip: 2, negative_prompt: 'ugly' }),
      mocks: [{ match: '/sdapi/v1/txt2img', payload: { images: ['QUJD'] } }] },
    { label: 'sdcppNonOk', route: '/api/sd/sdcpp/generate',
      body: JSON.stringify({ url: '<mock>', prompt: 'a tree' }),
      mocks: [{ match: '/sdapi/v1/txt2img', status: 500, text: 'sdcpp says no' }] },
    { label: 'sdcppThrows', route: '/api/sd/sdcpp/generate',
      body: JSON.stringify({ url: '<mock>', prompt: 'a tree' }),
      mocks: [{ match: '/sdapi/v1/txt2img', throws: true }] },
    { label: 'drawthingsEcho', route: '/api/sd/drawthings/generate',
      body: JSON.stringify({ url: '<mock>', auth: 'user:pass', prompt: 'a tree', model: 'm1', width: 1, steps: 3 }),
      mocks: [{ match: '/sdapi/v1/txt2img', payload: { images: ['QUJD'] } }] },
    { label: 'drawthingsNoAuth', route: '/api/sd/drawthings/generate',
      body: JSON.stringify({ url: '<mock>', prompt: 'a tree', model: 'm1' }),
      mocks: [{ match: '/sdapi/v1/txt2img', payload: { images: ['QUJD'] } }] },
    { label: 'drawthingsNonOk', route: '/api/sd/drawthings/generate',
      body: JSON.stringify({ url: '<mock>', prompt: 'a tree' }),
      mocks: [{ match: '/sdapi/v1/txt2img', status: 500, text: 'drawthings says no' }] },
    { label: 'drawthingsThrows', route: '/api/sd/drawthings/generate',
      body: JSON.stringify({ url: '<mock>', prompt: 'a tree' }),
      mocks: [{ match: '/sdapi/v1/txt2img', throws: true }] },

    // ── WAVE 3: A1111 /generate — TWO requests, and the count is fixture data ───────────────────
    // The options GET is Forge detection; its failure is swallowed. A missing options request would
    // be invisible without the recorded count, which is why every scenario here has two rules.
    { label: 'generateForgeKeepsModules', route: '/api/sd/generate',
      body: JSON.stringify({ url: '<mock>', auth: 'user:pass', prompt: 'a tree', override_settings: { forge_additional_modules: ['mod'] } }),
      mocks: [
          { match: '/sdapi/v1/options', payload: { forge_preset: 'forge', sd_model_checkpoint: 'm1' } },
          { match: '/sdapi/v1/txt2img', payload: { images: ['QUJD'], info: {} } },
      ] },
    { label: 'generateNonForgeUnsetsModules', route: '/api/sd/generate',
      body: JSON.stringify({ url: '<mock>', prompt: 'a tree', override_settings: { forge_additional_modules: ['mod'], other: 1 } }),
      mocks: [
          { match: '/sdapi/v1/options', payload: { sd_model_checkpoint: 'm1' } },
          { match: '/sdapi/v1/txt2img', payload: { images: ['QUJD'] } },
      ] },
    { label: 'generateOptionsNonOkKeepsModules', route: '/api/sd/generate',
      body: JSON.stringify({ url: '<mock>', prompt: 'a tree', override_settings: { forge_additional_modules: ['mod'] } }),
      mocks: [
          { match: '/sdapi/v1/options', status: 500, text: 'options exploded' },
          { match: '/sdapi/v1/txt2img', payload: { images: ['QUJD'] } },
      ] },
    { label: 'generateOptionsThrowsKeepsModules', route: '/api/sd/generate',
      body: JSON.stringify({ url: '<mock>', prompt: 'a tree', override_settings: { forge_additional_modules: ['mod'] } }),
      mocks: [
          { match: '/sdapi/v1/options', throws: true },
          { match: '/sdapi/v1/txt2img', payload: { images: ['QUJD'] } },
      ] },
    { label: 'generateNonOk', route: '/api/sd/generate',
      body: JSON.stringify({ url: '<mock>', prompt: 'a tree' }),
      mocks: [
          { match: '/sdapi/v1/options', payload: {} },
          { match: '/sdapi/v1/txt2img', status: 500, text: 'txt2img exploded' },
      ] },
    { label: 'generateThrows', route: '/api/sd/generate',
      body: JSON.stringify({ url: '<mock>', prompt: 'a tree' }),
      mocks: [
          { match: '/sdapi/v1/options', payload: {} },
          { match: '/sdapi/v1/txt2img', throws: true },
      ] },

    // ── WAVE 4: stability (native FormData) ─────────────────────────────────────────────────────
    // The previous notImplementedReason claimed native FormData parts were unobservable. That reason
    // was STALE: the hook's recordBody captures [object FormData] entries, so the parts are fixture
    // data now. Every multipart scenario asserts a NON-EMPTY part list.
    { label: 'stabilityNoKey', route: '/api/sd/stability/generate',
      body: JSON.stringify({ model: 'stable-image-ultra', payload: { prompt: 'a tree' } }), secrets: {}, mocks: [] },
    { label: 'stabilityUltraMultipart', route: '/api/sd/stability/generate',
      body: JSON.stringify({ model: 'stable-image-ultra', payload: { prompt: 'a tree', output_format: 'png', aspect_ratio: '1:1', negative_prompt: 'ugly', seed: 0 } }),
      secrets: secretEntry('api_key_stability', KEYS.stability),
      mocks: [{ match: '/v2beta/stable-image/generate/ultra', headers: { 'content-type': 'image/png' }, binary: PNG_BYTES }] },
    { label: 'stabilityCoreEndpoint', route: '/api/sd/stability/generate',
      body: JSON.stringify({ model: 'stable-image-core', payload: { prompt: 'a tree' } }),
      secrets: secretEntry('api_key_stability', KEYS.stability),
      mocks: [{ match: '/v2beta/stable-image/generate/core', headers: { 'content-type': 'image/png' }, binary: PNG_BYTES }] },
    { label: 'stabilitySd3Endpoint', route: '/api/sd/stability/generate',
      body: JSON.stringify({ model: 'stable-diffusion-3', payload: { prompt: 'a tree' } }),
      secrets: secretEntry('api_key_stability', KEYS.stability),
      mocks: [{ match: '/v2beta/stable-image/generate/sd3', headers: { 'content-type': 'image/png' }, binary: PNG_BYTES }] },
    { label: 'stabilityStringCoercion', route: '/api/sd/stability/generate',
      body: JSON.stringify({ model: 'stable-image-ultra', payload: { prompt: 'a tree', seed: null, flag: true, count: 2, nested: { a: 1 }, list: [1, 2], skip: undefined } }),
      secrets: secretEntry('api_key_stability', KEYS.stability),
      mocks: [{ match: '/v2beta/stable-image/generate/ultra', headers: { 'content-type': 'image/png' }, binary: PNG_BYTES }] },
    { label: 'stabilityInvalidModel', route: '/api/sd/stability/generate',
      body: JSON.stringify({ model: 'nope', payload: { prompt: 'a tree' } }),
      secrets: secretEntry('api_key_stability', KEYS.stability), mocks: [] },
    { label: 'stabilityPayloadMissing', route: '/api/sd/stability/generate',
      body: JSON.stringify({ model: 'stable-image-ultra' }),
      secrets: secretEntry('api_key_stability', KEYS.stability), mocks: [] },
    { label: 'stabilityNonOk', route: '/api/sd/stability/generate',
      body: JSON.stringify({ model: 'stable-image-ultra', payload: { prompt: 'a tree' } }),
      secrets: secretEntry('api_key_stability', KEYS.stability),
      mocks: [{ match: '/v2beta/stable-image/generate/ultra', status: 500, text: 'stability says no' }] },
    { label: 'stabilityThrows', route: '/api/sd/stability/generate',
      body: JSON.stringify({ model: 'stable-image-ultra', payload: { prompt: 'a tree' } }),
      secrets: secretEntry('api_key_stability', KEYS.stability),
      mocks: [{ match: '/v2beta/stable-image/generate/ultra', throws: true }] },

    // ── WAVE 4: workersai (JSON and flux-2 multipart) ───────────────────────────────────────────
    { label: 'workersaiNoKey', route: '/api/sd/workersai/generate',
      body: JSON.stringify({ account_id: 'acct', model: 'flux-1-schnell', prompt: 'a tree' }), secrets: {}, mocks: [] },
    { label: 'workersaiNoAccount', route: '/api/sd/workersai/generate',
      body: JSON.stringify({ account_id: '   ', model: 'flux-1-schnell', prompt: 'a tree' }),
      secrets: secretEntry('api_key_workers_ai', KEYS.workersai), mocks: [] },
    { label: 'workersaiNoModel', route: '/api/sd/workersai/generate',
      body: JSON.stringify({ account_id: 'acct', model: '', prompt: 'a tree' }),
      secrets: secretEntry('api_key_workers_ai', KEYS.workersai), mocks: [] },
    { label: 'workersaiJsonProjection', route: '/api/sd/workersai/generate',
      body: JSON.stringify({ account_id: 'acct id/with?chars', model: 'flux-1-schnell', prompt: 'a tree', negative_prompt: 'ugly', width: '512', height: 768, steps: '20', scale: '7.5', seed: 0 }),
      secrets: secretEntry('api_key_workers_ai', KEYS.workersai),
      mocks: [{ match: '/ai/run/flux-1-schnell', payload: { result: { image: 'QUJD' } } }] },
    { label: 'workersaiJsonTopLevelImage', route: '/api/sd/workersai/generate',
      body: JSON.stringify({ account_id: 'acct', model: 'flux-1-schnell', prompt: 'a tree' }),
      secrets: secretEntry('api_key_workers_ai', KEYS.workersai),
      mocks: [{ match: '/ai/run/flux-1-schnell', payload: { image: 'QUJD' } }] },
    { label: 'workersaiJsonNoImage', route: '/api/sd/workersai/generate',
      body: JSON.stringify({ account_id: 'acct', model: 'flux-1-schnell', prompt: 'a tree' }),
      secrets: secretEntry('api_key_workers_ai', KEYS.workersai),
      mocks: [{ match: '/ai/run/flux-1-schnell', payload: { result: {} } }] },
    { label: 'workersaiFlux2Multipart', route: '/api/sd/workersai/generate',
      body: JSON.stringify({ account_id: 'acct', model: 'flux-2-dev', prompt: 'a tree', width: 512, height: 512, steps: 4 }),
      secrets: secretEntry('api_key_workers_ai', KEYS.workersai),
      mocks: [{ match: '/ai/run/flux-2-dev', payload: { result: { image: 'QUJD' } } }] },
    { label: 'workersaiBinaryAnswer', route: '/api/sd/workersai/generate',
      body: JSON.stringify({ account_id: 'acct', model: 'flux-1-schnell', prompt: 'a tree' }),
      secrets: secretEntry('api_key_workers_ai', KEYS.workersai),
      mocks: [{ match: '/ai/run/flux-1-schnell', headers: { 'content-type': 'image/png' }, binary: PNG_BYTES }] },
    { label: 'workersaiNonOkForwardsText', route: '/api/sd/workersai/generate',
      body: JSON.stringify({ account_id: 'acct', model: 'flux-1-schnell', prompt: 'a tree' }),
      secrets: secretEntry('api_key_workers_ai', KEYS.workersai),
      mocks: [{ match: '/ai/run/flux-1-schnell', status: 500, text: 'workers ai says no' }] },
    { label: 'workersaiReservedModelRaw', route: '/api/sd/workersai/generate',
      body: JSON.stringify({ account_id: 'a b', model: 'org/model v1?x=1', prompt: 'a tree' }),
      secrets: secretEntry('api_key_workers_ai', KEYS.workersai),
      mocks: [{ match: '/ai/run/org/model v1?x=1', payload: { result: { image: 'QUJD' } } }] },
    { label: 'workersaiFalsyMembersOmitted', route: '/api/sd/workersai/generate',
      body: JSON.stringify({ account_id: 'acct', model: 'flux-1-schnell', prompt: 'a tree', negative_prompt: '', width: 0, seed: -1 }),
      secrets: secretEntry('api_key_workers_ai', KEYS.workersai),
      mocks: [{ match: '/ai/run/flux-1-schnell', payload: { result: { image: 'QUJD' } } }] },
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
        // A body-supplied URL is recorded as `<mock>` so the fixture is host- and port-independent;
        // the pinned peer's real origin is only used for this run.
        const requestBody = String(scenario.body).split('<mock>').join(server.origin);
        const result = await server.post(scenario.route, requestBody);
        const requests = server.outbound();
        scenarios[scenario.label] = {
            route: scenario.route,
            requestBody: scenario.body,
            mocks: rules,
            secrets: server.readSecrets(),
            response: captureHttp(result),
            outbound: requests.map(request => {
                const record = {
                    url: normalizeSeed(request.url).split(server.origin).join('<mock>'),
                    method: request.method,
                    headers: request.headers,
                };
                if (request.parts !== undefined) {
                    // A native FormData body: the hook records the parsed parts directly, because the
                    // boundary is random per request. The part LIST must be non-empty; a consumed
                    // stream would record zero parts, which looks exactly like "never sent".
                    if (!Array.isArray(request.parts) || request.parts.length === 0) {
                        throw new Error(`${scenario.label}: the peer recorded an EMPTY part list for a multipart request`);
                    }
                    record.parts = request.parts;
                } else if (request.bodyBase64 !== undefined) {
                    record.parts = parseMultipart(request.headers['content-type'] ?? '', request.bodyBase64);
                } else {
                    record.body = request.body === null || request.body === undefined
                        ? request.body
                        : normalizeSeed(request.body).split(server.origin).join('<mock>');
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

// ── WAVE 3 assertions ───────────────────────────────────────────────────────────────────────────
assert.deepEqual(scenarios.sdcppGenerateProjection.response.body, { images: ['QUJD'], info: { seed: 42 } },
    'sdcpp re-serializes the provider JSON');
assert.equal(requireOutbound('sdcppGenerateProjection', 0).url, '<mock>/sdapi/v1/txt2img', 'sdcpp path is the body URL plus the fixed pathname');
assert.equal(requireOutbound('sdcppGenerateProjection', 0).body,
    '{"model":"m1","prompt":"a tree","width":512,"height":768,"steps":20,"cfg_scale":7,"seed":"<seed>","batch_size":1,"sampler_name":"euler","scheduler":"karras"}',
    'sdcpp drops empty/undefined/null members and clip_skip <= 1, keeping the pinned member order');
assert.equal(requireOutbound('sdcppGenerateProjection', 0).headers.authorization, undefined, 'sdcpp sends no authorization header');
assert.equal(requireOutbound('sdcppClipSkipIncluded', 0).body, '{"prompt":"a tree","negative_prompt":"ugly","clip_skip":2}',
    'clip_skip is carried only when it is greater than 1');
assert.equal(scenarios.sdcppNonOk.response.status, 500, 'sdcpp non-ok is 500');
assert.equal(scenarios.sdcppThrows.response.status, 500, 'a rejected sdcpp fetch is 500');

assert.deepEqual(scenarios.drawthingsEcho.response.body, { images: ['QUJD'] }, 'drawthings passes the provider JSON through');
assert.equal(requireOutbound('drawthingsEcho', 0).url, '<mock>/sdapi/v1/txt2img', 'drawthings path is the body URL plus the fixed pathname');
assert.equal(requireOutbound('drawthingsEcho', 0).body, '{"prompt":"a tree","model":"m1","width":1,"steps":3}',
    'drawthings forwards the body minus url and auth in the original member order');
assert.equal(requireOutbound('drawthingsEcho', 0).headers.authorization, `Basic ${Buffer.from('user:pass').toString('base64')}`, 'drawthings Basic auth');
assert.equal(requireOutbound('drawthingsNoAuth', 0).headers.authorization, `Basic ${Buffer.from('undefined').toString('base64')}`,
    'an absent auth is stringified to "undefined", which is what the pinned helper does');
assert.equal(scenarios.drawthingsNonOk.response.status, 500, 'drawthings non-ok is 500');
assert.equal(scenarios.drawthingsThrows.response.status, 500, 'a rejected drawthings fetch is 500');

// ── WAVE 3: A1111 /generate ─────────────────────────────────────────────────────────────────────
assert.deepEqual(scenarios.generateForgeKeepsModules.response.body, { images: ['QUJD'], info: {} },
    'A1111 re-serializes the provider JSON');
assert.equal(scenarios.generateForgeKeepsModules.outbound.length, 2, 'A1111 makes the options request and then the generation');
assert.equal(requireOutbound('generateForgeKeepsModules', 0).url, '<mock>/sdapi/v1/options', 'the options probe is the FIRST request');
assert.equal(requireOutbound('generateForgeKeepsModules', 0).method, 'GET', 'the options probe is a GET');
assert.equal(requireOutbound('generateForgeKeepsModules', 1).body,
    '{"url":"<mock>","auth":"user:pass","prompt":"a tree","override_settings":{"forge_additional_modules":["mod"]}}',
    'a Forge server keeps forge_additional_modules and the body is forwarded as given');
assert.equal(requireOutbound('generateNonForgeUnsetsModules', 1).body,
    '{"url":"<mock>","prompt":"a tree","override_settings":{"other":1}}',
    'a non-Forge server loses only forge_additional_modules, preserving the member order');
assert.equal(requireOutbound('generateOptionsNonOkKeepsModules', 1).body,
    '{"url":"<mock>","prompt":"a tree","override_settings":{"forge_additional_modules":["mod"]}}',
    'a non-ok options response skips the unset');
assert.equal(requireOutbound('generateOptionsThrowsKeepsModules', 1).body,
    '{"url":"<mock>","prompt":"a tree","override_settings":{"forge_additional_modules":["mod"]}}',
    'a rejected options fetch is swallowed and skips the unset');
assert.equal(requireOutbound('generateForgeKeepsModules', 0).headers.authorization, `Basic ${Buffer.from('user:pass').toString('base64')}`,
    'the options probe carries the Basic auth header');
assert.equal(scenarios.generateNonOk.response.status, 500, 'A1111 non-ok is 500');
assert.equal(scenarios.generateThrows.response.status, 500, 'a rejected A1111 generation fetch is 500');

// ── WAVE 4 assertions ───────────────────────────────────────────────────────────────────────────
assert.equal(scenarios.stabilityNoKey.response.status, 400, 'stability without a key is 400');
assert.equal(scenarios.stabilityNoKey.outbound.length, 0, 'a missing stability key sends nothing');
assert.equal(scenarios.stabilityUltraMultipart.response.bodyText, PNG_BYTES.toString('base64'),
    'stability answers plain base64 of the provider bytes');
assert.equal(requireOutbound('stabilityUltraMultipart', 0).url, `${STABILITY}/v2beta/stable-image/generate/ultra`, 'stability ultra endpoint');
assert.deepEqual(requireOutbound('stabilityUltraMultipart', 0).parts, [
    { name: 'prompt', value: 'a tree' },
    { name: 'output_format', value: 'png' },
    { name: 'aspect_ratio', value: '1:1' },
    { name: 'negative_prompt', value: 'ugly' },
    { name: 'seed', value: '0' },
], 'stability multipart parts in payload insertion order, String()-coerced');
assert.equal(requireOutbound('stabilityUltraMultipart', 0).headers.authorization, `Bearer ${KEYS.stability}`, 'stability bearer key');
assert.equal(requireOutbound('stabilityUltraMultipart', 0).headers.accept, 'image/*', 'stability accept header');
assert.equal(requireOutbound('stabilityCoreEndpoint', 0).url, `${STABILITY}/v2beta/stable-image/generate/core`, 'stability core endpoint');
assert.equal(requireOutbound('stabilitySd3Endpoint', 0).url, `${STABILITY}/v2beta/stable-image/generate/sd3`, 'stability sd3 endpoint');
assert.deepEqual(requireOutbound('stabilityStringCoercion', 0).parts, [
    { name: 'prompt', value: 'a tree' },
    { name: 'seed', value: 'null' },
    { name: 'flag', value: 'true' },
    { name: 'count', value: '2' },
    { name: 'nested', value: '[object Object]' },
    { name: 'list', value: '1,2' },
], 'String() coercion: null/true/number/object/array (the undefined-skip branch is unreachable from an HTTP JSON body, since JSON has no undefined)');
assert.equal(scenarios.stabilityInvalidModel.response.status, 500, 'an unknown stability model is 500');
assert.equal(scenarios.stabilityInvalidModel.outbound.length, 0, 'an unknown model sends nothing');
assert.equal(scenarios.stabilityPayloadMissing.response.status, 500, 'a missing payload is 500');
assert.equal(scenarios.stabilityPayloadMissing.outbound.length, 0, 'a missing payload sends nothing');
assert.equal(scenarios.stabilityNonOk.response.status, 500, 'stability non-ok is 500');
assert.equal(scenarios.stabilityThrows.response.status, 500, 'a rejected stability fetch is 500');

assert.equal(scenarios.workersaiNoKey.response.status, 400, 'workersai without a key is 400');
assert.equal(scenarios.workersaiNoAccount.response.status, 400, 'a blank account id is 400');
assert.equal(scenarios.workersaiNoModel.response.status, 400, 'a blank model is 400');
assert.deepEqual(scenarios.workersaiJsonProjection.response.body, { format: 'png', image: 'QUJD' }, 'workersai projects the JSON image');
assert.equal(requireOutbound('workersaiJsonProjection', 0).url,
    `${CLOUDFLARE}/client/v4/accounts/acct%20id%2Fwith%3Fchars/ai/run/flux-1-schnell`,
    'the account id is encodeURIComponent-ed while the model is RAW');
assert.equal(requireOutbound('workersaiJsonProjection', 0).body,
    '{"prompt":"a tree","negative_prompt":"ugly","width":512,"height":768,"num_steps":20,"guidance":7.5,"seed":"<seed>"}',
    'workersai coercion: truthiness gates, Number() conversion, seed >= 0');
assert.equal(requireOutbound('workersaiJsonProjection', 0).headers.authorization, `Bearer ${KEYS.workersai}`, 'workersai bearer key');
assert.deepEqual(scenarios.workersaiJsonTopLevelImage.response.body, { format: 'png', image: 'QUJD' }, 'a top-level image field is accepted');
assert.equal(scenarios.workersaiJsonNoImage.response.status, 500, 'a JSON answer without an image is 500');
assert.deepEqual(requireOutbound('workersaiFlux2Multipart', 0).parts, [
    { name: 'prompt', value: 'a tree' },
    { name: 'width', value: '512' },
    { name: 'height', value: '512' },
    { name: 'num_steps', value: '4' },
], 'the flux-2 branch sends native FormData parts');
assert.deepEqual(scenarios.workersaiFlux2Multipart.response.body, { format: 'png', image: 'QUJD' }, 'the flux-2 branch projects the JSON answer');
assert.equal(scenarios.workersaiBinaryAnswer.response.body.image, PNG_BYTES.toString('base64'), 'a non-JSON answer becomes base64 bytes');
assert.equal(scenarios.workersaiNonOkForwardsText.response.status, 500, 'workersai non-ok is 500');
assert.equal(scenarios.workersaiNonOkForwardsText.response.bodyText, 'workersai says no'.replace('workersai', 'workers ai'),
    'workersai forwards the provider TEXT on failure');
assert.equal(requireOutbound('workersaiReservedModelRaw', 0).url,
    `${CLOUDFLARE}/client/v4/accounts/a%20b/ai/run/org/model v1?x=1`,
    'a reserved-character model stays RAW in the path (rule 15)');
assert.equal(requireOutbound('workersaiFalsyMembersOmitted', 0).body, '{"prompt":"a tree"}',
    'falsy negative_prompt/width and a negative seed are omitted');

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
        3: ['/api/sd/sdcpp/generate', '/api/sd/drawthings/generate', '/api/sd/generate'],
        4: ['/api/sd/stability/generate', '/api/sd/workersai/generate'],
    },
    implementedRoutes: [
        '/api/sd/pollinations/generate', '/api/sd/together/generate',
        '/api/sd/huggingface/generate', '/api/sd/electronhub/generate', '/api/sd/chutes/generate',
        '/api/sd/nanogpt/generate', '/api/sd/xai/generate', '/api/sd/aimlapi/generate-image',
        '/api/sd/sdcpp/generate', '/api/sd/drawthings/generate', '/api/sd/generate',
        '/api/sd/stability/generate', '/api/sd/workersai/generate',
        // WAVE 5 IS RECORDED BY ITS OWN PROBE. `bfl` and `falai` submit a job, sleep `delay(2500)` and
        // poll a URL the provider names, so their scenarios live in
        // `tools/probe-sd-generate-wave5.mjs` / `sillytavern-1.19.0-sd-generate-wave5.json`. `scenarios`
        // in THIS file is the replay list of its own test, and adding poll scenarios here would hand them
        // to a peer with no `times` rule support, no wave-5 seam and no provider-URL rewriting. The routes
        // are listed as implemented because they are implemented; their observations are in that file.
        '/api/sd/bfl/generate', '/api/sd/falai/generate',
        // WAVE 6, same reasoning one level further. `zai`'s two routes are implemented and their
        // observations live in `tools/probe-sd-zai.mjs` / `sillytavern-1.19.0-sd-zai.json`: the image
        // route REFUSES any provider URL outside `.zai`/`.ufileos.com` and then fetches it as given, so
        // its success path needs a peer no local host can name, and the video route polls a literal
        // async-result path with `delay(5000 + attempt*1000)`. Listing them here as implemented states
        // the fact; the fixture that proves it is that other file.
        '/api/sd/zai/generate', '/api/sd/zai/generate-video',
    ],
    notImplementedRoutes: [
        '/api/sd/comfy/generate', '/api/sd/comfyrunpod/generate',
    ],
    // STALE REASONS DELETED. `stability/generate` and `workersai/generate` were listed here with the
    // reason that native FormData parts were unobservable. That reason was WRONG: the hook's
    // `recordBody` gained `[object FormData]` entry capture, so the parts are recorded (and asserted
    // non-empty) today. The correction is recorded in the inventory row as well, because a stale
    // reason is worse than a missing row - the next reader trusts it and stops.
    //
    // `zai`'s reason was also deleted, for the same class of reason: it was TRUE that the success path
    // is unreplayable, but it was written as if the ROUTE were not implemented. The route is
    // implemented; what is unrecordable is one branch, and that fact now lives in the zai fixture's
    // `notCovered` where a reader of that route will meet it.
    staleReasonsRemoved: {
        '/api/sd/stability/generate': 'claimed native FormData parts were unobservable; recordBody now captures them',
        '/api/sd/workersai/generate': 'claimed its flux-2 multipart branch was unobservable; recordBody now captures it',
        '/api/sd/zai/generate': 'said a peer cannot receive the provider URL, which is true, but implied the route was not implemented; it is, and the unreplayable branch is named in sillytavern-1.19.0-sd-zai.json',
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
        'src/endpoints/stable-diffusion.js:867': 'sdcpp: fixed payload projection in a fixed member order, drops undefined/null/empty, clip_skip only when > 1, no auth',
        'src/endpoints/stable-diffusion.js:297': 'A1111 /generate: options GET for Forge detection (failure swallowed), then txt2img POST with the whole body; a non-Forge server loses override_settings.forge_additional_modules; socket close POSTs /interrupt',
        'src/endpoints/stable-diffusion.js:977': 'drawthings: forwards the whole body minus url/auth in order, always sends Basic auth (absent auth stringifies to "undefined")',
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