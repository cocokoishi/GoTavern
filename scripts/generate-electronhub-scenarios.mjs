// Generate tests/provider-wire/scenarios/electronhub-*.json.
//
// Same reason as the claude/mistral/deepseek generators: the scenarios share config, secrets,
// transport redirect, seam and normalization, and hand-written copies drift.
import { writeFileSync } from 'node:fs';
import path from 'node:path';

const directory = path.resolve('tests/provider-wire/scenarios');
const KEY = 'synthetic-electronhub-key';
const SEAM = {
    environmentVariable: 'GOTAVERN_ELECTRONHUB_CHAT_URL',
    value: '<mock>',
    pinnedLiteral: 'https://api.electronhub.ai/v1',
};
const BASE = {
    schemaVersion: 1,
    stage1Boundary: 'Stage 1 validates the backend -> provider transformation only. Browser-side prompt assembly happens in the frontend before the request reaches the route and is NOT covered here; a green provider-wire capture is not evidence of preset-level equivalence.',
    targetPath: 'electronhub',
    backendConfig: ['enableUserAccounts: true', 'skipContentCheck: true', 'requestProxy:', '  enabled: false'],
};
const secrets = () => ({
    api_key_electronhub: [{ id: 'probe-id-api_key_electronhub', value: KEY, label: 'api_key_electronhub', active: true }],
});
const normalization = () => ({
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
            pinnedSource: "src/endpoints/backends/chat-completions.js:1468 'Authorization': 'Bearer ' + apiKey",
        },
        {
            path: 'provider.requests[].url',
            rule: 'the recorder origin is replaced with <mock>',
            reason: 'The pinned leg reaches the recorder through the probe transport redirect and the Go leg through its seam, because API_ELECTRONHUB is a pinned literal with no reverse_proxy support. The PATH (/chat/completions) is untouched and IS compared.',
            pinnedSource: 'src/endpoints/backends/chat-completions.js:84 API_ELECTRONHUB = https://api.electronhub.ai/v1, :1395 apiUrl = API_ELECTRONHUB, :1476 apiUrl + /chat/completions',
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

const answer = text => JSON.stringify({
    id: 'probe-electronhub',
    object: 'chat.completion',
    model: 'probe/model',
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 9, completion_tokens: 5, total_tokens: 14 },
});
const jsonRule = text => ({ status: 200, headers: [{ name: 'Content-Type', value: 'application/json' }], body: answer(text) });

const scenarios = [];
const add = definition => scenarios.push({
    ...BASE,
    secrets: secrets(),
    expectedAuthorizationKey: KEY,
    transportRedirect: [{ from: 'https://api.electronhub.ai/v1', to: '<mock>' }],
    goSeam: SEAM,
    normalization: normalization(),
    ...definition,
});
const user = content => ({ role: 'user', content });
const generate = definition => ({
    path: '/api/backends/chat-completions/generate',
    body: {
        chat_completion_source: 'electronhub',
        model: 'probe/model',
        max_tokens: 96,
        stream: false,
        ...definition,
    },
});

// 1. The DEFAULT: messages forwarded VERBATIM (this route runs no prompt processing at all, so a
//    repeated role stays two messages and a mid-prompt system turn stays a system turn), plus the two
//    members no other route sends, top_k and logit_bias, and NO web_search member.
add({
    name: 'electronhub-nonstream',
    purpose: 'ELECTRONHUB default: messages are forwarded VERBATIM (a repeated user role stays two messages and a mid-prompt system turn stays system), top_k and logit_bias are copied in their own positions, seed and the penalties are copied, and web_search is ABSENT because enable_web_search is not set.',
    request: generate({
        messages: [
            { role: 'system', content: 'probe system marker' },
            user('probe first user'),
            user('probe second user'),
            { role: 'system', content: 'probe mid system marker' },
            user('probe final user'),
        ],
        temperature: 0.4,
        top_p: 0.8,
        top_k: 40,
        logit_bias: { '50256': -100 },
        presence_penalty: 0.1,
        frequency_penalty: 0.2,
        seed: 11,
    }),
    mock: { responses: [jsonRule('mock electronhub reply')] },
});

// 2. enable_web_search adds ONLY web_search, spread last.
add({
    name: 'electronhub-web-search',
    purpose: 'ELECTRONHUB web search: a truthy enable_web_search adds web_search:true and nothing else, and the member is spread after seed.',
    request: generate({ messages: [user('probe user marker')], enable_web_search: true }),
    mock: { responses: [jsonRule('mock electronhub reply')] },
});

// 3. tools/tool_choice forwarded RAW.
add({
    name: 'electronhub-tools',
    purpose: 'ELECTRONHUB tools: the tools array and tool_choice are forwarded EXACTLY as supplied, with no empty-required clean-up and no mapping (contrast DEEPSEEK and CLAUDE).',
    request: generate({
        messages: [user('probe tool user marker')],
        tool_choice: 'auto',
        tools: [
            { type: 'function', function: { name: 'probe_empty', parameters: { type: 'object', properties: { a: { type: 'string' } }, required: [] } } },
            { type: 'probe-not-a-function', function: { name: 'survives' } },
        ],
    }),
    mock: { responses: [jsonRule('mock electronhub reply')] },
});

// 4. reasoning_effort is UNGATED here: no include_reasoning member exists in this route.
add({
    name: 'electronhub-reasoning-effort',
    purpose: 'ELECTRONHUB reasoning_effort: forwarded whenever it is truthy, with NO include_reasoning gate (the exact opposite of DEEPSEEK), and spread after tools.',
    request: generate({ messages: [user('probe user marker')], reasoning_effort: 'high' }),
    mock: { responses: [jsonRule('mock electronhub reply')] },
});

// 5/6. json_schema keeps the MISTRAL shape (response_format.json_schema, strict ?? true) rather than
//      DEEPSEEK's appended user message.
add({
    name: 'electronhub-json-schema',
    purpose: 'ELECTRONHUB json_schema: response_format carries type json_schema with name/description/schema copied and strict defaulting to true, and NO extra message is appended (the DEEPSEEK shape).',
    request: generate({
        messages: [user('probe schema user marker')],
        json_schema: {
            name: 'probe_schema',
            description: 'probe schema description',
            value: { type: 'object', properties: { probe_field: { type: 'string' } }, required: ['probe_field'] },
        },
    }),
    mock: { responses: [jsonRule('{"probe_field":"value"}')] },
});
add({
    name: 'electronhub-json-schema-nonstrict',
    purpose: 'ELECTRONHUB json_schema with strict false: the supplied value survives instead of the true default.',
    request: generate({
        messages: [user('probe schema user marker')],
        json_schema: { name: 'probe_schema', value: { type: 'object', properties: { probe_field: { type: 'string' } } }, strict: false },
    }),
    mock: { responses: [jsonRule('{"probe_field":"value"}')] },
});

// 7. A CLAUDE-family model with the caching config at its defaults must NOT gain cache_control: the
//    model regex guards two config-gated helpers, and this capture is the observable half of that gate.
add({
    name: 'electronhub-claude-model-no-cache',
    purpose: 'ELECTRONHUB claude-model gate: a model matching /^claude-/ with enableSystemPromptCache defaulting to false and cachingAtDepth to -1 injects NO cache_control anywhere in the forwarded messages, so the route assumes no cache markers.',
    request: generate({
        model: 'claude-sonnet-4-5-20250929',
        messages: [user('probe claude user marker'), { role: 'assistant', content: 'probe claude assistant marker' }, user('probe claude follow-up')],
    }),
    mock: { responses: [jsonRule('mock electronhub reply')] },
});

// 8/9. The stream and its NON-STREAM CONTROL carry the SAME answer.
const streamFrames = [
    'data: {"id":"probe-electronhub","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"mock electronhub reply"},"finish_reason":null}]}\n\n',
    'data: {"id":"probe-electronhub","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
    'data: [DONE]\n\n',
];
add({
    name: 'electronhub-stream',
    purpose: 'ELECTRONHUB streaming: the provider frames are forwarded VERBATIM, terminating in the provider\'s own [DONE] sentinel.',
    request: generate({ messages: [user('probe user marker')], stream: true }),
    mock: { responses: [{ status: 200, headers: [{ name: 'Content-Type', value: 'text/event-stream' }], stream: streamFrames }] },
});
add({
    name: 'electronhub-stream-control-nonstream',
    purpose: 'The NON-STREAM CONTROL for electronhub-stream: the same answer text through the buffered path, which also pins the PASSTHROUGH (no rewrap) of the provider body.',
    request: generate({ messages: [user('probe user marker')] }),
    mock: { responses: [jsonRule('mock electronhub reply')] },
});

// 10/11. Non-2xx with a JSON body is forwarded at 500; a non-JSON body falls back to {error:true}.
add({
    name: 'electronhub-error-status',
    purpose: 'ELECTRONHUB non-2xx with a JSON body: status 500 carrying the provider body verbatim.',
    request: generate({ messages: [user('probe user marker')] }),
    mock: {
        responses: [{
            status: 429,
            headers: [{ name: 'Content-Type', value: 'application/json' }],
            body: '{"error":{"message":"probe rate limited","type":"rate_limit_error"}}',
        }],
    },
});
add({
    name: 'electronhub-error-status-nonjson',
    purpose: 'ELECTRONHUB non-2xx with a NON-JSON body: tryParse fails, so the answer is 500 {error:true}. The control for electronhub-error-status.',
    request: generate({ messages: [user('probe user marker')] }),
    mock: { responses: [{ status: 503, headers: [{ name: 'Content-Type', value: 'text/plain' }], body: 'probe unavailable' }] },
});

for (const definition of scenarios) {
    const target = path.join(directory, `${definition.name}.json`);
    writeFileSync(target, `${JSON.stringify(definition, null, 2)}\n`);
    console.log(`wrote ${path.basename(target)}`);
}
console.log(`${scenarios.length} scenarios`);
