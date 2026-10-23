#!/usr/bin/env node
// Compare the browser-leg streaming, cancellation and non-streaming drives between GoTavern and the
// pinned server. Inputs are six generation-probe reports produced by the SAME probe script with
// PROBE_MODE=stream|cancel or unset (non-streaming control):
//
//   node compare-streaming-legs.mjs \
//     stream-gotavern.json stream-pinned.json \
//     cancel-gotavern.json cancel-pinned.json \
//     nonstream-gotavern.json nonstream-pinned.json
//
// Output: a JSON verdict (stdout). A mode is "proven" only when every check in it holds on BOTH
// legs; `compatibleReady` is the conjunction, and is what a `compatible` row may be proposed from.

import fs from 'node:fs/promises';
import process from 'node:process';

const [streamGotavernPath, streamPinnedPath, cancelGotavernPath, cancelPinnedPath, nonstreamGotavernPath, nonstreamPinnedPath] = process.argv.slice(2);
if (!streamGotavernPath || !streamPinnedPath || !cancelGotavernPath || !cancelPinnedPath || !nonstreamGotavernPath || !nonstreamPinnedPath) {
    console.error('usage: node compare-streaming-legs.mjs <stream-gotavern.json> <stream-pinned.json> <cancel-gotavern.json> <cancel-pinned.json> <nonstream-gotavern.json> <nonstream-pinned.json>');
    process.exit(2);
}

const load = async file => JSON.parse(await fs.readFile(file, 'utf8'));

const providerRequests = report => (report.recording ?? []).map(request => ({
    method: request.method,
    path: request.path,
    bodyLength: request.bodyLength,
    bodySha256: request.bodySha256,
    clientDisconnected: request.clientDisconnected === true,
    framesWritten: request.framesWritten ?? null,
}));

const renderTexts = report => (report.postSend?.renderSnapshots ?? []).map(snapshot => snapshot.text);

const requestBodyStream = report => {
    const request = (report.recording ?? []).find(entry => entry.method === 'POST' && entry.body);
    if (!request) return null;
    try {
        return JSON.parse(request.body).stream;
    } catch {
        return null;
    }
};

const isPrefixSequence = texts => texts.every((text, index) => index === 0 || text.startsWith(texts[index - 1]));

// The DOM history legitimately contains non-content states: the sent user message, the assistant
// placeholder ('…'), and (after an abort) an empty message. Only the streamed content states form
// the prefix chain that incremental rendering must produce.
const streamedTexts = report => renderTexts(report).filter(text => text && text !== '…' && text !== 'probe user marker');

const compareMode = (gotavern, pinned, { expectClientDisconnected, expectStreamFlag }) => {
    const gotavernRequests = providerRequests(gotavern);
    const pinnedRequests = providerRequests(pinned);
    const checks = {
        requestArrivedBoth: gotavern.requestArrived === true && pinned.requestArrived === true,
        providerRequestCountEqual: gotavernRequests.length === pinnedRequests.length,
        providerRequestMethodsAndPathsEqual: JSON.stringify(gotavernRequests.map(request => `${request.method} ${request.path}`)) === JSON.stringify(pinnedRequests.map(request => `${request.method} ${request.path}`)),
        providerBodyEqual: JSON.stringify(gotavernRequests.map(request => [request.bodyLength, request.bodySha256])) === JSON.stringify(pinnedRequests.map(request => [request.bodyLength, request.bodySha256])),
        finalTextEqual: (gotavern.postSend?.finalAssistantText ?? null) === (pinned.postSend?.finalAssistantText ?? null),
        // EQUAL IS NOT ENOUGH WHEN BOTH ARE EMPTY. A stream neither leg can parse renders nothing, and
        // `finalTextEqual` alone calls that agreement: two servers that BOTH fail to decode the framing
        // would compare EQUAL and the drive would look proven while the surface rendered nothing. This
        // check is what makes "the leg streamed" mean text, not merely parity.
        finalTextNonEmpty: String(gotavern.postSend?.finalAssistantText ?? '').trim().length > 0 && String(pinned.postSend?.finalAssistantText ?? '').trim().length > 0,
        // TICK ALIGNMENT IS RECORDED, NOT ASSERTED. Measured twice with the SAME build: GoTavern's third
        // render tick was "Hello from" in one run and "Hello from the" in the next, while pinned produced
        // "Hello from the" both times. A boundary that moves on ONE leg across repeats is a coalescing
        // race, not a contract (rule 18) -- and the properties alignment was reaching for are asserted
        // directly: streamedRenderPrefixes (each leg grows monotonically), finalTextEqual, and
        // framesWrittenEqual (both legs applied the same number of chunks). The raw sequences stay in
        // `renderTexts` and their alignment in `renderTickAlignment`, for a reader to inspect.
        streamedRenderPrefixes: isPrefixSequence(streamedTexts(gotavern)) && isPrefixSequence(streamedTexts(pinned)),
        // EQUAL AND EMPTY IS NOT A PASS. For a STREAM this can fail because of the PEER'S FRAMING: a claude
        // stream the page cannot parse renders nothing and would otherwise compare equal on both legs.
        finalTextNonEmpty: typeof gotavern.postSend?.finalAssistantText === 'string' && gotavern.postSend.finalAssistantText.length > 0
            && typeof pinned.postSend?.finalAssistantText === 'string' && pinned.postSend.finalAssistantText.length > 0,
        pagesHaveNoErrors: (gotavern.pageErrors ?? []).length === 0 && (pinned.pageErrors ?? []).length === 0,
    };
    if (expectStreamFlag !== undefined) {
        checks.requestStreamFlagMatches = requestBodyStream(gotavern) === expectStreamFlag && requestBodyStream(pinned) === expectStreamFlag;
    }
    if (expectClientDisconnected !== undefined) {
        checks.clientDisconnectedMatches = gotavernRequests.every(request => request.clientDisconnected === expectClientDisconnected) && pinnedRequests.every(request => request.clientDisconnected === expectClientDisconnected);
    }
    return {
        gotavern: {
            providerRequests: gotavernRequests,
            renderTexts: renderTexts(gotavern),
            finalAssistantText: gotavern.postSend?.finalAssistantText ?? null,
            streamState: gotavern.streamState ?? null,
        },
        pinned: {
            providerRequests: pinnedRequests,
            renderTexts: renderTexts(pinned),
            finalAssistantText: pinned.postSend?.finalAssistantText ?? null,
            streamState: pinned.streamState ?? null,
        },
        checks,
        renderTickAlignment: { tickByTickEqual: JSON.stringify(renderTexts(gotavern)) === JSON.stringify(renderTexts(pinned)), note: 'recorded, not asserted: the tick boundary races on a single leg across repeats' },
        proven: Object.values(checks).every(Boolean),
    };
};

const main = async () => {
    const [streamGotavern, streamPinned, cancelGotavern, cancelPinned, nonstreamGotavern, nonstreamPinned] = await Promise.all([
        load(streamGotavernPath), load(streamPinnedPath),
        load(cancelGotavernPath), load(cancelPinnedPath),
        load(nonstreamGotavernPath), load(nonstreamPinnedPath),
    ]);

    const streaming = compareMode(streamGotavern, streamPinned, { expectClientDisconnected: false, expectStreamFlag: true });
    // Streaming must additionally show INCREMENTAL rendering: more than the placeholder and the final
    // text, and the sequence must grow monotonically.
    streaming.checks.incrementalRenderingObserved =
        streamedTexts(streamGotavern).length >= 3 &&
        streamedTexts(streamPinned).length >= 3 &&
        streamGotavern.streamState?.sawIncremental === true &&
        streamPinned.streamState?.sawIncremental === true;
    streaming.checks.framesWrittenEqual =
        JSON.stringify(providerRequests(streamGotavern).map(request => request.framesWritten)) === JSON.stringify(providerRequests(streamPinned).map(request => request.framesWritten));
    streaming.proven = Object.values(streaming.checks).every(Boolean);

    const cancellation = compareMode(cancelGotavern, cancelPinned, { expectClientDisconnected: true, expectStreamFlag: true });
    // Cancellation-specific checks. `framesWritten` depends on WHEN the abort lands relative to the
    // peer's writes, so it is recorded but not part of the proof (it is timing, not behaviour).
    cancellation.checks.contentRenderedBeforeAbort =
        cancelGotavern.streamState?.sawIncremental === true &&
        cancelPinned.streamState?.sawIncremental === true &&
        (cancelGotavern.streamState?.contentSnapshotsBeforeEnd ?? 0) >= 1 &&
        (cancelPinned.streamState?.contentSnapshotsBeforeEnd ?? 0) >= 1;
    cancellation.checks.noFurtherChunksAppliedAfterAbort =
        cancelGotavern.streamState?.textAfterStop === cancelGotavern.streamState?.textLater &&
        cancelPinned.streamState?.textAfterStop === cancelPinned.streamState?.textLater &&
        cancelGotavern.streamState?.snapshotsAtStopPlus1200 === cancelGotavern.streamState?.snapshotsLater &&
        cancelPinned.streamState?.snapshotsAtStopPlus1200 === cancelPinned.streamState?.snapshotsLater;
    cancellation.checks.abortControlUsed = cancelGotavern.streamState?.stopPresent === true && cancelPinned.streamState?.stopPresent === true;
    // THE ABORT LANDS ON A RENDER TICK, AND THE TICK MOVES ACROSS REPEATS ON THE SAME LEG.
    //
    // Measured for mistralai, three runs per leg, every one with framesWritten 14 and
    // clientDisconnected true: GoTavern rendered "Hello from", "Hello from the stream", "Hello from the
    // stream?"; pinned rendered "Hello from the", "Hello from", "Hello from". A quantity that moves on ONE
    // leg across repeats is a coalescing race, not a contract (rule 18) -- the same reasoning this file
    // already applies to framesWritten ("it is timing, not behaviour") and to renderTickAlignment.
    // Comparing the post-abort TEXT across legs is that same racing quantity by another name, so it is
    // RECORDED below and replaced in the proof by two stable contract assertions:
    //   - the aborted text is a non-empty PREFIX of the reply both legs stream when not aborted (an abort
    //     mid-stream must leave a prefix of the reply, never garbage and never nothing);
    //   - each leg's final text equals ITS OWN after-abort state, so nothing is rewritten once stopped.
    delete cancellation.checks.finalTextEqual;
    const streamedReply = String(streamGotavern.postSend?.finalAssistantText ?? '');
    const abortedText = report => String(report.postSend?.finalAssistantText ?? '');
    const abortedIsPrefix = report => abortedText(report).trim().length > 0 && streamedReply.startsWith(abortedText(report));
    cancellation.checks.abortTextIsPrefixOfStreamedReply = streamedReply.length > 0 && abortedIsPrefix(cancelGotavern) && abortedIsPrefix(cancelPinned);
    cancellation.checks.finalTextEqualsAfterAbortState =
        (cancelGotavern.postSend?.finalAssistantText ?? null) === (cancelGotavern.streamState?.textLater ?? null) &&
        (cancelPinned.postSend?.finalAssistantText ?? null) === (cancelPinned.streamState?.textLater ?? null);
    cancellation.abortRenderState = {
        gotavern: { text: abortedText(cancelGotavern), framesWritten: providerRequests(cancelGotavern).map(request => request.framesWritten) },
        pinned: { text: abortedText(cancelPinned), framesWritten: providerRequests(cancelPinned).map(request => request.framesWritten) },
        note: 'recorded, not asserted: the abort lands on a render tick that moves on a single leg across repeats (measured: three runs per leg, 14 frames each, three different prefixes on GoTavern and two on pinned), so cross-leg equality of this text is timing rather than behaviour',
    };
    cancellation.proven = Object.values(cancellation.checks).every(Boolean);

    const nonstream = compareMode(nonstreamGotavern, nonstreamPinned, { expectStreamFlag: false });
    nonstream.checks.singleContentStateOnly = streamedTexts(nonstreamGotavern).length === 1 && streamedTexts(nonstreamPinned).length === 1;
    nonstream.proven = Object.values(nonstream.checks).every(Boolean);

    const comparison = {
        schemaVersion: 1,
        // WHICH DRIVE PRODUCED THIS. The custom artifact (streaming-comparison.json) recorded 9 render
    // snapshots per leg, so it was measured at a different paced frame count than this one; a reader
    // comparing the two documents must be able to see that they describe different drives rather than
    // assume the same one. Frame count comes from PROBE_FRAME_COUNT (the peer's default is 5 for a stream
    // and 12 for a cancel), and the OpenRouter legs below were driven at 14.
    driveParameters: {
        streamFrameCount: process.env.PROBE_FRAME_COUNT ?? 'peer default (5 stream / 12 cancel)',
        customArtifactFrameCount: 'different: streaming-comparison.json records 9 render snapshots per leg, so the two documents describe different drives and neither supersedes the other',
            ...(process.env.PROBE_SOURCE === 'chutes' ? {
                sourceShape: "CHUTES forwards messages VERBATIM, with `top_k` and `logit_bias` members no sibling source sends: the recorded provider body IS the evidence, and the artifact carries its digest rather than a re-shaped copy. This is the case that makes a shared-helper implementation look correct and be wrong: a source whose MESSAGE side has no processor at all cannot be served by a helper that quietly reshapes messages for its siblings, and the recorded body digest is what would catch it.",
            } : {}),
            ...(process.env.PROBE_SOURCE === 'electronhub' ? {
                sourceShape: "ELECTRONHUB HAS NO reverse_proxy SUPPORT AT ALL: its route is a bare literal and always reads the ELECTRONHUB secret, so a request carrying a proxy is IGNORED rather than proxied. `proxyPasswordPresent: false` on both legs therefore means UNSUPPORTED, not unused, and the artifact says so because a reader would otherwise read the false as \"proxy available and untouched\".",
            } : {}),

        // See the generation comparator: openrouter is proxy:false with a pinned literal, so the seam and
        // the redirect are the only route and proxyPasswordPresent false on both legs is the evidence.
        // See the generation comparator: claude is proxy-capable and no-validate, so the peer travels in
        // reverse_proxy and NO /models call may appear on either leg.
        ...(process.env.PROBE_SOURCE === 'claude' ? {
            seamEnvVar: 'GOTAVERN_CLAUDE_CHAT_URL',
            peerRoute: 'the frontend reverse_proxy setting, followed by BOTH legs, because claude is proxy-capable',
            seamUsage: 'safety net only: the seam is aimed so a leg preferring the pinned literal cannot reach the real provider, but the route is the setting',
            noValidate: 'claude must record ZERO /models calls on both legs; a status call is the harness bug, not a product finding',
        } : {}),
        ...(process.env.PROBE_SOURCE === 'openrouter' ? {
            seamEnvVar: 'GOTAVERN_OPENROUTER_CHAT_URL',
            peerRoute: 'the seam on the GoTavern leg and the openrouter.ai transport redirect on the pinned leg, because no request member can carry a peer for this source',
            proxyPasswordMeaning: 'proxyPasswordPresent false on BOTH legs is the evidence that seam plus redirect were the only route to the peer',
        } : {}),
        ...(process.env.PROBE_SOURCE === 'groq' || process.env.PROBE_SOURCE === 'siliconflow' || process.env.PROBE_SOURCE === 'nanogpt' || process.env.PROBE_SOURCE === 'deepseek' ? {
            // NAMED PER SOURCE, for the same reason as the generation artifact: the seam that aimed
            // this leg must be the one recorded.
            seamEnvVar: { groq: 'GOTAVERN_GROQ_CHAT_URL', siliconflow: 'GOTAVERN_SILICONFLOW_CHAT_URL', nanogpt: 'GOTAVERN_NANOGPT_CHAT_URL', deepseek: 'GOTAVERN_DEEPSEEK_CHAT_URL', aimlapi: 'GOTAVERN_AIMLAPI_CHAT_URL', ai21: 'GOTAVERN_AI21_CHAT_URL' }[process.env.PROBE_SOURCE] ?? null,
            // THE TWO FACTS A READER CANNOT RECONSTRUCT FROM THESE NUMBERS. Both were measured the hard
            // way in this lane, and they belong in the artifact rather than in a message about it.
            pinnedRedirectRequired: 'PROBE_PINNED_REDIRECT_FILE is NOT optional for a source the frontend marks proxy:false. Without it run-against-pinned.mjs installs no transport redirect hook, the pinned server fetches the REAL provider, and the peer log stays EMPTY -- which reads exactly like a product hang or a product defect, and did for two rounds here. The seam named in seamEnvVar aims the GoTavern leg and the redirect aims the pinned leg; both are required, and proxyPasswordPresent false on BOTH legs is the evidence that neither leg could have reached a peer through a reverse proxy instead.',
            // SILICONFLOW'S ENDPOINT IS A BODY FIELD: the drive selects the DEFAULT through the
            // frontend's own control and the seam aims that host. The CN endpoint is not measured.
            ...(process.env.PROBE_SOURCE === 'siliconflow' ? {
                endpointMode: 'global (selected through #siliconflow_endpoint, the control a user sets)',
                endpointBreadth: 'the DEFAULT endpoint only; the CN host is a second supported endpoint and is not exercised by this drive',
            } : {}),
            peerKeying: 'the scripted mock provider matches POSITIONALLY and fails in BOTH directions, so the COUNT of model-list answers is not the axis: with ONE entry the pinned generate never arrives (the second status call consumes it and the send is refused with online_status no_connection); with THREE the generate arrives but receives a MODELS body and renders an empty string while the other leg renders text -- an equal-empty that finalTextNonEmpty exists to catch. This drive therefore uses a peer that answers by REQUEST (GET -> model list every time, completion POST -> completion, SSE when streaming and JSON when not), which is correct for any number of status calls.',
        } : {}),
        // OPENAI: the same seam/redirect pair as the generation artifact, and the same measured fact -- openai IS
        // proxy:true, so the absent reverse_proxy is a deliberate drive choice, not a control the frontend lacks.
        ...(process.env.PROBE_SOURCE === 'openai' ? {
            seamEnvVar: 'GOTAVERN_OPENAI_CHAT_URL',
            proxySettingDeliberatelyUnset: 'apiSourceConfig marks openai proxy:true, so oai_settings.reverse_proxy was available and deliberately left unset; proxyPasswordPresent false on both legs is the measurement, not an assumption',
            pinnedRedirectRequired: 'PROBE_PINNED_REDIRECT_FILE aims the pinned leg at the same peer the seam aims the GoTavern leg at; without it the pinned server fetches api.openai.com and the peer log stays empty',
        } : {}),

    },
    question: 'do the same browser drives produce identical streaming, cancellation and non-streaming observations on GoTavern and pinned?',
        captures: { streamGotavern: streamGotavernPath, streamPinned: streamPinnedPath, cancelGotavern: cancelGotavernPath, cancelPinned: cancelPinnedPath, nonstreamGotavern: nonstreamGotavernPath, nonstreamPinned: nonstreamPinnedPath },
        streaming,
        cancellation,
        nonstream,
        compatibleReady: streaming.proven && cancellation.proven && nonstream.proven,
    // DID THE CREDENTIAL TRAVEL, measured rather than asserted in prose. With a reverse proxy set the
    // server reads body.proxy_password and NOT the source secret, so a source the frontend marks
    // proxy:false must show FALSE on both legs -- which is the evidence that both legs reached the peer
    // through the seam and the redirect rather than through a reverse-proxy credential. Recorded as a
    // BOOLEAN from the streamed drives, never as the value.
    proxyPasswordPresent: {
        gotavern: (streamGotavern.generateCalls ?? [])[0]?.proxyPasswordPresent ?? null,
        pinned: (streamPinned.generateCalls ?? [])[0]?.proxyPasswordPresent ?? null,
    },
        notes: [
            'The probe previously awaited response.clone().text() for EVERY response before returning it to the frontend, so a streamed generate response was fully buffered before the fetch promise resolved: incremental rendering was impossible to observe and an aborted stream observed an empty message. That was a probe defect on both legs (rule 10), fixed by skipping the clone read for text/event-stream and for the generate route. Earlier captures in this directory were taken with that defect; these captures are not.',
            'The peer records clientDisconnected only when the caller closes before the scripted stream finishes; it is the provider-side proof of cancellation.',
            'framesWritten in cancellation mode depends on how many paced frames were written before the abort arrived, so it is recorded for information, not asserted.',
            'Pinned emits extra prompt-manager dry generations (visible as duplicate GENERATE_AFTER_DATA dryRun=true entries); they never issue a provider request and are not part of the comparison.',
        ],
    };
    console.log(JSON.stringify(comparison, null, 2));
};

await main();
