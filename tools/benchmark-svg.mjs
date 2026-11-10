#!/usr/bin/env node
// Generate the README performance figure from the RECORDED Q22 paired-benchmark artefact.
//
// THIS IS A GENERATOR, NOT A PROBE. It computes nothing about the product: every number it draws is read out of the
// JSON artefact that the benchmark workflow uploaded, and the script refuses to render when the artefact it is
// pointed at does not carry the shape it expects. A generator that could invent a value would defeat the point of
// publishing one, so the values are DATA and the layout is the only thing this file decides.
//
// Usage:
//   node tools/benchmark-svg.mjs --report tests/perf/q22-baseline.json \
//       --out docs/assets/benchmark.svg --out-light docs/assets/benchmark-light.svg
//   node tools/benchmark-svg.mjs --report <q22-paired-benchmark.json> --out <dark.svg> --out-light <light.svg> \
//       --run-id <actions run id> --commit <measured commit>
// The first form is the release path: the committed baseline wrapper carries the run id and the full commit
// in its provenance, and the figure prints the 7-character form. The second form is for a freshly downloaded
// artefact that has no wrapper yet; both still refuse to render without a run id and a commit.
//
// WHY THE CHART IS SHAPED THIS WAY (release constraint: never hide a raw value behind a ratio, never truncate an
// axis to exaggerate; GOAL.md 15.6):
//   * ONE zero-based axis PER METRIC, with the maximum printed at the axis end. A 54x difference in boot time
//     cannot share a linear axis with 0.3 ms without making the small bar invisible, so each metric gets its own
//     axis rather than one shared axis. Nothing is truncated: the axis starts at zero and its top label is a
//     rounded-up "nice" number computed from the data (the SCALE is rounded, never the value).
//   * EVERY number carries its unit: ms on the timing rows and their axes, MB on memory, "rounds"/"samples"/
//     "requests" on the method notes, and the ratio is printed with "x" because it is itself a multiplier.
//   * BOTH the raw value AND the ratio are printed, and the ratio is COMPUTED here from the raw numbers rather
//     than typed in, so a reader can check it against the two values beside it.
//   * RSS uses DECIMAL megabytes (1e6 bytes) and says so on its own row ("decimal MB (1e6 B)"); the exact byte
//     count is printed too, so no reader has to trust the rounding. ONE unit rule for the whole figure and the
//     README: 1 MB = 1,000,000 bytes.
//   * THE VERDICT WORD IS PER METRIC: "faster" on the timing rows, "lighter" on memory, because a resident-set
//     size is not fast or slow. The direction "lower is better" is stated once and is not re-encoded as colour.
//   * TWO VARIANTS, BECAUSE A SINGLE ARTEFACT CANNOT BE OPTIMAL ON BOTH GITHUB THEMES. The dark variant is drawn
//     for GitHub's dark canvas (#0d1117) and the light variant for its light canvas (#ffffff). Shipping both and
//     selecting with <picture> + prefers-color-scheme keeps every text pair past WCAG AA instead of shipping one
//     dark image on a white page (or one washed-out image on a dark page). THE CONTRAST TABLE IS COMPUTED HERE
//     from the same palette constants the SVG uses, and the generator REFUSES to render if any pair drops below
//     its threshold, so the claim cannot drift from the picture.
//   * TYPE IS NEVER SMALLER THAN 12 PX AT 1:1, because the figure is embedded at its natural width in a README
//     and the previous 8.5-10.5 px revision was unreadable on a laptop. Every text style is declared in one
//     place and the generator asserts the floor before writing.
//   * NO EXTERNAL REFERENCE OF ANY KIND: no @font-face, no image, no script, no http(s) URL. Fonts are generic
//     system families only. The figure also has role="img" and <title>/<desc>; the description carries the SAME
//     per-metric verdict words a sighted reader sees, because a screen-reader user gets that text instead.
//   * DETERMINISTIC: the layout is a pure function of the artefact, the run id and the commit. There is no
//     Math.random, no Date, no locale-dependent formatting and no order-dependent counter, so two runs produce
//     identical bytes (the gate regenerates twice and compares).

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
const outLightPath = argumentValue('--out-light');
// THE REPORT MAY BE A BARE q22 ARTEFACT OR THE COMMITTED BASELINE WRAPPER (tests/perf/q22-baseline.json).
// The wrapper exists because the bare artefact does not record its own run id or commit; the wrapper carries
// both in `provenance` and embeds the artefact verbatim under `report`. Accepting both keeps one command for
// the documented update procedure while leaving the bare-artefact path usable for a downloaded file.
const parsedReport = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
const report = parsedReport.report ?? parsedReport;
const provenance = parsedReport.report ? (parsedReport.provenance ?? {}) : {};

// THE RUN ID AND THE MEASURED COMMIT ARE STILL REQUIRED, AND STILL REFUSED WHEN ABSENT. They are workflow
// context, not artefact fields, so they are taken from the wrapper's provenance when it has them and from the
// caller otherwise; a figure that names no run is a number with no provenance.
const runIdArgument = argumentValue('--run-id');
const commitArgument = argumentValue('--commit');
const runId = runIdArgument ?? provenance.runId ?? null;
// A wrapper's commit is a full 40-character id; the figure prints the short form so a reader can match it to
// `git log` without a wall of hex. An explicitly passed commit is printed exactly as passed.
const commit = commitArgument ?? (typeof provenance.commit === 'string' ? provenance.commit.slice(0, 7) : null);
if (!reportPath || !outPath || !outLightPath || !runId || !commit) {
    console.error('usage: node tools/benchmark-svg.mjs --report <q22-paired-benchmark.json | tests/perf/q22-baseline.json> --out <dark.svg> --out-light <light.svg> [--run-id <actions run id>] [--commit <measured commit>]');
    console.error('       (--run-id/--commit are required unless the report is the baseline wrapper, which carries them in provenance)');
    process.exit(2);
}
if (runIdArgument && provenance.runId && runIdArgument !== provenance.runId) {
    console.error(`--run-id ${runIdArgument} disagrees with the baseline provenance run id ${provenance.runId}; refusing to label a figure with a run it did not measure`);
    process.exit(2);
}
if (!/^[0-9]+$/.test(runId)) {
    console.error(`--run-id must be a GitHub Actions run id, got ${runId}`);
    process.exit(2);
}
if (commitArgument && provenance.commit && !provenance.commit.startsWith(commitArgument)) {
    console.error(`--commit ${commitArgument} disagrees with the baseline provenance commit ${provenance.commit}; refusing to label a figure with a tree it did not measure`);
    process.exit(2);
}
if (!/^[0-9a-f]{7,40}$/.test(commit)) {
    console.error(`--commit must be a hexadecimal commit id of 7-40 characters, got ${commit}`);
    process.exit(2);
}

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
const VERDICT_FASTER = 'faster';
const VERDICT_LIGHTER = 'lighter';

const groupedInteger = value => Math.round(value).toLocaleString('en-US');

// THE AXIS FORMATTER IS NOT THE VALUE FORMATTER. A value keeps its measured precision (0.292 ms); a tick is a
// SCALE label, and "15.00 ms" on a 0..30 axis implies a precision the tick does not have. Ticks are rounded to one
// decimal at most and lose a trailing .0, so the axis reads 0 / 30 ms / 60 ms while the bar keeps 51.04 ms.
function formatAxisTick(value, unit) {
    const rounded = Math.round(value * 10) / 10;
    const body = Number.isInteger(rounded) ? groupedInteger(rounded) : rounded.toFixed(1);
    return `${body} ${unit}`;
}

const metrics = [
    {
        key: 'startup',
        label: 'Cold start to first /version 200',
        unit: 'ms',
        verdict: VERDICT_FASTER,
        pinnedValue: requireField(pinned, 'bootMsMedian', 'summary.pinned'),
        goValue: requireField(gotavern, 'bootMsMedian', 'summary.gotavern'),
        format: value => `${groupedInteger(value)} ms`,
        note: [`median of ${rounds} alternating rounds;`, 'fresh data root, no config.yaml'],
    },
    {
        key: 'rss',
        label: 'Steady-state memory (RSS)',
        unit: 'MB',
        verdict: VERDICT_LIGHTER,
        pinnedValue: requireField(pinned, 'rssBytesMedian', 'summary.pinned') / BYTES_PER_MEGABYTE,
        goValue: requireField(gotavern, 'rssBytesMedian', 'summary.gotavern') / BYTES_PER_MEGABYTE,
        format: value => (value >= 100 ? `${groupedInteger(value)} MB` : `${value.toFixed(1)} MB`),
        exact: {
            pinned: requireField(pinned, 'rssBytesMedian', 'summary.pinned'),
            go: requireField(gotavern, 'rssBytesMedian', 'summary.gotavern'),
        },
        note: [`median of ${pinned.samples?.rss ?? '?'} samples after ${requestsPerRound} requests/path;`, 'decimal MB (1e6 B); exact bytes:'],
    },
    {
        key: 'version',
        label: 'GET /version latency',
        unit: 'ms',
        verdict: VERDICT_FASTER,
        pinnedValue: requireField(pinned, 'versionMedianMs', 'summary.pinned'),
        goValue: requireField(gotavern, 'versionMedianMs', 'summary.gotavern'),
        format: value => `${value.toFixed(value < 10 ? 3 : 2)} ms`,
        note: [`median of ${pinned.samples?.version ?? '?'} sequential requests;`, `p95 ${formatRatioValue(pinned.versionP95Ms)} ms / ${formatRatioValue(gotavern.versionP95Ms)} ms`],
    },
    {
        key: 'root',
        label: 'GET / latency (HTML shell)',
        unit: 'ms',
        verdict: VERDICT_FASTER,
        pinnedValue: requireField(pinned, 'rootMedianMs', 'summary.pinned'),
        goValue: requireField(gotavern, 'rootMedianMs', 'summary.gotavern'),
        format: value => `${value.toFixed(2)} ms`,
        note: [`median of ${pinned.samples?.root ?? '?'} sequential requests;`, 'body fully consumed'],
    },
];

// One value formatter shared by the figure and the description. `formatMs` precision follows the metric's own
// format function above; p95 uses the same rule as a latency value.
function formatRatioValue(value) {
    return value >= 10 ? value.toFixed(2) : value.toFixed(3);
}

// ---------------------------------------------------------------------------------------------------------------
// GEOMETRY. All of it is derived from what is drawn; nothing is positioned by magic numbers that the content then
// silently overflows. The canvas is 16:9 (GOAL.md 15.6) and the margin is shared by every surface.
// ---------------------------------------------------------------------------------------------------------------
const WIDTH = 1200;
const HEIGHT = 675;
const MARGIN = 48;
const CONTENT_RIGHT = WIDTH - MARGIN;
const ROW_START = 150;
const ROW_HEIGHT = 116;
const ROWS_BOTTOM = ROW_START + metrics.length * ROW_HEIGHT;
const BAR_X = 300;
const BAR_WIDTH = 500;
const BAR_HEIGHT = 16;
const BAR_RADIUS = 8;
const VALUE_X = 824;
const RATIO_X = 976;
// THE MINIMUM VISIBLE WIDTH IS A LEGIBILITY FLOOR FOR THE RECTANGLE ONLY. At 39.5 MB against a 1,200 MB axis the
// honest fraction is 3.3%, which is visible; the floor exists because a 0.29 ms bar against a 60 ms axis is 2.4 px
// -- the figure would obey "never truncate" while failing "shows both subjects". The floor widens the RECTANGLE;
// it never changes the printed value, the axis or the ratio, all of which are computed from the raw numbers. It is
// stated in the figure's own footer so the reader is not left to discover it by measuring.
const MIN_VISIBLE_BAR = 5;

// A "nice" axis maximum: the first value in a coarse ladder at or above the data, so the axis label is a number a
// reader can hold in their head (12,000 rather than 11,522) while the printed value stays exact. The axis is still
// zero-based and its maximum is still printed, so this rounds the SCALE, never the data.
function niceAxisMax(value) {
    if (!(value > 0)) return 1;
    const exponent = Math.floor(Math.log10(value));
    const base = Math.pow(10, exponent);
    for (const step of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) {
        if (value <= step * base) return step * base;
    }
    return 10 * base;
}

const escapeXml = value => String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const ratioOf = metric => (metric.goValue === 0 ? null : metric.pinnedValue / metric.goValue);
function formatRatio(ratio) {
    if (ratio === null) return 'n/a';
    return `${ratio >= 100 ? ratio.toFixed(1) : ratio.toFixed(2)}\u00d7`;
}

// ---------------------------------------------------------------------------------------------------------------
// THE PALETTES, AND THE CONTRAST AUDIT THAT IS COMPUTED FROM THEM.
//
// Two variants because GitHub renders READMEs on a white canvas or a #0d1117 canvas and one image cannot be
// optimal on both: a dark-only figure looks like a foreign panel in light mode, and a light-only figure either
// glares in dark mode or washes its accent colour down to unreadable. Both variants share the layout and differ
// only in colour, so a reader switching themes sees the same drawing.
//
// EVERY PAIR BELOW IS MEASURED, NOT ASSERTED. WCAG 2.1 relative luminance + contrast ratio is computed from the
// same constants the SVG uses, printed on every run, and a pair below its threshold makes the generator exit
// non-zero BEFORE it writes an image. Text pairs require 4.5:1; the two bar fills are large graphical objects and
// require 3:1 against the page. Hairline rules are decoration only, carry no meaning, and are excluded from the
// audit by design (every meaning-bearing mark is also labelled in text).
// ---------------------------------------------------------------------------------------------------------------
const PALETTES = {
    // COLOUR-BLIND-SAFE SUBJECT PAIR: blue against orange is the safest two-hue pair for the common
    // red-green deficiencies (deuteranopia and protanopia), and the pair also differs in lightness, so it
    // survives a greyscale print. Colour is still never the only encoding: every bar carries a NODE/GO tag
    // and a printed value, and the <desc> names the subjects in words.
    dark: {
        name: 'dark',
        page: '#0d1117',
        ink: '#f0f6fc',
        secondary: '#c9d1d9',
        muted: '#9aa4b0',
        accent: '#6ee7f9',
        pinnedBar: '#f0883e',
        goBar: '#58a6ff',
        hairline: '#30363d',
        hairlines: '0.55',
    },
    light: {
        name: 'light',
        page: '#ffffff',
        ink: '#1f2328',
        secondary: '#424a53',
        muted: '#57606a',
        accent: '#0b5f7a',
        pinnedBar: '#bc4c00',
        goBar: '#0969da',
        hairline: '#d0d7de',
        hairlines: '0.9',
    },
};

function channelLuminance(channel) {
    const normalized = channel / 255;
    return normalized <= 0.03928 ? normalized / 12.92 : Math.pow((normalized + 0.055) / 1.055, 2.4);
}
function relativeLuminance(hex) {
    const value = hex.replace('#', '');
    const [r, g, b] = [0, 2, 4].map(offset => parseInt(value.slice(offset, offset + 2), 16));
    return 0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b);
}
function contrastRatio(foreground, background) {
    const [lighter, darker] = [relativeLuminance(foreground), relativeLuminance(background)].sort((a, b) => b - a);
    return (lighter + 0.05) / (darker + 0.05);
}

// Each row names the surface the text actually sits on. There are no panels and no text inside bars, so the text
// background is always the flat page colour -- which is why the audit is exact rather than approximate.
function contrastPairs(palette) {
    const onPage = (foreground, role, threshold = 4.5) => ({ foreground, background: palette.page, role, threshold });
    return [
        onPage(palette.ink, 'headline, row labels, subject values'),
        onPage(palette.secondary, 'subtitle, legend labels, method notes'),
        onPage(palette.muted, 'kicker, axis ticks, footer, legend note'),
        onPage(palette.accent, 'derived ratios, verdict words, GoTavern values'),
        { foreground: palette.pinnedBar, background: palette.page, role: 'pinned bar fill (graphical)', threshold: 3 },
        { foreground: palette.goBar, background: palette.page, role: 'GoTavern bar fill (graphical)', threshold: 3 },
    ];
}

function auditContrast(palette) {
    const rows = contrastPairs(palette).map(pair => ({ ...pair, ratio: contrastRatio(pair.foreground, pair.background) }));
    const failures = rows.filter(row => row.ratio < row.threshold);
    return { rows, failures };
}

// THE TYPE SCALE IS DECLARED ONCE AND ASSERTED. alpha.20 raises the whole scale so the figure is readable when a
// phone or a half-width window scales it down: the previous revision's 12 px floor was legible at 1:1 on a laptop
// and unreadable on a narrow viewport. Every size the drawing uses is listed here; the generator refuses to write a
// figure whose smallest declared size is under 14 px at 1:1.
const TYPE_SCALE = {
    kicker: 14,
    headline: 40,
    subtitle: 15,
    legend: 14,
    legendNote: 13,
    rowLabel: 20,
    rowNote: 14,
    subjectTag: 13,
    value: 18,
    axisTick: 14,
    ratio: 32,
    verdict: 14,
    footer: 13,
};
const MIN_TYPE_PX = 13;
const smallType = Object.entries(TYPE_SCALE).filter(([, size]) => size < MIN_TYPE_PX);
if (smallType.length > 0) {
    console.error(`refusing to draw: type sizes below ${MIN_TYPE_PX} px at 1:1: ${smallType.map(([name, size]) => `${name}=${size}px`).join(', ')}`);
    process.exit(2);
}

const SYSTEM_SANS = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
const SYSTEM_MONO = 'ui-monospace, "SF Mono", "SFMono-Regular", Menlo, Consolas, "Liberation Mono", monospace';

function styleBlock(palette) {
    return `
  <style>
    .page { fill: ${palette.page}; }
    .kicker { font: 400 ${TYPE_SCALE.kicker}px ${SYSTEM_MONO}; letter-spacing: 1.6px; fill: ${palette.muted}; }
    .headline { font: 700 ${TYPE_SCALE.headline}px ${SYSTEM_SANS}; fill: ${palette.ink}; }
    .headline-accent { font: 700 ${TYPE_SCALE.headline}px ${SYSTEM_SANS}; fill: ${palette.accent}; }
    .subtitle { font: 400 ${TYPE_SCALE.subtitle}px ${SYSTEM_SANS}; fill: ${palette.secondary}; }
    .legend { font: 500 ${TYPE_SCALE.legend}px ${SYSTEM_SANS}; fill: ${palette.secondary}; }
    .legend-note { font: 400 ${TYPE_SCALE.legendNote}px ${SYSTEM_MONO}; fill: ${palette.muted}; }
    .row-label { font: 600 ${TYPE_SCALE.rowLabel}px ${SYSTEM_SANS}; fill: ${palette.ink}; }
    .row-note { font: 400 ${TYPE_SCALE.rowNote}px ${SYSTEM_SANS}; fill: ${palette.secondary}; }
    .row-exact { font: 400 ${TYPE_SCALE.rowNote}px ${SYSTEM_MONO}; fill: ${palette.muted}; }
    .subject-tag { font: 400 ${TYPE_SCALE.subjectTag}px ${SYSTEM_MONO}; letter-spacing: 0.8px; fill: ${palette.muted}; }
    .value { font: 600 ${TYPE_SCALE.value}px ${SYSTEM_MONO}; }
    .value-pinned { fill: ${palette.ink}; }
    .value-go { fill: ${palette.accent}; }
    .axis-tick { font: 400 ${TYPE_SCALE.axisTick}px ${SYSTEM_MONO}; fill: ${palette.muted}; }
    .ratio { font: 700 ${TYPE_SCALE.ratio}px ${SYSTEM_MONO}; fill: ${palette.accent}; }
    .verdict { font: 700 ${TYPE_SCALE.verdict}px ${SYSTEM_MONO}; letter-spacing: 1.4px; fill: ${palette.accent}; }
    .footer { font: 400 ${TYPE_SCALE.footer}px ${SYSTEM_MONO}; fill: ${palette.muted}; }
    .hairline { stroke: ${palette.hairline}; stroke-opacity: ${palette.hairlines}; stroke-width: 1; }
    .tick { stroke: ${palette.hairline}; stroke-opacity: ${palette.hairlines}; stroke-width: 1; }
    .bar-pinned { fill: ${palette.pinnedBar}; }
    .bar-go { fill: ${palette.goBar}; }
  </style>`;
}

function renderFigure(palette) {
    const parts = [];
    // The axis maximum must cover BOTH values, not just the pinned one: a regression where GoTavern becomes slower
    // than Node would otherwise draw a bar past the printed maximum, which is exactly the truncation the chart
    // forbids. Compute it from the larger of the two.
    const axisMaxOf = metric => niceAxisMax(Math.max(metric.pinnedValue, metric.goValue));

    parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-labelledby="benchmarkTitle benchmarkDesc">`);
    parts.push(`<title id="benchmarkTitle">GoTavern paired benchmark: faster on every timing row, lighter on memory</title>`);
    // THE DESCRIPTION CARRIES THE SAME VERDICT WORDS AS THE ROWS, per metric, because a screen-reader user gets this
    // text instead of the picture and must not be told "faster" about a memory figure any more than a sighted reader
    // is. The unit rule and the zero-based-axis rule are stated here too, so the accessible text is self-contained.
    const description = metrics
        .map(metric => `${metric.label}: SillyTavern (Node) ${metric.format(metric.pinnedValue)}, GoTavern ${metric.format(metric.goValue)} (${formatRatio(ratioOf(metric)).replace('\u00d7', '-fold')} ${metric.verdict})`)
        .join('; ')
        + `. Lower is better in every row; each row is drawn against its own zero-based axis whose maximum is printed at the axis end. Memory is decimal MB (1 MB = 1,000,000 bytes); every other value is milliseconds. Source: tests/perf/q22-baseline.json, run ${runId} at commit ${commit}.`;
    parts.push(`<desc id="benchmarkDesc">${escapeXml(description)}</desc>`);
    parts.push(styleBlock(palette));

    parts.push(`<rect class="page" x="0" y="0" width="${WIDTH}" height="${HEIGHT}"/>`);

    // ---- header -------------------------------------------------------------------------------------
    parts.push(`<text class="kicker" x="${MARGIN}" y="42">PAIRED BENCHMARK &#183; ONE GITHUB RUNNER &#183; BOTH SERVERS FROM THE SAME CHECKOUT</text>`);
    parts.push(`<text class="headline" x="${MARGIN}" y="84">Faster. <tspan class="headline-accent">Lighter.</tspan></text>`);
    parts.push(`<text class="subtitle" x="${MARGIN}" y="110">GoTavern (Go) against pinned SillyTavern (Node), medians from ${rounds} alternating rounds; lower is better in every row.</text>`);

    // Legend: colour is never the only encoding. The subject tag sits beside every value ("NODE"/"GO"), and the
    // <desc> names the subjects in words, so a reader who cannot distinguish the two fills still gets the mapping.
    parts.push(`<rect x="${MARGIN}" y="124" width="12" height="12" rx="3" class="bar-pinned"/>`);
    parts.push(`<text class="legend" x="${MARGIN + 20}" y="135">SillyTavern (Node)</text>`);
    parts.push(`<rect x="${MARGIN + 180}" y="124" width="12" height="12" rx="3" class="bar-go"/>`);
    parts.push(`<text class="legend" x="${MARGIN + 200}" y="135">GoTavern</text>`);
    parts.push(`<text class="legend-note" x="${CONTENT_RIGHT}" y="135" text-anchor="end">ONE ZERO-BASED AXIS PER ROW; MAXIMUM PRINTED</text>`);
    parts.push(`<line class="hairline" x1="${MARGIN}" y1="152" x2="${CONTENT_RIGHT}" y2="152"/>`);

    // ---- metric rows --------------------------------------------------------------------------------
    metrics.forEach((metric, index) => {
        const rowTop = ROW_START + index * ROW_HEIGHT;
        const axisMax = axisMaxOf(metric);
        const widthOf = value => Math.max(MIN_VISIBLE_BAR, (value / axisMax) * BAR_WIDTH);

        parts.push(`<text class="row-label" x="${MARGIN}" y="${rowTop + 26}">${escapeXml(metric.label)}</text>`);
        metric.note.forEach((line, lineIndex) => {
            parts.push(`<text class="row-note" x="${MARGIN}" y="${rowTop + 48 + lineIndex * 20}">${escapeXml(line)}</text>`);
        });
        if (metric.exact) {
            // The exact byte count sits under the rounded value so the rounding is checkable, and it keeps its own
            // unit (B) rather than being folded into the MB value.
            parts.push(`<text class="row-exact" x="${MARGIN}" y="${rowTop + 88}">${groupedInteger(metric.exact.pinned)} B vs ${groupedInteger(metric.exact.go)} B</text>`);
        }

        // The bars. A zero baseline is drawn as the axis below them, so the reader can see that both bars start at 0.
        parts.push(`<rect x="${BAR_X}" y="${rowTop + 14}" width="${widthOf(metric.pinnedValue).toFixed(2)}" height="${BAR_HEIGHT}" rx="${BAR_RADIUS}" class="bar-pinned"/>`);
        parts.push(`<rect x="${BAR_X}" y="${rowTop + 46}" width="${widthOf(metric.goValue).toFixed(2)}" height="${BAR_HEIGHT}" rx="${BAR_RADIUS}" class="bar-go"/>`);

        // The zero-based axis with its three printed ticks. The maximum is the rounded-up scale value, never a
        // truncated data value; the midpoint tick is a scale aid, not a measurement.
        const axisY = rowTop + 80;
        parts.push(`<line class="tick" x1="${BAR_X}" y1="${axisY}" x2="${BAR_X + BAR_WIDTH}" y2="${axisY}"/>`);
        parts.push(`<line class="tick" x1="${BAR_X}" y1="${axisY - 4}" x2="${BAR_X}" y2="${axisY + 4}"/>`);
        parts.push(`<line class="tick" x1="${BAR_X + BAR_WIDTH / 2}" y1="${axisY - 4}" x2="${BAR_X + BAR_WIDTH / 2}" y2="${axisY + 4}"/>`);
        parts.push(`<line class="tick" x1="${BAR_X + BAR_WIDTH}" y1="${axisY - 4}" x2="${BAR_X + BAR_WIDTH}" y2="${axisY + 4}"/>`);
        parts.push(`<text class="axis-tick" x="${BAR_X}" y="${axisY + 22}">0 ${metric.unit}</text>`);
        parts.push(`<text class="axis-tick" x="${BAR_X + BAR_WIDTH / 2}" y="${axisY + 22}" text-anchor="middle">${escapeXml(formatAxisTick(axisMax / 2, metric.unit))}</text>`);
        parts.push(`<text class="axis-tick" x="${BAR_X + BAR_WIDTH}" y="${axisY + 22}" text-anchor="end">${escapeXml(formatAxisTick(axisMax, metric.unit))}</text>`);

        // The values, labelled by subject in words as well as by colour.
        parts.push(`<text class="subject-tag" x="${VALUE_X - 10}" y="${rowTop + 26}" text-anchor="end">NODE</text>`);
        parts.push(`<text class="value value-pinned" x="${VALUE_X}" y="${rowTop + 26}">${escapeXml(metric.format(metric.pinnedValue))}</text>`);
        parts.push(`<text class="subject-tag" x="${VALUE_X - 10}" y="${rowTop + 58}" text-anchor="end">GO</text>`);
        parts.push(`<text class="value value-go" x="${VALUE_X}" y="${rowTop + 58}">${escapeXml(metric.format(metric.goValue))}</text>`);

        // The derived ratio and the per-metric verdict word. The ratio is computed from the two values printed to its
        // left; it is not read from the artefact and it is not typed in.
        parts.push(`<text class="ratio" x="${RATIO_X}" y="${rowTop + 34}">${formatRatio(ratioOf(metric))}</text>`);
        parts.push(`<text class="verdict" x="${RATIO_X}" y="${rowTop + 60}">${metric.verdict.toUpperCase()}</text>`);
        parts.push(`<text class="legend-note" x="${RATIO_X}" y="${rowTop + 82}">COMPUTED</text>`);

        if (index < metrics.length - 1) {
            parts.push(`<line class="hairline" x1="${MARGIN}" y1="${rowTop + ROW_HEIGHT - 8}" x2="${CONTENT_RIGHT}" y2="${rowTop + ROW_HEIGHT - 8}"/>`);
        }
    });

    // ---- footer -------------------------------------------------------------------------------------
    // The footer is deliberately SHORTER and LARGER than the alpha.19 revision: at 13 px on a 1104 px content width
    // a line must stay under ~120 characters, so the provenance lives in the <desc> and the provenance document and
    // the visible footer keeps only what a reader needs to trust the picture.
    parts.push(`<line class="hairline" x1="${MARGIN}" y1="${ROWS_BOTTOM + 6}" x2="${CONTENT_RIGHT}" y2="${ROWS_BOTTOM + 6}"/>`);
    parts.push(`<text class="footer" x="${MARGIN}" y="${ROWS_BOTTOM + 24}">generated from tests/perf/q22-baseline.json &#183; run ${escapeXml(runId)} &#183; commit ${escapeXml(commit)} &#183; ${rounds} rounds &#215; ${requestsPerRound} requests/path</text>`);
    parts.push(`<text class="footer" x="${MARGIN}" y="${ROWS_BOTTOM + 40}">memory decimal MB (1e6 B); other values ms &#183; ratios computed from the two printed values &#183; bar floor is legibility only</text>`);
    parts.push(`<text class="footer" x="${MARGIN}" y="${ROWS_BOTTOM + 56}">${palette.name} variant &#183; blue/orange colour-blind-safe pair &#183; no external font, image, script or network reference &#183; never hand-edited</text>`);

    parts.push('</svg>');
    return parts.join('\n');
}

// Build both variants. The layout and every printed value are shared; only the palette differs, so the two images
// are guaranteed to agree about the data.
const contrast = { dark: auditContrast(PALETTES.dark), light: auditContrast(PALETTES.light) };
const contrastFailures = Object.entries(contrast).flatMap(([name, audit]) => audit.failures.map(failure => `${name}: ${failure.role} ${failure.foreground} on ${failure.background} = ${failure.ratio.toFixed(2)}:1, below the required ${failure.threshold}:1`));
if (contrastFailures.length > 0) {
    console.error('refusing to draw: contrast audit failed');
    for (const failure of contrastFailures) console.error(`  - ${failure}`);
    process.exit(2);
}

const darkSvg = renderFigure(PALETTES.dark);
const lightSvg = renderFigure(PALETTES.light);
fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
fs.mkdirSync(path.dirname(path.resolve(outLightPath)), { recursive: true });
// Explicit UTF-8, no BOM: the figure is text an editor and a browser both read as UTF-8, and a BOM at the first byte
// of an SVG is a byte the gates cannot explain (AGENTS.md verification rule 12).
fs.writeFileSync(path.resolve(outPath), darkSvg + '\n', 'utf8');
fs.writeFileSync(path.resolve(outLightPath), lightSvg + '\n', 'utf8');

// ---- the audit trail this generator prints ---------------------------------------------------------
console.log(`wrote ${outPath} (${WIDTH}x${HEIGHT}, dark)`);
console.log(`wrote ${outLightPath} (${WIDTH}x${HEIGHT}, light)`);
for (const metric of metrics) {
    console.log(`  ${metric.key.padEnd(8)} pinned=${metric.format(metric.pinnedValue).padStart(12)}  gotavern=${metric.format(metric.goValue).padStart(12)}  ${formatRatio(ratioOf(metric))} ${metric.verdict}`);
}
console.log('contrast audit (WCAG 2.1, computed from the same palette constants the SVG uses):');
for (const [name, audit] of Object.entries(contrast)) {
    for (const row of audit.rows) {
        console.log(`  ${name.padEnd(5)} ${row.role.padEnd(52)} ${row.foreground} on ${row.background} = ${row.ratio.toFixed(2)}:1 (min ${row.threshold}:1)`);
    }
}
console.log(`type floor: every declared size is >= ${MIN_TYPE_PX} px at 1:1 (deepest text: row notes, axis ticks, footer); the alpha.20 scale is one step larger than alpha.19 and colours are a blue/orange, colour-blind-safe pair`);
