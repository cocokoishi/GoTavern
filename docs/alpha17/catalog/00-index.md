# alpha.17 niche scenario catalogue — index, dedup rule, field legend

Status: PROPOSED

This part is the index of a **proposal**, not evidence. It lists the deduplication rule, the 15 fields
every scenario row carries, the status taxonomy, the evidence policy, and the planned per-domain counts.
The assembled deliverable is `docs/alpha17/niche-scenario-catalog.md`, produced from
`docs/alpha17/catalog/NN-*.md` by `docs/alpha17/catalog/assemble.mjs` (deterministic concatenation, count
recomputed from the assembled text). The `tests` lane owns `tests/e2e/niche_*.go`; this catalogue cites
those files where they exist but never claims a run.

## 1. Deduplication rule (applied to every row)

**One scenario = one distinct observable behaviour, i.e. one failure mode that a single negative control
can distinguish. A parameter sweep is a table inside one row, never N rows.**

Merged variants (examples of what was folded into one row):

| merged into | variants folded in (parameter table) | why one row |
|---|---|---|
| FS-001 | CJK name, emoji name, zero-width-character name | same code path (sanitize + create + read back); the negative control "force ASCII" kills all three |
| FS-003 | 300-byte name, Windows reserved `CON`, `../`-looking name | all are the *containment/sanitisation* behaviour; one planted defect (skip sanitisation) fails every variant |
| DATA-002 | BOM in request body, BOM on disk | one reader/normalisation behaviour; the two legs assert opposite sides of the same asymmetry |
| DATA-005 | 2^53−1, 2^53, 2^53+1, 1e400, −0, 1.0 vs 1 | one JS number-semantics row; a hand-rolled integer encoder fails all five |
| HTTP-001 | GET/POST/PUT/DELETE/HEAD on one route set | one method-dispatch matrix; a 405-vs-404 bug is one defect |
| PROVIDER-004 | 12 provider sources that share the `/chat/completions` shape | one relay row + source list; per-provider prosecution is `provider-wire` scenario count, not N catalogue rows |
| PROMPT-002 | 120-block, 105-prompt, 119-prompt presets | one "enabled blocks reach the request in order" behaviour at three sizes |
| CONC-001 | 8 accounts × {settings, chats, append, rename, delete, reset, import, streaming} | one isolation/concurrency correctness row + an operation matrix |
| PERF-001 | 100 / 1000 / 10000 cards; 10×2 MiB / 100×256 KiB / 1000×16 KiB chats | one scale row at three measured points; splitting them would duplicate the same assertion |
| CLI-006 | PowerShell 5.1 / PowerShell 7 / Linux shell | one installer-exit/update contract row + shell matrix |
| EXT-004 | 20 locked extensions, pairwise | one lifecycle row; pairwise/triple combinations are a separate row (EXT-005), not 190 rows |

Deliberately **not** merged: behaviours with a different negative control (e.g. `ENOSPC` vs `EFBIG` keep
separate WRITE rows because a single planted defect cannot make both assertions red).

## 2. Field legend (all 15 fields on every scenario row)

| field | meaning |
|---|---|
| `ID` | stable domain prefix + zero-padded serial (`FS-001`); unique in the assembled document |
| `Name` | the behaviour in one line |
| `Risk` | `P0` data-loss/security/parity; `P1` visible wrongness; `P2` hygiene/rare |
| `Pre` | preconditions/environment (OS, data root, config, tree state) |
| `Input` | the adversarial data/parameter table |
| `Ops` | operation sequence (routes/CLI steps, order matters) |
| `PinnedBasis` | `file:line` in `../SillyTavern` @ `06bde939` or a committed fixture path |
| `PinnedExp` | expected pinned Node observation (status/body/disk/wire) |
| `GoExp` | expected GoTavern observation (same shape) |
| `Neg` | negative control: the planted defect that MUST make the named assertion red |
| `Test` | real `file:line` if a test exists (grep-verified this round), else `NEW: <path> (proposed)` or `NONE` |
| `Cmd` | exact command that judges the row |
| `CI` | workflow that carries it (existing name) or `NEW: <workflow> (proposed)` |
| `Status` | `COVERED` / `EXECUTED` / `PARTIAL` / `DESIGNED` / `UNEXECUTED` — see §3 |
| `Residual` | what the row still does not prove |

Abbreviations used in cells: `RT` round-trip; `WB` world book; `WI` world info; `PR` provider request;
`NDJSON` newline-delimited JSON; `X` the subject; `oracle` = pinned Node.

## 3. Status taxonomy (execution status, not a coverage wish)

- **EXECUTED** — a committed run record (docs/alpha17/**, workflow artifact, run id+workflow name) names
  this scenario and it passed. **No row in this catalogue is EXECUTED**; execution evidence belongs to
  `docs/alpha17/new-test-evidence.md` and the CI artifacts. A catalogue row may not promote itself.
- **COVERED** — a dedicated test exists in the working tree at the cited `file:line` and asserts the
  behaviour; verified by grep in this round. COVERED says "a test exists", **not** "it passed" and not
  "it is CI-wired": `tests/e2e/niche_*.go` is currently untracked, so those rows carry that residual.
- **PARTIAL** — a test exists but asserts only part of the behaviour (named in `Residual`).
- **DESIGNED** — no test yet; this row supplies input + operation sequence + negative control, and the
  named harness primitives exist (a proposed `NEW:` test path is given).
- **UNEXECUTED** — no test and no directly reusable harness primitive; the row is a plan only.

## 4. Evidence policy

1. Pinned citations were verified with `Select-String`/`grep` against
   `C:\Users\koishi\Desktop\GoTavern\SillyTavern` @ `06bde939fb1e9c4c8d8641d810f0a916b5bce127`
   (read-only). Cited line numbers are the lines the grep returned, not remembered values.
2. Test citations are `file:line` returned by grep over the current tree (`HEAD c02eed1` plus the
   untracked `tests/e2e/niche_*.go`); a row whose test cannot be re-found becomes `UNVERIFIED` in the gap
   matrix, never COVERED.
3. No run id is quoted unless a committed document records it. `EXECUTED` is deliberately empty here.
4. The catalogue does not modify `tests/`, `internal/` or `upstream/`; test ownership stays with the
   `tests` lane (README §4).

## 5. Deduplicated counts (computed, not planned)

The assembler recomputes these from the part files; the assembled header is authoritative. Last run:
`node docs/alpha17/catalog/assemble.mjs` → **176 unique scenarios**, 135,966 bytes, first byte `0x23` (no BOM).

| domain | prefix | rows | part file |
|---|---|---|---|
| filesystem | `FS-###` | 24 | `01-fs.md` |
| data / JSON / JSONL | `DATA-###` | 18 | `02-data.md` |
| persistent writes / recovery | `WRITE-###` | 16 | `03-write.md` |
| HTTP surface | `HTTP-###` | 18 | `04-http.md` |
| provider transport / relay | `PROVIDER-###` | 15 | `05-provider.md` |
| SSE / streaming | `SSE-###`, `STREAM-###` | 14 | `06-sse-stream.md` |
| prompt / tokenizer / WI / regex | `PROMPT-###` | 16 | `07-prompt.md` |
| extensions + concurrency | `EXT-###`, `CONC-###` | 18 | `08-ext-concurrency.md` |
| security | `SEC-###` | 14 | `09-security.md` |
| CLI / installer / Docker / OS | `CLI-###` | 13 | `10-cli.md` |
| performance / cache | `PERF-###`, `CACHE-###` | 10 | `11-perf-cache.md` |
| **total** | | **176** | 11 domain parts + index |

A domain may shrink during review only by merging a row into another row's parameter table; the assembler
refuses duplicate IDs and refuses a total below 150, so the target cannot silently regress.

## 6. Part map

`01-fs.md` FS-001–FS-024 · `02-data.md` DATA-001–DATA-018 · `03-write.md` WRITE-001–WRITE-016 ·
`04-http.md` HTTP-001–HTTP-018 · `05-provider.md` PROVIDER-001–PROVIDER-015 · `06-sse-stream.md`
SSE-001–SSE-004 + STREAM-001–STREAM-010 · `07-prompt.md` PROMPT-001–PROMPT-016 · `08-ext-concurrency.md`
EXT-001–EXT-010 + CONC-001–CONC-008 · `09-security.md` SEC-001–SEC-014 · `10-cli.md` CLI-001–CLI-013 ·
`11-perf-cache.md` PERF-001–PERF-006 + CACHE-001–CACHE-004. Assembly: `assemble.mjs` (fixed order list; a
missing part, a duplicate ID or a total below 150 fails closed).
