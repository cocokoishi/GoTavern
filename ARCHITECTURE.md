# GoTavern Architecture

> A standalone, low-memory Go reimplementation of the SillyTavern **server/backend**, while serving the **unmodified upstream SillyTavern frontend** and preserving SillyTavern's on-disk data formats and browser-visible HTTP contract.

## 0. Status and compatibility baseline

GoTavern is a compatibility implementation, not a redesign.

The initial compatibility baseline is pinned to:

- Upstream repository: `SillyTavern/SillyTavern`
- Upstream branch used to select the baseline: `release`
- SillyTavern version: **1.19.0**
- Baseline commit: **`06bde939fb1e9c4c8d8641d810f0a916b5bce127`**
- License: **AGPL-3.0**

The SHA is the normative baseline. A branch name is not a sufficient compatibility target because `release` moves.

Primary upstream sources of truth:

- `src/server-main.js`
- `src/server-startup.js`
- `src/users.js`
- `src/constants.js`
- `src/endpoints/**`
- `src/middleware/**`
- `src/request-proxy.js`
- `src/private-request-filter.js`
- `default/config.yaml`
- `public/**`
- `webpack.config.js`

TauriTavern (`Darkatse/TauriTavern`) is a useful architectural reference for the idea of keeping SillyTavern compatibility while replacing the backend, but **GoTavern must not copy Tauri-specific host APIs or treat TauriTavern behavior as normative**. SillyTavern at the pinned SHA is the oracle.

---

## 1. Definition of “compatible”

A feature is compatible only when all externally observable behavior used by the upstream frontend or frontend extensions matches the pinned SillyTavern baseline closely enough for differential tests to pass.

Compatibility includes:

1. HTTP method and path.
2. Query parsing and parameter defaults.
3. Request body parsing, including JSON, URL-encoded forms and multipart uploads.
4. Upload field names and filename handling.
5. Authentication requirements and redirect behavior.
6. CSRF behavior.
7. Response status code.
8. Response headers when browser-observable or relied upon by clients.
9. JSON field names, nesting, types, nullability, omitted fields and array ordering where observable.
10. Text/binary response bodies.
11. Error status and error body shape.
12. Redirect status and `Location` behavior.
13. Streaming behavior, including chunk boundaries where semantically relevant, SSE framing, `[DONE]`-style sentinels where applicable, flushing and cancellation.
14. Static/user-resource URL behavior.
15. File layout and file formats.
16. Character card metadata semantics, including V1/V2/V3 and PNG metadata.
17. Authentication/session persistence semantics.
18. Extension installation/update/delete and static loading behavior.
19. Outbound provider request behavior that is observable by providers or affects generated responses.
20. Deprecated endpoint redirects still present in the baseline.

“Returns approximately the same data” is not sufficient.

### Explicit non-goal

Node.js **server plugins** are not supported. They execute server-side JavaScript against Node/SillyTavern internals and are outside the browser-compatible HTTP/data contract. They must be reported as unsupported, never silently ignored or emulated incompletely.

Everything else shipped as a built-in browser-visible SillyTavern feature remains in scope until the compatibility matrix says otherwise.

---

## 2. Architectural invariants

These are hard constraints. An implementation that violates them is not an acceptable shortcut.

### 2.1 The frontend is upstream SillyTavern

GoTavern MUST NOT rewrite, fork, transpile by hand, or maintain a parallel implementation of the SillyTavern UI.

The source frontend tree must be byte-for-byte the pinned upstream `public/**` tree, excluding only generated artifacts that upstream itself produces at build/start time.

Release builds embed the pinned frontend into the Go binary with `go:embed`, so production does not require Node.js or a separate frontend directory.

A CI guard must compare the vendored frontend manifest against the pinned upstream SHA. Any changed frontend byte fails CI unless the baseline SHA is intentionally updated.

Third-party extensions are **writable overlays**, not modifications to the embedded upstream frontend. Requests under the upstream third-party extension URL are resolved using the same precedence/semantics as upstream.

### 2.2 No invented compatibility API

Do not add browser compatibility endpoints because they seem convenient. Every route in the SillyTavern compatibility namespace must trace to the pinned upstream source or to a documented compatibility requirement discovered by capture/differential testing.

GoTavern-specific operational endpoints, if eventually needed, must live under a clearly separate namespace such as `/gotavern/*` and must never be required by the upstream frontend.

### 2.3 Disk data remains SillyTavern data

The canonical user data is the SillyTavern filesystem layout. There is no GoTavern database migration layer in front of it.

GoTavern must be able to:

- start directly against an existing compatible SillyTavern `config.yaml` and data root;
- stop, then allow the original SillyTavern Node server to start against the same files;
- read files produced by SillyTavern;
- write files SillyTavern can read;
- preserve unknown JSON/card fields unless the upstream endpoint itself intentionally replaces the complete object.

Do not introduce SQLite as the source of truth for chats, characters, settings, users, extensions, worlds, presets or secrets.

### 2.4 One compatibility oracle

If documentation, TauriTavern, memory, an old SillyTavern version and current source disagree, the pinned SillyTavern source and observed behavior win.

When behavior is unclear, write a probe against Node SillyTavern first.

### 2.5 No silent degradation

A route is one of:

- `compatible`
- `partial` with an exact documented difference
- `unsupported` with a reason
- `not implemented`

Never return fake success for missing behavior. Never substitute another provider/tokenizer/format and mark the endpoint compatible without a differential test proving equivalence.

---

## 3. Upstream server surface that must be mirrored

At the baseline SHA, the private router composition includes these mounted namespaces (see `src/server-startup.js`):

```text
/
/api/users
/api/moving-ui
/api/images
/api/quick-replies
/api/avatars
/api/themes
/api/openai
/api/google
/api/anthropic
/api/tokenizers
/api/presets
/api/secrets
/thumbnail
/api/novelai
/api/extensions
/api/assets
/api/files
/api/characters
/api/chats
/api/groups
/api/worldinfo
/api/stats
/api/backgrounds
/api/sprites
/api/content
/api/settings
/api/sd
/api/horde
/api/vector
/api/translate
/api/extra/classify
/api/extra/caption
/api/search
/api/backends/text-completions
/api/openrouter
/api/nanogpt
/api/backends/kobold
/api/backends/chat-completions
/api/speech
/api/azure
/api/volcengine
/api/minimax
/api/data-maid
/api/backups
/api/image-metadata
```

This list is not the API inventory. Phase 0 must enumerate every method + route under every router, plus routes declared outside `src/endpoints/**`.

Important top-level behavior from `src/server-main.js` also includes, at minimum:

- `/`
- `/login`
- `/callback/:source?`
- `/csrf-token`
- `/api/ping`
- `/proxy/:url(*)`
- `/version`
- public `/api/users` routes before login enforcement
- static upstream frontend files
- authenticated user-resource serving
- deprecated route redirects with **308** where upstream uses 308

User data is also exposed through browser paths such as:

```text
/backgrounds/*
/characters/*
/User%20Avatars/*
/assets/*
/user/images/*
/user/files/*
/scripts/extensions/third-party/*
```

The exact list and path decoding rules must be generated into `docs/api-inventory.md` from source analysis and validated by probes.

---

## 4. Repository layout

Target layout:

```text
GoTavern/
├── cmd/
│   ├── gotavern/                 # main server binary
│   └── gotavern-migrate/         # optional Go migration/copy utility once implemented
├── internal/
│   ├── app/                      # composition root and lifecycle
│   ├── compat/                   # compatibility contracts/helpers, no concrete IO
│   │   ├── httpcontract/
│   │   ├── errors/
│   │   └── version/
│   ├── config/                   # config.yaml compatibility projection
│   ├── httpserver/
│   │   ├── router/
│   │   ├── middleware/
│   │   ├── static/
│   │   └── response/
│   ├── auth/                     # basic auth, accounts, sessions, CSRF
│   ├── userdata/                 # data-root and user-directory abstraction
│   ├── storage/
│   │   ├── atomicfile/
│   │   ├── jsonfile/
│   │   ├── jsonl/
│   │   ├── pngcard/
│   │   └── locks/
│   ├── endpoints/                # modules aligned to upstream router modules
│   │   ├── characters/
│   │   ├── chats/
│   │   ├── groups/
│   │   ├── worldinfo/
│   │   ├── settings/
│   │   ├── extensions/
│   │   ├── providers/
│   │   └── ...
│   ├── outbound/                 # shared HTTP transport/proxy/SSRF policy
│   ├── providers/                # OpenAI/Claude/Gemini/etc adapters
│   ├── tokenizers/
│   ├── extensions/               # git/repository operations and extension FS
│   ├── media/
│   └── observability/
├── upstream/
│   ├── SILLYTAVERN_VERSION
│   ├── SILLYTAVERN_COMMIT
│   ├── public/                   # byte-identical upstream public tree
│   ├── generated/                # build-time upstream-generated assets such as lib.js
│   └── public.sha256             # generated tree manifest
├── tools/
│   ├── sync-upstream/            # deterministic baseline/vendor updater
│   ├── inventory/                # route inventory extractor
│   └── contract-runner/          # Node vs Go differential test harness
├── tests/
│   ├── contract/
│   ├── roundtrip/
│   ├── e2e/
│   ├── fixtures/
│   └── benchmarks/
├── scripts/
│   └── migrate-from-sillytavern.sh
├── docs/
│   ├── api-inventory.md
│   ├── compat-matrix.md
│   ├── migration.md
│   ├── testing.md
│   └── reports/
├── ARCHITECTURE.md
├── AGENTS.md
├── Dockerfile
├── go.mod
└── LICENSE
```

Do not over-generalize endpoint code into a framework before route parity exists. Keeping endpoint packages visibly aligned with upstream modules makes source comparison and review easier.

---

## 5. Runtime root and direct-use mode

GoTavern's default runtime root is its working directory.

Expected compatibility files include:

```text
<runtime-root>/
├── config.yaml
├── data/                         # default dataRoot
│   ├── _storage/                 # upstream user/account node-persist data
│   ├── cookie-secret.txt
│   ├── default-user/
│   └── <other users>/
└── public/
    └── scripts/extensions/third-party/   # optional global writable extension overlay
```

`dataRoot` comes from `config.yaml` exactly as upstream resolves it. `./data` is only the default.

Two supported deployment modes are required:

### Direct-use mode

Point GoTavern at an existing SillyTavern runtime root and use its `config.yaml` + data root in place. The Node process must be stopped before GoTavern writes to that root.

### Copy-migration mode

Copy an existing installation to a new GoTavern runtime root with a migration tool/script. The source is treated as read-only. Rollback means stopping GoTavern and starting Node SillyTavern on the untouched source, or copying compatible data back after making a backup.

The copy tool must not rename, delete, chmod, rewrite, “upgrade”, migrate or clean the source.

---

## 6. SillyTavern user directory contract

The baseline `USER_DIRECTORY_TEMPLATE` contains these paths under each user root and must be represented without renaming:

```text
thumbnails/
thumbnails/bg/
thumbnails/avatar/
thumbnails/persona/
worlds/
user/
User Avatars/
user/images/
groups/
group chats/
chats/
characters/
backgrounds/
NovelAI Settings/
KoboldAI Settings/
OpenAI Settings/
TextGen Settings/
themes/
movingUI/
extensions/
instruct/
context/
QuickReplies/
assets/
user/workflows/
user/files/
vectors/
backups/
sysprompt/
reasoning/
```

The exact names, spaces and capitalization are contract data.

The data root also contains non-user state such as `_storage`, `cookie-secret.txt`, temporary upload state and generated caches. Phase 0 must classify every baseline data-root entry as canonical, cache, temporary or compatibility-sensitive before any cleanup policy is implemented.

---

## 7. HTTP server architecture

### 7.1 Router

Use Go's standard `net/http` plus a small router with deterministic path semantics (for example `chi` if its behavior is explicitly wrapped/tested). The selected router must not leak its own automatic redirects, path cleaning, OPTIONS behavior or error body formats where they differ from Express.

Every route registration must include contract metadata used by tests and inventory generation:

```go
// Conceptual shape only.
type RouteContract struct {
    Method       string
    Pattern      string
    UpstreamFile string
    Auth         AuthMode
    CSRF         bool
    Phase        int
}
```

The metadata is documentation/test support, not an alternate API definition. Upstream source remains authoritative.

### 7.2 Middleware ordering is contract

Upstream ordering matters. The Go pipeline must reproduce the effective order discovered in `src/server-main.js`, including relevant behavior for:

1. security headers;
2. compression;
3. response timing if observable;
4. request body limits/decoding;
5. CORS;
6. Basic Auth when configured;
7. IP whitelist;
8. Host whitelist;
9. access logging;
10. cookie session parsing/signing;
11. selected user/data-root binding;
12. CSRF token generation/validation;
13. public root/login/static/public user endpoints;
14. login requirement;
15. CORS proxy;
16. uploads;
17. version/deprecated routes/private endpoints.

Do not “improve” middleware ordering without a parity test.

### 7.3 Body limits and multipart

The baseline accepts very large request bodies (upstream JSON/URL encoded limit is 500 MB and multipart field size is also large). Implement streaming/spooling so the limit does not imply allocating a 500 MB buffer.

Uploads should spool to the data-root upload directory when the upstream behavior requires a temporary file. Clean-up behavior must match upstream while avoiding unbounded memory growth.

### 7.4 Response writer

Centralize helpers for Express-compatible outcomes:

- JSON
- text
- empty status (`sendStatus` semantics where relevant)
- binary/download
- redirects
- streamed proxy response
- SSE/event stream

Do not normalize every error into a GoTavern envelope. SillyTavern endpoints use different historical error shapes; those differences are part of compatibility.

---

## 8. Authentication, sessions and CSRF

This is compatibility-critical because a server can appear to work while extensions fail due to session/CSRF differences.

### 8.1 Basic Auth

Implement the baseline behavior for:

- `basicAuthMode`
- `basicAuthUser.username/password`
- rate limiting behavior
- `perUserBasicAuth`
- interaction with `enableUserAccounts`
- forwarded client IP settings when enabled

Challenge status/header/body and failure behavior must be measured against Node.

### 8.2 Multi-user accounts

Do not invent a new user database.

Read/write the same user storage representation under the data root used by upstream `_storage`. Password hashing, salt handling, enabled/admin flags, recovery flows and public/private/admin route semantics must match the baseline.

If implementing the `node-persist` file representation directly is necessary, document and test it as an on-disk compatibility codec.

### 8.3 Sessions

Upstream uses `cookie-session`, with the cookie secret derived from the data root (`cookie-secret.txt`). GoTavern must reproduce the browser-visible cookie/session semantics, including cookie name, signing/encoding, `SameSite=Lax`, HTTP-only behavior and configured session timeout.

A strong target is **session cookie interoperability**: a valid session minted by the baseline Node server should be understood by GoTavern and vice versa when both use the same data root/secret. If an upstream quirk prevents this, the difference must be documented and tested before claiming full auth compatibility.

### 8.4 CSRF

Implement `/csrf-token` and the `x-csrf-token` validation behavior from upstream, including the disabled mode response (`token: "disabled"`) and proxy exemption behavior when applicable.

Do not replace this with a generic CSRF package unless differential tests prove identical observable behavior.

---

## 9. Configuration compatibility

`config.yaml` is a compatibility file, not a Go-native configuration redesign.

Use a two-layer representation:

1. a generic YAML node/tree retained for unknown values;
2. a typed projection for fields GoTavern actually consumes.

Rules:

- unknown keys are accepted and retained;
- upstream defaults come from the pinned baseline, not Go zero values;
- type coercions/default behavior should match upstream's `getConfigValue`/CLI resolution where observable;
- relative paths resolve against the same effective root as upstream;
- GoTavern must not rewrite `config.yaml` merely by starting;
- unsupported Node-server-plugin configuration may be reported but must not corrupt the file.

Important categories include server bind/protocol, TLS, whitelist, forwarded headers, Basic Auth, user accounts, session timeout, CSRF, CORS, host whitelist, private-address request filter, request proxy, backups, thumbnails, performance flags, extension settings, Git backend, import-domain allowlists and request overrides.

Phase 0 must produce a field-by-field compatibility table from `default/config.yaml` and command-line resolution.

---

## 10. Embedded upstream frontend

### 10.1 Build-time sync

`tools/sync-upstream` must:

1. read `upstream/SILLYTAVERN_COMMIT`;
2. fetch/checkout exactly that commit;
3. copy `public/**` without modification;
4. generate a SHA-256 tree manifest;
5. produce upstream-generated runtime frontend artifacts using the upstream build process where necessary;
6. record toolchain/version metadata required to reproduce them;
7. fail if the working copy has unaccounted frontend patches.

At the 1.19.0 baseline, SillyTavern compiles `public/lib.js` through Webpack to a generated `lib.js` served from a cache/output directory. GoTavern must generate the equivalent artifact **at build/release time**, embed it, and serve it at the same browser path. Node/Webpack must not be required on the production server.

### 10.2 Runtime serving

Serve:

1. authenticated/per-user mutable resource overlays where upstream does;
2. third-party extension overlays;
3. embedded generated assets;
4. embedded upstream static assets.

Path traversal protection is mandatory but must not break legitimate encoded SillyTavern resource URLs.

Compression/cache headers/content types must be tested against upstream for representative files.

---

## 11. Storage and concurrency

### 11.1 Data is files first

Storage adapters operate directly on SillyTavern files. They must not translate into a private schema.

### 11.2 Unknown-field preservation

For JSON structures where GoTavern changes only selected fields, use loss-minimizing representations such as `json.RawMessage` maps or a typed envelope with retained raw unknown properties.

Do not deserialize into a narrow struct and marshal it back if that would drop extension-defined or future-upstream fields.

If upstream semantics replace the entire file with the submitted object, matching that behavior is more important than preservation beyond what upstream itself preserves.

### 11.3 Atomic writes

All compatibility-sensitive writes use a shared atomic-file layer:

1. acquire a keyed write lock for the canonical target path;
2. create a temporary file in the **same directory/filesystem**;
3. write the full new content;
4. apply required permissions;
5. flush the file where appropriate;
6. atomically replace/rename using platform-correct semantics;
7. fsync the parent directory on platforms where needed for durability;
8. release the lock.

Do not write a final JSON/JSONL/card file in place.

### 11.4 Locking

Use a sharded/keyed lock manager keyed by canonical absolute path. A global mutex is unacceptable because large chats/media uploads should not block unrelated users.

For multi-file operations, define a stable lock ordering to prevent deadlocks.

GoTavern should hold a data-root instance lock to discourage two writable GoTavern processes from sharing one data root. Running Node SillyTavern and GoTavern writable against the same root simultaneously is unsupported.

### 11.5 JSONL chats

Chat code must preserve upstream JSONL semantics exactly, including first-line metadata, message ordering, line encoding, import/export behavior, integrity checks and backup behavior.

Never parse and rewrite a chat merely to read it.

Large chats should be streamed line-by-line rather than loaded wholesale unless the endpoint contract requires a full in-memory response.

---

## 12. Character cards and PNG metadata

Character handling is its own compatibility subsystem.

Required support:

- JSON character cards;
- PNG cards;
- V1/V2/V3 metadata semantics used by the baseline;
- imports/exports;
- edit/merge attribute behavior;
- duplicate/rename/delete;
- avatar/image handling;
- sprite-related behavior that the upstream route performs;
- unknown field preservation.

The PNG codec must preserve all non-target PNG chunks and image data. Updating card metadata must alter only the metadata chunk(s) required by upstream semantics and must not re-encode the bitmap unless upstream does so for that operation.

Maintain golden fixtures produced by Node SillyTavern and round-trip them through GoTavern.

---

## 13. World info, presets, settings, themes and quick replies

These appear simple but are extension-sensitive.

For each module:

- reproduce upstream filename sanitization;
- reproduce capitalization and extension rules;
- reproduce sorting/listing behavior;
- preserve unknown JSON fields as required;
- use the exact user directory names;
- mirror status/error behavior;
- update backups the same way when the baseline does.

World Info and settings are especially important to Tavern Helper/JS-Slash-Runner-style workflows; E2E tests must cover scripts that read/update them through normal frontend APIs.

---

## 14. Outbound HTTP architecture

All server-side outbound HTTP must go through one shared transport service so configuration and security rules cannot be accidentally bypassed.

Responsibilities:

- HTTP/HTTPS keep-alive setting;
- configured proxy (`requestProxy.*`) including bypass behavior;
- private-address/SSRF filter;
- request overrides;
- timeout/cancellation;
- redirect policy;
- TLS behavior;
- streaming pass-through;
- per-provider headers;
- bounded diagnostic logging with secret redaction.

Endpoint packages must not instantiate ad-hoc `http.Client` objects.

Provider adapters should operate as thin translators around the upstream contract. Do not force all providers into one lowest-common-denominator request model when SillyTavern exposes provider-specific options.

---

## 15. Generation and streaming

Generation is successful only if the unmodified upstream frontend can consume it exactly as it consumes Node SillyTavern.

Required provider families include all built-in families exposed by the baseline, including the chat-completion and text-completion backends and provider-specific helper/model-list endpoints. Priority starts with OpenAI-compatible, Claude/Anthropic, Gemini/Google, OpenRouter and custom endpoints, but the end-state target is the full baseline surface.

### Streaming rules

- Flush promptly; never buffer the full model response.
- Preserve content type and event/data framing.
- Preserve upstream termination semantics.
- Propagate client cancellation to the provider request.
- Do not gzip/buffer streams in a way that changes frontend behavior.
- Reverse-proxy examples must disable response buffering for generation streams.

Golden streaming tests should compare parsed event sequences rather than assume ordinary JSON equality.

---

## 16. Tokenization

Token counts are behavior, not an estimate.

Every tokenizer endpoint marked compatible must be checked against the Node baseline on a corpus containing:

- ASCII;
- CJK;
- emoji;
- combining characters;
- special tokens;
- long prompts;
- representative chat templates.

A fallback tokenizer may exist only when upstream itself falls back in the same condition. “Close enough” counts are not compatible because prompt truncation and extension logic depend on exact counts.

Prefer pure-Go or statically linkable implementations and embedded tokenizer assets so the release remains a single static binary. If an exact baseline tokenizer cannot yet be implemented, mark that route partial rather than lying about parity.

---

## 17. Secrets

`secrets.json` stays in the upstream location and format.

Requirements:

- read/write the same key names and structure;
- preserve unknown secret keys;
- honor `allowKeysExposure` semantics;
- never print secret values in logs or contract snapshots;
- redact Authorization/API-key headers in diagnostics;
- keep file permissions restrictive where the platform supports it;
- atomic writes only.

Contract fixtures containing secrets must use synthetic values.

---

## 18. Extension ecosystem

Frontend extension compatibility is a first-class acceptance target, not a bonus.

### 18.1 Serving

The browser-visible path remains:

```text
/scripts/extensions/third-party/<extension>/...
```

Resolution must match upstream per-user/global behavior. The embedded frontend itself remains immutable.

### 18.2 Management

Implement the complete baseline `/api/extensions/**` behavior, including discovery, install, update, version/status, branch operations and delete/move operations present at the pinned SHA.

A system `git` executable may be used initially if behavior is wrapped behind an interface and Docker/runtime requirements are explicit. A pure-Go Git implementation is allowed only if compatibility is equal or better. The final architecture should not require Node.js.

Git operations must use safe argument handling and protect against path traversal/repository URL injection.

### 18.3 Mandatory real-extension acceptance tests

At minimum, CI/E2E acceptance fixtures must include real pinned revisions of:

- Tavern Helper / JS-Slash-Runner (`N0VI028/JS-Slash-Runner`)
- LittleWhiteBox

Tests must cover more than “extension JS file loaded”:

- install;
- startup discovery;
- static assets;
- extension enable/load;
- slash/script execution;
- variable access/update;
- World Info interaction;
- character/chat interaction;
- rendered frontend card/UI behavior that depends on backend calls;
- extension update/remove.

Phase 4 must record every backend route actually touched by these tests in `docs/extension-route-coverage.md` and cross-link it to `docs/api-inventory.md`.

Do not special-case either extension in production code. They are compatibility probes.

---

## 19. Deprecated routes

The baseline redirects many historical endpoints to `/api/...` replacements using HTTP **308** specifically to preserve request methods.

GoTavern must inventory and reproduce them. Examples include legacy character/chat/group/world-info/background/theme/avatar/quick-reply routes.

Do not remove deprecated routes merely because the current frontend no longer calls them: third-party extensions may still do so.

---

## 20. Testing strategy

No module is “done” because it has unit tests. The primary acceptance method is differential compatibility testing.

### 20.1 Contract harness

Run two isolated servers against copies of the same deterministic fixture:

```text
fixture A -> Node SillyTavern 1.19.0 @ pinned SHA
fixture B -> GoTavern under test
```

For each route case, send equivalent requests and compare:

- status;
- selected headers;
- body type;
- JSON semantic shape and ordering where relevant;
- exact text/binary bodies where required;
- redirects;
- set-cookie/session behavior;
- stream event sequence;
- filesystem side effects.

Normalize only inherently nondeterministic fields explicitly documented per test (timestamps, random CSRF tokens, temporary names, etc.). Never globally sort/remove fields to make tests pass.

Every normalization rule needs a reason.

### 20.2 Filesystem side-effect diff

After mutating endpoint tests, compare the fixture trees. Classify every difference as:

- required equivalent output;
- expected nondeterminism;
- cache/temp difference;
- compatibility bug.

Unknown differences fail the test.

### 20.3 Round-trip tests

For each canonical file type:

1. Node writes -> Go reads.
2. Go writes -> Node reads.
3. Node reads Go output and performs another normal mutation.
4. Go reads the result again.

Fixtures must contain unknown/custom fields to detect destructive struct serialization.

### 20.4 E2E

Playwright runs the real unmodified embedded frontend and covers:

- root/login redirect;
- Basic Auth deployment;
- multi-user account login;
- CSRF-protected requests;
- character library/open/edit;
- chat load/save/rename/delete;
- message generation with streaming;
- World Info trigger;
- group chat;
- presets/settings;
- extension install/load;
- Tavern Helper script execution;
- LittleWhiteBox critical workflow.

Browser console errors and failed network requests fail the suite unless explicitly allowlisted with a linked issue.

### 20.5 Performance

Measure Node and Go using the same machine/container limits, dataset and scenario.

Report at least:

- idle RSS/PSS where available;
- steady-state RSS after opening a representative character/chat;
- RSS during streaming generation;
- CPU at idle;
- CPU/request for representative CRUD;
- startup time;
- open file descriptors/goroutines;
- binary size.

The target is materially below Node and stable on a 1 GB machine, but compatibility failures cannot be traded for lower memory numbers.

---

## 21. Compatibility matrix rules

`docs/compat-matrix.md` is a release gate.

Each module/route family records:

- baseline SHA;
- implementation status;
- contract-test count/pass rate;
- round-trip status;
- E2E coverage;
- known differences;
- issue links.

Only `compatible` means no known browser/data-contract difference for the tested baseline.

A release called “drop-in compatible” requires all baseline built-in route families to be `compatible`, except explicitly declared Node server plugins.

---

## 22. Phase plan and gates

### Phase 0 — Reconnaissance

Deliver before broad implementation:

- `docs/api-inventory.md` generated/verified from source;
- `docs/config-inventory.md`;
- `docs/data-layout.md`;
- initial `docs/compat-matrix.md`;
- baseline Node fixture/container;
- contract harness skeleton;
- frontend upstream sync/hash guard.

Gate: no route implementation based solely on memory.

### Phase 1 — Boot/login/frontend

Implement:

- embedded upstream frontend and generated `lib.js`;
- config loading;
- listen/TLS/whitelist/host whitelist/CORS basics;
- Basic Auth;
- user accounts/session compatibility;
- CSRF;
- user directory binding;
- settings read needed to load the UI;
- `/version`, `/api/ping`, root/login/callback behavior.

Gate: Playwright can load the real frontend and login with zero backend-stub hacks.

### Phase 2 — Core data CRUD

Implement characters/cards, chats, groups, world info, settings, presets, avatars/backgrounds/themes/quick replies/assets/files and backups required by these flows.

Gate: Node <-> Go round-trip suite passes on representative and unknown-field fixtures.

### Phase 3 — Generation/providers

Implement secrets, shared outbound transport/proxy/SSRF policy, provider model/helper routes, chat/text completion, streaming and tokenization.

Gate: real frontend streams a response and contract tests cover representative providers using deterministic mock upstreams.

### Phase 4 — Extension ecosystem

Implement `/api/extensions/**`, extension overlays and Git operations; validate pinned Tavern Helper and LittleWhiteBox workflows.

Gate: both real extensions pass E2E without source modifications.

### Phase 5 — Remaining built-ins

Complete image generation, speech/TTS/STT, translation, search/visit/transcript, thumbnails, vector endpoints, classification/caption, import/export, content manager, data-maid and every remaining inventory item.

Gate: the compatibility matrix has no unexplained route gap.

---

## 23. Migration design

Migration is intentionally boring because the format is already compatible.

### 23.1 Copy, do not convert

For a standard install, migration copies:

- `config.yaml`;
- the complete configured data root (`data/` by default), including `_storage`, `cookie-secret.txt`, all users, extensions and caches required for compatibility;
- optional global extension overlay `public/scripts/extensions/third-party/` when present;
- optional TLS certificate directory when the copied config references relative files and the operator chooses to copy them.

Do **not** copy Node `node_modules`.

Do **not** treat `plugins/` as supported functionality. Node server plugins are outside scope. The migration report should warn if they exist.

### 23.2 Source is read-only

The migration implementation must perform no source mutations. No source-side backup creation, lock file, chmod, cleanup, rename or migration hook.

For a consistent snapshot, the operator should stop Node SillyTavern before copying or use a filesystem snapshot. This consistency recommendation does not permit the copy tool to modify the source.

### 23.3 Existing destination

Never merge over an existing destination silently.

Default behavior:

- fail if destination `config.yaml` or data root already exists;
- `--force` may replace only after creating a destination-side backup, never touching source;
- provide `--dry-run`/summary in the eventual Go migration utility.

### 23.4 Rollback

Because formats stay upstream-compatible, rollback is process-level, not schema-level:

1. stop GoTavern;
2. back up its runtime root;
3. either point Node SillyTavern at the GoTavern-compatible data/config or copy them into a fresh Node runtime;
4. start the pinned/equivalent Node SillyTavern;
5. verify login and a representative chat/character.

No reverse converter should be necessary.

---

## 24. Deployment architecture

### 24.1 Binary

Release target is one Go server binary containing the pinned upstream frontend/generated browser assets.

Prefer `CGO_ENABLED=0` where feature parity permits. Any dependency that requires CGO/native shared libraries must be justified because it weakens the standalone deployment goal.

### 24.2 Docker

Use a multi-stage build and a minimal runtime image. Runtime needs only:

- GoTavern binary;
- CA certificates;
- optionally `git` if the selected extension backend uses system Git;
- writable runtime/data volumes.

Do not ship Node.js in the runtime image.

### 24.3 Reverse proxy

Nginx/Caddy examples must preserve:

- original Host and client IP headers according to the user's trusted-proxy config;
- cookies;
- large request bodies needed by imports/uploads;
- Web/SSE streaming without proxy buffering;
- long generation timeouts;
- correct scheme forwarding.

Security documentation must warn that enabling forwarded headers without a correctly configured trusted reverse proxy permits spoofing.

---

## 25. Security requirements that compatibility does not waive

Matching upstream does not mean adding avoidable Go-specific vulnerabilities.

Mandatory controls:

- canonical path containment for all user-controlled paths;
- symlink-aware checks for writable/import roots;
- archive extraction traversal protection;
- SSRF/private-address policy shared by all outbound routes;
- URL scheme allowlists where upstream has them;
- no shell interpolation for Git/provider commands;
- bounded decompression/archive expansion;
- request-size enforcement without huge preallocation;
- secret/header redaction;
- permission checks for admin routes;
- no serving files outside the selected user's allowed roots.

When a safer implementation changes browser-observable behavior, first determine whether the upstream behavior is intentional and whether the difference breaks compatibility. Document deliberate security deviations explicitly.

---

## 26. Upstream update procedure

Do not casually track upstream `release`.

To move the baseline:

1. select a new exact SillyTavern commit/version;
2. update `SILLYTAVERN_COMMIT` and `SILLYTAVERN_VERSION` in one PR;
3. regenerate the frontend tree/hash and generated frontend artifact;
4. regenerate API/config inventories;
5. diff router/middleware/data-layout changes;
6. run the old-baseline compatibility suite to identify intentional breaks;
7. implement new behavior;
8. run full Node(new) vs Go differential tests;
9. update compatibility matrix and migration notes;
10. only then merge the baseline bump.

A green Go unit-test suite without a green differential suite is insufficient for an upstream bump.

---

## 27. Implementation decision rules for agents

When implementing an endpoint:

1. Locate its mount point in `server-startup.js`/`server-main.js`.
2. Read the complete upstream router handler and helper calls.
3. Read any storage/middleware/helper code that changes observable behavior.
4. Add/update the inventory entry.
5. Add a Node-baseline contract case first or in the same commit.
6. Implement the narrowest Go behavior that matches it.
7. Compare response and filesystem side effects.
8. Add round-trip coverage for data writes.
9. Update `docs/compat-matrix.md`.
10. Commit a buildable state.

If source inspection is incomplete, stop implementation of that endpoint rather than guessing.

---

## 28. Definition of done for the project

GoTavern reaches its stated goal only when a user can take an ordinary SillyTavern 1.19.0 server deployment, stop Node, point GoTavern at the same compatible config/data (or copy it read-only with the migration tool), open the same site through the same reverse proxy, and continue using characters, chats, worlds, presets, providers and frontend extensions without modifying the upstream frontend or extension code.

They must then be able to stop GoTavern and return to SillyTavern without a data conversion step.

The exception is Node.js server plugins, which are explicitly unsupported and must remain clearly documented as such.
