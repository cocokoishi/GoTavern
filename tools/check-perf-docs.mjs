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
//   * docs/assets/benchmark.svg is REGENERATED from it and byte-compared, so the figure cannot drift;
//   * the README performance table is RECOMPUTED from it under one stated unit rule and compared cell by
//     cell, so a unit mismatch cannot hide;
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
// artifact field; restoring the file by copy returns it to green.
//
// USAGE:
//   node tools/check-perf-docs.mjs
//   node tools/check-perf-docs.mjs --baseline <q22-baseline.json> --readme <README.md> \
//       --svg <benchmark.svg> --provenance <benchmark.svg.provenance.md> --baseline-doc <perf-baseline.md>
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

// ---- README: the performance table and the paragraph that cites the run ---------------------------
const readme = readText(readmePath);
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
        // THE SAME NUMBERS APPEAR TWICE IN THE README (the TL;DR mini-table near the top and the
        // Performance table below the figure). Both are release surfaces, so every occurrence is checked;
        // only the Performance section also carries the "How it was measured" column.
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

// ---- provenance: it must name the same run, commit, rounds and soak ------------------------------
const provenanceText = readText(provenancePath);
if (provenanceText !== null) {
    expectContains(provenancePath, provenanceText, `| run id | \`${runId}\``, 'provenance must name the baseline run id');
    expectContains(provenancePath, provenanceText, String(provenance.commit ?? ''), 'provenance must name the full baseline commit');
    expectContains(provenancePath, provenanceText, `${rounds} alternating rounds x ${requestsPerRound} sequential requests per path`, `provenance must state ${rounds} rounds x ${requestsPerRound} requests per path from the baseline`);
    expectContains(provenancePath, provenanceText, '2 x 10-minute windows, one per subject, 30 s sampling (both completed)', 'provenance must state the soak shape the artifact records');
    if (provenance.host?.runnerImage) expectContains(provenancePath, provenanceText, String(provenance.host.runnerImage), 'provenance must name the runner image recorded with the baseline');
    expectContains(provenancePath, provenanceText, 'decimal MB (1e6 B)', 'provenance must state the decimal-MB unit rule');
    expectContains(provenancePath, provenanceText, 'stated on the row', 'provenance claims the unit is stated on the row; the figure must actually state it');
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
    const firstSvg = path.join(tempRoot, 'first.svg');
    const secondSvg = path.join(tempRoot, 'second.svg');
    const runGenerator = output => spawnSync(process.execPath, [generatorPath, '--report', baselinePath, '--out', output], { cwd: ROOT, encoding: 'utf8' });
    const first = runGenerator(firstSvg);
    if (first.status !== 0) {
        problem(generatorPath, null, `refused to regenerate the figure from the baseline: ${(first.stderr || first.stdout || '').trim().split('\n').slice(-3).join(' | ')}`);
    } else {
        const second = runGenerator(secondSvg);
        const readBytes = file => {
            try {
                return readFileSync(file);
            } catch {
                return null;
            }
        };
        const generated = readBytes(firstSvg);
        const regenerated = readBytes(secondSvg);
        if (generated === null || regenerated === null) {
            problem(generatorPath, null, 'did not write the regenerated figure');
        } else {
            if (!generated.equals(regenerated)) {
                problem(generatorPath, null, 'is not deterministic: two regenerations from the same baseline produced different bytes');
            }
            const committedText = readText(svgPath);
            if (committedText === null) {
                problem(svgPath, null, 'cannot be read for the byte comparison');
            } else {
                const committed = committedText.replace(/\r\n/g, '\n');
                const generatedText = generated.toString('utf8');
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
                    problem(svgPath, line, `differs from the figure regenerated from ${relative(baselinePath)}: expected ${JSON.stringify(expected.slice(0, 160))}, committed ${JSON.stringify(actual.slice(0, 160))}`);
                }
                const svg = committed;
                expectContains(svgPath, svg, `RUN ${runId}`, 'the figure must name the baseline run id');
                expectContains(svgPath, svg, `@ ${shortCommit}`, 'the figure must name the baseline short commit');
                expectContains(svgPath, svg, 'decimal MB (1e6 B)', 'the RSS row note must state the decimal-MB unit rule');
                expectContains(svgPath, svg, 'role="img"', 'the figure must expose role="img"');
                expectContains(svgPath, svg, '<title', 'the figure must carry a <title>');
                expectContains(svgPath, svg, '<desc', 'the figure must carry a <desc>');
                expectContains(svgPath, svg, '-fold faster', 'the description must carry the per-metric timing verdict');
                expectContains(svgPath, svg, '-fold lighter', 'the description must carry the per-metric memory verdict');
                for (const forbidden of ['href="http', "href='http", '<script', '<image', '@font-face', 'url(http']) {
                    if (svg.includes(forbidden)) problem(svgPath, lineOf(svg, forbidden), `contains an external/script reference ${JSON.stringify(forbidden)}; the figure must be self-contained`);
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
