# Release-admissible five-layer run (local, corpus v2)

This is the record of the **final** local release-admissible run of the real-UI oracle that preceded the CI
gate dispatch. It is **Layer A evidence**: the same-SHA authority is the `GoTavern real-UI oracle
differential` workflow run at the candidate SHA, whose artifact is verified by
`scripts/verify-a19-evidence.mjs` inside the publish job. Nothing in this file is a CI verdict.

The final run is release-admissible run 8. Run 6 was the first run whose five layers were `match`, and it is
kept in the history below because it established the all-layers result first, but **its evidence document is
not the admissible artifact**: its embedded teeth run was 43/51 (eight mutations were only valid against the
synthetic fixture legs) and its `label` still said "PLUMBING RUN". Both were fixed in `d63e8fe`
(teeth rewritten for the real artifacts) and `762b668` (label agrees with `releaseAdmissible`), and run 8
re-ran the whole oracle on the fixed tree.

## Identity (final artifact)

| field | value |
|---|---|
| run | release-admissible run 8 (`--corpus-origin ui --mode all --run-label release-admissible`) |
| candidate code SHA | `762b668` (short form; the full 40-hex SHA is in `a19-diff/release8/run-facts.txt`); clean worktree `a19-release`, `git status` 0 lines |
| subject binary | `e671d114a5cc426250b50efb902338d9e7d32977205674e837ed449f525b702c` (`-trimpath`, built at `d63e8fe`; `d63e8fe` and `762b668` are tests/docs-only commits, so the product tree is identical across them) |
| corpus | `C:\Users\koishi\Desktop\GoTavern\a19-oracle\corpus` — 978 files / 49,898,769 B / tree `06d68e057085abad28d4e3bfc19df71cf91d9ea612ad6907bd67b38784d3a2ba`, re-censused unchanged before and after the run |
| corpus manifest | `corpus-manifest-v2.json`, sha256 `25caa60c871cde4348c22ed24baac18aaf6911ebc065d3e6ba74d95fcc61b1d9` |
| corpus origin / tier | `ui` / `full` (Node-UI-originated, immutable) |
| pinned oracle | SillyTavern `1.19.0` at `06bde939fb1e9c4c8d8641d810f0a916b5bce127` |
| legs | 6/6 (`drive`/`restart`/`handback` × pinned/GoTavern), every journey step ok |
| layers | browser `match`, http `match`, providerWire `match`, persistence `match`, lifecycle `match` |
| failed guards | **none** |
| verdict | `match`, evidence `ok: true`, `releaseAdmissible: true`, label `alpha.19 real-UI oracle (release-admissible)` |
| run window | started `2026-11-09T07:49:48.522Z`, finished `2026-11-09T07:59:36.640Z` (588,619 ms wall) |
| normalisations | **23** named decisions in this run, each with reason / pinnedEvidence / field / test / negativeCase in the evidence document (run 6 recorded 26; the three scheduling entries below did not fire here; see the list) |
| not compared | **6** surfaces (listed below) |
| comparator teeth | **51 mutations / 51 ok / 0 survived** (`out/a19-live-oracle-teeth.json`, `ok: true`, in-run artifact) |
| verifier | `node scripts/verify-a19-evidence.mjs --self-test` → `ok: true`, 17/17 cases. The local artifact is refused **by design** (`selection.dispatch:"local"`, expected `workflow_dispatch`); admissible evidence exists only from the CI dispatch at the candidate SHA |

**Gate-code identity with the frozen tree.** `git diff 762b668..HEAD -- tests/browser scripts` is empty and
the only difference between the two trees is this document, so the driver (`a19-live-oracle.mjs`), comparator
(`a19-compare-live-oracle.mjs`), journey probe (`a19-journey-probe.mjs`), teeth (`a19-oracle-teeth.mjs`) and
verifier that produced this artifact are byte-identical to the frozen candidate; the candidate adds a
docs-only delta after the run SHA. The CI gate at the candidate SHA re-runs the whole oracle and is the same-SHA
authority.

## Normalisations recorded by the final run (23)

Each entry is in the evidence document with its five members (reason, pinnedEvidence, field, test,
negativeCase); the field list is:

1. `layers.browser.finalChat.lastText`, `layers.persistence.chatMessages[].mes` — per-subject reply prefix stripped.
2. `layers.http.requests[].requestBodyText / responseBodyText`, JSON members `send_date` and `create_date` (recursively).
3. HTTP request header `cookie` and response header `set-cookie`.
4. `layers.providerWire.requests[].rawHeaders` — names case-folded and sorted, order not compared.
5. provider request header `accept-encoding` VALUE only (presence and name still required).
6. provider request header `connection` VALUE only.
7. `layers.http.requests[]` ordering — independent page requests race.
8. JSON string values of the form `http://127.0.0.1:<port>(/v1)` in compared bodies and product JSON; provider `Host` port.
9. JSON member `chat_metadata.integrity` in compared bodies and chat JSONL.
10. JSON members `gen_started`, `gen_finished`, `time_to_first_token` (recursively).
11. HTTP response header `x-response-time` VALUE only.
12. HTTP response header `content-encoding` VALUE for compressible bodies.
13. JSON member `addedTimestamp` inside `default-user/image-metadata.json` (recursively).
14. `layers.http.requests[]` multiplicity for `POST /api/settings/save` only.
15. HTTP JSON response member `enable_extensions_auto_update` in `/api/settings/get` (recursively projected).
16. HTTP response header `etag`, ONLY when the raw response body digests differ.
17. JSON member `chat` in character/group list responses, ONLY when its value matches the pinned run-created chat-name shape.
18. the `POST /api/settings/save` REQUEST body only (the response and every final file are compared).
19. JSON member `date_last_chat` in list responses.
20. JSON members `last_mes` (`POST /api/chats/recent`, `/api/characters/chats`) and `timestamp` (`POST /api/stats/get`, `/api/stats/update`) only.
21. HTTP response headers `x-gotavern-tokenizer-exact` and `x-gotavern-tokenizer-layout`, only when absent on the pinned side.
22. `layers.http.requests[]` multiplicity for `/api/tokenizers/*` only.
23. multipart boundary token in non-JSON request bodies and in the request `Content-Type` header value only.

Run 6 additionally recorded three scheduling decisions that this run did not need (no such rows occurred):
`layers.http.requests[] GET multiplicity only`, `layers.http.requests[] multiplicity for the named read-only
routes only`, and `HTTP request-set membership of /api/tokenizers/* only (identity present on one side); every
shared identity is still paired and its count body compared`. Their absence in the final run narrows nothing:
the same named machinery is still exercised by the teeth (a dropped tokenizer request and a duplicate GET are
survivor teeth; a changed count body is a kill tooth).

## Not compared (6)

1. third-party external egress (non-subject origins)
2. real provider completion
3. image codec bytes (thumbnail/avatar re-encode)
4. wall-clock timestamps inside compared files
5. the raw emitted-event STREAM (order and multiplicity of every event)
6. static frontend assets (non-`/api` paths)

## What the run proved, and what it did not

Proved on this corpus: the same journey, driven on isolated copies of the same UI-originated tree, produces the
same final browser state, the same `/api` request/response surface after the named projections, the same
byte-oriented provider requests, the same persisted state (including restart reads in both directions), and a
clean lifecycle (reload, restart as a new process, chat switch, hand-back).
Not proved: a real human's long-lived directory (`GOAL.md` §14 stays NOT MET); Node control, ≥8-user
concurrency, long-run soak and p99 on the corpus (recorded separately only if they ran); real-provider
completion (the peer is deterministic, `AGENTS.md` rule 22).

## Artifacts (outside the repository)

- `a19-diff/release8/out/release-evidence.json` — the evidence document (23 normalisations, 6 notCompared, teeth 51/51, `ok: true`, headSha `762b668…`)
- `a19-diff/release8/out/a19-live-oracle-comparison.json` — per-guard detail (26 in run 6; this artifact is the final one)
- `a19-diff/release8/out/a19-live-oracle-teeth.json` — in-run teeth (51/51, `ok: true`)
- `a19-diff/release8/out/legs/{a19-drive,a19-restart,a19-handback}-{gotavern,pinned}.json` — the six leg reports (each exit 0)
- `a19-diff/release8/run-facts.txt` — SHA / binary / manifest identity as measured
- legacy: `a19-diff/release6/out/*` (first all-layers-match run; its evidence is NOT the admissible artifact: teeth 43/51 and plumbing label, fixed by `d63e8fe`/`762b668`)

The corpus originals never enter the repository; only the manifest and the provenance
([`corpus.md`](corpus.md), [`corpus-report-v2.json`](corpus-report-v2.json)) are committed.
