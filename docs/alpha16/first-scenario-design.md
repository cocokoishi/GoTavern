# The first E03+E04 combined scenario (M0 design)

**Status: design only, not implemented.** This is the M0 exit artefact the plan's *Immediate first task*
asks for: the first combined browser scenario in which a complex preset, the real pinned 酒馆助手 /
JS-Slash-Runner, Quick Replies/STscript, regex scripts, nested world books and the 20 locked third-party
extensions all change **one** recorded provider request, driven through the unmodified pinned frontend.

It is written against the harness that exists (`tests/browser/combination-journey-probe.mjs`, 1,665 lines,
and `tests/browser/third-party-extensions-run.mjs`, 591 lines). It does not propose a third fixture/framework;
every new file below is a kit or an extracted helper beside the existing drivers.

## 1. The scenario in one paragraph

One browser session, one staged tree, both subjects (pinned Node, GoTavern). A card whose V3 payload embeds a
character book and a character-scoped regex; **three world books** (the journey's 3-slot global book, the
card-embedded book, and a second global book carrying recursive/secondary-key entries) selected through the
frontend's own selection path; a **120-block complex preset** (Prompt Manager order + enabled flags, role
boundaries, custom samplers, reasoning/tool options, stop strings) selected through the frontend's preset
control; the real pinned Tavern Helper iframe writing/reading variables **in the same turn** as a Quick Reply
created through the extension's own API, so the QR's STscript writes the variable the helper then reads, and a
global regex plus the card-scoped regex rewrite a later utterance; **all 20 locked third-party extensions
installed and active**; one streamed generation. The recorded chat-completion body must contain every marker
in the expected **order**, and turning any one knob off must remove exactly its markers. Restart and
Node→Go→Node hand-back then run on the same tree.

## 2. Why E03 and E04 must be one scenario

E03 is a prompt-laboratory environment (deep prompt order, recursion, token boundaries); E04 is an
extension-collision environment (all 20 extensions coexisting; helper + QR + regex + variables + group state).
Combining them is not a cost trick: it is the only way to observe that an extension's own state change
reaches the *same* provider request the preset and world books built. Two separate probes can each be green
while the combination is wrong, and `GOAL.md` §9 forbids inferring the combination from the parts.

## 3. Reuse map (what already exists, what is added)

| existing file | what it already gives | what this scenario adds |
|---|---|---|
| `tests/browser/combination-journey-probe.mjs` | the drive: character open, preset select, 3-slot world book, helper variables, QR create+execute, character regex, streamed turn, history turn, swipe/regenerate/continue/branch, knob-off control turns, save+reload, group turn, `--after-restart`, `--handback`; each step recorded via `step()` | a `--profile e03e04` mode: install all 20 extensions before the first turn, stage the 120-block preset + nested books, and record *ordered* marker arrays |
| `tests/browser/extensions/combination-journey-kit.mjs` | stages the journey card (embedded regex + V3 payload), the 3-slot world book, groups, the persisted world selection; exports the marker constants | a second/third book with recursion/secondary keys, an embedded `character_book` in the card, and a **single ordered marker manifest** (`expectedOrder`) shared by probe and comparator |
| `tests/browser/install-pinned-extension.mjs` (`ensurePinnedExtensionInstalled`, `userExtensionsDirectory`, `installedRevision`) | installs a pinned extension at its frozen commit, proves the revision, refuses an auto-update | install **all 20** from `tests/browser/third-party-extensions.lock.json` through one extracted helper |
| `tests/browser/third-party-extensions-run.mjs` (`installIntoRoot`, `runGenerationLeg`, `bundleFailure`) | the 20-extension install + activate + own-setting + restart + uninstall lifecycle, sharded in CI | extract only the install/activate part into `tests/browser/extensions/extension-install-batch.mjs` and call it from both drivers (no second install implementation) |
| `tests/browser/compare-combination-journey.mjs` | compares subjects on steps, requests, browser state, disk state; fails a non-discriminating pair | ordered-marker comparison, per-extension "own effect reached the wire" assertions, and embedded identity (head SHA, pinned SHA, profile, tier) |
| `tests/browser/combination-journey-gate-selftest.mjs` | proves the comparator can fail (planted differences) | negative controls specific to this scenario (§6) |
| `.github/workflows/combination-journey.yml` | dispatch + path-push trigger, both legs, comparator, artifact | `profile` and `tier` inputs; fast/medium/full tiers; artifact `combination-journey-evidence` with the embedded identity fields |
| `tests/browser/fixtures/real/preset-a.json` (105 prompts, 71 KB) and `preset-b.json` (1.36 MB) | the committed complex preset derivations already used by the real-preset lanes | the **stress profile** is generated deterministically from a small manifest (120 blocks) so 120 prompt texts do not become 1 MB of committed fixture prose |

## 4. What is new, and nothing else

1. `tests/browser/extensions/e03e04-profile-kit.mjs` — deterministic generator:
   - `buildPreset(seed, blockCount)` → a preset document with `prompts` ordered by `prompt_order`,
     alternating enabled/disabled flags, several role boundaries, distinct sampler and reasoning/tool members,
     stop strings, and one `MARKER_Pxxxx` per block so a block's presence is attributable;
   - `buildBooks(seed)` → three books: the existing 3-slot book (positions before/after, depth), a
     card-embedded `character_book` with entry recursion and secondary keys, and a global book with a
     recursive secondary-key chain; each entry carries a `MARKER_Wxxxx` and an order token;
   - `expectedOrder` → the one list the probe asserts and the comparator compares.
   All content synthetic and SFW; no user prose; the generator is deterministic and its manifest records the
   seed and the sha256 of every generated document.
2. `tests/browser/extensions/extension-install-batch.mjs` — the extracted install/activate helper.
3. `combination-journey-probe.mjs` — `--profile e03e04` and the assertions in §5. No new driver.
4. `compare-combination-journey.mjs` — §5/§6 assertions. No new comparator.
5. `combination-journey-gate-selftest.mjs` — §6 controls.
6. `combination-journey.yml` — tiers and artifact identity.

## 5. The provider-request contract

For the streamed turn, on both subjects, the recorded chat-completion body must satisfy, **in order**:

1. `messages` carries the card's system/personality/scenario fields in the pinned positions;
2. the Author's Note marker sits at its configured depth;
3. book entries appear in their position class (before-character, after-character, in-chat depth), and the
   entries of *each* book are present (global 3-slot, card-embedded, recursive global);
4. the 120 preset blocks that are enabled are present in Prompt Manager order, and the disabled ones are
   **absent** (this is the control that keeps "120 blocks" from being a parse test);
5. the Quick Reply's STscript-written value is visible to the helper variable injection in the same request
   (the helper reads the variable the QR wrote), with both markers adjacent in the documented order;
6. the character-scoped regex's rewrite of the earlier utterance is in the history message, and the raw
   pre-rewrite text is **not**;
7. at least one marker written by each of the 20 extensions' own settings *where that extension has a
   provider-visible effect* is present, and the per-extension record names the extension that fired
   (extensions with no provider-visible effect are recorded as `no-wire-effect` with their evidence, not
   silently skipped);
8. the whole set appears on pinned Node and on GoTavern with the same byte body, same message roles, same
   order, same stops/samplers/reasoning/tool members.

The comparison is byte-oriented on the provider body (`bodySha256`, `bodyLength`, raw target, recorded
headers) exactly as `GOAL.md` §10 requires; the ordered-marker list is an *additional* locator so a difference
names the source, not merely "bodies differ".

## 6. Negative controls (each must fail a NAMED assertion)

| planted defect | assertion that must go red |
|---|---|
| swap two world-book entry positions in the generated books | ordered marker list: `worldbook-order` |
| disable one preset block that the fixture enabled | `preset-block-present-MARKER_Pxxxx` |
| drop the QR-written variable before the helper reads it | `qr-to-helper-chain` |
| turn the helper off | `helper-iframe` / `helper-variable-marker` (the existing knob-off control) |
| remove one extension's own effect | `extension-effect-<name>` |
| duplicate one user message in the persisted chat | `ordered-message-ids` |
| omit the card-embedded book | `card-character-book-marker` |
| record an artifact with a wrong head SHA | artifact verifier (fail-closed) |
| make both subjects produce identical captures with every knob off | `HARNESS NON-DISCRIMINATING` (rule 50) |

`combination-journey-gate-selftest.mjs` gets one planted case per row and must observe the named assertion go
red before the scenario is wired into CI.

## 7. Tiers and cost

| tier | blocks | extensions | books | where |
|---|---|---|---|---|
| fast (per push on harness paths) | 12 | 3 (helper + 2 no-wire-effect) | 1 | branch CI, minutes |
| medium (dispatch) | 60 | 10 | 2 | dispatch |
| full (scheduled / release) | 120 | 20 | 3 | scheduled + alpha.16 release gate |

The full tier is the only one whose green covers the whole design; a narrowed run states its tier in the
artifact and never supports a full-coverage claim.

## 8. What this scenario does NOT claim

- Not a real provider: the peer answers by marker (`AGENTS.md` rule 22; `GOAL.md` §8.1).
- Not a real user's card/preset prose: committed derivations and synthetic generators only (rule 56).
- Not multi-user (E06 covers that separately).
- Not the group turn's multi-member fan-out: recorded as whatever the product made, not asserted.
- Extension effects that live purely in the frontend are recorded as `no-wire-effect`; the scenario does not
  invent a provider marker for them.

## 9. Prerequisites this design owes to other M0 findings

1. **Page-init egress seam.** The hermeticity decision is OPEN at the baseline: some probes stage
   `main_api: openai` to remove the Horde model-list fetch, and the HANDOFF checkpoint records that every
   browser probe's page init reached the live network. This scenario may not run at the full tier until the
   egress path is either staged away or recorded as an explicit allowlist with a validated local seam
   (plan §5).
2. **Bounded settle for the conversation-editing race.** The drive must wait on
   `chat_id_changed` + `uniqueMesids === chat.length` before the first send and compare an ordered
   `domMessageIds` list rather than a raw count (HANDOFF checkpoint), or the duplicate-node race will be
   attributed to the product again.
3. **Artifact identity.** The comparator's artifact must embed `kind`, `schemaVersion`, `headSha`,
   `pinnedSha`, `seed`, `tier`, `profile`, the fixture digests and the run/workflow identity; the committed
   browser comparison artifacts at the baseline carry only `schemaVersion`/`mode` and would be refused by the
   fail-closed verifier the plan requires.
