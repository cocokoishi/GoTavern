// TEETH FOR THE RELEASE GOVERNANCE GATES.
//
// Both gates are fail-closed steps in the publish path, which means their important behaviour is REFUSAL -- and a
// refusal that was never exercised is indistinguishable from a step that cannot refuse. Each case below builds the
// smallest input that should be rejected, requires the rejection, and (for the positive controls) requires acceptance
// of a clean input. The wrong-SHA case is the one this whole change exists for: a perfect set of green runs that belong
// to ANOTHER commit must fail, because that is exactly the state a hand-written checklist cannot tell apart from a
// same-SHA release.
//
// Run: node --test scripts/release-governance.test.mjs   (ci.yml `verify` job runs exactly this)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateGates, fetchRunsFromApi, renderEvidence, validateManifest, validateManifestAgainstWorkflowNames } from './release-governance/gates.mjs';
import { assembleReleaseBody } from './assemble-release-body.mjs';
import { validateReleaseNotes } from './release-governance/notes.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);

function manifest(workflows = ['Workflow A', 'Workflow B']) {
    return {
        schemaVersion: 1,
        sameShaRequired: true,
        requiredGates: workflows.map((workflow) => ({ workflow, why: 'because the gate test says so' })),
    };
}

function run(name, { sha = SHA, status = 'completed', conclusion = 'success', id = 1, event = 'workflow_dispatch', createdAt = '2026-10-31T00:00:00Z' } = {}) {
    return {
        id,
        name,
        head_sha: sha,
        status,
        conclusion,
        event,
        created_at: createdAt,
        html_url: `https://example.invalid/${id}`,
    };
}

test('gates: every required workflow green at the target SHA passes', () => {
    const verdict = evaluateGates({
        manifest: manifest(),
        sha: SHA,
        runs: [run('Workflow A', { id: 11 }), run('Workflow B', { id: 12 })],
    });
    assert.equal(verdict.ok, true, JSON.stringify(verdict.problems));
    assert.equal(verdict.rows.length, 2);
    assert.deepEqual(verdict.rows.map((row) => row.verdict), ['success', 'success']);
});

test('gates: a required workflow with no run at all fails closed', () => {
    const verdict = evaluateGates({ manifest: manifest(), sha: SHA, runs: [run('Workflow A')] });
    assert.equal(verdict.ok, false);
    assert.ok(verdict.problems.some((problem) => /Workflow B: missing/.test(problem)), JSON.stringify(verdict.problems));
});

test('gates: a green run on a DIFFERENT commit is refused, not counted', () => {
    const verdict = evaluateGates({
        manifest: manifest(),
        sha: SHA,
        runs: [run('Workflow A', { sha: OTHER_SHA }), run('Workflow B', { sha: OTHER_SHA })],
    });
    assert.equal(verdict.ok, false, 'a same-SHA gate that accepts another commit is the defect it exists to catch');
    assert.ok(verdict.problems.every((problem) => /missing/.test(problem)), JSON.stringify(verdict.problems));
});

test('gates: a completed FAILED run at the target SHA is refused', () => {
    const verdict = evaluateGates({
        manifest: manifest(),
        sha: SHA,
        runs: [run('Workflow A', { conclusion: 'failure' }), run('Workflow B')],
    });
    assert.equal(verdict.ok, false);
    assert.ok(verdict.problems.some((problem) => /Workflow A: not-green/.test(problem)), JSON.stringify(verdict.problems));
});

test('gates: an in-progress run is not success', () => {
    const verdict = evaluateGates({
        manifest: manifest(),
        sha: SHA,
        runs: [run('Workflow A', { status: 'in_progress', conclusion: null }), run('Workflow B')],
    });
    assert.equal(verdict.ok, false);
    assert.ok(verdict.problems.some((problem) => /Workflow A: not-green/.test(problem)), JSON.stringify(verdict.problems));
});

test('gates: a cancelled run is not success', () => {
    const verdict = evaluateGates({
        manifest: manifest(),
        sha: SHA,
        runs: [run('Workflow A', { conclusion: 'cancelled' }), run('Workflow B')],
    });
    assert.equal(verdict.ok, false);
});

test('gates: a stale green run at the SHA does not hide a newer failed run at the SHA', () => {
    // Preference is a completed success, so one success is enough -- but if the only runs are a failure then the gate
    // must refuse. This case pins the second half.
    const verdict = evaluateGates({
        manifest: manifest(['Workflow A']),
        sha: SHA,
        runs: [run('Workflow A', { conclusion: 'timed_out', createdAt: '2026-10-31T02:00:00Z' })],
    });
    assert.equal(verdict.ok, false);
    assert.ok(/timed_out/.test(JSON.stringify(verdict.problems)));
});

test('gates: manifest validation refuses a gate that does not demand one SHA', () => {
    const problems = validateManifest({ schemaVersion: 1, sameShaRequired: false, requiredGates: [{ workflow: 'A', why: 'x' }] });
    assert.ok(problems.some((problem) => /sameShaRequired/.test(problem)), JSON.stringify(problems));
});

test('gates: manifest validation refuses duplicate or unjustified entries', () => {
    const problems = validateManifest({
        schemaVersion: 1,
        sameShaRequired: true,
        requiredGates: [{ workflow: 'A', why: 'x' }, { workflow: 'A', why: 'y' }, { workflow: 'B' }],
    });
    assert.ok(problems.some((problem) => /twice/.test(problem)), JSON.stringify(problems));
    assert.ok(problems.some((problem) => /why is required/.test(problem)), JSON.stringify(problems));
});

test('gates: a manifest entry that names no existing workflow is refused', () => {
    const workflows = readdirSync(path.join(ROOT, '.github', 'workflows'))
        .filter((name) => /\.ya?ml$/.test(name))
        .map((name) => {
            const text = readFileSync(path.join(ROOT, '.github', 'workflows', name), 'utf8');
            const match = text.match(/^name:\s*(.+?)\s*$/m);
            return match ? match[1].replace(/^['"]|['"]$/g, '') : null;
        })
        .filter(Boolean);
    const typo = validateManifestAgainstWorkflowNames(manifest(['GoTavern CI Typo']), workflows);
    assert.ok(typo.length === 1 && /names no workflow/.test(typo[0]), JSON.stringify(typo));
    // Positive control: the real committed manifest must name only workflows that exist, or the release gate would fail
    // closed at publish time for a reason that is a typo rather than a missing run.
    const committed = JSON.parse(readFileSync(path.join(ROOT, 'docs', 'release-manifest.json'), 'utf8'));
    assert.deepEqual(validateManifestAgainstWorkflowNames(committed, workflows), []);
    assert.deepEqual(validateManifest(committed), []);
});

test('gates: the published evidence section carries every run id and the target SHA', () => {
    const verdict = evaluateGates({
        manifest: manifest(['Workflow A', 'Workflow B']),
        sha: SHA,
        runs: [run('Workflow A', { id: 11 }), run('Workflow B', { id: 12 })],
    });
    assert.equal(verdict.ok, true);
    const evidence = renderEvidence({ rows: verdict.rows, sha: SHA, repo: 'owner/repo' });
    // A release body without the run ids would be a claim, not evidence; this is the text users can check.
    assert.match(evidence, /## Qualification evidence/);
    assert.match(evidence, /actions\/runs\/11/);
    assert.match(evidence, /actions\/runs\/12/);
    assert.ok(evidence.includes(SHA), 'the evidence section must name the commit every run judged');
    assert.match(evidence, /Target commit: `a{40}`/);
});

test('body: a curated note plus green same-SHA runs assembles a publishable body with the evidence table', () => {
    const result = assembleReleaseBody({
        notesText: noteBody(),
        tag: 'v0.1.0-beta.1',
        checksumsText: CHECKSUMS,
        runs: [run('Workflow A', { id: 21 }), run('Workflow B', { id: 22 })],
        manifest: manifest(),
        sha: SHA,
        repo: 'owner/repo',
    });
    assert.equal(result.ok, true, JSON.stringify(result.problems));
    assert.match(result.body, /## Qualification evidence/);
    assert.match(result.body, /actions\/runs\/21/);
    assert.ok(result.body.startsWith('# GoTavern Beta 1'), 'the curated note must remain the body lead, evidence appended');
    assert.ok(result.body.includes(SHA));
});

test('body: a curated note with a missing same-SHA run is NOT publishable, and no body is produced', () => {
    const result = assembleReleaseBody({
        notesText: noteBody(),
        tag: 'v0.1.0-beta.1',
        checksumsText: CHECKSUMS,
        runs: [run('Workflow A', { id: 21 })],
        manifest: manifest(),
        sha: SHA,
    });
    assert.equal(result.ok, false);
    assert.equal(result.body, null, 'a failing gate must not produce a body that could be published');
    assert.ok(result.problems.some((problem) => /Workflow B: missing/.test(problem)), JSON.stringify(result.problems));
});

test('body: a curated note whose checksums do not match this run is NOT publishable', () => {
    const wrongChecksums = `${'d'.repeat(64)}  gotavern-linux-amd64.tar.gz`;
    const result = assembleReleaseBody({
        notesText: noteBody(),
        tag: 'v0.1.0-beta.1',
        checksumsText: wrongChecksums,
        runs: [run('Workflow A', { id: 21 }), run('Workflow B', { id: 22 })],
        manifest: manifest(),
        sha: SHA,
    });
    assert.equal(result.ok, false);
    assert.ok(result.problems.some((problem) => /not in checksums|matches no asset|not its checksum/.test(problem)), JSON.stringify(result.problems));
});

test('body: no curated note means generated notes, but the same-SHA gate still has to pass', () => {
    const red = assembleReleaseBody({
        notesText: null,
        tag: 'v0.1.0-beta.1',
        runs: [run('Workflow A', { id: 21 })],
        manifest: manifest(),
        sha: SHA,
    });
    assert.equal(red.ok, false, 'a prerelease without a curated body is not exempt from the same-SHA gate');
    assert.equal(red.body, null);
    const green = assembleReleaseBody({
        notesText: null,
        tag: 'v0.1.0-beta.1',
        runs: [run('Workflow A', { id: 21 }), run('Workflow B', { id: 22 })],
        manifest: manifest(),
        sha: SHA,
    });
    assert.equal(green.ok, true);
    assert.equal(green.body, null, 'the caller falls back to gh --generate-notes when there is no curated body');
});

test('gates: the API query paginates and refuses a non-200 instead of treating it as no runs', async () => {
    const seen = [];
    const fetchImpl = async (url) => {
        seen.push(url);
        if (seen.length === 1) {
            return {
                ok: true,
                json: async () => ({ workflow_runs: Array.from({ length: 100 }, (_, index) => run('Workflow A', { id: index + 1 })) }),
                text: async () => '',
            };
        }
        return {
            ok: true,
            json: async () => ({ workflow_runs: [run('Workflow B', { id: 201 })] }),
            text: async () => '',
        };
    };
    const runs = await fetchRunsFromApi({ sha: SHA, repo: 'owner/repo', token: 'x', fetchImpl });
    assert.equal(runs.length, 101, 'a full first page must be followed by a second request');
    assert.match(seen[0], /head_sha=/);
    assert.match(seen[1], /page=2/);

    let deniedError = null;
    try {
        await fetchRunsFromApi({
            sha: SHA,
            repo: 'owner/repo',
            token: 'x',
            fetchImpl: async () => ({ ok: false, status: 403, text: async () => 'forbidden' }),
        });
    } catch (error) {
        deniedError = error;
    }
    assert.ok(deniedError && /403/.test(deniedError.message), 'a permission failure must be a named error, not an empty run list');
});

function noteBody(extra = '') {    const filler = 'GoTavern Beta 1 is a long-lived test release. '.repeat(40);
    return `# GoTavern Beta 1 (v0.1.0-beta.1)

${filler}

## Compatibility

Everything here is measured against the pinned oracle. ${extra}

## Known limitations

None beyond the recorded gaps.

## Checksums

SHA256 of the canonical assets is in checksums.txt.

- gotavern-linux-amd64.tar.gz ${DIGEST_LINUX}
`;
}

const DIGEST_LINUX = '3f9a1b7c'.repeat(8);
const DIGEST_WIN = 'b8e4d2c6'.repeat(8);
const DIGEST_OTHER = '9a1c5e7b'.repeat(8);

const CHECKSUMS = [
    `${DIGEST_LINUX}  gotavern-linux-amd64.tar.gz`,
    `${DIGEST_WIN}  gotavern-windows-amd64.zip`,
].join('\n');

test('notes: a clean curated body is accepted', () => {
    const verdict = validateReleaseNotes({ text: noteBody(), tag: 'v0.1.0-beta.1', checksumsText: CHECKSUMS });
    assert.equal(verdict.ok, true, JSON.stringify(verdict.problems));
});

test('notes: a drafting word is refused', () => {
    const verdict = validateReleaseNotes({ text: noteBody('TODO: fill this in.'), tag: 'v0.1.0-beta.1', checksumsText: CHECKSUMS });
    assert.equal(verdict.ok, false);
    assert.ok(verdict.problems.some((problem) => /drafting word TODO/.test(problem)), JSON.stringify(verdict.problems));
});

test('notes: an angle-bracket placeholder is refused', () => {
    const verdict = validateReleaseNotes({ text: noteBody('Measured at <date>.'), tag: 'v0.1.0-beta.1', checksumsText: CHECKSUMS });
    assert.equal(verdict.ok, false);
    assert.ok(verdict.problems.some((problem) => /<date>/.test(problem)), JSON.stringify(verdict.problems));
});

test('notes: a too-short (fabricated) run id is refused, a real one is accepted', () => {
    const short = validateReleaseNotes({ text: noteBody('Qualified in run 123.'), tag: 'v0.1.0-beta.1', checksumsText: CHECKSUMS });
    assert.equal(short.ok, false);
    assert.ok(short.problems.some((problem) => /too-short run id/.test(problem)), JSON.stringify(short.problems));
    const real = validateReleaseNotes({ text: noteBody('Qualified in run 41173508011.'), tag: 'v0.1.0-beta.1', checksumsText: CHECKSUMS });
    assert.equal(real.ok, true, JSON.stringify(real.problems));
});

test('notes: an example checksum is refused', () => {
    const body = noteBody().replace(DIGEST_LINUX, '0'.repeat(64));
    const verdict = validateReleaseNotes({ text: body, tag: 'v0.1.0-beta.1', checksumsText: CHECKSUMS });
    assert.equal(verdict.ok, false);
    assert.ok(verdict.problems.some((problem) => /degenerate|matches no asset/.test(problem)), JSON.stringify(verdict.problems));
});

test('notes: a digest that matches no release asset is refused', () => {
    const body = noteBody().replace(DIGEST_LINUX, DIGEST_OTHER);
    const verdict = validateReleaseNotes({ text: body, tag: 'v0.1.0-beta.1', checksumsText: CHECKSUMS });
    assert.equal(verdict.ok, false);
    assert.ok(verdict.problems.some((problem) => /matches no asset/.test(problem)), JSON.stringify(verdict.problems));
});

test('notes: the right digest beside the wrong asset is refused and names the asset', () => {
    const body = noteBody().replace('gotavern-linux-amd64.tar.gz', 'gotavern-windows-amd64.zip');
    const verdict = validateReleaseNotes({ text: body, tag: 'v0.1.0-beta.1', checksumsText: CHECKSUMS });
    assert.equal(verdict.ok, false);
    assert.ok(verdict.problems.some((problem) => /gotavern-windows-amd64\.zip/.test(problem)), JSON.stringify(verdict.problems));
});

test('notes: a body that never names its own tag is refused', () => {
    const verdict = validateReleaseNotes({ text: noteBody(), tag: 'v0.1.0', checksumsText: CHECKSUMS });
    assert.equal(verdict.ok, false);
    assert.ok(verdict.problems.some((problem) => /do not name the tag/.test(problem)), JSON.stringify(verdict.problems));
});

test('notes: a stub body, or one without the required sections, is refused', () => {
    const stub = validateReleaseNotes({ text: `# GoTavern Beta 1\n\nv0.1.0-beta.1\n`, tag: 'v0.1.0-beta.1', checksumsText: CHECKSUMS });
    assert.equal(stub.ok, false);
    assert.ok(stub.problems.some((problem) => /stub/.test(problem)), JSON.stringify(stub.problems));
    const missing = validateReleaseNotes({
        text: noteBody().replace('## Known limitations', '## Limits'),
        tag: 'v0.1.0-beta.1',
        checksumsText: CHECKSUMS,
    });
    assert.equal(missing.ok, false);
    assert.ok(missing.problems.some((problem) => /Known limitations/.test(problem)), JSON.stringify(missing.problems));
});
