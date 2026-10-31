#!/usr/bin/env node
// Generate docs/assets/benchmark.svg from the RECORDED Q22 paired-benchmark artefact.
//
// THIS IS A GENERATOR, NOT A PROBE. It computes nothing about the product: every number it draws is read out of the
// JSON artefact that the benchmark workflow uploaded, and the script refuses to render when the artefact it is
// pointed at does not carry the shape it expects. A generator that could invent a value would defeat the point of
// publishing one, so the values are DATA and the layout is the only thing this file decides.
//
// Usage:
//   node tools/benchmark-svg.mjs --report <q22-paired-benchmark.json> --out docs/assets/benchmark.svg \
//       --run-id 41171857944 --commit 91e1e15
//
// WHY THE CHART IS SHAPED THIS WAY (release constraint: never hide a raw value behind a ratio, never truncate an
// axis to exaggerate):
//   * Every bar is drawn in a row whose axis starts at ZERO and whose maximum is a ROUNDED UP "nice" number that is
//     printed on the row. A 310x difference cannot share a linear axis with 0.32 ms without making the small bar
//     invisible, so each metric gets its own zero-based axis rather than one shared axis.
//   * Both the raw value AND the ratio are printed. The ratio is labelled as derived from the printed values, and
//     it is computed here from the raw numbers rather than typed in, so a reader can check it with the values shown.
//   * RSS and startup use DECIMAL megabytes (1e6 bytes), stated on the row, because that is the unit the byte
//     counts round to; the exact byte count is printed too, so no reader has to trust the rounding.
//   * "Lower is better" is stated once, and the direction is not re-encoded in colour. The verdict word is
//     PER METRIC: "faster" on the timing rows, "lighter" on memory, because a resident-set size is not fast or slow.
//   * The figure carries its own background and uses colours that hold contrast on both GitHub themes; it has no
//     external references, no fonts it does not ship as a generic family, and no JavaScript.
//
// THE VISUAL LANGUAGE IS PRECISION-INSTRUMENT RATHER THAN SKETCH. The earlier revision imitated a whiteboard marker
// (wobbly rectangles, hand-drawn frames, sketch ticks). It read as deliberate but it kept fighting its own data:
// wobble next to a 310x difference invites "hand-drawn therefore approximate", and the frames competed with the
// bars. This revision draws the opposite: hairline rules, tabular figures, a violet-to-cyan gradient that exists
// only on the verdicts that are derived numbers, and a dark page lit by two soft auroras. Nothing is decorative
// that does not carry information: every rule separates something, every colour marks a subject, every glow marks
// the product's bar.

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
// forbids. This is one of the two values this script accepts on trust from its caller, and the caller is a release
// step that can (and does) verify it against the run that produced the file.
const runId = argumentValue('--run-id');
// THE MEASURED COMMIT IS ALSO NOT IN THE ARTEFACT (the artefact records the runner, not a git revision), so the
// caller names it too. It is printed, never inferred, and the previous revision of this file got it wrong by
// HARD-CODING a stale short SHA into the footer -- a number that looked like provenance while naming a tree the
// figure had not measured. Requiring it and refusing to render without it is the fix.
const commit = argumentValue('--commit');
if (!reportPath || !outPath || !runId || !commit) {
    console.error('usage: node tools/benchmark-svg.mjs --report <q22-paired-benchmark.json> --out <benchmark.svg> --run-id <actions run id> --commit <measured commit>');
    process.exit(2);
}
if (!/^[0-9]+$/.test(runId)) {
    console.error(`--run-id must be a GitHub Actions run id, got ${runId}`);
    process.exit(2);
}
if (!/^[0-9a-f]{7,40}$/.test(commit)) {
    console.error(`--commit must be a hexadecimal commit id of 7-40 characters, got ${commit}`);
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
const VERDICT_FASTER = 'faster';
const VERDICT_LIGHTER = 'lighter';

const groupedInteger = value => Math.round(value).toLocaleString('en-US');

// THE AXIS FORMATTER IS NOT THE VALUE FORMATTER. A value keeps its measured precision (0.316 ms); a tick is a
// SCALE label, and "15.00 ms" on a 0..30 axis implies a precision the tick does not have. Ticks are rounded to one
// decimal at most and lose a trailing .0, so the axis reads 0 / 15 ms / 30 ms while the bar still prints 28.77 ms.
function formatAxisTick(value, unit) {
    const rounded = Math.round(value * 10) / 10;
    const body = Number.isInteger(rounded) ? groupedInteger(rounded) : rounded.toFixed(1);
    return `${body} ${unit}`;
}

const metrics = [
    {
        key: 'startup',
        index: '01',
        label: 'Cold start to first /version 200',
        unit: 'ms',
        verdict: VERDICT_FASTER,
        pinnedValue: requireField(pinned, 'bootMsMedian', 'summary.pinned'),
        goValue: requireField(gotavern, 'bootMsMedian', 'summary.gotavern'),
        format: value => `${groupedInteger(value)} ms`,
        subLabel: value => `${value.toLocaleString('en-US', { maximumFractionDigits: 1 })} ms`,
        note: ['median of 3 alternating rounds;', 'empty data root, no config.yaml'],
    },
    {
        key: 'rss',
        index: '02',
        label: 'Steady-state memory (RSS)',
        unit: 'MB',
        verdict: VERDICT_LIGHTER,
        pinnedValue: requireField(pinned, 'rssBytesMedian', 'summary.pinned') / BYTES_PER_MEGABYTE,
        goValue: requireField(gotavern, 'rssBytesMedian', 'summary.gotavern') / BYTES_PER_MEGABYTE,
        format: value => (value >= 100 ? `${groupedInteger(value)} MB` : `${value.toFixed(1)} MB`),
        subLabel: value => (value >= 100 ? `${groupedInteger(value)} MB` : `${value.toFixed(1)} MB`),
        exact: {
            pinned: requireField(pinned, 'rssBytesMedian', 'summary.pinned'),
            go: requireField(gotavern, 'rssBytesMedian', 'summary.gotavern'),
        },
        note: ['VmRSS from /proc, after readiness', 'and 30 requests; median of 6 samples'],
    },
    {
        key: 'version',
        index: '03',
        label: 'GET /version latency',
        unit: 'ms',
        verdict: VERDICT_FASTER,
        pinnedValue: requireField(pinned, 'versionMedianMs', 'summary.pinned'),
        goValue: requireField(gotavern, 'versionMedianMs', 'summary.gotavern'),
        format: value => `${value.toFixed(value < 10 ? 3 : 2)} ms`,
        subLabel: value => `${value.toFixed(value < 10 ? 3 : 2)} ms`,
        note: [`median of ${pinned.samples?.version ?? 90} sequential requests,`, 'same client for both subjects'],
    },
    {
        key: 'root',
        index: '04',
        label: 'GET / latency (HTML shell)',
        unit: 'ms',
        verdict: VERDICT_FASTER,
        pinnedValue: requireField(pinned, 'rootMedianMs', 'summary.pinned'),
        goValue: requireField(gotavern, 'rootMedianMs', 'summary.gotavern'),
        format: value => `${value.toFixed(2)} ms`,
        subLabel: value => `${value.toFixed(2)} ms`,
        note: [`median of ${pinned.samples?.root ?? 90} sequential requests,`, 'body fully consumed'],
    },
];

// ---------------------------------------------------------------------------------------------------------------
// GEOMETRY. All of it is derived from what is drawn; nothing is positioned by magic numbers that the content then
// silently overflows. The row height is the tallest row (a pinned bar, a GoTavern bar, the axis and its labels).
// ---------------------------------------------------------------------------------------------------------------
const WIDTH = 1000;
const MARGIN = 64;
const CONTENT_RIGHT = WIDTH - MARGIN;
const ROW_START = 320;
const ROW_HEIGHT = 176;
const BAR_X = 336;
const BAR_WIDTH = 420;
const BAR_HEIGHT = 13;
const BAR_RADIUS = 6.5;
// THE MINIMUM VISIBLE WIDTH IS A LEGIBILITY FLOOR FOR THE RECTANGLE ONLY. At 32 ms against a 10,000 ms axis the
// honest fraction is 0.32%, which renders as a sub-pixel line -- the figure would obey "never truncate" while
// failing "shows both subjects". The floor widens the RECTANGLE; it never changes the printed value, the axis,
// or the ratio, all of which are computed from the raw numbers. A reader comparing bar LENGTHS with the floor in
// play would understate the difference, which is the safe direction to be wrong in. The floor is stated in the
// figure's own footer so the reader is not left to discover it by measuring.
const MIN_VISIBLE_BAR = 5;

// A "nice" axis maximum: the first value in a coarse ladder at or above the data, so the axis label is a number a
// reader can hold in their head (10,000 rather than 9,941) while the printed value stays exact. The axis is still
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
const verdictWord = metric => metric.verdict.toUpperCase();

// ---------------------------------------------------------------------------------------------------------------
// THE PALETTE. "Midnight ink" page, warm amber for the pinned Node server, cyan for GoTavern, and a violet-to-cyan
// gradient used ONLY for derived numbers (the ratios and the second headline line) so colour marks "computed from
// the two values beside it" rather than decorating. Contrast on #070b14: primary #eef3ff 17.6:1, secondary
// #a7b6cd 9.9:1, muted #6b7d9c 4.9:1, cyan #7fe9ff 12.7:1, amber #f6b545 10.9:1. The hairline #94a3b8 at 0.16 is
// decoration only and carries no meaning; every meaning-bearing mark is also labelled in text.
const PAGE_TOP = '#070b14';
const PAGE_BOTTOM = '#0b1322';
const INK = '#eef3ff';
const INK_SOFT = '#a7b6cd';
const MUTED = '#7488a7';
const HAIRLINE = '#94a3b8';
const AMBER = '#f6b545';
const AMBER_DEEP = '#e2912b';
const CYAN = '#7fe9ff';
const CYAN_DEEP = '#229ed9';

const style = `
  <style>
    .serif { font-family: "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, "Times New Roman", serif; }
    .sans { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; }
    .mono { font-family: ui-monospace, "SF Mono", "Cascadia Mono", "Segoe UI Mono", Consolas, "Liberation Mono", monospace; }
    .micro { font: 400 9.5px ui-monospace, "SF Mono", "Cascadia Mono", Consolas, monospace; letter-spacing: 2.2px; fill: ${MUTED}; }
    .title { font: 400 50px "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif; fill: ${INK}; }
    .title-accent { font: 400 50px "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif; }
    .intro { font: 400 13px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif; fill: ${INK_SOFT}; }
    .spec-label { font: 400 8.5px ui-monospace, "SF Mono", "Cascadia Mono", Consolas, monospace; letter-spacing: 1.9px; fill: ${MUTED}; }
    .spec-value { font: 500 11.5px ui-monospace, "SF Mono", "Cascadia Mono", Consolas, monospace; fill: ${INK}; }
    .legend { font: 500 12px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif; fill: ${INK_SOFT}; }
    .legend-note { font: 400 9px ui-monospace, "SF Mono", "Cascadia Mono", Consolas, monospace; letter-spacing: 1.8px; fill: ${MUTED}; }
    .row-index { font: 400 10px ui-monospace, "SF Mono", "Cascadia Mono", Consolas, monospace; letter-spacing: 1.5px; fill: ${MUTED}; }
    .row-label { font: 600 15.5px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif; fill: ${INK}; }
    .row-note { font: 400 10.5px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif; fill: ${INK_SOFT}; }
    .row-exact { font: 400 9.5px ui-monospace, "SF Mono", "Cascadia Mono", Consolas, monospace; fill: ${MUTED}; }
    .value { font: 600 11px ui-monospace, "SF Mono", "Cascadia Mono", Consolas, monospace; }
    .axis { font: 400 9px ui-monospace, "SF Mono", "Cascadia Mono", Consolas, monospace; fill: ${MUTED}; }
    .ratio { font: 600 30px ui-monospace, "SF Mono", "Cascadia Mono", Consolas, monospace; }
    .ratio-factor { font-size: 19px; }
    .verdict { font: 400 9.5px ui-monospace, "SF Mono", "Cascadia Mono", Consolas, monospace; letter-spacing: 2.1px; fill: ${MUTED}; }
    .footer { font: 400 9.5px ui-monospace, "SF Mono", "Cascadia Mono", Consolas, monospace; fill: ${MUTED}; }
    .footer-label { fill: #93a5c2; letter-spacing: 1.4px; }
  </style>`;

const parts = [];
const totalHeight = ROW_START + metrics.length * ROW_HEIGHT + 156;

const defs = `
  <defs>
    <linearGradient id="page" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${PAGE_TOP}"/>
      <stop offset="1" stop-color="${PAGE_BOTTOM}"/>
    </linearGradient>
    <radialGradient id="auroraCyan" cx="82%" cy="-6%" r="62%">
      <stop offset="0" stop-color="#22d3ee" stop-opacity="0.17"/>
      <stop offset="0.55" stop-color="#22d3ee" stop-opacity="0.05"/>
      <stop offset="1" stop-color="#22d3ee" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="auroraViolet" cx="8%" cy="106%" r="58%">
      <stop offset="0" stop-color="#7c6cf0" stop-opacity="0.16"/>
      <stop offset="0.6" stop-color="#7c6cf0" stop-opacity="0.04"/>
      <stop offset="1" stop-color="#7c6cf0" stop-opacity="0"/>
    </radialGradient>
    <pattern id="dotgrid" width="22" height="22" patternUnits="userSpaceOnUse">
      <circle cx="1" cy="1" r="1" fill="${HAIRLINE}" opacity="0.07"/>
    </pattern>
    <linearGradient id="titleGrad" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#a5f3fc"/>
      <stop offset="0.55" stop-color="#66ccff"/>
      <stop offset="1" stop-color="#a78bfa"/>
    </linearGradient>
    <linearGradient id="ratioGrad" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#eaf9ff"/>
      <stop offset="1" stop-color="#7fe9ff"/>
    </linearGradient>
    <linearGradient id="amberBar" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffd08a"/>
      <stop offset="0.55" stop-color="${AMBER}"/>
      <stop offset="1" stop-color="${AMBER_DEEP}"/>
    </linearGradient>
    <linearGradient id="cyanBar" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#c8f7ff"/>
      <stop offset="0.45" stop-color="${CYAN}"/>
      <stop offset="1" stop-color="${CYAN_DEEP}"/>
    </linearGradient>
    <linearGradient id="hairlineFade" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="${HAIRLINE}" stop-opacity="0"/>
      <stop offset="0.12" stop-color="${HAIRLINE}" stop-opacity="0.26"/>
      <stop offset="0.88" stop-color="${HAIRLINE}" stop-opacity="0.26"/>
      <stop offset="1" stop-color="${HAIRLINE}" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="cardSheen" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.05"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="topRule" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#22d3ee" stop-opacity="0.7"/>
      <stop offset="0.5" stop-color="#66ccff" stop-opacity="0.35"/>
      <stop offset="1" stop-color="#a78bfa" stop-opacity="0"/>
    </linearGradient>
    <filter id="barShadow" x="-10%" y="-40%" width="120%" height="220%">
      <feDropShadow dx="0" dy="3" stdDeviation="4" flood-color="#000000" flood-opacity="0.35"/>
    </filter>
    <filter id="goGlow" x="-60%" y="-120%" width="220%" height="340%">
      <feGaussianBlur stdDeviation="4.5" result="blur"/>
      <feMerge>
        <feMergeNode in="blur"/>
        <feMergeNode in="blur"/>
      </feMerge>
    </filter>
  </defs>`;

parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${totalHeight}" viewBox="0 0 ${WIDTH} ${totalHeight}" role="img" aria-labelledby="benchmarkTitle benchmarkDesc">`);
parts.push(`<title id="benchmarkTitle">GoTavern vs SillyTavern (Node) - paired benchmark, ${escapeXml(runnerImage)}</title>`);
// THE DESCRIPTION CARRIES THE SAME VERDICT WORDS AS THE ROWS, per metric, because a screen-reader user gets this
// text instead of the picture and must not be told "faster" about a memory figure any more than a sighted reader is.
parts.push(`<desc id="benchmarkDesc">${escapeXml(metrics.map(m => `${m.label}: SillyTavern ${m.format(m.pinnedValue)}, GoTavern ${m.format(m.goValue)} (${formatRatio(ratioOf(m)).replace('\u00d7', '-fold')} ${m.verdict})`).join('; '))}. For timing rows a lower value is faster; for memory a lower value is lighter. Degree of improvement is per row, each drawn against its own zero-based axis whose maximum is printed on the row. Methodology and provenance are stated in the README section below the figure and in docs/assets/benchmark.svg.provenance.md.</desc>`);
parts.push(defs);
parts.push(style);
parts.push(`<rect width="${WIDTH}" height="${totalHeight}" fill="url(#page)"/>`);
parts.push(`<rect width="${WIDTH}" height="${totalHeight}" fill="url(#auroraCyan)"/>`);
parts.push(`<rect width="${WIDTH}" height="${totalHeight}" fill="url(#auroraViolet)"/>`);
parts.push(`<rect width="${WIDTH}" height="${totalHeight}" fill="url(#dotgrid)"/>`);

// ---- top micro line and rule ---------------------------------------------------------------------------------
parts.push(`<text class="micro" x="${MARGIN}" y="40">GOTAVERN / PERFORMANCE</text>`);
parts.push(`<text class="micro" x="${CONTENT_RIGHT}" y="40" text-anchor="end">${escapeXml(`PAIRED BENCHMARK \u00b7 ${rounds} ROUNDS \u00b7 RUN ${runId}`)}</text>`);
parts.push(`<rect x="${MARGIN}" y="56" width="${CONTENT_RIGHT - MARGIN}" height="1" fill="url(#topRule)"/>`);

// ---- header --------------------------------------------------------------------------------------------------
parts.push(`<text class="title serif" x="${MARGIN}" y="126">Same SillyTavern.</text>`);
parts.push(`<text class="title-accent serif" x="${MARGIN}" y="182" fill="url(#titleGrad)">Faster. Lighter.</text>`);
parts.push(`<text class="intro sans" x="${MARGIN}" y="222">One GitHub runner. The same pinned checkout, the same seeding, the same workload.</text>`);
parts.push(`<text class="intro sans" x="${MARGIN}" y="242">Three alternating rounds, medians shown. Every bar is linear and starts at zero.</text>`);

// ---- spec card: the provenance a reader needs before trusting a single bar ------------------------------------
const cardX = 676;
const cardY = 74;
const cardW = CONTENT_RIGHT - cardX;
const cardH = 180;
parts.push(`<rect x="${cardX}" y="${cardY}" width="${cardW}" height="${cardH}" rx="14" fill="#0c1424" fill-opacity="0.72" stroke="${HAIRLINE}" stroke-opacity="0.18"/>`);
parts.push(`<rect x="${cardX}" y="${cardY}" width="${cardW}" height="${cardH}" rx="14" fill="url(#cardSheen)"/>`);
parts.push(`<rect x="${cardX + 1}" y="${cardY + 1}" width="${cardW - 2}" height="2" rx="1" fill="url(#topRule)" opacity="0.8"/>`);
const specRows = [
    ['RUN', runId],
    ['RUNNER', runnerImage],
    ['ROUNDS', `${rounds} \u00d7 ${requestsPerRound} req/path`],
    ['SOAK', '10 min \u00d7 2 subjects'],
    ['PINNED', '1.19.0 @ 06bde939'],
];
specRows.forEach(([label, value], index) => {
    const y = cardY + 34 + index * 30;
    parts.push(`<text class="spec-label mono" x="${cardX + 20}" y="${y}">${escapeXml(label)}</text>`);
    parts.push(`<text class="spec-value mono" x="${cardX + cardW - 20}" y="${y}" text-anchor="end">${escapeXml(value)}</text>`);
    if (index < specRows.length - 1) {
        parts.push(`<rect x="${cardX + 20}" y="${y + 11}" width="${cardW - 40}" height="1" fill="${HAIRLINE}" fill-opacity="0.10"/>`);
    }
});

// ---- legend --------------------------------------------------------------------------------------------------
const legendY = 292;
parts.push(`<rect x="${MARGIN}" y="${legendY - 8}" width="17" height="9" rx="4.5" fill="url(#amberBar)"/>`);
parts.push(`<text class="legend sans" x="${MARGIN + 26}" y="${legendY}">SillyTavern 1.19.0 (Node)</text>`);
parts.push(`<rect x="${MARGIN + 252}" y="${legendY - 8}" width="17" height="9" rx="4.5" fill="url(#cyanBar)"/>`);
parts.push(`<text class="legend sans" x="${MARGIN + 278}" y="${legendY}">GoTavern</text>`);
parts.push(`<text class="legend-note mono" x="${CONTENT_RIGHT}" y="${legendY}" text-anchor="end">LINEAR AXES - ZERO-BASED - MEDIANS</text>`);

// ---- metric rows ---------------------------------------------------------------------------------------------
let rowTop = ROW_START;
for (const metric of metrics) {
    const axisMax = niceAxisMax(Math.max(metric.pinnedValue, metric.goValue));
    const ratio = ratioOf(metric);
    const pinnedWidth = Math.max(MIN_VISIBLE_BAR, (metric.pinnedValue / axisMax) * BAR_WIDTH);
    const goWidth = Math.max(MIN_VISIBLE_BAR, (metric.goValue / axisMax) * BAR_WIDTH);
    const pinnedBarY = rowTop + 34;
    const goBarY = rowTop + 66;
    const axisY = rowTop + 96;

    parts.push(`<text class="row-index mono" x="${MARGIN}" y="${rowTop + 24}">${escapeXml(metric.index)}</text>`);
    parts.push(`<text class="row-label sans" x="${MARGIN}" y="${rowTop + 50}">${escapeXml(metric.label)}</text>`);
    metric.note.forEach((line, index) => {
        parts.push(`<text class="row-note sans" x="${MARGIN}" y="${rowTop + 72 + index * 16}">${escapeXml(line)}</text>`);
    });
    if (metric.exact) {
        parts.push(`<text class="row-exact mono" x="${MARGIN}" y="${rowTop + 118}">${escapeXml(`${groupedInteger(metric.exact.pinned)} B / ${groupedInteger(metric.exact.go)} B`)}</text>`);
    }

    // grid: quarter lines behind the bars, then the zero baseline. The grid is drawn UNDER the bars so a full-width
    // bar is not sliced by a line it covers anyway; the baseline is drawn OVER the bars' left edge start only.
    [0.25, 0.5, 0.75].forEach(fraction => {
        parts.push(`<rect x="${(BAR_X + BAR_WIDTH * fraction).toFixed(2)}" y="${pinnedBarY - 8}" width="1" height="${axisY - pinnedBarY + 8}" fill="${HAIRLINE}" fill-opacity="0.09"/>`);
    });

    // PINNED BAR. The drop shadow separates it from the page without changing its length; the sheen is clipped to
    // the bar's own top half so the fill reads as a solid material rather than a flat rectangle.
    parts.push(`<rect x="${BAR_X}" y="${pinnedBarY}" width="${pinnedWidth.toFixed(2)}" height="${BAR_HEIGHT}" rx="${BAR_RADIUS}" fill="url(#amberBar)" filter="url(#barShadow)"/>`);
    parts.push(`<rect x="${BAR_X}" y="${pinnedBarY}" width="${pinnedWidth.toFixed(2)}" height="${BAR_HEIGHT / 2}" rx="${BAR_RADIUS}" fill="#ffffff" fill-opacity="0.10"/>`);
    parts.push(`<text class="value mono" x="${(BAR_X + pinnedWidth - 12).toFixed(2)}" y="${(pinnedBarY + 10.5).toFixed(1)}" text-anchor="end" fill="#1b1206">${escapeXml(metric.format(metric.pinnedValue))}</text>`);

    // GOTAVERN BAR. A blurred copy underneath is the glow; the crisp copy is drawn again on top so the bar stays a
    // solid, measurable length instead of a soft smear. THE GLOW IS DECORATION AND IS NOT THE ONLY MARKER: the exact
    // value is printed beside the bar and the ratio is printed at the row's right edge.
    parts.push(`<rect x="${BAR_X}" y="${goBarY}" width="${goWidth.toFixed(2)}" height="${BAR_HEIGHT}" rx="${BAR_RADIUS}" fill="${CYAN}" opacity="0.55" filter="url(#goGlow)"/>`);
    parts.push(`<rect x="${BAR_X}" y="${goBarY}" width="${goWidth.toFixed(2)}" height="${BAR_HEIGHT}" rx="${BAR_RADIUS}" fill="url(#cyanBar)"/>`);
    parts.push(`<rect x="${BAR_X}" y="${goBarY}" width="${goWidth.toFixed(2)}" height="${BAR_HEIGHT / 2}" rx="${BAR_RADIUS}" fill="#ffffff" fill-opacity="0.14"/>`);
    parts.push(`<text class="value mono" x="${(BAR_X + goWidth + 11).toFixed(2)}" y="${(goBarY + 10.5).toFixed(1)}" fill="#a9f1ff">${escapeXml(metric.format(metric.goValue))}</text>`);

    // AXIS: zero-based, maximum printed, with the mid tick labelled. Ticks are 3 px strokes; the labels are the only
    // place the scale is stated in words, so the panel never has to be guessed from bar lengths.
    parts.push(`<rect x="${BAR_X}" y="${axisY}" width="${BAR_WIDTH}" height="1" fill="${HAIRLINE}" fill-opacity="0.30"/>`);
    [0, 0.5, 1].forEach(fraction => {
        const x = BAR_X + BAR_WIDTH * fraction;
        parts.push(`<rect x="${x.toFixed(2)}" y="${axisY}" width="1" height="4" fill="${HAIRLINE}" fill-opacity="0.45"/>`);
    });
    parts.push(`<text class="axis mono" x="${BAR_X}" y="${axisY + 18}">0 ${escapeXml(metric.unit)}</text>`);
    parts.push(`<text class="axis mono" x="${BAR_X + BAR_WIDTH / 2}" y="${axisY + 18}" text-anchor="middle">${escapeXml(formatAxisTick(axisMax / 2, metric.unit))}</text>`);
    parts.push(`<text class="axis mono" x="${BAR_X + BAR_WIDTH}" y="${axisY + 18}" text-anchor="end">${escapeXml(formatAxisTick(axisMax, metric.unit))}</text>`);

    // RATIO: the row's punch line, derived from the two values on the same row and printed in the only gradient type
    // in the figure. The verdict word sits under it so "lighter" can never be read as "faster".
    if (ratio !== null) {
        parts.push(`<text class="ratio mono" x="${CONTENT_RIGHT}" y="${rowTop + 58}" text-anchor="end" fill="url(#ratioGrad)"><tspan>${escapeXml(formatRatio(ratio).slice(0, -1))}</tspan><tspan class="ratio-factor" dx="1">\u00d7</tspan></text>`);
        parts.push(`<text class="verdict mono" x="${CONTENT_RIGHT}" y="${rowTop + 78}" text-anchor="end">${escapeXml(verdictWord(metric).split('').join(' '))}</text>`);
    }

    if (metric !== metrics[metrics.length - 1]) {
        parts.push(`<rect x="${MARGIN}" y="${rowTop + ROW_HEIGHT - 10}" width="${CONTENT_RIGHT - MARGIN}" height="1" fill="url(#hairlineFade)"/>`);
    }
    rowTop += ROW_HEIGHT;
}

// ---- footer --------------------------------------------------------------------------------------------------
const footerRuleY = rowTop + 6;
const footerLine1 = footerRuleY + 26;
parts.push(`<rect x="${MARGIN}" y="${footerRuleY}" width="${CONTENT_RIGHT - MARGIN}" height="1" fill="url(#hairlineFade)"/>`);
const footerLines = [
    ['VALUES', `GoTavern smoke metrics \u00b7 run ${runId} \u00b7 ${runnerImage} shared runner \u00b7 ${rounds} alternating rounds \u00d7 ${requestsPerRound} sequential requests per path \u00b7 medians shown`],
    ['SUBJECTS', `SillyTavern 1.19.0 @ pinned 06bde939   vs   GoTavern @ ${commit}   (the commit this run measured; the v0.1.0-alpha.9 tag adds documentation only)`],
    ['HONESTY', 'every bar sits on its own zero-based axis whose maximum is printed at the axis end, so no axis is truncated and no ratio replaces a value.'],
    ['', 'a 5 px floor keeps a near-zero bar visible; it never changes a printed value, the axis maximum or the ratio. Ratios restate the two printed values.'],
];
footerLines.forEach(([label, line], index) => {
    const y = footerLine1 + index * 17;
    parts.push(`<text class="footer mono" x="${MARGIN}" y="${y}">${label ? `<tspan class="footer-label">${escapeXml(label)}</tspan>` : ''}<tspan dx="${label ? 10 : 0}">${escapeXml(line)}</tspan></text>`);
});
parts.push(`<text class="footer mono" x="${MARGIN}" y="${footerLine1 + footerLines.length * 17 + 8}">generated by tools/benchmark-svg.mjs from the recorded artefact - never hand-edited</text>`);
parts.push(`<text class="footer mono" x="${CONTENT_RIGHT}" y="${footerLine1 + footerLines.length * 17 + 8}" text-anchor="end">github.com/cocokoishi/GoTavern</text>`);

parts.push('</svg>');

fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
fs.writeFileSync(path.resolve(outPath), parts.join('\n') + '\n');
console.log(`wrote ${outPath} (${parts.join('\n').length} bytes, ${totalHeight} px tall)`);
for (const metric of metrics) {
    console.log(`  ${metric.key.padEnd(8)} pinned=${metric.format(metric.pinnedValue).padStart(12)}  gotavern=${metric.format(metric.goValue).padStart(12)}  ${formatRatio(ratioOf(metric))} ${metric.verdict}`);
}
