// Pure decision logic for the release same-SHA gate. No network, no filesystem: the CLI wrapper
// (scripts/verify-release-gates.mjs) supplies the manifest and the runs it fetched, and the Node test
// (scripts/release-governance.test.mjs) supplies synthetic runs so every refusal has a demonstrated teeth case.
//
// WHY THIS EXISTS. Alpha.9's release was published from a candidate whose gates were all green, but nothing in the
// pipeline ASSERTED that the green runs belonged to the commit the tag pointed at. A release whose CI ran on one
// SHA, whose browser differential ran on another and whose qualification ran on a third is indistinguishable, in a
// hand-written checklist, from a release whose gates all ran on the same commit -- and the difference is exactly the
// evidence the tag claims. The release workflow now calls this gate before `gh release create` and FAILS CLOSED.
//
// The gate answers one question per required workflow: is there at least one COMPLETED run of that workflow whose
// head_sha is the target commit and whose conclusion is success? It never repairs a missing run, never accepts a
// different SHA, and never treats "in progress" or "cancelled" as success.

export const SCHEMA_VERSION = 1;

// A manifest entry is a workflow NAME (the `name:` field of the workflow file, which is what the runs API reports as
// `name`), not a file path: a path would silently stop matching if a workflow were renamed while its runs kept the
// old name, and the manifest must be checkable against the workflows that exist.
export function validateManifest(manifest) {
    const problems = [];
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
        return ['manifest is not a JSON object'];
    }
    if (manifest.schemaVersion !== SCHEMA_VERSION) {
        problems.push(`schemaVersion is ${JSON.stringify(manifest.schemaVersion)}, expected ${SCHEMA_VERSION}`);
    }
    if (manifest.sameShaRequired !== true) {
        problems.push('sameShaRequired must be exactly true; a release gate that does not require one SHA is not a gate');
    }
    if (!Array.isArray(manifest.requiredGates) || manifest.requiredGates.length === 0) {
        problems.push('requiredGates must be a non-empty array');
        return problems;
    }
    const seen = new Set();
    for (const [index, entry] of manifest.requiredGates.entries()) {
        if (!entry || typeof entry !== 'object') {
            problems.push(`requiredGates[${index}] is not an object`);
            continue;
        }
        if (typeof entry.workflow !== 'string' || entry.workflow.trim() === '') {
            problems.push(`requiredGates[${index}].workflow is not a non-empty string`);
            continue;
        }
        if (seen.has(entry.workflow)) problems.push(`requiredGates names ${JSON.stringify(entry.workflow)} twice`);
        seen.add(entry.workflow);
        if (typeof entry.why !== 'string' || entry.why.trim() === '') {
            problems.push(`requiredGates[${index}].why is required so the gate records what it is buying`);
        }
    }
    return problems;
}

function recordOf(run) {
    return {
        workflow: run?.name ?? null,
        runId: run?.id ?? null,
        headSha: run?.head_sha ?? null,
        status: run?.status ?? null,
        conclusion: run?.conclusion ?? null,
        event: run?.event ?? null,
        createdAt: run?.created_at ?? null,
        url: run?.html_url ?? null,
    };
}

// Pick one run per required workflow. Preference is: a successful completed run at the target SHA wins; otherwise the
// newest run at the target SHA is reported as the blocking observation. Runs at a different SHA are counted and
// reported, never accepted -- that is the whole same-SHA property.
export function evaluateGates({ manifest, runs, sha }) {
    const problems = validateManifest(manifest);
    if (!Array.isArray(runs)) problems.push('runs is not an array');
    if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha)) problems.push(`sha ${JSON.stringify(sha)} is not a 40-hex commit`);

    const rows = [];
    if (problems.length > 0) return { ok: false, sha: sha ?? null, rows, problems };

    const byName = new Map();
    for (const run of runs) {
        if (!run || typeof run !== 'object') continue;
        const name = run.name;
        if (typeof name !== 'string') continue;
        if (!byName.has(name)) byName.set(name, []);
        byName.get(name).push(run);
    }

    for (const entry of manifest.requiredGates) {
        const candidates = byName.get(entry.workflow) ?? [];
        const atSha = candidates.filter((run) => run.head_sha === sha);
        const elsewhere = candidates.length - atSha.length;
        const completedSuccess = atSha.filter((run) => run.status === 'completed' && run.conclusion === 'success');
        const newest = (list) => [...list].sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')))[0] ?? null;

        if (completedSuccess.length > 0) {
            rows.push({
                ...recordOf(newest(completedSuccess)),
                verdict: 'success',
                detail: `${completedSuccess.length} completed success run(s) at the target SHA`,
            });
            continue;
        }

        if (atSha.length === 0) {
            rows.push({
                ...recordOf(null),
                workflow: entry.workflow,
                verdict: 'missing',
                detail: elsewhere === 0
                    ? 'no run of this workflow exists; the gate cannot be satisfied by a claim'
                    : `no run at the target SHA (${elsewhere} run(s) exist at other SHAs, which is exactly the mismatch this gate refuses)`,
            });
            continue;
        }

        const blocked = newest(atSha);
        rows.push({
            ...recordOf(blocked),
            verdict: 'not-green',
            detail: `newest run at the target SHA is ${blocked.status}/${blocked.conclusion ?? 'no conclusion'}`,
        });
    }

    for (const row of rows) {
        if (row.verdict !== 'success') {
            const id = row.runId === null ? 'no run' : `run ${row.runId}`;
            problems.push(`${row.workflow}: ${row.verdict} (${id}): ${row.detail}`);
        }
    }

    return { ok: problems.length === 0, sha, rows, problems };
}

// The manifest must name workflows that exist. Checking the manifest against the workflow files is a UNIT fact, not a
// runtime query: a typo would otherwise fail closed at publish time with a message that looks like a missing run.
export function validateManifestAgainstWorkflowNames(manifest, workflowNames) {
    const problems = [];
    const known = new Set(workflowNames);
    for (const entry of manifest?.requiredGates ?? []) {
        if (typeof entry?.workflow === 'string' && !known.has(entry.workflow)) {
            problems.push(`required gate ${JSON.stringify(entry.workflow)} names no workflow in .github/workflows (known: ${[...known].sort().join(', ')})`);
        }
    }
    return problems;
}
