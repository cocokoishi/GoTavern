# alpha.18 release bar — machine-checkable state

`GOAL.md` §16 is the goal-level bar; this file is the checkable form. Each row names what would prove it and
the artifact that records the proof. A row is only `MET` when its evidence exists and was produced by the run
named; `PENDING` rows are open obligations, and the release must not be tagged while any is PENDING.

| # | requirement | how it is checked | state (at freeze) |
|---|---|---|---|
| 1 | 13 required gates green at ONE candidate SHA, unified evidence PASS 13/13 | `node scripts/verify-release-gates.mjs --sha <candidate> --manifest docs/release-manifest.json` inside the publish job, and the same command by hand before tagging | PENDING — recorded in `docs/alpha18/same-sha-evidence.md` after the wave |
| 2 | narrowed dispatch refused by NAME; skipped required job refused; wrong SHA/event/artifact refused | real `long-lived … -f size=small` run refused for skipped `medium-corpus` (run id in `docs/alpha18/evidence-contract.md`); real Docker full-selection run accepted; the pre-run-name alpha.17 titles refused under the applied manifest; local `scripts/release-governance.test.mjs` 87/87 | MET (real runs recorded in `docs/alpha18/evidence-contract.md`) |
| 3 | 10,000-card hotspot: root cause, production change, paired ≥20% improvement in p50 or peak RSS, no material regression | `docs/alpha18/perf-hotspot.md` (roots + change), `docs/alpha18/perf/abba-inprocess.json` (24 paired rows: 10,000-card p50 −60.0%, B/op −40.3%, 1,000/100 cards −33.7%/−26.0%), `docs/alpha18/perf/abba-process.json` (published alpha.17 binary vs candidate, boot/RSS/HTTP), same-SHA `GoTavern smoke metrics` gate in row 1 | MET (in-process ABBA + process ABBA; CI gate in row 1) |
| 4 | product capabilities: real CORS proxy, pinned chat auto-backups, streaming/cancel resource evidence; every fix has RED/GREEN | 35 CORS tests against real upstreams (plus a mutation RED), 49 backup tests (plus two mutation REDs), 13 real-socket streaming tests (plus three mutation REDs), full `internal/server` suite green; divergences/limits in `docs/SEMANTIC-COMPATIBILITY.md` §18 | MET |
| 5 | 60-minute mixed-load soak on the final candidate with honest limits | `tools/perf/a18-soak.mjs --minutes 60` artifact `docs/alpha18/perf/soak-60min.json`; leak verdict explicitly UNPROVEN (RSS-only) | PENDING — run started after freeze; artifact added in the post-wave docs commit |
| 6 | classifier graduates alpha.18 and neighbours stay prerelease | `bash scripts/test-classify-version-tag.sh` 74/74 green with the alpha.18 equality entry and alpha.19/180/18-rc1/18+build.1 prerelease | MET |
| 7 | release notes checked against evidence, every unproven item listed, no claim ahead of a gate | `docs/release-notes-v0.1.0-alpha.18.md`; `node tools/check-perf-docs.mjs` green; `tests/docs/check-perf-docs.test.mjs` 15/15 | MET |
| 8 | publish `draft=false`, `prerelease=false`, `latest=true`, six archives + checksums, same-SHA evidence table in the body | `GoTavern Release` publish job + post-publication check | PENDING |
| 9 | Docker `:v0.1.0-alpha.18` and `:latest` same digest; older images unchanged | `docker.yml` run at the candidate + post-publication `docker manifest inspect` | PENDING |
| 10 | independent post-publication verification (six archives re-downloaded and checksummed, published binary `version`, unpacked run with a real data request and a write/read closure, installer smoke, published-extension smoke, `releases/latest`) | post-publication ledger in `docs/alpha18/handoff-ledger.md` | PENDING |
| 11 | no force push, no tag move, no `--no-verify`; alpha.16/alpha.17 tags unchanged | `git cat-file -t`/`rev-parse` of both tags before and after + the ledger | PENDING |
| 12 | `GOAL.md` §14 stays NOT MET | `GOAL.md` §14 text and `docs/goal-scorecard.md` (unchanged answers) | MET (unchanged, NOT MET) |

## Freeze discipline

- The candidate is the commit that contains this file, the release notes, the GOAL/HANDOFF records, the
  regenerated benchmark baseline and every product change. After it is pushed, the 13-gate wave is dispatched
  from `main` at that SHA.
- **No product code change after freeze.** A change would invalidate the wave and require a new candidate;
  only documentation that records completed evidence may follow on `main` (and it does not move the tag).
- The tag is annotated and is created only after the verifier prints PASS 13/13 for the candidate, and it is
  never moved afterwards.
