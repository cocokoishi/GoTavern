#!/usr/bin/env node
// Capture the pinned NanoGPT credits probe:
//
//	POST /api/nanogpt/credits  nanogpt.js:36
//
// The handler issues TWO parallel requests (POST /check-balance, GET /subscription/v1/usage) with
// Promise.allSettled, then normalises the payload into {usd_balance, nano_balance, subscription}.
// The fixture records both outbound requests, the response envelope, and every scenario's exact
// bytes. It is a pure provider transform, so a controlled peer can exist for it.
//
// DEFERRED this round (recorded in the fixture knownDifferences, reported explicitly rather than
// silently): /api/sprites/{upload,upload-zip}, /api/data-maid/*, /api/avatars/upload.
// The reasons are architecture/codec boundaries, not missing effort:
// - /api/avatars/upload runs Jimp (decode -> crop -> cover -> PNG encode via JimpMime.png). A Go
//   implementation using a different PNG encoder cannot produce the recorded bytes, so a
//   byte-level oracle would demand a Jimp-compatible codec decision.
// - /api/sprites/upload-zip and /api/data-maid/* need multipart part recording and, for the data
//   maid, the in-memory DataMaidService token flow (report mints tokens that view/finalize/delete
//   consume), so they cannot be tested independently of a 34 KB service port.
// - /api/sprites/upload itself is a plain byte copy with a multipart part and a sanitized label;
//   it is implementable but was not reached in this round's budget and is left not implemented
//   rather than claimed.
//
// @gotavern-oracle: this declaration is read by tools/build-generated-lib.mjs,
// which auto-discovers probes so that adding one needs no edit there.
// @gotavern-oracle: fixture=sillytavern-1.19.0-nanogpt.json label="NanoGPT credits"

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
    console.error('usage: node tools/probe-nanogpt.mjs <pinned-source-clone> <gotavern-root>');
    process.exit(2);
}
if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim() !== PINNED_COMMIT) {
    throw new Error(`upstream checkout is not pinned at ${PINNED_COMMIT}`);
}

const COOKIE_SECRET = 'gotavern-pinned-nanogpt-cookie-secret';
const SECRETS = { api_key_nanogpt: 'probe-nanogpt-key' };
const SEAM_DEFAULTS = { GOTAVERN_NANOGPT_CREDITS_URL: 'https://nano-gpt.com/api' };

function secretFile(values) {
    const secrets = {};
    for (const [key, value] of Object.entries(values)) {
        secrets[key] = [{ id: `probe-id-${key}`, value, label: key, active: true }];
    }
    return secrets;
}

const scenarios = [];
const addScenario = definition => scenarios.push(definition);

const balance = value => ({ method: 'POST', path: '/check-balance', status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
const usage = value => ({ method: 'GET', path: '/subscription/v1/usage', status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });

addScenario({
    name: 'credits.ok',
    body: {},
    upstream: [
        balance({ usd_balance: 12.5, nano_balance: '42' }),
        usage({
            active: true,
            state: 'active',
            allowOverage: false,
            period: { currentPeriodEnd: '2026-01-01T00:00:00.000Z' },
            limits: { weeklyInputTokens: 100000, dailyInputTokens: 10000, dailyImages: 20 },
            weeklyInputTokens: { used: 100, remaining: 99900, percentUsed: 0.1, resetAt: 1767225600000 },
            dailyInputTokens: { used: 5, remaining: 9995, percentUsed: 0.05, resetAt: 1767225600000 },
            dailyImages: { used: 2, remaining: 18, percentUsed: 10, resetAt: 1767225600000 },
        }),
    ],
});
addScenario({
    name: 'credits.subscriptionInactive',
    body: {},
    upstream: [
        balance({ usd_balance: 0, nano_balance: null }),
        usage({ active: false }),
    ],
});
addScenario({
    name: 'credits.subscriptionFailed',
    body: {},
    upstream: [
        balance({ usd_balance: 3.25, nano_balance: '7' }),
        { method: 'GET', path: '/subscription/v1/usage', status: 500, headers: { 'content-type': 'text/plain' }, body: 'usage failed' },
    ],
});
addScenario({
    name: 'credits.balanceFailed',
    body: {},
    upstream: [
        { method: 'POST', path: '/check-balance', status: 500, headers: { 'content-type': 'text/plain' }, body: 'balance failed' },
        usage({ active: true }),
    ],
});
addScenario({
    name: 'credits.invalidNumbers',
    body: {},
    upstream: [
        balance({ usd_balance: 'not-a-number', nano_balance: {} }),
        usage({
            active: true,
            state: '',
            allowOverage: true,
            period: {},
            limits: {},
            weeklyInputTokens: { used: 'x', remaining: null, percentUsed: true, resetAt: {} },
            dailyInputTokens: null,
            dailyImages: 'nope',
        }),
    ],
});
addScenario({
    name: 'credits.noKey',
    body: {},
    secrets: { ...SECRETS, api_key_nanogpt: '' },
});
addScenario({
    name: 'credits.closedPort',
    body: {},
    peer: 'closed',
});

function capture(result) {
    const body = result.bytes ?? Buffer.from(result.text ?? '', 'utf8');
    return {
        status: result.response.status,
        contentType: normalize(result.response.headers.get('content-type') ?? '') || null,
        contentLength: result.response.headers.get('content-length'),
        etag: result.response.headers.get('etag'),
        bodyBase64: body.toString('base64'),
        bodySha256: createHash('sha256').update(body).digest('hex'),
        bodyLength: body.length,
        bodyJson: result.body !== null && typeof result.body === 'object' ? result.body : null,
    };
}

function normalize(value) {
    return typeof value === 'string' ? value.split('<mock>').join('http://nanogpt-peer.example') : value;
}

async function main() {
    const server = await startPinnedProviderServer({ sourceRoot, prefix: 'gotavern-nanogpt-oracle-', mocks: [] });
    try {
        const observations = {};
        const inputs = {};
        for (const scenario of scenarios) {
            const secrets = scenario.secrets ?? SECRETS;
            server.writeSecrets(secretFile(secrets));
            server.setMocks((scenario.upstream ?? []).map(item => ({
                match: item.path,
                status: item.status,
                headers: item.headers ?? {},
                body: item.body,
                throws: item.throws === true,
            })));
            const result = await server.post('/api/nanogpt/credits', JSON.stringify(scenario.body ?? {}));
            inputs[scenario.name] = {
                body: scenario.body ?? {},
                bodyText: JSON.stringify(scenario.body ?? {}),
                peer: scenario.peer ?? 'mock',
                secrets,
                upstream: scenario.upstream ?? [],
                // Parallel fetches settle independently, so the recorded outbound order is not
                // stable; the replay compares the request set, not the request order.
                outboundOrder: 'shape',
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
                    shape: ['outbound order', 'outbound[].transportConnection'],
                    shapeReason: {
                        'outbound order': 'the two requests are issued with Promise.allSettled and their recording order is not deterministic; the fixture stores the set and the replay compares the set',
                        'outbound[].transportConnection': 'the stub records the headers the route passed, not the transport Connection Node appends; only presence is asserted',
                    },
                },
            };
        }
        const knownDifferences = [{
            routes: ['/api/sprites/upload', '/api/sprites/upload-zip', '/api/data-maid/report', '/api/data-maid/finalize', 'GET /api/data-maid/view', '/api/data-maid/delete', '/api/avatars/upload'],
            status: 'not implemented',
            reason: 'avatars/upload re-encodes through Jimp (crop/cover/PNG), so byte parity needs a Jimp-compatible codec decision; sprites/upload-zip and the data-maid routes need multipart part recording plus the DataMaidService token flow (report mints tokens view/finalize/delete consume). sprites/upload itself (a plain byte copy with a sanitized label) is implementable but was not reached this round; it is left not implemented rather than claimed.',
        }];
        writeFixture(repositoryRoot, 'sillytavern-1.19.0-nanogpt.json', {
            schemaVersion: 1,
            baseline: { version: PINNED_VERSION, commit: PINNED_COMMIT },
            probe: 'pinned /api/nanogpt/credits route (two parallel provider requests)',
            oracle: { file: 'src/endpoints/nanogpt.js' },
            conventions: {
                mock: 'the two provider URLs are hardcoded literals and are replaced by a seam in the replay; the fixture records the pinned literals',
                parallel: 'outbound order is a shape field because the pinned route uses Promise.allSettled',
            },
            nodeFetchWireDefaults: {
                headers: [['accept', '*/*'], ['accept-encoding', 'gzip, deflate, br'], ['user-agent', 'node-fetch']],
                verifiedBy: 'tests/oracle/sillytavern-1.19.0-sd-routes.json records the same defaults on the pinned wire',
            },
            fixtureFields: {
                compared: ['observations.*.status', 'observations.*.contentType', 'observations.*.contentLength', 'observations.*.etag', 'observations.*.bodyBase64', 'observations.*.bodySha256', 'observations.*.bodyLength', 'observations.*.outbound[] as a set'],
                shape: ['observations.*.outbound order', 'observations.*.outbound[].transportConnection'],
            },
            inputs: {
                cookieSecret: COOKIE_SECRET,
                account: { handle: 'default-user', name: 'NanoGPT Probe', admin: true, password: '' },
                seamDefaults: SEAM_DEFAULTS,
                scenarios: inputs,
            },
            observations,
            knownDifferences,
        });
        console.log('Wrote tests/oracle/sillytavern-1.19.0-nanogpt.json from pinned NanoGPT credits behaviour');
    } finally {
        await server.stop();
    }
}

await main();
