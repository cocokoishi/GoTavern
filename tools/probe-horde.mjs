#!/usr/bin/env node
// @gotavern-oracle: fixture=sillytavern-1.19.0-horde.json label="horde"
// Probe the pinned /api/horde/* generation, polling and cancellation surface against the REAL pinned
// server with its `node-fetch` replaced by a controlled peer (tools/lib/pinned-outbound.mjs).
//
// WHY THE HOOK. `https://aihorde.net` is hardcoded in the pinned source, and four of these routes go
// through `@zeldafan0225/ai_horde` (5.2.0), whose request shape lives in the package rather than in
// `src/endpoints/horde.js`. The hook leaves the pinned code unmodified and records what it actually
// sends, which is the only way to pin the SDK-built bodies.
//
// POLLING WITHOUT WALL-CLOCK FRAGILITY. `caption-image` and `generate-image` sleep 3000 ms before each
// status check and poll up to 200 times. The probe never waits for a timeout to decide an outcome: the
// controlled peer answers with an explicit sequence (`times` in a rule), so the number of polls is a
// property of the fixture, and every scenario terminates in at most three polls. What is NOT recorded
// is the interval itself (it is asserted separately in the Go test as a constant).
//
// The image cancel path is a CLIENT DISCONNECT: the pinned handler aborts its controller and sends
// DELETE /generate/status/{id}. That is exercised here by aborting the request from the client and
// then reading the recorded outbound traffic.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import {
    PINNED_COMMIT, PINNED_VERSION, captureHttp, startPinnedProviderServer, writeFixture,
} from './lib/pinned-outbound.mjs';

const sourceRoot = path.resolve(process.argv[2] ?? '');
const repositoryRoot = path.resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3]) {
    console.error('usage: node tools/probe-horde.mjs <pinned-source-clone> <gotavern-root>');
    process.exit(2);
}
if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim() !== PINNED_COMMIT) {
    throw new Error(`upstream checkout is not pinned at ${PINNED_COMMIT}`);
}

const API = 'https://aihorde.net';
const HORDE_KEY = 'synthetic-horde-key';
const ANONYMOUS_KEY = '0000000000';
const IMAGE_PROMPT = 'https://img.test/generated.png';
const CAPTION = 'a cat sitting on a mat';

function secretEntry(key, value) {
    return { [key]: [{ id: `sid-${key}`, value, label: key, active: true }] };
}

// A rule list for one scenario. `times` limits how often a rule answers, so a poll sequence can be
// expressed without the probe changing the mock between calls; `run` keeps the counters per scenario.
const SDK_HEADERS = { 'content-type': 'application/json' };

const SCENARIOS = [
    // ── static and model list ───────────────────────────────────────────────────────────────────
    { label: 'sdSamplers', route: '/api/horde/sd-samplers', body: '{}' },
    { label: 'sdModelsOk', route: '/api/horde/sd-models', body: '{}',
      mocks: [{ match: '/status/models', body: { 'stable_diffusion': [{ name: 'model-a' }] } }] },
    { label: 'sdModelsNonOk', route: '/api/horde/sd-models', body: '{}',
      mocks: [{ match: '/status/models', status: 500, body: { message: 'horde down' } }] },
    { label: 'sdModelsThrows', route: '/api/horde/sd-models', body: '{}', mocks: [{ match: '/status/models', throws: true }] },

    // ── user-info ───────────────────────────────────────────────────────────────────────────────
    { label: 'userInfoNoKey', route: '/api/horde/user-info', body: '{}', secrets: {} },
    { label: 'userInfoOk', route: '/api/horde/user-info', body: '{}', secrets: secretEntry('api_key_horde', HORDE_KEY),
      mocks: [{ match: '/sharedkeys/', body: { kudos: 100 } }, { match: '/find_user', body: { username: 'probe-user', id: 7 } }] },
    { label: 'userInfoSharedKeyFails', route: '/api/horde/user-info', body: '{}', secrets: secretEntry('api_key_horde', HORDE_KEY),
      mocks: [{ match: '/sharedkeys/', status: 404, body: { message: 'no such shared key' } }, { match: '/find_user', body: { username: 'probe-user' } }] },
    { label: 'userInfoFindFails', route: '/api/horde/user-info', body: '{}', secrets: secretEntry('api_key_horde', HORDE_KEY),
      mocks: [{ match: '/sharedkeys/', body: { kudos: 1 } }, { match: '/find_user', status: 401, body: { message: 'bad key' } }] },

    // ── cancel-task / task-status (the cancellation surface) ────────────────────────────────────
    { label: 'cancelTaskOk', route: '/api/horde/cancel-task', body: '{"taskId":"task-1"}',
      mocks: [{ match: '/generate/text/status/task-1', body: { message: 'Cancelled' } }] },
    { label: 'cancelTaskNonJson', route: '/api/horde/cancel-task', body: '{"taskId":"task-2"}',
      mocks: [{ match: '/generate/text/status/task-2', raw: 'nope' }] },
    { label: 'taskStatusOk', route: '/api/horde/task-status', body: '{"taskId":"task-1"}',
      mocks: [{ match: '/generate/text/status/task-1', body: { done: true, generations: [{ text: 'hello' }] } }] },
    { label: 'taskStatusErrorBody', route: '/api/horde/task-status', body: '{"taskId":"task-3"}',
      mocks: [{ match: '/generate/text/status/task-3', status: 500, body: { message: 'boom' } }] },

    // ── generate-text: async submit, no server-side streaming ───────────────────────────────────
    { label: 'generateTextOk', route: '/api/horde/generate-text', body: '{"prompt":"hello","params":{"max_length":50}}',
      secrets: secretEntry('api_key_horde', HORDE_KEY), mocks: [{ match: '/generate/text/async', body: { id: 'task-9', kudos: 5 } }] },
    { label: 'generateTextNoKey', route: '/api/horde/generate-text', body: '{"prompt":"hello"}',
      secrets: {}, mocks: [{ match: '/generate/text/async', body: { id: 'task-9' } }] },
    { label: 'generateTextNonOk', route: '/api/horde/generate-text', body: '{"prompt":"hello"}',
      secrets: secretEntry('api_key_horde', HORDE_KEY), mocks: [{ match: '/generate/text/async', status: 400, raw: 'bad prompt' }] },
    { label: 'generateTextThrows', route: '/api/horde/generate-text', body: '{"prompt":"hello"}',
      secrets: secretEntry('api_key_horde', HORDE_KEY), mocks: [{ match: '/generate/text/async', throws: true }] },
    // The submitted body is re-serialized by JSON.stringify, so non-canonical text must be normalized.
    { label: 'generateTextReserialized', route: '/api/horde/generate-text', body: '{"prompt":"hello","params":{ "max_length" : 50 , "temperature" : 0.70 }}',
      secrets: secretEntry('api_key_horde', HORDE_KEY), mocks: [{ match: '/generate/text/async', body: { id: 'task-9' } }] },

    // ── caption-image: async submit + polled status ─────────────────────────────────────────────
    { label: 'captionOk', route: '/api/horde/caption-image', body: '{"image":"data:image/png;base64,AAAA"}',
      secrets: secretEntry('api_key_horde', HORDE_KEY),
      mocks: [
          { match: '/interrogate/async', body: { id: 'inter-1' } },
          { match: '/interrogate/status/', times: 2, body: { state: 'waiting' } },
          { match: '/interrogate/status/', body: { state: 'done', forms: [{ form: 'caption', result: { caption: CAPTION } }] } },
      ] },
    { label: 'captionFaulted', route: '/api/horde/caption-image', body: '{"image":"data:image/png;base64,AAAA"}',
      secrets: secretEntry('api_key_horde', HORDE_KEY),
      mocks: [{ match: '/interrogate/async', body: { id: 'inter-2' } }, { match: '/interrogate/status/', body: { state: 'faulted' } }] },
    { label: 'captionCancelled', route: '/api/horde/caption-image', body: '{"image":"data:image/png;base64,AAAA"}',
      secrets: secretEntry('api_key_horde', HORDE_KEY),
      mocks: [{ match: '/interrogate/async', body: { id: 'inter-3' } }, { match: '/interrogate/status/', body: { state: 'cancelled' } }] },
    { label: 'captionNoCaption', route: '/api/horde/caption-image', body: '{"image":"data:image/png;base64,AAAA"}',
      secrets: secretEntry('api_key_horde', HORDE_KEY),
      mocks: [{ match: '/interrogate/async', body: { id: 'inter-4' } }, { match: '/interrogate/status/', body: { state: 'done', forms: [{}] } }] },
    { label: 'captionNoForms', route: '/api/horde/caption-image', body: '{"image":"data:image/png;base64,AAAA"}',
      secrets: secretEntry('api_key_horde', HORDE_KEY),
      mocks: [{ match: '/interrogate/async', body: { id: 'inter-5' } }, { match: '/interrogate/status/', body: { state: 'done' } }] },
    { label: 'captionNoId', route: '/api/horde/caption-image', body: '{"image":"data:image/png;base64,AAAA"}',
      secrets: secretEntry('api_key_horde', HORDE_KEY),
      mocks: [{ match: '/interrogate/async', body: { message: 'cannot interrogate' } }] },
    { label: 'captionAsyncThrows', route: '/api/horde/caption-image', body: '{"image":"data:image/png;base64,AAAA"}',
      secrets: secretEntry('api_key_horde', HORDE_KEY), mocks: [{ match: '/interrogate/async', throws: true }] },

    // ── generate-image: sanitize/truncate, polled check+status, faulted, client abort ───────────
    { label: 'imageNoPrompt', route: '/api/horde/generate-image', body: '{}' },
    { label: 'imageNoId', route: '/api/horde/generate-image', body: '{"prompt":"a tree"}',
      secrets: secretEntry('api_key_horde', HORDE_KEY), mocks: [{ match: '/generate/async', body: { message: 'not possible' } }] },
    { label: 'imageOk', route: '/api/horde/generate-image', body: JSON.stringify({ prompt: 'a tree', negative_prompt: 'ugly', model: 'model-a', sampler: 'k_euler', steps: 20, width: 512, height: 512, scale: 7.5, seed: 42, karras: false, enable_hr: false, restore_faces: false, clip_skip: 2, nfsw: false }),
      secrets: secretEntry('api_key_horde', HORDE_KEY),
      mocks: [
          { match: '/generate/async', body: { id: 'gen-1', kudos: 10 } },
          { match: '/generate/check/', times: 1, body: { done: false, waiting: 1 } },
          { match: '/generate/check/', body: { done: true } },
          { match: '/generate/status/', body: { generations: [{ img: IMAGE_PROMPT }] } },
      ] },
    { label: 'imageFaulted', route: '/api/horde/generate-image', body: '{"prompt":"a tree"}',
      secrets: secretEntry('api_key_horde', HORDE_KEY),
      mocks: [{ match: '/generate/async', body: { id: 'gen-2' } }, { match: '/generate/check/', body: { faulted: true } }, { match: '/generate/status/', body: {} }] },
    { label: 'imageNoGenerations', route: '/api/horde/generate-image', body: '{"prompt":"a tree"}',
      secrets: secretEntry('api_key_horde', HORDE_KEY),
      mocks: [
          { match: '/generate/async', body: { id: 'gen-3' } },
          { match: '/generate/check/', body: { done: true } },
          { match: '/generate/status/', body: { message: 'no generations' } },
      ] },
    // Sanitization and truncation are visible only in the async submit body, before any polling, so each
    // gets a scenario whose prompt is short enough (sanitize) or long enough (truncate) to be observable.
    { label: 'imageSanitized', route: '/api/horde/generate-image', body: JSON.stringify({ prompt: 'a young girl and a boy', negative_prompt: 'ugly', sanitize: true, model: 'model-a' }),
      secrets: secretEntry('api_key_horde', HORDE_KEY),
      mocks: [{ match: '/generate/async', body: { id: 'gen-4' } }, { match: '/generate/check/', body: { faulted: true } }, { match: '/generate/status/', body: {} }] },
    { label: 'imageTruncated', route: '/api/horde/generate-image', body: JSON.stringify({ prompt: 'x'.repeat(6000), negative_prompt: 'ugly', model: 'model-a' }),
      secrets: secretEntry('api_key_horde', HORDE_KEY),
      mocks: [{ match: '/generate/async', body: { id: 'gen-5' } }, { match: '/generate/check/', body: { faulted: true } }, { match: '/generate/status/', body: {} }] },
];

const server = await startPinnedProviderServer({ sourceRoot, prefix: 'gotavern-horde-oracle-', mocks: [] });
const scenarios = {};
let bootOutbound = [];
try {
    bootOutbound = server.bootOutbound;
    for (const scenario of SCENARIOS) {
        server.writeSecrets(scenario.secrets ?? {});
        const rules = (scenario.mocks ?? []).map(rule => ({
            run: scenario.label,
            match: `${API}/api/v2${rule.match}`,
            status: rule.status ?? 200,
            statusText: rule.statusText ?? 'OK',
            headers: SDK_HEADERS,
            body: rule.raw ?? JSON.stringify(rule.body ?? {}),
            throws: rule.throws === true,
            ...(rule.times === undefined ? {} : { times: rule.times }),
        }));
        if (process.env.GOTAVERN_HORDE_DEBUG) console.log('STEP', scenario.label);
        server.setMocks(rules);
        const before = server.outbound();
        void before;
        const result = await server.post(scenario.route, scenario.body);
        // The pinned image handler fires an un-awaited DELETE on socket close, which arrives AFTER
        // the response and therefore inside the NEXT scenario. That traffic belongs to the abort
        // scenario only; elsewhere it is dropped so a scenario records only its own calls.
        const requests = server.outbound().filter(request => !(request.method === 'DELETE' && request.url.includes('/generate/status/')));
        scenarios[scenario.label] = {
            route: scenario.route,
            requestBody: scenario.body,
            mocks: rules,
            secrets: server.readSecrets(),
            response: captureHttp(result),
            outbound: requests.map(request => ({
                url: request.url,
                method: request.method,
                headers: request.headers,
                body: request.body,
            })),
        };
    }

    // NOT PROBED: the image generation cancel-on-client-disconnect path. The pinned handler registers
    // `request.socket.on('close', ...)` and then aborts and DELETEs, but this probe could not make the
    // pinned server observe a disconnect: with a fetch abort the connection pool keeps the socket
    // alive, and even a raw socket destroyed mid-request produced no socket close inside the pinned
    // process within a four-second window. It is implemented from the source and reported as NOT
    // differentially verified rather than recorded as if it were.
} catch (error) {
    console.error('PROBE FAILED; pinned server log tail:');
    console.error(server.logs.join('').slice(-8000));
    throw error;
} finally {
    await server.stop();
}

// ── assertions: every recorded observation must be the measured one ─────────────────────────────
assert.deepEqual(scenarios.sdSamplers.response.body, [
    'lcm', 'k_lms', 'k_heun', 'k_euler_a', 'k_euler', 'k_dpm_2', 'k_dpm_2_a', 'DDIM', 'PLMS',
    'k_dpm_fast', 'k_dpm_adaptive', 'k_dpmpp_2s_a', 'k_dpmpp_2m', 'dpmsolver', 'k_dpmpp_sde',
], 'sd-samplers answers the SDK enum values in declaration order');
assert.equal(scenarios.sdSamplers.outbound.length, 0, 'sd-samplers makes no request');
assert.deepEqual(scenarios.sdModelsOk.response.body, { stable_diffusion: [{ name: 'model-a' }] }, 'sd-models passes the list through');
assert.equal(requireOutbound('sdModelsOk', 0).url, `${API}/api/v2/status/models`, 'sd-models URL');
assert.equal(requireOutbound('sdModelsOk', 0).headers['content-type'], 'application/json', 'the SDK sends Content-Type even on GET');
assert.equal(requireOutbound('sdModelsOk', 0).headers.apikey, undefined, 'getModels sends no apikey');
assert.equal(scenarios.sdModelsNonOk.response.status, 500, 'a non-2xx SDK answer throws and answers 500');
assert.equal(scenarios.sdModelsThrows.response.status, 500, 'a rejected SDK fetch answers 500');

assert.deepEqual(scenarios.userInfoNoKey.response.body, { anonymous: true }, 'no key means anonymous');
assert.equal(scenarios.userInfoNoKey.outbound.length, 0, 'no key means no request');
assert.deepEqual(scenarios.userInfoOk.response.body, { user: { username: 'probe-user', id: 7 }, sharedKey: { kudos: 100 }, anonymous: false }, 'user-info composes user and sharedKey');
assert.equal(requireOutbound('userInfoOk', 0).url, `${API}/api/v2/sharedkeys/${HORDE_KEY}`, 'the shared key path carries the raw key');
assert.equal(requireOutbound('userInfoOk', 0).headers.apikey, undefined, 'getSharedKey passes no token');
assert.equal(requireOutbound('userInfoOk', 1).headers.apikey, HORDE_KEY, 'findUser passes the token as apikey');
assert.deepEqual(scenarios.userInfoSharedKeyFails.response.body, { user: { username: 'probe-user' }, sharedKey: null, anonymous: false }, 'a failed shared key is null, not an error');
assert.equal(scenarios.userInfoFindFails.response.status, 500, 'a failed findUser is a 500');

assert.equal(requireOutbound('cancelTaskOk', 0).method, 'DELETE', 'cancel-task DELETEs the text status');
assert.equal(requireOutbound('cancelTaskOk', 0).url, `${API}/api/v2/generate/text/status/task-1`, 'cancel-task URL');
assert.equal(requireOutbound('cancelTaskOk', 0).headers.apikey, undefined, 'cancel-task sends no apikey');
assert.deepEqual(scenarios.cancelTaskOk.response.body, { message: 'Cancelled' }, 'cancel-task passes the answer through');
assert.equal(scenarios.cancelTaskNonJson.response.status, 500, 'a body that is not JSON makes cancel-task throw');
assert.equal(requireOutbound('taskStatusOk', 0).method, 'GET', 'task-status GETs the same resource');
assert.deepEqual(scenarios.taskStatusOk.response.body, { done: true, generations: [{ text: 'hello' }] }, 'task-status passes the answer through');
assert.deepEqual(scenarios.taskStatusErrorBody.response.body, { message: 'boom' }, 'task-status has NO ok guard, so an error body is returned as-is');
assert.equal(scenarios.taskStatusErrorBody.response.status, 200, 'the error body is answered with 200');

assert.deepEqual(scenarios.generateTextOk.response.body, { id: 'task-9', kudos: 5 }, 'generate-text answers the async submission');
assert.equal(requireOutbound('generateTextOk', 0).method, 'POST', 'generate-text POSTs');
assert.equal(requireOutbound('generateTextOk', 0).url, `${API}/api/v2/generate/text/async`, 'generate-text URL');
assert.equal(requireOutbound('generateTextOk', 0).headers.apikey, HORDE_KEY, 'a configured key travels as apikey');
assert.equal(requireOutbound('generateTextNoKey', 0).headers.apikey, ANONYMOUS_KEY, 'a missing key falls back to the anonymous key');
assert.equal(requireOutbound('generateTextOk', 0).headers['client-agent'].startsWith('SillyTavern:'), true, 'Client-Agent comes from /version');
assert.deepEqual(scenarios.generateTextNonOk.response.body, { error: { message: 'bad prompt' } }, 'a non-ok submission answers {error:{message}}');
assert.equal(scenarios.generateTextNonOk.response.status, 200, 'that error shape is answered with 200');
assert.deepEqual(scenarios.generateTextThrows.response.body, { error: true }, 'a rejected fetch answers {error:true}');
assert.equal(requireOutbound('generateTextReserialized', 0).body, '{"prompt":"hello","params":{"max_length":50,"temperature":0.7}}',
    'the submitted body is re-serialized (whitespace and 0.70 normalized)');

assert.deepEqual(scenarios.captionOk.response.body, { caption: CAPTION }, 'caption-image answers {caption}');
assert.equal(requireOutbound('captionOk', 0).method, 'POST', 'caption-image submits asynchronously');
assert.equal(requireOutbound('captionOk', 0).url, `${API}/api/v2/interrogate/async`, 'the interrogation submit URL');
assert.equal(requireOutbound('captionOk', 0).headers.apikey, HORDE_KEY, 'the interrogation submit carries apikey');
assert.equal(requireOutbound('captionOk', 0).body, '{"source_image":"data:image/png;base64,AAAA","forms":[{"name":"caption"}]}',
    'the interrogation body is the SDK-built pair');
assert.equal(scenarios.captionOk.outbound.filter(request => request.url.includes('/interrogate/status/')).length, 3,
    'the status was polled three times');
assert.equal(requireOutbound('captionOk', 1).headers.apikey, undefined, 'the status poll carries no apikey');
assert.equal(scenarios.captionFaulted.response.status, 503, 'a faulted interrogation answers 503');
assert.equal(scenarios.captionCancelled.response.status, 503, 'a cancelled interrogation answers 503');
assert.equal(scenarios.captionNoCaption.response.status, 500, 'a done interrogation without a caption answers 500');
assert.equal(scenarios.captionNoForms.response.status, 500, 'a done interrogation without forms answers 500');
assert.equal(scenarios.captionNoId.response.status, 400, 'an unsatisfiable interrogation answers 400');
assert.equal(scenarios.captionAsyncThrows.response.status, 500, 'a rejected submit answers 500');

assert.equal(scenarios.imageNoPrompt.response.status, 400, 'generate-image requires a prompt');
assert.equal(scenarios.imageNoPrompt.outbound.length, 0, 'a missing prompt reaches no peer');
assert.equal(scenarios.imageNoId.response.status, 400, 'an unsatisfiable image request answers 400');
assert.equal(scenarios.imageOk.response.status, 200, 'generate-image answers 200');
assert.equal(scenarios.imageOk.response.bodyText, IMAGE_PROMPT, 'the image URL is answered as a plain string');
assert.equal(scenarios.imageOk.response.headers['content-type'], 'text/html; charset=utf-8', 'a string body is typed html by Express');
assert.equal(requireOutbound('imageOk', 0).body, '{"prompt":"a tree ### ugly","params":{"sampler_name":"k_euler","hires_fix":false,"use_gfpgan":false,"cfg_scale":7.5,"steps":20,"width":512,"height":512,"karras":false,"clip_skip":2,"seed":"42","n":1},"r2":false,"nsfw":false,"models":["model-a"]}',
    'the async image body is the SDK-built shape with the prompt joined to the negative prompt');
assert.equal(scenarios.imageOk.outbound.filter(request => request.method === 'GET' && request.url.includes('/generate/check/')).length, 2, 'the check was polled twice');
assert.equal(scenarios.imageOk.outbound.filter(request => request.method === 'GET' && request.url.includes('/generate/status/')).length, 1, 'the status was fetched once');
assert.equal(scenarios.imageFaulted.response.status, 500, 'a faulted generation answers 500');
assert.equal(scenarios.imageNoGenerations.response.status, 500, 'a status without generations answers 500');
const sanitizedBody = JSON.parse(requireOutbound('imageSanitized', 0).body);
assert.equal(sanitizedBody.prompt.includes('woman'), true, 'sanitize rewrites girl to woman');
assert.equal(sanitizedBody.prompt.includes(' man'), true, 'sanitize rewrites boy to man');
assert.equal(sanitizedBody.prompt.includes('girl'), false, 'the original word is gone');
assert.equal(sanitizedBody.prompt.includes('young'), false, 'the risky adjective is removed');
assert.equal(sanitizedBody.prompt.endsWith(' ### ugly'), true, 'the negative prompt is appended');
const truncatedBody = JSON.parse(requireOutbound('imageTruncated', 0).body);
// maxLength = 5000 - String('ugly').length - 5 = 4991, then the prompt is joined with ' ### ugly'.
assert.equal(truncatedBody.prompt, 'x'.repeat(4991) + ' ### ugly', 'the prompt is truncated to the pinned threshold');
const abortScenario = scenarios.imageClientAbort;
if (process.env.GOTAVERN_HORDE_DEBUG) 
assert.equal(abortScenario.outbound.some(request => request.method === 'DELETE' && request.url === `${API}/api/v2/generate/status/gen-abort`), true,
    'a client disconnect DELETEs the generation request');

const fixture = {
    schemaVersion: 1,
    baseline: { version: PINNED_VERSION, commit: PINNED_COMMIT },
    probe: 'tools/probe-horde.mjs',
    pinnedSource: {
        'src/endpoints/horde.js:144': 'cancel-task: DELETE /generate/text/status/{taskId}',
        'src/endpoints/horde.js:164': 'task-status: GET the same resource, no ok guard',
        'src/endpoints/horde.js:183': 'generate-text: POST /generate/text/async with the re-serialized body and apikey',
        'src/endpoints/horde.js:214': 'sd-samplers: Object.values(ModelGenerationInputStableSamplers), no request',
        'src/endpoints/horde.js:224': 'sd-models: SDK getModels() -> GET /status/models',
        'src/endpoints/horde.js:235': 'caption-image: SDK postAsyncInterrogate then polled getInterrogationStatus, 200 attempts x 3000ms',
        'src/endpoints/horde.js:285': 'user-info: getSharedKey + findUser, anonymous short-circuit',
        'src/endpoints/horde.js:309': 'generate-image: sanitize/truncate, SDK postAsyncImageGenerate, polled check+status, client-abort DELETE, 504 after 200 attempts',
        'node_modules/@zeldafan0225/ai_horde/index.js': 'SDK 5.2.0: base https://aihorde.net/api/v2, headers Client-Agent + Content-Type: application/json, apikey only when a token option is passed, non-2xx throws APIError',
    },
    mechanism: 'The pinned server runs unmodified; only its node-fetch module is replaced by a controlled peer, because https://aihorde.net is hardcoded and four routes go through the AI Horde SDK. Poll sequences are expressed as timed rules in the peer, so no scenario depends on a wall-clock timeout.',
    fields: [
        { path: 'scenarios.*.response.status', comparison: 'compared', reason: 'the pinned handlers choose 200/400/500/503 themselves' },
        { path: 'scenarios.*.response.headers', comparison: 'compared', reason: 'Express and the pinned middleware stack set them, including the html type for a string body' },
        { path: 'scenarios.*.response.body/bodyText', comparison: 'compared', reason: 'the projection is endpoint behaviour, including the {error:{message}} shape at status 200' },
        { path: 'scenarios.*.outbound[].url/method', comparison: 'compared', reason: 'the constructed URL, including the raw key and task id in the path' },
        { path: 'scenarios.*.outbound[].body', comparison: 'compared', reason: 'the SDK-built or re-serialized body, where member order and undefined omission are behaviour' },
        { path: 'scenarios.*.outbound[].headers.client-agent', comparison: 'compared', reason: 'taken from /version and therefore a value that can drift' },
        { path: 'scenarios.*.outbound[].headers.apikey', comparison: 'compared', reason: 'present only when the pinned call passes a token, and the anonymous fallback is a literal' },
        { path: 'scenarios.*.outbound[].headers.content-type', comparison: 'compared', reason: 'the SDK sends JSON on GET as well' },
        { path: 'poll counts', comparison: 'compared', reason: 'the number of status/check requests is a property of the controlled sequence' },
        { path: 'live list content', comparison: 'shape', reason: 'sd-models content is third-party data: the fixture supplies a controlled payload and asserts the passthrough' },
        { path: 'poll interval', comparison: 'shape', reason: 'the 3000ms cadence is not recorded (wall-clock does not cross the boundary); it is asserted as a constant in the Go test' },
        { path: '200-attempt fall-through', comparison: 'shape', reason: 'reaching it would take ten minutes, so it is unprobed; the Go deviation is named in the compat row' },
    ],
    normalizations: [
        'Polling terminates by an explicit rule sequence (`times`), never by a timeout, so the recorded poll counts do not depend on machine speed.',
        'sd-models content is supplied by the controlled peer; nothing about the live Horde list is recorded as a constant.',
        'Synthetic credentials only.',
        'The image cancel-on-client-disconnect path is NOT probed (see the comment in the probe body); the fixture records it as unprobed instead of pretending to compare it.',
        'Stray DELETE /generate/status calls, which the pinned handler fires un-awaited on socket close after a response, are excluded from a scenario recording so a scenario holds only its own calls. They belong to the route, but the pinned timing puts them outside the request that caused them.',
    ],
    inputs: { api: API, hordeKey: HORDE_KEY, anonymousKey: ANONYMOUS_KEY, image: IMAGE_PROMPT, caption: CAPTION, sdkVersion: '5.2.0' },
    bootOutbound,
    scenarios,
};

const outputFile = writeFixture(repositoryRoot, 'sillytavern-1.19.0-horde.json', fixture);
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