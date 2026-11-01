// THE PRESET-KNOB CATALOGUE AND ITS SCENARIO BUILDER.
//
// WHY THIS EXISTS. `presets-and-ui-content` is PARTIAL and the long tail ("every preset field is set but only the
// complex kit's request is compared") had no per-knob measurement. A preset setting reaches the model in TWO
// places: the pinned FRONTEND assembles messages from it, and the pinned SERVER maps the generate request's
// members onto the provider body. The frontend is byte-identical on both subjects (the unmodified pinned
// frontend is served by GoTavern), so the server half is where a Go divergence can live -- and it is measured
// here, byte for byte, through the provider-wire mechanism.
//
// ONE KNOB, TWO SCENARIOS. For each knob the catalogue declares value A and value B; the generator writes one
// provider-wire scenario per value. The differential then has four relations to satisfy:
//   Node(A) == Go(A)   -- enforced live by tools/probe-provider-wire.mjs for every scenario;
//   Node(B) == Go(B)   -- ditto;
//   Node(A) != Node(B) -- asserted from the committed pinned captures by
//                         tests/provider-wire/preset-knobs.test.mjs (this is the DISCRIMINATION proof);
//   Go(A)   != Go(B)   -- follows by equality: if Go(A)==Node(A) and Go(B)==Node(B) and Node(A)!=Node(B), Go
//                         cannot equal itself across A/B unless the harness failed to compare.
// A knob declared `discriminating` whose A/B captures collide fails as HARNESS NON-DISCRIMINATING.
//
// MEASURED-NOOP IS A RESULT, NOT A SKIP. Some settings are consumed entirely by the frontend (instruct/context
// templates, use_sysprompt for chat-completion sources, names_behavior, assistant_prefill outside Claude), so the
// server must IGNORE them. Their A/B captures must be EQUAL on both subjects. That equality is the evidence for
// the `measured-noop-at-the-provider-wire` classification, and the frontend effect is covered by the browser
// preset/helper/world-info differentials instead. A noop knob whose captures DIFFER fails too: the classification
// would be false.
//
// EVERY KNOB CARRIES ITS SOURCES. `pinnedSource` is the upstream file:line that consumes the member; `goSource` is
// the Go implementation. An entry without both is rejected by the test, so the catalogue cannot drift into a list
// of settings nobody traced.

export const PROVIDER_WIRE_BASE = Object.freeze({
    chat_completion_source: 'openai',
    model: 'probe-model',
    messages: [
        { role: 'system', content: 'preset-knob system marker' },
        { role: 'user', content: 'preset-knob user marker' },
    ],
    max_tokens: 64,
    temperature: 0.5,
    stream: false,
    reverse_proxy: '<mock>',
    proxy_password: 'synthetic-proxy-key',
});

const NONSTREAM_MOCK = {
    responses: [{
        status: 200,
        headers: [{ name: 'Content-Type', value: 'application/json' }],
        body: '{"id":"mock-nonstream","choices":[{"index":0,"message":{"role":"assistant","content":"mock reply"},"finish_reason":"stop"}]}',
    }],
};

// The reverse-proxy normalization, copied from openai-reverse-proxy-nonstream.json because the mechanism is the
// same: the mock authority is not a property of either backend, and the provider body contains it through
// `reverse_proxy`. Everything else is compared byte for byte.
const REVERSE_PROXY_NORMALIZATION = Object.freeze({
    tier2: [
        {
            path: 'provider.requests[].headers[Host]',
            rule: 'value replaced with <mock-authority>',
            reason: 'The mock listens on an ephemeral loopback port, so the authority is not a property of either backend.',
            harnessSource: 'tools/mock-provider/main.go: --port 0 asks the kernel for a free port, so the authority is not stable',
        },
        {
            path: 'provider.requests[].headers[authorization]',
            rule: 'value replaced with Bearer <redacted>, presence and scheme preserved',
            reason: 'The scenario supplies a synthetic key; the header\'s presence and scheme are the contract, the value is not.',
            pinnedSource: 'src/endpoints/backends/chat-completions.js:933 \'Authorization\': \'Bearer \' + apiKey',
        },
        {
            path: 'http.requests[].body.reverse_proxy and its bodySha256',
            rule: 'the mock authority is replaced with <mock> before hashing',
            reason: 'The mock listens on an ephemeral loopback port, so the authority is not a property of either backend. The rest of the body is compared byte for byte through the digest.',
            pinnedSource: 'src/endpoints/backends/chat-completions.js:1788 apiUrl = new URL(request.body.reverse_proxy || API_OPENAI).toString()',
        },
    ],
    tier3: [{
        path: 'providerResponse.headers[x-response-time]',
        rule: 'excluded from the compared headers',
        reason: 'It is a measurement of elapsed wall-clock time, so it differs on every run and no backend can match it; the value is a duration, not a contract.',
        pinnedSource: 'src/server-main.js:108 app.use(responseTime())',
    }],
});

/**
 * The catalogue. `bodyA`/`bodyB` are merged over PROVIDER_WIRE_BASE.
 *
 * `expectedChanges` is the set of provider-body JSON paths that MUST differ between A and B (dotted, arrays as
 * `[i]`); `allowedChanges` is the complete set of paths allowed to differ, so a difference caused by something
 * other than the knob fails instead of being credited to it. `[]` for a measured-noop knob means NO path may
 * differ.
 */
export const PRESET_KNOBS = Object.freeze([
    {
        id: 'temperature', area: 'samplers', feature: 'temperature', kind: 'discriminating',
        bodyA: { temperature: 0.2 }, bodyB: { temperature: 1.3 },
        expectedChanges: ['temperature'], allowedChanges: ['temperature'],
        pinnedSource: 'src/endpoints/backends/chat-completions.js:2755 \'temperature\': request.body.temperature',
        goSource: 'internal/server/chat_completions.go:607 fixed member order',
    },
    {
        id: 'top-p', area: 'samplers', feature: 'top_p', kind: 'discriminating',
        bodyA: { top_p: 0.1 }, bodyB: { top_p: 0.95 },
        expectedChanges: ['top_p'], allowedChanges: ['top_p'],
        pinnedSource: 'src/endpoints/backends/chat-completions.js:2760 \'top_p\': request.body.top_p',
        goSource: 'internal/server/chat_completions.go:607 fixed member order',
    },
    {
        id: 'top-k', area: 'samplers', feature: 'top_k', kind: 'discriminating',
        bodyA: { top_k: 0 }, bodyB: { top_k: 40 },
        expectedChanges: ['top_k'], allowedChanges: ['top_k'],
        pinnedSource: 'src/endpoints/backends/chat-completions.js:2761 \'top_k\': request.body.top_k',
        goSource: 'internal/server/chat_completions.go:607 fixed member order',
    },
    {
        id: 'max-tokens', area: 'limits', feature: 'max_tokens', kind: 'discriminating',
        bodyA: { max_tokens: 64 }, bodyB: { max_tokens: 512 },
        expectedChanges: ['max_tokens'], allowedChanges: ['max_tokens'],
        pinnedSource: 'src/endpoints/backends/chat-completions.js:2756 \'max_tokens\': request.body.max_tokens',
        goSource: 'internal/server/chat_completions.go:607 fixed member order',
    },
    {
        id: 'presence-penalty', area: 'samplers', feature: 'presence_penalty', kind: 'discriminating',
        bodyA: { presence_penalty: 0 }, bodyB: { presence_penalty: 1.5 },
        expectedChanges: ['presence_penalty'], allowedChanges: ['presence_penalty'],
        pinnedSource: 'src/endpoints/backends/chat-completions.js:2758 \'presence_penalty\'',
        goSource: 'internal/server/chat_completions.go:607 fixed member order',
    },
    {
        id: 'frequency-penalty', area: 'samplers', feature: 'frequency_penalty', kind: 'discriminating',
        bodyA: { frequency_penalty: 0 }, bodyB: { frequency_penalty: 1.5 },
        expectedChanges: ['frequency_penalty'], allowedChanges: ['frequency_penalty'],
        pinnedSource: 'src/endpoints/backends/chat-completions.js:2759 \'frequency_penalty\'',
        goSource: 'internal/server/chat_completions.go:607 fixed member order',
    },
    {
        id: 'seed', area: 'samplers', feature: 'seed', kind: 'discriminating',
        bodyA: { seed: 42 }, bodyB: { seed: 4242 },
        expectedChanges: ['seed'], allowedChanges: ['seed'],
        pinnedSource: 'src/endpoints/backends/chat-completions.js:2764 \'seed\': request.body.seed',
        goSource: 'internal/server/chat_completions.go:607 fixed member order',
    },
    {
        id: 'n', area: 'samplers', feature: 'n', kind: 'discriminating',
        bodyA: { n: 1 }, bodyB: { n: 3 },
        expectedChanges: ['n'], allowedChanges: ['n'],
        pinnedSource: 'src/endpoints/backends/chat-completions.js:2765 \'n\': request.body.n',
        goSource: 'internal/server/chat_completions.go:607 fixed member order',
    },
    {
        id: 'stop', area: 'stops', feature: 'stop sequences', kind: 'discriminating',
        bodyA: { stop: ['STOP_ONE'] }, bodyB: { stop: ['STOP_ONE', 'STOP_TWO'] },
        expectedChanges: ['stop[1]'], allowedChanges: ['stop[1]'],
        pinnedSource: 'src/endpoints/backends/chat-completions.js:2762 \'stop\': request.body.stop and :2615-2618 bodyParams.stop for a non-empty array',
        goSource: 'internal/server/chat_completions.go:561-566',
    },
    {
        id: 'logit-bias', area: 'samplers', feature: 'logit_bias', kind: 'discriminating',
        bodyA: { logit_bias: { '50256': -100 } }, bodyB: { logit_bias: { '50256': -100, '1234': 50 } },
        expectedChanges: ['logit_bias.1234'], allowedChanges: ['logit_bias.1234'],
        pinnedSource: 'src/endpoints/backends/chat-completions.js:2763 \'logit_bias\': request.body.logit_bias',
        goSource: 'internal/server/chat_completions.go:607 fixed member order',
    },
    {
        id: 'json-schema', area: 'response-format', feature: 'json_schema / response_format', kind: 'discriminating',
        bodyA: { json_schema: { name: 'knob_schema', value: { type: 'object', properties: { alpha: { type: 'string' } } } } },
        bodyB: { json_schema: { name: 'knob_schema', value: { type: 'object', properties: { beta: { type: 'number' } } } } },
        expectedChanges: ['response_format.json_schema.schema.properties.alpha', 'response_format.json_schema.schema.properties.beta'],
        allowedChanges: ['response_format.json_schema.schema.properties.alpha', 'response_format.json_schema.schema.properties.beta'],
        pinnedSource: 'src/endpoints/backends/chat-completions.js:2642-2650 response_format from request.body.json_schema',
        goSource: 'internal/server/chat_completions.go:864-880 pinnedChatCompletionResponseFormat',
    },
    {
        id: 'tools', area: 'tools', feature: 'tools[] functions and tool_choice', kind: 'discriminating',
        bodyA: {
            tool_choice: 'auto',
            tools: [{ type: 'function', function: { name: 'knob_tool_alpha', description: 'alpha', parameters: { type: 'object', properties: {} } } }],
        },
        bodyB: {
            tool_choice: 'auto',
            tools: [{ type: 'function', function: { name: 'knob_tool_beta', description: 'beta', parameters: { type: 'object', properties: {} } } }],
        },
        expectedChanges: ['tools[0].function.name', 'tools[0].function.description'],
        allowedChanges: ['tools[0].function.name', 'tools[0].function.description'],
        pinnedSource: 'src/endpoints/backends/chat-completions.js:2637-2640 tools/tool_choice copied into bodyParams',
        goSource: 'internal/server/chat_completions.go:568-576',
    },
    {
        id: 'reasoning-effort', area: 'reasoning', feature: 'reasoning_effort (model in OPENAI_REASONING_EFFORT_MODELS)', kind: 'discriminating',
        bodyA: { model: 'gpt-5', reasoning_effort: 'low' }, bodyB: { model: 'gpt-5', reasoning_effort: 'high' },
        expectedChanges: ['reasoning_effort'], allowedChanges: ['reasoning_effort'],
        pinnedSource: 'src/endpoints/backends/chat-completions.js:2596-2603 reasoning_effort for CUSTOM/OPENAI, constants.js:461',
        goSource: 'internal/server/chat_completions.go:445-551',
    },
    {
        id: 'verbosity', area: 'reasoning', feature: 'verbosity (gpt-5 family)', kind: 'discriminating',
        bodyA: { model: 'gpt-5', verbosity: 'low' }, bodyB: { model: 'gpt-5', verbosity: 'high' },
        expectedChanges: ['verbosity'], allowedChanges: ['verbosity'],
        pinnedSource: 'src/endpoints/backends/chat-completions.js:2605-2610 verbosity for CUSTOM/OPENAI, constants.js:459',
        goSource: 'internal/server/chat_completions.go:554-559',
    },
    {
        id: 'instruct-template', area: 'instruct-template', feature: 'instruct template selection (frontend-owned for chat-completion sources)', kind: 'measured-noop',
        bodyA: { instruct: 'ChatML' }, bodyB: { instruct: 'Neutral' },
        expectedChanges: [], allowedChanges: [],
        pinnedSource: 'public/scripts/instruct-mode.js (frontend assembly); src/endpoints/backends/chat-completions.js reads no instruct member',
        goSource: 'no server consumer; pinned frontend is served unchanged',
    },
    {
        id: 'context-template', area: 'context-template', feature: 'context template selection (frontend-owned for chat-completion sources)', kind: 'measured-noop',
        bodyA: { context: 'ChatML' }, bodyB: { context: 'Default' },
        expectedChanges: [], allowedChanges: [],
        pinnedSource: 'public/scripts/openai.js prompt manager builds messages; the server reads no context member',
        goSource: 'no server consumer',
    },
    {
        id: 'use-sysprompt', area: 'system-prompt', feature: 'use_sysprompt on a chat-completion source', kind: 'measured-noop',
        bodyA: { use_sysprompt: false }, bodyB: { use_sysprompt: true },
        expectedChanges: [], allowedChanges: [],
        pinnedSource: 'request.body.use_sysprompt is read only by sendClaudeRequest (:250); the generic OpenAI body ignores it',
        goSource: 'internal/server/claude_chat.go (Claude only)',
    },
    {
        id: 'names-behavior', area: 'character-fields', feature: 'names_behavior (frontend message-name shaping)', kind: 'measured-noop',
        bodyA: { names_behavior: 0 }, bodyB: { names_behavior: 1 },
        expectedChanges: [], allowedChanges: [],
        pinnedSource: 'public/scripts/openai.js sets message names before the request; the server does not read names_behavior',
        goSource: 'no server consumer',
    },
]);

/** The base body for both scenario values of a knob, with the knob value merged over it. */
export function knobScenario(knob, which) {
    const overrides = which === 'a' ? knob.bodyA : knob.bodyB;
    return {
        schemaVersion: 1,
        name: `preset-knob-${knob.id}-${which}`,
        purpose: `Preset knob "${knob.feature}" at value ${which.toUpperCase()} (${knob.area}). One member of the browser-equivalent generate request differs between the -a and -b scenarios; the provider-wire differential then proves Node(A)==Go(A), Node(B)==Go(B), and the pair test proves the pinned captures discriminate. Kind: ${knob.kind}.`,
        stage1Boundary: 'Stage 1 validates the backend -> provider transformation only. Browser-side prompt assembly (including the frontend\'s consumption of preset/settings fields) happens before the route is reached and is NOT covered here; a green provider-wire capture is not evidence of preset-level equivalence, and every knob here is classified in docs/preset-semantics.md against the surface that proves its frontend half (or declares that half unmeasured).',
        targetPath: 'openai-reverse-proxy',
        backendConfig: [
            'enableUserAccounts: true',
            'skipContentCheck: true',
            'requestProxy:',
            '  enabled: false',
        ],
        secrets: {},
        expectedAuthorizationKey: 'synthetic-proxy-key',
        request: {
            path: '/api/backends/chat-completions/generate',
            body: { ...PROVIDER_WIRE_BASE, ...overrides },
        },
        mock: NONSTREAM_MOCK,
        normalization: REVERSE_PROXY_NORMALIZATION,
    };
}

/** Every scenario file the generator must write, sorted by name. */
export function allKnobScenarios() {
    const scenarios = [];
    for (const knob of PRESET_KNOBS) {
        scenarios.push(knobScenario(knob, 'a'));
        scenarios.push(knobScenario(knob, 'b'));
    }
    return scenarios.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
}
