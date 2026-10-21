#!/usr/bin/env node
// @gotavern-oracle: fixture=sillytavern-1.19.0-speech.json label="speech"
// Probe the pinned /api/speech/* routes that talk to a third-party service, against the REAL pinned
// server with its node-fetch replaced by a controlled peer (tools/lib/pinned-outbound.mjs).
//
// Nine routes are pinned here. The other two are NOT, and the fixture says so:
//
//   POST /api/speech/recognize  speech.js:42
//   POST /api/speech/synthesize speech.js:61
//
// Both call `getPipeline()` from src/transformers.js, i.e. a LOCAL ONNX inference pipeline whose model
// weights are downloaded from the Hugging Face hub and whose output is model-dependent. The behaviour
// lives in `@huggingface/transformers` plus those weights, not in the pinned endpoint, so there is no
// controlled-peer oracle and no way to pin a transcription or a waveform. They stay `not implemented`
// rather than being approximated (AGENTS.md rule 18).
//
// Two observations need explanation because they are not raw text:
//   - audio responses are recorded by digest, never as text (a UTF-8 round trip corrupts binary);
//   - multipart bodies are recorded as PARSED PARTS, because form-data generates a random boundary,
//     so the raw bytes can never be compared but the parts the peer observes can.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import {
    PINNED_COMMIT, PINNED_VERSION, captureHttp, captureHttpBinary, parseMultipart,
    startPinnedProviderServer, writeFixture,
} from './lib/pinned-outbound.mjs';

const sourceRoot = path.resolve(process.argv[2] ?? '');
const repositoryRoot = path.resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3]) {
    console.error('usage: node tools/probe-speech.mjs <pinned-source-clone> <gotavern-root>');
    process.exit(2);
}
if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim() !== PINNED_COMMIT) {
    throw new Error(`upstream checkout is not pinned at ${PINNED_COMMIT}`);
}

const POLLINATIONS = 'https://gen.pollinations.ai';
const ELEVENLABS = 'https://api.elevenlabs.io';
const ELEVENLABS_KEY = 'sk-synthetic-elevenlabs-key';
const POLLINATIONS_KEY = 'sk-synthetic-pollinations-key';

// A deterministic "audio" payload: the routes forward or base64-decode these bytes, so the digest of
// the response is the assertion.
const AUDIO_MAGIC = Buffer.from('ID3gotavern-synthetic-audio-payload-0123456789', 'utf8');
const AUDIO_BASE64 = AUDIO_MAGIC.toString('base64');
const WAV_UPLOAD = Buffer.from('RIFFgotavern-synthetic-wav-upload-payload', 'utf8');

function secretEntry(key, value) {
    return { [key]: [{ id: `sid-${key}`, value, label: key, active: true }] };
}

const MODELS_PAYLOAD = [
    { name: 'other-model', voices: ['should-not-appear'] },
    { name: 'openai-audio', voices: ['alloy', 'echo'], aliases: ['tts-1'] },
];

const SCENARIOS = [
    // ── /pollinations/voices ───────────────────────────────────────────────────────────────────
    { label: 'voicesDefaultModel', route: '/api/speech/pollinations/voices', body: '{}', payload: MODELS_PAYLOAD },
    { label: 'voicesByAlias', route: '/api/speech/pollinations/voices', body: '{"model":"tts-1"}', payload: MODELS_PAYLOAD },
    { label: 'voicesUnknownModel', route: '/api/speech/pollinations/voices', body: '{"model":"nope"}', payload: MODELS_PAYLOAD },
    { label: 'voicesNoVoices', route: '/api/speech/pollinations/voices', body: '{"model":"no-voices"}', payload: [{ name: 'no-voices' }] },
    { label: 'voicesNotArray', route: '/api/speech/pollinations/voices', body: '{}', payload: { nope: true } },
    { label: 'voicesNonOk', route: '/api/speech/pollinations/voices', body: '{}', status: 503, statusText: 'Service Unavailable', text: 'pollinations down' },
    { label: 'voicesThrows', route: '/api/speech/pollinations/voices', body: '{}', throws: true },

    // ── /pollinations/generate ────────────────────────────────────────────────────────────────
    { label: 'generateNoKey', route: '/api/speech/pollinations/generate', body: '{"text":"hello"}', secrets: {}, match: 'gen.pollinations.ai' },
    { label: 'generateOk', route: '/api/speech/pollinations/generate', body: '{"text":"hello"}', secrets: secretEntry('api_key_pollinations', POLLINATIONS_KEY), payload: { choices: [{ message: { audio: { data: AUDIO_BASE64 } } }] }, binaryResponse: true },
    { label: 'generateModelAndVoice', route: '/api/speech/pollinations/generate', body: '{"text":"hello","model":"openai-audio-large","voice":"nova"}', secrets: secretEntry('api_key_pollinations', POLLINATIONS_KEY), payload: { choices: [{ message: { audio: { data: AUDIO_BASE64 } } }] }, binaryResponse: true },
    { label: 'generateMissingAudio', route: '/api/speech/pollinations/generate', body: '{"text":"hello"}', secrets: secretEntry('api_key_pollinations', POLLINATIONS_KEY), payload: { choices: [{ message: {} }] } },
    { label: 'generateNonOk', route: '/api/speech/pollinations/generate', body: '{"text":"hello"}', secrets: secretEntry('api_key_pollinations', POLLINATIONS_KEY), status: 402, statusText: 'Payment Required', text: 'no credits' },
    { label: 'generateInvalidJSON', route: '/api/speech/pollinations/generate', body: '{"text":"hello"}', secrets: secretEntry('api_key_pollinations', POLLINATIONS_KEY), raw: 'not json' },
    { label: 'generateThrows', route: '/api/speech/pollinations/generate', body: '{"text":"hello"}', secrets: secretEntry('api_key_pollinations', POLLINATIONS_KEY), throws: true },

    // ── /elevenlabs/voices, /voice-settings, /history ─────────────────────────────────────────
    { label: 'elevenlabsVoicesNoKey', route: '/api/speech/elevenlabs/voices', body: '{}', secrets: {}, match: 'api.elevenlabs.io' },
    { label: 'elevenlabsVoicesOk', route: '/api/speech/elevenlabs/voices', body: '{}', secrets: secretEntry('api_key_elevenlabs', ELEVENLABS_KEY), payload: { voices: [{ voice_id: 'v1', name: 'Voice One' }] } },
    { label: 'elevenlabsVoicesNonOk', route: '/api/speech/elevenlabs/voices', body: '{}', secrets: secretEntry('api_key_elevenlabs', ELEVENLABS_KEY), status: 401, statusText: 'Unauthorized', text: 'bad key' },
    { label: 'elevenlabsVoiceSettingsOk', route: '/api/speech/elevenlabs/voice-settings', body: '{}', secrets: secretEntry('api_key_elevenlabs', ELEVENLABS_KEY), payload: { stability: 0.5, similarity_boost: 0.75 } },
    { label: 'elevenlabsHistoryOk', route: '/api/speech/elevenlabs/history', body: '{}', secrets: secretEntry('api_key_elevenlabs', ELEVENLABS_KEY), payload: { history: [{ history_item_id: 'h1' }], has_more: false } },
    { label: 'elevenlabsHistoryNonOk', route: '/api/speech/elevenlabs/history', body: '{}', secrets: secretEntry('api_key_elevenlabs', ELEVENLABS_KEY), status: 500, statusText: 'Internal Server Error', text: 'boom' },

    // ── /elevenlabs/synthesize (streamed audio) ───────────────────────────────────────────────
    { label: 'synthesizeNoKey', route: '/api/speech/elevenlabs/synthesize', body: '{"voiceId":"v1","request":{}}', secrets: {}, match: 'api.elevenlabs.io' },
    { label: 'synthesizeMissingVoice', route: '/api/speech/elevenlabs/synthesize', body: '{"request":{}}', secrets: secretEntry('api_key_elevenlabs', ELEVENLABS_KEY), match: 'api.elevenlabs.io' },
    { label: 'synthesizeMissingRequest', route: '/api/speech/elevenlabs/synthesize', body: '{"voiceId":"v1"}', secrets: secretEntry('api_key_elevenlabs', ELEVENLABS_KEY), match: 'api.elevenlabs.io' },
    { label: 'synthesizeOk', route: '/api/speech/elevenlabs/synthesize', body: '{"voiceId":"voice/one","request":{"text":"hello","model_id":"eleven_multilingual_v2","voice_settings":{"stability":0.4}}}', secrets: secretEntry('api_key_elevenlabs', ELEVENLABS_KEY), binary: AUDIO_MAGIC },
    // The request sub-object is RE-SERIALIZED by JSON.stringify, so a body whose raw text is not
    // canonical (spaces, 0.50, 1e2) is the only way to distinguish re-serialization from a pass-through
    // of the submitted text. Without this scenario a mutation that forwarded the raw member passed.
    { label: 'synthesizeReserialized', route: '/api/speech/elevenlabs/synthesize', body: '{"voiceId":"v1","request":{ "text" : "hello" , "stability" : 0.50 , "seed" : 1e2 }}', secrets: secretEntry('api_key_elevenlabs', ELEVENLABS_KEY), binary: AUDIO_MAGIC },
    { label: 'synthesizeEmptyRequest', route: '/api/speech/elevenlabs/synthesize', body: '{"voiceId":"v1","request":{}}', secrets: secretEntry('api_key_elevenlabs', ELEVENLABS_KEY), binary: AUDIO_MAGIC },
    { label: 'synthesizeNonOk', route: '/api/speech/elevenlabs/synthesize', body: '{"voiceId":"v1","request":{"text":"hello"}}', secrets: secretEntry('api_key_elevenlabs', ELEVENLABS_KEY), status: 422, statusText: 'Unprocessable Entity', text: 'bad request' },
    { label: 'synthesizeThrows', route: '/api/speech/elevenlabs/synthesize', body: '{"voiceId":"v1","request":{"text":"hello"}}', secrets: secretEntry('api_key_elevenlabs', ELEVENLABS_KEY), throws: true },

    // ── /elevenlabs/history-audio (streamed audio) ────────────────────────────────────────────
    { label: 'historyAudioNoId', route: '/api/speech/elevenlabs/history-audio', body: '{}', secrets: secretEntry('api_key_elevenlabs', ELEVENLABS_KEY), match: 'api.elevenlabs.io' },
    { label: 'historyAudioOk', route: '/api/speech/elevenlabs/history-audio', body: '{"historyItemId":"item/one"}', secrets: secretEntry('api_key_elevenlabs', ELEVENLABS_KEY), binary: AUDIO_MAGIC },
    { label: 'historyAudioNonOk', route: '/api/speech/elevenlabs/history-audio', body: '{"historyItemId":"item-one"}', secrets: secretEntry('api_key_elevenlabs', ELEVENLABS_KEY), status: 404, statusText: 'Not Found', text: 'no such item' },

    // ── /elevenlabs/voices/add (multipart upstream) ───────────────────────────────────────────
    { label: 'voicesAddDefaults', route: '/api/speech/elevenlabs/voices/add', body: '{}', secrets: secretEntry('api_key_elevenlabs', ELEVENLABS_KEY), payload: { voice_id: 'new-voice' } },
    { label: 'voicesAddWithFiles', route: '/api/speech/elevenlabs/voices/add', body: JSON.stringify({ name: 'My Voice', description: 'described', labels: '{"accent":"british"}', files: [`data:audio/wav;base64,${WAV_UPLOAD.toString('base64')}`] }), secrets: secretEntry('api_key_elevenlabs', ELEVENLABS_KEY), payload: { voice_id: 'new-voice' } },
    { label: 'voicesAddInvalidFile', route: '/api/speech/elevenlabs/voices/add', body: JSON.stringify({ name: 'X', files: ['not-a-data-uri', 'data:audio/mpeg;base64,!!!notbase64'] }), secrets: secretEntry('api_key_elevenlabs', ELEVENLABS_KEY), payload: { voice_id: 'new-voice' } },
    { label: 'voicesAddNoKey', route: '/api/speech/elevenlabs/voices/add', body: '{}', secrets: {}, match: 'api.elevenlabs.io' },
    { label: 'voicesAddNonOk', route: '/api/speech/elevenlabs/voices/add', body: '{}', secrets: secretEntry('api_key_elevenlabs', ELEVENLABS_KEY), status: 500, statusText: 'Internal Server Error', text: 'upload failed' },

    // ── /elevenlabs/recognize (multipart IN and OUT) ──────────────────────────────────────────
    { label: 'recognizeNoFile', route: '/api/speech/elevenlabs/recognize', body: '{"model":"scribe_v1"}', secrets: secretEntry('api_key_elevenlabs', ELEVENLABS_KEY), match: 'api.elevenlabs.io' },
    { label: 'recognizeNoKey', route: '/api/speech/elevenlabs/recognize', body: '{"model":"scribe_v1"}', upload: { field: 'avatar', filename: 'audio.wav', contentType: 'audio/wav', base64: WAV_UPLOAD.toString('base64') }, secrets: {}, match: 'api.elevenlabs.io' },
    { label: 'recognizeOk', route: '/api/speech/elevenlabs/recognize', body: '{"model":"scribe_v1"}', upload: { field: 'avatar', filename: 'audio.wav', contentType: 'audio/wav', base64: WAV_UPLOAD.toString('base64') }, secrets: secretEntry('api_key_elevenlabs', ELEVENLABS_KEY), payload: { text: 'transcribed words' } },
    { label: 'recognizeNonOk', route: '/api/speech/elevenlabs/recognize', body: '{"model":"scribe_v1"}', upload: { field: 'avatar', filename: 'audio.wav', contentType: 'audio/wav', base64: WAV_UPLOAD.toString('base64') }, secrets: secretEntry('api_key_elevenlabs', ELEVENLABS_KEY), status: 400, statusText: 'Bad Request', text: 'bad audio' },
];

// A multipart boundary is random per request, so the recorded content type carries a marker instead of
// the bytes. Everything else in the header set is compared exactly.
const BOUNDARY_PATTERN = /boundary="?[^";]+"?/gi;
function normalizeBoundary(headers) {
    const normalized = {};
    for (const [name, value] of Object.entries(headers)) {
        normalized[name] = typeof value === 'string' ? value.replace(BOUNDARY_PATTERN, 'boundary=<boundary>') : value;
    }
    return normalized;
}

const SEED_PATTERN = /"seed":\d+/g;
function normalizeSeed(text) {
    return typeof text === 'string' ? text.replace(SEED_PATTERN, '"seed":"<seed>"') : text;
}

const server = await startPinnedProviderServer({ sourceRoot, prefix: 'gotavern-speech-oracle-', mocks: [] });
const scenarios = {};
let bootOutbound = [];
let uploadsDirectory = null;
try {
    bootOutbound = server.bootOutbound;
    // multer's global middleware writes the uploaded file here; recording the directory afterwards is
    // what shows the temp-file lifecycle.
    uploadsDirectory = server.uploadsRoot;
    for (const scenario of SCENARIOS) {
        const rule = {
            match: scenario.match ?? (scenario.route.includes('/elevenlabs/') ? 'api.elevenlabs.io' : 'gen.pollinations.ai'),
            status: scenario.status ?? 200,
            statusText: scenario.statusText ?? 'OK',
            headers: scenario.binary ? { 'content-type': 'audio/mpeg' } : { 'content-type': 'application/json' },
            body: scenario.raw ?? (scenario.binary ? scenario.binary.toString('base64') : scenario.text !== undefined ? scenario.text : JSON.stringify(scenario.payload ?? {})),
            binaryBody: scenario.binary !== undefined,
            throws: scenario.throws === true,
        };
        if (process.env.GOTAVERN_SPEECH_DEBUG) console.log('STEP', scenario.label);
        server.setMocks([rule]);
        server.writeSecrets(scenario.secrets ?? {});
        const uploadsBefore = listUploads(uploadsDirectory);
        let result;
        if (scenario.upload) {
            const form = new FormData();
            form.append(
                scenario.upload.field,
                new Blob([Buffer.from(scenario.upload.base64, 'base64')], { type: scenario.upload.contentType }),
                scenario.upload.filename,
            );
            for (const [name, value] of Object.entries(JSON.parse(scenario.body))) {
                form.append(name, String(value));
            }
            result = await server.postForm(scenario.route, form);
        } else {
            result = await server.post(scenario.route, scenario.body);
        }
        const uploadsAfter = listUploads(uploadsDirectory);
        const requests = server.outbound();
        const captured = (scenario.binary !== undefined || scenario.binaryResponse === true)
            ? captureHttpBinary(result)
            : captureHttp(result);
        const outbound = requests.map(request => {
            const record = {
                url: request.url,
                method: request.method,
                headers: normalizeBoundary(request.headers),
            };
            if (request.bodyBase64 !== undefined) {
                const contentType = request.headers['content-type'] ?? '';
                record.parts = parseMultipart(contentType, request.bodyBase64);
                record.bodyBase64Bytes = Buffer.from(request.bodyBase64, 'base64').length;
            } else {
                // The random seed exists only in the Pollinations body; normalizing everywhere would hide
                // a real number in another route's body.
                record.body = request.url.includes('/v1/chat/completions') ? normalizeSeed(request.body) : request.body;
            }
            return record;
        });
        scenarios[scenario.label] = {
            route: scenario.route,
            requestBody: scenario.body,
            requestUpload: scenario.upload ?? null,
            mocks: [rule],
            secrets: server.readSecrets(),
            response: captured,
            outbound,
            uploadsAfter: uploadsAfter,
            uploadsCreated: uploadsAfter.length - uploadsBefore.length,
        };
    }
} finally {
    await server.stop();
}

function listUploads(directory) {
    try {
        return readdirSync(directory)
            .map(name => {
                const bytes = readFileSync(path.join(directory, name));
                return { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
            })
            .sort((left, right) => left.sha256.localeCompare(right.sha256));
    } catch {
        return [];
    }
}

if (process.env.GOTAVERN_SPEECH_DEBUG) { for (const [label, value] of Object.entries(scenarios)) { console.log(label, JSON.stringify(value.response), JSON.stringify(value.outbound)); } }

// ── assertions: the fixture must pin each behaviour, not merely record a status ─────────────────
assert.deepEqual(scenarios.voicesDefaultModel.response.body, ['alloy', 'echo'],
    'the default model is openai-audio and its voices are returned');
assert.deepEqual(scenarios.voicesByAlias.response.body, ['alloy', 'echo'], 'an alias match selects the model');
assert.equal(scenarios.voicesUnknownModel.response.status, 500, 'no matching model is a 500');
assert.equal(scenarios.voicesNoVoices.response.status, 500, 'a model without a voices array is a 500');
assert.equal(scenarios.voicesNotArray.response.status, 500, 'a non-array payload is a 500');
assert.equal(requireOutbound('voicesDefaultModel', 0).url, `${POLLINATIONS}/text/models`, 'voices fetches the pinned models URL');
assert.equal(scenarios.generateNoKey.response.status, 400, 'generate without a Pollinations key answers 400');
assert.equal(scenarios.generateNoKey.outbound.length, 0, 'a missing key must not reach the peer');
assert.equal(scenarios.generateOk.response.status, 200, 'generate answers 200');
assert.equal(scenarios.generateOk.response.headers['content-type'], 'audio/mpeg', 'generate answers audio/mpeg');
assert.equal(scenarios.generateOk.response.sha256, createHash('sha256').update(AUDIO_MAGIC).digest('hex'),
    'the base64 audio data is decoded and returned as bytes');
assert.equal(requireOutbound('generateOk', 0).url, `${POLLINATIONS}/v1/chat/completions`, 'generate posts to the pinned completions URL');
const generateBody = JSON.parse(requireOutbound('generateOk', 0).body);
assert.equal(generateBody.model, 'openai-audio', 'the default model is openai-audio');
assert.equal(generateBody.audio.voice, 'alloy', 'the default voice is alloy');
assert.equal(generateBody.stream, false, 'stream is false');
assert.deepEqual(generateBody.modalities, ['text', 'audio'], 'modalities is the pinned pair');
assert.equal(generateBody.messages[0].role, 'user', 'the text is sent as a user message');
assert.equal(generateBody.messages[0].content, 'hello', 'the text reaches the message content');
assert.equal(requireOutbound('generateOk', 0).body.includes('"seed":"<seed>"'), true, 'the seed is randomized per request');
assert.equal(requireOutbound('generateOk', 0).headers.authorization, `Bearer ${POLLINATIONS_KEY}`, 'generate carries the bearer key');
assert.equal(scenarios.generateMissingAudio.response.status, 500, 'missing audio data is a 500');
assert.equal(requireOutbound('generateModelAndVoice', 0).body.includes('"model":"openai-audio-large"'), true, 'the requested model is forwarded');
assert.equal(requireOutbound('generateModelAndVoice', 0).body.includes('"voice":"nova"'), true, 'the requested voice is forwarded');

assert.equal(scenarios.elevenlabsVoicesNoKey.response.status, 400, 'a missing ElevenLabs key answers 400');
assert.deepEqual(scenarios.elevenlabsVoicesOk.response.body, { voices: [{ voice_id: 'v1', name: 'Voice One' }] }, 'voices passes the payload through');
assert.equal(requireOutbound('elevenlabsVoicesOk', 0).url, `${ELEVENLABS}/v1/voices`, 'voices fetches the pinned URL');
assert.equal(requireOutbound('elevenlabsVoicesOk', 0).headers['xi-api-key'], ELEVENLABS_KEY, 'the key travels in xi-api-key');
assert.deepEqual(scenarios.elevenlabsVoiceSettingsOk.response.body, { stability: 0.5, similarity_boost: 0.75 }, 'voice-settings passes the payload through');
assert.equal(requireOutbound('elevenlabsVoiceSettingsOk', 0).url, `${ELEVENLABS}/v1/voices/settings/default`, 'voice-settings URL');
assert.equal(requireOutbound('elevenlabsHistoryOk', 0).url, `${ELEVENLABS}/v1/history`, 'history URL');
assert.equal(scenarios.elevenlabsHistoryNonOk.response.status, 500, 'a non-ok history answer is a 500');

assert.equal(scenarios.synthesizeMissingVoice.response.status, 400, 'synthesize without voiceId answers 400');
assert.equal(scenarios.synthesizeMissingRequest.response.status, 400, 'synthesize without request answers 400');
assert.equal(scenarios.synthesizeEmptyRequest.response.status, 200, 'an EMPTY request object is truthy, so it passes the guard');
assert.equal(requireOutbound('synthesizeOk', 0).url, `${ELEVENLABS}/v1/text-to-speech/voice/one`, 'the voiceId is interpolated into the path');
assert.equal(requireOutbound('synthesizeOk', 0).body, '{"text":"hello","model_id":"eleven_multilingual_v2","voice_settings":{"stability":0.4}}',
    'the request sub-object is re-serialized as the upstream JSON body');
assert.equal(requireOutbound('synthesizeReserialized', 0).body, '{"text":"hello","stability":0.5,"seed":100}',
    're-serialization normalizes whitespace, 0.50 and 1e2, which forwarding the raw member text would not');
assert.equal(scenarios.synthesizeOk.response.headers['content-type'], 'audio/mpeg', 'synthesize answers audio/mpeg');
assert.equal(scenarios.synthesizeOk.response.sha256, createHash('sha256').update(AUDIO_MAGIC).digest('hex'), 'the audio bytes are forwarded');
assert.equal(scenarios.synthesizeNonOk.response.status, 500, 'a non-ok synthesize answer is a 500');
assert.equal(scenarios.synthesizeThrows.response.status, 500, 'a rejected synthesize fetch is a 500');

assert.equal(scenarios.historyAudioNoId.response.status, 400, 'history-audio without an id answers 400');
assert.equal(requireOutbound('historyAudioOk', 0).url, `${ELEVENLABS}/v1/history/item/one/audio`, 'the history id is interpolated');
assert.equal(scenarios.historyAudioOk.response.sha256, createHash('sha256').update(AUDIO_MAGIC).digest('hex'), 'history audio bytes are forwarded');
assert.equal(scenarios.historyAudioNonOk.response.status, 500, 'a non-ok history-audio answer is a 500');

const voicesAddParts = requireOutbound('voicesAddDefaults', 0).parts;
assert.deepEqual(voicesAddParts.map(part => part.name), ['name', 'description', 'labels'], 'the default fields are sent in order');
assert.equal(requireOutbound('voicesAddDefaults', 0).url, `${ELEVENLABS}/v1/voices/add`, 'voices/add URL');
const withFiles = requireOutbound('voicesAddWithFiles', 0).parts;
assert.deepEqual(withFiles.map(part => part.name), ['name', 'description', 'labels', 'files'], 'a file part is appended after the text fields');
assert.equal(withFiles[3].filename, 'audio.wav', 'the filename extension comes from the mime type');
assert.equal(withFiles[3].contentType, 'audio/wav', 'the part content type is the data-URI mime type');
assert.equal(withFiles[3].sha256, createHash('sha256').update(WAV_UPLOAD).digest('hex'), 'the decoded data-URI bytes are sent');
const invalidFileParts = requireOutbound('voicesAddInvalidFile', 0).parts;
assert.deepEqual(invalidFileParts.map(part => part.name), ['name', 'description', 'labels', 'files'],
    'the non-data-URI entry is skipped, while the malformed-base64 data URI still produces a file part');
assert.equal(invalidFileParts[3].filename, 'audio.mpga', 'the measured mime-types extension for audio/mpeg is mpga, not mpeg');
assert.equal(invalidFileParts[3].sha256, createHash('sha256').update(Buffer.from('!!!notbase64', 'base64')).digest('hex'),
    'Buffer.from decodes the malformed base64 the way the pinned route does, which drops the invalid characters');

assert.equal(scenarios.recognizeNoFile.response.status, 400, 'recognize without an uploaded file answers 400');
assert.equal(requireOutbound('recognizeOk', 0).url, `${ELEVENLABS}/v1/speech-to-text`, 'recognize URL');
assert.deepEqual(requireOutbound('recognizeOk', 0).parts.map(part => part.name), ['file', 'model_id'], 'the file part precedes model_id');
assert.equal(requireOutbound('recognizeOk', 0).parts[0].filename, 'audio.wav', 'the upstream file is always named audio.wav');
assert.equal(requireOutbound('recognizeOk', 0).parts[0].contentType, 'audio/wav', 'the upstream part is audio/wav');
assert.equal(requireOutbound('recognizeOk', 0).parts[0].sha256, createHash('sha256').update(WAV_UPLOAD).digest('hex'), 'the uploaded bytes are forwarded');
assert.equal(requireOutbound('recognizeOk', 0).parts[1].name, 'model_id', 'the model field is forwarded');
assert.deepEqual(scenarios.recognizeOk.response.body, { text: 'transcribed words' }, 'recognize passes the payload through');
assert.equal(scenarios.recognizeNoKey.response.status, 400, 'recognize without a key answers 400');
assert.equal(scenarios.recognizeNonOk.response.status, 500, 'a non-ok recognize answer is a 500');

const fixture = {
    schemaVersion: 1,
    baseline: { version: PINNED_VERSION, commit: PINNED_COMMIT },
    probe: 'tools/probe-speech.mjs',
    implementedRoutes: [
        '/api/speech/pollinations/voices', '/api/speech/pollinations/generate',
        '/api/speech/elevenlabs/voices', '/api/speech/elevenlabs/voice-settings',
        '/api/speech/elevenlabs/synthesize', '/api/speech/elevenlabs/history',
        '/api/speech/elevenlabs/history-audio', '/api/speech/elevenlabs/voices/add',
        '/api/speech/elevenlabs/recognize',
    ],
    notImplementedRoutes: [
        {
            route: '/api/speech/recognize',
            reason: 'speech.js:42 calls getPipeline() from src/transformers.js, i.e. LOCAL ONNX inference whose weights are downloaded from the Hugging Face hub and whose output depends on those weights. The behaviour is not in the pinned endpoint, so a controlled peer cannot pin a transcription.',
        },
        {
            route: '/api/speech/synthesize',
            reason: 'speech.js:61 calls getPipeline() from src/transformers.js, i.e. LOCAL ONNX inference and a wavefile encode. No third-party request exists to pin and the waveform is model-dependent.',
        },
    ],
    mechanism: 'Every upstream here is a hardcoded literal with no configuration seam, so the probe replaces only the node-fetch module of the pinned server with a controlled peer (tools/lib/pinned-outbound.mjs).',
    fields: [
        { path: 'scenarios.*.response.status', comparison: 'compared', reason: 'the pinned handlers choose 200/400/500 themselves, including the 401 to 400 rewrite of forwardFetchResponse' },
        { path: 'scenarios.*.response.headers', comparison: 'compared', reason: 'Express and the pinned middleware stack set them, including the explicit audio/mpeg content type' },
        { path: 'scenarios.*.response.bodyText', comparison: 'compared', reason: 'JSON responses are compared as bytes' },
        { path: 'scenarios.*.response.sha256', comparison: 'compared', reason: 'audio responses are compared by digest because a text round trip would corrupt binary bytes' },
        { path: 'scenarios.*.outbound[].url', comparison: 'compared', reason: 'the constructed upstream URL, including interpolated voice and history ids' },
        { path: 'scenarios.*.outbound[].body', comparison: 'compared', reason: 'the JSON body, with the per-request random seed normalized' },
        { path: 'scenarios.*.outbound[].parts', comparison: 'compared', reason: 'multipart bodies are compared as parsed parts: the boundary is random per request, so the raw bytes cannot be' },
        { path: 'scenarios.*.outbound[].headers', comparison: 'shape', reason: 'only the declared xi-api-key, authorization and content-type headers are asserted' },
        { path: 'scenarios.*.uploadsCreated/uploadsAfter', comparison: 'shape', reason: "multer's temp-file lifecycle in _uploads is recorded for the reader but NOT compared: GoTavern parses the upload in memory, so it creates no temp file. Named as a known difference in the compat row." },
        { path: 'translated/synthesized third-party content', comparison: 'shape', reason: 'the fixture supplies the peer payload and asserts the transform, never a live answer' },
    ],
    normalizations: [
        'The Pollinations seed is `Math.floor(Math.random() * 2^32)`, so it is replaced by <seed> in the recorded outbound body; it is the only nondeterministic value in this domain.',
        'Multipart boundaries are random per request, so multipart bodies are recorded as parsed parts (name, filename, content type, content digest) rather than bytes.',
        'Audio responses are recorded by SHA-256 and length, never as text.',
        'Synthetic credentials only.',
    ],
    inputs: { pollinations: POLLINATIONS, elevenlabs: ELEVENLABS, elevenLabsKey: ELEVENLABS_KEY, pollinationsKey: POLLINATIONS_KEY, audioSha256: createHash('sha256').update(AUDIO_MAGIC).digest('hex'), wavSha256: createHash('sha256').update(WAV_UPLOAD).digest('hex') },
    bootOutbound,
    scenarios,
};

const outputFile = writeFixture(repositoryRoot, 'sillytavern-1.19.0-speech.json', fixture);
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