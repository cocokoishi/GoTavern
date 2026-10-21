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
        renderSequenceEqual: JSON.stringify(renderTexts(gotavern)) === JSON.stringify(renderTexts(pinned)),
        streamedRenderPrefixes: isPrefixSequence(streamedTexts(gotavern)) && isPrefixSequence(streamedTexts(pinned)),
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
    cancellation.checks.finalTextEqualsAfterAbortState = (cancelGotavern.postSend?.finalAssistantText ?? null) === (cancelPinned.postSend?.finalAssistantText ?? null);
    cancellation.proven = Object.values(cancellation.checks).every(Boolean);

    const nonstream = compareMode(nonstreamGotavern, nonstreamPinned, { expectStreamFlag: false });
    nonstream.checks.singleContentStateOnly = streamedTexts(nonstreamGotavern).length === 1 && streamedTexts(nonstreamPinned).length === 1;
    nonstream.proven = Object.values(nonstream.checks).every(Boolean);

    const comparison = {
        schemaVersion: 1,
        question: 'do the same browser drives produce identical streaming, cancellation and non-streaming observations on GoTavern and pinned?',
        captures: { streamGotavern: streamGotavernPath, streamPinned: streamPinnedPath, cancelGotavern: cancelGotavernPath, cancelPinned: cancelPinnedPath, nonstreamGotavern: nonstreamGotavernPath, nonstreamPinned: nonstreamPinnedPath },
        streaming,
        cancellation,
        nonstream,
        compatibleReady: streaming.proven && cancellation.proven && nonstream.proven,
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
