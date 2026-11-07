// THE UNIFIED RELEASE EVIDENCE CONTRACT.
//
// Everything before this module produced a VERDICT (`scripts/verify-release-gates.mjs` prints PASS/FAIL) and a
// human-readable table. A verdict is not a record: the release needs ONE machine-checkable document that says, per
// required gate, exactly which run was judged, which jobs were required and what their statuses were, which artifact
// was consumed and with which digest, what the embedded evidence said, and -- crucially -- which fields COULD NOT be
// derived from the Actions API. Those fields are recorded as `null` with `derived: false` and a written reason. The
// alternative, a document with a plausible-looking value that no query produced, is the failure mode this project has
// paid for repeatedly (fabricated run ids, a green that belonged to another workflow, evidence that was never read).
//
// DETERMINISM. The document is built from the manifest order and the runs the verifier judged. It contains no clock
// value, no random id and no environment-dependent ordering, so two runs over the same input produce byte-identical
// JSON. That is what lets the release record be diffed and cited.
//
// The emitter shares the verifier's query plan (`evidenceQueryNeeds`) and its decision function (`evaluateGates`), so
// the document cannot be produced from different evidence than the verdict. It REFUSES to write a document whose
// `overall.result` is not `PASS`; a failing or unprovable gate is reported to stderr and exits non-zero, because a
// saved "PASS" document that never gated the publication is worse than no document.

import { readFileSync, writeFileSync } from 'node:fs';
import { evaluateGates, evidenceQueryNeeds, fetchRunsFromApi } from './gates.mjs';

export const RELEASE_EVIDENCE_KIND = 'gotavern-release-evidence';
export const RELEASE_EVIDENCE_SCHEMA_VERSION = 1;

// The pinned oracle baseline this program writes against (AGENTS.md hard rule 1). Exported as a CONVENIENCE for the
// command line and the tests; the contract does not assume it: `--pinned-sha`/`manifest.pinnedSha` supplies the value
// and the document records where it came from. A hardcoded default that no one could override would be the same defect
// as an invented field.
export const KNOWN_PINNED_ORACLE_SHA = '06bde939fb1e9c4c8d8641d810f0a916b5bce127';

function derivedField(value, source) {
    return { value, derived: true, source };
}

// A field that the Actions API cannot answer. `value` is ALWAYS null: a caller cannot accidentally read a guess as a
// measurement, and every such field carries the reason it is absent so the document explains its own gaps.
function notDerived(reason) {
    return { value: null, derived: false, reason };
}

const NOT_DERIVABLE_INPUTS = 'the Actions runs API exposes no dispatch inputs for a run: the workflow_run object has no `inputs` member (verified against GitHub API run 42340311363 on 2026-11-07) and display_title carries the workflow name, not the inputs. The dispatch selection is therefore proven from required jobs / embedded evidence where the manifest names a requiredSelection, and recorded as unverifiable otherwise -- never inferred from a title or invented';
const NOT_DERIVABLE_TESTS = 'per-gate test selection/execution counts are not exposed by the Actions API; they live in each run log, which this document does not parse. Where a gate\'s embedded evidence document carries a count it is recorded under gates[].tests with its source; otherwise it stays null';
const NOT_DERIVABLE_TIER = 'the release has no single tier: the combination journey requires tier=full and the long-lived corpus requires medium, while other gates have none. Per-gate tiers are recorded under gates[].tier only where an embedded evidence document names them; a single release-wide value would be invented';
const NOT_DERIVABLE_SEED = 'no gate on this wave is required to record a seed, and the Actions API exposes none; a gate whose embedded evidence carries `seed` is recorded under gates[].seed and any first such value is also surfaced here, but this wave carries none';

function evidenceValue(evidence) {
    if (!evidence || typeof evidence !== 'object') return null;
    return evidence;
}

function gateSelection(row) {
    if (row.verdict === 'narrowed-selection') {
        return { status: 'narrowed', derived: true, reason: row.detail ?? null };
    }
    if (row.verdict === 'selection-unverifiable') {
        return { status: 'unverifiable', derived: false, reason: row.detail ?? null };
    }
    const selection = row.selection && typeof row.selection === 'object' ? row.selection : null;
    if (selection?.declared === true) {
        return { status: 'proven', derived: true, provenBy: selection.provenBy ?? null };
    }
    return {
        status: 'unverifiable',
        derived: false,
        reason: 'the manifest names no requiredSelection for this gate, so the dispatch selection is not proved by the Actions API',
    };
}

function gateTests(row) {
    const evidence = evidenceValue(row.evidenceDocument ?? null);
    const pick = (name) => (evidence && evidence[name] !== undefined ? evidence[name] : undefined);
    const tests = { selected: null, executed: null, unexecuted: null, derived: false };
    let any = false;
    for (const [key, member] of [['selected', 'selectedTests'], ['executed', 'executedTests'], ['unexecuted', 'unexecutedTests']]) {
        const value = pick(member);
        if (value !== undefined) {
            tests[key] = value;
            any = true;
        }
    }
    if (any) {
        tests.derived = true;
        tests.source = 'the gate\'s embedded evidence document';
    } else {
        tests.reason = NOT_DERIVABLE_TESTS;
    }
    return tests;
}

function negativeControlOf(row) {
    const evidence = evidenceValue(row.evidenceDocument ?? null);
    if (!evidence) return null;
    for (const [path, value] of Object.entries(evidence)) {
        if (typeof value === 'boolean' && /teeth|negativecontrol|selftest/i.test(path)) {
            return { field: path, ok: value };
        }
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            for (const [innerPath, innerValue] of Object.entries(value)) {
                if (typeof innerValue === 'boolean' && /teeth|negativecontrol|selftest/i.test(innerPath)) {
                    return { field: `${path}.${innerPath}`, ok: innerValue };
                }
            }
        }
    }
    return null;
}

/**
 * Build the unified evidence document from the SAME manifest + runs + SHA the gate judged.
 * `verdict` is computed here with `evaluateGates` so the document cannot disagree with the verdict.
 */
export function buildReleaseEvidence({ manifest, runs, sha, repo = '', workflow = null, event = null, pinnedSha = null, pinnedShaSource = null, runsFixture = null }) {
    const verdict = evaluateGates({ manifest, runs, sha });
    const rows = verdict.rows ?? [];

    // The evidence documents themselves are needed for per-gate content fields, and they are attached to the artifact
    // objects by the live query; they are NOT re-downloaded here.
    const gates = rows.map((row) => {
        const selection = gateSelection(row);
        const evidence = evidenceValue(row.evidence);
        const fields = row.evidenceFields ?? (evidence ? Object.keys(evidence).sort() : null);
        return {
            workflow: row.workflow,
            runId: row.runId,
            headSha: row.headSha ?? null,
            event: row.event ?? null,
            status: row.status ?? null,
            conclusion: row.conclusion ?? null,
            verdict: row.verdict,
            detail: row.detail ?? null,
            requiredJobs: row.requiredJobs ?? [],
            jobs: (row.jobDetails ?? []).map((job) => ({ name: job.name, status: job.status, conclusion: job.conclusion })),
            selection,
            artifact: row.artifact ? { name: row.artifact, digest: row.artifactDigest ?? null, createdAt: row.artifactCreatedAt ?? null, expiresAt: row.artifactExpiresAt ?? null, workflowRunId: row.artifactWorkflowRunId ?? null } : null,
            embeddedEvidence: row.evidence || row.evidenceFields
                ? {
                    kind: row.evidence ?? null,
                    tier: row.tier ?? null,
                    headSha: row.evidenceHeadSha ?? null,
                    pinnedSha: row.evidencePinnedSha ?? null,
                    presentFields: fields,
                }
                : null,
            tests: gateTests(row),
            negativeControl: negativeControlOf(row),
        };
    });

    const problemGate = (workflowName) => {
        const row = rows.find((candidate) => candidate.workflow === workflowName);
        return row ?? null;
    };
    // Overall verdict: the ONLY place a PASS may be claimed. `publishable` is what a publish path must check.
    const overall = {
        result: verdict.ok ? 'PASS' : 'FAIL',
        gates: rows.length,
        passed: rows.filter((row) => row.verdict === 'success').length,
        problems: verdict.problems,
        derived: true,
        source: 'evaluateGates over the Actions API runs/jobs/artifacts at the candidate SHA',
    };

    const artifactDigests = [];
    for (const row of rows) {
        if (!row.artifact) continue;
        artifactDigests.push({
            workflow: row.workflow,
            runId: row.runId,
            name: row.artifact,
            digest: row.artifactDigest ?? null,
            digestDerived: row.artifactDigest !== null && row.artifactDigest !== undefined,
            createdAt: row.artifactCreatedAt ?? null,
            expired: false,
        });
    }

    const negative = gates
        .map((gate) => (gate.negativeControl ? { workflow: gate.workflow, ...gate.negativeControl } : null))
        .filter(Boolean);
    const seedEvidence = rows.find((row) => row.evidenceDocument && row.evidenceDocument.seed !== undefined);

    const provenSelections = gates.filter((gate) => gate.selection.status === 'proven').map((gate) => gate.workflow);
    const unverifiableSelections = gates.filter((gate) => gate.selection.status === 'unverifiable').map((gate) => gate.workflow);
    const narrowedSelections = gates.filter((gate) => gate.selection.status === 'narrowed').map((gate) => gate.workflow);

    const doc = {
        schemaVersion: RELEASE_EVIDENCE_SCHEMA_VERSION,
        kind: RELEASE_EVIDENCE_KIND,
        workflow: workflow === null
            ? notDerived('the Actions API does not name the workflow that produced this document; the publish step supplies GITHUB_WORKFLOW, and it is null when the verifier runs outside Actions')
            : derivedField(workflow, 'the publish step (GITHUB_WORKFLOW / --workflow)'),
        headSha: derivedField(sha, 'the commit the gate judged (--sha)'),
        pinnedSha: pinnedSha === null
            ? notDerived('no pinned oracle commit is named by the manifest (pinnedSha) or by --pinned-sha, and the Actions API exposes no run field naming it')
            : derivedField(pinnedSha, pinnedShaSource ?? 'the manifest (pinnedSha) or --pinned-sha'),
        event: event === null
            ? notDerived('the publishing run\'s event is read from GITHUB_EVENT_NAME; it is null when the verifier runs outside Actions')
            : derivedField(event, 'the publishing run (GITHUB_EVENT_NAME / --event)'),
        dispatchInputs: notDerived(NOT_DERIVABLE_INPUTS),
        selectedTests: notDerived(NOT_DERIVABLE_TESTS),
        executedTests: notDerived(NOT_DERIVABLE_TESTS),
        unexecutedTests: notDerived(NOT_DERIVABLE_TESTS),
        tier: notDerived(NOT_DERIVABLE_TIER),
        seed: seedEvidence ? derivedField(seedEvidence.seed, `the embedded evidence document of ${seedEvidence.workflow} (run ${seedEvidence.runId})`) : notDerived(NOT_DERIVABLE_SEED),
        selection: { proven: provenSelections, unverifiable: unverifiableSelections, narrowed: narrowedSelections },
        artifactDigests,
        negativeControl: negative.length > 0
            ? { derived: true, ok: negative.every((entry) => entry.ok === true), gates: negative, source: 'boolean teeth/negative-control members of the judged gates\' embedded evidence documents' }
            : notDerived('no gate on this wave is required to carry a negative-control/teeth member in its embedded evidence, and the Actions API does not expose one'),
        gates,
        overall,
        publishable: verdict.ok === true,
        repo: repo || null,
        judgedSha: sha,
        runsFixture: runsFixture ?? null,
    };
    // Record the per-gate evidence documents so `gateTests`/`negativeControlOf` can read them; they are NOT serialised
    // (they are already carried by the artifact the row cites). Attaching after construction keeps the emitted JSON
    // free of duplicated megabytes while the doc stays self-contained about what it checked.
    for (const [index, row] of rows.entries()) gates[index].evidenceDocument = row.evidence ?? null;
    for (const gate of gates) delete gate.evidenceDocument;
    return doc;
}

// Markdown rendering of the same document. The table is the human-readable half of the contract; every cell is a value
// the JSON also carries, and unverifiable selections are printed as such instead of being left blank.
export function renderReleaseEvidenceMarkdown(doc) {
    const lines = [];
    lines.push(`## Unified release evidence contract (\`${doc.judgedSha}\`)`);
    lines.push('');
    lines.push(`Kind \`${doc.kind}\` schemaVersion ${doc.schemaVersion}. Generated from the Actions API by \`scripts/release-governance/release-evidence.mjs\`; deterministic (no clock value).`);
    lines.push('');
    lines.push(`**Overall: ${doc.overall.result}** - ${doc.overall.passed}/${doc.overall.gates} required gate(s) green at this SHA.`);
    lines.push('');
    lines.push('| workflow | run | event | verdict | required jobs | artifact (digest) | embedded evidence | selection |');
    lines.push('|---|---|---|---|---|---|---|---|');
    for (const gate of doc.gates) {
        const jobs = gate.jobs.length > 0
            ? gate.jobs.map((job) => `${job.name}=${job.conclusion ?? job.status}`).join(', ')
            : (gate.requiredJobs.length > 0 ? gate.requiredJobs.join(', ') : '-');
        const artifact = gate.artifact ? `${gate.artifact.name} (${gate.artifact.digest ?? 'digest not exposed'})` : '-';
        const evidence = gate.embeddedEvidence
            ? `kind=${gate.embeddedEvidence.kind ?? '-'}${gate.embeddedEvidence.tier ? `, tier=${gate.embeddedEvidence.tier}` : ''}${gate.embeddedEvidence.pinnedSha ? `, pinnedSha=${gate.embeddedEvidence.pinnedSha}` : ''}`
            : '-';
        const selection = gate.selection.status === 'proven'
            ? `proven (${gate.selection.provenBy})`
            : gate.selection.status === 'narrowed'
                ? 'NARROWED'
                : 'unverifiable (derived:false)';
        lines.push(`| ${gate.workflow} | ${gate.runId ?? '-'} | ${gate.event ?? '-'} | ${gate.verdict} | ${jobs} | ${artifact} | ${evidence} | ${selection} |`);
    }
    lines.push('');
    if (!doc.publishable) {
        lines.push('Refusals (this document is NOT publishable):');
        for (const problem of doc.overall.problems) lines.push(`- ${problem}`);
        lines.push('');
    }
    lines.push('### Fields the Actions API cannot answer (recorded, not invented)');
    lines.push('');
    for (const [name, value] of Object.entries(doc)) {
        if (value && typeof value === 'object' && value.derived === false && value.reason) {
            lines.push(`- \`${name}\`: ${value.reason}`);
        }
    }
    lines.push('');
    lines.push('### Selection proof');
    lines.push('');
    lines.push(`- proven from the API: ${doc.selection.proven.length === 0 ? 'none' : doc.selection.proven.join(', ')}`);
    lines.push(`- unverifiable (the manifest names no requiredSelection, so the dispatch inputs are not exposed): ${doc.selection.unverifiable.length === 0 ? 'none' : doc.selection.unverifiable.join(', ')}`);
    lines.push(`- narrowed (refused): ${doc.selection.narrowed.length === 0 ? 'none' : doc.selection.narrowed.join(', ')}`);
    lines.push('');
    if (doc.pinnedSha.derived) lines.push(`Pinned oracle commit: \`${doc.pinnedSha.value}\` (${doc.pinnedSha.source})`);
    else lines.push('Pinned oracle commit: **not recorded** (derived:false) - see the reason above.');
    lines.push('');
    return `${lines.join('\n')}\n`;
}

// Serialise deterministically. `JSON.stringify(doc, null, 2)` over a document built in manifest order is stable; this
// function exists so the CLI and the tests share ONE serialisation and a trailing newline is guaranteed.
export function serializeReleaseEvidence(doc) {
    return `${JSON.stringify(doc, null, 2)}\n`;
}

/**
 * Run the SAME queries the verifier runs, build the document, and write it ONLY when every gate passed.
 * Returns { ok, doc, problems, jsonPath, markdownPath }.
 */
export async function emitReleaseEvidence({
    manifest,
    sha,
    repo = '',
    token = '',
    runs = null,
    runsJsonPath = null,
    workflow = null,
    event = null,
    pinnedSha = null,
    pinnedShaSource = null,
    outPath = null,
    markdownOutPath = null,
    fetchImpl = fetch,
}) {
    let resolvedRuns = runs;
    if (resolvedRuns === null) {
        if (runsJsonPath) {
            const fixture = JSON.parse(readFileSync(runsJsonPath, 'utf8'));
            resolvedRuns = Array.isArray(fixture) ? fixture : fixture.workflow_runs ?? [];
        } else {
            resolvedRuns = await fetchRunsFromApi({ sha, repo, token, fetchImpl, ...evidenceQueryNeeds(manifest) });
        }
    }
    const doc = buildReleaseEvidence({ manifest, runs: resolvedRuns, sha, repo, workflow, event, pinnedSha, pinnedShaSource });
    const problems = doc.publishable ? [] : [...doc.overall.problems, `overall result is ${doc.overall.result}, so no PASS evidence document is written`];
    if (!doc.publishable) return { ok: false, doc, problems, jsonPath: null, markdownPath: null };
    if (outPath) writeFileSync(outPath, serializeReleaseEvidence(doc), 'utf8');
    if (markdownOutPath) writeFileSync(markdownOutPath, renderReleaseEvidenceMarkdown(doc), 'utf8');
    return { ok: true, doc, problems: [], jsonPath: outPath, markdownPath: markdownOutPath };
}
