// THE BROWSER SOURCE CATALOG -- DRIVER FACTS ONLY.
//
// WHAT THIS FILE IS. The one place that says HOW to drive a chat-completion source in a browser
// differential: which secret the drive writes, which setting names the model, which control a user
// would press, whether the frontend asks for a model list, how each leg is aimed at the recording
// peer, which peer answers, and which surfaces the source has been proved on. generation-probe.mjs
// and both generation/streaming comparators read it instead of each carrying their own list of
// `if (source === 'x')` branches.
//
// WHAT MUST NEVER BE IN THIS FILE, AND WHY.
//   No expected provider BODY, no expected RESPONSE, no expected header VALUE, no expected prompt,
//   message list, status code, or final text. This file is read by the harness that PRODUCES the
//   observations (the subject side) and the harness that CHECKS them (the oracle side). If an
//   expectation lived here, the same document would decide both what is sent and what is correct,
//   and a wrong expectation could never fail: the check would agree with the drive by construction.
//   Expectations come from the pinned server at run time and are compared leg-to-leg; the only
//   values this file may carry are things a USER or the RECORDER controls -- a DOM selector, a
//   setting name, a URL to aim a leg at, a protocol name. `validateCatalog()` enforces the ban on
//   the shapes that would smuggle an expectation in, and test/sources.test.mjs runs it.
//
// WHAT `capabilities` MEANS vs `evidence`. `capabilities` is what the HARNESS can drive today.
// `evidence` is which committed *-comparison.json artefacts exist and are gate-checked. They are
// allowed to disagree, but never silently: a capability without evidence must name why in
// `unproven`, because that is a row nobody has measured, and a sleep-walking gap is exactly what
// this lane exists to remove.
//
// ADDING A SOURCE. Add one entry here, add a `tools/browser-evidence/source-hooks.mjs` hook only if
// the source needs a check the generic invariants cannot express, and re-record. Nothing else in
// the harness should need an edit -- test/sources.test.mjs fails if it does.

// The four mechanisms by which a leg can be pointed at the recording peer. Named rather than
// inferred, because each one is a different claim about what the drive proved.
export const PINNED_ROUTE = {
    // The frontend puts the peer in `custom_url`, a request member.
    CUSTOM_URL: 'custom_url',
    // The frontend puts the peer in `reverse_proxy`, followed by BOTH legs (proxy-capable sources).
    REVERSE_PROXY: 'reverse_proxy',
    // The URL is a pinned literal with no request member that can carry a peer: the GoTavern leg is
    // aimed by its seam and the pinned leg by the transport redirect run-against-pinned.mjs installs.
    DIRECT_LITERAL: 'direct-literal',
    // The host is chosen by a body field (siliconflow's endpoint, workers_ai's account id), so the
    // drive must record WHICH derivation it drove or the numbers cannot be read back.
    BODY_DERIVED: 'body-derived',
};

// The peer circuits. `scripted` is the Go mock-provider driven by a POSITIONAL response script;
// `request-keyed` is the in-process Node peer that answers by request (GET -> model list, POST ->
// completion, SSE when streaming), which is correct for any number of status calls.
export const PEER_CIRCUIT = { SCRIPTED: 'scripted', REQUEST_KEYED: 'request-keyed' };

const claudeProxyNote = 'safety net only: GOTAVERN_CLAUDE_CHAT_URL exists in the Go arm and is aimed here so a leg preferring the pinned literal cannot reach the real provider, but the route this drive took is the setting, which is why proxyPasswordPresent is TRUE on both legs';
const pinnedRedirectRequiredNote = 'PROBE_PINNED_REDIRECT_FILE is NOT optional for a source the frontend marks proxy:false. Without it run-against-pinned.mjs installs no transport redirect hook, the pinned server fetches the REAL provider, and the peer log stays EMPTY -- which reads exactly like a product hang or a product defect, and did for two rounds in this lane. The seam named in seamEnvVar aims the GoTavern leg and the redirect aims the pinned leg; both are required, and proxyPasswordPresent false on BOTH legs is the evidence that neither leg could have reached a peer through a reverse proxy instead.';
const peerKeyingNote = 'the mock script is POSITIONAL and fails in BOTH directions, so the COUNT of model-list answers is not the axis: with ONE entry the pinned generate never arrives (the second status call consumes it and the send is refused with online_status no_connection); with THREE the generate arrives but receives a MODELS body and renders an empty string while the other leg renders text -- an equal-empty that finalTextNonEmpty exists to catch. The peer therefore answers by REQUEST (GET -> model list, completion POST -> completion, SSE when streaming and JSON when not), which is correct for any number of status calls.';

/**
 * One catalogued source.
 *
 * `probe` is everything generation-probe.mjs needs and nothing about what comes back:
 *   secretKey       SECRET_KEYS member written before the drive (null = the source needs no key)
 *   keySelector     the DOM field the CONNECT handler reads, typed by the drive; null = not typed
 *   modelSetting    the oai_settings member that names the model (null = the drive leaves it alone)
 *   modelControl    a <select> a user sets (driven to its own default and RECORDED, never invented)
 *   reverseProxy    put the peer in oai_settings.reverse_proxy (a path a user can take)
 *   customUrl       put the peer in oai_settings.custom_url
 *   expectsModelsCall  whether CONNECT is expected to ask the provider for a model list
 *   noValidate      the frontend returns before any status call and the drive must not wait for one
 *   peer            {protocol, circuit, scriptedModelsAnswers}
 *   seams           [{env, suffix}] GoTavern seams that aim this leg (suffix appended to the peer)
 *   redirectFrom    pinned origins the transport redirect must rewrite ([] = the request carries it)
 */
const define = entry => entry;

export const SOURCES = [
    define({
        id: 'custom',
        label: 'custom (user-supplied OpenAI-compatible endpoint)',
        browserSource: 'custom',
        probe: {
            secretKey: 'CUSTOM',
            keySelector: null,
            modelSetting: null,
            modelControl: null,
            reverseProxy: false,
            customUrl: true,
            expectsModelsCall: true,
            noValidate: false,
            peer: { protocol: 'openai', circuit: PEER_CIRCUIT.SCRIPTED, scriptedModelsAnswers: 1 },
            seams: [],
            redirectFrom: [],
        },
        pinnedRoute: PINNED_ROUTE.CUSTOM_URL,
        // custom is proxy:false in apiSourceConfig AND carries the peer in custom_url, so the proxy
        // column is a statement about the frontend, not about this drive.
        proxy: 'unsupported',
        capabilities: { generation: true, streaming: true, cancellation: true },
        evidence: { generation: 'generation-comparison.json', streaming: 'streaming-comparison.json' },
        driveParameters: null,
    }),
    define({
        id: 'openrouter',
        label: 'openrouter (direct literal, no request member can carry a peer)',
        browserSource: 'openrouter',
        probe: {
            secretKey: 'OPENROUTER',
            keySelector: null,
            modelSetting: 'openrouter_model',
            modelControl: null,
            reverseProxy: false,
            customUrl: false,
            expectsModelsCall: true,
            noValidate: false,
            peer: { protocol: 'openai', circuit: PEER_CIRCUIT.SCRIPTED, scriptedModelsAnswers: 1 },
            seams: [{ env: 'GOTAVERN_OPENROUTER_CHAT_URL', suffix: '' }],
            redirectFrom: ['https://openrouter.ai/api/v1'],
        },
        pinnedRoute: PINNED_ROUTE.DIRECT_LITERAL,
        proxy: 'unsupported',
        capabilities: { generation: true, streaming: true, cancellation: true },
        evidence: { generation: 'generation-openrouter-comparison.json', streaming: 'streaming-openrouter-comparison.json' },
        driveParameters: () => ({
            seamEnvVar: 'GOTAVERN_OPENROUTER_CHAT_URL',
            peerRoute: 'the seam on the GoTavern leg and the https://openrouter.ai/api/v1 transport redirect on the pinned leg -- openrouter has no reverse_proxy and no custom_url, so no request member can carry a peer',
            proxyPasswordMeaning: 'proxyPasswordPresent false on BOTH legs is the EVIDENCE that the seam and the redirect were the only route; a true would mean the drive had started travelling as a proxy and the artifact would no longer describe a proxy:false source',
            pinnedRedirectRequired: 'PROBE_PINNED_REDIRECT_FILE is NOT optional: without it the pinned leg fetches the real provider and an empty peer log reads like a product hang',
        }),
    }),
    define({
        id: 'claude',
        label: 'claude (Anthropic framing, proxy-capable, no-validate)',
        browserSource: 'claude',
        probe: {
            secretKey: 'CLAUDE',
            keySelector: '#api_key_claude',
            modelSetting: 'claude_model',
            modelControl: null,
            reverseProxy: true,
            customUrl: false,
            expectsModelsCall: false,
            noValidate: true,
            peer: { protocol: 'anthropic', circuit: PEER_CIRCUIT.SCRIPTED, scriptedModelsAnswers: 0 },
            // THE SEAM IS AIMED, WHICH IS WHAT THE ARTEFACT CLAIMS. Before this catalog the probe set
            // no claude seam and wrote no anthropic redirect while the artifact said the seam was
            // "aimed here" -- a claim about network isolation that no code backed (AGENTS rule 14).
            // claude_chat.go:796-799 resolves `reverse_proxy || seam`, so the seam is a default and
            // aiming it cannot change the route this drive takes; it only guarantees that a leg which
            // stopped honouring the setting cannot reach api.anthropic.com.
            seams: [{ env: 'GOTAVERN_CLAUDE_CHAT_URL', suffix: '' }],
            redirectFrom: ['https://api.anthropic.com/v1'],
        },
        pinnedRoute: PINNED_ROUTE.REVERSE_PROXY,
        proxy: 'capable-through-setting',
        capabilities: { generation: true, streaming: true, cancellation: true },
        evidence: { generation: 'generation-claude-comparison.json', streaming: 'streaming-claude-comparison.json' },
        driveParameters: () => ({
            seamEnvVar: 'GOTAVERN_CLAUDE_CHAT_URL',
            peerRoute: 'the frontend reverse_proxy setting, followed by BOTH legs -- claude is proxy-capable, and a reverse-proxy drive is the route a user takes',
            seamUsage: claudeProxyNote,
            noValidate: 'claude is in the frontend noValidateSources list, so the CONNECT path never validates; this artifact must therefore record ZERO /models calls on BOTH legs',
        }),
    }),
    define({
        id: 'mistralai',
        label: 'mistralai (OpenAI-shaped, proxy-capable)',
        browserSource: 'mistralai',
        probe: {
            secretKey: 'MISTRALAI',
            keySelector: '#api_key_mistralai',
            modelSetting: 'mistralai_model',
            modelControl: null,
            reverseProxy: true,
            customUrl: false,
            expectsModelsCall: true,
            noValidate: false,
            peer: { protocol: 'openai', circuit: PEER_CIRCUIT.SCRIPTED, scriptedModelsAnswers: 1 },
            // Same reasoning as claude, and the same defect repaired: the drive claimed no isolation
            // because it had none. mistral_chat.go:275-282 resolves `reverse_proxy || seam`.
            seams: [{ env: 'GOTAVERN_MISTRAL_CHAT_URL', suffix: '' }],
            redirectFrom: ['https://api.mistral.ai/v1'],
        },
        pinnedRoute: PINNED_ROUTE.REVERSE_PROXY,
        proxy: 'capable-through-setting',
        capabilities: { generation: true, streaming: true, cancellation: true },
        evidence: { generation: 'generation-mistral-comparison.json', streaming: 'streaming-mistral-comparison.json' },
        driveParameters: () => ({
            seamEnvVar: 'GOTAVERN_MISTRAL_CHAT_URL',
            peerRoute: 'the frontend reverse_proxy setting, followed by BOTH legs -- mistralai is proxy-capable, and a reverse-proxy drive is the route a user takes',
            seamUsage: 'safety net only: GOTAVERN_MISTRAL_CHAT_URL exists in the Go arm and is aimed here so a leg preferring the pinned literal cannot reach the real provider, but the route this drive took is the setting, which is why proxyPasswordPresent is TRUE on both legs',
        }),
    }),
    define({
        id: 'groq',
        label: 'groq (proxy:false, seam + redirect only)',
        browserSource: 'groq',
        probe: {
            secretKey: 'GROQ',
            keySelector: null,
            modelSetting: 'groq_model',
            modelControl: null,
            reverseProxy: false,
            customUrl: false,
            expectsModelsCall: true,
            noValidate: false,
            // THREE scripted model-list answers, not one: a fresh pinned page asks for the model list
            // more than once (openai.js:6097 at settings load, :6963 after connect) and the script is
            // POSITIONAL, so one entry is consumed by the first call and the second receives the
            // completion body -- measured on the pinned groq leg as online_status no_connection with
            // the peer never asked for a completion. Positional data, kept as data.
            peer: { protocol: 'openai', circuit: PEER_CIRCUIT.REQUEST_KEYED, scriptedModelsAnswers: 3 },
            seams: [{ env: 'GOTAVERN_GROQ_CHAT_URL', suffix: '' }],
            redirectFrom: ['https://api.groq.com/openai/v1'],
        },
        pinnedRoute: PINNED_ROUTE.DIRECT_LITERAL,
        proxy: 'unsupported',
        capabilities: { generation: true, streaming: true, cancellation: true },
        evidence: { generation: 'generation-groq-comparison.json', streaming: 'streaming-groq-comparison.json' },
        driveParameters: () => ({
            // GROQ IS proxy:false (openai.js:6050), so a reverse proxy is not a control the frontend
            // offers: the seam and the redirect are the only route to a peer.
            seamEnvVar: 'GOTAVERN_GROQ_CHAT_URL',
            pinnedRedirectRequired: pinnedRedirectRequiredNote,
            peerKeying: peerKeyingNote,
        }),
    }),
    define({
        id: 'siliconflow',
        label: 'siliconflow (proxy:false, host chosen by a body field)',
        browserSource: 'siliconflow',
        probe: {
            secretKey: 'SILICONFLOW',
            keySelector: null,
            modelSetting: 'siliconflow_model',
            // THE ENDPOINT IS A SETTING THE USER SETS, so the drive drives the frontend's own control
            // to its own default and RECORDS what it drove. The harness never invents the value.
            modelControl: { selector: '#siliconflow_endpoint', record: '__siliconflowEndpoint' },
            reverseProxy: false,
            customUrl: false,
            expectsModelsCall: true,
            noValidate: false,
            peer: { protocol: 'openai', circuit: PEER_CIRCUIT.REQUEST_KEYED, scriptedModelsAnswers: 1 },
            seams: [{ env: 'GOTAVERN_SILICONFLOW_CHAT_URL', suffix: '' }],
            redirectFrom: ['https://api.siliconflow.com/v1'],
        },
        pinnedRoute: PINNED_ROUTE.BODY_DERIVED,
        proxy: 'unsupported',
        capabilities: { generation: true, streaming: true, cancellation: true },
        evidence: { generation: 'generation-siliconflow-comparison.json', streaming: 'streaming-siliconflow-comparison.json' },
        driveParameters: leg => ({
            seamEnvVar: 'GOTAVERN_SILICONFLOW_CHAT_URL',
            pinnedRedirectRequired: pinnedRedirectRequiredNote,
            peerKeying: peerKeyingNote,
            endpointMode: leg?.endpoint?.mode ?? null,
            endpointControl: leg?.endpoint?.control ?? null,
            endpointsOffered: leg?.endpoint?.available ?? null,
            endpointBreadth: 'the DEFAULT (global) endpoint only. The CN endpoint is a supported second host and is not measured here, so this row does not claim endpoint breadth',
        }),
    }),
    define({
        id: 'nanogpt',
        label: 'nanogpt (proxy:false, seam + redirect only)',
        browserSource: 'nanogpt',
        probe: {
            secretKey: 'NANOGPT',
            keySelector: '#api_key_nanogpt',
            modelSetting: 'nanogpt_model',
            modelControl: null,
            reverseProxy: false,
            customUrl: false,
            expectsModelsCall: true,
            noValidate: false,
            peer: { protocol: 'openai', circuit: PEER_CIRCUIT.REQUEST_KEYED, scriptedModelsAnswers: 1 },
            seams: [{ env: 'GOTAVERN_NANOGPT_CHAT_URL', suffix: '' }],
            redirectFrom: ['https://nano-gpt.com/api/v1'],
        },
        pinnedRoute: PINNED_ROUTE.DIRECT_LITERAL,
        proxy: 'unsupported',
        capabilities: { generation: true, streaming: true, cancellation: true },
        evidence: { generation: 'generation-nanogpt-comparison.json', streaming: 'streaming-nanogpt-comparison.json' },
        driveParameters: () => ({
            seamEnvVar: 'GOTAVERN_NANOGPT_CHAT_URL',
            pinnedRedirectRequired: pinnedRedirectRequiredNote,
            peerKeying: peerKeyingNote,
        }),
    }),
    define({
        id: 'deepseek',
        label: 'deepseek (proxy-capable but driven without one; /beta on the completion path)',
        browserSource: 'deepseek',
        probe: {
            secretKey: 'DEEPSEEK',
            keySelector: '#api_key_deepseek',
            modelSetting: 'deepseek_model',
            modelControl: null,
            reverseProxy: false,
            customUrl: false,
            expectsModelsCall: true,
            noValidate: false,
            peer: { protocol: 'openai', circuit: PEER_CIRCUIT.REQUEST_KEYED, scriptedModelsAnswers: 1 },
            // THE SEAM REPLACES THE WHOLE BASE, not its origin (deepseek_chat.go:58), and production's
            // literal carries /beta, so the suffix is part of aiming this leg correctly. Measured the
            // other way first: bare origin produced /chat/completions on Go against
            // /beta/chat/completions on pinned, which was the harness and not the product.
            seams: [{ env: 'GOTAVERN_DEEPSEEK_CHAT_URL', suffix: '/beta' }],
            redirectFrom: ['https://api.deepseek.com'],
        },
        pinnedRoute: PINNED_ROUTE.DIRECT_LITERAL,
        proxy: 'capable-deliberately-unset',
        capabilities: { generation: true, streaming: true, cancellation: true },
        evidence: { generation: 'generation-deepseek-comparison.json', streaming: 'streaming-deepseek-comparison.json' },
        driveParameters: () => ({
            seamEnvVar: 'GOTAVERN_DEEPSEEK_CHAT_URL',
            pinnedRedirectRequired: pinnedRedirectRequiredNote,
            peerKeying: peerKeyingNote,
        }),
    }),
    define({
        id: 'openai',
        label: 'openai (proxy-capable, deliberately driven without a proxy)',
        browserSource: 'openai',
        probe: {
            secretKey: 'OPENAI',
            keySelector: null,
            modelSetting: 'openai_model',
            modelControl: null,
            reverseProxy: false,
            customUrl: false,
            expectsModelsCall: true,
            noValidate: false,
            peer: { protocol: 'openai', circuit: PEER_CIRCUIT.REQUEST_KEYED, scriptedModelsAnswers: 1 },
            seams: [{ env: 'GOTAVERN_OPENAI_CHAT_URL', suffix: '' }],
            redirectFrom: ['https://api.openai.com/v1'],
        },
        pinnedRoute: PINNED_ROUTE.DIRECT_LITERAL,
        proxy: 'capable-deliberately-unset',
        capabilities: { generation: true, streaming: true, cancellation: true },
        evidence: { generation: 'generation-openai-comparison.json', streaming: 'streaming-openai-comparison.json' },
        driveParameters: () => ({
            seamEnvVar: 'GOTAVERN_OPENAI_CHAT_URL',
            proxySettingDeliberatelyUnset: 'apiSourceConfig marks openai proxy:true (SECRET_KEYS.OPENAI, #api_key_openai), so oai_settings.reverse_proxy WAS available to this drive and was left unset on purpose; a reader must not conclude from the false that the frontend offers no proxy for openai',
            pinnedRedirectRequired: 'PROBE_PINNED_REDIRECT_FILE aims the PINNED leg (the transport hook run-against-pinned.mjs installs) at the same peer the seam aims the GoTavern leg at. Without it the pinned server fetches api.openai.com, the peer log stays EMPTY, and an empty log reads exactly like a product hang.',
            peerKeying: peerKeyingNote,
        }),
    }),
    define({
        id: 'cohere',
        label: 'cohere (two bases: /v2 generate, /v1 status)',
        browserSource: 'cohere',
        probe: {
            secretKey: 'COHERE',
            keySelector: null,
            modelSetting: 'cohere_model',
            modelControl: null,
            reverseProxy: false,
            customUrl: false,
            expectsModelsCall: true,
            noValidate: false,
            peer: { protocol: 'openai', circuit: PEER_CIRCUIT.REQUEST_KEYED, scriptedModelsAnswers: 1 },
            // TWO BASES, and aiming only generate leaves the status call at the real host, which then
            // refuses the send with no provider request at all.
            seams: [
                { env: 'GOTAVERN_COHERE_CHAT_URL', suffix: '/v2' },
                { env: 'GOTAVERN_COHERE_STATUS_URL', suffix: '/v1' },
            ],
            redirectFrom: ['https://api.cohere.ai'],
        },
        pinnedRoute: PINNED_ROUTE.DIRECT_LITERAL,
        proxy: 'unsupported',
        capabilities: { generation: true, streaming: true, cancellation: true },
        // NO COMMITTED ARTEFACT, AND THAT IS A MEASURED GAP RATHER THAN A SILENT ONE: the drive is
        // wired end to end and has never produced a comparison, so nothing proves cohere at the
        // browser surface. Recording it is a re-run, not an implementation task.
        evidence: { generation: null, streaming: null },
        unproven: 'drivable but never recorded: cohere has no generation- or streaming-comparison.json, so no browser claim may cite it',
        driveParameters: () => ({
            seamEnvVar: 'GOTAVERN_COHERE_CHAT_URL',
            pinnedRedirectRequired: 'PROBE_PINNED_REDIRECT_FILE is NOT optional: cohere has no reverse_proxy, and its two bases live on ONE host with different API versions, so the redirect is by ORIGIN',
            peerKeying: peerKeyingNote,
        }),
    }),
    define({
        id: 'chutes',
        label: 'chutes (proxy:false; messages forwarded verbatim)',
        browserSource: 'chutes',
        probe: {
            secretKey: 'CHUTES',
            keySelector: null,
            modelSetting: 'chutes_model',
            modelControl: null,
            reverseProxy: false,
            customUrl: false,
            expectsModelsCall: true,
            noValidate: false,
            peer: { protocol: 'openai', circuit: PEER_CIRCUIT.REQUEST_KEYED, scriptedModelsAnswers: 1 },
            seams: [{ env: 'GOTAVERN_CHUTES_CHAT_URL', suffix: '' }],
            redirectFrom: ['https://llm.chutes.ai/v1'],
        },
        pinnedRoute: PINNED_ROUTE.DIRECT_LITERAL,
        proxy: 'unsupported',
        capabilities: { generation: true, streaming: true, cancellation: true },
        evidence: { generation: 'generation-chutes-comparison.json', streaming: 'streaming-chutes-comparison.json' },
        driveParameters: () => ({
            seamEnvVar: 'GOTAVERN_CHUTES_CHAT_URL',
            pinnedRedirectRequired: pinnedRedirectRequiredNote,
            peerKeying: peerKeyingNote,
            sourceShape: 'CHUTES forwards messages VERBATIM, with `top_k` and `logit_bias` members no sibling source sends: the recorded provider body IS the evidence, and the artifact carries its digest rather than a re-shaped copy. This is the case that makes a shared-helper implementation look correct and be wrong: a source whose MESSAGE side has no processor at all cannot be served by a helper that quietly reshapes messages for its siblings, and the recorded body digest is what would catch it.',
        }),
    }),
    define({
        id: 'electronhub',
        label: 'electronhub (no reverse_proxy support at all)',
        browserSource: 'electronhub',
        probe: {
            secretKey: 'ELECTRONHUB',
            keySelector: null,
            modelSetting: 'electronhub_model',
            modelControl: null,
            reverseProxy: false,
            customUrl: false,
            expectsModelsCall: true,
            noValidate: false,
            peer: { protocol: 'openai', circuit: PEER_CIRCUIT.REQUEST_KEYED, scriptedModelsAnswers: 1 },
            seams: [{ env: 'GOTAVERN_ELECTRONHUB_CHAT_URL', suffix: '' }],
            redirectFrom: ['https://api.electronhub.ai/v1'],
        },
        pinnedRoute: PINNED_ROUTE.DIRECT_LITERAL,
        proxy: 'unsupported',
        capabilities: { generation: true, streaming: true, cancellation: true },
        evidence: { generation: 'generation-electronhub-comparison.json', streaming: 'streaming-electronhub-comparison.json' },
        driveParameters: () => ({
            seamEnvVar: 'GOTAVERN_ELECTRONHUB_CHAT_URL',
            pinnedRedirectRequired: pinnedRedirectRequiredNote,
            peerKeying: peerKeyingNote,
            sourceShape: 'ELECTRONHUB HAS NO reverse_proxy SUPPORT AT ALL: its route is a bare literal and always reads the ELECTRONHUB secret, so a request carrying a proxy is IGNORED rather than proxied. `proxyPasswordPresent: false` on both legs therefore means UNSUPPORTED, not unused, and the artifact says so because a reader would otherwise read the false as "proxy available and untouched".',
        }),
    }),
    define({
        id: 'aimlapi',
        label: 'aimlapi (proxy:false and its key guard has no reverse_proxy escape)',
        browserSource: 'aimlapi',
        probe: {
            secretKey: 'AIMLAPI',
            keySelector: null,
            modelSetting: 'aimlapi_model',
            modelControl: null,
            reverseProxy: false,
            customUrl: false,
            expectsModelsCall: true,
            noValidate: false,
            peer: { protocol: 'openai', circuit: PEER_CIRCUIT.REQUEST_KEYED, scriptedModelsAnswers: 1 },
            seams: [{ env: 'GOTAVERN_AIMLAPI_CHAT_URL', suffix: '' }],
            redirectFrom: ['https://api.aimlapi.com/v1'],
        },
        pinnedRoute: PINNED_ROUTE.DIRECT_LITERAL,
        proxy: 'unsupported',
        capabilities: { generation: true, streaming: true, cancellation: true },
        evidence: { generation: 'generation-aimlapi-comparison.json', streaming: 'streaming-aimlapi-comparison.json' },
        driveParameters: () => ({
            seamEnvVar: 'GOTAVERN_AIMLAPI_CHAT_URL',
            pinnedRedirectRequired: pinnedRedirectRequiredNote,
            peerKeying: peerKeyingNote,
            proxyMemberSupport: 'UNSUPPORTED: aimlapi_chat.go:24,152 guards on `!apiKey` and the route NEVER READS reverse_proxy, so the peer is unreachable through a proxy for this source. proxyPasswordPresent false on both legs is therefore a statement about the SOURCE, not a choice this drive made',
        }),
    }),
    define({
        id: 'ai21',
        label: 'ai21 (proxy:false, no-validate, framing recorded)',
        browserSource: 'ai21',
        probe: {
            secretKey: 'AI21',
            keySelector: null,
            modelSetting: 'ai21_model',
            modelControl: null,
            reverseProxy: false,
            customUrl: false,
            expectsModelsCall: false,
            noValidate: true,
            peer: { protocol: 'openai', circuit: PEER_CIRCUIT.REQUEST_KEYED, scriptedModelsAnswers: 1 },
            seams: [{ env: 'GOTAVERN_AI21_CHAT_URL', suffix: '' }],
            redirectFrom: ['https://api.ai21.com/studio/v1'],
        },
        pinnedRoute: PINNED_ROUTE.DIRECT_LITERAL,
        proxy: 'unsupported',
        capabilities: { generation: true, streaming: true, cancellation: true },
        evidence: { generation: 'generation-ai21-comparison.json', streaming: 'streaming-ai21-comparison.json' },
        driveParameters: () => ({
            seamEnvVar: 'GOTAVERN_AI21_CHAT_URL',
            pinnedRedirectRequired: pinnedRedirectRequiredNote,
            peerKeying: peerKeyingNote,
        }),
        // THE ONE SOURCE WHOSE COMPARISON IS ABOUT FRAMING RATHER THAN ONLY BODY. Named here so the
        // check lives in its own module (tools/browser-evidence/source-hooks.mjs) instead of an
        // `if (source === 'ai21')` inside a generic function.
        hooks: ['ai21-request-framing'],
    }),
    define({
        id: 'xai',
        label: 'xai (proxy-capable; the peer travels in the SETTING)',
        browserSource: 'xai',
        probe: {
            secretKey: 'XAI',
            keySelector: null,
            modelSetting: 'xai_model',
            modelControl: null,
            reverseProxy: true,
            customUrl: false,
            expectsModelsCall: true,
            noValidate: false,
            peer: { protocol: 'openai', circuit: PEER_CIRCUIT.REQUEST_KEYED, scriptedModelsAnswers: 1 },
            // THE ROUTE IS THE SETTING; the seam and the redirect are safety nets, aimed so a leg
            // preferring the pinned literal cannot reach the real api.x.ai. proxyPasswordPresent TRUE
            // on both legs is what distinguishes this row from every seam-routed one.
            seams: [{ env: 'GOTAVERN_XAI_CHAT_URL', suffix: '' }],
            redirectFrom: ['https://api.x.ai'],
        },
        pinnedRoute: PINNED_ROUTE.REVERSE_PROXY,
        proxy: 'capable-through-setting',
        capabilities: { generation: true, streaming: true, cancellation: true },
        evidence: { generation: 'generation-xai-comparison.json', streaming: 'streaming-xai-comparison.json' },
        driveParameters: () => ({
            seamEnvVar: 'GOTAVERN_XAI_CHAT_URL',
            peerRoute: 'the frontend reverse_proxy setting, followed by BOTH legs (chat-completions.js:1184 `new URL(request.body.reverse_proxy || API_XAI)`), which is a path a user can take because xAI is proxy-capable',
            seamUsage: 'safety net only: GOTAVERN_XAI_CHAT_URL and the api.x.ai transport redirect are both aimed at the peer so a leg preferring the pinned literal cannot reach the real api.x.ai, but NEITHER is the route this drive took, and proxyPasswordPresent true on both legs is the evidence',
            converterNote: 'xAI runs convertXAIMessages (prompt-converters.js:785), a RENAMER that prefixes content with the character or user name and DELETES msg.name -- not the semi_tools merger. A wrong port would still produce a parseable body, so the compared provider bytes are the assertion',
        }),
    }),
    define({
        id: 'workers_ai',
        label: 'workers_ai (account id in the PATH, proxy:false)',
        browserSource: 'workers_ai',
        probe: {
            secretKey: 'WORKERS_AI',
            keySelector: null,
            modelSetting: 'workers_ai_model',
            modelControl: { selector: '#workers_ai_account_id', record: '__workersAiAccountId' },
            reverseProxy: false,
            customUrl: false,
            expectsModelsCall: true,
            noValidate: false,
            peer: { protocol: 'openai', circuit: PEER_CIRCUIT.REQUEST_KEYED, scriptedModelsAnswers: 1 },
            seams: [{ env: 'GOTAVERN_WORKERS_AI_CHAT_URL', suffix: '' }],
            redirectFrom: ['https://api.cloudflare.com/client/v4'],
        },
        pinnedRoute: PINNED_ROUTE.BODY_DERIVED,
        proxy: 'unsupported',
        capabilities: { generation: true, streaming: true, cancellation: true },
        evidence: { generation: 'generation-workersai-comparison.json', streaming: 'streaming-workersai-comparison.json' },
        // THE DRIVE IS A PROPOSAL, NOT A MEASUREMENT, AND SAYS SO. The committed artefacts were
        // produced by a probe revision that could select workers_ai; the revision in this tree cannot
        // (no workers_ai in the allowlist the catalog replaces it with). The rows below are the
        // mechanics that revision would need -- an account-id control driven and recorded -- and they
        // are listed so the gap is visible, not so a gate can pass on them.
        driveSupported: false,
        unproven: 'the current probe cannot select workers_ai; its two committed artefacts predate that and stay gate-checked but cannot be re-recorded until the account-id drive is exercised',
        driveParameters: leg => ({
            seamEnvVar: 'GOTAVERN_WORKERS_AI_CHAT_URL',
            pinnedRedirectRequired: pinnedRedirectRequiredNote,
            peerKeying: peerKeyingNote,
            accountIdMode: leg?.accountId?.mode ?? null,
            accountIdControl: leg?.accountId?.control ?? null,
            accountIdValue: leg?.accountId?.value ?? null,
            peerPathShape: 'the peer saw accounts-prefix + the account id + /ai/v1/chat/completions, and the model list at /<account>/ai/models/search?task=Text+Generation&per_page=1000, because the seam replaces the PREFIX only and the id stays in the path where the product puts it',
        }),
    }),
];

// Key names that would turn this catalog into an oracle. Checked at load AND in the test, so a
// future edit that drops an expected body into an entry fails immediately rather than at review.
const FORBIDDEN_KEYS = [
    'expected', 'expect', 'expectedBody', 'expectedResponse', 'expectedHeaders', 'expectedPath',
    'expectedStatus', 'expectedMessages', 'expectedText', 'expectedPrompt', 'oracle', 'golden',
    'body', 'response', 'messages', 'stop', 'stopStrings', 'prompt',
];

function forbiddenKeyPaths(value, prefix = '') {
    const found = [];
    if (Array.isArray(value)) {
        value.forEach((item, index) => found.push(...forbiddenKeyPaths(item, `${prefix}[${index}]`)));
        return found;
    }
    if (!value || typeof value !== 'object') return found;
    for (const [key, inner] of Object.entries(value)) {
        if (FORBIDDEN_KEYS.includes(key)) found.push(`${prefix}${prefix ? '.' : ''}${key}`);
        found.push(...forbiddenKeyPaths(inner, `${prefix}${prefix ? '.' : ''}${key}`));
    }
    return found;
}

/**
 * Validates the catalog and returns the list of problems. Empty means valid.
 *
 * The rules are the ones a coverage claim needs: an entry must be complete enough to DRIVE the
 * source (secret, model mechanics, peer, aiming), its capabilities and evidence must not contradict
 * each other, and a gap must carry a reason.
 */
export function validateCatalog(sources = SOURCES) {
    const problems = [];
    const ids = new Set();
    const artifacts = new Map();
    for (const source of sources) {
        const where = `source ${JSON.stringify(source.id)}`;
        if (!source.id || typeof source.id !== 'string') {
            problems.push('a source has no id');
            continue;
        }
        if (ids.has(source.id)) problems.push(`${where}: duplicate id`);
        ids.add(source.id);
        if (!source.label) problems.push(`${where}: no label`);
        if (!source.browserSource) problems.push(`${where}: no browserSource (the frontend chat_completion_source value)`);
        if (!source.pinnedRoute || !Object.values(PINNED_ROUTE).includes(source.pinnedRoute)) {
            problems.push(`${where}: pinnedRoute ${JSON.stringify(source.pinnedRoute)} is not one of ${Object.values(PINNED_ROUTE).join(', ')}`);
        }
        if (!['unsupported', 'capable-through-setting', 'capable-deliberately-unset'].includes(source.proxy)) {
            problems.push(`${where}: proxy ${JSON.stringify(source.proxy)} does not say whether the frontend offers a reverse proxy`);
        }
        const probe = source.probe ?? {};
        if (!('secretKey' in probe)) problems.push(`${where}: probe.secretKey is missing (null is allowed for a keyless source, absent is not)`);
        if (!probe.peer || !['openai', 'anthropic'].includes(probe.peer.protocol)) {
            problems.push(`${where}: probe.peer.protocol must be openai or anthropic`);
        }
        if (!probe.peer || !Object.values(PEER_CIRCUIT).includes(probe.peer.circuit)) {
            problems.push(`${where}: probe.peer.circuit must be ${Object.values(PEER_CIRCUIT).join(' or ')}`);
        }
        if (typeof probe.expectsModelsCall !== 'boolean') problems.push(`${where}: probe.expectsModelsCall must be a boolean`);
        if (typeof probe.noValidate !== 'boolean') problems.push(`${where}: probe.noValidate must be a boolean`);
        if (!Array.isArray(probe.seams)) {
            problems.push(`${where}: probe.seams must be an array (use [] for a source aimed by the request)`);
        } else {
            for (const seam of probe.seams) {
                if (!seam || !/^GOTAVERN_[A-Z0-9_]+_URL$/.test(String(seam.env))) {
                    problems.push(`${where}: seam ${JSON.stringify(seam)} is not a GOTAVERN_*_URL seam`);
                }
            }
        }
        if (!Array.isArray(probe.redirectFrom)) problems.push(`${where}: probe.redirectFrom must be an array`);
        // A source aimed at a pinned LITERAL must be able to reach the peer on both legs: either the
        // request carries it, or a seam plus a redirect exists. Anything else is a drive that would
        // reach the real provider.
        const carriesPeer = probe.customUrl === true || probe.reverseProxy === true;
        if (source.pinnedRoute === PINNED_ROUTE.DIRECT_LITERAL && !carriesPeer) {
            if ((probe.seams ?? []).length === 0 || (probe.redirectFrom ?? []).length === 0) {
                problems.push(`${where}: pinned literal with no request member must name both a seam and a redirect, or the leg can reach the real provider`);
            }
        }
        const capabilities = source.capabilities ?? {};
        for (const surface of ['generation', 'streaming', 'cancellation']) {
            if (typeof capabilities[surface] !== 'boolean') problems.push(`${where}: capabilities.${surface} must be a boolean`);
        }
        const evidence = source.evidence ?? {};
        for (const surface of ['generation', 'streaming']) {
            const file = evidence[surface];
            if (file && !artifacts.has(file)) artifacts.set(file, []);
            if (file) artifacts.get(file).push(source.id);
            if (file && capabilities[surface] !== true) {
                problems.push(`${where}: evidence.${surface} names ${file} but capabilities.${surface} is false, so the artefact is for a drive this catalog says cannot run`);
            }
        }
        if ((capabilities.generation || capabilities.streaming) && !evidence.generation && !evidence.streaming && !source.unproven) {
            problems.push(`${where}: claims a drivable surface with no committed artefact and no unproven reason`);
        }
        if (source.driveSupported === false && !source.unproven) {
            problems.push(`${where}: driveSupported false without an unproven reason`);
        }
        if (source.driveParameters !== null && typeof source.driveParameters !== 'function') {
            problems.push(`${where}: driveParameters must be a function of the leg report or null`);
        }
        for (const path of forbiddenKeyPaths(source)) {
            problems.push(`${where}: carries ${path}, which is expectation-shaped. This catalog is DRIVER-ONLY: an expectation here would be agreed to by the same document that produces the observation`);
        }
    }
    for (const [file, owners] of artifacts) {
        if (owners.length > 1) problems.push(`artefact ${file} is claimed by ${owners.join(' and ')}`);
    }
    return problems;
}

// Fail fast at import: a catalog that cannot describe its sources must not silently drive them.
const loadProblems = validateCatalog();
if (loadProblems.length > 0) {
    throw new Error(`tests/browser/sources.mjs is invalid:\n  - ${loadProblems.join('\n  - ')}`);
}

export const BY_ID = new Map(SOURCES.map(source => [source.id, source]));

/** The source for this PROBE_SOURCE value, or a named error listing what is drivable. */
export function sourceFor(id) {
    const source = BY_ID.get(id);
    if (!source) {
        const drivable = SOURCES.filter(entry => entry.driveSupported !== false).map(entry => entry.id).join(', ');
        throw new Error(`PROBE_SOURCE must be one of ${drivable}, got ${id}`);
    }
    if (source.driveSupported === false) {
        throw new Error(`PROBE_SOURCE=${id} is catalogued but not drivable by this probe: ${source.unproven}`);
    }
    return source;
}

/** The artefact a surface of a source is recorded into, or null when it has none. */
export function artifactFor(id, surface) {
    const source = BY_ID.get(id);
    if (!source) throw new Error(`no catalogued source ${id}`);
    return source.evidence?.[surface] ?? null;
}

/** Reverse lookup: which source does this artefact belong to. Used by the coverage test. */
export function sourceForArtifact(fileName) {
    for (const source of SOURCES) {
        for (const surface of ['generation', 'streaming']) {
            if (source.evidence?.[surface] === fileName) return { source, surface };
        }
    }
    return null;
}

/** Every seam env var any source can be aimed with, for cross-source naming checks. */
export const ALL_SEAM_ENVS = SOURCES.flatMap(source => (source.probe.seams ?? []).map(seam => seam.env));

/** Sources with committed evidence for a surface, in catalog order. */
export function sourcesWithEvidence(surface) {
    return SOURCES.filter(source => source.evidence?.[surface]);
}
