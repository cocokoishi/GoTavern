# Semantic Compatibility and Torture Test Plan

This document answers one question:

> How do we prove that GoTavern behaves like SillyTavern for real roleplay/preset/extension workflows, rather than merely proving that both servers can return text?

The pinned oracle is SillyTavern `1.19.0` at `06bde939fb1e9c4c8d8641d810f0a916b5bce127`.

## 1. Core principle

For a complex generation workflow, the most important artifact is not the final prose. It is the **effective request sent to the model provider** plus the **state transitions around it**.

Two backends can both return a fluent answer while differing in:

- prompt order;
- system/user/assistant role mapping;
- included history;
- world-info placement;
- Author's Note depth;
- token truncation;
- stop strings;
- tool schemas;
- reasoning flags;
- custom body/header overrides;
- persisted chat metadata.

Those differences are compatibility bugs even if a casual user sees “a reply”.

---

## 2. Four-observer differential harness

Every semantic scenario runs twice from equivalent isolated fixtures:

```text
real pinned frontend -> Node SillyTavern -> recording/mock provider
real pinned frontend -> GoTavern        -> recording/mock provider
```

Capture and compare four observers.

### Observer A — browser -> backend

Capture:

- HTTP path/method/query;
- selected browser headers;
- JSON/multipart body;
- CSRF/session behavior;
- request timing/order for multi-request workflows.

Purpose: prove both runs start from equivalent browser state and reveal backend-induced frontend divergence before generation.

### Observer B — backend -> provider

Capture exactly what reaches the deterministic mock provider:

- target path/query/method;
- headers after secret-value redaction;
- JSON/body fields and field presence;
- message arrays and roles;
- stop sequences;
- token/sampler parameters;
- model/provider choice;
- tools/tool_choice/schema;
- reasoning/thinking parameters;
- multimodal parts;
- custom include/exclude body and headers;
- streaming flag;
- reverse-proxy/custom endpoint transformations.

This is the strongest semantic oracle for prompt equivalence.

### Observer C — provider -> backend -> browser

The mock provider emits deterministic responses, including deliberately fragmented streaming sequences. Compare:

- server status/content type;
- browser-parsed SSE/events;
- token/reasoning/tool-call accumulation;
- error forwarding;
- `[DONE]`/terminal behavior where applicable;
- first-flush behavior;
- abort propagation;
- final visible generated message.

### Observer D — persistent/browser state

After each workflow compare:

- chat JSONL;
- settings/world/preset files;
- chat metadata/local variables;
- global variables/settings;
- card/world mutations;
- backups that upstream creates;
- active browser state;
- emitted frontend events and payload shapes;
- state after a full page reload.

Unknown differences fail the scenario until classified.

---

## 3. Normalization policy

Differential testing is only useful if normalization is narrow.

Allowed examples:

- random CSRF token values;
- cryptographic session signatures when semantic equivalence is tested separately;
- generated timestamps explicitly proven nondeterministic;
- temporary filenames;
- provider test keys after preserving header presence/scheme.

Not allowed:

- deleting unknown JSON fields globally;
- sorting every object/array “because ordering is annoying”;
- ignoring all cache/backup files without inventory;
- stripping errors/statuses;
- dropping request fields because both providers happen to accept them.

Every normalization rule lives next to the test with a written reason.

---

## 4. Complex preset torture fixture

Maintain at least one synthetic “kitchen sink” character/user fixture specifically designed to make semantic drift obvious.

It should include all applicable pinned-baseline features below.

### 4.1 Prompt Manager / Chat Completion state

Exercise:

- many prompt entries with distinctive marker strings;
- enabled and disabled prompts;
- system/user/assistant-role entries;
- custom ordering;
- main prompt;
- auxiliary/post-history prompts;
- character description/personality/scenario;
- example dialogue;
- persona content;
- group nudge where applicable;
- empty and omitted values that differ semantically;
- provider preset fields with non-default values.

Each marker is unique so provider-wire snapshots make ordering/inclusion easy to diagnose.

### 4.2 Advanced Formatting templates

Cover independent and combined use of:

- instruct templates;
- context templates;
- system prompt templates;
- reasoning templates;
- sequence/prefix/suffix formatting;
- names/roles/stop sequences affected by templates.

The test should assert the final provider request, not merely the template files themselves.

### 4.3 World Info

Use deterministic entries with unique markers and cover supported baseline semantics including:

- before/after character definitions where applicable;
- Author's Note-related positions;
- depth-based insertion;
- ordering;
- primary keys;
- secondary/selective keys;
- recursive activation;
- deterministic probability cases (use 100%/0% when randomness is not the subject);
- token budget pressure;
- outlets/macros where supported;
- disabled entries;
- multiple books/character-linked/global state as applicable.

Assertions include which entries reach the provider and in what relative order.

### 4.4 Author's Note

Test multiple configured depths/positions using unique marker content. Include enough chat history that an off-by-one insertion depth changes the provider message list.

### 4.5 Macros

Use representative macros that depend on character/user/chat/world state and verify expansion in the final prompt. Include literal escaping/empty values where upstream behavior is nontrivial.

### 4.6 STscript and variables

Exercise:

- local variables;
- global variables;
- chat metadata persistence;
- pipes;
- nested slash commands;
- get/set/increment-like variable operations supported by the pinned frontend;
- reload and re-evaluation;
- scripts that mutate world info or other normal frontend state.

Compare final state and saved files, not only script return text.

### 4.7 Quick Replies

Include manual and applicable auto-execution paths, nested STscript, variables and generation calls. Verify execution order and post-reload persistence.

### 4.8 Regex / text transformations

Exercise configured transforms over the relevant scopes supported by the pinned frontend: user input, model output, slash/generated text, world/prompt content and reasoning where applicable.

Tests should catch both missing application and accidental double application.

---

## 5. Generation-mode matrix

Run representative complex state through each supported generation mode that changes prompt construction or persistence:

- normal send;
- regenerate;
- swipe/new candidate;
- continue;
- impersonate;
- quiet/background generation;
- raw/helper generation exposed by frontend/extensions;
- group-chat generation;
- non-streaming;
- streaming.

For each mode compare provider-wire request and persisted final state.

---

## 6. Provider matrix

Use deterministic local provider emulators. Do not spend real API credits in CI.

### 6.1 OpenAI-compatible

Cover:

- normal chat completions;
- custom base URL;
- custom Authorization/header configuration;
- model selection;
- temperature/top_p/top_k/frequency/presence fields where supported;
- stop strings;
- max token fields;
- stream/non-stream;
- tool calling;
- JSON schema / structured output;
- reasoning-style fields used by current baseline;
- multiple candidates/swipes where applicable.

### 6.2 Anthropic/Claude

Cover provider-specific role/system conversion, headers/version fields, streaming content/reasoning/tool events and token-limit mapping.

### 6.3 Google/Gemini

Cover system instructions, safety/provider options used by baseline, candidate/parts layout, thoughts/reasoning, function calls and inline/multimodal content where applicable.

### 6.4 OpenRouter

Cover model/provider routing fields and headers/options that SillyTavern adds or transforms.

### 6.5 Custom endpoint

This is especially important for Tavern Helper and advanced users. Cover:

- custom URL;
- custom model;
- proxy password/key;
- `custom_include_body`;
- `custom_exclude_body`;
- `custom_include_headers`;
- YAML parsing/merging semantics;
- explicit parameter unset/default behavior;
- streamed response parsing.

### 6.6 Text completion / Kobold-style backends

Maintain equivalent wire snapshots for representative text-completion backend families, including prompt string construction and stop/sampling fields.

---

## 7. Token-budget boundary suite

Approximate tokenizer parity is not enough.

Construct fixtures at thresholds where a one-token difference changes observable behavior:

1. last history message barely fits;
2. last history message barely does not fit;
3. a world-info entry barely fits;
4. Author's Note inclusion competes with history;
5. examples are truncated at a boundary;
6. CJK/emoji/special-token text changes counts significantly;
7. provider-specific tokenizer selection changes based on configured model.

Assert both token count endpoints and the resulting provider message/prompt payload.

---

## 8. Streaming torture suite

The mock provider should intentionally fragment logical content across awkward network chunks.

Scenarios:

- one SSE line split across transport reads;
- several SSE events in one read;
- CRLF and LF framing accepted as upstream frontend expects;
- normal text deltas;
- reasoning/thinking deltas;
- tool-call arguments split across events;
- multimodal/provider-specific delta forms where supported;
- empty keepalive/comment-like chunks if the provider path accepts them;
- `[DONE]` termination;
- provider closes without expected sentinel;
- provider error before first token;
- provider error mid-stream;
- malformed JSON event;
- client abort before first token;
- client abort mid-stream.

Compare parsed event sequence and final state. Do not require identical TCP packet boundaries unless frontend behavior actually depends on them.

---

## 9. Settings/preset state suite

Because `/api/settings/get` aggregates many directories, maintain a fixture containing:

- multiple provider presets with sortable names;
- invalid JSON file that upstream skips;
- worlds;
- themes;
- moving UI presets;
- Quick Replies;
- instruct/context/system/reasoning presets;
- extension/account/request-compression config states.

Compare exact response field names/types/ordering semantics and follow with real frontend preset selection.

Also test settings save + backup throttling/snapshot APIs using an isolated clock/filesystem where practical.

---

## 10. Character/card suite

Fixtures include:

- JSON character;
- PNG card V1/V2/V3 cases used by baseline;
- unknown extension metadata;
- alternate PNG chunks;
- sprites;
- linked world info;
- unusual Unicode names;
- filenames requiring sanitization;
- duplicate/rename/import/export/edit/merge operations.

Run Node -> Go -> Node mutation cycles and compare semantic metadata. Ensure unrelated PNG chunks/image payload are preserved when the upstream operation preserves them.

---

## 11. Chat/group suite

Cover:

- normal chat JSONL;
- long chat;
- metadata-rich chat;
- swipes;
- reasoning/tool metadata if stored by the frontend;
- rename/delete/export/import;
- group chat metadata and member state;
- backups/integrity behavior;
- concurrent saves to distinct chats and same chat.

A read must not rewrite a file merely because Go parsed it.

---

## 12. Real Tavern Helper acceptance

Pinned gate revision:

```text
N0VI028/JS-Slash-Runner@837a6288135cde61522a9279173b98020f08807e
```

Do not patch the extension.

### Installation/lifecycle

Test:

- install through normal SillyTavern extension API/UI;
- manifest discovery;
- static asset/module import;
- browser reload;
- version/update/branch operations;
- delete/reinstall;
- no unexpected console errors or failed requests.

### CRUD/state

Exercise extension code paths that touch standard backend behavior, including:

- character create/edit/import;
- persona/avatar upload/delete;
- settings retrieval;
- lorebook/world info operations;
- variable/state persistence;
- rendered cards/UI state followed by reload.

### Generation

Tavern Helper currently performs deep generation integration. Test at least:

- helper/raw generation;
- custom OpenAI-compatible endpoint;
- streamed normal text;
- streamed reasoning;
- tool calling with split deltas;
- JSON/tool schema;
- event emissions around generation;
- abort/cancel;
- final saved state.

Capture the request arriving at `/api/backends/chat-completions/generate` and, more importantly, the final request GoTavern sends to the mock provider. Compare with Node.

### Route coverage

Maintain `docs/extension-route-coverage.md` from both static scans and dynamic browser capture. A route observed from the pinned extension but missing from the Go inventory is a release failure.

---

## 13. LittleWhiteBox acceptance and explicit boundary

Pinned probe revision:

```text
RT15548/LittleWhiteBox@9e71caef9ba7b3ca324ce9f1cb06a69ff54d734b
```

The frontend exercises standard SillyTavern APIs such as file upload, world-info access, group state and SD proxy endpoints. Those standard-API workflows must work unmodified and are valuable compatibility probes.

The repository also contains a Node server plugin named `littlewhitebox-server`, mounted under `/api/plugins/littlewhitebox-server/`, which implements separate capabilities such as background image/draw jobs and Exa proxying.

Arbitrary Node server plugins are an explicit GoTavern non-goal. Therefore the acceptance report must separate:

- **required:** LittleWhiteBox frontend functions using standard built-in SillyTavern frontend/backend APIs;
- **excluded:** features that demonstrably require `littlewhitebox-server`;
- **failure:** a standard built-in API path that works on Node but fails on Go.

Never create fake plugin endpoints to make a superficial smoke test green.

---

## 14. Startup/fresh-install semantics

Semantic tests begin before HTTP serving.

Maintain fixtures for:

- empty runtime;
- current config/data;
- config missing new default keys;
- config using deprecated keys;
- legacy data cases covered by pinned startup migrations;
- multi-user state;
- preexisting default-content names;
- `skipContentCheck` states;
- user CSS override;
- custom error page/override state;
- dirty `_uploads` cleanup case.

Run Node and Go once, stop them, then compare destination state before doing browser tests.

Account recovery is a persistent mutation. Compare the recovery-code log and
five-minute cache, IP limiter results, password hash/salt, unknown user fields,
the updated session version, and a Node→Go→Node node-persist round trip.

---

## 15. Failure semantics

Happy paths miss many extension assumptions. Add differential cases for:

- missing/invalid body;
- invalid multipart field/filename;
- duplicate extension directory;
- extension manifest missing/invalid;
- non-admin global extension operation;
- invalid CSRF;
- expired/missing login;
- Basic Auth failure/rate limit;
- account recovery with missing, unknown, disabled, incorrect-code, expired-code,
  and rate-limited requests;
- provider 400/401/429/500;
- DNS/connect timeout;
- request-proxy failures;
- blocked private address;
- disk permission/read/write failure where reproducible;
- malformed card/chat/world JSON;
- missing files;
- client disconnect.

Compare exact status/body/side effects rather than merely expecting “an error”.

---

## 16. Browser instrumentation

Playwright runs the real pinned frontend and records:

- console errors/warnings (with narrow allowlist only);
- page errors;
- failed network requests;
- dynamic import failures;
- selected `eventSource` events and payload summaries;
- UI state checkpoints;
- localStorage/IndexedDB only when the workflow legitimately depends on them;
- generation request/response timing checkpoints.

No hidden frontend patch may be used to make GoTavern tests pass. Test-only instrumentation is injected from Playwright/devtools hooks without changing the shipped `public/**` tree.

---

## 17. Pass criteria

A semantic scenario is green only when all applicable observers match the pinned Node baseline after documented nondeterministic normalization.

Examples of **not sufficient** evidence:

- HTTP 200;
- UI loaded;
- model returned text;
- Tavern Helper icon appeared;
- character file exists;
- token counts are “very close”.

Examples of meaningful evidence:

- identical effective provider message order and fields;
- same world-info entries inserted at the same place;
- context-boundary selection matches exactly;
- same tool schema/reasoning/custom-body request reaches provider;
- same stream event semantics reach the frontend;
- same variables/chat metadata survive reload;
- Node can read and further mutate Go-written data without loss.

That is the standard required before the project calls itself drop-in compatible.
