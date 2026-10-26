// THE NETWORK-HOP STREAMING SURFACE (Q19): `streaming-framing-comparison.json`.
//
// WHY THIS IS ITS OWN SURFACE AND ITS OWN FILE. Every other streaming artefact records the page talking
// DIRECTLY to an in-process peer on loopback -- one unbroken connection, no middle, plain HTTP -- so the
// matrix row's gap was never a gap in the recorder but in the hop underneath it.
// `compare-streaming-framing.mjs` puts a real TCP hop between subject and peer and records three surfaces
// through it (direct, relayed, cut); this module is the gate on that artefact.
//
// WHAT IT DOES DIFFERENTLY FROM `streamingSurfacesProven`. That gate reads a surface's `checks` and
// RECOMPUTES each derivable one from the per-leg numbers, so a hand-edited flag contradicts the data. This
// artefact stores the per-leg OBSERVATIONS in `observations`, so the same treatment is possible and is
// done: every derivable guard is rebuilt from `observations` and from the hop's own record. The key is the
// SURFACE NAME (`observations.stream` / `.relayed` / `.abort`), which the first draft got wrong by reading
// `observations.streaming` -- it recomputed every streaming guard from an empty object, which made the
// healthy artefact RED and a wrong artefact GREEN. tests/browser/streaming-framing-verifier-selftest.mjs is
// what catches that shape.
//
// A GUARD THIS GATE DOES NOT KNOW IS A FINDING, exactly as in `streamingSurfacesProven`: an artefact that
// grows a check nobody reads is a claim nobody checks.

const show = value => JSON.stringify(value)?.slice(0, 240) ?? String(value);

/** The guards this gate can recompute from the artefact's own observations and hop record. */
export const FRAMING_GUARD_NAMES = {
    stream: [
        'incrementalRenderObservedOnBoth', 'renderAdvancedMonotonicallyOnBoth',
        'renderedStatesNeverExceedContentFrames', 'everySubjectAppliedAtLeastOneContentFrame',
        'finalTextEqualAndNonEmpty', 'noHopOnTheDirectSurface', 'noPageErrorsOnEitherSubject',
    ],
    relayed: [
        'hopPresentOnBothSubjects', 'hopRelayedInMoreThanOneWrite', 'hopRelayedEveryFrame',
        'noCutInTheRelayedSurface', 'relayedDeliveredContentToThePage', 'noPageErrorsThroughTheHop',
    ],
    abort: [
        'hopCutBothSubjectsMidStream', 'hopRelayedTheReachabilityCheckWhole', 'hopReleasedNoBodyAtTheHead',
        'noCallerCancelOnEitherSubject', 'peerWroteMoreThanTheHopReleased', 'contentRenderedBeforeTheCutOnBoth',
        'partialTextIdenticalOnBothSubjects', 'sameTruncationOnBothSubjects', 'sameReleasedByteCountOnBothSubjects',
        'noPageErrorsOnEitherSubject',
    ],
};

// Guards that CANNOT be recomputed from this artefact because they need per-request data it does not keep
// (the request bodies, the peer's disconnect flags, the page's own post-cut timing). They are checked for
// PRESENCE and truth, and named here so the omission is a stated hole rather than an implied success.
export const FRAMING_NOT_RECOMPUTABLE = [
    'bothSubjectsReachedThePeer', 'providerRequestBytesEqual', 'requestStreamFlagSetOnBoth',
    'bothSubjectsSawTheWholeScript', 'bothSubjectsSawTheWholeScriptThroughTheHop',
    'hopForwardedIdenticalRequestBytes', 'hopForwardedWhatThePeerReceived', 'relayedFinalTextEqualsTheDirectStream',
    'peerDidNotDisconnect', 'partialTextIsAProperPrefixOfTheWholeReply', 'noFurtherChunksAppliedAfterTheCut',
    'pageReturnedToIdleOnBothSubjects',
];

const isPrefixSequence = texts => texts.every((text, index) => index === 0 || text.startsWith(texts[index - 1]));

/** Recomputes every derivable guard for one surface from `observations[surface]` and the hop record. */
export function recomputeFramingSurface(artifact, surface) {
    const observed = artifact.observations?.[surface] ?? {};
    const gotavern = observed.gotavern ?? {};
    const pinned = observed.pinned ?? {};
    const gvTexts = gotavern.texts ?? [];
    const pnTexts = pinned.texts ?? [];
    const hop = artifact.hop ?? {};
    const common = {
        noPageErrorsOnEitherSubject: (gotavern.pageErrors ?? 0) === 0 && (pinned.pageErrors ?? 0) === 0,
        noPageErrorsThroughTheHop: (gotavern.pageErrors ?? 0) === 0 && (pinned.pageErrors ?? 0) === 0,
    };
    if (surface === 'stream') {
        // `streamFramesWritten` is the peer's count for the DIRECT run, which is the run this surface's
        // render states belong to (the cut run's count is `framesWritten`).
        const contentFrames = Math.max(0, Math.max(...(hop.streamFramesWritten?.gotavern ?? [0]), 0) - 1);
        return {
            ...common,
            incrementalRenderObservedOnBoth: gvTexts.length >= 3 && pnTexts.length >= 3,
            renderAdvancedMonotonicallyOnBoth: isPrefixSequence(gvTexts) && isPrefixSequence(pnTexts),
            renderedStatesNeverExceedContentFrames: gvTexts.length <= contentFrames && pnTexts.length <= contentFrames,
            everySubjectAppliedAtLeastOneContentFrame: gvTexts.length >= 1 && pnTexts.length >= 1,
            finalTextEqualAndNonEmpty: (gotavern.finalText ?? null) === (pinned.finalText ?? null) && String(gotavern.finalText ?? '').length > 0,
            noHopOnTheDirectSurface: hop.mode?.direct === undefined || hop.mode?.direct === null,
        };
    }
    if (surface === 'relayed') {
        return {
            ...common,
            hopPresentOnBothSubjects: hop.mode?.relayed === 'pass-through',
            hopRelayedInMoreThanOneWrite: (hop.relayedWrites?.gotavern ?? 0) > 1 && (hop.relayedWrites?.pinned ?? 0) > 1,
            hopRelayedEveryFrame: (hop.relayedFrames?.gotavern ?? 0) >= (hop.relayedFrames?.expected ?? Infinity)
                && (hop.relayedFrames?.pinned ?? 0) >= (hop.relayedFrames?.expected ?? Infinity),
            noCutInTheRelayedSurface: hop.relayedCut?.gotavern === null && hop.relayedCut?.pinned === null,
            relayedDeliveredContentToThePage: gvTexts.length >= 1 && pnTexts.length >= 1,
        };
    }
    return {
        ...common,
        hopCutBothSubjectsMidStream: hop.mode?.abort === 'cut-at-head' && hop.anyCut?.gotavern === 'cut-at-head' && hop.anyCut?.pinned === 'cut-at-head',
        hopRelayedTheReachabilityCheckWhole: (hop.cutArmedResponses?.gotavern ?? 0) >= 1 && (hop.cutArmedResponses?.pinned ?? 0) >= 1
            && (hop.relayedWholeResponses?.gotavern ?? 0) >= 1 && (hop.relayedWholeResponses?.pinned ?? 0) >= 1,
        hopReleasedNoBodyAtTheHead: hop.releasedBytesUnderCut?.gotavern === 0 && hop.releasedBytesUnderCut?.pinned === 0,
        noCallerCancelOnEitherSubject: gotavern.stopClickedAt === null && pinned.stopClickedAt === null,
        peerWroteMoreThanTheHopReleased: (hop.framesWritten?.gotavern ?? []).every(frames => frames > 0)
            && (hop.framesWritten?.pinned ?? []).every(frames => frames > 0)
            && hop.releasedBytesUnderCut?.gotavern === 0 && hop.releasedBytesUnderCut?.pinned === 0,
        contentRenderedBeforeTheCutOnBoth: gvTexts.length >= 1 && pnTexts.length >= 1,
        partialTextIdenticalOnBothSubjects: (gotavern.finalText ?? null) === (pinned.finalText ?? null) && String(gotavern.finalText ?? '').length > 0,
        sameTruncationOnBothSubjects: JSON.stringify(gvTexts) === JSON.stringify(pnTexts) && gvTexts.length >= 1,
        // A HEAD CUT RELEASES NOTHING ON EITHER SUBJECT, so equality here means "both zero": requiring a
        // positive count would contradict the surface this guard belongs to.
        sameReleasedByteCountOnBothSubjects: hop.releasedBytesUnderCut?.gotavern === hop.releasedBytesUnderCut?.pinned
            && hop.releasedBytesUnderCut?.gotavern === 0,
    };
}

/**
 * Gates `streaming-framing-comparison.json`.
 *
 * A missing file is NOT a pass and NOT a failure: the surface is produced only by a `stream`-mode run of
 * the browser differential, so a run that did not ask for it reports NOT-RECORDED (the driver does that). A
 * COMMITTED file that cannot be read, or that contradicts its own observations, is a failure.
 */
export function streamingFramingSurface(ctx, artifact) {
    if (!artifact) {
        return;
    }
    for (const surface of ['stream', 'relayed', 'abort']) {
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
        const known = FRAMING_GUARD_NAMES[surface].concat(FRAMING_NOT_RECOMPUTABLE);
        const unexpected = Object.keys(guards).filter(name => !known.includes(name));
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
    const surfacesProven = ['stream', 'relayed', 'abort'].every(surface => artifact[surface]?.proven === true);
    if (artifact.proven !== surfacesProven) {
        ctx.fail(`proven is ${show(artifact.proven)} but the three network surfaces recompute to ${surfacesProven}`);
    }
    if (artifact.proven !== true) {
        ctx.fail('proven is not true, so no claim about streaming through a real hop may rest on this artefact');
    }
    // THE HOP MUST HAVE DONE WHAT THE SURFACES CLAIM IT DID, read from the hop's own record rather than
    // from the guards derived from it: a relay that wrote once was not a relay, and a cut that released
    // nothing truncated nothing.
    for (const leg of ['gotavern', 'pinned']) {
        if ((artifact.hop?.relayedWrites?.[leg] ?? 0) <= 1) {
            ctx.fail(`hop.relayedWrites.${leg} is ${show(artifact.hop?.relayedWrites?.[leg])}, so the hop did not relay the body on that subject and the relayed surface measures the direct connection`);
        }
        // A HEAD-OF-BODY CUT RELEASES ZERO BODY BYTES, and that is the point of the surface: the page got a
        // response and no body. A positive count here would mean the body had started, i.e. a DIFFERENT fault.
        if (artifact.hop?.releasedBytesUnderCut?.[leg] !== 0) {
            ctx.fail(`hop.releasedBytesUnderCut.${leg} is ${show(artifact.hop?.releasedBytesUnderCut?.[leg])}, but a head-of-body cut releases no body byte -- so the body had started and this is not the surface the guards describe`);
        }
        if (artifact.hop?.anyCut?.[leg] !== 'cut-at-head') {
            ctx.fail(`hop.anyCut.${leg} is ${show(artifact.hop?.anyCut?.[leg])}, so the cut the abort surface is about did not happen to that subject`);
        }
    }
    // THE UNPROVEN LIST IS PART OF THE CLAIM. An artefact that declines to say what it does not cover reads
    // as complete (GOAL.md 13, AGENTS.md 36) -- and this one must name the buffering mode it DELETED.
    if (!Array.isArray(artifact.notCompared) || artifact.notCompared.length < 4) {
        ctx.fail('notCompared does not name what this artefact leaves unproven; a surface with a hidden gap is the defect this gate exists for');
    } else if (!artifact.notCompared.some(line => /buffer/i.test(String(line)))) {
        ctx.fail('notCompared does not name the buffering-proxy mode that was measured and removed, so a reader would assume it was proven');
    }
    ctx.observe(`network hop: relayed in ${artifact.hop?.relayedWrites?.gotavern}/${artifact.hop?.relayedWrites?.pinned} write(s) with ${artifact.hop?.relayedFrames?.gotavern}/${artifact.hop?.relayedFrames?.pinned} frame(s); the cut released ${show(artifact.hop?.releasedBytesUnderCut?.gotavern)} B to both subjects from ${show(artifact.hop?.framesWritten?.gotavern)} frame(s)`);
}
