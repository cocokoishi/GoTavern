# Gap sweep: missing / stub / silent-degradation, frontend→route reverse mapping, CLI+startup parity

Measured on GoTavern `292905f` against the pinned reference
`C:\Users\koishi\Desktop\GoTavern\SillyTavern` verified at
`06bde939fb1e9c4c8d8641d810f0a916b5bce127` (read-only; never written).

Method: `git ls-files` / `git grep -I` over the tracked tree, `Select-String` and regex extraction over
`internal/**`, `cmd/**` and the pinned `src/**` + `public/**`, plus the pinned `node_modules/yargs`
source for the yargs defaults. No Go toolchain, npm, Playwright or probe was run. Every claim below
cites file:line on both sides. Anything not citable is listed under **Uncertainty**, not as a finding.

`HEAD` is clean of my writes; my only write scope is this file. Nothing under `.private-fixtures/` was
read, listed, hashed or summarised, and no search was issued against it.

---

## Findings, ranked by user impact

### G-01 — Automatic browser launch is unimplemented, and it is ON by default on a fresh install

| field | value |
| --- | --- |
| surface | startup / post-listener action, CLI+config |
| reference action | `default/config.yaml:20-34` (`browserLaunch:` / `enabled: true` at `:22` / `browser: 'default'` at `:27`); `src/command-line.js:68-71` (parser defaults), `:142-160` (flags), `:247-265` (deprecated `autorun*` aliases), `:311-314` (CLI → config precedence), `:343-368` (hostname + URL construction); `src/server-main.js:362-395` (`postSetupTasks`: reads `browserLaunch.browser` at `:365`, logs `Launching in a browser: <app>...` at `:390`, `await open(url, opts)` at `:391`, non-fatal catch at `:392-394`) |
| GoTavern action | `cmd/gotavern/main.go:218-225` — builds the URL, prints it, then at `:223-225` prints `Warning: automatic browser launch is not implemented; open the URL above manually` and does nothing. Option parsing exists: `internal/commandline/options.go:27-30` (fields), `:141-144` + `:162-165` (flags incl. deprecated aliases), `:187` (defaults), `:221-224` (precedence). URL derivation exists: `internal/commandline/urls.go:53-82` |
| reference observable | the OS default browser (or the app named by `browserLaunch.browser`) opens the resolved launch URL; stdout gets `Launching in a browser: default...`; a failure prints `Failed to launch the browser. Open the URL manually.` and the server keeps running |
| GoTavern observable | nothing is opened; a one-line warning on **stderr**; the URL is printed on stdout |
| difference | pinned opens a browser on every fresh install because the shipped `default/config.yaml` sets `enabled: true`; GoTavern ships the same file (`upstream/default/config.yaml:20`) and therefore resolves `BrowserLaunchEnabled == true` — and then declines. The `browserLaunch.browser` key is never read anywhere in the Go tree (`git grep -I browserLaunch.browser` → no hits), so the app-selection half is absent too |
| reachable by a user? | **yes — the default path.** No configuration needed: a fresh install of pinned opens a browser, a fresh install of GoTavern does not |
| class | **product bug**, documented as an open item rather than a boundary (`docs/compat-matrix.md:15`, `:16`, `:50`; `docs/startup-inventory.md:35`, `:37`). The task's own question — boundary or "we never got to it" — resolves to the latter: there is no architectural obstacle, the URL and hostname logic is already implemented and oracle-tested (`internal/commandline/paths_test.go:364-369`), and pinned's failure mode is non-fatal |
| proposed minimal fix | in `runServer`, when `BrowserLaunchEnabled` is truthy: read `browserLaunch.browser` through the command-line layer, print `Launching in a browser: <app>...` to stdout, then exec the platform opener (Windows `rundll32 url.dll,FileProtocolHandler <url>`, darwin `open`, linux `xdg-open`; the four named apps only when `browser` names one), and on error print pinned's message and continue. Never fail startup. Do **not** put this behind a new flag: pinned's gate is the existing key |
| test that locks it | a unit test with an injected opener recording argv, asserting (a) one invocation with the resolved URL, (b) the URL matches `ResolveBrowserLaunchHostname` + `BrowserLaunchURL` for the four protocol combinations, (c) `enabled: false` → zero invocations, (d) opener error → server still serves and the pinned message is emitted. Differential: run pinned with `browserLaunch.enabled: true` and a PATH-shadowed recorder binary to capture the exact argv/streams |

### G-02 — `DATA_ROOT/access.log` is never written, and `logging.enableAccessLog` is never read

| field | value |
| --- | --- |
| surface | startup middleware / per-connection log + startup output |
| reference action | `src/middleware/accessLogWriter.js:6` (`enableAccessLog`, default true), `:10` (`getAccessLogPath` = `DATA_ROOT/access.log`), `:33-58` (middleware: on the first request from an IP, console-log `New connection from <ip>; User Agent: <ua>` and append `<iso> <ip> <ua>\n`), mounted at `src/server-main.js:153`; `default/config.yaml:187` sets `enableAccessLog: true`; the `listen: true` hint that names the file is `src/server-main.js:439-443` |
| GoTavern action | `internal/startup/access_log_migration.go:20-91` only **moves** a legacy `serverDir/access.log` into the data root, invoked at `internal/startup/data_startup.go:134`. There is no writer: `git grep -I` finds no `knownIPs`, no `New connection from`, no append to `access.log` in `internal/**` or `cmd/**`. `logging.enableAccessLog` is never read (`git grep -I` → zero hits) |
| reference observable | a first request from a new IP creates/appends `DATA_ROOT/access.log` with one timestamped line; `listen: true` also prints the two-line hint block naming that file |
| GoTavern observable | the file is never created by serving; the hint block is not printed (`cmd/gotavern/main.go:201-225` prints only the listener lines and the URL) |
| difference | an operator following pinned's own instruction ("Check the access.log file in the data directory to inspect incoming connections") finds a file that only exists if it was migrated from an old install, and that never grows |
| reachable by a user? | **yes, default-on** |
| class | **product bug**; the writer is not recorded as a gap. `docs/data-layout.md:56` describes the file only as the migration target, `docs/startup-inventory.md:30` admits "startup logging … incomplete" without naming the per-connection log, and `docs/compatibility-matrix.json:805` carries only the migration fixture |
| proposed minimal fix | add a middleware in the pinned position that keeps a `knownIPs` set, and on a new IP prints the console line and appends to `<dataRoot>/access.log`, gated by `logging.enableAccessLog` (default true); a write failure logs and is non-fatal. Add the `listen` hint block to the startup output |
| test that locks it | fixture-free unit test: two requests from one IP → one line; a second distinct IP → two lines; `enableAccessLog: false` → no file; unwritable data root → the request is still served 200 and the failure is logged. Assert the exact line shape against a pinned capture (timestamp/IP/UA) |

### G-03 — The Azure TTS routes (`/api/azure/list`, `/api/azure/generate`) do not exist and no document says so

| field | value |
| --- | --- |
| surface | route coverage / TTS provider |
| reference action | `src/endpoints/azure.js:8` (`POST /list`), `:46` (`POST /generate`, SSML construction and escaping at `:62-64`, `X-Microsoft-OutputFormat` at `:71`, `audio/ogg` at `:82`); mounted at `src/server-startup.js:182` |
| GoTavern action | no `/api/azure` registration exists (`git grep -I "api/azure"` over `internal/**` and `cmd/**` → zero hits; the full route-prefix diff against the 45 pinned mounts yields only `/api/azure` and `/api/volcengine` unexplained) |
| reference observable | `POST /api/azure/list` with a stored `azure_tts` secret and a `region` returns the provider's voice JSON; `POST /api/azure/generate` returns `audio/ogg` bytes |
| GoTavern observable | the generic 404 (no route registered) |
| difference | the Azure TTS provider is selectable in the stock frontend — `public/scripts/extensions/tts/azure.js:143` (`/api/azure/list`) and `:191` (`/api/azure/generate`) — and 404s on GoTavern while pinned answers |
| reachable by a user? | **yes** — pick "Azure TTS" in the TTS extension and press a read-aloud button |
| class | **product bug / undocumented missing route.** It is *not* one of the recorded boundaries: the wire format lives in the pinned server's own source (not in a dependency), the upstream is ordinary outbound HTTPS, and no local ONNX pipeline is involved. A grep for `azure` across `docs/` returns only `azure_openai` (the chat-completion source: `docs/generated/coverage-matrix.json:11`, `docs/surface-coverage.md:42`) — the TTS routes are unmentioned |
| proposed minimal fix | implement both handlers from `azure.js` (secret `azure_tts`, `region` required, SSML with the pinned `&`/`<`/`>` escaping, the three pinned headers, `audio/ogg`), and add a controlled-peer probe scenario |
| test that locks it | probe with a stub peer asserting the exact URL (`https://<region>.tts.speech.microsoft.com/...`), method, header set, SSML body bytes and the 403/400/500 branches; plus a route-presence assertion against the pinned mount list so a future mount cannot be added silently |

### G-04 — `/api/volcengine/generate-voice` does not exist, while its secrets ARE configurable

| field | value |
| --- | --- |
| surface | route coverage / TTS provider |
| reference action | `src/endpoints/volcengine.js:9` (`POST /generate-voice`), default endpoint `:14`, 403 on missing credentials `:20-23`, 400 on missing `resource_id`/`text`/`voice_speaker` `:29-32`, the `X-Api-*` header set `:36-40` and the `req_params` body `:42-60`; mounted at `src/server-startup.js:183` |
| GoTavern action | no route (`git grep -I "api/volcengine"` over `internal/**`/`cmd/**` → zero hits). The two credential keys **are** declared: `internal/startup/secrets_state.go:105-106` (`volcengine_app_id`, `volcengine_access_key`) |
| reference observable | the route proxies to `openspeech.bytedance.com` (or a caller-supplied `provider_endpoint`) and streams the audio back |
| GoTavern observable | the generic 404 |
| difference | the user can save Volcengine credentials in GoTavern's own secrets UI and then every synthesis request 404s. `volcengine` appears **nowhere** in `docs/` (`git grep -I` over `docs/` → zero hits) and the frontend calls it at `public/scripts/extensions/tts/volcengine.js:297` |
| reachable by a user? | **yes** — select Volcengine TTS; the credentials path is fully wired |
| class | **product bug / undocumented missing route** (same reasoning as G-03: pinned-owned wire format, ordinary outbound HTTPS) |
| proposed minimal fix | implement the route with the pinned default endpoint, the 403/400 guards, the `X-Api-*` headers and the `req_params` body; add a probe |
| test that locks it | probe asserting the default endpoint literal, the header set, the body member order, and the 403/400 branches; plus the route-presence assertion described in G-03 |

### G-05 — `cacheBuster.*` is accepted and ignored, so `Clear-Site-Data` is never emitted

| field | value |
| --- | --- |
| surface | middleware / cache invalidation after an upgrade |
| reference action | `src/middleware/cacheBuster.js:28` (`cacheBuster.enabled`, default **false**), `:29` (`cacheBuster.userAgentPattern`), `:45-66` (`shouldBust`), `:72-85` (once per `handle` + sha256(user-agent)), `:101-105` (`Clear-Site-Data: "cache"`) |
| GoTavern action | no `Clear-Site-Data` header anywhere; `internal/server/avatars_upload.go:94-96` is a comment *describing* the pinned behaviour, not an implementation; neither key is read (`git grep -I cacheBuster.userAgentPattern` → zero hits; `cacheBuster.enabled` appears only inside comments) |
| reference observable | with `cacheBuster.enabled: true`, the first response per (user, user-agent) carries `Clear-Site-Data: "cache"` |
| GoTavern observable | no such header, ever |
| difference | the operator who enabled the buster to force clients off stale frontend assets after an update gets no invalidation on GoTavern. Default-off, so this is opt-in only |
| reachable by a user? | yes, when `cacheBuster.enabled: true` is set |
| class | **product bug** (config parsed-but-ignored), undocumented: neither key appears in any compat row |
| proposed minimal fix | a middleware keyed on `handle` + sha256(`user-agent`), gated by `cacheBuster.enabled`, with `cacheBuster.userAgentPattern` compiled as a case-insensitive regex (`''`/absent → bust for all); set the header before the response is written |
| test that locks it | table over (enabled, pattern, UA) × (first request, repeat request) asserting presence, value `"cache"` and exactly-once; plus `enabled: false` → header absent |

### G-06 — `sso.*` is accepted and ignored: SSO auto-login silently degrades to the login page

| field | value |
| --- | --- |
| surface | authentication / login flow |
| reference action | `src/users.js:30` (`sso.autheliaAuth`, default false), `:31` (`sso.authentikAuth`, default false), `:34` (`sso.trustedProxies`, default `['127.0.0.1','::1']`), `:761-765` (inside the login flow: `if (AUTHELIA_AUTH && await autheliaUserLogin(request))` / the Authentik equivalent), `:826` and `:832` (operator warnings for a non-array / accept-all trustedProxies); defaults at `default/config.yaml:116-135` |
| GoTavern action | the three keys are only migrated from their legacy names (`internal/configinit/config.go:70-71`); nothing reads `sso.*` anywhere in the Go tree |
| reference observable | a request arriving through the configured reverse proxy with the SSO header establishes a session without the login form |
| GoTavern observable | the login page, with no indication that the setting was ignored |
| difference | an operator who enabled SSO gets a working-looking but different deployment: users must log in manually. Default-off, so opt-in |
| reachable by a user? | yes, when `sso.autheliaAuth`/`sso.authentikAuth` is true |
| class | **product bug** (config parsed-but-ignored). `docs/config-inventory.md:53-55` lists the keys and their pinned defaults but no compat row states that GoTavern ignores them |
| proposed minimal fix | implement the SSO login path (or, as an interim that is honest rather than silent, warn loudly at startup when any `sso.*` key is truthy). Rule 18 forbids the silent version |
| test that locks it | a request carrying the Authelia header with the key true → session established; with the key false → login page; and an assertion that a truthy unhandled key produces a startup warning |

### G-07 — `privateAddressWhitelist.*` is accepted and ignored: an enabled SSRF filter is silently off

| field | value |
| --- | --- |
| surface | outbound transport policy (SSRF) |
| reference action | `src/server-main.js:337-348` (all five options: `enabled` default false `:340`, `allowedRanges` default `['127.0.0.0/8','::1/128']` `:341`, `log.blockedRequests` default true `:342`, `log.allowedRequests` default false `:343`, `allowUnresolvedHosts` default false `:344`), implemented in `src/private-request-filter.js` (DNS-resolved private-range blocking with per-hop redirect validation) |
| GoTavern action | none of the five keys is read (`git grep -I privateAddress` → one comment at `internal/server/search.go:15`); the only trace is the pinned-derived table at `docs/config-inventory.md:59-63` |
| reference observable | with `enabled: true`, an outbound request resolving into a private range is blocked and logged per `log.blockedRequests` |
| GoTavern observable | the request goes out |
| difference | a security control the operator explicitly turned on does nothing, with no warning |
| reachable by a user? | yes, when `privateAddressWhitelist.enabled: true` is set. Default-off |
| class | **documented-open product gap with a silent-ignore failure mode.** The whole startup step is recorded as `not implemented` at `docs/startup-inventory.md:32`, and `docs/api-inventory.md:232` / `docs/compat-matrix.md:77` explain why `/api/search/visit` is absent for lack of a shared policy. What is *not* recorded is that the setting is accepted and silently ignored — which is the part that misleads an operator |
| proposed minimal fix | implement the filter inside `internal/outbound` (the single outbound policy — a route-local dial policy would be strictly less safe, as `docs/api-inventory.md:232` already argues). If it stays deferred, make startup refuse to be silent: warn by name when a truthy `privateAddressWhitelist.*` key is present |
| test that locks it | with `enabled: true` and a controlled peer on a loopback address: zero outbound requests and the pinned log line; with `enabled: false`: the request proceeds. Assert the request COUNT, not just the status (rule 17) |

### G-08 — `--help` writes to stderr and documents none of the 31 server options

| field | value |
| --- | --- |
| surface | CLI help output, stdout/stderr split |
| reference action | pinned parses with `yargs` (`src/command-line.js:110-267`, usage string at `:111`, 31 `.option(...)` blocks with `describe` text at `:112-266`). The yargs factory enables both built-ins unconditionally — `node_modules/yargs/build/index.cjs` (`Yargs: (…) => { … i.help(), i.version(), … }`) — and the run path calls `this.showHelp("log")` / `showVersion("log")` then `this.exit(0)`, i.e. **stdout**, exit 0 |
| GoTavern action | `cmd/gotavern/main.go:45-48` routes `help`/`--help`/`-h` to `printUsage()` at `:241-250`, whose every line is `fmt.Fprintln(os.Stderr, …)`; the text lists only the subcommands |
| reference observable | `node server.js --help` prints usage plus all 31 options with types and descriptions to stdout, exit 0 |
| GoTavern observable | `gotavern --help` prints five usage lines to **stderr**, exit 0, and names no option |
| difference | two divergences on one surface: the stream (a redirected/piped help output is empty) and the content (no option is discoverable from `--help`; `--port`, `--dataRoot`, `--configPath` etc. are invisible) |
| reachable by a user? | yes, trivially |
| class | **product bug** (UX/discoverability + stream split). No doc claims otherwise |
| proposed minimal fix | print to stdout; generate the option list from `cliOptionKinds` (`internal/commandline/options.go:134-166`) with the pinned `describe` strings, so a new option cannot be added without appearing in help |
| test that locks it | a test that captures both streams: help text is on stdout, stderr is empty, and every key of `cliOptionKinds` appears in the output (this is the "gate with teeth" form — adding an option to the map without a description fails it) |

### G-09 — Stale "DEFERRED / not implemented" comments in eight Go files now contradict the tree

| field | value |
| --- | --- |
| surface | code documentation / boundary audit |
| reference action | n/a (this is GoTavern-internal) |
| GoTavern action | comments claiming absence, each contradicted by a registered route: `internal/server/backends.go:14-18` ("DEFERRED … still `not implemented`: `/chat-completions/status`, `/kobold/generate`, `/text-completions/generate`, `/kobold/transcribe-audio`") — all four are registered (`internal/server/backends_status.go`, `backends_kobold_deferred.go:58`, `backends_textgen_generate.go:59`, and the `/api/backends/kobold/transcribe-audio` registration); `internal/server/backends_kobold.go:8-9` (same two routes); `internal/server/backends_textgen.go:13-14` (same generate route); `internal/server/openai_media.go:11-16` ("DEFERRED … `/caption-image`, `/generate-video`, the four transcribe-audio routes … and the entire `/api/google` domain") — all registered (`openai_caption.go:88`, `openai_generate_video.go:82`, `openai_transcribe.go`, `openai_chutes_transcribe.go:46`, `google_*.go`); `internal/server/sd.go:18-19` and `internal/server/sd_generate.go:13` ("the 19 `*/generate*` routes … remain `not implemented`") — `docs/compat-matrix.md:72` states all 19 are implemented; `internal/server/novelai.go:13-18` (`/api/novelai/generate`, `/api/novelai/generate-image`) — both registered; `internal/server/horde.go:5-9` ("SCOPE: two routes … The rest of the Horde domain … is not implemented here") — eleven `/api/horde/*` routes are registered and `horde_generation.go` implements the generation family |
| reference observable | n/a |
| GoTavern observable | a reader of any of these files concludes a capability is absent |
| difference | these are the exact markers a missing/stub sweep is told to collect; taken at face value they manufacture eight phantom boundaries and hide eight implemented capabilities. They also understate the product in the direction opposite to the usual failure, which is why the project's "documentation may not claim ahead of evidence" rule does not catch them |
| reachable by a user? | no (documentation only) — but it misleads every future lane and every reviewer |
| class | **documentation bug (stale).** None of these is a real gap |
| proposed minimal fix | rewrite each header comment to state what the file implements plus the residue that is genuinely open (e.g. `openai_media.go` should keep only what `openai_transcribe.go` really does not cover), and delete the "DEFERRED" lists that a later wave superseded |
| test that locks it | a cheap gate: for every `not implemented` / `DEFERRED` phrase in `internal/**`/`cmd/**` non-test files, require an accompanying route string that is *absent* from the registrations, or an explicit `docs/compat-matrix.md` row — otherwise fail. (Stated as a proposed gate, not as an existing one) |

### G-10 — AGENTS.md architecture boundary 3 still presents `/thumbnail` as an undecided codec question

| field | value |
| --- | --- |
| surface | project documentation / boundary list |
| reference action | n/a |
| GoTavern action | `AGENTS.md:346-353` says `/api/avatars/upload` and `/thumbnail` are both a codec decision that cannot be claimed `partial`, and `:354-357` says the two startup-differential `/thumbnail` 404s "are THIS BOUNDARY rather than missing work". Both statements are contradicted by the tree and by a later section of the same file: `ARCHITECTURE.md:1395-1406` explicitly **reverses** the boundary for `/thumbnail`; `internal/server/thumbnails.go:8-38` implements it and states the decision; `internal/server/avatars_upload.go` implements the re-encode; `docs/compatibility-matrix.md:351` records the observable-based gate. `AGENTS.md:550-554` (rule 45) then says the boundary reading was wrong and that the user-visible consequence had gone unrecorded |
| reference observable | n/a |
| GoTavern observable | a reader of the boundary list re-derives an implemented P0 as a closed boundary |
| difference | the file asserts a boundary that its own rule 45 and ARCHITECTURE.md 35.2 refute, and that the code has moved past |
| reachable by a user? | no (documentation only) |
| class | **documentation bug (stale/self-contradictory boundary)** |
| proposed minimal fix | rewrite boundary 3 to state the decision — pure-Go codec for `/thumbnail`, pure-Go re-encode for `/api/avatars/upload`, no byte equality with Jimp, observable-based gates — and keep only the genuine residue (`docs/compatibility-matrix.md:160`'s unprobed crop/resize). Remove the claim that the startup-differential 404s are a boundary |
| test that locks it | a doc check that a boundary entry naming a route must not also be described as implemented by a compat row — cheap, but it is the only thing that would have caught this |

### G-11 — `docs/frontend-startup-calls.md` reports three absences that no longer exist

| field | value |
| --- | --- |
| surface | committed inventory (frontend page-load observation) |
| reference action | n/a |
| GoTavern action | the doc's own header says `Requests observed during page load: 229. Page errors: 0.` and its closing section says `Blocking candidates: 1 missing` naming `POST /api/horde/text-workers` (`:12`, `:242-244`); it also records `GET /thumbnail?type=persona&file=user-default.png` → 404 (`:56`) and `GET /css/user.css` → `no response` (`:46`). All three are now served: `/api/horde/text-workers` is registered at `internal/server/horde.go:118` and implemented at `:227-255`; `/thumbnail` is registered at `internal/server/thumbnails.go:134`; `/css/user.css` at `internal/server/frontend_assets.go:109` |
| reference observable | n/a |
| GoTavern observable | the doc's negative claims are false |
| difference | the artifact a lane would consult to answer "which frontend calls are missing" answers with a list that is wrong in three places, one of them labelled *blocking* |
| reachable by a user? | no (documentation only) |
| class | **documentation staleness.** Separately: the doc is a *page-load* observation, not the rule-43 oracle-derived inventory — it only contains the URLs one load happened to request, so its silence about a route is not evidence of absence either |
| proposed minimal fix | mark it with the commit and build it was measured against, and regenerate it in the same change as any route work; or fold it into the route-inventory gate so it cannot drift. State in the header that it is an observation, not an inventory |
| test that locks it | assert the doc's `missing` rows against the live registration set (the same assertion G-03/G-04 propose for mounts) |

### G-12 — `/api/horde/text-workers` re-serialises the upstream body, so the response bytes differ from pinned

| field | value |
| --- | --- |
| surface | browser-facing response bytes |
| reference action | `src/endpoints/horde.js:67-74`: `fetch(...)` → `await fetchResult.json()` → `response.send(data)`, i.e. Express `JSON.stringify`, which preserves the parsed member order and does **not** escape `<`, `>`, `&` |
| GoTavern action | `internal/server/horde.go:243-252`: `json.Unmarshal` into `any` → `json.Marshal` → the same bytes are then served by `respondJSONBytes` (`internal/server/secrets.go:366-372`). Go marshals maps with sorted keys and escapes `<`, `>`, `&` as `\u003c`/`\u003e`/`\u0026` |
| reference observable | member order as the provider sent it; HTML characters literal |
| GoTavern observable | alphabetically sorted members; HTML characters escaped (and the weak ETag at `secrets.go:369` computed over those different bytes) |
| difference | the JSON *semantics* are equal, so no user-visible effect is proven; the bytes are not. This is reported as a low-severity wire-shape divergence, not as a broken feature |
| reachable by a user? | not demonstrably |
| class | **product bug (minor) / user impact uncertain.** The existing test cannot see either difference: `internal/server/horde_test.go:259-281` asserts `strings.Contains(body, "worker-a")` on a fixture with a single member (`[{"name":"worker-a"}]` at `:263`) and no HTML characters — rule 15's question ("what input would make this assertion fail?") has no answer in that fixture |
| proposed minimal fix | serve the upstream body bytes verbatim (as the route's own `/status` contract already implies) or route the value through the existing `orderedNodeJSON` machinery; if the re-marshal is kept deliberately, record why |
| test that locks it | a fixture whose worker object has ≥2 members in a known non-alphabetical order and a value containing `<`, `&` and a non-BMP character, asserting byte equality with a pinned capture. Note that `/text-models` legitimately re-serialises (the metadata merge at `horde.js:86-94`), so its expected order is the pinned spread order, not the upstream order |

---

## Items checked and found CORRECT (coverage, not hits)

These were examined with the same method and produced no finding. Listed so the sweep's coverage is
auditable rather than implied by its hit list.

**CLI / startup**

1. **The CLI option set is identical to pinned's.** Extraction of `.option('…')` from `src/command-line.js` yields 31 names; `internal/commandline/options.go:134-166` lists exactly the same 31. Set difference is empty in both directions. The four deprecated `autorun*`/`avoidLocalhost` aliases are present and mapped (`:162-165`, `:221-224`).
2. **Unknown CLI options are silently accepted — and that is pinned's behaviour.** `internal/commandline/options.go:341-344` does `if !known { continue }`. Pinned uses `yargs` (`src/command-line.js:110`) with no `.strict()`, `.strictCommands()` or `.strictOptions()` anywhere in the file, so yargs performs no unknown-argument validation either. I had initially assumed commander's error-on-unknown and checked the source before writing it up; the assumption was wrong.
3. **`--version` reaches the SillyTavern baseline, and `/version` is not hijacked.** `cmd/gotavern/main.go:49-51`, `:57-72`; `internal/server/http.go:660-667` answers `pkgVersion`/`gitRevision`/`gitBranch`/`commitDate`/`agent` from the pinned constants. Rule 17 holds.
4. **Signal handling and shutdown.** Pinned installs `SIGINT`/`SIGTERM` handlers (`src/server-main.js:330-331`); GoTavern does the same and closes with a bounded 10 s context (`cmd/gotavern/main.go:227-238`). Rule 24's "every wait has a bound" is satisfied on this path.
5. **Environment-variable precedence.** `SILLYTAVERN_<KEY_WITH_UNDERSCORES>` wins over the file, including when set to the empty string, in `internal/commandline/options.go:431-448` and again in the chat-converter path `internal/server/pinned_chat_config.go:78-87`. This matches the pinned `getConfigValue` shape the code cites.
6. **`gemini.apiVersion` is read** (`internal/server/google_config.go`), not hardcoded — and where pinned hardcodes, GoTavern reproduces the hardcode deliberately: `personGeneration: 'allow_all'` in the video route (`src/endpoints/google.js:522`) is reproduced at `internal/server/google_video.go:18-19` while the image route's config read (`google.js:442`) is kept separate. A "reasonable" unification here would have been the divergence.

**Routes / frontend reverse mapping**

7. **All seven pinned user-data static mounts are served.** `src/users.js:1213-1219` (7 mounts) versus `internal/server/frontend_assets.go:83-90` (6, executed with planted-byte markers by `internal/server/frontend_asset_contract_test.go:57-91`) plus `/scripts/extensions/third-party/{rest...}` at `internal/server/extensions_static.go:77`. The historical `/characters/<file>.png` class is closed.
8. **The extensions static mount keeps the pinned feature guard.** `src/users.js:1219` wraps the mount in `extensionsEnabledFeatureGuard` (`src/endpoints/extensions.js:72-79`, 404 when `extensions.enabled` is false); GoTavern applies the same guard in `internal/server/extensions.go:214-217`, reached from the static route at `extensions_static.go:93`, and the pinned static-middleware precedence is reproduced at `extensions_static.go:89-92`.
9. **Every pinned `app.use` mount has a Go counterpart except the two in G-03/G-04.** Diffing the 45 mounts in `src/server-startup.js:141-187` against the registered route strings leaves only `/api/extra/classify` and `/api/extra/caption` (explicit boundary 2 — local ONNX), `/api/azure` (G-03) and `/api/volcengine` (G-04).
10. **`/api/sd/comfy/*` and `/api/sd/comfyrunpod/*` are complete.** `src/endpoints/stable-diffusion.js:385-635` (two sub-routers, mounted `:2199-2200`) versus the ten `comfy` routes and two `comfyrunpod` routes in Go; the frontend's `/api/sd/comfy` and `/api/sd/comfyrunpod` literals are base URLs for concatenation, not routes of their own.
11. **All 19 `/api/sd/*/generate*` routes are implemented**, matching `docs/compat-matrix.md:72` — the in-code comments that deny this are G-09.
12. **`/api/image/*`, `/api/classify`, `/api/classify/labels`, `/api/summarize`, `/api/caption`, `/api/tts` are not SillyTavern routes at all.** The frontend builds them on `getApiUrl()`, which is `extension_settings.apiUrl` (`public/scripts/extensions.js:48`) — the separately-hosted "Extras" API. Their absence from the Go route table is correct, and this whole class was excluded from the findings after that check.
13. **`/api/edge-tts/*` is absent from both.** `public/scripts/extensions/tts/edge.js:215,233` requests it, but `edge-tts` appears nowhere in pinned's `src/` or `default/`, so pinned 404s it too. Not a divergence.
14. **`/api/plugins/*`, `/api/plugins/edge-tts/*`, `/api/plugins/fandom/*`, `/api/plugins/office/*`, `/api/modules`** — the Node server-plugin loader, hard rule 16's explicit exclusion. Not emulated, not faked.
15. **`/api/search/visit`, `/api/translate/{google,bing}`, `/api/google/generate-voice`** — declared boundaries with their reasons recorded (`docs/api-inventory.md:232`, `docs/compat-matrix.md:77`, `internal/server/google_voice.go:13-27`, `AGENTS.md:358-365`). I re-read each and they remain architecturally sound: the wire format is owned by an imported package, or the route needs a policy that does not exist. These are boundaries, not backlog.
16. **501 is used for "not written yet" and kept distinct from a refusal.** `internal/server/backends_status.go:205-220` (a known source with no ported arm → 501; an unknown source → pinned's own refusal text, *before* the 501 block), `content.go:169-172`, `content_uuid.go:147-149`, `chat_completions.go:377-388`. Rule 17's distinction is preserved and the ordering is commented where it was previously got wrong.
17. **`/api/extra/{caption,classify,classify/labels}` absent with the local-ONNX reason** — `internal/server/speech.go:15-23`, `internal/server/novelai.go:17-18`, `AGENTS.md:336-345`. Boundary 2 holds; no fake fixture exists for them.
18. **`/api/avatars/upload` and `/thumbnail` are implemented with the decision recorded** — see G-10 for the stale AGENTS text; the code and `ARCHITECTURE.md:1395-1406` are consistent with each other.

**Sweep-1 marker triage**

19. **`panic(` in non-test Go code is confined to registry construction.** `internal/server/chat_completions_registry.go:257` and `:260`, both fail-fast guards on a table that cannot be built with an empty name or a nil behaviour. No handler panics.
20. **501 sites are all deliberate and documented** (see item 16).
21. **Discarded errors are idiomatic, not swallowed logic.** Every `_ = …` in `internal/**`/`cmd/**` non-test code is a `Close()`, a `Sync()`, a `fmt.Fprintf` return or a response-body `Write` (e.g. `internal/app/heartbeat.go:119-139`, `internal/configinit/config.go:195-215`, `internal/outbound/transport.go:207`, `internal/server/accounts.go:465`). No branch discards an error whose loss would change an observable.
22. **The chat-backup gap is recorded, and the pointer resolves.** `internal/server/chats.go:16-21` says "See docs/compat-matrix.md for the recorded gap"; `docs/compat-matrix.md:31` and `:32` record the throttled backup and the `chat_metadata.integrity` check as not reproduced, including the consequence ("the backups directory is not written and an integrity mismatch is not rejected").
23. **`openai.randomizeUserId` is still open and still recorded as open.** `src/endpoints/backends/chat-completions.js:2296-2298` (a `uuidv4()` `user` member when the key is true) versus no read in Go; `docs/compat-matrix.md:52` lists it under "Open:". A real provider-wire divergence for that operator, but not an undocumented one.
24. **`extensions.models.autoDownload` belongs to boundary 2.** `src/transformers.js:136` gates a local model download; the local-inference exclusion covers it. `internal/configinit/config.go` carries only the legacy-key migration.
25. **`requestOverrides` is recorded as a known gap.** `src/additional-headers.js:203-204` applies config-driven header overrides to outbound requests; GoTavern records it at `internal/server/search.go:321-322` and `docs/compat-matrix.md:77`. Documented.
26. **The `extensions.autoUpdate` / `enableServerPlugins*` divergence is a recorded product decision, not a silent one.** `internal/commandline/options.go:464-472` deliberately does not read the inherited keys and says why; `internal/commandline/autoupdate.go` carries the resolution. Rule 26's OFF-by-default override is visible in the code.

---

## Uncertainty (not findings — no citable oracle, or no observable consequence established)

1. **`logging.minLogLevel` is never read.** Pinned reads it at `src/util.js:1137` to set console verbosity; GoTavern only migrates the legacy `minLogLevel` key (`internal/configinit/config.go`). Effect is confined to console output volume; I could not establish a user-visible consequence and did not test the output. Not reported as a finding.
2. **`performance.memoryCacheCapacity` is never read.** Pinned uses it as a `MemoryLimitedMap` bound for the character cache (`src/endpoints/characters.js:30-31`). A Go implementation with an unbounded cache differs in memory profile, not in any observable I can cite. Uncertain.
3. **`uncaughtException` semantics differ.** Pinned installs a handler that calls `exitProcess()` (`src/server-main.js:332-335`); Go's `net/http` recovers a handler panic per connection and keeps serving. Whether any user depends on the pinned crash-and-exit behaviour is unknown to me, and the "inherited weakness" rule (AGENTS boundary 5) cuts both ways here. Reported as uncertain rather than as a divergence.
4. **`browserLaunch.enabled` default ambiguity in the inventory.** `docs/config-inventory.md:20` records the key's default as `true` while citing `src/command-line.js:311`; the *parser* default is `false` (`src/command-line.js:68`) and the *effective fresh-install* value is `true` from `default/config.yaml:22`. G-01's severity rests on the latter. The inventory line is imprecise but not wrong for a fresh install; I did not raise it as a separate finding.
5. **The frontend URL extraction is regex-based.** It covered 309 pinned `public/**` files and 333 `/api/...` literals; a URL assembled from fragments in a way my patterns miss would not appear. Every *negative* claim above was therefore re-checked individually against pinned `src/` (items 12-15) rather than being drawn from the extraction, per rule 11. A systematic static enumeration of every URL the pinned frontend builds does not exist in this repository, which is itself the reason G-11 matters.
6. **I did not run anything.** No probe, no browser, no Go test. Every "GoTavern observable" above is a source reading of a handler's response path, not a measured response. The observables are stated at the level the source determines (status, header, body construction, file write) and none of my findings depends on a timing or race behaviour.

## Not claimed

This sweep does not claim the project is complete, and it does not claim any route or behaviour absent
from the lists above is at parity. The three sweeps were bounded by the marker set in the brief, the
pinned mount list, the pinned frontend's literal URL set and the pinned CLI/config surface. Storage,
tokenization, streaming/cancellation, preset semantics and the browser-observable surfaces were not
audited here.
