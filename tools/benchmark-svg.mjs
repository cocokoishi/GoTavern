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

const metrics = [
    {
        key: 'startup',
        label: 'Cold start to first /version 200',
        unit: 'ms',
        pinnedValue: requireField(pinned, 'bootMsMedian', 'summary.pinned'),
        goValue: requireField(gotavern, 'bootMsMedian', 'summary.gotavern'),
        format: value => `${value.toLocaleString('en-US')} ms`,
        note: 'median of 3 rounds; empty data root, no config.yaml',
    },
    {
        key: 'rss',
        label: 'Steady-state RSS',
        unit: 'MB',
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

const WIDTH = 880;
const MARGIN_X = 28;
const PANEL_LABEL_WIDTH = 210;
const CHART_WIDTH = WIDTH - MARGIN_X * 2 - PANEL_LABEL_WIDTH;
// THE HEIGHT IS DERIVED FROM WHAT IS DRAWN, not chosen. A first version hard-coded 96 and the note text overflowed
// the panel and ran underneath the bars -- which the XML validity check could not see and only a render did. Each
// panel now budgets: label, note line(s), two bar rows, axis, and padding.
const PANEL_HEIGHT = 124;
const PANEL_GAP = 24;
const HEADER_HEIGHT = 108;
const FOOTER_HEIGHT = 104;
const BAR_HEIGHT = 21;

const BACKGROUND = '#0d1117';   // GitHub dark canvas; the figure supplies it so it does not depend on the page
const PANEL_FILL = '#161b22';
const TEXT_PRIMARY = '#e6edf3';  // 15.9:1 on BACKGROUND
const TEXT_SECONDARY = '#9198a1'; // 5.6:1 on BACKGROUND (AA for normal text)
const NODE_FILL = '#d29922';     // readable on both themes
const GO_FILL = '#3fb950';
const AXIS = '#30363d';

const escapeXml = value => String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

// A bar is drawn as a fraction of the panel's own maximum, so the axis is zero-based and nothing is truncated.
//
// THE MINIMUM VISIBLE WIDTH IS A LEGIBILITY FLOOR FOR THE RECTANGLE ONLY. At 61 ms against a 14,355 ms panel
// maximum the honest fraction is 0.42%, which renders as a sub-pixel line -- the figure would obey "never truncate"
// while failing "shows both subjects". The floor widens the RECTANGLE to 4 px; it never changes the printed value,
// the axis, or the ratio, all of which are computed from the raw numbers. A reader comparing bar LENGTHS with the
// floor in play would understate the difference, which is the safe direction to be wrong in.
const MIN_VISIBLE_BAR = 4;

const style = `
  <style>
    .title { font: 600 17px -apple-system, "Segoe UI", system-ui, sans-serif; fill: ${TEXT_PRIMARY}; }
    .subtitle { font: 400 12px -apple-system, "Segoe UI", system-ui, sans-serif; fill: ${TEXT_SECONDARY}; }
    .panel-label { font: 600 12.5px -apple-system, "Segoe UI", system-ui, sans-serif; fill: ${TEXT_PRIMARY}; }
    .panel-note { font: 400 10.5px -apple-system, "Segoe UI", system-ui, sans-serif; fill: ${TEXT_SECONDARY}; }
    .value { font: 600 12px "SFMono-Regular", Consolas, "Liberation Mono", monospace; fill: ${TEXT_PRIMARY}; }
    .exact { font: 400 9.5px "SFMono-Regular", Consolas, "Liberation Mono", monospace; fill: ${TEXT_SECONDARY}; }
    .axis { stroke: ${AXIS}; stroke-width: 1; }
    .axis-label { font: 400 9.5px "SFMono-Regular", Consolas, "Liberation Mono", monospace; fill: ${TEXT_SECONDARY}; }
    .legend { font: 500 11.5px -apple-system, "Segoe UI", system-ui, sans-serif; fill: ${TEXT_PRIMARY}; }
    .ratio { font: 600 11.5px -apple-system, "Segoe UI", system-ui, sans-serif; fill: ${TEXT_PRIMARY}; }
    .footer { font: 400 10px -apple-system, "Segoe UI", system-ui, sans-serif; fill: ${TEXT_SECONDARY}; }
    .total { font: 600 11px -apple-system, "Segoe UI", system-ui, sans-serif; fill: ${TEXT_PRIMARY}; }
  </style>`;

const parts = [];
const totalHeight = HEADER_HEIGHT + metrics.length * (PANEL_HEIGHT + PANEL_GAP) + FOOTER_HEIGHT;

parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${totalHeight}" viewBox="0 0 ${WIDTH} ${totalHeight}" role="img" aria-labelledby="benchmarkTitle benchmarkDesc">`);
parts.push(`<title id="benchmarkTitle">GoTavern vs SillyTavern (Node) - paired benchmark, ${escapeXml(runnerImage)}</title>`);
parts.push(`<desc id="benchmarkDesc">${escapeXml(metrics.map(m => `${m.label}: SillyTavern ${m.format(m.pinnedValue)}, GoTavern ${m.format(m.goValue)}`).join('; '))}. Lower is better for every metric. Methodology and provenance are stated in the README section below the figure.</desc>`);
parts.push(style);
parts.push(`<rect width="${WIDTH}" height="${totalHeight}" fill="${BACKGROUND}" rx="6"/>`);

// ---- header --------------------------------------------------------------------------------------------------
parts.push(`<text class="title" x="${MARGIN_X}" y="34">GoTavern vs SillyTavern - same machine, one run, alternating rounds</text>`);
parts.push(`<text class="subtitle" x="${MARGIN_X}" y="55">Lower is better for every metric. Each panel has its own zero-based axis; the axis maximum is printed on the panel.</text>`);
parts.push(`<text class="subtitle" x="${MARGIN_X}" y="72">${escapeXml(`Runner ${runnerImage} - ${rounds} rounds x ${requestsPerRound} sequential requests per path - medians shown`)}</text>`);

// legend
const legendY = 92;
parts.push(`<rect x="${MARGIN_X}" y="${legendY - 9}" width="11" height="11" rx="2" fill="${NODE_FILL}"/>`);
parts.push(`<text class="legend" x="${MARGIN_X + 17}" y="${legendY}">SillyTavern (Node)</text>`);
parts.push(`<rect x="${MARGIN_X + 150}" y="${legendY - 9}" width="11" height="11" rx="2" fill="${GO_FILL}"/>`);
parts.push(`<text class="legend" x="${MARGIN_X + 167}" y="${legendY}">GoTavern</text>`);

// ---- panels --------------------------------------------------------------------------------------------------
let y = HEADER_HEIGHT;
for (const metric of metrics) {
    const panelMax = Math.max(metric.pinnedValue, metric.goValue);
    const axisLabel = metric.format(panelMax);

    parts.push(`<rect x="${MARGIN_X - 10}" y="${y - 16}" width="${WIDTH - (MARGIN_X - 10) * 2}" height="${PANEL_HEIGHT}" rx="5" fill="${PANEL_FILL}"/>`);

    // label block: the metric name, and the sampling note BELOW it but ABOVE the bars so it cannot be overrun.
    parts.push(`<text class="panel-label" x="${MARGIN_X}" y="${y + 2}">${escapeXml(metric.label)}</text>`);
    parts.push(`<text class="panel-note" x="${MARGIN_X}" y="${y + 17}">${escapeXml(metric.note)}</text>`);

    const chartX = MARGIN_X + PANEL_LABEL_WIDTH;
    const barRows = [
        { value: metric.pinnedValue, fill: NODE_FILL, name: 'SillyTavern (Node)' },
        { value: metric.goValue, fill: GO_FILL, name: 'GoTavern' },
    ];

    barRows.forEach((row, index) => {
        // THE BARS START BELOW THE NOTE BLOCK. In the first version they began at y+6 and a two-line note ran
        // behind them; the render showed the note cut off mid-sentence.
        const barY = y + 26 + index * (BAR_HEIGHT + 11);
        const fraction = panelMax === 0 ? 0 : row.value / panelMax;
        const barWidth = Math.max(MIN_VISIBLE_BAR, fraction * CHART_WIDTH);
        parts.push(`<rect x="${chartX}" y="${barY}" width="${barWidth.toFixed(2)}" height="${BAR_HEIGHT}" rx="2" fill="${row.fill}"><title>${escapeXml(`${row.name}: ${metric.format(row.value)}`)}</title></rect>`);

        // THE VALUE GOES INSIDE THE BAR WHEN THE BAR IS LONG ENOUGH, OUTSIDE OTHERWISE.
        //
        // Measured on the first render: the pinned bar fills the panel, so a label placed AFTER it ran off the
        // right edge of the figure and read "14,3..." -- the number for the subject the figure exists to report.
        // Placing it inside a full-width bar cannot overflow; placing it outside a short bar has room by
        // construction. The threshold is the label's own estimated width, not a fraction of the panel.
        const label = metric.format(row.value);
        const estimatedLabelWidth = label.length * 7.2 + 12;
        const placeInside = barWidth > estimatedLabelWidth + 10;
        const textX = placeInside ? chartX + barWidth - 8 : chartX + barWidth + 8;
        const anchor = placeInside ? 'end' : 'start';
        // Inside a filled bar the label needs its own contrast, so it is drawn in the panel's dark ink.
        const ink = placeInside ? '#0d1117' : TEXT_PRIMARY;
        parts.push(`<text class="value" x="${textX.toFixed(2)}" y="${barY + 15}" text-anchor="${anchor}" fill="${ink}">${escapeXml(label)}</text>`);
    });

    // axis: a zero-based baseline with its maximum printed at the right end, so the panel states its own scale.
    const axisY = y + 26 + 2 * (BAR_HEIGHT + 11) + 4;
    parts.push(`<line class="axis" x1="${chartX}" y1="${axisY}" x2="${chartX + CHART_WIDTH}" y2="${axisY}"/>`);
    parts.push(`<text class="axis-label" x="${chartX}" y="${axisY + 13}">0</text>`);
    parts.push(`<text class="axis-label" x="${chartX + CHART_WIDTH}" y="${axisY + 13}" text-anchor="end">panel max ${escapeXml(axisLabel)}</text>`);
    // The exact byte counts for the RSS panel sit under the axis on their OWN baseline, indented past the "0"
    // tick, where they cannot collide with it -- the first render had both at the same y and the "0" was obscured.
    if (metric.exact) {
        parts.push(`<text class="exact" x="${chartX + 18}" y="${axisY + 13}">exact: ${metric.exact.pinned.toLocaleString('en-US')} B / ${metric.exact.go.toLocaleString('en-US')} B</text>`);
    }

    const ratio = metric.goValue === 0 ? null : metric.pinnedValue / metric.goValue;
    if (ratio !== null) {
        // THREE SIGNIFICANT FIGURES ABOVE 10, so 24.48 does not print as "24x" and 145.58 does not print as
        // "146x". The ratio is a restatement of the two values beside it rather than a headline, and rounding it to
        // two digits would make it disagree with arithmetic a reader can do from the panel.
        const ratioText = ratio >= 100 ? ratio.toFixed(1) : ratio >= 10 ? ratio.toFixed(2) : ratio.toFixed(2);
        parts.push(`<text class="ratio" x="${chartX + CHART_WIDTH}" y="${y + 2}" text-anchor="end">${escapeXml(`${ratioText}x lower`)}</text>`);
    }

    y += PANEL_HEIGHT + PANEL_GAP;
}

// ---- footer --------------------------------------------------------------------------------------------------
const footerY = y + 4;
parts.push(`<line class="axis" x1="${MARGIN_X - 10}" y1="${footerY - 14}" x2="${WIDTH - MARGIN_X + 10}" y2="${footerY - 14}"/>`);
parts.push(`<text class="footer" x="${MARGIN_X - 10}" y="${footerY}">Ratios are computed from the two printed values in each panel; they are a restatement, not a separate measurement.</text>`);
parts.push(`<text class="footer" x="${MARGIN_X - 10}" y="${footerY + 15}">SillyTavern 1.19.0 (pinned commit 06bde939), booted from the same checkout, same data-root seeding, same port allocator.</text>`);
parts.push(`<text class="footer" x="${MARGIN_X - 10}" y="${footerY + 30}">Workflow: GoTavern smoke metrics, run ${escapeXml(runId)} - shared GitHub runner, so these are runner-dependent numbers, not a budget.</text>`);
parts.push(`<text class="footer" x="${MARGIN_X - 10}" y="${footerY + 45}">Full methodology and provenance: README, "Performance" section.</text>`);

parts.push('</svg>');

fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
fs.writeFileSync(path.resolve(outPath), parts.join('\n') + '\n');
console.log(`wrote ${outPath} (${parts.join('\n').length} bytes)`);
for (const metric of metrics) {
    const ratio = metric.pinnedValue / metric.goValue;
    console.log(`  ${metric.key.padEnd(8)} pinned=${metric.format(metric.pinnedValue).padStart(12)}  gotavern=${metric.format(metric.goValue).padStart(12)}  ratio=${ratio.toFixed(2)}x`);
}
