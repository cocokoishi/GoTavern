# Surface contract: continue (P2)

**Status: contract written, evidence not yet gathered.** This file declares what "continue parity"
means *before* any guard exists, because the abort surface spent ten dispatches discovering that a
guard set without a declared subject encodes whichever vehicle it was first written against.

Baseline: SillyTavern `1.19.0` @ `06bde939fb1e9c4c8d8641d810f0a916b5bce127`.

## The claim

Given the same character, chat file, last assistant message and the unmodified pinned frontend,
pressing the **Continue** control must produce, on GoTavern and pinned Node, **the same provider
request bytes and the same resulting chat state.**

Parity is asserted at two levels. The second is the claim; the first is how a difference is explained.

**C1 — the claim.** `bodySha256` of the provider request is **equal** across subjects: messages array,
roles, ordering, the prefill/continue marker, `max_tokens` and stop sequences as pinned sets them.
This is a **byte** comparison, not a structural one.

**C1 has no provider request to compare → HARNESS ALARM FIRST.** A leg that produced no provider
request, no page error and no failed HTTP request is a probe-faithfulness alarm, not permission to
declare the product broken.

## What a C1 difference becomes

**A C1 difference is recorded as a `KNOWN DIFFERENCE` with its `bodySha256` pair and the V1/V2/V4/V5
evidence explaining it. IT IS NOT A FIX.** This is the user's *evidence first, patch second* rule
written into the contract itself, so that no runtime change can be reached for on the strength of one
red. A Go change on this surface requires all five: Node evidence, GoTavern evidence, a stable
asymmetric result, harness error excluded, and a named surface contract — this file is the fifth.

## How a C1 difference is explained — V1, V2, V4, V5

These are **substitutes for nothing**. They do not replace C1 and a green on any of them is not a
green on the claim.

- **V1 — request construction.** What the frontend put in the request: message count, roles, content,
  the continue/prefill marker, samplers and stops as recorded.
- **V2 — state.** The chat file before and after, the identity of the last message, and whether the
  continuation **extends** the existing assistant message or **opens a new one**. The difference
  between those two is user-visible and must be recorded either way.
- **V4 — response append.** The **streaming** and **non-streaming** branches judged **separately**:
  one message or two, and where the appended text lands.
- **V5 — error paths, on two axes.**
  (a) **provider error** mid-continue;
  (b) **client disconnect** mid-continue.
  These are **different terminal states**. The abort lane established that a cut and a caller abort
  end differently; a continue that treats them the same is a difference the abort surface cannot
  reveal. Each axis is measured on both subjects or is recorded as `not-observed`.

## The green standard

**For every guard that goes green, state how it could have failed.** A guard whose failure condition
cannot be stated is not a guard, and a guard reading an empty array is a green that cannot fail — the
exact defect the abort lane spent seven dispatches finding. Any guard added here must name a reachable
input that makes it red, and the mutation must be demonstrated before the guard is trusted.

## What this surface does NOT claim

- Frontend painting, Canvas or WebGL behaviour. **P4's boundary principle applies here**: browser
  pixel equality is not a Go backend parity requirement.
- Byte parity of the **response** body — only the request.
- Anything about a continuation driven by a Node server plugin (deliberate exclusion).
- Anything about a continuation that crosses an extension the pinned frontend does not load.
- **Streaming continuation (V4, streaming branch) — BOUNDARY, not a gap.** The streaming continue
  goes through a different path: `script.js:5388-5391` sets `streamingProcessor.firstMessageText = ''
  ` when `isContinue`, then `:5393` drives it through `sendStreamingRequest`, and `:5404-5406` prepends
  `continue_mag` to the assembled reply. Verified against the vendored pinned source
  (`upstream/public/script.js`), so the stated reason still holds. Driving it requires a streaming
  generator the capture peer does not provide, and the comparator records the same boundary at
  `artefact.notCompared`. **A boundary with a stated reason is a complete answer**; the streaming
  branch is therefore not counted against this surface, and the non-streaming branch it *does* claim
  is named as the branch measured.
- **Provider error mid-continue (V5(a)) — NOT YET DRIVEN.** No leg produces a failing provider, so
  "did the product save half a message on a provider error" is unanswered. Recorded in
  `artefact.notCompared` rather than implied.
- **Client disconnect mid-continue (V5(b)) — RECORDED, NOT YET JUDGED.** The leg drives an abort of the
  continue response and records both outcomes at `artefact.disconnectDuringContinue` with an `agree`
  verdict, because zero thresholds exist yet. It becomes a guard when there is a stated failure
  condition, not before.

## Pre-stated expectation, recorded before the run

**P2 is expected to produce a `KNOWN DIFFERENCE` or a boundary, not a green.** Continue is one of the
four surfaces the user listed as unstarted; the honest first deliverable is the measurement.

**If it produces a green, that green must explain why this expectation was wrong** — by showing that a
byte-identical request was observed on both subjects *and* naming what the dispatch did not cover
(V4's two branches separately, V5's two axes), so the coverage claim is bounded by what actually ran.
