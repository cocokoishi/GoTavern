# GoTavern v0.1.0-alpha.14 — the engineering-program release

`v0.1.0-alpha.14` is the stable-channel release that lands the engineering program in
`GOAL.md` §11 (M0–M8): a first-run CLI a non-developer can read, a performance evidence gate that
makes every published number checkable against the run that produced it, response compression,
streaming chat summaries, identity-keyed caches, a panic boundary with bounded server timeouts, and
provider stream-termination differentials decided against pinned Node. It keeps the same SillyTavern
1.19.0 baseline (`06bde939fb1e9c4c8d8641d810f0a916b5bce127`) and the same compatibility contract as
alpha.13.

## What changed

**CLI.** A first run now prints GoTavern's identity and baseline, the resolved install, config and
data paths, and a `Ready:` line built from the bound socket. `--help` and `version` work for every
subcommand in any argument position (`gotavern start --help` used to boot a server), an unknown flag
warns, colour is TTY-aware and honours `NO_COLOR`/`FORCE_COLOR`, Docker and the launchers boot
headless, the startup trace is opt-in, and errors name the next step while the pinned `config.yaml`
refusal block stays byte-identical.

**Performance, with evidence.** `tests/perf/q22-baseline.json` is now the committed source of truth:
the README table, the figure and its provenance are recomputed from it by
`tools/check-perf-docs.mjs` in CI under one stated unit rule (decimal MB = 1e6 B), so a number
cannot drift from its run again. The alpha.13 tag tree's MiB-as-MB row is the defect this closes.

Measured in this program's runs (same host and input before/after):

| change | measurement | evidence |
|---|---|---|
| response compression | 229-request page load 9,067,849 B → 2,951,609 B wire (−67.4%), decoded bytes identical, 181 responses compressed, +0.57 ms CPU per compressed response | `GoTavern CI` 41766644754 |
| streaming chat summaries | 3.4 MB chat: 19.5 MB → 4.2 MB allocated, 28,161 → 62 allocations, 109.6 → 17.3 ms | Lane CI 41762701523, oracle 41762705531 |
| settings aggregation cache | 1100 documents: 30.09 → 4.29 ms (−85.7%), 23.64 → 3.04 MB (−87.2%) | bench profiles 41770713640 |
| world-info listing cache | 1000 worlds: 64.25 → 2.90 ms (−95.5%), 49.53 → 0.90 MB (−98.2%) | bench profiles 41770713640 |
| route table | 54 `init()` registrars and 56 `init()` functions → one explicit table; no route or handler line changed | Lane CI 41755388454 |
| provider stream termination | 25/25 scenarios match pinned after fixing the novelai, textgen and Ollama truncation paths | `GoTavern CI` 41776528079 |
| panic boundary and timeouts | pinned finalhandler 500 page; read-header 60 s, idle 5 s, headers 16 KiB; SSE unaffected | `GoTavern CI` 41766792295 |

**Stability.** A panic now answers the pinned finalhandler page instead of dropping the connection;
the HTTP server has Node's header and idle bounds (and deliberately no write timeout, so SSE is
never cut); the account cache detects same-size atomic replacements on Unix through the inode change
time from the stat it already performs, with the Windows boundary recorded rather than hidden.

## Compatibility

The compatibility claims are unchanged from alpha.13 and are re-run at this release's commit: the
packaged archive boots a stock tree on Linux and Windows, the browser differential drives the pinned
frontend, the 20 pinned third-party extensions each install, activate, persist a setting across a
restart, disable, re-enable and uninstall on both subjects, and every provider-wire capture is
compared byte for byte. New oracle fixtures recorded in this program are
`tests/oracle/sillytavern-1.19.0-compression.json` (the pinned compression contract; raw compressed
bytes are host-dependent and recorded as null, so the contract is encoding choice plus headers plus
decoded bytes) and `tests/oracle/sillytavern-1.19.0-stream-termination.json` (25 scenarios).

## Scope correction (post-publication, 2026-11-04)

**M4's package extractions were not performed.** `GOAL.md` §11 names M4 as move-only
`orderedjson` → `httpx` → `userdata` extraction *before* the route table; this release landed only the
route-table step (`8eca43b`: 54 `init()` registrars replaced by one explicit table, no behaviour
change). The three move-only package extractions did **not** land, so `GOAL.md` §12.1's M4 definition of
done — "the extracted packages are move-only, `internal/server` owns less" — is **NOT met**, and the
opening sentence's "M0–M8" must be read as: M0, M1, M2, M3, M5, M6, M7 and M8 complete; **M4 partial**.
The extraction is recorded as the next milestone item in `GOAL.md` §11 and `HANDOFF.md`, to be gated by
the existing differential suites and shipped in a follow-up release rather than retro-fitted into this
tag. No other claim in this note changes.

## Known limitations

- **M4 is partial (see the scope correction above):** the route table landed, the
  `orderedjson`/`httpx`/`userdata` move-only extractions did not, so `internal/server` still owns the
  code those packages were meant to take.
- **The strong drop-in claim in `GOAL.md` §14 is still NOT MET.** The evidence covers a synthesised
  long-lived tree, a committed synthetic corpus and a packaged archive over a stock tree; a real,
  long-used user directory has not been qualified.
- **No brotli encoder.** A client offering both `br` and `gzip` receives gzip; a `br`-only client
  receives identity. Recorded as a deliberate deviation; a pure-Go encoder is a reversible follow-up.
- **Windows account-cache boundary.** A same-size, timestamp-preserving external restore while the
  server runs can serve a stale record until mtime or size changes, eviction, or restart. The Unix
  path detects it.
- **Node's `requestTimeout` is not mapped.** `ReadTimeout` stays zero deliberately: a whole-request
  deadline would put a deadline under every upload.
- **Cross-scheme redirects are unproven** (no trusted TLS loopback peer); same-host and cross-host
  redirects are covered.
- **The gzip wrapper close path is unreachable for provider traffic** and is recorded as a boundary,
  with a connection-baseline test guarding it.
- **Narrowed oracle dispatches.** Each per-lane CI run re-records the probes its change can move;
  only the scheduled full sweep covers the whole oracle.
- The alpha.13 non-claims stand: arbitrary Node server plugins, local in-process ML, remote provider
  embeddings, wire formats inside third-party npm packages, per-chat backups and VERTEXAI
  service-account mode remain out of scope for the stated reasons.

## Artifacts

Six prebuilt archives (`gotavern-linux-amd64.tar.gz`, `gotavern-linux-arm64.tar.gz`,
`gotavern-darwin-amd64.tar.gz`, `gotavern-darwin-arm64.tar.gz`, `gotavern-windows-amd64.zip`,
`gotavern-windows-arm64.zip`) plus `checksums.txt` are attached to this release; verify with
`sha256sum -c checksums.txt`. The Docker image `ghcr.io/cocokoishi/gotavern:v0.1.0-alpha.14` is
published by tag, and `:latest` moves to it only because this tag classifies as stable.

## Evidence

The same-commit required-gate table is appended to this body by the publish job, so every claim
above is checkable against the run that produced it. `docs/goal-scorecard.md` is the per-question
ledger and `HANDOFF.md` is the current checkpoint.
