# Surface contract: hand-back to Node (P3)

**REQUEST HAND-BACK IS ABSENT. NOT PARTIAL, NOT CONFIGURED-OFF — ABSENT.** A reader who skims
this file must come away knowing that GoTavern does **not** proxy an unimplemented route to a
running Node SillyTavern under any configuration, and that no code path exists to do so. This is
stated first because the hazard on this surface is not a wrong measurement — it is a reader
believing a hand-back happens. A document that implies a proxy exists is the same class of defect
as a matrix row asserting a gap the evidence had already closed.

Baseline: SillyTavern `1.19.0` @ `06bde939fb1e9c4c8d8641d810f0a916b5bce127`.

## Two different hand-backs, and only one exists

**DATA hand-back — driven, and judged.** `Q21` (`tests/browser/q21-data-handback.mjs`, workflow
steps `Hand GoTavern's own tree back to pinned Node (Q21)` and `Judge the hand-back`) boots the
product over a fresh data root, lets it write a real conversation, then hands **the same
directory** to pinned via `run-against-pinned.mjs --data-root`, and then hands a
pinned-written tree back the other way. The assertions are `gotavernWrote`, `pinnedOpened`,
`pinnedOpenedSavedChat`, `pinnedReadTheChat`, `pinnedChatIdMatches`, `pinnedContinued`,
`pinnedBranched`, `noDataLossOnHandBack`, plus the reverse-direction rows `gotavernMutated`,
`branchStateSurvivesGoWrite` and `pinnedReadGotavernsTurn`.

**The claim is judged, not inferred.** `tests/oracle/q21/judge-handback.mjs` is a separate program
that names the rows each DIRECTION requires, distinguishes `unreached` (the probe never got there)
from `mismatch` (it got there and disagreed), refuses `match` on an all-zero count, and has its own
negative controls (a zero-step report, a missing `pinnedContinued`, a zero `continueRequests`, absent
counts, a red row, a failure field). The earlier version of this file listed `pinnedContinued` as an
assertion while no code asserted it; that is why the judge exists.

**What this surface still does not claim.** A hand-back is not a proof about the USER's tree: the
fixture is the committed synthetic derivation, and `card-a.png` could not be re-derived without the
private original, so the container's own root/data and `trAc`/extension relations remain unproven
while the generator's one-canonical-document invariant is proven on synthetic sources. The state of
the Q21 claim itself lives in [`docs/goal-scorecard.md`](../goal-scorecard.md)'s Q21 row, never
here — this file describes the SURFACE, and a surface document that reports a status is how two
sources of truth start.

**REQUEST hand-back — absent, and this contract's subject.** No route is proxied, no request is
forwarded, and no configuration selects an upstream Node.

**The absent mechanism, established by three independent searches**, each naming what it searched
for (rule 11's shape — a negative needs the search stated, not assumed):

1. **`ReverseProxy` in `internal/` and `cmd/`: 126 hits, every one the pinned provider setting
   `reverse_proxy`** — a per-source boolean read from the request body
   (`aimlapi_chat.go:211-213`, `body.member("reverse_proxy")`). **Not one is
   `httputil.NewSingleHostReverseProxy`**, and none forwards a route.
2. **`handback|hand-back|HandBack|upstreamNode|proxyTo` across `internal/`: two *test* filenames,
   no implementation.**
3. **The 18 `StatusNotImplemented` answers are provider-branch 501s** — rule 17's correct answer
   for an unimplemented provider, not a hand-back trigger.

## The claimed boundary: what a user gets

Per route, GoTavern answers from itself and **reaches nothing further**. The claim is therefore
better than "hand-back configured": it is **no outbound request at all**, which is asserted by a
request count rather than by a status (rule 17 — a status alone cannot distinguish "correctly
refused" from "not implemented").

**The route set, enumerated from the router rather than accumulated** (rule 43's shape — a missing
row must be a failure, not an omission):

| Route | Condition | Answer | Outbound requests |
|---|---|---|---|
| `/api/content/importURL` | host is `chub`/`characterhub`, `janitorai`, `pygmalion`, `risu`, `perchance` | **501** | **0** |
| `/api/content/importURL` | host is neither a provider nor in `whitelistImportDomains` | 404 (policy refusal) | 0 |
| `/api/content/importURL` | `aicharactercards.com` / generic whitelist | 200 (implemented) | ≥0 (by design) |
| `/api/content/importUUID` | any non-AICC shape | **501** | **0** |
| `/api/image-metadata*` | generation unsupported for the type | **501** | **0** |

**The exclusions are TOTAL.** Under this boundary **nothing is forwarded** — not the body, not
headers, not the query string, not cookies — because there is no mechanism to forward them. There
is no "mostly forwarded" state to describe. A future reader looking for which headers are stripped
will find the answer is *all of them, along with everything else*.

## `not implemented` must stay distinguishable from `refused`

This is `AGENTS.md` rule 17 living on this surface, and it is the one place P3 could produce a
**product finding** rather than a boundary. Each 501 site carries its reason in source:

- `content.go:169-172` — *"provider branches ported in later increments answer 501 rather than
  pretending the host was refused: silently answering 404 here would misreport pinned behaviour."*
- `content_uuid.go:147-149` — *"unimplemented provider downloader: 501, never a 404 that would be
  indistinguishable from a policy refusal."*
- `image_metadata_get.go:71-72` — 501 with a named error message.

**The gate asserts status AND `noOutboundRequests`.** A 501 that made an outbound request would be
a hand-back under another name; a 404 for an unimplemented branch would be a rule-17 defect.

## The state each leg starts from — P2's carry-over, restated here

P2's four instrument findings all lived in *what state each leg starts from*. For this surface the
asymmetry to look for is not which chat a leg holds but **which server the request reaches**. Under
this boundary the answer is always **"GoTavern, and nothing further"** — and the outbound request
count is the evidence, not the status code.

## What this surface does NOT claim

- That request hand-back will never exist. This records that it **does not exist now**; adding it
  is a product decision needing its own design and the five-part evidence, and it is not implied here.
- Anything about extension loading in a second runtime (Q21's own stated exclusion).
- Provider-wire parity (Q14 owns it).
- That the 501 route set is complete against pinned's route list — the diff is the instrument, and
  it is recorded per route rather than as a total.

## Pre-stated expectation, recorded before the run

**P3 is expected to produce a `DELIBERATE EXCLUSION` boundary with a per-route table, not a
`PROVEN`.** The deliverable converts an unknown into a measurable exclusion, which is the Alpha 9
objective in miniature. **A `PROVEN` would require the route enumeration to be complete against
pinned's own route list**, which this contract does not yet claim.