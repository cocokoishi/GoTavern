#!/usr/bin/env node
// @gotavern-oracle: fixture=sillytavern-1.19.0-openai-transcribe.json label="openai transcribe"
// Probe the four pinned transcription routes built by `createTranscribeHandler` (openai.js:806):
//
//   POST /api/openai/transcribe-audio          -> https://api.openai.com/v1/audio/transcriptions
//   POST /api/openai/groq/transcribe-audio     -> https://api.groq.com/openai/v1/audio/transcriptions
//   POST /api/openai/mistral/transcribe-audio  -> https://api.mistral.ai/v1/audio/transcriptions
//   POST /api/openai/zai/transcribe-audio      -> https://api.z.ai/api/paas/v4/audio/transcriptions
//
// All four share ONE handler, so the fixture records each route against the same behaviour and the Go side
// has one implementation with four seams.
//
// THE MULTIPART HAZARD: the handler appends `fs.createReadStream(request.file.path)` to a `form-data`
// package FormData. That is the stream-backed body whose `[object FormData]`-plus-`pipe` combination the
// `recordBody` guard mis-routed once and which broke the speech probe. This probe therefore asserts, for
// every multipart scenario, that the recorded part list is NON-EMPTY -- so a request that failed to record
// can never look like a request the server never made.
//
// Refusals (no key, no file) answer 400 with ZERO outbound requests, asserted as a count per rule 17.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';

import { PINNED_COMMIT, PINNED_VERSION, captureHttp, parseMultipart, startPinnedProviderServer, writeFixture } from './lib/pinned-outbound.mjs';

const sourceRoot = path.resolve(process.argv[2] ?? '');
const repositoryRoot = path.resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3]) {
    console.error('usage: node tools/probe-openai-transcribe.mjs <pinned-source-clone> <gotavern-root>');
    process.exit(2);
}
if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim() !== PINNED_COMMIT) {
    throw new Error(`upstream checkout is not pinned at ${PINNED_COMMIT}`);
}

const OPENAI = 'https://api.openai.com/v1/audio/transcriptions';
const GROQ = 'https://api.groq.com/openai/v1/audio/transcriptions';
const MISTRAL = 'https://api.mistral.ai/v1/audio/transcriptions';
const ZAI = 'https://api.z.ai/api/paas/v4/audio/transcriptions';

const KEYS = {
    api_key_openai: 'synthetic-openai-key',
    api_key_groq: 'synthetic-groq-key',
    api_key_mistralai: 'synthetic-mistral-key',
    api_key_zai: 'synthetic-zai-key',
};

const AUDIO = Buffer.from('RIFFgotavern-synthetic-transcribe-audio-payload', 'utf8');
const TRANSCRIPT = { text: 'transcribed words', language: 'english' };

function secretEntry(key, value) {
    return { [key]: [{ id: `sid-${key}`, value, label: key, active: true }] };
}

const upload = (body = {}) => ({ field: 'avatar', filename: 'audio.wav', contentType: 'audio/wav', base64: AUDIO.toString('base64'), body });

const SCENARIOS = [
    { label: 'openaiOk', route: '/api/openai/transcribe-audio', body: { model: 'whisper-1' }, secrets: secretEntry('api_key_openai', KEYS.api_key_openai),
      mocks: [{ match: 'api.openai.com', payload: TRANSCRIPT }] },
    { label: 'openaiLanguage', route: '/api/openai/transcribe-audio', body: { model: 'whisper-1', language: 'en' }, secrets: secretEntry('api_key_openai', KEYS.api_key_openai),
      mocks: [{ match: 'api.openai.com', payload: TRANSCRIPT }] },
    { label: 'openaiNoKey', route: '/api/openai/transcribe-audio', body: { model: 'whisper-1' }, secrets: {}, mocks: [] },
    { label: 'openaiNoFile', route: '/api/openai/transcribe-audio', body: { model: 'whisper-1' }, secrets: secretEntry('api_key_openai', KEYS.api_key_openai), mocks: [], omitFile: true },
    { label: 'openaiNonOk', route: '/api/openai/transcribe-audio', body: { model: 'whisper-1' }, secrets: secretEntry('api_key_openai', KEYS.api_key_openai),
      mocks: [{ match: 'api.openai.com', status: 400, statusText: 'Bad Request', text: 'openai says no' }] },
    { label: 'openaiReservedModel', route: '/api/openai/transcribe-audio', body: { model: 'whisper 1;x=1' }, secrets: secretEntry('api_key_openai', KEYS.api_key_openai),
      mocks: [{ match: 'api.openai.com', payload: TRANSCRIPT }] },
    { label: 'groqOk', route: '/api/openai/groq/transcribe-audio', body: { model: 'whisper-large-v3' }, secrets: secretEntry('api_key_groq', KEYS.api_key_groq),
      mocks: [{ match: 'api.groq.com', payload: TRANSCRIPT }] },
    { label: 'groqNoKey', route: '/api/openai/groq/transcribe-audio', body: { model: 'whisper-large-v3' }, secrets: {}, mocks: [] },
    { label: 'mistralOk', route: '/api/openai/mistral/transcribe-audio', body: { model: 'voxtral-mini-latest' }, secrets: secretEntry('api_key_mistralai', KEYS.api_key_mistralai),
      mocks: [{ match: 'api.mistral.ai', payload: TRANSCRIPT }] },
    { label: 'mistralNoKey', route: '/api/openai/mistral/transcribe-audio', body: { model: 'voxtral-mini-latest' }, secrets: {}, mocks: [] },
    { label: 'zaiOk', route: '/api/openai/zai/transcribe-audio', body: { model: 'glm-asr' }, secrets: secretEntry('api_key_zai', KEYS.api_key_zai),
      mocks: [{ match: 'api.z.ai', payload: TRANSCRIPT }] },
    { label: 'zaiNonOk', route: '/api/openai/zai/transcribe-audio', body: { model: 'glm-asr' }, secrets: secretEntry('api_key_zai', KEYS.api_key_zai),
      mocks: [{ match: 'api.z.ai', status: 500, statusText: 'Internal Server Error', text: 'zai says no' }] },
];

const server = await startPinnedProviderServer({ sourceRoot, prefix: 'gotavern-openai-transcribe-oracle-', mocks: [] });
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
            body: rule.text !== undefined ? rule.text : JSON.stringify(rule.payload ?? {}),
        }));
        server.writeSecrets(scenario.secrets ?? {});
        server.setMocks(rules);
        let result;
        if (scenario.omitFile) {
            const form = new FormData();
            for (const [name, value] of Object.entries(scenario.body)) form.append(name, String(value));
            result = await server.postForm(scenario.route, form);
        } else {
            const form = new FormData();
            form.append('avatar', new Blob([AUDIO], { type: 'audio/wav' }), 'audio.wav');
            for (const [name, value] of Object.entries(scenario.body)) form.append(name, String(value));
            result = await server.postForm(scenario.route, form);
        }
        scenarios[scenario.label] = {
            route: scenario.route,
            requestBody: JSON.stringify(scenario.body),
            upload: scenario.omitFile ? null : upload(scenario.body),
            mocks: rules,
            secrets: server.readSecrets(),
            response: captureHttp(result),
            outbound: server.outbound().map(request => {
                // The multipart boundary is random per request, so the recorded content type carries a
                // marker instead of the value: recording it verbatim would make the fixture unstable across
                // runs and break the zero-diff gate for a reason that is not behaviour.
                const headers = { ...request.headers };
                if (typeof headers['content-type'] === 'string') {
                    headers['content-type'] = headers['content-type'].replace(/boundary="?[^";]+"?/i, 'boundary=<boundary>');
                }
                const record = { url: request.url, method: request.method, headers };
                if (request.bodyBase64 !== undefined) {
                    record.parts = parseMultipart(request.headers['content-type'] ?? '', request.bodyBase64);
                } else {
                    record.body = request.body;
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

const AUDIO_SHA = createHash('sha256').update(AUDIO).digest('hex');
const multipartLabels = [];
for (const scenario of SCENARIOS) {
    const recorded = scenarios[scenario.label];
    const parts = (recorded.outbound[0] ?? {}).parts;
    // Rule 14: a request that failed to record must not look like a request the server never made. For
    // every multipart scenario the recorded part list must be present and NON-EMPTY.
    if ((scenario.mocks ?? []).length > 0) {
        assert.ok(Array.isArray(parts) && parts.length > 0,
            `${scenario.label}: the peer recorded no multipart parts, so this run cannot be compared`);
        multipartLabels.push(scenario.label);
    }
}

const openaiOk = scenarios.openaiOk;
assert.equal(openaiOk.response.status, 200, 'the provider JSON is passed through');
assert.deepEqual(openaiOk.response.body, TRANSCRIPT, 'the transcription payload');
assert.equal(openaiOk.outbound.length, 1, 'exactly one upstream request');
assert.equal(openaiOk.outbound[0].url, OPENAI, 'the OpenAI endpoint');
assert.equal(openaiOk.outbound[0].method, 'POST', 'the method');
assert.equal(openaiOk.outbound[0].headers.authorization, `Bearer ${KEYS.api_key_openai}`, 'the bearer key');
assert.equal(openaiOk.outbound[0].headers['content-type'].startsWith('multipart/form-data'), true, 'the body is multipart');
assert.deepEqual(openaiOk.outbound[0].parts.map(part => part.name), ['file', 'model'], 'the part order, with no language part');
assert.equal(openaiOk.outbound[0].parts[0].filename, 'audio.wav', 'the file part is always named audio.wav');
assert.equal(openaiOk.outbound[0].parts[0].contentType, 'audio/wav', 'and typed audio/wav');
assert.equal(openaiOk.outbound[0].parts[0].sha256, AUDIO_SHA, 'the uploaded bytes are forwarded');
// parseMultipart records every part as bytes plus a digest, so a text field is compared by digest.
const digestOf = value => createHash('sha256').update(value, 'utf8').digest('hex');
assert.equal(openaiOk.outbound[0].parts[1].sha256, digestOf('whisper-1'), 'the model is a form FIELD here, not a path segment');
assert.equal(openaiOk.outbound[0].parts[1].bytes, Buffer.byteLength('whisper-1', 'utf8'), 'and its length');

const openaiLanguage = scenarios.openaiLanguage;
assert.deepEqual(openaiLanguage.outbound[0].parts.map(part => part.name), ['file', 'model', 'language'], 'a language member appends a third part');
assert.equal(openaiLanguage.outbound[0].parts[2].sha256, digestOf('en'), 'the language value');

const reserved = scenarios.openaiReservedModel;
assert.equal(reserved.outbound[0].parts[1].sha256, digestOf('whisper 1;x=1'), 'a reserved-character model round-trips as a form field value');

assert.equal(scenarios.openaiNoKey.response.status, 400, 'a missing key answers 400');
assert.equal(scenarios.openaiNoKey.outbound.length, 0, 'and reaches NO peer (rule 17)');
assert.equal(scenarios.openaiNoFile.response.status, 400, 'a missing file answers 400');
assert.equal(scenarios.openaiNoFile.outbound.length, 0, 'and reaches NO peer (rule 17)');
assert.equal(scenarios.openaiNonOk.response.status, 500, 'a provider error is a 500');
assert.equal(scenarios.openaiNonOk.response.bodyText, 'openai says no', 'the provider TEXT is forwarded');

assert.equal(scenarios.groqOk.outbound[0].url, GROQ, 'the Groq endpoint');
assert.equal(scenarios.groqOk.outbound[0].headers.authorization, `Bearer ${KEYS.api_key_groq}`, 'the Groq key');
assert.equal(scenarios.groqNoKey.response.status, 400, 'Groq without a key is a 400');
assert.equal(scenarios.groqNoKey.outbound.length, 0, 'and reaches no peer');
assert.equal(scenarios.mistralOk.outbound[0].url, MISTRAL, 'the Mistral endpoint');
assert.equal(scenarios.mistralOk.outbound[0].headers.authorization, `Bearer ${KEYS.api_key_mistralai}`, 'the Mistral key');
assert.equal(scenarios.mistralNoKey.response.status, 400, 'Mistral without a key is a 400');
assert.equal(scenarios.zaiOk.outbound[0].url, ZAI, 'the Z.AI endpoint');
assert.equal(scenarios.zaiOk.outbound[0].headers.authorization, `Bearer ${KEYS.api_key_zai}`, 'the Z.AI key');
assert.equal(scenarios.zaiNonOk.response.status, 500, 'a Z.AI provider error is a 500');
assert.equal(scenarios.zaiNonOk.response.bodyText, 'zai says no', 'the Z.AI provider text is forwarded');

const fixture = {
    schemaVersion: 1,
    baseline: { version: PINNED_VERSION, commit: PINNED_COMMIT },
    probe: 'tools/probe-openai-transcribe.mjs',
    implementedRoutes: [
        '/api/openai/transcribe-audio', '/api/openai/groq/transcribe-audio',
        '/api/openai/mistral/transcribe-audio', '/api/openai/zai/transcribe-audio',
    ],
    notImplementedRoutes: ['/api/openai/caption-image', '/api/openai/generate-video', '/api/openai/chutes/transcribe-audio'],
    notImplementedReasons: {
        '/api/openai/chutes/transcribe-audio': 'JSON with base64 audio and the model interpolated into the HOSTNAME; its own wave.',
        '/api/openai/caption-image': 'A chat-completions body over a large per-api branch table; its own wave.',
        '/api/openai/generate-video': 'A polling job with three fixed-host request shapes; its own wave.',
    },
    pinnedSource: {
        'src/endpoints/openai.js:806': 'createTranscribeHandler: reads request.file, appends fs.createReadStream to a form-data FormData, then model and optional language',
        'src/endpoints/openai.js:856': 'the four registrations, one fixed apiUrl each',
    },
    mechanism: 'Every upstream is a hardcoded literal, so the probe replaces the `node-fetch` module and the global `fetch` with a controlled peer; the Go side uses one handler with four seams and replays the peer through a real listener.',
    fields: [
        { path: 'scenarios.*.response.status', comparison: 'compared', reason: 'the pinned handler answers 200, 400 for a refusal or 500 for a provider error' },
        { path: 'scenarios.*.response.headers', comparison: 'compared', reason: 'json for a pass-through, html for the text bodies' },
        { path: 'scenarios.*.response.body/bodyText', comparison: 'compared', reason: 'the provider JSON pass-through and the forwarded provider text' },
        { path: 'scenarios.*.outbound[].url', comparison: 'compared', reason: 'four fixed endpoints, one per provider' },
        { path: 'scenarios.*.outbound[].headers', comparison: 'compared', reason: 'the bearer key and the multipart content type, asserted in both directions' },
        { path: 'scenarios.*.outbound[].parts', comparison: 'compared', reason: 'the multipart parts, because the boundary is random per request; the part list must be NON-EMPTY or the run refuses' },
        { path: 'scenarios.*.outbound.length', comparison: 'compared', reason: 'the refusals must reach NO peer, and every success exactly one' },
        { path: 'uploaded bytes', comparison: 'compared', reason: 'the forwarded file is compared by digest, and it is synthetic' },
    ],
    normalizations: ['The multipart boundary is random per request, so bodies are recorded as parsed parts and the content type records a boundary marker rather than the value.'],
    inputs: {
        audioSha256: AUDIO_SHA,
        audioBytes: AUDIO.length,
        transcript: TRANSCRIPT,
        keys: KEYS,
        multipartScenarios: multipartLabels,
    },
    bootOutbound,
    scenarios,
};

const outputFile = writeFixture(repositoryRoot, 'sillytavern-1.19.0-openai-transcribe.json', fixture);
console.log(`scenarios: ${Object.keys(scenarios).length}, boot outbound: ${bootOutbound.length}`);
console.log(`fixture written to ${outputFile}`);
