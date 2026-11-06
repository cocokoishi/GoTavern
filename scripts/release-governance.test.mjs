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
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { evaluateGates, fetchRunsFromApi, renderEvidence, validateManifest, validateManifestAgainstWorkflowNames } from './release-governance/gates.mjs';
import { EVIDENCE_MEMBER, parseReleaseEvidence, validateReleaseEvidence } from './release-governance/artifact-evidence.mjs';
import { assembleReleaseBody } from './assemble-release-body.mjs';
import { validateReleaseNotes } from './release-governance/notes.mjs';
import { evaluateMarker, selfTest as darwinArm64SelfTest } from './release-governance/darwin-arm64-qualification.mjs';
import {
    evaluateLimitation as evaluateMacosArm64Limitation,
    parseCrossPlatform as parseThirdPartyCrossPlatform,
    selfTest as macosArm64LimitationSelfTest,
} from './release-governance/macos-arm64-limitation.mjs';

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

test('gates: a push-triggered success at the SHA does NOT satisfy a gate that requires a dispatched run', () => {
    // MEASURED FAILURE THIS TEST PINS: run 41210334467 was a push run of GoTavern CI at the Beta candidate and
    // concluded success while its `oracle` job was SKIPPED -- the push trigger narrows the probe selection by
    // changed paths. It satisfied the old gate, which only asked "is there a successful run at this SHA?". A
    // release gate must ask for the run a release manager DISPATCHED, whose selection is the full one.
    const dispatched = {
        schemaVersion: 1,
        sameShaRequired: true,
        requiredGates: [{ workflow: 'Workflow A', why: 'because the gate test says so', requiredEvent: 'workflow_dispatch' }],
    };
    const narrowed = evaluateGates({
        manifest: dispatched,
        sha: SHA,
        runs: [run('Workflow A', { event: 'push', id: 21 })],
    });
    assert.equal(narrowed.ok, false, 'a push run must not satisfy a dispatch-required gate');
    assert.ok(
        narrowed.problems.some((problem) => /Workflow A: missing/.test(problem) && /narrowed selection/.test(problem)),
        JSON.stringify(narrowed.problems),
    );

    const full = evaluateGates({
        manifest: dispatched,
        sha: SHA,
        runs: [run('Workflow A', { event: 'push', id: 21 }), run('Workflow A', { event: 'workflow_dispatch', id: 22, createdAt: '2026-10-31T01:00:00Z' })],
    });
    assert.equal(full.ok, true, JSON.stringify(full.problems));
    assert.equal(full.rows[0].runId, 22, 'the evidence row must name the dispatched run, not the narrowed push run');
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

// A GATE WHOSE VERDICT IS A MACHINE-CHECKED SET MUST CARRY THAT SET. A green conclusion without the
// artifact is exactly the "the aggregator step was skipped" shape: the workflow can conclude success
// while the step that proves 20/20 never ran.
function manifestWithArtifact(artifact = 'extension-compat-evidence') {
    return {
        schemaVersion: 1,
        sameShaRequired: true,
        requiredGates: [{ workflow: 'Workflow A', why: 'because the gate test says so', requiredEvent: 'workflow_dispatch', requiredArtifact: artifact }],
    };
}

test('gates: a required artifact attached to the same-SHA successful run passes', () => {
    const withArtifact = { ...run('Workflow A', { id: 31 }), artifacts: [{ name: 'extension-compat-evidence', expired: false }] };
    const verdict = evaluateGates({ manifest: manifestWithArtifact(), sha: SHA, runs: [withArtifact] });
    assert.equal(verdict.ok, true, JSON.stringify(verdict.problems));
    assert.equal(verdict.rows[0].artifact, 'extension-compat-evidence');
});

test('gates: a required artifact that is absent fails closed', () => {
    const withoutArtifact = { ...run('Workflow A', { id: 32 }), artifacts: [] };
    const verdict = evaluateGates({ manifest: manifestWithArtifact(), sha: SHA, runs: [withoutArtifact] });
    assert.equal(verdict.ok, false, 'a green conclusion without the required evidence artifact must not satisfy the gate');
    assert.ok(verdict.problems.some((problem) => /missing-artifact/.test(problem)), JSON.stringify(verdict.problems));
});

test('gates: an expired required artifact fails closed', () => {
    const expired = { ...run('Workflow A', { id: 33 }), artifacts: [{ name: 'extension-compat-evidence', expired: true }] };
    const verdict = evaluateGates({ manifest: manifestWithArtifact(), sha: SHA, runs: [expired] });
    assert.equal(verdict.ok, false);
    assert.ok(verdict.problems.some((problem) => /missing-artifact/.test(problem)), JSON.stringify(verdict.problems));
});

test('gates: a required artifact is only accepted from a run at the target SHA', () => {
    const elsewhere = { ...run('Workflow A', { id: 34, sha: OTHER_SHA }), artifacts: [{ name: 'extension-compat-evidence', expired: false }] };
    const verdict = evaluateGates({ manifest: manifestWithArtifact(), sha: SHA, runs: [elsewhere] });
    assert.equal(verdict.ok, false);
    assert.ok(verdict.problems.some((problem) => /missing/.test(problem)), JSON.stringify(verdict.problems));
});

// ===================================================================================================================
// NEGATIVE CONTROLS FOR THE EVIDENCE RAILS (alpha.15).
//
// The rails below exist because a release gate that has never REFUSED is indistinguishable from one that cannot refuse.
// Every case feeds evaluateGates a FABRICATED API RESPONSE (runs, their job lists, their artifact lists, the parsed
// release-evidence document) that a plausible-looking release could actually produce, and requires a named refusal.
// The positive control at the end is the only case allowed to pass, so the matrix cannot read as "the gate is strict"
// by failing everything.
// ===================================================================================================================

const LONG_EVIDENCE_KIND = 'gotavern-longlived-corpus-evidence';
const NODE_EVIDENCE_KIND = 'gotavern-node-stock-tree-evidence';

function gateManifest(entry) {
    return {
        schemaVersion: 1,
        sameShaRequired: true,
        requiredGates: [{ workflow: 'Workflow A', why: 'because the gate test says so', requiredEvent: 'workflow_dispatch', ...entry }],
    };
}

function goodLongEvidence(overrides = {}) {
    return {
        schemaVersion: 1,
        kind: LONG_EVIDENCE_KIND,
        headSha: SHA,
        size: 'medium',
        ok: true,
        legs: [{ name: 'gotavern-drive', skipped: false, exitCode: 0 }],
        comparatorTeeth: { ok: true },
        pinnedExtensions: { manifestSha256: 'c'.repeat(64), count: 20 },
        corpus: { treeSha256: 'd'.repeat(64) },
        ...overrides,
    };
}

function longGateEntry(overrides = {}) {
    return gateManifest({
        requiredJobs: ['medium-corpus'],
        requiredArtifact: 'longlived-medium-evidence',
        requiredEvidence: {
            kind: LONG_EVIDENCE_KIND,
            tierField: 'size',
            tier: 'medium',
            requireTruthy: ['ok', 'comparatorTeeth.ok'],
            requireSha256: ['pinnedExtensions.manifestSha256', 'corpus.treeSha256'],
        },
        ...overrides,
    });
}

function longRun({ id = 51, sha = SHA, event = 'workflow_dispatch', jobs = [{ name: 'medium-corpus', status: 'completed', conclusion: 'success' }], artifacts = [{ name: 'longlived-medium-evidence', expired: false, evidence: goodLongEvidence() }], conclusion = 'success', status = 'completed', createdAt = '2026-11-05T00:00:00Z' } = {}) {
    return { ...run('Workflow A', { id, sha, event, conclusion, status, createdAt }), jobs, artifacts };
}

function evaluateLong(candidateRun, manifestOverride = longGateEntry()) {
    return evaluateGates({ manifest: manifestOverride, sha: SHA, runs: [candidateRun] });
}

test('rails: the positive control passes with jobs, artifact and embedded evidence all present', () => {
    const verdict = evaluateLong(longRun());
    assert.equal(verdict.ok, true, JSON.stringify(verdict.problems));
    assert.equal(verdict.rows[0].verdict, 'success');
    assert.equal(verdict.rows[0].artifact, 'longlived-medium-evidence');
    assert.equal(verdict.rows[0].evidence, LONG_EVIDENCE_KIND);
});

test('rails: a SKIPPED required job fails closed even though the run concluded success', () => {
    // THIS IS THE MASKERADE THE RAIL EXISTS FOR: a workflow_dispatch of the long-lived workflow with size=small runs
    // only the small tier, leaves medium-corpus SKIPPED, and the RUN is green. A manifest that only asked "is there a
    // successful dispatched run?" would publish on it.
    const verdict = evaluateLong(longRun({ jobs: [
        { name: 'small-corpus', status: 'completed', conclusion: 'success' },
        { name: 'medium-corpus', status: 'completed', conclusion: 'skipped' },
    ] }));
    assert.equal(verdict.ok, false);
    assert.ok(verdict.problems.some((problem) => /job-not-green/.test(problem) && /medium-corpus/.test(problem) && /skipped job is not a green job/.test(problem)), JSON.stringify(verdict.problems));
});

test('rails: a required job that is absent from the run fails closed', () => {
    const verdict = evaluateLong(longRun({ jobs: [{ name: 'small-corpus', status: 'completed', conclusion: 'success' }] }));
    assert.equal(verdict.ok, false);
    assert.ok(verdict.problems.some((problem) => /missing-job/.test(problem) && /medium-corpus/.test(problem)), JSON.stringify(verdict.problems));
});

test('rails: a required job that FAILED fails closed', () => {
    const verdict = evaluateLong(longRun({ jobs: [{ name: 'medium-corpus', status: 'completed', conclusion: 'failure' }] }));
    assert.equal(verdict.ok, false);
    assert.ok(verdict.problems.some((problem) => /job-not-green/.test(problem)), JSON.stringify(verdict.problems));
});

test('rails: a job list that was never fetched fails closed (not "no requirement")', () => {
    const verdict = evaluateLong(longRun({ jobs: null }));
    assert.equal(verdict.ok, false);
    assert.ok(verdict.problems.some((problem) => /missing-jobs/.test(problem)), JSON.stringify(verdict.problems));
});

test('rails: the required artifact under the WRONG name fails closed, naming what was observed', () => {
    const verdict = evaluateLong(longRun({ artifacts: [{ name: 'longlived-small-evidence', expired: false, evidence: goodLongEvidence() }] }));
    assert.equal(verdict.ok, false);
    assert.ok(verdict.problems.some((problem) => /missing-artifact/.test(problem) && /longlived-small-evidence/.test(problem)), JSON.stringify(verdict.problems));
});

test('rails: an EXPIRED required artifact fails closed even when its content is right', () => {
    const verdict = evaluateLong(longRun({ artifacts: [{ name: 'longlived-medium-evidence', expired: true, evidence: goodLongEvidence() }] }));
    assert.equal(verdict.ok, false);
    assert.ok(verdict.problems.some((problem) => /missing-artifact/.test(problem) && /EXPIRED/.test(problem)), JSON.stringify(verdict.problems));
});

test('rails: an artifact with no readable evidence document fails closed', () => {
    const verdict = evaluateLong(longRun({ artifacts: [{ name: 'longlived-medium-evidence', expired: false, evidenceError: 'the artifact archive has no readable release-evidence.json member' }] }));
    assert.equal(verdict.ok, false);
    assert.ok(verdict.problems.some((problem) => /missing-evidence/.test(problem)), JSON.stringify(verdict.problems));
});

test('rails: the TIER MARKER is enforced (a small-tier document in the medium artifact is refused)', () => {
    // The embedded marker is what separates a default small dispatch from the qualified medium run even when both
    // upload a similarly-named document. A name is not content.
    const verdict = evaluateLong(longRun({ artifacts: [{ name: 'longlived-medium-evidence', expired: false, evidence: goodLongEvidence({ size: 'small' }) }] }));
    assert.equal(verdict.ok, false);
    assert.ok(verdict.problems.some((problem) => /evidence-mismatch/.test(problem) && /size/.test(problem) && /"small"/.test(problem) && /"medium"/.test(problem)), JSON.stringify(verdict.problems));
});

test('rails: the EMBEDDED HEAD SHA is enforced (evidence recorded at another commit is refused)', () => {
    const verdict = evaluateLong(longRun({ artifacts: [{ name: 'longlived-medium-evidence', expired: false, evidence: goodLongEvidence({ headSha: OTHER_SHA }) }] }));
    assert.equal(verdict.ok, false);
    assert.ok(verdict.problems.some((problem) => /evidence-mismatch/.test(problem) && /headSha/.test(problem) && problem.includes(OTHER_SHA)), JSON.stringify(verdict.problems));
});

test('rails: a wrong evidence KIND is refused', () => {
    const verdict = evaluateLong(longRun({ artifacts: [{ name: 'longlived-medium-evidence', expired: false, evidence: goodLongEvidence({ kind: NODE_EVIDENCE_KIND }) }] }));
    assert.equal(verdict.ok, false);
    assert.ok(verdict.problems.some((problem) => /evidence-mismatch/.test(problem) && /kind/.test(problem)), JSON.stringify(verdict.problems));
});

test('rails: a required truthy field that is false is refused', () => {
    const verdict = evaluateLong(longRun({ artifacts: [{ name: 'longlived-medium-evidence', expired: false, evidence: goodLongEvidence({ ok: false }) }] }));
    assert.equal(verdict.ok, false);
    assert.ok(verdict.problems.some((problem) => /evidence-mismatch/.test(problem) && /ok/.test(problem) && /expected exactly true/.test(problem)), JSON.stringify(verdict.problems));
});

test('rails: a required digest that is not 64-hex is refused', () => {
    const verdict = evaluateLong(longRun({ artifacts: [{ name: 'longlived-medium-evidence', expired: false, evidence: goodLongEvidence({ pinnedExtensions: { manifestSha256: 'not-a-digest', count: 20 } }) }] }));
    assert.equal(verdict.ok, false);
    assert.ok(verdict.problems.some((problem) => /evidence-mismatch/.test(problem) && /manifestSha256/.test(problem) && /64-hex/.test(problem)), JSON.stringify(verdict.problems));
});

test('rails: an evidence document with the wrong schemaVersion is refused', () => {
    const verdict = evaluateLong(longRun({ artifacts: [{ name: 'longlived-medium-evidence', expired: false, evidence: goodLongEvidence({ schemaVersion: 2 }) }] }));
    assert.equal(verdict.ok, false);
    assert.ok(verdict.problems.some((problem) => /evidence-mismatch/.test(problem) && /schemaVersion/.test(problem)), JSON.stringify(verdict.problems));
});

test('rails: evidence at a DIFFERENT SHA is refused (an old run cannot be reused)', () => {
    const elsewhere = longRun({ sha: OTHER_SHA });
    const verdict = evaluateLong(elsewhere);
    assert.equal(verdict.ok, false);
    assert.ok(verdict.problems.some((problem) => /missing/.test(problem) && /other SHAs/.test(problem)), JSON.stringify(verdict.problems));
});

test('rails: a null head_sha on the run is refused (a nonexistent SHA cannot match)', () => {
    const verdict = evaluateLong({ ...longRun(), head_sha: null });
    assert.equal(verdict.ok, false);
    assert.ok(verdict.problems.some((problem) => /missing/.test(problem)), JSON.stringify(verdict.problems));
});

test('rails: a PUSH run carrying the same fixed-name artifact fails closed (event rail)', () => {
    // node-stock-tree uploads the SAME fixed artifact name on push runs. Without the requiredEvent rail a push run
    // would therefore satisfy its release gate; this is the case that proves the rail is doing the work.
    const pushed = longRun({ event: 'push' });
    const verdict = evaluateLong(pushed);
    assert.equal(verdict.ok, false);
    assert.ok(verdict.problems.some((problem) => /missing/.test(problem) && /narrowed selection/.test(problem)), JSON.stringify(verdict.problems));
});

test('rails: a SCHEDULE-required gate is not satisfied by a dispatch run, and a scheduled run satisfies it', () => {
    const scheduled = gateManifest({
        requiredEvent: 'schedule',
        requiredJobs: ['medium-corpus'],
        requiredArtifact: 'longlived-medium-evidence',
        requiredEvidence: { kind: LONG_EVIDENCE_KIND, tierField: 'size', tier: 'medium', requireTruthy: ['ok'] },
    });
    const dispatched = evaluateGates({ manifest: scheduled, sha: SHA, runs: [longRun({ event: 'workflow_dispatch' })] });
    assert.equal(dispatched.ok, false);
    assert.ok(dispatched.problems.some((problem) => /missing/.test(problem) && /scheduled\/cron run/.test(problem)), JSON.stringify(dispatched.problems));
    const nightly = evaluateGates({ manifest: scheduled, sha: SHA, runs: [longRun({ event: 'schedule' })] });
    assert.equal(nightly.ok, true, JSON.stringify(nightly.problems));
});

test('rails: a newer GREEN run that lacks the evidence rails does not hide an older run that satisfies them', () => {
    const satisfying = longRun({ id: 61, createdAt: '2026-11-04T00:00:00Z' });
    const newerButEmpty = longRun({
        id: 62,
        createdAt: '2026-11-05T00:00:00Z',
        jobs: [{ name: 'medium-corpus', status: 'completed', conclusion: 'skipped' }],
        artifacts: [],
    });
    const verdict = evaluateGates({ manifest: longGateEntry(), sha: SHA, runs: [satisfying, newerButEmpty] });
    assert.equal(verdict.ok, true, JSON.stringify(verdict.problems));
    assert.equal(verdict.rows[0].runId, 61, 'the run that actually carries the evidence must be the one cited');
});

test('rails: manifest validation refuses evidence rails that could be satisfied by an unintended trigger', () => {
    const noEvent = validateManifest(gateManifest({ requiredArtifact: 'longlived-medium-evidence', requiredEvent: undefined }));
    assert.ok(noEvent.some((problem) => /no requiredEvent/.test(problem)), JSON.stringify(noEvent));
    const typo = validateManifest(gateManifest({ requiredEvent: 'workflow_disaptch' }));
    assert.ok(typo.some((problem) => /not a known Actions event/.test(problem)), JSON.stringify(typo));
    const evidenceWithoutArtifact = validateManifest(gateManifest({ requiredEvidence: { kind: LONG_EVIDENCE_KIND } }));
    assert.ok(evidenceWithoutArtifact.some((problem) => /requires requiredArtifact/.test(problem)), JSON.stringify(evidenceWithoutArtifact));
    const badSpec = validateManifest(gateManifest({ requiredArtifact: 'x-evidence', requiredEvidence: { kind: LONG_EVIDENCE_KIND, requireTruthy: 'ok' } }));
    assert.ok(badSpec.some((problem) => /requireTruthy/.test(problem)), JSON.stringify(badSpec));
    const duplicateJob = validateManifest(gateManifest({ requiredJobs: ['a', 'a'] }));
    assert.ok(duplicateJob.some((problem) => /twice/.test(problem)), JSON.stringify(duplicateJob));
});

// ---- the artifact archive reader: the evidence is READ, not assumed from the artifact name ------------------------

function buildZip(files, { method = 0 } = {}) {
    const locals = [];
    const centrals = [];
    let offset = 0;
    for (const [name, content] of Object.entries(files)) {
        const nameBuffer = Buffer.from(name, 'utf8');
        const raw = Buffer.from(content, 'utf8');
        const data = method === 8 ? deflateRawSync(raw) : raw;
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0, 6);
        local.writeUInt16LE(method, 8);
        local.writeUInt16LE(0, 10);
        local.writeUInt16LE(0, 12);
        local.writeUInt32LE(0, 14);
        local.writeUInt32LE(data.length, 18);
        local.writeUInt32LE(raw.length, 22);
        local.writeUInt16LE(nameBuffer.length, 26);
        local.writeUInt16LE(0, 28);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(0, 8);
        central.writeUInt16LE(method, 10);
        central.writeUInt16LE(0, 12);
        central.writeUInt16LE(0, 14);
        central.writeUInt32LE(0, 16);
        central.writeUInt32LE(data.length, 20);
        central.writeUInt32LE(raw.length, 24);
        central.writeUInt16LE(nameBuffer.length, 28);
        central.writeUInt16LE(0, 30);
        central.writeUInt16LE(0, 32);
        central.writeUInt16LE(0, 34);
        central.writeUInt16LE(0, 36);
        central.writeUInt32LE(0, 38);
        central.writeUInt32LE(offset, 42);
        locals.push(local, nameBuffer, data);
        centrals.push(central, nameBuffer);
        offset += local.length + nameBuffer.length + data.length;
    }
    const centralSize = centrals.reduce((total, part) => total + part.length, 0);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(Object.keys(files).length, 8);
    eocd.writeUInt16LE(Object.keys(files).length, 10);
    eocd.writeUInt32LE(centralSize, 12);
    eocd.writeUInt32LE(offset, 16);
    eocd.writeUInt16LE(0, 20);
    return Buffer.concat([...locals, ...centrals, eocd]);
}

test('artifact: a stored and a deflated release-evidence member are both read', () => {
    for (const method of [0, 8]) {
        const zip = buildZip({ [EVIDENCE_MEMBER]: JSON.stringify(goodLongEvidence()) }, { method });
        const parsed = parseReleaseEvidence(zip);
        assert.equal(parsed.error, null, `method ${method}: ${parsed.error}`);
        assert.equal(parsed.evidence.kind, LONG_EVIDENCE_KIND);
    }
});

test('artifact: a missing member or a corrupt archive is a REFUSAL, never empty evidence', () => {
    assert.equal(parseReleaseEvidence(buildZip({ 'other.json': '{}' })).evidence, null);
    assert.match(parseReleaseEvidence(buildZip({ other: '{}' })).error, /no readable release-evidence.json member/);
    assert.equal(parseReleaseEvidence(Buffer.from('not a zip at all, definitely')).evidence, null);
    assert.match(parseReleaseEvidence(Buffer.from('not a zip at all, definitely')).error, /no readable/);
    // A member that is present but not JSON is still a refusal, not an object with missing fields.
    const notJson = parseReleaseEvidence(buildZip({ [EVIDENCE_MEMBER]: '{not json' }));
    assert.equal(notJson.evidence, null);
    assert.match(notJson.error, /not valid JSON/);
});

test('artifact: the evidence validator names each contract violation independently', () => {
    const spec = { kind: LONG_EVIDENCE_KIND, tierField: 'size', tier: 'medium', requireTruthy: ['ok'], requireSha256: ['corpus.treeSha256'] };
    assert.deepEqual(validateReleaseEvidence({ evidence: goodLongEvidence(), spec, sha: SHA, artifactName: 'a' }), []);
    const problems = validateReleaseEvidence({ evidence: goodLongEvidence({ schemaVersion: 0, kind: 'x', headSha: OTHER_SHA, size: 'large', ok: false, corpus: { treeSha256: 'zz' } }), spec, sha: SHA, artifactName: 'a' });
    for (const expected of [/schemaVersion/, /kind/, /headSha/, /size/, /ok/, /corpus.treeSha256/]) {
        assert.ok(problems.some((problem) => expected.test(problem)), `${expected} missing from ${JSON.stringify(problems)}`);
    }
});

// ---- the LIVE PLUMBING: fabricated GitHub API responses, including the refusals ---------------------------------
test('live: the query fetches jobs and downloads the named artifact evidence, and refusals surface as nulls', async () => {
    const zip = buildZip({ [EVIDENCE_MEMBER]: JSON.stringify(goodLongEvidence()) });
    const baseRun = { ...run('Workflow A', { id: 71 }), artifacts_url: 'x' };
    const calls = [];
    const fetchImpl = async (url, options) => {
        calls.push(url);
        if (/\/actions\/runs\?/.test(url)) return jsonResponse({ workflow_runs: [baseRun] });
        if (/\/runs\/71\/artifacts/.test(url)) return jsonResponse({ artifacts: [{ id: 900, name: 'longlived-medium-evidence', expired: false, size_in_bytes: 1234 }] });
        if (/\/runs\/71\/jobs/.test(url)) return jsonResponse({ jobs: [{ name: 'medium-corpus', status: 'completed', conclusion: 'success' }] });
        if (/\/artifacts\/900\/zip/.test(url)) return { ok: true, arrayBuffer: async () => zip };
        throw new Error(`unexpected fetch ${url} ${options?.headers?.Accept ?? ''}`);
    };
    const runs = await fetchRunsFromApi({ sha: SHA, repo: 'owner/repo', token: 't', includeArtifacts: true, includeJobs: true, includeEvidence: true, artifactNames: ['longlived-medium-evidence'], fetchImpl });
    assert.equal(runs[0].jobs[0].name, 'medium-corpus');
    assert.equal(runs[0].artifacts[0].evidence.kind, LONG_EVIDENCE_KIND);
    const verdict = evaluateGates({ manifest: longGateEntry(), sha: SHA, runs });
    assert.equal(verdict.ok, true, JSON.stringify(verdict.problems));

    // THE FAILURE DIRECTION: listing failures become nulls, and the gate refuses (it never treats "not fetched" as OK).
    const failing = async (url) => {
        if (/\/actions\/runs\?/.test(url)) return jsonResponse({ workflow_runs: [baseRun] });
        return { ok: false, status: 500, text: async () => 'boom' };
    };
    const refusedRuns = await fetchRunsFromApi({ sha: SHA, repo: 'owner/repo', token: 't', includeArtifacts: true, includeJobs: true, includeEvidence: true, artifactNames: [], fetchImpl: failing });
    const refused = evaluateGates({ manifest: longGateEntry(), sha: SHA, runs: refusedRuns });
    assert.equal(refused.ok, false);
    assert.ok(refused.problems.some((problem) => /missing-jobs/.test(problem)), JSON.stringify(refused.problems));

    // A zip download that answers 404 is named in the refusal, not silently skipped.
    const missingZip = async (url) => {
        if (/\/actions\/runs\?/.test(url)) return jsonResponse({ workflow_runs: [baseRun] });
        if (/\/runs\/71\/artifacts/.test(url)) return jsonResponse({ artifacts: [{ id: 900, name: 'longlived-medium-evidence', expired: false, size_in_bytes: 1234 }] });
        if (/\/runs\/71\/jobs/.test(url)) return jsonResponse({ jobs: [{ name: 'medium-corpus', status: 'completed', conclusion: 'success' }] });
        return { ok: false, status: 404, text: async () => 'gone' };
    };
    const missingRuns = await fetchRunsFromApi({ sha: SHA, repo: 'owner/repo', token: 't', includeArtifacts: true, includeJobs: true, includeEvidence: true, artifactNames: ['longlived-medium-evidence'], fetchImpl: missingZip });
    const missing = evaluateGates({ manifest: longGateEntry(), sha: SHA, runs: missingRuns });
    assert.equal(missing.ok, false);
    assert.ok(missing.problems.some((problem) => /missing-evidence/.test(problem) && /404/.test(problem)), JSON.stringify(missing.problems));
    assert.ok(calls.length >= 4);
});

function jsonResponse(payload) {
    return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
}

// ---- RELEASE WORKFLOW WIRING: the publish path must call the same classifier and the updated gate ----------------
test('workflow wiring: release.yml publish uses the shared classifier and the same-SHA gate, and a dispatch cannot publish', () => {
    const text = readFileSync(path.join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
    const jobBlock = (name) => {
        const match = new RegExp(`^  ${name}:\\s*$([\\s\\S]*?)(?=^  [A-Za-z0-9_-]+:\\s*$|(?!([\\s\\S])))`, 'm').exec(text);
        assert.ok(match, `release.yml has no ${name} job`);
        return match[1];
    };
    // Six platform assets in the build matrix.
    for (const archive of ['gotavern-linux-amd64.tar.gz', 'gotavern-linux-arm64.tar.gz', 'gotavern-darwin-amd64.tar.gz', 'gotavern-darwin-arm64.tar.gz', 'gotavern-windows-amd64.zip', 'gotavern-windows-arm64.zip']) {
        assert.ok(text.includes(archive), `release.yml does not build ${archive}`);
    }
    const publish = jobBlock('publish');
    assert.ok(/refs\/tags\/v\*/.test(publish) || /github\.ref_type == 'tag'/.test(text), 'the publish job must be gated on a TAG ref so a dispatch is a dry run');
    assert.match(publish, /classify-version-tag\.sh/, 'the publish job must ask the ONE classifier for the channel');
    assert.match(publish, /assemble-release-body\.mjs/, 'the curated-body path must use the shared gate through the assembler');
    assert.match(publish, /verify-release-gates\.mjs/, 'the generated-notes path must call the same-SHA gate CLI');
    assert.match(publish, /needs:[\s\S]*prepublish-qualification/, 'publish must depend on the prepublish qualification at the tag commit');
    const prepublish = jobBlock('prepublish-qualification');
    assert.match(prepublish, /candidate_version/, 'the prepublish job must be exercisable by a candidate_version dispatch');
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

// ---- darwin/arm64 recorded platform limitation --------------------------------------------------------------------
// The publish gate must REFUSE a darwin/arm64 archive whose execution is neither proven nor recorded, and it must
// refuse a recorded downgrade that is not stated in the release notes. These planted cases exercise the same
// `evaluateMarker` the publish job runs; `darwinArm64SelfTest` is the program the publish job runs before it reads
// the real marker, and the wiring case below keeps the workflow from quietly dropping either step.
const DOWNGRADE_DIGEST = 'c'.repeat(64);
const PLATFORM_ANNOTATION = "The configuration 'macos-14-arm64-us-default' is not supported";

function downgradeMarker(overrides = {}) {
    return JSON.stringify({
        schemaVersion: 1,
        kind: 'gotavern-darwin-arm64-platform-limitation',
        target: 'darwin/arm64',
        version: 'v0.1.0-alpha.16',
        archive: 'gotavern-darwin-arm64.tar.gz',
        archiveSha256: DOWNGRADE_DIGEST,
        mode: 'recorded-downgrade',
        reasonCode: 'platform-runner-unavailable',
        inspection: {
            machO: { magic: '0xfeedfacf', cpuType: '0x0100000c', cpuTypeName: 'arm64' },
            buildInfo: { goos: 'darwin', goarch: 'arm64' },
        },
        platformEvidence: {
            attempts: [{ runId: '42242191281', jobId: '127975851110', conclusion: 'cancelled', annotation: PLATFORM_ANNOTATION }],
        },
        execution: { performed: false, evidence: null },
        ...overrides,
    });
}

const LIMITATION_NOTES = '## Known limitations\n\nThe darwin/arm64 target is NOT runtime-qualified; runtime execution is not qualified.\n';
const NO_LIMITATION_NOTES = '## Known limitations\n\nNothing to report.\n';

test('darwin/arm64: a missing platform-limitation marker is refused by name', () => {
    const verdict = evaluateMarker({ markerText: '', notesText: LIMITATION_NOTES, archiveSha256: DOWNGRADE_DIGEST });
    assert.equal(verdict.ok, false);
    assert.ok(verdict.problems.some((problem) => problem.includes('missing-marker')), JSON.stringify(verdict.problems));
});

test('darwin/arm64: a recorded downgrade without the release-notes limitation line is refused', () => {
    const verdict = evaluateMarker({ markerText: downgradeMarker(), notesText: NO_LIMITATION_NOTES, archiveSha256: DOWNGRADE_DIGEST });
    assert.equal(verdict.ok, false);
    assert.ok(verdict.problems.some((problem) => problem.includes('notes-limitation-missing')), JSON.stringify(verdict.problems));
});

test('darwin/arm64: a recorded downgrade with the marker and the published note line is accepted', () => {
    const verdict = evaluateMarker({ markerText: downgradeMarker(), notesText: LIMITATION_NOTES, archiveSha256: DOWNGRADE_DIGEST });
    assert.equal(verdict.ok, true, JSON.stringify(verdict.problems));
});

test('darwin/arm64: a marker claiming execution without execution evidence is refused', () => {
    const claimed = downgradeMarker({ mode: 'executed', execution: { performed: true, evidence: null } });
    const verdict = evaluateMarker({ markerText: claimed, notesText: LIMITATION_NOTES, archiveSha256: DOWNGRADE_DIGEST });
    assert.equal(verdict.ok, false);
    assert.ok(verdict.problems.some((problem) => problem.includes('execution-evidence-missing')), JSON.stringify(verdict.problems));
});

test('darwin/arm64: the workflow wires the recorded downgrade into the publish gate', () => {
    const workflow = readFileSync(path.join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
    assert.match(workflow, /^  darwin-arm64-recorded-downgrade:/m, 'the recorded-downgrade job is missing');
    assert.match(
        workflow,
        /needs: \[[^\]]*darwin-arm64-recorded-downgrade[^\]]*\]/,
        'the publish job no longer waits for the recorded-downgrade job',
    );
    assert.match(workflow, /darwin-arm64-qualification\.mjs --self-test/, 'the publish job no longer runs the planted cases');
    assert.match(workflow, /darwin-arm64-qualification\.mjs verify/, 'the publish job no longer verifies the marker');
    assert.doesNotMatch(workflow, /^  execute-darwin-arm64:/m, 'a pure-execution darwin/arm64 job is back without an execution marker');
});

test('darwin/arm64: the planted limitation cases hold', () => {
    assert.equal(darwinArm64SelfTest(), 0);
});

// ---- third-party extension compatibility: the macos/arm64 recorded platform limitation ---------------------------
// Gate #11 was blocked by the ONLY cancelled job in run 42247719306: the cross-platform macos-14 arm64 leg. The
// workflow now records the limitation instead of claiming the leg, and the aggregate job (which writes the
// extension-compat-evidence artifact the release gate consumes) refuses evidence without that record. These cases
// plant the refusals: a workflow that still executes the leg, an aggregate without the marker, a marker that
// claims the leg ran, and the wiring that keeps the disclosure inside the evidence artifact.
const THIRD_PARTY_WORKFLOW = path.join(ROOT, '.github', 'workflows', 'third-party-extension-compat.yml');

test('third-party: the workflow no longer declares a macos-14 arm64 cross-platform execution leg', () => {
    const workflow = readFileSync(THIRD_PARTY_WORKFLOW, 'utf8');
    const parsed = parseThirdPartyCrossPlatform(workflow);
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.platforms, ['windows-amd64', 'macos-amd64'], 'the cross-platform matrix must keep only the two runnable legs');
    assert.equal(parsed.hasArm64Leg, false, 'the workflow still declares os: macos-14 / platform: macos-arm64');
    assert.doesNotMatch(workflow, /^\s+platform: macos-arm64\s*$/m, 'a macos-arm64 matrix leg is still present');
});

test('third-party: the recorded-limitation job records a marker and the aggregate requires it', () => {
    const workflow = readFileSync(THIRD_PARTY_WORKFLOW, 'utf8');
    assert.match(workflow, /^  macos-arm64-recorded-limitation:/m, 'the recorded-limitation job is missing');
    assert.match(workflow, /macos-arm64-limitation\.mjs record/, 'the recorded-limitation job no longer records a marker');
    const aggregate = workflow.slice(workflow.indexOf('  aggregate:'), workflow.indexOf('  cross-platform:'));
    assert.match(aggregate, /needs: \[shard, macos-arm64-recorded-limitation\]/, 'the aggregate no longer depends on the limitation record');
    assert.match(aggregate, /name: macos-arm64-recorded-limitation/, 'the aggregate no longer downloads the limitation record');
    assert.match(aggregate, /macos-arm64-limitation\.mjs verify/, 'the aggregate no longer verifies the limitation record');
    assert.match(
        aggregate,
        /evidence-out "\$RUNNER_TEMP\/ext-compat\/evidence\/macos-arm64-platform-limitation\.json"/,
        'the limitation record is no longer copied into the extension-compat-evidence directory',
    );
});

function macosArm64Marker(overrides = {}) {
    return JSON.stringify({
        schemaVersion: 1,
        kind: 'gotavern-macos-arm64-platform-limitation',
        workflow: 'Third-party extension compatibility',
        target: 'macos/arm64',
        mode: 'recorded-limitation',
        reasonCode: 'platform-runner-unavailable',
        matrix: { crossPlatformPresent: ['windows-amd64', 'macos-amd64'], removed: ['macos-arm64'], arm64LegPresent: false },
        platformEvidence: {
            attempts: [
                {
                    runId: '42247719306',
                    jobId: '127994821648',
                    conclusion: 'cancelled',
                    annotation: "The configuration 'macos-14-arm64-us-default' is not supported",
                },
            ],
        },
        execution: { performed: false, evidence: null },
        ...overrides,
    });
}

test('third-party: a missing macos/arm64 limitation record is refused by name', () => {
    const verdict = evaluateMacosArm64Limitation({ markerText: '', workflowText: readFileSync(THIRD_PARTY_WORKFLOW, 'utf8') });
    assert.equal(verdict.ok, false);
    assert.ok(verdict.problems.some((problem) => problem.includes('missing-marker')), JSON.stringify(verdict.problems));
});

test('third-party: a limitation record that still claims the arm64 leg is refused', () => {
    const marker = macosArm64Marker({ matrix: { crossPlatformPresent: ['windows-amd64', 'macos-amd64'], removed: [], arm64LegPresent: true } });
    const verdict = evaluateMacosArm64Limitation({ markerText: marker, workflowText: readFileSync(THIRD_PARTY_WORKFLOW, 'utf8') });
    assert.equal(verdict.ok, false);
    assert.ok(verdict.problems.some((problem) => problem.includes('arm64-leg-still-claimed')), JSON.stringify(verdict.problems));
});

test('third-party: a limitation record claiming execution without evidence is refused', () => {
    const marker = macosArm64Marker({ execution: { performed: true, evidence: {} } });
    const verdict = evaluateMacosArm64Limitation({ markerText: marker, workflowText: readFileSync(THIRD_PARTY_WORKFLOW, 'utf8') });
    assert.equal(verdict.ok, false);
    assert.ok(verdict.problems.some((problem) => problem.includes('execution-claim-without-evidence')), JSON.stringify(verdict.problems));
});

test('third-party: a workflow that still declares the arm64 leg is refused even with a marker', () => {
    // Normalise a CRLF work tree before the structural edit: the assertion is about the workflow's shape, not about
    // the checkout's line endings.
    const workflow = readFileSync(THIRD_PARTY_WORKFLOW, 'utf8')
        .replace(/\r\n/g, '\n')
        .replace(
            '          - os: macos-15-intel\n            platform: macos-amd64',
            '          - os: macos-15-intel\n            platform: macos-amd64\n          - os: macos-14\n            platform: macos-arm64',
        );
    const verdict = evaluateMacosArm64Limitation({ markerText: macosArm64Marker(), workflowText: workflow });
    assert.equal(verdict.ok, false);
    assert.ok(verdict.problems.some((problem) => problem.includes('workflow-still-has-arm64-leg')), JSON.stringify(verdict.problems));
});

test('third-party: a valid recorded limitation is accepted with the real workflow', () => {
    const verdict = evaluateMacosArm64Limitation({
        markerText: macosArm64Marker(),
        workflowText: readFileSync(THIRD_PARTY_WORKFLOW, 'utf8'),
    });
    assert.equal(verdict.ok, true, JSON.stringify(verdict.problems));
});

test('third-party: the planted limitation cases hold', () => {
    assert.equal(macosArm64LimitationSelfTest(), 0);
});
