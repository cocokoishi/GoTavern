# HANDOFF

Written at the end of a working session. Read this before touching anything. It records where the
project actually stands, what is red and why, what is unowned, and the invariants that cost the most
to learn.

Baseline: SillyTavern `1.19.0` @ `06bde939fb1e9c4c8d8641d810f0a916b5bce127`. Oracle checkout lives beside
this repository at `../SillyTavern` and is READ-ONLY.

## 1. Where the project stands, in the terms the docs use

**Do not measure progress by the count of unimplemented routes.** `ARCHITECTURE.md` §0 makes the RELEASE
ARTEFACT the unit of success, and `docs/surface-coverage.md` makes the five observer surfaces
(B/P/F/E/C) the bar for `compatible`. That is the real scoreboard:

- exactly **1** area is `compatible` (chat-completions generation, custom/OpenAI-compatible source);
- everything else is `partial`, and almost always because **E** (browser events/final state) and **C**
  (cancel/streaming) were never measured;
- coverage at hand-off: **309 partial / 30 not implemented**, of which **11 are decided exclusions**
  (`docs/api-inventory.md` now states the status convention at the top), leaving **19 routes of real work**
  against a reachable ceiling of **339 - 11 = 328**.

`docs/api-inventory.md` is GENERATED (header) but its **status column is hand-maintained**: the generator
reads existing statuses and keeps them (`existingStatuses.routes.get(...) ?? default`). Only the header is
generator-owned; a hand-written header paragraph is silently overwritten and fails the zero-diff gate.

## 2. What is red at hand-off, and what each red actually means

`verify` and `browser-evidence` were red on the last completed run. Read them as findings, not regressions:

1. **`browser-evidence` is DESIGNED to fail right now.** `tools/verify-browser-comparisons.mjs` reports:
   `generation-comparison.json: milestoneEqual is false with NO milestoneDifferenceReason recorded;
   differing counters: dryAfterData gotavern=1 pinned=2`. That counter sits inside the area
   `docs/surface-coverage.md` calls `compatible`. Either the divergence is acceptable and needs a recorded
   reason, or it is a product difference. **Neither can be decided by leaving the field unexplained.**
2. **`verify` was red on `assets/download`** and a fix landed in `c010781`; the run for that commit was
   still in flight at hand-off. The last known failure was
   `download.ok.characterTxt/assets: tree has 8 entries, pinned Node left 9`, whose ninth entry was
   `temp/note.txt` — a RACE artifact of pinned's own `unlinkSync` (see §5), fixed in the fixture rather
   than the handler.

`docker` is **green**: the image builds, starts, and passes `gotavern assets verify` inside the container.
`cross-compile` (6 platforms) is green. The **Release workflow** is green and produces all six canonical
archives plus `checksums.txt` on GitHub Actions.

## 3. The board: every remaining route has an owner-less, pre-reconnoitred task

| task | scope | state |
|---|---|---|
| `task-34` | `/api/sd/comfy/generate` | spec verified to the MECHANISM level; needs one fixture mechanism (below) |
| `task-36` | remaining `/api/sd/*` generate (5) | scope corrected from a wrong premise |
| `task-37` | `/api/data-maid/*` (4) | corrected: locally-minted random token over in-process state |
| `task-38` | `/api/backends/*` (3) | classified, incl. a pinned `localhost`→`127.0.0.1` rewrite |
| `task-39` | 7 singletons + 1 MUST-NOT-BUILD | `assets/download` has FOUR guards, not two |
| `task-41` | Phase 4: Tavern Helper + LittleWhiteBox E2E | harness written; blocked by `/lib.js` (now fixed) |
| `task-42` | E for data domains | characters/chats/settings PROMOTED; backgrounds + quick replies refused with reasons |
| `task-43` | config resolves against cwd where pinned chdirs | needs an oracle BEFORE a decision |

`/api/search/visit` must **NOT** be implemented. It is a decided boundary: the pinned route fetches a
caller-supplied URL through `getUntrustedRequestAgent()`, the private-request-filter SSRF agent, and
GoTavern has no shared private-address transport policy — a route-local one would violate the
single-outbound-policy rule and be STRICTLY LESS SAFE than pinned. `search_test.go` asserts it stays 404.

## 4. Next actions, in the order the evidence supports

1. **Read the `verify` result for `c010781`.** If green, the `assets/download` lane is done; its row needs
   the status written (Lead applies docs rows).
2. **Decide `dryAfterData` (1 vs 2).** That single field is the only thing between the current state and a
   green `browser-evidence`. Reproduce it deliberately, then either record `milestoneDifferenceReason` or
   fix the product. Do not widen the check to make it pass.
3. **Re-run the extension probe now that `/lib.js` is fixed.** `94ce50b` made `/lib.js` come from the
   generated bundle before the disk lookup. The extension comparison artifact was WITHDRAWN in that commit
   because it had been recorded before the harness staged the release `public/` tree, so its GoTavern leg
   was serving the embedded bundle. A faithful pair is the gate that proves the `/lib.js` fix; only then
   may any extension row be promoted from `static`.
4. **`task-43`** (config vs cwd): measure with an oracle first. An inference about the pinned code was
   already wrong once here (`--dataRoot` was called an ignored flag; it is honoured outside global mode —
   pinned `src/command-line.js:288-290`).
5. Then `task-39` item 6 (`minimax/generate-voice`, EIGHT OR-defaults → one scenario per default), and the
   remaining route tasks.

## 5. Verification rules that were learned the expensive way this session

These are in `AGENTS.md` as rules 11, 15, 18, 19 and 20; the notes below are the specific instances.

- **A fixture's `scenarios` IS the replay's list of routes that must work.** Committing probe scenarios
  without the handler in the SAME increment turns `verify` red. It happened on
  `/api/openrouter/image/generate`. Probe and replay are ONE increment. The same applies to a replay test
  that is written but not staged — check `git status` for untracked `_test.go` files after an agent reports.
- **`nodeGet` cannot index an array.** It requires an OBJECT at every path step, so
  `sdStringMemberOr(decoded,"choices","0",...)` resolves to undefined and turns a good provider answer into
  a 500. Traverse arrays explicitly (see `openRouterImageURL`).
- **`if (!model || !prompt)` is JS falsiness.** A string conversion of an ABSENT member yields the
  non-empty literal `"undefined"`, so a guard written as `prompt == ""` passes for a body with no prompt at
  all. Test presence AND `nodeTruthyJSON` before converting.
- **A race is not a contract.** `temp/note.txt` appeared in 1 Windows run of 7 because pinned unlinks it
  AFTER sending the response. Record a sorted set or nothing, classify `shape`, and make the fixture REFUSE
  a re-record that puts the entry back. Never widen the drain window to catch the loser.
- **An assertion that cannot fail is decoration.** The host-whitelist refusal's outbound count could not
  fail while its URL was `blocked.invalid`, because a fetch-before-guard never reached the peer. It uses
  `localhost:<port>` now, so "refused" and "attempted then refused" are distinguishable.
- **Verify committed bytes, not the working tree.** A `browser-evidence` job that recomputed comparisons
  from their legs passed by hand and failed in CI with `ENOENT`: the legs are gitignored deliberately
  (`tests/browser/.gitignore` explains why — a committed leg invites treating a known divergence as the
  expected value). Only the comparison is committed, and the gate checks the artifact's coherence instead.
- **Validate workflow YAML with a real parser** before pushing. An earlier hand-written `ci.yml` was itself
  unparseable and stopped CI; a throwaway module using `gopkg.in/yaml.v3` catches it in seconds.
- **`-run` that matches nothing reports `ok`.** Use the exact test name and confirm `=== RUN` appeared.

## 6. Release-artefact state (new this session)

- `.github/workflows/release.yml` builds the six canonical archives on a tag or by dispatch and publishes
  `checksums.txt` in **sha256sum format with NO `./` prefix** — `install.sh` matches with
  `awk '$2 == asset'`, so a prefixed filename parses to no entry and the installer aborts on the user's
  machine. The publish job refuses to publish if a canonical name or its checksum entry is missing.
- **`tokenizers/` ships in every archive.** `upstream/assets.go` embeds `public`, `default`, `generated`
  and `manifests` only; the runtime reads `<InstallRoot>/tokenizers` from DISK. Without it the routes take
  the pinned fallback and estimate every prompt roughly 25% high while still answering.
- `Dockerfile` / `docker-compose.yml` exist; the container passes `--dataRoot /data/data` because install
  root is `filepath.Dir(os.Executable())` and the config's relative `dataRoot: ./data` would otherwise
  resolve to `/app/data`, outside the volume. `config.yaml` resolves against the working directory, which
  is the volume, so configuration and content both survive a container replacement.
- `THIRD_PARTY_NOTICES.txt` records the AGPL-3.0 redistribution of the pinned upstream assets.

## 7. Working agreements

- Compute belongs on GitHub Actions. Locally run at most `go build`, `gofmt`, and `go test -count=1` for
  the package you changed. Never run `tools/build-generated-lib.mjs` locally.
- Teammates do NOT commit or push; the Lead does, per lane, with a message that records the measurement and
  the correction, not just the change.
- Push early: an unpushed commit has never been tested. A red run that names the differing bytes is cheaper
  than an hour of local guessing.
- When a lane cannot be finished, contribute the READ you did (what you verified, what you corrected, what
  is still unread) rather than a stub. Several of this session's best findings arrived that way.
