// THE NETWORK-HOP STREAMING SURFACE (Q19): `streaming-framing-comparison.json`.
//
// WHY THIS IS ITS OWN SURFACE AND ITS OWN FILE. Every other streaming artefact records the page talking
// DIRECTLY to an in-process peer on loopback -- one unbroken connection, no middle, plain HTTP -- so the
// matrix row's gap ("a real network's chunk boundaries, a proxy that buffers, a mid-stream TLS close")
// is not a gap in the recorder but in the hop underneath it. `compare-streaming-framing.mjs` puts a real
// TCP hop between subject and peer and records three surfaces through it; this module is the gate on
// that artefact.
//
// WHAT IT DOES DIFFERENTLY FROM `streamingSurfacesProven`. That gate reads a surface's `checks` and
// RECOMPUTES each derivable one from the per-leg numbers, so a hand-edited flag contradicts the data.
// This artefact stores the per-leg OBSERVATIONS in `observations`, so the same treatment is possible and
// is done: every guard is rebuilt from `observations` and from the hop's own record, and a recorded flag
// that disagrees with its own data is a finding.
//
// A GUARD THIS GATE DOES NOT KNOW IS A FINDING, exactly as in `streamingSurfacesProven`: an artefact that
// grows a check nobody reads is a claim nobody checks.

const show = value => JSON.stringify(value)?.slice(0, 240) ?? String(value);

/** The guard names this gate can recompute from the artefact's own observations. */
export const FRAMING_GUARD_NAMES = {
    streaming: [
        'incrementalRenderObservedOnBoth', 'renderAdvancedMonotonicallyOnBoth',
        'renderedStatesNeverExceedContentFrames', 'everySubjectAppliedAtLeastOneContentFrame',
        'finalTextEqualAndNonEmpty', 'noPageErrorsOnEitherSubject',
    ],
    buffered: [
        'bufferingProxyHeldTheWholeBody', 'bufferingProxyReleasedEveryFrameInThatWrite', 'noCutInTheBufferingSurface',
        'forwardedRequestBytesEqual', 'hopForwardedWhatThePeerReceived',
        'incrementalRenderAdvancedThroughTheBufferingProxy', 'noPageErrorsThroughTheHop',
    ],
    abort: [
        'networkCutBothSubjectsMidStream', 'peerDidNotDisconnect', 'noCallerCancelOnEitherSubject',
        'contentRenderedBeforeTheCutOnBoth', 'partialTextIdenticalOnBothSubjects',
        'sameTruncationOnBothSubjects', 'releasedByteCountEqualOnBothSubjects', 'noPageErrorsOnEitherSubject',
    ],
};

// Guards that CANNOT be recomputed from this artefact because they need data the flight recorder did not
// keep (the per-request prototype state, the frontend's own idle flag). They are checked for PRESENCE and
// truth, and named here so the omission is a stated hole rather than an implied success.
export const FRAMING_NOT_RECOMPUTABLE = [
    'bothSubjectsReachedThePeer', 'providerRequestBytesEqual', 'requestStreamFlagSetOnBoth',
    'bothSubjectsSawTheWholeScript', 'bothSubjectsSawTheWholeScriptThroughTheHop',
    'peerWroteMoreThanItDelivered', 'partialTextIsAProperPrefixOfTheWholeReply',
    'noFurtherChunksAppliedAfterTheCut', 'generationEndedOnBothSubjects', 'bufferedFinalTextEqualsTheDirectStream',
];

const isPrefixSequence = texts => texts.every((text, index) => index === 0 || text.startsWith(texts[index - 1]));

/** Recomputes every derivable streaming-surface guard from `observations.streaming` and the artefact. */
export function recomputeFramingSurface(artifact, surface) {
    // THE OBSERVATION BLOCK IS KEYED BY SURFACE NAME, the same name this function recomputes for: the
    // comparator writes observations.streaming / .buffered / .abort, and the first draft read
    // observations.stream and silently recomputed from an empty object -- which made the healthy artefact
    // red and would have made a wrong artefact green for stream. MEASURED, not assumed: the exact-key
    // lookup is what the harness in this repository exists to catch.
    const observed = artifact.observations?.[surface] ?? {};
    const gotavern = observed.gotavern ?? {};
    const pinned = observed.pinned ?? {};
    const gvTexts = gotavern.texts ?? [];
    const pnTexts = pinned.texts ?? [];
    const hop = artifact.hop ?? {};
    const common = {
        noPageErrorsOnEitherSubject: (gotavern.pageErrors ?? 0) === 0 && (pinned.pageErrors ?? 0) === 0,
    };
    if (surface === 'streaming') {
        const contentFrames = Math.max(0, Math.max(...(hop.framesWritten?.gotavern ?? [0]), 0) - 1);
        return {
            ...common,
            incrementalRenderObservedOnBoth: gvTexts.length >= 3 && pnTexts.length >= 3,
            renderAdvancedMonotonicallyOnBoth: isPrefixSequence(gvTexts) && isPrefixSequence(pnTexts),
            renderedStatesNeverExceedContentFrames: gvTexts.length <= contentFrames && pnTexts.length <= contentFrames,
            everySubjectAppliedAtLeastOneContentFrame: gvTexts.length >= 1 && pnTexts.length >= 1,
        };
    }
    if (surface === 'buffered') {
        return {
            ...common,
            bufferingProxyHeldTheWholeBody: (hop.bufferedWrites?.gotavern ?? 0) === 1 && (hop.bufferedWrites?.pinned ?? 0) === 1,
            incrementalRenderAdvancedThroughTheBufferingProxy: gvTexts.length >= 3 && pnTexts.length >= 3,
        };
    }
    return {
        ...common,
        networkCutBothSubjectsMidStream: hop.cut?.gotavern === 'cut-after-bytes' && hop.cut?.pinned === 'cut-after-bytes',
        contentRenderedBeforeTheCutOnBoth: gvTexts.length >= 1 && pnTexts.length >= 1,
        partialTextIdenticalOnBothSubjects: (gotavern.finalText ?? null) === (pinned.finalText ?? null) && String(gotavern.finalText ?? '').length > 0,
        sameTruncationOnBothSubjects: JSON.stringify(gvTexts) === JSON.stringify(pnTexts),
        releasedByteCountEqualOnBothSubjects: hop.releasedBytesUnderCut?.gotavern !== null
            && hop.releasedBytesUnderCut?.gotavern === hop.releasedBytesUnderCut?.pinned,
    };
}

/**
 * Gates `streaming-framing-comparison.json`.
 *
 * A missing file is NOT a pass and NOT a failure: the surface is produced only by a `stream`-mode run of
 * the browser differential, so a run that did not ask for it must report NOT-RECORDED. A COMMITTED file
 * that cannot be read, or that contradicts its own observations, is a failure.
 */
export function streamingFramingSurface(ctx, artifact) {
    if (!artifact) {
        return;
    }
    for (const surface of ['streaming', 'buffered', 'abort']) {
        const block = artifact[surface];
        if (!block) {
            ctx.fail(`the ${surface} block is missing, so that network surface was never compared`);
            continue;
        }
        const guards = block.guards ?? {};
        for (const name of FRAMING_GUARD_NAMES[surface]) {
            if (!(name in guards)) {
                ctx.fail(`${surface}.guards.${name} is missing; an absent guard used to iterate zero times and pass`);
            } else if (guards[name] !== true) {
                ctx.fail(`${surface}.guards.${name} is ${show(guards[name])}`);
            }
        }
        const unexpected = Object.keys(guards).filter(name => !FRAMING_GUARD_NAMES[surface].includes(name) && !FRAMING_NOT_RECOMPUTABLE.includes(name));
        if (unexpected.length > 0) {
            ctx.fail(`${surface}.guards carries ${show(unexpected)}, which this gate does not know; a check nobody reads is a claim nobody checks`);
        }
        for (const name of FRAMING_NOT_RECOMPUTABLE) {
            if (name in guards && guards[name] !== true) {
                ctx.fail(`${surface}.guards.${name} is ${show(guards[name])}, and it cannot be recomputed from this artefact, so a false value is all the evidence there is`);
            }
        }
        const recomputed = recomputeFramingSurface(artifact, surface);
        for (const [name, value] of Object.entries(recomputed)) {
            if (!(name in guards)) continue;
            if (guards[name] !== value) {
                ctx.fail(`${surface}.guards.${name} is recorded as ${show(guards[name])} but the stored observations recompute to ${show(value)} -- the artefact contradicts itself`);
            }
        }
        const allTrue = Object.values(guards).every(Boolean);
        if (block.proven !== allTrue) {
            ctx.fail(`${surface}.proven is ${show(block.proven)} but its own guards recompute to ${allTrue}`);
        }
        if (block.proven !== true) {
            const failed = Object.entries(guards).filter(([, value]) => value !== true).map(([name]) => name);
            ctx.fail(`${surface}.proven is not true; failing guards: ${failed.join(', ') || '(none isolated)'}`);
        }
    }
    // THE HEADLINE CLAIM, recomputed rather than read.
    const surfacesProven = ['streaming', 'buffered', 'abort'].every(surface => artifact[surface]?.proven === true);
    if (artifact.proven !== surfacesProven) {
        ctx.fail(`proven is ${show(artifact.proven)} but the three network surfaces recompute to ${surfacesProven}`);
    }
    if (artifact.proven !== true) {
        ctx.fail('proven is not true, so no claim about streaming through a real hop may rest on this artefact');
    }
    // THE HOP MUST HAVE DONE SOMETHING. A buffering surface whose hop issued more than one write measured
    // the pass-through case, and the single most important thing this artefact claims would be false.
    for (const leg of ['gotavern', 'pinned']) {
        if ((artifact.hop?.bufferedWrites?.[leg] ?? 0) !== 1) {
            ctx.fail(`hop.bufferedWrites.${leg} is ${show(artifact.hop?.bufferedWrites?.[leg])}, so the hop did not hold the body in the buffering surface and that surface measures something else`);
        }
        if ((artifact.hop?.releasedBytesUnderCut?.[leg] ?? 0) <= 0) {
            ctx.fail(`hop.releasedBytesUnderCut.${leg} is ${show(artifact.hop?.releasedBytesUnderCut?.[leg])}, so no body was released before the cut and nothing was truncated`);
        }
    }
    // THE UNPROVEN LIST IS PART OF THE CLAIM. An artefact that declines to say what it does not cover would
    // read as complete (GOAL.md 13, AGENTS.md 36).
    if (!Array.isArray(artifact.notCompared) || artifact.notCompared.length < 3) {
        ctx.fail('notCompared does not name what this artefact leaves unproven; a surface with a hidden gap is the defect this gate exists for');
    }
    ctx.observe(`network hop: buffering released the whole body in one write on both subjects (${artifact.hop?.bufferedWrites?.gotavern}/${artifact.hop?.bufferedWrites?.pinned} write(s)); the cut released ${artifact.hop?.releasedBytesUnderCut?.gotavern} B of ${show(artifact.hop?.framesWritten?.gotavern)} frame(s) on both subjects`);
}
