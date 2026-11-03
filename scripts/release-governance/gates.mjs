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
        if (entry.requiredEvent !== undefined && (typeof entry.requiredEvent !== 'string' || entry.requiredEvent.trim() === '')) {
            problems.push(`requiredGates[${index}].requiredEvent, when present, must be a non-empty event name (for example "workflow_dispatch")`);
        }
        // A GATE THAT PRODUCES A VERDICT MUST PRODUCE ITS EVIDENCE. `requiredArtifact` names the uploaded
        // artifact that carries the machine-checkable result (the 20/20 matrix, the lock hash, the
        // capability verdicts). Without it the gate would accept a green run whose aggregator step was
        // skipped or whose artifact expired -- a conclusion is not an artifact.
        if (entry.requiredArtifact !== undefined && (typeof entry.requiredArtifact !== 'string' || entry.requiredArtifact.trim() === '')) {
            problems.push(`requiredGates[${index}].requiredArtifact, when present, must be a non-empty artifact name`);
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
        // A NARROWED RUN IS NOT THE RELEASE GATE. `ci.yml` on a push selects its oracle probes from the changed
        // paths, so a push run at the candidate SHA can be green having executed a SUBSET (measured: run
        // 41210334467 at 0985be42 skipped the oracle entirely and still concluded success). A release therefore
        // needs a DELIBERATELY DISPATCHED run, whose selection is the full one; the manifest names the required
        // event per gate, and a run of another event is not evidence for that requirement.
        const atShaAll = candidates.filter((run) => run.head_sha === sha);
        const wrongEvent = entry.requiredEvent ? atShaAll.filter((run) => run.event !== entry.requiredEvent) : [];
        const atSha = entry.requiredEvent ? atShaAll.filter((run) => run.event === entry.requiredEvent) : atShaAll;
        const elsewhere = candidates.length - atSha.length;
        const completedSuccess = atSha.filter((run) => run.status === 'completed' && run.conclusion === 'success');
        const newest = (list) => [...list].sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')))[0] ?? null;

        if (completedSuccess.length > 0) {
            // THE ARTIFACT CHECK. A required artifact must be attached to the SAME successful run this row
            // names, and must not be expired. `artifacts` is populated by the live query; a fixture that
            // omits it fails closed rather than defaulting to "present".
            if (entry.requiredArtifact) {
                const withArtifact = completedSuccess.filter((run) => Array.isArray(run.artifacts)
                    && run.artifacts.some((artifact) => artifact?.name === entry.requiredArtifact && artifact?.expired !== true));
                if (withArtifact.length === 0) {
                    const observed = completedSuccess.flatMap((run) => (Array.isArray(run.artifacts) ? run.artifacts.map((artifact) => artifact?.name) : ['<artifacts not queried>']));
                    rows.push({
                        ...recordOf(newest(completedSuccess)),
                        verdict: 'missing-artifact',
                        artifact: entry.requiredArtifact,
                        detail: `the successful run(s) at the target SHA do not carry the required artifact ${JSON.stringify(entry.requiredArtifact)} (observed: ${[...new Set(observed)].join(', ') || 'none'})`,
                    });
                    continue;
                }
                const chosen = newest(withArtifact);
                rows.push({
                    ...recordOf(chosen),
                    verdict: 'success',
                    artifact: entry.requiredArtifact,
                    detail: `${withArtifact.length} completed success run(s) at the target SHA with event ${entry.requiredEvent ?? 'any'}, carrying artifact ${JSON.stringify(entry.requiredArtifact)}`,
                });
                continue;
            }
            rows.push({
                ...recordOf(newest(completedSuccess)),
                verdict: 'success',
                detail: `${completedSuccess.length} completed success run(s) at the target SHA with event ${entry.requiredEvent ?? 'any'}`,
            });
            continue;
        }

        if (atSha.length === 0) {
            rows.push({
                ...recordOf(wrongEvent[0] ?? null),
                workflow: entry.workflow,
                verdict: 'missing',
                detail: wrongEvent.length > 0
                    ? `no ${entry.requiredEvent} run at the target SHA (${wrongEvent.length} run(s) of the same workflow exist there with event(s) ${[...new Set(wrongEvent.map((run) => run.event))].join(', ')}, which prove a narrowed selection, not the release gate)`
                    : elsewhere === 0
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

// Live query for the runs of one commit. Kept here (with an injectable `fetchImpl`) so the gate CLI, the body assembler
// and any test use ONE selection/query implementation, and a test can simulate GitHub without a network.
export async function fetchRunsFromApi({ sha, repo, token, fetchImpl = fetch, includeArtifacts = false }) {
    if (!token || !repo) {
        throw new Error('live mode needs GITHUB_TOKEN (or GH_TOKEN) and GITHUB_REPOSITORY; refusing to guess');
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
        const response = await fetchImpl(url, { headers });
        if (!response.ok) {
            throw new Error(`GitHub API answered ${response.status} for the runs of ${sha}: ${(await response.text()).slice(0, 400)}`);
        }
        const payload = await response.json();
        const pageRuns = payload.workflow_runs ?? [];
        runs.push(...pageRuns);
        if (pageRuns.length < 100) break;
    }
    // THE ARTIFACT LIST OF EACH RUN, fetched only when a manifest entry requires one. The runs API does
    // not embed artifacts, and a required artifact that was never looked for is the same as no check at
    // all. An artifact lookup failure is attached as an empty list, which fails the artifact check closed.
    if (includeArtifacts) {
        for (const run of runs) {
            try {
                const response = await fetchImpl(`https://api.github.com/repos/${repo}/actions/runs/${run.id}/artifacts?per_page=100`, { headers });
                if (!response.ok) {
                    run.artifacts = [];
                    continue;
                }
                const payload = await response.json();
                run.artifacts = (payload.artifacts ?? []).map((artifact) => ({ name: artifact.name, expired: artifact.expired, sizeInBytes: artifact.size_in_bytes }));
            } catch {
                run.artifacts = [];
            }
        }
    }
    return runs;
}

// The publishable evidence section appended to a curated release body. Live run ids are generated here because the
// note cannot contain them: a note that cites the ids of runs is written after those runs, and editing it into the
// tagged commit would change the commit those runs judged. The section is a measurement written at publish time.
export function renderEvidence({ rows, sha, repo }) {
    const lines = [];
    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push('## Qualification evidence (same-SHA required gates)');
    lines.push('');
    lines.push(`Every workflow below has a completed, successful run whose \`head_sha\` is this release tag's target commit \`${sha}\`. The table is generated from the GitHub Actions API by \`scripts/assemble-release-body.mjs\` immediately before publication, so it is a measurement of this tag, not a hand-copied list.`);
    lines.push('');
    lines.push('| workflow | run id | event | conclusion | artifact |');
    lines.push('|---|---|---|---|---|');
    for (const row of rows) {
        const link = repo ? `[${row.runId}](https://github.com/${repo}/actions/runs/${row.runId})` : String(row.runId);
        lines.push(`| ${row.workflow} | ${link} | ${row.event ?? '-'} | ${row.conclusion ?? '-'} | ${row.artifact ?? '-'} |`);
    }
    lines.push('');
    lines.push('The `artifact` column names the uploaded evidence bundle the verifier required for gates whose verdict is a machine-checked set (for example the 20/20 third-party extension matrix); `-` means the gate is judged by its own conclusion.');
    lines.push('');
    lines.push(`Target commit: \`${sha}\``);
    lines.push('');
    return `${lines.join('\n')}\n`;
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
