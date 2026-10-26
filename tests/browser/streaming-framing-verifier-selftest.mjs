// The verifier module's teeth, shown without a browser and without a committed artefact.
//
// tools/browser-evidence/streaming-framing.mjs is the gate that reads the COMMITTED
// streaming-framing-comparison.json, so the only way to see it fail is to hand it an artefact that is
// wrong. This runs the real module against hand-made artefacts and asserts which finding it produces --
// the same relation tests/browser/streaming-framing-selftest.mjs has to the comparator.
import { streamingFramingSurface, FRAMING_GUARD_NAMES, FRAMING_NOT_RECOMPUTABLE } from '../../tools/browser-evidence/streaming-framing.mjs';

// THE OBSERVATION BLOCK IS KEYED BY SURFACE NAME. This file is where that was MEASURED as wrong: the first
// draft of the verifier read `observations.stream` while the comparator writes `observations.streaming`,
// so every recomputation ran against an empty object -- the healthy artefact was red AND a wrong artefact
// would have been green for the streaming surface. The healthy case below is what catches that shape.


const ALL_TRUE = names => Object.fromEntries(names.map(name => [name, true]));
const NEEDLES = text => Object.keys(text ?? {});

/** A healthy artefact: every guard true, observations that recompute to true, hop numbers that agree. */
function healthy() {
    // THREE DISTINCT CONTENT STATES ON EVERY SURFACE, so the recomputed guards are true for the same
    // reason the recorded ones are (the first draft of this file used two and the healthy artefact was
    // correctly reported red -- which is the harness proving it can fail).
    const texts = ['Hello', 'Hello from', 'Hello from the'];
    // A GROWING CHAIN, because the recompute requires every state to extend the previous one; a list of
    // unrelated tokens is NOT a prefix sequence and was measured as such.
    const words = ['Hello', ' from', ' the', ' stream', '?', ' incremental', ' rendering', ' is', ' genuinely', ' observed', ' and', ' paced', ' by', ' the'];
    const many = Array.from({ length: 14 }, (_, index) => words.slice(0, index + 1).join(''));
    const guards = {
        streaming: ALL_TRUE(FRAMING_GUARD_NAMES.streaming.concat(FRAMING_NOT_RECOMPUTABLE.filter(name => name !== 'bufferedFinalTextEqualsTheDirectStream' && name !== 'partialTextIsAProperPrefixOfTheWholeReply' && name !== 'noFurtherChunksAppliedAfterTheCut' && name !== 'generationEndedOnBothSubjects' && name !== 'peerWroteMoreThanItDelivered'))),
        buffered: ALL_TRUE(FRAMING_GUARD_NAMES.buffered.concat(['bufferedFinalTextEqualsTheDirectStream'])),
        abort: ALL_TRUE(FRAMING_GUARD_NAMES.abort.concat(['peerWroteMoreThanItDelivered', 'partialTextIsAProperPrefixOfTheWholeReply', 'noFurtherChunksAppliedAfterTheCut', 'generationEndedOnBothSubjects'])),
    };
    return {
        schemaVersion: 1,
        hop: {
            cutAfterFrames: 3, cutAfterBytes: 300,
            cut: { gotavern: 'cut-after-bytes', pinned: 'cut-after-bytes' },
            bufferedWrites: { gotavern: 1, pinned: 1 },
            releasedBytesUnderCut: { gotavern: 300, pinned: 300 },
            framesWritten: { gotavern: [15], pinned: [15] },
            streamFramesWritten: { gotavern: [15], pinned: [15] },
        },
        observations: {
            streaming: { gotavern: { texts: many, finalText: 'whole reply', pageErrors: 0 }, pinned: { texts: many, finalText: 'whole reply', pageErrors: 0 } },
            buffered: { gotavern: { texts: many, finalText: 'whole reply', pageErrors: 0 }, pinned: { texts: many, finalText: 'whole reply', pageErrors: 0 } },
            abort: { gotavern: { texts, finalText: 'Hello from the', pageErrors: 0 }, pinned: { texts, finalText: 'Hello from the', pageErrors: 0 } },
        },
        streaming: { guards: guards.streaming, proven: true },
        buffered: { guards: guards.buffered, proven: true },
        abort: { guards: guards.abort, proven: true },
        proven: true,
        notCompared: ['a real provider (the peer is simulated)', 'a real TLS connection', 'network jitter'],
    };
}

const cases = [];
const add = (description, mutate, needle) => cases.push({ description, mutate, needle });

add('the healthy artefact passes', () => {}, null);
add('a missing surface is a finding', artifact => { delete artifact.abort; }, 'the abort block is missing');
add('a missing guard is a finding (an absent check is not a pass)', artifact => { delete artifact.buffered.guards.bufferingProxyHeldTheWholeBody; }, 'buffered.guards.bufferingProxyHeldTheWholeBody is missing');
add('a hand-edited false guard is named', artifact => { artifact.abort.guards.sameTruncationOnBothSubjects = false; artifact.abort.proven = false; artifact.proven = false; }, 'abort.guards.sameTruncationOnBothSubjects is false');
add('a guard that contradicts the stored observations is a finding', artifact => { artifact.observations.abort.pinned.texts = ['Hello']; }, 'sameTruncationOnBothSubjects is recorded as true but the stored observations recompute to false');
add('a guard nobody reads is a finding', artifact => { artifact.streaming.guards.inventedGuard = true; }, 'streaming.guards carries ["inventedGuard"]');
add('a hop that did not buffer is a finding', artifact => { artifact.hop.bufferedWrites.gotavern = 5; }, 'hop.bufferedWrites.gotavern is 5');
add('a cut that released nothing is a finding', artifact => { artifact.hop.releasedBytesUnderCut.pinned = 0; }, 'hop.releasedBytesUnderCut.pinned is 0');
add('an artefact with no notCompared list is a finding', artifact => { artifact.notCompared = []; }, 'notCompared does not name what this artefact leaves unproven');
add('a proven flag that disagrees with its surfaces is a finding', artifact => { artifact.buffered.proven = false; artifact.buffered.guards.incrementalRenderAdvancedThroughTheBufferingProxy = false; }, 'proven is true but the three network surfaces recompute to false');
add('a false not-recomputable guard is a finding', artifact => { artifact.streaming.guards.providerRequestBytesEqual = false; artifact.streaming.proven = false; artifact.proven = false; }, 'streaming.guards.providerRequestBytesEqual is false');

let failures = 0;
for (const testCase of cases) {
    const artifact = healthy();
    testCase.mutate(artifact);
    const findings = [];
    const ctx = { fail: message => findings.push(message), observe: () => {}, noteStale: () => {} };
        streamingFramingSurface(ctx, artifact);
    if (testCase.needle === null) {
        if (findings.length > 0) { failures += 1; console.error(`FAIL  the healthy artefact produced ${findings.length} finding(s): ${findings[0]}`); }
        else console.log(`ok    ${testCase.description}`);
        continue;
    }
    if (findings.some(finding => finding.includes(testCase.needle))) console.log(`ok    ${testCase.description}`);
    else { failures += 1; console.error(`FAIL  ${testCase.description}: expected a finding containing ${JSON.stringify(testCase.needle)}; got ${JSON.stringify(findings.slice(0, 3))}`); }
}
if (failures > 0) { console.error(`${failures} of ${cases.length} verifier cases are wrong`); process.exit(1); }
console.log(`${cases.length} cases: the committed-artefact gate rejects every wrong shape and accepts the healthy one`);