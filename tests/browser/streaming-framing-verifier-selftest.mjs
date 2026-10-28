// The committed-artefact gate's teeth, shown without a browser and without a committed artefact.
//
// tools/browser-evidence/streaming-framing.mjs reads the COMMITTED streaming-framing-comparison.json, so
// the only way to see it fail is to hand it an artefact that is wrong. This runs the real module against
// hand-made artefacts and asserts which finding it produces -- the same relation
// tests/browser/streaming-framing-selftest.mjs has to the comparator.
//
// THE HAZARD THIS FILE EXISTS FOR, and it was measured on this lane: the observation block is keyed by
// SURFACE NAME (`observations.stream` / `.relayed` / `.abort`). The first draft read `observations.streaming`
// while the comparator wrote `observations.stream`, so every recomputation ran against an empty object --
// which made the HEALTHY artefact red and a WRONG artefact green. The healthy case below is what fails if
// that key ever drifts again, and the last case pins the drift itself.
//
// Run: node tests/browser/streaming-framing-verifier-selftest.mjs

import { streamingFramingSurface, FRAMING_GUARD_NAMES, FRAMING_NOT_RECOMPUTABLE } from '../../tools/browser-evidence/streaming-framing.mjs';

const allTrue = names => Object.fromEntries(names.map(name => [name, true]));
const words = ['Hello', ' from', ' the', ' stream', '?', ' incremental', ' rendering', ' is', ' genuinely', ' observed', ' and', ' paced', ' by', ' the'];
const many = Array.from({ length: 14 }, (_, index) => words.slice(0, index + 1).join(''));
const partial = many.slice(0, 3);

/** A healthy artefact: every guard true, observations that recompute to true, hop numbers that agree. */
function healthy() {
    const guards = {
        stream: allTrue(FRAMING_GUARD_NAMES.stream.concat(['bothSubjectsReachedThePeer', 'providerRequestBytesEqual', 'requestStreamFlagSetOnBoth', 'bothSubjectsSawTheWholeScript'])),
        relayed: allTrue(FRAMING_GUARD_NAMES.relayed.concat(['bothSubjectsSawTheWholeScriptThroughTheHop', 'hopForwardedIdenticalRequestBytes', 'hopForwardedWhatThePeerReceived', 'relayedFinalTextEqualsTheDirectStream'])),
        abort: allTrue(FRAMING_GUARD_NAMES.abort.concat(['peerSawTheClientDisconnect', 'partialTextIsAProperPrefixOfTheWholeReply', 'noFurtherChunksAppliedAfterTheCut', 'bothSubjectsLeftGeneratingWithTheStopButtonUp'])),
    };
    return {
        schemaVersion: 1,
        hop: {
            mode: { direct: null, relayed: 'pass-through', abort: 'cut-at-head' },
            cutArmOnPath: '/chat/completions',
            cut: { gotavern: 'cut-at-head', pinned: 'cut-at-head' },
            anyCut: { gotavern: 'cut-at-head', pinned: 'cut-at-head' },
            cutsPerformed: { gotavern: 1, pinned: 1 },
            relayedCut: { gotavern: null, pinned: null },
            cutAfterFrames: 3,
            cutAfterBytes: 300,
    releasedBytesUnderCut: { gotavern: 349, pinned: 349 },
            hopReleasedBytesTotal: { gotavern: 349, pinned: 349 },
            relayedWrites: { gotavern: 14, pinned: 14 },
            relayedFrames: { gotavern: 15, pinned: 15, expected: 14 },
            gzipFramedResponses: { gotavern: 1, pinned: 1 },
            cutArmedResponses: { gotavern: 1, pinned: 1 },
            relayedWholeResponses: { gotavern: 1, pinned: 1 },
            framesWritten: { gotavern: [15], pinned: [15] },
            streamFramesWritten: { gotavern: [15], pinned: [15] },
        },
        observations: {
            stream: { gotavern: { texts: many, finalText: 'whole reply', pageErrors: 0, stopClickedAt: null }, pinned: { texts: many, finalText: 'whole reply', pageErrors: 0, stopClickedAt: null } },
            relayed: { gotavern: { texts: many, finalText: 'whole reply', pageErrors: 0, stopClickedAt: null }, pinned: { texts: many, finalText: 'whole reply', pageErrors: 0, stopClickedAt: null } },
            abort: { gotavern: { texts: partial, finalText: partial.at(-1), pageErrors: 0, stopClickedAt: null }, pinned: { texts: partial, finalText: partial.at(-1), pageErrors: 0, stopClickedAt: null } },
        },
        stream: { guards: guards.stream, proven: true },
        relayed: { guards: guards.relayed, proven: true },
        abort: { guards: guards.abort, proven: true },
        proven: true,
        notCompared: ['a real provider (the peer is simulated)', 'a real TLS connection', 'incremental render through a buffering proxy: measured and deleted', 'network jitter'],
    };
}

const cases = [];
const add = (description, mutate, needle) => cases.push({ description, mutate, needle });

add('the healthy artefact passes', () => {}, null);
add('a missing surface is a finding', artifact => { delete artifact.abort; }, 'the abort block is missing');
add('a missing guard is a finding (an absent check is not a pass)', artifact => { delete artifact.relayed.guards.hopRelayedInMoreThanOneWrite; }, 'relayed.guards.hopRelayedInMoreThanOneWrite is missing');
add('a hand-edited false guard is named', artifact => { artifact.abort.guards.sameTruncationOnBothSubjects = false; artifact.abort.proven = false; artifact.proven = false; }, 'abort.guards.sameTruncationOnBothSubjects is false');
add('a guard that contradicts the stored observations is a finding', artifact => { artifact.observations.abort.pinned.texts = [partial[0]]; }, 'sameTruncationOnBothSubjects is recorded as true but the stored observations recompute to false');
add('a guard nobody reads is a finding', artifact => { artifact.stream.guards.inventedGuard = true; }, 'stream.guards carries ["inventedGuard"]');
add('a hop that assembled the body is a finding, read from the hop record itself', artifact => { artifact.hop.relayedWrites.gotavern = 1; }, 'hop.relayedWrites.gotavern is 1');
add('a cut that released NOTHING on one subject is a finding: that is a head cut, which cannot render content', artifact => { artifact.hop.releasedBytesUnderCut.pinned = 0; }, 'hop.releasedBytesUnderCut.pinned is');
// THE RECOMPUTE FIRES FIRST and is the stronger statement: the guard claims a cut on both subjects while
// the hop's own record says the pinned cut never happened. Either finding is correct; this asserts the
// recompute, which is the one that also catches a hand-edited flag.
add('a subject the cut never reached is a finding', artifact => { artifact.hop.anyCut.pinned = null; }, 'hopCutBothSubjectsMidStream is recorded as true but the stored observations recompute to false');
add('an artefact with no notCompared list is a finding', artifact => { artifact.notCompared = []; }, 'notCompared does not name what this artefact leaves unproven');
add('an artefact that hides the deleted buffering mode is a finding', artifact => { artifact.notCompared = ['a real provider', 'a real TLS connection', 'network jitter', 'frames other than the cut point']; }, 'does not name the buffering-proxy mode that was measured and removed');
add('a proven flag that disagrees with its surfaces is a finding', artifact => { artifact.relayed.guards.hopPresentOnBothSubjects = false; artifact.relayed.proven = false; }, 'proven is true but the three network surfaces recompute to false');
add('a false not-recomputable guard is a finding', artifact => { artifact.stream.guards.providerRequestBytesEqual = false; artifact.stream.proven = false; artifact.proven = false; }, 'stream.guards.providerRequestBytesEqual is false');
// THE KEY DRIFT, as a case: observations keyed by the WRONG surface name must be caught rather than
// silently recomputed from an empty object (which is the defect that made a wrong artefact green).
add('observations keyed by the wrong surface name are caught, not silently accepted',
    artifact => {
        artifact.observations.streaming = artifact.observations.stream;
        delete artifact.observations.stream;
    },
    'stream.guards.incrementalRenderObservedOnBoth is recorded as true but the stored observations recompute to false');

let failures = 0;
for (const testCase of cases) {
    const artifact = healthy();
    testCase.mutate(artifact);
    const findings = [];
    const ctx = { fail: message => findings.push(message), observe: () => {}, noteStale: () => {} };
    streamingFramingSurface(ctx, artifact);
    if (testCase.needle === null) {
        if (findings.length > 0) {
            failures += 1;
            console.error(`FAIL  the healthy artefact produced ${findings.length} finding(s): ${findings[0]}`);
        } else {
            console.log(`ok    ${testCase.description}`);
        }
        continue;
    }
    if (findings.some(finding => finding.includes(testCase.needle))) {
        console.log(`ok    ${testCase.description}`);
    } else {
        failures += 1;
        console.error(`FAIL  ${testCase.description}: expected a finding containing ${JSON.stringify(testCase.needle)}; got ${JSON.stringify(findings.slice(0, 3))}`);
    }
}
if (failures > 0) {
    console.error(`${failures} of ${cases.length} verifier cases are wrong`);
    process.exit(1);
}
console.log(`${cases.length} cases: the committed-artefact gate rejects every wrong shape and accepts the healthy one`);
