#!/usr/bin/env node
// SAME-SHA RELEASE GATE. Run before `gh release create`: every required workflow must have a completed, successful
// run whose head_sha is the commit the release tag points at. Fails closed.
//
// Usage:
//   node scripts/verify-release-gates.mjs --sha <40-hex commit> [--manifest docs/release-manifest.json]
//   node scripts/verify-release-gates.mjs --sha <sha> --runs-json <file>     # offline fixture / self-test
//
// Environment (live mode): GITHUB_TOKEN or GH_TOKEN, GITHUB_REPOSITORY (owner/repo). The workflow itself passes
// GITHUB_TOKEN, which is scoped to this repository; no other credential is required.
//
// Exit status is the gate: 0 only when EVERY required workflow is green at the target SHA. The printed table is the
// evidence, and it is also written to GITHUB_STEP_SUMMARY when that file is set, so the release run's own summary
// names the exact run ids the tag is resting on instead of implying them.

import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import { evaluateGates, validateManifest, validateManifestAgainstWorkflowNames } from './release-governance/gates.mjs';

const args = process.argv.slice(2);
function valueOf(flag, fallback = null) {
    const index = args.indexOf(flag);
    if (index === -1) return fallback;
    return args[index + 1] ?? fallback;
}

const sha = valueOf('--sha');
const manifestPath = valueOf('--manifest', 'docs/release-manifest.json');
const runsJsonPath = valueOf('--runs-json');
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
// that could never match anything.
const workflowNames = [];
if (existsSync('.github/workflows')) {
    const { readdirSync } = await import('node:fs');
    for (const name of readdirSync('.github/workflows')) {
        if (!/\.ya?ml$/.test(name)) continue;
        const text = readFileSync(`.github/workflows/${name}`, 'utf8');
        const match = text.match(/^name:\s*(.+?)\s*$/m);
        if (match) workflowNames.push(match[1].replace(/^['"]|['"]$/g, ''));
    }
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
    if (token === '' || repo === '') {
        fail('live mode needs GITHUB_TOKEN (or GH_TOKEN) and GITHUB_REPOSITORY; refusing to guess');
        process.exit(1);
    }
    const headers = {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'gotavern-release-gate',
    };
    const runs = [];
    for (let page = 1; page <= 10; page += 1) {
        const url = `https://api.github.com/repos/${repo}/actions/runs?head_sha=${sha}&per_page=100&page=${page}`;
        const response = await fetch(url, { headers });
        if (!response.ok) {
            fail(`GitHub API answered ${response.status} for the runs of ${sha}: ${(await response.text()).slice(0, 400)}`);
            process.exit(1);
        }
        const payload = await response.json();
        const pageRuns = payload.workflow_runs ?? [];
        runs.push(...pageRuns);
        if (pageRuns.length < 100) break;
    }
    return runs;
}

const runs = await fetchRuns();
const verdict = evaluateGates({ manifest, runs, sha });

const lines = [];
lines.push(`## Same-SHA release gate for \`${sha}\``);
lines.push('');
lines.push('Every required workflow must have a completed, successful run whose `head_sha` is this commit.');
lines.push('');
lines.push('| required workflow | run | event | status | conclusion | verdict |');
lines.push('|---|---|---|---|---|---|');
for (const row of verdict.rows) {
    lines.push(`| ${row.workflow} | ${row.runId === null ? '-' : row.runId} | ${row.event ?? '-'} | ${row.status ?? '-'} | ${row.conclusion ?? '-'} | ${row.verdict} |`);
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

if (!verdict.ok) {
    for (const problem of verdict.problems) console.error(`::error::${problem}`);
    process.exitCode = 1;
}
