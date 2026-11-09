# alpha.19 program index (LIVE)

`CHARTER.md` is the **frozen baseline** written at the start of the round (2026-11-08): the user's
prompt verbatim, the measured starting state, the final goal and the acceptance rules. This file is the
**live index**: it changes as evidence lands, and it never rewrites the charter.

## Current stage

| field | value |
|---|---|
| stage | **P0 — oracle + harness boot proven; P1 (real-UI corpus) in progress** |
| branch | `alpha19/program` (from `52883e8`) |
| candidate | none yet |
| subagents | `oracle-ui` (A), `compat-diff` (B), `perf-stability` (C) — exactly three, long-lived |
| corpus | not yet produced (A in progress) |
| CI gates | none dispatched for alpha.19 yet |

## Evidence index (live)

| area | path | state |
|---|---|---|
| charter / prompt / goal | [`CHARTER.md`](CHARTER.md) | frozen |
| oracle pin manifest (SHA256 of `public/**`, `src/**`, `default/**`, `server.js`, `package*.json`) | [`oracle-pin.sha256`](oracle-pin.sha256) | recorded |
| oracle pin summary (commit, clean flag, file count, bytes, tree digest) | [`oracle-pin.json`](oracle-pin.json) | recorded |
| pinned boot smoke (real `run-against-pinned.mjs` boot, `/version` identity, index bytes, readiness bound) | [`oracle/pinned-boot-smoke.json`](oracle/pinned-boot-smoke.json) | recorded |
| decisions and rejected options | [`decision-log.md`](decision-log.md) | live |
| alpha.19 evidence artifact contract (for the new CI gate) | [`evidence-contract.md`](evidence-contract.md) | drafted |
| real-UI corpus (originals + manifest + action log) | outside the repo: `C:\Users\koishi\Desktop\GoTavern\a19-oracle` (A); summary will be copied here | in progress |
| five-layer differential | A's corpus + B's comparator | not started |
| findings (RED/GREEN) | `findings/` | not started |
| performance | `perf/` (C) | not started |
| same-SHA CI evidence | `same-sha-evidence.md` | not started |
| release evidence | `release-evidence.md` | not started |

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
