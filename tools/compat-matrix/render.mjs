#!/usr/bin/env node
// Render docs/compatibility-matrix.md from docs/compatibility-matrix.json.
//
// The JSON is the source of truth; this view is generated so the two can never disagree. `check.mjs`
// regenerates into memory and refuses a tree whose committed Markdown differs, which is the gate that
// stops the document drifting ahead of the data (AGENTS.md 36: documentation may not claim ahead of
// evidence) and the reason this file exists at all rather than a hand-written table.
//
// Deterministic by construction: rows are emitted in JSON order, no timestamps, no host paths, no counts
// computed from the environment. Two runs on two machines produce identical bytes.

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, '..', '..');
export const matrixPath = path.join(repoRoot, 'docs', 'compatibility-matrix.json');
export const markdownPath = path.join(repoRoot, 'docs', 'compatibility-matrix.md');

export function loadMatrix() {
    return JSON.parse(readFileSync(matrixPath, 'utf8'));
}

// ---------------------------------------------------------------------------------------------------
// THE COUNTS ARE MEASURED FROM THE TREE, NOT TYPED. A hand-maintained number in a compatibility document
// is exactly the shape that let four documents here disagree about the same fact (73/86/187 routes).
// `check.mjs` recounts these and fails on a disagreement, so deleting a fixture, renaming a test or adding
// a CI job turns the matrix red until it is regenerated — which is what makes this a gate and not a
// document (AGENTS.md 36: documentation may not claim ahead of evidence).
// ---------------------------------------------------------------------------------------------------
// ---------------------------------------------------------------------------------------------------
// GO TEST FUNCTIONS are enumerated from the COMMITTED tree (`git ls-files`), not from a filesystem walk.
// Three defects in the walk this replaces, each measured on 2026-10-29:
//   * it started at the repository root, so an untracked scratch `*_test.go` would inflate the count, and
//     this repository keeps a gitignored `.private-fixtures` area inside that root -- a count that depends
//     on what a developer left on disk is not a fact about the tree;
//   * it counted `TestMain`, which is a package's test ENTRY POINT rather than a test. Three packages
//     declare one, so the reported total carried three non-tests;
//   * it skipped the whole `upstream/` directory to avoid the vendored asset trees under it, which also
//     dropped `upstream/assets_test.go` and `upstream/tokenizers_test.go` -- three real tests -- while
//     `check.mjs` walked the same root WITHOUT that exclusion, so the generator and the gate that validates
//     the generator's citations answered "is this a declared test?" from two different definitions.
// Both callers now share this one definition. `TestMain` is excluded by name and never counted.
export function goTestFunctions() {
    const files = execFileSync('git', ['-C', repoRoot, 'ls-files', '--', '*_test.go'], { encoding: 'utf8' })
        .split('\n')
        .filter(Boolean);
    const names = new Set();
    let count = 0;
    for (const relative of files) {
        const source = readFileSync(path.join(repoRoot, relative), 'utf8');
        for (const match of source.matchAll(/^func (Test[A-Za-z0-9_]+)\(/gm)) {
            if (match[1] === 'TestMain') continue;
            names.add(match[1]);
            count++;
        }
    }
    return { names, count };
}

export function computeDerived(matrix) {
    const fixtureDir = path.join(repoRoot, 'tests', 'oracle');
    const browserDir = path.join(repoRoot, 'tests', 'browser');
    const oracleFixtures = readdirSync(fixtureDir).filter(name => name.endsWith('.json'));
    const browserArtefacts = readdirSync(browserDir).filter(name => name.endsWith('-comparison.json'));

    const goTest = goTestFunctions();

    const workflowDir = path.join(repoRoot, '.github', 'workflows');
    const workflows = readdirSync(workflowDir).filter(name => name.endsWith('.yml'));
    // A JOB is a key under the workflow's `jobs:` block. The count this replaces matched every empty-valued
    // two-space key in the file, which also counts TRIGGER keys (`on.workflow_dispatch:` with no value is a
    // two-space key) -- so the number labelled "workflow jobs" moved when a lane added a dispatch trigger and
    // did not move when a job was added. Measured 2026-10-31: the old definition reported 39 where the tree
    // has 36 jobs, and a derived-count drift on `main` came entirely from trigger keys.
    let ciJobs = 0;
    for (const workflow of workflows) {
        const lines = readFileSync(path.join(workflowDir, workflow), 'utf8').split(/\r?\n/);
        const jobsIndex = lines.findIndex(line => /^jobs:\s*$/.test(line));
        if (jobsIndex < 0) continue;
        for (const line of lines.slice(jobsIndex + 1)) {
            if (/^\S/.test(line)) break; // the next top-level key ends the block
            if (/^ {2}[A-Za-z0-9_-]+:\s*$/.test(line)) ciJobs++;
        }
    }

    const cited = slot => new Set(matrix.rows.flatMap(row => (row.evidence?.[slot] ?? []).map(entry => String(entry).replace(/^\.\//, ''))));
    const citedFixtures = cited('oracleFixtures');
    const citedArtefacts = cited('browserArtifacts');
    const citedTests = cited('tests');

    const statuses = {};
    for (const row of matrix.rows) statuses[row.status] = (statuses[row.status] || 0) + 1;

    return {
        oracleFixtures: {
            inTree: oracleFixtures.length,
            citedByMatrix: oracleFixtures.filter(name => citedFixtures.has(`tests/oracle/${name}`)).length,
        },
        browserArtefacts: {
            inTree: browserArtefacts.length,
            citedByMatrix: browserArtefacts.filter(name => citedArtefacts.has(`tests/browser/${name}`)).length,
        },
        goTestFunctions: {
            inTree: goTest.count,
            citedByMatrix: [...citedTests].filter(entry => goTest.names.has(entry)).length,
        },
        workflows: { inTree: workflows.length, jobsInTree: ciJobs },
        rows: {
            total: matrix.rows.length,
            PASS: statuses.PASS ?? 0,
            PARTIAL: statuses.PARTIAL ?? 0,
            FAIL: statuses.FAIL ?? 0,
            NOT_APPLICABLE: statuses.NOT_APPLICABLE ?? 0,
        },
        sessionSteps: {
            total: matrix.session?.steps?.length ?? 0,
            withProbe: (matrix.session?.steps ?? []).filter(step => step.probe).length,
            withoutProbe: (matrix.session?.steps ?? []).filter(step => !step.probe).length,
            sharingARuntime: (matrix.session?.steps ?? []).filter(step => step.sharesRuntimeWithOtherSteps).length,
        },
    };
}


const cell = value => String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

function codeList(items) {
    if (!items || items.length === 0) return '_none_';
    return items.map(item => '`' + cell(item) + '`').join(', ');
}

export function render(matrix) {
    const lines = [];
    const push = line => lines.push(line);

    push('# Compatibility matrix (generated)');
    push('');
    push('**Generated from `docs/compatibility-matrix.json` by `tools/compat-matrix/render.mjs`. Do not edit this file:');
    push('edit the JSON and run the generator. `tools/compat-matrix/check.mjs` fails the build when the two differ, when a');
    push('cited path or test does not exist, or when a `PASS` row carries an evidence gap.**');
    push('');
    push(`Pinned baseline: **${cell(matrix.baseline.name)} ${cell(matrix.baseline.version)}**, commit \`${cell(matrix.baseline.commit)}\`.`);
    push('');
    push('This matrix is the coarse, capability-level answer to "how far is GoTavern from usable". The per-route');
    push('detail lives in `docs/compat-matrix.md` history; this file is the layer that states, per capability area,');
    push('what is claimed, what evidences the claim, and — where the claim is short — exactly what is missing.');
    push('');

    const counts = {};
    for (const row of matrix.rows) counts[row.status] = (counts[row.status] || 0) + 1;
    push('## Status meanings and counts');
    push('');
    push('| Status | Count | Meaning |');
    push('|---|---|---|');
    for (const status of ['PASS', 'PARTIAL', 'FAIL', 'NOT_APPLICABLE']) {
        push(`| ${status} | ${counts[status] || 0} | ${cell(matrix.statusMeanings[status])} |`);
    }
    push('');
    push('## How a status is derived');
    push('');
    push(cell(matrix.derivation.method));
    push('');
    push('A row is `PASS` only when every one of these holds:');
    push('');
    for (const requirement of matrix.derivation.passRequires) push(`- ${cell(requirement)}`);
    push('');
    push(`**Production rule.** ${cell(matrix.derivation.productionRule)}`);
    push('');
    push(`**Artifact rule.** ${cell(matrix.derivation.artifactRule)}`);
    push('');
    push(`**Fail rule.** ${cell(matrix.derivation.failRule)}`);
    push('');

    push('## Rows');
    push('');
    push('| # | Capability area | Status | Evidence present | Evidence gap |');
    push('|---|---|---|---|---|');
    matrix.rows.forEach((row, index) => {
        const present = [];
        if (row.evidence.oracleFixtures?.length) present.push(`${row.evidence.oracleFixtures.length} oracle fixture(s)`);
        if (row.evidence.upstreamAssets?.length) present.push('upstream assets');
        if (row.evidence.implementation?.length) present.push('Go implementation');
        if (row.evidence.tests?.length) present.push(`${row.evidence.tests.length} named test(s)`);
        if (row.evidence.browserArtifacts?.length) present.push(`${row.evidence.browserArtifacts.length} browser artefact(s)`);
        if (row.evidence.ci?.length) present.push('CI job(s)');
        if (row.evidence.releaseArtifact) present.push('release-artifact step');
        push(`| ${index + 1} | ${cell(row.area)} | **${row.status}** | ${cell(present.join(', ') || '_none_')} | ${row.evidenceGap.length ? cell(row.evidenceGap.length + ' item(s)') : '_none_'} |`);
    });
    push('');

    push('## Evidence and gaps, per row');
    push('');
    for (const row of matrix.rows) {
        push(`### ${cell(row.area)} — \`${row.status}\``);
        push('');
        push(`Row id: \`${cell(row.id)}\``);
        push('');
        push(`- Oracle fixtures: ${codeList(row.evidence.oracleFixtures)}`);
        push(`- Upstream assets: ${codeList(row.evidence.upstreamAssets)}`);
        push(`- Go implementation: ${codeList(row.evidence.implementation)}`);
        push(`- Named tests: ${codeList(row.evidence.tests)}`);
        push(`- Browser artefacts: ${codeList(row.evidence.browserArtifacts)}`);
        push(`- CI jobs: ${codeList(row.evidence.ci)}`);
        push(`- Release artifact: ${row.evidence.releaseArtifact ? cell(row.evidence.releaseArtifact) : '_none_'}`);
        push('');
        if (row.evidenceGap.length) {
            push('**Evidence gap**');
            push('');
            for (const gap of row.evidenceGap) push(`- ${cell(gap)}`);
            push('');
        } else {
            push('**Evidence gap**: none.');
            push('');
        }
        if (row.blockedBy?.length) {
            push(`Blocked by: ${row.blockedBy.map(id => '`' + cell(id) + '`').join(', ')}`);
            push('');
        }
        push(cell(row.notes));
        push('');
    }

    push('## The whole-session differential (what exists today)');
    push('');
    push(cell(matrix.session.purpose));
    push('');
    push(`- State carried between steps: **${matrix.session.stateCarriedBetweenSteps}**`);
    push(`- One shared runtime/fixture across steps: **${matrix.session.sharedFixture}**`);
    push(`- Harness reused: ${codeList(matrix.session.existingHarness)}`);
    push('');
    push('| Step | What the user does | Probe | Both legs compared | Shares runtime with other steps |');
    push('|---|---|---|---|---|');
    for (const step of matrix.session.steps) {
        const probe = step.probe ? '`' + cell(step.probe) + '`' : `_not implemented_: ${cell(step.notImplemented)}`;
        push(`| ${cell(step.step)} | ${cell(step.userAction)} | ${probe} | ${step.comparesBothLegs} | ${step.sharesRuntimeWithOtherSteps} |`);
    }
    push('');
    push('**Canonicalisation.** ' + cell(matrix.session.canonicalisation.method));
    push('');
    push('Replaced per field path, never by whole-document regex: ' + matrix.session.canonicalisation.required.map(v => '`' + cell(v) + '`').join(', ') + '.');
    push('');
    push('Forbidden: ' + matrix.session.canonicalisation.forbidden.map(v => cell(v)).join('; ') + '.');
    push('');

    push('## Top gaps, ranked by "would this stop a real user"');
    push('');
    push('| Rank | Gap | Row | Would it stop a real user? | Evidence |');
    push('|---|---|---|---|---|');
    for (const gap of matrix.gaps) {
        push(`| ${gap.rank} | ${cell(gap.title)} | \`${cell(gap.row)}\` | ${cell(gap.wouldStopARealUser)} | ${cell(gap.evidence)} |`);
    }
    push('');

    if (matrix.derived) {
        push('## Counts measured from this tree');
        push('');
        push('Recomputed by `tools/compat-matrix/check.mjs` on every run; a disagreement fails the build, so these');
        push('numbers cannot drift away from the tree the way four documents once disagreed about one route count.');
        push('"Go test functions" counts `func Test...` declarations in tracked `*_test.go` files, from `git ls-files`,');
        push('with `TestMain` excluded because it is a package\'s test entry point rather than a test.');
        push('');
        push('| Measure | In the tree | Cited by this matrix |');
        push('|---|---|---|');
        const { oracleFixtures, browserArtefacts, goTestFunctions, workflows, rows, sessionSteps } = matrix.derived;
        push(`| Oracle fixtures | ${oracleFixtures.inTree} | ${oracleFixtures.citedByMatrix} |`);
        push(`| Browser artefacts | ${browserArtefacts.inTree} | ${browserArtefacts.citedByMatrix} |`);
        push(`| Go test functions | ${goTestFunctions.inTree} | ${goTestFunctions.citedByMatrix} |`);
        push(`| Workflow jobs | ${workflows.jobsInTree} in ${workflows.inTree} workflow(s) | _n/a_ |`);
        push(`| Rows | ${rows.total} | PASS ${rows.PASS}, PARTIAL ${rows.PARTIAL}, FAIL ${rows.FAIL}, NOT_APPLICABLE ${rows.NOT_APPLICABLE} |`);
        push(`| Session steps | ${sessionSteps.total} | ${sessionSteps.withProbe} with a probe, ${sessionSteps.withoutProbe} without, ${sessionSteps.sharingARuntime} sharing a runtime |`);
        push('');
    }

    return lines.join('\n');
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
    const { writeFileSync } = await import('node:fs');
    const matrix = loadMatrix();
    // `--emit` refreshes the derived counts INTO the JSON (the generator writes the data it measures);
    // the default writes the human view, which needs the counts to already be present.
    if (process.argv.includes('--emit')) {
        matrix.derived = computeDerived(matrix);
        writeFileSync(matrixPath, JSON.stringify(matrix, null, 2) + '\n', 'utf8');
        process.stdout.write(`updated docs/compatibility-matrix.json derived counts: ${JSON.stringify(matrix.derived.rows)}\n`);
    }
    const markdown = render(matrix);
    writeFileSync(markdownPath, markdown, 'utf8');
    process.stdout.write(`wrote docs/compatibility-matrix.md (${markdown.split('\n').length} lines)\n`);
}

