# alpha.20 README restructure and figure record (M7 evidence)

Status: **IMPLEMENTED, gate green.** This file records the before/after measurements, what moved where, and the
checks that keep the README and the figure from drifting. The executable contract is
`tools/check-perf-docs.mjs` (data/README/figure/provenance) plus `tools/check-figure-a11y.mjs` (headless layout).

## 1. Before/after, measured on the committed bytes

The gate's own boundary defines the **first screen**: everything above the `## Release status` heading
(`tools/check-perf-docs.mjs`, "README: the FIRST SCREEN, checked structurally"). The counts are characters of
that region with newlines normalised to LF, and bytes of the whole file.

| surface | alpha.19 (`7d1178e`) | alpha.20 | delta |
|---|---:|---:|---:|
| first-screen characters | 11,170 | **3,714** | **−66.8%** |
| first-screen bytes | 11,208 | 3,746 | −66.6% |
| whole README bytes | 13,993 | 13,966 | −0.2% |
| whole README lines / non-blank | 148 / 100 | 151 / 106 | within the gate's 100-160 / 100-150 |

The contract was a **≥40% reduction**; the delivered cut is 66.8%. The whole file stayed inside the
10,000-14,000 B budget because the detail moved to docs/ rather than being deleted: the release history,
performance table, install manual, per-area ledgers and documentation index now live below the boundary, where
a reader who scrolls gets them.

## 2. What the first screen now contains

1. name + one-line positioning (what it is: the SillyTavern 1.19.0 server in Go, one prebuilt binary, no Node
   on the host, unmodified frontend, same `data/` layout);
2. **one** figure — the `<picture>` pair, dark by `prefers-color-scheme`, with an alt text whose numbers are
   recomputed from the artifact;
3. three key features (light/fast with the mechanism cited; your existing tree unchanged; upstream-oracle
   evidence);
4. the 30-second install for Linux/macOS and Windows (both installers, prebuilt archive, no toolchain);
5. a compact compatibility + limits table (7 rows) with the honesty sentence the gate requires: GOAL.md §14
   **NOT MET**, the evidence is **synthetic**, `PRIVATE_NOT_RUN`;
6. links to the detail (performance, compatibility, install, scorecard, matrix, installation).

**No CI/SHA/gate jargon on the first screen**: no badge, no release tag, no commit id, no workflow or fixture
language. The gate enforces the release-tag half (`README-FIRST-SCREEN-VERSION`) and the badges sit below the
boundary, next to the release history.

## 3. The gate change that keeps it short (and its teeth)

`tools/check-perf-docs.mjs` gains `README-FIRST-SCREEN-BUDGET`:

- `FIRST_SCREEN_BUDGET = { alpha19Characters: 11170, maxCharacters: 6702 }` — the ceiling is 60% of the
  **recorded** alpha.19 first screen, so the ≥40% reduction is a property of the committed bytes, not a claim in
  this document;
- a README whose first screen is over the ceiling fails by name with the measured count and the boundary line;
- the negative control in `tests/docs/check-perf-docs.test.mjs` inserts filler **above** the boundary (the
  whole-file budget still passes) and asserts `README-FIRST-SCREEN-BUDGET`; the untampered tree is the positive
  control. All 16 negative controls pass.

`RELEASE_VERSION` moves to the published `v0.1.0-alpha.19`; the README release-status sentence now names the
release this tree actually ships (it said alpha.18 while alpha.19 was published). Historical release records and
`GOAL.md` §14 were not touched.

## 4. The figure (one image, two variants, rebuilt)

The figure stays generated from the single recorded artifact `tests/perf/q22-baseline.json` (run
`42012475880` at `f1396ce`) — no number is typed into the generator or the SVG. What alpha.20 changed:

- **type scale raised one step**: row labels 20 px, values 18 px, notes 14 px, minimum 13 px (alpha.19's floor
  was 12 px); the footer is shorter so 13 px lines fit without clipping;
- **colour-blind-safe subject pair**: blue vs orange (safe for deuteranopia/protanopia and separable in
  greyscale) plus unchanged direct `NODE`/`GO` labels and printed values, so colour is never the only encoding;
- layout, axes, units, per-metric verdict words, zero-based per-row axes and the `COMPUTED` ratio marking are
  unchanged; the canvas stays 1200x675 (GOAL.md §15.6) and both variants still come from one generator run;
- provenance updated with the new palette and floor, and with the **honest mobile limit**: a 1200 px figure on
  a 360 px page scales to ~30%, so body text needs the image opened/zoomed; the alt text and the Performance
  table carry the same four numbers as text.

## 5. Checks (headless only; no desktop browser)

`tools/check-figure-a11y.mjs` renders both committed variants in headless Chrome/Edge and writes
[`figure-checks.json`](figure-checks.json) (36 checks on the last run, all pass):

| assertion | what it proves |
|---|---|
| FIGURE-XML-SYNTAX | both variants parse as XML (not tag soup) |
| FIGURE-TEXT-CONTAINED | every `<text>` bbox is inside the 1200x675 viewBox at 1200/720/360 CSS px |
| FIGURE-NO-OVERFLOW | the rendered drawing never overflows its container at those widths |
| FIGURE-TYPE-FLOOR | every declared size is >= 13 px at 1:1 |
| FIGURE-MOBILE-HERO | at 720 px the hero numbers render at >= 18 px |
| FIGURE-DESC-VALUES / FIGURE-PAIR-DESC | both `<desc>` elements restate all 12 recomputed values and agree |
| README-PICTURE-BLOCK | exactly one `<picture>`/`<source>`/`<img>`, dark selected by `prefers-color-scheme`, both variants referenced, `width="1200"` |
| README-ALT-VALUES | the alt text carries the recomputed values |
| README-MARKDOWN-SAFE | the wrapper uses only picture/source/img (no script/style/iframe/foreignObject) |

The data half stays in `tools/check-perf-docs.mjs` and runs in CI: figure bytes regenerated twice and compared,
canvas/role/title/desc, unit rule, verdict words, computed ratios, contrast computed from the committed palette
(text 4.5:1, bars 3:1), and README/table/alt/provenance agreement with the artifact.

## 6. What was NOT done, and why

- **No new number was invented for the figure.** The recorded artifact predates alpha.20, so the figure still
  cites run `42012475880` at `f1396ce`; replacing it is the same-commit `GoTavern smoke metrics` step of the
  release (one commit regenerates artifact, table, SVG pair and provenance). This document does not claim the
  figure shows alpha.20's numbers.
- **No truncated axis, no ratio-only row, no external font/image/script** — the alpha.19 design promises are
  preserved and are gated.
- **Mobile legibility is bounded and stated, not promised**: containment and the at-a-glance hero size are
  checked at 720 px; at 360 px the image is an illustration with a text alternative, which is recorded in the
  provenance rather than dressed up as a phone-readable chart.
