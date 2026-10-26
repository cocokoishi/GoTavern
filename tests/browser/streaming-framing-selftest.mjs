#!/usr/bin/env node
// The streaming framing comparator's TEETH, shown in one second instead of eighteen minutes.
//
// WHY THIS EXISTS. `compare-streaming-framing.mjs` is only run by a browser differential (three drive
// pairs on two subjects, ~18 minutes), so a mutation in one of its guards would otherwise need a full
// dispatch to observe. Worse, some of the most important assertions CANNOT be mutated into a full run at
// all: a full run where the buffering surface renders into a delayed body is correct, and it is the
// MISMATCH path -- the surface renders while the hop still holds the body -- that must be caught. That
// path is only reachable from a hand-made artefact, so it is reachable HERE.
//
// WHAT IT DOES, per case: writes synthetic leg reports into a temp directory, runs the REAL comparator
// against them, and asserts (a) the comparator's exit status and (b) the EXACT guard name that failed.
// Nothing is stubbed inside the comparator: the same file that CI runs is the file under test, which is
// the only way a guard whose formula changed is caught here too.
//
// THE CASES BELOW ARE THE MUTATION SET FROM THE COMMIT, kept as code so they cannot rot: the commit
// message quotes the guard each one turns red, and this file is where that claim is executable.
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

// THE PEER'S SCRIPT, as the probe writes it for PROBE_FRAME_COUNT=14: fifteen `data:` frames in total
// (fourteen content frames and the terminal `[DONE]`). Every synthetic leg below is built from this, so a
// number that drifts here is a number that drifted from the peer's own framing.
// FITTED TO THE PROBE'S ARITHMETIC: PROBE_FRAME_COUNT=14 writes fourteen CONTENT frames (the peer's
// wordCount loop) plus one terminal frame with empty content, so the peer records 15 frames written and
// the comparator reads 14 content frames from that count. The first version of this file reused the
// PROBE'S own word list, which holds fifteen words; the baseline was then red for the RIGHT reason -- a page
// that rendered fifteen states had rendered one more than the peer wrote -- and the list is now the first
// fourteen words. The baseline case asserts the count rather than assuming it.
const WORDS = ['Hello', ' from', ' the', ' stream', '?', ' incremental', ' rendering', ' is', ' genuinely', ' observed', ' and', ' paced', ' by', ' the'];
const renderStates = count => WORDS.slice(0, count).map((_, index) => WORDS.slice(0, index + 1).join(''));
const fullText = WORDS.join('');

/** One synthetic leg: what the probe would have written, with the hop record the scenario needs. */
function leg({ texts, finalAssistantText, hop, framesWritten = 15, clientDisconnected = false, pageErrors = [], streamState = {} }) {
    return {
        pageErrors,
        streamState: { sawIncremental: true, contentSnapshotsBeforeEnd: Math.max(1, texts.length), ...streamState },
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

const bufferedHop = { mode: 'buffer', cutAfterBytes: 0, cut: null, bodyWriteCount: 1, bodyWrites: [{ bytes: 900, frames: 15 }], releasedBytes: 900, forwarded: [{ method: 'POST', path: '/chat/completions', bodyBytes: 7400, bodySha256: 'a'.repeat(64) }] };
const cutHop = { mode: 'cut', cutAfterBytes: 300, cut: 'cut-after-bytes', bodyWriteCount: 1, bodyWrites: [{ bytes: 300, frames: 3 }], releasedBytes: 300, forwarded: [{ method: 'POST', path: '/chat/completions', bodyBytes: 7400, bodySha256: 'a'.repeat(64) }] };

/** The healthy baseline: all three surfaces green. Every case is one mutation of this. */
function baseline() {
    const whole = leg({ texts: renderStates(14), finalAssistantText: fullText, hop: { mode: null, absent: true } });
    return {
        stream: { gotavern: whole, pinned: structuredClone(whole) },
        buffered: {
            gotavern: leg({ texts: renderStates(14), finalAssistantText: fullText, hop: structuredClone(bufferedHop) }),
            pinned: leg({ texts: renderStates(14), finalAssistantText: fullText, hop: structuredClone(bufferedHop) }),
        },
        abort: {
            gotavern: leg({
                texts: renderStates(3),
                finalAssistantText: renderStates(3).at(-1),
                hop: structuredClone(cutHop),
                framesWritten: 15,
                streamState: { stopClickedAt: null, textAfterAbort: renderStates(3).at(-1), textLater: renderStates(3).at(-1), returnedToIdle: true },
            }),
            pinned: leg({
                texts: renderStates(3),
                finalAssistantText: renderStates(3).at(-1),
                hop: structuredClone(cutHop),
                framesWritten: 15,
                streamState: { stopClickedAt: null, textAfterAbort: renderStates(3).at(-1), textLater: renderStates(3).at(-1), returnedToIdle: true },
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

/** Runs the real comparator over one set of six legs, returning {status, stderr, artifact}. `label` keeps
 *  each case's output file distinct: one shared `out.json` meant the SECOND case read the FIRST case's
 *  artefact when the comparator exited before writing (measured -- every case reported `records []`), which
 *  would have made this file claim the guards had no teeth while they were in fact biting. */
function run(legs, label) {
    const args = ['--stream', write('s-go.json', legs.stream.gotavern), write('s-pin.json', legs.stream.pinned),
        '--buffered', write('b-go.json', legs.buffered.gotavern), write('b-pin.json', legs.buffered.pinned),
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

/** The named guards that are false in the produced artefact, across all surfaces. */
const failedGuards = artifact => {
    if (!artifact) return [];
    const surfaces = ['streaming', 'buffered', 'abort', 'passThroughControl'];
    return surfaces.flatMap(surface => (artifact[surface]?.failedGuards ?? []).map(name => ({ surface, name })));
};

const cases = [];
const addCase = (description, mutate, expected) => cases.push({ description, mutate, expected });

// ---- 1. THE BASELINE MUST BE GREEN, or every case below is measuring the baseline's own redness. ------
addCase('the healthy artefact passes every guard on all three surfaces', () => {}, null);

// ---- 2. THE BLOCKING-PROXY HAZARD: a subject that renders while the hop holds the body. --------------
// This is the case a full run CANNOT produce (a correct server does not), and the case the whole surface
// exists for: it must be caught, by the guard that says the page did not render frame by frame.
addCase('a subject that renders only the whole reply through the buffering hop is caught',
    legs => {
        legs.buffered.gotavern = leg({ texts: [fullText], finalAssistantText: fullText, hop: structuredClone(bufferedHop) });
    },
    { surface: 'buffered', name: 'incrementalRenderAdvancedThroughTheBufferingProxy' });

// ---- 3. A HOP THAT DID NOT BUFFER cannot support the buffering surface. -----------------------------
addCase('a hop that relayed in more than one write fails the buffering evidence guard',
    legs => {
        legs.buffered.gotavern.networkHop.bodyWriteCount = 7;
        legs.buffered.gotavern.networkHop.bodyWrites = Array.from({ length: 7 }, () => ({ bytes: 128, frames: 2 }));
    },
    { surface: 'buffered', name: 'bufferingProxyHeldTheWholeBody' });

addCase('a hop whose single write did not carry the whole script fails the released-every-frame guard',
    legs => {
        legs.buffered.pinned.networkHop.bodyWrites = [{ bytes: 300, frames: 3 }];
    },
    { surface: 'buffered', name: 'bufferingProxyReleasedEveryFrameInThatWrite' });

// ---- 4. REQUEST BYTES ACROSS THE HOP. ---------------------------------------------------------------
addCase('different request bytes forwarded by the hop are caught',
    legs => {
        legs.buffered.pinned.networkHop.forwarded[0].bodySha256 = 'b'.repeat(64);
    },
    { surface: 'buffered', name: 'forwardedRequestBytesEqual' });

addCase('a hop that forwarded bytes the peer did not record is caught',
    legs => {
        legs.buffered.gotavern.recording[0].bodyLength = 7399;
    },
    { surface: 'buffered', name: 'hopForwardedWhatThePeerReceived' });

// ---- 5. THE MID-STREAM CUT. -------------------------------------------------------------------------
addCase('a cut that did not happen fails the network-cut guard',
    legs => {
        legs.abort.pinned.networkHop.cut = null;
    },
    { surface: 'abort', name: 'networkCutBothSubjectsMidStream' });

addCase('a peer that recorded a client disconnect makes this cancellation, not a dead network, and is caught',
    legs => {
        legs.abort.gotavern.recording[0].clientDisconnected = true;
    },
    { surface: 'abort', name: 'peerDidNotDisconnect' });

addCase('a stop click in the abort surface is caught',
    legs => {
        legs.abort.gotavern.streamState.stopClickedAt = 1234;
    },
    { surface: 'abort', name: 'noCallerCancelOnEitherSubject' });

addCase('different partial text on the two subjects is caught',
    legs => {
        legs.abort.pinned.postSend.finalAssistantText = 'Hello from';
        legs.abort.pinned.postSend.renderSnapshots = [{ t: 1000, text: 'Hello from' }];
    },
    { surface: 'abort', name: 'partialTextIdenticalOnBothSubjects' });

addCase('a truncation that landed at a different byte on the two subjects is caught',
    legs => {
        legs.abort.pinned.networkHop.releasedBytes = 301;
    },
    { surface: 'abort', name: 'releasedByteCountEqualOnBothSubjects' });

addCase('a subject that keeps rendering after the cut is caught',
    legs => {
        legs.abort.gotavern.streamState.textLater = `${renderStates(3).at(-1)} extra`;
    },
    { surface: 'abort', name: 'noFurtherChunksAppliedAfterTheCut' });

addCase('a subject that never returns to idle after the cut is caught',
    legs => {
        legs.abort.pinned.streamState.returnedToIdle = false;
    },
    { surface: 'abort', name: 'generationEndedOnBothSubjects' });

addCase('a page error escaping on one subject is caught',
    legs => {
        legs.abort.gotavern.pageErrors = ['TypeError: undefined is not a function'];
    },
    { surface: 'abort', name: 'noPageErrorsOnEitherSubject' });

// ---- 6. THE RENDER PROPERTIES ON THE DIRECT SURFACE. -------------------------------------------------
addCase('a subject that renders nothing on the direct surface is caught',
    legs => {
        legs.stream.gotavern.postSend.renderSnapshots = [];
        legs.stream.gotavern.postSend.finalAssistantText = null;
    },
    { surface: 'streaming', name: 'everySubjectAppliedAtLeastOneContentFrame' });

addCase('a subject that rewrote settled text (non-monotonic render) is caught',
    legs => {
        legs.stream.gotavern.postSend.renderSnapshots = [
            { t: 1, text: 'Hello from the' }, { t: 2, text: 'Hello from' }, { t: 3, text: fullText },
        ];
    },
    { surface: 'streaming', name: 'renderAdvancedMonotonicallyOnBoth' });

addCase('a subject that applied more states than the peer wrote frames is caught',
    legs => {
        legs.stream.pinned.postSend.renderSnapshots = Array.from({ length: 20 }, (_, index) => ({ t: index, text: `state ${index}` }));
        legs.stream.pinned.postSend.finalAssistantText = 'state 19';
    },
    { surface: 'streaming', name: 'renderedStatesNeverExceedContentFrames' });

addCase('equal-and-empty final text on both subjects is caught',
    legs => {
        legs.stream.gotavern.postSend.finalAssistantText = '';
        legs.stream.gotavern.postSend.renderSnapshots = [];
        legs.stream.pinned.postSend.finalAssistantText = '';
        legs.stream.pinned.postSend.renderSnapshots = [];
    },
    { surface: 'streaming', name: 'finalTextEqualAndNonEmpty' });

addCase('a caller disconnect in the streamed surface is caught',
    legs => {
        legs.stream.pinned.recording[0].clientDisconnected = true;
    },
    { surface: 'streaming', name: 'bothSubjectsSawTheWholeScript' });

addCase('a stream flag that was not requested is caught',
    legs => {
        legs.stream.gotavern.recording[0].body = JSON.stringify({ model: 'probe-model', stream: false });
    },
    { surface: 'streaming', name: 'requestStreamFlagSetOnBoth' });

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
