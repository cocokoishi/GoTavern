// DOES THE BROWSER-EVIDENCE VERIFIER'S COVERAGE ARITHMETIC HAVE TEETH?
//
// This lane's finding: `tools/verify-browser-comparisons.mjs` read the artefacts it knew about and never
// checked the OTHER direction -- that every committed `*-comparison.json` is claimed by some checker. It
// would also print "coherent" for a tree with zero catalogued artefacts (a loop over nothing is not a
// failure), accepted artefacts that named a different pinned baseline, and accepted a `guards` object whose
// extra keys no checker read. Each is a false green: evidence that reads as proof but cannot fail.
//
// WHAT THIS FILE DOES, in two layers.
//
//   1. PURE CASES. `tools/browser-evidence/coverage.mjs` holds the arithmetic as functions, so each guard is
//      asserted to fire on the synthetic shape it exists for and to stay quiet on a healthy shape. These run
//      in milliseconds and need no repository.
//   2. INTEGRATION MUTATIONS. A copy of the verifier, its modules, the source catalogue, the three external
//      workflows and every committed comparison artefact is written to a temp tree. The healthy copy must
//      exit 0; each mutation must exit non-zero AND name the guard/artefact that caught it. This is the
//      negative control for the guards themselves, not for the unit functions: it runs the file CI runs.
//
// Nothing is stubbed inside the verifier. No committed artefact and no workflow is touched: the mutations
// are applied to the COPY (AGENTS verification rule 2 -- never restore a mutation with git).
//
// Run: node tests/browser/a15-verifier-coverage-selftest.mjs

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
    claimProblems, evidenceFloorProblems, exemptionProblems, externalClaimProblems, guardSetProblems,
    PINNED_BASELINE_COMMIT, pinnedBaselineProblems,
} from '../../tools/browser-evidence/coverage.mjs';
import { compareArtifacts } from '../../tools/browser-evidence/freshness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

const cases = [];
const addCase = (description, run) => cases.push({ description, run });
const expectProblems = (description, problems, needle) => {
    assert.ok(problems.length > 0, `${description}: expected a finding, got none`);
    assert.ok(problems.some(problem => problem.includes(needle)),
        `${description}: expected a finding naming ${JSON.stringify(needle)}; got ${JSON.stringify(problems)}`);
};
const expectClean = (description, problems) => {
    assert.deepEqual(problems, [], `${description}: expected no findings, got ${JSON.stringify(problems)}`);
};

// ---------------------------------------------------------------------------------------------------
// 1. PURE CASES -- each guard fires on its own shape and is quiet on the healthy shape.
// ---------------------------------------------------------------------------------------------------

addCase('a committed artefact no checker claims is a finding, named', () => {
    const problems = claimProblems({
        files: ['generation-groq-comparison.json', 'unclaimed-comparison.json'],
        catalogueClaims: ['generation-groq-comparison.json'],
        handledFiles: [],
    });
    expectProblems('unclaimed artefact', problems, 'unclaimed-comparison.json');
    expectProblems('unclaimed artefact', problems, 'NO checker claims');
    assert.equal(problems.length, 1, `the claimed artefact must not be reported: ${JSON.stringify(problems)}`);
});

addCase('an artefact claimed twice is a finding (one owner per artefact)', () => {
    const problems = claimProblems({
        files: ['asset-comparison.json'],
        catalogueClaims: [],
        handledFiles: ['asset-comparison.json'],
        externalClaims: new Map([['asset-comparison.json', { workflow: 'w.yml', step: 's', reason: 'r' }]]),
    });
    expectProblems('double claim', problems, 'claimed by');
});

addCase('an external claim for a file that is not committed is stale, and one with no reason/step cannot be reviewed', () => {
    const problems = claimProblems({
        files: [],
        externalClaims: new Map([
            ['gone-comparison.json', { workflow: 'w.yml', step: 's', reason: 'r' }],
            ['other-comparison.json', { workflow: 'w.yml', step: '', reason: '' }],
        ]),
    });
    expectProblems('stale external claim', problems, 'gone-comparison.json');
    expectProblems('unreviewable claim', problems, 'no reason');
    expectProblems('unreviewable claim', problems, 'no workflow step');
});

addCase('a declared external gate whose workflow no longer mentions the artefact or the step is a finding', () => {
    const claims = new Map([['group-chat-comparison.json', {
        workflow: '.github/workflows/group-chat-differential.yml',
        step: 'Judge that every leg and the comparison exist',
        command: 'tests/browser/group-chat-comparison.json',
        reason: 're-judged by that job',
    }]]);
    const healthy = externalClaimProblems(claims, () => 'step: Judge that every leg and the comparison exist\nfile: group-chat-comparison.json\nnode --input-type=commonjs -e "tests/browser/group-chat-comparison.json"\n');
    expectClean('healthy external claim', healthy);
    expectProblems('deleted artefact mention', externalClaimProblems(claims, () => 'step: Judge that every leg and the comparison exist\n'), 'no longer mentions group-chat-comparison.json');
    expectProblems('deleted step', externalClaimProblems(claims, () => 'group-chat-comparison.json\nnode --input-type=commonjs -e "tests/browser/group-chat-comparison.json"\n'), 'no step named');
    expectProblems('deleted command', externalClaimProblems(claims, () => 'step: Judge that every leg and the comparison exist\ngroup-chat-comparison.json\n'), 'no longer runs');
});

addCase('a zero-artefact tree, an empty catalogue and a zero-checked run each fail the floor', () => {
    expectProblems('empty directory', evidenceFloorProblems({ files: [], catalogueSize: 30, checked: 30 }), 'no committed comparison artefacts');
    expectProblems('empty catalogue', evidenceFloorProblems({ files: Array.from({ length: 30 }, (_, index) => `a${index}-comparison.json`), catalogueSize: 0, checked: 0 }), 'source catalogue is empty');
    expectProblems('zero checked', evidenceFloorProblems({ files: Array.from({ length: 30 }, (_, index) => `a${index}-comparison.json`), catalogueSize: 30, checked: 0 }), 'ZERO catalogued source artefacts');
    expectProblems('shrunk evidence set', evidenceFloorProblems({ files: ['a-comparison.json'], catalogueSize: 30, checked: 1 }), 'below the floor');
    expectClean('healthy floor', evidenceFloorProblems({ files: Array.from({ length: 40 }, (_, index) => `a${index}-comparison.json`), catalogueSize: 30, checked: 30 }));
});

addCase('a declared pinned baseline that names another oracle is a finding, and a matching short revision is not', () => {
    const healthy = pinnedBaselineProblems({
        pinnedBaseline: `SillyTavern 1.19.0, commit ${PINNED_BASELINE_COMMIT}`,
        provenance: { pinned: { frontendVersion: { gitRevision: PINNED_BASELINE_COMMIT.slice(0, 9) } } },
    });
    assert.equal(healthy.declared, true, 'the healthy artefact declares a baseline');
    expectClean('matching baseline', healthy.problems);

    const wrongCommit = pinnedBaselineProblems({ pinnedBaseline: `SillyTavern 1.19.0, commit ${'0'.repeat(40)}` });
    expectProblems('wrong commit', wrongCommit.problems, 'pinnedBaseline');

    const wrongRevision = pinnedBaselineProblems({ provenance: { pinned: { frontendVersion: { gitRevision: 'deadbeef0' } } } });
    expectProblems('wrong revision', wrongRevision.problems, 'frontendVersion.gitRevision');

    const undeclared = pinnedBaselineProblems({ schemaVersion: 1 });
    assert.equal(undeclared.declared, false, 'an artefact that declares nothing must be reported as undeclared');
    expectClean('undeclared baseline is a stated gap, not a finding', undeclared.problems);
});

addCase('a guard the artefact records but no checker reads is a finding, and so is a vanished required/optional guard', () => {
    const required = ['legsPresent', 'driveCompleted'];
    const optional = new Map([['presetStaged', 'staging fact, pinned not required']]);
    expectClean('healthy guard set', guardSetProblems({ guards: { legsPresent: true, driveCompleted: true, presetStaged: true }, required, optional }));

    expectProblems('unread guard', guardSetProblems({ guards: { legsPresent: true, driveCompleted: true, presetStaged: true, mysteryGuard: true }, required, optional }), 'mysteryGuard');
    expectProblems('vanished required guard', guardSetProblems({ guards: { driveCompleted: true, presetStaged: true }, required, optional }), 'guards.legsPresent is missing');
    expectProblems('vanished optional guard', guardSetProblems({ guards: { legsPresent: true, driveCompleted: true }, required, optional }), 'pinned in the optional allowlist');
});

addCase('a freshness comparison over two empty documents is STALE, not FRESH', () => {
    // A comparator that wrote `{}` produced no observation; an equality over nothing must not report FRESH.
    for (const [label, committed, fresh] of [
        ['both empty', {}, {}],
        ['fresh empty', { schemaVersion: 1 }, {}],
        ['committed empty', {}, { schemaVersion: 1 }],
    ]) {
        const result = compareArtifacts(committed, fresh);
        assert.equal(result.identical, false, `${label}: two empty/near-empty documents must not be FRESH`);
        assert.equal(result.differences[0]?.kind, 'empty', `${label}: the difference must be named empty, got ${JSON.stringify(result.differences)}`);
    }
    assert.equal(compareArtifacts({ a: 1, b: [1, 2] }, { a: 1, b: [1, 2] }).identical, true, 'a genuinely identical pair must stay FRESH');
    assert.equal(compareArtifacts({ a: 1 }, { a: 2 }).identical, false, 'a changed field must stay STALE');
});

addCase('a driveSupported:false exemption must be on the reviewed allowlist, and the allowlist cannot go stale', () => {
    const reviewed = new Map([['workers_ai', 'the current probe cannot select workers_ai; its two committed artefacts predate that']]);
    const source = { id: 'workers_ai', driveSupported: false, unproven: 'the current probe cannot select workers_ai; its two committed artefacts predate that and stay gate-checked' };
    expectClean('reviewed exemption', exemptionProblems([source], reviewed));
    expectProblems('unreviewed exemption', exemptionProblems([source, { id: 'sneaky', driveSupported: false, unproven: 'a reason nobody reviewed' }], reviewed), 'sneaky');
    expectProblems('stale allowlist', exemptionProblems([], reviewed), 'not exempt any more');
    expectProblems('moved justification', exemptionProblems([{ id: 'workers_ai', driveSupported: false, unproven: 'a different reason' }], reviewed), 'does not carry the reviewed text');
});

// ---------------------------------------------------------------------------------------------------
// 2. INTEGRATION MUTATIONS -- run the REAL verifier over a COPY, and require it to name the guard.
// ---------------------------------------------------------------------------------------------------

const WORKFLOWS = [
    '.github/workflows/browser-differential.yml',
    '.github/workflows/group-chat-differential.yml',
    '.github/workflows/worldinfo-slots.yml',
];

function stageCopy() {
    const root = mkdtempSync(path.join(os.tmpdir(), 'a15-verifier-coverage-'));
    const verifier = path.join(root, 'tools', 'verify-browser-comparisons.mjs');
    mkdirSync(path.join(root, 'tools', 'browser-evidence'), { recursive: true });
    mkdirSync(path.join(root, 'tests', 'browser'), { recursive: true });
    mkdirSync(path.join(root, '.github', 'workflows'), { recursive: true });
    copyFileSync(path.join(repoRoot, 'tools', 'verify-browser-comparisons.mjs'), verifier);
    for (const name of readdirSync(path.join(repoRoot, 'tools', 'browser-evidence'))) {
        copyFileSync(path.join(repoRoot, 'tools', 'browser-evidence', name), path.join(root, 'tools', 'browser-evidence', name));
    }
    copyFileSync(path.join(repoRoot, 'tests', 'browser', 'sources.mjs'), path.join(root, 'tests', 'browser', 'sources.mjs'));
    for (const name of readdirSync(path.join(repoRoot, 'tests', 'browser')).filter(entry => entry.endsWith('-comparison.json'))) {
        copyFileSync(path.join(repoRoot, 'tests', 'browser', name), path.join(root, 'tests', 'browser', name));
    }
    for (const workflow of WORKFLOWS) {
        copyFileSync(path.join(repoRoot, workflow), path.join(root, workflow));
    }
    return root;
}

function runVerifier(root) {
    const result = spawnSync(process.execPath, [path.join(root, 'tools', 'verify-browser-comparisons.mjs')], {
        encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    });
    return { status: result.status, stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') };
}

function mutateCopy(root, mutate) {
    const copy = mkdtempSync(path.join(os.tmpdir(), 'a15-verifier-mutation-'));
    for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const source = path.join(entry.parentPath ?? entry.path, entry.name);
        const relative = path.relative(root, source);
        const target = path.join(copy, relative);
        mkdirSync(path.dirname(target), { recursive: true });
        copyFileSync(source, target);
    }
    mutate(copy);
    return copy;
}

const roots = [];
let failures = 0;
const control = stageCopy();
roots.push(control);
const healthy = runVerifier(control);
if (healthy.status !== 0) {
    failures += 1;
    console.error(`FAIL  the unmutated copy must be green; got exit ${healthy.status}: ${healthy.stderr.slice(0, 800)}`);
} else {
    console.log('ok    the unmutated copy passes every coverage check');
}

const mutations = [
    {
        description: 'an unclaimed committed artefact is caught BY NAME',
        needle: 'zzz-unclaimed-comparison.json',
        apply: root => writeFileSync(path.join(root, 'tests', 'browser', 'zzz-unclaimed-comparison.json'), `${JSON.stringify({ schemaVersion: 1 })}\n`),
    },
    {
        description: 'an artefact measured against another pinned baseline is caught BY PATH',
        needle: 'pinnedBaseline',
        apply: root => {
            const file = path.join(root, 'tests', 'browser', 'authors-note-comparison.json');
            const artifact = JSON.parse(readFileSync(file, 'utf8'));
            artifact.pinnedBaseline = 'SillyTavern 1.19.0, commit 0000000000000000000000000000000000000000';
            writeFileSync(file, `${JSON.stringify(artifact, null, 2)}\n`);
        },
    },
    {
        description: 'a guard no checker reads is caught BY NAME',
        needle: 'mysteryGuard',
        apply: root => {
            const file = path.join(root, 'tests', 'browser', 'asset-comparison.json');
            const artifact = JSON.parse(readFileSync(file, 'utf8'));
            artifact.guards.mysteryGuard = true;
            writeFileSync(file, `${JSON.stringify(artifact, null, 2)}\n`);
        },
    },
    {
        description: 'a required guard that vanished is caught BY NAME',
        needle: 'bothLegsCompleted',
        apply: root => {
            const file = path.join(root, 'tests', 'browser', 'asset-comparison.json');
            const artifact = JSON.parse(readFileSync(file, 'utf8'));
            delete artifact.guards.bothLegsCompleted;
            writeFileSync(file, `${JSON.stringify(artifact, null, 2)}\n`);
        },
    },
    {
        description: 'an external gate whose step was deleted is caught BY WORKFLOW',
        needle: 'Judge that every leg and the comparison exist',
        apply: root => {
            const file = path.join(root, '.github', 'workflows', 'group-chat-differential.yml');
            writeFileSync(file, readFileSync(file, 'utf8').replaceAll('Judge that every leg and the comparison exist', 'Compare the legs'));
        },
    },
];

for (const mutation of mutations) {
    const copy = mutateCopy(control, mutation.apply);
    roots.push(copy);
    const result = runVerifier(copy);
    if (result.status === 0) {
        failures += 1;
        console.error(`FAIL  ${mutation.description}: the verifier stayed GREEN on a tree it must refuse`);
        continue;
    }
    const output = `${result.stderr}\n${result.stdout}`;
    if (!output.includes(mutation.needle)) {
        failures += 1;
        console.error(`FAIL  ${mutation.description}: went red but did not name ${JSON.stringify(mutation.needle)}; output ${JSON.stringify(output.slice(-800))}`);
        continue;
    }
    console.log(`ok    ${mutation.description}`);
}

for (const root of roots) rmSync(root, { recursive: true, force: true });

// ---- the pure cases, reported last so the integration layer above is the loud one -----------------
for (const testCase of cases) {
    try {
        testCase.run();
        console.log(`ok    ${testCase.description}`);
    } catch (error) {
        failures += 1;
        console.error(`FAIL  ${String(error.message ?? error)}`);
    }
}

if (failures > 0) {
    console.error(`\n${failures} of ${cases.length + mutations.length + 1} coverage cases are wrong; the verifier's coverage guards do not have the teeth this file claims`);
    process.exit(1);
}
console.log(`\n${cases.length} pure case(s) + ${mutations.length} verifier mutation(s): every coverage guard fires on the shape it exists for, and the healthy tree is green`);
