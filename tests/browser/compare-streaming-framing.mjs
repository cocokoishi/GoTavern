#!/usr/bin/env node
// Compare the NETWORK half of the streaming surface (Q19) between GoTavern and pinned Node.
//
// Inputs are SIX generation-probe reports produced by the SAME probe on both subjects:
//
//   node compare-streaming-framing.mjs \
//     --stream     <stream-gotavern.json>     <stream-pinned.json> \
//     --buffered   <buffered-gotavern.json>   <buffered-pinned.json> \
//     --abort      <abort-gotavern.json>      <abort-pinned.json> \
//     [--out tests/browser/streaming-framing-comparison.json]
//
// WHAT IT ADDS TO compare-streaming-legs.mjs. That comparator measures the subjects with the page
// talking DIRECTLY to an in-process peer on loopback: one unbroken connection, no middle, plain HTTP.
// The three surfaces here put a real TCP hop between them:
//
//   buffered : the hop holds the whole upstream body and releases it in ONE write. A subject that
//              flushed per chunk still renders frame by frame THROUGH the hop (because it wrote each
//              frame as it read it, and the hop released them together only at the very end -- which is
//              the weakest possible network for incremental render), and the request bytes the hop
//              forwards are identical on both subjects.
//   abort    : the hop releases N frames and then closes BOTH sockets. The peer never disconnects and
//              finishes its whole script; the page is NEVER asked to stop. Both subjects must report the
//              same truncation and the same partial text.
//   cancel   : compare-streaming-legs.mjs already proves the peer saw a disconnect on both subjects. This
//              file adds the one thing that proof cannot see: the exact bytes that reached the peer.
//
// WHY EACH GUARD CAN FAIL (AGENTS.md doctrine rule 4). Every guard below is a comparison against the
// OTHER SUBJECT, against the HOP's own record, or against the hop's control mode; none of them is
// readable from a single leg, and none of them is true by construction. The header of each guard says
// which mutation kills it, and the mutation table in the commit that introduced this file names the
// assertion that went red for each one.
//
// THE CONTROL, AND WHY IT IS MANDATORY. `buffered` is only evidence if the hop really buffered: if the
// hop relayed instantly then `buffered` measures the same thing `stream` measures and would pass for the
// wrong reason. The hop records every body write it issues, so `bufferingProxyHeldTheWholeBody` requires
// EXACTLY ONE body write whose frame count is the whole script, and `passThroughProxyRelayedInPieces`
// (run when a pass-through leg pair is supplied) requires MORE THAN ONE. A hop that buffered nothing is a
// HARNESS NON-DISCRIMINATING verdict, not a pass.

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const usage = 'usage: node compare-streaming-framing.mjs --stream <gotavern> <pinned> --buffered <gotavern> <pinned> --abort <gotavern> <pinned> [--passthrough <gotavern> <pinned>] [--out <path>]';

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
        if (!['--stream', '--buffered', '--abort', '--passthrough'].includes(flag)) {
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
    for (const required of ['stream', 'buffered', 'abort']) {
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
// (after an abort) an empty message. Only content states form the prefix chain incremental render must
// produce.
const CONTENT = text => Boolean(text) && text !== '\u2026' && text !== 'probe user marker';
const streamedTexts = report => renderTexts(report).filter(CONTENT);
const framesWritten = report => (report.recording ?? []).map(request => request.framesWritten ?? 0);
const requestDigests = report => (report.recording ?? []).map(request => [request.method, request.path, request.bodyLength, request.bodySha256]);
const finalText = report => (report.postSend?.finalAssistantText ?? null);


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

/** True when a hop record shows a body released in exactly one write, in buffering mode. */
const singleRelease = hop => Array.isArray(hop.bodyWrites) && hop.bodyWrites.length === 1 && hop.mode === 'buffer';

/**
 * SURFACE 1 -- STREAMED THROUGH A REAL HOP: the baseline. Same drive as the committed streaming artefact,
 * recorded in the same run so the two framing surfaces below have something to be compared against (the
 * aborted text must be a prefix of the reply THIS RUN streamed, not of a number from an older artefact).
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
    // THE REQUEST BYTES. The hop records what actually left it, so this is an assertion about the wire
    // and not about the subject's intent.
    guard('providerRequestBytesEqual',
        'the two subjects sent different request bytes (digest or length), so the request that reached the peer differs',
        JSON.stringify(requestDigests(gotavern)) === JSON.stringify(requestDigests(pinned)));
    guard('requestStreamFlagSetOnBoth',
        'a subject did not ask the provider for a streamed reply, so there was no stream to frame',
        Boolean(gvRequest?.body) && Boolean(pnRequest?.body)
            && JSON.parse(gvRequest.body).stream === true && JSON.parse(pnRequest.body).stream === true);
    // INCREMENTAL RENDER, as a property rather than a tick alignment: the sequence of content states must
    // grow monotonically and hold at least three distinct states (more than "placeholder" and "final").
    const isPrefixSequence = texts => texts.every((text, index) => index === 0 || text.startsWith(texts[index - 1]));
    guard('incrementalRenderObservedOnBoth',
        'a subject rendered fewer than three distinct content states, so the reply arrived in one piece (or not at all) and incremental render was not observed',
        gvTexts.length >= 3 && pnTexts.length >= 3);
    guard('renderAdvancedMonotonicallyOnBoth',
        'a subject applied a render state that is not an extension of the previous one, so the page rewrote settled text',
        isPrefixSequence(gvTexts) && isPrefixSequence(pnTexts));
    // THE FRAMES APPLIED ARE BOUNDED BY THE FRAMES WRITTEN. A subject that applied MORE content states
    // than the peer wrote content frames invented text. A subject that applied FEWER is the coalescing
    // question, which is answered by the two guards below rather than folded in here -- HOW MANY render
    // states the browser reached is a function of when it read the socket, not of what the server sent,
    // and this project has already recorded that quantity moving across repeats on a SINGLE leg
    // (compare-streaming-legs.mjs, `renderTickAlignment`).
    // THE PEER'S OWN ARITHMETIC, read from generation-probe.mjs rather than assumed: `PROBE_FRAME_COUNT=N`
    // writes N CONTENT frames (one per loop iteration) and THEN one terminal frame, so a recorded
    // `framesWritten` of N+1 means N content frames. (Measured: the first version subtracted two and the
    // harness self-test caught it -- the peer's 14-frame script records 15.)
    const contentFrames = Math.max(0, Math.max(...framesWritten(gotavern), 0) - 1);
    guard('renderedStatesNeverExceedContentFrames',
        `a subject applied more content states than the peer wrote content frames (peer wrote ${contentFrames}; gotavern applied ${gvTexts.length}, pinned applied ${pnTexts.length}), so the page produced text the provider never sent`,
        gvTexts.length <= contentFrames && pnTexts.length <= contentFrames);
    // AND AT LEAST ONE STATE PER SUBJECT IS REQUIRED, so the bound above cannot be satisfied by rendering
    // nothing at all: a subject that rendered zero states passes "never exceeds the frames" trivially.
    guard('everySubjectAppliedAtLeastOneContentFrame',
        `a subject applied no content state (gotavern ${gvTexts.length}, pinned ${pnTexts.length}), so no frame reached the DOM and the bound above is vacuous for it`,
        gvTexts.length >= 1 && pnTexts.length >= 1);
    guard('finalTextEqualAndNonEmpty',
        'the two subjects ended with different text, or both ended empty (equal-and-empty is not a pass)',
        finalText(gotavern) === finalText(pinned) && String(finalText(gotavern) ?? '').length > 0);
    guard('bothSubjectsSawTheWholeScript',
        'the peer wrote a different number of frames to the two subjects, or the caller disconnected in a surface that nobody aborted',
        JSON.stringify(framesWritten(gotavern)) === JSON.stringify(framesWritten(pinned))
            && (gotavern.recording ?? []).every(request => request.clientDisconnected === false)
            && (pinned.recording ?? []).every(request => request.clientDisconnected === false));
    guard('noPageErrorsOnEitherSubject',
        'a page error was recorded on one of the subjects, so a difference below could be the page rather than the server',
        (gotavern.pageErrors ?? []).length === 0 && (pinned.pageErrors ?? []).length === 0);
    return { guards, problems, proven: problems.length === 0, gotavernTexts: gvTexts, pinnedTexts: pnTexts };
}

/**
 * SURFACE 2 -- A BUFFERING PROXY BETWEEN SUBJECT AND PEER.
 *
 * The hop releases the whole body in one write. Incremental render must STILL advance frame by frame on
 * both subjects, which is the hardest case for a server that flushes: it can only pass if every frame was
 * flushed to the socket as it was read, because the hop handed the page everything at once and anything
 * still inside the server would arrive even later.
 */
function bufferedSurface(gotavern, pinned, baseline) {
    const { guards, problems, guard } = guardsOf();
    const gvHop = gotavern.networkHop ?? {};
    const pnHop = pinned.networkHop ?? {};

    // DID THE HOP DO WHAT ITS NAME SAYS. Without this the whole surface is the `stream` surface wearing
    // another name, and would pass for the wrong reason.
    guard('bufferingProxyHeldTheWholeBody',
        `the hop did not release the body in exactly one write on one of the subjects (gotavern: mode ${gvHop.mode}, ${gvHop.bodyWriteCount} write(s); pinned: mode ${pnHop.mode}, ${pnHop.bodyWriteCount} write(s)), so nothing about buffering was measured`,
        singleRelease(gvHop) && singleRelease(pnHop));
    // The one release must carry the WHOLE script: a hop that released one frame and closed is the CUT
    // surface, and the two would be indistinguishable without this.
    const framesReleased = hop => (hop.bodyWrites ?? []).reduce((total, write) => total + (write.frames ?? 0), 0);
    guard('bufferingProxyReleasedEveryFrameInThatWrite',
        `the hop's single write did not carry the whole script (gotavern released ${framesReleased(gvHop)} frame terminators, pinned released ${framesReleased(pnHop)}), so the page saw a truncated body rather than a buffered one`,
        framesReleased(gvHop) >= baseline.contentFrames && framesReleased(pnHop) >= baseline.contentFrames);
    guard('noCutInTheBufferingSurface',
        'the hop reported a cut during the buffering surface, so what the page received was truncated and this is not the buffering case',
        gvHop.cut === null || gvHop.cut === undefined ? true : false);
    // THE REQUEST BYTES THE HOP FORWARDED. "The peer saw identical request bytes" asserted at the hop
    // rather than at the peer: the peer records bodies, the hop records digests, and the digests must
    // match between the subjects AND match what the peer recorded on its own side.
    const forwardedDigest = hop => JSON.stringify((hop.forwarded ?? []).map(entry => [entry.method, entry.path, entry.bodyBytes, entry.bodySha256]));
    guard('forwardedRequestBytesEqual',
        'the hop forwarded different request bytes for the two subjects, so the request that crossed the hop differs',
        (gvHop.forwarded ?? []).length > 0 && forwardedDigest(gvHop) === forwardedDigest(pnHop));
    const peerDigests = report => JSON.stringify((report.recording ?? []).map(request => [request.method, request.path, request.bodyLength, request.bodySha256]));
    guard('hopForwardedWhatThePeerReceived',
        'what the hop forwarded is not what the peer recorded, so the hop rewrote the request and the comparison would be about the hop',
        peerDigests(gotavern) === peerDigests(pinned) && JSON.stringify((gvHop.forwarded ?? []).map(entry => [entry.bodyBytes])) === JSON.stringify((gotavern.recording ?? []).map(request => [request.bodyLength])));

    // THE CLAIM OF THE SURFACE: incremental render survives the weakest network.
    const gvTexts = streamedTexts(gotavern);
    const pnTexts = streamedTexts(pinned);
    guard('bufferedFinalTextEqualsTheDirectStream',
        'the text the page ended with through the hop differs from the text it ended with on a direct connection, so the hop changed the outcome',
        finalText(gotavern) === finalText(pinned)
            && finalText(gotavern) === baseline.gotavernFinal
            && finalText(pinned) === baseline.pinnedFinal);
    // THE FRAME SEQUENCE, COMPARED BY FRAME RATHER THAN BY TICK. A server that assembled the reply would
    // deliver it in one piece through this hop, and the page would render ZERO content states (the last
    // text state would be the whole reply, reached without any intermediate state). The guards therefore
    // require (a) more than one content state per subject, and (b) that every state the page reached is a
    // prefix of the final text -- so the page walked the reply and did not jump to it. The per-ticks
    // comparison of the DIRECT and BUFFERED legs is deliberately NOT made: the tick a browser lands on is
    // a race between the socket read and the renderer, and only a CONCURRENT observer of that socket could
    // decide it -- see the notCompared list, where the timing half is named instead of asserted.
    guard('incrementalRenderAdvancedThroughTheBufferingProxy',
        `the page did not render frame by frame through a hop that released everything at once (gotavern applied ${gvTexts.length} content state(s), pinned applied ${pnTexts.length}); a subject that assembled the reply before answering would show a single state`,
        gvTexts.length >= 3 && pnTexts.length >= 3);
    guard('bothSubjectsSawTheWholeScriptThroughTheHop',
        'the peer wrote a different number of frames through the hop, or a caller disconnected',
        JSON.stringify(framesWritten(gotavern)) === JSON.stringify(framesWritten(pinned))
            && (gotavern.recording ?? []).every(request => request.clientDisconnected === false)
            && (pinned.recording ?? []).every(request => request.clientDisconnected === false));
    guard('noPageErrorsThroughTheHop',
        'a page error was recorded through the hop, so the render evidence is suspect',
        (gotavern.pageErrors ?? []).length === 0 && (pinned.pageErrors ?? []).length === 0);
    return { guards, problems, proven: problems.length === 0 };
}

/**
 * SURFACE 3 -- THE NETWORK DIES MID-STREAM, AND NOBODY ASKS IT TO.
 *
 * The hop releases N frames and closes both sockets. The peer finishes its script (so the peer never
 * disconnected: `clientDisconnected` must be false, which is how this surface is distinguishable from
 * cancellation), the page is never told to stop, and both subjects must end in the same state.
 */
function abortSurface(gotavern, pinned, baseline) {
    const { guards, problems, guard } = guardsOf();
    const gvHop = gotavern.networkHop ?? {};
    const pnHop = pinned.networkHop ?? {};
    const gvState = gotavern.streamState ?? {};
    const pnState = pinned.streamState ?? {};

    // THE NETWORK FAULT HAPPENED, ON BOTH LEGS, AND IT WAS THE NETWORK.
    guard('networkCutBothSubjectsMidStream',
        `the hop did not cut both subjects mid-stream (gotavern cut: ${JSON.stringify(gvHop.cut)}, pinned cut: ${JSON.stringify(pnHop.cut)}), so no truncation was observed and nothing below is about one`,
        gvHop.cut === 'cut-after-bytes' && pnHop.cut === 'cut-after-bytes');
    guard('peerDidNotDisconnect',
        'the peer recorded a client disconnect, so what ended the stream was the subject (cancellation) rather than the network',
        (gotavern.recording ?? []).every(request => request.clientDisconnected === false)
            && (pinned.recording ?? []).every(request => request.clientDisconnected === false));
    guard('peerWroteMoreThanItDelivered',
        'the peer did not write more frames than the hop released, so the reply was complete and nothing was truncated',
        (gvHop.releasedBytes ?? 0) > 0 && (pnHop.releasedBytes ?? 0) > 0
            && framesWritten(gotavern).every(frames => frames > 0)
            && framesWritten(pinned).every(frames => frames > 0));
    // THE CALLER NEVER STOPPED. `stopClickedAt` is null on both, so "the page gave up" cannot be confused
    // with "a user pressed stop" -- which is the whole reason `cancel` mode cannot measure this.
    guard('noCallerCancelOnEitherSubject',
        'a subject recorded a stop click in the abort surface, so this measured cancellation rather than a dead network',
        gvState.stopClickedAt === null && pnState.stopClickedAt === null);

    // THE TWO CLAIMS THE ROW ASKS FOR: the same truncation, and the same partial text.
    const gvTexts = streamedTexts(gotavern);
    const pnTexts = streamedTexts(pinned);
    guard('contentRenderedBeforeTheCutOnBoth',
        `no content was rendered before the network died (gotavern applied ${gvTexts.length} content state(s), pinned applied ${pnTexts.length}), so the surface proves nothing about partial rendering`,
        gvTexts.length >= 1 && pnTexts.length >= 1);
    guard('partialTextIdenticalOnBothSubjects',
        `the two subjects ended with different partial text (gotavern ${JSON.stringify(finalText(gotavern))}, pinned ${JSON.stringify(finalText(pinned))}), so the same cut produced different replies`,
        finalText(gotavern) === finalText(pinned) && String(finalText(gotavern) ?? '').length > 0);
    guard('partialTextIsAProperPrefixOfTheWholeReply',
        'the surviving partial text is not a proper prefix of what the same subject delivered on a direct connection, so the page invented or reordered text',
        String(finalText(gotavern) ?? '').length > 0
            && String(finalText(pinned) ?? '').length > 0
            && baseline.gotavernFinal.startsWith(finalText(gotavern))
            && baseline.pinnedFinal.startsWith(finalText(pinned))
            && finalText(gotavern) !== baseline.gotavernFinal);
    // THE SAME TRUNCATION, EXACTLY: the two subjects applied the same number of content states, and each
    // is a superset of nothing -- the states are compared, not merely counted, so two subjects that cut
    // at the same count but produced different text are both red above and here.
    guard('sameTruncationOnBothSubjects',
        `the subjects truncated at different points (gotavern applied ${gvTexts.length} content state(s) [${JSON.stringify(gvTexts)}], pinned applied ${pnTexts.length} [${JSON.stringify(pnTexts)}])`,
        JSON.stringify(gvTexts) === JSON.stringify(pnTexts));
    // THE TRUNCATION REACHED THE PROVIDER AS A CLOSED CONNECTION, not as a clean end: the hop released
    // fewer bytes than the whole reply, and the released byte count is identical on both legs.
    guard('releasedByteCountEqualOnBothSubjects',
        `the hop released a different number of bytes to the two subjects (gotavern ${gvHop.releasedBytes}, pinned ${pnHop.releasedBytes}), so the cut did not land at the same place`,
        gvHop.releasedBytes === pnHop.releasedBytes && gvHop.cutAfterBytes === pnHop.cutAfterBytes);
    // THE PAGE'S OWN REPORT OF THE FAILURE. The frontend ends a dead stream through its error path (a
    // toast and GENERATION_ENDED / GENERATION_STOPPED); a subject that kept rendering would show up as
    // text that moved after the cut.
    guard('noFurtherChunksAppliedAfterTheCut',
        'text changed after the cut point was reached, so the page was still applying chunks from a stream the network had closed',
        gvState.textAfterAbort === gvState.textLater && pnState.textAfterAbort === pnState.textLater);
    guard('generationEndedOnBothSubjects',
        `a subject did not return to idle after the cut (gotavern ${JSON.stringify(gvState.returnedToIdle)}, pinned ${JSON.stringify(pnState.returnedToIdle)}), so one of them hangs on a dead stream and a user would see a spinner forever`,
        gvState.returnedToIdle === true && pnState.returnedToIdle === true);
    guard('noPageErrorsOnEitherSubject',
        'a page error escaped to the browser on one subject; the frontend reports a dead stream through its own error path, so an escaping error is a difference in handling',
        (gotavern.pageErrors ?? []).length === 0 && (pinned.pageErrors ?? []).length === 0);
    return { guards, problems, proven: problems.length === 0, gotavernTexts: gvTexts, pinnedTexts: pnTexts };
}

/**
 * THE CONTROL FOR THE HOP ITSELF: a pass-through leg pair, when supplied, must show MORE THAN ONE body
 * write. A hop that writes once in pass-through mode would mean node coalesced the peer's paced frames
 * and BOTH network surfaces measured the same thing -- the harness would be non-discriminating.
 */
function passThroughControl(gotavern, pinned) {
    const { guards, problems, guard } = guardsOf();
    const gvHop = gotavern.networkHop ?? {};
    const pnHop = pinned.networkHop ?? {};
    guard('passThroughProxyRelayedInPieces',
        `the pass-through hop issued ${gvHop.bodyWriteCount}/${pnHop.bodyWriteCount} write(s) instead of more than one on both subjects, so the buffering surface's single write is not a difference the hop made`,
        (gvHop.bodyWriteCount ?? 0) > 1 && (pnHop.bodyWriteCount ?? 0) > 1);
    return { guards, problems, proven: problems.length === 0 };
}

const main = async () => {
    const gotavern = await load(pairs.stream.gotavern);
    const pinned = await load(pairs.stream.pinned);
    const bufferedGotavern = await load(pairs.buffered.gotavern);
    const bufferedPinned = await load(pairs.buffered.pinned);
    const abortGotavern = await load(pairs.abort.gotavern);
    const abortPinned = await load(pairs.abort.pinned);

    const stream = streamSurface(gotavern, pinned);
    const baseline = {
        gotavernFinal: String(finalText(gotavern) ?? ''),
        pinnedFinal: String(finalText(pinned) ?? ''),
        gotavernTexts: stream.gotavernTexts,
        contentFrames: Math.max(0, Math.max(...framesWritten(gotavern), 0) - 1),
    };
    const buffered = bufferedSurface(bufferedGotavern, bufferedPinned, baseline);
    const abort = abortSurface(abortGotavern, abortPinned, baseline);
    const passthrough = pairs.passthrough
        ? passThroughControl(await load(pairs.passthrough.gotavern), await load(pairs.passthrough.pinned))
        : null;

    const comparison = {
        schemaVersion: 1,
        question: 'with a real hop between subject and peer, do both subjects still render incrementally, and do both report the same truncation and the same partial text when the network dies mid-stream?',
        captures: Object.fromEntries(Object.entries(pairs).map(([surface, legs]) => [surface, {
            gotavern: path.basename(legs.gotavern),
            pinned: path.basename(legs.pinned),
        }])),
        // WHAT THE HOP WAS, recorded so a reader can tell a 2-frame cut from a 14-frame stream without
        // reading the legs. These are the HOP's numbers, not the subject's.
        hop: {
            cutAfterFrames: abortGotavern.networkHop?.cutAfterFrames ?? null,
            cutAfterBytes: abortGotavern.networkHop?.cutAfterBytes ?? null,
            // THE CUT, PER SUBJECT: the gate recomputes networkCutBothSubjectsMidStream from these, so a
            // hand-edited verdict would contradict its own evidence.
            cut: { gotavern: abortGotavern.networkHop?.cut ?? null, pinned: abortPinned.networkHop?.cut ?? null },
            bufferedWrites: { gotavern: bufferedGotavern.networkHop?.bodyWriteCount ?? null, pinned: bufferedPinned.networkHop?.bodyWriteCount ?? null },
            releasedBytesUnderCut: { gotavern: abortGotavern.networkHop?.releasedBytes ?? null, pinned: abortPinned.networkHop?.releasedBytes ?? null },
            framesWritten: { gotavern: framesWritten(abortGotavern), pinned: framesWritten(abortPinned) },
            streamFramesWritten: { gotavern: framesWritten(gotavern), pinned: framesWritten(pinned) },
        },
        // THE PER-SUBJECT OBSERVATIONS THE GUARDS ARE COMPUTED FROM, stored so `verify-browser-comparisons`
        // can RECOMPUTE the guards instead of reading this file's own flags (invariants.mjs rule 1).
        observations: {
            stream: { gotavern: { texts: stream.gotavernTexts, finalText: finalText(gotavern), pageErrors: (gotavern.pageErrors ?? []).length }, pinned: { texts: stream.pinnedTexts, finalText: finalText(pinned), pageErrors: (pinned.pageErrors ?? []).length } },
            buffered: { gotavern: { texts: streamedTexts(bufferedGotavern), finalText: finalText(bufferedGotavern), pageErrors: (bufferedGotavern.pageErrors ?? []).length }, pinned: { texts: streamedTexts(bufferedPinned), finalText: finalText(bufferedPinned), pageErrors: (bufferedPinned.pageErrors ?? []).length } },
            abort: { gotavern: { texts: abort.gotavernTexts, finalText: finalText(abortGotavern), pageErrors: (abortGotavern.pageErrors ?? []).length }, pinned: { texts: abort.pinnedTexts, finalText: finalText(abortPinned), pageErrors: (abortPinned.pageErrors ?? []).length } },
        },
        streaming: { guards: stream.guards, failedGuards: Object.entries(stream.guards).filter(([, value]) => value !== true).map(([name]) => name), problems: stream.problems, proven: stream.proven },
        buffered: { guards: buffered.guards, failedGuards: Object.entries(buffered.guards).filter(([, value]) => value !== true).map(([name]) => name), problems: buffered.problems, proven: buffered.proven },
        abort: { guards: abort.guards, failedGuards: Object.entries(abort.guards).filter(([, value]) => value !== true).map(([name]) => name), problems: abort.problems, proven: abort.proven },
        ...(passthrough ? { passThroughControl: { guards: passthrough.guards, failedGuards: Object.entries(passthrough.guards).filter(([, value]) => value !== true).map(([name]) => name), problems: passthrough.problems, proven: passthrough.proven } } : {}),
        proven: stream.proven && buffered.proven && abort.proven && (passthrough ? passthrough.proven : true),
        notCompared: [
            'a real provider (AGENTS.md 22): the peer is a simulated backend that captures and answers; the hop is real TCP but loopback',
            'a real TLS connection: the mid-stream close here is a socket close on plain HTTP, so a TLS fatal alert or a reset from a middlebox is unobserved',
            'a real HTTP proxy with its own buffering policy: the hop buffers by construction rather than by configuration',
            'network timing jitter and loss: the hop paces nothing and drops nothing except at the cut point',
        ],
    };
    const text = JSON.stringify(comparison, null, 2);
    if (out) {
        // THE ARTEFACT IS WRITTEN EVEN WHEN A GUARD FAILS. A red artefact IS the evidence for the finding,
        // and the workflow's verifier must be able to read what failed.
        await fs.writeFile(out, text + '\n');
    } else {
        console.log(text);
    }
    if (!comparison.proven) {
        const failed = [
            ...comparison.streaming.failedGuards,
            ...comparison.buffered.failedGuards,
            ...comparison.abort.failedGuards,
            ...(passthrough ? comparison.passThroughControl.failedGuards : []),
        ];
        console.error(`streaming framing comparison failed: ${failed.join(', ')}`);
        for (const surface of ['streaming', 'buffered', 'abort', ...(passthrough ? ['passThroughControl'] : [])]) {
            for (const problem of comparison[surface].problems) {
                console.error(`  ${surface}: ${problem}`);
            }
        }
        process.exit(1);
    }
    console.error('streaming framing comparison: every guard true on all three surfaces');
};

await main();
