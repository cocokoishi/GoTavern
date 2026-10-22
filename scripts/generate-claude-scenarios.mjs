// Generate tests/provider-wire/scenarios/claude-*.json.
//
// The scenarios are data, so writing them from one script keeps the shared members (config, secrets,
// transport redirect, seam, the two normalization tiers) identical across files instead of drifting
// copy by copy. Run it, diff the result, delete nothing: it is a generator, not a harness.
import { writeFileSync } from 'node:fs';
import path from 'node:path';

const directory = path.resolve('tests/provider-wire/scenarios');
const KEY = 'synthetic-claude-key';
const SEAM = {
    environmentVariable: 'GOTAVERN_CLAUDE_CHAT_URL',
    value: '<mock>',
    pinnedLiteral: 'https://api.anthropic.com/v1',
};
const BASE = {
    schemaVersion: 1,
    stage1Boundary: 'Stage 1 validates the backend -> provider transformation only. Browser-side prompt assembly happens in the frontend before the request reaches the route and is NOT covered here; a green provider-wire capture is not evidence of preset-level equivalence.',
    targetPath: 'claude',
    backendConfig: ['enableUserAccounts: true', 'skipContentCheck: true', 'requestProxy:', '  enabled: false'],
};
const secrets = () => ({
    api_key_claude: [{ id: 'probe-id-api_key_claude', value: KEY, label: 'api_key_claude', active: true }],
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
            path: 'provider.requests[].headers[x-api-key]',
            rule: 'value replaced with <redacted>, presence and name preserved',
            reason: 'CLAUDE authenticates with x-api-key, NOT an Authorization header, so the bearer redaction does not reach it. The scenario declares the key and the harness asserts it arrived; only the value is dropped from the record.',
            pinnedSource: "src/endpoints/backends/chat-completions.js:417 'x-api-key': apiKey",
        },
        {
            path: 'provider.requests[].url',
            rule: 'the recorder origin is replaced with <mock>',
            reason: 'The pinned leg reaches the recorder through the probe transport redirect and the Go leg through its seam, because API_CLAUDE is a pinned literal. The PATH (/messages, and its normalization) is untouched and IS compared.',
            pinnedSource: 'src/endpoints/backends/chat-completions.js:74 API_CLAUDE = https://api.anthropic.com/v1, :231 new URL(reverse_proxy || API_CLAUDE).toString(), :410 apiUrl + /messages',
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

const messageAnswer = text => JSON.stringify({
    id: 'msg_probe',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-4-5-20250929',
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 11, output_tokens: 7 },
});
const jsonRule = text => ({ status: 200, headers: [{ name: 'Content-Type', value: 'application/json' }], body: messageAnswer(text) });

const scenarios = [];
const add = definition => scenarios.push({
    ...BASE,
    secrets: secrets(),
    expectedApiKey: { header: 'x-api-key', value: KEY },
    transportRedirect: [{ from: 'https://api.anthropic.com/v1', to: '<mock>' }],
    goSeam: SEAM,
    normalization: normalization(),
    ...definition,
});

const user = content => ({ role: 'user', content });

// 1. The DEFAULT request. Every initializer of the CLAUDE route is at its default here: no reasoning
//    effort, no tools, no json_schema, no verbosity, no prefill, and the pinned config gate for the
//    caching helpers is off. It pins the body member ORDER, the ALWAYS-present stop_sequences, the
//    composed anthropic-beta header (two values) and -- because calculateClaudeBudgetTokens returns 1024
//    for an ABSENT reasoning_effort -- the thinking member with temperature/top_p/top_k removed and
//    max_tokens raised by 1024.
add({
    name: 'claude-nonstream',
    purpose: 'CLAUDE source, NON-STREAMING default request: the pinned body member order, the always-present empty stop_sequences, the two unconditional anthropic-beta values, and the thinking member an absent reasoning_effort produces (with the sampling members removed and max_tokens raised).',
    request: {
        path: '/api/backends/chat-completions/generate',
        body: {
            chat_completion_source: 'claude',
            model: 'claude-sonnet-4-5-20250929',
            messages: [user('probe user marker'), { role: 'assistant', content: 'probe assistant marker' }, user('probe follow-up marker')],
            max_tokens: 64,
            temperature: 0.7,
            top_p: 0.9,
            use_sysprompt: true,
            stream: false,
        },
    },
    mock: { responses: [jsonRule('mock claude reply')] },
});

// 2. A model that matches NEITHER the thinking nor the limited-sampling predicate: the same request
//    keeps temperature/top_p/top_k and has no thinking member at all. This is the control for the
//    thinking branch, and it is the only way to see the plain sampling members survive.
add({
    name: 'claude-nonthinking-model',
    purpose: 'CLAUDE source with a model outside the thinking and limited-sampling predicates: temperature/top_p/top_k survive and NO thinking member is sent, which is the control for claude-nonstream.',
    request: {
        path: '/api/backends/chat-completions/generate',
        body: {
            chat_completion_source: 'claude',
            model: 'claude-3-5-sonnet-20240620',
            messages: [user('probe user marker')],
            max_tokens: 256,
            temperature: 0.7,
            top_p: 0.9,
            top_k: 40,
            use_sysprompt: true,
            stream: false,
        },
    },
    mock: { responses: [jsonRule('mock claude reply')] },
});

// 3. System-prompt extraction across MULTIPLE system messages, including the two example names that get
//    a speaker prefix. Everything after the first non-system message stays in `messages`, and the user
//    turn is untouched.
add({
    name: 'claude-system-multiple',
    purpose: 'CLAUDE system extraction: three leading system messages become three system text blocks, example_user/example_assistant gain their speaker prefix, and the remaining turns keep their order.',
    request: {
        path: '/api/backends/chat-completions/generate',
        body: {
            chat_completion_source: 'claude',
            model: 'claude-3-5-sonnet-20240620',
            user_name: 'Probe User',
            char_name: 'Probe Char',
            messages: [
                { role: 'system', content: 'probe system one' },
                { role: 'system', name: 'example_user', content: 'example line' },
                { role: 'system', name: 'example_assistant', content: 'example reply' },
                user('probe user marker'),
            ],
            max_tokens: 128,
            use_sysprompt: true,
            stream: false,
        },
    },
    mock: { responses: [jsonRule('mock claude reply')] },
});

// 4. `use_sysprompt: false` DELETES the system member entirely and turns a leading system message into a
//    user turn instead of extracting it.
add({
    name: 'claude-no-sysprompt',
    purpose: 'CLAUDE with use_sysprompt false: the system member is deleted from the body and the leading system message is converted to a user turn.',
    request: {
        path: '/api/backends/chat-completions/generate',
        body: {
            chat_completion_source: 'claude',
            model: 'claude-3-5-sonnet-20240620',
            messages: [{ role: 'system', content: 'probe system one' }, user('probe user marker')],
            max_tokens: 128,
            use_sysprompt: false,
            stream: false,
        },
    },
    mock: { responses: [jsonRule('mock claude reply')] },
});

// 5. Consecutive same-role turns are MERGED. The Anthropic messaging endpoint only accepts alternating
//    turns, so a prompt with two user turns in a row must reach the provider as one turn with two
//    content blocks.
add({
    name: 'claude-merge-roles',
    purpose: 'CLAUDE consecutive-role merging: user,user,assistant,assistant,user reaches the provider as user,assistant,user with the content blocks concatenated in order.',
    request: {
        path: '/api/backends/chat-completions/generate',
        body: {
            chat_completion_source: 'claude',
            model: 'claude-3-5-sonnet-20240620',
            messages: [
                user('merged user one'),
                user('merged user two'),
                { role: 'assistant', content: 'merged assistant one' },
                { role: 'assistant', content: 'merged assistant two' },
                user('tail user'),
            ],
            max_tokens: 128,
            use_sysprompt: true,
            stream: false,
        },
    },
    mock: { responses: [jsonRule('mock claude reply')] },
});

// 6. assistant_prefill on a NON-thinking model (mixing a prefill with a thinking model would also flip
//    the last turn's role, so the two observables are kept apart on purpose). The trailing text is
//    trimEnd()ed, which is why the scenario sends trailing whitespace.
add({
    name: 'claude-prefill',
    purpose: 'CLAUDE assistant_prefill: a trailing assistant turn carrying prefill.trimEnd(), with trailing whitespace removed, on a model where the prefill role is NOT flipped.',
    request: {
        path: '/api/backends/chat-completions/generate',
        body: {
            chat_completion_source: 'claude',
            model: 'claude-3-5-sonnet-20240620',
            messages: [user('probe user marker')],
            assistant_prefill: '  Probe prefill line \n\n',
            max_tokens: 128,
            use_sysprompt: true,
            stream: false,
        },
    },
    mock: { responses: [jsonRule('mock claude reply')] },
});

// 7. Limited sampling with reasoning_effort 'auto': the budget is null, so the thinking branch does NOT
//    fire, and the limited-sampling rule alone decides between temperature and top_p. With top_p < 1 the
//    TEMPERATURE is deleted and top_p is kept -- an implementation that sends both is visibly wrong here.
add({
    name: 'claude-limited-sampling',
    purpose: 'CLAUDE limited sampling: with top_p < 1 the pinned rule deletes temperature and keeps top_p, and reasoning_effort auto keeps the thinking branch out of the way so the two rules cannot mask each other.',
    request: {
        path: '/api/backends/chat-completions/generate',
        body: {
            chat_completion_source: 'claude',
            model: 'claude-sonnet-4-5-20250929',
            messages: [user('probe user marker')],
            max_tokens: 64,
            temperature: 0.7,
            top_p: 0.9,
            top_k: 40,
            reasoning_effort: 'auto',
            use_sysprompt: true,
            stream: false,
        },
    },
    mock: { responses: [jsonRule('mock claude reply')] },
});

// 8. Traditional thinking: reasoning_effort 'medium' gives floor(max_tokens * 0.25) clamped to 1024, the
//    max_tokens raise when it is <= 1024, and the deletion of temperature/top_p/top_k.
add({
    name: 'claude-thinking',
    purpose: 'CLAUDE traditional thinking via reasoning_effort medium: thinking{type:enabled,budget_tokens:1024}, max_tokens raised to 1088 because 64 <= 1024, and temperature/top_p/top_k deleted.',
    request: {
        path: '/api/backends/chat-completions/generate',
        body: {
            chat_completion_source: 'claude',
            model: 'claude-sonnet-4-5-20250929',
            messages: [user('probe user marker')],
            max_tokens: 64,
            temperature: 0.7,
            top_p: 0.9,
            top_k: 40,
            reasoning_effort: 'medium',
            use_sysprompt: true,
            stream: false,
        },
    },
    mock: { responses: [jsonRule('mock claude reply')] },
});

// 9. Tools: the beta list gains tools-2024-05-16, tool_choice is `{ type: <the caller's string> }`, only
//    `type: 'function'` entries are mapped through `.function`, and `parameters` becomes input_schema.
//    One non-function entry is included so the FILTER is observable rather than assumed.
add({
    name: 'claude-tools',
    purpose: 'CLAUDE tools: tool_choice {type:auto}, the tools array mapped through .function with input_schema from parameters, non-function entries dropped, and the tools-2024-05-16 beta value appended.',
    request: {
        path: '/api/backends/chat-completions/generate',
        body: {
            chat_completion_source: 'claude',
            model: 'claude-sonnet-4-5-20250929',
            messages: [user('probe tool user marker')],
            max_tokens: 64,
            reasoning_effort: 'auto',
            use_sysprompt: true,
            stream: false,
            tool_choice: 'auto',
            tools: [
                {
                    type: 'function',
                    function: {
                        name: 'probe_tool',
                        description: 'probe tool description',
                        parameters: { type: 'object', properties: { probe_arg: { type: 'string', description: 'probe arg' } }, required: ['probe_arg'] },
                    },
                },
                { type: 'probe-not-a-function', function: { name: 'dropped_tool' } },
            ],
        },
    },
    mock: { responses: [jsonRule('mock claude reply')] },
});

// 10/11. The stream and its NON-STREAM CONTROL carry the SAME provider answer, so a buffered reply cannot
//        pass as a stream, and the terminator is asserted to be Anthropic's `message_stop` (the CLAUDE
//        route passes forwardFetchResponse the provider bytes verbatim; there is no [DONE] anywhere).
const streamFrames = [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_probe","role":"assistant","content":[]}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"mock claude reply"}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
];
add({
    name: 'claude-stream',
    purpose: 'CLAUDE streaming: the provider frames are forwarded VERBATIM (Anthropic event names, terminating in message_stop, never a [DONE] sentinel) and the backend response carries no content type of its own.',
    request: {
        path: '/api/backends/chat-completions/generate',
        body: {
            chat_completion_source: 'claude',
            model: 'claude-sonnet-4-5-20250929',
            messages: [user('probe user marker')],
            max_tokens: 64,
            reasoning_effort: 'auto',
            use_sysprompt: true,
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
    name: 'claude-stream-control-nonstream',
    purpose: 'The NON-STREAM CONTROL for claude-stream: the same answer text through the buffered path, so the stream capture cannot be produced by a backend that simply buffers. Also pins the OAI-format rewrap plus the retained provider content array.',
    request: {
        path: '/api/backends/chat-completions/generate',
        body: {
            chat_completion_source: 'claude',
            model: 'claude-sonnet-4-5-20250929',
            messages: [user('probe user marker')],
            max_tokens: 64,
            reasoning_effort: 'auto',
            use_sysprompt: true,
            stream: false,
        },
    },
    mock: { responses: [jsonRule('mock claude reply')] },
});

// 12. A non-2xx provider answer on a NON-streaming request: the provider text is dropped and the caller
//     gets 500 {"error":true}, which is NOT the generic path's 200 {"error":{message}} shape.
add({
    name: 'claude-error-status',
    purpose: 'CLAUDE non-2xx answer: 500 {"error":true} with the provider body dropped, distinct from the generic path error envelope.',
    request: {
        path: '/api/backends/chat-completions/generate',
        body: {
            chat_completion_source: 'claude',
            model: 'claude-3-5-sonnet-20240620',
            messages: [user('probe user marker')],
            max_tokens: 64,
            use_sysprompt: true,
            stream: false,
        },
    },
    mock: {
        responses: [{
            status: 529,
            headers: [{ name: 'Content-Type', value: 'application/json' }],
            body: '{"type":"error","error":{"type":"overloaded_error","message":"probe overloaded"}}',
        }],
    },
});

// 13. reverse_proxy: the URL comes from the BODY, the key comes from proxy_password (NOT the secret), and
//     `new URL(...).toString()` normalizes a bare origin by appending '/', so the request target ends up
//     with a DOUBLED slash. No transport redirect or seam is involved: the caller names the host.
add({
    name: 'claude-reverse-proxy',
    purpose: 'CLAUDE reverse_proxy: the URL is new URL(reverse_proxy).toString() + /messages (a bare origin gains a trailing slash, so the target has a doubled slash) and proxy_password is used as x-api-key instead of the stored secret.',
    secrets: { api_key_claude: [{ id: 'probe-id-api_key_claude', value: 'synthetic-claude-secret-IGNORED', label: 'api_key_claude', active: true }] },
    expectedApiKey: { header: 'x-api-key', value: 'synthetic-claude-proxy-password' },
    transportRedirect: [],
    goSeam: null,
    request: {
        path: '/api/backends/chat-completions/generate',
        body: {
            chat_completion_source: 'claude',
            model: 'claude-3-5-sonnet-20240620',
            messages: [user('probe user marker')],
            max_tokens: 64,
            use_sysprompt: true,
            stream: false,
            reverse_proxy: '<mock>',
            proxy_password: 'synthetic-claude-proxy-password',
        },
    },
    mock: { responses: [jsonRule('mock claude reply')] },
});

for (const definition of scenarios) {
    const target = path.join(directory, `${definition.name}.json`);
    writeFileSync(target, `${JSON.stringify(definition, null, 2)}\n`);
    console.log(`wrote ${path.basename(target)}`);
}
console.log(`${scenarios.length} scenarios`);
