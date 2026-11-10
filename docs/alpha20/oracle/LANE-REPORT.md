# Alpha.20 oracle/corpus lane — post-candidate evidence report

Candidate under test: **`496e5a9`** (short `496e5a9`). The 14-gate wave runs at
that SHA. This report is docs-only; it documents what the lane measured and which commits carry test/corpus
tooling versus evidence documents, so the lead can integrate evidence without changing the candidate tree.

## Evidence produced (what a reader can rely on)

| probe | artifact | key result |
|---|---|---|
| (a) chat integrity/force | `chat-integrity/evidence.json` (commit `6cdf46b`) | CONFIRMED: 400 `{"error":"integrity"}`, file byte-unchanged, no backup; force:true 200 + overwrite + backup; legacy/empty/BOM accepted; corrupt first line refused; config read at boot |
| (b) group save/backup | `group-save-backup/evidence.json` (`459e4fa`) | CONFIRMED: `group chats/<id>.jsonl`; `chat_<key>[_hash]_<ts>.jsonl` backups, NO `.bak`; one trailing backup per throttle window; graceful-exit flush writes exactly the pending trailing payload; retention is a shared `chat_` quota; broken backups dir only logs |
| (c) Accept-Encoding/Brotli | `encoding-negotiation/evidence.json` (`459e4fa`), `decisions.md` | CONFIRMED/DIFFERENT-measured: pinned br vs Go gzip; decoded bytes identical; +6,647 B (5.62%) on `/script.js`; br-only client gets identity; threshold bracketed 1023/1029 B; DECISION = keep disclosed difference (new dep + outbound decoder cost outranks it) |
| (d) `_cache/characters` | `character-cache/evidence.json` (`459e4fa`), `decisions.md` | CONFIRMED: key `<abs path>-<mtimeMs>`, filename sha256(key), value = card text; create/read/invalidate/external-mtime/corrupt/restart/concurrent/broken-path/Node→Go→Node observed; **pinned verify quirk**: stale records are NOT pruned (misaddressed node-persist key), reproduced by Go; DECISION = verify-only parity |
| fresh-install template | `pinned-data-template/evidence.json` (`ca90f7d`) | CONFIRMED product-produced template: 209 files / 30,065,637 B / tree `3fae9dee…`, cold boot 202,176 ms |
| Go-vs-pinned differential | `chat-integrity/differential.json` (sha256 `473e2fac…`), `group-save-backup/differential.json` (sha256 `5435e880…`), `differential-assessment.md`, `backup-window/evidence.json` (commit `39b8d9c`) | post-`fb24983`: chat 13/14 MATCH, group 10/12 MATCH; every status/body/chat-file/restart/retention observable matches. The one differing observable is the backup-scheduler snapshot; a controlled same-config experiment (both subjects config sha256 `d0e9063a…`, resolved `enabled=true/checkIntegrity=true/throttleInterval=10000`) shows BOTH write the leading edge immediately at +10,500 ms and BOTH are throttled at +1,500 ms, so that row is classified **HARNESS-ERROR**, not a product difference. Pre-fix RED artifact committed (`differential-before-fb24983.json`: 3/14 and 4/11 MATCH) |
| M3 comparator teeth | `differential-teeth.json`, `oracle-strengthening.md` (commit `9278e1a`, post-candidate) | **13/13 mutations killed, 0 survived, pristine artifacts byte-unchanged**; baseline MET after excluding the three harness-error scheduler/flush rows BY NAME (ids recorded in the artifact); every product-observable row stayed in the baseline. Mutations: status, exact body, chat-file sha, backup content, backup name, dropped row, added row, extra backup tuple, retention, restart count (chat), restart count (group), restart first message, timestamp-normalisation negative case |
| M3 failure injection | `fault-injection/evidence.json`, `fault-injection.md` (commit `5b1e631`) | EXECUTED 8 scenarios: concurrent writers (all answered, one complete payload), backup-dir failure (200, persists, recovers), ACL-denied dir (500 causal, bytes unchanged, recovers), no CSRF (403, unchanged), corrupt character cache (reads 200), invalid config restart (exit 1 causal, zero data-root mutation, valid config recovers), SIGKILL mid-write ×3 (disconnected mid-flight, all lines parse, old complete payload), clean SIGTERM + fresh boot read-back |
| M2 medium corpus | `corpus-medium-manifest.json` (sha256 `d1e966fc…`), `corpus-medium-report.json`, `corpus-tiers.md` (commit `52bcadf`) | 1533 files / 50,615,571 B / tree `d6f7d7f7…`; created 64 cards, 12 worlds (229 entries), 20 presets, 163 chats, 3000 messages, 8 groups, 3 personas, 2 QR, 2 regex, 1 extension — all medium targets reached, `reachedAllTargets: true`, `boundary: null`. Provenance separate: 10 UI-turn messages, 2826 product-save-path, 164 product-native chat greetings; chats 6 UI-control actions + 90 product-function calls + 67 files disclosed as unattributed. Pinned Tavern Helper `837a6288…` from the offline seed, exercised through the UI; one live gitlab version-check request recorded as an egress finding |

## Commit classification for integration

Evidence documents / reports only (safe to integrate as docs):

- `6cdf46b`, `459e4fa`: probe scripts + evidence + docs (test/tools + docs; they do not change product code)
- `d3ba699`, `52bcadf`: corpus counts + frozen manifest/report + docs
- `73ba787`, `39b8d9c`, `9278e1a`: M3 docs/evidence + test probes/teeth (no product code)
- `082cfb9`, `ca90f7d`, `5b1e631`: probes/tooling/teeth/fault harness + evidence docs (no product code)

The lane touched **no product Go file** at any commit; the pinned checkout was never written.

## NOT EXECUTED (must be recorded as such in alpha.20 evidence)

1. Five-layer live-oracle rerun on the medium corpus (`a19-live-oracle.mjs --mode all`): host saturated by the
   performance lane plus a quiet window; the alpha.19 release-admissible run is not re-used as alpha.20
   evidence.
2. Provider-wire fault injection (mid-SSE close, arbitrary SSE splits, no-response provider, truncated body):
   a hand-posted generate request is not the product's path; the faithful driver is the five-layer oracle's
   browser legs.
3. Disk-full injection: no safe way to fill the host filesystem inside the harness.
4. Small and large/extreme corpus tiers: the medium tier is the one built and frozen; small/large were not run.
5. The backup write TIMING comparison remains a harness-error observation (no product claim in either
   direction); the throttle POLICY was measured equal by `backup-window/evidence.json`.
