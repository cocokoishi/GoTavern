// CHECKS DERIVED FROM THE CATALOGUE ITSELF.
//
// The old verifier restated each source's facts in its own block: siliconflow's control id, workers_ai's
// account-id keys, groq's expected seam name, openai's `proxySettingDeliberatelyUnset` sentence. Every
// one of those is a fact the catalogue already holds, so the gate now READS the catalogue and fails when
// the artefact disagrees with it. Three consequences worth naming:
//
//   * adding a source needs no edit here (the required drive-parameter keys come from the source's own
//     `driveParameters` function, so they cannot drift from the recorder that writes them);
//   * a cross-source mistake -- a nanogpt artefact naming the groq seam -- fails without anyone having
//     to remember to write that assertion for nanogpt;
//   * a check for a source with no artefact cannot exist, and a source with an artefact cannot lack a
//     check. That symmetry is what the coverage test relies on.

import { ALL_SEAM_ENVS, PINNED_ROUTE } from '../../tests/browser/sources.mjs';

/**
 * The drive-parameter keys this source's recorder emits, and which of them are derived from the LEG
 * (so a null in the artefact means the drive never recorded the thing it drove).
 */
export function requiredDriveParameters(source) {
    const template = source.driveParameters ? source.driveParameters(undefined) : {};
    const all = Object.keys(template);
    return { all, legDerived: all.filter(key => template[key] === null) };
}

/**
 * WHICH DRIVE FACTS ARE EVIDENCE AND WHICH ARE DOCUMENTATION.
 *
 * A gate that fails on a missing sentence teaches people to add sentences. The facts below are the ones
 * a reader NEEDS in order to check the row's claim -- which seam aimed the Go leg, which body-derived
 * value the drive selected, whether the credential travelled -- and they are required. The rest of a
 * source's `driveParameters` prose (`peerRoute`, `seamUsage`, `peerKeying`, `pinnedRedirectRequired`, â€¦)
 * is documentation: its absence is reported as STALENESS ("this artefact predates the current recorder;
 * re-record it"), never as a failure, because documentation that lags the recorder does not make the
 * measured numbers wrong.
 */
export const EVIDENCE_KEYS = new Set(['seamEnvVar', 'endpointMode', 'endpointControl', 'accountIdMode', 'accountIdControl', 'accountIdValue']);

/** Invariant: the artefact says how the drive was aimed, in the terms the catalogue uses. */
export function driveParametersMatchCatalog(ctx, source, artifact) {
    if (!source.driveParameters) {
        return; // custom: the artifact carries no driveParameters block by design.
    }
    const parameters = artifact.driveParameters;
    if (!parameters || typeof parameters !== 'object') {
        // No block at all: the seam claim and the driven value are both unrecorded, so this fails when
        // the row makes either claim, and is only a staleness note for a row that makes neither.
        const needsEvidence = source.probe.seams.length > 0 || requiredDriveParameters(source).legDerived.length > 0;
        if (needsEvidence) {
            ctx.fail(`has no driveParameters block, but ${source.id}'s row claims mechanics a reader cannot reconstruct without it (the seam that aimed the leg or the body value the drive selected)`);
        }
        return;
    }
    const { all, legDerived } = requiredDriveParameters(source);
    const missingDocumentation = [];
    for (const key of all) {
        if (!(key in parameters)) {
            const isEvidence = EVIDENCE_KEYS.has(key) || legDerived.includes(key);
            if (isEvidence) ctx.fail(`driveParameters.${key} is missing; ${source.id}'s catalogue row says the drive records it, and the claim cannot be checked without it`);
            else missingDocumentation.push(key);
            continue;
        }
        if (legDerived.includes(key) && (parameters[key] === null || parameters[key] === undefined)) {
            ctx.fail(`driveParameters.${key} is ${JSON.stringify(parameters[key])}, so the artefact does not say which value the drive selected`);
        }
    }
    if (missingDocumentation.length > 0) {
        ctx.noteStale(`does not carry the documentation fields ${missingDocumentation.join(', ')} that the current recorder emits; this artefact predates it and should be re-recorded`);
    }
    // THE SEAM THE ROW CLAIMS MUST BE THE SEAM THE CATALOGUE NAMES. A source that has a seam and does not
    // record it leaves a reader unable to check the network-isolation claim; a source that names another
    // source's seam describes a drive that did not happen.
    if (source.probe.seams.length > 0) {
        const expected = source.probe.seams[0].env;
        if (!parameters.seamEnvVar) {
            ctx.fail(`driveParameters.seamEnvVar is absent, but ${source.id} is aimed by ${expected} and the row's own prose refers to it`);
        } else if (parameters.seamEnvVar !== expected) {
            ctx.fail(`driveParameters.seamEnvVar is ${JSON.stringify(parameters.seamEnvVar)}, but ${source.id} is aimed by ${expected}`);
        }
    }
    const seam = parameters.seamEnvVar;
    if (seam !== undefined && seam !== null && !ALL_SEAM_ENVS.includes(seam)) {
        ctx.fail(`driveParameters.seamEnvVar names ${JSON.stringify(seam)}, which is not a seam any catalogued source declares`);
    }
}

/**
 * Invariant: whether the CREDENTIAL travelled is recorded with the value the row claims.
 *
 * Required where the row makes a claim about the route: every source that is proxy-capable (the
 * credential SHOULD travel) and every source aimed by a pinned literal (the row's evidence is that it
 * could not). CUSTOM is excluded: its row is about custom_url, not about proxies.
 */
export function proxyCredentialRow(ctx, source, artifact, surface) {
    const relevant = source.proxy !== 'unsupported' || source.pinnedRoute === PINNED_ROUTE.DIRECT_LITERAL;
    if (!relevant) {
        return;
    }
    const expected = source.proxy === 'capable-through-setting';
    const record = surface === 'generation' ? artifact.proxyPasswordPresent : artifact.proxyPasswordPresent;
    if (!record || typeof record !== 'object') {
        ctx.fail(`does not record proxyPasswordPresent, but ${source.id}'s row claims the credential ${expected ? 'travelled as proxy_password' : 'could not travel'} -- an unrecorded claim is an unchecked one`);
        return;
    }
    for (const leg of ['gotavern', 'pinned']) {
        if (record[leg] !== expected) {
            ctx.fail(`proxyPasswordPresent.${leg} is ${JSON.stringify(record[leg])}, but ${source.id} is ${source.proxy === 'capable-through-setting' ? 'driven through the reverse_proxy setting, so the credential must travel' : 'aimed by seam and redirect, so no proxy credential may travel'}`);
        }
    }
}

/**
 * Invariant: the artefact names the source it is FOR.
 *
 * The comparators take PROBE_SOURCE from the environment, and the only thing tying an artefact to a
 * source today is its filename. A run that compared openrouter legs and wrote them into the groq file
 * would pass every other check, because both rows have the same shape.
 */
export function artifactNamesItsSource(ctx, source, artifact, surface) {
    const parameters = artifact.driveParameters ?? {};
    const named = parameters.seamEnvVar;
    if (named && source.probe.seams.length > 0 && named !== source.probe.seams[0].env) {
        // reported by driveParametersMatchCatalog with the same detail; kept out here to avoid a duplicate.
        return;
    }
    ctx.observe(`catalogued as ${source.id} (${source.pinnedRoute}${source.probe.seams.length > 0 ? `, seam ${source.probe.seams[0].env}` : ''})`);
}
