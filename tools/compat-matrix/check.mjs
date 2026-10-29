#!/usr/bin/env node
// The gate on the compatibility matrix: it may not claim what this tree cannot show.
//
// AGENTS.md 7, 36 and 40 all fail the same way here: a document says a capability works, no gate
// contradicts it because no gate reads the document, and the first contradiction arrives as a user-visible
// defect. So the matrix is data, and this file is the thing that reads it. Every citation must resolve:
//
//   * a path must exist (file or directory) -- a row may not cite an oracle fixture that was never
//     recorded or a Go package that does not exist;
//   * a test name must be a real `func Test...` in a `*_test.go`, or a real harness file -- a row may not
//     cite a test as evidence for a behaviour no test asserts (the "phantom test" that reads as proof);
//   * a CI citation must name a workflow that exists AND a job in it -- a row may not cite a gate that
//     would never run;
//   * a PASS row may not carry an evidence gap, and a NOT_APPLICABLE row may not be a euphemism for
//     unwritten work;
//   * the committed Markdown must equal what the generator produces, byte for byte, so the human view
//     cannot drift ahead of the data (AGENTS.md 36).
//
// Teeth are demonstrated in the commit that introduced this file: a phantom test name, a phantom path, a
// PASS row with a gap, and a stale Markdown each turn it red with the row named.
//
// Usage: node tools/compat-matrix/check.mjs [--quiet]

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { loadMatrix, render, computeDerived, goTestFunctions, repoRoot, markdownPath } from './render.mjs';

const STATUSES = new Set(['PASS', 'PARTIAL', 'FAIL', 'NOT_APPLICABLE']);
const EVIDENCE_SLOTS = ['oracleFixtures', 'upstreamAssets', 'implementation', 'tests', 'browserArtifacts', 'ci'];

const failures = [];
const fail = (where, message) => failures.push(`${where}: ${message}`);

// ---------------------------------------------------------------------------------------------
// A test name is real when some TRACKED *_test.go declares it. The enumeration lives in `render.mjs`
// (`goTestFunctions`) so this gate and the count it validates cannot answer "is this a declared test?"
// from two different walks -- which they did until 2026-10-29: the generator skipped `upstream/` and this
// file did not, so a citation of `TestPinnedAssetManifests` resolved here and counted as uncited there.
// `TestMain` is not a test and is excluded by the shared definition.
// ---------------------------------------------------------------------------------------------
const tests = goTestFunctions().names;

// `ci.yml#job` -- the workflow must exist and the job must be declared in it.
function resolveCi(jobReference) {
    const [workflow, job] = jobReference.split('#');
    if (!workflow || !job) return `"${jobReference}" is not in the form <workflow>.yml#<job>`;
    const workflowPath = path.join(repoRoot, '.github', 'workflows', workflow);
    if (!existsSync(workflowPath)) return `workflow ${workflow} does not exist`;
    const source = readFileSync(workflowPath, 'utf8');
    const declared = new RegExp(`^ {2}${job.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\s*$`, 'm').test(source);
    if (!declared) return `workflow ${workflow} declares no job named "${job}"`;
    return null;
}

const matrix = loadMatrix();

if (matrix.schemaVersion !== 1) fail('meta', `schemaVersion is ${matrix.schemaVersion}, expected 1`);

// Baseline must match the recorded pin, or every row is evidence about a different version.
const pinnedCommit = readFileSync(path.join(repoRoot, 'upstream', 'SILLYTAVERN_COMMIT'), 'utf8').trim().split(/\s+/)[0];
if (matrix.baseline.commit !== pinnedCommit) {
    fail('meta', `baseline.commit is ${matrix.baseline.commit} but upstream/SILLYTAVERN_COMMIT records ${pinnedCommit}`);
}

const seenIds = new Set();
for (const row of matrix.rows) {
    const where = `row "${row.id ?? '(missing id)'}"`;
    if (!row.id) fail('row', 'a row has no id');
    if (seenIds.has(row.id)) fail(where, 'duplicate row id');
    seenIds.add(row.id);
    if (!row.area) fail(where, 'no area');
    if (!STATUSES.has(row.status)) fail(where, `status ${JSON.stringify(row.status)} is not one of ${[...STATUSES].join(', ')}`);
    if (!Array.isArray(row.evidenceGap)) fail(where, 'evidenceGap must be an array (empty when there is no gap)');
    if (!row.evidence || typeof row.evidence !== 'object') {
        fail(where, 'no evidence object');
        continue;
    }
    for (const slot of EVIDENCE_SLOTS) {
        const value = row.evidence[slot];
        if (value === undefined) fail(where, `evidence.${slot} is missing (use [] when there is none, so "none" is stated rather than implied)`);
        if (value !== undefined && !Array.isArray(value)) fail(where, `evidence.${slot} must be an array`);
    }

    // PATHS. A citation that does not resolve is a phantom: it reads as evidence and is not.
    for (const slot of ['oracleFixtures', 'upstreamAssets', 'implementation', 'browserArtifacts']) {
        for (const citation of row.evidence[slot] ?? []) {
            if (!existsSync(path.join(repoRoot, citation))) fail(where, `evidence.${slot} cites ${citation}, which does not exist in this tree`);
        }
    }

    // TESTS. A name is real only if it resolves to a declared Go test or an existing harness file.
    for (const citation of row.evidence.tests ?? []) {
        if (citation.endsWith('.mjs')) {
            if (!existsSync(path.join(repoRoot, citation))) fail(where, `evidence.tests cites harness file ${citation}, which does not exist`);
            continue;
        }
        if (!tests.has(citation)) fail(where, `evidence.tests cites ${citation}, which is not a declared Go test in this tree`);
    }

    // CI. A gate that never runs is not a gate.
    for (const citation of row.evidence.ci ?? []) {
        const problem = resolveCi(citation);
        if (problem) fail(where, `evidence.ci: ${problem}`);
    }

    // A PASS row with a gap is the exact shape of the three shipped P0s.
    if (row.status === 'PASS' && (row.evidenceGap?.length ?? 0) > 0) {
        fail(where, 'status PASS but evidenceGap is not empty: missing evidence may never be reported as PASS');
    }
    if (row.status === 'PASS') {
        for (const slot of ['oracleFixtures', 'implementation', 'tests', 'ci']) {
            if ((row.evidence[slot] ?? []).length === 0) fail(where, `status PASS but evidence.${slot} is empty`);
        }
    }
    // NOT_APPLICABLE is a decided exclusion, and an exclusion still needs a reason and no gap.
    if (row.status === 'NOT_APPLICABLE') {
        if ((row.evidenceGap?.length ?? 0) > 0) fail(where, 'NOT_APPLICABLE carries an evidence gap, which means work is missing rather than excluded');
        if (!row.notes || row.notes.length < 40) fail(where, 'NOT_APPLICABLE must name the decision and its source in notes');
    }
    // Every non-PASS, non-excluded row states what is missing, because "PARTIAL" alone is a feeling.
    if (row.status === 'PARTIAL' && (row.evidenceGap?.length ?? 0) === 0) {
        fail(where, 'status PARTIAL but evidenceGap is empty: name what is missing');
    }
    if (row.status === 'FAIL' && (row.evidenceGap?.length ?? 0) === 0) {
        fail(where, 'status FAIL but evidenceGap is empty: a FAIL row is a finding, so it must say what the evidence does not cover');
    }
    for (const blocked of row.blockedBy ?? []) {
        if (!matrix.rows.some(candidate => candidate.id === blocked)) fail(where, `blockedBy names "${blocked}", which is not a row id`);
    }
}

// The session inventory: every step either cites a probe that exists, or says why it does not exist.
for (const step of matrix.session?.steps ?? []) {
    const where = `session step "${step.step}"`;
    if (!step.userAction) fail(where, 'no userAction');
    if (step.probe) {
        if (!existsSync(path.join(repoRoot, step.probe))) fail(where, `cites probe ${step.probe}, which does not exist`);
        if (typeof step.comparesBothLegs !== 'boolean') fail(where, 'comparesBothLegs must be stated as a boolean');
    } else if (!step.notImplemented) {
        fail(where, 'has no probe and does not say why (notImplemented)');
    }
    if (step.browserArtifact && !existsSync(path.join(repoRoot, step.browserArtifact))) {
        fail(where, `cites browser artefact ${step.browserArtifact}, which does not exist`);
    }
}
if (matrix.session?.steps?.length && matrix.session.sharedFixture === true) {
    // If this ever becomes true, the whole-session row must be re-derived rather than left as FAIL.
    const sessionRow = matrix.rows.find(row => row.id === 'whole-session-e2e');
    if (sessionRow && sessionRow.status === 'FAIL') fail('session', 'sharedFixture is true but the whole-session-e2e row still says FAIL');
}

// The gaps table is what a reader acts on, so it must point at real rows and be ranked without holes.
const ranks = (matrix.gaps ?? []).map(gap => gap.rank).sort((a, b) => a - b);
ranks.forEach((rank, index) => {
    if (rank !== index + 1) fail('gaps', `ranks are not 1..N without holes (found ${ranks.join(',')})`);
});
for (const gap of matrix.gaps ?? []) {
    if (!matrix.rows.some(row => row.id === gap.row)) fail(`gap #${gap.rank}`, `names row "${gap.row}", which is not a row id`);
    if (!gap.evidence) fail(`gap #${gap.rank}`, 'no evidence line (a gap without an evidence line is an opinion)');
    if (!gap.wouldStopARealUser) fail(`gap #${gap.rank}`, 'does not answer "would this stop a real user"');
}

// EVERY ROW NAMES WHAT WOULD GO RED IF IT WERE WRONG. A row whose verdict no test can contradict is a
// document, not a gate (AGENTS.md 31: every bug reproduced before it is fixed; 32: a test that cannot fail
// is worse than no test). A FAIL row names the gate that does not exist yet instead.
for (const row of matrix.rows) {
    const where = `row "${row.id}"`;
    const claim = row.wouldGoRedIfWrong;
    if (!claim || typeof claim !== 'object') {
        fail(where, 'no wouldGoRedIfWrong: name the test that fails when this row is wrong');
        continue;
    }
    if (claim.test === null) {
        if (row.status !== 'FAIL') fail(where, 'wouldGoRedIfWrong.test is null, which is only allowed for a FAIL row that names its absent gate');
        if (!claim.explanation || claim.explanation.length < 80) fail(where, 'a null wouldGoRedIfWrong needs an explanation naming the absent gate and what it must assert');
    } else if (!tests.has(claim.test)) {
        fail(where, `wouldGoRedIfWrong cites ${JSON.stringify(claim.test)}, which is not a declared Go test in this tree`);
    } else if (!(row.evidence.tests ?? []).includes(claim.test)) {
        fail(where, `wouldGoRedIfWrong cites ${claim.test}, which is not among this row's own evidence.tests`);
    }
}

// A FAIL ROW OWNS ITS GATE AS DATA. Naming the owning lane and the assertion that must land keeps a FAIL row
// from decaying into "in progress": the row can only be promoted by supplying that gate, and this refuses a
// FAIL row that names neither an owner nor what the gate must assert.
for (const row of matrix.rows) {
    if (row.status !== 'FAIL') continue;
    const where = `row "${row.id}"`;
    if (!row.absentGate) {
        fail(where, 'status FAIL but no absentGate: name the owning lane and the assertion that must land');
        continue;
    }
    if (!row.absentGate.owner) fail(where, 'absentGate.owner is empty: say which lane owns the gate');
    if (!row.absentGate.mustAssert || row.absentGate.mustAssert.length < 60) {
        fail(where, 'absentGate.mustAssert is empty or too short to be a requirement');
    }
}

// THE DERIVED COUNTS ARE RECOUNTED HERE. The generator writes them; this recomputes them from the tree, so a
// deleted fixture, a renamed test or a removed CI job fails until the matrix is regenerated. A number typed
// into a document is what this check exists to make impossible.
const derived = computeDerived(matrix);
if (!matrix.derived) {
    fail('derived', 'the matrix carries no derived counts; run node tools/compat-matrix/render.mjs --emit');
} else if (JSON.stringify(matrix.derived) !== JSON.stringify(derived)) {
    const keys = Object.keys(derived);
    const drifted = keys.filter(key => JSON.stringify(matrix.derived[key]) !== JSON.stringify(derived[key]));
    fail('derived', `counts disagree with a recount of this tree (${drifted.join(', ')}): committed ${JSON.stringify(matrix.derived)} vs measured ${JSON.stringify(derived)}. Run node tools/compat-matrix/render.mjs --emit`);
}

// THE HUMAN VIEW MAY NOT DRIFT. Regenerated in memory: a mismatch means the document says something the
// data does not, which is AGENTS.md 36 in its most direct form.
const expected = render(matrix);
const committed = readFileSync(markdownPath, 'utf8');
if (expected !== committed) {
    const expectedLines = expected.split('\n');
    const committedLines = committed.split('\n');
    let first = 0;
    while (first < expectedLines.length && first < committedLines.length && expectedLines[first] === committedLines[first]) first++;
    fail('docs/compatibility-matrix.md', `differs from the generator output at line ${first + 1}: committed ${JSON.stringify(committedLines[first] ?? '(end)')} vs generated ${JSON.stringify(expectedLines[first] ?? '(end)')}. Run node tools/compat-matrix/render.mjs`);
}

if (failures.length > 0) {
    process.stderr.write(`compatibility matrix: ${failures.length} problem(s)\n`);
    for (const failure of failures) process.stderr.write(`  - ${failure}\n`);
    process.exit(1);
}

if (!process.argv.includes('--quiet')) {
    const counts = {};
    for (const row of matrix.rows) counts[row.status] = (counts[row.status] || 0) + 1;
    const summary = ['PASS', 'PARTIAL', 'FAIL', 'NOT_APPLICABLE'].map(status => `${status} ${counts[status] || 0}`).join(' | ');
    process.stdout.write(`compatibility matrix: ${matrix.rows.length} rows (${summary}), ${(matrix.gaps ?? []).length} gaps, ${matrix.session?.steps?.length ?? 0} session steps — every citation resolves\n`);
}
