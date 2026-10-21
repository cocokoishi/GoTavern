#!/usr/bin/env node
// @gotavern-oracle: fixture=sillytavern-1.19.0-google-media.json label="google media"
// Probe the pinned Gemini media routes that are a SINGLE forwarded request:
//
//   POST /api/google/caption-image    google.js:234
//   POST /api/google/generate-image   google.js:432
//
// Neither re-encodes an image: caption-image only string-splits the incoming data URI and returns the
// model's TEXT, and generate-image passes the provider's base64 straight through. So neither belongs to
// the Jimp codec boundary, and both are comparable through HTTP.
//
// `generate-video` is NOT recorded here: it polls up to 30 times with a wall-clock `delay(5000 + attempt *
// 1000)`, has three request shapes (create, poll, provider-URI fetch) and an AbortController wired to the
// client socket. It is its own increment; the fixture records that reason.
//
// A vertex `seed` is randomized when absent, so it is normalized to a marker.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';

import { PINNED_COMMIT, PINNED_VERSION, captureHttp, startPinnedProviderServer, writeFixture } from './lib/pinned-outbound.mjs';

const sourceRoot = path.resolve(process.argv[2] ?? '');
const repositoryRoot = path.resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3]) {
    console.error('usage: node tools/probe-google-media.mjs <pinned-source-clone> <gotavern-root>');
    process.exit(2);
}
if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim() !== PINNED_COMMIT) {
    throw new Error(`upstream checkout is not pinned at ${PINNED_COMMIT}`);
}

const MAKERSUITE = 'https://generativelanguage.googleapis.com';
const VERTEX = 'https://us-central1-aiplatform.googleapis.com';
const OAUTH = 'https://oauth2.googleapis.com';

const KEYS = {
    makersuite: 'synthetic-makersuite-key',
    vertexai: 'synthetic-vertex-express-key',
    proxyPassword: 'synthetic-proxy-password',
};

const IMAGE_BASE64 = Buffer.from('gotavern-synthetic-caption-image-bytes', 'utf8').toString('base64');
const DATA_URI = `data:image/png;base64,${IMAGE_BASE64}`;
const GENERATED_BASE64 = Buffer.from('gotavern-synthetic-generated-image-bytes', 'utf8').toString('base64');
const CAPTION = 'a synthetic caption';

function secretEntry(key, value) {
    return { [key]: [{ id: `sid-${key}`, value, label: key, active: true }] };
}

const SCENARIOS = [
    // ── caption-image ───────────────────────────────────────────────────────────────────────────
    { label: 'captionNoImage', route: '/api/google/caption-image', body: JSON.stringify({ prompt: 'describe' }),
      secrets: secretEntry('api_key_makersuite', KEYS.makersuite), mocks: [] },
    { label: 'captionOk', route: '/api/google/caption-image', body: JSON.stringify({ image: DATA_URI, prompt: 'describe', model: 'gemini-2.0-flash' }),
      secrets: secretEntry('api_key_makersuite', KEYS.makersuite),
      mocks: [{ match: '/models/', payload: { candidates: [{ content: { parts: [{ text: CAPTION }] } }] } }] },
    { label: 'captionDefaultModel', route: '/api/google/caption-image', body: JSON.stringify({ image: DATA_URI, prompt: 'describe' }),
      secrets: secretEntry('api_key_makersuite', KEYS.makersuite),
      mocks: [{ match: '/models/', payload: { candidates: [{ content: { parts: [{ text: CAPTION }] } }] } }] },
    { label: 'captionMalformedImage', route: '/api/google/caption-image', body: JSON.stringify({ image: 'not-a-data-uri', prompt: 'describe' }),
      secrets: secretEntry('api_key_makersuite', KEYS.makersuite),
      mocks: [{ match: '/models/', payload: { candidates: [{ content: { parts: [{ text: CAPTION }] } }] } }] },
    { label: 'captionNoCandidates', route: '/api/google/caption-image', body: JSON.stringify({ image: DATA_URI, prompt: 'describe' }),
      secrets: secretEntry('api_key_makersuite', KEYS.makersuite),
      mocks: [{ match: '/models/', payload: {} }] },
    { label: 'captionNoCaption', route: '/api/google/caption-image', body: JSON.stringify({ image: DATA_URI, prompt: 'describe' }),
      secrets: secretEntry('api_key_makersuite', KEYS.makersuite),
      mocks: [{ match: '/models/', payload: { candidates: [{ content: { parts: [{}] } }] } }] },
    { label: 'captionProviderError', route: '/api/google/caption-image', body: JSON.stringify({ image: DATA_URI, prompt: 'describe' }),
      secrets: secretEntry('api_key_makersuite', KEYS.makersuite),
      mocks: [{ match: '/models/', status: 429, statusText: 'Too Many Requests', payload: { error: { message: 'quota' } } }] },
    { label: 'captionReservedModel', route: '/api/google/caption-image', body: JSON.stringify({ image: DATA_URI, prompt: 'describe', model: 'models/x y?z=1' }),
      secrets: secretEntry('api_key_makersuite', KEYS.makersuite),
      mocks: [{ match: '/models/', payload: { candidates: [{ content: { parts: [{ text: CAPTION }] } }] } }] },
    { label: 'captionVertexExpress', route: '/api/google/caption-image', body: JSON.stringify({ image: DATA_URI, prompt: 'describe', model: 'gemini-2.0-flash', api: 'vertexai' }),
      secrets: secretEntry('api_key_vertexai', KEYS.vertexai),
      mocks: [{ match: '-aiplatform.googleapis.com', payload: { candidates: [{ content: { parts: [{ text: CAPTION }] } }] } }] },
    { label: 'captionProxyMode', route: '/api/google/caption-image', body: JSON.stringify({ image: DATA_URI, prompt: 'describe', reverse_proxy: 'https://proxy.example.test', proxy_password: KEYS.proxyPassword }),
      secrets: {},
      mocks: [{ match: 'proxy.example.test', payload: { candidates: [{ content: { parts: [{ text: CAPTION }] } }] } }] },

    // ── generate-image ──────────────────────────────────────────────────────────────────────────
    { label: 'generateImageOk', route: '/api/google/generate-image', body: JSON.stringify({ prompt: 'a tree', model: 'imagen-3.0-generate-002' }),
      secrets: secretEntry('api_key_makersuite', KEYS.makersuite),
      mocks: [{ match: ':predict', payload: { predictions: [{ bytesBase64Encoded: GENERATED_BASE64 }] } }] },
    { label: 'generateImageDefaultModel', route: '/api/google/generate-image', body: JSON.stringify({ prompt: 'a tree' }),
      secrets: secretEntry('api_key_makersuite', KEYS.makersuite),
      mocks: [{ match: ':predict', payload: { predictions: [{ bytesBase64Encoded: GENERATED_BASE64 }] } }] },
    { label: 'generateImageVertex', route: '/api/google/generate-image', body: JSON.stringify({ prompt: 'a tree', model: 'imagen-3.0-generate-002', api: 'vertexai', seed: 42, enhance: true, negative_prompt: 'ugly', aspect_ratio: '16:9' }),
      secrets: secretEntry('api_key_vertexai', KEYS.vertexai),
      mocks: [{ match: ':predict', payload: { predictions: [{ bytesBase64Encoded: GENERATED_BASE64 }] } }] },
    { label: 'generateImageVertexRandomSeed', route: '/api/google/generate-image', body: JSON.stringify({ prompt: 'a tree', model: 'imagen-3.0-generate-002', api: 'vertexai' }),
      secrets: secretEntry('api_key_vertexai', KEYS.vertexai),
      mocks: [{ match: ':predict', payload: { predictions: [{ bytesBase64Encoded: GENERATED_BASE64 }] } }] },
    { label: 'generateImageDeprecatedModel', route: '/api/google/generate-image', body: JSON.stringify({ prompt: 'a tree', model: 'imagegeneration@006' }),
      secrets: secretEntry('api_key_makersuite', KEYS.makersuite),
      mocks: [{ match: ':predict', payload: { predictions: [{ bytesBase64Encoded: GENERATED_BASE64 }] } }] },
    { label: 'generateImageNoImage', route: '/api/google/generate-image', body: JSON.stringify({ prompt: 'a tree' }),
      secrets: secretEntry('api_key_makersuite', KEYS.makersuite),
      mocks: [{ match: ':predict', payload: { predictions: [] } }] },
    { label: 'generateImageProviderError', route: '/api/google/generate-image', body: JSON.stringify({ prompt: 'a tree' }),
      secrets: secretEntry('api_key_makersuite', KEYS.makersuite),
      mocks: [{ match: ':predict', status: 500, statusText: 'Internal Server Error', text: 'imagen says no' }] },
    { label: 'generateImageReservedModel', route: '/api/google/generate-image', body: JSON.stringify({ prompt: 'a tree', model: 'models/x y?z=1' }),
      secrets: secretEntry('api_key_makersuite', KEYS.makersuite),
      mocks: [{ match: ':predict', payload: { predictions: [{ bytesBase64Encoded: GENERATED_BASE64 }] } }] },
];

function normalizeSeed(value) {
    if (typeof value !== 'string') return value;
    return value.replace(/"seed":\d+/g, '"seed":"<seed>"');
}

const server = await startPinnedProviderServer({ sourceRoot, prefix: 'gotavern-google-media-oracle-', mocks: [] });
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
        }));
        server.writeSecrets(scenario.secrets ?? {});
        server.setMocks(rules);
        const result = await server.post(scenario.route, scenario.body);
        scenarios[scenario.label] = {
            route: scenario.route,
            requestBody: scenario.body,
            mocks: rules,
            secrets: server.readSecrets(),
            response: captureHttp(result),
            outbound: server.outbound().map(request => ({
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

// ── caption-image ───────────────────────────────────────────────────────────────────────────────
assert.equal(scenarios.captionNoImage.response.status, 500, 'an absent image member throws and answers 500');
assert.equal(scenarios.captionNoImage.outbound.length, 0, 'and reaches no peer');
assert.deepEqual(scenarios.captionOk.response.body, { caption: CAPTION }, 'the caption projection');
assert.equal(scenarios.captionOk.outbound[0].url, `${MAKERSUITE}/v1beta/models/gemini-2.0-flash:generateContent`, 'the AI Studio caption URL');
const captionBody = JSON.parse(scenarios.captionOk.outbound[0].body);
assert.equal(captionBody.contents[0].parts[0].text, 'describe', 'the prompt part comes first');
assert.deepEqual(captionBody.contents[0].parts[1].inlineData, { mimeType: 'image/png', data: IMAGE_BASE64 }, 'the data URI is split into mimeType and data');
assert.equal(captionBody.contents[0].role, 'user', 'the role');
assert.equal(Object.keys(captionBody).join(','), 'contents,safetySettings', 'the request member order');
assert.equal(captionBody.safetySettings.length, 5, 'AI Studio carries the five Gemini safety settings');
assert.equal(scenarios.captionDefaultModel.outbound[0].url, `${MAKERSUITE}/v1beta/models/gemini-2.0-flash:generateContent`, 'the default model');
assert.deepEqual(JSON.parse(scenarios.captionMalformedImage.outbound[0].body).contents[0].parts[1], { inlineData: {} },
    'a malformed data URI leaves undefined members, which JSON.stringify DROPS');
assert.equal(scenarios.captionNoCandidates.response.status, 500, 'no candidates is a 500');
assert.equal(scenarios.captionNoCandidates.response.bodyText, 'No candidates found, image was most likely filtered.', 'the no-candidates message');
assert.equal(scenarios.captionNoCaption.response.status, 500, 'no caption is a 500');
assert.equal(scenarios.captionNoCaption.response.bodyText, 'No caption found', 'the no-caption message');
assert.equal(scenarios.captionProviderError.response.status, 500, 'a provider error is flattened to 500');
assert.deepEqual(scenarios.captionProviderError.response.body, { error: true }, 'and answers {error:true} whatever the provider status was');
assert.equal(scenarios.captionReservedModel.outbound[0].url, `${MAKERSUITE}/v1beta/models/models/x y?z=1:generateContent`,
    'the model is interpolated RAW into the path (rule 15)');
assert.equal(scenarios.captionVertexExpress.outbound[0].url,
    `${VERTEX}/v1/publishers/google/models/gemini-2.0-flash:generateContent`, 'the vertex express URL');
assert.equal(JSON.parse(scenarios.captionVertexExpress.outbound[0].body).safetySettings.length, 10, 'Vertex appends its five safety settings');
assert.equal(scenarios.captionProxyMode.outbound[0].headers['x-goog-api-key'], KEYS.proxyPassword, 'the AI Studio proxy sends the password as the key header');

// ── generate-image ──────────────────────────────────────────────────────────────────────────────
assert.deepEqual(scenarios.generateImageOk.response.body, { image: GENERATED_BASE64 }, 'the image is passed through unchanged');
assert.equal(scenarios.generateImageOk.outbound[0].url, `${MAKERSUITE}/v1beta/models/imagen-3.0-generate-002:predict`, 'the AI Studio predict URL');
const imageBody = JSON.parse(scenarios.generateImageOk.outbound[0].body);
assert.equal(Object.keys(imageBody).join(','), 'instances,parameters', 'the request member order');
assert.equal(imageBody.parameters.sampleCount, 1, 'one sample');
assert.equal(imageBody.parameters.aspectRatio, '1:1', 'the default aspect ratio');
assert.equal(imageBody.parameters.personGeneration, 'allow_adult', 'the config default for personGeneration');
assert.equal(imageBody.parameters.safetySetting, 'block_low_and_above', 'the AI Studio safety setting');
assert.equal(imageBody.parameters.outputOptions.mimeType, 'image/jpeg', 'the requested output mime type');
assert.equal(imageBody.parameters.outputOptions.compressionQuality, 100, 'the requested compression quality');
assert.equal('seed' in imageBody.parameters, false, 'AI Studio sends no seed');
assert.equal('enhancePrompt' in imageBody.parameters, false, 'AI Studio sends no enhancePrompt');
assert.equal('language' in imageBody.parameters, false, 'AI Studio sends no language');
assert.equal('addWatermark' in imageBody.parameters, false, 'AI Studio sends no addWatermark');
assert.equal(scenarios.generateImageDefaultModel.outbound[0].url, `${MAKERSUITE}/v1beta/models/imagen-3.0-generate-002:predict`, 'the default model');
const vertexBody = JSON.parse(scenarios.generateImageVertex.outbound[0].body);
// The seed is masked on both sides, so an explicit seed and a randomized one are indistinguishable here;
// the discriminating scenario is that AI Studio carries NO seed member at all.
assert.equal(vertexBody.parameters.seed, '<seed>', 'a vertex seed is present and masked');
assert.equal(vertexBody.parameters.enhancePrompt, true, 'enhancePrompt');
assert.equal(vertexBody.parameters.negativePrompt, 'ugly', 'negativePrompt');
assert.equal(vertexBody.parameters.language, 'auto', 'language');
assert.equal(vertexBody.parameters.safetySetting, 'block_only_high', 'the Vertex safety setting');
assert.equal(vertexBody.parameters.addWatermark, false, 'addWatermark');
assert.equal(vertexBody.parameters.aspectRatio, '16:9', 'the requested aspect ratio');
assert.equal(scenarios.generateImageVertexRandomSeed.outbound[0].body.includes('"seed":"<seed>"'), true,
    'a vertex seed is randomized when absent');
const deprecatedBody = JSON.parse(scenarios.generateImageDeprecatedModel.outbound[0].body);
assert.equal('personGeneration' in deprecatedBody.parameters, false, 'a deprecated model drops personGeneration');
assert.equal('safetySetting' in deprecatedBody.parameters, false, 'and drops safetySetting');
assert.equal(scenarios.generateImageNoImage.response.status, 500, 'no predictions is a 500');
assert.equal(scenarios.generateImageNoImage.response.bodyText, 'No image data found in response', 'the no-image message');
assert.equal(scenarios.generateImageProviderError.response.status, 500, 'a provider error is a 500');
assert.equal(scenarios.generateImageProviderError.response.bodyText, 'Image generation request failed', 'the provider-error message');
assert.equal(scenarios.generateImageReservedModel.outbound[0].url, `${MAKERSUITE}/v1beta/models/models/x y?z=1:predict`,
    'the model is interpolated RAW into the path (rule 15)');

const fixture = {
    schemaVersion: 1,
    baseline: { version: PINNED_VERSION, commit: PINNED_COMMIT },
    probe: 'tools/probe-google-media.mjs',
    implementedRoutes: ['/api/google/caption-image', '/api/google/generate-image'],
    notImplementedRoutes: ['/api/google/generate-video'],
    notImplementedReasons: {
        '/api/google/generate-video': 'It polls up to THIRTY times with a wall-clock `delay(5000 + attempt * 1000)`, has three request shapes (create, poll, and a fetch of a provider-supplied video URI whose host cannot be redirected to a controlled peer), and wires an AbortController to the client socket. The timeout branch alone would cost about ten minutes of wall clock, so it needs timed rules plus a cancellation scenario and is its own increment.',
    },
    pinnedSource: {
        'src/endpoints/google.js:234': 'router.post(\'/caption-image\'): splits the data URI, forwards contents+inlineData, returns {caption} from the model text',
        'src/endpoints/google.js:432': 'router.post(\'/generate-image\'): predict with the pinned parameter block, returns predictions[0].bytesBase64Encoded unchanged',
        'src/endpoints/google.js:498': 'router.post(\'/generate-video\'): predictLongRunning plus a polling loop (not recorded here)',
    },
    mechanism: 'Every upstream is a hardcoded literal, so the probe replaces the `node-fetch` module and the global `fetch` with a controlled peer; the Go side reuses the same four Google auth branches and replays the peer through a real listener.',
    fields: [
        { path: 'scenarios.*.response.status', comparison: 'compared', reason: 'the pinned handlers choose 200/500 themselves and flatten provider statuses' },
        { path: 'scenarios.*.response.headers', comparison: 'compared', reason: 'a string body is html-typed, a JSON body is json-typed' },
        { path: 'scenarios.*.response.body/bodyText', comparison: 'compared', reason: 'the caption and image projections, and three distinct error messages' },
        { path: 'scenarios.*.outbound[].url', comparison: 'compared', reason: 'four auth branches, the raw model interpolation and the endpoint suffix' },
        { path: 'scenarios.*.outbound[].body', comparison: 'compared', reason: 'the pinned parameter block, including members JSON.stringify DROPS because they are undefined' },
        { path: 'scenarios.*.outbound[].headers', comparison: 'compared', reason: 'x-goog-api-key or Authorization, asserted in both directions by the test' },
        { path: 'scenarios.*.response.body.image', comparison: 'compared', reason: 'the provider base64 is passed through, so byte equality is the right comparison and no codec is involved' },
    ],
    normalizations: [
        'A vertex `seed` is randomized when absent, so it is replaced by a marker in the recorded body.',
        'The AI Studio proxy host is not reachable from the Go peer, so the test substitutes the peer origin and compares the path the route builds.',
    ],
    inputs: {
        imageBase64: IMAGE_BASE64,
        generatedBase64: GENERATED_BASE64,
        caption: CAPTION,
        makersuiteKey: KEYS.makersuite,
        vertexKey: KEYS.vertexai,
        proxyPassword: KEYS.proxyPassword,
        imageSha256: createHash('sha256').update(Buffer.from(GENERATED_BASE64, 'base64')).digest('hex'),
    },
    bootOutbound,
    scenarios,
};

const outputFile = writeFixture(repositoryRoot, 'sillytavern-1.19.0-google-media.json', fixture);
console.log(`scenarios: ${Object.keys(scenarios).length}, boot outbound: ${bootOutbound.length}`);
console.log(`fixture written to ${outputFile}`);
