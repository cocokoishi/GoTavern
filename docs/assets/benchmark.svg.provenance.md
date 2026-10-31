# docs/assets/benchmark.svg — provenance

The figure is **generated**, never hand-drawn. Every number in it is read out of a recorded benchmark artefact;
`tools/benchmark-svg.mjs` contains no measured value and refuses to render if a field it needs is absent. It also
refuses to render without `--run-id` and `--commit`, because a figure that names no run and no tree is a number
with no provenance.

## How it was produced

```
gh run download 41171857944 -n q22-paired-benchmark -D ./q22
node tools/benchmark-svg.mjs \
  --report ./q22/q22-paired-benchmark.json \
  --out docs/assets/benchmark.svg \
  --run-id 41171857944 \
  --commit 91e1e15
```

## The artefact it is drawn from

| field | value |
|---|---|
| workflow | `GoTavern smoke metrics` |
| run id | `41171857944` (conclusion: success) |
| run branch / event | `main`, `workflow_dispatch` |
| commit measured | `91e1e15283cdfe90ca9fd8c0fc40c794612c6b43` (the code the v0.1.0-alpha.9 release ships; the tag commit adds documentation only) |
| runner image | `ubuntu26` |
| rounds / requests | 3 alternating rounds x 30 sequential requests per path |
| soak | 2 x 10-minute windows, one per subject, 30 s sampling (both completed) |

`docs/goal-scorecard.md` row Q22 cites this run, the README's Performance table quotes its medians, and this figure
is generated from the same artefact, so the picture, the table and the ledger restate ONE recording.

## Why this run and not another one

- **It measured the tree the release was cut from.** The tag `v0.1.0-alpha.9` adds documentation on top of the
  measured commit, so a rebuild from the tag produces the same code; that is why the release notes quote this run.
- **It measured the same experiment.** Same runner image, same alternating rounds, same fresh-`mkdtemp` data root
  per round, same 30 requests per path, and the artefact asserts `everyRoundAnswered`, `sampleCountsMatch`,
  `soakCompleted` and `soakSeriesMatch`.
- **The absolute numbers are host noise; the ratio is not.** Pinned boot has been measured at 14,355 ms, 8,777 ms,
  12,985 ms and 9,941 ms on the same image, and GoTavern's at 136 ms, 61 ms and 32 ms. That is why the figure cites
  ONE runner and ONE run id, and why the README calls the numbers a comparison rather than a budget.

## Editing this figure

Do not edit the SVG. Change the artefact or the generator and regenerate, so the numbers in the picture remain a
restatement of a recording rather than a retyping of one. Two runs of the generator over the same inputs produce
identical bytes (the layout is a pure function of the artefact, the run id and the commit; there is no `Math.random`,
no `Date` and no order-dependent counter).

The generator enforces these properties, each of which a hand edit would silently break:

- one **zero-based** axis per metric, with a rounded-up axis maximum printed at the axis end, so nothing is truncated;
- the raw value printed for both subjects in every row, plus the ratio derived from those two values;
- a minimum bar width that affects only the rectangle, never a printed number, the axis or the ratio — and it is
  stated in the figure's own footer rather than left for a reader to discover by measuring;
- `role="img"` with `<title>` and `<desc>`, and the `<desc>` carries the SAME per-metric verdict word a sighted
  reader sees;
- an explicit background and no external references, no external font, and no script.

## Visual style (2026-10-31 redesign)

The figure is a **precision instrument, not a whiteboard sketch**. The 2026-10-27 revision imitated a marker
(wobbly rectangles, hand-drawn frames, sketch axes). It was replaced because wobble beside a 310x difference invites
"hand-drawn therefore approximate", and the frames competed with the bars for attention. This revision draws
hairlines, tabular figures, a typeset serif headline and a dark page lit by two soft auroras; the only glow in the
figure marks the product's bar, and the only gradient type is reserved for DERIVED numbers.

**THE VERDICT WORD IS PER-METRIC, AND THAT IS A CORRECTNESS RULE.** The three timing rows say `Nx faster`; the
memory row says `Nx lighter`. A resident-set size is not fast or slow, so printing "faster" over the RSS bar would
put an inaccurate claim on a release surface. The headline covers all four by making two claims — "Faster. Lighter."
— rather than stretching one word over a metric it does not describe.

**On the surface colour and contrast.** A paper-white board would force dark ink, and `#66ccff` on white is 2.2:1,
unreadable as text. The deep ink page (`#070b14` at the top of the gradient) keeps the identity colour as the bright
accent it is and keeps every text pair past WCAG AA. Measured against the lightest stop of the page gradient
(`#0b1322`), which is the worst case for light ink: primary `#eef3ff` 16.72:1, secondary `#a7b6cd` 9.04:1, muted
`#7488a7` 4.82:1, cyan `#7fe9ff` 13.27:1, amber `#f6b545` 10.27:1. The in-bar value ink (`#1b1206`) is 10.23:1 on
the flat amber stop and 7.32:1 on the darkest amber stop, so it stays legible across the bar's own gradient. The
hairline `#94a3b8` at 0.16 opacity is decoration only and carries no meaning; every meaning-bearing mark is also
labelled in text.
