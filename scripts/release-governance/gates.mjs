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
    // The release policy's pinned baseline, when it names one. Recorded in the unified evidence document and inherited by
    // no gate implicitly: a gate that must prove it names `requiredPinnedSha` itself, so a gate whose artifact carries no
    // pinned-baseline record can stay un-named instead of failing for a field its producer does not write yet.
    if (manifest.pinnedSha !== undefined) {
        if (typeof manifest.pinnedSha !== 'string' || !/^[0-9a-f]{40}$/.test(manifest.pinnedSha)) {
            problems.push(`pinnedSha, when present, must be a 40-hex commit id (the pinned oracle commit, e.g. 06bde939fb1e9c4c8d8641d810f0a916b5bce127)`);
        }
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
        // THE ARTIFACT MUST BELONG TO THE CITED RUN, NOT TO AN OLDER ATTEMPT. A fixed-name artifact can be attached to
        // a run whose head_sha matches while the BYTES were uploaded by another run (a re-run, an earlier dispatch at
        // another commit, or a retried attempt). `requiredArtifactFresh` makes the verifier compare the artifact's
        // created_at and workflow_run identity against the cited run; absent evidence of freshness is a refusal, not an
        // assumption. Declarative and optional: a manifest that does not name it is judged exactly as before.
        if (entry.requiredArtifactFresh !== undefined) {
            if (entry.requiredArtifactFresh !== true) {
                problems.push(`requiredGates[${index}].requiredArtifactFresh, when present, must be exactly true (an optional rail that can be set false is not a rail)`);
            }
            if (typeof entry.requiredArtifact !== 'string' || entry.requiredArtifact.trim() === '') {
                problems.push(`requiredGates[${index}].requiredArtifactFresh requires requiredArtifact: there is no artifact to freshness-check`);
            }
        }
        // A DIGEST BINDS THE BYTES. When named, the Actions API's artifact `digest` member (`sha256:<64 hex>`) must exist
        // and be well-formed, so the evidence document records the exact bytes the gate consumed instead of a name.
        if (entry.requireArtifactDigest !== undefined) {
            if (entry.requireArtifactDigest !== true) {
                problems.push(`requiredGates[${index}].requireArtifactDigest, when present, must be exactly true`);
            }
            if (typeof entry.requiredArtifact !== 'string' || entry.requiredArtifact.trim() === '') {
                problems.push(`requiredGates[${index}].requireArtifactDigest requires requiredArtifact: there is no artifact whose digest could be bound`);
            }
        }
        // PINNED-SHA BINDING. The embedded evidence may name the pinned oracle commit the run was produced against; a
        // gate naming `requiredPinnedSha` refuses evidence that omits it or names another commit. This is the baseline
        // rule (SillyTavern 1.19.0 at 06bde939...) applied to the CONTENT, so a run at the right candidate SHA cannot
        // satisfy it with a document recorded against a different oracle.
        if (entry.requiredPinnedSha !== undefined) {
            if (typeof entry.requiredPinnedSha !== 'string' || !/^[0-9a-f]{40}$/.test(entry.requiredPinnedSha)) {
                problems.push(`requiredGates[${index}].requiredPinnedSha, when present, must be a 40-hex commit id (the pinned oracle commit)`);
            }
            if (entry.requiredEvidence === undefined) {
                problems.push(`requiredGates[${index}].requiredPinnedSha requires requiredEvidence: the pinned commit is read from the artifact's embedded evidence document`);
            }
            if (typeof manifest.pinnedSha === 'string' && entry.requiredPinnedSha !== manifest.pinnedSha) {
                problems.push(`requiredGates[${index}].requiredPinnedSha ${JSON.stringify(entry.requiredPinnedSha)} contradicts the manifest's pinnedSha ${JSON.stringify(manifest.pinnedSha)}`);
            }
        }
        // NARROWED-DISPATCH PROOF. A dispatched run can still be narrowed: a workflow input may select `small` instead of
        // `medium`, `mode=smoke` instead of `mode=all`, or a `fast` combination tier instead of `full`. The run's
        // conclusion cannot see that, and neither can the job list when the narrowed branch runs the SAME job with fewer
        // steps. `requiredSelection` names what must be true for the selection to be the full one, and the verifier may
        // prove it from (a) a required job set, (b) embedded evidence members, or (c) the run's display title. If none of
        // the declared sources can be read for the run, the gate is `selection-unverifiable` and REFUSES -- a selection
        // that cannot be proved is not accepted silently.
        if (entry.requiredSelection !== undefined) {
            const selection = entry.requiredSelection;
            if (!selection || typeof selection !== 'object' || Array.isArray(selection)) {
                problems.push(`requiredGates[${index}].requiredSelection, when present, must be an object`);
            } else {
                const allowed = new Set(['jobs', 'evidence', 'titleIncludes']);
                for (const key of Object.keys(selection)) {
                    if (!allowed.has(key)) {
                        problems.push(`requiredGates[${index}].requiredSelection.${key} is not a known selection source (known: ${[...allowed].sort().join(', ')})`);
                    }
                }
                let sources = 0;
                if (selection.jobs !== undefined) {
                    sources += 1;
                    if (!Array.isArray(selection.jobs) || selection.jobs.length === 0 || selection.jobs.some((job) => typeof job !== 'string' || job.trim() === '')) {
                        problems.push(`requiredGates[${index}].requiredSelection.jobs, when present, must be a non-empty array of job names`);
                    }
                }
                if (selection.evidence !== undefined) {
                    sources += 1;
                    if (!Array.isArray(selection.evidence) || selection.evidence.length === 0) {
                        problems.push(`requiredGates[${index}].requiredSelection.evidence, when present, must be a non-empty array of {path, equals} members`);
                    } else {
                        for (const [memberIndex, member] of selection.evidence.entries()) {
                            if (!member || typeof member !== 'object' || Array.isArray(member)) {
                                problems.push(`requiredGates[${index}].requiredSelection.evidence[${memberIndex}] is not an object`);
                                continue;
                            }
                            if (typeof member.path !== 'string' || member.path.trim() === '') {
                                problems.push(`requiredGates[${index}].requiredSelection.evidence[${memberIndex}].path is not a non-empty member path`);
                            }
                            if (!Object.prototype.hasOwnProperty.call(member, 'equals')) {
                                problems.push(`requiredGates[${index}].requiredSelection.evidence[${memberIndex}] names no expected value (equals)`);
                            }
                        }
                    }
                    if (typeof entry.requiredArtifact !== 'string' || entry.requiredArtifact.trim() === '') {
                        problems.push(`requiredGates[${index}].requiredSelection.evidence requires requiredArtifact: the selection fields are read from the artifact's embedded evidence document`);
                    }
                }
                if (selection.titleIncludes !== undefined) {
                    sources += 1;
                    if (!Array.isArray(selection.titleIncludes) || selection.titleIncludes.length === 0 || selection.titleIncludes.some((text) => typeof text !== 'string' || text === '')) {
                        problems.push(`requiredGates[${index}].requiredSelection.titleIncludes, when present, must be a non-empty array of non-empty strings`);
                    }
                }
                if (sources === 0) {
                    problems.push(`requiredGates[${index}].requiredSelection names no proof source; a selection requirement that cannot be checked is not a rail`);
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
                if (spec.pinnedShaField !== undefined && (typeof spec.pinnedShaField !== 'string' || spec.pinnedShaField.trim() === '')) {
                    problems.push(`requiredGates[${index}].requiredEvidence.pinnedShaField, when present, must be a non-empty member path (the member that carries the pinned oracle commit, e.g. pinnedSha or pinnedCommit)`);
                }
                for (const fieldName of ['requireTruthy', 'requireSha256', 'requireFields']) {
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

// Read one member by dotted path out of an embedded evidence document. Kept here (not imported from
// artifact-evidence.mjs) because a gate's `requiredSelection` compares ARBITRARY member paths and the two modules must
// not drift on what a path means.
function memberAt(value, dottedPath) {
    let current = value;
    for (const key of String(dottedPath).split('.')) {
        if (current === null || current === undefined || typeof current !== 'object') return undefined;
        current = current[key];
    }
    return current;
}

// THE NARROWED-DISPATCH RAIL. A dispatched run can still be narrowed by an input (`size=small`, `mode=smoke`,
// `tier=fast`), and the run's conclusion and even its job list can look identical when the narrowed branch runs the same
// job with fewer steps. `requiredSelection` names what must be true of the FULL selection and lets the verifier prove it
// from exactly three API-visible sources: the run's jobs, the artifact's embedded evidence, or the run's display title.
// The order of outcomes matters:
//   * a source PROVES it        -> pass, recording which source proved it;
//   * a source DISPROVES it     -> `narrowed-selection` (a definite observation, refused by name);
//   * only unavailable sources  -> `selection-unverifiable` (refused: a selection that cannot be proved is not accepted
//                                  silently, which is the whole point of this rail).
// The order of outcomes matters, and a gate may declare SEVERAL proof sources:
//   * every declared source that CAN be read is evaluated; a source that DISPROVES the full selection is a definite
//     observation and refuses by name even if another source would have proved it (two disagreeing observations are
//     not a green -- measured: before this rule, a corpus.origin="generator" artifact was accepted because its
//     display title said mode=all);
//   * with no disproval, at least one source must PROVE it (recording which one);
//   * only unavailable sources -> `selection-unverifiable` (refused: a selection that cannot be proved is not
//     accepted silently, which is the whole point of this rail).
function checkSelectionRail(entry, run, sha, evidence) {
    const selection = entry.requiredSelection;
    if (!selection) return { ok: true, declared: false };
    const unavailable = [];
    const disprovals = [];
    let provenBy = null;
    if (Array.isArray(selection.jobs) && selection.jobs.length > 0) {
        if (!Array.isArray(run.jobs)) {
            unavailable.push(`the job list for run ${run.id} was not retrieved`);
        } else {
            const bad = [];
            for (const requiredJob of selection.jobs) {
                const job = run.jobs.find((candidate) => candidate?.name === requiredJob);
                if (!job) bad.push(`${JSON.stringify(requiredJob)} absent`);
                else if (job.status !== 'completed' || job.conclusion !== 'success') bad.push(`${JSON.stringify(requiredJob)} ${job.status}/${job.conclusion ?? 'no conclusion'}`);
            }
            if (bad.length === 0) provenBy = provenBy ?? 'jobs';
            else disprovals.push(`required selection job(s) not green in run ${run.id}: ${bad.join(', ')}`);
        }
    }
    if (Array.isArray(selection.evidence) && selection.evidence.length > 0) {
        if (!evidence) {
            unavailable.push(`artifact ${JSON.stringify(entry.requiredArtifact)} carries no readable embedded evidence document`);
        } else {
            const bad = selection.evidence
                .filter((member) => memberAt(evidence, member.path) !== member.equals)
                .map((member) => `${member.path}=${JSON.stringify(memberAt(evidence, member.path))} (required ${JSON.stringify(member.equals)})`);
            if (bad.length === 0) provenBy = provenBy ?? 'evidence';
            else disprovals.push(`embedded evidence does not prove the full selection: ${bad.join(', ')}`);
        }
    }
    if (Array.isArray(selection.titleIncludes) && selection.titleIncludes.length > 0) {
        const title = run.display_title;
        if (typeof title !== 'string' || title.trim() === '') {
            unavailable.push(`run ${run.id} carries no display title to read`);
        } else {
            const missing = selection.titleIncludes.filter((text) => !title.includes(text));
            if (missing.length === 0) provenBy = provenBy ?? 'display-title';
            else disprovals.push(`run display title ${JSON.stringify(title)} does not contain ${missing.map((text) => JSON.stringify(text)).join(', ')}`);
        }
    }
    if (disprovals.length > 0) {
        return { ok: false, declared: true, verdict: 'narrowed-selection', detail: disprovals.join('; ') };
    }
    if (provenBy !== null) return { ok: true, declared: true, provenBy };
    return {
        ok: false,
        declared: true,
        verdict: 'selection-unverifiable',
        detail: `the manifest requires the full dispatch selection but no declared proof source can be read from the Actions API for run ${run.id}: ${unavailable.join('; ')}`,
    };
}

// THE EVIDENCE RAILS, checked against ONE candidate run. A run can be green and still fail any of them, and each
// refusal names the rail that broke so a mutation is localised:
//
//   jobs      every `requiredJobs` entry must be completed/success IN THIS RUN (a skipped job is not success);
//   artifact  the fixed-name artifact must be attached to this run and not expired;
//   fresh     the artifact must belong to THIS run/attempt, not an older one (opt-in per gate);
//   digest    the API's sha256 artifact digest must exist and be 64-hex (opt-in per gate);
//   evidence  the artifact must CONTAIN a release-evidence document whose kind, embedded head SHA, tier marker and
//             required fields match the manifest (a name is not content);
//   pinned    embedded evidence must name the pinned oracle commit (opt-in per gate);
//   selection the full dispatch selection must be provable (opt-in per gate; narrowed/unprovable refuse).
function checkEvidenceRails(entry, run, sha) {
    const facts = { jobDetails: [], artifact: null, evidence: null };
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
            facts.jobDetails.push({ name: job.name, status: job.status, conclusion: job.conclusion });
            if (job.status !== 'completed' || job.conclusion !== 'success') {
                return {
                    ok: false,
                    verdict: 'job-not-green',
                    detail: `required job ${JSON.stringify(requiredJob)} is ${job.status}/${job.conclusion ?? 'no conclusion'} in run ${run.id}${job.conclusion === 'skipped' ? ' (a skipped job is not a green job)' : ''}`,
                };
            }
        }
    }

    let artifact = null;
    let evidence = null;
    if (entry.requiredArtifact) {
        if (!Array.isArray(run.artifacts)) {
            return {
                ok: false,
                verdict: 'missing-artifact',
                detail: `the runs query did not retrieve artifacts for run ${run.id}, so the required artifact ${JSON.stringify(entry.requiredArtifact)} cannot be asserted`,
            };
        }
        artifact = run.artifacts.find((candidate) => candidate?.name === entry.requiredArtifact);
        if (!artifact || artifact.expired === true) {
            const observed = [...new Set(run.artifacts.map((candidate) => candidate?.name).filter(Boolean))];
            return {
                ok: false,
                verdict: 'missing-artifact',
                detail: `the successful run(s) at the target SHA do not carry the required artifact ${JSON.stringify(entry.requiredArtifact)}${artifact?.expired === true ? ' (the artifact is EXPIRED)' : ''} (observed: ${observed.join(', ') || 'none'})`,
            };
        }
        facts.artifact = artifact;
        // The embedded document is carried on the facts even when the gate's spec does not require it, so the unified
        // evidence document can report what the artifact actually said instead of only the fields a spec happened to name.
        if (artifact.evidence) {
            evidence = artifact.evidence;
            facts.evidence = artifact.evidence;
        }
        // A FIXED NAME IS NOT AN IDENTITY. The same fixed-name artifact can be attached to a run whose head_sha matches
        // while its bytes were uploaded by another run or an earlier attempt. Freshness is checked only where the
        // manifest names it, and an artifact that cannot be shown to belong to THIS run is refused rather than assumed.
        if (entry.requiredArtifactFresh === true) {
            const identity = artifact.workflow_run;
            if (identity && identity.id !== undefined && identity.id !== run.id) {
                return {
                    ok: false,
                    verdict: 'stale-artifact',
                    detail: `artifact ${JSON.stringify(entry.requiredArtifact)} in run ${run.id} belongs to run ${identity.id} (an older attempt or another run); a reused artifact is not evidence for this run`,
                };
            }
            if (identity && typeof identity.head_sha === 'string' && identity.head_sha !== sha) {
                return {
                    ok: false,
                    verdict: 'stale-artifact',
                    detail: `artifact ${JSON.stringify(entry.requiredArtifact)} in run ${run.id} records head_sha ${identity.head_sha}, not the candidate ${sha}`,
                };
            }
            const artifactCreated = Date.parse(artifact.created_at ?? '');
            const runCreated = Date.parse(run.created_at ?? '');
            if (Number.isNaN(artifactCreated) || Number.isNaN(runCreated)) {
                return {
                    ok: false,
                    verdict: 'stale-artifact',
                    detail: `artifact ${JSON.stringify(entry.requiredArtifact)} in run ${run.id} carries no comparable created_at (artifact ${JSON.stringify(artifact.created_at ?? null)}, run ${JSON.stringify(run.created_at ?? null)}), so it cannot be shown to belong to this run`,
                };
            }
            if (artifactCreated < runCreated) {
                return {
                    ok: false,
                    verdict: 'stale-artifact',
                    detail: `artifact ${JSON.stringify(entry.requiredArtifact)} in run ${run.id} was created at ${artifact.created_at}, BEFORE the cited run started at ${run.created_at}`,
                };
            }
        }
        if (entry.requireArtifactDigest === true) {
            const digest = artifact.digest;
            if (typeof digest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(digest)) {
                return {
                    ok: false,
                    verdict: 'artifact-digest-missing',
                    detail: `artifact ${JSON.stringify(entry.requiredArtifact)} in run ${run.id} carries digest ${JSON.stringify(digest)}; the manifest requires the Actions API's sha256:<64-hex> digest so the evidence binds the bytes, not the name`,
                };
            }
        }
        if (entry.requiredEvidence) {
            if (!artifact.evidence) {
                return {
                    ok: false,
                    verdict: 'missing-evidence',
                    detail: `artifact ${JSON.stringify(entry.requiredArtifact)} in run ${run.id} carries no readable release-evidence document (${artifact.evidenceError ?? 'the content was not fetched'})`,
                };
            }
            evidence = artifact.evidence;
            facts.evidence = evidence;
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
        // THE PINNED BASELINE IS PART OF THE CONTENT. Where the manifest names it, an embedded document that omits it or
        // names another commit is refused with its own verdict, so the baseline rule has teeth instead of prose.
        if (typeof entry.requiredPinnedSha === 'string') {
            const pinnedField = entry.requiredEvidence?.pinnedShaField ?? 'pinnedSha';
            const observed = evidence ? memberAt(evidence, pinnedField) : undefined;
            if (observed === undefined || observed === null) {
                return {
                    ok: false,
                    verdict: 'pinned-sha-missing',
                    detail: `artifact ${JSON.stringify(entry.requiredArtifact)} in run ${run.id} carries no embedded ${pinnedField}; the manifest requires the pinned oracle commit ${entry.requiredPinnedSha}`,
                };
            }
            if (observed !== entry.requiredPinnedSha) {
                return {
                    ok: false,
                    verdict: 'pinned-sha-mismatch',
                    detail: `artifact ${JSON.stringify(entry.requiredArtifact)} in run ${run.id} records pinnedSha ${JSON.stringify(observed)}, not the required pinned oracle commit ${entry.requiredPinnedSha}`,
                };
            }
        }
    }

    const selectionRail = checkSelectionRail(entry, run, sha, evidence);
    if (!selectionRail.ok) {
        return { ok: false, verdict: selectionRail.verdict, detail: selectionRail.detail };
    }
    facts.selection = selectionRail;
    return { ok: true, facts };
}

// A WORKFLOW'S `run-name` CHANGES THE RUN OBJECT'S `name`, AND THAT BROKE NAME MATCHING.
//
// Measured on real run 42439335334 (`Browser differential`, dispatched with `-f mode=assets` after the alpha.18
// run-name change): the runs API reported `name: "Browser differential mode=assets"` and
// `display_title: "Browser differential mode=assets"` -- NOT the workflow's display name -- while `path` remained
// `.github/workflows/browser-differential.yml`. A gate matched by `name` alone therefore found NO run ("no run of this
// workflow exists") even though the dispatch was right there at the right SHA. The run's `path` is the stable identity.
//
// This map (workflow display name -> workflow file path, as the API reports it) is built from the CHECKED-OUT workflow
// files by the callers that have a filesystem; a run belongs to a gate when EITHER its `name` matches the manifest
// workflow OR its `path` matches. The parameter is optional: a caller that passes no map keeps the old name-only
// behaviour, and the synthetic tests exercise both sides.
export function workflowPathMapFromFiles(files) {
    const map = new Map();
    for (const file of files ?? []) {
        const text = String(file?.text ?? '');
        const match = text.match(/^name:\s*(.+?)\s*$/m);
        if (!match) continue;
        const name = match[1].replace(/^['"]|['"]$/g, '');
        const relative = String(file?.path ?? '').replace(/\\/g, '/');
        if (relative === '') continue;
        const path = relative.startsWith('.github/workflows/') ? relative : `.github/workflows/${relative.split('/').pop()}`;
        map.set(name, path);
    }
    return map;
}

// Pick one run per required workflow. Preference is: a completed successful run at the target SHA that SATISFIES its
// evidence rails wins; otherwise the newest run at the target SHA is reported as the blocking observation. Runs at a
// different SHA are counted and reported, never accepted -- that is the whole same-SHA property.
export function evaluateGates({ manifest, runs, sha, workflowPaths = null }) {
    const problems = validateManifest(manifest);
    if (!Array.isArray(runs)) problems.push('runs is not an array');
    if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha)) problems.push(`sha ${JSON.stringify(sha)} is not a 40-hex commit`);

    const rows = [];
    if (problems.length > 0) return { ok: false, sha: sha ?? null, rows, problems };

    // The workflow file path each manifest entry resolves to, when the caller could read the checkout.
    const pathByName = workflowPaths instanceof Map ? workflowPaths : new Map(Object.entries(workflowPaths ?? {}));
    const belongsTo = (run, workflowName) => {
        if (!run || typeof run !== 'object') return false;
        if (run.name === workflowName) return true;
        const expectedPath = pathByName.get(workflowName);
        return expectedPath !== undefined && run.path === expectedPath;
    };

    const newest = (list) => [...list].sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')))[0] ?? null;

    for (const entry of manifest.requiredGates) {
        const candidates = runs.filter((run) => belongsTo(run, entry.workflow));
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
                    const facts = rail.facts ?? {};
                    const tierField = entry.requiredEvidence ? (entry.requiredEvidence.tierField ?? 'tier') : null;
                    const tierValue = tierField !== null && facts.evidence ? memberAt(facts.evidence, tierField) : undefined;
                    rows.push({
                        ...recordOf(run),
                        workflow: entry.workflow, // the MANIFEST name, never a run-name the workflow evaluated
                        verdict: 'success',
                        artifact: entry.requiredArtifact,
                        evidence: entry.requiredEvidence?.kind ?? facts.evidence?.kind ?? null,
                        requiredJobs: entry.requiredJobs,
                        jobDetails: facts.jobDetails ?? [],
                        selection: facts.selection ?? { declared: false },
                        artifactDigest: facts.artifact?.digest ?? null,
                        artifactCreatedAt: facts.artifact?.created_at ?? null,
                        artifactExpiresAt: facts.artifact?.expires_at ?? null,
                        artifactWorkflowRunId: facts.artifact?.workflow_run?.id ?? null,
                        tier: tierValue === undefined ? null : tierValue,
                        evidencePinnedSha: facts.evidence?.pinnedSha ?? facts.evidence?.pinnedCommit ?? null,
                        evidenceHeadSha: facts.evidence?.headSha ?? null,
                        evidenceDocument: facts.evidence ?? null,
                        evidenceFields: facts.evidence ? Object.keys(facts.evidence).sort() : null,
                        detail: `${completedSuccess.length} completed success run(s) at the target SHA with event ${entry.requiredEvent ?? 'any'}${entry.requiredArtifact ? `, carrying artifact ${JSON.stringify(entry.requiredArtifact)}` : ''}${entry.requiredJobs ? `, required job(s) ${entry.requiredJobs.join(', ')} green` : ''}${entry.requiredEvidence ? `, evidence kind ${JSON.stringify(entry.requiredEvidence.kind)} with the candidate head SHA and tier marker` : ''}`,
                    });
                    break;
                }
                blocked = { run, rail };
            }
            if (!blocked) continue;
            rows.push({
                ...recordOf(blocked.run),
                workflow: entry.workflow,
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
            workflow: entry.workflow,
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
    const selection = (entry) => entry?.requiredSelection ?? {};
    return {
        // The artifact LISTS are needed by anything that reads a required artifact, its content, its freshness, its
        // digest, or a selection proof read out of its evidence.
        includeArtifacts: gates.some((entry) => entry.requiredArtifact || entry.requiredJobs || entry.requiredEvidence || entry.requiredArtifactFresh || entry.requireArtifactDigest || entry.requiredPinnedSha || entry.requiredSelection),
        includeJobs: gates.some((entry) => entry.requiredJobs || selection(entry).jobs),
        includeEvidence: gates.some((entry) => entry.requiredEvidence || entry.requiredPinnedSha || selection(entry).evidence),
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
                run.artifacts = (payload.artifacts ?? []).map((artifact) => ({
                    id: artifact.id,
                    name: artifact.name,
                    expired: artifact.expired,
                    sizeInBytes: artifact.size_in_bytes,
                    // THE IDENTITY OF THE BYTES. The freshness/digest rails compare these against the cited run, so the
                    // query must carry them; a field that was never fetched cannot be asserted later.
                    digest: artifact.digest ?? null,
                    createdAt: artifact.created_at ?? null,
                    created_at: artifact.created_at ?? null,
                    expires_at: artifact.expires_at ?? null,
                    updated_at: artifact.updated_at ?? null,
                    workflow_run: artifact.workflow_run ? { id: artifact.workflow_run.id, head_sha: artifact.workflow_run.head_sha } : null,
                }));
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
    const hasSelection = rows.some((row) => row.selection?.declared === true);
    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push('## Qualification evidence (same-SHA required gates)');
    lines.push('');
    lines.push(`Every workflow below has a completed, successful run whose \`head_sha\` is this release tag's target commit \`${sha}\`. The table is generated from the GitHub Actions API by \`scripts/assemble-release-body.mjs\` immediately before publication, so it is a measurement of this tag, not a hand-copied list.`);
    lines.push('');
    lines.push(hasSelection
        ? '| workflow | run id | event | conclusion | required jobs | selection proof | artifact (evidence) |'
        : '| workflow | run id | event | conclusion | required jobs | artifact (evidence) |');
    lines.push(hasSelection ? '|---|---|---|---|---|---|---|' : '|---|---|---|---|---|---|');
    for (const row of rows) {
        const link = repo ? `[${row.runId}](https://github.com/${repo}/actions/runs/${row.runId})` : String(row.runId);
        const jobs = Array.isArray(row.requiredJobs) && row.requiredJobs.length > 0 ? row.requiredJobs.join(', ') : '-';
        const artifact = row.artifact ? `${row.artifact}${row.evidence ? ` (${row.evidence})` : ''}` : '-';
        const selection = row.selection?.declared === true ? (row.selection.provenBy ?? row.selection.verdict ?? 'unverified') : '-';
        lines.push(hasSelection
            ? `| ${row.workflow} | ${link} | ${row.event ?? '-'} | ${row.conclusion ?? '-'} | ${jobs} | ${selection} | ${artifact} |`
            : `| ${row.workflow} | ${link} | ${row.event ?? '-'} | ${row.conclusion ?? '-'} | ${jobs} | ${artifact} |`);
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
