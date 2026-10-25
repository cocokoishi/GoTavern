# GoTavern — Real SillyTavern Drop-in Parity & Performance

This file is the **locked goal** of the project. It is not a plan and not a roadmap: it is the
statement every lane, subagent, commit, CI gate and report must answer to. The question is always

> Does this work move us closer to the goal in this file?

`AGENTS.md` carries the verification rules. `ARCHITECTURE.md` carries the design contract.
`HANDOFF.md` carries where the work actually stands today. When they disagree with this file about
*what we are trying to achieve*, this file wins.

## 1. The goal

Turn GoTavern from "a Go backend that implements a large number of SillyTavern APIs" into a
production-grade **drop-in replacement that can carry a long-lived SillyTavern user directory**.

A user must be able to keep their existing SillyTavern frontend, `config.yaml`, `data/`, character
cards, avatars, backgrounds, chats, world books, complex presets, Quick Replies, Regex, STscript,
variables, personas, extensions and 酒馆助手 / Tavern Helper / JS-Slash-Runner, and simply swap the
backend.

For every behaviour that pinned SillyTavern supports and that is not an explicit product exclusion,
GoTavern must be equivalent **on the surfaces a user actually observes**.

The goal is met only when all of the following are demonstrated with the shipped artifact:

1. a long-lived, actually-used SillyTavern directory runs directly under GoTavern;
2. no extension is ever updated without explicit user consent;
3. character cards and every core avatar resource display;
4. backgrounds, sprites, persona and user avatars and the other core asset surfaces display;
5. 酒馆助手 really runs — iframe, bridge, events, scripts — rather than merely loading JS;
6. a real complex preset demonstrably changes the model context under different configurations;
7. after 酒馆助手 mutates presets, variables, prompts or generation configuration, the context sent
   to the model equals pinned SillyTavern's;
8. the changes a preset causes — context, message ordering, world info, Author's Note, history
   truncation, injections, samplers, tools, reasoning — all behave identically to pinned;
9. save / reload / swipe / regenerate / continue / restart all preserve that equality;
10. data written by GoTavern can be handed back to original Node SillyTavern and keeps working;
11. only after compatibility holds, a fair paired benchmark proves the CPU/RSS/startup/long-run
    advantage.

## 2. What is forbidden as evidence

The following are **not** evidence that GoTavern is compatible, and a report that rests on them is
rejected:

- "we implement a lot of APIs";
- "route coverage is high";
- "the Go tests are green";
- "the page opens";
- "a chat message can be sent once";
- "the extension's files load";
- "`getPreset()` returns data";
- "CI is green".

The last two exist because both were true while the product was visibly broken. A green gate that
cannot express the user's complaint is decoration (`AGENTS.md` rule 7).

## 3. The one sentence that decides compatibility

> For a given character, chat, world book, preset, helper script, variable state and user input, the
> **final request that reaches the model backend** is equal between pinned Node SillyTavern and
> GoTavern — and so is the persistent and browser state afterwards.

Everything else is instrumentation around that sentence. A preset is not "compatible" because its
JSON loads; it is compatible because the context it produces is the same. An avatar is not
"available" because a file exists on disk; it is available because a browser displays it.

## 4. Primary oracle and its precedence

Pinned baseline: **SillyTavern 1.19.0**, commit `06bde939fb1e9c4c8d8641d810f0a9165bce127`.

Evidence precedence, highest first:

1. an observation of pinned SillyTavern actually running;
2. the pinned source at that commit;
3. a recorded oracle (committed fixture/capture);
4. a source-derived test;
5. developer inference — last, and it must be labelled as inference.

Forbidden as a basis for behaviour: memory of SillyTavern, current upstream `master`, "that is how Go
normally does it", and a mock that defines its own correctness.

## 5. The real inputs are part of the specification

Qualification is not allowed to run only on clean fixtures. The following are inputs, not examples:

- **the long-lived SillyTavern tree** — a realistic user data root: config, users, characters and
  card PNGs, chats, groups, world info, presets of every kind, Quick Replies, Regex, personas and
  persona avatars, user avatars, backgrounds and their metadata, sprites, themes, moving UI,
  extensions including JS-Slash-Runner, extension settings, thumbnails, backups, unknown files, old
  fields and mixed legacy state;
- **the real complex preset(s)** — including at least one carrying
  `extensions.tavern_helper` (scripts + variables) and `extensions.regex_scripts`;
- **the real complex character card(s)**;
- **the pinned JS-Slash-Runner version**.

Real inputs are read-only. They are read, hashed and copied to a temporary tree. A desensitised
fixture must preserve **structure and complexity** — every field, ordering, enabled flag, depth,
role, extension subtree and size class — while replacing prose with markers. Desensitising is not
simplifying: shrinking a 500-field preset to three prompts and calling it equivalent destroys the
only property that made it an oracle.

## 6. P0 ledger

Every P0 keeps a reproducer, a gate that has been shown to fail, and a packaged-artifact check.

| Id | Defect | State |
|---|---|---|
| P0-A | the real provider transport could not reach a real provider (DeepSeek) | fixed, gated |
| P0-B | the release binary hung during initialisation in a working SillyTavern tree | fixed, gated |
| P0-C | extensions/plugins were updated without being asked | fixed, gated |
| P0-D | 酒馆助手 / JS-Slash-Runner does not actually work | **open** |
| P0-E | core visual assets are missing (character avatars, backgrounds, personas, sprites, thumbnails) | **open** |
| P0-F | a real complex preset cannot be shown to change the model context the way pinned does | **open** |

## 7. The user-facing scorecard

These are the questions the project must be able to answer with evidence. Answering them with test
counts is a failure to answer.

| # | Question |
|---|---|
| Q1 | Can a long-lived SillyTavern directory be started directly with GoTavern? |
| Q2 | Did GoTavern touch my extensions? (required answer: no, unless explicitly opted in) |
| Q3 | Are all character-list avatars correct? |
| Q4 | Is the image of an opened complex character card correct? |
| Q5 | Is the character avatar inside a chat correct? |
| Q6 | Are personas correct? |
| Q7 | Do backgrounds display exactly as in the original? |
| Q8 | Does the JS-Slash-Runner iframe really work? |
| Q9 | Do 酒馆助手's generation APIs really work? |
| Q10 | Do 酒馆助手's variables really work? |
| Q11 | Does 酒馆助手 injection really change the model context? |
| Q12 | After 酒馆助手 modifies the `'in_use'` preset, does it affect generation immediately? |
| Q13 | Does switching presets produce genuinely different context at the simulated backend? |
| Q14 | For each preset: is `Node context == Go context`? |
| Q15 | Is a complex character card's semantics inside the context the same? |
| Q16 | Is world-info activation the same? |
| Q17 | Is Author's Note depth the same? |
| Q18 | Is token truncation the same? |
| Q19 | Are streaming and helper events the same? |
| Q20 | Is it still the same after reload, swipe, regenerate, continue? |
| Q21 | Can data written by GoTavern be handed back to Node and keep running? |
| Q22 | Is CPU/RAM actually and measurably lower than Node's? |

## 8. The harness that is required

The goal cannot be reached with the harness that exists. The following are mandatory pieces, not
optional improvements.

1. **A deterministic simulated model backend.** It records every request completely (target,
   headers, raw body bytes and SHA-256, member structure, model, stream, messages/roles/content,
   system instructions, samplers, stops, tools, tool_choice, response format, reasoning,
   provider-specific members) and replies deterministically by marker (e.g. context contains
   `MARKER_A` → `ACK_A`; order `A→B→C` → `ORDER:A>B>C`). It also emits controlled SSE, controlled
   errors, mid-stream closes and delayed responses. The mock only captures and answers: it never
   defines what the correct context is. Correctness comes from the pinned capture.
2. **Preset semantic differential.** `Preset-A`, `-B`, `-C` and the real preset, each run under
   pinned Node and under GoTavern, comparing the final provider request. Two things must hold at
   once: `Node(X) == Go(X)` for every X, **and** `X != Y` within an implementation. If a harness
   produces three identical captures it fails as `HARNESS NON-DISCRIMINATING` rather than passing.
3. **Prompt provenance.** For a large preset, a difference must be locatable: which final message,
   from which source (preset prompt, world info, character field, helper injection), at which depth,
   under which lifecycle event. "bodies differ" is not a report.
4. **Browser asset differential.** Pinned Node and GoTavern loading the *same* frontend, *same*
   driver and *same* fixture, compared on network URL/status/MIME/SHA-256/length, DOM state, image
   `complete` / `naturalWidth` / `naturalHeight`, CSS background, console and screenshot. A core
   asset failing is a red gate.
5. **Browser semantics differential.** The helper's iframe path, generation, streaming, events,
   cancellation and preset mutation driven through a real browser against the unmodified frontend.
6. **Mutation evidence for every gate**, produced by a CI run with `-count=1`, naming the assertion
   that went red and the restored green.

## 9. Combination rules

- Tests that share coverage combine **only** where they have been shown to combine. `preset PASS`
  plus `helper PASS` does **not** imply `preset × helper PASS`; `asset PASS` plus `generation PASS`
  does **not** imply they are fine together. A single data-root or path bug can break an asset, an
  extension and a preset at the same time.
- The highest-priority scenario is the full real combination: `real character × real complex preset
  × 酒馆助手 × world book × existing chat history × preset/chat/character variables × regex × Quick
  Replies × STscript × prompt injection × generation × streaming`.
- A narrowed matrix is a cost control. It never supports a claim of full coverage.

## 10. Comparators

Normalisation is a named, narrow, justified exception, never a global policy. Forbidden: sorting
messages or JSON keys globally, dropping unknown fields, ignoring headers, ignoring body members,
comparing only content, collapsing duplicates, or ignoring prompt order. Anything genuinely
nondeterministic is normalised per JSON path with the reason and its evidence recorded.

## 11. Order of work

```
long-lived tree runs
→ visual assets display
→ 酒馆助手 runs
→ preset semantic differential holds
→ the real combination holds
→ persistence holds
→ Node → Go → Node holds
→ performance
```

Optimising a product that does not work is out of scope. So is claiming a later stage because an
earlier stage's cheap checks are green.

## 12. Definition of done

The core goal of a round is complete only when every line below is true.

```
[ ] the goal above is established and persisted (this file, AGENTS, ARCHITECTURE, HANDOFF)
[ ] the current HEAD has been re-audited from the tree, not from older numbers
[ ] the real long-lived SillyTavern tree has been analysed safely
[ ] the original user directories were not modified
[ ] the real complex preset has been found and characterised
[ ] the real complex character card has been found and characterised
[ ] the actually-installed JS-Slash-Runner version is pinned
[ ] no extension is ever auto-updated
[ ] character avatars pass in a browser
[ ] selected-character image passes in a browser
[ ] persona assets pass in a browser
[ ] backgrounds pass in a browser
[ ] sprites and other core assets pass in a browser
[ ] the no-broken-core-assets gate passes
[ ] the JS-Slash-Runner iframe works
[ ] helper generate works
[ ] helper generateRaw works
[ ] helper lifecycle events match
[ ] helper variables work
[ ] helper injections change the context like pinned
[ ] helper cancellation works
[ ] a deterministic provider simulator exists
[ ] presets A/B/C genuinely produce different context
[ ] Node(A) == Go(A), Node(B) == Go(B), Node(C) == Go(C)
[ ] runtime `in_use` preset semantics match
[ ] helper preset mutation matches
[ ] helper × world info matches
[ ] helper × variables × preset matches
[ ] the real complex preset differential passes
[ ] the real complex character differential passes
[ ] character × preset × helper passes as a combination
[ ] streaming passes
[ ] regenerate / swipe / continue pass
[ ] reload passes
[ ] restart passes
[ ] Node → Go → Node passes
[ ] mutation evidence exists for every new gate
[ ] the release-shaped artifact passes
[ ] the critical `main` Actions runs are green
[ ] remaining gaps are listed explicitly
[ ] the paired performance benchmark is done once compatibility is stable
```

## 13. Non-claims

The following remain outside the product, and saying so is part of the contract: arbitrary Node.js
server plugins (never emulated), in-process ONNX inference, image re-encoding that depends on a
Jimp-compatible codec where byte equality is claimed, and wire formats that live inside third-party
npm packages. A row that is partial says partial with its reason; a row that is not covered says so.
