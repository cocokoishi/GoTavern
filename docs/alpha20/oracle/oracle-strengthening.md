# Oracle strengthening (M3) — status and boundaries

This file records what the alpha.20 oracle lane actually EXECUTED for M3, what it wrote but did not run, and
what it did NOT execute. A class that did not run is marked `NOT EXECUTED` with its reason; it is never
implied by a plan or by a green run of something else.

## The framework is the existing five-layer oracle, extended additively

`tests/browser/a19-live-oracle.mjs` (driver), `a19-compare-live-oracle.mjs` (five-layer comparator) and
`a19-oracle-teeth.mjs` (51 named mutations, 51/51 killed in the alpha.19 release run) are unchanged. No second
oracle framework, no second comparator and no widened normalisation was added.

The alpha.20 additions are:

| file | role | state |
|---|---|---|
| `tests/browser/a20-probe-differential.mjs` | reruns the probe-(a)/(b) matrices on BOTH subjects and compares the observable tuple | **EXECUTED once (pre-fix)**; the post-fix rerun was stopped by the Lead's quiet window and is **NOT EXECUTED** |
| `tests/browser/a20-differential-teeth.mjs` | 13 adversarial mutations (12 must go RED, 1 negative must stay GREEN) against the recorded differential legs, with a pristine-bytes check | **WRITTEN, NOT EXECUTED** (it refuses to run on a non-green baseline) |
| the probe (a)/(b) pinned captures | the pinned oracle the differential compares against | EXECUTED (committed `evidence.json`) |
| probe (c)/(d) | Brotli negotiation / character cache | EXECUTED (pinned-only; see their docs for why a differential is a codec/perf question rather than a wire-equality one) |

## Executed: the pre-fix differential is a real RED; the post-fix run is MATCH on every product observable

`differential-before-fb24983.json` (both probes) is the first run of the differential driver, made while this
branch was still based on the tree before `fb24983` ("fix(server): enforce pinned chat_metadata.integrity and
schedule the group-save backup"). It is not a synthetic mutation: it is the two real subjects answering the
same requests.

- chat-integrity matrix: 3/14 scenarios matched in that pre-fix run; the integrity refusals, body/status and the
  absent backups all differed.
- group-save-backup matrix: 4/11 matched in that pre-fix run.

Post-`fb24983` (merged main `ebdbfbb`), the same matrices give **chat-integrity 13/14 MATCH** and
**group-save-backup 10/12 MATCH**; all status/body/chat-file/restart/retention observables match. The two
remaining rows are the dedicated backup-scheduler measurement and the flush row that carries the same one file.

**The scheduler row is HARNESS-ERROR, not a product difference, and this was measured, not argued.**
`a20-backup-window.mjs` boots both subjects with the SAME explicit `configPath`/config bytes (verified
`sameConfig: true` with resolved `backups.chat` values and digests in `backup-window/evidence.json`) and runs a
controlled timeline: save, wait 10,500 ms, save, then save again 1,500 ms later. Both subjects write a leading
backup immediately for the 10,500 ms save (sha matches the payload) and neither writes one immediately for the
1,500 ms save — the throttle policy matches. The differential's short-window snapshot therefore observed a
timer state, not a different policy; the row is classified HARNESS-ERROR and the post-fix matrix has no
product-observable DIFFERENT row. The controlled experiment also records each subject's config path, sha256 and
resolved backup values, so this classification is reproducible from the artifact.

## NOT EXECUTED (with reasons), so coverage is not implied

| class | state | reason |
|---|---|---|
| differential teeth (13 mutations RED/GREEN + pristine-bytes check) | **EXECUTED — 13/13 mutations kille, 0 survived, pristine artifacts byte-unchanged** (`differential-teeth.json`) | run on the committed differential artifacts with the three backup-scheduler/flush rows EXCLUDED BY NAME (the HARNESS-ERROR rows measured in `backup-window/evidence.json`); the excluded ids are recorded in the teeth artifact, and every product-observable row remained in the baseline. Each mutation flips exactly the named field to DIFFERENT; the timestamp-normalisation negative case stays MATCH. A SURVIVED row would be a comparator gap reported by name |
| five-layer live oracle re-run on the medium corpus (`a19-live-oracle.mjs --mode all`) | NOT EXECUTED | host was saturated by the performance lane and the quiet window; the alpha.19 release-admissible run remains the last five-layer evidence and is not re-used as alpha.20 evidence |
| provider-wire fault injection (mid-SSE close, arbitrary splits, no-response provider, truncated body) | NOT EXECUTED in this lane | a hand-posted generate request is not the product path; the faithful driver is the five-layer oracle's browser legs. Existing Go adversarial/transport tests cover parts and are not re-claimed |
| read-only FS / disk-full / rename failure / concurrent writers / mid-write termination / Windows locks / partial corruption / invalid config restart / restart with active requests / corrupt cache / expired session | **EXECUTED where listed in [`fault-injection.md`](fault-injection.md)** (8 scenarios with data-safety/no-false-success/recoverability/resource-release assertions); disk-full and provider-wire remain NOT EXECUTED with reasons | see fault-injection.md |


## Egress control (what every executed probe did)

- All executed probes talk only to `127.0.0.1`; no live provider, no third-party origin.
- Pinned boots always pass `--browserLaunchEnabled false`; the kit's `bootPinned` never opens a browser.
- The differential's GoTavern leg boots the binary built with `-trimpath` from this worktree over a scratch
  data root; the recording peer is local.
- The Tavern Helper install used the offline seed with a frozen local origin, so the pinned product's
  version-check path cannot reach the network (the extension's own load-time version check was the alpha.19
  disclosed egress; the seeded frozen origin is the mitigation already recorded there).
- Probe (c) captures the provider-wire side only over loopback; it makes no outbound call.

## What would close M3 (the honest remaining work)

1. Rebase/merge `origin/main` (done: `da84629`), rerun `a20-probe-differential.mjs` on an idle host and record
   `differential.json` for both probes (expected GREEN; a mismatch would be a real finding, not a teeth gap).
2. Run `a20-differential-teeth.mjs` on the green artifacts; every one of the 12 positive mutations must name
   the field it turns red, the negative timestamp case must stay green, and the pristine artifact sha256 must
   be unchanged before/after.
3. Add the live fault-injection class list as a separate additive probe only if a host window exists; until
   then the rows above stay `NOT EXECUTED`.
