#!/usr/bin/env node
// The streaming framing comparator's TEETH, shown in a second instead of eighteen minutes.
//
// WHY THIS EXISTS. `compare-streaming-framing.mjs` is only run by a browser differential (three drive
// pairs on two subjects, ~20 minutes), so a mutation in one of its guards would otherwise need a full
// dispatch to observe. Worse, some of the most important assertions CANNOT be produced by a correct
// server at all -- the abort surface's "same truncation, same partial text" only has content when the
// network really dies -- so the hand-made artefact is the only input that reaches them.
//
// WHAT IT DOES, per case: writes synthetic leg reports into a temp directory, runs the REAL comparator
// against them, and asserts (a) the exit status and (b) the EXACT guard name that failed. Nothing is
// stubbed inside the comparator: the file CI runs is the file under test, which is how a guard whose
// formula changed is caught here too.
//
// THE CASES ARE THE MUTATION SET FROM THE COMMIT, kept as code so they cannot rot: the commit message
// quotes the guard each one turns red, and this file is where that claim is executable.
//
// Run: node tests/browser/streaming-framing-selftest.mjs

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const comparator = path.join(here, 'compare-streaming-framing.mjs');

// FITTED TO THE PROBE'S ARITHMETIC: `PROBE_FRAME_COUNT=14` writes fourteen CONTENT frames (the peer's
// `wordCount` loop) plus one terminal frame with empty content, so the peer records 15 frames written and
// the comparator reads 14 content frames from that count.
const WORDS = ['Hello', ' from', ' the', ' stream', '?', ' incremental', ' rendering', ' is', ' genuinely', ' observed', ' and', ' paced', ' by', ' the'];
const renderStates = count => WORDS.slice(0, count).map((_, index) => WORDS.slice(0, index + 1).join(''));
const fullText = WORDS.join('');
const PARTIAL = renderStates(3).at(-1);

/** One synthetic leg: what the probe would have written, with the hop record the scenario needs. */
function leg({ texts, finalAssistantText, hop, framesWritten = 15, clientDisconnected = false, pageErrors = [], streamState = {} }) {
    return {
        pageErrors,
        streamState: { sawIncremental: true, contentSnapshotsBeforeEnd: Math.max(1, texts.length), stopClickedAt: null, ...streamState },
        recording: [{
            method: 'POST',
            path: '/chat/completions',
            bodyLength: 7400,
            body: JSON.stringify({ model: 'probe-model', stream: true }),
            bodySha256: 'a'.repeat(64),
            clientDisconnected,
            framesWritten,
        }],
        postSend: {
            renderSnapshots: [...texts.map(text => ({ t: 1000, text })), { t: 2000, text: finalAssistantText }]
                .filter((snapshot, index, all) => index === 0 || snapshot.text !== all[index - 1].text),
            finalAssistantText,
        },
        networkHop: hop,
    };
}

const relayedHop = () => ({
    mode: 'pass-through', cutArmOnPath: '/chat/completions', cutAfterBytes: 0, cut: null,
    bodyWriteCount: 14,
    bodyWrites: Array.from({ length: 14 }, () => ({ bytes: 180, frames: 1 })),
    forwarded: [{ method: 'POST', path: '/chat/completions', bodyBytes: 7400, bodySha256: 'a'.repeat(64) }],
    releasedBytes: 2600, cutArmedResponses: 0, relayedWholeResponses: 2, gzipFramedResponses: 0,
});
const cutHop = () => ({
    mode: 'cut', cutArmOnPath: '/chat/completions', cutAfterBytes: 513, cut: 'cut-after-bytes',
    anyCut: 'cut-after-bytes', cutsPerformed: 1,
    // A CUT AFTER THREE COMPLETE FRAMES RELEASES A POSITIVE PREFIX: 349 bytes in the measured run, from a
    // script the peer wrote in full. The fixture must describe the SAME vehicle the workflow drives, or the
    // healthy baseline describes a surface the hop no longer produces.
    bodyWriteCount: 8,
    bodyWrites: Array.from({ length: 8 }, () => ({ bytes: 44, frames: 1 })),
    forwarded: [{ method: 'POST', path: '/chat/completions', bodyBytes: 7400, bodySha256: 'a'.repeat(64) }],
    releasedBytes: 349, releasedAtCut: 349, cutArmedResponses: 1, relayedWholeResponses: 1, gzipFramedResponses: 0,
});
const directHop = () => ({ mode: null, absent: true });

/** The healthy baseline: every guard true on all three surfaces. Each case is one mutation of this. */
function baseline() {
    const whole = () => leg({ texts: renderStates(14), finalAssistantText: fullText, hop: directHop() });
    return {
        stream: { gotavern: whole(), pinned: whole() },
        relayed: {
            gotavern: leg({ texts: renderStates(14), finalAssistantText: fullText, hop: relayedHop() }),
            pinned: leg({ texts: renderStates(14), finalAssistantText: fullText, hop: relayedHop() }),
        },
        abort: {
            gotavern: leg({
                texts: renderStates(3),
                finalAssistantText: PARTIAL,
                hop: cutHop(),
                framesWritten: 15,
                // THE MEASURED TERMINAL OF A CUT AFTER COMPLETE FRAMES: the peer sees the client go, and
                // the page is left generating with the stop button up on BOTH subjects (isGenerating true,
                // returnedToIdle false). The fixture must describe the vehicle the workflow drives.
                clientDisconnected: true,
                streamState: { textAfterCut: PARTIAL, textLater: PARTIAL, returnedToIdle: false },
            }),
            pinned: leg({
                texts: renderStates(3),
                finalAssistantText: PARTIAL,
                hop: cutHop(),
                framesWritten: 15,
                // THE MEASURED TERMINAL OF A CUT AFTER COMPLETE FRAMES: the peer sees the client go, and
                // the page is left generating with the stop button up on BOTH subjects (isGenerating true,
                // returnedToIdle false). The fixture must describe the vehicle the workflow drives.
                clientDisconnected: true,
                streamState: { textAfterCut: PARTIAL, textLater: PARTIAL, returnedToIdle: false },
            }),
        },
    };
}

const scenarioDir = mkdtempSync(path.join(os.tmpdir(), 'q19-framing-selftest-'));
const write = (name, value) => {
    const file = path.join(scenarioDir, name);
    writeFileSync(file, JSON.stringify(value, null, 2));
    return file;
};

/** Runs the real comparator over one set of six legs. `label` keeps each case's artefact distinct: a
 *  shared output file meant the second case read the FIRST case's artefact when the comparator exited
 *  before writing (measured: every case reported `records []`), which would have made this file claim the
 *  guards had no teeth while they were in fact biting. */
function run(legs, label) {
    const args = ['--stream', write('s-go.json', legs.stream.gotavern), write('s-pin.json', legs.stream.pinned),
        '--relayed', write('r-go.json', legs.relayed.gotavern), write('r-pin.json', legs.relayed.pinned),
        '--abort', write('a-go.json', legs.abort.gotavern), write('a-pin.json', legs.abort.pinned)];
    const out = path.join(scenarioDir, `out-${label}.json`);
    const result = spawnSync(process.execPath, [comparator, ...args, '--out', out], { encoding: 'utf8' });
    let artifact = null;
    try {
        artifact = JSON.parse(readFileSync(out, 'utf8'));
    } catch {
        artifact = null;
    }
    return { status: result.status, stderr: result.stderr ?? '', artifact };
}

const failedGuards = artifact => {
    if (!artifact) return [];
    return ['stream', 'relayed', 'abort'].flatMap(surface => (artifact[surface]?.failedGuards ?? []).map(name => ({ surface, name })));
};

const cases = [];
const addCase = (description, mutate, expected) => cases.push({ description, mutate, expected });

// ---- 1. THE BASELINE MUST BE GREEN, or every case below is measuring the baseline's own redness. ------
addCase('the healthy artefact passes every guard on all three surfaces', () => {}, null);

// ---- 2. THE HOP MUST HAVE RELAYED, not assembled. -----------------------------------------------------
addCase('a hop that assembled the body (one write) fails the relay evidence guard',
    legs => {
        legs.relayed.gotavern.networkHop.bodyWriteCount = 1;
        legs.relayed.gotavern.networkHop.bodyWrites = [{ bytes: 2577, frames: 15 }];
    },
    { surface: 'relayed', name: 'hopRelayedInMoreThanOneWrite' });
addCase('a hop that relayed fewer frames than the peer wrote is caught',
    legs => {
        legs.relayed.pinned.networkHop.bodyWrites = [{ bytes: 300, frames: 3 }];
    },
    { surface: 'relayed', name: 'hopRelayedEveryFrame' });
addCase('different request bytes forwarded by the hop are caught',
    legs => {
        legs.relayed.pinned.networkHop.forwarded[0].bodySha256 = 'b'.repeat(64);
    },
    { surface: 'relayed', name: 'hopForwardedIdenticalRequestBytes' });
addCase('a hop that forwarded bytes the peer did not record is caught',
    legs => {
        legs.relayed.gotavern.recording[0].bodyLength = 7399;
    },
    { surface: 'relayed', name: 'hopForwardedWhatThePeerReceived' });
addCase('text that differs through the hop from the direct connection is caught',
    legs => {
        legs.relayed.pinned.postSend.finalAssistantText = `${fullText} extra`;
    },
    { surface: 'relayed', name: 'relayedFinalTextEqualsTheDirectStream' });
addCase('a leg of the direct surface that crossed a hop is caught',
    legs => {
        legs.stream.pinned.networkHop = relayedHop();
    },
    { surface: 'stream', name: 'noHopOnTheDirectSurface' });
addCase('a cut during the relayed surface is caught',
    legs => {
        legs.relayed.gotavern.networkHop.cut = 'cut-after-bytes';
    },
    { surface: 'relayed', name: 'noCutInTheRelayedSurface' });

// ---- 3. THE FAULT MUST BE THE NETWORK'S. -------------------------------------------------------------
addCase('a cut that did not happen fails the network-cut guard',
    legs => {
        legs.abort.pinned.networkHop.anyCut = null;
        legs.abort.pinned.networkHop.cut = null;
    },
    { surface: 'abort', name: 'hopCutBothSubjectsMidStream' });
addCase('a cut on the reachability check instead of the completion is caught',
    legs => {
        legs.abort.pinned.networkHop.relayedWholeResponses = 0;
    },
    { surface: 'abort', name: 'hopRelayedTheReachabilityCheckWhole' });
addCase('a head cut that relayed body bytes is not a head cut, and is caught',
    legs => {
        legs.abort.pinned.networkHop.releasedBytes = 0;
    },
    { surface: 'abort', name: 'hopReleasedSomeBodyBeforeTheCut' });
addCase('a peer that recorded a client disconnect makes this cancellation, and is caught',
    legs => {
        // THE PEER MUST SEE THE CLIENT GO; making it see ONLY the connect and never the disconnect
        // is the mutation. (The old case set this true to simulate cancellation, which is what the
        // codec did under a head cut -- the opposite expectation.)
        legs.abort.gotavern.recording[0].clientDisconnected = false;
    },
    { surface: 'abort', name: 'peerSawTheClientDisconnect' });
addCase('a stop click in the abort surface is caught',
    legs => {
        legs.abort.gotavern.streamState.stopClickedAt = 1234;
    },
    { surface: 'abort', name: 'noCallerCancelOnEitherSubject' });
addCase('a head cut that leaked a body byte is caught',
    legs => {
        legs.abort.gotavern.networkHop.releasedBytes = 0;
    },
    { surface: 'abort', name: 'hopReleasedSomeBodyBeforeTheCut' });

// ---- 4. THE ROW'S TWO CLAIMS. ------------------------------------------------------------------------
addCase('nothing rendered before the cut is caught',
    legs => {
        legs.abort.pinned.postSend.renderSnapshots = [];
        legs.abort.pinned.postSend.finalAssistantText = null;
    },
    { surface: 'abort', name: 'contentRenderedBeforeTheCutOnBoth' });
addCase('different partial text on the two subjects is caught',
    legs => {
        legs.abort.pinned.postSend.finalAssistantText = renderStates(2).at(-1);
        legs.abort.pinned.postSend.renderSnapshots = [{ t: 1000, text: renderStates(2).at(-1) }];
    },
    { surface: 'abort', name: 'partialTextIdenticalOnBothSubjects' });
addCase('a partial text that is not a proper prefix of the whole reply is caught',
    legs => {
        legs.abort.gotavern.postSend.finalAssistantText = 'something the provider never sent';
        legs.abort.gotavern.postSend.renderSnapshots = [{ t: 1000, text: 'something the provider never sent' }];
        legs.abort.pinned.postSend.finalAssistantText = 'something the provider never sent';
        legs.abort.pinned.postSend.renderSnapshots = [{ t: 1000, text: 'something the provider never sent' }];
    },
    { surface: 'abort', name: 'partialTextIsAProperPrefixOfTheWholeReply' });
addCase('a truncation that landed at a different byte on the two subjects is caught',
    legs => {
        legs.abort.pinned.networkHop.releasedBytes = 400;
    },
    { surface: 'abort', name: 'sameReleasedByteCountOnBothSubjects' });
    // A DIFFERENT BYTE COUNT IS THE sameReleasedByteCountOnBothSubjects GUARD'S JOB, not the
    // 'released something' guard's: the mutation makes both subjects release a positive prefix, and
    // only their EQUALITY is violated.
addCase('a subject that keeps rendering after the cut is caught',
    legs => {
        legs.abort.gotavern.streamState.textLater = `${PARTIAL} extra`;
    },
    { surface: 'abort', name: 'noFurtherChunksAppliedAfterTheCut' });
addCase('a subject that never returns to idle after the cut is caught',
    legs => {
        legs.abort.pinned.streamState.returnedToIdle = true;
    },
    { surface: 'abort', name: 'bothSubjectsLeftGeneratingWithTheStopButtonUp' });
addCase('a page error escaping on one subject is caught',
    legs => {
        legs.abort.gotavern.pageErrors = ['TypeError: undefined is not a function'];
    },
    { surface: 'abort', name: 'noPageErrorsOnEitherSubject' });

// ---- 5. THE DIRECT SURFACE'S RENDER PROPERTIES. ------------------------------------------------------
addCase('a subject that renders nothing on the direct surface is caught',
    legs => {
        legs.stream.gotavern.postSend.renderSnapshots = [];
        legs.stream.gotavern.postSend.finalAssistantText = null;
    },
    { surface: 'stream', name: 'everySubjectAppliedAtLeastOneContentFrame' });
addCase('a subject that rewrote settled text (non-monotonic render) is caught',
    legs => {
        legs.stream.gotavern.postSend.renderSnapshots = [
            { t: 1, text: 'Hello from the' }, { t: 2, text: 'Hello from' }, { t: 3, text: fullText },
        ];
    },
    { surface: 'stream', name: 'renderAdvancedMonotonicallyOnBoth' });
addCase('a subject that applied more states than the peer wrote frames is caught',
    legs => {
        legs.stream.pinned.postSend.renderSnapshots = Array.from({ length: 20 }, (_, index) => ({ t: index, text: `state ${index}` }));
        legs.stream.pinned.postSend.finalAssistantText = 'state 19';
    },
    { surface: 'stream', name: 'renderedStatesNeverExceedContentFrames' });
addCase('equal-and-empty final text on both subjects is caught',
    legs => {
        legs.stream.gotavern.postSend.finalAssistantText = '';
        legs.stream.gotavern.postSend.renderSnapshots = [];
        legs.stream.pinned.postSend.finalAssistantText = '';
        legs.stream.pinned.postSend.renderSnapshots = [];
    },
    { surface: 'stream', name: 'finalTextEqualAndNonEmpty' });
addCase('a caller disconnect in the streamed surface is caught',
    legs => {
        legs.stream.pinned.recording[0].clientDisconnected = true;
    },
    { surface: 'stream', name: 'bothSubjectsSawTheWholeScript' });
addCase('a stream flag that was not requested is caught',
    legs => {
        legs.stream.gotavern.recording[0].body = JSON.stringify({ model: 'probe-model', stream: false });
    },
    { surface: 'stream', name: 'requestStreamFlagSetOnBoth' });
addCase('different request bytes on the direct surface are caught',
    legs => {
        legs.stream.pinned.recording[0].bodySha256 = 'c'.repeat(64);
    },
    { surface: 'stream', name: 'providerRequestBytesEqual' });

let failures = 0;
let index = 0;
for (const testCase of cases) {
    index += 1;
    const legs = baseline();
    testCase.mutate(legs);
    const { status, stderr, artifact } = run(legs, index);
    try {
        if (testCase.expected === null) {
            assert.equal(status, 0, `the baseline must be green, got status ${status}: ${stderr}`);
            assert.equal(artifact?.proven, true, 'the baseline artefact must record proven: true');
            assert.deepEqual(failedGuards(artifact), [], `the baseline must fail no guard, got ${JSON.stringify(failedGuards(artifact))}`);
        } else {
            assert.notEqual(status, 0, `${testCase.description}: the comparator must exit non-zero`);
            const failed = failedGuards(artifact);
            assert.ok(failed.some(entry => entry.surface === testCase.expected.surface && entry.name === testCase.expected.name),
                `${testCase.description}: expected ${testCase.expected.surface}.${testCase.expected.name} to fail; the artefact records ${JSON.stringify(failed)} and stderr ${JSON.stringify(stderr.slice(0, 400))}`);
        }
        console.log(`ok    ${testCase.description}`);
    } catch (error) {
        failures += 1;
        console.error(`FAIL  ${String(error.message ?? error)}`);
    }
}

rmSync(scenarioDir, { recursive: true, force: true });
if (failures > 0) {
    console.error(`\n${failures} of ${cases.length} framing-comparator cases are wrong; the gate does not have the teeth it claims`);
    process.exit(1);
}
console.log(`\n${cases.length} cases: every guard the framing comparator names can fail, and the healthy artefact passes`);
