# AGENTS.md

GoTavern is a **release-grade drop-in replacement for the SillyTavern server/backend**, not a new frontend and not a partial clone. Read `ARCHITECTURE.md` and `docs/SEMANTIC-COMPATIBILITY.md` before implementation.

## Hard rules

1. **Baseline:** SillyTavern `1.19.0`, commit `06bde939fb1e9c4c8d8641d810f0a916b5bce127` until an explicit baseline-bump PR changes it.
2. **Upstream is the oracle.** Read pinned source and/or probe pinned Node behavior. Never invent routes, defaults, errors, startup effects or provider transforms from memory.
3. **Do not rewrite the frontend.** Pinned `public/**` stays byte-identical; upstream-generated browser assets are built by the pinned upstream build process.
4. **Embed the full fresh-install contract.** `default/**` content/scaffold/config inputs are compatibility assets too, not optional examples.
5. **Production users need no Go or Node.** Stable releases must be prebuilt. Node/npm are allowed only in development/CI/reference builds.
6. **Release UX is product behavior.** Fresh install, update, migration, rollback, manual release download and Docker paths must be tested.
7. **HTTP parity alone is insufficient.** Compare browser HTTP, startup/config mutations, disk state, provider-wire requests, stream/cancel behavior and browser events/state where relevant.
8. **“It can chat” proves almost nothing.** Complex presets must produce equivalent final provider requests, including message order/roles, world info, stops, token limits, tools/schema, reasoning and custom provider options.
9. **Tokenization must be exact where marked compatible.** Context-boundary tests are mandatory.
10. **Use SillyTavern data directly.** No private canonical DB/schema for characters, chats, settings, users, worlds, presets, secrets or extensions.
11. **Preserve unknown fields** unless the upstream operation itself replaces them.
12. **Sensitive writes are locked and atomic.** No in-place JSON/JSONL/card corruption risk.
13. **Startup behavior is compatibility behavior.** Reproduce config creation/key migration/default insertion, directory creation, content seeding and other pinned startup mutations. Do not assume `config.yaml` is read-only once a runtime is started.
14. **Copy migration source is read-only.** This is separate from normal startup behavior. Never mutate the source installation during migration.
15. **Frontend extensions are first-class.** Pinned Tavern Helper is a deep semantic E2E probe, not merely a load test. LittleWhiteBox standard-SillyTavern-API workflows must pass.
16. **Arbitrary Node server plugins are the sole explicit ecosystem exclusion.** Do not emulate or fake plugin endpoints. If an extension feature requires one, report that boundary explicitly.
17. **Do not hijack `/version`.** It remains a SillyTavern compatibility endpoint. Put GoTavern build identity in `gotavern version` / a separate GoTavern namespace.
18. **No fake compatibility.** Missing/different behavior is `partial`, `unsupported` or `not implemented`; never fabricate success.
19. **Keep `main` buildable/runnable.** Commit by coherent contract/module.

## Required workflow

For each endpoint/startup/config/provider behavior:

1. Find its complete upstream call path.
2. Read helpers/middleware/storage/provider transforms that affect observations.
3. Update the relevant inventory.
4. Add a Node-reference differential test before or with implementation.
5. Implement the Go behavior.
6. Compare all applicable observer surfaces:
   - browser -> server request/response;
   - server -> provider request;
   - provider stream/error -> browser;
   - filesystem/startup side effects;
   - browser event/final state.
7. Add Node->Go->Node round trips for persistent data.
8. Update `docs/compat-matrix.md`.
9. Run formatting/tests/build.

If uncertain, write a probe. Do not guess.

## Verification methods

These are rules for how to verify, not what to verify. They come from real failures on this
project, several of which produced a green result that proved nothing. They apply to every
domain.

1. **A mutation run must use `go test -count=1`.** Go's test cache answers `ok ... (cached)` for
   a test whose inputs have not changed, so a mutation that alters a constant can appear to be
   caught, or appear to be missed, without the test ever executing.
2. **Revert an untracked file with a file copy, never with git.** `git checkout -- <path>` on an
   untracked path exits successfully and does nothing. A mutation that was never reverted stays
   in the tree, poisons every later result for an invisible reason, and can be copied into the
   backup you would restore from.
3. **A surviving mutation means the oracle and the implementation are both suspects.** Before
   "fixing" the implementation, check whether the assertion could fail at all. Survivors have
   repeatedly turned out to be oracle gaps — a value that could not cross a boundary, a case
   where two behaviours are indistinguishable — and treating them as implementation bugs leads
   to changing correct code.
4. **Take expectations from an oracle, not from a derivation.** A hand-derived expectation
   records your understanding of the upstream behaviour, not the behaviour. Where a reference
   implementation or a recorded capture exists, it wins. WHERE NO ORACLE CAN EXIST, say so and label
   the test as a derivation rather than dressing it up: the `/api/content/importUUID` UUID-shape
   classifier cannot be probed, because every non-AICC shape performs a fetch on the pinned server,
   so a recorded "501" would be an oracle for behaviour that never ran. It is a source-derived table
   test against the pinned predicates, labelled as such in its row, and the route's OBSERVABLE
   behaviour (501 plus zero outbound requests) is pinned separately. That split — derivation for the
   internal decision, oracle for the observable — is the honest shape when only half is reachable.
5. **Verify committed bytes, not working-tree bytes.** `git archive HEAD` plus blob digests. A
   clean `git diff` does not mean the committed bytes are the recorded ones, and it does not
   mean the working tree matches them. This project has already shipped 626 of 792 vendored
   assets with the wrong line endings while the manifest was self-consistent with the wrong
   bytes and therefore passed.
6. **Check `git log origin/main..HEAD` before reporting.** An unpushed commit is not durable and
   CI has never seen it.
7. **Never let a step that appears to have happened stand unverified.** Assertions that cannot
   fail, reverts that silently no-op, cached test results and probes that never ran are all the
   same failure: evidence that reads as proof but cannot fail. Where a fixture cannot
   discriminate, make the test refuse to run rather than pass vacuously.
8. **A non-zero exit in a PowerShell pipeline may be manufactured by stderr.** When a native
   command writes to stderr and its output is piped or redirected, PowerShell can raise
   `NativeCommandError` and surface a non-zero status even though the command succeeded. Confirm
   a suspected failure by redirecting to a file and reading the command's own exit code, not by
   trusting the pipeline's. The same caution applies to any wrapper that re-derives a status from
   captured text rather than propagating the process status.
9. **A file that is "readable" may still be corrupt.** Writing a file containing non-ASCII text
   through a shell whose default encoding is not UTF-8 produces bytes that fail a strict UTF-8
   decode; most decoders replace the invalid bytes silently, so nothing complains until an editor
   refuses to open the file. Decode generated documents strictly and fail on replacement
   characters, and pass an explicit encoding whenever a shell writes non-ASCII content. This is
   the same failure as the CRLF vendored assets: the artefact looked correct while its bytes were
   not, and every reader that tolerated the damage hid it.
10. **"No failure reported, but the expected outcome did not happen" is a probe-faithfulness
   alarm, not a product finding.** A driver that reports the absence of an outcome while
   reporting no error is usually driving the subject in a way a user cannot, and the subject is
   short-circuiting on a guard the driver never satisfied. Before concluding the subject is
   broken, assert the driver reached the state a real caller reaches — for a browser probe, that
   means the same entry path, the same preconditions, and an explicit check that the subject is
   not already mid-operation. A `false` accompanied by a named failing request is a product
   finding; a `false` accompanied by nothing is a probe defect until proven otherwise. There is a
   third case: when the product ITSELF cannot reach the state the driver needs — because a fresh
   install is missing the data a user would have — the driver is faithful and the finding is a
   product one that merely presents as a probe defect. Distinguish the cases by asking whether a
   real user, starting from the same state, could reach the outcome at all. The inverse error also
   occurs and produced two runs of a phantom defect: a driver whose precondition is STRICTER than
   the product's own gate rejects a legitimate state and blames the product. Derive preconditions
   from the subject's actual gate — the flag the subject itself checks, read from its source — not
   from a state that merely sounds right.
11. **A truncated or filtered listing cannot support a claim of absence.** `Select-Object -First N`,
   `head`, `--depth`, a grep limit or any other bounded output answers "what is in the first N",
   not "what exists". Before concluding that a file, directory or field is missing, query for that
   specific thing and let the query succeed or fail on its own — count it, filter for its path, or
   test it directly. A negative finding drawn from bounded output is the most dangerous kind of
   error this list covers, because it arrives looking like a measurement and is then quoted as
   evidence; it has already produced one false claim that propagated into a project rule.
12. **An artefact derived from a file inherits that file's defects, including an invisible BOM.**
   PowerShell's `Set-Content -Encoding utf8` writes a byte-order mark, so a commit message written
   that way starts with U+FEFF. Ten published subjects in this repository carry one, all of them
   rule-recording commits produced that way, and nobody noticed for months because a BOM renders as
   nothing. Write generated text with
   `[System.IO.File]::WriteAllText(path, text, (New-Object System.Text.UTF8Encoding($false)))`, and
   assert the FIRST byte of anything you generate — not just that it decodes strictly, because a BOM
   decodes perfectly. The check itself is the second trap: `git log -1 --format=%s` piped into
   PowerShell has the BOM at the START of the stream, where the decoder consumes it as a stream
   marker and silently drops it, so a per-commit loop reports zero. Prefix another field
   (`--format="%H%x09%s"`) so the BOM can never land at stream start, and verify the check can
   report a known instance before trusting a negative. The same reasoning applies to any evidence
   file: verify the bytes you produced, not the readability of the bytes you produced. A shell
   redirection is the same trap in a different costume: PowerShell `>` writes UTF-16LE, so
   `git show HEAD:file > file` restored a workflow as a binary blob that YAML still parsed and CI
   still ran, while git reported it as binary and every ordinary tool refused it. Write recovered
   text with `[System.IO.File]::WriteAllText(path, text, UTF8Encoding($false))`, and check the
   first bytes plus whether git says "Bin" afterwards.
13. **A process query that contains its own search text matches itself.** `Get-CimInstance` and `ps`
   read the full command line, and a shell command's own text is part of the command line of the
   wrapper that runs it. Searching for `codex` or `server.js` therefore flags the shell that is
   doing the searching, and the visible result -- "one process found", with a PID that changes on
   every query -- looks exactly like a genuine leftover process. It produced two false findings in
   one session and a kill attempt aimed at the harness's own runner, which aborted the tool call.
   Build the needle at runtime (`'server' + [char]46 + 'js'`), or exclude the wrapper by name, and
   treat a *changing* PID as proof the match is the query itself rather than a stable long-lived
   process. The same reasoning applies to log and repository searches for a term that appears in the
   command you are running.
14. **A probe must not be able to reach the live network, and "I replaced the HTTP client"
   is not the same claim as "no request left this process."** The Horde probe replaced the
   pinned server's `node-fetch` module and still reached the REAL `aihorde.net`, because the
   `@zeldafan0225/ai_horde` SDK calls the GLOBAL `fetch`. The run did not fail: it recorded
   live third-party data into a fixture that would have been committed and replayed as
   evidence, and only the `sd-models` passthrough assertion exposed it because the "recorded"
   payload turned out to be the live model list. Replace EVERY egress path — the module, the
   global `fetch`, and any SDK client — and make the assertion say the peer received exactly
   the requests the fixture claims, so a request that escapes is visible as a missing request
   rather than as plausible data. Prefer a probe that would error without the peer over one
   that would silently succeed without it.
15. **An encoding assertion is vacuous unless the input carries the characters that would be
   mis-encoded.** A mutation that replaced `encodeURIComponent(prompt)` with the raw prompt survived,
   because the transport re-encodes a SPACE in the request target: the peer received `a%20tree`
   either way, so the fixture could not tell the two implementations apart. Adding a prompt with
   reserved characters (`a/b?c&d=e#f%20g` -> `a%2Fb%3Fc%26d%3De%23f%2520g`) made the difference
   visible at the peer and the mutation died. This generalises: any assertion about escaping,
   normalisation, truncation or quoting needs an input that actually exercises the transformation,
   or it passes for the wrong reason. The test for this class is always the same question — "what
   input would make this assertion fail?" — and if no such input exists in the fixture, the
   assertion is decoration.
16. **A fixture whose steps share state is ORDERED DATA, not a keyed map.** The sprite-upload
   fixture first keyed its steps by name and the replay iterated them sorted; because every step
   mutates one shared user tree, sorting desynchronised every subsequent tree snapshot and made the
   whole-tree assertions meaningless while still passing. Store dependent steps as an ARRAY and
   iterate them in recorded order, and let the replay refuse a fixture whose required step shapes are
   missing. The same applies to any recorded sequence where step N's observable depends on step N-1:
   users, chats, avatars, secrets migration, workflow CRUD.
17. **An unimplemented branch must be distinguishable from a refused one.** `/api/content` import
   refuses an unknown host with 404 as a POLICY decision, and the branch's whole value is that a
   404 means "the operator's whitelist said no". Answering 404 for a provider branch that simply is
   not implemented would make that assertion unfalsifiable: a test would see the same status for
   "correctly refused" and "not written yet". Those branches answer 501 instead, so the refusal
   stays meaningful and the gap stays visible. Apply the same split anywhere a route has both a
   policy refusal and unimplemented paths, and assert the number of outbound requests (zero for a
   refusal) rather than only the status.

18. **A field classified `shape` must not record the observed value.** The oracle gate compares the
   fixture's BYTES, so a host-derived value sitting in a `shape` field differs across hosts however
   the field is classified. `sd-routes` had exactly that: a finalhandler development error page was
   classified `shape` for the right reason and its body was STILL recorded, which no Windows-side
   check could see -- recomputing all 83 observations' content-length and ETag from their own bodies
   gave zero mismatches locally, and only the gate found it. Therefore: classify from a
   host-INDEPENDENT property of the scenario ("this body is a rendered error page"), never by
   comparing two values that happen to differ on one host; record `null` for a shape field and keep
   the reason; null its DERIVED fields too, because content-length measures those bytes and the ETag
   hashes them; and REFUSE outright if a scenario tries to classify `status` as shape, since every
   scenario must compare its status. THE SAME RULE APPLIES WHEN THE INSTABILITY COMES FROM A RACE RATHER THAN FROM THE HOST, and the
   sd-routes probe produced the first case: `upscalers.notArray` and `vaes.autoFirst` each start TWO
   outbound requests to different endpoints before awaiting either, so the peer records ARRIVAL order,
   and the probe reads the outbound log immediately after the response -- so when the route answers as
   soon as the first request settles, the losing request has not landed yet and the recorded COUNT is 1
   or 2 depending on timing. Measured: deterministic 5/5 on this host and non-deterministic on Linux,
   which is why only the CI double-run could see it. When a pinned route starts more than one outbound
   request before awaiting them, the fixture must record a sorted SET or NOTHING AT ALL -- never an
   arrival-ordered array and never an observed count -- with the race named in the shape reason, and
   the assertion must live in a labelled source-derived test (rule 4) instead. Do NOT widen the drain
   window to catch the loser: that makes the count stable by luck rather than by contract, and the same
   race reappears under different timing. The one argued exception is a value that is CLIENT-derived and
   byte-stable (`requestHeaders.connection`), which stays recorded with its reason -- nulling it
   would discard information with no host-dependence justification. After any such change, sweep
   every fixture for host-specific strings (`C:\`, `AppData`, `/home/`, `/tmp/`, `/root/`,`/Users/`): the
   sweep is cheap, it is the only check that finds this class, and it found exactly one location
   across 100 fixtures. RUN THE SWEEP CASE-SENSITIVELY: a case-insensitive `/Users/` matches the
   legitimate `GET /api/users/me` path and reports a host path that is not there, which is how a
   sweep turns into a phantom defect and someone sets out to fix a fixture that is already correct.

19. **A `go test -run` filter that matches nothing reports `ok`, which reads as success.** The real
   name of the sd-routes guard is `TestPinnedNodeSDRoutes`; `-run TestSD` does not match it, and Go
   answers `ok ... [no tests to run]` with exit status 0. Every green reported for that fixture under
   a `TestSD` filter was therefore vacuous for the one test that matters, and it was caught only
   because a mutation appeared to survive -- the mutation had never executed. Run the EXACT test name
   (or a prefix that provably matches), and confirm the test actually ran: `-v` shows `=== RUN`, and
   a test that logs a measurement (like the host-derived count) proves its own execution. This is
   rule 7 in a new costume: a green that cannot fail. The same caution applies to any filter used
   before a commit, including mine.

20. **The outbound stub selects a rule by SUBSTRING of the request URL, so overlapping shapes need
   `times` and longest-path-first ordering.** `selectRule` does `href.includes(candidate.match)` and
   returns the FIRST contained match, so a rule matching `/v1/videos` also matches `/v1/videos/{id}`
   and `/v1/videos/{id}/content`. Without a `times` bound, the create rule answered the POLL as well,
   the loop polled the create answer forever, and the probe hung -- a harness defect presenting as a
   product hang, which is the most expensive way for it to present. Two consequences to apply before
   writing any probe whose shapes share a path prefix: give the earlier shape a `times` bound so it
   stops answering, and list the LONGER path FIRST (`/content` ahead of the poll rule, or the poll
   rule swallows the content request and returns JSON where bytes are expected). This is the
   ordered-steps rule (16) applied to the harness itself rather than to the fixture's data. Related:
   a probe must fail by NAMING itself -- per-scenario timeout plus the scenario name and the mocks it
   was served -- because a bare `TimeoutError` cost a full turn to localise while the same defect with
   diagnostics was fixed in one run.

   THE ORDERING DISCIPLINE APPLIES TO ANY CONSUMER OF A RECORDED MOCK LIST, NOT ONLY TO THE PROBE. A
   replay peer that serves mocks by REQUEST ORDER while the fixture's list is ordered for the
   substring matcher will serve the wrong mock to the wrong shape -- the OpenAI video replay gave the
   poll the content mock exactly that way, which is the probe-hang defect one layer over. A consumer
   that does not reproduce the producer's matching semantics is a second place the same bug can live,
   so the replay peer must implement the same substring and times selection the stub does.

   Do not add an exact-path match option to `tools/lib` on
   initiative; it is a lib change and carries the `pipe()` discipline: every outbound probe must
   re-record byte-identically before it is committed.

## Architecture boundaries that are decided, not pending

1. **Arbitrary Node server plugins are the sole explicit ecosystem exclusion** — see hard rule 16.
   Do not emulate or fake their endpoints.
2. **Local in-process ML inference is the second explicit exclusion, and it is not a probe gap.**
   `/api/extra/{caption,classify,classify/labels}`, `/api/speech/{recognize,synthesize}` and the
   local embedding sources inside `/api/vector/*` call `getPipeline()` in `src/transformers.js`,
   which loads an ONNX model through `sillytavern-transformers` and runs it **inside the server**
   (`env.backends.onnx.wasm`). There is no outbound HTTP to replace with a controlled peer, so no
   differential can exist for them at all. They stay `not implemented` with that reason. Serving them
   would mean adopting an ONNX runtime, which contradicts the `CGO_ENABLED=0` distribution rule, so
   it is a product decision that must be made explicitly and recorded here — never absorbed silently
   into a `partial` row. FAKE FIXTURES FOR THESE ARE FORBIDDEN: a recorded "response" would be
   evidence for a behaviour that was never executed.
3. **Image re-encoding is a codec decision, not a test gap.** Two routes are in this class, both
   because their bytes are the output of Jimp. `/api/avatars/upload` decodes, crops, covers and
   re-encodes; `/thumbnail/<computed>` does `Jimp.read` -> `resize` with `ResizeStrategy.BILINEAR`
   -> crop -> `getBuffer(JimpMime.png)` or `getBuffer(JimpMime.jpeg, {quality})`. For both, an oracle
   CAN exist (the pinned output is recordable), but a Go implementation cannot reproduce those bytes
   without a Jimp-compatible codec, so neither can be claimed `partial` through HTTP comparison
   alone. Do not fake byte equality by copying the recorded bytes, and do not add a production seam
   purely to make them testable. Decide the codec question explicitly first.
   This matters for reading the startup differential: two of its four known differences are
   `/thumbnail` 404s, and they are THIS BOUNDARY rather than missing work. Without that stated, a
   future increment would set out to implement thumbnails and discover the codec problem only after
   building a harness.
4. **A behaviour implemented inside a dependency is not ported unless a user requirement forces it.**
   `/api/google/generate-voice` runs a private Google `batchexecute` protocol that lives in the
   `google-translate-api-x` package; `/api/translate/{google,bing}` are the same class. This is NOT
   a pinnability problem -- the package calls the global `fetch`, so a controlled peer captures the
   URL, form body and response and an oracle is entirely possible. The objection is OWNERSHIP: we
   would own a copy of an undocumented private protocol and track that package's changes forever,
   to buy one route, while the project's promise is parity with the SillyTavern SERVER rather than
   with its dependencies. Contrast the Horde SDK, which IS ported: there the pinned endpoint code
   owns the request shaping and only the sockets belong to the SDK. The distinction to apply is
   "is the wire format written in the pinned server's source, or in a package it imports".
   These routes stay `not implemented` with that reason, in their own rows, and the decision is
   REVERSIBLE: a user requirement turns it into an explicit product decision with a stated cost,
   rather than a rediscovery.
5. **Inherited security weaknesses are reproduced AND recorded, never silently fixed or silently
   copied.** Content import (`/api/content/importURL` and `/importUUID`) classifies a provider with
   substring matching on the parsed hostname — `host.includes('chub.ai')`, `host.includes('janitorai')`
   and so on — so a hostname such as `chub.ai.attacker.example` passes `isChub` and is treated as
   chub. Only the generic branch is an exact `whitelistImportDomains` membership check; the provider
   branches are not. A drop-in replacement must reproduce this, because "safer but different" breaks
   parity claims just as badly as "different and worse". It must therefore be stated in the compat
   row as a known inherited property, so an operator can see what they are inheriting rather than
   discovering it. Any deliberate hardening is a separate, visible product decision that changes the
   compatibility claim.
6. Consequence for the coverage claim: the reachable ceiling is the route count MINUS these routes.
   Report the exclusion count alongside the coverage numbers rather than implying 339/339 is
   attainable.

## Where verification runs

The development machine is weak. Spend its cycles on the work only it can do, and let GitHub
Actions spend the rest.

- **Locally:** `go build ./...`, gofmt, and `go test -count=1` for the PACKAGES you changed. That is
  the loop you need while writing code.
- **In CI:** the full `go test ./...`, `go vet ./...`, `gotavern assets verify`, every cross-compile,
  and `tools/build-generated-lib.mjs` — which re-records every oracle fixture and regenerates the
  inventories on Linux and then requires a zero diff.
- **Do not run `tools/build-generated-lib.mjs` locally** to "check" a fixture. It rewrites
  host-dependent fixtures with Windows paths (`account-*`, `basic-auth`, `frontend-static`,
  `host-whitelist`, `per-user-basic-auth` all differ on this host), it takes tens of minutes, and its
  result is not the gate: the Linux CI run is. Push, read the failure, fix from that.
- **Push early.** An unpushed commit has never been tested and cannot be reproached from CI output.
  A red run that names the differing bytes is cheaper than an hour of local guessing.
- When CI runs are the gate, a CI job must be able to tell you WHICH bytes differ. Prefer
  `git diff --exit-code` plus the diff in the log over a bare exit status.

## Phase order

- **Phase 0:** API/config/startup/data inventories; pinned `public/**` + `default/**`; generated frontend reproduction; Node oracle; multi-observer differential harness; release/installer skeleton.
- **Phase 1:** release-style fresh install, startup/config/default seeding, CLI, frontend, auth/accounts/session/CSRF, settings needed for boot.
- **Phase 2:** settings aggregation/backups, characters/cards, chats/groups, world info, presets/templates, avatars/backgrounds/themes/moving UI/Quick Replies/assets/files.
- **Phase 3:** secrets, proxy/SSRF transport, providers, exact tokenization, streaming/cancel, provider-wire parity, semantic torture tests.
- **Phase 4:** extension static/install/update/version/branch/switch/delete; pinned Tavern Helper deep E2E; LittleWhiteBox standard-API E2E.
- **Phase 5:** every remaining built-in + full release qualification.

Do not skip Phase 0 and do not move a phase gate by replacing missing behavior with stubs.

## Distribution rules

Canonical release asset names are defined in `ARCHITECTURE.md` / `docs/INSTALLATION.md`. Installer scripts download prebuilt assets and verify checksums; they must never fall back to cloning/compiling source. Re-running an installer updates immutable release files only and preserves user data/config/extensions/certs.

Prefer `CGO_ENABLED=0`, pure-Go dependencies and a built-in Git path so minimal production machines do not need extra runtimes. If exact parity requires a native dependency, document the operational cost before adopting it.

## Semantic compatibility probes

At minimum keep pinned real probes for:

- `N0VI028/JS-Slash-Runner@837a6288135cde61522a9279173b98020f08807e`;
- `RT15548/LittleWhiteBox@9e71caef9ba7b3ca324ce9f1cb06a69ff54d734b`.

Never special-case these extensions in production code. They are canaries for the general SillyTavern ecosystem.

## Definition of success

A non-developer can install a prebuilt GoTavern release, start fresh or migrate an existing SillyTavern deployment, use the unmodified frontend and complex supported extension/preset workflows, and obtain the same effective provider requests and persistent/browser state as pinned Node SillyTavern—without Go/Node on the target server and without a data conversion layer.
