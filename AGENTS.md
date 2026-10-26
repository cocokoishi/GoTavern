# AGENTS.md

GoTavern is a **release-grade drop-in replacement for the SillyTavern server/backend**, not a new frontend and not a partial clone. Read `ARCHITECTURE.md` and `docs/SEMANTIC-COMPATIBILITY.md` before implementation.

## Hard rules

1. **Baseline:** SillyTavern `1.19.0`, commit `06bde939fb1e9c4c8d8641d810f0a916b5bce127` until an explicit baseline-bump change (its own commit, carrying the pinned-source evidence for every observable it moves) replaces it.
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
9. Let CI run formatting/tests/build. Do not run the Go toolchain, npm, Playwright or any probe on
   this host (see "Working mode: CI-first" below); a local green is not the gate and a local red on this
   host can be a CRLF or host-path artefact rather than a defect.

If uncertain, write a probe. Do not guess.

## Verification methods

These are rules for how to verify, not what to verify. They come from real failures on this
project, several of which produced a green result that proved nothing. They apply to every
domain.

1. **A mutation run must use `go test -count=1`, and it runs in GitHub Actions.** Go's test cache answers
   `ok ... (cached)` for a test whose inputs have not changed, so a mutation that alters a constant can
   appear to be caught, or appear to be missed, without the test ever executing. Mutation evidence is a
   row in the commit message naming what was changed, the assertion that went red, and the restored
   green — produced by a run, never by reasoning about a run.
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
   discriminate, make the test refuse to run rather than pass vacuously. THE SAME APPLIES TO A
   CAPABILITY: an additive change can be verified as harmless and still be the WRONG capability. The
   probe library gained writeConfig/restoreConfig for a config-driven branch, and it passed every
   additive test -- byte-clean, host-side only, two probes re-recording byte-identically, no fixture
   moved -- and was still insufficient, because the pinned server parses config.yaml at STARTUP and a
   running process never re-reads it. The assertion failed with the pinned value named ("actual: 1,
   expected: 2" messages), which is what caught it: additivity answers "does this break anything?" and
   not "does this achieve the purpose?". Prove a capability REACHES the behaviour it was built for
   before building anything on it, and prefer the design that REMOVES a hazard over one that manages it
   -- the boot-time override that replaced the file write also removed the restore, the isolation
   assertion and the ordering constraint, because there was no shared mutable state left to isolate.
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
   not, and every reader that tolerated the damage hid it. THE SAME APPLIES TO A SOURCE LITERAL, AND THE
   FIXTURE CAN HIDE IT: `probe-sd-routes.mjs` held the CP1252 decode of A-umlaut's UTF-8 bytes as a
   scenario's filename (`C3 83 E2 80 9E` on disk instead of `C3 84`). The Windows fixture had been
   recorded while the literal was correct, the literal was corrupted afterwards by a file write with
   the wrong encoding, and no Windows re-record followed -- so a STALE-BUT-CORRECT fixture agreed with
   a corrupt source and hid the defect, while only the Linux gate, which re-records everything, could
   see it. Two consequences: a fixture that agrees with a corrupt source is "readable but corrupt"
   rather than a passing test, so a Windows recording is NOT evidence for a scenario whose input
   changed afterwards; and when repairing such a file, write the BYTES rather than re-encoding the
   whole file, because a whole-file re-encode is how the corruption arrives. A non-ASCII input is what
   exercises this class -- an ASCII-only fixture passes on both hosts -- and a sweep for the CP1252
   signature (`C3 83`, `E2 80 9E`) across the probe sources is the check that finds others.
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
   evidence; it has already produced one false claim that propagated into a project rule. THE SAME APPLIES TO
   VERIFYING A SPECIFICATION: checking its ENUMERATED items is not checking the artefact. A handover
   spec for `/api/sd/comfy/generate` listed five numbered behaviours and a separate sentence claiming
   that only the initial prompt fetch carried an abort `signal`; the five behaviours were verified line
   by line and the sentence was skipped, and the sentence was the one that was WRONG -- no fetch in that
   handler is signal-bound at all, so the abort controller is a no-op. Verify every CLAIM, not only the
   items that happen to be numbered, and when a spec mixes verified behaviour with asserted mechanism,
   treat the mechanism as unverified until it has been read too.
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
   assertion is decoration. THE SAME APPLIES TO THE HARNESS'S OWN VIEW OF A URL: the caption-image
   replay re-anchored each mock rule on `recorded.URL.Path`, which is the DECODED path, so the
   workers_ai account id `acc%2Fone%3Fx%3D1` became `acc/one?x=1`, the rule no longer matched the
   request the peer had actually received, and the failure looked like a product defect while the Go
   side was sending the correct escaped target. Use `EscapedPath()` wherever a harness matches or
   records a URL it did not build itself, because the decoded form has already thrown away the
   distinction the fixture exists to preserve.
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
   the assertion must live in a labelled source-derived test (rule 4) instead.
   Do NOT widen the drain window to catch the loser: that makes the count stable by luck rather than
   by contract, and the same race reappears under different timing. NULLING THE FIELD IS NOT ENOUGH WHEN THE UNSTABLE VALUE ALSO APPEARS INSIDE A FIELD THAT IS
   COMPARED. The caption-image probe classified the pollinations `seed` as shape with a null value
   and was still unstable, because the seed also appears inside the recorded REQUEST BODY: the run was
   green and `stable=False` at the same time. The body now carries a `<seed>` marker, the same
   treatment the SD and video seeds receive, and the normalisation is recorded. So: after classifying
   an unstable value shape, SEARCH THE FIXTURE FOR THE VALUE ITSELF -- if it also sits inside a
   compared body, header or target, the marker has to be applied there too, and the double-run check
   is what catches the omission. The one argued exception is a value that is CLIENT-derived and
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

## Differential-testing doctrine (what the oracle is allowed to claim)

These are the constraints that make a green mean something. They are not style preferences: each one
exists because its inverse has already produced a passing test that proved nothing on this project.

1. **Upstream is the oracle, and a difference is answered in a fixed order.** `pinned capture` →
   verify the probe is faithful → verify the fixture is DISCRIMINATING → verify the comparator/gate has
   teeth → only then ask whether the Go implementation is wrong. Never start at the last step. If the
   fixture cannot distinguish two behaviours, it is not evidence for either.
2. **Provider-wire stays byte-oriented.** The contract is `bodySha256`, `bodyLength`, the raw request
   target, the method and the recorded headers. FORBIDDEN, because each makes two different requests
   compare equal: canonicalising JSON, parsing then re-marshalling, ignoring member order, dropping
   unknown headers, dropping members that "look irrelevant", replacing the raw body with a semantic
   struct comparison. A genuinely nondeterministic field may be narrow-normalised only with its
   field/path, the reason, and the upstream source or probe evidence written down beside it. Global
   rules ("ignore timestamps/headers") are forbidden.
3. **Subject and oracle must never share an expectation.** Allowed to share: process lifecycle, port
   allocation, scratch directories, HTTP/SSE utilities, browser-driving mechanics, a source's driver
   metadata ("how to get the request to the recording peer"), fixture parsing, reporting, and
   impact-selection machinery. Forbidden to share: the expected provider body, the expected response
   mapping, the expected message transform, the expected source-specific output, the expected
   status/error shape. If implementation and test read the same definition, both can be wrong and the
   run is still green.
4. **Every gate has teeth, and the teeth are demonstrated.** After adding or changing a gate, mutate the
   thing it guards, show the exact assertion name that went red, restore, show green. "The command
   exited 0" is not evidence. Go mutations run in CI with `-count=1`.
5. **A verdict is a taxonomy, not a boolean.** Internally every differential observation is one of:
   `match`, `mismatch`, `not-observed`, `pinned-unreachable`, `decided-exclusion`, `harness-error`,
   `candidate-error`, `nondeterministic-oracle`. In particular a browser leg that produced no provider
   request, no page error and no failed HTTP request is a HARNESS-FAITHFULNESS ALARM first; it is not
   permission to declare the product broken.
6. **No live network, from any egress path.** Not just the module the pinned server imports: the global
   `fetch`, an SDK's internal transport, native `http`/`https`, redirects, a dynamically constructed
   host. Each provider probe must be able to show that the peer received exactly the requests the
   fixture claims; a request that escapes must appear as a MISSING request or a forbidden-egress
   failure, never as plausible recorded data.
7. **Coverage is computed, never prose.** The P/E/streaming/cancellation/preset matrix comes from
   committed fixtures and artefacts, explicit decided exclusions, or explicit pinned-unreachable
   explanations. `N/A` is not a pass, and a source is never "supported because the registry lists it" —
   the product registry and the pinned-derived coverage are cross-checked, and neither proves the other.
8. **Narrowing reduces cost, never strength.** A probe that did not run is unverified, not
   verified-equal; the scheduled full sweep is the only run whose green covers the whole oracle.
9. **Never turn red into green by re-recording.** Re-record only when the OBSERVATION legitimately
   changed, and say which upstream behaviour changed and why. "The fixture moved, so I moved the fixture"
   is the failure this rule exists to forbid.
10. **Refactor only where a real drift or false green has already happened.** Two vertical slices are in
    scope: the Oracle infrastructure and the chat-completion/provider differential. Extract a helper only
    when at least two real callers share semantics that a differential has proven identical. Do not
    replace `orderedNodeJSON` with maps, do not rewrite stable probes wholesale, do not build a universal
    provider framework, and do not touch storage, the frontend or endpoint packages that are already at
    parity.
11. **A giant file may not grow a new source branch.** The source list lives in the driver catalogue
    only; the generation driver, the streaming driver, the comparators and the verifier entrypoint must
    not each keep one; artefact coverage reconciles against the catalogue automatically; a
    source-specific assertion registers at an explicit extension point. A new provider is a descriptor
    plus an artefact plus, if genuinely special, a named hook.
12. **A stage report carries numbers, computed from the tree, never copied from a document.**
    HEAD sha, changed files, probe declaration count, fixture count, provider-wire source and scenario
    counts, E/streaming/cancellation counts, preset-E2E coverage, how many probes this run actually
    executed, single-vs-double policy, pinned-boot count, the slowest probes, mutation verdict, the CI run
    id, and the remaining OPEN gaps. An older HANDOFF number is not a measurement.

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

## Working mode: CI-first, branch-merge, no pull requests

The development host is weak. Since 2026-10-24 the rule is not "prefer CI", it is **the host does
not run heavy work at all**. Everything that compiles, boots a server, drives a browser, records a
fixture or runs a test suite happens in GitHub Actions.

- **Allowed locally:** editing files, `git` (branch/commit/merge/revert), reading code and fixtures,
  `node --check` on a single file you just edited, and `git diff` inspection. Nothing else.
- **Forbidden locally:** `go build`, `go test`, `go vet`, `gofmt` over the tree, `npm`, Playwright,
  `tools/build-generated-lib.mjs`, the browser harness, any probe. The machine cannot afford them and
  a Windows result is not the Linux gate anyway (see the CRLF and host-path traps in the rules above).
- **A relative path in a .NET or PowerShell file API does not follow `cd`.** `[System.IO.File]::WriteAllText('internal/x.go', …)` resolves against the PROCESS working directory, which is the session workspace, while `cd` only changes PowerShell's location. An edit aimed at another worktree therefore lands in this checkout, silently, and the read-back that would have caught it is the only thing that does. Two lanes have already written into the wrong tree this way. Use absolute paths for every write (`Resolve-Path` first, then write), and after any edit in a worktree that is not this one, read the file back and confirm which tree changed before reporting it.
- **No pull requests, but NOT one-push-per-task.** Branch count and duplicated multi-hour sweeps got out
  of control: five PRs meant five oracle jobs. So: no pull requests, and `main` is the only long-lived
  branch. What is now SUPERSEDED is the older "push once, at the end" rule — a lane that sits on twenty
  unpushed commits has never been looked at by a compiler, and on 2026-10-25 a lane's gate and its fix
  travelled in the same push, so the red was argued from a set diff instead of observed. **Commit and push
  at every coherent step**: gate first and let it go red, then the fix and let it go green, and quote both
  run ids. A lane may push as often as it has something coherent to say; the lead merges it into `main`
  locally when its cheap checks pass, and deletes it.
- **Persist expensive CI work** rather than re-paying it: `setup-go` cache, `actions/cache` for the
  pinned SillyTavern `node_modules`, the oracle build root, the harness `node_modules` and the
  Playwright browser bundle. A cache key must PROVE the identity of what it restores (pinned commit
  plus the lockfile hash that goes with it), never merely suggest it, and every hit must print which
  branch it took so the log proves the persistence instead of implying it.
- **Narrowing is a cost control, never a strength control.** A narrowed oracle run reduces recording
  work and, with it, detection: a probe that did not run leaves its fixture byte-identical, so the
  zero-diff gate cannot see it. The scheduled full sweep is the only run whose green covers the whole
  oracle. Never claim otherwise in a comment, a document or a report.
- **Every job has a `timeout-minutes`** sized to measured reality, so a wedged probe or browser fails
  the job instead of consuming a runner for hours.
- **A CI job must be able to tell you WHICH bytes differ.** Prefer `git diff --exit-code` plus the
  diff in the log over a bare exit status. `.github/workflows/ci.yml` uploads the Linux re-record as a
  patch on every run, so a failure can be read rather than guessed at.
- `docs/development-loop.md` lists the tiers and, more importantly, what ONLY the oracle can decide.

`node scripts/dev-verify.mjs` still exists and is still useful as a *classifier* (it says which
checks a change needs), but it is optional advice: on this host it must not be used to run the Go
build or the test suite that CI will run. If you run it, run it with `--explain`.

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

## Product contract (2026-10-25, after three user-visible P0 failures)

The rules below exist because three defects shipped through a green CI: a provider that could not be reached in
production (`P0-A`), a boot that hangs inside a real SillyTavern directory (`P0-B`) and extension/plugin updates
that happen without being asked for (`P0-C`). Each rule is an invariant with an evidence requirement, because the
failure mode they replace is "the suite was green, therefore it works". The measurements behind them are in
`docs/network-egress.md` and `docs/startup-state-machine.md`.

21. **The target is a usable SillyTavern replacement, not a parity demonstration.** A green differential is a
    means. The acceptance question is always: can a real user, with their real data and their real provider, do
    their real work?
22. **The user's runtime path outranks any mock.** A behaviour verified only against our own peer, mock or
    fixture is `unverified` for production purposes, whatever the fixture says.
23. **Every release claim must be demonstrated with the shipped artifact.** Source-tree tests are necessary and
    insufficient: the packed archive, unpacked into a clean environment, must start against a stock tree.
24. **Startup may not wait indefinitely** — no `flock.Lock()` without a bounded acquisition, no unbounded
    resolver call, no unbounded sleep loop, no join without a producer. Every wait has a named error and a bound.
25. **Startup performs no non-essential network access.** Boot is local; the only allowed lookup is the
    documented docker-hostname resolution, and it is bounded.
26. **Auto-update defaults to OFF, and every ambiguous input resolves to OFF**: missing key, unknown legacy key,
    `null`, unparsed value, unreadable config, migrated config. `true` is only ever read from an explicit,
    parseable, present value — never from a default, a fallback or a merge. This overrides pinned's own default
    (`upstream/default/config.yaml:301`, `:396`); diverging from upstream here is the product decision, and it is
    recorded as such.
27. **Startup does not modify user files as a side effect.** A config that parses is not rewritten because our
    defaults exist. Missing values are supplied in memory and reported; any write is an explicit, logged,
    backed-up migration with an idempotence test.
28. **Existing user data wins.** Never truncate an unknown file, delete an unknown key, overwrite an extension,
    reset a plugin repository, or chmod a user tree implicitly. A dirty git worktree is refused, not forced.
29. **The provider transport must work on the real internet**: TLS with system roots, proxy awareness, bounded
    connect/handshake/header/idle timeouts, response decompression, redirect policy, keep-alive, cancellation.
    A transport that only reproduces wire bytes for a mock writes the mock's contract, not the internet's.
30. **Byte-exact and production transports are different roles.** The wire-exact client exists to observe pinned's
    request bytes; it must not be the client that carries user traffic merely because it was there first.
31. **Every bug is reproduced before it is fixed.** The reproducer must fail for the right reason, and the fix
    must be shown to make that specific reproducer pass.
32. **Never delete or weaken a failing test to get green.** A test that cannot fail is worse than no test.
33. **Never mask a deadlock with a longer timeout, and never mask a readiness race with `sleep`.** Those are the
    two shapes of "fixed" that reappear as a user-visible hang.
34. **CI tests the unpacked release artifact**, in a stock SillyTavern directory, with the same steps a user
    follows in the installation docs.
35. **Errors are causal and safe**: they name DNS, connect, TLS, proxy, timeout, HTTP status or mid-stream close,
    and they never print secrets. "Cannot connect to server" is not an error message.
36. **Documentation may not claim ahead of evidence.** A capability is documented as working only after the gate
    that proves it has run; until then it says `partial` or `not implemented` with the reason.
37. **A subagent's report is evidence, not a summary.** Files inspected, reproducer, root cause, invariant,
    changed files, tests, CI run id, residual risk. "Implemented" alone is rejected.
38. **Release qualification covers the real migration path**: stock tree, existing config, existing data, restart,
    persistence, and the ability to hand the data back to pinned Node.
39. **Lanes own areas, not files-in-flight.** One lane per area and one owner per area; a lane pushes at every
    coherent step (see "Working mode" — the older one-push rule is superseded, because a gate and its fix in the
    same push means the red was never observed); the integrator merges each lane when its cheap checks pass;
    shared architecture changes land first and lanes rebase onto them.
40. **A hang, a crash or a silent mutation discovered in production is a defect in the process too.** Record what
    the process was missing — a gate, a fixture, a timeout, a document — in the same change that fixes the bug.

41. **A source-tree suite cannot see boot latency; only the packaged gates can.** Measured on 2026-10-25: a
    commit whose binary slept 45 s before `app.Start` passed Lane CI and the whole Go test suite, while BOTH
    packaged drop-in gates (Linux and Windows) failed on it inside the 30 s readiness bound. The reason is
    structural -- the suite calls `Start` directly, so anything in front of it is invisible to the suite.
    Therefore: do not read a green lane run as "boot is fine", and any claim about startup latency must cite a
    packaged-artifact run. The inverse also holds: when a boot defect is reported, the first question is which
    gate could have seen it, and if the answer is "none", the missing gate is part of the fix (rule 40).

## Product contract (2026-10-25, second pass: a green CI and a page a user cannot look at)

`GOAL.md` is the locked goal: a real user's long-lived SillyTavern directory, with their real cards,
avatars, backgrounds, presets, variables and 酒馆助手, must work after swapping the backend, and the
final request that reaches the model must equal pinned Node's. The rules below exist because the
suite was green while the product was visibly broken. They extend rules 21-41 and apply to every
lane: a report that cannot answer "does this move us toward `GOAL.md`?" is rejected.

42. **A route the browser always requests is part of the contract even when no test touches it.**
    Enumerated on 2026-10-25: pinned `src/users.js:1213-1219` mounts SEVEN user-data static trees
    (`/backgrounds/*`, `/characters/*`, `/User%20Avatars/*`, `/assets/*`, `/user/images/*`,
    `/user/files/*`, `/scripts/extensions/third-party/*`), and `internal/server/frontend_assets.go`
    served **three** of them. `/characters/<file>.png` — the URL behind a character's full-size
    avatar, its sprites and its live2d — answered 404 while `/characters/*` existed as a directory
    nobody could fetch. No fixture covered it, so nothing failed. The obligation is therefore not
    "implement the routes a fixture exercises" but "implement the routes the pinned frontend builds",
    and the inventory must be derived from the oracle: see rule 43.
43. **Coverage is enumerated from the oracle's own lists, never accumulated from whatever the last
    E2E happened to touch.** Every `router.use(...)` mount, every `endpoints/*.js` router mounted in
    `src/server-startup.js`, and every URL a pinned *frontend* module builds is a row in an
    inventory, and a test diffs that inventory against the Go registrations so a missing row is a
    failure. Per-route discovery is how three mounts stayed missing through a year of green runs: each
    probe covered only the paths its scenario needed, and no gate compared the sets.
44. **The frontend's URL helpers are the server's requirements document.** `public/script.js`'s
    `getThumbnailUrl` builds `/thumbnail?type=<bg|avatar|persona>&file=<name>` and is called by
    `buildAvatarList` for the character list, by `group-chats.js`, `bookmarks.js` and `personas.js`
    for every avatar they render, and by `backgrounds.js` for background thumbnails. Reading those
    call sites is cheaper than discovering each one from a user report, and it is the reason
    "/thumbnail is unimplemented" is a P0 rather than a gap: the browser has no fallback, so every
    one of those images is a broken image.
45. **"Decided boundary" may not be used to justify an absence a user can see.** The architecture
    boundary list records `/thumbnail` as a Jimp codec decision, and the startup differential records
    two of its four known differences as `/thumbnail` 404s. Both statements were true and both were
    treated as *closed*. The user-visible consequence was not recorded anywhere: avatars, persona
    images and background thumbnails do not render. A boundary is legitimate only if the surface still
    works without it (an alternative codec that renders the same picture), otherwise it is a P0 with a
    product decision attached. When a boundary is recorded, the SAME change must record what the user
    sees because of it.
46. **A test asserting the absence of a browser-required asset is a bug report, not a gate.** If a
    fixture's expected value for a core asset is 404, one of the two is wrong and the fixture does not
    get to decide. Core-asset absence is `FAIL`, never `PARTIAL`.
47. **Extension compatibility is not "the files load".** 酒馆助手 / JS-Slash-Runner runs user code in
    an iframe and drives generation, presets, variables, world info, messages and streaming through
    the host page. A feature it implements purely in the frontend is not our burden; every capability
    it reaches through a user file or an API route is. Therefore a helper test must drive a real
    browser against the unmodified frontend and must assert on the provider request and the persisted
    state that the helper produced, not on the presence of a script element.
48. **A preset is compatible only if it changes the final model context.** Loading a 100-prompt
    preset is a parse test. The compatibility statement is: for a given character, chat, world book,
    helper state, variable state and user input, the request that reaches the model backend equals
    pinned Node's — fields, ordering, roles, depths, flags, samplers, stops, tools, reasoning. Two
    halves must hold simultaneously: `Node(X) == Go(X)` for every preset X, and `X != Y` within one
    implementation. The second half is not decoration: an implementation that ignores preset
    selection entirely can satisfy the first half against a weak comparator.
49. **A simulated provider may capture and answer; it may never define correctness.** Expected context
    comes from a pinned Node capture. Writing the expected JSON by hand and making both sides match it
    tests the mock's author, not the product (rule 4 in the differential doctrine).
50. **A harness whose captures do not differ when its inputs differ must fail itself.** If three
    presets produce identical captures, or helper-off and helper-on produce identical captures where
    they must differ, the verdict is `HARNESS NON-DISCRIMINATING` and the test is red. This is rule 15
    applied to a whole harness rather than to one encoding assertion.
51. **Real user artifacts are read-only inputs to qualification.** A long-lived SillyTavern tree, a
    real complex preset and a real character card are read, hashed and copied; the originals are never
    written, never `git pull`ed, never reformatted. A desensitised fixture must preserve every field,
    ordering, enabled flag, depth, role, extension subtree and size class, because the structure is the
    oracle — a 1.1 MB `extensions.tavern_helper` subtree replaced by three prompts is a different
    product. Missing credentials are not a reason to skip: reachability is provable without one
    (`scripts/deepseek-canary.mjs` records the provider's own rejection), and a real completion is
    provable through a provider's anonymous mode (`scripts/live-canary.mjs`).
52. **A user saying "the page is obviously broken" outranks every green run in this repository.**
    When that happens the first question is never "which test failed" but "which measurement could
    have expressed this complaint, and why does it not exist". The answer is the deliverable, in the
    same change as the fix (rule 40). On 2026-10-25 the answer was: nothing in the suite ever loaded a
    page and looked at a picture.
53. **Every lane, commit and report answers the goal question.** "Does this move us closer to
    `GOAL.md`?" A change that adds coverage of a behaviour no user can observe, or that raises a number
    without changing an answer to the scorecard in `GOAL.md` §7, is not progress.
54. **A gate that compares two declarations cannot see the failure that happens when one is executed.**
    Measured 2026-10-25: a lane registered `/User Avatars/{rest...}`, and the inventory gate written to police
    exactly that set compared the PINNED declaration string with the REGISTERED string. It was green. The
    server panicked inside `mux.HandleFunc`, because `net/http` reads a space in a pattern as a method
    separator (`src/net/http/pattern.go:96`), so `main` stopped opening a port: `verify` failed, four unrelated
    suites went red (account-admin, global basic-auth, the adversarial ratchet, and the DeepSeek e2e whose
    binary "exited 2 before answering GET /version"), and a merged commit was unrunnable. Two duties follow.
    When the acceptance of a value is an EXECUTION — registering a pattern, opening a listener, constructing the
    handler, parsing the document — the gate must execute it and not compare spellings; the set-comparison gate
    may stay, but only as a second opinion beside one that builds the real object. And when a merged commit
    cannot start, the report's FIRST line says so: "some tests are red" describes a symptom and hides a
    regression that a revert fixes in a minute.
55. **A run id without its workflow name is not evidence.** Measured 2026-10-25 in the same lane: a mutation
    was reported as SURVIVING from run `40197036022`, which is the **GoTavern drop-in qualification** workflow
    — it boots a packaged archive against a stock tree and never runs the unit suite, so its green could not
    fail. The run that actually judged the mutation was `40197036003` (GoTavern **Lane CI**, failure on
    `TestPinnedFrontendAssetContractMountsServeMarkedBytes/characters`), created in the same second as the
    wrong one. Two commits in this repository produce several workflows each, so `gh run list` shows pairs and
    a one-line summary does not say which is which. Always quote `workflow name + run id + conclusion`
    together; when the verdict is a survivor, re-read the log for the assertion name before acting on it,
    because "the mutation survived" and "I read the wrong job" look identical in a summary line. This is rule
    7 one layer up: the green did not merely fail to prove the claim, it belonged to a different subject.
