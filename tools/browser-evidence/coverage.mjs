// THE VERIFIER'S OWN COVERAGE ARITHMETIC, extracted so it can be tested without a repository full of
// committed artefacts.
//
// WHY THIS MODULE EXISTS. `tools/verify-browser-comparisons.mjs` checks the artefacts it knows about: the
// catalogued chat-completion artefacts, plus a hand-written list of other surfaces. Nothing checked the
// OTHER direction -- that every committed `*-comparison.json` is one of those two things. A committed
// artefact that nobody claims is a claim nobody re-reads, and the verifier would print `ok` for a tree in
// which it had checked zero artefacts, because a loop over an empty set is not a failure.
//
// These functions are pure: the verifier passes the on-disk file names and the claims it can see, and gets
// back named problems. That shape is what makes the guards testable by mutation (a synthetic file list and
// a synthetic claim set) instead of by editing committed evidence.
//
// The PINNED baseline check is here for the same reason. Several artefacts record WHICH pinned tree they
// were measured against (`pinnedBaseline`, `pinnedSource.baselineCommit`, a provenance `gitRevision`), and
// the verifier used to read none of them: a re-record against another pinned checkout would pass every
// content check while describing a different oracle. A declaration that is present must match; an artefact
// that declares nothing is reported as an observation (the gap is stated, not silently passed), because
// inventing a declaration is a re-record decision, not a gate decision.

/** The one pinned baseline this tree's evidence may describe (AGENTS.md hard rule 1). */
export const PINNED_BASELINE_COMMIT = '06bde939fb1e9c4c8d8641d810f0a916b5bce127';

/** Minimum committed comparison artefacts. A floor, not a count: it fails a tree whose evidence vanished. */
export const MINIMUM_COMMITTED_ARTEFACTS = 25;

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Every place an artefact may name the pinned tree, with the path a finding can quote. */
function baselineDeclarations(artifact) {
    const declarations = [];
    const add = (path, value, kind) => {
        if (value === undefined || value === null) return;
        declarations.push({ path, value: String(value), kind });
    };
    add('pinnedBaseline', artifact?.pinnedBaseline, 'commit');
    add('pinnedSource.baselineCommit', artifact?.pinnedSource?.baselineCommit, 'commit');
    add('pinnedCommit', artifact?.pinnedCommit, 'commit');
    add('provenance.pinned.commit', artifact?.provenance?.pinned?.commit, 'commit');
    add('provenance.pinned.pinnedCommit', artifact?.provenance?.pinned?.pinnedCommit, 'commit');
    add('provenance.pinned.frontendVersion.gitRevision', artifact?.provenance?.pinned?.frontendVersion?.gitRevision, 'revision');
    add('provenance.gotavern.frontendVersion.gitRevision', artifact?.provenance?.gotavern?.frontendVersion?.gitRevision, 'revision');
    return declarations;
}

/**
 * Named problems for an artefact whose declared pinned baseline does not match the pinned checkout.
 * `kind: 'revision'` values are the checkout's short `git rev-parse --short` form (9 chars today), so a
 * revision matches when the full commit starts with it; a commit value must contain the full commit.
 */
export function pinnedBaselineProblems(artifact, expected = PINNED_BASELINE_COMMIT) {
    const problems = [];
    const declarations = baselineDeclarations(artifact);
    for (const declaration of declarations) {
        const matches = declaration.kind === 'revision'
            ? /^[0-9a-f]{7,40}$/.test(declaration.value) && expected.startsWith(declaration.value)
            : declaration.value.includes(expected);
        if (!matches) {
            problems.push(`${declaration.path} is ${JSON.stringify(declaration.value)}, which does not name the pinned baseline ${expected}: an artefact measured against a different oracle cannot support a claim about this one`);
        }
    }
    return { declared: declarations.length > 0, problems };
}

/**
 * The converse coverage rule: every committed comparison artefact must be claimed by exactly one checker.
 *
 * `catalogueClaims` are artefacts a catalogued source's evidence names (the verifier's section 1).
 * `handledFiles` are the fixed surfaces the verifier reads (sections 2 and 2b).
 * `externalClaims` are artefacts another workflow re-runs and judges; each declares the workflow file and
 * the step that does it, so deleting that step is a finding here rather than a silent loss of the gate.
 */
export function claimProblems({ files, catalogueClaims = [], handledFiles = [], externalClaims = new Map() }) {
    const problems = [];
    const committed = new Set(files);
    const claimedBy = new Map();
    const claim = (file, by) => {
        if (!claimedBy.has(file)) claimedBy.set(file, []);
        claimedBy.get(file).push(by);
    };
    for (const file of catalogueClaims) claim(file, 'the source catalogue');
    for (const file of handledFiles) claim(file, 'a verifier surface check');
    for (const file of externalClaims.keys()) claim(file, `the external gate in ${externalClaims.get(file).workflow}`);
    for (const file of committed) {
        const owners = claimedBy.get(file) ?? [];
        if (owners.length === 0) {
            problems.push(`${file} is committed but NO checker claims it: add it to the verifier, the source catalogue, or EXTERNAL_CLAIM_GATES with the workflow step that re-judges it`);
        } else if (owners.length > 1) {
            problems.push(`${file} is claimed by ${owners.join(' and ')}; exactly one checker must own a committed artefact, or a change to one claim silently stops covering it`);
        }
    }
    for (const [file, claimEntry] of externalClaims) {
        if (!committed.has(file)) {
            problems.push(`EXTERNAL_CLAIM_GATES names ${file}, which is not committed; the declaration has gone stale (a gate for a file nobody has)`);
        }
        if (typeof claimEntry.reason !== 'string' || claimEntry.reason.trim() === '') {
            problems.push(`EXTERNAL_CLAIM_GATES names ${file} with no reason; a claim without a reason cannot be reviewed`);
        }
        if (typeof claimEntry.step !== 'string' || claimEntry.step.trim() === '') {
            problems.push(`EXTERNAL_CLAIM_GATES names ${file} with no workflow step; the gate could be deleted without this check noticing`);
        }
    }
    return problems;
}

/**
 * A decided exclusion must be PINNED, not implied by a flag. `driveSupported: false` removes a catalogued
 * source from every drive and (in the verifier) from the catalogue checks; today it is one source
 * (workers_ai) with a stated reason, but nothing stops a second source from acquiring the flag and quietly
 * leaving the sweep. The allowlist is the reviewed set; a source that is exempt must be listed with a
 * reason, a listed source must still be exempt, and the reason must survive.
 */
export function exemptionProblems(sources, allowlist) {
    const problems = [];
    const exempt = new Map();
    for (const source of sources ?? []) {
        if (source.driveSupported !== false) continue;
        exempt.set(source.id, source.unproven);
        const declared = allowlist.get(source.id);
        if (!declared) {
            problems.push(`${source.id} is catalogued with driveSupported:false but is NOT in the reviewed exemption allowlist: an exemption added without review silently removes a source from every drive`);
        } else if (typeof source.unproven !== 'string' || !source.unproven.includes(declared)) {
            problems.push(`${source.id} is exempt for a reason that does not carry the reviewed text (${JSON.stringify(declared)}): the exemption's justification moved without review`);
        }
    }
    for (const [id, reason] of allowlist) {
        if (!exempt.has(id)) problems.push(`the exemption allowlist names ${id}, which is not exempt any more; the allowlist has gone stale (delete it in the same change that re-enables the source)`);
        if (typeof reason !== 'string' || reason.trim().length < 20) problems.push(`the exemption allowlist names ${id} with no reviewable reason`);
    }
    return problems;
}

/**
 * The gate's own arithmetic must fail closed: a catalogue with no sources, a run that checked zero
 * catalogued artefacts, or an evidence set that shrank below its floor are all "the gate did not run",
 * which must never print as a coherent tree.
 */
export function evidenceFloorProblems({ files, catalogueSize, checked, minimum = MINIMUM_COMMITTED_ARTEFACTS }) {
    const problems = [];
    if (!Array.isArray(files) || files.length === 0) {
        problems.push('no committed comparison artefacts were found at all, so this gate would pass over an empty evidence directory');
    } else if (files.length < minimum) {
        problems.push(`only ${files.length} committed comparison artefact(s) exist, below the floor of ${minimum}: the evidence set shrank, so the gate is reading a tree it was not written for`);
    }
    if (!(catalogueSize > 0)) {
        problems.push('the source catalogue is empty, so no chat-completion artefact can be checked; an empty catalogue must fail this gate rather than pass it vacuously');
    }
    if (!(checked > 0)) {
        problems.push('this gate checked ZERO catalogued source artefacts: the catalogue and the evidence files no longer intersect, so every chat-completion claim is unverified');
    }
    return problems;
}

/**
 * The external declaration is only a claim if the workflow it names still exists and still runs a step
 * with the declared name that mentions the artefact. `readWorkflow` is injected so this is testable.
 */
export function externalClaimProblems(externalClaims, readWorkflow) {
    const problems = [];
    for (const [file, claim] of externalClaims) {
        let text;
        try {
            text = readWorkflow(claim.workflow);
        } catch (error) {
            problems.push(`EXTERNAL_CLAIM_GATES names ${claim.workflow} for ${file}, but that workflow cannot be read (${String(error?.message ?? error)})`);
            continue;
        }
        if (!text.includes(file)) {
            problems.push(`${claim.workflow} no longer mentions ${file}, so the external gate EXTERNAL_CLAIM_GATES names for it does not judge it`);
        }
        if (!text.includes(claim.step)) {
            problems.push(`${claim.workflow} has no step named ${JSON.stringify(claim.step)}, which EXTERNAL_CLAIM_GATES says re-judges ${file}`);
        }
        if (claim.command && !text.includes(claim.command)) {
            problems.push(`${claim.workflow} no longer runs ${JSON.stringify(claim.command)}, the command EXTERNAL_CLAIM_GATES says judges ${file}`);
        }
    }
    return problems;
}

/**
 * The two-way guard-set rule: an artefact's `guards` keys must be exactly the REQUIRED set plus an
 * allowlist of named optional guards (and, for surfaces with a declared-gap mechanism, the guards the
 * artefact excuses). A guard that appears in the artefact but in none of those is a claim no checker reads;
 * a required guard that disappeared is a silently reduced surface; an allowlisted guard that disappeared
 * means the pin no longer describes the artefact.
 */
export function guardSetProblems({ guards, required, optional = new Map(), excused = [] }) {
    const problems = [];
    const present = new Set(Object.keys(guards ?? {}));
    const excusedSet = new Set(excused);
    for (const name of required) {
        if (!present.has(name)) problems.push(`guards.${name} is missing from the artefact, so the required check disappeared (the artefact no longer claims what the gate requires)`);
    }
    for (const name of present) {
        if (required.includes(name) || optional.has(name) || excusedSet.has(name)) continue;
        problems.push(`guards.${name} is recorded but NO checker reads it: add it to the required set, to the named optional allowlist with a reason, or to the artefact's declared gaps`);
    }
    for (const name of optional.keys()) {
        if (!present.has(name)) problems.push(`guards.${name} is pinned in the optional allowlist but is absent from the artefact; the allowlist no longer describes the recording`);
    }
    for (const name of excusedSet) {
        if (!present.has(name)) problems.push(`guards.${name} is named as an excused gap but is absent from the artefact; the excusal no longer describes the recording`);
    }
    return problems;
}
