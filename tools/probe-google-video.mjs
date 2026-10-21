#!/usr/bin/env node
// @gotavern-oracle: fixture=sillytavern-1.19.0-google-video.json label="google video"
// Probe the pinned `/api/google/generate-video` route (google.js:498) for both branches.
//
// The route POLLS: up to thirty attempts, each preceded by `await delay(5000 + attempt * 1000)`. The
// poll COUNT is therefore a fixture property (timed rules), and the scenarios here deliberately stop at
// one or two polls so the probe stays fast. The TIMEOUT branch needs thirty polls, about ten minutes of
// wall clock, and is NOT recorded: it is covered by a labelled Go implementation test, and the delay is
// not shortened in the probe because that would record a behaviour the product does not have.
//
// The AI Studio branch fetches a PROVIDER-SUPPLIED video URI. That is recordable: google.js imports
// `fetch from 'node-fetch'` and this probe replaces that module, so the URI request lands on the peer.
// No production seam was added. (`zai` is the different case: its route refuses a hostname outside
// .zai/.ufileos.com, which is a POLICY in the pinned source rather than an unreachable transport.)
//
// `personGeneration` is HARDCODED to 'allow_all' on this route, unlike generate-image which reads
// gemini.image.personGeneration from config. Unifying the two would be a compatibility break.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';

import { PINNED_COMMIT, PINNED_VERSION, captureHttp, startPinnedProviderServer, writeFixture } from './lib/pinned-outbound.mjs';

const sourceRoot = path.resolve(process.argv[2] ?? '');
const repositoryRoot = path.resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3]) {
    console.error('usage: node tools/probe-google-video.mjs <pinned-source-clone> <gotavern-root>');
    process.exit(2);
}
if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim() !== PINNED_COMMIT) {
    throw new Error(`upstream checkout is not pinned at ${PINNED_COMMIT}`);
}

const MAKERSUITE = 'https://generativelanguage.googleapis.com';
const VERTEX = 'https://us-central1-aiplatform.googleapis.com';
const VIDEO_URI = 'https://video.example.test/one.mp4';

const KEYS = { makersuite: 'synthetic-makersuite-key', vertexai: 'synthetic-vertex-express-key' };
const VIDEO_BYTES = Buffer.from('gotavern-synthetic-video-bytes', 'utf8');
const VIDEO_BASE64 = VIDEO_BYTES.toString('base64');
const JOB_NAME = 'operations/gotavern-synthetic-job';

function secretEntry(key, value) {
    return { [key]: [{ id: `sid-${key}`, value, label: key, active: true }] };
}

const jobCreated = { name: JOB_NAME };
const vertexRunning = { done: false };
const vertexDone = { done: true, response: { videos: [{ bytesBase64Encoded: VIDEO_BASE64 }] } };
const studioRunning = { done: false };
const studioDone = { done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: VIDEO_URI } }] } } };

const SCENARIOS = [
    // ── Vertex: one poll ────────────────────────────────────────────────────────────────────────
    { label: 'vertexDoneFirstPoll', body: { api: 'vertexai', prompt: 'a cat', model: 'veo-3.1-generate-preview' },
      secrets: secretEntry('api_key_vertexai', KEYS.vertexai),
      mocks: [
          { match: ':predictLongRunning', payload: jobCreated },
          { match: ':fetchPredictOperation', payload: vertexDone },
      ] },
    // ── Vertex: two polls, so the count is data ─────────────────────────────────────────────────
    { label: 'vertexDoneSecondPoll', body: { api: 'vertexai', prompt: 'a cat', model: 'veo-3.1-generate-preview' },
      secrets: secretEntry('api_key_vertexai', KEYS.vertexai),
      mocks: [
          { match: ':predictLongRunning', payload: jobCreated },
          { match: ':fetchPredictOperation', payload: vertexRunning, times: 1 },
          { match: ':fetchPredictOperation', payload: vertexDone },
      ] },
    { label: 'vertexParameters', body: { api: 'vertexai', prompt: 'a cat', model: 'veo-3.1-generate-preview', negative_prompt: 'dogs', seconds: 12, aspect_ratio: '9:16', seed: 42 },
      secrets: secretEntry('api_key_vertexai', KEYS.vertexai),
      mocks: [
          { match: ':predictLongRunning', payload: jobCreated },
          { match: ':fetchPredictOperation', payload: vertexDone },
      ] },
    { label: 'vertexNonVeo3Parameters', body: { api: 'vertexai', prompt: 'a cat', model: 'veo-2.0-generate-001', seconds: 1, seed: 42 },
      secrets: secretEntry('api_key_vertexai', KEYS.vertexai),
      mocks: [
          { match: ':predictLongRunning', payload: jobCreated },
          { match: ':fetchPredictOperation', payload: vertexDone },
      ] },
    // ── Vertex error branches ───────────────────────────────────────────────────────────────────
    { label: 'createFails', body: { api: 'vertexai', prompt: 'a cat', model: 'veo-3.1-generate-preview' },
      secrets: secretEntry('api_key_vertexai', KEYS.vertexai),
      mocks: [{ match: ':predictLongRunning', status: 500, statusText: 'Internal Server Error', text: 'no video for you' }] },
    { label: 'noJobName', body: { api: 'vertexai', prompt: 'a cat', model: 'veo-3.1-generate-preview' },
      secrets: secretEntry('api_key_vertexai', KEYS.vertexai),
      mocks: [{ match: ':predictLongRunning', payload: {} }] },
    { label: 'vertexPollFails', body: { api: 'vertexai', prompt: 'a cat', model: 'veo-3.1-generate-preview' },
      secrets: secretEntry('api_key_vertexai', KEYS.vertexai),
      mocks: [
          { match: ':predictLongRunning', payload: jobCreated },
          { match: ':fetchPredictOperation', status: 500, statusText: 'Internal Server Error', text: 'poll failed' },
      ] },
    { label: 'vertexNoVideoData', body: { api: 'vertexai', prompt: 'a cat', model: 'veo-3.1-generate-preview' },
      secrets: secretEntry('api_key_vertexai', KEYS.vertexai),
      mocks: [
          { match: ':predictLongRunning', payload: jobCreated },
          { match: ':fetchPredictOperation', payload: { done: true, response: {} } },
      ] },
    // ── AI Studio: one poll, then the provider URI fetch ────────────────────────────────────────
    { label: 'aiStudioDoneFirstPoll', body: { prompt: 'a cat', model: 'veo-3.1-generate-preview' },
      secrets: secretEntry('api_key_makersuite', KEYS.makersuite),
      mocks: [
          { match: ':predictLongRunning', payload: jobCreated },
          { match: JOB_NAME, payload: studioDone },
          { match: VIDEO_URI, headers: { 'content-type': 'video/mp4' }, binary: VIDEO_BYTES },
      ] },
    { label: 'aiStudioNoUri', body: { prompt: 'a cat', model: 'veo-3.1-generate-preview' },
      secrets: secretEntry('api_key_makersuite', KEYS.makersuite),
      mocks: [
          { match: ':predictLongRunning', payload: jobCreated },
          { match: JOB_NAME, payload: { done: true, response: {} } },
      ] },
    { label: 'aiStudioUriFetchFails', body: { prompt: 'a cat', model: 'veo-3.1-generate-preview' },
      secrets: secretEntry('api_key_makersuite', KEYS.makersuite),
      mocks: [
          { match: ':predictLongRunning', payload: jobCreated },
          { match: JOB_NAME, payload: studioDone },
          { match: VIDEO_URI, status: 404, statusText: 'Not Found', text: 'gone' },
      ] },
    { label: 'aiStudioPollFails', body: { prompt: 'a cat', model: 'veo-3.1-generate-preview' },
      secrets: secretEntry('api_key_makersuite', KEYS.makersuite),
      mocks: [
          { match: ':predictLongRunning', payload: jobCreated },
          { match: JOB_NAME, status: 500, statusText: 'Internal Server Error', text: 'poll failed' },
      ] },
    { label: 'aiStudioReservedModel', body: { prompt: 'a cat', model: 'models/x y?z=1' },
      secrets: secretEntry('api_key_makersuite', KEYS.makersuite),
      mocks: [
          { match: ':predictLongRunning', payload: jobCreated },
          { match: JOB_NAME, payload: studioDone },
          { match: VIDEO_URI, headers: { 'content-type': 'video/mp4' }, binary: VIDEO_BYTES },
      ] },
    { label: 'aiStudioNoKey', body: { prompt: 'a cat', model: 'veo-3.1-generate-preview' },
      secrets: {},
      mocks: [
          { match: ':predictLongRunning', payload: jobCreated },
          { match: JOB_NAME, payload: studioDone },
          { match: VIDEO_URI, headers: { 'content-type': 'video/mp4' }, binary: VIDEO_BYTES },
      ] },
];

function normalizeSeed(value) {
    if (typeof value !== 'string') return value;
    return value.replace(/"seed":\d+/g, '"seed":"<seed>"');
}

const server = await startPinnedProviderServer({ sourceRoot, prefix: 'gotavern-google-video-oracle-', mocks: [] });
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
            ...(rule.times === undefined ? {} : { times: rule.times }),
        }));
        server.writeSecrets(scenario.secrets ?? {});
        server.setMocks(rules);
        const started = Date.now();
        const result = await server.post('/api/google/generate-video', JSON.stringify(scenario.body));
        const elapsed = Date.now() - started;
        scenarios[scenario.label] = {
            route: '/api/google/generate-video',
            requestBody: JSON.stringify(scenario.body),
            mocks: rules,
            secrets: server.readSecrets(),
            elapsedBucket: elapsed < 4000 ? 'under-4s' : elapsed < 9000 ? '5s-poll' : elapsed < 16000 ? '11s-two-polls' : 'longer',
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

const b64 = value => value.toString('base64');
const pollCount = label => scenarios[label].outbound.filter(request => request.url.includes(':fetchPredictOperation') || request.url.includes(JOB_NAME)).length;

// ── Vertex branch ───────────────────────────────────────────────────────────────────────────────
const firstPoll = scenarios.vertexDoneFirstPoll;
assert.equal(firstPoll.response.status, 200, 'the vertex branch answers 200');
assert.deepEqual(firstPoll.response.body, { video: VIDEO_BASE64 }, 'the video is base64-encoded provider bytes');
assert.equal(firstPoll.outbound.length, 2, 'one create plus one poll');
assert.equal(firstPoll.outbound[0].url, `${VERTEX}/v1/publishers/google/models/veo-3.1-generate-preview:predictLongRunning`, 'the vertex create URL');
assert.equal(firstPoll.outbound[1].url, `${VERTEX}/v1/publishers/google/models/veo-3.1-generate-preview:fetchPredictOperation`, 'the vertex poll URL');
assert.equal(firstPoll.outbound[1].method, 'POST', 'the vertex poll is a POST');
assert.deepEqual(JSON.parse(firstPoll.outbound[1].body), { operationName: JOB_NAME }, 'the vertex poll body');
const createBody = JSON.parse(firstPoll.outbound[0].body);
assert.equal(Object.keys(createBody).join(','), 'instances,parameters', 'the create member order');
assert.equal(createBody.instances[0].prompt, 'a cat', 'the prompt');
assert.equal(createBody.parameters.personGeneration, 'allow_all', 'personGeneration is HARDCODED here, unlike generate-image which reads config');
assert.equal(createBody.parameters.durationSeconds, 6, 'an absent seconds member becomes the pinned default of 6');
assert.equal(createBody.parameters.aspectRatio, '16:9', 'the default aspect ratio');
assert.equal(createBody.parameters.negativePrompt, '', 'an absent negative prompt becomes the empty string');
assert.equal('seed' in createBody.parameters, true, 'a veo-3 request carries a seed');

assert.equal(scenarios.vertexDoneSecondPoll.outbound.length, 3, 'the two-poll scenario records three requests');
assert.equal(pollCount('vertexDoneSecondPoll'), 2, 'and TWO polls: the count is the fixture property');
assert.equal(scenarios.vertexParameters.outbound.length, 2, 'the parameters scenario polls once');
const tunedBody = JSON.parse(scenarios.vertexParameters.outbound[0].body);
assert.equal(tunedBody.parameters.durationSeconds, 8, 'a requested 12 seconds is clamped to the upper bound');
assert.equal(tunedBody.parameters.aspectRatio, '9:16', 'the requested aspect ratio');
assert.equal(tunedBody.parameters.negativePrompt, 'dogs', 'the negative prompt');
assert.equal(tunedBody.parameters.seed, '<seed>', 'the seed is masked');
const veo2Body = JSON.parse(scenarios.vertexNonVeo3Parameters.outbound[0].body);
assert.equal(veo2Body.parameters.durationSeconds, 5, 'a non-veo-3 model clamps 1 second up to 5');
assert.equal('seed' in veo2Body.parameters, false, 'a non-veo-3 model carries NO seed member');

assert.equal(scenarios.createFails.response.status, 500, 'a create failure is a 500');
assert.equal(scenarios.createFails.response.bodyText, 'Video generation request failed', 'the create-failure message');
assert.equal(scenarios.createFails.outbound.length, 1, 'a create failure stops there');
assert.equal(scenarios.noJobName.response.status, 500, 'a missing job name is a 500');
assert.equal(scenarios.noJobName.response.bodyText, 'No video job name found in response', 'the no-job-name message');
assert.equal(scenarios.noJobName.outbound.length, 1, 'a missing job name stops there');
assert.equal(scenarios.vertexPollFails.response.status, 500, 'a poll failure is a 500');
assert.equal(scenarios.vertexPollFails.response.bodyText, 'Video job status request failed', 'the poll-failure message');
assert.equal(scenarios.vertexNoVideoData.response.status, 500, 'a done poll without video data is a 500');
assert.equal(scenarios.vertexNoVideoData.response.bodyText, 'No video data found in response', 'the no-video-data message');

// ── AI Studio branch ────────────────────────────────────────────────────────────────────────────
const studio = scenarios.aiStudioDoneFirstPoll;
assert.equal(studio.response.status, 200, 'the AI Studio branch answers 200');
assert.deepEqual(studio.response.body, { video: VIDEO_BASE64 }, 'the provider URI bytes are base64-encoded');
assert.equal(studio.outbound.length, 3, 'create, poll, then the provider URI fetch');
assert.equal(studio.outbound[0].url, `${MAKERSUITE}/v1beta/models/veo-3.1-generate-preview:predictLongRunning`, 'the AI Studio create URL');
assert.equal(studio.outbound[1].url, `${MAKERSUITE}/v1beta/${JOB_NAME}`, 'the AI Studio poll URL joins the job name onto the base');
assert.equal(studio.outbound[1].method, 'GET', 'the AI Studio poll is a GET');
assert.equal(studio.outbound[2].url, VIDEO_URI, 'and then the PROVIDER-SUPPLIED URI is fetched');
assert.equal(studio.outbound[2].method, 'GET', 'the URI fetch is a GET');
assert.equal(scenarios.aiStudioNoUri.response.status, 500, 'a done poll without a URI is a 500');
assert.equal(scenarios.aiStudioNoUri.response.bodyText, 'No video URI found in response', 'the no-URI message');
assert.equal(scenarios.aiStudioNoUri.outbound.length, 2, 'and it stops before any URI fetch');
assert.equal(scenarios.aiStudioUriFetchFails.response.status, 500, 'a failing URI fetch is a 500');
assert.equal(scenarios.aiStudioUriFetchFails.response.bodyText, 'Video fetch request failed', 'the URI-fetch message');
assert.equal(scenarios.aiStudioPollFails.response.status, 500, 'an AI Studio poll failure is a 500');
assert.equal(scenarios.aiStudioPollFails.response.bodyText, 'Video job status request failed', 'the same poll-failure message as vertex');
assert.equal(scenarios.aiStudioReservedModel.outbound[0].url, `${MAKERSUITE}/v1beta/models/models/x y?z=1:predictLongRunning`,
    'the model is interpolated RAW into the path (rule 15)');
assert.equal(scenarios.aiStudioNoKey.outbound.length, 3, 'the AI Studio branch does not guard the key: it still runs');

// The poll delay is real wall clock, and it is recorded as a BUCKET rather than a duration so the fixture
// stays host-independent while still showing that a poll actually waited.
assert.equal(scenarios.vertexDoneFirstPoll.elapsedBucket, '5s-poll', 'one poll waits the first delay of 5000ms');
assert.equal(scenarios.vertexDoneSecondPoll.elapsedBucket, '11s-two-polls', 'two polls wait 5000ms then 6000ms');
assert.equal(scenarios.createFails.elapsedBucket, 'under-4s', 'a failed create never enters the loop');

const fixture = {
    schemaVersion: 1,
    baseline: { version: PINNED_VERSION, commit: PINNED_COMMIT },
    probe: 'tools/probe-google-video.mjs',
    implementedRoutes: ['/api/google/generate-video'],
    notImplementedRoutes: [],
    pinnedSource: {
        'src/endpoints/google.js:498': 'router.post(\'/generate-video\'): predictLongRunning, then a 30-attempt poll loop with delay(5000 + attempt * 1000)',
        'src/endpoints/google.js:551': 'the poll loop; Vertex posts :fetchPredictOperation with {operationName}, AI Studio GETs urlJoin(baseUrl, jobName)',
        'src/endpoints/google.js:620': 'the AI Studio branch then fetches the PROVIDER-SUPPLIED video URI through node-fetch, which this probe replaces',
    },
    mechanism: 'Every upstream is a hardcoded literal, so the probe replaces the `node-fetch` module and the global `fetch` with a controlled peer; the Go side reuses the same four Google auth branches and replays the peer through a real listener. The provider-supplied URI fetch needs NO production seam because the pinned route reaches it through node-fetch.',
    fields: [
        { path: 'scenarios.*.response.status', comparison: 'compared', reason: 'the pinned handler answers 200 or 500 with a fixed TEXT message per branch' },
        { path: 'scenarios.*.response.headers', comparison: 'compared', reason: 'a string body is html-typed' },
        { path: 'scenarios.*.response.body/bodyText', comparison: 'compared', reason: 'the base64 video projection and eight distinct error messages' },
        { path: 'scenarios.*.outbound[].url', comparison: 'compared', reason: 'four auth branches, two poll shapes, the provider URI and the raw model interpolation' },
        { path: 'scenarios.*.outbound[].body', comparison: 'compared', reason: 'the create parameter block and the vertex poll operationName, with the randomized seed masked' },
        { path: 'scenarios.*.outbound[].headers', comparison: 'compared', reason: 'x-goog-api-key or Authorization, asserted in both directions by the test' },
        { path: 'scenarios.*.outbound.length', comparison: 'compared', reason: 'THE POLL COUNT is the only thing that discriminates a cache-like shortcut from the real loop' },
        { path: 'scenarios.*.elapsedBucket', comparison: 'shape', reason: 'a wall-clock bucket, recorded only to show that a poll actually waited; a duration in milliseconds would be host-derived and would break the zero-diff gate' },
    ],
    normalizations: [
        'A veo-3 seed is randomized when absent, so it is replaced by a marker.',
        'Elapsed time is bucketed rather than recorded, because a millisecond duration is host-derived.',
    ],
    notRecorded: [
        'the TIMEOUT branch: thirty polls with delay(5000 + attempt*1000) is about ten minutes of wall clock, so parity cannot be observed. It is covered by a labelled Go implementation test, and the probe does NOT shorten the delay because that would record a behaviour the product does not have.',
        'cancellation: the pinned route aborts through request.socket.on(close). The parity leg is attempted separately; if a destroyed socket produces no close, it becomes a labelled implementation test asserting the 500 "Video generation aborted by client" from source.',
    ],
    inputs: {
        videoBase64: VIDEO_BASE64,
        videoSha256: createHash('sha256').update(VIDEO_BYTES).digest('hex'),
        jobName: JOB_NAME,
        videoUri: VIDEO_URI,
        makersuiteKey: KEYS.makersuite,
        vertexKey: KEYS.vertexai,
    },
    bootOutbound,
    scenarios,
};

const outputFile = writeFixture(repositoryRoot, 'sillytavern-1.19.0-google-video.json', fixture);
console.log(`scenarios: ${Object.keys(scenarios).length}, boot outbound: ${bootOutbound.length}`);
console.log(`fixture written to ${outputFile}`);
