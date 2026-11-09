# Red-run triage: the two main-branch reds after the alpha.18 publication

Owner: Subagent B (compat-diff). Date: 2026-11-08. Source of truth: the run logs quoted below, not a
summary of them. Evidence files (outside the repo, because they are raw CI logs):
`C:\Users\koishi\Desktop\GoTavern\a19-diff\soak-log.txt`,
`C:\Users\koishi\Desktop\GoTavern\a19-diff\published-smoke-log.txt`,
`...\run-42478967874.json`, `...\run-42477517830.json`.

## Verdict

| run | workflow | failing job / step | classification |
|---|---|---|---|
| 42478967874 | `Third-party extension compatibility` | `soak` / `Thirty-minute all-20 soak (both subjects)` | **driver precondition + CI environment** (an external HTTPS request that never settles). NOT product, NOT pinned drift. |
| 42477517830 | `GoTavern published-extension smoke` | `published-linux-artifact` / `All-20 extension differential against the PUBLISHED binary` | **same root cause, proven symmetric: BOTH subjects fail the same guard.** NOT product, NOT published-artifact path. |

Both reds are the same defect in the harness's `network-quiet` precondition: it counts the *browser page's
own* egress — including a third-party extension's GitHub API fetch — as "the drive did not hold". When that
external connection hangs, a leg fails for network weather. GoTavern's server is not in the path.

## 1. Run 42478967874 — `Third-party extension compatibility`, job `soak`

Facts from `gh run view 42478967874 --json ...`:

- workflow `Third-party extension compatibility`, event `schedule`, branch `main`,
  headSha `52883e8a048e4f29f6f574529d2491339106fe28`, conclusion `failure`.
- failing job `soak` (id `128726625481`), step 12 `Thirty-minute all-20 soak (both subjects)`:
  started `2026-11-08T12:11:36Z`, failed `13:20:36Z`. Every other job is green
  (`shard (1..4)`, `corpus`, `overhead`, `aggregate`, `selftest`, `macos-arm64-recorded-limitation`).

The failing assertion, quoted from the job log:

```
2026-11-08T12:45:06.8605662Z [gotavern/before] FAIL network-quiet :: {"quiet":false,"waitedMs":120084,
  "requests":796,"unresolved":["/repos/DangerDaza/Dooms-Enhancement-Suite"]}
2026-11-08T12:45:06.8634287Z   "failure": "drive steps did not hold: network-quiet",
```

The other three phases of the same job:

```
12:45:06  [go soak before]     exit 1 in 1974s
12:45:06  --- pinned soak before ---
13:16:07  [pinned soak before] exit 0 in 1861s
13:18:21  [go soak after]      exit 0 in 134s
13:20:35  [pinned soak after]  exit 0 in 134s
13:20:35  --- compare soak ---
          "failedExtensions": [],  "soak": "PASS",
          "failedGuards": ["gotavern-legs-drove"]
```

So: every extension-compatibility assertion that ran was green (`failedExtensions: []`, `soak: PASS`), all
four legs finished, and only the **leg-drive guard** failed, because one browser request was still in flight
at the end of the 120 s `network-quiet` window. The URL path is the GitHub REST repository endpoint for the
pinned corpus extension `DangerDaza/Dooms-Enhancement-Suite`
(`tests/browser/third-party-extensions.lock.json:2027-2030`, commit `893b1e17…`, capabilities include
`fetch` and `remote-network`).

## 2. Run 42477517830 — `GoTavern published-extension smoke`, job `published-linux-artifact`

Facts from `gh run view 42477517830 --json ...`:

- workflow `GoTavern published-extension smoke`, event `workflow_dispatch`, branch `main`,
  headSha `81d70dc27e6165cca83bd4e4f37882395183b444`, conclusion `failure`.
- failing job `published-linux-artifact` (id `128722044527`), step 11
  `All-20 extension differential against the PUBLISHED binary`; the sibling
  `published-container` job is green.

The failing assertions, quoted from the job log — note that BOTH subjects fail, with the same unresolved
path and the same request count:

```
2026-11-08T11:55:25.7641853Z [gotavern/after] FAIL network-quiet :: {"quiet":false,"waitedMs":120004,
  "requests":796,"unresolved":["/repos/DangerDaza/Dooms-Enhancement-Suite"]}
2026-11-08T11:58:09.2660394Z [pinned/after]   FAIL network-quiet :: {"quiet":false,"waitedMs":120095,
  "requests":796,"unresolved":["/repos/DangerDaza/Dooms-Enhancement-Suite"]}
...
2026-11-08T11:58:09.3965972Z   "failedGuards": ["gotavern-legs-drove", "stock-legs-drove"]
2026-11-08T11:58:09.4339755Z === all20: FAIL (412s) -- gotavern-legs-drove; stock-legs-drove
```

The `before` legs both passed (`go all20 before` exit 0 in 19 s, `pinned all20 before` exit 0 in 37 s); only
the `after` legs hit the hang, and they hit it **identically**. `failedExtensions: []` again.

This run is the strongest available evidence for the classification: the **stock pinned leg — the oracle —
fails the same guard on the same URL with the same `796` recorded requests**. A defect in GoTavern cannot make
pinned Node fail; a defect in the published Go binary cannot either, because the pinned subject is a
different program. The only shared variable is the external network and the driver that watches it.

## 3. Mechanism (read from the source, with line numbers)

`tests/browser/extension-corpus-probe.mjs`:

- `page.on('request')` records **every** browser request (`:313-321`), with
  `path: url.pathname + url.search` — the host is deliberately not recorded, which is why the log line shows
  a bare `/repos/...` path.
- `waitForNetworkQuiet(entries, {quietMs, deadlineMs})` (`:286-298`) returns `quiet: true` only when
  **no** recorded request has `status === null` and no new request arrived for `quietMs`; on timeout it
  reports the first ten unresolved paths.
- The guard is a recorded drive step: `record('network-quiet', settle.quiet === true, settle)` (`:524`), so a
  timeout becomes `failedSteps: ["network-quiet"]` → `failure: "drive steps did not hold: network-quiet"` →
  the leg exits 1 (`:680-693`) → the comparator's `gotavern-legs-drove` / `stock-legs-drove` guards go red.

Nothing in GoTavern's server can terminate a browser request to another origin: the connection is held by
Chromium on the runner, and the URL is emitted by extension JavaScript served from the page. The same
796-request surface in failing and passing legs says the page state is identical; only one external
connection's fate differs.

## 4. Classification rationale, one category at a time

- **Product (GoTavern defect): REJECTED.** No parity guard failed in either run (`failedExtensions: []`);
  the failing guard is a driver precondition; and in run 42477517830 the pinned oracle fails the same guard
  with the same input. There is no GoTavern route or transport in the request path.
- **Upstream drift (pinned SillyTavern changed): REJECTED.** The pinned checkout is fetched and asserted by
  `checkout-pinned`; both logs contain `oracle: checked out 06bde939… (asserted)`. Pinned's own leg behaves
  identically to GoTavern's when it meets the same hung connection.
- **Driver defect: CONFIRMED (immediate cause).** `network-quiet` treats third-party extension egress as part
  of "the drive held". That precondition is stricter than the subject's own gate — AGENTS verification rule
  10's false-negative shape: a driver that fails on something the product does not control reports a product
  finding that does not exist.
- **CI environment / external network: CONFIRMED (trigger).** The same URL settles in the same job later
  (soak `after` legs exit 0 in 134 s; published run `before` legs exit 0) and in other runs of the same
  workflows (`gh run list --workflow 'Third-party extension compatibility' --limit 10` shows 8 successes
  around it). This is API-rate-limiting/latency weather at `api.github.com`, not determinism.

## 5. Recommended driver fix (proposed; `tests/browser` existing harness needs Lead approval)

1. Record the request **origin** (`url.origin`) alongside the path, so an artefact can say *which host* did
   not settle. Today it cannot.
2. Split `network-quiet` into two observations:
   - `network-quiet` — same-origin requests (the subject's own routes) plus the recording peer. This stays a
     drive step; a hung same-origin request really is a subject/harness fault.
   - `external-egress` — third-party origins: recorded as an informational row
     (`{origin, path, pending, waitedMs}`), NOT a leg failure, and listed in the comparator's `notCompared`.
   The comparator may then still fail on a *parity* difference in external egress count, but never on its
   timing.
3. Teeth: a selftest must mutate the guard in both directions — a stalled **same-origin** request must still
   turn the named guard red; a stalled **external** URL must leave the leg-drive verdict green while the
   `external-egress` row records it. This is the negative case that proves the split is discriminating and
   not a widened ignore.
4. Rejected alternative: `page.route` aborting non-allowlisted origins. It would change the extension's
   observable behaviour and make both subjects depend on the harness rather than the product.

## 6. What this triage does NOT prove (stated, not implied)

- The request's host is not in the log (only the path); `api.github.com` is inferred from the GitHub REST
  path shape plus the lock entry. The soak artifact `extension-compat-soak` (artifact id 13619120970,
  81,828,563 bytes) was not downloaded here; a `rows[]` entry would confirm the origin if host were recorded.
- The extension checkout that emits the request is a CI temp directory and is not uploaded, so the emitting
  line is not quoted. It is third-party client-side code by construction (the URL is not a GoTavern or
  SillyTavern route).
- Neither workflow was re-dispatched. A re-run is expected to PASS while `api.github.com` settles, and a
  recurrence at the same guard on BOTH subjects would strengthen, not weaken, the environment claim.
- The published-binary path itself is not implicated: the container job and the `before` legs were green;
  the same guard failed on the pinned leg.

## 7. Impact on alpha.19

Neither red blocks the alpha.19 baseline: both are pre-existing harness/environment failures, not candidate
defects. They do mean the "main is red" statement in `CHARTER.md` §1.3 stays true until the driver fix above
lands, and that a 30-minute soak gate can fail for weather that no subject change can fix. The fix is
Lead-owned (`tests/browser/**` existing comparator/probe: one writer at a time, teeth required), and it should
land before the alpha.19 same-SHA wave, because an unexplained soak red on the candidate would be
mis-attributed to the candidate.
