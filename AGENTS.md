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
   implementation or a recorded capture exists, it wins.
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