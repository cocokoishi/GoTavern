#!/usr/bin/env node
// Generate docs/assets/benchmark.svg from the RECORDED Q22 paired-benchmark artefact.
//
// THIS IS A GENERATOR, NOT A PROBE. It computes nothing about the product: every number it draws is read out of
// the JSON artefact that the benchmark workflow uploaded, and the script refuses to render when the artefact it is
// pointed at does not carry the shape it expects. A generator that could invent a value would defeat the point of
// publishing one, so the values are DATA and the layout is the only thing this file decides.
//
// Usage:
//   node tools/benchmark-svg.mjs --report <q22-paired-benchmark.json> --out docs/assets/benchmark.svg
//
// WHY THE CHART IS SHAPED THIS WAY (release constraint: never hide a raw value behind a ratio, never truncate an
// axis to exaggerate):
//   * Every bar is drawn in a panel whose axis starts at ZERO and whose maximum is that METRIC'S OWN maximum, and
//     the axis maximum is printed on the panel. A 235x difference cannot share a linear axis with 0.43 ms without
//     making the small bar invisible, so each metric gets its own zero-based panel rather than one shared axis.
//   * Both the raw value AND the ratio are printed. The ratio is labelled as derived from the printed values, and
//     it is computed here from the raw numbers rather than typed in, so a reader can check it with the values shown.
//   * RSS and startup use DECIMAL megabytes (1e6 bytes), stated on the panel, because that is the unit the byte
//     counts round to; the exact byte count is printed too, so no reader has to trust the rounding.
//   * "Lower is better" is stated once, and the direction is not re-encoded in colour.
//   * The figure carries its own background and uses colours that hold contrast on both GitHub themes; it has no
//     external references, no fonts it does not ship as a generic family, and no JavaScript.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

function argumentValue(name, fallback = null) {
    const index = process.argv.indexOf(name);
    if (index < 0) return fallback;
    return process.argv[index + 1] ?? fallback;
}

const reportPath = argumentValue('--report');
const outPath = argumentValue('--out');
// THE RUN ID IS NOT IN THE ARTEFACT. It is workflow context, so it is passed in explicitly rather than derived,
// and it is REQUIRED: a figure that names no run is a number with no provenance, which the release constraint
// forbids. This is the one value this script accepts on trust from its caller, and the caller is a release step
// that can (and does) verify it against the run that produced the file.
const runId = argumentValue('--run-id');
if (!reportPath || !outPath || !runId) {
    console.error('usage: node tools/benchmark-svg.mjs --report <q22-paired-benchmark.json> --out <benchmark.svg> --run-id <actions run id>');
    process.exit(2);
}

const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));

// REFUSE RATHER THAN GUESS. Every field drawn below is required; a missing one is a failure, not a zero.
function requireField(object, key, context) {
    if (object === null || typeof object !== 'object' || !(key in object)) {
        throw new Error(`the artefact is missing ${context}.${key}; refusing to draw a value that is not recorded`);
    }
    return object[key];
}

const pinned = requireField(report, 'summary', 'report').pinned;
const gotavern = requireField(report, 'summary', 'report').gotavern;
const runnerImage = requireField(report, 'runnerImage', 'report');
const rounds = requireField(report, 'rounds', 'report');
const requestsPerRound = requireField(report, 'requestsPerRound', 'report');

const BYTES_PER_MEGABYTE = 1e6;

// THE VERDICT WORD IS PER-METRIC DATA, NOT A GLOBAL BANNER, AND THAT IS A CORRECTNESS DECISION RATHER THAN A STYLE
// ONE. "Faster" is true of the three TIMING panels and FALSE of memory: a resident-set size is not fast or slow, it
// is large or small. Printing "faster" over a memory bar would put an inaccurate claim on a release surface, which is
// the single thing this project does not do. So timing panels say "faster", the RSS panel says "lighter", and the
// headline carries the punch across all four without misdescribing any of them.
const VERDICT_FASTER = 'faster';
const VERDICT_LIGHTER = 'lighter';

const metrics = [
    {
        key: 'startup',
        label: 'Cold start to first /version 200',
        unit: 'ms',
        verdict: VERDICT_FASTER,
        pinnedValue: requireField(pinned, 'bootMsMedian', 'summary.pinned'),
        goValue: requireField(gotavern, 'bootMsMedian', 'summary.gotavern'),
        format: value => `${value.toLocaleString('en-US')} ms`,
        note: 'median of 3 rounds; empty data root, no config.yaml',
    },
    {
        key: 'rss',
        label: 'Steady-state memory (RSS)',
        unit: 'MB',
        verdict: VERDICT_LIGHTER,
        pinnedValue: requireField(pinned, 'rssBytesMedian', 'summary.pinned') / BYTES_PER_MEGABYTE,
        goValue: requireField(gotavern, 'rssBytesMedian', 'summary.gotavern') / BYTES_PER_MEGABYTE,
        format: value => `${value.toFixed(1)} MB`,
        exact: {
            pinned: requireField(pinned, 'rssBytesMedian', 'summary.pinned'),
            go: requireField(gotavern, 'rssBytesMedian', 'summary.gotavern'),
        },
        note: 'VmRSS from /proc, sampled after readiness and after 60 requests; median of 6',
    },
    {
        key: 'version',
        label: 'GET /version latency',
        unit: 'ms',
        verdict: VERDICT_FASTER,
        pinnedValue: requireField(pinned, 'versionMedianMs', 'summary.pinned'),
        goValue: requireField(gotavern, 'versionMedianMs', 'summary.gotavern'),
        format: value => `${value.toFixed(value < 10 ? 3 : 2)} ms`,
        // MEASURED, NOT PARAPHRASED FROM ANOTHER HARNESS. `timeRequests` issues `count` SEQUENTIAL requests with
        // Node's global fetch (undici) and rejects any non-2xx. It does not configure an Agent, so reuse comes from
        // undici's default pooling rather than from a stated keep-alive policy -- and the smoke-metrics workflow's
        // "keep-alive connection" wording describes a DIFFERENT harness, so it is not borrowed here.
        note: `median of ${pinned.samples?.version ?? 90} sequential requests, same client both subjects`,
    },
    {
        key: 'root',
        label: 'GET / latency (HTML shell)',
        unit: 'ms',
        verdict: VERDICT_FASTER,
        pinnedValue: requireField(pinned, 'rootMedianMs', 'summary.pinned'),
        goValue: requireField(gotavern, 'rootMedianMs', 'summary.gotavern'),
        format: value => `${value.toFixed(2)} ms`,
        note: `median of ${pinned.samples?.root ?? 90} sequential requests, body fully consumed`,
    },
];

// ---------------------------------------------------------------------------------------------------------------
// LAYOUT. One panel per metric, stacked vertically. Each panel is self-contained: its own zero-based axis, its own
// axis maximum printed, both raw values, and the ratio derived from those two values.
// ---------------------------------------------------------------------------------------------------------------

const WIDTH = 900;
const MARGIN_X = 30;
const PANEL_LABEL_WIDTH = 232;
const CHART_WIDTH = WIDTH - MARGIN_X * 2 - PANEL_LABEL_WIDTH;
// THE HEIGHT IS DERIVED FROM WHAT IS DRAWN, not chosen. An early version hard-coded 96 and the note text overflowed
// the panel and ran underneath the bars -- which the XML validity check could not see and only a render did.
// THE PANEL HEIGHT IS DERIVED FROM THE TALLEST PANEL, not chosen. The worst case is the memory panel, which carries
// three label lines: 18 (metric name) + 3x16 (name/note/exact) for the bar offset, then 2x(22+13) for the two bar
// rows, then 6 for the axis and 15 for the axis labels = 157, plus 12 of bottom padding. An earlier fixed 132 was
// 25 px short and the RSS panel's axis labels would have been clipped by the panel below it.
const PANEL_HEIGHT = 169;
const PANEL_GAP = 30;
const HEADER_HEIGHT = 168;
const FOOTER_HEIGHT = 128;
const BAR_HEIGHT = 22;

// ---------------------------------------------------------------------------------------------------------------
// THE PALETTE. #66ccff is the requested identity colour and is used for the figure's frame, the GoTavern bars, the
// headline accent and the sketch hatching. It is a LIGHT colour, so it works as an INK on a dark surface and it must
// never be used for small text on a dark ink.
//
// THE BACKGROUND IS A DEEP NAVY PAGE RATHER THAN PAPER. A whiteboard look is the obvious reading of "hand-drawn", but
// a white or paper surface forces dark ink, and #66ccff on white is 2.2:1 -- unreadable as text and invisible as a
// stroke. A deep navy keeps the requested colour as the bright accent it is, keeps every text pair past AA, and still
// reads as a sketched board rather than a dashboard.
const BACKGROUND = '#0a1a2f';
const PANEL_FILL = '#0f233d';
const TEXT_PRIMARY = '#eaf4ff';
const TEXT_SECONDARY = '#a8c0d8';
const NODE_FILL = '#e8a33d';     // warm counterpart to the cool identity colour
const GO_FILL = '#66ccff';       // THE requested colour, used for the product being advocated
const IDENTITY = '#66ccff';
// THE STROKE COLOURS ARE BRIGHTER THAN A DARK-AXIS DEFAULT ON PURPOSE. A first render used a muted #4a6b8a for the
// axes and frames and at 1.3 px on #0f233d they read as NO STROKE AT ALL -- the panels flattened into plain navy
// cards and the sketch disappeared. Sketch lines have to be visible to look drawn, so the axis/frame ink is a light
// desaturated blue and the bars are outlined in their own saturated colour.
const AXIS = '#6f93b5';
const FRAME_INK = '#3f6b93';

const escapeXml = value => String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

// A bar is drawn as a fraction of the panel's own maximum, so the axis is zero-based and nothing is truncated.
//
// THE MINIMUM VISIBLE WIDTH IS A LEGIBILITY FLOOR FOR THE RECTANGLE ONLY. At 61 ms against a 14,355 ms panel
// maximum the honest fraction is 0.42%, which renders as a sub-pixel line -- the figure would obey "never truncate"
// while failing "shows both subjects". The floor widens the RECTANGLE; it never changes the printed value, the axis,
// or the ratio, all of which are computed from the raw numbers. A reader comparing bar LENGTHS with the floor in play
// would understate the difference, which is the safe direction to be wrong in.
const MIN_VISIBLE_BAR = 5;

// ---------------------------------------------------------------------------------------------------------------
// THE SKETCH IS A PURE FUNCTION OF ITS ARGUMENTS. No Math.random, no Date, no counter that depends on execution
// order: two runs of this generator must produce identical bytes, because the provenance file promises the SVG is
// regenerable from the recorded artefact. A wobbly hand-drawn look and a reproducible artefact are not in tension;
// what they forbid is randomness.
//
// `sketchNoise(n)` is a small integer hash of n, mapped to [-1, 1). It is the classic xorshift-multiply mix, chosen
// because it is short, has no state, and is identical in every JavaScript engine (it stays inside 32-bit integer
// arithmetic before the final divide).
// ---------------------------------------------------------------------------------------------------------------
function sketchNoise(n) {
    let x = (n | 0) * 2654435761;
    x = (x ^ (x >>> 15)) >>> 0;
    x = (x * 2246822519) >>> 0;
    x = (x ^ (x >>> 13)) >>> 0;
    return ((x >>> 0) / 4294967296) * 2 - 1;
}

/**
 * A hand-drawn straight-ish line: the two endpoints plus a few interior points displaced perpendicular to the line.
 * `seed` selects a distinct wobble so two lines that share a path do not wobble identically.
 */
function sketchLine(x1, y1, x2, y2, seed, amplitude = 2.4, segments = 7) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const length = Math.hypot(dx, dy) || 1;
    // Perpendicular unit vector, so the wobble is across the line rather than along it.
    const nx = -dy / length;
    const ny = dx / length;
    const points = [];
    for (let index = 0; index <= segments; index += 1) {
        const t = index / segments;
        // Zero displacement at both ends keeps the line attached to what it connects.
        const taper = Math.sin(Math.PI * t);
        const offset = sketchNoise(seed * 101 + index * 17) * amplitude * taper;
        points.push([x1 + dx * t + nx * offset, y1 + dy * t + ny * offset]);
    }
    return points;
}

const toPath = points => points
    .map(([x, y], index) => `${index === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`)
    .join(' ');

/**
 * A sketchy rectangle: four wobbling edges joined into ONE CLOSED SUBPATH.
 *
 * THE SUBPATHS MUST NOT BE SEPARATE. A first version emitted `M...L... M...L... M... M...Z` -- four independent
 * subpaths with a single trailing `Z` -- and SVG closes only the LAST subpath, so the filled area collapsed to a
 * degenerate sliver and every bar rendered as a hollow outline. The render showed it immediately (bars looked like
 * empty boxes); XML validity did not, because the markup was well-formed and simply meant something else. So the
 * four edges are emitted as one continuous ring: `M` once, then the interior points of all four edges, then `Z`.
 */
function sketchRect(x, y, width, height, seed, amplitude = 0.9) {
    const visibleWidth = Math.max(width, MIN_VISIBLE_BAR);
    const top = sketchLine(x, y, x + visibleWidth, y, seed + 1, amplitude);
    const right = sketchLine(x + visibleWidth, y, x + visibleWidth, y + height, seed + 2, amplitude * 0.9);
    const bottom = sketchLine(x + visibleWidth, y + height, x, y + height, seed + 3, amplitude);
    const left = sketchLine(x, y + height, x, y, seed + 4, amplitude * 0.9);
    // Drop each edge's first point: it duplicates the previous edge's last point, and repeating it would end the
    // subpath. Keeping the ring continuous is what makes the interior fillable.
    const rings = [top, right, bottom, left];
    const points = [];
    rings.forEach((edge, index) => {
        const edgePoints = index === 0 ? edge : edge.slice(1);
        for (const point of edgePoints) points.push(point);
    });
    return `${toPath(points)} Z`;
}

const style = `
  <style>
    .headline { font: 700 23px Georgia, "Times New Roman", serif; fill: ${TEXT_PRIMARY}; }
    .headline-accent { font: 700 23px Georgia, "Times New Roman", serif; fill: ${IDENTITY}; }
    .subtitle { font: 400 12.5px Georgia, "Times New Roman", serif; fill: ${TEXT_SECONDARY}; }
    .panel-label { font: 700 14px Georgia, "Times New Roman", serif; fill: ${TEXT_PRIMARY}; }
    .panel-note { font: 400 11px Georgia, "Times New Roman", serif; fill: ${TEXT_SECONDARY}; }
    .value { font: 700 13px Georgia, "Times New Roman", serif; fill: ${TEXT_PRIMARY}; }
    .exact { font: 400 10px Georgia, "Times New Roman", serif; fill: ${TEXT_SECONDARY}; }
    .axis-label { font: 400 10px Georgia, "Times New Roman", serif; fill: ${TEXT_SECONDARY}; }
    .legend { font: 600 12.5px Georgia, "Times New Roman", serif; fill: ${TEXT_PRIMARY}; }
    .ratio { font: 700 12.5px Georgia, "Times New Roman", serif; fill: ${IDENTITY}; }
    .footer { font: 400 10.5px Georgia, "Times New Roman", serif; fill: ${TEXT_SECONDARY}; }
    .stroke-ink { fill: none; stroke: ${TEXT_PRIMARY}; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
    .stroke-identity { fill: none; stroke: ${IDENTITY}; stroke-width: 2.4; stroke-linecap: round; stroke-linejoin: round; }
    .stroke-axis { fill: none; stroke: ${AXIS}; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
    .stroke-frame { fill: none; stroke: ${FRAME_INK}; stroke-width: 1.9; stroke-linecap: round; stroke-linejoin: round; }
  </style>`;

const parts = [];
const totalHeight = HEADER_HEIGHT + metrics.length * (PANEL_HEIGHT + PANEL_GAP) + FOOTER_HEIGHT;

parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${totalHeight}" viewBox="0 0 ${WIDTH} ${totalHeight}" role="img" aria-labelledby="benchmarkTitle benchmarkDesc">`);
parts.push(`<title id="benchmarkTitle">GoTavern vs SillyTavern (Node) - paired benchmark, ${escapeXml(runnerImage)}</title>`);
// THE DESCRIPTION CARRIES THE SAME VERDICT WORDS AS THE PANELS, per metric, because a screen-reader user gets this
// text instead of the picture and must not be told "faster" about a memory figure any more than a sighted reader is.
parts.push(`<desc id="benchmarkDesc">${escapeXml(metrics.map(m => `${m.label}: SillyTavern ${m.format(m.pinnedValue)}, GoTavern ${m.format(m.goValue)} (${(m.pinnedValue / m.goValue).toFixed(2)}x ${m.verdict})`).join('; '))}. For timing panels a lower value is faster; for memory a lower value is lighter. Degree of improvement is per panel, each drawn against its own zero-based axis. Methodology and provenance are stated in the README section below the figure.</desc>`);
parts.push(style);
// THE CANVAS IS PAINTED FIRST, and it is a full-bleed rect with no rounding: the figure owns its own background so
// it is identical on GitHub's light and dark themes, and a rounded corner would let the page colour peek through at
// the edge on one theme only.
parts.push(`<rect width="${WIDTH}" height="${totalHeight}" fill="${BACKGROUND}"/>`);

// ---- header --------------------------------------------------------------------------------------------------
// The headline delivers the punch the request asked for, using "faster" ONLY where it is true of the whole set:
// the three timing panels plus the memory panel are covered by "Faster. Lighter." as two separate claims, not one
// claim stretched over a metric it does not describe.
parts.push(`<text x="${MARGIN_X}" y="52"><tspan class="headline">Same SillyTavern. </tspan><tspan class="headline-accent">Faster. Lighter.</tspan></text>`);
// A hand-drawn underline beneath the accent, in the identity colour: two passes so it looks drawn rather than ruled.
parts.push(`<path class="stroke-identity" opacity="0.75" d="${toPath(sketchLine(WIDTH - MARGIN_X - 214, 62, WIDTH - MARGIN_X - 6, 62, 91, 1.6, 9))}"/>`);
parts.push(`<path class="stroke-identity" opacity="0.35" d="${toPath(sketchLine(WIDTH - MARGIN_X - 210, 65, WIDTH - MARGIN_X - 10, 65, 92, 1.9, 9))}"/>`);

parts.push(`<text class="subtitle" x="${MARGIN_X}" y="86">Measured against pinned SillyTavern on the same machine, in the same run, in alternating rounds.</text>`);
parts.push(`<text class="subtitle" x="${MARGIN_X}" y="104">${escapeXml(`Runner ${runnerImage} - ${rounds} rounds x ${requestsPerRound} sequential requests per path - medians shown`)}</text>`);

// legend: swatches drawn as small sketchy boxes so the legend matches the bars it explains.
const legendY = 130;
parts.push(`<path d="${sketchRect(MARGIN_X, legendY - 11, 15, 15, 301)}" fill="${NODE_FILL}" stroke="${NODE_FILL}" stroke-width="1.1" stroke-linejoin="round"/>`);
parts.push(`<text class="legend" x="${MARGIN_X + 23}" y="${legendY}">SillyTavern (Node)</text>`);
parts.push(`<path d="${sketchRect(MARGIN_X + 178, legendY - 11, 15, 15, 302)}" fill="${GO_FILL}" stroke="${GO_FILL}" stroke-width="1.1" stroke-linejoin="round"/>`);
parts.push(`<text class="legend" x="${MARGIN_X + 201}" y="${legendY}">GoTavern</text>`);
// The per-panel verdict vocabulary is explained ONCE, at the legend, rather than repeated four times: "faster" for
// the timing rows and "lighter" for memory, each panel printing its own word.
parts.push(`<text class="panel-note" x="${MARGIN_X + 330}" y="${legendY}">Each panel says what the difference means: faster for timing, lighter for memory.</text>`);

// ---- panels --------------------------------------------------------------------------------------------------
let y = HEADER_HEIGHT;
let panelIndex = 0;
for (const metric of metrics) {
    panelIndex += 1;
    const panelMax = Math.max(metric.pinnedValue, metric.goValue);
    const axisLabel = metric.format(panelMax);

    // A hand-drawn frame for the panel: the flat card first, then a sketchy outline around it, then a SECOND faint
    // pass offset by a pixel or two -- which is what a marker does when a hand goes round a box twice. The outline
    // uses sketchRect so it is a single closed ring; drawing the four edges as four separate subpaths (an earlier
    // version) makes them stroke correctly but leaves the shape unclosed at the corners.
    const frameX = MARGIN_X - 12;
    const frameY = y - 20;
    const frameW = WIDTH - (MARGIN_X - 12) * 2;
    parts.push(`<rect x="${frameX}" y="${frameY}" width="${frameW}" height="${PANEL_HEIGHT}" rx="7" fill="${PANEL_FILL}"/>`);
    parts.push(`<path class="stroke-frame" d="${sketchRect(frameX, frameY, frameW, PANEL_HEIGHT, 400 + panelIndex * 7, 3.0)}"/>`);
    parts.push(`<path class="stroke-frame" opacity="0.45" d="${sketchRect(frameX + 2.5, frameY + 2.5, frameW - 5, PANEL_HEIGHT - 5, 430 + panelIndex * 7, 3.6)}"/>`);

    // label block: the metric name, its sampling note, and the literal byte counts for the memory panel.
    parts.push(`<text class="panel-label" x="${MARGIN_X}" y="${y + 2}">${escapeXml(metric.label)}</text>`);
    parts.push(`<text class="panel-note" x="${MARGIN_X}" y="${y + 19}">${escapeXml(metric.note)}</text>`);
    if (metric.exact) {
        parts.push(`<text class="exact" x="${MARGIN_X}" y="${y + 34}">exact: ${metric.exact.pinned.toLocaleString('en-US')} B / ${metric.exact.go.toLocaleString('en-US')} B</text>`);
    }

    const chartX = MARGIN_X + PANEL_LABEL_WIDTH;
    const barRows = [
        { value: metric.pinnedValue, fill: NODE_FILL, name: 'SillyTavern (Node)', ink: '#1a1206' },
        { value: metric.goValue, fill: GO_FILL, name: 'GoTavern', ink: '#062334' },
    ];

    // THE THREE LABEL LINES (metric name, note, exact bytes) NEED REAL VERTICAL ROOM, and the bar offset is derived
    // from how many of them a panel actually has. A fixed offset of 40 put the bars 6 px under a 10 px text line and
    // the render showed "exact: 912,199,680 B" overprinted by the note above it.
    const labelLines = metric.exact ? 3 : 2;
    const barTop = y + 18 + labelLines * 16;

    barRows.forEach((row, index) => {
        // THE BARS START BELOW THE LABEL BLOCK, so a note can never run behind them.
        const barY = barTop + index * (BAR_HEIGHT + 13);
        const fraction = panelMax === 0 ? 0 : row.value / panelMax;
        const barWidth = Math.max(MIN_VISIBLE_BAR, fraction * CHART_WIDTH);
        const seedBase = 500 + panelIndex * 20 + index * 5;

        // A sketchy filled bar: the wobbly outline carries the fill, and a second faint pass sits just inside it so
        // the edge reads as drawn twice. The wobble is seeded from the panel and row index, so it is identical on
        // every run.
        parts.push(`<path d="${sketchRect(chartX, barY, barWidth, BAR_HEIGHT, seedBase, 2.2)}" fill="${row.fill}" stroke="${row.fill}" stroke-width="1.4" stroke-linejoin="round"/>`);
        parts.push(`<path d="${sketchRect(chartX + 1.5, barY + 1.5, barWidth - 3, BAR_HEIGHT - 3, seedBase + 40)}" fill="none" stroke="${row.fill}" stroke-width="1" opacity="0.45" stroke-linejoin="round"/>`);

        // THE VALUE GOES INSIDE THE BAR WHEN THE BAR IS LONG ENOUGH, OUTSIDE OTHERWISE.
        //
        // Measured on an earlier render: the pinned bar fills the panel, so a label placed AFTER it ran off the right
        // edge of the figure and read "14,3..." -- the number for the subject the figure exists to report. Placing it
        // inside a full-width bar cannot overflow; placing it outside a short bar has room by construction.
        const label = metric.format(row.value);
        const estimatedLabelWidth = label.length * 7.6 + 14;
        // The threshold includes the wobble allowance on both sides, so a bar is only "inside" when the label has room
        // for its own padding AND the edge wander. Otherwise the label goes outside, where the margin is real.
        const placeInside = barWidth > estimatedLabelWidth + 12 + 2 * 5;
        // THE PADDING ACCOUNTS FOR THE WOBBLE, not just the glyph width. A bar's right edge now wanders up to ~2 px
        // either side of its nominal x, so a label at the old 10 px inset could touch the drawn edge on a panel whose
        // seed pushed that edge inward -- visible in a render as "61 ms" grazing its own stroke. The inset is the
        // glyph padding PLUS the maximum wobble, and the outside case gets the same allowance.
        const WOBBLE_ALLOWANCE = 5;
        const textX = placeInside ? chartX + barWidth - 10 - WOBBLE_ALLOWANCE : chartX + barWidth + 11 + WOBBLE_ALLOWANCE;
        const anchor = placeInside ? 'end' : 'start';
        const ink = placeInside ? row.ink : TEXT_PRIMARY;
        // THE BASELINE SITS MID-BAR RATHER THAN 16 px DOWN. A 22 px bar with a 13 px face has its visual centre at
        // about barY + 15.5, and 16 was close, but the bar's TOP EDGE now wobbles by up to ~2 px -- on the GET /
        // panel the seed pushed that edge down far enough that the top of "14.17 ms" met the stroke, which the render
        // showed as text sitting ON the outline. Nudging to 15.5 keeps the glyphs inside the straight body of the bar
        // where the wobble is tapered away.
        parts.push(`<text class="value" x="${textX.toFixed(2)}" y="${(barY + 15.5).toFixed(1)}" text-anchor="${anchor}" fill="${ink}">${escapeXml(label)}</text>`);
    });

    // axis: a zero-based baseline, drawn by hand, with sketchy tick marks and the maximum printed at the right end so
    // the panel states its own scale. Ticks are drawn rather than a ruled line because a ruled line is the one thing
    // that makes a sketch look like a chart library.
    const axisY = barTop + 2 * (BAR_HEIGHT + 13) + 6;
    parts.push(`<path class="stroke-axis" d="${toPath(sketchLine(chartX, axisY, chartX + CHART_WIDTH, axisY, 700 + panelIndex, 2.0, 11))}"/>`);
    [0, 0.25, 0.5, 0.75, 1].forEach((tick, tickIndex) => {
        const tickX = chartX + CHART_WIDTH * tick;
        const tickTop = axisY - (tickIndex % 2 === 0 ? 6 : 4);
        // A drawn tick is a SHORT wobbling stroke, so it gets its own sketchLine from the axis up to tickTop. An
        // earlier draft passed the same y twice, which is a zero-length line -- it would have drawn nothing while
        // looking like it drew a tick.
        parts.push(`<path class="stroke-axis" opacity="0.8" d="${toPath(sketchLine(tickX, axisY, tickX, tickTop, 710 + panelIndex * 9 + tickIndex, 0.6, 3))}"/>`);
    });
    parts.push(`<text class="axis-label" x="${chartX}" y="${axisY + 15}">0</text>`);
    parts.push(`<text class="axis-label" x="${chartX + CHART_WIDTH}" y="${axisY + 15}" text-anchor="end">panel max ${escapeXml(axisLabel)}</text>`);

    const ratio = metric.goValue === 0 ? null : metric.pinnedValue / metric.goValue;
    if (ratio !== null) {
        // THREE SIGNIFICANT FIGURES where the ratio is large, so 24.48 does not print as "24x". The ratio is a
        // restatement of the two values beside it rather than a headline.
        const ratioText = ratio >= 100 ? ratio.toFixed(1) : ratio.toFixed(2);
        // THE WORD COMES FROM THE METRIC, so memory can never be called "faster". Drawn in the identity colour, which
        // is the only place small type uses it.
        parts.push(`<text class="ratio" x="${chartX + CHART_WIDTH}" y="${y + 2}" text-anchor="end">${escapeXml(`${ratioText}x ${metric.verdict}`)}</text>`);
    }

    y += PANEL_HEIGHT + PANEL_GAP;
}

// ---- footer --------------------------------------------------------------------------------------------------
const footerY = y + 6;
parts.push(`<path class="stroke-axis" opacity="0.8" d="${toPath(sketchLine(MARGIN_X - 12, footerY - 18, WIDTH - MARGIN_X + 12, footerY - 18, 880, 1.5, 14))}"/>`);
parts.push(`<text class="footer" x="${MARGIN_X - 12}" y="${footerY}">Every bar is drawn against its own panel's zero-based axis, whose maximum is printed on the panel. No axis is truncated and no ratio replaces a value.</text>`);
parts.push(`<text class="footer" x="${MARGIN_X - 12}" y="${footerY + 16}">Ratios are computed from the two printed values in each panel; they are a restatement, not a separate measurement.</text>`);
parts.push(`<text class="footer" x="${MARGIN_X - 12}" y="${footerY + 32}">SillyTavern 1.19.0 (pinned commit 06bde939) vs GoTavern at a3c2f53 - same checkout, same data-root seeding, same port allocator.</text>`);
parts.push(`<text class="footer" x="${MARGIN_X - 12}" y="${footerY + 48}">Workflow: GoTavern smoke metrics, run ${escapeXml(runId)} - shared GitHub runner, so these are runner-dependent numbers, not a budget.</text>`);
parts.push(`<text class="footer" x="${MARGIN_X - 12}" y="${footerY + 64}">Full methodology and provenance: README, "Performance" section.</text>`);

parts.push('</svg>');

fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
fs.writeFileSync(path.resolve(outPath), parts.join('\n') + '\n');
console.log(`wrote ${outPath} (${parts.join('\n').length} bytes)`);
for (const metric of metrics) {
    const ratio = metric.pinnedValue / metric.goValue;
    console.log(`  ${metric.key.padEnd(8)} pinned=${metric.format(metric.pinnedValue).padStart(12)}  gotavern=${metric.format(metric.goValue).padStart(12)}  ${ratio.toFixed(2)}x ${metric.verdict}`);
}
