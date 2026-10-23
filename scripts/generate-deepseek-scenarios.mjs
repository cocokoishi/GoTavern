// Generate tests/provider-wire/scenarios/deepseek-*.json.
//
// Same reason as the claude and mistral generators: the scenarios share config, secrets, transport
// redirect, seam and normalization, and writing them by hand drifts copy by copy.
import { writeFileSync } from 'node:fs';
import path from 'node:path';

const directory = path.resolve('tests/provider-wire/scenarios');
const KEY = 'synthetic-deepseek-key';
const SEAM = {
    environmentVariable: 'GOTAVERN_DEEPSEEK_CHAT_URL',
    value: '<mock>',
    pinnedLiteral: 'https://api.deepseek.com/beta',
};
const BASE = {
    schemaVersion: 1,
    stage1Boundary: 'Stage 1 validates the backend -> provider transformation only. Browser-side prompt assembly happens in the frontend before the request reaches the route and is NOT covered here; a green provider-wire capture is not evidence of preset-level equivalence.',
    targetPath: 'deepseek',
    backendConfig: ['enableUserAccounts: true', 'skipContentCheck: true', 'requestProxy:', '  enabled: false'],
};
const secrets = () => ({
    api_key_deepseek: [{ id: 'probe-id-api_key_deepseek', value: KEY, label: 'api_key_deepseek', active: true }],
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
            pinnedSource: "src/endpoints/backends/chat-completions.js:1145 'Authorization': 'Bearer ' + apiKey",
        },
        {
            path: 'provider.requests[].url',
            rule: 'the recorder origin is replaced with <mock>',
            reason: 'The pinned leg reaches the recorder through the probe transport redirect and the Go leg through its seam, because API_DEEPSEEK is a pinned literal. The PATH (/chat/completions) is untouched and IS compared.',
            pinnedSource: 'src/endpoints/backends/chat-completions.js:86 API_DEEPSEEK = https://api.deepseek.com/beta, :1072 new URL(reverse_proxy || API_DEEPSEEK).toString(), :1153 apiUrl + /chat/completions',
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
    id: 'probe-deepseek',
    object: 'chat.completion',
    model: 'deepseek-chat',
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 9, completion_tokens: 5, total_tokens: 14 },
});
const jsonRule = text => ({ status: 200, headers: [{ name: 'Content-Type', value: 'application/json' }], body: answer(text) });

const scenarios = [];
const add = definition => scenarios.push({
    ...BASE,
    secrets: secrets(),
    expectedAuthorizationKey: KEY,
    transportRedirect: [{ from: 'https://api.deepseek.com/beta', to: '<mock>' }],
    goSeam: SEAM,
    normalization: normalization(),
    ...definition,
});
const user = content => ({ role: 'user', content });
const generate = definition => ({
    path: '/api/backends/chat-completions/generate',
    body: {
        chat_completion_source: 'deepseek',
        model: 'deepseek-chat',
        max_tokens: 96,
        stream: false,
        ...definition,
    },
});

// 1. The DEFAULT: thinking is ALWAYS present (disabled without include_reasoning), seed and stop are
//    forwarded as-is (no -1 rule here), and the SEMI_TOOLS merge runs -- a consecutive user turn is
//    folded and a mid-prompt system turn becomes user.
add({
    name: 'deepseek-nonstream',
    purpose: 'DEEPSEEK default: thinking:{type:"disabled"} present with include_reasoning absent, seed and stop forwarded unchanged, penalties copied, a consecutive same-role turn folded with a blank line and a mid-prompt system turn rewritten to user by the SEMI_TOOLS merge.',
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
        presence_penalty: 0.1,
        frequency_penalty: 0.2,
        seed: 7,
        stop: ['PROBE_STOP'],
    }),
    mock: { responses: [jsonRule('mock deepseek reply')] },
});

// 2. The reasoning pair: include_reasoning flips thinking to enabled and unlocks reasoning_effort.
add({
    name: 'deepseek-reasoning',
    purpose: 'DEEPSEEK reasoning: include_reasoning true makes thinking enabled AND forwards reasoning_effort, which is spread LAST so it follows thinking in the body order.',
    request: generate({
        messages: [user('probe user marker')],
        include_reasoning: true,
        reasoning_effort: 'high',
    }),
    mock: { responses: [jsonRule('mock deepseek reply')] },
});

// 3. The CONTROL for the gate: reasoning_effort WITHOUT include_reasoning is not forwarded at all.
add({
    name: 'deepseek-reasoning-effort-without-include',
    purpose: 'DEEPSEEK gate control: reasoning_effort supplied WITHOUT include_reasoning is dropped and thinking stays disabled, so scenario 2 cannot be satisfied by forwarding the effort unconditionally.',
    request: generate({
        messages: [user('probe user marker')],
        reasoning_effort: 'high',
    }),
    mock: { responses: [jsonRule('mock deepseek reply')] },
});

// 4. logprobs > 0 adds BOTH members, and the value is copied to top_logprobs.
add({
    name: 'deepseek-logprobs',
    purpose: 'DEEPSEEK logprobs: a positive logprobs adds top_logprobs with the same value plus logprobs true.',
    request: generate({
        messages: [user('probe user marker')],
        logprobs: 3,
    }),
    mock: { responses: [jsonRule('mock deepseek reply')] },
});

// 5. tools are RAW, but a tool whose parameters.required is an EMPTY ARRAY loses that key while a
//    non-empty required survives -- the mutation is the observable.
add({
    name: 'deepseek-tools-required-empty',
    purpose: 'DEEPSEEK tools: the empty parameters.required array is DELETED from the forwarded tool while a tool with a non-empty required keeps it and tool_choice is copied, so the deletion cannot be satisfied by dropping required everywhere.',
    request: generate({
        messages: [user('probe tool user marker')],
        tool_choice: 'auto',
        tools: [
            { type: 'function', function: { name: 'probe_empty', parameters: { type: 'object', properties: { a: { type: 'string' } }, required: [] } } },
            { type: 'function', function: { name: 'probe_full', parameters: { type: 'object', properties: { b: { type: 'string' } }, required: ['b'] } } },
        ],
    }),
    mock: { responses: [jsonRule('mock deepseek reply')] },
});

// 6/7. addAssistantPrefix marks a TRAILING assistant turn when no tool is in play, and does not when
//      one is. Scenario 7 also carries a tool_calls message, which gains an empty reasoning_content.
add({
    name: 'deepseek-prefix-flag',
    purpose: 'DEEPSEEK prefill flag: with no tools in the request, a trailing assistant turn is marked with prefix true.',
    request: generate({
        messages: [user('probe user marker'), { role: 'assistant', content: 'probe trailing assistant' }],
    }),
    mock: { responses: [jsonRule('mock deepseek reply')] },
});
add({
    name: 'deepseek-tools-suppress-prefix',
    purpose: 'DEEPSEEK prefix control plus the reasoner hack: with tools present the trailing assistant turn is NOT marked, AND a message carrying tool_calls gains an empty reasoning_content member.',
    request: generate({
        messages: [
            user('probe user marker'),
            { role: 'assistant', content: '', tool_calls: [{ id: 'probe_call_alpha', type: 'function', function: { name: 'probe_tool', arguments: '{}' } }] },
            { role: 'tool', tool_call_id: 'probe_call_alpha', content: 'probe tool result' },
            user('probe after tool'),
        ],
        tool_choice: 'auto',
        tools: [{ type: 'function', function: { name: 'probe_tool', parameters: { type: 'object', properties: {} } } }],
    }),
    mock: { responses: [jsonRule('mock deepseek reply')] },
});

// 8. json_schema: response_format json_object PLUS a new USER message carrying the schema, pretty
//    printed with four spaces.
add({
    name: 'deepseek-json-schema',
    purpose: 'DEEPSEEK json_schema: response_format is {type:"json_object"} and the schema is APPENDED as a new user message reading "JSON schema for the response:" followed by a four-space-indented rendering.',
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

// 9/10. The stream and its NON-STREAM CONTROL carry the SAME answer. DeepSeek's terminator is [DONE]
//       because the route pipes forwardFetchResponse the provider bytes verbatim.
const streamFrames = [
    'data: {"id":"probe-deepseek","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"mock deepseek reply"},"finish_reason":null}]}\n\n',
    'data: {"id":"probe-deepseek","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
    'data: [DONE]\n\n',
];
add({
    name: 'deepseek-stream',
    purpose: 'DEEPSEEK streaming: the provider frames are forwarded VERBATIM, terminating in the provider\'s own [DONE] sentinel.',
    request: generate({ messages: [user('probe user marker')], stream: true }),
    mock: {
        responses: [{
            status: 200,
            headers: [{ name: 'Content-Type', value: 'text/event-stream' }],
            stream: streamFrames,
        }],
    },
});
add({
    name: 'deepseek-stream-control-nonstream',
    purpose: 'The NON-STREAM CONTROL for deepseek-stream: the same answer text through the buffered path, which also pins the PASSTHROUGH (no rewrap) of the provider body.',
    request: generate({ messages: [user('probe user marker')] }),
    mock: { responses: [jsonRule('mock deepseek reply')] },
});

// 11/12. A non-2xx answer with a JSON body is forwarded at 500; a non-JSON body falls back to
//        {error:true} at the same status. The pair is a control for each other.
add({
    name: 'deepseek-error-status',
    purpose: 'DEEPSEEK non-2xx with a JSON body: status 500 carrying the provider body verbatim.',
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
    name: 'deepseek-error-status-nonjson',
    purpose: 'DEEPSEEK non-2xx with a NON-JSON body: tryParse fails, so the answer is 500 {error:true}. The control for deepseek-error-status.',
    request: generate({ messages: [user('probe user marker')] }),
    mock: {
        responses: [{
            status: 503,
            headers: [{ name: 'Content-Type', value: 'text/plain' }],
            body: 'probe unavailable',
        }],
    },
});

// 13. reverse_proxy WITHOUT a password passes the pinned guard (`!apiKey && !reverse_proxy`) and the
//     request leaves with `Bearer undefined` -- a different contract from CLAUDE and MISTRAL, which
//     both answer 400 in this shape.
add({
    name: 'deepseek-reverse-proxy-no-password',
    purpose: 'DEEPSEEK reverse_proxy with NO proxy_password: the key guard is `!apiKey && !reverse_proxy`, so the request is NOT refused -- it leaves with Authorization "Bearer undefined" and the body URL decides the target.',
    secrets: { api_key_deepseek: [{ id: 'probe-id-api_key_deepseek', value: 'synthetic-deepseek-secret-IGNORED', label: 'api_key_deepseek', active: true }] },
    expectedAuthorizationKey: 'undefined',
    transportRedirect: [],
    goSeam: null,
    request: generate({ messages: [user('probe user marker')], reverse_proxy: '<mock>' }),
    mock: { responses: [jsonRule('mock deepseek reply')] },
});

for (const definition of scenarios) {
    const target = path.join(directory, `${definition.name}.json`);
    writeFileSync(target, `${JSON.stringify(definition, null, 2)}\n`);
    console.log(`wrote ${path.basename(target)}`);
}
console.log(`${scenarios.length} scenarios`);
