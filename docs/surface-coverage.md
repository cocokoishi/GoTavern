# Five-surface coverage

`AGENTS.md` requires five observer surfaces to be equivalent before an area can be called
`compatible`:

1. **B**rowser -> **S**erver HTTP
2. **S**erver -> **P**rovider wire
3. **F**ilesystem / startup side effects
4. **E**vents / final browser state
5. **C**ancel / streaming

This file exists because "partial" hid which surface was missing. A row can now be read as
"B ✓, P ✓, F ✗, E ✗, C ✗" instead of a word. It is the working list for promoting areas, not a
claim about them: an empty cell means NO EVIDENCE, which is different from "not applicable" and
has to be argued per area.

## How to read a cell

- ✓ — a committed artifact in this repository proves it, named in the Evidence column.
- — (empty) — no evidence recorded. Treat as unproven even if the behaviour looks right.
- n/a — the surface genuinely does not apply to that area, and the reason is stated.

## Current state

| Area | B | P | F | E | C | Status | Evidence |
|---|---|---|---|---|---|---|---|
| Chat-completions generation, custom/OpenAI-compatible source | ✓ | ✓ | ✓ | ✓ | ✓ | **compatible** | `tests/oracle/sillytavern-1.19.0-backends.json`; `tests/browser/generation-comparison.json`; `tests/browser/streaming-comparison.json` |
| Chat-completions generation, every other source | ✓ | ✓ | ✓ |  |  | partial | provider-wire only; no browser-driven capture for these sources |
| Tokenizers (encode/decode/count/openai) | ✓ | n/a |  |  | n/a | partial | `tests/oracle/sillytavern-1.19.0-tokenizers.json`. F is empty **and it matters**: a browser capture once measured the FALLBACK path because `tokenizers/` was missing beside the binary, which is now a hard failure in `assets verify` |
| Secrets (all 8 routes) | ✓ | n/a | ✓ |  | n/a | partial | `tests/oracle/sillytavern-1.19.0-secrets.json` |
| Assets / backups / sprites (user data) | ✓ | n/a | ✓ |  | n/a | partial | `tests/oracle/sillytavern-1.19.0-{assets,backups,sprites}.json` |
| SD non-generate routes | ✓ | ✓ | ✓ |  | n/a | partial | `tests/oracle/sillytavern-1.19.0-sd-{routes,workflows}.json` |
| SD generate (8 sources) | ✓ | ✓ | ✓ |  |  | partial | `tests/oracle/sillytavern-1.19.0-sd-generate.json` |
| Horde domain | ✓ | ✓ |  |  |  | partial | `tests/oracle/sillytavern-1.19.0-horde.json` |
| Speech / images | ✓ | ✓ | ✓ |  | n/a | partial | `tests/oracle/sillytavern-1.19.0-{speech,images}.json` |
| Content import (importURL/importUUID) | ✓ | ✓ | ✓ |  | n/a | partial | `tests/oracle/sillytavern-1.19.0-content{,-uuid}.json` |
| Providers / tokenization / streaming at the SERVER level | ✓ | ✓ | ✓ |  | ✓ | partial | `tests/oracle/sillytavern-1.19.0-provider-wire.json` (stream + abort scenarios) |

## What promotion actually requires

The chat-completions row became `compatible` only after the fifth surface was MEASURED, and that
measurement overturned three earlier conclusions:

- the probe buffered every streamed response with an unconditional `clone().text()`, so every
  capture in that directory was the streamed path mislabelled as non-streaming. A **non-stream
  control** (different body length and SHA) is now required before any streaming claim;
- aborting "after N render snapshots" is a race. Abort on an EXACT rendered prefix, and assert the
  provider observed the disconnect (`clientDisconnected: true` on both legs), not just that the
  browser stopped rendering;
- a sequential mock script starves the real request once an extra call (Connect's `GET /models`)
  is added to the flow. Script per-endpoint, not per-order.

## The cheapest next promotions

Ordered by missing work, not by route count:

1. **Horde F** — the domain writes nothing outside its own state, so F is probably n/a and can be
   argued from source in one paragraph. Cheapest to close.
2. **Chat-completions E/C for the other sources** — the harness now does this for one source; the
   cost is a per-source Connect/settings drive, not new infrastructure.
3. **E for every data domain** — the existing browser startup-call capture already records the
   requests these routes make at boot; turning that into a committed comparison is mostly
   bookkeeping, and it would move several rows at once.
