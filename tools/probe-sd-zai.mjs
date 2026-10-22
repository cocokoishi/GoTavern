#!/usr/bin/env node
// @gotavern-oracle: fixture=sillytavern-1.19.0-sd-zai.json label="sd zai"
// Probe the PINNED z.ai stable-diffusion routes:
//
//	POST /api/sd/zai/generate         src/endpoints/stable-diffusion.js:1880
//	POST /api/sd/zai/generate-video   src/endpoints/stable-diffusion.js:1957
//
// WHAT IS RECORDABLE HERE, AND WHY THE IMAGE ROUTE'S SUCCESS PATH IS NOT.
//
// The image route guards the provider-returned URL with
// `!url.hostname.endsWith('.z.ai') && !url.hostname.endsWith('.ufileos.com')` and then fetches that URL
// AS GIVEN. The probe's stub would happily answer a `.z.ai` URL, so the pinned side could record the
// success path — but the GO side cannot: its own replay peer is on 127.0.0.1, the guard is evaluated by
// the implementation itself (not by the harness), and no seam can make a local listener answer to a
// `.z.ai` name. Recording that path would put a scenario in the fixture that the Go replay can never
// drive, which is exactly how an unrelated test went red in the previous lane. So the image route is
// recorded at its REFUSAL and ERROR branches only (key guard, submit failure, unparseable URL, and the
// hostname guard including the apex and suffix traps), each with the exact number of outbound requests
// so "refused" is distinguishable from "fetched and failed" (AGENTS.md rule 17).
//
// The VIDEO route builds its poll URL from a literal plus `data.id` (no provider-supplied polling URL)
// and puts NO hostname guard on the content URL, so its whole success path IS replayable: the content
// URL is rewritten onto the local peer by the test and the poll COUNT is fixture data (`times` rules,
// submit rule bounded, distinct paths so a submit rule cannot swallow a poll — rule 20).
//
// NOT RECORDED, with the reason in `notCovered`: the image success path and its 404-retry branch (the
// hostname guard makes them unreplayable in Go), the video 30-attempt exhaustion branch (591s of
// escalating delays: 5s..34s), an unknown `task_status` (it keeps polling to exhaustion, same cost), and
// the client-disconnect abort (a labelled Go implementation test instead).

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';

import { PINNED_COMMIT, PINNED_VERSION, captureHttp, startPinnedProviderServer, writeFixture } from './lib/pinned-outbound.mjs';

const sourceRoot = path.resolve(process.argv[2] ?? '');
const repositoryRoot = path.resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3]) {
    console.error('usage: node tools/probe-sd-zai.mjs <pinned-source-clone> <gotavern-root>');
    process.exit(2);
}
if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim() !== PINNED_COMMIT) {
    throw new Error(`upstream checkout is not pinned at ${PINNED_COMMIT}`);
}

const ZAI = 'https://api.z.ai';
const ZAI_IMAGES = `${ZAI}/api/paas/v4/images/generations`;
const ZAI_VIDEOS = `${ZAI}/api/paas/v4/videos/generations`;
const VIDEO_URL = 'https://media.example.test/clip.mp4';
const VIDEO_BYTES = Buffer.from('gotavern-synthetic-mp4', 'utf8');
const KEY = 'synthetic-zai-key';
const JOB_ID = 'gotavern-video-job';
const RESERVED_JOB_ID = 'job/one two';

const IMAGE_BODY = { prompt: 'a tree', model: 'cogview-4', quality: 'hd', size: '1024x1024' };
const VIDEO_BODY = { prompt: 'a cat', model: 'cogvideox-3', quality: '720p', size: '1920x1080', aspect_ratio: '16:9' };

function secretEntry(key, value) {
    return { [key]: [{ id: `sid-${key}`, value, label: key, active: true }] };
}

const IMAGE_SECRETS = secretEntry('api_key_zai', KEY);

// A submit answer that carries one provider image URL; the route's answer depends only on that URL.
function submitWithURL(url) {
    return { match: '/v4/images/generations', times: 1, payload: { data: [{ url }] } };
}

function pollWith(payload, times) {
    return { match: '/async-result/', payload, ...(times === undefined ? {} : { times }) };
}

const SCENARIOS = [
    // ── zai/generate: the REFUSAL and ERROR branches (the success path is not replayable, see header) ──
    { label: 'zaiNoKey', route: '/api/sd/zai/generate', body: JSON.stringify(IMAGE_BODY), secrets: {}, mocks: [] },
    { label: 'zaiSubmitNonOk', route: '/api/sd/zai/generate', body: JSON.stringify(IMAGE_BODY), secrets: IMAGE_SECRETS,
      mocks: [{ match: '/v4/images/generations', times: 1, status: 500, text: 'zai says no' }] },
    { label: 'zaiSubmitThrows', route: '/api/sd/zai/generate', body: JSON.stringify(IMAGE_BODY), secrets: IMAGE_SECRETS,
      mocks: [{ match: '/v4/images/generations', times: 1, throws: true }] },
    // `String(data?.data?.[0]?.url ?? '')` then `isValidUrl` — both failure branches answer 500.
    { label: 'zaiNoURL', route: '/api/sd/zai/generate', body: JSON.stringify(IMAGE_BODY), secrets: IMAGE_SECRETS,
      mocks: [{ match: '/v4/images/generations', times: 1, payload: { data: [{}] } }] },
    { label: 'zaiInvalidURL', route: '/api/sd/zai/generate', body: JSON.stringify(IMAGE_BODY), secrets: IMAGE_SECRETS,
      mocks: [submitWithURL('not a url')] },
    // The hostname guard: a URL on ANY other host is refused WITHOUT being fetched, which is what the
    // zero-second-request assertion pins.
    { label: 'zaiRefusedHost', route: '/api/sd/zai/generate', body: JSON.stringify(IMAGE_BODY), secrets: IMAGE_SECRETS,
      mocks: [submitWithURL('https://images.example.test/one.png')] },
    // The guard is `endsWith('.z.ai')`, so the APEX `z.ai` itself is refused.
    { label: 'zaiRefusedApex', route: '/api/sd/zai/generate', body: JSON.stringify(IMAGE_BODY), secrets: IMAGE_SECRETS,
      mocks: [submitWithURL('https://z.ai/one.png')] },
    // ... and a host that merely CONTAINS `z.ai` is refused too: `notz.ai` ends with `tz.ai`, not `.z.ai`.
    { label: 'zaiRefusedSuffixTrap', route: '/api/sd/zai/generate', body: JSON.stringify(IMAGE_BODY), secrets: IMAGE_SECRETS,
      mocks: [submitWithURL('https://notz.ai/one.png')] },
    // ... and a `.z.ai` LABEL inside a longer hostname does not satisfy `endsWith` either.
    { label: 'zaiRefusedLabelInside', route: '/api/sd/zai/generate', body: JSON.stringify(IMAGE_BODY), secrets: IMAGE_SECRETS,
      mocks: [submitWithURL('https://good.z.ai.attacker.example/one.png')] },

    // ── zai/generate-video: submit, then poll a URL built from data.id ──────────────────────────────
    { label: 'zaiVideoNoKey', route: '/api/sd/zai/generate-video', body: JSON.stringify(VIDEO_BODY), secrets: {}, mocks: [] },
    { label: 'zaiVideoSubmitNonOk', route: '/api/sd/zai/generate-video', body: JSON.stringify(VIDEO_BODY), secrets: IMAGE_SECRETS,
      mocks: [{ match: '/v4/videos/generations', times: 1, status: 500, text: 'zai says no' }] },
    { label: 'zaiVideoSubmitThrows', route: '/api/sd/zai/generate-video', body: JSON.stringify(VIDEO_BODY), secrets: IMAGE_SECRETS,
      mocks: [{ match: '/v4/videos/generations', times: 1, throws: true }] },
    { label: 'zaiVideoCompletedFirstPoll', route: '/api/sd/zai/generate-video', body: JSON.stringify(VIDEO_BODY), secrets: IMAGE_SECRETS,
      mocks: [
          { match: '/v4/videos/generations', times: 1, payload: { id: JOB_ID } },
          pollWith({ task_status: 'SUCCESS', video_result: [{ url: VIDEO_URL }] }),
          { match: 'media.example.test', headers: { 'content-type': 'video/mp4' }, binary: VIDEO_BYTES },
      ] },
    // Two polls, so the poll COUNT is fixture data: the PROCESSING rule answers ONCE.
    { label: 'zaiVideoCompletedSecondPoll', route: '/api/sd/zai/generate-video', body: JSON.stringify(VIDEO_BODY), secrets: IMAGE_SECRETS,
      mocks: [
          { match: '/v4/videos/generations', times: 1, payload: { id: JOB_ID } },
          pollWith({ task_status: 'PROCESSING' }, 1),
          pollWith({ task_status: 'SUCCESS', video_result: [{ url: VIDEO_URL }] }),
          { match: 'media.example.test', headers: { 'content-type': 'video/mp4' }, binary: VIDEO_BYTES },
      ] },
    { label: 'zaiVideoTaskFail', route: '/api/sd/zai/generate-video', body: JSON.stringify(VIDEO_BODY), secrets: IMAGE_SECRETS,
      mocks: [
          { match: '/v4/videos/generations', times: 1, payload: { id: JOB_ID } },
          pollWith({ task_status: 'FAIL', detail: 'moderation' }),
      ] },
    { label: 'zaiVideoPollNonOk', route: '/api/sd/zai/generate-video', body: JSON.stringify(VIDEO_BODY), secrets: IMAGE_SECRETS,
      mocks: [
          { match: '/v4/videos/generations', times: 1, payload: { id: JOB_ID } },
          { match: '/async-result/', status: 500, text: 'poll exploded' },
      ] },
    { label: 'zaiVideoNoURL', route: '/api/sd/zai/generate-video', body: JSON.stringify(VIDEO_BODY), secrets: IMAGE_SECRETS,
      mocks: [
          { match: '/v4/videos/generations', times: 1, payload: { id: JOB_ID } },
          pollWith({ task_status: 'SUCCESS' }),
      ] },
    { label: 'zaiVideoContentNonOk', route: '/api/sd/zai/generate-video', body: JSON.stringify(VIDEO_BODY), secrets: IMAGE_SECRETS,
      mocks: [
          { match: '/v4/videos/generations', times: 1, payload: { id: JOB_ID } },
          pollWith({ task_status: 'SUCCESS', video_result: [{ url: VIDEO_URL }] }),
          { match: 'media.example.test', status: 500, text: 'content exploded' },
      ] },
    // The job id is interpolated into the PATH raw (rule 15), which the recorded poll URL shows.
    { label: 'zaiVideoReservedId', route: '/api/sd/zai/generate-video', body: JSON.stringify(VIDEO_BODY), secrets: IMAGE_SECRETS,
      mocks: [
          { match: '/v4/videos/generations', times: 1, payload: { id: RESERVED_JOB_ID } },
          { match: '/async-result/job', status: 500, text: 'poll exploded' },
      ] },
    // An answer with no `id` interpolates the string "undefined" into the poll path.
    { label: 'zaiVideoNoId', route: '/api/sd/zai/generate-video', body: JSON.stringify(VIDEO_BODY), secrets: IMAGE_SECRETS,
      mocks: [
          { match: '/v4/videos/generations', times: 1, payload: {} },
          { match: '/async-result/undefined', status: 500, text: 'poll exploded' },
      ] },
];

const server = await startPinnedProviderServer({ sourceRoot, prefix: 'gotavern-sd-zai-oracle-', mocks: [] });
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
            // A two-way bucket: the video route waits delay(5000 + attempt*1000) before EVERY poll, which is
            // 5s for one poll and 11s for two, while the image refusal branches never enter their loop.
            elapsedBucket: elapsed < 4000 ? 'under-4s' : elapsed < 9000 ? 'one-poll' : elapsed < 16000 ? 'two-polls' : 'longer',
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
        refuseProbe(`scenario ${label} recorded ${scenario.outbound.length} outbound request(s), so request ${index} cannot be compared`
            + ` | recorded status ${response.status} | recorded body ${String(response.bodyText ?? '').slice(0, 500)}`);
    }
    return scenario.outbound[index];
}

// ── zai/generate assertions ──────────────────────────────────────────────────────────────────────
assert.equal(scenarios.zaiNoKey.response.status, 400, 'zai without a key is 400');
assert.equal(scenarios.zaiNoKey.outbound.length, 0, 'a missing zai key sends nothing');
assert.equal(scenarios.zaiSubmitNonOk.response.status, 500, 'a non-ok submit is a 500');
assert.equal(scenarios.zaiSubmitNonOk.outbound.length, 1, 'a non-ok submit stops there');
assert.equal(scenarios.zaiSubmitThrows.response.status, 500, 'a rejected submit is a 500');
assert.equal(scenarios.zaiSubmitThrows.outbound.length, 1, 'the attempted submit is recorded');
assert.equal(requireOutbound('zaiSubmitNonOk', 0).url, ZAI_IMAGES, 'the submit URL is hardcoded');
assert.equal(requireOutbound('zaiSubmitNonOk', 0).body, '{"prompt":"a tree","model":"cogview-4","quality":"hd","size":"1024x1024"}',
    'the image projection is prompt/model/quality/size in that order');
assert.equal(requireOutbound('zaiSubmitNonOk', 0).headers.authorization, `Bearer ${KEY}`, 'z.ai uses a bearer key');
assert.equal(scenarios.zaiNoURL.response.status, 500, 'an answer without data[0].url is a 500');
assert.equal(scenarios.zaiNoURL.outbound.length, 1, 'and nothing is fetched');
assert.equal(scenarios.zaiInvalidURL.response.status, 500, 'an unparseable URL is a 500');
assert.equal(scenarios.zaiInvalidURL.outbound.length, 1, 'and nothing is fetched');

// THE REFUSAL IS THE OBSERVATION: a URL on any other host is refused WITHOUT a second request, so the
// count stays at 1 for every one of these and assertion of 1 IS the "refused, not fetched" claim.
for (const label of ['zaiRefusedHost', 'zaiRefusedApex', 'zaiRefusedSuffixTrap', 'zaiRefusedLabelInside']) {
    assert.equal(scenarios[label].response.status, 500, `${label} is a 500`);
    assert.equal(scenarios[label].outbound.length, 1, `${label}: the refused URL is NEVER fetched`);
}
assert.equal(scenarios.zaiRefusedApex.outbound[0].url, ZAI_IMAGES, 'the apex refusal still performed the submit');
assert.equal(scenarios.zaiRefusedHost.elapsedBucket, 'under-4s', 'a refusal never enters the image retry loop');

// ── zai/generate-video assertions ────────────────────────────────────────────────────────────────
assert.equal(scenarios.zaiVideoNoKey.response.status, 400, 'video without a key is 400');
assert.equal(scenarios.zaiVideoNoKey.outbound.length, 0, 'a missing key sends nothing');
assert.equal(scenarios.zaiVideoSubmitNonOk.response.status, 500, 'a non-ok video submit is a 500');
assert.equal(requireOutbound('zaiVideoSubmitNonOk', 0).body,
    '{"prompt":"a cat","model":"cogvideox-3","quality":"720p","size":"1920x1080","aspect_ratio":"16:9"}',
    'the video projection adds aspect_ratio after size');
assert.equal(requireOutbound('zaiVideoSubmitNonOk', 0).url, ZAI_VIDEOS, 'the video submit URL is hardcoded');
assert.equal(scenarios.zaiVideoSubmitThrows.response.status, 500, 'a rejected video submit is a 500');

const firstPoll = scenarios.zaiVideoCompletedFirstPoll;
assert.equal(firstPoll.response.status, 200, 'a SUCCESS on the FIRST poll answers 200');
assert.deepEqual(firstPoll.response.body, { format: 'mp4', video: VIDEO_BYTES.toString('base64') },
    'the video is base64 of the fetched content, with the hardcoded mp4 format');
assert.equal(firstPoll.outbound.length, 3, 'submit, one poll, one content fetch');
assert.equal(requireOutbound('zaiVideoCompletedFirstPoll', 1).url, `${ZAI}/api/paas/v4/async-result/${JOB_ID}`,
    'the poll URL is the literal base plus data.id');
assert.equal(requireOutbound('zaiVideoCompletedFirstPoll', 1).method, 'GET', 'the poll is a GET');
assert.equal(requireOutbound('zaiVideoCompletedFirstPoll', 1).headers.authorization, `Bearer ${KEY}`,
    'the poll carries the bearer key');
assert.equal(requireOutbound('zaiVideoCompletedFirstPoll', 2).url, VIDEO_URL, 'then the provider content URL is fetched');
assert.equal(requireOutbound('zaiVideoCompletedFirstPoll', 2).headers.authorization, undefined,
    'the CONTENT fetch is a bare fetch(url): no headers at all');

assert.equal(scenarios.zaiVideoCompletedSecondPoll.outbound.length, 4, 'a non-terminal status makes the loop poll TWICE');
assert.equal(requireOutbound('zaiVideoCompletedSecondPoll', 1).url, requireOutbound('zaiVideoCompletedSecondPoll', 2).url,
    'both polls go to the same URL, so only the COUNT differs');
assert.equal(scenarios.zaiVideoCompletedFirstPoll.elapsedBucket, 'one-poll', 'one poll waits 5000ms');
assert.equal(scenarios.zaiVideoCompletedSecondPoll.elapsedBucket, 'two-polls', 'two polls wait 5000ms then 6000ms');
assert.equal(scenarios.zaiVideoTaskFail.response.status, 500, 'a FAIL status is a 500');
assert.equal(scenarios.zaiVideoTaskFail.response.bodyText, 'Video generation failed', 'with that exact text');
assert.equal(scenarios.zaiVideoTaskFail.outbound.length, 2, 'and no content fetch');
assert.equal(scenarios.zaiVideoPollNonOk.response.status, 500, 'a non-ok poll is a 500');
assert.equal(scenarios.zaiVideoPollNonOk.response.bodyText, 'poll exploded', 'which forwards the provider TEXT');
assert.equal(scenarios.zaiVideoNoURL.response.status, 500, 'SUCCESS without video_result[0].url is a 500');
assert.equal(scenarios.zaiVideoNoURL.response.bodyText, 'Internal Server Error', 'a bare status message');
assert.equal(scenarios.zaiVideoNoURL.outbound.length, 2, 'and no content fetch');
assert.equal(scenarios.zaiVideoContentNonOk.response.status, 500, 'a non-ok content fetch is a 500');
assert.equal(scenarios.zaiVideoContentNonOk.response.bodyText, 'content exploded', 'which forwards the provider TEXT');
assert.equal(requireOutbound('zaiVideoReservedId', 1).url, `${ZAI}/api/paas/v4/async-result/${RESERVED_JOB_ID}`,
    'a reserved-character job id is interpolated RAW into the poll path (rule 15)');
assert.equal(requireOutbound('zaiVideoNoId', 1).url, `${ZAI}/api/paas/v4/async-result/undefined`,
    'an answer without id interpolates the string "undefined"');

const sha256 = value => createHash('sha256').update(value).digest('hex');

const fixture = {
    schemaVersion: 1,
    baseline: { version: PINNED_VERSION, commit: PINNED_COMMIT },
    probe: 'tools/probe-sd-zai.mjs',
    waves: { 6: ['/api/sd/zai/generate', '/api/sd/zai/generate-video'] },
    implementedRoutes: ['/api/sd/zai/generate', '/api/sd/zai/generate-video'],
    notImplementedRoutes: [],
    pinnedSource: {
        'src/endpoints/stable-diffusion.js:1880': 'zai image: POST https://api.z.ai/api/paas/v4/images/generations with prompt/model/quality/size, then a hostname guard (.z.ai or .ufileos.com via endsWith) and up to 5 fetches of the provider URL, retrying only on 404 after delay(1000); format from path.extname of the URL path',
        'src/endpoints/stable-diffusion.js:1957': 'zai video: POST .../videos/generations with prompt/model/quality/size/aspect_ratio, then up to 30 polls of .../async-result/<id> after delay(5000 + attempt*1000), FAIL and non-ok polls forward text, SUCCESS without a valid video_result url is a bare 500, and the content fetch has NO hostname guard',
    },
    mechanism: 'Both upstreams are hardcoded literals, so the probe replaces the `node-fetch` module and the global `fetch` with a controlled peer; the Go side uses its own seams for the two bases and replays the recorded rules through a real local listener, rewriting the video content URL onto it.',
    fields: [
        { path: 'scenarios.*.response.status', comparison: 'compared', reason: 'the pinned handlers choose 200/400/500 themselves' },
        { path: 'scenarios.*.response.headers', comparison: 'compared', reason: 'a string body is html-typed, the JSON answers json-typed' },
        { path: 'scenarios.*.response.body/bodyText', comparison: 'compared', reason: 'the projection, the forwarded provider text, and the hardcoded messages' },
        { path: 'scenarios.*.outbound[].url', comparison: 'compared', reason: 'the two hardcoded POST targets plus the poll built from data.id (raw interpolation) and the provider content URL, compared as path+query' },
        { path: 'scenarios.*.outbound[].body', comparison: 'compared', reason: 'JSON member order of the two projections' },
        { path: 'scenarios.*.outbound[].headers', comparison: 'compared', reason: 'the declared provider headers, asserted in BOTH directions (Bearer on submit and poll, NOTHING on the content fetch)' },
        { path: 'scenarios.*.outbound[].count', comparison: 'compared', reason: 'the REFUSAL is a count: an image URL outside the allowlist must not produce a second request, and the video poll count is fixture data' },
        { path: 'scenarios.*.elapsedBucket', comparison: 'recorded-not-replayed', reason: 'a three-way bucket (under 4s / one poll / two polls). A duration is host-derived; the bucket proves the escalation happened. The Go replay collapses the delays through a test seam; separate Go tests pin 5000ms+1000ms*attempt, the 30 attempts and the 1000ms 404 retry.' },
        { path: 'scenarios.*.mocks', comparison: 'recorded-not-compared', reason: 'the timed rule list the peer served, so a scenario can be re-driven from the fixture' },
        { path: 'scenarios.*.secrets', comparison: 'recorded-not-compared', reason: 'the secrets file the probe wrote' },
    ],
    normalizations: [
        'Synthetic credentials and synthetic video bytes only.',
        'The provider content host is synthetic (media.example.test), so no recording can be mistaken for live provider data.',
        'No seeds or timestamps are recorded: neither projection carries a random member.',
    ],
    inputs: { videoSha256: sha256(VIDEO_BYTES), key: KEY },
    notCovered: {
        'zai image success path': 'The route guards the provider URL with a hostname allowlist (.z.ai / .ufileos.com) and then fetches it AS GIVEN. The pinned side could answer a .z.ai URL from the controlled peer, but the GO replay cannot: the guard is evaluated by the implementation, and no local listener can answer to a .z.ai name. Recording it would put a scenario in the fixture that the Go replay can never drive, so only the refusal and error branches are recorded, each asserting the exact request count.',
        'zai image 404 retry': 'The retry loop (5 attempts, delay(1000) between 404s, format from path.extname) is unreachable for the same reason: it needs a .z.ai URL. The retry cadence and the extname mapping are covered by LABELLED Go implementation tests instead of a fixture.',
        'zai video exhaustion': 'Thirty polls with delay(5000 + attempt*1000) is 591 seconds of wall clock, so the branch is NOT recorded and the probe does not shorten the pinned delay. A LABELLED Go implementation test asserts 30 polls and the bare 500.',
        'zai video unknown task_status': 'Any status other than FAIL/SUCCESS keeps polling to exhaustion, the same 591 seconds; not recorded. The Go loop continues, which is the pinned behaviour read from the source.',
        'zai video client disconnect': 'The abort answers "Video generation aborted by client" at the top of each iteration; the disconnect cannot be produced reliably through the probe. A LABELLED Go implementation test asserts the message and that no poll follows the disconnect.',
    },
    bootOutbound,
    scenarios,
};

const outputFile = writeFixture(repositoryRoot, 'sillytavern-1.19.0-sd-zai.json', fixture);
console.log(`scenarios: ${Object.keys(scenarios).length}, boot outbound: ${bootOutbound.length}`);
console.log(`fixture written to ${outputFile}`);
