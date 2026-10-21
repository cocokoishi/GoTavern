#!/usr/bin/env node
// @gotavern-oracle: fixture=sillytavern-1.19.0-openai-generate-video.json label="openai generate video"
// Probe `/api/openai/generate-video` (openai.js:653).
//
// THREE request shapes on the FIXED host api.openai.com: create `POST /v1/videos`, poll
// `GET /v1/videos/{id}`, content `GET /v1/videos/{id}/content`. No production seam is needed because the
// host is FIXED -- the contrast to the Google video route, whose provider-supplied URI needed the module
// replacement instead.
//
// THE MATCHER IS A SUBSTRING MATCH, and that is load-bearing here: the stub selects the first rule whose
// `match` is CONTAINED in the request URL, so a rule for `/v1/videos` also matches `/v1/videos/{id}` and
// `/v1/videos/{id}/content`. Every rule that is a PREFIX of a later shape's path therefore carries `times`,
// or it serves the wrong answer to the later shape -- which presents as the route hanging, not as a mock
// problem. This probe learned that the expensive way once already.
//
// DIAGNOSTICS: each scenario runs under its own timeout and, on failure, prints the scenario NAME, the mocks
// it was served and the outbound captured so far, so a hang identifies itself instead of surfacing as a bare
// TimeoutError.
//
// NOT RECORDED: the TIMEOUT leg. After thirty exhausted attempts the pinned handler falls off the end of its
// try and answers NOTHING, so the request HANGS until the client gives up. The probe does not shorten the
// delay to make that observable; the leg is a LABELLED Go implementation test with parity UNOBSERVED, as is
// cancellation.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';

import { PINNED_COMMIT, PINNED_VERSION, captureHttp, startPinnedProviderServer, writeFixture } from './lib/pinned-outbound.mjs';

const sourceRoot = path.resolve(process.argv[2] ?? '');
const repositoryRoot = path.resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3]) {
    console.error('usage: node tools/probe-openai-generate-video.mjs <pinned-source-clone> <gotavern-root>');
    process.exit(2);
}
if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim() !== PINNED_COMMIT) {
    throw new Error(`upstream checkout is not pinned at ${PINNED_COMMIT}`);
}

const VIDEOS = 'https://api.openai.com/v1/videos';
const KEY = 'synthetic-openai-key';
const JOB_ID = 'video_abc123';
const JOB_PATH = `/v1/videos/${JOB_ID}`;
const VIDEO_BYTES = Buffer.from('gotavern-synthetic-openai-video-bytes', 'utf8');
const SCENARIO_TIMEOUT_MS = 30000;

function secretEntry(key, value) {
    return { [key]: [{ id: `sid-${key}`, value, label: key, active: true }] };
}

const jobCreated = { id: JOB_ID, status: 'queued' };
const running = { id: JOB_ID, status: 'in_progress', progress: 50 };
const completed = { id: JOB_ID, status: 'completed', progress: 100 };
const failed = { id: JOB_ID, status: 'failed' };

const SCENARIOS = [
    { label: 'completedFirstPoll', body: { prompt: 'a cat on a skateboard' }, secrets: secretEntry('api_key_openai', KEY),
      mocks: [
          { match: '/v1/videos', times: 1, payload: jobCreated },
          { match: JOB_PATH, times: 1, payload: completed },
          { match: `${JOB_PATH}/content`, headers: { 'content-type': 'video/mp4' }, binary: VIDEO_BYTES },
      ] },
    { label: 'completedSecondPoll', body: { prompt: 'a cat' }, secrets: secretEntry('api_key_openai', KEY),
      mocks: [
          { match: '/v1/videos', times: 1, payload: jobCreated },
          { match: JOB_PATH, times: 1, payload: running },
          { match: JOB_PATH, times: 1, payload: completed },
          { match: `${JOB_PATH}/content`, headers: { 'content-type': 'video/mp4' }, binary: VIDEO_BYTES },
      ] },
    { label: 'explicitParameters', body: { prompt: 'a cat', model: 'sora-2-pro', size: '1024x1792', seconds: '12' }, secrets: secretEntry('api_key_openai', KEY),
      mocks: [
          { match: '/v1/videos', times: 1, payload: jobCreated },
          { match: JOB_PATH, times: 1, payload: completed },
          { match: `${JOB_PATH}/content`, headers: { 'content-type': 'video/mp4' }, binary: VIDEO_BYTES },
      ] },
    { label: 'falsyParameters', body: { prompt: 'a cat', model: '', size: '', seconds: '' }, secrets: secretEntry('api_key_openai', KEY),
      mocks: [
          { match: '/v1/videos', times: 1, payload: jobCreated },
          { match: JOB_PATH, times: 1, payload: completed },
          { match: `${JOB_PATH}/content`, headers: { 'content-type': 'video/mp4' }, binary: VIDEO_BYTES },
      ] },
    // TRUTHY NON-STRING members: the pinned OR operator keeps the VALUE itself, so an array or an
    // object is forwarded as that type. This is the input that discriminates a string-only helper.
    { label: 'nonStringTruthyMembers', body: { prompt: 'a cat', model: [], size: {}, seconds: 12 }, secrets: secretEntry('api_key_openai', KEY),
      mocks: [
          { match: '/v1/videos', times: 1, payload: jobCreated },
          { match: JOB_PATH, times: 1, payload: completed },
          { match: JOB_PATH + '/content', times: 1, headers: { 'content-type': 'video/mp4' }, binary: VIDEO_BYTES },
      ] },
    { label: 'reservedJobId', body: { prompt: 'a cat' }, secrets: secretEntry('api_key_openai', KEY),
      mocks: [
          { match: '/v1/videos', times: 1, payload: { id: 'job/one?x=1' } },
          { match: 'job/one?x=1/content', times: 1, headers: { 'content-type': 'video/mp4' }, binary: VIDEO_BYTES },
          { match: 'job/one?x=1', times: 1, payload: completed },
      ] },
    { label: 'statusFailed', body: { prompt: 'a cat' }, secrets: secretEntry('api_key_openai', KEY),
      mocks: [
          { match: '/v1/videos', times: 1, payload: jobCreated },
          { match: JOB_PATH, times: 1, payload: failed },
      ] },
    { label: 'noJobId', body: { prompt: 'a cat' }, secrets: secretEntry('api_key_openai', KEY),
      mocks: [{ match: '/v1/videos', times: 1, payload: { status: 'queued' } }] },
    { label: 'createNonOk', body: { prompt: 'a cat' }, secrets: secretEntry('api_key_openai', KEY),
      mocks: [{ match: '/v1/videos', times: 1, status: 400, statusText: 'Bad Request', text: 'create says no' }] },
    { label: 'pollNonOk', body: { prompt: 'a cat' }, secrets: secretEntry('api_key_openai', KEY),
      mocks: [
          { match: '/v1/videos', times: 1, payload: jobCreated },
          { match: JOB_PATH, times: 1, status: 500, statusText: 'Internal Server Error', text: 'poll says no' },
      ] },
    { label: 'contentNonOk', body: { prompt: 'a cat' }, secrets: secretEntry('api_key_openai', KEY),
      mocks: [
          { match: '/v1/videos', times: 1, payload: jobCreated },
          { match: JOB_PATH, times: 1, payload: completed },
          { match: `${JOB_PATH}/content`, times: 1, status: 500, statusText: 'Internal Server Error', text: 'content says no' },
      ] },
    { label: 'noKey', body: { prompt: 'a cat' }, secrets: {}, mocks: [] },
];

function withTimeout(promise, milliseconds, label) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error(`scenario ${label} timed out after ${milliseconds}ms`)), milliseconds)),
    ]);
}

const server = await startPinnedProviderServer({ sourceRoot, prefix: 'gotavern-openai-video-oracle-', mocks: [] });
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
        let result;
        try {
            result = await withTimeout(server.post('/api/openai/generate-video', JSON.stringify(scenario.body)), SCENARIO_TIMEOUT_MS, scenario.label);
        } catch (error) {
            // MAKE THE FAILURE IDENTIFY ITSELF: the scenario name, the mocks it was served, and what the peer
            // captured before the failure. A bare TimeoutError costs a whole turn to localise.
            console.error(`SCENARIO FAILED: ${scenario.label}`);
            console.error(`  mocks served: ${JSON.stringify(rules, null, 2)}`);
            console.error(`  outbound captured before the failure: ${JSON.stringify(server.outbound(), null, 2)}`);
            throw error;
        }
        scenarios[scenario.label] = {
            route: '/api/openai/generate-video',
            requestBody: JSON.stringify(scenario.body),
            mocks: rules,
            secrets: server.readSecrets(),
            response: captureHttp(result),
            outbound: server.outbound().map(request => ({ url: request.url, method: request.method, headers: request.headers, body: request.body })),
        };
    }
} catch (error) {
    console.error('PROBE FAILED; pinned server log tail:');
    console.error(server.logs.join('').slice(-4000));
    throw error;
} finally {
    await server.stop();
}

const VIDEO_BASE64 = VIDEO_BYTES.toString('base64');
const completedRun = scenarios.completedFirstPoll;
assert.equal(completedRun.response.status, 200, 'a completed job answers 200');
assert.deepEqual(completedRun.response.body, { format: 'mp4', data: VIDEO_BASE64 }, 'the projection is {format, data}');
assert.equal(completedRun.outbound.length, 3, 'create, poll and content are three requests');
assert.equal(completedRun.outbound[0].url, VIDEOS, 'the create URL');
assert.equal(completedRun.outbound[0].method, 'POST', 'the create method');
assert.equal(completedRun.outbound[0].headers.authorization, `Bearer ${KEY}`, 'the create bearer key');
assert.deepEqual(JSON.parse(completedRun.outbound[0].body), {
    prompt: 'a cat on a skateboard', model: 'sora-2', size: '720x1280', seconds: '8',
}, 'the create body, with the OR-defaults');
assert.equal(completedRun.outbound[1].url, `${VIDEOS}/${JOB_ID}`, 'the poll URL carries the job id');
assert.equal(completedRun.outbound[1].method, 'GET', 'the poll is a GET');
assert.equal(completedRun.outbound[2].url, `${VIDEOS}/${JOB_ID}/content`, 'the content URL');
assert.equal(completedRun.outbound[2].method, 'GET', 'the content fetch is a GET');

const pollCount = label => scenarios[label].outbound.filter(request => request.method === 'GET' && !request.url.endsWith('/content')).length;
assert.equal(pollCount('completedFirstPoll'), 1, 'one poll in the single-poll scenario');
assert.equal(pollCount('completedSecondPoll'), 2, 'TWO polls: the count is the fixture property');
assert.equal(scenarios.completedSecondPoll.outbound.length, 4, 'two polls plus create and content');

const explicit = JSON.parse(scenarios.explicitParameters.outbound[0].body);
assert.equal(explicit.model, 'sora-2-pro', 'an explicit model');
assert.equal(explicit.size, '1024x1792', 'an explicit size');
assert.equal(explicit.seconds, '12', 'an explicit duration stays a STRING');
assert.deepEqual(JSON.parse(scenarios.falsyParameters.outbound[0].body), {
    prompt: 'a cat', model: 'sora-2', size: '720x1280', seconds: '8',
}, 'every falsy member falls back through the OR operator, which is what the fixture ACTUALLY recorded');
assert.deepEqual(JSON.parse(scenarios.nonStringTruthyMembers.outbound[0].body), { prompt: 'a cat', model: [], size: {}, seconds: 12 },
    'a TRUTHY NON-STRING member is forwarded as its own type: the OR operator keeps the value, it does not stringify it');

const reserved = scenarios.reservedJobId;
assert.equal(reserved.outbound[1].url, `${VIDEOS}/job/one?x=1`, 'the provider-supplied job id is interpolated RAW into the poll path');
assert.equal(reserved.outbound[2].url, `${VIDEOS}/job/one?x=1/content`, 'and into the content path');

assert.equal(scenarios.statusFailed.response.status, 500, 'a failed job is a 500');
assert.equal(scenarios.statusFailed.response.bodyText, 'Video generation failed', 'the failed-job message');
assert.equal(scenarios.noJobId.response.status, 500, 'a missing job id is a 500');
assert.equal(scenarios.noJobId.response.bodyText, 'No video job ID returned', 'the missing-id message');
assert.equal(scenarios.createNonOk.response.bodyText, 'create says no', 'the create provider TEXT');
assert.equal(scenarios.pollNonOk.response.bodyText, 'poll says no', 'the poll provider TEXT');
assert.equal(scenarios.contentNonOk.response.bodyText, 'content says no', 'the content provider TEXT');
assert.equal(scenarios.noKey.response.status, 400, 'a missing key answers 400');
assert.equal(scenarios.noKey.outbound.length, 0, 'and reaches NO peer (rule 17)');

const fixture = {
    schemaVersion: 1,
    baseline: { version: PINNED_VERSION, commit: PINNED_COMMIT },
    probe: 'tools/probe-openai-generate-video.mjs',
    implementedRoutes: ['/api/openai/generate-video'],
    notImplementedRoutes: ['/api/openai/caption-image'],
    notImplementedReasons: {
        '/api/openai/caption-image': 'A chat-completions body over a large per-api branch table; its own wave.',
    },
    pinnedSource: {
        'src/endpoints/openai.js:653': 'router.post(\'/generate-video\'): create POST /v1/videos, then a 30-attempt poll loop with delay(5000 + attempt * 1000), then GET /v1/videos/{id}/content',
        'src/endpoints/openai.js:699': 'the loop; an aborted client answers 500 "Video generation aborted by client"',
        'src/endpoints/openai.js:748': 'the catch; there is NO return after the loop, so an exhausted job answers NOTHING and the request hangs',
    },
    inheritedProperties: {
        exhaustedJobHangs: 'After thirty exhausted attempts the pinned handler falls off the end of its try block and Express answers NOTHING: the request HANGS until the client gives up. The replacement reproduces this deliberately, and a client must impose its own timeout. Answering instead would change every client behaviour, and a 200 with an empty body would be actively misleading.',
        rawJobId: 'The provider-supplied job id is interpolated RAW into the poll and content paths.',
    },
    harnessNotes: {
        substringMatch: 'The probe stub selects the first rule whose match is CONTAINED in the request URL, so a rule for /v1/videos also matches /v1/videos/{id} and /v1/videos/{id}/content. Every rule whose match is a PREFIX of a later shape must carry `times`, or it serves the wrong answer and the route appears to hang. The diagnostic in this probe prints the scenario name, the mocks served and the captured outbound on failure.',
    },
    mechanism: 'Every upstream is a hardcoded literal on a FIXED host, so no production seam is needed: the probe replaces the `node-fetch` module and the global `fetch` with a controlled peer and the Go side points the same peer origin at the base seam. The provider-supplied URI case does not arise here.',
    fields: [
        { path: 'scenarios.*.response.status', comparison: 'compared', reason: '200, 400 for the refusal, or 500 for each failure answer' },
        { path: 'scenarios.*.response.headers', comparison: 'compared', reason: 'json for the projection, html for the text bodies' },
        { path: 'scenarios.*.response.body/bodyText', comparison: 'compared', reason: 'the {format,data} projection and five distinct failure messages' },
        { path: 'scenarios.*.outbound[].url', comparison: 'compared', reason: 'the three shapes, including the raw job id in two paths' },
        { path: 'scenarios.*.outbound[].body', comparison: 'compared', reason: 'the create body with its OR-defaults' },
        { path: 'scenarios.*.outbound[].headers', comparison: 'compared', reason: 'the bearer key, asserted in both directions' },
        { path: 'scenarios.*.outbound.length', comparison: 'compared', reason: 'the POLL COUNT is the only thing that separates the real loop from a shortcut' },
    ],
    notRecorded: [
        'the TIMEOUT leg: thirty polls with escalating delays is about ten minutes of wall clock, and the pinned behaviour is a HANG rather than an answer, so parity is UNOBSERVED. It is a labelled Go implementation test, and the probe does not shorten the delay to make it observable.',
        'cancellation: labelled for the same reason; the pinned abort rides on request.socket.on(close).',
    ],
    normalizations: ['None: the request and the answers are deterministic.'],
    inputs: {
        videoSha256: createHash('sha256').update(VIDEO_BYTES).digest('hex'),
        videoBase64: VIDEO_BASE64,
        jobId: JOB_ID,
        openaiKey: KEY,
        pollCounts: { completedFirstPoll: 1, completedSecondPoll: 2 },
    },
    bootOutbound,
    scenarios,
};

const outputFile = writeFixture(repositoryRoot, 'sillytavern-1.19.0-openai-generate-video.json', fixture);
console.log(`scenarios: ${Object.keys(scenarios).length}, boot outbound: ${bootOutbound.length}`);
console.log(`fixture written to ${outputFile}`);
