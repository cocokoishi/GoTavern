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

## The result: `not-observed` for parity on a common setup

**P2 closes `not-observed`, and this section is the reason.** Four runs, no product answer, and the
reason is structural rather than budgetary.

**C1 measured `a1e050cbfa0f` on both subjects — identical.** That is a *match on two legs that did
not run the same experiment*, and it is explicitly **not** a parity claim. The digest equality is
real and reproducible (it is the same digest `AGENTS.md` rule 101 recorded on 2026-10-27); it does
not show that the subjects behave identically given identical state.

**The named reason, with its numbers:**

```
gotavern: openChat "chats/.../Seraphina - 2023-5-12 @21h 32m 29s 224ms.jsonl"
          source "file"  lines 2  messages 2  carriesPredecessor false  openedContextChatLength 0
pinned:   openChat "chats/.../Seraphina - 2023-5-12 @21h 32m 29s 224ms.jsonl"
          source "file"  lines 6  messages 6  carriesPredecessor true   openedContextChatLength 5
chat completions: gotavern 4, pinned 2
```

**Same path, different file.** The mechanism is at `q20-continue-probe.mjs:520-530`: the handoff tree
is a `fs.cp` of the **GoTavern leg's data root, taken after its setup turns and before the press**, and
the pinned leg then inherits it. So the pinned leg is *given* the predecessor that the GoTavern leg
*wrote*, and the GoTavern leg is then asked to have it independently. **That is not a comparable
experiment; it is two legs measured on two different starting states.**

## THE RULE THIS SURFACE PRODUCES

> **The handoff tree is an INPUT, and a leg that is not handed it cannot be compared.**
>
> A surface whose legs start from different states is `not-observed` for parity, whatever the
> individual guards say. Where one leg's state is produced by the other leg's drive and then
> inherited, **the comparison measures the handoff, not the subject.**

This generalises to every verb probe — regenerate, continue, impersonate: any verb where one leg's
state is derived from the other's drive carries this hazard, and the first question is always **what
state does each leg start from**.

**A repair that made the file exist but replaced a richer state with a poorer one is the concrete
instance of why this is a rule rather than an observation.** The pre-gate save fixed `openChat: null`
and produced `openedContextChatLength: 0` — a two-line file over a six-line one. It closed the
*existence* half of the divergence while destroying the *content* half, and a further repair would
have chased the symptom. That is the moment to state the boundary, not to fix the sixth thing.

## What WAS newly measured

`pre-gate-save-succeeded` and `gate-found-the-chat-on-disk` — two new steps, both green, both real.
`openChat` moved from `null` to a resolved path, and 27 of 27 continue steps passed on the GoTavern leg.

## What is NOT covered

- **V5(a) provider error mid-continue** — still `notCompared`.
- **V5(b) client disconnect** — now drives (`ok disconnect-mid-continue-recorded`), but the run never
  reached a comparison, so it measured nothing about the product.
- **V4-streaming** — a recorded boundary, pinned source verified at `script.js:5388-5391`, `:5393`,
  `:5404-5406`.

## The four-run cost, as record

| Run | Finding | Outcome |
|---|---|---|
| 40757180703 | the V5(b) insertion broke a counting assertion | my defect, fixed by relocation |
| 40761754633 | setup divergence, `openChat: null` | fixed |
| (no dispatch) | classification defect, `not-driven` read as `agree` | fixed at zero dispatch cost |
| 40767188029 | partial fix, content half open | closed as `not-observed` |

**Two instrument findings fixed, one classification defect fixed without a run, one partial fix, and
one re-measured equality. No product answer.** The cost came almost entirely from the vehicle rather
than the subject, which is the shape P3 must avoid.
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
