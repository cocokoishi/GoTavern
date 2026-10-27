# GoTavern Architecture

> A release-first, standalone Go replacement for the SillyTavern server/backend that serves the **unmodified upstream SillyTavern frontend**, uses the **same persistent data**, and reproduces the browser-visible, provider-visible, and filesystem-visible behavior of a pinned SillyTavern release closely enough that ordinary users and frontend extensions do not need to know the backend changed.

## 0. Product contract

GoTavern is not a Go port for developers who happen to have a Go toolchain. It is an end-user SillyTavern-compatible server product.

An ordinary user must be able to:

1. download a prebuilt release or run an installer script;
2. run GoTavern without Go, Node.js, npm, pnpm, Python, or a compiler;
3. open it from a browser, including through an existing reverse proxy;
4. use a fresh installation with the same upstream defaults SillyTavern would seed;
5. copy or directly reuse an existing SillyTavern `config.yaml` and data root;
6. keep characters, chats, worlds, presets, settings, secrets, accounts and frontend extensions intact;
7. use complex prompt/preset/world-info/script workflows with the same semantics, not merely obtain some generated text;
8. update GoTavern without overwriting mutable user data;
9. stop GoTavern and return to an equivalent SillyTavern baseline without a schema conversion;
10. reach a real provider (including an OpenAI-compatible one over HTTPS, and through a proxy) and see a causal
    error when it cannot;
11. start the release binary inside a stock SillyTavern directory without the process hanging, whatever the
    working directory;
12. never have an extension or plugin modified unless they asked for that update.

Items 10-12 were added on 2026-10-25 because all three failed in real use while the suite was green. Their
binding contracts are §34, with the measurements in `docs/network-egress.md` and
`docs/startup-state-machine.md`.

The project is successful only when these user journeys work from released artifacts. `go run`, a locally compiled binary, or a green handler unit test is not a substitute for a release artifact and end-to-end validation.

---

## 1. Normative compatibility baseline

The initial baseline is pinned to:

- upstream repository: `SillyTavern/SillyTavern`;
- SillyTavern version: **1.19.0**;
- exact commit: **`06bde939fb1e9c4c8d8641d810f0a916b5bce127`**;
- license: **AGPL-3.0**.

The commit SHA is normative. `release` is only the branch from which the baseline was selected and must never be treated as a floating build input.

Primary source-of-truth areas include:

```text
src/server-main.js
src/server-startup.js
src/server-init.js
src/config-init.js
src/command-line.js
src/users.js
src/constants.js
src/endpoints/**
src/middleware/**
src/request-proxy.js
src/private-request-filter.js
default/**
public/**
webpack.config.js
package.json / package-lock.json
```

TauriTavern is useful as a reference for lessons learned when replacing the backend while retaining SillyTavern behavior, but it is not an oracle. If it differs from the pinned SillyTavern source or observed Node behavior, SillyTavern wins.

Every GoTavern release must record all of the following in machine-readable build metadata and release notes:

- GoTavern version;
- SillyTavern baseline version and full SHA;
- hash manifest of embedded `public/**`;
- hash manifest of embedded `default/**`;
- build toolchain version used for upstream generated assets;
- pinned revisions of real third-party compatibility probes;
- compatibility-matrix result for that release.

### `/version` is a compatibility endpoint

The upstream frontend and extensions may inspect `/version`. GoTavern must therefore preserve the pinned SillyTavern response schema and meaningful baseline version fields there. Do not replace `/version` with a GoTavern product version.

GoTavern's own build identity belongs in the CLI (`gotavern version`) and, only if useful operationally, a separate `/gotavern/version` endpoint that the upstream frontend never depends on.

---

## 2. Compatibility is multi-layered

A server that opens the UI and returns a model response is not necessarily compatible. GoTavern uses eight independent compatibility layers.

### 2.1 Browser HTTP contract

For every upstream route, reproduce observable behavior including:

- method and path;
- path decoding and routing edge cases;
- query/body parsing and defaults;
- JSON, URL-encoded and multipart parsing;
- upload field names and filename rules;
- authentication and authorization;
- CSRF;
- redirects;
- status codes;
- browser-relevant headers and content types;
- JSON field names, types, omitted/null behavior and ordering where observable;
- text/binary bodies;
- historical error shapes;
- deprecated endpoint behavior;
- stream framing, termination and cancellation.

A generic Go error envelope is not compatible with an endpoint that historically returns plain text, empty status, or a different JSON shape.

### 2.2 Static/frontend module ABI

Frontend extensions execute inside the real SillyTavern browser environment. Compatibility includes:

- byte-identical pinned upstream `public/**` source assets;
- the correctly generated upstream `lib.js` artifact;
- the same same-origin URLs and MIME types;
- internal frontend module import URLs used by extensions;
- third-party extension static paths;
- no new Content-Security-Policy that blocks behavior allowed by the pinned server;
- user CSS override behavior;
- cache behavior where extensions rely on refreshed assets;
- browser globals, DOM, `eventSource`, slash-command infrastructure and other frontend ABI supplied by the unchanged upstream frontend.

Keeping `public/**` unchanged gives GoTavern a major advantage, but it does not by itself guarantee this ABI: backend state, resource routing, MIME types, version reporting and generated assets can still break it.

### 2.3 Persistence/data contract

The canonical data is SillyTavern data, not a GoTavern-private schema. Compatibility includes exact directory names, file formats, unknown-field preservation, backup side effects, timestamps/order where meaningful, PNG metadata behavior and account/session storage.

### 2.4 Startup/configuration contract

Startup is observable. The pinned Node server does more than bind a socket: it initializes user storage, creates directories, migrates supported legacy data/config forms, seeds default content, verifies caches, migrates secrets/group metadata/public overrides, creates settings backups, initializes statistics, cleans uploads, configures request filtering/proxy behavior and installs the final 404 response.

Those side effects must be inventoried and reproduced or explicitly classified. A Go server that serves routes correctly after a hand-prepared fixture can still fail real fresh installs and upgrades.

### 2.5 Provider-wire contract

This layer is critical for roleplay quality and complex presets.

For a given browser request and settings state, Node SillyTavern and GoTavern must send semantically equivalent requests to the model/provider. Compare at the provider boundary:

- target URL and query;
- HTTP method;
- relevant headers after secret redaction;
- provider/model selection;
- exact message list, order and roles;
- system/instruction handling;
- examples;
- world-info and Author's Note placement;
- stop strings;
- sampler fields and omitted/default fields;
- token limits;
- tool definitions, tool choice and schemas;
- structured-output/JSON-schema fields;
- reasoning/thinking fields;
- multimodal parts;
- custom provider body/header inclusion/exclusion;
- reverse proxy behavior;
- stream flag and provider-specific transformations.

Receiving plausible text is not evidence of parity. A one-line difference in prompt order, omitted stop string, tokenizer budget, role conversion or tool schema can materially change the roleplay while the UI still appears healthy.

### 2.6 Streaming and cancellation contract

Streaming compatibility includes the route-specific protocol, not a blanket assumption that every stream is SSE.

Where the browser consumes SSE, preserve the event/data semantics, terminal sentinel behavior, provider chunks that carry reasoning/tool calls/images, first-event flushing and cancellation propagation. TCP packet boundaries need not be identical unless they become browser-observable; parsed event sequence and semantics do.

Client abort must cancel or tear down the provider request as upstream does. No reverse-proxy or Go buffering layer may turn a live stream into a delayed full response.

### 2.7 Browser event/state side effects

Complex extensions observe more than HTTP. For representative operations, tests must compare:

- event names;
- relative event order;
- payload field/types;
- save-before/save-after timing where observable;
- active character/chat/group state;
- settings/world-info list refreshes;
- local/global/chat metadata mutations;
- generated message/reasoning/tool state;
- final persisted chat after reload.

### 2.8 Operational compatibility

A replacement is not operationally compatible if users need a compiler or must redesign their deployment. Compatibility therefore also covers install, update, startup, reverse proxy, Docker, service management, migration and rollback workflows.

---

## 3. Explicit non-goal

**Arbitrary Node.js SillyTavern server plugins are not supported.**

They execute Node code against server internals and are not reducible to the public/browser compatibility contract. GoTavern must not claim to execute them, silently ignore required plugin endpoints, or build a general Node emulation layer.

This boundary must be applied honestly to third-party extensions that ship optional/required server plugins. The frontend portion is tested against standard SillyTavern APIs; any feature that genuinely requires a Node server plugin is listed separately as outside scope.

Everything else shipped as a built-in browser-visible SillyTavern feature remains in scope until the compatibility matrix explicitly proves otherwise.

---

## 4. User journeys are release gates

### 4.1 Fresh installation

Supported path:

```text
installer script OR GitHub Release archive
    -> prebuilt native GoTavern binary
    -> first start in an empty runtime directory
    -> config/default data created with pinned upstream semantics
    -> browser opens/URL is printed
    -> user can configure a provider and chat
```

No Go or Node runtime is permitted on the target machine for this path.

Fresh-install E2E must start from an actually empty temporary directory. Test fixtures that already contain `settings.json`, presets or user folders do not satisfy this gate.

### 4.2 Replacing an existing standalone SillyTavern clone

Typical source layout is a Git clone with `config.yaml` and `data/`. The user should install GoTavern into a separate directory, run the migration command/script against the old installation, stop the Node instance, then start GoTavern.

The user must not need to understand Go package layout or manually copy individual character/chat folders.

### 4.3 Custom/global SillyTavern installations

Migration must also handle:

- `--global` installations;
- custom `--configPath`;
- custom `--dataRoot`;
- absolute data roots outside the SillyTavern repository;
- multi-user installations;
- reverse-proxy deployments;
- Docker volume layouts.

These are ordinary deployment variants, not unsupported edge cases.

### 4.4 Updating GoTavern

Re-running the installer or using a future `gotavern update` flow may replace only immutable release components. It must not overwrite or recreate:

- `config.yaml` except through the same startup config migration behavior the baseline itself performs;
- data root;
- third-party extension working trees;
- TLS certificates;
- user-created service/proxy configuration.

A failed update must not leave a half-written executable. Download/verify to a temporary path, then atomically replace the installed binary/immutable release files.

### 4.5 Rollback

Rollback is only promised across data-compatible baselines:

1. stop GoTavern;
2. back up the runtime/data root;
3. start the equivalent/pinned SillyTavern version against the compatible config/data, or copy them to a fresh matching SillyTavern runtime;
4. verify login, one representative character and one representative chat.

Do not promise that arbitrary future SillyTavern downgrades remain safe after upstream itself introduces irreversible migrations.

---

## 5. Distribution and installation architecture

### 5.1 End users consume releases, not source builds

GitHub Releases are the canonical native distribution channel. Every stable release must publish at least:

```text
gotavern-linux-amd64.tar.gz
gotavern-linux-arm64.tar.gz
gotavern-darwin-amd64.tar.gz
gotavern-darwin-arm64.tar.gz
gotavern-windows-amd64.zip
gotavern-windows-arm64.zip
checksums.txt
```

Release archives contain the native executable plus immutable convenience/documentation files needed for manual extraction. They must not contain a live `config.yaml` or `data/` payload that could overwrite an existing runtime during extraction/update.

Linux `amd64` and `arm64` are hard requirements. Windows `amd64` is a hard requirement; Windows `arm64` and both macOS architectures should remain first-class if the dependency graph permits pure-Go builds.

### 5.2 One-line installers

The repository ships `install.sh` and `install.ps1`.

Installer properties:

- detect supported OS/architecture;
- download the matching **prebuilt** release asset;
- support latest stable and an explicit version pin;
- download `checksums.txt` and verify SHA-256 before install;
- install into a user-owned directory by default;
- require no root/admin privileges by default;
- do not modify PATH automatically;
- never clone source or fall back to local compilation;
- preserve mutable runtime data on re-run;
- use temporary files and atomic replacement for updates;
- report clearly when no compatible release exists;
- do not automatically start a migrated server before the user has stopped the source Node instance.

The initial portable default is `$HOME/GoTavern` on Unix-like systems and `$HOME\GoTavern` on Windows, overrideable by an installer argument.

### 5.3 Familiar launchers

Manual release archives should include tiny launchers so a SillyTavern user does not have to memorize CLI syntax:

- `start.sh` on Unix;
- `Start.cmd` on Windows.

They resolve their own directory and execute the adjacent `gotavern` binary with forwarded arguments. The native binary with no subcommand starts the server.

### 5.4 Docker

Stable releases are PLANNED to publish a multi-architecture image, e.g. `ghcr.io/cocokoishi/gotavern:<version>`, and a stable/latest channel according to release policy. **STATUS: nothing publishes one.** No workflow contains `ghcr`, `buildx`, `docker login` or `platforms`; `docker.yml` builds a local single-platform `gotavern:ci` tag for a smoke test and pushes nothing. A user following the container path therefore has to build the image themselves today, and this sentence is the tracked gap rather than a description.

The runtime image must not contain Node.js. Prefer a pure-Go built-in Git implementation so it does not require system `git` either. CA certificates and timezone data may be included as needed.

Document mounts for at least config/data and any global extension overlay. Container upgrades must be image replacement, never mutable data replacement.

### 5.5 Services

Provide example user/system `systemd` units and reverse-proxy snippets, but do not make an installer silently register a root service. Service installation is an explicit administrator action.

---

## 6. Repository layout

Target layout:

```text
GoTavern/
├── cmd/
│   └── gotavern/                 # server + operational subcommands
├── internal/
│   ├── app/                      # lifecycle/composition root
│   ├── compat/                   # compatibility metadata/helpers
│   ├── config/                   # config + CLI/env compatibility
│   ├── startup/                  # ordered startup migrations/initialization
│   ├── httpserver/
│   │   ├── router/
│   │   ├── middleware/
│   │   ├── static/
│   │   └── response/
│   ├── auth/
│   ├── userdata/
│   ├── storage/
│   │   ├── atomicfile/
│   │   ├── jsonfile/
│   │   ├── jsonl/
│   │   ├── pngcard/
│   │   └── locks/
│   ├── endpoints/                # aligned visibly with upstream routers
│   ├── outbound/                 # proxy/SSRF/override-aware HTTP transport
│   ├── providers/
│   ├── tokenizers/
│   ├── extensions/
│   ├── media/
│   └── observability/
├── upstream/
│   ├── SILLYTAVERN_VERSION
│   ├── SILLYTAVERN_COMMIT
│   ├── public/                   # byte-identical pinned source frontend
│   ├── default/                  # pinned default content/config/scaffold
│   ├── generated/                # pinned build-generated browser assets
│   ├── tokenizers/               # vendored source tree; a RELEASE ships it at <root>/src/tokenizers (see note)
│   └── manifests/
├── tools/
│   ├── sync-upstream/
│   ├── inventory/
│   └── contract-runner/
├── tests/
│   ├── contract/
│   ├── provider-wire/
│   ├── startup/
│   ├── roundtrip/
│   ├── e2e/
│   ├── torture/
│   ├── fixtures/
│   └── benchmarks/
├── scripts/
│   └── migrate-from-sillytavern.sh
├── docs/
│   ├── INSTALLATION.md
│   ├── SEMANTIC-COMPATIBILITY.md
│   ├── api-inventory.md
│   ├── config-inventory.md
│   ├── startup-inventory.md
│   ├── data-layout.md
│   ├── extension-route-coverage.md
│   ├── compat-matrix.md
│   ├── migration.md
│   └── reports/
├── install.sh
├── install.ps1
├── start.sh
├── Start.cmd
├── ARCHITECTURE.md
├── AGENTS.md
├── Dockerfile
├── go.mod
└── LICENSE
```

> **Tokenizer data is a disk asset, and it is looked for in three places.** Upstream reads these files
> server-side by a path relative to its own working directory (`new SentencePieceTokenizer('src/tokenizers/...')`,
> `src/endpoints/tokenizers.js:251-254`), so a real SillyTavern tree keeps them at `<root>/src/tokenizers/`. The only
> static mount upstream has is `public/` (`server-main.js:242`), so nothing serves `/src/tokenizers/...` over HTTP.
> GoTavern's release places the same tree at the SAME path, `<root>/src/tokenizers/`, does **not** embed it in the binary
> (`upstream/assets.go` embeds only `public/default/generated/manifests`), and resolves, in this order:
> `<root>/src/tokenizers`, then the legacy `<root>/tokenizers` (what v0.1.0-alpha.1 shipped), then `<root>/upstream/tokenizers`
> (`internal/server/tokenizers.go`). The second candidate is what makes a MIGRATED SillyTavern installation work:
> without it the routes fell back to the pinned Guesstimate and answered with wrong token counts instead of failing.

Keep endpoint packages recognizable against upstream until parity is mature. Prematurely hiding hundreds of historically different endpoint semantics behind a generic CRUD framework makes source review and differential debugging harder.

---

## 7. Immutable release assets: `public/**`, `default/**`, generated frontend

### 7.1 `public/**`

Do not rewrite the SillyTavern frontend. The vendored source frontend must be byte-identical to the pinned SHA except generated artifacts that upstream itself produces separately.

Release CI generates and verifies a SHA-256 tree manifest. An unexplained frontend byte change fails CI.

### 7.2 `default/**` is also part of the product

A standalone fresh install cannot embed only `public/**`. Pinned SillyTavern uses `default/config.yaml`, `default/content/**` and `default/scaffold/**` for initial configuration and content seeding.

GoTavern releases must therefore include/embed the pinned default content required by startup and content-manager semantics. This includes the indexes and files used to seed settings, characters/sprites, backgrounds, worlds, themes, workflows, provider presets, instruct/context/system/reasoning presets, Quick Replies and other indexed defaults.

Fresh-install tests must compare the resulting destination tree and `/api/settings/get` output with a fresh Node baseline after both complete startup.

### 7.3 Generated `lib.js`

The pinned server uses the upstream Webpack build to generate the browser `lib.js` artifact. Release CI may use the pinned upstream Node/npm toolchain to build this artifact. Production servers must not.

The generated asset must be reproducibly tied to the pinned source/package lock and embedded into the release.

### 7.4 Mutable overlays

Mutable data remains outside embedded assets. At minimum support upstream-equivalent behavior for:

- per-user third-party extensions;
- global third-party extensions;
- `/css/user.css` from the data-root `_css` override when present;
- data-root error/override content used by startup;
- user images/files/cards/backgrounds/assets.

Resolution precedence and path decoding must match the baseline.

---

## 8. Runtime root and CLI compatibility

### 8.1 Standalone mode

Default runtime root is the working/launcher directory. The familiar layout is:

```text
<runtime-root>/
├── gotavern
├── config.yaml
├── data/
│   ├── _storage/
│   ├── cookie-secret.txt
│   ├── default-user/
│   └── ...
└── public/scripts/extensions/third-party/  # writable global overlay if used
```

The static upstream frontend itself may be embedded; the URL contract remains the same even when no physical `public/` source tree exists at runtime.

### 8.2 SillyTavern operational flags

The server must inventory and support the pinned command-line behavior relevant to deployments, including standalone/global mode, config/data path overrides, port/listen addresses, IPv4/IPv6 selection, DNS preference, browser-launch controls, CORS proxy, CSRF disable flag, TLS paths/passphrase, whitelist, Basic Auth, keep-alive, request proxy/bypass and heartbeat. Deprecated aliases remain supported where the pinned parser supports them.

Existing service definitions should require minimal edits: executable name/path, not a redesign of every runtime flag.

### 8.3 GoTavern operational commands

GoTavern-specific commands may be added outside the browser compatibility namespace, for example:

```text
gotavern version
gotavern migrate ...
gotavern doctor ...
```

No subcommand starts the normal server. Operational commands must not change the browser API contract.

---

## 9. Startup compatibility is a subsystem

Phase 0 must create `docs/startup-inventory.md` from the pinned source and tests. At minimum inventory the effective ordered chain around:

```text
config initialization/default-key migration
user storage initialization
DNS result ordering
public/user directory creation
legacy user-data migration
system-prompt migration
public override migration
security-setting verification
group-chat metadata migration
default/scaffold content seeding
character disk-cache verification
flat-secret migration
upload cleanup
access-log migration
settings backup initialization
statistics initialization
private-address request filter initialization
request-proxy initialization
generated frontend availability
404 fallback installation
server bind
post-start browser launch / heartbeat
```

Node server-plugin loading is the explicit exclusion; omitting it must not alter unrelated startup ordering.

Every startup step is classified as:

- required canonical mutation;
- compatibility migration;
- cache generation/verification;
- temporary cleanup;
- security validation;
- operational side effect;
- excluded Node-plugin behavior.

Tests run fresh, already-current and legacy fixtures through Node and Go and compare post-start trees/observable state.

### Config startup mutation must match upstream

`config.yaml` is not universally immutable. The pinned SillyTavern config initialization can:

- create a missing config from `default/config.yaml`;
- migrate deprecated keys;
- migrate corresponding environment variable names;
- add missing default keys;
- rewrite the destination config when those migrations/additions occur.

GoTavern must reproduce these semantics closely enough for differential startup tests. This is distinct from the migration copier's safety rule: **the source installation passed to a copy migration remains read-only**. Once a destination/direct-use runtime is actually started, upstream-compatible startup mutations are allowed and sometimes required.

---

## 10. HTTP server and middleware

Use `net/http` plus a small router only if its automatic behaviors are fully controlled. Router-generated slash redirects, path cleaning, OPTIONS responses or default 404 bodies must not leak when Express behaves differently.

Every route registration should carry test/inventory metadata linking it to its upstream file and mount point.

Effective middleware ordering is contract. Reproduce the pinned order for security headers, compression, response timing where observable, body parsing/limits, CORS, Basic Auth, IP whitelist, Host whitelist, access logging, cookie sessions, user binding, CSRF, public routes/static assets, login enforcement, CORS proxy, uploads, version/deprecated/private routes and final 404 handling.

Pinned upstream disables Helmet CSP; GoTavern must not introduce a stricter CSP that breaks frontend extensions.

### Body sizes without memory explosions

The baseline accepts very large bodies. Enforce equivalent limits while streaming/spooling uploads rather than preallocating hundreds of megabytes. Large limits are contract; large resident-memory spikes are not.

### Historical response shapes

Centralize low-level response helpers, but never normalize heterogeneous upstream endpoint errors into one Go format. Differential tests decide the endpoint shape.

---

## 11. Authentication, users, sessions and CSRF

Implement the pinned semantics for Basic Auth, rate limits, per-user Basic Auth, multi-user accounts, SSO-related trusted proxy behavior, account admin/public/private routes, session timeout and CSRF.

Do not invent a user database. The data-root `_storage` representation and `cookie-secret.txt` are compatibility data.

A high-value target is session interoperability: given the same data root/secret and baseline, cookies minted by Node should be understood by Go and vice versa where the upstream encoding allows it. If exact cross-process cookie interoperability proves impossible or intentionally implementation-specific, document the exact difference and ensure migration forces a safe re-login instead of pretending otherwise.

`/csrf-token` and `x-csrf-token` behavior, including disabled mode and CORS-proxy exemption, are differential-tested.

---

## 12. Configuration and environment compatibility

Represent YAML in two layers:

1. a loss-preserving generic YAML tree;
2. typed projections for values GoTavern consumes.

Unknown keys survive rewrites. Defaults and coercions follow the pinned `getConfigValue`/CLI behavior rather than Go zero values.

Phase 0 generates `docs/config-inventory.md` covering every pinned default key plus CLI/env interaction, startup migrations and whether the value is read once or dynamically.

Request proxy behavior deserves exact testing rather than a generic interpretation: the pinned server uses proxy-agent/environment-style bypass semantics and has a documented interaction with the private-address filter. GoTavern's transport layer must reproduce effective routing/security behavior, including all proxy protocols it claims compatible. Unsupported SOCKS/PAC or bypass semantics are release blockers for the corresponding config capability, not silent fallbacks.

---

## 13. Data layout and storage

### 13.1 Canonical per-user directories

Preserve exact names/case/spaces from the pinned `USER_DIRECTORY_TEMPLATE`:

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

Also classify data-root state such as `_storage`, `cookie-secret.txt`, `_uploads`, `_css`, `_errors`, content logs, caches, heartbeat/access-log state and any migration artifacts.

### 13.2 Unknown-field preservation

When mutating only part of a JSON/card structure, retain unknown fields. Do not deserialize through narrow structs and accidentally erase extension/future-upstream data.

If upstream itself replaces the complete submitted object, reproduce that replacement semantics rather than inventing extra preservation.

### 13.3 Atomic writes and locking

Compatibility-sensitive writes use a shared keyed lock + atomic replacement layer:

1. canonicalize target path;
2. acquire a path-keyed lock;
3. create temp file on the same filesystem;
4. write complete data;
5. apply permissions;
6. flush as appropriate;
7. atomically replace;
8. fsync parent when required for durability;
9. unlock.

Avoid one global mutex. Define stable multi-file lock order.

### 13.4 JSONL chats

Preserve metadata line/message ordering/import/export/integrity/backup semantics. Reads should not rewrite chats. Large chats should be processed incrementally unless a route explicitly requires full materialization.

### 13.5 Character cards

Character handling includes JSON and PNG cards, V1/V2/V3 semantics, import/export, duplicate/rename/delete, attribute merge/edit, image/avatar and sprite side effects. PNG metadata updates must preserve unrelated chunks/image data unless upstream itself re-encodes that operation.

Golden Node fixtures and Node↔Go↔Node mutation round trips are mandatory.

---

## 14. Settings, presets and default content are semantic state

`/api/settings/get` is not a thin `settings.json` read. The pinned endpoint aggregates the settings file plus provider presets, world names, themes, moving UI, Quick Replies, instruct/context/system/reasoning presets and server capability/config flags.

This endpoint is an early compatibility gate because the frontend and extensions derive large amounts of state from it.

Match:

- the fact that `settings` is returned in the upstream representation;
- file filtering and invalid-JSON behavior;
- naming/extension removal;
- sort order;
- all aggregate fields and their types;
- request-compression/capability fields;
- save JSON formatting when observable on disk;
- autosave/backup throttling and snapshot behavior;
- startup settings backup behavior.

Similarly, world info, presets, themes, moving UI and Quick Replies require exact filename sanitization, list ordering, replacement/merge behavior, backups and error shapes.

---

## 15. Prompt semantics: test the final model input

Most sophisticated roleplay semantics are constructed by the unchanged frontend before the request reaches GoTavern. That does **not** make them safe to ignore. Backend tokenization, settings aggregation, persistence, endpoint transformations and provider translation can still change the final prompt.

The authoritative semantic test therefore starts with a real browser state and ends at a recording provider.

The torture suite must cover combinations of:

- Prompt Manager ordering and enabled/disabled entries;
- main/auxiliary/system prompts;
- conversation history and examples;
- character description/personality/scenario/first message data;
- persona;
- group chat nudges/state;
- Advanced Formatting;
- instruct, context, system-prompt and reasoning templates;
- Author's Note at multiple depths/positions;
- World Info insertion positions, ordering and depth;
- World Info recursive/secondary-key/probability behavior under deterministic fixtures;
- World Info outlets/macros where supported by the baseline;
- macros;
- STscript pipes, local/global variables and chat metadata;
- Quick Reply execution and nested scripts;
- regex transformations;
- character-specific preset selection;
- swipes, regenerate, continue, impersonate and quiet/raw/background generation paths;
- streaming and non-streaming;
- reasoning/thinking;
- tool/function calling;
- structured output / JSON schema;
- multimodal message parts where supported;
- custom API URL/key/header/body include/exclude behavior;
- reverse proxies;
- stop strings and provider-specific sampler fields;
- multiple swipes/candidates where supported.

For every applicable scenario compare the Node and Go **provider-wire request**, returned stream interpretation, browser-visible final state and persisted chat after reload.

### Context-budget edge tests

Exact tokenization affects truncation, world-info inclusion and prompt assembly. Add boundary cases where a one-token difference changes what fits in context. A tokenizer that is merely close on ordinary strings is not compatible.

---

## 16. Provider adapters and outbound HTTP

All server outbound traffic must go through a shared transport layer that implements the pinned proxy/bypass, request override, DNS/address-filter, keep-alive, TLS, redirect, cancellation and streaming policies.

Endpoint/provider packages must not instantiate ad-hoc clients that bypass these policies.

Do not force providers into a lowest-common-denominator model. SillyTavern has provider-specific semantics. Preserve provider-specific bodies/headers/routes and omission rules.

### Provider-wire recorder

Tests launch local deterministic mock providers capable of:

- recording the exact incoming request;
- simulating OpenAI-compatible, Anthropic/Claude, Google/Gemini, OpenRouter/custom and text-completion style APIs;
- returning deterministic non-streaming results;
- returning deliberately fragmented streams;
- returning tool/reasoning/multimodal/provider errors;
- delaying responses to test abort/cancellation;
- recording connection cancellation.

Run the identical browser/HTTP fixture once through Node and once through Go and compare the recording.

---

## 17. Streaming

Never buffer a full provider stream to make implementation easier.

Tests compare:

- response status/content type;
- parsed SSE/event sequence where SSE is used;
- terminal sentinel semantics such as `[DONE]` when applicable;
- reasoning/tool-call deltas;
- candidate/multi-swipe behavior;
- representative raw framing;
- time-to-first-flush under a bounded local test;
- error forwarding;
- client-abort propagation.

Reverse-proxy examples must disable buffering for generation routes and use appropriate long timeouts.

---

## 18. Tokenization

Token counts are compatibility behavior.

Every compatible tokenizer endpoint is validated against Node using ASCII, CJK, emoji, combining characters, special tokens, empty input, long prompts, representative chat templates and context-boundary fixtures.

Use a fallback only when the pinned upstream uses the same fallback under the same condition. If exact parity for a tokenizer/model family is not available, mark it partial; do not call an approximation compatible.

Release assets should embed tokenizer resources or use pure-Go/statically linkable implementations where practical so production does not need Node/Python.

---

## 19. Secrets

`secrets.json` remains in the upstream location/format. Preserve unknown keys and `allowKeysExposure` behavior. Atomic writes, restrictive permissions where supported and comprehensive log redaction are mandatory.

Provider-wire test snapshots use synthetic credentials and normalize only secret values, not structural header differences.

---

## 20. Frontend extension ecosystem

Extensions are a core compatibility target because they exercise unstable edges ordinary core UI flows may not.

### 20.1 Static/runtime ABI

Serve the same browser path:

```text
/scripts/extensions/third-party/<extension>/...
```

Match per-user/global precedence, manifest discovery, content types, ESM/static loading and cache behavior. Dynamic imports and imports of upstream internal frontend modules must continue to work because the frontend is unchanged.

### 20.2 Extension management API

Reproduce the complete pinned `/api/extensions/**` surface, including permissions, URL/protocol checks, sanitization, global/per-user destinations, install cleanup-on-invalid-manifest, version/update, branch enumeration, switch, move and delete behavior.

### 20.3 Git without an external runtime dependency

GoTavern release users should not need to install `git`. Implement a built-in pure-Go HTTP(S) Git path sufficient for the pinned extension operations. A system-Git backend may remain available for parity/debugging when `git.backend` requests it, but the default/auto mode must work on a minimal release machine with no system Git.

Parity tests include shallow clone, explicit branch clone, update, remote/version state, unshallow/branch discovery, branch switch and removal.

---

## 21. Real extension probes

Real extensions are pinned test fixtures, not production special cases.

Initial pinned probes:

- Tavern Helper / JS-Slash-Runner: `N0VI028/JS-Slash-Runner` at revision `837a6288135cde61522a9279173b98020f08807e`;
- LittleWhiteBox: `RT15548/LittleWhiteBox` at revision `9e71caef9ba7b3ca324ce9f1cb06a69ff54d734b`.

A release also runs a non-gating smoke job against their then-current compatible default branches to detect ecosystem drift early. Reproducible gating remains pinned.

### 21.1 Tavern Helper is a deep semantic probe

Do not reduce its acceptance test to “manifest loaded”. Current code directly exercises character import/create/edit, avatars, settings, extension management, model status and chat-completion generation, while also importing SillyTavern frontend internals and participating in generation events/reasoning/tool-call/stream handling.

Mandatory Tavern Helper scenarios include:

- install from its repository through the normal UI/API;
- reload/discovery/static imports with zero console/module errors;
- character import/create/edit through extension paths;
- persona/avatar operation;
- world-info/lorebook read and mutation;
- variables and STscript interaction;
- UI/card rendering;
- raw/background generation helpers;
- custom OpenAI-compatible endpoint;
- streamed reasoning;
- tool calling + schema;
- generation event order/payload checks;
- extension update/version/branch/delete;
- persistence followed by browser reload.

`docs/extension-route-coverage.md` records statically discovered and dynamically observed backend routes. Missing routes fail the extension gate.

### 21.2 LittleWhiteBox and the server-plugin boundary

LittleWhiteBox's frontend directly exercises standard SillyTavern APIs such as files, world info, groups and image-generation proxy routes; these standard-API workflows are valid compatibility probes and must work unmodified.

The currently inspected LittleWhiteBox repository also ships `server-plugin/littlewhitebox-server`, mounted under its own `/api/plugins/littlewhitebox-server/` namespace for features including background image/draw jobs and Exa proxying. Those capabilities are Node server-plugin functionality and therefore fall under the explicit project non-goal.

The acceptance report must distinguish:

- frontend-only / standard-SillyTavern-API LittleWhiteBox functionality: required to pass;
- functionality that truly requires `littlewhitebox-server`: explicitly outside scope, reported as such;
- any unexpected standard-API regression: release blocker.

Do not add fake `/api/plugins/littlewhitebox-server/*` success responses, and do not special-case the extension in production code.

---

## 22. Complete upstream HTTP surface

Phase 0 enumerates every route/method, but the baseline mounted private namespaces include at least:

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

Also inventory routes outside these routers such as root/login/callback/CSRF/ping/proxy/version, public users endpoints, static/user-resource routes, and every 308 legacy redirect.

`docs/api-inventory.md` must be generated or mechanically checked against pinned source so a forgotten file cannot disappear from the plan.

---

## 23. Differential test architecture

A route test alone is insufficient. For semantic workflows use a four-observer harness:

```text
                 same browser fixture
                        |
            +-----------+-----------+
            |                       |
      Node baseline              GoTavern
            |                       |
       recording provider      recording provider
            |                       |
      fixture data tree        fixture data tree
            |                       |
       browser event log        browser event log
```

Compare four surfaces:

### A. Browser -> server

Capture method/path/query/headers/body and verify the unchanged frontend generated the same logical request state in both runs.

### B. Server -> provider

Compare provider-wire requests after narrowly redacting nondeterministic secrets. This proves complex preset semantics actually reach the model unchanged.

### C. Provider -> server -> browser

Feed identical deterministic provider responses/streams and compare statuses, parsed stream events, error behavior, cancellation and final browser state.

### D. Persistent side effects

Diff data trees after mutations and reload both browser sessions. Unknown differences fail unless explicitly classified as allowed nondeterminism/cache/temp output.

### Normalization rules

Never globally sort JSON, delete fields or ignore files just to make tests green. Every normalization has a local written reason (random CSRF token, timestamp, temp filename, etc.).

---

## 24. Semantic torture suite

`docs/SEMANTIC-COMPATIBILITY.md` owns the detailed matrix. The release gate includes at least:

1. **Complex OpenAI-style preset:** many Prompt Manager entries, examples, world info, Author's Note, instruct/context/system/reasoning state, custom stop/sampler fields.
2. **Context boundary:** token budget selected so one-token drift changes history/world-info inclusion.
3. **World Info stress:** multiple insertion locations/depths, deterministic secondary/recursive matching, ordering/outlets/macros.
4. **STscript/Quick Reply:** local/global variables, chat metadata, nested slash commands and save/reload.
5. **Regex:** transformations across configured scopes without double application.
6. **Tavern Helper generation:** custom endpoint + reasoning + tools/schema + stream.
7. **Group chat:** multiple characters/group metadata/prompt construction.
8. **Continuation modes:** regenerate/swipe/continue/impersonate/quiet/raw generation.
9. **Provider translations:** OpenAI-compatible, Claude, Gemini, OpenRouter and custom request overrides.
10. **Failure semantics:** provider 4xx/5xx, malformed stream, disconnect, client cancel, expired auth/CSRF.

A torture test passes only when the expected observer surfaces match. “Both produced readable prose” is not a pass criterion.

---

## 25. Migration architecture

### 25.1 Canonical implementation

The final cross-platform migration engine belongs in the Go executable:

```text
gotavern migrate ...
```

Shell/PowerShell helpers may wrap it. The existing shell copier is transitional until the Go command implements the complete matrix.

### 25.2 Source is read-only

Copy migration never modifies source files: no rename, chmod, cleanup, lock, config migration, backup creation or deletion in the SillyTavern source.

For a consistent snapshot, stop SillyTavern first or use a filesystem snapshot.

### 25.3 Source discovery

Support explicit forms rather than guessing dangerous paths:

```text
--from <SillyTavern-root>
--source-config <path>
--source-data <path>
--source-global
--dest <GoTavern-runtime-root>
```

When a source config uses an absolute/out-of-tree data root, copy the complete source data root into a deliberate destination path and patch **only the destination config** to refer to that copied location. The source remains untouched.

### 25.4 What is copied

At minimum:

- destination copy of `config.yaml`;
- complete configured data root, including `_storage`, cookie secret, all users and compatibility-sensitive hidden/root state;
- global frontend-extension overlay if present;
- relative TLS assets referenced by copied config when selected/needed;
- other path-backed config assets discovered by the migration inventory.

Do not copy `node_modules`.

Detect `plugins/` and print a clear unsupported server-plugin report rather than pretending they migrated.

### 25.5 Symlinks and path safety

Migration preflights symlinks. A symlink that would make the destination still refer into the source/outside an allowed root must fail or require an explicit policy; a “copied” runtime that secretly reads old source data is not a migration.

Preflight all destination conflicts before any write. `--force` may only replace after a destination-side backup. Provide `--dry-run` and a final manifest/count/hash verification mode.

### 25.6 Direct-use mode

Advanced users may point GoTavern directly at existing compatible config/data, but Node and Go must never be writable against that root simultaneously. Direct-use mode still permits the same startup mutations the pinned Node baseline would perform.

---

## 26. Release CI and supply chain

A release workflow must:

1. verify the pinned upstream SHA/version;
2. verify `public/**` and `default/**` manifests;
3. reproducibly build required upstream generated frontend assets;
4. run Go format/vet/tests;
5. run Node-vs-Go contract/startup/roundtrip/provider-wire suites;
6. run Playwright fresh-install and migrated-install E2E;
7. run pinned Tavern Helper and standard-API LittleWhiteBox probes;
8. build all native release archives;
9. smoke-run each native binary where CI runners permit;
10. build multi-arch Docker image (NOT IMPLEMENTED -- see 5.4: no workflow pushes an image);
11. generate `checksums.txt` from the final bytes;
12. attach archives/checksums/reports to one GitHub Release.

The installer contract depends on stable asset names; changing them is a breaking distribution change.

No release job may publish binaries if the compatibility matrix still labels a claimed built-in feature `partial` or `not implemented` while release notes call the build drop-in compatible.

---

## 27. Phases and gates

### Phase 0 — Oracle, inventory, harness, release skeleton

Deliver:

- API/config/startup/data inventories;
- pinned upstream sync/hash tooling for `public/**` and `default/**`;
- generated frontend build reproduction;
- Node reference container/fixture;
- browser/server/provider/filesystem differential harness skeleton;
- release asset naming and cross-compile workflow skeleton;
- installer scripts able to consume those assets;
- initial compatibility matrix.

Gate: no feature is implemented from memory, and a CI dry run can build a native GoTavern artifact without requiring Go on the eventual target machine.

### Phase 1 — Fresh install, boot, auth and frontend

Implement startup config/default seeding, CLI compatibility, static/generated assets, auth/accounts/sessions/CSRF, user binding, root/login/callback/version/ping, user/static overrides and enough settings behavior for the actual UI to boot.

Gate: an empty runtime initialized from a release-style binary reaches the real frontend with zero backend stubs and its resulting default/config/data tree matches the Node reference modulo documented nondeterminism.

### Phase 2 — Core data and semantic state

Implement settings aggregation/backups, characters/cards, chats/groups, world info, presets, avatars/backgrounds/themes/moving UI/Quick Replies/assets/files and related import/export/backup semantics.

Gate: Node↔Go round trips and complex settings/world/preset fixture reloads pass with unknown fields intact.

### Phase 3 — Providers, tokenizers and semantic generation

Implement secrets, outbound transport, provider helper/model endpoints, chat/text completion backends, streaming and exact tokenizers.

Gate: provider-wire differential tests and initial semantic torture suite pass, including context-boundary cases. Merely receiving generated text does not satisfy the gate.

### Phase 4 — Frontend extension ecosystem

Implement extension management/static overlay/Git parity and run real extension suites.

Gate: pinned Tavern Helper deep workflow passes unmodified; pinned LittleWhiteBox standard-API workflows pass; plugin-dependent LittleWhiteBox features are accurately reported as the explicit server-plugin exclusion.

### Phase 5 — Complete built-ins and release qualification

Complete every remaining inventory item: image generation, speech/TTS/STT, translation, search, thumbnails, vectors, classification/caption, content manager, data-maid and all remaining built-ins.

Gate: no unexplained route/startup/config gap, full torture suite green, migrated-install rollback test green, resource benchmark reported, release archive + installer + Docker smoke tests green.

---

## 28. Compatibility matrix semantics

Each route/module/workflow records:

- baseline SHA;
- implementation status;
- HTTP contract tests;
- startup side-effect tests where relevant;
- data round-trip tests;
- provider-wire tests where relevant;
- browser event/E2E coverage;
- real-extension coverage;
- known differences with issue links.

Status meanings:

- `compatible`: no known material difference in tested baseline surfaces;
- `partial`: works in some paths but has a specific known semantic/contract difference;
- `unsupported`: deliberate scope exclusion;
- `not implemented`: absent.

A release may be called **drop-in compatible** only when all pinned built-in SillyTavern behavior is `compatible` except the explicit arbitrary Node server-plugin exclusion, and all release/user-journey gates pass.

---

## 29. Performance target

Measure release binaries, not debug builds, against the same Node baseline dataset/container limits.

Report at least idle RSS/PSS, RSS after representative library/chat load, RSS during stream generation, idle CPU, CPU/request for CRUD, startup time, open FDs/goroutines, binary/archive size and behavior under a 1 GiB memory limit.

GoTavern should be materially lighter than Node and stable on a 1 GiB server. Compatibility cannot be traded away to win a memory chart.

Avoid loading giant chats/card libraries/body limits into memory unnecessarily. Use streaming, bounded caches and spool files while retaining upstream observable semantics.

---

## 30. Security constraints

Compatibility does not justify new Go-specific vulnerabilities. Require canonical path containment, symlink-aware writes/imports, archive traversal protection, bounded archive/decompression, shared SSRF/private-address policy, URL scheme validation, safe Git arguments, request-size enforcement without huge allocation, admin checks and secret redaction.

When a security fix intentionally differs from pinned upstream observable behavior, document it explicitly as a deliberate security deviation and test that it does not silently break supported frontend workflows.

---

## 31. Upstream baseline bumps

A baseline bump is a compatibility project, not a dependency update.

Procedure:

1. choose an exact new upstream SHA/version;
2. regenerate `public/**`, `default/**` and generated asset manifests;
3. regenerate API/config/startup/data inventories;
4. diff CLI/middleware/startup/content/provider changes;
5. run old and new Node references where needed to classify upstream behavior changes;
6. implement Go changes;
7. run complete new Node-vs-Go differential suites;
8. rerun pinned and current-head extension smoke probes;
9. update migration notes/compatibility matrix;
10. only then ship a GoTavern release advertising the new baseline.

---

## 32. Agent implementation rules

When implementing an endpoint or behavior:

1. locate the upstream entry/mount/startup caller;
2. read the full handler plus helpers/middleware/storage/provider transforms that alter observation;
3. add/update the appropriate inventory;
4. add a Node reference probe/differential case;
5. implement the smallest Go behavior that matches;
6. compare HTTP output **and** filesystem/startup/provider-wire/browser-event side effects as applicable;
7. add round-trip coverage for persistent mutations;
8. update the compatibility matrix;
9. keep `main` buildable/runnable;
10. never mark semantic compatibility based only on a successful response or chat.

If a behavior is unclear, run the pinned Node implementation and record it. Do not infer Express/Node/library behavior from memory when it can be measured.

---

## 33. Definition of done

GoTavern reaches its stated goal when a non-developer can download/install a release on a supported machine with no Go/Node toolchain, either start fresh or migrate an ordinary/custom SillyTavern 1.19.0 deployment, keep the same reverse-proxy/browser workflow, and use the real upstream frontend with complex characters, chats, presets, world info, macros/scripts, provider options and supported frontend extensions without source modifications.

For complex roleplay workflows, Node and Go must produce equivalent final provider requests and equivalent persisted/browser state, not merely both generate text.

The user must be able to update GoTavern without losing mutable data and return to an equivalent SillyTavern baseline without data conversion.

The single ecosystem exception remains arbitrary Node.js server plugins, whose dependent functionality must be identified and reported rather than faked.

---

## 34. Product gates added 2026-10-25 (P0-A, P0-B, P0-C)

Three user-visible failures reached a release. They are recorded here as contracts because each one was
invisible to the existing gates, and a contract that only lives in a bug report is a contract that will be
broken again. Measurements: `docs/network-egress.md`, `docs/startup-state-machine.md`.

### 34.1 Two transports, and only one of them carries user traffic

- `internal/outbound` keeps the wire-exact client. Its job is to reproduce pinned's request bytes so the
  provider-wire fixture can observe them; it is a measuring instrument.
- A production transport, built on `net/http` with `Proxy: http.ProxyFromEnvironment`, explicit
  `DialContext`/`TLSHandshakeTimeout`/`ResponseHeaderTimeout`/idle limits, keep-alive, a redirect policy and
  transparent decompression, carries every provider request a user makes.
- Acceptance is a matrix that fails today: HTTPS non-stream, HTTPS stream, 401, 403, 429, 5xx, a delayed reply,
  a chunk boundary that splits a UTF-8 character, an abrupt mid-stream close, an HTTP proxy, a CONNECT proxy,
  `NO_PROXY`, a TLS failure, and a redirect — each with a causal error message.
- The wire-exact fixture must keep passing through the wire-exact client unchanged. Neither transport may be
  deleted to make the other's tests pass.

### 34.2 Startup is bounded, staged and read-only

- Every lock acquisition carries a bound and reports `config is locked by another GoTavern process (waited Ns)`.
- Startup emits named stages (`startup.begin` … `startup.ready`) with duration; a hang therefore names itself
  instead of looking like a silent initialisation.
- A `config.yaml` that parses is not rewritten for GoTavern's own convenience — but pinned's default insertion
  IS reproduced, because hard rule 13 makes startup behaviour compatibility behaviour and the pinned fixtures
  record the insertion. The exact boundary is §34.4; the invariant that survives is that the user's keys and
  unknown sections survive it and a second boot is byte-identical.
- Readiness is observable (stdout marker plus health endpoint); no test may `sleep` and assume.
- The release artifact must boot from a stock SillyTavern tree in four layouts: CWD = root, foreign CWD,
  Windows archive, Linux archive. Each with a hard timeout that dumps goroutines and the stage trace.

### 34.3 No automatic updates, by default and by ambiguity

**The inherited keys are not inputs.** `extensions.autoUpdate` and `enableServerPluginsAutoUpdate` are read for
reporting only; they never enable an update. The reason is decisive and was measured: GoTavern's fresh install
writes `upstream/generated/default-config.yaml` verbatim (that file IS pinned's `fresh` config, generated from
`probe-config-init.mjs`), and lines 134 and 168 of it say `true`. So "absent ⇒ false" alone fixes nothing — every
fresh install and every migrated stock tree carries an explicit `true` that the user never wrote, and honouring it
reproduces exactly the behaviour the user reported.

The only input that can enable automatic updating is a GoTavern-owned key, `gotavern.autoUpdateExtensions`,
defaulting to false, resolved strictly (boolean true, or the string `"true"` after lower/trim; everything else —
`null`, `"yes"`, `"on"`, `"1"`, `"0"`, numbers, sequences, mappings, junk — is false). `settings/get` reports the
GoTavern value, so the frontend's control reflects the decision that actually governs behaviour. Manual update
paths remain available; only the automatic decision is removed. This is a deliberate divergence from upstream and
it is recorded as one: the pinned config bytes stay byte-identical (hard rules 3/4), and any comparison of config
bytes carries a named exemption for those two keys rather than a re-recorded expectation.

- `extensions.autoUpdatePlugins` and `enableExtensionsAutoUpdate` (the legacy name) follow the same rule: legacy
  values are migrated for reporting, and never enable anything.
- "Check for updates" and "apply updates" are separate decisions with separate flags.
- Boot performs zero updater egress and zero mutation of `extensions/**` or plugins/**`: a recursive hash and a
  `git status` per repository, taken before and after boot, must match, and an egress recorder must show no
  updater-originated request.
- A dirty repository is refused by any manual update path; no forced reset exists by default.

### 34.4 What boot may and may not write (adjudicated 2026-10-25)

Two rules collided and the collision was left in the tree as a red test, which is why it is written down here.

- **Hard rule 13** says startup behaviour is compatibility behaviour and names *config creation, key migration and
  default insertion* explicitly. Pinned inserts its defaults at startup, the pinned fixtures record that
  insertion byte-for-byte, and a replacement that silently stopped doing it would be "safer but different" — the
  failure mode this project forbids as loudly as "different and worse".
- **Rule 27** said a parseable config is not rewritten on boot. As written it is unachievable and, applied to the
  bytes, it was tried and REVERTED: pruning the three auto-update keys out of the merge turned six
  pinned-derived fixtures red (the migration bytes, and — through the merged config — the CORS headers the
  basic-auth and host-whitelist fixtures compare). A fix that requires editing a recorded expectation is not a
  fix; it is a divergence that has to be declared.

The boundary that both rules can hold, and that the code implements:

1. **Pinned's default insertion happens.** A first boot of a parseable config may add the keys pinned would add.
2. **Nothing the user wrote is lost.** Their own keys and any unknown section survive, byte-for-byte.
3. **A second boot is byte-identical.** No re-serialisation drift, no reordering, no "rewrite on every start".
4. **GoTavern never writes an operator-owned decision into the file to make its own behaviour convenient.** The
   auto-update keys are the case that matters, and they are neutralised one layer up (§34.3): they are
   reporting-only, and the only input is `gotavern.autoUpdateExtensions`. Asserting this on the FILE would
   measure the wrong layer, and it is measured on the decision layer instead
   (`config.autoupdate-inherited-true`, `config.autoupdate-fresh-install`, `extensions.gotavern-key-strict`).
5. **Any write that is not pinned's insertion** is an explicit, logged, backed-up migration with an idempotence
   test — rule 27's surviving core.

The adversarial case `config.parseable-config-rewritten` asserts 1-3 and names 4's real home, so the invariant is
measured rather than asserted in prose.

---

## 35. Real-user parity contract (2026-10-25, second pass: P0-D, P0-E, P0-F)

`GOAL.md` is the normative statement of what this project is for. This section records the contracts that
follow from taking it literally, because three of them were recorded as *closed* and were not.

### 35.1 A server that answers only what a fixture asked for is not a drop-in

Pinned mounts seven user-data static trees at `src/users.js:1213-1219`; GoTavern served three of them
(`internal/server/frontend_assets.go`). `/characters/*` is the URL behind a character's full-size avatar,
its sprite set and its live2d models; `/User%20Avatars/*` is a persona/user avatar; `/assets/*` is the
bgm/ambient/blip/live2d/vrm tree. All three answered 404 while the directories existed. Nothing failed,
because every probe exercised only the paths its own scenario needed and no gate compared the *sets*.

The contract is therefore set-based, not path-based: the pinned route inventory is enumerated from the
oracle (every `router.use` mount, every `endpoints/*.js` router mounted by `src/server-startup.js`, every
URL a pinned frontend module builds) and diffed against the Go registrations. A missing row is a test
failure. `AGENTS.md` rules 42-44.

### 35.2 The visual asset surface is a compatibility surface

An asset is compatible when a browser displays it, not when a file exists. The observable chain is:

```
disk file -> data-root resolution -> parse/identify -> URL the frontend builds -> route -> path decode
-> file open -> response bytes -> MIME -> browser decode -> naturalWidth > 0 -> visible
```

Consequences:

- **`/thumbnail` must exist.** Pinned `src/endpoints/thumbnails.js` serves `/thumbnail?type=<bg|avatar|persona>
  &file=<name>`, and the pinned frontend calls it for *every* avatar it renders: `buildAvatarList` in
  `public/script.js` (the character list), `group-chats.js`, `bookmarks.js`, `personas.js`, and
  `backgrounds.js` for background thumbnails. There is no fallback, so an unimplemented `/thumbnail` is not
  "thumbnails missing" — it is "all of those images are broken".
- **This reverses architecture boundary 3 for `/thumbnail`.** That boundary said a Jimp-compatible codec
  decision was required before the route could be claimed, and treated the resulting 404 as closed. The
  correct reading of the boundary is narrower: Go cannot reproduce Jimp's *bytes*, but a thumbnail is not
  judged by its bytes. The product decision recorded here is: serve a real thumbnail produced by a pure-Go
  codec at the configured dimensions, MIME and quality, cached at the same on-disk locations pinned uses
  (`<user>/thumbnails/{bg,avatar,persona}/...`), invalidated by the same triggers, and declare the
  divergence explicitly — `bytes differ (Jimp vs pure-Go codec), observable equal`. The gate asserts the
  observable: status, MIME from `thumbnails.format`, image decodes, rendered dimensions equal the configured
  thumbnail dimensions, cache hit does not re-encode, and the deleted/changed original invalidates.
  `/api/avatars/upload`'s pixel path keeps the original boundary until a user requirement reaches it, because
  there the thumbnail argument does not apply: the *stored file* is the Jimp output.
- **Thumbnail absence is FAIL, never PARTIAL** (`AGENTS.md` rule 46). A startup differential whose expected
  value for a browser-required asset is a 404 is a bug report.
- **Assets and generation are one gate, not two** (`AGENTS.md` rule: combination). One data-root or path bug
  can break an avatar, an extension asset and a preset read simultaneously, so the highest-level browser
  scenario must render avatars/persona/background while a helper-driven generation runs.

### 35.3 Preset semantics: the final request is the contract

A preset is compatible when, for a given character, chat, world book, helper state, variable state and user
input, the request that reaches the model backend is equal to pinned's. Loading the JSON is a parse test.
The harness must hold both halves at once:

- `Node(X) == Go(X)` for every preset X (including real presets with `prompt_order` groups, custom
  `injection_*` entries, `squash_system_messages`, `wrap_in_quotes`, sampler and tool fields, and
  `extensions.tavern_helper` / `extensions.regex_scripts`);
- `X != Y` within one implementation — a harness whose captures do not differ when the preset differs is
  `HARNESS NON-DISCRIMINATING` and fails itself (`AGENTS.md` rule 50).

Runtime `'in_use'` state is distinct from the file on disk: a helper that edits the in-use preset and
generates immediately must see the edit in the provider request, and a reload must not silently replace the
runtime state with the file (or must, if pinned does — the pinned observation decides, not intuition).

**Where preset semantics actually live (measured 2026-10-25).** None of the preset vocabulary appears in the
pinned server's provider code: a grep for `prompt_order`, `promptOrder`, `PromptManager`, `squash_system`,
`names_behavior` and `wrap_in_quotes` across `src/endpoints/backends/*.js` returns **zero** matches, while the
same file reads `request.body.messages`, `stop`, `max_tokens`, `temperature`, `top_p`, `top_k`, `tools`,
`tool_choice`, `json_schema`, `reasoning_effort`, `middleout`, `reverse_proxy` and the rest directly. The
preset is compiled into `messages` by the **browser** (`public/scripts/openai.js` and its `PromptManager`), and
the server's job starts at `request.body.messages`.

Three consequences that decide what a preset harness must be:

- GoTavern does not need — and must not grow — a server-side prompt builder. A Go `prompt_order`
  implementation would be a second engine that can never match the frontend's.
- A preset divergence can still be GoTavern's fault, through the *inputs*: the frontend builds the prompt from
  `/api/presets/*`, `/api/settings/get`, `/api/worldinfo/get`, `/api/characters/*`, extension settings in
  `settings.json`, and the chat file. Any difference in those payloads — a dropped field, a reordered list, a
  normalised name — changes the request without a line of prompt code being wrong.
- Therefore the preset differential is **browser-driven**: the same frontend, the same preset file and the
  same character produce the request, and the two servers are compared at the simulated backend. Server-side
  transforms that DO exist (`middleout`, `convertClaudeMessages`, the Gemini/Google conversion, the
  system-message and prefilling handling) are compared on the same capture, because they happen between
  `request.body` and the provider.

Provenance is required for reporting: a divergence names the message index, its source (preset prompt id,
world-info entry, character field, helper injection id, Author's Note), its depth/role, and the lifecycle
event state of both sides. "Bodies differ" is not a report.

### 35.4 酒馆助手 / JS-Slash-Runner is a browser-level probe

Its value comes from running user code in a sandboxed iframe and driving the host page's generation,
presets, variables, world info, messages and streaming. An in-process import proves nothing about that
architecture, so the probe loads the *pinned extension version* into the *unmodified pinned frontend* in a
real browser against both servers, and asserts on the provider request and the persisted state the helper
produced. The extension tree is read-only: the probe copies it, hashes it before and after, and any mutation
without `gotavern.autoUpdateExtensions=true` is `UNAUTHORIZED EXTENSION MUTATION` (§34.3).

### 35.5 Deterministic simulated model backend

Compatibility work of this kind needs a model backend whose *context* can be inspected, not just a mock that
answers "pong". The simulator records the complete request (target, headers, raw body and digest, member
structure, model, stream flag, messages and roles, system instructions, samplers, stops, tools,
`tool_choice`, response format, reasoning, provider-specific members) and replies by rule (`MARKER_A` present
→ `ACK_A`), including controlled SSE framing, errors, mid-stream closes and delays. It captures and answers;
it never defines correctness — expected context comes from pinned captures (`AGENTS.md` rule 49).

## 36. User artifacts never enter the repository: only derivations do

The rule is `AGENTS.md` 56. This section records the MECHANISM, so a future change does not have to rediscover it.

**The originals are read-only inputs.** `tools/real-fixture-profile.mjs <file>...` reads a card or a preset by path
and prints what must be preserved: prompt counts, `prompt_order` rows and enabled rows, the enabled bitmap hash,
`extensions.tavern_helper` byte sizes, regex counts, and the card's chunk lengths. It writes nothing.

**A derivation is built, not copied.** `tools/build-real-fixtures.mjs --out <dir> --preset name=<path>` replaces
prose, helper script bodies and every name-bearing field with same-BYTE-length markers, refuses when a replacement
changes the document's serialised length, and refuses to write a manifest whose output fails the scanner. Cards are
refused by name until the same pass covers `chara`/`ccv3` (`name`, `creator`, `creator_notes`, `tags`, alternate
greetings, `character_book.name`) AND a content check for prose that violates a platform's rules. That refusal is
why no card has ever been committed.

**The scanner is the gate, and it runs in CI.** `tools/check-fixture-watermarks.mjs --allow-declared <manifest>
<files>` refuses a URL, a Discord handle/invite, an e-mail, a QQ group, a bilibili/patreon/afdian/WeChat handle, a
作者/署名/转载 credit, a 64+ character string with no marker, and any name field (prompt, regex script, helper script
name/info, and the button/data label subtrees) that is not a marker. The only exemptions are entries the manifest
lists by EXACT path and EXACT value, and a manifest entry no fixture carries is itself a refusal.

**CI needs none of the originals.** A leg that wants "a user's own preset" loads the committed derivation
(`tests/browser/fixtures/real/preset-a.json`, `preset-b.json`, via `real-preset-probe.mjs`); a leg that wants "a
user's directory" builds one in Go (`tests/e2e/longlived_test.go` writes a card PNG with a real `chara` chunk, a
12-turn chat, a 30-entry world book, a 40-prompt preset, backgrounds, a persona and extension state into its own
temp dir). Nothing in `.github/workflows/` references a path outside the repository.
---

## 37. Where a request is assembled, where it is observed, and who owns which half (2026-10-26)

This section is the map a reader needs BEFORE debugging a prompt difference. Every claim in it was
measured against pinned source; the ones that were not are labelled.

### 37.1 The data flow of one generation

```
  user types / extension fires
        │
        ▼
  BROWSER (pinned public/**, byte-identical, unmodifiable by us)
    · PromptManager reads the preset file and the live 'in_use' settings
    · prompt_order / enabled flags / markers / injection_* decide the message list
    · world info is scanned and inserted at its positions and depths
    · regex_scripts and promptOnly rewrites are applied to the outgoing text
    · the character card fields, persona, chat history and Author's Note are spliced in
    · tokenization for the BUDGET in the frontend uses its own tokenizer
        │  POST /api/backends/chat-completions/generate  { messages, ...samplers, tools, ... }
        ▼
  GOTAVERN (this server)
    · auth/session/CSRF, body limits, route dispatch
    · settings/presets/worldinfo/characters/chats READS feed the browser above
    · secrets resolution, proxy/allowlist/private-address filter
    · provider ADAPTER: request.body.messages → provider-specific body (convertClaudeMessages,
      Gemini/Google conversion, system-message handling, prefilling, middleout)
    · outbound transport: TLS, proxy, redirects, decompression, timeouts, cancellation
        │  provider-wire request (the observable that decides compatibility)
        ▼
  MODEL PROVIDER (real, or the deterministic simulated backend in tests)
        │  stream / error / close
        ▼
  GOTAVERN relay (SSE parse, error mapping, cancel propagation, disconnect handling)
        │
        ▼
  BROWSER (renders, saves the chat through /api/chats/save, fires helper events)
```

### 37.2 What the browser owns, and what the Go backend owns

This split is the single most misread fact in the project. It was recorded in `AGENTS.md` rule 47 and in
`docs/real-user-input-audit.md` §1, and restated here because a lane that gets it wrong builds the wrong
thing.

**The browser owns prompt assembly.** Measured: a grep for `prompt_order`, `promptOrder`, `PromptManager`,
`squash_system`, `names_behavior` and `wrap_in_quotes` across `src/endpoints/backends/*.js` returns ZERO
matches, while the same files read `request.body.messages`, `stop`, `max_tokens`, `temperature`, `top_p`,
`tools`, `tool_choice`, `json_schema`, `reasoning_effort` and `middleout` directly. Therefore:

- **Preset order is the frontend's.** GoTavern must not grow a server-side prompt builder. A Go
  `prompt_order` implementation would be a second engine that can never match the frontend's — and would
  make the differential compare our engine against itself.
- **Regex application is the frontend's**, for the same reason: `regex_scripts` with `promptOnly` rewrite
  the outgoing prompt in the page. The server's job is to serve the script list faithfully.
- **Helper invocation is the frontend's.** 酒馆助手 runs user code in a same-origin iframe and drives the
  host page's own generation path. Our obligation is every route and asset that path touches, not a
  reimplementation of the helper.
- **Frontend tokenization decides what FITS in the browser's budget**; server tokenization must still be
  exact wherever a route or a truncation decision uses it (`ARCHITECTURE.md` §18, `AGENTS.md` rule 9).

**The Go backend owns everything from `request.body` to the wire, plus the data the browser reads:**

- route/status/header/body parity for every route the pinned frontend builds (`AGENTS.md` rules 42-44);
- the exact bytes of the data it serves — settings, presets, worlds, characters, chats, extension settings —
  because a dropped field or a reordered list changes the prompt WITHOUT a line of prompt code being wrong;
- secrets resolution and the provider adapter, including every provider-specific transform;
- the outbound transport's real-internet behaviour (`ARCHITECTURE.md` §16, `AGENTS.md` rule 29) as distinct
  from the byte-exact wire client (rule 30);
- persistence: unknown-field preservation, atomic writes, and what a restart does to a running server
  (`ARCHITECTURE.md` §13).

**The consequence for a divergence report:** name the message index, its source (preset prompt id, world-info
entry, character field, helper injection, Author's Note), its depth and role, and which half produced it.
"Bodies differ" is not a report, and "the prompt builder is wrong" is not a hypothesis we are allowed,
because we do not have one.

### 37.3 Capture points — where an observation can be taken

| Capture point | What it proves | Where it is recorded |
|---|---|---|
| browser → server request | the frontend's own assembly, and that our routes answer it | provider-wire fixtures, browser legs |
| server → provider request | **the contract** (`AGENTS.md` rule 8): raw target, method, headers, body bytes and SHA-256 | `tests/provider-wire/scenarios/`, `tests/oracle/*.json` |
| provider stream → server → browser | SSE framing, error mapping, cancellation | browser streaming legs, `docs/SEMANTIC-COMPATIBILITY.md` §8 |
| filesystem/startup side effects | boot mutations, seeding, migration | `docs/startup-inventory.md`, startup fixtures |
| browser final state | what the user sees: DOM, image decode, CSS background, console | browser artefact JSONs |

A surface with no capture point is a surface with no gate, and the honest name for it is `unproven` rather
than "probably fine" (`docs/gate-blindspots.md` is the analysis of five such surfaces).

### 37.4 PUBLIC synthetic fixtures versus LOCAL original-input qualification

Two different kinds of input, with different rules, and confusing them is how a privacy failure would
happen.

**PUBLIC synthetic fixtures** are committed and run in Actions. They are either synthesised in Go
(`tests/e2e/longlived_test.go` builds a card, a chat, a world book, a preset and visual assets) or built as
a DERIVATION of a real input by a generator that proves byte-length preservation and passes a watermark
scanner (`AGENTS.md` rule 56, `ARCHITECTURE.md` §36). They are reproducible by anyone, they need no secret,
and they are the only inputs CI ever holds.

**LOCAL original-input qualification** is the channel for the user's actual files. Its purpose is that the
user's real preset and card are the ORACLE, and they may not leave the machine, so no public run can be the
gate for them. Its constraints — isolated copy, execution permitted, transmission forbidden, no reversible
derivative, not a substitute for any public gate — are stated in `AGENTS.md` (collaboration contract, item 5)
and `docs/development-loop.md` §4. It is **NOT YET DEMONSTRATED**, and it is a narrow revision of a broader
rule rather than a general permission to run things locally.

**The rule that keeps them apart:** a PUBLIC fixture must be derivable or synthesisable from the repository
alone; a LOCAL observation may be RECORDED as a finding (counts, hashes, pass/fail, a difference), and may
never be promoted into a fixture by copying its bytes. The generator is the only door between the two, and
it refuses rather than approximates.
