#!/usr/bin/env node
// @gotavern-oracle: fixture=sillytavern-1.19.0-google-native-tts.json label="google native tts"
// Probe the pinned `/api/google/generate-native-tts` route (google.js:356) across all four auth branches.
//
// The clock is FROZEN for the pinned child through NODE_OPTIONS, because the Vertex service-account branch
// mints an RS256 JWT whose `iat`/`exp` come from Date.now(). RS256 with PKCS#1 v1.5 is deterministic, so
// with a fixed key and a fixed clock the ENTIRE compact serialisation must match byte for byte, and the
// token request body at the peer is the assertion that proves it.
//
// The service-account private key is a SYNTHETIC 2048-bit key embedded here, never a real credential, and
// it is embedded rather than generated so the fixture is byte-stable across runs.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { PINNED_COMMIT, PINNED_VERSION, captureHttp, captureHttpBinary, startPinnedProviderServer, writeFixture } from './lib/pinned-outbound.mjs';

const sourceRoot = path.resolve(process.argv[2] ?? '');
const repositoryRoot = path.resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3]) {
    console.error('usage: node tools/probe-google-native-tts.mjs <pinned-source-clone> <gotavern-root>');
    process.exit(2);
}
if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim() !== PINNED_COMMIT) {
    throw new Error(`upstream checkout is not pinned at ${PINNED_COMMIT}`);
}

const FIXED_MS = 1700000000000;
const FIXED_SECONDS = Math.floor(FIXED_MS / 1000);

// Freeze the child's clock. NODE_OPTIONS is inherited by the spawned pinned server, so this reaches it
// without touching the shared probe library.
const freezeDirectory = mkdtempSync(path.join(os.tmpdir(), 'gotavern-freeze-clock-'));
const freezePath = path.join(freezeDirectory, 'freeze-clock.mjs');
writeFileSync(freezePath, [
    `const FIXED = ${FIXED_MS};`,
    'const RealDate = Date;',
    'class FrozenDate extends RealDate {',
    '    constructor(...args) { super(...(args.length ? args : [FIXED])); }',
    '    static now() { return FIXED; }',
    '}',
    'globalThis.Date = FrozenDate;',
    '',
].join('\n'));
process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} --import ${pathToFileURL(freezePath).href}`.trim();

const MAKERSUITE = 'https://generativelanguage.googleapis.com';
const VERTEX = 'https://us-central1-aiplatform.googleapis.com';
const VERTEX_GLOBAL = 'https://aiplatform.googleapis.com';
const OAUTH = 'https://oauth2.googleapis.com';

const KEYS = {
    makersuite: 'synthetic-makersuite-key',
    vertexai: 'synthetic-vertex-express-key',
    proxyPassword: 'synthetic-proxy-password',
};

const SA_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDEeEszoF7Ax81j
k3uJSL+W1IN5v5gt159jt0V/Ev5yfVQy3WQkumAsN3jBU+eYA8zUSvdmyf3FfZdX
d4L3faOxgHKGa4FJQD5xTGF2NdUGe8CyInSTJ0N+fH6raOx/pW64Pijm+HTqThZp
SjXoXTEUEJpib5ocvwGiUZpt3Qpu9wI4Hhl3vHv8arBHlu9tsOA2MboGuvqrQvJf
f4F8qyiJIg703cWamzYDZeSkFjz2+KZrAkRK3crIsBaMwh6t14AR7myZkAUaMhjS
T8jKRGDldcyLHH/wfVTmCC1F9VOBD0bO6Qt61resu3eF3ekIyyIzFw9cp+S3+XK5
wj6fdq6dAgMBAAECggEAIPZ7y4QfEaIUHB5M7joV5uTt0Bnsmthf5heEIe9aYHQV
kdkiKaVZaGHAMVN1+kO89GtFeenu2VkacLLc9tAODERcMqBL1zHfqBukCHS8snNF
3703KM9AHDMf/3tBnqLvYhsPury5xOvoB69LPxqPlum4NUa7KRKE4CpnygH5c6dT
Y6kkHo+Iqo+brsBi5nknXU4oDWGskGVZSAFrRcE/msaV/1W+q2q+erRF4ziG63xw
mqOhVgHJOTI54VNx+6EyE7DVurFPzvHIZww1xAfaVtI1q+cr/lWGajnoiMUF28cr
Msg6hIq0cE23u0rkvQ6D9v8cNXJmxbBDavr1EVr2MwKBgQDkrdywtCPy8+cuOynT
oNIK3GGI56KCb26G3F3PWjB0su3k7tNF3RxZvq04fHM2p7jHMOrdiPJUmJ0yKebr
lGZ4ugKea+LemJDAX29Zvu6pJI2KSbV5vhWDPeLR9MFqfQU8mYRTK1roFNq/ZAPY
VFnUM2k5U4gqXRz19jiR+ApMkwKBgQDb8VBNqKea8l2rLg5JwEYDMc1dzJnukGqN
K4z/TLZ7ogAiM93R+yMnb7fDKGg41+hu8kiS96EL1bpq9NQRa3voiDLsQinufrTK
LMJzWIwzh5LWHlHZ9eIFjwpF/IwTvkvt4A3V03ooiAHfU+HpIE2ot78tM/vnMcdn
Hgb0geRGDwKBgQCI5XAlNGIE8nAl4/MhJrg3GkElVQ2bKhwvjcJ2/BXf9rGliDdg
LoLnUted5hqO0I80Z5tibbYsYIRSYHVF+Dvz797bediByzF0iG0/e6aiCSjWbVO/
gsScIbMkX3JeTmORKJHnvB+aqcleJACNQ8nW18QZNmFggwdwUysAb02zEwKBgQC3
H7aC0leqdP10V0ZiNYqVglPBM2c+8FMm8wnUTuTpDzsZPyIDgRwF68iO3wfXvDy0
k1nFtBQMrIkoIGypjFqAg1YSzAvpnOmeI6JLM4CYLtsdF+WCmmzzv+MH3nwqvBiw
GAqs7AUb1hHpBghkeBbw0PyGAHBOUG37905HKhcMFQKBgHSdk/j9aa1XULFIG/Fp
FEcLIbbJA6ObHiOonm2SnI7yhizsWZuuIVJ+hiq2s7WhdaLC/GMwRCvIt5rb++yc
Q1gMY5TyzWG2BjyR0V2LEFB5kzLXw8WCyw2hxJX4e2HTgNTWr6E+3R1IT9IVBacw
PkkPwulnlizGMFj8X4jkJOCE
-----END PRIVATE KEY-----`;

const SERVICE_ACCOUNT = {
    type: 'service_account',
    project_id: 'gotavern-synthetic-project',
    private_key_id: 'synthetic-key-id',
    private_key: SA_PRIVATE_KEY,
    client_email: 'gotavern-synthetic@gotavern-synthetic-project.iam.gserviceaccount.com',
    client_id: '1234567890',
    token_uri: 'https://oauth2.googleapis.com/token',
};

const PCM_BYTES = Buffer.from('gotavern-synthetic-pcm-l16-payload', 'utf8');
const MP3_BYTES = Buffer.from('gotavern-synthetic-mp3-payload', 'utf8');
const ACCESS_TOKEN = 'synthetic-access-token';

function secretEntry(key, value) {
    return { [key]: [{ id: `sid-${key}`, value, label: key, active: true }] };
}

function audioResponse(dataBase64, mimeType) {
    return { candidates: [{ content: { parts: [{ inlineData: { data: dataBase64, mimeType } }] } }] };
}

const SCENARIOS = [
    { label: 'aiStudioWav', body: { text: 'hello there', voice: 'Zephyr', model: 'gemini-2.5-flash-preview-tts' },
      secrets: secretEntry('api_key_makersuite', KEYS.makersuite),
      mocks: [{ match: '/models/', payload: audioResponse(PCM_BYTES.toString('base64'), 'audio/l16;rate=24000') }] },
    { label: 'aiStudioDefaultRate', body: { text: 'hello there', voice: 'Puck', model: 'gemini-2.5-flash-preview-tts' },
      secrets: secretEntry('api_key_makersuite', KEYS.makersuite),
      mocks: [{ match: '/models/', payload: audioResponse(PCM_BYTES.toString('base64'), 'audio/L16') }] },
    { label: 'aiStudioOtherMime', body: { text: 'hello there', voice: 'Kore', model: 'gemini-2.5-flash-preview-tts' },
      secrets: secretEntry('api_key_makersuite', KEYS.makersuite),
      mocks: [{ match: '/models/', payload: audioResponse(MP3_BYTES.toString('base64'), 'audio/mpeg') }] },
    { label: 'aiStudioNoAudio', body: { text: 'hello there', voice: 'Kore', model: 'gemini-2.5-flash-preview-tts' },
      secrets: secretEntry('api_key_makersuite', KEYS.makersuite),
      mocks: [{ match: '/models/', payload: { candidates: [{ content: { parts: [{}] } }] } }] },
    { label: 'aiStudioProviderErrorJson', body: { text: 'hello there', voice: 'Kore', model: 'gemini-2.5-flash-preview-tts' },
      secrets: secretEntry('api_key_makersuite', KEYS.makersuite),
      mocks: [{ match: '/models/', status: 429, statusText: 'Too Many Requests', payload: { error: { message: 'quota exceeded' } } }] },
    { label: 'aiStudioProviderErrorText', body: { text: 'hello there', voice: 'Kore', model: 'gemini-2.5-flash-preview-tts' },
      secrets: secretEntry('api_key_makersuite', KEYS.makersuite),
      mocks: [{ match: '/models/', status: 500, statusText: 'Internal Server Error', text: 'not json at all' }] },
    { label: 'aiStudioReservedModel', body: { text: 'hello there', voice: 'Kore', model: 'models/x y?z=1' },
      secrets: secretEntry('api_key_makersuite', KEYS.makersuite),
      mocks: [{ match: '/models/', payload: audioResponse(PCM_BYTES.toString('base64'), 'audio/mpeg') }] },
    { label: 'aiStudioNoKey', body: { text: 'hello there', voice: 'Kore', model: 'gemini-2.5-flash-preview-tts' },
      secrets: {},
      mocks: [{ match: '/models/', payload: audioResponse(MP3_BYTES.toString('base64'), 'audio/mpeg') }] },
    { label: 'vertexExpressWithProject', body: { api: 'vertexai', text: 'hello there', voice: 'Kore', model: 'gemini-2.5-flash-preview-tts', vertexai_express_project_id: 'gotavern-synthetic-project' },
      secrets: secretEntry('api_key_vertexai', KEYS.vertexai),
      mocks: [{ match: '-aiplatform.googleapis.com', payload: audioResponse(PCM_BYTES.toString('base64'), 'audio/mpeg') }] },
    { label: 'vertexExpressWithoutProject', body: { api: 'vertexai', text: 'hello there', voice: 'Kore', model: 'gemini-2.5-flash-preview-tts' },
      secrets: secretEntry('api_key_vertexai', KEYS.vertexai),
      mocks: [{ match: '-aiplatform.googleapis.com', payload: audioResponse(PCM_BYTES.toString('base64'), 'audio/mpeg') }] },
    { label: 'vertexExpressGlobalRegion', body: { api: 'vertexai', text: 'hello there', voice: 'Kore', model: 'gemini-2.5-flash-preview-tts', vertexai_region: 'global' },
      secrets: secretEntry('api_key_vertexai', KEYS.vertexai),
      mocks: [{ match: 'aiplatform.googleapis.com', payload: audioResponse(PCM_BYTES.toString('base64'), 'audio/mpeg') }] },
    { label: 'vertexFullJwt', body: { api: 'vertexai', vertexai_auth_mode: 'full', text: 'hello there', voice: 'Kore', model: 'gemini-2.5-flash-preview-tts' },
      secrets: secretEntry('vertexai_service_account_json', JSON.stringify(SERVICE_ACCOUNT)),
      mocks: [
          { match: 'oauth2.googleapis.com/token', payload: { access_token: ACCESS_TOKEN, expires_in: 3600, token_type: 'Bearer' } },
          { match: '-aiplatform.googleapis.com', payload: audioResponse(PCM_BYTES.toString('base64'), 'audio/mpeg') },
      ] },
    { label: 'vertexFullJwtSecondRequest', body: { api: 'vertexai', vertexai_auth_mode: 'full', text: 'again', voice: 'Kore', model: 'gemini-2.5-flash-preview-tts' },
      secrets: secretEntry('vertexai_service_account_json', JSON.stringify(SERVICE_ACCOUNT)),
      mocks: [
          { match: 'oauth2.googleapis.com/token', payload: { access_token: ACCESS_TOKEN, expires_in: 3600, token_type: 'Bearer' } },
          { match: '-aiplatform.googleapis.com', payload: audioResponse(PCM_BYTES.toString('base64'), 'audio/mpeg') },
      ] },
    { label: 'vertexFullMissingServiceAccount', body: { api: 'vertexai', vertexai_auth_mode: 'full', text: 'hello there', voice: 'Kore', model: 'gemini-2.5-flash-preview-tts' },
      secrets: {}, mocks: [] },
    { label: 'vertexFullInvalidServiceAccount', body: { api: 'vertexai', vertexai_auth_mode: 'full', text: 'hello there', voice: 'Kore', model: 'gemini-2.5-flash-preview-tts' },
      secrets: secretEntry('vertexai_service_account_json', 'not-json-at-all'), mocks: [] },
    { label: 'vertexFullTokenExchangeFails', body: { api: 'vertexai', vertexai_auth_mode: 'full', text: 'hello there', voice: 'Kore', model: 'gemini-2.5-flash-preview-tts' },
      secrets: secretEntry('vertexai_service_account_json', JSON.stringify(SERVICE_ACCOUNT)),
      mocks: [{ match: 'oauth2.googleapis.com/token', status: 400, statusText: 'Bad Request', payload: { error: 'invalid_grant' } }] },
    { label: 'proxyMode', body: { reverse_proxy: 'https://proxy.example.test', proxy_password: KEYS.proxyPassword, text: 'hello there', voice: 'Kore', model: 'gemini-2.5-flash-preview-tts' },
      secrets: {},
      mocks: [{ match: 'proxy.example.test', payload: audioResponse(PCM_BYTES.toString('base64'), 'audio/mpeg') }] },
    { label: 'proxyModeVertex', body: { api: 'vertexai', reverse_proxy: 'https://proxy.example.test', proxy_password: KEYS.proxyPassword, text: 'hello there', voice: 'Kore', model: 'gemini-2.5-flash-preview-tts' },
      secrets: {},
      mocks: [{ match: 'proxy.example.test', payload: audioResponse(PCM_BYTES.toString('base64'), 'audio/mpeg') }] },
];

const server = await startPinnedProviderServer({ sourceRoot, prefix: 'gotavern-google-native-tts-oracle-', mocks: [] });
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
        const result = await server.post('/api/google/generate-native-tts', JSON.stringify(scenario.body));
        // An audio answer is recorded as a digest and a length, never as text: a UTF-8 round trip would
        // corrupt the RIFF header bytes that are not valid UTF-8.
        const contentType = result.response.headers.get('content-type') ?? '';
        const captured = /^audio\//.test(contentType) ? captureHttpBinary(result) : captureHttp(result);
        scenarios[scenario.label] = {
            route: '/api/google/generate-native-tts',
            requestBody: JSON.stringify(scenario.body),
            mocks: rules,
            secrets: server.readSecrets(),
            response: captured,
            outbound: server.outbound(),
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
const b64 = value => value.toString('base64');
const wavBytes = (pcm, sampleRate) => {
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + pcm.length, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(sampleRate * 1 * 16 / 8, 28);
    header.writeUInt16LE(1 * 16 / 8, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36);
    header.writeUInt32LE(pcm.length, 40);
    return Buffer.concat([header, pcm]);
};

// ── AI Studio branch ────────────────────────────────────────────────────────────────────────────
const wav = scenarios.aiStudioWav;
assert.equal(wav.response.status, 200, 'the AI Studio branch answers 200');
assert.equal(wav.response.headers['content-type'], 'audio/wav', 'audio/l16 is wrapped into WAV');
assert.equal(wav.response.sha256, sha256(wavBytes(PCM_BYTES, 24000)), 'the WAV bytes are the pinned 44-byte header plus the PCM payload');
assert.equal(wav.response.bytes, 44 + PCM_BYTES.length, 'the WAV length is the 44-byte header plus the PCM payload');
assert.equal(wav.outbound.length, 1, 'one request in the AI Studio branch');
assert.equal(wav.outbound[0].url, `${MAKERSUITE}/v1beta/models/gemini-2.5-flash-preview-tts:generateContent`, 'the AI Studio URL');
assert.equal(wav.outbound[0].headers['x-goog-api-key'], KEYS.makersuite, 'the API key header');
const wavRequest = JSON.parse(wav.outbound[0].body);
assert.equal(wavRequest.contents[0].parts[0].text, 'hello there', 'the text reaches the provider');
assert.equal(wavRequest.generationConfig.responseModalities[0], 'AUDIO', 'the modality');
assert.equal(wavRequest.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Zephyr', 'the voice name');
assert.equal(Object.keys(wavRequest).join(','), 'contents,generationConfig,safetySettings', 'the request member order');

assert.equal(scenarios.aiStudioDefaultRate.response.headers['content-type'], 'audio/wav', 'a rate-less audio/l16 is still WAV');
assert.equal(scenarios.aiStudioDefaultRate.response.sha256, sha256(wavBytes(PCM_BYTES, 24000)), 'the sample rate defaults to 24000');
assert.equal(scenarios.aiStudioOtherMime.response.headers['content-type'], 'audio/mpeg', 'another mime type passes through');
assert.equal(scenarios.aiStudioOtherMime.response.sha256, sha256(MP3_BYTES), 'the bytes pass through unchanged');
assert.equal(scenarios.aiStudioNoAudio.response.status, 500, 'no audio data is a 500');
assert.deepEqual(scenarios.aiStudioNoAudio.response.body, { error: 'No audio data found in response' }, 'the no-audio message');
assert.equal(scenarios.aiStudioProviderErrorJson.response.status, 429, 'a provider error propagates the PROVIDER status');
assert.deepEqual(scenarios.aiStudioProviderErrorJson.response.body, { error: 'quota exceeded' }, 'the provider message is forwarded');
assert.equal(scenarios.aiStudioProviderErrorText.response.status, 500, 'a NON-JSON error body is flattened to 500');
assert.deepEqual(scenarios.aiStudioProviderErrorText.response.body, { error: 'Internal server error during TTS generation' }, 'the generic message');
assert.equal(requireOutbound('aiStudioReservedModel', 0).url, `${MAKERSUITE}/v1beta/models/models/x y?z=1:generateContent`,
    'the model is interpolated RAW into the path (rule 15)');
// The pinned AI Studio branch does NOT guard the key: it reads the secret, gets undefined and sends the
// request anyway, with no key header at all. That is the behaviour to reproduce, not to harden.
assert.equal(scenarios.aiStudioNoKey.outbound.length, 1, 'a missing AI Studio key still sends the request');
assert.equal(requireOutbound('aiStudioNoKey', 0).headers['x-goog-api-key'], '', 'and sends the key header EMPTY, because node-fetch serialises an undefined value as an empty string');
assert.equal(scenarios.aiStudioNoKey.response.status, 200, 'the provider answer is used as-is');

// ── Vertex express branch ───────────────────────────────────────────────────────────────────────
assert.equal(requireOutbound('vertexExpressWithProject', 0).url,
    `${VERTEX}/v1/projects/gotavern-synthetic-project/locations/us-central1/publishers/google/models/gemini-2.5-flash-preview-tts:generateContent`,
    'the express branch with a project id');
assert.equal(requireOutbound('vertexExpressWithoutProject', 0).url,
    `${VERTEX}/v1/publishers/google/models/gemini-2.5-flash-preview-tts:generateContent`,
    'the express branch without a project id');
assert.equal(requireOutbound('vertexExpressGlobalRegion', 0).url,
    `${VERTEX_GLOBAL}/v1/publishers/google/models/gemini-2.5-flash-preview-tts:generateContent`,
    'the global region drops the region prefix');
assert.equal(requireOutbound('vertexExpressWithProject', 0).headers['x-goog-api-key'], KEYS.vertexai, 'the express branch authenticates with a key header');

// ── Vertex full branch: the JWT is byte-for-byte ────────────────────────────────────────────────
const full = scenarios.vertexFullJwt;
assert.equal(full.outbound.length, 2, 'the full branch makes TWO requests: token exchange, then the model');
const tokenRequest = full.outbound[0];
assert.equal(tokenRequest.url, `${OAUTH}/token`, 'the token endpoint');
assert.equal(tokenRequest.method, 'POST', 'the token exchange is a POST');
assert.equal(tokenRequest.headers['content-type'], 'application/x-www-form-urlencoded', 'the token exchange content type');
const tokenBody = new URLSearchParams(tokenRequest.body);
assert.equal(tokenBody.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer', 'the grant type');
const assertion = tokenBody.get('assertion');
assert.equal(typeof assertion, 'string', 'the assertion is a JWT');
const [jwtHeader, jwtClaims, jwtSignature] = assertion.split('.');
assert.equal(jwtHeader, Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url'), 'the JWT header, byte for byte');
assert.deepEqual(JSON.parse(Buffer.from(jwtClaims, 'base64url').toString('utf8')), {
    iss: SERVICE_ACCOUNT.client_email,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: 'https://oauth2.googleapis.com/token',
    iat: FIXED_SECONDS,
    exp: FIXED_SECONDS + 3600,
}, 'the claims are pinned to the frozen clock');
assert.ok(jwtSignature.length > 300, 'the signature is a 2048-bit RS256 signature');
assert.equal(full.outbound[1].headers.authorization, `Bearer ${ACCESS_TOKEN}`, 'the model request carries the exchanged token');
assert.equal(scenarios.vertexFullJwtSecondRequest.outbound.length, 2, 'a SECOND request fetches a SECOND token: no caching');
assert.equal(scenarios.vertexFullMissingServiceAccount.response.status, 500, 'a missing service account is a 500');
assert.equal(scenarios.vertexFullMissingServiceAccount.outbound.length, 0, 'a missing service account reaches no peer');
assert.equal(scenarios.vertexFullInvalidServiceAccount.response.status, 500, 'an invalid service account is a 500');
assert.equal(scenarios.vertexFullInvalidServiceAccount.outbound.length, 0, 'an invalid service account reaches no peer');
assert.equal(scenarios.vertexFullTokenExchangeFails.response.status, 500, 'a failed token exchange is a 500');
assert.equal(scenarios.vertexFullTokenExchangeFails.outbound.length, 1, 'a failed token exchange stops before the model call');

// ── Reverse proxy branch ────────────────────────────────────────────────────────────────────────
assert.equal(requireOutbound('proxyMode', 0).url, `https://proxy.example.test/v1beta/models/gemini-2.5-flash-preview-tts:generateContent`,
    'the AI Studio proxy URL');
assert.equal(requireOutbound('proxyMode', 0).headers['x-goog-api-key'], KEYS.proxyPassword, 'in the AI Studio proxy branch the proxy password IS the api key header, not a bearer token');
assert.equal(requireOutbound('proxyMode', 0).headers.authorization, undefined, 'and no Authorization header is sent in that branch');
assert.equal(requireOutbound('proxyModeVertex', 0).url, `https://proxy.example.test/v1/publishers/google/models/gemini-2.5-flash-preview-tts:generateContent`,
    'the Vertex proxy URL');

const fixture = {
    schemaVersion: 1,
    baseline: { version: PINNED_VERSION, commit: PINNED_COMMIT },
    probe: 'tools/probe-google-native-tts.mjs',
    implementedRoutes: ['/api/google/generate-native-tts'],
    notImplementedRoutes: [
        '/api/google/caption-image', '/api/google/generate-image', '/api/google/generate-video',
    ],
    notImplementedReasons: {
        '/api/google/caption-image': 'Gemini multimodal envelope via getGoogleApiConfig; not in this increment.',
        '/api/google/generate-image': 'Gemini image generation envelope (`:predict`); not in this increment.',
        '/api/google/generate-video': 'Gemini video generation envelope, polling; not in this increment.',
    },
    pinnedSource: {
        'src/endpoints/google.js:356': 'router.post(\'/generate-native-tts\') — getGoogleApiConfig, then a POST with responseModalities AUDIO and a prebuilt voice',
        'src/endpoints/google.js:41': 'getVertexAIAuth: proxy, express or full (service account)',
        'src/endpoints/google.js:89': 'generateJWTToken: RS256 over base64url(header).base64url(claims)',
        'src/endpoints/google.js:118': 'getAccessToken: POST oauth2.googleapis.com/token with grant_type jwt-bearer',
        'src/endpoints/google.js:17': 'createWavHeader/createCompleteWavFile: the 44-byte RIFF/WAVE mono 16-bit header',
    },
    mechanism: 'Every upstream is a hardcoded literal, so the probe replaces the `node-fetch` module and the global `fetch` with a controlled peer; the Go side replays the same peer through a real listener. The pinned child clock is frozen through NODE_OPTIONS so the RS256 JWT is deterministic and comparable byte for byte.',
    fields: [
        { path: 'scenarios.*.response.status', comparison: 'compared', reason: 'the pinned handler propagates the PROVIDER status on a provider error and answers 500 elsewhere' },
        { path: 'scenarios.*.response.headers', comparison: 'compared', reason: 'audio/wav for audio/l16, the provider mime type otherwise' },
        { path: 'scenarios.*.response.body/bodyText', comparison: 'compared', reason: 'JSON answers are compared as text, including the two distinct error shapes' },
        { path: 'scenarios.*.response.sha256/bytes', comparison: 'compared', reason: 'audio answers are compared by digest and length; a UTF-8 round trip would corrupt the RIFF header bytes' },
        { path: 'scenarios.*.outbound[].url', comparison: 'compared', reason: 'four auth branches build four URL shapes, including the raw model interpolation' },
        { path: 'scenarios.*.outbound[].body', comparison: 'compared', reason: 'the token request carries the JWT assertion, compared byte for byte against the deterministic RS256 output' },
        { path: 'scenarios.*.outbound[].headers', comparison: 'compared', reason: 'x-goog-api-key or Authorization: Bearer, asserted in both directions by the test' },
        { path: 'scenarios.*.outbound.length', comparison: 'compared', reason: 'the full branch makes two requests per call (token, then model) and never caches' },
        { path: 'safetySettings', comparison: 'shape', reason: 'the pinned handler merges GEMINI_SAFETY with VERTEX_SAFETY from constants.js; the fixture records the merged array but the Go side is expected to reproduce it verbatim once those constants are ported, so only its shape is asserted here' },
    ],
    normalizations: [
        'The pinned clock is frozen at 2023-11-14T22:13:20.000Z so `iat`/`exp` and therefore the whole JWT are deterministic.',
        'The service-account private key is a synthetic 2048-bit key embedded in the probe; no real credential is recorded.',
    ],
    inputs: {
        fixedEpochMilliseconds: FIXED_MS,
        fixedEpochSeconds: FIXED_SECONDS,
        serviceAccount: SERVICE_ACCOUNT,
        serviceAccountKeySha256: sha256(SA_PRIVATE_KEY),
        pcmSha256: sha256(PCM_BYTES),
        wavSha256: sha256(wavBytes(PCM_BYTES, 24000)),
        wavBytes: 44 + PCM_BYTES.length,
        defaultRateWavSha256: sha256(wavBytes(PCM_BYTES, 24000)),
        mp3Sha256: sha256(MP3_BYTES),
        accessToken: ACCESS_TOKEN,
        makersuiteKey: KEYS.makersuite,
        vertexKey: KEYS.vertexai,
        proxyPassword: KEYS.proxyPassword,
    },
    bootOutbound,
    scenarios,
};

const outputFile = writeFixture(repositoryRoot, 'sillytavern-1.19.0-google-native-tts.json', fixture);
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