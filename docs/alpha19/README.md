# alpha.19 program index (LIVE)

`CHARTER.md` is the **frozen baseline** written at the start of the round (2026-11-08): the user's
prompt verbatim, the measured starting state, the final goal and the acceptance rules. This file is the
**live index**: it changes as evidence lands, and it never rewrites the charter.

## Current stage

| field | value |
|---|---|
| stage | **RELEASED — `v0.1.0-alpha.19` published 2026-11-09T19:08:48Z** |
| tag / candidate | annotated `v0.1.0-alpha.19` (object `50d0c3aa…`) peels to `bbc5615` |
| release | https://github.com/cocokoishi/GoTavern/releases/tag/v0.1.0-alpha.19 — `draft=false`, `prerelease=false`, latest, 6 archives + `checksums.txt` |
| subagents | `oracle-ui` (A), `compat-diff` (B), `perf-stability` (C) — exactly three, long-lived |
| corpus | **v2 finalized and committed as provenance**: 978 files / 49,898,769 B / tree `06d68e05…`; created 32 cards, 9 worlds/154 entries, 10 presets, 51 chats, 5 groups, 1 extension; 1,168 messages (396 UI turns + 772 product-save-path, disclosed). The CI gate regenerates its own corpus per run. |
| CI gates | **14/14 green at the released candidate** (verifier PASS; table in [`same-sha-evidence.md`](same-sha-evidence.md)) |

## Evidence index (live)

| area | path | state |
|---|---|---|
| charter / prompt / goal | [`CHARTER.md`](CHARTER.md) | frozen |
| oracle pin manifest (SHA256 of `public/**`, `src/**`, `default/**`, `server.js`, `package*.json`) | [`oracle-pin.sha256`](oracle-pin.sha256) | recorded |
| oracle pin summary (commit, clean flag, file count, bytes, tree digest) | [`oracle-pin.json`](oracle-pin.json) | recorded |
| pinned boot smoke (real `run-against-pinned.mjs` boot, `/version` identity, index bytes, readiness bound) | [`oracle/pinned-boot-smoke.json`](oracle/pinned-boot-smoke.json) | recorded |
| decisions and rejected options | [`decision-log.md`](decision-log.md) | live |
| alpha.19 evidence artifact contract (for the new CI gate) | [`evidence-contract.md`](evidence-contract.md) | applied (verifier + gate rails) |
| real-UI oracle CI gate (workflow + manifest entry + governance rails + evidence verifier) | [`.github/workflows/real-ui-oracle.yml`](../../.github/workflows/real-ui-oracle.yml), [`evidence-contract.md`](evidence-contract.md), `docs/release-manifest.json` gate 14, [`scripts/verify-a19-evidence.mjs`](../../scripts/verify-a19-evidence.mjs) | **PASS in CI at the released candidate** (run 42647718786; 5/5 layers match, 26 normalisations, 6 notCompared, 57/57 teeth) |
| real-UI corpus (v2 manifest + provenance) | outside: `a19-oracle/manifest/corpus-manifest-v2.json` (sha256 `25caa60c…`, tree `06d68e05…`); committed copy + [`oracle/corpus.md`](oracle/corpus.md) | finalized (Lead re-hashed 978/978 files) |
| five-layer differential | [`oracle/release-admissible-run.md`](oracle/release-admissible-run.md) (local Layer A) + the CI run above | released candidate PASS |
| findings (RED/GREEN) | `findings/` | 7 records: release-selection-rail, layer-b-conditional-get, reset-save-test-flake, self-check-runs, abba self-test, tokenizer scheduling/derived sizes, plus product fixes in commit history |
| performance | `perf/` (C) | C1/C4/C3/C5/C2 measured; cumulative summary + ABBA self-test (passed) + cumulative A/B rows + Node control committed; 8-user/soak did not run |
| same-SHA CI evidence | [`same-sha-evidence.md`](same-sha-evidence.md) | **14/14 PASS** at the released candidate |
| release evidence | [`release-evidence.md`](release-evidence.md) | published + independently verified |

## How to verify the oracle pin (any machine)

The pinned checkout is `../SillyTavern` at `06bde939fb1e9c4c8d8641d810f0a916b5bce127`. The manifest lists
906 files / 61,049,059 bytes and covers `server.js`, `package.json`, `package-lock.json`, `public/**`,
`src/**`, `default/**`. The tree digest is the SHA256 of the sorted manifest lines (LF-joined, no trailing
newline):

```
tree sha256 = 41d91cd619536319fbff2b3a3e6abaaa2cfc14dc870ffc2179e3648e41c8aedf
```

GNU/Linux verification (from the pinned root):

```
git rev-parse HEAD            # 06bde939fb1e9c4c8d8641d810f0a916b5bce127
git status --porcelain        # must be empty
sha256sum -c <repo>/docs/alpha19/oracle-pin.sha256
sha256sum <repo>/docs/alpha19/oracle-pin.sha256   # file integrity, not the tree digest
```

Windows (this host) equivalent: read the manifest line by line, `Get-FileHash -Algorithm SHA256` each
relative path under the pinned root, and compare. `oracle-pin.json` records the count/bytes/digest the
check must reproduce.

**Why this exists:** `AGENTS.md` hard rule 2 and the user's prompt §一.2 forbid modifying pinned
SillyTavern. `git status --porcelain` proves no *tracked* modification; this manifest proves the exact
bytes of the files a differential reads, including the frontend, `default/**` and the server source, so a
future change to the oracle is detectable even after a checkout/restore cycle.

## Program rules (short form; full form in CHARTER.md and AGENTS.md)

- Pinned SillyTavern is read-only. GoTavern is the only side that may change.
- The corpus must be produced by real headless-browser user actions against the unmodified pinned UI; no
  hand-written JSONL, no generator output passed off as user creation.
- Every alpha.19 claim needs an evidence path, the exact command, and (for CI) `workflow name + run id +
  conclusion` at one candidate SHA.
- No normalisation without a reason, pinned evidence, a named field, a test and a negative case.
- A green that cannot fail is not evidence. Gates need teeth, demonstrated by a mutation.
- Nothing is called done while an evidence-ledger row in `CHARTER.md` §9 still says `未开始`.
