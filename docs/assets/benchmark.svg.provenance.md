# docs/assets/benchmark.svg — provenance

The figure is **generated**, never hand-drawn. Every number in it is read out of a recorded benchmark artefact;
`tools/benchmark-svg.mjs` contains no measured value and refuses to render if a field it needs is absent.

## How it was produced

```
gh run download 40396669521 -n q22-paired-benchmark -D ./q22
node tools/benchmark-svg.mjs \
  --report ./q22/q22-paired-benchmark.json \
  --out docs/assets/benchmark.svg \
  --run-id 40396669521
```

## The artefact it is drawn from

| field | value |
|---|---|
| workflow | `GoTavern smoke metrics` |
| run id | `40396669521` (conclusion: success) |
| run branch | `lane/q22-paired-bench` |
| commit measured | `a3c2f5340f152ce96150f52be4ccf7b27695b61f` |
| runner image | `ubuntu26` |
| rounds / requests | 3 alternating rounds x 30 sequential requests per path |
| soak | 10-minute window, both subjects, 30 s sampling |

`smoke-metrics.yml` has no `pull_request` trigger and `workflow_dispatch` needs the file on the default branch, so
the run above was dispatched from a lane branch while that lane carried a temporary push trigger. The same numbers
are recorded in `docs/goal-scorecard.md` row Q22, which cites this run and `40394799325`.

## Why this run and not a newer one

- It is the only run whose artefact contains **both subjects AND the 10-minute soak** (`40394799325` has no soak
  block; it is cited for the paired medians only).
- It is on `main`'s history. Since it ran, exactly **one production `.go` file** changed
  (`internal/commandline/paths.go`), and that change is confined to the *relative*-`dataRoot` branch. The benchmark
  passes an absolute `mkdtemp` root, so it takes the `default:` arm, which the change did not touch.
- Re-running would produce a third set of numbers differing from both existing runs (boot programs measured at
  14,355 ms and 8,777 ms on the same image), because this is a shared runner. A re-run could not change the release
  decision; it could only make the currently cited runs non-authoritative.

## Editing this figure

Do not edit the SVG. Change the artefact or the generator and regenerate, so the numbers in the picture remain a
restatement of a recording rather than a retyping of one.

The generator enforces these properties, each of which a hand edit would silently break:

- one **zero-based** panel per metric, with that panel's axis maximum printed, so nothing is truncated;
- the raw value printed for both subjects in every panel, plus the ratio derived from those two values;
- a minimum bar width that affects only the rectangle, never a printed number or the axis;
- `role="img"` with `<title>` and `<desc>`, so the figure is not opaque to a screen reader, and the `<desc>` carries
  the SAME per-panel verdict word a sighted reader sees;
- an explicit background and no external references, no external font, and no script.

## Visual style, and the one word the style may not use (2026-10-27 redesign)

The figure is drawn in a **sketch / whiteboard-marker** style: wobbly bar outlines, hand-drawn panel frames drawn
twice, sketchy axis ticks, and a hand underline beneath the accent in the identity colour `#66ccff`.

**The wobble is a pure function of its arguments.** `sketchNoise(n)` is a stateless 32-bit integer hash, and every
curve is `sketchLine`/`sketchRect` seeded from the panel and row index. There is no `Math.random`, no `Date`, and no
dependence on execution order, so the two runs that produce `benchmark.svg` produce identical bytes -- the property
the section above depends on. A hand-drawn look and a reproducible artefact are not in tension; what they forbid is
randomness.

**THE VERDICT WORD IS PER-METRIC, AND THAT IS A CORRECTNESS RULE.** The three timing panels say
`Nx faster`; the memory panel says `Nx lighter`. A resident-set size is not fast or slow, so printing "faster" over
the RSS bar would put an inaccurate claim on a release surface. The headline covers all four by making two claims --
"Faster. Lighter." -- rather than stretching one word over a metric it does not describe.

**On the surface colour.** A paper-white board would force dark ink, and `#66ccff` on white is 2.2:1 -- unreadable as
text and invisible as a stroke. A deep navy page (`#0a1a2f`) keeps the requested colour as the bright accent it is
and keeps every text pair past WCAG AA: primary 15.71:1, secondary 9.32:1, identity 9.69:1, and the in-bar value inks
8.97:1 and 8.59:1. The frame stroke is 3.11:1, above the 3:1 threshold for non-text graphics.

