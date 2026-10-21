#!/usr/bin/env node
// @gotavern-oracle: fixture=sillytavern-1.19.0-openai-chutes-transcribe.json label="openai chutes transcribe"
// Probe `/api/openai/chutes/transcribe-audio` (openai.js:882), the one route in this project where rule 15
// and rule 14 COMBINE.
//
// The pinned handler builds its URL by interpolating the model into the HOSTNAME:
//
//     fetch(`https://${request.body.model}.chutes.ai/transcribe`)
//
// so a model containing a dot or a slash sends the request to a DIFFERENT HOST. That is reproduced
// VERBATIM here -- no sanitising -- and recorded as an INHERITED property, the way the content-import
// substring match is recorded. Hardening it would change the compatibility claim.
//
// Because the input can change the destination, a probe that merely records what it caught cannot tell
// "the model stayed in the label" from "the request went somewhere else entirely". Two assertions cover
// that: the captured URL string (host included) is compared exactly, and the captured request COUNT is
// asserted, so an ESCAPED request shows up as a MISSING capture rather than as plausible data.
//
// Refusals (no key, no uploaded file) answer 400 with ZERO outbound requests, asserted as a count.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';

import { PINNED_COMMIT, PINNED_VERSION, captureHttp, startPinnedProviderServer, writeFixture } from './lib/pinned-outbound.mjs';

const sourceRoot = path.resolve(process.argv[2] ?? '');
const repositoryRoot = path.resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3]) {
    console.error('usage: node tools/probe-openai-chutes-transcribe.mjs <pinned-source-clone> <gotavern-root>');
    process.exit(2);
}
if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim() !== PINNED_COMMIT) {
    throw new Error(`upstream checkout is not pinned at ${PINNED_COMMIT}`);
}

const CHUTES_KEY = 'synthetic-chutes-key';
const AUDIO = Buffer.from('RIFFgotavern-synthetic-chutes-audio', 'utf8');
const CHUNKS = [{ text: 'hello ' }, { text: 'world' }];
const JOINED = 'hello world';

function secretEntry(key, value) {
    return { [key]: [{ id: `sid-${key}`, value, label: key, active: true }] };
}

const upload = base64 => ({ field: 'avatar', filename: 'audio.wav', contentType: 'audio/wav', base64 });

const SCENARIOS = [
    { label: 'chutesOk', body: { model: 'whisper-large-v3' }, secrets: secretEntry('api_key_chutes', CHUTES_KEY),
      mocks: [{ match: '.chutes.ai/transcribe', payload: CHUNKS }] },
    // A model with a DOT moves the request to another host entirely: the captured URL must show it.
    { label: 'chutesHostileModel', body: { model: 'evil.example.com/x' }, secrets: secretEntry('api_key_chutes', CHUTES_KEY),
      mocks: [{ match: 'evil.example.com', payload: CHUNKS }] },
    // A model with a SLASH makes the URL parser treat the first segment as the host and the rest as a path.
    { label: 'chutesSlashModel', body: { model: 'a/b' }, secrets: secretEntry('api_key_chutes', CHUTES_KEY),
      mocks: [{ match: '/b.chutes.ai/transcribe', payload: CHUNKS }] },
    { label: 'chutesEmptyChunks', body: { model: 'whisper-large-v3' }, secrets: secretEntry('api_key_chutes', CHUTES_KEY),
      mocks: [{ match: '.chutes.ai/transcribe', payload: [{ text: 'only' }, {}] }] },
    // Two scenarios exist because there are two distinct mutations to kill: one where the leading and
    // trailing whitespace must be TRIMMED, and one where INTERNAL whitespace must SURVIVE so a per-chunk
    // trim (the more likely mistake) is discriminated as well.
    { label: 'chutesWhitespaceChunks', body: { model: 'whisper-large-v3' }, secrets: secretEntry('api_key_chutes', CHUTES_KEY),
      mocks: [{ match: '.chutes.ai/transcribe', payload: [{ text: '  padded  ' }, { text: '\n second \n' }] }] },
    { label: 'chutesInternalWhitespace', body: { model: 'whisper-large-v3' }, secrets: secretEntry('api_key_chutes', CHUTES_KEY),
      mocks: [{ match: '.chutes.ai/transcribe', payload: [{ text: '  a  ' }, { text: '  b  ' }] }] },
    // A JSON 
    { label: 'chutesNullAnswer', body: { model: 'whisper-large-v3' }, secrets: secretEntry('api_key_chutes', CHUTES_KEY),
      mocks: [{ match: '.chutes.ai/transcribe', text: 'null' }] },
    { label: 'chutesNonArray', body: { model: 'whisper-large-v3' }, secrets: secretEntry('api_key_chutes', CHUTES_KEY),
      mocks: [{ match: '.chutes.ai/transcribe', payload: { text: 'not an array' } }] },
    { label: 'chutesNonOk', body: { model: 'whisper-large-v3' }, secrets: secretEntry('api_key_chutes', CHUTES_KEY),
      mocks: [{ match: '.chutes.ai/transcribe', status: 500, statusText: 'Internal Server Error', text: 'chutes says no' }] },
    { label: 'chutesNoKey', body: { model: 'whisper-large-v3' }, secrets: {}, mocks: [] },
    { label: 'chutesNoFile', body: { model: 'whisper-large-v3' }, secrets: secretEntry('api_key_chutes', CHUTES_KEY), mocks: [], omitFile: true },
];

const server = await startPinnedProviderServer({ sourceRoot, prefix: 'gotavern-openai-chutes-oracle-', mocks: [] });
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
        const form = new FormData();
        if (!scenario.omitFile) form.append('avatar', new Blob([AUDIO], { type: 'audio/wav' }), 'audio.wav');
        for (const [name, value] of Object.entries(scenario.body)) form.append(name, String(value));
        const result = await server.postForm('/api/openai/chutes/transcribe-audio', form);
        scenarios[scenario.label] = {
            route: '/api/openai/chutes/transcribe-audio',
            requestBody: JSON.stringify(scenario.body),
            upload: scenario.omitFile ? null : upload(AUDIO.toString('base64')),
            mocks: rules,
            secrets: server.readSecrets(),
            response: captureHttp(result),
            outbound: server.outbound().map(request => ({ url: request.url, method: request.method, headers: request.headers, body: request.body })),
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
const AUDIO_BASE64 = AUDIO.toString('base64');

// Rule 14 + rule 15 together: for every scenario that reaches the provider, exactly ONE request must have
// been captured, and its URL is compared with the host visible. An escaped request would leave the count
// at zero, which fails here instead of passing as "nothing to compare".
for (const scenario of SCENARIOS) {
    if ((scenario.mocks ?? []).length === 0) continue;
    const recorded = scenarios[scenario.label];
    assert.equal(recorded.outbound.length, 1,
        `${scenario.label}: expected exactly one captured request, got ${recorded.outbound.length} -- an escaped request must not look like a request that was never made`);
}

const ok = scenarios.chutesOk;
assert.equal(ok.response.status, 200, 'the chutes branch answers 200');
assert.deepEqual(ok.response.body, { text: JOINED }, 'the chunks are joined and trimmed');
assert.equal(ok.outbound[0].url, 'https://whisper-large-v3.chutes.ai/transcribe', 'the model becomes the HOST LABEL, verbatim');
assert.equal(ok.outbound[0].method, 'POST', 'the method');
assert.equal(ok.outbound[0].headers.authorization, `Bearer ${CHUTES_KEY}`, 'the bearer key');
assert.equal(ok.outbound[0].headers['content-type'], 'application/json', 'the content type');
assert.equal(ok.outbound[0].body, JSON.stringify({ audio_b64: AUDIO_BASE64 }), 'the body carries the base64 audio');
assert.equal(createHash('sha256').update(AUDIO).digest('hex'), AUDIO_SHA, 'the recorded audio digest is stable');

// THE HOSTILE HOSTS, asserted explicitly: these are the cases where the input changes the destination.
assert.equal(scenarios.chutesHostileModel.outbound[0].url, 'https://evil.example.com/x.chutes.ai/transcribe',
    'a model with a dot moves the request to a DIFFERENT HOST, reproduced verbatim and recorded as inherited');
assert.equal(scenarios.chutesSlashModel.outbound[0].url, 'https://a/b.chutes.ai/transcribe',
    'a model with a slash makes the first segment the host and the rest a path');

assert.deepEqual(scenarios.chutesEmptyChunks.response.body, { text: 'only' }, 'a chunk without text contributes the empty string');
const whitespaceText = scenarios.chutesWhitespaceChunks.response.body.text;
assert.equal(whitespaceText, 'padded  \n second', 'the joined text is TRIMMED at both ends');
assert.notEqual(whitespaceText, '  padded  \n second \n', 'and the untrimmed value differs, so this scenario is not decoration');
const internalText = scenarios.chutesInternalWhitespace.response.body.text;
assert.equal(internalText, 'a    b', 'INTERNAL whitespace survives the trim');
assert.notEqual(internalText, 'ab', 'a per-chunk trim would produce ab, so this scenario discriminates that mutation too');
assert.equal(scenarios.chutesNonArray.response.status, 500, 'a non-array answer is a 500');
assert.equal(scenarios.chutesNonArray.response.bodyText, 'Internal Server Error', 'and answers the plain status text');
assert.equal(scenarios.chutesNullAnswer.response.status, 500, 'a null answer is a 500');
assert.equal(scenarios.chutesNullAnswer.response.bodyText, 'Internal Server Error', 'and answers the PLAIN status text, not the provider body');
assert.equal(scenarios.chutesNonOk.response.status, 500, 'a provider error is a 500');
assert.equal(scenarios.chutesNonOk.response.bodyText, 'chutes says no', 'with the provider TEXT');
assert.equal(scenarios.chutesNoKey.response.status, 400, 'a missing key answers 400');
assert.equal(scenarios.chutesNoKey.outbound.length, 0, 'and reaches NO peer (rule 17)');
assert.equal(scenarios.chutesNoFile.response.status, 400, 'a missing file answers 400');
assert.equal(scenarios.chutesNoFile.outbound.length, 0, 'and reaches NO peer (rule 17)');

const fixture = {
    schemaVersion: 1,
    baseline: { version: PINNED_VERSION, commit: PINNED_COMMIT },
    probe: 'tools/probe-openai-chutes-transcribe.mjs',
    implementedRoutes: ['/api/openai/chutes/transcribe-audio'],
    notImplementedRoutes: ['/api/openai/caption-image', '/api/openai/generate-video'],
    notImplementedReasons: {
        '/api/openai/generate-video': 'A polling job with three fixed-host request shapes; its own wave.',
        '/api/openai/caption-image': 'A chat-completions body over a large per-api branch table; its own wave.',
    },
    pinnedSource: {
        'src/endpoints/openai.js:882': 'router.post(\'/chutes/transcribe-audio\'): reads the uploaded file, base64s it, and fetches https://${request.body.model}.chutes.ai/transcribe',
    },
    mechanism: 'The upstream host is derived from the REQUEST, so the probe replaces the `node-fetch` module and the global `fetch` with a controlled peer and asserts BOTH the captured URL (host included) and the captured request COUNT: an escaped request appears as a missing capture rather than as plausible data.',
    inheritedProperties: {
        hostInterpolation: 'The model is interpolated into the HOSTNAME with no sanitising, so a model containing a dot or a slash redirects the request to another host. Reproduced verbatim and recorded here the way the content-import substring match is recorded; hardening it would be a deliberate compatibility change, not a silent improvement.',
    },
    fields: [
        { path: 'scenarios.*.response.status', comparison: 'compared', reason: '200, 400 for a refusal, 500 for a provider error or a non-array answer' },
        { path: 'scenarios.*.response.headers', comparison: 'compared', reason: 'json for the projection, html for the text bodies' },
        { path: 'scenarios.*.response.body/bodyText', comparison: 'compared', reason: 'the joined-chunks projection and the forwarded provider text' },
        { path: 'scenarios.*.outbound[].url', comparison: 'compared', reason: 'the HOST is compared exactly, because the model can move it (rule 15)' },
        { path: 'scenarios.*.outbound[].body', comparison: 'compared', reason: 'the base64 audio member' },
        { path: 'scenarios.*.outbound[].headers', comparison: 'compared', reason: 'the bearer key and content type, asserted in both directions' },
        { path: 'scenarios.*.outbound.length', comparison: 'compared', reason: 'exactly one request when the provider is reached and ZERO for a refusal, so an escape cannot hide' },
    ],
    normalizations: ['None: the request and the answer are both deterministic.'],
    inputs: {
        audioSha256: AUDIO_SHA,
        audioBase64: AUDIO_BASE64,
        chunks: CHUNKS,
        joined: JOINED,
        chutesKey: CHUTES_KEY,
        hostileModelUrl: 'https://evil.example.com/x.chutes.ai/transcribe',
    },
    bootOutbound,
    scenarios,
};

const outputFile = writeFixture(repositoryRoot, 'sillytavern-1.19.0-openai-chutes-transcribe.json', fixture);
console.log(`scenarios: ${Object.keys(scenarios).length}, boot outbound: ${bootOutbound.length}`);
console.log(`fixture written to ${outputFile}`);
