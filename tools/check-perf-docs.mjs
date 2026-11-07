#!/usr/bin/env node
// THE PERFORMANCE-EVIDENCE GATE: the README, docs/performance.md, both figure variants and the provenance
// must restate ONE recorded artifact -- tests/perf/q22-baseline.json -- and the README must stay a short,
// honest, current release surface.
//
// WHY THIS EXISTS. `v0.1.0-alpha.13`'s tag tree carried a README RSS row of 1,057 MB / 36.9 MB while the run
// it cited (`GoTavern smoke metrics` 41403239135) recorded 1,108,514,816 B / 38,647,808 B and the same tree's
// own figure printed 1,109 / 38.6 decimal MB. Nothing compared the three surfaces to the recording, so the
// mismatch survived alpha.12 and alpha.13 (M0 audit defect D1). alpha.16's README then grew to 34.5 KB with a
// stale "current release" line (alpha.15/alpha.13 text) and no length, link, duplicate or stale-version gate.
// This checker removes both classes:
//
//   * tests/perf/q22-baseline.json is the source of truth (provenance + the q22 artefact embedded verbatim);
//   * docs/assets/benchmark.svg (dark) and docs/assets/benchmark-light.svg (light) are REGENERATED from it and
//     byte-compared twice (determinism), so neither variant can drift and the two cannot disagree about data;
//   * the README and docs/performance.md performance tables are RECOMPUTED from it under one stated unit rule
//     and compared cell by cell, so a unit mismatch cannot hide;
//   * the README's first screen is checked STRUCTURALLY: figure pair through <picture>/prefers-color-scheme,
//     alt text recomputed from the artifact, shortest install+start block, links to the detail, the synthetic
//     scope and the unmet GOAL 14 claim in the same place as the claim, and no hardcoded release version;
//   * NEW: README byte+line budget (10-14 KB, ~100-150 lines), stale release text refused (a known-stale
//     version token can never be called current), internal relative/anchor links must resolve, duplicate
//     sections/paragraphs are refused, and the required regression disclosure must be present;
//   * docs/performance.md must carry the artifact identity (run, full commit, rounds, samples, soak, units),
//     the same recomputed table, p95, ratios, reproduction commands, every required UNPROVEN/report-only row,
//     the local-baseline label, the cold-guard status and its own working links/unique sections;
//   * the figures are checked for the properties they promise: 1200x675, role/title/desc, per-metric verdict
//     words, type floor >= 12 px at 1:1, WCAG contrast computed from the COMMITTED palette, dark/light data
//     consistency, and no external font, image, script or network reference;
//   * the provenance's run id, commit, rounds and soak are compared with the baseline's own provenance.
//
// ONE UNIT RULE, STATED ONCE AND USED EVERYWHERE: memory is decimal MB, 1 MB = 1,000,000 bytes. Formatting
// follows the figure's own rule (>= 100 MB -> integer with thousands separators, < 100 MB -> one decimal);
// time is milliseconds, printed with the precision the figure uses (startup integer, /version 2 decimals
// unless below 10 where 3, / 2 decimals). The gate recomputes from `rssBytesMedian` and never parses a
// number back out of a doc to "check" it.
//
// FAIL CLOSED, AND NAME EVERY FAILURE WITH A STABLE ASSERTION ID. Every problem is printed as
//   [ASSERTION-ID] file:line: message
// naming the value found, the value the artifact implies and the artifact field it came from, so a red run
// can be read without opening the tree, and a negative test can assert the exact id that went red. The exit
// status is non-zero when any problem exists; the gate never edits a file.
//
// TEETH: tests/docs/check-perf-docs.test.mjs tampers temporary copies and asserts the named failure for each
// check below; the untampered tree is the positive control. Observed ids are listed beside their checks.
//
// USAGE:
//   node tools/check-perf-docs.mjs
//   node tools/check-perf-docs.mjs --baseline <q22-baseline.json> --readme <README.md> \
//       --performance-doc <docs/performance.md> --svg <benchmark.svg> --svg-light <benchmark-light.svg> \
//       --provenance <benchmark.svg.provenance.md> --baseline-doc <perf-baseline.md> \
//       --generator <benchmark-svg.mjs> --release v0.1.0-alpha.<n> --root <repo root>
//       # overrides are used by the negative-control tests on copies

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const SCRIPT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function argument(name, fallback) {
    const index = process.argv.indexOf(name);
    return index < 0 ? fallback : process.argv[index + 1] ?? fallback;
}

const ROOT = path.resolve(argument('--root', SCRIPT_ROOT));
const baselinePath = path.resolve(argument('--baseline', path.join(ROOT, 'tests', 'perf', 'q22-baseline.json')));
const readmePath = path.resolve(argument('--readme', path.join(ROOT, 'README.md')));
const performanceDocPath = path.resolve(argument('--performance-doc', path.join(ROOT, 'docs', 'performance.md')));
const svgPath = path.resolve(argument('--svg', path.join(ROOT, 'docs', 'assets', 'benchmark.svg')));
const svgLightPath = path.resolve(argument('--svg-light', path.join(ROOT, 'docs', 'assets', 'benchmark-light.svg')));
const provenancePath = path.resolve(argument('--provenance', path.join(ROOT, 'docs', 'assets', 'benchmark.svg.provenance.md')));
const baselineDocPath = path.resolve(argument('--baseline-doc', path.join(ROOT, 'docs', 'perf-baseline.md')));
const generatorPath = path.resolve(argument('--generator', path.join(ROOT, 'tools', 'benchmark-svg.mjs')));
const alpha17Dir = path.join(ROOT, 'docs', 'alpha17');
const perfLaneDir = path.join(alpha17Dir, 'perf');
const RELEASE_VERSION = argument('--release', 'v0.1.0-alpha.17');
const RELEASES_LATEST = 'https://github.com/cocokoishi/GoTavern/releases/latest';
// Known-stale release tokens: text that was true once and must never be presented as the current release.
// It may still appear in a historical sentence ("was the previous release"), never as "current"/"latest".
const STALE_VERSION_TOKENS = ['v0.1.0-alpha.13', 'alpha.13', 'v0.1.0-alpha.15', 'alpha.15'];
const RELEASE_TOKEN_PATTERN = /\bv?0\.1\.0-alpha\.\d+\b|\balpha\.\d+\b/g;
const README_BUDGET = { minBytes: 10000, maxBytes: 14000, minLines: 100, maxLines: 160, minNonBlank: 100, maxNonBlank: 150 };

const problems = [];
function problem(assertion, file, line, message) {
    problems.push({ assertion, file: relative(file), line, message });
}
function relative(file) {
    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    return rel === '' ? '.' : rel;
}
function readText(file, assertion) {
    try {
        return readFileSync(file, 'utf8');
    } catch (error) {
        problem(assertion, file, null, `cannot be read: ${error.message}`);
        return null;
    }
}
function readJson(file, assertion) {
    const text = readText(file, assertion);
    if (text === null) return null;
    try {
        return JSON.parse(text);
    } catch (error) {
        problem(assertion, file, null, `is not valid JSON: ${error.message}`);
        return null;
    }
}
function lineOf(text, needle) {
    if (typeof needle !== 'string' || needle === '') return null;
    const index = text.split('\n').findIndex(line => line.includes(needle));
    return index < 0 ? null : index + 1;
}
function expectContains(assertion, file, text, needle, why) {
    if (text === null) return;
    if (!text.includes(needle)) problem(assertion, file, lineOf(text, needle.split('\n')[0]), `does not contain ${JSON.stringify(needle)} (${why})`);
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
const formatRatio = value => `${value >= 100 ? value.toFixed(1) : value.toFixed(2)}x`;

// ---- load the source of truth -------------------------------------------------------------------
let runId = '';
let shortCommit = '';
const baseline = readJson(baselinePath, 'ARTIFACT-READ');
if (baseline === null) {
    reportAndExit();
}
const provenance = baseline.provenance ?? {};
const report = baseline.report;
if (!report || typeof report !== 'object') {
    problem('ARTIFACT-SHAPE', baselinePath, null, 'has no embedded report; the baseline wrapper is malformed');
    reportAndExit();
}
for (const subject of ['pinned', 'gotavern']) {
    if (!report.summary?.[subject] || typeof report.summary[subject].rssBytesMedian !== 'number') {
        problem('ARTIFACT-SHAPE', baselinePath, null, `report.summary.${subject} is missing or has no rssBytesMedian`);
        reportAndExit();
    }
}
const summary = report.summary;
const rounds = report.rounds;
const requestsPerRound = report.requestsPerRound;
const soak = Array.isArray(report.soak) ? report.soak : [];
const soakOf = subject => soak.find(entry => entry.subject === subject) ?? null;
if (!/^[0-9]+$/.test(String(provenance.runId ?? ''))) problem('ARTIFACT-RUN-ID', baselinePath, null, `provenance.runId is not a GitHub Actions run id: ${JSON.stringify(provenance.runId)}`);
if (!/^[0-9a-f]{40}$/.test(String(provenance.commit ?? ''))) problem('ARTIFACT-COMMIT', baselinePath, null, `provenance.commit is not a full 40-character commit id: ${JSON.stringify(provenance.commit)}`);
if (report.runnerImage !== undefined && provenance.host?.runnerImage !== undefined && report.runnerImage !== provenance.host.runnerImage) {
    problem('ARTIFACT-RUNNER', baselinePath, null, `report.runnerImage ${JSON.stringify(report.runnerImage)} disagrees with provenance.host.runnerImage ${JSON.stringify(provenance.host.runnerImage)}`);
}
for (const entry of soak) {
    if (typeof entry.windowMs !== 'number' || typeof entry.sampleEveryMs !== 'number' || !Array.isArray(entry.series) || entry.series.length === 0) {
        problem('ARTIFACT-SOAK', baselinePath, null, `soak for ${entry.subject ?? 'unknown'} is incomplete (windowMs/sampleEveryMs/series)`);
    }
}
if (report.asserted?.everyRoundAnswered !== true) problem('ARTIFACT-ASSERTED', baselinePath, null, 'report.asserted.everyRoundAnswered is not true');
if (report.asserted?.sampleCountsMatch !== true) problem('ARTIFACT-ASSERTED', baselinePath, null, 'report.asserted.sampleCountsMatch is not true');

const shortCommitRecorded = String(provenance.commit ?? '').slice(0, 7);
runId = String(provenance.runId ?? '');
shortCommit = shortCommitRecorded;
const goSoak = soakOf('gotavern');
const pinnedSoak = soakOf('pinned');

// ---- shared markdown helpers --------------------------------------------------------------------
function headingSlug(text) {
    return text
        .replace(/<[^>]+>/g, '')
        .replace(/`([^`]*)`/g, '$1')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/[*_~]/g, '')
        .trim()
        .toLowerCase()
        .replace(/[^\p{L}\p{N} -]/gu, '')
        .replace(/\s+/g, '-');
}
function headingsOf(text) {
    return [...text.matchAll(/^(#{1,6})\s+(.+?)\s*#*\s*$/gm)].map(match => ({ level: match[1].length, text: match[2].trim(), slug: headingSlug(match[2]) }));
}
function sectionOf(text, headingName) {
    const lines = text.split('\n');
    const start = lines.findIndex(line => new RegExp(`^##\\s+${headingName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`).test(line));
    if (start < 0) return null;
    const end = lines.findIndex((line, index) => index > start && /^##\s+/.test(line));
    return { start, end: end < 0 ? lines.length : end, text: lines.slice(start, end < 0 ? lines.length : end).join('\n') };
}
function markdownLinks(text) {
    const links = [];
    for (const match of text.matchAll(/(?<!!)\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) links.push(match[1]);
    return links;
}
function checkLinks(assertion, file, text, baseDir) {
    if (text === null) return;
    const byDocumentHeadings = headingsOf(text);
    for (const target of markdownLinks(text)) {
        let anchor = '';
        let destination = target;
        if (destination.startsWith('#')) {
            anchor = destination.slice(1);
            destination = '';
        } else if (destination.includes('#')) {
            const hash = destination.indexOf('#');
            anchor = destination.slice(hash + 1);
            destination = destination.slice(0, hash);
        }
        try {
            destination = decodeURIComponent(destination);
        } catch {
            // keep the raw form; a malformed escape will fail the existence check
        }
        destination = destination.replace(/^<|>$/g, '');
        if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(destination)) continue; // external / schemes
        if (destination === '') {
            if (anchor !== '' && !byDocumentHeadings.some(heading => heading.slug === anchor)) {
                problem(assertion, file, lineOf(text, target), `link target ${JSON.stringify(target)} points at an anchor no heading defines`);
            }
            continue;
        }
        const resolved = path.resolve(baseDir, destination);
        if (!existsSync(resolved)) {
            problem(assertion, file, lineOf(text, target), `relative link ${JSON.stringify(target)} does not resolve to an existing path (resolved ${JSON.stringify(relative(resolved))})`);
            continue;
        }
        if (anchor !== '' && destination.endsWith('.md') && statSync(resolved).isFile()) {
            const targetText = readText(resolved, assertion);
            if (targetText !== null && !headingsOf(targetText).some(heading => heading.slug === anchor)) {
                problem(assertion, file, lineOf(text, target), `link target ${JSON.stringify(target)} points at ${JSON.stringify(anchor)}, which is not a heading in that document`);
            }
        }
    }
}
function checkDuplicates(prefix, file, text) {
    if (text === null) return;
    const seenHeadings = new Map();
    for (const heading of headingsOf(text)) {
        const key = `${heading.level}:${heading.text}`;
        seenHeadings.set(key, (seenHeadings.get(key) ?? 0) + 1);
    }
    for (const [key, count] of seenHeadings) {
        if (count > 1) problem(`${prefix}-DUPLICATE-SECTION`, file, null, `heading ${JSON.stringify(key.split(':')[1])} appears ${count} times (level ${key.split(':')[0]})`);
    }
    const seenParagraphs = new Map();
    for (const block of text.split(/\n{2,}/)) {
        const normalized = block.replace(/\s+/g, ' ').trim();
        if (normalized.length < 120) continue;
        if (/^(?:\||#|<|```|[-*+] |\d+\. )/.test(normalized)) continue;
        seenParagraphs.set(normalized, (seenParagraphs.get(normalized) ?? 0) + 1);
    }
    for (const [paragraph, count] of seenParagraphs) {
        if (count > 1) problem(`${prefix}-DUPLICATE-PARAGRAPH`, file, null, `paragraph appears ${count} times: ${JSON.stringify(paragraph.slice(0, 100))}...`);
    }
}
function checkVersionText(prefix, file, text) {
    if (text === null) return;
    const currentClaim = /\b(?:current|currently|latest|releases\/latest|:latest|serves|points at|stable release|stable-channel release)\b/i;
    const historical = /\b(?:previous|earlier|older|prior|superseded|was|history|historical)\b/i;
    text.split('\n').forEach((line, index) => {
        for (const token of line.match(RELEASE_TOKEN_PATTERN) ?? []) {
            if (STALE_VERSION_TOKENS.includes(token)) {
                problem(`${prefix}-STALE-VERSION`, file, index + 1, `contains the known-stale release token ${JSON.stringify(token)}; it may not appear on a current release surface`);
            } else if (currentClaim.test(line) && !historical.test(line) && token !== RELEASE_VERSION) {
                problem(`${prefix}-STALE-VERSION`, file, index + 1, `presents ${JSON.stringify(token)} with current/latest wording but the release this tree ships is ${JSON.stringify(RELEASE_VERSION)}`);
            }
        }
    });
}

// ---- README: length budget, release identity, links, duplicates ---------------------------------
const readme = readText(readmePath, 'README-READ');
if (readme !== null) {
    const bytes = Buffer.byteLength(readme, 'utf8');
    const rawLines = readme.split('\n').length;
    const nonBlankLines = readme.split('\n').filter(line => /\S/.test(line)).length;
    if (bytes < README_BUDGET.minBytes || bytes > README_BUDGET.maxBytes) {
        problem('README-BUDGET', readmePath, null, `is ${bytes} B; the first-screen release surface must stay between ${README_BUDGET.minBytes} and ${README_BUDGET.maxBytes} B (detail belongs in docs/performance.md)`);
    }
    if (rawLines < README_BUDGET.minLines || rawLines > README_BUDGET.maxLines) {
        problem('README-BUDGET', readmePath, null, `has ${rawLines} raw lines; keep it between ${README_BUDGET.minLines} and ${README_BUDGET.maxLines}`);
    }
    if (nonBlankLines < README_BUDGET.minNonBlank || nonBlankLines > README_BUDGET.maxNonBlank) {
        problem('README-BUDGET', readmePath, null, `has ${nonBlankLines} non-blank lines; keep it between ${README_BUDGET.minNonBlank} and ${README_BUDGET.maxNonBlank}`);
    }
    expectContains('README-RELEASE-TOKEN', readmePath, readme, RELEASE_VERSION, 'the README must name the release this tree ships');
    expectContains('README-RELEASES-LATEST', readmePath, readme, RELEASES_LATEST, 'the README must link the authoritative releases/latest page');
    checkVersionText('README', readmePath, readme);
    checkLinks('README-LINK', readmePath, readme, ROOT);
    checkDuplicates('README', readmePath, readme);
}

// ---- README: the FIRST SCREEN, checked structurally ----------------------------------------------
// GOAL.md 15.6 fixes what a reader sees before scrolling: name and one-line description, one real performance
// figure, the shortest install/start block, the compatibility state with known limits, and links to the detail.
// A prose claim cannot be gated, but its STRUCTURE can: the boundary is the "## Release status" heading, and
// everything before it is the first screen. The release history and the CI badges are deliberately below that
// boundary, so a stale release version or a badge cannot creep back up into the first thing a reader sees.
if (readme !== null) {
    const lines = readme.split('\n');
    const firstScreenEnd = lines.findIndex(line => /^##\s+Release status\s*$/.test(line));
    if (firstScreenEnd < 0) {
        problem('README-FIRST-SCREEN-BOUNDARY', readmePath, null, 'has no "## Release status" heading, so the gate cannot tell where the first screen ends (the release history and CI badges must live below the first screen)');
    }
    const firstScreen = lines.slice(0, firstScreenEnd < 0 ? lines.length : firstScreenEnd).join('\n');
    const firstScreenProblem = (assertion, message, line = null) => problem(assertion, readmePath, line, `first screen: ${message}`);
    // (a) the ONE figure, in both variants, selected by GitHub's colour scheme.
    if (!firstScreen.includes('<picture')) firstScreenProblem('README-FIGURE-PAIR', 'has no <picture> element, so the figure cannot be the one image of the first screen');
    if (!firstScreen.includes('prefers-color-scheme')) firstScreenProblem('README-FIGURE-PAIR', 'does not choose the figure variant with prefers-color-scheme, so the dark/light pair cannot be selected by GitHub');
    for (const variant of ['docs/assets/benchmark.svg', 'docs/assets/benchmark-light.svg']) {
        if (!firstScreen.includes(variant)) firstScreenProblem('README-FIGURE-PAIR', `does not reference the figure variant ${variant} (both variants must be referenced, or one of them is unreachable)`);
    }
    // THE ALT TEXT IS A FIRST-SCREEN NUMBER SURFACE TOO, so it is recomputed like a table cell rather than trusted.
    // Without this, the alt text would be the one place in the first screen where a hand-copied number could drift
    // from the artifact (the defect class this gate exists to remove).
    const imgAlt = /<img\b[^>]*\balt="([^"]*)"/.exec(firstScreen);
    if (!imgAlt) {
        firstScreenProblem('README-ALT-TEXT', 'has no <img alt="..."> inside the first screen, so the figure has no text alternative');
    } else {
        const altCells = [
            { pinned: `${groupedInteger(summary.pinned.bootMsMedian)} ms`, go: `${groupedInteger(summary.gotavern.bootMsMedian)} ms`, ratio: formatRatio(summary.pinned.bootMsMedian / summary.gotavern.bootMsMedian), source: 'report.summary.*.bootMsMedian' },
            { pinned: formatMB(summary.pinned.rssBytesMedian), go: formatMB(summary.gotavern.rssBytesMedian), ratio: formatRatio(summary.pinned.rssBytesMedian / summary.gotavern.rssBytesMedian), source: 'report.summary.*.rssBytesMedian' },
            { pinned: `${formatMs(summary.pinned.versionMedianMs)} ms`, go: `${formatMs(summary.gotavern.versionMedianMs)} ms`, ratio: formatRatio(summary.pinned.versionMedianMs / summary.gotavern.versionMedianMs), source: 'report.summary.*.versionMedianMs' },
            { pinned: `${summary.pinned.rootMedianMs.toFixed(2)} ms`, go: `${summary.gotavern.rootMedianMs.toFixed(2)} ms`, ratio: formatRatio(summary.pinned.rootMedianMs / summary.gotavern.rootMedianMs), source: 'report.summary.*.rootMedianMs' },
        ];
        for (const cells of altCells) {
            for (const value of [cells.pinned, cells.go, cells.ratio]) {
                if (!imgAlt[1].includes(value)) firstScreenProblem('README-ALT-TEXT-VALUE', `figure alt text does not carry ${JSON.stringify(value)} recomputed from ${cells.source}; a hand-copied number in the first screen can drift from the recorded artifact`);
            }
        }
    }
    // (b) the shortest install+start block, on both platforms, not a link to it.
    for (const command of ['install.sh', './start.sh', 'install.ps1', '.\\Start.cmd']) {
        if (!firstScreen.includes(command)) firstScreenProblem('README-START-BLOCK', `does not carry the shortest start block: it is missing ${JSON.stringify(command)}`);
    }
    // (c) links to the detail, by anchor, so the first screen cannot become a dead end.
    for (const anchor of ['(#performance)', '(#compatibility)', '(#install)']) {
        if (!firstScreen.includes(anchor)) firstScreenProblem('README-FIRST-SCREEN-LINKS', `does not link the detailed section ${anchor}`);
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
        if (!firstScreen.toLowerCase().includes(needle.toLowerCase())) firstScreenProblem('README-FIRST-SCREEN-SCOPE', `does not contain ${JSON.stringify(needle)} (${why})`);
    }
    // (e) no GoTavern release version in the first screen: a release tag there is a number that goes stale on
    // every release, and the release history has its own section below. The pinned upstream baseline ("1.19.0")
    // is a deliberate constant, not a GoTavern release, so it does not match this pattern.
    const releaseVersion = /\bv?0\.\d+\.\d+(?:-[0-9A-Za-z.]+)?|\balpha\.\d+\b/.exec(firstScreen);
    if (releaseVersion) firstScreenProblem('README-FIRST-SCREEN-VERSION', `contains a hardcoded GoTavern release version ${JSON.stringify(releaseVersion[0])}; release history belongs below the first screen`, lineOf(firstScreen, releaseVersion[0]));
    // Wording rule, whole document: the strong claim is not demonstrated, so no surface may say the product is
    // perfectly compatible. The word "drop-in" stays available because the README uses it as the NAME of the
    // release qualification gates, which is what they are called.
    const perfect = /perfect(?:ly)?[\s-]*compatib/i.exec(readme);
    if (perfect) problem('README-WORDING', readmePath, lineOf(readme, perfect[0]), `claims ${JSON.stringify(perfect[0])}; GOAL.md 14's strong claim is not met, so compatibility wording must carry its scope`);
}

// ---- README and docs/performance.md: the performance table, p95, unit rule, soak, regressions ------
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
const cleanCell = value => String(value ?? '').replace(/\*\*/g, '').trim();
function checkPerformanceTable(prefix, file, text) {
    if (text === null) return;
    const lines = text.split('\n');
    for (const row of expectedRows) {
        const indexes = lines
            .map((line, lineIndex) => (line.trim().startsWith(`| ${row.label} |`) ? lineIndex : -1))
            .filter(index => index >= 0);
        if (indexes.length === 0) {
            problem(`${prefix}-TABLE-ROW`, file, null, `has no table row starting with "| ${row.label} |"`);
            continue;
        }
        for (const index of indexes) {
            const cells = lines[index].split('|').map(cell => cell.trim());
            const pinnedCell = cleanCell(cells[2]);
            const goCell = cleanCell(cells[3]);
            if (pinnedCell !== row.pinned) {
                problem(`${prefix}-TABLE-PINNED`, file, index + 1, `row ${JSON.stringify(row.label)}: pinned cell is ${JSON.stringify(pinnedCell)}, the artifact gives ${JSON.stringify(row.pinned)} (${row.source})`);
            }
            if (goCell !== row.gotavern) {
                problem(`${prefix}-TABLE-GOTAVERN`, file, index + 1, `row ${JSON.stringify(row.label)}: GoTavern cell is ${JSON.stringify(goCell)}, the artifact gives ${JSON.stringify(row.gotavern)} (${row.source})`);
            }
            if (cells.length > 4) {
                const howCell = cleanCell(cells[4]);
                if (howCell !== '' && !howCell.includes(row.measured)) {
                    problem(`${prefix}-TABLE-HOW`, file, index + 1, `row ${JSON.stringify(row.label)}: measurement cell does not contain ${JSON.stringify(row.measured)} (it says ${JSON.stringify(howCell)})`);
                }
            }
        }
    }
    // p95 quoted inline in the /version row; recompute it rather than trusting the text.
    const expectedP95 = `${formatMs(summary.pinned.versionP95Ms)} / ${formatMs(summary.gotavern.versionP95Ms)}`;
    if (!text.includes(`p95: ${expectedP95}`)) {
        problem(`${prefix}-P95`, file, null, `does not quote p95 ${JSON.stringify(expectedP95)} from report.summary.*.versionP95Ms (${summary.pinned.versionP95Ms} / ${summary.gotavern.versionP95Ms})`);
    }
    // The RSS row must say 30 requests PER PATH, i.e. 60 per round; the pre-gate text said "30 requests
    // per round", which understated the load the second RSS sample follows.
    if (!text.includes('30 requests per path (60 per round)')) {
        problem(`${prefix}-RSS-SAMPLING`, file, null, 'does not state "30 requests per path (60 per round)" (the harness issues 30 per path before the second RSS sample)');
    }
    if (!text.includes('VmRSS')) problem(`${prefix}-RSS-SAMPLING`, file, null, 'does not name VmRSS, the recorded RSS source');
}
function checkCitation(prefix, file, text) {
    if (text === null) return;
    expectContains(`${prefix}-RUN`, file, text, `run \`${runId}\``, 'must cite the baseline run id');
    expectContains(`${prefix}-COMMIT`, file, text, `\`${shortCommit}\``, 'must cite the baseline short commit');
    if (goSoak && pinnedSoak) {
        expectContains(`${prefix}-SOAK`, file, text, formatSigned(goSoak.rssDriftBytes / 1e6, 1, 'MB'), `the GoTavern soak RSS drift must be recomputed from soak[].rssDriftBytes (${goSoak.rssDriftBytes} B)`);
        expectContains(`${prefix}-SOAK`, file, text, formatSigned(goSoak.p95DriftMs, 2, 'ms'), `the GoTavern soak p95 drift must be recomputed from soak[].p95DriftMs (${goSoak.p95DriftMs})`);
        expectContains(`${prefix}-SOAK`, file, text, formatSigned(pinnedSoak.p95DriftMs, 2, 'ms'), `the pinned soak p95 drift must be recomputed from soak[].p95DriftMs (${pinnedSoak.p95DriftMs})`);
    } else {
        problem(`${prefix}-SOAK`, file, null, 'the soak sentence cannot be checked: the baseline has no two-subject soak');
    }
}
if (readme !== null) {
    const section = sectionOf(readme, 'Performance');
    if (section === null) {
        problem('README-SECTION-PERFORMANCE', readmePath, null, 'has no "## Performance" section, so the gate has nothing to check');
    } else {
        const sectionText = section.text;
        expectContains('README-UNIT', readmePath, sectionText, '1 MB = 1,000,000 bytes', 'the README must state the decimal-MB unit rule once');
        checkPerformanceTable('README', readmePath, sectionText);
        checkCitation('README', readmePath, sectionText);
        // REGRESSION DISCLOSURE: the / median carries gzip CPU, and no headline improvement is claimed. A
        // README that only lists wins is hiding a measured cost.
        if (!sectionText.includes('gzip CPU')) problem('README-REGRESSION', readmePath, null, 'does not disclose that `/` carries gzip CPU (the measured cost of compressing the HTML shell)');
        if (!/does not claim an improvement|no improvement/i.test(sectionText)) problem('README-REGRESSION', readmePath, null, 'does not state that no improvement is claimed in the four headline metrics (the deltas are inside run-to-run variation)');
    }
}

// ---- docs/performance.md: provenance identity, table, ratios, UNPROVEN row and local label ---------
const performanceDoc = readText(performanceDocPath, 'PERF-DOC-READ');
if (performanceDoc !== null) {
    const lines = performanceDoc.split('\n');
    if (!/^\*{0,2}Status:/m.test(performanceDoc)) problem('PERF-DOC-STATUS', performanceDocPath, null, 'has no "Status:" line (it must say VERIFIED or DRAFT)');
    expectContains('PERF-DOC-RUN', performanceDocPath, performanceDoc, `run \`${runId}\``, 'the detailed document must name the baseline run id');
    expectContains('PERF-DOC-COMMIT', performanceDocPath, performanceDoc, String(provenance.commit ?? ''), 'the detailed document must name the full measured commit');
    expectContains('PERF-DOC-ROUNDS', performanceDocPath, performanceDoc, `${rounds} alternating rounds × ${requestsPerRound} sequential requests per path`, `must state ${rounds} rounds × ${requestsPerRound} requests per path from the baseline`);
    expectContains('PERF-DOC-UNITS', performanceDocPath, performanceDoc, '1 MB = 1,000,000 bytes', 'must state the decimal-MB unit rule');
    expectContains('PERF-DOC-UNITS', performanceDocPath, performanceDoc, 'decimal MB', 'must name the decimal-MB unit');
    // The heading table is checked in its own section: the before/after section legitimately repeats the ROW
    // label with a PREVIOUS record's value in a different column, and that occurrence must not be read as a
    // second claim about this artifact.
    const headlineSection = sectionOf(performanceDoc, '2. The four headline metrics');
    if (headlineSection === null) problem('PERF-DOC-TABLE-ROW', performanceDocPath, null, 'has no "## 2. The four headline metrics" section, so the recorded table has no home');
    checkPerformanceTable('PERF-DOC', performanceDocPath, headlineSection?.text ?? null);
    checkCitation('PERF-DOC', performanceDocPath, performanceDoc);
    const ratios = [
        formatRatio(summary.pinned.bootMsMedian / summary.gotavern.bootMsMedian),
        formatRatio(summary.pinned.rssBytesMedian / summary.gotavern.rssBytesMedian),
        formatRatio(summary.pinned.versionMedianMs / summary.gotavern.versionMedianMs),
        formatRatio(summary.pinned.rootMedianMs / summary.gotavern.rootMedianMs),
    ];
    for (const ratio of ratios) expectContains('PERF-DOC-RATIOS', performanceDocPath, performanceDoc, ratio, `must print the computed ratio ${ratio} (derived from the two recorded values)`);
    // The documented before/after record must name the previous run id and commit it compares against.
    expectContains('PERF-DOC-BEFORE-AFTER', performanceDocPath, performanceDoc, '`41777492725`', 'must name the previous recorded run it compares with');
    expectContains('PERF-DOC-BEFORE-AFTER', performanceDocPath, performanceDoc, '`4fd8ed7`', 'must name the previous recorded commit it compares with');
    // The optimization's both-direction claim: the cold cost must not be hidden beside the repeat win.
    for (const [needle, why] of [
        ['cold first request', 'must state the cost of the cache on the cold first request, not only the repeat win'],
        ['+21%', 'must state the measured cold-first-request cost (+21%)'],
        ['gzip CPU', 'must disclose that `/` carries gzip CPU (the measured compression cost)'],
    ]) {
        expectContains('PERF-DOC-REGRESSION', performanceDocPath, performanceDoc, needle, why);
    }
    // The local engineering baseline must stay labelled local, because it is NOT part of the paired artifact.
    expectContains('PERF-DOC-LOCAL-LABEL', performanceDocPath, performanceDoc, 'These are local, single-machine numbers', 'the local before/after benchmark table must stay labelled local (it is not part of the paired artifact)');
    // EVERY required honest row is named here; a missing one means scope has been implied rather than stated.
    const unproven = [
        ['GOAL.md', 'must cite GOAL.md so the synthetic scope is checkable'],
        ['NOT MET', 'must state that the strong drop-in bar is NOT MET'],
        ['REPORT-ONLY', 'must state that the 8-user latency row is report-only'],
        ['detection floor', 'must state that the soak rule is a detection floor'],
        ['macOS ARM64', 'must state the macOS ARM64 runtime status'],
        ['UNVERIFIED', 'must state an unverified platform/row explicitly'],
        ['windows/arm64', 'must state the windows/arm64 status'],
        ['BUILD-ONLY', 'must state that windows/arm64 is build-only'],
        ['ENOSPC', 'must state the real-kernel ENOSPC status'],
        ['UNPROVEN', 'must state the unproven rows explicitly'],
    ];
    for (const [needle, why] of unproven) {
        if (!performanceDoc.toLowerCase().includes(needle.toLowerCase())) problem('PERF-DOC-UNPROVEN', performanceDocPath, null, `does not contain ${JSON.stringify(needle)} (${why})`);
    }
    // COLD-GUARD: while the perf lane has produced no record, this document must say so; once a record exists
    // under docs/alpha17/perf/, the document must point at it instead of claiming it is pending.
    expectContains('PERF-DOC-COLD-GUARD', performanceDocPath, performanceDoc, 'cold-guard', 'must name the cold-guard row');
    const perfLaneHasArtifacts = existsSync(perfLaneDir) && statSync(perfLaneDir).isDirectory();
    if (perfLaneHasArtifacts) {
        expectContains('PERF-DOC-COLD-GUARD', performanceDocPath, performanceDoc, 'docs/alpha17/perf/', 'the perf lane now has records; the document must point at docs/alpha17/perf/');
    } else if (!/pending/i.test(performanceDoc)) {
        problem('PERF-DOC-COLD-GUARD', performanceDocPath, null, 'the cold-guard row has no record in docs/alpha17/perf/ and the document does not say it is pending');
    }
    checkVersionText('PERF-DOC', performanceDocPath, performanceDoc);
    checkLinks('PERF-DOC-LINK', performanceDocPath, performanceDoc, path.join(ROOT, 'docs'));
    checkDuplicates('PERF-DOC', performanceDocPath, performanceDoc);
}

// ---- provenance: it must name the same run, commit, rounds and soak, and both figure variants ---------
const provenanceText = readText(provenancePath, 'PROVENANCE-READ');
if (provenanceText !== null) {
    expectContains('PROVENANCE-RUN', provenancePath, provenanceText, `| run id | \`${runId}\``, 'provenance must name the baseline run id');
    expectContains('PROVENANCE-COMMIT', provenancePath, provenanceText, String(provenance.commit ?? ''), 'provenance must name the full baseline commit');
    expectContains('PROVENANCE-ROUNDS', provenancePath, provenanceText, `${rounds} alternating rounds x ${requestsPerRound} sequential requests per path`, `provenance must state ${rounds} rounds x ${requestsPerRound} requests per path from the baseline`);
    expectContains('PROVENANCE-SOAK', provenancePath, provenanceText, '2 x 10-minute windows, one per subject, 30 s sampling (both completed)', 'provenance must state the soak shape the artifact records');
    if (provenance.host?.runnerImage) expectContains('PROVENANCE-RUNNER', provenancePath, provenanceText, String(provenance.host.runnerImage), 'provenance must name the runner image recorded with the baseline');
    expectContains('PROVENANCE-UNITS', provenancePath, provenanceText, 'decimal MB (1e6 B)', 'provenance must state the decimal-MB unit rule');
    expectContains('PROVENANCE-UNITS', provenancePath, provenanceText, 'stated on the row', 'provenance claims the unit is stated on the row; the figure must actually state it');
    expectContains('PROVENANCE-PAIR', provenancePath, provenanceText, 'benchmark-light.svg', 'provenance must name the light figure variant next to the dark one');
    expectContains('PROVENANCE-CANVAS', provenancePath, provenanceText, '1200', 'provenance must state the shared canvas size');
    expectContains('PROVENANCE-CONTRAST', provenancePath, provenanceText, 'contrast', 'provenance must record the contrast audit');
    expectContains('PROVENANCE-TYPE-FLOOR', provenancePath, provenanceText, '12 px', 'provenance must state the minimum type size at 1:1');
    expectContains('PROVENANCE-REGEN', provenancePath, provenanceText, '--out-light', 'the update procedure must regenerate BOTH variants');
}

// ---- baseline document: identity only, no second hand-copied number table -------------------------
const baselineDoc = readText(baselineDocPath, 'BASELINE-DOC-READ');
if (baselineDoc !== null) {
    expectContains('BASELINE-DOC-RUN', baselineDocPath, baselineDoc, String(provenance.runId ?? ''), 'the baseline document must name the baseline run id');
    expectContains('BASELINE-DOC-COMMIT', baselineDocPath, baselineDoc, String(provenance.commit ?? ''), 'the baseline document must name the full baseline commit');
    expectContains('BASELINE-DOC-ROUNDS', baselineDocPath, baselineDoc, `${rounds} alternating rounds × ${requestsPerRound} sequential requests per path`, `the baseline document must state ${rounds} rounds × ${requestsPerRound} requests per path from the baseline`);
    if (provenance.host?.cpuCount !== undefined && provenance.host?.cpuCount !== null) {
        expectContains('BASELINE-DOC-CPU', baselineDocPath, baselineDoc, `${provenance.host.cpuCount} vCPU`, 'the baseline document must state the recorded CPU count');
    }
    if (typeof provenance.host?.totalMemoryBytes === 'number') {
        expectContains('BASELINE-DOC-RAM', baselineDocPath, baselineDoc, `${groupedInteger(provenance.host.totalMemoryBytes)} B`, 'the baseline document must state the recorded RAM');
    }
    expectContains('BASELINE-DOC-UNITS', baselineDocPath, baselineDoc, 'decimal MB', 'the baseline document must state the unit rule');
    expectContains('BASELINE-DOC-COVERAGE', baselineDocPath, baselineDoc, '## 5. Current metric coverage', 'the baseline document must carry the metric matrix');
    expectContains('BASELINE-DOC-UPDATE', baselineDocPath, baselineDoc, '## 8. Update procedure', 'the baseline document must carry the one-commit update procedure');
    expectContains('BASELINE-DOC-POINTER', baselineDocPath, baselineDoc, 'docs/performance.md', 'the baseline document must point at the detailed performance document so detail is not duplicated here');
    // The document deliberately does NOT restate the performance numbers in its identity/method sections (a
    // second hand-copied table is the defect class this gate exists to remove). The teeth section quotes the
    // gate's own observed failure strings, so it is excluded from this check.
    const teethStart = baselineDoc.indexOf('## 7. The gate');
    const beforeTeeth = teethStart < 0 ? baselineDoc : baselineDoc.slice(0, teethStart);
    for (const stale of [`${groupedInteger(summary.pinned.bootMsMedian)} ms`, formatMB(summary.pinned.rssBytesMedian)]) {
        if (beforeTeeth.includes(stale)) {
            problem('BASELINE-DOC-NO-SECOND-TABLE', baselineDocPath, lineOf(beforeTeeth, stale), `restates the measured value ${JSON.stringify(stale)}; the numbers belong to the README/figure, which the gate already checks (a second hand-copied table is the defect class)`);
        }
    }
}

// ---- generator: no hardcoded release identity ---------------------------------------------------
const generatorSource = readText(generatorPath, 'GENERATOR-READ');
if (generatorSource !== null) {
    const hardcodedVersion = /v[0-9]+\.[0-9]+\.[0-9]+-alpha\.[0-9]+/.exec(generatorSource);
    if (hardcodedVersion) {
        problem('GENERATOR-VERSION', generatorPath, lineOf(generatorSource, hardcodedVersion[0]), `contains a hardcoded release version ${JSON.stringify(hardcodedVersion[0])}; the figure must derive every release identity from the artifact or the caller`);
    }
    const hardcodedSha = /["'`]([0-9a-f]{7,40})["'`]/.exec(generatorSource);
    // The pinned oracle commit is a legitimate constant (the figure names the pinned subject); what must never be
    // hardcoded is the MEASURED commit, which comes from the artifact or the caller. The pinned baseline is the one
    // commit id allowed to appear as a literal in the generator.
    const PINNED_BASELINE_SHA = '06bde939fb1e9c4c8d8641d810f0a916b5bce127';
    if (hardcodedSha && !PINNED_BASELINE_SHA.startsWith(hardcodedSha[1])) {
        problem('GENERATOR-COMMIT', generatorPath, lineOf(generatorSource, hardcodedSha[0]), `contains a hardcoded commit id ${JSON.stringify(hardcodedSha[1])}; the measured commit must come from the artifact or the caller`);
    }
}

// ---- figure: regenerate it, compare bytes, and check the properties it promises -------------------
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'gotavern-perf-evidence-'));
try {
    const generated = { dark: path.join(tempRoot, 'first-dark.svg'), light: path.join(tempRoot, 'first-light.svg') };
    const regenerated = { dark: path.join(tempRoot, 'second-dark.svg'), light: path.join(tempRoot, 'second-light.svg') };
    const runGenerator = (dark, light) => spawnSync(process.execPath, [generatorPath, '--report', baselinePath, '--out', dark, '--out-light', light], { cwd: ROOT, encoding: 'utf8' });
    const first = runGenerator(generated.dark, generated.light);
    if (first.status !== 0) {
        problem('FIGURE-REGEN', generatorPath, null, `refused to regenerate the figure variants from the baseline: ${(first.stderr || first.stdout || '').trim().split('\n').slice(-3).join(' | ')}`);
    } else {
        const second = runGenerator(regenerated.dark, regenerated.light);
        if (second.status !== 0) {
            problem('FIGURE-REGEN', generatorPath, null, `refused a second regeneration of the figure variants: ${(second.stderr || second.stdout || '').trim().split('\n').slice(-3).join(' | ')}`);
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
        const committedTexts = {};
        const compareVariant = variant => {
            const firstBytes = readBytes(variant.generatedPath);
            const secondBytes = readBytes(variant.regeneratedPath);
            if (firstBytes === null || secondBytes === null) {
                problem('FIGURE-REGEN', generatorPath, null, `did not write the ${variant.name} figure variant`);
                return null;
            }
            if (!firstBytes.equals(secondBytes)) {
                problem('FIGURE-DETERMINISTIC', generatorPath, null, `is not deterministic for the ${variant.name} variant: two regenerations from the same baseline produced different bytes`);
            }
            const committedText = readText(variant.committedPath, 'FIGURE-READ');
            if (committedText === null) return null;
            committedTexts[variant.name] = committedText;
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
                problem(`FIGURE-BYTES-${variant.name.toUpperCase()}`, variant.committedPath, line, `differs from the ${variant.name} figure regenerated from ${relative(baselinePath)}: expected ${JSON.stringify(expected.slice(0, 160))}, committed ${JSON.stringify(actual.slice(0, 160))}`);
            }
            return committed;
        };
        for (const variant of variants) {
            const svg = compareVariant(variant);
            if (svg === null) continue;
            const label = `${variant.name} figure`;
            const check = assertion => (needle, message) => {
                if (!svg.includes(needle)) problem(assertion, variant.committedPath, null, `${label}: ${message}`);
            };
            // 16:9 at the documented size, so "readable at 1:1" is a property of the committed bytes.
            check('FIGURE-CANVAS')('width="1200" height="675"', 'must be 1200x675 (16:9); the first screen embeds it at natural size');
            check('FIGURE-CANVAS')('viewBox="0 0 1200 675"', 'the viewBox must match the 1200x675 canvas');
            check('FIGURE-ATTRIBUTES')(`run ${runId}`, 'must name the baseline run id');
            check('FIGURE-ATTRIBUTES')(`commit ${shortCommit}`, 'must name the baseline short commit');
            check('FIGURE-UNITS')('decimal MB (1e6 B)', 'the RSS row note must state the decimal-MB unit rule');
            check('FIGURE-ATTRIBUTES')('role="img"', 'must expose role="img"');
            check('FIGURE-ATTRIBUTES')('<title', 'must carry a <title>');
            check('FIGURE-ATTRIBUTES')('<desc', 'must carry a <desc>');
            check('FIGURE-VERDICT')('-fold faster', 'description must carry the per-metric timing verdict');
            check('FIGURE-VERDICT')('-fold lighter', 'description must carry the per-metric memory verdict');
            check('FIGURE-VERDICT')('faster', 'must print the timing verdict word');
            check('FIGURE-VERDICT')('lighter', 'must print the memory verdict word');
            check('FIGURE-VERDICT')('COMPUTED', 'must mark the ratios as derived from the printed values');
            for (const forbidden of ['href="http', "href='http", '<script', '<image', '@font-face', 'url(http']) {
                if (svg.includes(forbidden)) problem('FIGURE-EXTERNAL', variant.committedPath, lineOf(svg, forbidden), `${label}: contains an external/script reference ${JSON.stringify(forbidden)}; the figure must be self-contained`);
            }
            checkFigurePalette(variant, svg);
        }
        // DARK/LIGHT DATA CONSISTENCY: one generator run writes both variants, so their accessible description
        // must be identical. A pair that disagrees about a value is the "two figures, two truths" defect.
        const descOf = text => {
            const match = /<desc[^>]*>([\s\S]*?)<\/desc>/.exec(text ?? '');
            return match ? match[1].replace(/\s+/g, ' ').trim() : null;
        };
        const darkDesc = descOf(committedTexts.dark);
        const lightDesc = descOf(committedTexts.light);
        if (darkDesc === null || lightDesc === null) {
            problem('FIGURE-PAIR-CONSISTENT', svgPath, null, 'the two figure variants do not both carry a <desc>, so their data consistency cannot be checked');
        } else if (darkDesc !== lightDesc) {
            problem('FIGURE-PAIR-CONSISTENT', svgLightPath, lineOf(committedTexts.light, '<desc'), `the light variant's description differs from the dark variant's; both must restate the same recorded data (dark: ${JSON.stringify(darkDesc.slice(0, 120))}, light: ${JSON.stringify(lightDesc.slice(0, 120))})`);
        }
    }
} finally {
    rmSync(tempRoot, { recursive: true, force: true });
}

// WCAG 2.1 contrast and the 12 px type floor, computed from the COMMITTED palette rather than asserted in prose.
// The generator refuses to render below its thresholds, so this is the second opinion on the committed bytes:
// a hand-edited fill or a lowered type size cannot pass merely because the generator was not re-run.
function relativeLuminance(hex) {
    const channels = [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16) / 255)
        .map(value => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}
function contrastRatio(foreground, background) {
    const [high, low] = [relativeLuminance(foreground), relativeLuminance(background)].sort((a, b) => b - a);
    return (high + 0.05) / (low + 0.05);
}
function checkFigurePalette(variant, svg) {
    const style = /<style[^>]*>([\s\S]*?)<\/style>/.exec(svg);
    if (!style) {
        problem(`FIGURE-CONTRAST-${variant.name.toUpperCase()}`, variant.committedPath, null, `${variant.name} figure: no <style> palette could be found, so contrast and type size cannot be checked`);
        return;
    }
    const rules = [];
    for (const rule of style[1].matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const selector = rule[1].trim();
        const body = rule[2];
        const fill = /\bfill:\s*(#[0-9a-fA-F]{6})\b/.exec(body)?.[1];
        const sizes = [...body.matchAll(/font(?:-size)?:\s*(?:[0-9]{3}\s+)?(\d+(?:\.\d+)?)px/g)].map(match => Number(match[1]));
        if (fill || sizes.length > 0) rules.push({ selector, fill, sizes });
    }
    const page = rules.find(rule => rule.selector.includes('.page'))?.fill;
    if (!page) {
        problem(`FIGURE-CONTRAST-${variant.name.toUpperCase()}`, variant.committedPath, null, `${variant.name} figure: no .page background fill, so contrast cannot be computed`);
        return;
    }
    for (const rule of rules) {
        if (rule.selector.includes('.page')) continue;
        if (rule.fill) {
            const graphical = rule.selector.startsWith('.bar');
            const threshold = graphical ? 3 : 4.5;
            const ratio = contrastRatio(rule.fill, page);
            if (ratio + 1e-9 < threshold) {
                problem(`FIGURE-CONTRAST-${variant.name.toUpperCase()}`, variant.committedPath, lineOf(svg, `fill: ${rule.fill}`), `${variant.name} figure: ${rule.selector} fill ${rule.fill} on canvas ${page} is ${ratio.toFixed(2)}:1, below the WCAG ${threshold}:1 minimum for ${graphical ? 'large graphical objects' : 'normal text'}`);
            }
        }
        for (const size of rule.sizes) {
            if (size < 12) {
                problem(`FIGURE-TYPE-FLOOR-${variant.name.toUpperCase()}`, variant.committedPath, lineOf(svg, `fill: ${rule.fill ?? ''}`), `${variant.name} figure: ${rule.selector} declares a ${size}px type size; the minimum at 1:1 is 12 px`);
            }
        }
    }
    // The generator's own declaration vocabulary is `font:`/`font-size:`; check every literal even if the CSS
    // parser above missed a nested declaration.
    for (const match of svg.matchAll(/font(?:-size)?:\s*(?:[0-9]{3}\s+)?(\d+(?:\.\d+)?)px/g)) {
        const size = Number(match[1]);
        if (size < 12) problem(`FIGURE-TYPE-FLOOR-${variant.name.toUpperCase()}`, variant.committedPath, lineOf(svg, match[0]), `${variant.name} figure: declares a ${size}px type size; the minimum at 1:1 is 12 px`);
    }
}

// ---- report --------------------------------------------------------------------------------------
function reportAndExit() {
    if (problems.length === 0) {
        console.log(`perf-evidence: OK (${relative(baselinePath)} run ${runId} at ${shortCommit}: README + docs/performance.md + figure bytes + provenance agree)`);
        process.exit(0);
    }
    console.error('perf-evidence: FAIL');
    for (const entry of problems) {
        console.error(`  - [${entry.assertion}] ${entry.file}${entry.line ? `:${entry.line}` : ''}: ${entry.message}`);
    }
    console.error(`  - ${problems.length} problem(s); nothing was written. Fix the surface named above or replace the baseline with a new run (docs/perf-baseline.md §8).`);
    process.exit(1);
}
reportAndExit();
