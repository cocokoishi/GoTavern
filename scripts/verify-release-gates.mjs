#!/usr/bin/env node
// SAME-SHA RELEASE GATE. Run before `gh release create`: every required workflow must have a completed, successful
// run whose head_sha is the commit the release tag points at. Fails closed.
//
// Usage:
//   node scripts/verify-release-gates.mjs --sha <40-hex commit> [--manifest docs/release-manifest.json]
//   node scripts/verify-release-gates.mjs --sha <sha> --runs-json <file>     # offline fixture / self-test
//   node scripts/verify-release-gates.mjs --sha <sha> --evidence-out <file>  # also write the publishable evidence table
//
// THE EVIDENCE TABLE IS THE POINT OF THE WHOLE CHECK. The release notes cannot cite the ids of runs that had not
// happened when the notes were written -- a note is part of the commit it describes, so filling in run ids changes the
// commit under judgement. Instead the committed note describes WHAT was qualified, and the publish step appends this
// evidence section, generated from the same-SHA query that gates the publication, to the body that goes live. The
// published body therefore carries the exact run ids and their target SHA, and the tag's tree does not have to contain
// a value that could not have existed when it was written.
//
// Environment (live mode): GITHUB_TOKEN or GH_TOKEN, GITHUB_REPOSITORY (owner/repo). The workflow itself passes
// GITHUB_TOKEN, which is scoped to this repository; no other credential is required.
//
// Exit status is the gate: 0 only when EVERY required workflow is green at the target SHA. The printed table is the
// evidence, and it is also written to GITHUB_STEP_SUMMARY when that file is set, so the release run's own summary
// names the exact run ids the tag is resting on instead of implying them.

import { readFileSync, appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { evaluateGates, evidenceQueryNeeds, fetchRunsFromApi, renderEvidence, validateManifest, validateManifestAgainstWorkflowNames, workflowPathMapFromFiles } from './release-governance/gates.mjs';
import { emitReleaseEvidence } from './release-governance/release-evidence.mjs';

const args = process.argv.slice(2);
function valueOf(flag, fallback = null) {
    const index = args.indexOf(flag);
    if (index === -1) return fallback;
    return args[index + 1] ?? fallback;
}

const sha = valueOf('--sha');
const manifestPath = valueOf('--manifest', 'docs/release-manifest.json');
const runsJsonPath = valueOf('--runs-json');
const evidenceOut = valueOf('--evidence-out');
const releaseEvidenceOut = valueOf('--release-evidence-out');
const releaseEvidenceMdOut = valueOf('--release-evidence-md-out');
const workflowName = valueOf('--workflow', process.env.GITHUB_WORKFLOW ?? null);
const eventName = valueOf('--event', process.env.GITHUB_EVENT_NAME ?? null);
const pinnedSha = valueOf('--pinned-sha');
const repo = process.env.GITHUB_REPOSITORY ?? '';
const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? '';

function fail(message) {
    console.error(`::error::${message}`);
    process.exitCode = 1;
}

if (!sha || !/^[0-9a-f]{40}$/.test(sha)) fail(`--sha must be a 40-hex commit; got ${JSON.stringify(sha)}`);
if (!existsSync(manifestPath)) fail(`manifest ${manifestPath} does not exist`);
if (process.exitCode === 1) process.exit(1);

let manifest;
try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
} catch (error) {
    fail(`manifest ${manifestPath} is not valid JSON: ${error.message}`);
    process.exit(1);
}
const manifestProblems = validateManifest(manifest);
if (manifestProblems.length > 0) {
    for (const problem of manifestProblems) console.error(`::error::manifest: ${problem}`);
    process.exit(1);
}

// The workflow-name cross-check needs the workflow files, which are in the checkout this step runs in. It is a
// second opinion beside the runtime query: the runtime query catches a missing run, this catches a manifest entry
// that could never match anything. The same files also produce the NAME -> FILE PATH map: a workflow that sets
// `run-name` reports the evaluated run-name in the run object's `name` (measured on run 42439335334), so the runtime
// query must be able to match a required workflow by the run's stable `path` as well as by its name.
const workflowNames = [];
let workflowPaths = null;
if (existsSync('.github/workflows')) {
    const { readdirSync } = await import('node:fs');
    const workflowFiles = [];
    for (const name of readdirSync('.github/workflows')) {
        if (!/\.ya?ml$/.test(name)) continue;
        const text = readFileSync(`.github/workflows/${name}`, 'utf8');
        workflowFiles.push({ path: `.github/workflows/${name}`, text });
        const match = text.match(/^name:\s*(.+?)\s*$/m);
        if (match) workflowNames.push(match[1].replace(/^['"]|['"]$/g, ''));
    }
    workflowPaths = workflowPathMapFromFiles(workflowFiles);
    const nameProblems = validateManifestAgainstWorkflowNames(manifest, workflowNames);
    if (nameProblems.length > 0) {
        for (const problem of nameProblems) console.error(`::error::manifest: ${problem}`);
        process.exit(1);
    }
}

async function fetchRuns() {
    if (runsJsonPath) {
        const fixture = JSON.parse(readFileSync(runsJsonPath, 'utf8'));
        return Array.isArray(fixture) ? fixture : fixture.workflow_runs ?? [];
    }
    try {
        // ONE derived query plan: whatever the manifest's evidence rails need (artifact lists, job lists, the embedded
        // evidence documents of the named artifacts), fetched by the shared implementation. A caller cannot ask for a
        // verdict on evidence it did not fetch.
        return await fetchRunsFromApi({ sha, repo, token, ...evidenceQueryNeeds(manifest) });
    } catch (error) {
        fail(error.message);
        process.exit(1);
    }
}

const runs = await fetchRuns();
const verdict = evaluateGates({ manifest, runs, sha, workflowPaths });

const lines = [];
lines.push(`## Same-SHA release gate for \`${sha}\``);
lines.push('');
lines.push('Every required workflow must have a completed, successful run whose `head_sha` is this commit.');
lines.push('');
lines.push('| required workflow | run | event | status | conclusion | required jobs | evidence | verdict |');
lines.push('|---|---|---|---|---|---|---|---|');
for (const row of verdict.rows) {
    const jobs = Array.isArray(row.requiredJobs) && row.requiredJobs.length > 0 ? row.requiredJobs.join(', ') : '-';
    const evidence = row.artifact ? `${row.artifact}${row.evidence ? ` (${row.evidence})` : ''}` : '-';
    lines.push(`| ${row.workflow} | ${row.runId === null ? '-' : row.runId} | ${row.event ?? '-'} | ${row.status ?? '-'} | ${row.conclusion ?? '-'} | ${jobs} | ${evidence} | ${row.verdict} |`);
}
if (!verdict.ok) {
    lines.push('');
    lines.push('Refusals, each naming the rail that broke (a green conclusion is not by itself evidence):');
    for (const row of verdict.rows.filter((candidate) => candidate.verdict !== 'success')) {
        lines.push(`- ${row.workflow}: **${row.verdict}** — ${row.detail ?? 'no detail'}`);
    }
}
lines.push('');
if (verdict.ok) {
    lines.push(`**PASS**: ${verdict.rows.length}/${manifest.requiredGates.length} required workflow(s) are green at this SHA.`);
} else {
    lines.push(`**FAIL**: ${verdict.problems.length} problem(s):`);
    for (const problem of verdict.problems) lines.push(`- ${problem}`);
}
const summary = `${lines.join('\n')}\n`;
process.stdout.write(summary);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);

// WRITE THE PUBLISHABLE EVIDENCE SECTION. Only a passing verdict may be appended to a release body; a failing verdict
// writes nothing, because a body that mentions a failed gate must never be publishable, and a release body is written
// by `gh release create` only after this exits 0 anyway.
if (verdict.ok && evidenceOut) {
    const evidence = renderEvidence({ rows: verdict.rows, sha, repo: repo || 'cocokoishi/GoTavern' });
    writeFileSync(evidenceOut, evidence, 'utf8');
    console.log(`wrote same-SHA qualification evidence to ${evidenceOut}`);
}

// WRITE THE UNIFIED RELEASE EVIDENCE CONTRACT (JSON + Markdown) when the publish path asks for it. The emitter shares
// this run's queries and decision function and REFUSES to write a PASS document if any gate failed; on a failing wave
// this branch never runs because the process exits non-zero below. Every field the Actions API cannot answer is written
// as null with `derived: false` and a reason -- never invented.
if (releaseEvidenceOut || releaseEvidenceMdOut) {
    if (!verdict.ok) {
        for (const problem of verdict.problems) console.error(`::error::refusing to write a release-evidence document: ${problem}`);
    } else {
        const { doc } = await emitReleaseEvidence({
            manifest,
            sha,
            repo: repo || 'cocokoishi/GoTavern',
            token,
            runs,
            workflow: workflowName,
            event: eventName,
            workflowPaths,
            // THE MANIFEST IS THE POLICY SOURCE. An explicit --pinned-sha wins for ad-hoc/local runs; otherwise the
            // baseline recorded in docs/release-manifest.json (`pinnedSha`) is used, so the publish path does not need a
            // second literal that could drift from the policy. Neither present -> null + derived:false + reason.
            pinnedSha: pinnedSha ?? manifest.pinnedSha ?? null,
            pinnedShaSource: pinnedSha
                ? '--pinned-sha (explicit command-line override)'
                : (manifest.pinnedSha ? 'manifest.pinnedSha (the release baseline policy)' : null),
            outPath: releaseEvidenceOut,
            markdownOutPath: releaseEvidenceMdOut,
        });
        if (releaseEvidenceOut) {
            console.log(`wrote unified release evidence to ${releaseEvidenceOut} (overall ${doc.overall.result}, ${doc.overall.passed}/${doc.overall.gates} gates)`);
        }
        if (releaseEvidenceMdOut) console.log(`wrote the release-evidence table to ${releaseEvidenceMdOut}`);
    }
}

if (!verdict.ok) {
    for (const problem of verdict.problems) console.error(`::error::${problem}`);
    process.exitCode = 1;
}

