// GENERIC INVARIANTS FOR THE BROWSER CHAT-COMPLETION ARTEFACTS.
//
// Every invariant is written ONCE here and applied to every source, instead of being copied into a
// per-source block. The catalogue (tests/browser/sources.mjs) says what each source IS; this file says
// what any artefact must satisfy REGARDLESS of the source; tools/browser-evidence/source-hooks.mjs holds
// the two or three checks that genuinely depend on one source's wire shape.
//
// TWO RULES SHAPE EVERYTHING BELOW.
//
// 1. RECOMPUTE FROM THE STORED OBSERVATIONS, NEVER TRUST THE RECORDED FLAG. The old verifier read
//    `providerRequestEqual === true` and `proven === true` and `guards.x === true`, all of which are
//    values the COMPARATOR wrote. A hand-edited flag, or a comparator whose formula silently changed,
//    passed the gate while contradicting the data sitting next to it. Every flag that can be rebuilt
//    from the artefact's own per-leg numbers IS rebuilt here, and a disagreement is a finding.
//    (The one place the old file already did this was the ai21 framing block; that idea is now the rule.)
//
// 2. A MISSING CHECK IS NOT A PASS. `Object.entries(artifact.guards ?? {})` iterated over nothing when
//    `guards` was absent, so an artefact with no guards at all was vacuously faithful. The required key
//    sets below are explicit: a missing key is a finding, the same size as a false one.
//
// WHAT THIS STILL CANNOT DO, stated so no reader infers more: it cannot tell whether the drive was run
// against today's HEAD. That is the freshness report's job (tools/browser-evidence/freshness.mjs), which
// needs legs this gate deliberately does not have.

/** Formats a value for a finding without dumping a whole object into the log. */
const show = value => JSON.stringify(value)?.slice(0, 200) ?? String(value);

/** The provider-request rows a leg stores, in the shape both comparators reduce them to. */
export const comparableRequests = (requests = []) => requests.map(request => ({
    method: request.method,
    path: request.path,
    bodyLength: request.bodyLength,
    bodySha256: request.bodySha256,
}));

const methodAndPath = requests => requests.map(request => `${request.method} ${request.path}`);
const digests = requests => requests.map(request => [request.bodyLength, request.bodySha256]);

// ---------------------------------------------------------------------------------------------
// Invariant 1: BOTH LEGS WERE REACHED.
// ---------------------------------------------------------------------------------------------
// A comparison of one driven leg against one idle leg proves nothing, and "requestArrived" is exactly
// the flag that says so. It is also the flag most likely to be true-by-construction, so it is checked
// against the recorded requests as well as read.
export function bothLegsReached(ctx, artifact, { surface = 'generation' } = {}) {
    if (surface === 'generation') {
        for (const leg of ['gotavern', 'pinned']) {
            if (artifact.requestArrived?.[leg] !== true) {
                ctx.fail(`${leg}.requestArrived is ${show(artifact.requestArrived?.[leg])}, so that leg was never driven`);
            }
            const requests = artifact.providerRequests?.[leg] ?? [];
            if (!requests.some(request => request.method === 'POST')) {
                ctx.fail(`${leg} records ${show(methodAndPath(requests))}; no completion POST arrived from that leg`);
            }
        }
        return;
    }
    for (const block of ['streaming', 'cancellation', 'nonstream']) {
        const surfaceBlock = artifact[block];
        if (!surfaceBlock) {
            ctx.fail(`the ${block} block is missing, so that surface was never compared`);
            continue;
        }
        for (const leg of ['gotavern', 'pinned']) {
            const requests = surfaceBlock[leg]?.providerRequests;
            if (!Array.isArray(requests) || requests.length === 0) {
                ctx.fail(`${block}.${leg} records no provider request, so that leg was never driven`);
            } else if (!requests.some(request => request.method === 'POST')) {
                ctx.fail(`${block}.${leg} records ${show(methodAndPath(requests))}; no completion POST arrived`);
            }
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Invariant 2: THE PROVIDER REQUEST ARRIVED AND THE TWO LEGS AGREED ON IT.
// ---------------------------------------------------------------------------------------------
// `providerRequestEqual` is the promise this project makes (AGENTS hard rule 7), so it is RECOMPUTED
// from the two legs' recorded method/path/length/digest rows and the recorded flag must agree. A
// disagreement is worse than a false: it means the artefact contradicts itself.
export function providerRequestsEqual(ctx, artifact) {
    const gotavern = comparableRequests(artifact.providerRequests?.gotavern ?? []);
    const pinned = comparableRequests(artifact.providerRequests?.pinned ?? []);
    const recomputed = JSON.stringify(gotavern) === JSON.stringify(pinned);
    if (artifact.providerRequestEqual !== recomputed) {
        ctx.fail(`providerRequestEqual is ${show(artifact.providerRequestEqual)} but the recorded requests recompute to ${recomputed}: gotavern ${show(methodAndPath(gotavern))} / pinned ${show(methodAndPath(pinned))}`);
    }
    if (!recomputed) {
        ctx.fail(`the two legs sent different provider requests: gotavern ${show(gotavern)} against pinned ${show(pinned)}`);
    }
    ctx.observe(`provider requests identical on both legs (${gotavern.length} request(s), completion body ${gotavern.find(request => request.method === 'POST')?.bodyLength ?? 'unknown'} B)`);
}

// ---------------------------------------------------------------------------------------------
// Invariant 3: THE SEND WINDOW WAS FAITHFUL (with a REQUIRED guard key set).
// ---------------------------------------------------------------------------------------------
export const REQUIRED_GENERATION_GUARDS = [
    // EQUAL AND EMPTY IS NOT A PASS, and neither is an artefact that omits the guard that says so.
    'finalTextNonEmpty',
    'bothLegsQuiescedBeforeSend',
    'bothLegsSettledAfterSend',
    'bothWindowsHoldCompleteGenerations',
    'sendWindowHoldsExactlyOneRealSendAndNoDryAssembly',
];

export function sendWindowFaithful(ctx, artifact) {
    if (!artifact.guards || typeof artifact.guards !== 'object') {
        ctx.fail('has no guards block, so a recording-window divergence cannot be told apart from a product one');
        return;
    }
    for (const guard of REQUIRED_GENERATION_GUARDS) {
        if (!(guard in artifact.guards)) {
            ctx.fail(`does not record the guard ${guard}; an absent guard used to iterate zero times and pass`);
        } else if (artifact.guards[guard] !== true) {
            ctx.fail(`guard ${guard} is ${show(artifact.guards[guard])}, must be true`);
        }
    }
    // THE GUARD'S MEANING MUST BE RECORDED WITH IT, or the next reader assumes the old window rule.
    const meaning = artifact.guardMeaning?.sendWindowHoldsExactlyOneRealSendAndNoDryAssembly;
    if (typeof meaning !== 'string' || !meaning.includes('non-dry invocation')) {
        ctx.fail('guardMeaning for the send-window guard is missing or does not state the invocation-level rule');
    }
    // THE TRAIL THE GUARD IS ABOUT. Recorded but previously never read by the gate: an artefact could
    // say "exactly one real send" beside a trail holding two. Recompute the property from the trail.
    const unmatched = artifact.generationUnmatchedAfterData;
    for (const leg of ['gotavern', 'pinned']) {
        if (!Array.isArray(unmatched?.[leg])) {
            ctx.fail(`generationUnmatchedAfterData.${leg} is missing, so the send window was judged on a trail nobody recorded`);
        } else if (unmatched[leg].length !== 0) {
            ctx.fail(`generationUnmatchedAfterData.${leg} is not empty (${show(unmatched[leg])}), so an assembly had no STARTED of its kind`);
        }
        const trail = artifact.generationInvocations?.[leg];
        if (!Array.isArray(trail)) {
            ctx.fail(`generationInvocations.${leg} is missing, so the send-window guard cannot be checked against its own trail`);
            continue;
        }
        const real = trail.filter(invocation => invocation.dryRun !== true);
        if (real.length !== 1) {
            ctx.fail(`generationInvocations.${leg} holds ${real.length} non-dry invocation(s); the guard claims exactly one`);
        } else {
            const afterData = real[0].afterData ?? [];
            if (afterData.length !== 1 || afterData[0] !== false) {
                ctx.fail(`the real invocation of ${leg} has afterData ${show(afterData)}; it must hold exactly one non-dry assembly and none dry`);
            }
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Invariant 4: NON-EMPTY FINAL TEXT, recomputed from the observation rather than read from a flag.
// ---------------------------------------------------------------------------------------------
export function finalTextNonEmpty(ctx, report, leg) {
    const text = report?.finalAssistantText;
    if (typeof text !== 'string' || text.length === 0) {
        ctx.fail(`${leg}.finalAssistantText is ${show(text)}, so the send rendered nothing (two legs that render nothing compare equal)`);
        return false;
    }
    return true;
}

// ---------------------------------------------------------------------------------------------
// Invariant 5: NO DRY INVOCATION IN THE SEND WINDOW, and exactly one real one.
// ---------------------------------------------------------------------------------------------
// Same data as invariant 3, but stated as its own property so the freshness report and any future
// renderer can ask for it without pulling the whole guard set.
export function noDryInvocationInSendWindow(ctx, artifact) {
    const trail = artifact.generationInvocations;
    if (!trail?.gotavern || !trail?.pinned) {
        return; // invariant 3 already reports the missing trail; do not double-count.
    }
    for (const leg of ['gotavern', 'pinned']) {
        const real = (trail[leg] ?? []).filter(invocation => invocation.dryRun !== true);
        const dry = (trail[leg] ?? []).filter(invocation => invocation.dryRun === true);
        for (const invocation of real) {
            if ((invocation.afterData ?? []).some(value => value === true)) {
                ctx.fail(`${leg}: the real send holds a dry assembly in the window, which is the defect this guard exists for`);
            }
        }
        ctx.observe(`${leg} send window: ${real.length} real invocation(s), ${dry.length} independent dry invocation(s) recorded and not attributed`);
    }
}

// ---------------------------------------------------------------------------------------------
// THE STREAMING/CANCELLATION INVARIANTS, recomputed from each block's stored observations.
// ---------------------------------------------------------------------------------------------
// These are the formulas compare-streaming-legs.mjs applies when it RECORDS a check. Re-expressing
// them here is deliberate duplication of a FORMULA (not of an expectation): the gate recomputes the
// same property from the same stored numbers and fails when the recorded flag disagrees. If the
// recorder's formula changes, the gate stops agreeing and says so -- which is the point.
const streamedTexts = request => (request?.renderTexts ?? []).filter(text => text && text !== '…' && text !== 'probe user marker');
const isPrefixSequence = texts => texts.every((text, index) => index === 0 || text.startsWith(texts[index - 1]));

const REQUIRED_CHECKS = {
    streaming: [
        'requestArrivedBoth', 'providerRequestCountEqual', 'providerRequestMethodsAndPathsEqual', 'providerBodyEqual',
        'finalTextEqual', 'finalTextNonEmpty', 'streamedRenderPrefixes', 'pagesHaveNoErrors',
        'requestStreamFlagMatches', 'clientDisconnectedMatches', 'incrementalRenderingObserved', 'framesWrittenEqual',
    ],
    cancellation: [
        'requestArrivedBoth', 'providerRequestCountEqual', 'providerRequestMethodsAndPathsEqual', 'providerBodyEqual',
        'finalTextNonEmpty', 'streamedRenderPrefixes', 'pagesHaveNoErrors', 'requestStreamFlagMatches',
        'clientDisconnectedMatches', 'contentRenderedBeforeAbort', 'noFurtherChunksAppliedAfterAbort',
        'abortControlUsed', 'abortTextIsPrefixOfStreamedReply', 'finalTextEqualsAfterAbortState',
    ],
    nonstream: [
        'requestArrivedBoth', 'providerRequestCountEqual', 'providerRequestMethodsAndPathsEqual', 'providerBodyEqual',
        'finalTextEqual', 'finalTextNonEmpty', 'streamedRenderPrefixes', 'pagesHaveNoErrors',
        'requestStreamFlagMatches', 'singleContentStateOnly',
    ],
};

// WHAT EACH SURFACE MUST HAVE OBSERVED, independent of the recorder's flags.
const EXPECTED_DISCONNECT = { streaming: false, cancellation: true, nonstream: undefined };

/** Recomputes one surface block's checks from its stored observations. Returns {name: boolean}. */
export function recomputeSurface(block) {
    const gotavern = block?.gotavern ?? {};
    const pinned = block?.pinned ?? {};
    const gotavernRequests = gotavern.providerRequests ?? [];
    const pinnedRequests = pinned.providerRequests ?? [];
    const recomputed = {
        requestArrivedBoth: gotavernRequests.length > 0 && pinnedRequests.length > 0,
        providerRequestCountEqual: gotavernRequests.length === pinnedRequests.length,
        providerRequestMethodsAndPathsEqual: JSON.stringify(methodAndPath(gotavernRequests)) === JSON.stringify(methodAndPath(pinnedRequests)),
        providerBodyEqual: JSON.stringify(digests(gotavernRequests)) === JSON.stringify(digests(pinnedRequests)),
        finalTextEqual: (gotavern.finalAssistantText ?? null) === (pinned.finalAssistantText ?? null),
        finalTextNonEmpty: String(gotavern.finalAssistantText ?? '').length > 0 && String(pinned.finalAssistantText ?? '').length > 0,
        streamedRenderPrefixes: isPrefixSequence(streamedTexts(gotavern)) && isPrefixSequence(streamedTexts(pinned)),
        incrementalRenderingObserved: streamedTexts(gotavern).length >= 3 && streamedTexts(pinned).length >= 3
            && gotavern.streamState?.sawIncremental === true && pinned.streamState?.sawIncremental === true,
        framesWrittenEqual: JSON.stringify(gotavernRequests.map(request => request.framesWritten))
            === JSON.stringify(pinnedRequests.map(request => request.framesWritten)),
        singleContentStateOnly: streamedTexts(gotavern).length === 1 && streamedTexts(pinned).length === 1,
        contentRenderedBeforeAbort: gotavern.streamState?.sawIncremental === true && pinned.streamState?.sawIncremental === true
            && (gotavern.streamState?.contentSnapshotsBeforeEnd ?? 0) >= 1 && (pinned.streamState?.contentSnapshotsBeforeEnd ?? 0) >= 1,
        noFurtherChunksAppliedAfterAbort: gotavern.streamState?.textAfterStop === gotavern.streamState?.textLater
            && pinned.streamState?.textAfterStop === pinned.streamState?.textLater
            && gotavern.streamState?.snapshotsAtStopPlus1200 === gotavern.streamState?.snapshotsLater
            && pinned.streamState?.snapshotsAtStopPlus1200 === pinned.streamState?.snapshotsLater,
        abortControlUsed: gotavern.streamState?.stopPresent === true && pinned.streamState?.stopPresent === true,
        finalTextEqualsAfterAbortState: (gotavern.finalAssistantText ?? null) === (gotavern.streamState?.textLater ?? null)
            && (pinned.finalAssistantText ?? null) === (pinned.streamState?.textLater ?? null),
    };
    // `pagesHaveNoErrors` and `requestStreamFlagMatches` come from observations the artefact does not
    // carry (page errors are per-leg report data, the request body is not stored). They are checked for
    // PRESENCE and truth, and NOT recomputed -- named here so the omission is visible rather than implied.
    return recomputed;
}

// THE ABORT-PREFIX PROPERTY IS RECOMPUTED HERE, FOR BOTH SUBJECTS. It is NOT in `NOT_RECOMPUTABLE`: the
// per-leg `finalAssistantText` values are stored in the artefact, so the property IS derivable, and the list
// below used to name it anyway -- the list and the code disagreed about what this gate does, and the code was
// the half that was wrong (`abortedText(block)` reads `block.gotavern`, so the second conjunct repeated the
// first and the PINNED leg's aborted text was never checked at all while the flag was required true).
export const NOT_RECOMPUTABLE = ['pagesHaveNoErrors', 'requestStreamFlagMatches'];

export function streamingSurfacesProven(ctx, artifact) {
    const abortedText = (block, leg) => String(block?.[leg]?.finalAssistantText ?? '');
    const streamedReply = String(artifact.streaming?.gotavern?.finalAssistantText ?? '');
    for (const surface of ['streaming', 'cancellation', 'nonstream']) {
        const block = artifact[surface];
        if (!block || typeof block !== 'object') continue; // reported by bothLegsReached
        const checks = block.checks ?? {};
        for (const required of REQUIRED_CHECKS[surface]) {
            if (!(required in checks)) {
                ctx.fail(`${surface}.checks.${required} is missing; the artefact records a proof that does not include it`);
            } else if (checks[required] !== true) {
                ctx.fail(`${surface}.checks.${required} is ${show(checks[required])}`);
            }
        }
        const unexpected = Object.keys(checks).filter(name => !REQUIRED_CHECKS[surface].includes(name));
        if (unexpected.length > 0) {
            ctx.fail(`${surface}.checks carries ${show(unexpected)}, which this gate does not know; a check nobody reads is a claim nobody checks`);
        }
        // RECOMPUTATION. Every derivable check is rebuilt from the stored per-leg numbers and must agree.
        const recomputed = recomputeSurface(block);
        for (const [name, value] of Object.entries(recomputed)) {
            if (!(name in checks)) continue; // absence already reported above where it is required
            if (checks[name] !== value) {
                ctx.fail(`${surface}.checks.${name} is recorded as ${show(checks[name])} but the stored observations recompute to ${show(value)} -- the artefact contradicts itself`);
            }
        }
        // THE ABORT-PREFIX PROPERTY, recomputed here because it is the cancellation surface's core claim.
        // BOTH SUBJECTS ARE RECOMPUTED: the pinned leg's aborted text is a stored observation too, and a
        // recompute that read only the GoTavern leg left the pinned half of the claim checked by nothing but
        // the recorded flag -- which is the one thing this gate exists not to trust.
        if (surface === 'cancellation') {
            const prefix = text => text.trim().length > 0 && streamedReply.startsWith(text);
            const observed = streamedReply.length > 0
                && prefix(abortedText(block, 'gotavern'))
                && prefix(abortedText(block, 'pinned'));
            if (checks.abortTextIsPrefixOfStreamedReply === true && !observed) {
                ctx.fail(`cancellation.checks.abortTextIsPrefixOfStreamedReply is recorded true, but the aborted text is not a non-empty prefix of the streamed reply (gotavern ${show(abortedText(block, 'gotavern'))}, pinned ${show(abortedText(block, 'pinned'))}, streamed reply ${show(streamedReply)})`);
            }
        }
        // THE SURFACE'S OWN VERDICT, recomputed: `proven` must equal the conjunction of the checks it carries.
        const allTrue = Object.values(checks).every(Boolean) && Object.keys(checks).length >= REQUIRED_CHECKS[surface].length;
        if (block.proven !== allTrue) {
            ctx.fail(`${surface}.proven is ${show(block.proven)} but its own checks recompute to ${allTrue}`);
        }
        if (block.proven !== true) {
            const failed = Object.entries(checks).filter(([, value]) => value !== true).map(([name]) => name);
            ctx.fail(`${surface}.proven is not true; failing checks: ${failed.join(', ') || '(none isolated)'}`);
        }
    }
    // `compatibleReady` is the artefact's headline claim; it must equal the conjunction of the surfaces.
    const surfacesProven = ['streaming', 'cancellation', 'nonstream'].every(surface => artifact[surface]?.proven === true);
    if (artifact.compatibleReady !== surfacesProven) {
        ctx.fail(`compatibleReady is ${show(artifact.compatibleReady)} but the three surfaces recompute to ${surfacesProven}`);
    }
    if (artifact.compatibleReady !== true) {
        ctx.fail('compatibleReady is not true, so no `compatible` claim may rest on this artefact');
    }
}

// ---------------------------------------------------------------------------------------------
// Invariant 6: CANCELLATION REACHED THE PROVIDER, on BOTH legs, in EVERY streaming artefact.
// ---------------------------------------------------------------------------------------------
// The old gate applied this to ten artefacts and skipped four (custom, openai, aimlapi, ai21), which is
// the surface's whole point. It is one rule now, applied to all of them.
export function cancellationReachedProvider(ctx, artifact) {
    const block = artifact.cancellation;
    if (!block) {
        return; // reported by bothLegsReached
    }
    for (const leg of ['gotavern', 'pinned']) {
        const requests = block[leg]?.providerRequests ?? [];
        if (requests.length === 0) {
            ctx.fail(`cancellation.${leg} records no provider request, so the teardown cannot have reached the provider`);
            continue;
        }
        const notDisconnected = requests.filter(request => request.clientDisconnected !== true);
        if (notDisconnected.length > 0) {
            ctx.fail(`cancellation.${leg} has ${notDisconnected.length} request(s) that did not record clientDisconnected true, so the abort never reached the provider on that leg`);
        }
    }
    // THE ABORT LANDED MID-STREAM: at least one frame was written before the caller went away. A
    // cancellation recorded at zero frames proves the abort won a race, not that the stream was cut.
    for (const leg of ['gotavern', 'pinned']) {
        const frames = (block[leg]?.providerRequests ?? []).map(request => request.framesWritten ?? 0);
        if (frames.length > 0 && Math.max(...frames) < 1) {
            ctx.fail(`cancellation.${leg} records ${show(frames)} frames written, so the stream was aborted before any content was sent`);
        }
    }
    const abortState = block.abortRenderState;
    if (!abortState || abortState.gotavern?.framesWritten === undefined || abortState.pinned?.framesWritten === undefined || typeof abortState.note !== 'string') {
        ctx.fail('cancellation.abortRenderState does not record both legs and its reason');
    }
}

// ---------------------------------------------------------------------------------------------
// Invariant 7: NO UNEXPECTED STATUS CALL / THE SOURCE'S OWN COMPLETION ROUTE WAS USED.
// ---------------------------------------------------------------------------------------------
// This is the one invariant whose reach depends on the peer circuit, and the gate says which case it
// is in rather than silently passing: a request-keyed peer records ONLY completion POSTs, so a status
// call is not observable there at all. `observable` is reported so a caption cannot claim otherwise.
export function completionRouteUsed(ctx, artifact, { source, requestsFor }) {
    const anthropic = source.probe.peer.protocol === 'anthropic';
    const completionMatches = path => anthropic ? String(path).includes('/messages') : (String(path).includes('/chat/completions') || String(path).includes('/chat'));
    const statusMatches = path => String(path).includes('/models');
    let observableStatusCalls = false;
    for (const [label, requests] of requestsFor(artifact)) {
        for (const request of requests ?? []) {
            const path = String(request.path ?? '');
            if (statusMatches(path)) {
                observableStatusCalls = true;
                if (source.probe.expectsModelsCall === false) {
                    ctx.fail(`${label} records ${request.method} ${path}; ${source.id} is a no-validate source and must never ask for a model list`);
                }
                continue;
            }
            if (completionMatches(path)) continue;
            ctx.fail(`${label} records ${request.method} ${path}, which is neither this source's completion route nor its model list`);
        }
        if (source.probe.expectsModelsCall === false && (requests ?? []).some(request => statusMatches(request.path))) {
            // already reported above with the label
        }
    }
    ctx.observe(source.probe.expectsModelsCall === false
        ? 'no-validate source: zero model-list calls required on both legs'
        : (observableStatusCalls
            ? 'status call observed and permitted (the frontend asks before a send)'
            : 'status call NOT observable: this drive records completion POSTs only'));
}
