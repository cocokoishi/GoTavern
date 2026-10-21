#!/usr/bin/env node
// Capture the pinned NovelAI routes that are one-shot provider transforms:
//
//	POST /api/novelai/status          novelai.js:133   credential/entitlement probe (JSON envelope)
//	POST /api/novelai/generate-voice  novelai.js:442   binary audio (audio/mpeg)
//
// DEFERRED this round, recorded in the fixture knownDifferences:
//	/api/novelai/generate       (novelai.js:167) builds a model-dependent parameter body with the
//	                            Clio/Kayra/Erato bad-word, logit-bias and repetition-penalty tables,
//	                            plus streaming SSE forwarding; the tables and the streaming path need
//	                            their own oracle before a Go port can be claimed.
//	/api/novelai/generate-image (novelai.js:300) builds the NAI Diffusion body, unzips the upstream
//	                            PNG archive, and conditionally performs a second upscale request with
//	                            a fallback to the original image; the zip extraction and the
//	                            two-request fallback need their own fixture.
//
// /api/extra/{caption,classify,classify/labels} are NOT provider routes: caption.js and
// classify.js run local Transformers.js pipelines (`getPipeline`) inside the server, with no
// outbound HTTP to replace or record. They are not probed here and are reported as not implemented
// for that reason (they need an in-process ML runtime, not a provider transform).
//
// The pinned-outbound stub replaces node-fetch. These handlers use the module import, not the
// global fetch and not an SDK client, so there is no bypass path; the probe also asserts the mock
// received exactly the expected requests by recording every outbound hit.
//
// @gotavern-oracle: this declaration is read by tools/build-generated-lib.mjs,
// which auto-discovers probes so that adding one needs no edit there.
// @gotavern-oracle: fixture=sillytavern-1.19.0-novelai.json label="NovelAI status and voice routes"

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
    console.error('usage: node tools/probe-novelai.mjs <pinned-source-clone> <gotavern-root>');
    process.exit(2);
}
if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim() !== PINNED_COMMIT) {
    throw new Error(`upstream checkout is not pinned at ${PINNED_COMMIT}`);
}

const COOKIE_SECRET = 'gotavern-pinned-novelai-cookie-secret';
const MOCK = '<mock>';
const PINNED_PEER = 'http://novelai-peer.example';

const SECRETS = { api_key_novel: 'probe-novel-key' };

const SEAM_DEFAULTS = {
    GOTAVERN_NOVELAI_IMAGE_URL: 'https://image.novelai.net',
    GOTAVERN_NOVELAI_API_URL: 'https://api.novelai.net',
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

const scenarios = [];
const addScenario = definition => scenarios.push(definition);

// ---- /api/novelai/status ---------------------------------------------------------------------
addScenario({
    name: 'status.ok',
    route: 'status',
    body: {},
    upstream: [{ method: 'GET', path: '/user/subscription', status: 200, headers: { 'content-type': 'application/json' }, body: '{"tier":3,"active":true}' }],
});
addScenario({
    name: 'status.unauthorized',
    route: 'status',
    body: {},
    upstream: [{ method: 'GET', path: '/user/subscription', status: 401, headers: { 'content-type': 'application/json' }, body: '{"message":"bad token"}' }],
});
addScenario({
    name: 'status.serverError',
    route: 'status',
    body: {},
    upstream: [{ method: 'GET', path: '/user/subscription', status: 500, headers: { 'content-type': 'text/plain' }, body: 'boom' }],
});
addScenario({
    name: 'status.noKey',
    route: 'status',
    body: {},
    secrets: { ...SECRETS, api_key_novel: '' },
});
addScenario({
    name: 'status.closedPort',
    route: 'status',
    body: {},
    peer: 'closed',
});

// ---- /api/novelai/generate-voice -------------------------------------------------------------
addScenario({
    name: 'voice.ok',
    route: 'generate-voice',
    body: { text: 'hello world & more', voice: 'Aini' },
    upstream: [{ method: 'GET', path: '/ai/generate-voice', status: 200, headers: { 'content-type': 'audio/mpeg' }, body: 'VOICE-BYTES-1234' }],
});
addScenario({
    name: 'voice.encoding',
    route: 'generate-voice',
    body: { text: 'spaces & symbols/?=#', voice: 'v 1' },
    upstream: [{ method: 'GET', path: '/ai/generate-voice', status: 200, headers: { 'content-type': 'application/octet-stream' }, body: 'X' }],
});
addScenario({
    name: 'voice.noKey',
    route: 'generate-voice',
    body: { text: 'hello', voice: 'Aini' },
    secrets: { ...SECRETS, api_key_novel: '' },
});
addScenario({
    name: 'voice.missingText',
    route: 'generate-voice',
    body: { voice: 'Aini' },
});
addScenario({
    name: 'voice.missingVoice',
    route: 'generate-voice',
    body: { text: 'hello' },
});
addScenario({
    name: 'voice.nonOk',
    route: 'generate-voice',
    body: { text: 'hello', voice: 'Aini' },
    upstream: [{ method: 'GET', path: '/ai/generate-voice', status: 500, headers: { 'content-type': 'text/plain' }, body: 'voice failed' }],
});
addScenario({
    name: 'voice.closedPort',
    route: 'generate-voice',
    body: { text: 'hello', voice: 'Aini' },
    peer: 'closed',
});

function capture(result) {
    const body = result.bytes ?? Buffer.from(result.text ?? '', 'utf8');
    const json = result.body !== null && typeof result.body === 'object' ? result.body : null;
    return {
        status: result.response.status,
        contentType: normalize(result.response.headers.get('content-type') ?? '') || null,
        contentLength: result.response.headers.get('content-length'),
        etag: result.response.headers.get('etag'),
        bodyBase64: body.toString('base64'),
        bodySha256: createHash('sha256').update(body).digest('hex'),
        bodyLength: body.length,
        bodyJson: json,
    };
}

async function main() {
    const server = await startPinnedProviderServer({ sourceRoot, prefix: 'gotavern-novelai-oracle-', mocks: [] });
    try {
        const observations = {};
        const inputs = {};
        for (const scenario of scenarios) {
            const secrets = scenario.secrets ?? SECRETS;
            server.writeSecrets(secretFile(materialize(secrets)));
            server.setMocks((scenario.upstream ?? []).map(item => ({
                match: item.path,
                status: item.status,
                headers: item.headers ?? {},
                body: item.body,
                throws: item.throws === true,
            })));
            const body = materialize(scenario.body ?? {});
            const result = await server.post(`/api/novelai/${scenario.route}`, JSON.stringify(body));
            inputs[scenario.name] = {
                route: scenario.route,
                body: scenario.body ?? {},
                bodyText: JSON.stringify(scenario.body ?? {}),
                peer: scenario.peer ?? 'mock',
                secrets,
                upstream: scenario.upstream ?? [],
            };
            observations[scenario.name] = {
                ...capture(result),
                outbound: server.outbound().map(request => ({
                    url: normalize(request.url),
                    method: request.method,
                    explicitHeaders: Object.entries(request.headers ?? {})
                        .map(([name, value]) => [String(name).toLowerCase(), String(value)])
                        .sort((left, right) => left[0].localeCompare(right[0])),
                    body: normalize(request.body ?? ''),
                })),
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
            routes: ['/api/novelai/generate', '/api/novelai/generate-image'],
            status: 'not implemented',
            reason: 'generate builds a model-dependent parameter body (Clio/Kayra/Erato bad-word, logit-bias and repetition-penalty tables) plus an SSE streaming forward; generate-image unzips the upstream PNG archive and conditionally performs a second upscale request with a fallback to the original base64. Both need their own oracle before a Go port can be claimed.',
        }, {
            routes: ['/api/extra/caption', '/api/extra/classify', '/api/extra/classify/labels'],
            status: 'not implemented',
            reason: 'these are NOT provider routes: caption.js and classify.js call getPipeline() from transformers.js, running a local Transformers.js image-to-text / text-classification model inside the server with no outbound HTTP to record. Implementing them needs an in-process ML runtime decision, not a provider transform.',
        }];
        writeFixture(repositoryRoot, 'sillytavern-1.19.0-novelai.json', {
            schemaVersion: 1,
            baseline: { version: PINNED_VERSION, commit: PINNED_COMMIT },
            probe: 'pinned /api/novelai status and generate-voice routes',
            oracle: { file: 'src/endpoints/novelai.js' },
            conventions: {
                binary: 'voice audio is recorded as base64 + SHA-256 + byte length and compared that way',
                mock: 'the request body travels in the status/voice handlers, not as a host, so there is no <mock> marker in this fixture',
                peer: 'the stub replaces node-fetch, the only egress these handlers use; the probe records every outbound hit so an escaped request is visible as a missing request',
            },
            nodeFetchWireDefaults: {
                headers: [['accept', '*/*'], ['accept-encoding', 'gzip, deflate, br'], ['user-agent', 'node-fetch']],
                verifiedBy: 'tests/oracle/sillytavern-1.19.0-sd-routes.json records the same defaults on the pinned wire',
            },
            fixtureFields: {
                compared: ['observations.*.status', 'observations.*.contentType', 'observations.*.contentLength', 'observations.*.etag', 'observations.*.bodyBase64', 'observations.*.bodySha256', 'observations.*.bodyLength', 'observations.*.outbound[] (url, method, explicitHeaders, body)'],
                shape: ['observations.*.outbound[].transportConnection'],
            },
            inputs: {
                cookieSecret: COOKIE_SECRET,
                account: { handle: 'default-user', name: 'NovelAI Probe', admin: true, password: '' },
                seamDefaults: SEAM_DEFAULTS,
                scenarios: inputs,
            },
            observations,
            knownDifferences,
        });
        console.log('Wrote tests/oracle/sillytavern-1.19.0-novelai.json from pinned NovelAI behaviour');
    } finally {
        await server.stop();
    }
}

await main();
