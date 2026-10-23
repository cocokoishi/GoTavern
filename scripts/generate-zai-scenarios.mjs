#!/usr/bin/env node
// Emit the ZAI provider-wire scenarios: the INPUTS the oracle recorder replays against pinned Node and
// against GoTavern. Writing them from one place keeps the eight scenarios' shared preamble identical and
// makes each scenario's DIFFERENCE the only thing a reviewer has to read.
//
// WHAT THIS FILE DOES NOT DO: it does not record. The recordings live in
// tests/oracle/sillytavern-1.19.0-provider-wire.json and are produced by the Linux oracle job, which is
// the only place pinned Node and the Go build are both available. Until that job records these names, the
// Go tests for this source assert the pinning-derived behaviour only and say so.
//
// Usage: node scripts/generate-zai-scenarios.mjs [--check]
//   --check  exit 1 if any emitted file would change, without writing (CI-friendly)

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const scenarioDirectory = path.resolve(here, '..', 'tests', 'provider-wire', 'scenarios');

const COMMON_LITERAL = 'https://api.z.ai/api/paas/v4';
const CODING_LITERAL = 'https://api.z.ai/api/coding/paas/v4';
const SEAM = 'GOTAVERN_ZAI_CHAT_URL';

const STAGE1_BOUNDARY =
    'Stage 1 validates the backend -> provider transformation only. Browser-side prompt assembly happens in the frontend before the request reaches the route and is NOT covered here; a green provider-wire capture is not evidence of preset-level equivalence.';

const normalization = (literal, sourceLine) => ({
    tier2: [
        {
            path: 'provider.requests[].headers[Host]',
            rule: 'value replaced with <mock-authority>',
            reason: 'The mock listens on an ephemeral loopback port, so the authority is not a property of either backend. Justified by tools/mock-provider listening on port 0.',
            harnessSource: 'tools/mock-provider/main.go: --port 0 asks the kernel for a free port, so the authority is not stable',
        },
        {
            path: 'provider.requests[].headers[authorization]',
            rule: 'value replaced with Bearer <redacted>, presence and scheme preserved',
            reason: 'The scenario supplies a synthetic key; the header presence and scheme are the contract, and the value is asserted by expectedAuthorizationKey instead.',
            pinnedSource: 'src/endpoints/backends/chat-completions.js:2079 \'Authorization\': \'Bearer \' + apiKey (status) and the shared generate path',
        },
        {
            path: 'provider.requests[].url',
            rule: 'the recorder origin is replaced with <mock>, the PATH is kept',
            reason: `The pinned leg reaches the recorder through the probe transport redirect and the Go leg through ${SEAM}, because the ZAI literals are pinned. The path is what distinguishes the two endpoint modes and IS compared.`,
            pinnedSource: sourceLine,
        },
    ],
    tier3: [
        {
            path: 'providerResponse.headers[x-response-time]',
            rule: 'excluded from the compared headers',
            reason: 'It is a measurement of elapsed wall-clock time, so it differs on every run and no backend can match it; the value is a duration, not a contract.',
            pinnedSource: 'src/server-main.js:108 app.use(responseTime())',
        },
    ],
});

function scenario({ name, purpose, literal, body, mockStatus, mockBody, sourceLine }) {
    return {
        schemaVersion: 1,
        stage1Boundary: STAGE1_BOUNDARY,
        targetPath: 'zai',
        backendConfig: ['enableUserAccounts: true', 'skipContentCheck: true', 'requestProxy:', '  enabled: false'],
        secrets: {
            api_key_zai: [
                {
                    id: 'probe-id-api_key_zai',
                    value: 'synthetic-zai-key',
                    label: 'api_key_zai',
                    active: true,
                },
            ],
        },
        expectedAuthorizationKey: 'synthetic-zai-key',
        transportRedirect: [{ from: literal, to: '<mock>' }],
        goSeam: { environmentVariable: SEAM, value: '<mock>', pinnedLiteral: literal },
        normalization: normalization(literal, sourceLine),
        name,
        purpose,
        request: { path: '/api/backends/chat-completions/generate', body },
        mock: {
            responses: [
                {
                    status: mockStatus,
                    headers: [{ name: 'Content-Type', value: 'application/json' }],
                    body: mockBody,
                },
            ],
        },
    };
}

const baseMessages = [
    { role: 'system', content: 'probe system marker' },
    { role: 'user', content: 'probe user marker' },
];

const completionBody = JSON.stringify({
    id: 'probe-zai',
    object: 'chat.completion',
    model: 'glm-4.6',
    choices: [{ index: 0, message: { role: 'assistant', content: 'mock zai reply' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 7, completion_tokens: 4, total_tokens: 11 },
});

const sourceLine = (literal, mode) =>
    `src/endpoints/backends/chat-completions.js:94-95 the two literals, :2552 defaultApiUrl = body.zai_endpoint === ZAI_ENDPOINT.CODING ? ${CODING_LITERAL} : ${COMMON_LITERAL}, :2553 new URL(reverse_proxy || defaultApiUrl).toString(); this scenario drives the ${mode} mode (${literal})`;

const zaiGenerate = (overrides) =>
    scenario({
        name: overrides.name,
        purpose: overrides.purpose,
        literal: overrides.literal ?? COMMON_LITERAL,
        sourceLine: sourceLine(overrides.literal ?? COMMON_LITERAL, overrides.mode ?? 'common'),
        mockStatus: overrides.mockStatus ?? 200,
        mockBody: overrides.mockBody ?? completionBody,
        body: {
            chat_completion_source: 'zai',
            model: 'glm-4.6',
            messages: overrides.messages ?? baseMessages,
            max_tokens: 64,
            temperature: 0.5,
            ...overrides.extra,
        },
    });

const scenarios = [
    zaiGenerate({
        name: 'zai-nonstream',
        mode: 'common',
        purpose:
            'ZAI common endpoint, non-stream control: thinking:{type:"disabled"} because include_reasoning is absent, the Accept-Language header the branch owns, and the documented default model passthrough.',
        extra: { stream: false },
    }),
    zaiGenerate({
        name: 'zai-coding-endpoint',
        mode: 'coding',
        purpose:
            'ZAI CODING endpoint: the same request with zai_endpoint:"coding", so the provider target path must be /api/coding/paas/v4/chat/completions rather than /api/paas/v4/chat/completions. This is the scenario that makes the body-driven endpoint switch falsifiable, because the two literals differ only in PATH.',
        literal: CODING_LITERAL,
        extra: { stream: false, zai_endpoint: 'coding' },
    }),
    zaiGenerate({
        name: 'zai-thinking-enabled',
        mode: 'common',
        purpose:
            'ZAI with include_reasoning true: thinking:{type:"enabled"}. Paired with zai-nonstream so both values of the member are pinned; a branch that dropped the member entirely would pass neither.',
        extra: { stream: false, include_reasoning: true },
    }),
    zaiGenerate({
        name: 'zai-json-schema',
        mode: 'common',
        purpose:
            'ZAI with a json_schema: setJsonObjectFormat sets response_format {type:"json_object"} AND appends a synthesized user message carrying the pretty-printed schema, so the compared message array is longer than the request\'s.',
        extra: {
            stream: false,
            json_schema: {
                value: {
                    name: 'probe_schema',
                    schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] },
                },
            },
        },
    }),
    zaiGenerate({
        name: 'zai-stream',
        mode: 'common',
        purpose: 'ZAI streaming: the shared forwarder, so the compared shape is the provider SSE rather than a buffered body.',
        extra: { stream: true },
    }),
    zaiGenerate({
        name: 'zai-peer-fields',
        mode: 'common',
        purpose:
            'ZAI with the peer sampling fields the shared path forwards (top_p, top_k, min_p, repetition_penalty, top_a) plus seed and stop, so the member set around the branch-specific ones is pinned rather than assumed.',
        extra: {
            stream: false,
            top_p: 0.8,
            top_k: 40,
            min_p: 0.05,
            repetition_penalty: 1.1,
            top_a: 0.2,
            seed: 11,
            stop: ['PROBE_STOP'],
        },
    }),
    zaiGenerate({
        name: 'zai-error-status',
        mode: 'common',
        purpose:
            'ZAI provider answering 429: the error observable, which is the shape a caller sees when the endpoint is rate limited rather than a 2xx body with a different member set.',
        mockStatus: 429,
        mockBody: '{"error":{"message":"rate limited","type":"rate_limit_exceeded"}}',
        extra: { stream: false },
    }),
    {
        schemaVersion: 1,
        stage1Boundary: STAGE1_BOUNDARY,
        targetPath: 'zai',
        backendConfig: ['enableUserAccounts: true', 'skipContentCheck: true', 'requestProxy:', '  enabled: false'],
        secrets: {
            api_key_zai: [
                { id: 'probe-id-api_key_zai', value: 'synthetic-zai-key', label: 'api_key_zai', active: true },
            ],
        },
        expectedAuthorizationKey: 'synthetic-zai-key',
        transportRedirect: [],
        goSeam: { environmentVariable: SEAM, value: '<mock>', pinnedLiteral: COMMON_LITERAL },
        normalization: { tier2: [], tier3: [] },
        name: 'zai-status',
        purpose:
            'ZAI /status: pinned\'s status matrix has NO ZAI arm, and its chain ends at :2062-2065 answering 400 { error: true } WITHOUT calling the provider. The mock script is therefore EMPTY: any outbound request would be answered by the mock default and would appear in the recording as a request pinned never made, which is exactly the divergence this scenario exists to catch.',
        request: { path: '/api/backends/chat-completions/status', body: { chat_completion_source: 'zai' } },
        mock: { responses: [] },
    },
];

const checkOnly = process.argv.includes('--check');
let changed = 0;
for (const emitted of scenarios) {
    const file = path.join(scenarioDirectory, `${emitted.name}.json`);
    const text = `${JSON.stringify(emitted, null, 2)}\n`;
    const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    if (existing === text) continue;
    changed += 1;
    if (checkOnly) {
        console.error(`would change: ${path.basename(file)}`);
        continue;
    }
    fs.writeFileSync(file, text, 'utf8');
    console.log(`wrote ${path.basename(file)}`);
}
if (checkOnly && changed > 0) process.exit(1);
console.log(`${scenarios.length} ZAI scenario(s) ${checkOnly ? 'checked' : 'emitted'}, ${changed} changed`);
