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

import { EVIDENCE_MEMBER, parseReleaseEvidence, validateReleaseEvidence } from './artifact-evidence.mjs';

// EVENTS the manifest may require. A typo must be a RED at PR time, not a gate that silently never matches a run: the
// `requiredEvent` value is matched against the runs API's `event` field, so `workflow_disaptch` would fail closed at
// publish time with a message that looks like a missing run. The allowlist is the set of events that can actually
// carry release evidence; `schedule` is present because a nightly rail is a legitimate requirement (a dispatched run
// is NOT a scheduled run and must not satisfy it).
export const KNOWN_EVENTS = new Set([
    'workflow_dispatch',
    'schedule',
    'push',
    'pull_request',
    'workflow_run',
    'release',
    'merge_group',
    'repository_dispatch',
]);

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
        if (entry.requiredEvent !== undefined) {
            if (typeof entry.requiredEvent !== 'string' || entry.requiredEvent.trim() === '') {
                problems.push(`requiredGates[${index}].requiredEvent, when present, must be a non-empty event name (for example "workflow_dispatch")`);
            } else if (!KNOWN_EVENTS.has(entry.requiredEvent)) {
                problems.push(`requiredGates[${index}].requiredEvent ${JSON.stringify(entry.requiredEvent)} is not a known Actions event (known: ${[...KNOWN_EVENTS].sort().join(', ')})`);
            }
        }
        // A GATE THAT PRODUCES A VERDICT MUST PRODUCE ITS EVIDENCE. `requiredArtifact` names the uploaded
        // artifact that carries the machine-checkable result (the 20/20 matrix, the lock hash, the
        // capability verdicts). Without it the gate would accept a green run whose aggregator step was
        // skipped or whose artifact expired -- a conclusion is not an artifact.
        if (entry.requiredArtifact !== undefined && (typeof entry.requiredArtifact !== 'string' || entry.requiredArtifact.trim() === '')) {
            problems.push(`requiredGates[${index}].requiredArtifact, when present, must be a non-empty artifact name`);
        }
        // A GREEN RUN CAN HAVE SKIPPED JOBS. The runs API reports the workflow's conclusion; a job whose `if:`
        // evaluated false (the small-tier long-lived run is exactly that) contributes a SKIPPED job to a SUCCESSFUL
        // run. `requiredJobs` names the jobs that must themselves be completed/success at the target SHA.
        if (entry.requiredJobs !== undefined) {
            if (!Array.isArray(entry.requiredJobs) || entry.requiredJobs.length === 0) {
                problems.push(`requiredGates[${index}].requiredJobs, when present, must be a non-empty array of job names`);
            } else {
                const jobs = new Set();
                for (const [jobIndex, job] of entry.requiredJobs.entries()) {
                    if (typeof job !== 'string' || job.trim() === '') {
                        problems.push(`requiredGates[${index}].requiredJobs[${jobIndex}] is not a non-empty job name`);
                        continue;
                    }
                    if (jobs.has(job)) problems.push(`requiredGates[${index}].requiredJobs names ${JSON.stringify(job)} twice`);
                    jobs.add(job);
                }
            }
        }
        // THE ARTIFACT'S CONTENT IS PART OF THE CONTRACT. `requiredEvidence` describes the release-evidence document
        // the fixed-name artifact must contain: its kind, the tier marker that separates a default small run from the
        // qualified medium one, the embedded HEAD SHA (the same-SHA property applied to the CONTENT), and the fields
        // that must be true/digests. It is meaningless without an artifact to read, so it requires one.
        if (entry.requiredEvidence !== undefined) {
            const spec = entry.requiredEvidence;
            if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
                problems.push(`requiredGates[${index}].requiredEvidence, when present, must be an object`);
            } else {
                if (typeof spec.kind !== 'string' || spec.kind.trim() === '') {
                    problems.push(`requiredGates[${index}].requiredEvidence.kind is required (the document type the artifact must carry)`);
                }
                if (spec.tier !== undefined && typeof spec.tier !== 'string') {
                    problems.push(`requiredGates[${index}].requiredEvidence.tier, when present, must be a string`);
                }
                if (spec.tierField !== undefined && (typeof spec.tierField !== 'string' || spec.tierField.trim() === '')) {
                    problems.push(`requiredGates[${index}].requiredEvidence.tierField, when present, must be a non-empty member path`);
                }
                for (const fieldName of ['requireTruthy', 'requireSha256']) {
                    const list = spec[fieldName];
                    if (list === undefined) continue;
                    if (!Array.isArray(list) || list.length === 0 || list.some((value) => typeof value !== 'string' || value.trim() === '')) {
                        problems.push(`requiredGates[${index}].requiredEvidence.${fieldName}, when present, must be a non-empty array of member paths`);
                    }
                }
                if (typeof entry.requiredArtifact !== 'string' || entry.requiredArtifact.trim() === '') {
                    problems.push(`requiredGates[${index}].requiredEvidence requires requiredArtifact: there is no artifact whose content could be read`);
                }
            }
        }
        // A NARROWED OR UNINTENDED TRIGGER MUST NOT BE ABLE TO SATISFY AN EVIDENCE GATE. Any gate that names a job,
        // an artifact or embedded evidence MUST also name the event it accepts; otherwise a push run (which can carry
        // the same fixed-name artifact) would be accepted.
        if ((entry.requiredArtifact !== undefined || entry.requiredJobs !== undefined || entry.requiredEvidence !== undefined)
            && entry.requiredEvent === undefined) {
            problems.push(`requiredGates[${index}] names a required job/artifact/evidence but no requiredEvent; a push-triggered run could then masquerade as release evidence`);
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

// THE THREE EVIDENCE RAILS, checked against ONE candidate run. A run can be green and still fail any of them, and each
// refusal names the rail that broke so a mutation is localised:
//
//   jobs      every `requiredJobs` entry must be completed/success IN THIS RUN (a skipped job is not success);
//   artifact  the fixed-name artifact must be attached to this run and not expired;
//   evidence  the artifact must CONTAIN a release-evidence document whose kind, embedded head SHA, tier marker and
//             required fields match the manifest (a name is not content).
function checkEvidenceRails(entry, run, sha) {
    if (Array.isArray(entry.requiredJobs) && entry.requiredJobs.length > 0) {
        if (!Array.isArray(run.jobs)) {
            return {
                ok: false,
                verdict: 'missing-jobs',
                detail: `the runs query did not retrieve the job list for run ${run.id}, so the required job(s) ${entry.requiredJobs.map((job) => JSON.stringify(job)).join(', ')} cannot be asserted`,
            };
        }
        for (const requiredJob of entry.requiredJobs) {
            const job = run.jobs.find((candidate) => candidate?.name === requiredJob);
            if (!job) {
                const observed = run.jobs.map((candidate) => candidate?.name).filter(Boolean);
                return {
                    ok: false,
                    verdict: 'missing-job',
                    detail: `required job ${JSON.stringify(requiredJob)} is absent from run ${run.id} (jobs: ${observed.length === 0 ? 'none' : observed.join(', ')})`,
                };
            }
            if (job.status !== 'completed' || job.conclusion !== 'success') {
                return {
                    ok: false,
                    verdict: 'job-not-green',
                    detail: `required job ${JSON.stringify(requiredJob)} is ${job.status}/${job.conclusion ?? 'no conclusion'} in run ${run.id}${job.conclusion === 'skipped' ? ' (a skipped job is not a green job)' : ''}`,
                };
            }
        }
    }

    if (entry.requiredArtifact) {
        if (!Array.isArray(run.artifacts)) {
            return {
                ok: false,
                verdict: 'missing-artifact',
                detail: `the runs query did not retrieve artifacts for run ${run.id}, so the required artifact ${JSON.stringify(entry.requiredArtifact)} cannot be asserted`,
            };
        }
        const artifact = run.artifacts.find((candidate) => candidate?.name === entry.requiredArtifact);
        if (!artifact || artifact.expired === true) {
            const observed = [...new Set(run.artifacts.map((candidate) => candidate?.name).filter(Boolean))];
            return {
                ok: false,
                verdict: 'missing-artifact',
                detail: `the successful run(s) at the target SHA do not carry the required artifact ${JSON.stringify(entry.requiredArtifact)}${artifact?.expired === true ? ' (the artifact is EXPIRED)' : ''} (observed: ${observed.join(', ') || 'none'})`,
            };
        }
        if (entry.requiredEvidence) {
            if (!artifact.evidence) {
                return {
                    ok: false,
                    verdict: 'missing-evidence',
                    detail: `artifact ${JSON.stringify(entry.requiredArtifact)} in run ${run.id} carries no readable release-evidence document (${artifact.evidenceError ?? 'the content was not fetched'})`,
                };
            }
            const evidenceProblems = validateReleaseEvidence({
                evidence: artifact.evidence,
                spec: entry.requiredEvidence,
                sha,
                artifactName: entry.requiredArtifact,
            });
            if (evidenceProblems.length > 0) {
                return {
                    ok: false,
                    verdict: 'evidence-mismatch',
                    detail: `artifact ${JSON.stringify(entry.requiredArtifact)} in run ${run.id} carries evidence that does not satisfy its manifest contract: ${evidenceProblems.join('; ')}`,
                };
            }
        }
    }
    return { ok: true };
}

// Pick one run per required workflow. Preference is: a completed successful run at the target SHA that SATISFIES its
// evidence rails wins; otherwise the newest run at the target SHA is reported as the blocking observation. Runs at a
// different SHA are counted and reported, never accepted -- that is the whole same-SHA property.
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

    const newest = (list) => [...list].sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')))[0] ?? null;

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

        if (completedSuccess.length > 0) {
            // Check the rails on the newest runs first; a green run whose required job was SKIPPED or whose artifact
            // carries the wrong tier/marker must not win over an older run that satisfies the contract.
            const ordered = [...completedSuccess].sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')));
            let blocked = null;
            for (const run of ordered) {
                const rail = checkEvidenceRails(entry, run, sha);
                if (rail.ok) {
                    blocked = null;
                    rows.push({
                        ...recordOf(run),
                        verdict: 'success',
                        artifact: entry.requiredArtifact,
                        evidence: entry.requiredEvidence?.kind,
                        requiredJobs: entry.requiredJobs,
                        detail: `${completedSuccess.length} completed success run(s) at the target SHA with event ${entry.requiredEvent ?? 'any'}${entry.requiredArtifact ? `, carrying artifact ${JSON.stringify(entry.requiredArtifact)}` : ''}${entry.requiredJobs ? `, required job(s) ${entry.requiredJobs.join(', ')} green` : ''}${entry.requiredEvidence ? `, evidence kind ${JSON.stringify(entry.requiredEvidence.kind)} with the candidate head SHA and tier marker` : ''}`,
                    });
                    break;
                }
                blocked = { run, rail };
            }
            if (!blocked) continue;
            rows.push({
                ...recordOf(blocked.run),
                verdict: blocked.rail.verdict,
                artifact: entry.requiredArtifact,
                evidence: entry.requiredEvidence?.kind,
                requiredJobs: entry.requiredJobs,
                detail: blocked.rail.detail,
            });
            continue;
        }

        if (atSha.length === 0) {
            rows.push({
                ...recordOf(wrongEvent[0] ?? null),
                workflow: entry.workflow,
                verdict: 'missing',
                detail: wrongEvent.length > 0
                    ? entry.requiredEvent === 'schedule'
                        ? `no SCHEDULED run at the target SHA (${wrongEvent.length} run(s) of the same workflow exist there with event(s) ${[...new Set(wrongEvent.map((run) => run.event))].join(', ')}; a dispatched or pushed run is not a scheduled/cron run)`
                        : `no ${entry.requiredEvent} run at the target SHA (${wrongEvent.length} run(s) of the same workflow exist there with event(s) ${[...new Set(wrongEvent.map((run) => run.event))].join(', ')}, which prove a narrowed selection, not the release gate)`
                    : elsewhere === 0
                        ? 'no run of this workflow exists; the gate cannot be satisfied by a claim'
                        : `no run at the target SHA (${elsewhere} run(s) exist at other SHAs, which is exactly the mismatch this gate refuses)`,
            });
            continue;
        }

        const blockedRun = newest(atSha);
        rows.push({
            ...recordOf(blockedRun),
            verdict: 'not-green',
            detail: `newest run at the target SHA is ${blockedRun.status}/${blockedRun.conclusion ?? 'no conclusion'}`,
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

// What the live query must fetch, derived from the manifest in ONE place so the verifier CLI and the body assembler
// cannot ask for different evidence. A caller that asked for artifacts but not jobs would let a skipped required job
// pass on a workflow conclusion; that split is why this is a single function.
export function evidenceQueryNeeds(manifest) {
    const gates = manifest?.requiredGates ?? [];
    return {
        includeArtifacts: gates.some((entry) => entry.requiredArtifact || entry.requiredJobs || entry.requiredEvidence),
        includeJobs: gates.some((entry) => entry.requiredJobs),
        includeEvidence: gates.some((entry) => entry.requiredEvidence),
        artifactNames: [...new Set(gates.map((entry) => entry.requiredArtifact).filter(Boolean))],
    };
}


// Live query for the runs of one commit. Kept here (with an injectable `fetchImpl`) so the gate CLI, the body assembler
// and any test use ONE selection/query implementation, and a test can simulate GitHub without a network.
//
// THREE SEPARATE QUERIES, because the runs API embeds none of them:
//   * artifacts: a required artifact is not visible on the run object, and an artifact that was never looked for is the
//     same as no check at all;
//   * jobs: a workflow's conclusion can be `success` while a required job was SKIPPED, so the jobs list is what makes
//     `requiredJobs` enforceable;
//   * evidence: the CONTENT of a required artifact (its kind, embedded tier marker and head SHA). Archives are
//     downloaded only for names in `artifactNames`, so the query never pulls unrelated release-sized archives.
// A failure to LIST artifacts/jobs is attached as `null` and a failure to READ evidence as `evidenceError`; both are
// refusals in evaluateGates, never "requirement absent".
export async function fetchRunsFromApi({
    sha,
    repo,
    token,
    fetchImpl = fetch,
    includeArtifacts = false,
    includeJobs = false,
    includeEvidence = false,
    artifactNames = [],
}) {
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
    // all. An artifact lookup failure is attached as null, which fails the artifact check closed.
    if (includeArtifacts) {
        for (const run of runs) {
            try {
                const response = await fetchImpl(`https://api.github.com/repos/${repo}/actions/runs/${run.id}/artifacts?per_page=100`, { headers });
                if (!response.ok) {
                    run.artifacts = null;
                    continue;
                }
                const payload = await response.json();
                run.artifacts = (payload.artifacts ?? []).map((artifact) => ({ id: artifact.id, name: artifact.name, expired: artifact.expired, sizeInBytes: artifact.size_in_bytes }));
            } catch {
                run.artifacts = null;
            }
        }
    }
    // THE JOB LIST, fetched only when an entry names a required job. `conclusion: success` on the RUN does not imply
    // every job ran: the small-tier long-lived dispatch is green with medium-corpus SKIPPED, which is the masquerade
    // `requiredJobs` exists to catch. A failed lookup is null and fails the job check closed.
    if (includeJobs) {
        for (const run of runs) {
            try {
                const response = await fetchImpl(`https://api.github.com/repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`, { headers });
                if (!response.ok) {
                    run.jobs = null;
                    continue;
                }
                const payload = await response.json();
                run.jobs = (payload.jobs ?? []).map((job) => ({ name: job.name, status: job.status, conclusion: job.conclusion }));
            } catch {
                run.jobs = null;
            }
        }
    }
    // THE EMBEDDED EVIDENCE, read out of the fixed-name artifact archive. Only the named artifacts are downloaded;
    // the release-evidence.json member is parsed out with a bounded ZIP reader (artifact-evidence.mjs).
    if (includeEvidence) {
        const wanted = new Set(artifactNames);
        for (const run of runs) {
            if (!Array.isArray(run.artifacts)) continue;
            for (const artifact of run.artifacts) {
                if (artifact?.expired === true || artifact?.id === undefined) continue;
                if (wanted.size > 0 && !wanted.has(artifact.name)) continue;
                try {
                    const response = await fetchImpl(`https://api.github.com/repos/${repo}/actions/artifacts/${artifact.id}/zip`, { headers });
                    if (!response.ok) {
                        artifact.evidenceError = `the artifact download answered ${response.status}`;
                        continue;
                    }
                    const buffer = Buffer.from(await response.arrayBuffer());
                    const parsed = parseReleaseEvidence(buffer, EVIDENCE_MEMBER);
                    artifact.evidence = parsed.evidence;
                    if (parsed.error) artifact.evidenceError = parsed.error;
                } catch (error) {
                    artifact.evidenceError = `the artifact download failed: ${error.message}`;
                }
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
    lines.push('| workflow | run id | event | conclusion | required jobs | artifact (evidence) |');
    lines.push('|---|---|---|---|---|---|');
    for (const row of rows) {
        const link = repo ? `[${row.runId}](https://github.com/${repo}/actions/runs/${row.runId})` : String(row.runId);
        const jobs = Array.isArray(row.requiredJobs) && row.requiredJobs.length > 0 ? row.requiredJobs.join(', ') : '-';
        const artifact = row.artifact ? `${row.artifact}${row.evidence ? ` (${row.evidence})` : ''}` : '-';
        lines.push(`| ${row.workflow} | ${link} | ${row.event ?? '-'} | ${row.conclusion ?? '-'} | ${jobs} | ${artifact} |`);
    }
    lines.push('');
    lines.push('The `required jobs` column names the jobs that had to be completed/success IN the cited run, not merely present in a green workflow; the `artifact (evidence)` column names the fixed-name evidence bundle the verifier downloaded and the document kind whose embedded head SHA and tier marker it checked (`-` means the gate is judged by its own conclusion).');
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
