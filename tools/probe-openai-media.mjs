#!/usr/bin/env node
// Capture the pinned OpenAI media routes that can be driven without a provider matrix:
//
//	POST /api/openai/generate-voice                openai.js:273   binary audio
//	POST /api/openai/custom/generate-voice         openai.js:756   binary audio
//	POST /api/openai/electronhub/generate-voice    openai.js:321   binary audio, upstream content-type forwarded
//	POST /api/openai/chutes/generate-voice         openai.js:419   binary audio, upstream content-type forwarded
//	POST /api/openai/generate-image                openai.js:619   JSON passthrough
//
// SCOPE. The remaining /api/openai media routes and the whole /api/google domain are NOT probed
// and NOT implemented this round: transcribe-audio (four providers plus chutes), caption-image
// (a 250-line per-api matrix), generate-video (a five-second polling loop) and google (OAuth /
// api-key provider configuration, native PCM-to-WAV wrapping). They stay `not implemented` with
// the reasons recorded in the fixture.
//
// BINARY BODIES. The pinned-outbound stub can only carry UTF-8-representable payloads, so the
// recorded audio payloads are ASCII byte patterns. The response is captured as base64 plus SHA-256
// and length, and the Go replay compares those, never the bytes as text. Arbitrary binary framing
// beyond what a UTF-8 payload can express is a stated limitation, not a claimed property.
//
// @gotavern-oracle: this declaration is read by tools/build-generated-lib.mjs,
// which auto-discovers probes so that adding one needs no edit there.
// @gotavern-oracle: fixture=sillytavern-1.19.0-openai-media.json label="OpenAI media routes"

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';

import {
    PINNED_COMMIT, PINNED_VERSION, startPinnedProviderServer, writeFixture,
} from './lib/pinned-outbound.mjs';

const sourceRoot = path.resolve(process.argv[2] ?? '');
const repositoryRoot = path.resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3]) {
    console.error('usage: node tools/probe-openai-media.mjs <pinned-source-clone> <gotavern-root>');
    process.exit(2);
}
if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim() !== PINNED_COMMIT) {
    throw new Error(`upstream checkout is not pinned at ${PINNED_COMMIT}`);
}

const COOKIE_SECRET = 'gotavern-pinned-openai-media-cookie-secret';
const MOCK = '<mock>';
const PINNED_PEER = 'http://media-peer.example';

const SECRETS = {
    api_key_openai: 'probe-openai-key',
    api_key_electronhub: 'probe-electronhub-key',
    api_key_chutes: 'probe-chutes-key',
    api_key_custom_openai_tts: 'probe-custom-tts-key',
};

const SEAM_DEFAULTS = {
    GOTAVERN_OPENAI_API_URL: 'https://api.openai.com',
    GOTAVERN_OPENAI_ELECTRONHUB_URL: 'https://api.electronhub.ai',
    GOTAVERN_OPENAI_CHUTES_TTS_URL: 'https://chutes-kokoro.chutes.ai',
};

function secretFile(values) {
    const secrets = {};
    for (const [key, value] of Object.entries(values)) {
        secrets[key] = [{ id: `probe-id-${key}`, value, label: key, active: true }];
    }
    return secrets;
}

function materialize(value) {
    if (typeof value === 'string') return value.split(MOCK).join(PINNED_PEER);
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
    const body = Buffer.from(result.text, 'utf8');
    return {
        status: result.response.status,
        contentType: normalize(result.response.headers.get('content-type') ?? '') || null,
        contentLength: result.response.headers.get('content-length'),
        etag: result.response.headers.get('etag'),
        bodyBase64: body.toString('base64'),
        bodySha256: createHash('sha256').update(body).digest('hex'),
        bodyLength: body.length,
    };
}

const scenarios = [];
function addScenario(definition) {
    scenarios.push(definition);
}
const OK = { status: 200, headers: { 'content-type': 'application/json' } };

const audio = 'AUDIO-BYTES-0123456789';
const otherAudio = 'SECOND-AUDIO-PAYLOAD';

// ---- /generate-voice -------------------------------------------------------------------------
addScenario({
    name: 'generateVoice.ok',
    route: 'generate-voice',
    body: { text: 'hello', voice: 'nova', speed: 1.25, model: 'tts-1-hd' },
    upstream: [{ ...OK, path: '/v1/audio/speech', headers: { 'content-type': 'audio/mpeg' }, body: audio }],
});
addScenario({
    name: 'generateVoice.defaults',
    route: 'generate-voice',
    body: { text: 'hello' },
    upstream: [{ ...OK, path: '/v1/audio/speech', headers: { 'content-type': 'audio/mpeg' }, body: audio }],
});
addScenario({
    name: 'generateVoice.instructions',
    route: 'generate-voice',
    body: { text: 'hello', instructions: 'Speak slowly' },
    upstream: [{ ...OK, path: '/v1/audio/speech', headers: { 'content-type': 'audio/mpeg' }, body: audio }],
});
addScenario({
    name: 'generateVoice.noKey',
    route: 'generate-voice',
    body: { text: 'hello' },
    secrets: { ...SECRETS, api_key_openai: '' },
});
addScenario({
    name: 'generateVoice.nonOk',
    route: 'generate-voice',
    body: { text: 'hello' },
    upstream: [{ path: '/v1/audio/speech', status: 500, headers: { 'content-type': 'text/plain' }, body: 'provider said no' }],
});
addScenario({
    name: 'generateVoice.closedPort',
    route: 'generate-voice',
    body: { text: 'hello' },
    // The stub rejects this fetch, which is the same branch a closed port produces; the replay
    // reaches the branch through a real closed port and asserts the recording peer saw nothing.
    upstream: [{ path: '/v1/audio/speech', throws: true }],
    peer: 'closed',
});

// ---- /custom/generate-voice ------------------------------------------------------------------
addScenario({
    name: 'customVoice.ok',
    route: 'custom/generate-voice',
    body: { input: 'hello', provider_endpoint: `${MOCK}/custom-tts`, response_format: 'opus', voice: 'af_bella', speed: 0.5, model: 'custom-tts-1' },
    upstream: [{ ...OK, path: '/custom-tts', headers: { 'content-type': 'audio/ogg' }, body: otherAudio }],
});
addScenario({
    name: 'customVoice.defaults',
    route: 'custom/generate-voice',
    body: { provider_endpoint: `${MOCK}/custom-tts` },
    upstream: [{ ...OK, path: '/custom-tts', headers: { 'content-type': 'audio/mpeg' }, body: otherAudio }],
});
addScenario({
    name: 'customVoice.noEndpoint',
    route: 'custom/generate-voice',
    body: { input: 'hello' },
});
addScenario({
    name: 'customVoice.noKey',
    route: 'custom/generate-voice',
    body: { input: 'hello', provider_endpoint: `${MOCK}/custom-tts` },
    secrets: { ...SECRETS, api_key_custom_openai_tts: '' },
    upstream: [{ ...OK, path: '/custom-tts', headers: { 'content-type': 'audio/mpeg' }, body: otherAudio }],
});
addScenario({
    name: 'customVoice.nonOk',
    route: 'custom/generate-voice',
    body: { input: 'hello', provider_endpoint: `${MOCK}/custom-tts` },
    upstream: [{ path: '/custom-tts', status: 503, headers: { 'content-type': 'text/plain' }, body: 'custom failed' }],
});

// ---- /electronhub/generate-voice -------------------------------------------------------------
addScenario({
    name: 'electronhubVoice.forwardsContentType',
    route: 'electronhub/generate-voice',
    body: { input: 'hello', voice: 'af_heart', model: 'tts-1', response_format: 'mp3', temperature: 0.7 },
    upstream: [{ ...OK, path: '/v1/audio/speech', headers: { 'content-type': 'audio/ogg' }, body: otherAudio }],
});
addScenario({
    name: 'electronhubVoice.defaultContentType',
    route: 'electronhub/generate-voice',
    body: { input: 'hello' },
    upstream: [{ ...OK, path: '/v1/audio/speech', headers: {}, body: audio }],
});
addScenario({
    name: 'electronhubVoice.dynamicAndFiniteParams',
    route: 'electronhub/generate-voice',
    body: { input: 'hello', voice: 'v', instructions: 'x', speaker_transcript: 'y', cfg_scale: '2.5', cfg_filter_top_k: 'not-a-number', speech_rate: '1.1', pitch_adjustment: 0, emotional_style: 'calm', extra_field: 'kept', ignored_null: null },
    upstream: [{ ...OK, path: '/v1/audio/speech', headers: { 'content-type': 'audio/mpeg' }, body: audio }],
});
addScenario({
    name: 'electronhubVoice.noKey',
    route: 'electronhub/generate-voice',
    body: { input: 'hello' },
    secrets: { ...SECRETS, api_key_electronhub: '' },
});
addScenario({
    name: 'electronhubVoice.nonOk',
    route: 'electronhub/generate-voice',
    body: { input: 'hello' },
    upstream: [{ path: '/v1/audio/speech', status: 500, headers: { 'content-type': 'text/plain' }, body: 'electronhub failed' }],
});

// ---- /chutes/generate-voice ------------------------------------------------------------------
addScenario({
    name: 'chutesVoice.ok',
    route: 'chutes/generate-voice',
    body: { input: 'hello', voice: 'am_adam', speed: 1.5 },
    upstream: [{ ...OK, path: '/speak', headers: { 'content-type': 'audio/wav' }, body: otherAudio }],
});
addScenario({
    name: 'chutesVoice.defaults',
    route: 'chutes/generate-voice',
    body: { input: 'hello' },
    upstream: [{ ...OK, path: '/speak', headers: { 'content-type': 'audio/mpeg' }, body: audio }],
});
addScenario({
    name: 'chutesVoice.noKey',
    route: 'chutes/generate-voice',
    body: { input: 'hello' },
    secrets: { ...SECRETS, api_key_chutes: '' },
});
addScenario({
    name: 'chutesVoice.nonOk',
    route: 'chutes/generate-voice',
    body: { input: 'hello' },
    upstream: [{ path: '/speak', status: 500, headers: { 'content-type': 'text/plain' }, body: 'chutes failed' }],
});

// ---- /generate-image -------------------------------------------------------------------------
addScenario({
    name: 'generateImage.ok',
    route: 'generate-image',
    body: { model: 'gpt-image-1', prompt: 'a cat', size: '1024x1024', n: 1, unknown_field: { nested: true } },
    upstream: [{ ...OK, path: '/v1/images/generations', body: JSON.stringify({ created: 1700000000, data: [{ b64_json: 'SU1BR0U=' }] }) }],
});
addScenario({
    name: 'generateImage.emptyBody',
    route: 'generate-image',
    body: {},
    upstream: [{ ...OK, path: '/v1/images/generations', body: '{"data":[]}' }],
});
addScenario({
    name: 'generateImage.noKey',
    route: 'generate-image',
    body: { prompt: 'a cat' },
    secrets: { ...SECRETS, api_key_openai: '' },
});
addScenario({
    name: 'generateImage.nonOk',
    route: 'generate-image',
    body: { prompt: 'a cat' },
    upstream: [{ path: '/v1/images/generations', status: 400, headers: { 'content-type': 'text/plain' }, body: 'bad request body' }],
});
addScenario({
    name: 'generateImage.notJson',
    route: 'generate-image',
    body: { prompt: 'a cat' },
    upstream: [{ ...OK, path: '/v1/images/generations', body: 'not json' }],
});

// ---- fixture assembly -----------------------------------------------------------------------
async function main() {
    const server = await startPinnedProviderServer({ sourceRoot, prefix: 'gotavern-openai-media-oracle-', mocks: [] });
    try {
        const observations = {};
        const inputs = {};
        for (const scenario of scenarios) {
            const secrets = scenario.secrets ?? SECRETS;
            server.writeSecrets(secretFile(materialize(secrets)));
            server.setMocks((scenario.upstream ?? []).map(upstream => ({
                match: upstream.path,
                status: upstream.status,
                headers: upstream.headers ?? {},
                body: upstream.body,
                throws: upstream.throws === true,
            })));
            const body = materialize(scenario.body ?? {});
            const result = await server.post(`/api/openai/${scenario.route}`, JSON.stringify(body));
            const outbound = server.outbound().map(request => ({
                url: normalize(request.url),
                method: request.method,
                explicitHeaders: explicitHeaders(request.headers),
                body: normalize(request.body ?? ''),
            }));
            inputs[scenario.name] = {
                route: scenario.route,
                body: scenario.body ?? {},
                bodyText: JSON.stringify(scenario.body ?? {}),
                seam: scenario.seam ?? null,
                peer: scenario.peer ?? 'mock',
                secrets,
                upstream: scenario.upstream ?? [],
            };

            observations[scenario.name] = {
                ...captureResponse(result),
                outbound,
                comparison: {
                    compared: ['status', 'contentType', 'contentLength', 'etag', 'bodyBase64', 'bodySha256', 'bodyLength', 'outbound'],
                    shape: ['outbound[].transportConnection'],
                    shapeReason: {
                        'outbound[].transportConnection': 'the stub records the headers the route passed, not the transport Connection Node appends; only presence is asserted',
                    },
                },
            };
        }

        const knownDifferences = [{
            routes: ['/api/openai/caption-image', '/api/openai/transcribe-audio', '/api/openai/groq/transcribe-audio', '/api/openai/mistral/transcribe-audio', '/api/openai/zai/transcribe-audio', '/api/openai/chutes/transcribe-audio', '/api/openai/generate-video'],
            status: 'not implemented',
            reason: 'caption-image is a 250-line per-api provider matrix; the transcribe routes need multipart upload recording (part order and part headers) plus transcription peers; generate-video polls for five seconds per attempt with client-abort semantics. Each needs its own oracle harness, so they are deferred rather than faked.',
        }, {
            routes: ['/api/google/caption-image', '/api/google/generate-image', '/api/google/generate-video', '/api/google/generate-voice', '/api/google/generate-native-tts', '/api/google/list-voices', '/api/google/list-native-voices'],
            status: 'not implemented',
            reason: 'the Google domain needs OAuth/service-account or api-key provider configuration (getGoogleApiConfig), a static language table imported from google-translate-api-x, PCM-to-WAV wrapping and its own binary capture; it is untouched this round.',
        }];

        const fixture = {
            schemaVersion: 1,
            baseline: { version: PINNED_VERSION, commit: PINNED_COMMIT },
            probe: 'pinned OpenAI binary media routes: four voice-generation endpoints and the image generation passthrough',
            oracle: { file: 'src/endpoints/openai.js', mountedAt: '/api/openai (src/server-startup.js)' },
            conventions: {
                binary: 'audio bodies are recorded as base64, SHA-256 and byte length; the replay compares those values, never the bytes as text',
                mock: 'provider_endpoints supplied in the request body are recorded as the <mock> marker',
                stubLimit: 'the pinned-outbound stub carries UTF-8 payloads only, so the recorded audio bytes are an ASCII pattern; arbitrary binary framing is a stated limitation, not a claimed property',
            },
            nodeFetchWireDefaults: {
                headers: [['accept', '*/*'], ['accept-encoding', 'gzip, deflate, br'], ['user-agent', 'node-fetch']],
                verifiedBy: 'tests/oracle/sillytavern-1.19.0-sd-routes.json records the same defaults on the pinned wire',
            },
            fixtureFields: {
                compared: ['observations.*.status', 'observations.*.contentType', 'observations.*.contentLength', 'observations.*.etag', 'observations.*.bodyBase64', 'observations.*.bodySha256', 'observations.*.bodyLength', 'observations.*.outbound[] (url, method, explicitHeaders, body)'],
                shape: ['observations.*.outbound[].transportConnection'],
                notRecorded: ['ephemeral peer authority', 'pinned listen port', 'startup log'],
            },
            inputs: {
                cookieSecret: COOKIE_SECRET,
                account: { handle: 'default-user', name: 'OpenAI Media Probe', admin: true, password: '' },
                seamDefaults: SEAM_DEFAULTS,
                scenarios: inputs,
            },
            observations,
            knownDifferences,
        };
        writeFixture(repositoryRoot, 'sillytavern-1.19.0-openai-media.json', fixture);
        console.log('Wrote tests/oracle/sillytavern-1.19.0-openai-media.json from pinned /api/openai media behaviour');
    } finally {
        await server.stop();
    }
}

await main();
