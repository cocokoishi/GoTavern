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

## Executed: the pre-fix differential is a real RED

`differential-before-fb24983.json` (both probes) is the first run of the differential driver, made while this
branch was still based on the tree before `fb24983` ("fix(server): enforce pinned chat_metadata.integrity and
schedule the group-save backup"). It is not a synthetic mutation: it is the two real subjects answering the
same requests.

- chat-integrity matrix: **3/14 scenarios matched, 11/14 differed** — A3/A4 (integrity refusal) differed in
  status, body and file state; A10 (corrupt first line) differed in status/body/file; A1/A6/A7/A8/A9/A11/B1/C1
  differed in the backups tuple (the pre-fix binary scheduled no backups).
- group-save-backup matrix: **4/11 matched, 7/11 differed** — G5 differed in status/body/file; G3/G4/G7
  differed in backups; G8 (flush on close) differed in both the pre-stop and across-exit counts; G10
  (retention) differed.

That is the RED half of a RED→GREEN pair for the two closed M1 gaps. The GREEN half — the same matrices on
the post-`fb24983` merge — is not claimed until it runs.

## NOT EXECUTED (with reasons), so coverage is not implied

| class | state | reason |
|---|---|---|
| post-fix differential rerun (expect GREEN) | NOT EXECUTED | started on the merged tree (`da84629`) and stopped by the Lead's quiet-window instruction to leave the 2-vCPU host idle. The previous run's artifacts are preserved; no result is claimed |
| differential teeth (13 mutations RED/GREEN + pristine-bytes check) | NOT EXECUTED | depends on the post-fix GREEN baseline; running it now would refuse by design |
| five-layer live oracle re-run on the medium corpus (`a19-live-oracle.mjs --mode all`) | NOT EXECUTED | needs both subjects' browser legs plus a corpus copy; the host was saturated by the performance lane's ABBA measurements and the quiet window forbids the load. The alpha.19 release-admissible run remains the last five-layer evidence and is not re-used as alpha.20 evidence |
| mid-request disconnect / upstream close / arbitrary SSE splits / no-response provider / truncated body | NOT EXECUTED in this lane | these are provider-transport fault classes. Existing Go tests cover parts of them (`internal/adversarial`, `internal/outbound` transport matrix, stream-truncation teeth); this lane did not add a new live fault-injection run, so it claims no new coverage |
| read-only FS / disk-full / rename failure / concurrent chat writers / mid-write termination / Windows locks / partial corruption / invalid config restart / restart with active requests / corrupt cache / extension save failure / expired session | NOT EXECUTED in this lane | same reason (host/quiet-window and time); corrupt-cache and broken-backup-directory shapes ARE covered by probe (d) C13 and probe (b) G12 as pinned behaviour, not as Go-side fault injection |

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
