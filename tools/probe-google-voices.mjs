#!/usr/bin/env node
// @gotavern-oracle: fixture=sillytavern-1.19.0-google-voices.json label="google voices"
// Probe the pinned /api/google voice routes. ONE route is recorded: `list-voices`.
//
// `list-voices` (google.js:291) is `response.json(languages)` where `languages` is the pinned
// `google-translate-api-x@10.7.2` table: 251 `code: Name` pairs in object order, and the source declares
// `auto` TWICE, so JavaScript keeps the LAST value at the FIRST position. There is NO network request,
// so the observable is the response bytes alone and the fixture asserts zero outbound requests.
//
// `generate-voice` (google.js:295) is NOT recorded and stays `not implemented`: it runs a private Google
// `batchexecute` protocol that lives inside the `google-translate-api-x` package, not in the pinned
// server. It is pinnable (the package calls the global `fetch`, which this peer intercepts) but porting
// it would make GoTavern own a copy of an undocumented private endpoint and track that package forever,
// for one route. See AGENTS.md "a behaviour implemented inside a dependency is not ported"; the decision
// is reversible on a user requirement. The fixture records that reasoning for the reader.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';

import { PINNED_COMMIT, PINNED_VERSION, captureHttp, startPinnedProviderServer, writeFixture } from './lib/pinned-outbound.mjs';

const sourceRoot = path.resolve(process.argv[2] ?? '');
const repositoryRoot = path.resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3]) {
    console.error('usage: node tools/probe-google-voices.mjs <pinned-source-clone> <gotavern-root>');
    process.exit(2);
}
if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim() !== PINNED_COMMIT) {
    throw new Error(`upstream checkout is not pinned at ${PINNED_COMMIT}`);
}

const server = await startPinnedProviderServer({ sourceRoot, prefix: 'gotavern-google-voices-oracle-', mocks: [] });
const scenarios = {};
let bootOutbound = [];
try {
    bootOutbound = server.bootOutbound;
    const result = await server.post('/api/google/list-voices', '{}');
    scenarios.listVoices = {
        route: '/api/google/list-voices',
        requestBody: '{}',
        response: captureHttp(result),
        outbound: server.outbound(),
    };
} catch (error) {
    console.error('PROBE FAILED; pinned server log tail:');
    console.error(server.logs.join('').slice(-8000));
    throw error;
} finally {
    await server.stop();
}

const voices = scenarios.listVoices.response.body;
assert.equal(scenarios.listVoices.response.status, 200, 'list-voices answers 200');
assert.equal(Array.isArray(voices), false, 'the answer is an OBJECT, not an array');
const codes = Object.keys(voices);
assert.ok(codes.length > 200, `the table carries more than 200 codes, got ${codes.length}`);
// The duplicate-key resolution, asserted rather than trusted: the source declares `auto` twice and JS
// keeps the last value at the first position.
assert.equal(codes.filter(code => code === 'auto').length, 1, 'a JSON object cannot carry a duplicate key');
assert.equal(codes[0], 'auto', 'the surviving `auto` keeps the FIRST position');
assert.equal(voices.auto, 'Automatic', 'the surviving `auto` carries the LAST value');
assert.equal(voices.en, 'English', 'a plain code maps to its name');
assert.equal(voices.auto !== voices.en, true, 'the two rows are distinct entries');
assert.equal(scenarios.listVoices.outbound.length, 0, 'list-voices performs NO request');

const fixture = {
    schemaVersion: 1,
    baseline: { version: PINNED_VERSION, commit: PINNED_COMMIT },
    probe: 'tools/probe-google-voices.mjs',
    implementedRoutes: ['/api/google/list-voices'],
    notImplementedRoutes: [
        '/api/google/caption-image',
        '/api/google/generate-image',
        '/api/google/generate-native-tts',
        '/api/google/generate-video',
        '/api/google/generate-voice',
        '/api/google/list-native-voices',
    ],
    notImplementedReasons: {
        '/api/google/generate-voice': 'The pinned handler delegates to `speak()` in the `google-translate-api-x` package, which builds a private Google `batchexecute` request (rpcids=jQ1olc, a `f.req` form body, and a non-JSON response parsed by slicing six characters and scanning `wrb.fr` rows). It IS pinnable: the package calls the global `fetch`, so a controlled peer receives the URL and form body, and a synthetic batchexecute response can be replayed. It is not ported because the protocol belongs to the package rather than to the pinned server, so GoTavern would own a copy of an undocumented private Google endpoint and track that package forever, for one route. The decision is reversible: a user requirement turns it into an explicit product decision with a stated cost. See AGENTS.md, the dependency-ownership boundary.',
        '/api/google/list-native-voices': 'A hardcoded Gemini native-TTS voice table with no network request. Not in this increment; it is the next cheapest route in the domain.',
        '/api/google/generate-native-tts': 'The Gemini/Vertex native envelope: an API-key or OAuth-shaped auth path (including a service-account JWT with RS256 signing), then PCM audio wrapped into WAV by `createCompleteWavFile` in server code. Different transport and different envelope from the OpenAI-shaped routes; not normalised.',
        '/api/google/caption-image': 'Gemini multimodal envelope via getGoogleApiConfig; not in this increment.',
        '/api/google/generate-image': 'Gemini image generation envelope; not in this increment.',
        '/api/google/generate-video': 'Gemini video generation envelope, polling; not in this increment.',
    },
    pinnedSource: {
        'src/endpoints/google.js:291': 'router.post(\'/list-voices\', (_, response) => response.json(languages))',
        'node_modules/google-translate-api-x/package.json': 'the table comes from version 10.7.2, lib/languages.cjs',
    },
    mechanism: 'list-voices performs no outbound request at all, so there is nothing to intercept: the pinned listener is booted, the route is driven, and the response bytes are compared. The peer exists only to assert ZERO outbound requests.',
    fields: [
        { path: 'scenarios.listVoices.response.status', comparison: 'compared', reason: 'the pinned handler always answers 200 for this route' },
        { path: 'scenarios.listVoices.response.headers', comparison: 'compared', reason: 'Express and the pinned middleware stack set them' },
        { path: 'scenarios.listVoices.response.body', comparison: 'compared', reason: 'the whole 251-entry table, including its ORDER and the duplicate-auto resolution' },
        { path: 'scenarios.listVoices.outbound', comparison: 'compared', reason: 'the route performs no request, so the fixture asserts an EMPTY outbound list' },
    ],
    normalizations: [
        'None. The route is deterministic and performs no request, so no value is nondeterministic.',
    ],
    inputs: {
        tableLength: codes.length,
        firstCode: codes[0],
        autoValue: voices.auto,
        tableSha256: createHash('sha256').update(scenarios.listVoices.response.bodyText).digest('hex'),
        packageVersion: '10.7.2',
    },
    bootOutbound,
    scenarios,
};

const outputFile = writeFixture(repositoryRoot, 'sillytavern-1.19.0-google-voices.json', fixture);
console.log(`table entries: ${codes.length}, body bytes: ${scenarios.listVoices.response.bodyText.length}`);
console.log(`fixture written to ${outputFile}`);
