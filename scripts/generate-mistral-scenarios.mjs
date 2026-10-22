// Generate tests/provider-wire/scenarios/mistral-*.json.
//
// Same reason as the claude generator: the scenarios share config, secrets, transport redirect, seam
// and normalization, and writing them by hand drifts copy by copy.
import { writeFileSync } from 'node:fs';
import path from 'node:path';

const directory = path.resolve('tests/provider-wire/scenarios');
const KEY = 'synthetic-mistral-key';
const SEAM = {
    environmentVariable: 'GOTAVERN_MISTRAL_CHAT_URL',
    value: '<mock>',
    pinnedLiteral: 'https://api.mistral.ai/v1',
};
const BASE = {
    schemaVersion: 1,
    stage1Boundary: 'Stage 1 validates the backend -> provider transformation only. Browser-side prompt assembly happens in the frontend before the request reaches the route and is NOT covered here; a green provider-wire capture is not evidence of preset-level equivalence.',
    targetPath: 'mistralai',
    backendConfig: ['enableUserAccounts: true', 'skipContentCheck: true', 'requestProxy:', '  enabled: false'],
};
const secrets = () => ({
    api_key_mistralai: [{ id: 'probe-id-api_key_mistralai', value: KEY, label: 'api_key_mistralai', active: true }],
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
            pinnedSource: "src/endpoints/backends/chat-completions.js:933 'Authorization': 'Bearer ' + apiKey",
        },
        {
            path: 'provider.requests[].url',
            rule: 'the recorder origin is replaced with <mock>',
            reason: 'The pinned leg reaches the recorder through the probe transport redirect and the Go leg through its seam, because API_MISTRAL is a pinned literal. The PATH (/chat/completions, and its normalization) is untouched and IS compared.',
            pinnedSource: 'src/endpoints/backends/chat-completions.js:75 API_MISTRAL = https://api.mistral.ai/v1, :882 new URL(reverse_proxy || API_MISTRAL).toString(), :942 apiUrl + /chat/completions',
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
    id: 'probe-mistral',
    object: 'chat.completion',
    model: 'open-mistral-nemo',
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 9, completion_tokens: 5, total_tokens: 14 },
});
const jsonRule = text => ({ status: 200, headers: [{ name: 'Content-Type', value: 'application/json' }], body: answer(text) });

const scenarios = [];
const add = definition => scenarios.push({
    ...BASE,
    secrets: secrets(),
    expectedAuthorizationKey: KEY,
    transportRedirect: [{ from: 'https://api.mistral.ai/v1', to: '<mock>' }],
    goSeam: SEAM,
    normalization: normalization(),
    ...definition,
});
const user = content => ({ role: 'user', content });

// 1. The default request: the fixed member order, and the two coercions that have no generic
//    equivalent -- seed -1 is DROPPED and an empty stop array is not sent at all.
add({
    name: 'mistral-nonstream',
    purpose: 'MISTRAL source, NON-STREAMING default: the fixed body order (model, messages, temperature, top_p, frequency_penalty, presence_penalty, max_tokens, stream, safe_prompt, random_seed, stop), seed -1 dropped instead of forwarded, an empty stop array not sent, and safe_prompt forwarded.',
    request: {
        path: '/api/backends/chat-completions/generate',
        body: {
            chat_completion_source: 'mistralai',
            model: 'open-mistral-nemo',
            messages: [user('probe user marker'), { role: 'assistant', content: 'probe assistant marker' }, user('probe follow-up marker')],
            temperature: 0.4,
            top_p: 0.8,
            frequency_penalty: 0.1,
            presence_penalty: 0.2,
            max_tokens: 96,
            stream: false,
            safe_prompt: true,
            seed: -1,
            stop: [],
        },
    },
    mock: { responses: [jsonRule('mock mistral reply')] },
});

// 2. seed 42 and a non-empty stop array: both are forwarded unchanged. This is the CONTROL for the
//    drop rules above -- without it, an implementation that drops seed and stop ALWAYS would pass.
add({
    name: 'mistral-seed-and-stop',
    purpose: 'MISTRAL seed/stop control: seed 42 becomes random_seed 42 and a non-empty stop array is forwarded, so the drop rules of mistral-nonstream cannot be satisfied by dropping them unconditionally.',
    request: {
        path: '/api/backends/chat-completions/generate',
        body: {
            chat_completion_source: 'mistralai',
            model: 'open-mistral-nemo',
            messages: [user('probe user marker')],
            max_tokens: 96,
            seed: 42,
            stop: ['PROBE_STOP', 'SECOND_STOP'],
            stream: false,
        },
    },
    mock: { responses: [jsonRule('mock mistral reply')] },
});

// 3. The message converter: example-name prefixes, a named non-system message, and a SYSTEM turn after
//    an ASSISTANT turn flipped to user.
add({
    name: 'mistral-message-shaping',
    purpose: 'MISTRAL message shaping: example_user/example_assistant lose their name and gain a speaker prefix, a named assistant message is prefixed with its own name, and a system turn immediately after an assistant turn becomes a user turn.',
    request: {
        path: '/api/backends/chat-completions/generate',
        body: {
            chat_completion_source: 'mistralai',
            model: 'open-mistral-nemo',
            user_name: 'Probe User',
            char_name: 'Probe Char',
            messages: [
                { role: 'system', name: 'example_user', content: 'example user line' },
                { role: 'system', name: 'example_assistant', content: 'example assistant line' },
                user('probe user marker'),
                { role: 'assistant', name: 'Probe Char', content: 'named assistant line' },
                { role: 'system', content: 'late system line' },
            ],
            max_tokens: 96,
            stream: false,
        },
    },
    mock: { responses: [jsonRule('mock mistral reply')] },
});

// 4. Tool ids are HASHED to nine characters and a user turn after a tool turn is folded into the
//    previous user content with a blank line. The tool id values are the observable, not the parse.
add({
    name: 'mistral-tool-messages',
    purpose: 'MISTRAL tool handling: tool_calls ids and the tool turn tool_call_id are replaced by sha512(id)[0:9], and the user turn after the tool turn is folded into the earlier user content with a blank-line separator.',
    request: {
        path: '/api/backends/chat-completions/generate',
        body: {
            chat_completion_source: 'mistralai',
            model: 'open-mistral-nemo',
            messages: [
                user('probe first user'),
                {
                    role: 'assistant',
                    content: '',
                    tool_calls: [{ id: 'call_probe_alpha', type: 'function', function: { name: 'probe_tool', arguments: '{"probe_arg":"one"}' } }],
                },
                { role: 'tool', tool_call_id: 'call_probe_alpha', content: 'tool result payload' },
                user('probe after tool'),
            ],
            max_tokens: 96,
            stream: false,
        },
    },
    mock: { responses: [jsonRule('mock mistral reply')] },
});

// 5. tools/tool_choice are forwarded RAW -- no mapping, no filtering, unlike CLAUDE. A non-function
//    entry survives, which is the observable that separates "forwarded" from "converted".
add({
    name: 'mistral-tools-raw',
    purpose: 'MISTRAL tools: the tools array and tool_choice are forwarded EXACTLY as supplied, including a non-function entry that the CLAUDE branch would have filtered out.',
    request: {
        path: '/api/backends/chat-completions/generate',
        body: {
            chat_completion_source: 'mistralai',
            model: 'open-mistral-nemo',
            messages: [user('probe tool user marker')],
            max_tokens: 96,
            stream: false,
            tool_choice: 'auto',
            tools: [
                { type: 'function', function: { name: 'probe_tool', description: 'probe tool', parameters: { type: 'object', properties: { probe_arg: { type: 'string' } } } } },
                { type: 'probe-not-a-function', function: { name: 'survives' } },
            ],
        },
    },
    mock: { responses: [jsonRule('mock mistral reply')] },
});

// 6/7. json_schema with `strict` ABSENT (defaults to true) and with `strict: false` (honoured). The
//      pinned code is `strict: request.body.json_schema.strict ?? true`, so null also defaults.
add({
    name: 'mistral-json-schema',
    purpose: 'MISTRAL json_schema with strict absent: response_format carries strict true, name/description/schema copied, and the schema is NOT flattened (it is passed through).',
    request: {
        path: '/api/backends/chat-completions/generate',
        body: {
            chat_completion_source: 'mistralai',
            model: 'open-mistral-nemo',
            messages: [user('probe schema user marker')],
            max_tokens: 96,
            stream: false,
            json_schema: {
                name: 'probe_schema',
                description: 'probe schema description',
                value: { type: 'object', properties: { probe_field: { type: 'string' } }, required: ['probe_field'] },
            },
        },
    },
    mock: { responses: [jsonRule('{"probe_field":"value"}')] },
});
add({
    name: 'mistral-json-schema-nonstrict',
    purpose: 'MISTRAL json_schema with strict false: the supplied value survives instead of the true default.',
    request: {
        path: '/api/backends/chat-completions/generate',
        body: {
            chat_completion_source: 'mistralai',
            model: 'open-mistral-nemo',
            messages: [user('probe schema user marker')],
            max_tokens: 96,
            stream: false,
            json_schema: {
                name: 'probe_schema',
                value: { type: 'object', properties: { probe_field: { type: 'string' } } },
                strict: false,
            },
        },
    },
    mock: { responses: [jsonRule('{"probe_field":"value"}')] },
});

// 8/9. The stream and its NON-STREAM CONTROL carry the SAME answer. Mistral's terminator is the
//      OpenAI-style [DONE], because the route pipes forwardFetchResponse the provider bytes verbatim.
const streamFrames = [
    'data: {"id":"probe-mistral","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"mock mistral reply"},"finish_reason":null}]}\n\n',
    'data: {"id":"probe-mistral","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
    'data: [DONE]\n\n',
];
add({
    name: 'mistral-stream',
    purpose: 'MISTRAL streaming: the provider frames are forwarded VERBATIM, terminating in the provider\'s own [DONE] sentinel, and the backend response carries no content type of its own.',
    request: {
        path: '/api/backends/chat-completions/generate',
        body: {
            chat_completion_source: 'mistralai',
            model: 'open-mistral-nemo',
            messages: [user('probe user marker')],
            max_tokens: 96,
            stream: true,
        },
    },
    mock: {
        responses: [{
            status: 200,
            headers: [{ name: 'Content-Type', value: 'text/event-stream' }],
            stream: streamFrames,
        }],
    },
});
add({
    name: 'mistral-stream-control-nonstream',
    purpose: 'The NON-STREAM CONTROL for mistral-stream: the same answer text through the buffered path, which also pins the PASSTHROUGH (no OAI rewrap, unlike CLAUDE) of the provider body.',
    request: {
        path: '/api/backends/chat-completions/generate',
        body: {
            chat_completion_source: 'mistralai',
            model: 'open-mistral-nemo',
            messages: [user('probe user marker')],
            max_tokens: 96,
            stream: false,
        },
    },
    mock: { responses: [jsonRule('mock mistral reply')] },
});

// 10. A non-2xx answer with a JSON body: status 500 carrying the PARSED PROVIDER BODY, which is
//     neither CLAUDE's fixed {"error":true} nor the generic path's 200 {error:{message}}.
add({
    name: 'mistral-error-status',
    purpose: 'MISTRAL non-2xx with a JSON body: status 500 carrying the provider body verbatim, which is a different observable from both CLAUDE and the generic path.',
    request: {
        path: '/api/backends/chat-completions/generate',
        body: {
            chat_completion_source: 'mistralai',
            model: 'open-mistral-nemo',
            messages: [user('probe user marker')],
            max_tokens: 96,
            stream: false,
        },
    },
    mock: {
        responses: [{
            status: 429,
            headers: [{ name: 'Content-Type', value: 'application/json' }],
            body: '{"object":"error","message":"probe rate limited","type":"rate_limit_error"}',
        }],
    },
});

// 11. A non-2xx answer whose body is NOT JSON: tryParse fails, so the fallback {"error":true} is used,
//     still at status 500. This is the control for scenario 10.
add({
    name: 'mistral-error-status-nonjson',
    purpose: 'MISTRAL non-2xx with a NON-JSON body: tryParse(errorText) fails, so the answer is 500 {"error":true}. The control for mistral-error-status, which must not be satisfied by always answering {error:true}.',
    request: {
        path: '/api/backends/chat-completions/generate',
        body: {
            chat_completion_source: 'mistralai',
            model: 'open-mistral-nemo',
            messages: [user('probe user marker')],
            max_tokens: 96,
            stream: false,
        },
    },
    mock: {
        responses: [{
            status: 503,
            headers: [{ name: 'Content-Type', value: 'text/plain' }],
            body: 'probe unavailable',
        }],
    },
});

// 12. reverse_proxy: the URL comes from the BODY, the key from proxy_password, and a bare origin gains
//     a trailing slash from new URL(...).toString(), so the target is /chat/completions after a
//     doubled slash.
add({
    name: 'mistral-reverse-proxy',
    purpose: 'MISTRAL reverse_proxy: the URL is new URL(reverse_proxy).toString() + /chat/completions (a bare origin gains a trailing slash, so the target carries a doubled slash) and proxy_password is used as the Bearer key instead of the stored secret.',
    secrets: { api_key_mistralai: [{ id: 'probe-id-api_key_mistralai', value: 'synthetic-mistral-secret-IGNORED', label: 'api_key_mistralai', active: true }] },
    expectedAuthorizationKey: 'synthetic-mistral-proxy-password',
    transportRedirect: [],
    goSeam: null,
    request: {
        path: '/api/backends/chat-completions/generate',
        body: {
            chat_completion_source: 'mistralai',
            model: 'open-mistral-nemo',
            messages: [user('probe user marker')],
            max_tokens: 96,
            stream: false,
            reverse_proxy: '<mock>',
            proxy_password: 'synthetic-mistral-proxy-password',
        },
    },
    mock: { responses: [jsonRule('mock mistral reply')] },
});

for (const definition of scenarios) {
    const target = path.join(directory, `${definition.name}.json`);
    writeFileSync(target, `${JSON.stringify(definition, null, 2)}\n`);
    console.log(`wrote ${path.basename(target)}`);
}
console.log(`${scenarios.length} scenarios`);
