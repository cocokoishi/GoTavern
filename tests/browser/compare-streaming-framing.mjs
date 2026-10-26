#!/usr/bin/env node
// Compare the NETWORK half of the streaming surface (Q19) between GoTavern and pinned Node.
//
// Inputs are SIX generation-probe reports from ONE run: three driving schedules on two subjects.
//
//   node compare-streaming-framing.mjs \
//     --stream  <stream-gotavern.json>  <stream-pinned.json> \
//     --relayed <relayed-gotavern.json> <relayed-pinned.json> \
//     --abort   <abort-gotavern.json>   <abort-pinned.json> \
//     [--out tests/browser/streaming-framing-comparison.json]
//
//   stream   direct connection: the baseline every other surface is compared against, and the only
//            surface on which the reply the page later TRUNCATES is known. Recorded in the same run rather
//            than read from an older artefact, so the prefix check is about one build.
//   relayed  the same drive with the framing hop in pass-through mode in front of the peer. The CONTROL:
//            the hop must have relayed more than one write, must have forwarded the identical request
//            bytes, and the page must have ended with the identical text. A hop that assembled the body
//            would show ONE write, and every claim about "a real middle" would be a claim about the direct
//            connection wearing a hop's name.
//   abort    the hop in cut mode: it relays N frames of the upstream body and then closes BOTH sockets.
//            The peer finishes its whole script (so `clientDisconnected` is FALSE -- what separates this
//            from cancellation), the page is NEVER asked to stop, and the two subjects must report the
//            SAME truncation and the SAME partial text.
//
// WHAT IT DOES NOT CLAIM, stated here because a reader would otherwise infer it. It does NOT claim that a
// buffering proxy preserves incremental render on either subject. That mode was measured in run
// 40299346339 and DELETED (see tests/browser/streaming-framing.mjs): in ONE release the page reads the
// whole body, the pinned SSE reader yields every frame in that same tick, and the number of rendered
// states becomes a property of the browser's commit schedule rather than of the server. The timing
// question -- whether a subject FLUSHES each chunk -- can only be answered by a concurrent observer of the
// subject's response socket, which this harness does not have. It is named in `notCompared`, not asserted.
//
// WHY EACH GUARD CAN FAIL. Every guard compares the OTHER subject, the HOP's own record, or the direct
// baseline; none is readable from a single leg, and none is true by construction.
// tests/browser/streaming-framing-selftest.mjs drives this file with hand-made legs and asserts, per case,
// the exact guard that goes red -- including the cases a real server cannot produce.

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const usage = 'usage: node compare-streaming-framing.mjs --stream <gotavern> <pinned> --relayed <gotavern> <pinned> --abort <gotavern> <pinned> [--out <path>]';

function parseArguments(argv) {
    const pairs = {};
    let out = null;
    for (let index = 0; index < argv.length; index += 1) {
        const flag = argv[index];
        if (flag === '--out') {
            out = argv[index + 1];
            index += 1;
            continue;
        }
        if (!['--stream', '--relayed', '--abort'].includes(flag)) {
            throw new Error(`unknown argument ${JSON.stringify(flag)}; ${usage}`);
        }
        const first = argv[index + 1];
        const second = argv[index + 2];
        if (!first || !second || first.startsWith('--') || second.startsWith('--')) {
            throw new Error(`${flag} needs two leg paths (gotavern then pinned); ${usage}`);
        }
        pairs[flag.slice(2)] = { gotavern: first, pinned: second };
        index += 2;
    }
    for (const required of ['stream', 'relayed', 'abort']) {
        if (!pairs[required]) {
            throw new Error(`--${required} is required: a framing comparison that omits a surface proves nothing about it; ${usage}`);
        }
    }
    return { pairs, out };
}

const { pairs, out } = parseArguments(process.argv.slice(2));
const load = async file => JSON.parse(await fs.readFile(file, 'utf8'));

const renderTexts = report => (report.postSend?.renderSnapshots ?? []).map(snapshot => snapshot.text);
// The DOM legitimately holds non-content states: the sent user message, the assistant placeholder, and
// (after a mid-stream cut) an empty message. Only content states form the prefix chain a reply produces.
const CONTENT = text => Boolean(text) && text !== '\u2026' && text !== 'probe user marker';
const streamedTexts = report => renderTexts(report).filter(CONTENT);
const framesWritten = report => (report.recording ?? []).map(request => request.framesWritten ?? 0);
const requestDigests = report => (report.recording ?? []).map(request => [request.method, request.path, request.bodyLength, request.bodySha256]);
const finalText = report => (report.postSend?.finalAssistantText ?? null);
const hop = report => report.networkHop ?? {};
const pageErrorCount = report => (report.pageErrors ?? []).length;
const isPrefixSequence = texts => texts.every((text, index) => index === 0 || text.startsWith(texts[index - 1]));

const guardsOf = () => {
    const guards = {};
    const problems = [];
    const guard = (name, meaning, value) => {
        guards[name] = value === true;
        if (value !== true) {
            problems.push(`${name}: ${meaning}`);
        }
    };
    return { guards, problems, guard };
};

const blockOf = surface => ({
    guards: surface.guards,
    failedGuards: Object.entries(surface.guards).filter(([, value]) => value !== true).map(([name]) => name),
    problems: surface.problems,
    proven: surface.proven,
});

/**
 * SURFACE 1 -- THE DIRECT CONNECTION: the baseline.
 */
function streamSurface(gotavern, pinned) {
    const { guards, problems, guard } = guardsOf();
    const gvTexts = streamedTexts(gotavern);
    const pnTexts = streamedTexts(pinned);
    const gvRequest = (gotavern.recording ?? []).find(request => request.method === 'POST');
    const pnRequest = (pinned.recording ?? []).find(request => request.method === 'POST');

    guard('bothSubjectsReachedThePeer',
        'a leg recorded no POST at the peer, so it was never driven and nothing below is a comparison',
        Boolean(gvRequest) && Boolean(pnRequest));
    guard('providerRequestBytesEqual',
        'the two subjects sent different request bytes (digest or length), so the request that reached the peer differs',
        (gotavern.recording ?? []).length > 0
            && JSON.stringify(requestDigests(gotavern)) === JSON.stringify(requestDigests(pinned)));
    guard('requestStreamFlagSetOnBoth',
        'a subject did not ask the provider for a streamed reply, so there was no stream to frame',
        Boolean(gvRequest?.body) && Boolean(pnRequest?.body)
            && JSON.parse(gvRequest.body).stream === true && JSON.parse(pnRequest.body).stream === true);
    guard('incrementalRenderObservedOnBoth',
        'a subject rendered fewer than three distinct content states, so the reply arrived in one piece (or not at all) and incremental render was not observed',
        gvTexts.length >= 3 && pnTexts.length >= 3);
    guard('renderAdvancedMonotonicallyOnBoth',
        'a subject applied a render state that is not an extension of the previous one, so the page rewrote settled text',
        isPrefixSequence(gvTexts) && isPrefixSequence(pnTexts));
    // THE FRAMES APPLIED ARE BOUNDED BY THE FRAMES WRITTEN. A subject that applied MORE content states
    // than the peer wrote content frames invented text. FEWER is the coalescing question, which is timing
    // and is named in notCompared; what a single leg can decide is the bound, plus the requirement that
    // the bound is not satisfied by rendering nothing.
    const contentFrames = Math.max(0, Math.max(...framesWritten(gotavern), 0) - 1);
    guard('renderedStatesNeverExceedContentFrames',
        `a subject applied more content states than the peer wrote content frames (peer wrote ${contentFrames}; gotavern applied ${gvTexts.length}, pinned applied ${pnTexts.length}), so the page produced text the provider never sent`,
        gvTexts.length <= contentFrames && pnTexts.length <= contentFrames);
    guard('everySubjectAppliedAtLeastOneContentFrame',
        `a subject applied no content state (gotavern ${gvTexts.length}, pinned ${pnTexts.length}), so no frame reached the DOM and the bound above is vacuous for it`,
        gvTexts.length >= 1 && pnTexts.length >= 1);
    guard('finalTextEqualAndNonEmpty',
        'the two subjects ended with different text, or both ended empty (equal-and-empty is not a pass)',
        finalText(gotavern) === finalText(pinned) && String(finalText(gotavern) ?? '').length > 0);
    guard('bothSubjectsSawTheWholeScript',
        'the peer wrote a different number of frames to the two subjects, or a caller disconnected in a surface nobody aborted',
        JSON.stringify(framesWritten(gotavern)) === JSON.stringify(framesWritten(pinned))
            && (gotavern.recording ?? []).every(request => request.clientDisconnected === false)
            && (pinned.recording ?? []).every(request => request.clientDisconnected === false));
    guard('noHopOnTheDirectSurface',
        `a leg of the direct surface crossed a hop (gotavern ${JSON.stringify(hop(gotavern).mode)}, pinned ${JSON.stringify(hop(pinned).mode)}), so it is not the baseline the other surfaces are compared against`,
        hop(gotavern).absent === true && hop(pinned).absent === true);
    guard('noPageErrorsOnEitherSubject',
        'a page error was recorded on one of the subjects, so a difference elsewhere could be the page rather than the server',
        pageErrorCount(gotavern) === 0 && pageErrorCount(pinned) === 0);
    return { guards, problems, proven: problems.length === 0, texts: { gotavern: gvTexts, pinned: pnTexts } };
}

/**
 * SURFACE 2 -- THE HOP RELAYING: the control.
 */
function relayedSurface(gotavern, pinned, baseline) {
    const { guards, problems, guard } = guardsOf();
    const gvHop = hop(gotavern);
    const pnHop = hop(pinned);
    const gvTexts = streamedTexts(gotavern);
    const pnTexts = streamedTexts(pinned);
    const relayedFrames = h => (h.bodyWrites ?? []).reduce((total, write) => total + (write.frames ?? 0), 0);

    guard('hopPresentOnBothSubjects',
        `a leg did not cross the hop (gotavern mode ${JSON.stringify(gvHop.mode)}, pinned mode ${JSON.stringify(pnHop.mode)}), so this surface measured the direct connection`,
        gvHop.mode === 'pass-through' && pnHop.mode === 'pass-through');
    // THE HOP RELAYED RATHER THAN ASSEMBLED. Without this, "the hop changed nothing" is a claim about a
    // hop that behaved like a socket, and every claim about a real middle is vacuous.
    guard('hopRelayedInMoreThanOneWrite',
        `the hop issued ${gvHop.bodyWriteCount}/${pnHop.bodyWriteCount} body write(s) instead of more than one on both subjects, so it assembled the body rather than relaying it`,
        (gvHop.bodyWriteCount ?? 0) > 1 && (pnHop.bodyWriteCount ?? 0) > 1);
    guard('hopRelayedEveryFrame',
        `the hop relayed ${relayedFrames(gvHop)}/${relayedFrames(pnHop)} frame terminators, fewer than the ${baseline.contentFrames} content frames the peer wrote, so the hop did not carry the whole reply`,
        relayedFrames(gvHop) >= baseline.contentFrames && relayedFrames(pnHop) >= baseline.contentFrames);
    guard('noCutInTheRelayedSurface',
        'the hop reported a cut while relaying, so what the page received was truncated and this is not the relayed case',
        (gvHop.cut ?? null) === null && (pnHop.cut ?? null) === null);
    // THE REQUEST BYTES THE HOP FORWARDED, asserted at the hop as well as at the peer.
    const forwardedDigest = value => JSON.stringify((value.forwarded ?? []).map(entry => [entry.method, entry.path, entry.bodyBytes, entry.bodySha256]));
    guard('hopForwardedIdenticalRequestBytes',
        'the hop forwarded different request bytes for the two subjects, so the request that crossed the hop differs',
        (gvHop.forwarded ?? []).length > 0 && forwardedDigest(gvHop) === forwardedDigest(pnHop));
    guard('hopForwardedWhatThePeerReceived',
        `what the hop forwarded is not what the peer recorded (hop ${JSON.stringify((gvHop.forwarded ?? []).filter(entry => entry.method === 'POST').map(entry => entry.bodyBytes))}, peer ${JSON.stringify((gotavern.recording ?? []).filter(request => request.method === 'POST').map(request => request.bodyLength))}), so the hop rewrote the request`,
        JSON.stringify((gvHop.forwarded ?? []).filter(entry => entry.method === 'POST').map(entry => entry.bodyBytes))
            === JSON.stringify((gotavern.recording ?? []).filter(request => request.method === 'POST').map(request => request.bodyLength)));
    guard('relayedFinalTextEqualsTheDirectStream',
        `the text the page ended with through the hop differs from the text it ended with on a direct connection (gotavern ${JSON.stringify(finalText(gotavern))} vs ${JSON.stringify(baseline.gotavernFinal)}, pinned ${JSON.stringify(finalText(pinned))} vs ${JSON.stringify(baseline.pinnedFinal)}), so the hop changed the answer`,
        finalText(gotavern) === finalText(pinned)
            && finalText(gotavern) === baseline.gotavernFinal
            && finalText(pinned) === baseline.pinnedFinal);
    guard('relayedDeliveredContentToThePage',
        `through the hop a subject applied no content state (gotavern ${gvTexts.length}, pinned ${pnTexts.length}), so the hop delivered nothing the page could render`,
        gvTexts.length >= 1 && pnTexts.length >= 1);
    guard('bothSubjectsSawTheWholeScriptThroughTheHop',
        'the peer wrote a different number of frames through the hop, or a caller disconnected',
        JSON.stringify(framesWritten(gotavern)) === JSON.stringify(framesWritten(pinned))
            && (gotavern.recording ?? []).every(request => request.clientDisconnected === false)
            && (pinned.recording ?? []).every(request => request.clientDisconnected === false));
    guard('noPageErrorsThroughTheHop',
        'a page error was recorded through the hop, so the render evidence is suspect',
        pageErrorCount(gotavern) === 0 && pageErrorCount(pinned) === 0);
    return { guards, problems, proven: problems.length === 0, texts: { gotavern: gvTexts, pinned: pnTexts } };
}

/**
 * SURFACE 3 -- THE NETWORK DIES MID-STREAM, AND NOBODY ASKS IT TO.
 *
 * The row's two claims, with the mechanism of each: the SAME TRUNCATION is a comparison of the content
 * states the two pages reached; the SAME PARTIAL TEXT is an equality on what survived; and the cut is
 * proven to be the network's by the peer never recording a disconnect while the page never recorded a stop
 * click.
 */
function abortSurface(gotavern, pinned, baseline) {
    const { guards, problems, guard } = guardsOf();
    const gvHop = hop(gotavern);
    const pnHop = hop(pinned);
    const gvTexts = streamedTexts(gotavern);
    const pnTexts = streamedTexts(pinned);
    const gvState = gotavern.streamState ?? {};
    const pnState = pinned.streamState ?? {};

    guard('hopCutBothSubjectsMidStream',
        `the hop did not cut both subjects (gotavern mode ${JSON.stringify(gvHop.mode)} cut ${JSON.stringify(gvHop.cut)}, pinned mode ${JSON.stringify(pnHop.mode)} cut ${JSON.stringify(pnHop.cut)}), so no truncation was observed and nothing below is about one`,
        gvHop.mode === 'cut' && pnHop.mode === 'cut' && gvHop.cut === 'cut-after-bytes' && pnHop.cut === 'cut-after-bytes');
    // THE CUT LANDED ON THE COMPLETION, not on the frontend's reachability check: the hop relays every
    // other response whole, and both legs must show that it did.
    guard('hopRelayedTheReachabilityCheckWhole',
        `the hop did not both arm and relay a response on each subject (gotavern armed ${JSON.stringify(gvHop.cutArmedResponses)} whole ${JSON.stringify(gvHop.relayedWholeResponses)}; pinned armed ${JSON.stringify(pnHop.cutArmedResponses)} whole ${JSON.stringify(pnHop.relayedWholeResponses)}), so the subject may never have reached a connected state and this surface measured a failed send rather than a truncation`,
        (gvHop.cutArmedResponses ?? 0) >= 1 && (pnHop.cutArmedResponses ?? 0) >= 1
            && (gvHop.relayedWholeResponses ?? 0) >= 1 && (pnHop.relayedWholeResponses ?? 0) >= 1);
    // THE TRUNCATION MUST BE ATTRIBUTABLE TO THE NETWORK. A chunked body that stops is indistinguishable
    // from a chunked body that ended, so the hop re-frames the SSE body as a single gzip member whose
    // trailer appears only on a clean finish; a cut body then ends in a decoder error.
    guard('hopFramedTheStreamSoTheCutIsDetectable',
        `the hop did not re-frame the SSE body as a single gzip member on both subjects (gotavern ${JSON.stringify(gvHop.gzipFramedResponses)}, pinned ${JSON.stringify(pnHop.gzipFramedResponses)}), so a cut body would end like a clean end to the reader and the truncation could not be attributed to the network`,
        (gvHop.gzipFramedResponses ?? 0) >= 1 && (pnHop.gzipFramedResponses ?? 0) >= 1);
    guard('peerDidNotDisconnect',
        `the peer recorded a client disconnect (gotavern ${JSON.stringify((gotavern.recording ?? []).map(request => request.clientDisconnected))}, pinned ${JSON.stringify((pinned.recording ?? []).map(request => request.clientDisconnected))}), so what ended the stream was the subject (cancellation) rather than the network`,
        (gotavern.recording ?? []).length > 0 && (pinned.recording ?? []).length > 0
            && (gotavern.recording ?? []).every(request => request.clientDisconnected === false)
            && (pinned.recording ?? []).every(request => request.clientDisconnected === false));
    guard('noCallerCancelOnEitherSubject',
        `a subject recorded a stop click in the abort surface (gotavern ${JSON.stringify(gvState.stopClickedAt)}, pinned ${JSON.stringify(pnState.stopClickedAt)}), so this measured cancellation rather than a dead network`,
        gvState.stopClickedAt === null && pnState.stopClickedAt === null);
    guard('peerWroteMoreThanTheHopReleased',
        `the hop released ${JSON.stringify(gvHop.releasedBytes)}/${JSON.stringify(pnHop.releasedBytes)} bytes from a script of ${JSON.stringify(framesWritten(gotavern))}/${JSON.stringify(framesWritten(pinned))} frame(s), so the reply may have been complete and nothing truncated`,
        (gvHop.releasedBytes ?? 0) > 0 && (pnHop.releasedBytes ?? 0) > 0
            && framesWritten(gotavern).every(frames => frames > 0) && framesWritten(pinned).every(frames => frames > 0));

    // ---- THE ROW'S TWO CLAIMS.
    guard('contentRenderedBeforeTheCutOnBoth',
        `no content was rendered before the network died (gotavern applied ${gvTexts.length} content state(s), pinned applied ${pnTexts.length}), so the surface proves nothing about partial rendering`,
        gvTexts.length >= 1 && pnTexts.length >= 1);
    guard('partialTextIdenticalOnBothSubjects',
        `the two subjects ended with different partial text (gotavern ${JSON.stringify(finalText(gotavern))}, pinned ${JSON.stringify(finalText(pinned))}), so the same cut produced different replies`,
        finalText(gotavern) === finalText(pinned) && String(finalText(gotavern) ?? '').length > 0);
    guard('partialTextIsAProperPrefixOfTheWholeReply',
        `the surviving partial text is not a PROPER prefix of what the same subject delivered on a direct connection (gotavern partial ${JSON.stringify(finalText(gotavern))} of ${JSON.stringify(baseline.gotavernFinal)}; pinned partial ${JSON.stringify(finalText(pinned))} of ${JSON.stringify(baseline.pinnedFinal)}), so the page invented, reordered, or did not lose, any text`,
        String(finalText(gotavern) ?? '').length > 0 && String(finalText(pinned) ?? '').length > 0
            && baseline.gotavernFinal.startsWith(finalText(gotavern))
            && baseline.pinnedFinal.startsWith(finalText(pinned))
            && finalText(gotavern) !== baseline.gotavernFinal
            && finalText(pinned) !== baseline.pinnedFinal);
    guard('sameTruncationOnBothSubjects',
        `the subjects truncated at different points (gotavern ${gvTexts.length} content state(s) ${JSON.stringify(gvTexts)}, pinned ${pnTexts.length} ${JSON.stringify(pnTexts)})`,
        JSON.stringify(gvTexts) === JSON.stringify(pnTexts) && gvTexts.length >= 1);
    guard('sameReleasedByteCountOnBothSubjects',
        `the hop released a different number of bytes to the two subjects (gotavern ${JSON.stringify(gvHop.releasedBytes)}, pinned ${JSON.stringify(pnHop.releasedBytes)}), so the cut did not land at the same place`,
        gvHop.releasedBytes === pnHop.releasedBytes && gvHop.cutAfterBytes === pnHop.cutAfterBytes && (gvHop.releasedBytes ?? 0) > 0);

    // ---- THE PAGE AFTER THE CUT.
    guard('noFurtherChunksAppliedAfterTheCut',
        `a subject recorded no post-cut text state (gotavern textAfterCut ${JSON.stringify(gvState.textAfterCut)}, pinned ${JSON.stringify(pnState.textAfterCut)}), so "nothing arrived after the cut" cannot be checked`,
        typeof gvState.textAfterCut === 'string' && typeof pnState.textAfterCut === 'string'
            && gvState.textAfterCut === gvState.textLater && pnState.textAfterCut === pnState.textLater);
    // THE PINNED FRONTEND ENDS A DEAD STREAM THROUGH ITS OWN ERROR PATH: `StreamingProcessor.generate`'s
    // catch -> `onErrorStreaming` -> `markUIGenStopped` -> `unblockGeneration` (script.js:3812-3832 and
    // :3617-3619), which clears `is_send_press`. A subject that instead hangs leaves a spinner forever,
    // which is the user-visible defect this guard exists for.
    guard('pageReturnedToIdleOnBothSubjects',
        `a subject did not return to idle after the cut (gotavern ${JSON.stringify(gvState.returnedToIdle)}, pinned ${JSON.stringify(pnState.returnedToIdle)}), so a user would see a spinner forever`,
        gvState.returnedToIdle === true && pnState.returnedToIdle === true);
    guard('noPageErrorsOnEitherSubject',
        'a page error escaped to the browser on one subject; the frontend ends a dead stream through its own error path, so an escaping error is a difference in handling',
        pageErrorCount(gotavern) === 0 && pageErrorCount(pinned) === 0);
    return { guards, problems, proven: problems.length === 0, texts: { gotavern: gvTexts, pinned: pnTexts } };
}

const main = async () => {
    const gotavern = await load(pairs.stream.gotavern);
    const pinned = await load(pairs.stream.pinned);
    const stream = streamSurface(gotavern, pinned);
    const baseline = {
        gotavernFinal: String(finalText(gotavern) ?? ''),
        pinnedFinal: String(finalText(pinned) ?? ''),
        gotavernTexts: stream.texts.gotavern,
        contentFrames: Math.max(0, Math.max(...framesWritten(gotavern), 0) - 1),
    };
    const relayedGotavern = await load(pairs.relayed.gotavern);
    const relayedPinned = await load(pairs.relayed.pinned);
    const relayed = relayedSurface(relayedGotavern, relayedPinned, baseline);
    const abortGotavern = await load(pairs.abort.gotavern);
    const abortPinned = await load(pairs.abort.pinned);
    const abort = abortSurface(abortGotavern, abortPinned, baseline);

    const observations = (surface, legs) => ({
        gotavern: { texts: surface.texts.gotavern, finalText: finalText(legs.gotavern), pageErrors: pageErrorCount(legs.gotavern), stopClickedAt: legs.gotavern.streamState?.stopClickedAt ?? null },
        pinned: { texts: surface.texts.pinned, finalText: finalText(legs.pinned), pageErrors: pageErrorCount(legs.pinned), stopClickedAt: legs.pinned.streamState?.stopClickedAt ?? null },
    });
    const comparison = {
        schemaVersion: 1,
        question: 'through a real hop, do both subjects relay identically, and do both report the same truncation and the same partial text when the network dies mid-stream?',
        captures: Object.fromEntries(Object.entries(pairs).map(([surface, legs]) => [surface, {
            gotavern: path.basename(legs.gotavern),
            pinned: path.basename(legs.pinned),
        }])),
        // THE HOP'S OWN NUMBERS, so a reader can tell a 3-frame cut from a 14-frame stream without opening
        // a leg -- and so the committed-artefact gate can RECOMPUTE its hop assertions from them.
        hop: {
            mode: { direct: hop(gotavern).mode ?? null, relayed: hop(relayedGotavern).mode ?? null, abort: hop(abortGotavern).mode ?? null },
            relayedCut: { gotavern: hop(relayedGotavern).cut ?? null, pinned: hop(relayedPinned).cut ?? null },
            cutArmOnPath: hop(abortGotavern).cutArmOnPath ?? null,
            cut: { gotavern: hop(abortGotavern).cut ?? null, pinned: hop(abortPinned).cut ?? null },
            cutAfterFrames: hop(abortGotavern).cutAfterFrames ?? null,
            cutAfterBytes: hop(abortGotavern).cutAfterBytes ?? null,
            releasedBytesUnderCut: { gotavern: hop(abortGotavern).releasedBytes ?? null, pinned: hop(abortPinned).releasedBytes ?? null },
            relayedWrites: { gotavern: hop(relayedGotavern).bodyWriteCount ?? null, pinned: hop(relayedPinned).bodyWriteCount ?? null },
            relayedFrames: {
                gotavern: (hop(relayedGotavern).bodyWrites ?? []).reduce((total, write) => total + (write.frames ?? 0), 0),
                pinned: (hop(relayedPinned).bodyWrites ?? []).reduce((total, write) => total + (write.frames ?? 0), 0),
                // THE CONTROL'S OWN BAR: the peer wrote this many content frames on the DIRECT run, so a relay
                // that carried fewer did not carry the reply. Recorded rather than recomputed from the relayed
                // legs, because a hop that dropped frames would move those legs' own counts too.
                expected: baseline.contentFrames,
            },
            gzipFramedResponses: { gotavern: hop(abortGotavern).gzipFramedResponses ?? 0, pinned: hop(abortPinned).gzipFramedResponses ?? 0 },
            cutArmedResponses: { gotavern: hop(abortGotavern).cutArmedResponses ?? 0, pinned: hop(abortPinned).cutArmedResponses ?? 0 },
            relayedWholeResponses: { gotavern: hop(abortGotavern).relayedWholeResponses ?? 0, pinned: hop(abortPinned).relayedWholeResponses ?? 0 },
            framesWritten: { gotavern: framesWritten(abortGotavern), pinned: framesWritten(abortPinned) },
            streamFramesWritten: { gotavern: framesWritten(gotavern), pinned: framesWritten(pinned) },
        },
        // THE PER-SUBJECT OBSERVATIONS THE GUARDS ARE COMPUTED FROM, keyed by SURFACE NAME so the
        // committed-artefact gate recomputes each guard instead of reading this file's own flags.
        observations: {
            stream: observations(stream, { gotavern, pinned }),
            relayed: observations(relayed, { gotavern: relayedGotavern, pinned: relayedPinned }),
            abort: observations(abort, { gotavern: abortGotavern, pinned: abortPinned }),
        },
        stream: blockOf(stream),
        relayed: blockOf(relayed),
        abort: blockOf(abort),
        proven: stream.proven && relayed.proven && abort.proven,
        notCompared: [
            'a real provider (AGENTS.md 22): the peer is a simulated backend that captures and answers; the hop is real TCP but loopback',
            'a real TLS connection: the mid-stream close is a socket close on plain HTTP carrying a gzip member, so a TLS fatal alert or a middlebox reset is unobserved (the decoder error stands in for it, and is measured)',
            'incremental render THROUGH a buffering proxy: a hop that releases the whole body in one write makes the number of rendered states a property of the browser commit schedule rather than of the server (measured, run 40299346339), so that mode was deleted rather than claimed',
            'whether a subject FLUSHES each chunk: that needs a concurrent observer of the subject response socket, which this harness does not have; what is asserted is the reply bytes, the frame count and the end-of-stream behaviour',
            'network timing jitter and loss: the hop paces nothing and drops nothing except at the cut point',
        ],
    };
    const text = JSON.stringify(comparison, null, 2);
    if (out) {
        // THE ARTEFACT IS WRITTEN EVEN WHEN A GUARD FAILS: a red artefact IS the evidence for the finding.
        await fs.writeFile(out, text + '\n');
    } else {
        console.log(text);
    }
    if (!comparison.proven) {
        const failed = [...comparison.stream.failedGuards, ...comparison.relayed.failedGuards, ...comparison.abort.failedGuards];
        console.error(`streaming framing comparison failed: ${failed.join(', ')}`);
        for (const surface of ['stream', 'relayed', 'abort']) {
            for (const problem of comparison[surface].problems) {
                console.error(`  ${surface}: ${problem}`);
            }
        }
        process.exit(1);
    }
    console.error('streaming framing comparison: every guard true on all three surfaces');
};

await main();
