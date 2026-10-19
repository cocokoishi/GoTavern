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

The settings snapshot routes are persistent file operations. Compare per-user
snapshot prefixes, list response order and date/name/size values, load and
restore validation, not-found responses, exact UTF-8 bytes, timestamped manual
backup creation, configured retention, a missing-settings no-op, and unchanged
account records. The `settings-snapshots` oracle normalizes change times and
generated timestamp text only. It also checks that Node reads a Go-created
snapshot and Go restores a Node-created snapshot. `settings/get` and
`settings/get` has its own oracle for raw settings, provider preset names and
contents, valid-JSON-only preset aggregation, world names, config flags, and
request-compression values. The response body and ETag match; pinned Node uses
gzip/chunked framing that Go does not yet reproduce. Locale edge ordering,
JavaScript stringify edge cases, and filesystem failures remain unprobed.
The `settings/save` oracle checks parsed request JSON, JavaScript's four-space
stringification (including numeric-key and number formatting), authenticated
responses, atomic settings writes, the immediate duplicate-aware snapshot, and
the no-snapshot window for a second save inside the ten-minute throttle. A Go
test exercises the trailing snapshot with the latest settings body. Its
round-trip probe sends a save through GoTavern and reads the same file through
the pinned Node `/api/settings/get` route. Malformed and oversized bodies,
filesystem failures, and real ten-minute timing remain unprobed.

The Quick Replies oracle covers authenticated save and delete, JSON formatting,
name truthiness/coercion, `sanitize-filename@1.6.3` illegal/control-character
removal, Unicode byte truncation, overwrite/removal state, and missing-name or
missing-file responses. It also verifies that the pinned Node aggregation route
reads a Quick Reply written by GoTavern. The deprecated save/delete paths keep
their POST method through 308 redirects. Reserved names that sanitize to an
empty path, trailing-character edges, malformed body-parser responses, alias
subpaths/warnings, symlink or directory targets, and filesystem failures remain
unprobed.

The themes oracle covers authenticated save/delete, the 404 for a missing theme, JSON formatting, filename coercion and sanitization, Unicode truncation, overwrite/removal state, the deprecated POST-preserving 308 save redirect, and unchanged account data. It also verifies that pinned Node reads a Go-created theme through /api/settings/get. Reserved names that sanitize to an empty path, malformed body-parser responses, alias subpaths/warnings, symlink or directory targets, and filesystem failures remain unprobed.

The moving UI oracle covers authenticated preset save, JSON formatting, name coercion and sanitization, Unicode truncation, overwrite state, missing/falsy-name responses, the deprecated POST-preserving 308 redirect, and unchanged account data. It verifies that pinned Node reads a Go-written moving UI preset through /api/settings/get. Browser selection and settings-debounce state are outside this API probe. Reserved names that sanitize to an empty path, malformed body-parser responses, alias subpaths/warnings, symlink targets, and filesystem failures remain unprobed.

The user-avatar oracle covers authenticated listing, pinned mime-db 1.54.0 image-extension filtering, en-US Intl.Collator order, hidden-file and directory behavior, response headers, and the legacy method-preserving 308 redirect. The API does not mutate avatar files or account data. Permission failures, other platform locale settings, symlink entries, and non-image MIME edge cases remain unprobed.

The persona-avatar delete oracle covers the avatar field validator, sanitize-filename rejection, deletion plus persona-thumbnail invalidation, authenticated/CSRF responses, the deprecated 308 alias, and resulting file state. Its cross-process round trip sends a delete through GoTavern and confirms the pinned Node /api/avatars/get route no longer lists that avatar. Go serializes the file removals under the shared user-data lock; malformed/URL-encoded bodies and filesystem/symlink failures remain gaps.

The Expressions sprite-list oracle covers authenticated GET /api/sprites/get requests, image-only extension filtering, derived labels, second-resolution modification-time URLs, character subfolders, missing/invalid paths, and unchanged character/account data. It compares the complete JSON response and stable HTTP headers with pinned Node. Browser rendering and retrieval of the returned /characters/... paths remain a separate extension/static-asset probe; extended query-object coercion, unusual Unicode casing, cross-platform directory-enumeration order, symlinks, and filesystem races remain unprobed. The sprite-delete oracle covers authenticated/CSRF-protected exact-basename deletion across extensions, spriteName-or-label selection, nested folders, missing/invalid requests, and post-operation file state. Go locks the data root and removes matching entries one at a time; URL-encoded/malformed request-body parsing, symlink containment, and error/partial-delete ordering remain gaps.

The background-folder oracle covers authenticated/CSRF-protected POST /api/backgrounds/folders reads of the pinned `image-metadata.json` format and GET/HEAD wrong-method 404 responses. It compares folder passthrough, filename-only assignment keys (including basename collisions and trailing slashes), omitted empty assignments, malformed-file fallback, falsey folder fallback, array-valued `images`, missing/null `images` errors, and unchanged metadata/account files. The same Node fixture covers authenticated/CSRF-protected POST /api/image-metadata/folders/get, GET/HEAD wrong-method 404s, and the route's folder-value passthrough/fallback/error behavior for each index shape. The Go handlers follow JavaScript property enumeration and JSON number/string serialization. The full browser organizer flow, thumbnail assignment writes, static background rendering, and filesystem permission/race failures remain unprobed.

The CORS oracle exercises pinned `cors@2.8.5` through the real Node listener. It captures configured allowed and denied origins for preflight and actual responses, custom methods/headers/credentials/exposed headers/max-age, preflights without an Origin header, and preflight handling on an unregistered route. Go applies the same CORS middleware before auth and route dispatch; YAML/environment values are carried through command-line configuration. With CORS disabled, the oracle records a known divergence: pinned Express automatically answers OPTIONS on registered routes with status 200 and an `Allow` header, while Go currently returns 404. Malformed/wildcard configuration, body-parser failures that precede CORS, and remaining header/coercion edge cases remain to be probed.

The same metadata-index oracle covers authenticated/CSRF-protected POST /api/image-metadata/all plus GET/HEAD wrong-method 404s. It compares the full index passthrough and prefix filtering, including JavaScript coercion for falsey, numeric, array, object, and shadowed-`toString` prefixes; JavaScript ordering/serialization; null and malformed index behavior; and unchanged index/account files. URL-encoded, missing-content-type, malformed/primitive JSON, and oversized body handling remain gaps.

The image-metadata folder-create oracle covers POST /api/image-metadata/folders/create authentication, CSRF, GET/HEAD 404s, missing/non-string names, JavaScript whitespace trimming, duplicate names, UUIDv4 shape, missing/malformed index fallback, malformed folder-shape errors, and exact four-space index persistence with unknown-field retention. Go serializes writes under the shared user-content lock and uses atomic replacement. Its cross-process round trip creates a folder through GoTavern and reads the resulting folder list and full index through pinned Node. URL-encoded/malformed request-body parser responses and filesystem failure/race cases remain unprobed.

The image-metadata thumbnail oracle covers POST /api/image-metadata/folders/set-thumbnails authentication, CSRF, GET/HEAD 404s, batch validation, strict ID comparisons, duplicate updates, skipped unknown folders, malformed index fallback and shape errors, and exact four-space index persistence with unknown-field retention. Go serializes batch updates under the shared user-content lock and uses atomic replacement. Its cross-process round trip updates a folder through GoTavern and reads the resulting folder list and full index through pinned Node. URL-encoded/malformed request-body parser responses and filesystem failure/race cases remain unprobed.

The image-metadata folder-update oracle covers POST /api/image-metadata/folders/update authentication, CSRF, GET/HEAD 404s, string-ID validation, first-match updates, assignment of arbitrary JSON values to `name` and `thumbnailFile`, not-found responses, malformed index fallback and shape errors, and exact four-space persistence with unknown-field retention. Go serializes updates under the shared user-content lock and uses atomic replacement. Its cross-process round trip renames a folder and changes its cover through GoTavern, then reads the resulting folder list and full index through pinned Node. Express emits a dynamic HTML syntax error for primitive JSON such as `null` while Go returns plain `Bad Request`. URL-encoded/malformed parser responses and filesystem failure/race cases still need broader coverage.

The image-metadata folder-delete oracle covers POST /api/image-metadata/folders/delete authentication, CSRF, GET/HEAD 404s, string-ID validation, first-match folder removal, removal of the first matching folder ID from each image, duplicate IDs, array/object image collections, malformed index fallback and shape errors, and exact four-space persistence with unknown-field retention. Go serializes deletion under the shared user-content lock and uses atomic replacement. Its cross-process round trip deletes a folder through GoTavern and reads the updated folder list and full index through pinned Node. Parser responses and filesystem failure/race cases remain incomplete.

The image-metadata assignment oracle covers POST /api/image-metadata/folders/assign and `/unassign` authentication, CSRF, GET/HEAD 404s, ID/path validation, POSIX normalization and traversal checks, missing-file skips, folder existence ordering, metadata stub creation, deduplicated assignment, one-at-a-time removal, raw unassign keys, malformed metadata shapes, and exact four-space persistence with unknown-field retention. Both handlers use the shared user-content lock and atomic replacement. Go assign and unassign operations are read back through pinned Node. Parser responses, remaining filesystem failures/races, and browser `imageFolderMap` state updates remain incomplete.

The image-metadata cleanup oracle covers POST /api/image-metadata/cleanup authentication, CSRF, GET/HEAD 404s, missing files, lexically out-of-user-root paths, object and array image collections, malformed roots, exact removed-key order, and exact four-space persistence. Cleanup uses the shared user-content lock and atomic replacement only when entries are removed; a no-op preserves index bytes, existence, and mtime. Its Go cleanup is read back by pinned Node. Malformed request-body parsing, filesystem permission/race behavior, and some primitive image-index shapes remain incomplete.

The image-metadata read oracle covers POST /api/image-metadata authentication, CSRF, GET/HEAD 404s, cached single and batch values, exact Node-compatible mtime matching, missing files, outside-root paths, path/paths selection and validation, malformed metadata-index shapes, root trailing-slash behavior, unknown-subpath routing, and unchanged account state. Cached JSON is returned without rewriting it, preserving unknown metadata fields. Go generation is probed for PNG, JPEG, and GIF, including SHA-256, dimensions, animation, average color, creation-time selection, thumbnail resolution, stale metadata replacement, folder-ID retention, atomic persistence, and a Go-write/Node-readback round trip. The known BMP probe succeeds in Node but returns an explicit unsupported-format response in Go; other image decoders and custom thumbnail dimensions are incomplete. Express body-parser syntax errors and non-string path coercions remain incomplete.

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

Admin account creation also changes persistent data and the user content tree.
Compare lodash-based handle normalization, duplicate detection, optional
password hashing and salt generation, the exact node-persist record fields,
all user directories, global defaults, and every per-user seeded file. The
`account-create` oracle includes accent, ligature, combining-mark, non-Latin,
array, object, and numeric slug inputs.

Resetting user settings is also a persistent mutation. Compare protected-user
password verification and passwordless-user behavior, the settings file before
and after failure/success, forced settings reseeding when normal content checks
are skipped, repeated resets, unrelated per-user files, the shared content log,
and unchanged account records. The `account-reset-settings` oracle pins the
startup stats timestamp and includes the system-prompt migration marker so the
whole user-tree comparison isolates the route effects deterministically.

Resetting all user data is another persistent mutation. Compare the logged
six-digit code and its replacement, password and code failures, the per-user
five-minute cache, shared per-IP rate-limit state and `Retry-After`, recursive
user-tree deletion, directory recreation, default-content reseeding, account
record retention, and successful cleanup of code/limiter state. The
`account-data-reset` oracle uses separate protected and passwordless accounts
and normalizes startup-only settings-backup names and stats timestamps.

Full-account backup is a read-only archive operation. Compare the feature gate,
missing-handle response, self/admin authorization, ZIP attachment headers,
included hidden files and empty directories, secret-file exclusions with
`allowKeysExposure` both disabled and enabled, every archived path and file
digest, and unchanged account records and source trees. The
`account-backup` oracle exercises admin and passwordless self-service accounts;
malformed handle/body types, traversal, symlinks, and filesystem/archive errors
remain unprobed.

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
