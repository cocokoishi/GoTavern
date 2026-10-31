# Browser hand-back stability (Q21)

**Status: RESOLVED — the Q21 hand-back leg is now condition-gated, and its repeated-stability mode is
the evidence path. Root cause, fix, proof and residual risk are below; the old disposition
("the pinned-frontend persistence flake, occasionally red") is retired.**

This document exists because Beta 1 refuses a known-occasional red. It covers `stability_runs` in
`.github/workflows/browser-differential.yml`, the waits in `tests/browser/q21-data-handback.mjs`,
and what the hand-back judge now guarantees.

---

## 1. The observation the lane started from

`Browser differential` run **41171855911** (workflow dispatch, `mode=all`, head `91e1e15`) was green on
every other surface and red on exactly one step, **"Judge the hand-back"**. The pinned leg's report
said:

```
pinnedWrote: ok    send={clicked:true,chatLength:4}  sendReply="Q21_REPLY_1"  fileMessages=5
pinnedContinued: FAIL
  click={clicked:true,startedAt:4,chatLength:5,lengthGrew:true,lastMessageGrew:false,lastMessageBytes:30}
  continueRequests=0  answerPersisted=false
  allRequests=[ one send request: markers{first:true,second:true}, answersWith="Q21_REPLY_1" ]
  chatFileTail=[assistant "Q21_REPLY_1",
                user    "Q21_PINNED_CONTINUATION_MARKER",
                assistant "Q21_REPLY_1"]
```

The identical commit re-judged on run **41179659240** (same workflow, `mode=preset`) was green, with
the same `pinnedWrote` and:

```
pinnedContinued: ok
  click={clicked:true,startedAt:5,chatLength:5,lengthGrew:false,lastMessageGrew:true,lastMessageBytes:23}
  continueRequests=1  messageCount=8  answersWith="Q21_REPLY_2"  answerPersisted=true
```

So the same code, the same fixture and the same assertions produced `continueRequests = 0` once and
`1` another time. That pair of reports is the measurement this document explains.

## 2. What the two reports discriminate

The only fields that differ are the ones that describe the page at the moment the CONTINUE control was
pressed, and they differ by exactly one message:

| field | red run (41171855911) | green run (41179659240) | meaning |
| --- | --- | --- | --- |
| `click.startedAt` (chat length at press) | **4** | **5** | in the red run the send's assistant reply was NOT in the page yet |
| `click.lengthGrew` / `lastMessageGrew` | `true` / **`false`** | `false` / **`true`** | red: a new message appeared after the press (the send's reply landing); green: the last message grew (the continuation) |
| `continueRequests` | **0** | **1** | red: no request left the frontend; green: one did |
| `pinnedWrote.fileMessages` | 5 | 5 | the chat FILE, too, was one line short of the send's reply |
| `allRequests` | 1 (the send) | 2 (send + continue) | the continue request itself |

`pinnedWrote` was **green in both runs**, and in the red run it was green while the send was still
streaming. That is the whole defect: the wait intended to prove "the send's reply landed" was
satisfied by a **different message with the same text**.

## 3. Root cause

The pinned leg's peer answered every request with `Q21_REPLY_<ordinal>`, and GoTavern's leg had used
the same peer template to write `Q21_REPLY_1` into the tree it handed over. The pinned half's
persistence wait was:

```js
pollUntil(readChatFile(savedChatName),
          chat => chat.some(entry => entry.mes === sendReply))   // sendReply === "Q21_REPLY_1"
```

The handed-back conversation already contained `Q21_REPLY_1` (GoTavern's reply to its own turn), so
this predicate was **true before the send's reply existed**. The chat file's line count confirms it:
the file carries a `chat_metadata` line plus the three loaded messages plus the send's user turn =
**5 lines**, i.e. the send's assistant reply (line 6) had not been written. The file therefore proved
nothing about the send's reply, and `pinnedWrote` went green while the page still had
`is_send_press === true`.

The CONTINUE click then reached `public/script.js:11648-11661`, whose own gate is:

```js
if (is_send_press == false || fromSlashCommand) {
    is_send_press = true;
    Generate('continue', ...);
}
```

With the send in flight the gate **refused the press silently** (no toast, no error). The probe's
post-click wait was `chat.length > start || lastTextNow !== lastTextBefore` — it accepted ANY chat
motion, so it returned as soon as the **send's own reply** landed (`4 -> 5`, `lengthGrew: true`). The
count of new peer requests was then taken synchronously and was legitimately `0`: no request for the
continue ever existed. The old `continuedInFile` wait had already computed `continueReply = null`, so
it polled for 60 s and could never succeed.

**In one sentence:** the probe pressed CONTINUE while the previous SEND was still streaming, because
its "reply landed" check could not tell one runtime's reply from the other's; pinned's own continue
guard then (correctly) swallowed the press, and the send's reply arriving afterwards was misread as a
continuation. The deterministic defect is the **fixture-level reply-text collision**; the race is
**which of the two events — the send finishing or the probe's next step — comes first**, which is why
the same commit can be green and red.

It is a **harness race, not a product defect and not a pinned-frontend defect**: the pinned frontend
behaved exactly as its source says it should (refuse a generation while one is running), and the
GoTavern leg was green in both runs.

## 4. Candidate causes, their exact code path, and their disposition

Every candidate from the lane brief was checked against the two reports and the code; only #2/#3 are
the cause, #4/#9 are the enabler, and the rest are excluded **by evidence, not by assertion**.

| # | candidate | exact code path | disposition |
| --- | --- | --- | --- |
| 1 | GoTavern race | `gotavernWrites()`: send -> `waitForTimeout(3000)` -> `hashTree`; product save path | **Not the cause** (the GoTavern half was green and the pinned leg's `continueRequests` counts only requests from the pinned page). **Latent race fixed anyway**: the 3 s sleep is now two named conditions (`gotavern-send-request-reached-peer`, `gotavern-send-committed-to-disk`) so the handed-over tree always contains the reply. |
| 2 | pinned frontend race | `public/script.js:11658` gate refused the press while `is_send_press` was true; probe's post-click wait accepted unrelated chat motion | **CONFIRMED, primary.** Fixed by waiting for the frontend's own idle state before pressing, reading press acceptance synchronously, and requiring the continuation's request before claiming anything. |
| 3 | browser timing | the click and the send's stream completion are concurrent page events; the old wait had no discriminator between them | **CONFIRMED, same event as #2.** Fixed: no wait accepts "the chat changed" as "the press started"; the press's own acceptance flag is the observation, and the provider request is the ground truth. |
| 4 | harness race | `sendReplyPersisted` matched `chat.some(mes === sendReply)`; both peers answered `Q21_REPLY_n`; so the handed-back reply satisfied it | **CONFIRMED, enabler.** Fixed: replies are phase-tagged (`Q21_PINNED_REPLY_n` / `Q21_GOTAVERN_REPLY_n`) and the persistence check is positional (assistant turn *after* the send's user turn). |
| 5 | filesystem timing | file polls; the 3 s sleep before hashing; pinned's `saveChatDebounced` (`public/script.js:7361`) | **Not the cause of `continueRequests==0`** (the press is gated by `is_send_press`, not the file). The GoTavern-side fixed sleep WAS a latent nondeterminism in the handed-over fixture and is replaced by a filesystem condition wait. |
| 6 | server readiness | `waitForVersion` (`gotavernWrites`, `bootGotavernOver`, `run-against-pinned.waitForVersion`), all HTTP-200-bounded | **Excluded.** Both legs reached `pageModelLoaded` and `opened` in both runs (`waitedMs: 0` / ready in the log). Unchanged. |
| 7 | persistence timing (pinned save lag) | `saveChatDebounced` + `saveChatConditional` | **Not the cause.** The file is an assertion surface, not the press gate; the fix stops using the file as a proxy for page state. The continue's own answer is still waited for on disk, because the file IS the claim. |
| 8 | stale state across runs | workflow `rm -rf "$tree"; mkdir -p "$tree"`; probe's `dataRootWasEmpty` step | **Excluded.** The red run's `dataRootWasEmpty` and every iteration's fresh tree passed. |
| 9 | cache / service worker | probe routes `**://testingcf.jsdelivr.net/**` to abort; `chromium.launch()` per leg; `page.on('pageerror')` | **Excluded.** The red report's `pageErrors` was `[]` and no service worker exists in the pinned frontend. Kept as-is (fresh context per leg). |
| 10 | nondeterministic selector | `#option_continue`, `#send_but`, `#send_textarea` | **Excluded.** `clicked:true` in the red run: the control resolved and the click was delivered; the frontend's guard refused it. The fix now records that refusal instead of inferring from a chat change. |
| 11 | fixture contamination | the committed card + markers are staged fresh; but the two peers' reply template was shared | **CONFIRMED as #4's mechanism.** The card fixture is unchanged; the reply-text collision is removed at the peer (phase tag). The hand-over tree is regenerated per run, so this leaks into no committed fixture. |

## 5. The fix

`tests/browser/q21-data-handback.mjs` no longer contains a fixed sleep in the hand-back drive, and
every wait is a **named condition** recorded in `report.conditions` with `waitedFor`, the deadline,
the elapsed time and the observation on the wire:

| condition | subject state it waits for |
| --- | --- |
| `gotavern-send-request-reached-peer` | a chat-completions request carrying the GoTavern turn marker reached the peer |
| `gotavern-send-committed-to-disk` | a chat file under the staged card holds the user turn **followed by** the reply text that request produced |
| `pinned-send-request-reached-peer` | the pinned send's request reached the peer |
| `pinned-send-reply-committed-in-page` | the page's own `chat` model holds the send's reply as the last message AND `is_send_press === false` AND no streaming processor |
| `pinned-send-reply-persisted` | the chat file holds the send's user turn followed by an assistant turn with the send's reply |
| `pinned-continue-allowed-by-frontend-guard` | `is_send_press === false`, no streaming processor, no message being edited (the inputs `script.js:11648-11661` reads) |
| `continue-request-reached-provider` | a NEW peer request after the press |
| `continue-completed-in-page` | the page is idle again AND the continuation moved the chat (last text grew or a message was added) |
| `continue-answer-persisted` | the chat file holds the continue's answer |

Three structural changes make the old failure impossible rather than less likely:

1. **Phase-tagged replies.** The two legs' peers answer `Q21_GOTAVERN_REPLY_n` and
   `Q21_PINNED_REPLY_n`. A reply string from one runtime can no longer satisfy a wait in the other.
   (Two peers answering the same string is a fixture that cannot distinguish "this leg's reply" from
   "the other runtime's reply" — the same class AGENTS.md rule 15/50 names.)
2. **Positional persistence.** "The reply is in the file" is now "the assistant turn AFTER the send's
   user turn carries this reply", so a stale message with the same text is not evidence.
3. **Press acceptance is read synchronously.** Pinned's `#option_continue` handler sets
   `is_send_press = true` *before* it calls `Generate`, so reading the flag in the same task as the
   click is a real observation. A refused press now throws `continue-press-not-accepted` with the
   pre-click state (including `swipeState` and `thisEditMesId`) — the exact outcome the old probe
   reported as `continueRequests: 0`.

**No timeout was widened.** The new bounds are 60 s per condition (the old polls used 60 s too), and
the probe throws as soon as a condition's premise is falsified (a refused press throws immediately
instead of spending 60 s polling for an answer that can never be persisted). The workflow's
`PINNED_READY_MS=300000` was already a measured cold-boot bound and is unchanged.

**The underlying upstream reality stays named.** The pressed control is still gated by pinned's own
`is_send_press` flag, and the probe cannot make the frontend accept a press it refuses. What the probe
now does is guarantee the press is made only when that gate is open, and name the gate as the failed
condition if it is not. This is the one condition that remains a property of the pinned frontend
rather than of GoTavern, and it is now a *precondition check with a named failure*, not a flake.

**Probe hygiene: no probe may open a desktop browser.** Measured on the operator's desktop 2026-10-31:
both of this probe's GoTavern boot sites (`gotavernWrites`, `bootGotavernOver`) started the server
without `--browserLaunchEnabled false`, and the seeded config is the pinned default with
`browserLaunch.enabled: true` (`upstream/default/config.yaml`; GoTavern gates the launch in
`cmd/gotavern/browser.go`), so every local hand-back iteration opened the user's **default browser**.
Both boots now pass the flag and both Playwright launches are explicitly `{ headless: true }`
(commit 5501298). The same omission existed in thirteen other boot sites and seventeen other launches
in `tests/browser/`; those are swept in commit 441f0f4. A source gate,
`tests/browser/browser-launch-gate.mjs`, now fails if any `tests/browser/**/*.mjs` GoTavern/pinned
spawn omits the flag or any Playwright launch omits explicit `headless: true`. It runs in the
`differential` job (no mode gate) and in `handback-stability` before its campaign, and its counts are:
**20 server spawns checked, 13 violations before / 0 after; 22 Playwright launches checked, 17 without
explicit headless before / 0 after.**

## 6. What the judge now guarantees

* Every leg still reports `steps`; `tests/oracle/q21/judge-handback.mjs` still refuses `match` on an
  empty report, a missing required row, or an all-zero count (its own selftest mutates exactly those
  cases and requires each to go red).
* `report.conditions` is an independent list of every wait performed, with `ok`, `waitedFor`,
  `elapsedMs` and `observed`. The in-file judge adds `failedConditions` (name + condition + observed)
  to its verdict, and the workflow's **"Judge the hand-back"** step prints
  `CONDITION FAILED <name> -- waited for <condition>; observed <state>` for each failed wait before it
  reads `report.failure`.
* The failure shapes that used to collapse into "count continueRequests was 0" are now distinct:
  - `continue-press-not-accepted` — the frontend refused the press (probe drove a state a user cannot
    reach, or the page was not idle as required);
  - `continue-request-reached-provider` — the press was accepted but nothing left the page (the
    harness-faithfulness alarm the differential doctrine names);
  - `continue-completed-in-page` / `continue-answer-persisted` — the request happened but the page or
    the file did not commit it;
  - a genuine `match` / `mismatch` between the runtimes, unchanged.

**No assertion was weakened.** The final `pinnedContinued` row additionally requires the page to have
settled the continuation (`continue-completed-in-page`), which the old row never checked; the
existing marker and persistence assertions are unchanged; `judge-handback.mjs` is untouched.

## 7. Repeated-stability mode (the evidence path)

Workflow: **Browser differential** (`.github/workflows/browser-differential.yml`), new dispatch input:

```
stability_runs   string, default '0'   # 0 = normal differential; 1..40 = repeat ONLY the hand-back leg N times
```

When `stability_runs` is non-zero, the `differential` job is **skipped** and the new
`handback-stability` job runs. It repeats, on the same commit, the same pinned checkout, the same
built binary and the same `tests/browser/fixtures/real/card-a.png` fixture:

```
governed tree (fresh per iteration)
  node tests/browser/q21-data-handback.mjs --data-root <tree> --report <iter>/q21-gotavern.json
  node tests/browser/run-against-pinned.mjs q21-data-handback.mjs -- --data-root <tree> --report <iter>/q21-pinned.json
  node tests/oracle/q21/judge-handback.mjs <gotavern> <pinned> --out <iter>/q21-verdict.json
```

and writes, per iteration, `iteration`, `verdict`, `seconds`, the leg exit codes, `failedRows` and
`failedCondition` to `results.jsonl`; the summary step writes `stability-summary.json` (with `scope`,
commit, pinned baseline, fixture sha256, `requested/executed/passed/failed`, `verdict: stable|unstable`
and the iteration array), prints a per-iteration markdown table into the job summary, and **fails the
run when any iteration is not `match`**. The evidence is uploaded as artifact
`q21-handback-stability-<run_id>`.

It is deliberately narrow: the summary's `scope` field says it is the hand-back leg only and NOT the
scheduled full sweep (AGENTS.md differential doctrine 8 — narrowing reduces cost, never strength).

### Local per-iteration evidence (this lane)

### CI repeated-stability evidence (the gate)

Run **41201570520** — workflow **Browser differential**, event `workflow_dispatch`, ref `beta/browser`,
head **5501298**, inputs `mode=preset, stability_runs=20`. Conclusion: **success**. The `differential`
job was skipped, as designed; `handback-stability` ran **20 fresh iterations** on one commit, one pinned
checkout (`06bde939fb1e9c4c8d8641d810f0a916b5bce127`), one built binary and one fixture
(`tests/browser/fixtures/real/card-a.png`, sha256
`37e8693c0ea1dfedf3237a6f02347b3ec0e95674ef1179ce79801050d0c9c5d4`).

| iteration | verdict | seconds | continueRequests | pinned rows | GoTavern rows |
| --- | --- | --- | --- | --- | --- |
| 1 | match | 65 | 1 | 17/17 | 6/6 |
| 2 | match | 65 | 1 | 17/17 | 6/6 |
| 3 | match | 64 | 1 | 17/17 | 6/6 |
| 4 | match | 65 | 1 | 17/17 | 6/6 |
| 5 | match | 65 | 1 | 17/17 | 6/6 |
| 6 | match | 64 | 1 | 17/17 | 6/6 |
| 7 | match | 65 | 1 | 17/17 | 6/6 |
| 8 | match | 64 | 1 | 17/17 | 6/6 |
| 9 | match | 65 | 1 | 17/17 | 6/6 |
| 10 | match | 64 | 1 | 17/17 | 6/6 |
| 11 | match | 65 | 1 | 17/17 | 6/6 |
| 12 | match | 64 | 1 | 17/17 | 6/6 |
| 13 | match | 64 | 1 | 17/17 | 6/6 |
| 14 | match | 65 | 1 | 17/17 | 6/6 |
| 15 | match | 65 | 1 | 17/17 | 6/6 |
| 16 | match | 64 | 1 | 17/17 | 6/6 |
| 17 | match | 64 | 1 | 17/17 | 6/6 |
| 18 | match | 63 | 1 | 17/17 | 6/6 |
| 19 | match | 64 | 1 | 17/17 | 6/6 |
| 20 | match | 63 | 1 | 17/17 | 6/6 |

Machine-readable summary: `stability-summary.json` → `verdict: "stable"`,
`requested: 20, executed: 20, passed: 20, failed: 0`; every iteration's `failedRows` and
`failedCondition` are `null`. Every iteration reached `continueRequests: 1`, answer
`Q21_PINNED_REPLY_2`, `messageCount: 8`, and all **seven named conditions** held (send request observed,
send reply committed in the page, send reply persisted positionally, frontend guard open, continue
request reached the provider, page settled, continue answer persisted). Artifact:
`q21-handback-stability-41201570520` (results.jsonl, stability-summary.json, one pinned report + judge
log per iteration).

**The leg is condition-bound, not sleep-bound.** Across the 20 iterations the slowest condition wait was
**2.5 s** (`pinned-send-request-reached-peer`, median 1.75 s); `pinned-send-reply-committed-in-page`
median 256 ms; every other wait was ≤ 12 ms (the continue request was observed at the peer in 2–3 ms).
No wait approached its 60 s deadline, so the green is not a widened timeout: the condition follows the
page, and the page is fast.

**Evidence applies to the shipped hand-back code.** The hand-back probe is byte-identical between the
run's head (5501298) and the lane tip — git blob
`2ca705561899a0893a4003641008f0a6f21a14da` for `tests/browser/q21-data-handback.mjs` in both. The only
later workflow change is the added launch-gate step, which does not touch the campaign.

### Local Windows evidence (Layer A, not the gate)

The same leg runs on this host (`node tests/browser/q21-data-handback.mjs` + `run-against-pinned.mjs`
+ `judge-handback.mjs`, one fresh tree per iteration). The final logic produced green hand-back passes
here (one full pass in ~8.5 min under heavy contention from other lanes' browser probes on this
machine). Two earlier local runs were useful failures and are the reason two additional fix points are
in the code:

* `continue-answer-persisted` was written as whole-message equality, but pinned **appends the
  continuation in place** (`public/script.js:6719-6737`), so the file holds
  `"Q21_PINNED_REPLY_1 Q21_PINNED_REPLY_2"` in one entry. The phase/ordinal-tagged answer makes
  `.includes()` unambiguous; the assertion now matches the behaviour the row exists to prove.
* Hash-tree snapshots taken immediately after the save condition could catch GoTavern's own atomic
  content-log temp file (`default-user/.gotavern-content-log-<hash>.tmp`) before it was renamed, which
  made `noDataLossOnHandBack` report a removal of the product's own temp file. The snapshot now waits
  for **filesystem quiescence** (two byte-identical whole-tree scans, bounded), the expected tree is
  taken from that settled snapshot, and runtime-state paths are classified on the REMOVED side too
  (any removal outside that class still fails the row).

Local iterations are listed as Layer A because the AGENTS.md working mode is explicit: a Linux CI run
is the gate, and the stability run above is that gate.

### CI dispatch (exact command for the Lead at the candidate SHA)

The workflow must be dispatchable from the ref that contains the commit. At the candidate SHA on the
merged branch (`main` after the merge, or the lane branch before it):

```bash
gh workflow run browser-differential.yml \
  --repo cocokoishi/GoTavern \
  --ref main \
  -f mode=preset \
  -f stability_runs=20
# then, with the run id it returns:
gh run watch <run-id> --repo cocokoishi/GoTavern
gh run view <run-id> --repo cocokoishi/GoTavern --log | grep -E 'iteration [0-9]+/|RESULT|hand-back'
```

`mode` is a required input of the workflow; it is ignored by the stability job because the
`differential` job is skipped. The run's `head_sha` is the tip of `--ref`, so dispatch **after** the
candidate commit is the tip (or pass `--ref beta/browser` before the merge). The per-iteration record
is the artifact `q21-handback-stability-<run_id>` and the run summary table.

**Measured, not proposed:** this exact command was run from the lane branch and produced run
**41201570520** (`success`, 20/20 iterations `match`):

```bash
gh workflow run browser-differential.yml --repo cocokoishi/GoTavern \
  --ref beta/browser -f mode=preset -f stability_runs=20
```

## 8. Residual risk

* **Local Windows runs are Layer A evidence**, per AGENTS.md "Working mode": the Linux CI run is the
  gate. The 20-iteration campaign above is that gate; the local section is the same leg on this host
  and is labelled as such.
* **The pinned frontend's `is_send_press` gate is the one remaining upstream property.** If a future
  pinned version changed the continue control's gate, `pinned-continue-allowed-by-frontend-guard`
  would report what it observed rather than silently pressing or failing with an unrelated count.
* **The stability mode repeats one leg; it does not re-run the other 16 rows of the pinned leg.**
  It proves the hand-back leg's own determinism, not the whole differential (the scheduled `all` sweep
  remains the surface for that).
* **The reply-tag change makes the handed-over tree deterministic** (the GoTavern reply is always
  persisted before the hand-over). That is a strengthening of the fixture; it does not change any
  compared provider request or any committed artefact.
* A generation that completes between two 250 ms polls cannot be missed by the new waits: acceptance
  is read synchronously after the click, and the provider request is observed independently at the
  peer. What cannot be observed is a request that never leaves the page — and that now fails with
  `continue-request-reached-provider`, which is the correct finding to raise for it.

## 9. Reproducing the red, and what was not run

The red state is discriminated by the two CI reports quoted in §1: run **41171855911**'s pinned report
(artifact `browser-differential-41171855911`, `legs/q21-pinned.json`) has `pinnedWrote` green with
`fileMessages: 5` and `pinnedContinued` red with `continueRequests: 0, lengthGrew: true,
lastMessageGrew: false`; run **41179659240**'s green report has the same `pinnedWrote` shape and
`pinnedContinued` with `startedAt: 5, lastMessageGrew: true, continueRequests: 1`. The two reports differ
only in the page state at the press, which is the root cause (§3), and both are on the same commit.

The judge's non-vacuity is proven separately, on a live green report pair from this lane:
`node tests/oracle/q21/judge-handback.mjs --selftest <q21-gotavern.json> <q21-pinned.json>` reports
**7/7 cases behaved as required**, including "a zero `continueRequests` count goes red even with every
row green", "ZERO steps with no failure goes red", "a missing `pinnedContinued` row is `unreached`",
"absent counts go red rather than being assumed non-zero" and "a red row goes red even when the leg's own
judge says `match`".

**Not run in this session, stated rather than implied:** a forced negative control of the NEW named
conditions (deliberately pressing CONTINUE on a busy page, or dropping the continue request in the page)
was not executed. Each condition's observation is recorded on every run (`report.conditions`), and the
failure *shapes* they name are listed in §6, but only the judge's own zero-count/missing-row/empty-report
reds have been observed going red. A future lane that wants that extra proof can run the mutation the
§3 analysis implies (remove the pre-press page-commit wait and the persistence condition: the press will
be refused and the leg will fail with `continue-press-not-accepted` / `continue-request-reached-provider`
rather than an unexplained count).

## 10. Lane record

| commit | content |
| --- | --- |
| `6a67442` | probe: named condition waits, phase-tagged replies, positional persistence, synchronous press acceptance, filesystem quiescence |
| `747fd9d` | workflow: `stability_runs` input + `handback-stability` job (per-iteration verdicts, machine-readable summary, artifact, fail-on-any-red) + judge step prints failed conditions |
| `5501298` | safety: both GoTavern boots in the Q21 probe pass `--browserLaunchEnabled false`; both Playwright launches explicit `headless: true` (the window the operator saw) |
| `441f0f4` | safety sweep: 13 more server spawns and 17 more launches in `tests/browser/`; new `tests/browser/browser-launch-gate.mjs` enforcing both rules in CI |

Evidence: run **41201570520** (`Browser differential`, ref `beta/browser`, head `5501298`,
`mode=preset`, `stability_runs=20`) — 20/20 `match`, `stable`, artifact
`q21-handback-stability-41201570520`. The Q21 probe blob at 5501298 equals the lane tip's
(`2ca705561899a0893a4003641008f0a6f21a14da`), so the campaign measures the shipped hand-back code.
The retired disposition: this flake is **not** an "occasionally red" pinned-frontend persistence
flavour; it was a harness reply-text collision that let a CONTINUE press land on a busy page.
