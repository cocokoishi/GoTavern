// NEGATIVE CONTROLS FOR THE PERFORMANCE-EVIDENCE GATE.
//
// The checker `tools/check-perf-docs.mjs` exists because a number, a link or a release token can drift from the
// recorded artifact while every surface still reads plausibly. A gate that has never failed is not a gate, so
// each test below tampers a TEMPORARY COPY of one surface, runs the real checker against the copy, and asserts
// the specific named assertion that goes red. The repository files are never modified: every mutation is written
// to a scratch directory and the untampered tree is the positive control at the top.
//
// Run: node --test tests/docs/check-perf-docs.test.mjs
// (or `node --test tests/docs/*.test.mjs` from the repository root)

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHECKER = path.join(ROOT, 'tools', 'check-perf-docs.mjs');
const scratch = mkdtempSync(path.join(os.tmpdir(), 'gotavern-perf-docs-teeth-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

function source(relativePath) {
    return readFileSync(path.join(ROOT, relativePath), 'utf8');
}
function scratchCopy(name, text) {
    const file = path.join(scratch, name);
    writeFileSync(file, text);
    return file;
}
function mutatedCopy(name, relativePath, mutate) {
    const original = source(relativePath);
    const changed = mutate(original);
    assert.notEqual(changed, original, `the mutation for ${name} did not change ${relativePath}`);
    return scratchCopy(name, changed);
}
function runChecker(extraArguments = []) {
    return spawnSync(process.execPath, [CHECKER, ...extraArguments], { cwd: ROOT, encoding: 'utf8' });
}
function expectNamedFailure(result, assertion) {
    assert.notEqual(result.status, 0, `expected a non-zero exit; stdout=${JSON.stringify(result.stdout)} stderr=${JSON.stringify(result.stderr)}`);
    assert.match(result.stderr, new RegExp(`\\[${assertion}\\]`), `expected the named assertion ${assertion} in:\n${result.stderr}`);
}

test('positive control: the untampered tree is green', () => {
    const result = runChecker();
    assert.equal(result.status, 0, `the real tree must pass the gate; stderr=${result.stderr}`);
    assert.match(result.stdout, /perf-evidence: OK/);
});

test('README table cell that disagrees with the artifact names README-TABLE-PINNED', () => {
    const readme = mutatedCopy('readme-table.md', 'README.md', text => text.replace('| 14,515 ms |', '| 14,516 ms |'));
    expectNamedFailure(runChecker(['--readme', readme]), 'README-TABLE-PINNED');
});

test('a known-stale release token is refused by name', () => {
    const readme = mutatedCopy('readme-stale.md', 'README.md', text => text.replaceAll('v0.1.0-alpha.19', 'v0.1.0-alpha.15'));
    expectNamedFailure(runChecker(['--readme', readme]), 'README-STALE-VERSION');
});

test('a first screen over the alpha.20 character budget is refused by name', () => {
    // The alpha.19 first screen measured 11,170 characters; alpha.20's contract is a >=40% reduction. The
    // mutation inserts filler ABOVE the "## Release status" boundary, so the whole-file budget still passes
    // and only the first-screen assertion can catch it.
    const readme = mutatedCopy('readme-first-screen-overbudget.md', 'README.md', text => {
        const boundary = text.indexOf('\n## Release status');
        assert.ok(boundary > 0, 'README.md has no "## Release status" boundary to mutate against');
        return `${text.slice(0, boundary)}\n${'first screen filler '.repeat(400)}${text.slice(boundary)}`;
    });
    expectNamedFailure(runChecker(['--readme', readme]), 'README-FIRST-SCREEN-BUDGET');
});

test('an over-budget README fails the length budget', () => {
    const readme = mutatedCopy('readme-overbudget.md', 'README.md', text => `${text}\n${'padding '.repeat(800)}\n`);
    expectNamedFailure(runChecker(['--readme', readme]), 'README-BUDGET');
});

test('a relative link that does not resolve fails by name', () => {
    const readme = mutatedCopy('readme-broken-link.md', 'README.md', text => text.replace('(docs/INSTALLATION.md)', '(docs/NO-SUCH-FILE.md)'));
    expectNamedFailure(runChecker(['--readme', readme]), 'README-LINK');
});

test('a duplicated section is refused', () => {
    const readme = mutatedCopy('readme-duplicate.md', 'README.md', text => `${text}\n## Performance\n\nA second performance section.\n`);
    expectNamedFailure(runChecker(['--readme', readme]), 'README-DUPLICATE-SECTION');
});

test('a figure without alt text fails the accessibility check', () => {
    const readme = mutatedCopy('readme-no-alt.md', 'README.md', text => text.replace(/\s+alt="[^"]*"/, ''));
    expectNamedFailure(runChecker(['--readme', readme]), 'README-ALT-TEXT');
});

test('a low-contrast committed figure fails the computed WCAG check', () => {
    const svg = mutatedCopy('dark-low-contrast.svg', 'docs/assets/benchmark.svg', text => text.replace('fill: #9aa4b0;', 'fill: #777777;'));
    expectNamedFailure(runChecker(['--svg', svg]), 'FIGURE-CONTRAST-DARK');
});

test('a dark/light pair that disagrees about the recorded data is refused', () => {
    const svgLight = mutatedCopy('light-pair-mismatch.svg', 'docs/assets/benchmark-light.svg', text => text.replace('run 42012475880', 'run 42012475801'));
    expectNamedFailure(runChecker(['--svg-light', svgLight]), 'FIGURE-PAIR-CONSISTENT');
});

test('a performance document whose table disagrees with the artifact names PERF-DOC-TABLE-PINNED', () => {
    const performanceDoc = mutatedCopy('performance-table.md', 'docs/performance.md', text => text.replace('| 14,515 ms |', '| 14,516 ms |'));
    expectNamedFailure(runChecker(['--performance-doc', performanceDoc]), 'PERF-DOC-TABLE-PINNED');
});

test('a performance document that drops an UNPROVEN row is refused', () => {
    const performanceDoc = mutatedCopy('performance-unproven.md', 'docs/performance.md', text => text.replaceAll('REPORT-ONLY', 'fine'));
    expectNamedFailure(runChecker(['--performance-doc', performanceDoc]), 'PERF-DOC-UNPROVEN');
});

test('a broken link inside the detailed performance document fails by name', () => {
    const performanceDoc = mutatedCopy('performance-broken-link.md', 'docs/performance.md', text => text.replace('(perf-baseline.md)', '(missing-baseline.md)'));
    expectNamedFailure(runChecker(['--performance-doc', performanceDoc]), 'PERF-DOC-LINK');
});

test('a duplicated section inside the detailed document is refused', () => {
    const performanceDoc = mutatedCopy('performance-duplicate.md', 'docs/performance.md', text => `${text}\n## 2. The four headline metrics\n\nA second table section.\n`);
    expectNamedFailure(runChecker(['--performance-doc', performanceDoc]), 'PERF-DOC-DUPLICATE-SECTION');
});

test('a tampered baseline copy propagates to the README table check', () => {
    const baseline = JSON.parse(source('tests/perf/q22-baseline.json'));
    baseline.report.summary.pinned.bootMsMedian = 14516;
    const baselineCopy = scratchCopy('baseline-tampered.json', `${JSON.stringify(baseline, null, 2)}\n`);
    expectNamedFailure(runChecker(['--baseline', baselineCopy]), 'README-TABLE-PINNED');
});

test('a cold-guard row that stops pointing at the perf lane record is refused', () => {
    // The perf lane now HAS a docs/alpha18/perf/ record, so the document must point at it. Removing that
    // pointer must fail by name rather than reading as if the cold-guard row were settled or absent.
    const performanceDoc = mutatedCopy('performance-cold-guard.md', 'docs/performance.md', text => text.replaceAll('docs/alpha18/perf/', 'the performance lane'));
    expectNamedFailure(runChecker(['--performance-doc', performanceDoc]), 'PERF-DOC-COLD-GUARD');
});
