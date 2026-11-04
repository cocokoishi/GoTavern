#!/usr/bin/env node
// THE PERFORMANCE-EVIDENCE GATE: README table, figure and provenance must restate ONE recorded artifact.
//
// WHY THIS EXISTS. `v0.1.0-alpha.13`'s tag tree carried a README RSS row of 1,057 MB / 36.9 MB while the
// run it cited (`GoTavern smoke metrics` 41403239135) recorded 1,108,514,816 B / 38,647,808 B and the same
// tree's own figure printed 1,109 / 38.6 decimal MB. Nothing compared the three surfaces to the recording,
// so the mismatch survived alpha.12 and alpha.13 (M0 audit defect D1). The class is "a number in a release
// surface that the artifact does not contain", and this gate removes it:
//
//   * tests/perf/q22-baseline.json is the source of truth (provenance + the q22 artefact embedded verbatim);
//   * docs/assets/benchmark.svg (dark) and docs/assets/benchmark-light.svg (light) are REGENERATED from it and
//     byte-compared, so neither figure variant can drift and the two cannot disagree about the data;
//   * the README performance table is RECOMPUTED from it under one stated unit rule and compared cell by
//     cell, so a unit mismatch cannot hide;
//   * the README's first screen is checked STRUCTURALLY: it must reference both figure variants through a
//     <picture> element, carry the shortest install+start block, link the detailed sections, state the
//     synthetic scope of the evidence and the unmet GOAL §14 claim in the same place as the claim, and
//     hardcode no GoTavern release version;
//   * the figures are checked for the properties they promise: 1200x675, role/title/desc with the same
//     per-metric verdict words, every declared type size at least 12 px at 1:1, and no external font,
//     image, script or network reference;
//   * the provenance's run id, commit, rounds and soak are compared with the baseline's own provenance.
//
// ONE UNIT RULE, STATED ONCE AND USED EVERYWHERE: memory is decimal MB, 1 MB = 1,000,000 bytes. Formatting
// follows the figure's own rule (>= 100 MB -> integer with thousands separators, < 100 MB -> one decimal);
// time is milliseconds, printed with the precision the figure uses (startup integer, /version 2 decimals
// unless below 10 where 3, / 2 decimals). The gate recomputes from `rssBytesMedian` and never parses a
// number back out of a doc to "check" it.
//
// FAIL CLOSED, AND NAME THE FIRST MISMATCH. Every problem carries the file, the line (when it has one), the
// value found, the value the artifact implies and the artifact field it came from, so a red run can be read
// without opening the tree. The exit status is non-zero on the first problem and the remaining count is
// printed; the gate never edits a file.
//
// TEETH (recorded in the commit that added it): changing 11,522 to 11,523 in README.md, or one summary
// number in a copy of the baseline, makes this gate exit 1 naming the metric, the expected value and the
// artifact field; restoring the file by copy returns it to green. A mutated dark OR light SVG fails its own
// byte comparison, and deleting the first screen's honesty sentence, dropping the <picture> element or
// lowering a figure type size below 12 px each fails with the first-screen or accessibility message named.
//
// USAGE:
//   node tools/check-perf-docs.mjs
//   node tools/check-perf-docs.mjs --baseline <q22-baseline.json> --readme <README.md> \
//       --svg <benchmark.svg> --svg-light <benchmark-light.svg> \
//       --provenance <benchmark.svg.provenance.md> --baseline-doc <perf-baseline.md>
//       # used by the teeth test on copies

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');

function argument(name, fallback) {
    const index = process.argv.indexOf(name);
    return index < 0 ? fallback : process.argv[index + 1] ?? fallback;
}

const baselinePath = path.resolve(argument('--baseline', path.join(ROOT, 'tests', 'perf', 'q22-baseline.json')));
const readmePath = path.resolve(argument('--readme', path.join(ROOT, 'README.md')));
const svgPath = path.resolve(argument('--svg', path.join(ROOT, 'docs', 'assets', 'benchmark.svg')));
const svgLightPath = path.resolve(argument('--svg-light', path.join(ROOT, 'docs', 'assets', 'benchmark-light.svg')));
const provenancePath = path.resolve(argument('--provenance', path.join(ROOT, 'docs', 'assets', 'benchmark.svg.provenance.md')));
const generatorPath = path.resolve(argument('--generator', path.join(ROOT, 'tools', 'benchmark-svg.mjs')));
const baselineDocPath = path.resolve(argument('--baseline-doc', path.join(ROOT, 'docs', 'perf-baseline.md')));

const problems = [];
function problem(file, line, message) {
    problems.push({ file: path.relative(ROOT, file).split(path.sep).join('/') || file, line, message });
}
const relative = file => path.relative(ROOT, file).split(path.sep).join('/');

function readText(file) {
    try {
        return readFileSync(file, 'utf8');
    } catch (error) {
        problem(file, null, `cannot be read: ${error.message}`);
        return null;
    }
}
function readJson(file) {
    const text = readText(file);
    if (text === null) return null;
    try {
        return JSON.parse(text);
    } catch (error) {
        problem(file, null, `is not valid JSON: ${error.message}`);
        return null;
    }
}
function lineOf(text, needle) {
    if (typeof needle !== 'string') return null;
    const index = text.split('\n').findIndex(line => line.includes(needle));
    return index < 0 ? null : index + 1;
}
function expectContains(file, text, needle, why) {
    if (text === null) return;
    if (!text.includes(needle)) problem(file, lineOf(text, needle.split('\n')[0]), `does not contain ${JSON.stringify(needle)} (${why})`);
}

// ---- formatting: the ONE unit rule ---------------------------------------------------------------
const groupedInteger = value => Math.round(value).toLocaleString('en-US');
const decimalMB = bytes => bytes / 1e6;
function formatMB(bytes) {
    const mb = decimalMB(bytes);
    return mb >= 100 ? `${groupedInteger(mb)} MB` : `${mb.toFixed(1)} MB`;
}
const formatMs = value => (value >= 10 ? value.toFixed(2) : value.toFixed(3));
const formatSigned = (value, digits, unit) => `${value >= 0 ? '+' : '-'}${Math.abs(value).toFixed(digits)} ${unit}`;

// ---- load the source of truth -------------------------------------------------------------------
const baseline = readJson(baselinePath);
if (baseline === null) {
    console.error(`perf-evidence: FAIL\n  - ${relative(baselinePath)}: cannot be read; the docs cannot be checked`);
    process.exit(1);
}
const provenance = baseline.provenance ?? {};
const report = baseline.report;
if (!report || typeof report !== 'object') {
    console.error(`perf-evidence: FAIL\n  - ${relative(baselinePath)}: has no embedded report; the baseline wrapper is malformed`);
    process.exit(1);
}
for (const subject of ['pinned', 'gotavern']) {
    if (!report.summary?.[subject] || typeof report.summary[subject].rssBytesMedian !== 'number') {
        console.error(`perf-evidence: FAIL\n  - ${relative(baselinePath)}: report.summary.${subject} is missing or has no rssBytesMedian`);
        process.exit(1);
    }
}
const summary = report.summary;
const rounds = report.rounds;
const requestsPerRound = report.requestsPerRound;
const soak = Array.isArray(report.soak) ? report.soak : [];
const soakOf = subject => soak.find(entry => entry.subject === subject) ?? null;
if (!/^[0-9]+$/.test(String(provenance.runId ?? ''))) problem(baselinePath, null, `provenance.runId is not a GitHub Actions run id: ${JSON.stringify(provenance.runId)}`);
if (!/^[0-9a-f]{40}$/.test(String(provenance.commit ?? ''))) problem(baselinePath, null, `provenance.commit is not a full 40-character commit id: ${JSON.stringify(provenance.commit)}`);
if (report.runnerImage !== undefined && provenance.host?.runnerImage !== undefined && report.runnerImage !== provenance.host.runnerImage) {
    problem(baselinePath, null, `report.runnerImage ${JSON.stringify(report.runnerImage)} disagrees with provenance.host.runnerImage ${JSON.stringify(provenance.host.runnerImage)}`);
}
for (const entry of soak) {
    if (typeof entry.windowMs !== 'number' || typeof entry.sampleEveryMs !== 'number' || !Array.isArray(entry.series) || entry.series.length === 0) {
        problem(baselinePath, null, `soak for ${entry.subject ?? 'unknown'} is incomplete (windowMs/sampleEveryMs/series)`);
    }
}
if (report.asserted?.everyRoundAnswered !== true) problem(baselinePath, null, 'report.asserted.everyRoundAnswered is not true');
if (report.asserted?.sampleCountsMatch !== true) problem(baselinePath, null, 'report.asserted.sampleCountsMatch is not true');

const shortCommit = String(provenance.commit ?? '').slice(0, 7);
const runId = String(provenance.runId ?? '');

// ---- README: the FIRST SCREEN, checked structurally ------------------------------------------------
// GOAL.md 15.6 fixes what a reader sees before scrolling: name and one-line description, one real performance
// figure, the shortest install/start block, the compatibility state with known limits, and links to the detail.
// A prose claim cannot be gated, but its STRUCTURE can: the boundary is the "## Release status" heading, and
// everything before it is the first screen. The release history and the CI badges are deliberately below that
// boundary, so a stale release version or a badge cannot creep back up into the first thing a reader sees.
const readme = readText(readmePath);
if (readme !== null) {
    const lines = readme.split('\n');
    const firstScreenEnd = lines.findIndex(line => /^##\s+Release status\s*$/.test(line));
    if (firstScreenEnd < 0) {
        problem(readmePath, null, 'has no "## Release status" heading, so the gate cannot tell where the first screen ends (the release history and CI badges must live below the first screen)');
    }
    const firstScreen = lines.slice(0, firstScreenEnd < 0 ? lines.length : firstScreenEnd).join('\n');
    const firstScreenProblem = (message, line = null) => problem(readmePath, line, `first screen: ${message}`);
    // (a) the ONE figure, in both variants, selected by GitHub's colour scheme.
    if (!firstScreen.includes('<picture')) firstScreenProblem('has no <picture> element, so the figure cannot be the one image of the first screen');
    if (!firstScreen.includes('prefers-color-scheme')) firstScreenProblem('does not choose the figure variant with prefers-color-scheme, so the dark/light pair cannot be selected by GitHub');
    for (const variant of ['docs/assets/benchmark.svg', 'docs/assets/benchmark-light.svg']) {
        if (!firstScreen.includes(variant)) firstScreenProblem(`does not reference the figure variant ${variant} (both variants must be referenced, or one of them is unreachable)`);
    }
    // THE ALT TEXT IS A FIRST-SCREEN NUMBER SURFACE TOO, so it is recomputed like a table cell rather than trusted.
    // Without this, the alt text would be the one place in the first screen where a hand-copied number could drift
    // from the artifact (the defect class this gate exists to remove).
    const imgAlt = /<img\b[^>]*\balt="([^"]*)"/.exec(firstScreen);
    if (!imgAlt) {
        firstScreenProblem('has no <img alt="..."> inside the first screen, so the figure has no text alternative');
    } else {
        const formatRatioText = value => `${value >= 100 ? value.toFixed(1) : value.toFixed(2)}x`;
        const altCells = [
            { pinned: `${groupedInteger(summary.pinned.bootMsMedian)} ms`, go: `${groupedInteger(summary.gotavern.bootMsMedian)} ms`, ratio: formatRatioText(summary.pinned.bootMsMedian / summary.gotavern.bootMsMedian), source: 'report.summary.*.bootMsMedian' },
            { pinned: formatMB(summary.pinned.rssBytesMedian), go: formatMB(summary.gotavern.rssBytesMedian), ratio: formatRatioText(summary.pinned.rssBytesMedian / summary.gotavern.rssBytesMedian), source: 'report.summary.*.rssBytesMedian' },
            { pinned: `${formatMs(summary.pinned.versionMedianMs)} ms`, go: `${formatMs(summary.gotavern.versionMedianMs)} ms`, ratio: formatRatioText(summary.pinned.versionMedianMs / summary.gotavern.versionMedianMs), source: 'report.summary.*.versionMedianMs' },
            { pinned: `${summary.pinned.rootMedianMs.toFixed(2)} ms`, go: `${summary.gotavern.rootMedianMs.toFixed(2)} ms`, ratio: formatRatioText(summary.pinned.rootMedianMs / summary.gotavern.rootMedianMs), source: 'report.summary.*.rootMedianMs' },
        ];
        for (const cells of altCells) {
            for (const value of [cells.pinned, cells.go, cells.ratio]) {
                if (!imgAlt[1].includes(value)) firstScreenProblem(`figure alt text does not carry ${JSON.stringify(value)} recomputed from ${cells.source}; a hand-copied number in the first screen can drift from the recorded artifact`);
            }
        }
    }
    // (b) the shortest install+start block, on both platforms, not a link to it.
    for (const command of ['install.sh', './start.sh', 'install.ps1', '.\\Start.cmd']) {
        if (!firstScreen.includes(command)) firstScreenProblem(`does not carry the shortest start block: it is missing ${JSON.stringify(command)}`);
    }
    // (c) links to the detail, by anchor, so the first screen cannot become a dead end.
    for (const anchor of ['(#performance)', '(#compatibility)', '(#install)']) {
        if (!firstScreen.includes(anchor)) firstScreenProblem(`does not link the detailed section ${anchor}`);
    }
    // (d) THE HONESTY REQUIREMENT, as a structure: the claim and its scope in the same place. GOAL.md 14 says the
    // strong form is NOT MET today and that any document calling the product drop-in must state which of its
    // evidence items have run. The first screen must therefore name GOAL.md, say the claim is not met, and say the
    // evidence is synthetic -- three facts that cannot drift apart in separate sections.
    for (const [needle, why] of [
        ['GOAL.md', 'must cite GOAL.md so the scope is checkable'],
        ['not met', 'must state that the strong drop-in claim is not met yet'],
        ['synthetic', 'must name the synthetic scope of the evidence'],
    ]) {
        if (!firstScreen.toLowerCase().includes(needle.toLowerCase())) firstScreenProblem(`does not contain ${JSON.stringify(needle)} (${why})`);
    }
    // (e) no GoTavern release version in the first screen: a release tag there is a number that goes stale on
    // every release, and the release history has its own section below. The pinned upstream baseline ("1.19.0")
    // is a deliberate constant, not a GoTavern release, so it does not match this pattern.
    const releaseVersion = /\bv?0\.\d+\.\d+(?:-[0-9A-Za-z.]+)?|\balpha\.\d+\b/.exec(firstScreen);
    if (releaseVersion) firstScreenProblem(`contains a hardcoded GoTavern release version ${JSON.stringify(releaseVersion[0])}; release history belongs below the first screen`, lineOf(firstScreen, releaseVersion[0]));
    // Wording rule, whole document: the strong claim is not demonstrated, so no surface may say the product is
    // perfectly compatible. The word "drop-in" stays available because the README uses it as the NAME of the
    // release qualification gates, which is what they are called.
    const perfect = /perfect(?:ly)?[\s-]*compatib/i.exec(readme);
    if (perfect) problem(readmePath, lineOf(readme, perfect[0]), `claims ${JSON.stringify(perfect[0])}; GOAL.md 14's strong claim is not met, so compatibility wording must carry its scope`);
}

// ---- README: the performance table and the paragraph that cites the run ---------------------------
if (readme !== null) {
    const lines = readme.split('\n');
    const sectionStart = lines.findIndex(line => /^##\s+Performance\s*$/.test(line));
    const sectionEnd = sectionStart < 0 ? -1 : lines.findIndex((line, index) => index > sectionStart && /^##\s+/.test(line));
    if (sectionStart < 0) {
        problem(readmePath, null, 'has no "## Performance" section, so the gate has nothing to check');
    } else {
        const end = sectionEnd < 0 ? lines.length : sectionEnd;
        const sectionLines = lines.slice(sectionStart, end);
        const sectionText = sectionLines.join('\n');

        // One unit rule, stated once in the section and reused by the figure's row note.
        expectContains(readmePath, sectionText, '1 MB = 1,000,000 bytes', 'the README must state the decimal-MB unit rule once');
        // The local before/after benchmark table is NOT part of the paired artifact; it must stay labelled as
        // local so a reader cannot mistake it for the recorded product comparison.
        expectContains(readmePath, sectionText, 'These are local, single-machine numbers', 'the local before/after benchmark table must stay labelled local (it is not part of the paired artifact)');

        const expectedRows = [
            {
                label: 'Cold start to first `/version` 200',
                pinned: `${groupedInteger(summary.pinned.bootMsMedian)} ms`,
                gotavern: `${groupedInteger(summary.gotavern.bootMsMedian)} ms`,
                source: `report.summary.*.bootMsMedian (${summary.pinned.bootMsMedian} / ${summary.gotavern.bootMsMedian})`,
                measured: `median of ${rounds} alternating rounds`,
            },
            {
                label: 'Steady-state RSS (`VmRSS` from `/proc`)',
                pinned: formatMB(summary.pinned.rssBytesMedian),
                gotavern: formatMB(summary.gotavern.rssBytesMedian),
                source: `report.summary.*.rssBytesMedian (${summary.pinned.rssBytesMedian} / ${summary.gotavern.rssBytesMedian} B; decimal MB = 1e6 B)`,
                measured: `median of ${summary.pinned.samples?.rss ?? '?'} samples`,
            },
            {
                label: '`GET /version` latency',
                pinned: `${formatMs(summary.pinned.versionMedianMs)} ms`,
                gotavern: `${formatMs(summary.gotavern.versionMedianMs)} ms`,
                source: `report.summary.*.versionMedianMs (${summary.pinned.versionMedianMs} / ${summary.gotavern.versionMedianMs})`,
                measured: `median of ${summary.pinned.samples?.version ?? '?'} sequential requests`,
            },
            {
                label: '`GET /` latency (HTML shell)',
                pinned: `${summary.pinned.rootMedianMs.toFixed(2)} ms`,
                gotavern: `${summary.gotavern.rootMedianMs.toFixed(2)} ms`,
                source: `report.summary.*.rootMedianMs (${summary.pinned.rootMedianMs} / ${summary.gotavern.rootMedianMs})`,
                measured: `median of ${summary.pinned.samples?.root ?? '?'} sequential requests`,
            },
        ];
        // THE SAME NUMBERS MAY APPEAR MORE THAN ONCE (the first-screen figure's alt text never carries raw cell
        // text, but a future README could repeat the table); every occurrence of a row is checked, and the
        // Performance section's occurrence must also carry the "How it was measured" column.
        const clean = value => String(value ?? '').replace(/\*\*/g, '').trim();
        for (const row of expectedRows) {
            const indexes = lines
                .map((line, lineIndex) => (line.trim().startsWith(`| ${row.label} |`) ? lineIndex : -1))
                .filter(index => index >= 0);
            if (indexes.length === 0) {
                problem(readmePath, null, `has no table row starting with "| ${row.label} |"`);
                continue;
            }
            for (const index of indexes) {
                const cells = lines[index].split('|').map(cell => cell.trim());
                // cells: ['', metric, pinned, gotavern, ...] -- the performance table has five columns,
                // the TL;DR mini-table four; the value cells are at the same positions in both.
                const pinnedCell = clean(cells[2]);
                const goCell = clean(cells[3]);
                if (pinnedCell !== row.pinned) {
                    problem(readmePath, index + 1, `row ${JSON.stringify(row.label)}: pinned cell is ${JSON.stringify(pinnedCell)}, the artifact gives ${JSON.stringify(row.pinned)} (${row.source})`);
                }
                if (goCell !== row.gotavern) {
                    problem(readmePath, index + 1, `row ${JSON.stringify(row.label)}: GoTavern cell is ${JSON.stringify(goCell)}, the artifact gives ${JSON.stringify(row.gotavern)} (${row.source})`);
                }
            }
            const sectionIndex = indexes.find(index => index >= sectionStart && index < end);
            if (sectionIndex === undefined) {
                problem(readmePath, null, `has no row starting with "| ${row.label} |" inside the "## Performance" section`);
                continue;
            }
            const howCell = clean(lines[sectionIndex].split('|').map(cell => cell.trim())[4]);
            if (!howCell.includes(row.measured)) {
                problem(readmePath, sectionIndex + 1, `row ${JSON.stringify(row.label)}: measurement cell does not contain ${JSON.stringify(row.measured)} (it says ${JSON.stringify(howCell)})`);
            }
        }

        // p95 is quoted inline in the /version row; recompute it rather than trusting the text.
        const versionRowIndex = lines.findIndex((line, lineIndex) => lineIndex >= sectionStart && lineIndex < end && line.trim().startsWith('| `GET /version` latency |'));
        if (versionRowIndex >= 0) {
            const cells = lines[versionRowIndex].split('|').map(cell => cell.trim().replace(/\*\*/g, ''));
            const expectedP95 = `${formatMs(summary.pinned.versionP95Ms)} / ${formatMs(summary.gotavern.versionP95Ms)}`;
            if (!cells[4].includes(`p95: ${expectedP95}`)) {
                problem(readmePath, versionRowIndex + 1, `/version row does not quote p95 ${JSON.stringify(expectedP95)} from report.summary.*.versionP95Ms (${summary.pinned.versionP95Ms} / ${summary.gotavern.versionP95Ms})`);
            }
        }

        // The RSS row must say 30 requests PER PATH, i.e. 60 per round; the pre-gate text said "30 requests
        // per round", which understated the load the second RSS sample follows.
        const rssRowIndex = lines.findIndex((line, lineIndex) => lineIndex >= sectionStart && lineIndex < end && line.trim().startsWith('| Steady-state RSS'));
        if (rssRowIndex >= 0 && !lines[rssRowIndex].includes('30 requests per path (60 per round)')) {
            problem(readmePath, rssRowIndex + 1, 'RSS row must say "30 requests per path (60 per round)" (the harness issues 30 per path before the second RSS sample)');
        }

        // The paragraph cites the run and the soak; both are recomputed from the artifact.
        expectContains(readmePath, sectionText, `run \`${runId}\``, 'the paragraph must cite the baseline run id');
        expectContains(readmePath, sectionText, `\`${shortCommit}\``, 'the paragraph must cite the baseline short commit');
        const goSoak = soakOf('gotavern');
        const pinnedSoak = soakOf('pinned');
        if (goSoak && pinnedSoak) {
            expectContains(readmePath, sectionText, formatSigned(goSoak.rssDriftBytes / 1e6, 1, 'MB'), `the GoTavern soak RSS drift must be recomputed from soak[].rssDriftBytes (${goSoak.rssDriftBytes} B)`);
            expectContains(readmePath, sectionText, formatSigned(goSoak.p95DriftMs, 2, 'ms'), `the GoTavern soak p95 drift must be recomputed from soak[].p95DriftMs (${goSoak.p95DriftMs})`);
            expectContains(readmePath, sectionText, formatSigned(pinnedSoak.p95DriftMs, 2, 'ms'), `the pinned soak p95 drift must be recomputed from soak[].p95DriftMs (${pinnedSoak.p95DriftMs})`);
        } else {
            problem(readmePath, null, 'the README soak sentence cannot be checked: the baseline has no two-subject soak');
        }
    }
}

// ---- provenance: it must name the same run, commit, rounds and soak, and both figure variants ---------
const provenanceText = readText(provenancePath);
if (provenanceText !== null) {
    expectContains(provenancePath, provenanceText, `| run id | \`${runId}\``, 'provenance must name the baseline run id');
    expectContains(provenancePath, provenanceText, String(provenance.commit ?? ''), 'provenance must name the full baseline commit');
    expectContains(provenancePath, provenanceText, `${rounds} alternating rounds x ${requestsPerRound} sequential requests per path`, `provenance must state ${rounds} rounds x ${requestsPerRound} requests per path from the baseline`);
    expectContains(provenancePath, provenanceText, '2 x 10-minute windows, one per subject, 30 s sampling (both completed)', 'provenance must state the soak shape the artifact records');
    if (provenance.host?.runnerImage) expectContains(provenancePath, provenanceText, String(provenance.host.runnerImage), 'provenance must name the runner image recorded with the baseline');
    expectContains(provenancePath, provenanceText, 'decimal MB (1e6 B)', 'provenance must state the decimal-MB unit rule');
    expectContains(provenancePath, provenanceText, 'stated on the row', 'provenance claims the unit is stated on the row; the figure must actually state it');
    // The figure is now a dark/light PAIR. The provenance must say so, state the shared canvas, and record how the
    // accessibility properties are verified, or a reader would look for one file and find the wrong half of a pair.
    expectContains(provenancePath, provenanceText, 'benchmark-light.svg', 'provenance must name the light figure variant next to the dark one');
    expectContains(provenancePath, provenanceText, '1200', 'provenance must state the shared canvas size');
    expectContains(provenancePath, provenanceText, 'contrast', 'provenance must record the contrast audit');
    expectContains(provenancePath, provenanceText, '12 px', 'provenance must state the minimum type size at 1:1');
    expectContains(provenancePath, provenanceText, '--out-light', 'the update procedure must regenerate BOTH variants');
}

// ---- baseline document: identity only, no second hand-copied number table -------------------------
const baselineDoc = readText(baselineDocPath);
if (baselineDoc !== null) {
    expectContains(baselineDocPath, baselineDoc, String(provenance.runId ?? ''), 'the baseline document must name the baseline run id');
    expectContains(baselineDocPath, baselineDoc, String(provenance.commit ?? ''), 'the baseline document must name the full baseline commit');
    expectContains(baselineDocPath, baselineDoc, `${rounds} alternating rounds × ${requestsPerRound} sequential requests per path`, `the baseline document must state ${rounds} rounds × ${requestsPerRound} requests per path from the baseline`);
    if (provenance.host?.cpuCount !== undefined && provenance.host?.cpuCount !== null) {
        expectContains(baselineDocPath, baselineDoc, `${provenance.host.cpuCount} vCPU`, 'the baseline document must state the recorded CPU count');
    }
    if (typeof provenance.host?.totalMemoryBytes === 'number') {
        expectContains(baselineDocPath, baselineDoc, `${groupedInteger(provenance.host.totalMemoryBytes)} B`, 'the baseline document must state the recorded RAM');
    }
    expectContains(baselineDocPath, baselineDoc, 'decimal MB', 'the baseline document must state the unit rule');
    expectContains(baselineDocPath, baselineDoc, '## 5. Current metric coverage', 'the baseline document must carry the metric matrix');
    expectContains(baselineDocPath, baselineDoc, '## 8. Update procedure', 'the baseline document must carry the one-commit update procedure');
    // The document deliberately does NOT restate the performance numbers in its identity/method sections (a
    // second hand-copied table is the defect class this gate exists to remove). The teeth section quotes the
    // gate's own observed failure strings, so it is excluded from this check.
    const teethStart = baselineDoc.indexOf('## 7. The gate');
    const beforeTeeth = teethStart < 0 ? baselineDoc : baselineDoc.slice(0, teethStart);
    for (const stale of [`${groupedInteger(summary.pinned.bootMsMedian)} ms`, formatMB(summary.pinned.rssBytesMedian)]) {
        if (beforeTeeth.includes(stale)) {
            problem(baselineDocPath, lineOf(beforeTeeth, stale), `restates the measured value ${JSON.stringify(stale)}; the numbers belong to the README/figure, which the gate already checks (a second hand-copied table is the defect class)`);
        }
    }
}

// ---- figure: regenerate it, compare bytes, and check the properties it promises -------------------
const generatorSource = readText(generatorPath);
if (generatorSource !== null) {
    const hardcodedVersion = /v[0-9]+\.[0-9]+\.[0-9]+-alpha\.[0-9]+/.exec(generatorSource);
    if (hardcodedVersion) {
        problem(generatorPath, lineOf(generatorSource, hardcodedVersion[0]), `contains a hardcoded release version ${JSON.stringify(hardcodedVersion[0])}; the figure must derive every release identity from the artifact or the caller`);
    }
    const hardcodedSha = /["'`]([0-9a-f]{7,40})["'`]/.exec(generatorSource);
    // The pinned oracle commit is a legitimate constant (the figure names the pinned subject); what must never be
    // hardcoded is the MEASURED commit, which comes from the artifact or the caller. The pinned baseline is the one
    // commit id allowed to appear as a literal in the generator.
    const PINNED_BASELINE_SHA = '06bde939fb1e9c4c8d8641d810f0a916b5bce127';
    if (hardcodedSha && !PINNED_BASELINE_SHA.startsWith(hardcodedSha[1])) {
        problem(generatorPath, lineOf(generatorSource, hardcodedSha[0]), `contains a hardcoded commit id ${JSON.stringify(hardcodedSha[1])}; the measured commit must come from the artifact or the caller`);
    }
}

const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'gotavern-perf-evidence-'));
try {
    const generated = { dark: path.join(tempRoot, 'first-dark.svg'), light: path.join(tempRoot, 'first-light.svg') };
    const regenerated = { dark: path.join(tempRoot, 'second-dark.svg'), light: path.join(tempRoot, 'second-light.svg') };
    const runGenerator = (dark, light) => spawnSync(process.execPath, [generatorPath, '--report', baselinePath, '--out', dark, '--out-light', light], { cwd: ROOT, encoding: 'utf8' });
    const first = runGenerator(generated.dark, generated.light);
    if (first.status !== 0) {
        problem(generatorPath, null, `refused to regenerate the figure variants from the baseline: ${(first.stderr || first.stdout || '').trim().split('\n').slice(-3).join(' | ')}`);
    } else {
        const second = runGenerator(regenerated.dark, regenerated.light);
        if (second.status !== 0) {
            problem(generatorPath, null, `refused a second regeneration of the figure variants: ${(second.stderr || second.stdout || '').trim().split('\n').slice(-3).join(' | ')}`);
        }
        const readBytes = file => {
            try {
                return readFileSync(file);
            } catch {
                return null;
            }
        };
        const variants = [
            { name: 'dark', committedPath: svgPath, generatedPath: generated.dark, regeneratedPath: regenerated.dark },
            { name: 'light', committedPath: svgLightPath, generatedPath: generated.light, regeneratedPath: regenerated.light },
        ];
        const compareVariant = variant => {
            const firstBytes = readBytes(variant.generatedPath);
            const secondBytes = readBytes(variant.regeneratedPath);
            if (firstBytes === null || secondBytes === null) {
                problem(generatorPath, null, `did not write the ${variant.name} figure variant`);
                return null;
            }
            if (!firstBytes.equals(secondBytes)) {
                problem(generatorPath, null, `is not deterministic for the ${variant.name} variant: two regenerations from the same baseline produced different bytes`);
            }
            const committedText = readText(variant.committedPath);
            if (committedText === null) {
                problem(variant.committedPath, null, 'cannot be read for the byte comparison');
                return null;
            }
            const committed = committedText.replace(/\r\n/g, '\n');
            const generatedText = firstBytes.toString('utf8');
            if (committed !== generatedText) {
                const committedLines = committed.split('\n');
                const generatedLines = generatedText.split('\n');
                const count = Math.max(committedLines.length, generatedLines.length);
                let firstDifference = -1;
                for (let index = 0; index < count; index++) {
                    if (committedLines[index] !== generatedLines[index]) {
                        firstDifference = index;
                        break;
                    }
                }
                const line = firstDifference < 0 ? 1 : firstDifference + 1;
                const expected = firstDifference < 0 ? '' : generatedLines[firstDifference] ?? '<missing line>';
                const actual = firstDifference < 0 ? '' : committedLines[firstDifference] ?? '<missing line>';
                problem(variant.committedPath, line, `differs from the ${variant.name} figure regenerated from ${relative(baselinePath)}: expected ${JSON.stringify(expected.slice(0, 160))}, committed ${JSON.stringify(actual.slice(0, 160))}`);
            }
            return committed;
        };
        for (const variant of variants) {
            const svg = compareVariant(variant);
            if (svg === null) continue;
            const label = `${variant.name} figure`;
            // 16:9 at the documented size, so "readable at 1:1" is a property of the committed bytes.
            expectContains(variant.committedPath, svg, 'width="1200" height="675"', `${label}: must be 1200x675 (16:9); the first screen embeds it at natural size`);
            expectContains(variant.committedPath, svg, 'viewBox="0 0 1200 675"', `${label}: the viewBox must match the 1200x675 canvas`);
            expectContains(variant.committedPath, svg, `run ${runId}`, `${label}: must name the baseline run id`);
            expectContains(variant.committedPath, svg, `commit ${shortCommit}`, `${label}: must name the baseline short commit`);
            expectContains(variant.committedPath, svg, 'decimal MB (1e6 B)', `${label}: the RSS row note must state the decimal-MB unit rule`);
            expectContains(variant.committedPath, svg, 'role="img"', `${label}: must expose role="img"`);
            expectContains(variant.committedPath, svg, '<title', `${label}: must carry a <title>`);
            expectContains(variant.committedPath, svg, '<desc', `${label}: must carry a <desc>`);
            expectContains(variant.committedPath, svg, '-fold faster', `${label}: description must carry the per-metric timing verdict`);
            expectContains(variant.committedPath, svg, '-fold lighter', `${label}: description must carry the per-metric memory verdict`);
            expectContains(variant.committedPath, svg, 'faster', `${label}: must print the timing verdict word`);
            expectContains(variant.committedPath, svg, 'lighter', `${label}: must print the memory verdict word`);
            expectContains(variant.committedPath, svg, 'COMPUTED', `${label}: must mark the ratios as derived from the printed values`);
            for (const forbidden of ['href="http', "href='http", '<script', '<image', '@font-face', 'url(http']) {
                if (svg.includes(forbidden)) problem(variant.committedPath, lineOf(svg, forbidden), `${label}: contains an external/script reference ${JSON.stringify(forbidden)}; the figure must be self-contained`);
            }
            // THE TYPE FLOOR IS CHECKED FROM THE COMMITTED SVG, not asserted in prose. Every numeric size declared
            // in a `font:`/`font-size:` declaration must be at least 12 px at 1:1, because the first screen embeds the
            // figure at natural size and the previous figure's 8.5-10.5 px labels were unreadable on a laptop.
            const sizes = [...svg.matchAll(/font(?:-size)?:\s*(?:[0-9]{3}\s+)?(\d+(?:\.\d+)?)px/g)].map(match => Number(match[1]));
            if (sizes.length === 0) problem(variant.committedPath, null, `${label}: no font sizes could be found in the figure, so the 12 px floor cannot be checked`);
            for (const size of sizes) {
                if (size < 12) {
                    problem(variant.committedPath, lineOf(svg, `${size}px`), `${label}: declares a ${size}px type size; the minimum at 1:1 is 12 px`);
                }
            }
        }
    }
} finally {
    rmSync(tempRoot, { recursive: true, force: true });
}

// ---- report --------------------------------------------------------------------------------------
if (problems.length === 0) {
    console.log(`perf-evidence: OK (${relative(baselinePath)} run ${runId} at ${shortCommit}: README table, figure bytes and provenance agree)`);
    process.exit(0);
}
const first = problems[0];
console.error('perf-evidence: FAIL');
console.error(`  - ${first.file}${first.line ? `:${first.line}` : ''}: ${first.message}`);
if (problems.length > 1) {
    console.error(`  - ${problems.length - 1} more problem(s):`);
    for (const extra of problems.slice(1)) console.error(`    - ${extra.file}${extra.line ? `:${extra.line}` : ''}: ${extra.message}`);
}
console.error('  - nothing was written; fix the surface named above or replace the baseline with a new run (docs/perf-baseline.md §8)');
process.exit(1);
