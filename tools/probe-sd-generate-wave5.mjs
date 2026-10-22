#!/usr/bin/env node
// @gotavern-oracle: fixture=sillytavern-1.19.0-sd-generate-wave5.json label="sd generate wave 5"
// Probe the PINNED polling stable-diffusion providers:
//
//	POST /api/sd/bfl/generate     src/endpoints/stable-diffusion.js:1473
//	POST /api/sd/falai/generate   src/endpoints/stable-diffusion.js:1641
//
// Both submit a job, sleep `delay(2500)` and then poll a URL the provider hands back, so the request COUNT
// of a scenario is behaviour. Three consequences shape this file:
//
//   - the poll count is fixture data: a rule that answers a `Pending`/`IN_QUEUE` status carries `times: 1`,
//     so the SECOND poll can only happen if the first answer really was non-terminal;
//   - `tools/lib/pinned-outbound.mjs`'s `selectRule` picks the FIRST rule whose `match` is a SUBSTRING of
//     the request URL, so every submit rule carries `times: 1` and the follow-up shapes are matched by
//     distinct HOSTS rather than by paths that share a prefix (AGENTS.md rule 20);
//   - the provider-supplied follow-up hosts are synthetic (`*.example.test`), so no recording can be
//     mistaken for live provider data and no run can resolve them.
//
// WHY THIS IS A SEPARATE PROBE AND FIXTURE from `probe-sd-generate.mjs`: that file's `scenarios` is the
// replay list of ITS test, whose controlled peer has no `times` rule support, no wave-5 seam and no
// provider-URL rewriting. A poll scenario recorded there would be driven by a peer that cannot answer it,
// and that test is not this lane's to change. `probe-sd-generate.mjs` lists both routes as implemented and
// points at this file for their observations.
//
// NOT RECORDED, and `notCovered` says why for each: the 100-attempt TIMEOUT branch of both routes (about
// four minutes of wall clock; the probe does not shorten the delay, because that would record a behaviour
// the product does not have — it is covered by LABELLED Go implementation tests), the reserved-character
// job id in the bfl fallback query, the fal.ai non-JSON result document, and bfl `Ready` without
// `result.sample` (the controlled peer turns that into a 200, so recording it would be a probe artefact).

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';

import { PINNED_COMMIT, PINNED_VERSION, captureHttp, startPinnedProviderServer, writeFixture } from './lib/pinned-outbound.mjs';

const sourceRoot = path.resolve(process.argv[2] ?? '');
const repositoryRoot = path.resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3]) {
    console.error('usage: node tools/probe-sd-generate-wave5.mjs <pinned-source-clone> <gotavern-root>');
    process.exit(2);
}
if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim() !== PINNED_COMMIT) {
    throw new Error(`upstream checkout is not pinned at ${PINNED_COMMIT}`);
}

const BFL = 'https://api.bfl.ai';
const FAL_QUEUE = 'https://queue.fal.run';

const BFL_POLL = 'https://bfl-poll.example.test/v1/poll';
const BFL_SAMPLE = 'https://bfl-media.example.test/sample.jpeg';
const BFL_JOB_ID = 'gotavern-bfl-task-one';
const FAL_STATUS = 'https://fal-status.example.test/fal-ai/flux/requests/req-one/status';
const FAL_RESULT = 'https://fal-result.example.test/fal-ai/flux/requests/req-one';
const FAL_IMAGE = 'https://fal-media.example.test/files/one.jpeg';

const KEYS = { bfl: 'synthetic-bfl-key', falai: 'synthetic-falai-key' };

const JPEG_BYTES = Buffer.from('ffd8ffe0-gotavern-synthetic-jpeg', 'utf8');

function secretEntry(key, value) {
    return { [key]: [{ id: `sid-${key}`, value, label: key, active: true }] };
}

const SCENARIOS = [
    // ── bfl (submit, then a poll the provider names) ──────────────────────────────────────────────
    { label: 'bflNoKey', route: '/api/sd/bfl/generate',
      body: JSON.stringify({ prompt: 'a tree', model: 'flux-pro-1.1' }), secrets: {}, mocks: [] },
    // `flux-pro-1.1` ENDS WITH `-pro-1.1`, so the pinned handler deletes steps and guidance: the branch is
    // selected by a string suffix, not by a model registry.
    { label: 'bflPro11ReadyFirstPoll', route: '/api/sd/bfl/generate',
      body: JSON.stringify({ prompt: 'a tree', model: 'flux-pro-1.1', steps: 40, guidance: 2.5, width: 512, height: 768, prompt_upsampling: true, seed: 42 }),
      secrets: secretEntry('api_key_bfl', KEYS.bfl),
      mocks: [
          { match: '/v1/flux-pro-1.1', times: 1, payload: { id: BFL_JOB_ID, polling_url: `${BFL_POLL}?task=${BFL_JOB_ID}` } },
          { match: 'bfl-poll.example.test', payload: { status: 'Ready', result: { sample: BFL_SAMPLE } } },
          { match: 'bfl-media.example.test', headers: { 'content-type': 'image/jpeg' }, binary: JPEG_BYTES },
      ] },
    // The `times` bound on the Pending rule is what makes the POLL COUNT fixture data.
    { label: 'bflPendingThenReady', route: '/api/sd/bfl/generate',
      body: JSON.stringify({ prompt: 'a tree', model: 'flux-pro-1.1', seed: 7 }),
      secrets: secretEntry('api_key_bfl', KEYS.bfl),
      mocks: [
          { match: '/v1/flux-pro-1.1', times: 1, payload: { id: BFL_JOB_ID, polling_url: `${BFL_POLL}?task=${BFL_JOB_ID}` } },
          { match: 'bfl-poll.example.test', times: 1, payload: { status: 'Pending' } },
          { match: 'bfl-poll.example.test', payload: { status: 'Ready', result: { sample: BFL_SAMPLE } } },
          { match: 'bfl-media.example.test', headers: { 'content-type': 'image/jpeg' }, binary: JPEG_BYTES },
      ] },
    // No `polling_url` in the submit answer, so the pinned fallback template runs:
    // `https://api.bfl.ai/v1/get_result?id=<id>`. The task id is a plain token on purpose: a
    // reserved-character id would be re-encoded by the pinned URL parser and re-sent verbatim by a raw
    // transport, which is an unresolved divergence rather than a recorded behaviour (see notCovered).
    { label: 'bflFallbackPollingUrl', route: '/api/sd/bfl/generate',
      body: JSON.stringify({ prompt: 'a tree', model: 'flux-pro-1.1', seed: 0 }),
      secrets: secretEntry('api_key_bfl', KEYS.bfl),
      mocks: [
          { match: '/v1/flux-pro-1.1', times: 1, payload: { id: BFL_JOB_ID } },
          { match: '/v1/get_result', payload: { status: 'Ready', result: { sample: BFL_SAMPLE } } },
          { match: 'bfl-media.example.test', headers: { 'content-type': 'image/jpeg' }, binary: JPEG_BYTES },
      ] },
    // The three aspect-ratio branches: inside the band (simplified), below 9/21 (height from the width) and
    // above 21/9 (width from the height).
    { label: 'bflUltraSimplifiedRatio', route: '/api/sd/bfl/generate',
      body: JSON.stringify({ prompt: 'a tree', model: 'flux-pro-1.1-ultra', steps: 40, guidance: 2.5, width: 512, height: 768, prompt_upsampling: true, seed: 42 }),
      secrets: secretEntry('api_key_bfl', KEYS.bfl),
      mocks: [
          { match: '/v1/flux-pro-1.1-ultra', times: 1, payload: { id: BFL_JOB_ID, polling_url: BFL_POLL } },
          { match: 'bfl-poll.example.test', payload: { status: 'Ready', result: { sample: BFL_SAMPLE } } },
          { match: 'bfl-media.example.test', headers: { 'content-type': 'image/jpeg' }, binary: JPEG_BYTES },
      ] },
    { label: 'bflUltraMaxAspect', route: '/api/sd/bfl/generate',
      body: JSON.stringify({ prompt: 'a tree', model: 'flux-pro-1.1-ultra', width: 1000, height: 100 }),
      secrets: secretEntry('api_key_bfl', KEYS.bfl),
      mocks: [
          { match: '/v1/flux-pro-1.1-ultra', times: 1, payload: { id: BFL_JOB_ID, polling_url: BFL_POLL } },
          { match: 'bfl-poll.example.test', payload: { status: 'Ready', result: { sample: BFL_SAMPLE } } },
          { match: 'bfl-media.example.test', headers: { 'content-type': 'image/jpeg' }, binary: JPEG_BYTES },
      ] },
    { label: 'bflUltraMinAspect', route: '/api/sd/bfl/generate',
      body: JSON.stringify({ prompt: 'a tree', model: 'flux-pro-1.1-ultra', width: 100, height: 1000 }),
      secrets: secretEntry('api_key_bfl', KEYS.bfl),
      mocks: [
          { match: '/v1/flux-pro-1.1-ultra', times: 1, payload: { id: BFL_JOB_ID, polling_url: BFL_POLL } },
          { match: 'bfl-poll.example.test', payload: { status: 'Ready', result: { sample: BFL_SAMPLE } } },
          { match: 'bfl-media.example.test', headers: { 'content-type': 'image/jpeg' }, binary: JPEG_BYTES },
      ] },
    // An -ultra model with NO dimensions: `gcd(NaN, undefined)` never terminates and its RangeError becomes a
    // 500 with ZERO outbound requests.
    { label: 'bflUltraMissingDimensions', route: '/api/sd/bfl/generate',
      body: JSON.stringify({ prompt: 'a tree', model: 'flux-pro-1.1-ultra' }),
      secrets: secretEntry('api_key_bfl', KEYS.bfl), mocks: [] },
    { label: 'bflSubmitNonOk', route: '/api/sd/bfl/generate',
      body: JSON.stringify({ prompt: 'a tree', model: 'flux-pro-1.1' }),
      secrets: secretEntry('api_key_bfl', KEYS.bfl),
      mocks: [{ match: '/v1/flux-pro-1.1', times: 1, status: 500, text: 'bfl says no' }] },
    // A model with NEITHER suffix keeps the full projection, so the two delete branches are discriminated
    // against "deleted for everyone". The 500 answer keeps the probe fast: the observation is the body.
    { label: 'bflPlainModelKeepsSteps', route: '/api/sd/bfl/generate',
      body: JSON.stringify({ prompt: 'a tree', model: 'flux-dev', steps: 40, guidance: 2.5, width: 512, height: 768, prompt_upsampling: true, seed: 42 }),
      secrets: secretEntry('api_key_bfl', KEYS.bfl),
      mocks: [{ match: '/v1/flux-dev', times: 1, status: 500, text: 'bfl says no' }] },
    { label: 'bflPollNonOk', route: '/api/sd/bfl/generate',
      body: JSON.stringify({ prompt: 'a tree', model: 'flux-pro-1.1' }),
      secrets: secretEntry('api_key_bfl', KEYS.bfl),
      mocks: [
          { match: '/v1/flux-pro-1.1', times: 1, payload: { id: BFL_JOB_ID, polling_url: BFL_POLL } },
          { match: 'bfl-poll.example.test', status: 500, text: 'poll exploded' },
      ] },
    { label: 'bflUnexpectedStatus', route: '/api/sd/bfl/generate',
      body: JSON.stringify({ prompt: 'a tree', model: 'flux-pro-1.1' }),
      secrets: secretEntry('api_key_bfl', KEYS.bfl),
      mocks: [
          { match: '/v1/flux-pro-1.1', times: 1, payload: { id: BFL_JOB_ID, polling_url: BFL_POLL } },
          { match: 'bfl-poll.example.test', payload: { status: 'Error', detail: 'moderation' } },
      ] },
    // The sample fetch has NO `ok` check: a non-2xx sample answer is still read as bytes and answered 200.
    { label: 'bflSampleFetchNonOk', route: '/api/sd/bfl/generate',
      body: JSON.stringify({ prompt: 'a tree', model: 'flux-pro-1.1' }),
      secrets: secretEntry('api_key_bfl', KEYS.bfl),
      mocks: [
          { match: '/v1/flux-pro-1.1', times: 1, payload: { id: BFL_JOB_ID, polling_url: BFL_POLL } },
          { match: 'bfl-poll.example.test', payload: { status: 'Ready', result: { sample: BFL_SAMPLE } } },
          { match: 'bfl-media.example.test', status: 500, text: 'sample exploded' },
      ] },
    { label: 'bflSubmitThrows', route: '/api/sd/bfl/generate',
      body: JSON.stringify({ prompt: 'a tree', model: 'flux-pro-1.1' }),
      secrets: secretEntry('api_key_bfl', KEYS.bfl),
      mocks: [{ match: '/v1/flux-pro-1.1', times: 1, throws: true }] },
    // A reserved-character model is interpolated into the path RAW (rule 15).
    { label: 'bflReservedModelRaw', route: '/api/sd/bfl/generate',
      body: JSON.stringify({ prompt: 'a tree', model: 'flux-pro-1.1/x y?z=1' }),
      secrets: secretEntry('api_key_bfl', KEYS.bfl),
      mocks: [{ match: '/v1/flux-pro-1.1/x', times: 1, status: 500, text: 'bfl says no' }] },

    // ── fal.ai (submit, poll status_url, then response_url, then the image url) ────────────────────
    { label: 'falaiNoKey', route: '/api/sd/falai/generate',
      body: JSON.stringify({ prompt: 'a tree', model: 'flux-pro' }), secrets: {}, mocks: [] },
    { label: 'falaiCompletedFirstPoll', route: '/api/sd/falai/generate',
      body: JSON.stringify({ prompt: 'a tree', model: 'flux-pro', steps: 20, width: 512, height: 768, seed: 42, guidance: 3.5 }),
      secrets: secretEntry('api_key_falai', KEYS.falai),
      mocks: [
          { match: '/fal-ai/flux-pro', times: 1, payload: { request_id: 'req-one', status_url: FAL_STATUS } },
          { match: 'fal-status.example.test', payload: { status: 'COMPLETED', response_url: FAL_RESULT } },
          { match: 'fal-result.example.test', payload: { images: [{ url: FAL_IMAGE }] } },
          { match: 'fal-media.example.test', headers: { 'content-type': 'image/jpeg' }, binary: JPEG_BYTES },
      ] },
    { label: 'falaiInQueueThenCompleted', route: '/api/sd/falai/generate',
      body: JSON.stringify({ prompt: 'a tree', model: 'flux-pro', seed: 0 }),
      secrets: secretEntry('api_key_falai', KEYS.falai),
      mocks: [
          { match: '/fal-ai/flux-pro', times: 1, payload: { request_id: 'req-one', status_url: FAL_STATUS } },
          { match: 'fal-status.example.test', times: 1, payload: { status: 'IN_QUEUE' } },
          { match: 'fal-status.example.test', payload: { status: 'COMPLETED', response_url: FAL_RESULT } },
          { match: 'fal-result.example.test', payload: { images: [{ url: FAL_IMAGE }] } },
          { match: 'fal-media.example.test', headers: { 'content-type': 'image/jpeg' }, binary: JPEG_BYTES },
      ] },
    { label: 'falaiSubmitNonOk', route: '/api/sd/falai/generate',
      body: JSON.stringify({ prompt: 'a tree', model: 'flux-pro' }),
      secrets: secretEntry('api_key_falai', KEYS.falai),
      mocks: [{ match: '/fal-ai/flux-pro', times: 1, status: 500, text: 'fal says no' }] },
    // An unknown status throws with the status payload as `cause`, and fal.ai's catch sends
    // `error.cause || error.message`: an OBJECT cause is sent as JSON — the one non-text failure shape here.
    { label: 'falaiUnexpectedStatus', route: '/api/sd/falai/generate',
      body: JSON.stringify({ prompt: 'a tree', model: 'flux-pro' }),
      secrets: secretEntry('api_key_falai', KEYS.falai),
      mocks: [
          { match: '/fal-ai/flux-pro', times: 1, payload: { request_id: 'req-one', status_url: FAL_STATUS } },
          { match: 'fal-status.example.test', payload: { status: 'ERROR', detail: 'boom' } },
      ] },
    { label: 'falaiResultDetail', route: '/api/sd/falai/generate',
      body: JSON.stringify({ prompt: 'a tree', model: 'flux-pro' }),
      secrets: secretEntry('api_key_falai', KEYS.falai),
      mocks: [
          { match: '/fal-ai/flux-pro', times: 1, payload: { request_id: 'req-one', status_url: FAL_STATUS } },
          { match: 'fal-status.example.test', payload: { status: 'COMPLETED', response_url: FAL_RESULT } },
          { match: 'fal-result.example.test', payload: { detail: [{ loc: ['body', 'prompt'], msg: 'field required' }] } },
      ] },
    { label: 'falaiPollNonOk', route: '/api/sd/falai/generate',
      body: JSON.stringify({ prompt: 'a tree', model: 'flux-pro' }),
      secrets: secretEntry('api_key_falai', KEYS.falai),
      mocks: [
          { match: '/fal-ai/flux-pro', times: 1, payload: { request_id: 'req-one', status_url: FAL_STATUS } },
          { match: 'fal-status.example.test', status: 500, text: 'status exploded' },
      ] },
    // A transport failure reaches the catch with NO cause, so the body is the JS error MESSAGE.
    { label: 'falaiSubmitThrows', route: '/api/sd/falai/generate',
      body: JSON.stringify({ prompt: 'a tree', model: 'flux-pro' }),
      secrets: secretEntry('api_key_falai', KEYS.falai),
      mocks: [{ match: '/fal-ai/flux-pro', times: 1, throws: true }] },
    { label: 'falaiReservedModelRaw', route: '/api/sd/falai/generate',
      body: JSON.stringify({ prompt: 'a tree', model: 'flux/pro v1?x=1' }),
      secrets: secretEntry('api_key_falai', KEYS.falai),
      mocks: [{ match: '/fal-ai/flux/pro', times: 1, status: 500, text: 'fal says no' }] },
];

const server = await startPinnedProviderServer({ sourceRoot, prefix: 'gotavern-sd-generate-wave5-oracle-', mocks: [] });
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
            // A TIMED rule answers at most this many times, which is what turns a poll loop's request COUNT
            // into fixture data instead of a wall-clock artefact (AGENTS.md rule 20).
            ...(rule.times === undefined ? {} : { times: rule.times }),
        }));
        server.writeSecrets(scenario.secrets ?? {});
        server.setMocks(rules);
        const started = Date.now();
        const result = await server.post(scenario.route, scenario.body);
        const elapsed = Date.now() - started;
        const requests = server.outbound();
        scenarios[scenario.label] = {
            route: scenario.route,
            requestBody: scenario.body,
            mocks: rules,
            secrets: server.readSecrets(),
            // A two-way bucket, never a duration: a duration differs on every host and run, while "did this
            // scenario spend at least one 2500ms delay" is a property of the route.
            elapsedBucket: elapsed < 2000 ? 'under-2s' : 'waited-for-poll',
            response: captureHttp(result),
            outbound: requests.map(request => ({ url: request.url, method: request.method, headers: request.headers, body: request.body })),
        };
    }
} catch (error) {
    console.error('PROBE FAILED; pinned server log tail:');
    console.error(server.logs.join('').slice(-8000));
    throw error;
} finally {
    await server.stop();
}

// An assertion that dereferences `outbound[0]` turns a fixture difference into a stack trace, and it would
// be a SILENT PASS had the expected value also been undefined, so every dereference goes through
// requireOutbound, which REFUSES with the evidence needed to tell a probe defect from a product difference.
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

// ── bfl assertions ─────────────────────────────────────────────────────────────────────────────────
// THE POLL COUNT IS THE ASSERTION in this file: a scenario that recorded one poll must record exactly one,
// and the two-poll scenario exactly two.
assert.equal(scenarios.bflNoKey.response.status, 400, 'bfl without a key is 400');
assert.equal(scenarios.bflNoKey.outbound.length, 0, 'a missing bfl key sends nothing');

const bflReady = scenarios.bflPro11ReadyFirstPoll;
assert.equal(bflReady.response.status, 200, 'bfl answers 200 when the FIRST poll is Ready');
assert.deepEqual(bflReady.response.body, { image: JPEG_BYTES.toString('base64') },
    'bfl answers the fetched sample bytes as base64, with NO format member');
assert.equal(bflReady.outbound.length, 3, 'submit, one poll, one sample fetch');
assert.equal(requireOutbound('bflPro11ReadyFirstPoll', 0).url, `${BFL}/v1/flux-pro-1.1`, 'the submit URL is /v1/<model>');
assert.equal(requireOutbound('bflPro11ReadyFirstPoll', 0).method, 'POST', 'the submit is a POST');
assert.equal(requireOutbound('bflPro11ReadyFirstPoll', 0).body,
    '{"prompt":"a tree","width":512,"height":768,"prompt_upsampling":true,"seed":42,"safety_tolerance":6,"output_format":"jpeg"}',
    'a model ending in -pro-1.1 DROPS steps and guidance; everything else keeps the pinned member order');
assert.equal(requireOutbound('bflPlainModelKeepsSteps', 0).body,
    '{"prompt":"a tree","steps":40,"guidance":2.5,"width":512,"height":768,"prompt_upsampling":true,"seed":42,"safety_tolerance":6,"output_format":"jpeg"}',
    'a model with neither suffix keeps every projected member, so both delete branches are discriminated');
assert.equal(requireOutbound('bflPro11ReadyFirstPoll', 0).headers['content-type'], 'application/json', 'bfl submits JSON');
assert.equal(requireOutbound('bflPro11ReadyFirstPoll', 0).headers['x-key'], KEYS.bfl, 'bfl authenticates with x-key, not a bearer');
assert.equal(requireOutbound('bflPro11ReadyFirstPoll', 1).url, `${BFL_POLL}?task=${BFL_JOB_ID}`,
    'the POLL uses the polling_url the provider returned, verbatim');
assert.equal(requireOutbound('bflPro11ReadyFirstPoll', 1).method, 'GET', 'the poll is a GET (no method is passed)');
assert.equal(requireOutbound('bflPro11ReadyFirstPoll', 1).headers['x-key'], KEYS.bfl,
    'the poll carries the key as well: bfl requires auth on the polling request');
assert.equal(requireOutbound('bflPro11ReadyFirstPoll', 1).headers['content-type'], undefined, 'the poll declares no content type');
assert.equal(requireOutbound('bflPro11ReadyFirstPoll', 2).url, BFL_SAMPLE, 'then the provider sample URL is fetched');
assert.equal(requireOutbound('bflPro11ReadyFirstPoll', 2).headers['x-key'], undefined,
    'the sample fetch is a bare fetch(sample): it carries NO key');

assert.equal(scenarios.bflPendingThenReady.outbound.length, 4, 'a Pending answer makes the loop poll TWICE');
assert.equal(requireOutbound('bflPendingThenReady', 1).url, requireOutbound('bflPendingThenReady', 2).url,
    'both polls go to the same URL, so only the COUNT differs');
assert.equal(scenarios.bflPendingThenReady.elapsedBucket, 'waited-for-poll', 'the poll loop really waits 2500ms');
assert.equal(scenarios.bflFallbackPollingUrl.outbound.length, 3, 'the fallback poll is one poll plus the sample');
assert.equal(requireOutbound('bflFallbackPollingUrl', 1).url, `${BFL}/v1/get_result?id=${BFL_JOB_ID}`,
    'an answer without polling_url falls back to the pinned get_result template');

assert.equal(requireOutbound('bflUltraSimplifiedRatio', 0).body,
    '{"prompt":"a tree","seed":42,"safety_tolerance":6,"output_format":"jpeg","aspect_ratio":"2:3"}',
    'an -ultra model DROPS steps/guidance/width/height/prompt_upsampling and appends aspect_ratio');
assert.equal(requireOutbound('bflUltraMaxAspect', 0).body,
    '{"prompt":"a tree","seed":null,"safety_tolerance":6,"output_format":"jpeg","aspect_ratio":"233:100"}',
    'above 21/9 the width is recomputed from the height; an absent seed becomes null');
assert.equal(requireOutbound('bflUltraMinAspect', 0).body,
    '{"prompt":"a tree","seed":null,"safety_tolerance":6,"output_format":"jpeg","aspect_ratio":"100:233"}',
    'below 9/21 the height is recomputed from the width');
assert.equal(scenarios.bflUltraSimplifiedRatio.response.body.image, JPEG_BYTES.toString('base64'),
    'the ultra branch still answers the sample');
assert.equal(scenarios.bflUltraMissingDimensions.response.status, 500,
    'an -ultra model with no dimensions recurses forever in gcd and the catch answers 500');
assert.equal(scenarios.bflUltraMissingDimensions.outbound.length, 0, 'and nothing is sent');
assert.equal(scenarios.bflSubmitNonOk.response.status, 500, 'a non-ok submit is a 500');
assert.equal(scenarios.bflSubmitNonOk.outbound.length, 1, 'a non-ok submit never polls');
assert.equal(scenarios.bflPollNonOk.response.status, 500, 'a non-ok poll is a 500');
assert.equal(scenarios.bflPollNonOk.outbound.length, 2, 'and it stops before any sample fetch');
assert.equal(scenarios.bflUnexpectedStatus.response.status, 500, 'an unknown status throws into the catch');
assert.equal(scenarios.bflUnexpectedStatus.response.bodyText, 'Internal Server Error', 'bfl sends a bare status message');
assert.equal(scenarios.bflUnexpectedStatus.outbound.length, 2, 'an unknown status never fetches a sample');
assert.equal(scenarios.bflSampleFetchNonOk.response.status, 200,
    'the sample fetch has NO ok check: a non-2xx sample answer still produces a 200 image');
assert.equal(scenarios.bflSampleFetchNonOk.response.body.image, Buffer.from('sample exploded', 'utf8').toString('base64'),
    'the 500 error BODY becomes the image bytes, which is what the pinned route does');
assert.equal(scenarios.bflSampleFetchNonOk.outbound.length, 3, 'submit, poll, sample fetch');
assert.equal(scenarios.bflSubmitThrows.response.status, 500, 'a rejected bfl submit is a 500');
assert.equal(scenarios.bflSubmitThrows.outbound.length, 1, 'the attempted submit is still recorded');
assert.equal(requireOutbound('bflReservedModelRaw', 0).url, `${BFL}/v1/flux-pro-1.1/x y?z=1`,
    'a reserved-character model is interpolated RAW into the path (rule 15)');

// ── fal.ai assertions ─────────────────────────────────────────────────────────────────────────────
assert.equal(scenarios.falaiNoKey.response.status, 400, 'fal.ai without a key is 400');
assert.equal(scenarios.falaiNoKey.outbound.length, 0, 'a missing fal.ai key sends nothing');
const falaiDone = scenarios.falaiCompletedFirstPoll;
assert.equal(falaiDone.response.status, 200, 'fal.ai answers 200 when the FIRST status is COMPLETED');
assert.deepEqual(falaiDone.response.body, { image: JPEG_BYTES.toString('base64') }, 'fal.ai answers the image bytes as base64');
assert.equal(falaiDone.outbound.length, 4, 'submit, one status poll, the result document, the image');
assert.equal(requireOutbound('falaiCompletedFirstPoll', 0).url, `${FAL_QUEUE}/fal-ai/flux-pro`,
    'the submit URL is queue.fal.run/fal-ai/<model>');
assert.equal(requireOutbound('falaiCompletedFirstPoll', 0).body,
    '{"prompt":"a tree","image_size":{"width":512,"height":768},"num_inference_steps":20,"seed":42,"guidance_scale":3.5,"enable_safety_checker":false,"safety_tolerance":6}',
    'the fal.ai projection, including the nested image_size member order');
assert.equal(requireOutbound('falaiCompletedFirstPoll', 0).headers.authorization, `Key ${KEYS.falai}`,
    'fal.ai authenticates with the "Key " scheme, not a bearer');
assert.equal(requireOutbound('falaiCompletedFirstPoll', 1).url, FAL_STATUS,
    'the status poll uses the provider status_url verbatim');
assert.equal(requireOutbound('falaiCompletedFirstPoll', 1).headers.authorization, `Key ${KEYS.falai}`, 'the status poll is authenticated');
assert.equal(requireOutbound('falaiCompletedFirstPoll', 2).url, FAL_RESULT,
    'the RESULT document comes from the STATUS answer response_url, not from the submit answer');
assert.equal(requireOutbound('falaiCompletedFirstPoll', 2).method, 'GET', 'the result document is a GET');
assert.equal(requireOutbound('falaiCompletedFirstPoll', 3).url, FAL_IMAGE, 'then images[0].url is fetched');
assert.equal(requireOutbound('falaiCompletedFirstPoll', 3).headers.authorization, `Key ${KEYS.falai}`,
    'the IMAGE fetch carries the key too, which is the pinned behaviour');
assert.equal(scenarios.falaiInQueueThenCompleted.outbound.length, 5, 'an IN_QUEUE answer makes the loop poll TWICE');
assert.equal(requireOutbound('falaiInQueueThenCompleted', 1).url, requireOutbound('falaiInQueueThenCompleted', 2).url,
    'both status polls go to the same URL');
assert.equal(scenarios.falaiSubmitNonOk.response.status, 500, 'a non-ok submit is a 500');
assert.equal(scenarios.falaiSubmitNonOk.outbound.length, 1, 'and it never polls');
assert.equal(scenarios.falaiUnexpectedStatus.response.status, 500, 'an unknown status throws into the catch');
assert.deepEqual(scenarios.falaiUnexpectedStatus.response.body, { status: 'ERROR', detail: 'boom' },
    'the CAUSE is the status payload and express sends an object as JSON - the one non-text failure shape here');
assert.equal(scenarios.falaiUnexpectedStatus.outbound.length, 2, 'an unknown status never fetches a result');
assert.equal(scenarios.falaiResultDetail.response.status, 500, 'a result detail is a 500');
assert.equal(scenarios.falaiResultDetail.response.bodyText, 'prompt: field required',
    'the cause is the STRING "<loc[1]>: <msg>", sent as html-typed text');
assert.equal(scenarios.falaiResultDetail.outbound.length, 3, 'a result detail never fetches an image');
assert.equal(scenarios.falaiPollNonOk.response.status, 500, 'a non-ok status poll is a 500');
assert.equal(scenarios.falaiPollNonOk.response.bodyText, 'Internal Server Error', 'fal.ai sends a bare status message there');
assert.equal(scenarios.falaiPollNonOk.outbound.length, 2, 'and it stops before the result document');
assert.equal(scenarios.falaiSubmitThrows.response.status, 500, 'a rejected fal.ai submit is a 500');
assert.equal(scenarios.falaiSubmitThrows.response.bodyText, 'fetch failed',
    'fal.ai forwards the JS error MESSAGE on the transport branch');
assert.equal(scenarios.falaiSubmitThrows.outbound.length, 1, 'the attempted submit is still recorded');
assert.equal(requireOutbound('falaiReservedModelRaw', 0).url, `${FAL_QUEUE}/fal-ai/flux/pro v1?x=1`,
    'a reserved-character model is interpolated RAW into the path (rule 15)');

const sha256 = value => createHash('sha256').update(value).digest('hex');

const fixture = {
    schemaVersion: 1,
    baseline: { version: PINNED_VERSION, commit: PINNED_COMMIT },
    probe: 'tools/probe-sd-generate-wave5.mjs',
    waves: { 5: ['/api/sd/bfl/generate', '/api/sd/falai/generate'] },
    implementedRoutes: ['/api/sd/bfl/generate', '/api/sd/falai/generate'],
    notImplementedRoutes: [],
    pinnedSource: {
        'src/endpoints/stable-diffusion.js:1473': 'bfl: POST https://api.bfl.ai/v1/<model> with a fixed projection, then up to 100 polls of the provider polling_url or https://api.bfl.ai/v1/get_result?id=<id> after delay(2500), each poll carrying x-key, then a bare fetch of result.sample',
        'src/endpoints/stable-diffusion.js:1641': 'falai: POST queue.fal.run/fal-ai/<model>, then up to 100 status polls after delay(2500), then the response_url from the STATUS answer, then images[0].url, all with "Key <key>" auth; the catch answers error.cause || error.message',
    },
    mechanism: 'Every upstream is a hardcoded literal, so the probe replaces the `node-fetch` module and the global `fetch` with a controlled peer (tools/lib/pinned-outbound.mjs); the Go side uses its own seams for the two provider bases and replays the recorded rules through a real local listener, rewriting the provider-supplied follow-up URLs onto it.',
    fields: [
        { path: 'scenarios.*.response.status', comparison: 'compared', reason: 'the pinned handlers choose 200/400/500 themselves' },
        { path: 'scenarios.*.response.headers', comparison: 'compared', reason: 'Express and the pinned middleware stack set them; a string body is html-typed and an object cause is json-typed' },
        { path: 'scenarios.*.response.body/bodyText', comparison: 'compared', reason: 'the projection, including the base64 image payload and the fal.ai cause text/JSON' },
        { path: 'scenarios.*.outbound[].url', comparison: 'compared', reason: 'the first hop is the seam plus the RAW model interpolation; the follow-up hops are the URLs the provider handed back, compared as path+query because the host is the provider\'s choice' },
        { path: 'scenarios.*.outbound[].body', comparison: 'compared', reason: 'JSON member order and the omitted-undefined members of the projection; seeds are NOT masked because both routes forward the caller seed' },
        { path: 'scenarios.*.outbound[].headers', comparison: 'compared', reason: 'the declared provider headers, asserted in BOTH directions by the test (x-key versus Authorization, and the key carried to the image host)' },
        { path: 'scenarios.*.outbound[].count', comparison: 'compared', reason: 'the poll COUNT is fixture data, produced by `times`-bounded rules; the replay refuses a different count' },
        { path: 'scenarios.*.elapsedBucket', comparison: 'recorded-not-replayed', reason: 'a two-way bucket (under 2s / at least one 2500ms delay). A duration would be host-derived; the bucket only proves the loop waited. The Go replay collapses the interval through a test seam, so this is evidence about the PINNED run; separate Go tests pin the interval and the attempt count.' },
        { path: 'scenarios.*.mocks', comparison: 'recorded-not-compared', reason: 'the timed rule list the peer served, so a scenario can be re-driven from the fixture alone' },
        { path: 'scenarios.*.secrets', comparison: 'recorded-not-compared', reason: 'the secrets file the probe wrote, so a reader can see which key each branch used' },
    ],
    normalizations: [
        'Synthetic credentials and synthetic image bytes only.',
        'The provider-supplied follow-up hosts are synthetic (bfl-poll/bfl-media/fal-status/fal-result/fal-media.example.test), so no recording can be mistaken for live provider data.',
        'The seed is recorded EXACTLY, not masked: these two routes forward the caller seed, so masking it would let an implementation that defaulted it pass.',
    ],
    inputs: {
        imageSha256: sha256(JPEG_BYTES),
        keys: KEYS,
    },
    // WHAT THIS FILE DOES NOT RECORD, stated rather than implied.
    notCovered: {
        'bfl timeout': 'The 100-attempt exhaustion branch needs 100 polls of delay(2500), about four minutes of wall clock, so it is NOT recorded; shortening the delay in the probe would record a behaviour the product does not have. It is covered by a LABELLED Go implementation test (TestSDBFLTimeoutIsAnImplementationTest), and the pinned observable is that the handler answers NOTHING after the loop runs out.',
        'falai timeout': 'Same branch on the same reasoning; see TestSDFalaiTimeoutIsAnImplementationTest.',
        'reserved-character job id in the bfl fallback query': 'The fallback template interpolates the task id into a QUERY (`?id=<id>`). A recorded id containing a space would be re-encoded by the pinned URL parser and re-sent verbatim by the Go transport, which is an unresolved divergence rather than a covered behaviour, so only a plain token id is recorded. Real BFL task ids are opaque tokens.',
        'falai non-JSON result document': 'The pinned catch would answer the JS SyntaxError message, which is a V8 version string rather than a product decision, so no scenario records it; the Go side answers a plain 500 there and the difference is a KNOWN, UNPINNED gap.',
        'bfl Ready status without result.sample': 'The pinned code fetches `undefined`, which node-fetch rejects, so the pinned server answers 500. It is NOT recordable through the controlled peer: the peer records the request for the string "undefined", finds no rule and synthesises a 500 RESPONSE, and because the sample fetch has no ok check the route turns that synthesised answer into a 200 image of the stub text. Recording it would be a probe artefact presented as an oracle, so the branch is covered by the LABELLED Go implementation test TestSDBFLMissingSampleIsAnImplementationTest instead.',
    },
    bootOutbound,
    scenarios,
};

const outputFile = writeFixture(repositoryRoot, 'sillytavern-1.19.0-sd-generate-wave5.json', fixture);
console.log(`scenarios: ${Object.keys(scenarios).length}, boot outbound: ${bootOutbound.length}`);
console.log(`fixture written to ${outputFile}`);
