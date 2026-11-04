# docs/assets/benchmark.svg and benchmark-light.svg — provenance

The figures are **generated**, never hand-drawn. Every number in them is read out of a recorded benchmark artefact;
`tools/benchmark-svg.mjs` contains no measured value and refuses to render if a field it needs is absent. It also
refuses to render without a run id and a measured commit, because a figure that names no run and no tree is a number
with no provenance. Both come from the committed baseline's `provenance` block, so the release path cannot mistype
them, and `tools/check-perf-docs.mjs` regenerates BOTH variants from that baseline and byte-compares each with the
committed SVG in CI.

## Two files, one drawing

| file | canvas | used for |
|---|---|---|
| `docs/assets/benchmark.svg` | 1200 × 675 (16:9) | GitHub dark mode (`#0d1117` canvas) |
| `docs/assets/benchmark-light.svg` | 1200 × 675 (16:9) | GitHub light mode (`#ffffff` canvas) |

The README references them through one `<picture>` element with
`<source media="(prefers-color-scheme: dark)" srcset="docs/assets/benchmark.svg">` and the light file as the
`<img>` fallback, so GitHub selects the variant that matches the reader's colour scheme. One image cannot be
optimal on both canvases: a dark-only figure reads as a foreign panel in light mode, and a light-only figure either
glares in dark mode or has to abandon its accent colour to keep contrast. Both variants share the layout and every
printed number, so a reader switching themes sees the same drawing.

## The artefact it is drawn from

The recorded artefact is committed as `tests/perf/q22-baseline.json` (the wrapper embeds the downloaded q22 artefact
verbatim; `docs/perf-baseline.md` §8 is the one-commit update procedure). The figures are regenerated from it with:

```
node tools/benchmark-svg.mjs --report tests/perf/q22-baseline.json \
    --out docs/assets/benchmark.svg --out-light docs/assets/benchmark-light.svg
node tools/check-perf-docs.mjs
```

The baseline itself was recorded from the Actions artifacts of run `41614844179`
(`gh run download 41614844179 -n q22-paired-benchmark` and `-n smoke-metrics`) by
`tools/record-perf-baseline.mjs`, which refuses a run/commit/runner mismatch between the two artifacts.

| field | value |
|---|---|
| committed baseline | `tests/perf/q22-baseline.json` (wrapper; the q22 artefact is embedded verbatim under `report`) |
| workflow | `GoTavern smoke metrics` |
| run id | `41614844179` (conclusion: success) |
| run branch / event | `main`, `workflow_dispatch` |
| commit measured | `4bf54510c747b3f257835fa1bfa86909bbb5f134` (the released commit itself: the stable-channel release commit; the tag points at this commit, so the figure quotes the same-SHA gate run rather than an ancestor) |
| runner image | `ubuntu26` |
| host (same run) | `ubuntu26` `20261026.180.1`, Linux/X64, kernel `7.0.0-1017-azure`, 4 vCPU, 16,759,443,456 B RAM, Node `v24.22.1` (from the same run's `smoke-metrics` artifact) |
| Go toolchain | `go.mod` directive `1.27.3`, read by `setup-go` via `go-version-file: go.mod`; the artefact itself does not record the toolchain |
| rounds / requests | 3 alternating rounds x 30 sequential requests per path |
| soak | 2 x 10-minute windows, one per subject, 30 s sampling (both completed) |
| unit rule | decimal MB, 1 MB = 1,000,000 bytes. The unit is **stated on the row** it applies to — the RSS row note reads `decimal MB (1e6 B)` — and the exact byte count is printed too, so the rounding is checkable |
| figure size | 1200 x 675 pixels, 16:9; both variants are byte-compared in CI |

`docs/goal-scorecard.md` row Q22 cites this alpha.13 measurement for the method and names this provenance record for
the current figure; the README's Performance table quotes this run's medians, and both figure variants are generated
from the same artefact, so the picture and the table restate ONE recording.

## Why this run and not another one

- **It measured the RELEASED commit.** `4bf5451` is the tag's own target, so this is the required same-SHA
  `GoTavern smoke metrics` gate run rather than an ancestor measurement; the documentation and the curated release
  note live on `main` after the tag (and are read at publish), which is why the tag tree carries no run id of its
  own. The published release body appends the same run-id table.
- **It measured the same experiment.** Same runner image, same alternating rounds, same fresh-`mkdtemp` data root
  per round, same 30 requests per path, and the artefact asserts `everyRoundAnswered`, `sampleCountsMatch`,
  `soakCompleted` and `soakSeriesMatch`.
- **The absolute numbers are host noise; the ratio is not.** Pinned boot has been measured at 14,355 ms, 8,777 ms,
  12,985 ms, 9,941 ms, 9,878 ms, 9,637 ms and 13,843 ms on the same image, and GoTavern's at 136 ms, 61 ms,
  32 ms, 185 ms, 189 ms, 397 ms and 162 ms. That is why the figure cites ONE runner and ONE run id, and why the README
  calls the numbers a comparison rather than a budget. The figure was regenerated from the released-commit gate run
  for alpha.13; quoting an older figure's numbers as this release's performance would have been an unmeasured claim,
  not a conservative one.

## Editing this figure

Do not edit either SVG. Change the artefact or the generator and regenerate, so the numbers in the picture remain a
restatement of a recording rather than a retyping of one. Two runs of the generator over the same inputs produce
identical bytes (the layout is a pure function of the artefact, the run id and the commit; there is no `Math.random`,
no `Date`, no locale-dependent formatting and no order-dependent counter). A single generator run writes BOTH variants;
there is no second code path that could make them disagree about the data.

The generator enforces these properties, each of which a hand edit would silently break:

- **one zero-based axis per metric**, with a rounded-up axis maximum printed at the axis end (and a midpoint tick for
  scale), so nothing is truncated and the axis top is not a data value;
- the raw value printed for both subjects in every row, **plus the ratio computed here** from those two values;
- **units on every number**: `ms` on every timing value and axis tick, `MB` on memory and its axis, `rounds`,
  `samples` and `requests` on the method notes, and `x` on the ratio (it is itself a multiplier);
- a **per-metric verdict word**: `faster` on the timing rows, `lighter` on memory, with the direction stated once
  ("lower is better in every row") and never re-encoded as colour;
- a minimum bar width that affects only the rectangle, never a printed number, the axis or the ratio — and it is
  stated in the figure's own footer rather than left for a reader to discover by measuring;
- `role="img"` with `<title>` and `<desc>`, and the `<desc>` carries the SAME per-metric verdict word a sighted
  reader sees, plus the unit rule and the source run/commit;
- **a type floor of 12 px at 1:1**: every text style is declared in one `TYPE_SCALE` table and the generator refuses
  to render a size below 12 px (the check also runs over the committed SVG in CI);
- an explicit opaque background, generic system font families only, and **no external reference** of any kind: no
  `@font-face`, image, script, or http(s) URL;
- **two variants from one palette table**, so the dark and light drawings differ only in colour.

## Contrast audit (measured, not asserted)

The generator computes WCAG 2.1 relative luminance and contrast ratios from the same palette constants it draws with,
prints the table on every run, and **refuses to render** if any pair is below its threshold (text 4.5:1, the two bar
fills 3:1 as large graphical objects). There are no panels and no text sits inside a bar, so every text pair has one
exact background and the table below is the whole of the figure's text surface. Hairline rules are decoration only,
carry no meaning, and are excluded; every meaning-bearing mark is also labelled in text.

| element | dark foreground on `#0d1117` | ratio | light foreground on `#ffffff` | ratio |
|---|---|---:|---|---:|
| headline, row labels, values | `#f0f6fc` | 17.39:1 | `#1f2328` | 15.80:1 |
| subtitle, legend labels, method notes | `#c9d1d9` | 12.26:1 | `#424a53` | 8.99:1 |
| kicker, axis ticks, footer, legend note | `#9aa4b0` | 7.49:1 | `#57606a` | 6.39:1 |
| derived ratios, verdict words, GoTavern values | `#6ee7f9` | 13.03:1 | `#0b5f7a` | 7.16:1 |
| pinned bar fill (graphical, min 3:1) | `#f59e0b` | 8.81:1 | `#b45309` | 5.02:1 |
| GoTavern bar fill (graphical, min 3:1) | `#22b8cf` | 7.95:1 | `#0e7490` | 5.36:1 |

Both variants were also rendered at 1× (1200 × 675) and at GitHub's mobile content widths (420 and 640 CSS px) during
the change that introduced them; at mobile width the 16:9 image scales below comfortable reading size, which is why
the Performance section keeps the same four numbers as a text table under the figure.

## Visual style (2026-11-03 redesign)

The previous figure was 1000 × 1180 portrait with 8.5–10.5 px type, a long way below the first screen. This revision
is a **16:9 technical panel** designed to be the one image of a README's first screen: a flat, high-contrast canvas
per GitHub theme, a headline that states the two verdicts ("Faster. Lighter."), four rows of paired bars with a shared
zero-based scale rule, values and derived ratios in fixed columns, subject tags in words as well as colour, and a
footer that names the artefact, the run, the commit and the unit rule. Nothing is decorative that does not carry
information: every rule separates something, the two fills mark the two subjects, and the only word that repeats is
the unit rule the figure exists to keep checkable.

**THE VERDICT WORD IS PER-METRIC, AND THAT IS A CORRECTNESS RULE.** The three timing rows say `faster`; the memory row
says `lighter`. A resident-set size is not fast or slow, so printing "faster" over the RSS bar would put an inaccurate
claim on a release surface. The headline covers all four by making two claims — "Faster. Lighter." — rather than
stretching one word over a metric it does not describe.
