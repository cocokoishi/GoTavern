#!/usr/bin/env node
// @gotavern-oracle: fixture=sillytavern-1.19.0-openai-caption.json label="openai caption"
// Probe `/api/openai/caption-image` (openai.js:16) â€” COMMIT 1 of wave D: the BRANCH DISPATCH.
//
// THE TABLE IS THE WORK. The pinned handler selects on `request.body.api` with NINETEEN distinct values,
// each changing the secret, the URL and sometimes the body. Four of them (ooba, koboldcpp, llamacpp, vllm)
// share the local fallback, so a "distinct URL" count would be 15 and would silently tolerate four missing
// branches; the count is therefore over the 19 BRANCH VALUES. `reverse_proxy` is a MODIFIER rather than a
// branch and gets its own scenario, or a missing modifier would be invisible too.
//
// SINGLE SOURCE OF TRUTH: the table below is written into the fixture as `branches`, and the Go test asserts
// its OWN dispatch table equals it (same values, same distinctness). Two copies that are merely both
// present can drift while both count assertions pass, which is the failure this makes impossible.
//
// The `pollinations` branch adds a RANDOMIZED seed. That is rule 18 with a THIRD source of instability
// (after host-derived and race-derived): it cannot be byte-stable, so it is classified `shape` with the
// randomization named and NO VALUE recorded. The pinned code offers no seam, so it is not-observed rather
// than pinned to whichever value a run produced.
//
// Commit 2 covers the `custom_include_body`/`custom_include_headers` merges (user-controlled, merged into the
// outbound request) and the per-branch role rewrites.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';

import { PINNED_COMMIT, PINNED_VERSION, captureHttp, startPinnedProviderServer, writeFixture } from './lib/pinned-outbound.mjs';

const sourceRoot = path.resolve(process.argv[2] ?? '');
const repositoryRoot = path.resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3]) {
    console.error('usage: node tools/probe-openai-caption.mjs <pinned-source-clone> <gotavern-root>');
    process.exit(2);
}
if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim() !== PINNED_COMMIT) {
    throw new Error(`upstream checkout is not pinned at ${PINNED_COMMIT}`);
}

// api, secret, URL. The four local-backend branches share the fallback and are still four entries, because
// the SECRET and the api VALUE differ.
const BRANCHES = [
    { api: 'openai', secret: 'api_key_openai', url: 'https://api.openai.com/v1/chat/completions' },
    { api: 'xai', secret: 'api_key_xai', url: 'https://api.x.ai/v1/chat/completions' },
    { api: 'mistral', secret: 'api_key_mistralai', url: 'https://api.mistral.ai/v1/chat/completions' },
    { api: 'custom', secret: 'api_key_custom', url: 'https://local.example.test/chat/completions' },
    { api: 'openrouter', secret: 'api_key_openrouter', url: 'https://openrouter.ai/api/v1/chat/completions' },
    { api: 'ooba', secret: 'api_key_ooba', url: 'https://local.example.test/v1/chat/completions' },
    { api: 'koboldcpp', secret: 'api_key_koboldcpp', url: 'https://local.example.test/v1/chat/completions' },
    { api: 'llamacpp', secret: 'api_key_llamacpp', url: 'https://local.example.test/v1/chat/completions' },
    { api: 'vllm', secret: 'api_key_vllm', url: 'https://local.example.test/v1/chat/completions' },
    { api: 'aimlapi', secret: 'api_key_aimlapi', url: 'https://api.aimlapi.com/v1/chat/completions' },
    { api: 'groq', secret: 'api_key_groq', url: 'https://api.groq.com/openai/v1/chat/completions' },
    { api: 'cohere', secret: 'api_key_cohere', url: 'https://api.cohere.ai/v2/chat' },
    { api: 'moonshot', secret: 'api_key_moonshot', url: 'https://api.moonshot.ai/v1/chat/completions' },
    { api: 'nanogpt', secret: 'api_key_nanogpt', url: 'https://nano-gpt.com/api/v1/chat/completions' },
    { api: 'chutes', secret: 'api_key_chutes', url: 'https://llm.chutes.ai/v1/chat/completions' },
    { api: 'electronhub', secret: 'api_key_electronhub', url: 'https://api.electronhub.ai/v1/chat/completions' },
    { api: 'zai', secret: 'api_key_zai', url: 'https://api.z.ai/api/paas/v4/chat/completions' },
    { api: 'pollinations', secret: 'api_key_pollinations', url: 'https://gen.pollinations.ai/v1/chat/completions' },
    { api: 'workers_ai', secret: 'api_key_workers_ai', url: 'https://api.cloudflare.com/client/v4/accounts/acc%2Fone%3Fx%3D1/ai/v1/chat/completions' },
];

const IMAGE = 'data:image/png;base64,' + Buffer.from('gotavern-synthetic-caption-image', 'utf8').toString('base64');
// A VIDEO data URI: this is what triggers the zai inlining transform.
const VIDEO_IMAGE = 'data:video/mp4;base64,' + Buffer.from('gotavern-synthetic-caption-video', 'utf8').toString('base64');
const CAPTION = { choices: [{ message: { role: 'assistant', content: 'a synthetic caption' } }] };

function secretEntry(key, value) {
    return { [key]: [{ id: `sid-${key}`, value, label: key, active: true }] };
}

// The body a branch needs to be reached: the api value, a prompt, the image, and the branch-specific extras
// the pinned code reads (a server_url for the local backends, an account id for workers_ai, an endpoint for
// zai).
function bodyFor(branch) {
    const body = { api: branch.api, prompt: 'describe this', image: IMAGE, model: 'gpt-4o-mini' };
    if (['custom', 'ooba', 'koboldcpp', 'llamacpp', 'vllm'].includes(branch.api)) body.server_url = 'https://local.example.test';
    if (branch.api === 'workers_ai') body.workers_ai_account_id = 'acc/one?x=1';
    if (branch.api === 'zai') body.zai_endpoint = 'common';
    return body;
}

const SCENARIOS = BRANCHES.map(branch => ({
    label: `branch-${branch.api}`,
    branch: branch.api,
    body: bodyFor(branch),
    secrets: secretEntry(branch.secret, `synthetic-${branch.api}-key`),
    // One rule per scenario, matching a substring unique to that branch's host, with `times: 1` so it cannot
    // answer a later request (rule 20).
    mocks: [{ match: new URL(branch.url.replace('%2F', '/').replace('%3F', '?').replace('%3D', '=')).host, times: 1, payload: CAPTION }],
}));

SCENARIOS.push(
    { label: 'guard-workers-ai-without-account', body: { api: 'workers_ai', prompt: 'x', image: IMAGE, model: 'm' },
      secrets: secretEntry('api_key_workers_ai', 'synthetic-workers-key'), mocks: [] },
    { label: 'modifier-reverse-proxy', body: { api: 'openai', reverse_proxy: 'https://proxy.example.test', proxy_password: 'synthetic-proxy-password', prompt: 'x', image: IMAGE, model: 'm' },
      secrets: secretEntry('api_key_openai', 'synthetic-openai-key'),
      mocks: [{ match: 'proxy.example.test', times: 1, payload: CAPTION }] },
    { label: 'no-key', body: { api: 'openai', prompt: 'x', image: IMAGE, model: 'm' }, secrets: {}, mocks: [] },
    // `api_type` is a DIFFERENT body member from `api`: it selects the additional-header getter, and with it
    // ABSENT -- which is every other scenario -- the pinned server adds NOTHING. The type literal is taken
    // from the api convention; the assertions below fail loudly if the getter does not fire.
    { label: 'apiType-openrouter-headers', body: { api: 'openai', api_type: 'openrouter', prompt: 'x', image: IMAGE, model: 'm' },
      secrets: secretEntry('api_key_openai', 'synthetic-openai-key'),
      mocks: [{ match: 'api.openai.com', times: 1, payload: CAPTION }] },
    // With the getter's OWN secret present its Authorization OVERWRITES the branch key: a REPLACEMENT, not an
    // addition, which a merge-only-when-absent implementation would pass.
    { label: 'apiType-openrouter-overwrites-key', body: { api: 'openai', api_type: 'openrouter', prompt: 'x', image: IMAGE, model: 'm' },
      secrets: Object.assign(secretEntry('api_key_openai', 'synthetic-openai-key'), secretEntry('api_key_openrouter', 'synthetic-openrouter-key')),
      mocks: [{ match: 'api.openai.com', times: 1, payload: CAPTION }] },
    // Z.AI video inlining: a data:video image is CONVERTED -- the part's TYPE changes and a KEY IS DELETED --
    // so the assertion pins the resulting KEYS and the ABSENCE of image_url. An implementation that adds
    // video_url and leaves image_url in place would pass a presence-only check.
    { label: 'zai-video-inlining', body: { api: 'zai', zai_endpoint: 'common', prompt: 'x', image: VIDEO_IMAGE, model: 'm' },
      secrets: secretEntry('api_key_zai', 'synthetic-zai-key'),
      mocks: [{ match: 'api.z.ai', times: 1, payload: CAPTION }] },
);

const server = await startPinnedProviderServer({ sourceRoot, prefix: 'gotavern-openai-caption-oracle-', mocks: [] });
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
            ...(rule.times === undefined ? {} : { times: rule.times }),
        }));
        server.writeSecrets(scenario.secrets ?? {});
        server.setMocks(rules);
        let result;
        try {
            result = await server.post('/api/openai/caption-image', JSON.stringify(scenario.body));
        } catch (error) {
            // MAKE THE FAILURE IDENTIFY ITSELF (rule 20's diagnostic): the scenario name and the mocks it was
            // served, because a bare TimeoutError costs a turn.
            console.error(`SCENARIO FAILED: ${scenario.label}`);
            console.error(`  mocks served: ${JSON.stringify(rules)}`);
            console.error(`  outbound captured: ${JSON.stringify(server.outbound())}`);
            throw error;
        }
        // The pollinations branch sets a RANDOMIZED seed, so the recorded body carries a marker instead of
        // the value: the field cannot be byte-stable and masking it is the same treatment the SD and video
        // seeds already receive.
        const normalizeSeed = value => (typeof value === 'string' ? value.replace(/"seed":\d+/g, '"seed":"<seed>"') : value);
        const outbound = server.outbound().map(request => ({ url: request.url, method: request.method, headers: request.headers, body: normalizeSeed(request.body) }));
        scenarios[scenario.label] = {
            route: '/api/openai/caption-image',
            branch: scenario.branch ?? null,
            requestBody: JSON.stringify(scenario.body),
            mocks: rules,
            secrets: server.readSecrets(),
            response: captureHttp(result),
            outbound,
            // The pollinations seed is RANDOMIZED: rule 18 with a third source of instability, so no value is
            // recorded and the reason says why.
            seedObservation: scenario.branch === 'pollinations'
                ? { comparison: 'shape', value: null, reason: 'the pinned handler sets bodyParams.seed to Math.floor(Math.random() * 2^32); the value cannot be byte-stable and the pinned code offers no seam, so it is NOT OBSERVED rather than pinned to whichever value this run produced' }
                : null,
        };
    }
} catch (error) {
    console.error('PROBE FAILED; pinned server log tail:');
    console.error(server.logs.join('').slice(-4000));
    throw error;
} finally {
    await server.stop();
}

// THE COUNT IS OVER THE 19 BRANCH VALUES, written down as data.
assert.equal(BRANCHES.length, 19, 'the branch table must carry nineteen values');
const distinctApis = new Set(BRANCHES.map(branch => branch.api));
assert.equal(distinctApis.size, 19, 'every api value must be distinct, so two branches cannot collapse');
const distinctSecrets = new Set(BRANCHES.map(branch => branch.secret));
assert.equal(distinctSecrets.size, 19, 'every branch must carry its own secret');

for (const branch of BRANCHES) {
    const recorded = scenarios[`branch-${branch.api}`];
    assert.equal(recorded.response.status, 200, `${branch.api}: the branch answers 200`);
    assert.deepEqual(recorded.response.body, { caption: 'a synthetic caption' }, `${branch.api}: the route projects the provider answer as {caption}`);
    assert.equal(recorded.outbound.length, 1, `${branch.api}: exactly one upstream request`);
    const observed = recorded.outbound[0].url;
    const wantedHostAndPath = branch.url.replace('https://', '');
    assert.equal(observed.includes(wantedHostAndPath), true,
        `${branch.api}: the request target must be ${branch.url}, saw ${observed}`);
    const auth = recorded.outbound[0].headers.authorization ?? recorded.outbound[0].headers['x-api-key'] ?? '';
    assert.equal(auth.includes(`synthetic-${branch.api}-key`), true,
        `${branch.api}: the branch must use ITS OWN secret, saw ${JSON.stringify(recorded.outbound[0].headers)}`);
}

assert.equal(scenarios['guard-workers-ai-without-account'].response.status, 400, 'workers_ai without an account id answers 400');
assert.deepEqual(scenarios['guard-workers-ai-without-account'].response.body, { error: 'Cloudflare Workers AI Account ID is required' }, 'and names the missing account id');
assert.equal(scenarios['guard-workers-ai-without-account'].outbound.length, 0, 'and reaches NO peer (rule 17)');
assert.equal(scenarios['no-key'].response.status, 400, 'an unknown api with no key answers 400');
assert.equal(scenarios['no-key'].outbound.length, 0, 'and reaches NO peer');
const proxy = scenarios['modifier-reverse-proxy'];
assert.equal(proxy.outbound.length, 1, 'the reverse_proxy MODIFIER still makes one request');
assert.equal(proxy.outbound[0].url.includes('proxy.example.test/chat/completions'), true,
    `the modifier overrides the URL, saw ${proxy.outbound[0].url}`);

// ── api_type: the additional-header getter, asserted as a FULL header set ────────────────────────────
const apiType = scenarios['apiType-openrouter-headers'];
assert.equal(apiType.response.status, 200, 'the api_type scenario answers 200');
assert.equal(apiType.outbound.length, 1, 'and still makes exactly one request');
const typeHeaders = apiType.outbound[0].headers;
assert.equal(typeHeaders['http-referer'], 'https://sillytavern.app', 'the getter adds HTTP-Referer');
assert.equal(typeHeaders['x-title'], 'SillyTavern', 'and X-Title, ON TOP of the route headers');
assert.equal(typeHeaders['content-type'], 'application/json', 'the route Content-Type is still present');
assert.equal(typeHeaders.authorization, 'Bearer synthetic-openai-key',
    'and the BRANCH key is used while the getter has no secret of its own');
const overwrite = scenarios['apiType-openrouter-overwrites-key'];
assert.equal(overwrite.outbound[0].headers.authorization, 'Bearer synthetic-openrouter-key',
    'the getter REPLACES the branch key when its own secret exists (the branch key was Bearer synthetic-openai-key)');
assert.equal(overwrite.outbound[0].headers['http-referer'], 'https://sillytavern.app', 'and still carries its own headers');

// ── zai video inlining: the part's KEYS and the ABSENCE of image_url ─────────────────────────────────
const zaiVideo = scenarios['zai-video-inlining'];
assert.equal(zaiVideo.response.status, 200, 'the zai video scenario answers 200');
const zaiBody = JSON.parse(zaiVideo.outbound[0].body);
const zaiParts = zaiBody.messages[0].content;
const videoPart = zaiParts.find(part => part.type === 'video_url');
assert.ok(videoPart, 'the data:video image becomes a video_url part');
assert.deepEqual(Object.keys(videoPart).sort(), ['type', 'video_url'],
    'and the part carries ONLY type and video_url: image_url is DELETED, not merely superseded');
assert.equal(videoPart.image_url, undefined, 'image_url is ABSENT');
assert.equal(videoPart.video_url.url, VIDEO_IMAGE, 'and the old image_url object MOVED to video_url');
const textPartStill = zaiParts.find(part => part.type === 'text');
assert.ok(textPartStill, 'while the text part is untouched');

const fixture = {
    schemaVersion: 1,
    baseline: { version: PINNED_VERSION, commit: PINNED_COMMIT },
    probe: 'tools/probe-openai-caption.mjs',
    implementedRoutes: ['/api/openai/caption-image'],
    notImplementedRoutes: [],
    // SINGLE SOURCE OF TRUTH: the Go dispatch table is asserted EQUAL to this list, so the two copies cannot
    // drift while both count assertions pass.
    branches: BRANCHES,
    branchCount: BRANCHES.length,
    modifiers: [{ name: 'reverse_proxy', note: 'a MODIFIER rather than a branch: it overrides the URL to ${reverse_proxy}/chat/completions for the keyed branches, and treating it as a branch would inflate the count and hide a missing modifier' }],
    // `api_type` selects the additional-header getter. Fourteen types, written down so an omitted one fails as
    // a count rather than passing as an absence. The getter's Authorization REPLACES the branch key when the
    // getter has a secret of its own, and the host override below it is CONFIG-dependent.
    apiTypes: ['mancer', 'vllm', 'aphrodite', 'tabby', 'togetherai', 'ooba', 'infermaticai', 'dreamgen', 'openrouter', 'koboldcpp', 'llamacpp', 'featherless', 'huggingface', 'generic'],
    hostOverride: {
        source: 'getConfigValue(requestOverrides)',
        note: 'a config list of {hosts, headers} matched on the URL HOST, so it cannot be asserted from the request alone and is scheduled behind the writeConfig capability rather than guessed',
    },
    pinnedSource: {
        'src/endpoints/openai.js:16': 'router.post(\'/caption-image\'): the 19-value api dispatch, the per-branch secret and apiUrl, and the shared 400 guards',
        'src/endpoints/openai.js:188': 'pollinations: a randomized bodyParams.seed and an anonymous vs keyed URL',
        'src/endpoints/openai.js:208': 'zai: the endpoint chosen by zai_endpoint, plus max_tokens 4096',
        'src/endpoints/openai.js:231': 'workers_ai: an encodeURIComponent account id in the path, 400 without one',
    },
    inheritedProperties: {
        customIncludeMerges: 'NOT YET PROBED (commit 2): custom_include_body and custom_include_headers are USER-CONTROLLED objects merged into the outbound request, so a caller can set arbitrary upstream headers and body members. They will be reproduced verbatim and recorded here; a deliberate hardening would be a visible compatibility decision rather than a route-local cleanup.',
    },
    fields: [
        { path: 'scenarios.branch-*.response.status', comparison: 'compared', reason: 'the branch answers 200, or 400 for a guard' },
        { path: 'scenarios.branch-*.response.body', comparison: 'compared', reason: 'the provider JSON pass-through' },
        { path: 'scenarios.branch-*.outbound[].url', comparison: 'compared', reason: 'the per-branch URL, which is what a missing or collapsed branch changes' },
        { path: 'scenarios.branch-*.outbound[].headers', comparison: 'compared', reason: 'the PER-BRANCH secret, so a branch using another branch secret is visible' },
        { path: 'scenarios.branch-*.outbound.length', comparison: 'compared', reason: 'one request per branch, zero for a guard (rule 17)' },
        { path: 'scenarios.branch-pollinations.seedObservation', comparison: 'shape', reason: 'the seed is RANDOMIZED by the pinned code, so it cannot be byte-stable and NO value is recorded' },
    ],
    normalizations: ['The pollinations branch sets a RANDOMIZED bodyParams.seed; the recorded request body carries the marker <seed> instead of the value, and the seed field itself is classified shape with no value recorded.'],
    inputs: {
        imageDataUri: IMAGE,
        caption: CAPTION,
        branchValues: BRANCHES.map(branch => branch.api),
        branchCount: BRANCHES.length,
    },
    bootOutbound,
    scenarios,
};

const outputFile = writeFixture(repositoryRoot, 'sillytavern-1.19.0-openai-caption.json', fixture);
console.log(`branches: ${BRANCHES.length}, scenarios: ${Object.keys(scenarios).length}, boot outbound: ${bootOutbound.length}`);
console.log(`fixture written to ${outputFile}`);
