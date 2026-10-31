# Gap sweep at the Alpha.9 release candidate

Measured on GoTavern `42b7c4d` (the candidate base; this lane's regenerated matrix is the commit carrying
this file) against the pinned reference SillyTavern `1.19.0`, commit
`06bde939fb1e9c4c8d8641d810f0a916b5bce127` (read-only; never written).

This file replaces the 2026-10-25 sweep that was measured on `292905f`. Most of that sweep's findings are
now closed; the dispositions in section 4 are re-verified against the tree at HEAD rather than carried
forward. The ranked list in section 2 is ordered by one question only:

> **Could this stop a real user from safely using GoTavern as a SillyTavern backend replacement?**

It is deliberately NOT ordered by how easy a test would be to write. A gap that is cheap to close but
cannot hurt a user ranks below one that is hard to close and changes the model's context.

## 0. Verdict, and the release condition

Release condition: **`FAIL = 0`; `PARTIAL > 0` is allowed when every partial row is understood, documented,
classified and non-blocking.**

At this candidate the machine matrix is `PASS 2 / PARTIAL 18 / FAIL 1 / NOT_APPLICABLE 1`: `world-info` is
now PASS (its slot-order gate went green in CI at `8de82c2`; see section 4), 18 rows remain PARTIAL, and the
single FAIL is `whole-session-e2e`, a P0 for the tag (section 2, rank 1). The 18 PARTIAL rows are classified
in section 3: **P0 0 / P1 8 / P2 10**. No PARTIAL row hides a P0.

What this lane did and did not run: it re-derived the matrix mechanically (`node
tools/compat-matrix/render.mjs --emit`), ran `node tools/compat-matrix/check.mjs` green, re-resolved every
citation with an independent resolver that does not import `render.mjs`, audited every historical status
transition, and read the tree for each closure in section 4. It ran the local document gates (`tools/compat-matrix/check.mjs`,
`tools/generate-doc-facts.mjs --check`, `go test ./internal/fixtures -count=1`) but **no browser probe and no
CI workflow**; freshness of every run-cited claim is the Lead's re-run at the frozen candidate SHA (section 5).

## 1. Severity classes

| class | meaning | tag effect |
| --- | --- | --- |
| **P0** | data loss/corruption, startup failure, a broken core browser workflow, an existing stock tree that cannot start, installer data destruction, or a materially wrong provider request | blocks the tag |
| **P1** | important but bounded: a real capability is unproven or a secondary feature is materially incomplete, with no observed corruption and a documented workaround/limitation | ships only with an accepted, written residual |
| **P2** | acceptable evidence debt: the mechanism is implemented and gated, the missing piece is an observer, a platform, an extreme edge or a production-only observation | ships, with the evidence gap recorded |

Classes of cause used in section 3: **deliberate architectural boundary** (decided and recorded, e.g. the
Jimp codec divergence, local ONNX), **evidence debt** (the mechanism exists and is gated, the observer is
missing), **production limitation** (the behaviour is genuinely not implemented/qualified), **observer
coverage** (the tests watch HTTP but not the browser, or a mock but not the network), **release-artifact
evidence missing** (source green, shipped archive not exercised for this surface).

## 2. Open gaps, ranked by real-user impact

This is the same ranked list as `docs/compatibility-matrix.json`'s `gaps` (regenerated into
`docs/compatibility-matrix.md`), where each entry also names the row and the evidence.

| # | gap (row) | would it stop a real user? | cause class | severity |
| --- | --- | --- | --- | --- |
| 1 | The whole-session differential is RED for a real FIRST-TURN provider-context difference (`whole-session-e2e`) | **yes** - the model is given different context on the first turn after a page load than pinned Node gives it; this is the product promise | product parity defect | **P0** |
| 2 | An existing user's tree is qualified through a DERIVED stock tree, and hand-back after GoTavern has written the tree is not in the packaged drop-in gate (`packaging-release`) | **yes for the target audience** - an existing SillyTavern user, until the stock tree is recorded and one round trip returns the tree to pinned Node | release-artifact evidence missing / production-vs-derived limitation | **P1** |
| 3 | Preset features outside the measured contract are unasserted: instruct/context templates, secondary world-info keys, recursion/probability/outlets, group-chat presets (`presets-and-ui-content`) | no for an ordinary preset; a complex preset can diverge with no gate | evidence debt | **P1** |
| 4 | Chat JSONL atomicity is asserted per route but not at a crash-or-kill boundary; the browser save->reload leg belongs to the red whole-session gate (`chats`) | yes if a kill lands mid-write - the conversation is the product - but no failure observed | evidence debt / extreme edge untested | **P1** |
| 5 | CharX, BYAF and RisuAI imports are unimplemented; avatar crop/resize is unprobed; no browser create/read-back (`characters`) | yes for a user arriving with one of those card formats; ordinary PNG/JSON/YAML use is unaffected | production limitation + deliberate codec divergence | **P1** |
| 6 | Every REMOTE embedding provider answers 500; only webllm/koboldcpp and caller-supplied vectors work (`embeddings-vector`) | yes for a user enabling vector storage with a remote provider; not the default chat journey | production limitation | **P1** |
| 7 | Every provider differential runs against this repository's own recording peer; a real provider through a real proxy is exercised by the user and nothing here (`providers-transport`) | no for a user with a working provider, but the corpus cannot prove the real path | production-vs-mock limitation / evidence debt | **P1** |
| 8 | 酒馆助手 render path, DOM URLs and variable persistence remain unproven; the ordinary asset-serving path is now executed (`extensions`) | no for a normal extension install; a workflow depending on persisted variables or rendered URLs stays unproven | secondary feature evidence gap / observer coverage | **P1** |
| 9 | With no tokenizer tree an inexact count cannot be told apart from an exact one; resolution is unproven beside a user's data (`tokenization`) | no for a fresh install, but AGENTS.md 9 makes exact tokenization mandatory where marked compatible | deliberate inherited weakness / evidence debt | **P2** |
| 10 | Media re-encoding is a DECIDED codec divergence; no browser posts a real multipart upload (`files-and-media`) | no - the observable transformation is gated; Jimp byte equality is explicitly not claimed | deliberate architectural boundary / evidence debt | **P2** |
| 11 | Two users writing the same world/preset tree concurrently is untested; per-user locks are asserted per route (`accounts-multi-user`) | no for a single-user install; yes for a multi-user deployment under contention | evidence debt / extreme edge untested | **P2** |
| 12 | No sweep asserts a stored secret is never printed on ANY error path, only on the probed routes (`secrets`) | no, but a leaked key is unrecoverable for the user | evidence debt | **P2** |
| 13 | Server plugins and local ONNX embeddings are excluded, and the exclusion is only as visible as the last document that mentioned it (`server-plugins`) | for the small set of users who rely on them, yes; they must learn it before installing | deliberate architectural boundary | **P2** |

The P2 rows are correctly below the user-blocking ones: each is a decided boundary, a narrow edge, or a
secondary surface. None of them can corrupt data or stop a fresh install from starting.

## 3. Release disposition for every PARTIAL row, plus the FAIL row

Columns: the exact capability that is not proven; whether the DEFAULT user journey is affected; the cause
class; the severity; and the one-sentence release disposition.

| row | why not PASS (the exact unproven capability) | default journey? | cause class | sev | release disposition |
| --- | --- | --- | --- | --- | --- |
| `core-http-static` | No release-artifact result for a stock tree, and no gate compares the SERVED frontend bytes against the committed per-file manifest end to end. | yes (every page asset), but this is the most mature area | evidence debt / release-artifact evidence missing | P2 | Safe to ship because route parity and the static contract are fixture- and manifest-pinned and the frontend is served from the pinned embedded bytes; the end-to-end served-bytes gate and the stock-tree artifact result are post-tag evidence work. |
| `auth-session-csrf` | No browser-level session test through the pinned frontend's own client, and no release-artifact result; every assertion is HTTP-level. | yes when basic or per-user auth is enabled; fresh installs ship auth off | observer coverage / evidence debt | P2 | Safe to ship because the session/CSRF contract is recorded against pinned (including the disabled-CSRF variant) and every state-changing browser leg already carries a real CSRF token; a cookie-only browser defect on an auth-enabled deployment is unobserved, not suspected. |
| `settings` | No stock-tree settings save/reload round trip; fixtures write fresh runtime roots, so a real user's settings.json with unknown/legacy keys has never round-tripped. | yes (settings save) | evidence debt / production-vs-fixture | P2 | Safe to ship because serialisation and aggregation are pinned and unknown-field preservation is a hard rule exercised elsewhere; the unproven input is a real user's file, which is evidence work rather than a known defect. |
| `secrets` | No sweep proves a stored secret is never printed on ANY error path; only the probed routes assert it. | yes when a secret is stored | evidence debt (security sweep) | P2 | Safe to ship because every probed route and the shipped-binary error payload are asserted to carry no credential, and this is an incomplete observer rather than an observed leak. |
| `characters` | CharX/BYAF/RisuAI imports unimplemented (honest pinned error shape); uploaded-avatar crop is source-implemented but not Jimp-identical and unprobed; no browser create-in-frontend/read-back E2E. | no for ordinary PNG/JSON/YAML cards; yes for those three formats | production limitation + deliberate codec divergence | P1 | Ships with a named limitation: ordinary card flows are byte-recorded and parity-tested and a CharX/BYAF/Risu import returns the pinned error rather than corrupting data, so the missing formats are a documented capability gap, not a data hazard. |
| `chats` | No crash-or-kill boundary test for JSONL append/rewrite; the one-session save/reload/continue assertion belongs to `whole-session-e2e`, which is red. | yes (chat save/load is the product) | evidence debt / dependency on the FAIL row | P1 | Ships only once `whole-session-e2e` is green at the candidate SHA (that run is the save/reload proof); the crash-atomicity boundary stays a documented post-tag evidence item because writes are already locked and atomic per route. |
| `groups` | No generation test: a group chat's multi-character turn order reaches the provider through a path no fixture covers, and group activation has no browser E2E. | no for single-character chat; yes for group chats | observer coverage | P1 | Ships with a named limitation: group route and metadata-migration parity is fixture-pinned, while the multi-character prompt assembly is unproven and cannot corrupt stored data. |
| `presets-and-ui-content` | Preset features outside the measured contract are unasserted (instruct/context templates, secondary world-info keys, recursion/probability/outlets, group chats); the NAME_MAX host difference is a recorded known difference. | yes (presets are core) | evidence debt | P1 | Ships because the complex-preset keep/drop pair is measured (`keepContext 4260 / dropContext 4259`, 24 vs 26 messages, `providerRequestEqual true`) and both halves of AGENTS.md 48 hold inside that contract; features outside it are documented as unmeasured, not claimed. |
| `providers-transport` | No real-network/provider evidence: every differential runs against this repository's recording peer, and the credential-gated live canaries are not in the default suite. | yes (provider transport is core), but the production transport is the runtime path and internet-shaped failures are gated | production-vs-mock limitation | P1 | Safe to ship because the production transport (TLS/system roots, proxy, bounded timeouts, decompression, redirects, cancellation) is the path users execute, four internet-shaped failure peers plus a shipped-binary test assert the causal taxonomy, and the additive `message` member is a declared superset; a credentialed live-provider run remains the documented evidence gap. |
| `providers-per-source-wire` | Request bytes are compared against a mock peer, so they prove shaping rather than delivery; no per-source evidence from the shipped artifact; the ai21 `requestFraming` block had no producer until it was rebuilt. | yes for the affected provider | production-vs-mock limitation / evidence debt | P2 | Safe to ship because the 15 catalogued sources' request bytes are byte-compared and the delivery half is owned by `providers-transport`; per-source production observation is evidence work, not a known divergence. |
| `streaming-and-cancel` | Nothing open: the row is the matrix's only PASS, with committed browser artefacts and transport-level frame-order/truncation tests. | yes | n/a (PASS) | none | Never compare rows to a PASS row's evidence standard: this row is the standard. Its browser artefact must be covered by the full browser differential at the candidate SHA. |
| `tokenization` | Resolution of a tokenizer tree is proven for a fresh and a migrated root, not for a stock tree whose `src/tokenizers` sits beside user data; with no tree, pinned's guesstimate count is reproduced and cannot be told apart from an exact one. | indirectly yes (context boundaries) | deliberate inherited weakness + evidence debt | P2 | Safe to ship because the boundary gate REFUSES a guesstimating server, the exact-count anchor fixture is gated, and the archive ships `src/tokenizers` with release qualification booting it; the stock-tree layout is the unproven input and is documented. |
| `files-and-media` | Jimp byte equality is not claimed (decided codec divergence); no multipart upload through a real browser; the browser painting a thumbnail itself is a recorded exclusion. | yes for avatars/backgrounds, but the observable is gated | deliberate architectural boundary / evidence debt | P2 | Safe to ship because both routes serve a real pure-Go re-encode and the gate asserts the observable (status, MIME from the original filename, decodability, exact dimensions, the pinned 512x768 box, cover-not-stretch, PNG output, cache behaviour); bytes matching Jimp is explicitly not a product claim. |
| `extensions` | 酒馆助手 render path/DOM URLs and variable persistence remain unproven (Q10 red on both subjects), plus Q12/Q19/Q20 declarations in the artefact; the ordinary asset-serving path IS now executed. | yes for extension users; the plain "files load" half is gated | secondary feature evidence gap / observer coverage | P1 | Ships with a named limitation: the iframe/bridge/generation path, a byte-identical `generateRaw` request and the plain asset-serving surface are proven, while persisted variables and rendered URLs stay unproven and are declared in the artefact. |
| `server-plugins` | Decided exclusion (AGENTS.md 16): arbitrary Node server plugins are not emulated, and `TestPluginsAreReportedAndNeverCopied` asserts the honest negative. | no for users who do not use them; yes for those who do | deliberate architectural boundary / NOT_APPLICABLE | P2 | Ships as an explicitly declared exclusion the operator can see before installing; it is not a partial implementation and no fake endpoint exists. |
| `embeddings-vector` | Every remote embedding source answers 500 at HEAD (openai, togetherai, mistral, cohere, ollama, llamacpp, vllm, vertexai, palm); the local in-process sources are a decided ONNX exclusion. | no default; yes for users who enable vector storage | production limitation (remote) + deliberate boundary (local) | P1 | Ships only with the remote 500s named in the release notes as a known unimplemented surface; it answers honestly (no fake vectors) and does not touch stored chats, but a user selecting a remote embedding source gets an unimplemented status, so advertising vector storage without that sentence would be a documentation defect. |
| `accounts-multi-user` | No contention test for two users writing one world/preset tree; no stock-tree multi-user migration result. | no single-user; yes multi-user | evidence debt / extreme edge untested | P2 | Safe to ship for the single-user product; multi-user operators should be told that concurrent same-tree writes are not gated, and per-user isolation is asserted per route. |
| `import-export-backups` | REQUEST hand-back to Node is absent by design (no proxying, no upstream selector); the DATA hand-back driver and judge exist and passed in Browser differential run 40977195387 (`match`, both directions), but not in the packaged drop-in gate. | yes when importing/backing up | recorded absence + evidence placement | P2 | Safe to ship because restore is proven end to end, the five provider import branches and the UUID classifier are gated to answer 501/404 with zero outbound, and request hand-back is a recorded absence rather than a silent failure; data hand-back belongs in the drop-in gate before the next tag. |
| `startup` | Startup-differential fixtures still start from fresh/migrated roots, not a populated stock tree. The egress half is CLOSED: a runtime recording-resolver gate plus an AST second opinion both exist and are cited. | yes (every boot), but bounded-boot and egress are gated | evidence debt / fixture coverage | P2 | Safe to ship because boot is bounded and local-only with a recording-resolver gate (`TestStartupMakesNoEgressOnAFreshBoot` and the docker-hostname cases), the AST scan covers the shapes the resolver cannot see, and a populated tree is booted by the long-lived e2e and packaged drop-in gates; the startup-differential corpus should add a populated tree post-tag. |
| `packaging-release` | The stock tree is DERIVED from the pinned source rather than recorded from a pinned Node run; data hand-back after GoTavern has run is absent from the packaged drop-in gate; quoted `releaseArtifact` is a workflow step, not a recorded run id. | yes for an existing SillyTavern user, the entire target audience | release-artifact evidence missing / production-vs-derived limitation | P1 | Must be explicitly accepted before the tag: the Linux and Windows amd64 archives are unpacked and booted against a stock tree in both layouts and both config modes, but that tree is a derivation, and a DERIVED tree is one step away from the real migration input this release claims; either record a pinned-generated stock tree and one hand-back in the drop-in gate, or the Lead records this residual in the release notes. |
| `whole-session-e2e` | **The FAIL.** Run 41015209900 (GoTavern whole-session differential) recorded 25 drive + 12 restart steps on both subjects with 37/39 guards green; `completion-1-equal` and `completion-2-equal` differ in ONE system message on the FIRST turn only (pinned 3191 bytes vs GoTavern 2477; pinned sends four example pairs, GoTavern the same pairs minus the first; requests 3-5, after the reload, are byte-identical). | **yes** - the first turn is the cheapest path a new user takes | product parity defect | **P0** | **Must be closed before the tag:** a fresh green whole-session run at the exact candidate SHA, with the comparator verdict and guard list, is the only thing that promotes this row; the release condition `FAIL = 0` cannot be met without it. |

## 4. Disposition of the 2026-10-25 sweep's findings (G-01 to G-12)

Every one is re-verified against the tree at HEAD, not carried forward from the old document.

| old id | finding | disposition at HEAD | evidence |
| --- | --- | --- | --- |
| G-01 | automatic browser launch unimplemented yet ON by default | **CLOSED** | `cmd/gotavern/main.go:254-259` calls `launchBrowser` gated on `browserLaunch.enabled` and never fails the boot; `cmd/gotavern/browser.go` + `browser_test.go`; pinned ordering preserved |
| G-02 | `DATA_ROOT/access.log` never written | **CLOSED** | `internal/server/access_log.go` writes `New connection from <ip>; User Agent: <ua>` and appends the timestamped line, gated as pinned is (middleware mounted only when `listen`, plus `logging.enableAccessLog`); `internal/commandline/options.go:354`; `access_log_test.go` |
| G-03 | Azure TTS routes absent | **CLOSED** | `internal/server/azure_tts.go` serves `POST /api/azure/{list,generate}` (SSML escaping, headers, `audio/ogg`); tests beside it |
| G-04 | Volcengine `generate-voice` absent while its secrets were configurable | **CLOSED** | `internal/server/volcengine.go:77` registers `/api/volcengine/generate-voice` with the pinned guards/default endpoint; tests |
| G-05 | `cacheBuster.*` accepted and ignored | **CLOSED** | `internal/commandline/cachebuster.go` reads both keys and `internal/server/cache_buster.go` emits `Clear-Site-Data: "cache"` with the pinned quoted value; tests |
| G-06 | `sso.*` accepted and ignored | **CLOSED as a SILENT-IGNORE finding** | still not implemented, but `internal/commandline/unimplemented_config.go` plus `cmd/gotavern/config_warning_test.go` make a truthy `sso.autheliaAuth`/`sso.authentikAuth` a loud startup warning, so the failure mode the finding named is gone and the exclusion is visible |
| G-07 | `privateAddressWhitelist.*` accepted and ignored | **CLOSED** | `internal/outbound/privatefilter.go` implements the filter; a warning is printed when `listen` is enabled and the filter is off; `privatefilter_test.go` |
| G-08 | `--help` on stderr and documents no options | **CLOSED** | `cmd/gotavern/main.go:85,155,315` prints usage to the provided stdout writer and the option list is generated from the command-line option map; `startup_test.go` asserts the stream |
| G-09 | stale `DEFERRED`/`not implemented` comments contradict the tree | **CLOSED** | `backends.go`, `backends_kobold.go`, `backends_textgen.go`, `openai_media.go`, `novelai.go`, `horde.go` were corrected on 2026-10-29; the remaining `DEFERRED` strings (`assets.go`, `backups.go`, `content.go`, `nanogpt.go`, `vector.go`) name real recorded gaps |
| G-10 | AGENTS.md boundary 3 presents `/thumbnail` as an undecided codec question | **STILL OPEN, OUTSIDE THIS LANE** | the bullets now record both decisions, but the boundary's INTRO sentence still says "for one of the two routes the decision is MADE, for the other it is still OPEN", which contradicts its own second bullet (`/api/avatars/upload`: DECIDED 2026-10-29). `AGENTS.md` is not `docs/` and is outside this lane's write scope; flagged to the Lead in the lane report |
| G-11 | `docs/frontend-startup-calls.md` reports three absences that no longer exist | **CLOSED** | each negative row is marked `RE-MEASURED 2026-10-29` with the corrected value and the blocking-candidate summary is explicitly `WITHDRAWN`; the header now says it is an observation, not an inventory |
| G-12 | `/api/horde/text-workers` re-serialised with sorted keys and HTML escaping | **CLOSED** | `internal/server/horde.go` now reproduces pinned's `JSON.stringify` order and non-escaping (`6e7ba5a`), with the discriminating fixture in `horde_test.go` |

Two further stale statements were corrected by this lane directly in the machine matrix:

- the `startup` row still claimed "NO GATE ASSERTS THAT STARTUP MAKES NO NON-ESSENTIAL NETWORK ACCESS"
  although `internal/app/startup_egress_test.go` and `startup_egress_source_test.go` exist and are green;
  the closure is now recorded in that row's notes and the tests are cited;
- the ranked-gap list still said the whole-session differential did not exist, that only the Linux archive
  is executed, that the extension ordinary asset-serving path is unproven and that tokenization has no
  boundary-pair gate; all four contradicted their own rows and the tree, and are rewritten in the matrix.

**Closed while this lane was open: world-info slot ORDER.** The ranked gap #3 this sweep started with ("the
before/after/atDepth slots are not asserted to reach the final provider request in pinned's order") was
closed by the lane that built the surface. `tests/browser/worldinfo-slots-comparison.json` records the SAME
486-byte body on both subjects (sha256 `0422801bd299fe5115c264d20f748abec68a714c2b220e80082a37b2e0bd4bcb`),
21/21 guards, slot order [1,2,4] (before@1 system, after@2 system, depth@4 user at 1 from the end), and the
self-test names the specific guard behind each of five mutations; `worldinfo-slots.yml#worldinfo-slots`
re-runs the surface and refuses to finish unless the fresh artefact reproduces the committed one byte for
byte (run 41171073703 at `8de82c2`, success). The two defects the surface found first were FIXTURE defects,
not product defects: a settings write staged before boot suppressed first-run onboarding on the GoTavern
subject, and a user-name step read `#your_name` while the assembled prompt resolves the persona BINDING the
onboarding handler writes; once the fixture was faithful, the product's onboarding path was identical on both
subjects. The matrix row is re-derived PARTIAL -> PASS with the ordering evidenceGap emptied, ranked gap #3
is removed, and the ranks are renumbered.

## 5. Freshness: which rows depend on which run, and what must be re-run at the frozen SHA

**What a green push run does NOT cover.** `ci.yml#oracle` is NARROWED on a push: a `changes` job computes
the probe set from the changed files, so a probe that did not run leaves its fixture byte-identical and the
zero-diff gate cannot see it. The full oracle is only the nightly schedule or a `workflow_dispatch` with an
empty `probes` input (i.e. every probe). `browser-differential.yml` narrows a push to the asset/helper
surfaces; the FULL sweep is only a `workflow_dispatch` with `mode: all` or the nightly schedule. A green
narrowed run therefore cannot be cited for a row whose evidence is the full sweep.

**Pinned-oracle fetch is part of freshness.** Every oracle/browser/whole-session job fetches the pinned
SillyTavern tree through `.github/actions/checkout-pinned` (landed in `7fbd7bf`, used by `ci.yml`,
`browser-differential.yml`, `whole-session.yml`, `worldinfo-slots.yml` and `smoke-metrics.yml`). The action
refuses a caller pin that disagrees with `upstream/SILLYTAVERN_COMMIT`, fetches `refs/heads/release`, and
asserts `git rev-parse HEAD` == the pin before any recording, so a hand-transcribed pin or a moved ref is named
at the pin instead of being recorded as a different baseline. A run that fails inside checkout has no fresh
evidence for any row below, is a harness failure rather than a red product gate, and must be re-run.

| evidence gate | rows that depend on it | freshness requirement at the frozen candidate SHA |
| --- | --- | --- |
| `ci.yml#verify` (`go test ./...`, vet, build, gofmt, assets verify, compat-matrix, doc-facts, coverage-matrix, classifier table, six cross-compiles) | every row's Go evidence ultimately runs here | a green `GoTavern CI` run whose head SHA IS the candidate, with all jobs green |
| `ci.yml#oracle` | core-http-static, auth-session-csrf, settings, secrets, characters, chats, groups, world-info, presets, providers-transport, providers-per-source-wire, streaming, tokenization, files-and-media, extensions, server-plugins, embeddings, accounts, import-export, startup, whole-session (indirectly) | the FULL oracle (dispatch with empty `probes`, or the nightly run) at the candidate; the narrowed push run is not this evidence |
| `ci.yml#browser-evidence` | every row carrying a committed browser artefact | green at the candidate; it recomputes the committed artefacts' claims and reports their freshness, it does not re-record them |
| `browser-differential.yml#differential` (`mode: all`) | world-info, presets-and-ui-content, providers-per-source-wire, streaming-and-cancel, extensions | a FULL browser differential at the candidate; a push-narrowed assets/helper run is NOT sufficient |
| `worldinfo-slots.yml#worldinfo-slots` | world-info (now PASS) | dispatch at the candidate; it re-runs both legs, requires 21/21 guards, and REFUSES unless the fresh artefact reproduces the committed one byte for byte |
| `whole-session.yml#whole-session` | whole-session-e2e, and the save/reload leg inside chats | a fresh dispatch at the EXACT candidate SHA; the row may only cite that run id |
| `dropin-qualification.yml#dropin-current-head` / `windows-inputs` / `dropin-windows` | packaging-release; it is also the only packaged-artifact boot for an existing stock tree | a run at the candidate (it runs on `main`/`lane/**` pushes; a tag-time run must be dispatched if the candidate is not a branch head) |
| `release-qualification.yml#qualify-linux-amd64` | tokenization, startup, packaging-release | **COLD** - the workflow triggers only on a `v*` tag or dispatch; dispatch it at the candidate |
| `release-qualification.yml#qualify-windows-amd64`, `#qualify-upgrade-rollback`, `#qualify-dropin-linux` | packaging-release | **COLD** - same tag/dispatch trigger; dispatch at the candidate |
| `release-install-smoke.yml#smoke-published-linux-amd64` | packaging-release | **DOWNSTREAM** - it smokes the PUBLISHED release, so its evidence can only exist after publishing; its weekly/dispatch run is the post-publish smoke, not a pre-tag proof |
| `docker.yml#docker` | packaging-release (Docker path and publish) | **COLD** - task tags/paths/schedule/dispatch; dispatch at the candidate |
| `smoke-metrics.yml#measure-linux-amd64` / `#paired-linux-amd64` | no matrix row cites it; release-checklist item 13 | **COLD** - weekly schedule/dispatch, no push; dispatch at the candidate and attach the artefact |

**Committed-artefact freshness at this candidate.** `node tools/verify-browser-comparisons.mjs`
(`ci.yml#browser-evidence`) passes, but it also prints freshness facts that must not be smoothed over into
"the browser evidence is current": `streaming-openai-comparison.json` is reported **STALE** (`does not carry
the documentation fields peerKeying that the current recorder emits`), and `helper-comparison.json`,
`helper-generation-comparison.json` and `streaming-framing-comparison.json` are **NOT-RECORDED** in this run
(their surfaces did not run; they are CI-produced rather than committed, which the extensions row states). A
stale committed artefact is still checked against its own claims, but only the FULL browser differential
re-records it against the candidate's code, and a stale artefact must not be cited as a candidate-run
measurement.

**Rows whose evidence can newly FAIL at freeze because it is cold (not because the tree changed):**

- `whole-session-e2e` - its only run evidence is run 41015209900 at head `d01de1d`, not the candidate; the
  row is honest as FAIL today, and only a fresh candidate run can flip it.
- `packaging-release` - five release-pipeline jobs, three of which are tag/dispatch-only; a green at an
  older SHA does not move with the candidate.
- `tokenization` and `startup` - the only shipped-artifact evidence they cite is
  `release-qualification.yml#qualify-linux-amd64`, which has not run at the candidate unless dispatched.
- `world-info` - its PASS rests on run 41171073703 at `8de82c2`; the release-gate freshness run at the
  candidate is `worldinfo-slots.yml#worldinfo-slots`, which also refuses a committed artefact it cannot
  reproduce byte for byte.
- rows whose committed browser artefacts predate the candidate: `presets-and-ui-content`,
  `providers-per-source-wire`, `streaming-and-cancel`, `extensions`. `ci.yml#browser-evidence` recomputes
  their claims, but only a full browser differential re-records them against the candidate's code.

**Build-only evidence, stated explicitly rather than smoothed over.** `release.yml#build` produces six
canonical archives (linux amd64/arm64, darwin amd64/arm64, windows amd64/arm64) and `ci.yml#verify` performs
six cross-compiles. Runtime execution exists only for **linux/amd64** (`release-qualification.yml` plus the
drop-in jobs) and **windows/amd64** (`dropin-windows` + `qualify-windows-amd64`). **linux/arm64,
darwin/amd64, darwin/arm64 and windows/arm64 are BUILD-ONLY**: nothing in this repository executes them, so
no matrix row may be read as runtime-qualified on those targets. `packaging-release` carries that
distinction; the release notes must repeat it (`docs/release-checklist.md` item 19).

## 6. Documents that still state an outdated status

| document | stale statement | disposition |
| --- | --- | --- |
| `AGENTS.md` boundary 3, intro sentence | "for one of the two routes the decision is MADE, for the other it is still OPEN" - the same entry's second bullet records `/api/avatars/upload` as DECIDED 2026-10-29 | **OPEN, outside this lane's scope** (`docs/` only). Flagged to the Lead; it is a one-sentence fix in the same change that touches this boundary |
| `docs/compatibility-matrix.md` | regenerated from the JSON by this lane; a committed copy whose derived count or Markdown disagrees is refused by `tools/compat-matrix/check.mjs` | **CURRENT after this lane's commit**; the 736 -> 740 test-function drift at the base commit is the reason it had to be regenerated |
| `docs/frontend-startup-calls.md` | negative rows and the blocking-candidate summary | **CURRENT** (RE-MEASURED / WITHDRAWN), see G-11 |
| `HANDOFF.md:58` | "docs/compatibility-matrix.md is generated and current" | true only after the regenerated matrix is in the candidate; if HANDOFF is cited as evidence, it must point at this lane's commit |
| `docs/release-notes-v0.1.0-alpha.9.md` | line 154 still says "A mid-stream TLS close is not observed by any gate", but `streaming-and-cancel` is PASS and its evidence includes `TestProductionTransportTreatsAGracefulTLSShutdownMidStreamAsTruncation` (graceful TLS shutdown mid-frame) plus the frame-order and cancelled-prefix properties; the notes also still carry 21 unmeasured `UPPER-CASE` placeholders | **OPEN, owned by the release-channel lane** (its carrier); the TLS-close sentence must be corrected or removed and every placeholder measured on the candidate run before publish (`docs/release-checklist.md` item 26) |
| this file | measured on `292905f`, ranked findings that are mostly closed | **REPLACED by this rewrite** |

## 7. Not claimed

This sweep does not claim the product is complete. It makes no claim about a route or behaviour that is not
named above. It ran no probe, no browser, no Go test and no CI workflow: every observation is either a
mechanical re-derivation of the tree or a source reading, and every run-cited claim is subject to the
freshness table in section 5. The authoritative machine view is `docs/compatibility-matrix.json`, gated by
`tools/compat-matrix/check.mjs`; this document is the human ranking and disposition layer over it.
