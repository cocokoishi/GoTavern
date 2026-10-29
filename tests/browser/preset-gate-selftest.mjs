// DOES THE PRESET GATE HAVE TEETH? Mutate the legs and require the comparator to go red.
//
// WHY THIS FILE EXISTS (AGENTS.md "Differential-testing doctrine" 4): a gate whose failure has never
// been observed is a gate nobody can trust, and this project has already shipped several greensor
// assertions that could not fail. The comparator's own guards are checked here against DELIBERATELY
// broken copies of the legs from the run that just finished, so the verdict "faithful and equal" is
// preceded by three demonstrations that it is not unconditional:
//
//   1. one character inside one message of the pinned KEEP leg  -> the byte digest differs and the
//      parsed diff names that message index;
//   2. the `stop` array of the GoTavern DROP leg removed        -> the digest differs and the diff names
//      the member;
//   3. the oldest history turn put BACK into the pinned DROP leg -> the boundary no longer binds, so the
//      comparator reports an UNFAITHFUL differential rather than a difference.
//
// It mutates in MEMORY only: no leg file and no artefact is written, so this can run beside the real
// comparison without touching the evidence.
//
// Usage: node tests/browser/preset-gate-selftest.mjs <keep-gotavern> <keep-pinned> <drop-gotavern> <drop-pinned> [--fixture <path>]

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { PRESET_FIXTURE, findMessage } from './preset-kit.mjs';
import { compare } from './compare-preset-legs.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

const clone = value => JSON.parse(JSON.stringify(value));

function readJSON(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// replaceProviderBody rewrites the recorded POST body of a leg AND the digest/length the comparator
// treats as the contract, so a mutation is visible in the BYTES rather than only in the parsed view.
function replaceProviderBody(report, mutate) {
    const copy = clone(report);
    const entry = (copy.recording ?? []).find(item => item.method === 'POST' && item.body);
    if (!entry) {
        throw new Error('this leg recorded no POST body, so the self-test cannot mutate it');
    }
    const body = JSON.parse(entry.body);
    mutate(body);
    entry.body = JSON.stringify(body);
    entry.bodyLength = Buffer.byteLength(entry.body, 'utf8');
    entry.bodySha256 = createHash('sha256').update(entry.body).digest('hex');
    return copy;
}

const args = process.argv.slice(2);
const fixtureIndex = args.indexOf('--fixture');
const boundaryIndex = args.indexOf('--boundary');
const files = args.filter((value, index) => !value.startsWith('--')
    && !(fixtureIndex >= 0 && index === fixtureIndex + 1)
    && !(boundaryIndex >= 0 && index === boundaryIndex + 1));
if (files.length !== 4) {
    console.error('usage: node tests/browser/preset-gate-selftest.mjs <keep-gotavern> <keep-pinned> <drop-gotavern> <drop-pinned> [--fixture <path>] [--boundary <path>]');
    process.exit(2);
}
const fixture = readJSON(fixtureIndex >= 0 ? path.resolve(args[fixtureIndex + 1]) : PRESET_FIXTURE);
const legs = {
    gotavernKeep: readJSON(files[0]),
    pinnedKeep: readJSON(files[1]),
    gotavernDrop: readJSON(files[2]),
    pinnedDrop: readJSON(files[3]),
};
const inputs = Object.fromEntries(['gotavernKeep', 'pinnedKeep', 'gotavernDrop', 'pinnedDrop'].map((name, index) => [name, path.basename(files[index])]));
// THE MEASURED PAIR, NOT THE CAPTURE'S. The legs were driven at the contexts the PINNED-LEG SEARCH chose
// (run 40092716313: keep 4260 / drop 4259), while the capture's own pair is only a hint. Feeding the
// capture's numbers here made the two context guards fail on a faithful baseline -- the self-test was
// asserting an expectation the comparator no longer has. The real measured file is passed by CI; the
// synthetic fallback below exists only so the file can be exercised by hand.
const boundaryFile = boundaryIndex >= 0
    ? readJSON(path.resolve(args[boundaryIndex + 1]))
    : (fixture?.capture?.boundary?.keepContext ? {
        measuredBy: 'pinned-leg',
        keepContext: fixture.capture.boundary.keepContext,
        dropContext: fixture.capture.boundary.dropContext,
        keep: { total: fixture.capture.boundary.keepMessages, history: fixture.capture.boundary.keepHistoryMessages },
        drop: { total: fixture.capture.boundary.dropMessages, history: fixture.capture.boundary.dropHistoryMessages },
        search: [],
        bracket: null,
    } : null);
const run = (overrides, boundaryOverride = boundaryFile) => compare({ ...legs, ...overrides, fixture, boundaryFile: boundaryOverride, inputs });

const failures = [];
const record = (name, ok, detail) => {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` -- ${detail}` : ''}`);
    if (!ok) failures.push(name);
};

// 0. THE BASELINE MUST PASS, or the mutations below prove nothing: a comparator that is red on the
//    faithful pair would "catch" every mutation for the wrong reason.
//
//    THE EXPECTATION IS THE COMPARATOR'S ACTUAL CONTRACT: verdict 'match' (not 'equal'), no guard false,
//    and the two context guards PRESENT AND TRUE -- those are the ones that say each variant ran at the
//    context the pinned leg chose, and a baseline that silently dropped them would pass while the
//    differential measured the wrong budget.
const baseline = run({});
const failedGuards = Object.entries(baseline.guards).filter(([, value]) => value === false).map(([name]) => name);
const contextGuardNames = ['keepVariantRanAtTheCapturedContext', 'dropVariantRanAtTheCapturedContext'];
record('baseline is faithful (verdict match, no guard false, both context guards true)',
    baseline.verdict === 'match'
    && baseline.providerRequestEqual === true
    && failedGuards.length === 0
    && contextGuardNames.every(name => baseline.guards?.[name] === true),
    JSON.stringify({ verdict: baseline.verdict, equal: baseline.providerRequestEqual, failedGuards, contextGuards: Object.fromEntries(contextGuardNames.map(name => [name, baseline.guards?.[name] ?? 'ABSENT'])) }));

const oldestMarker = String(fixture?.capture?.boundary?.oldestMarker ?? '');

// 1. ONE CHARACTER INSIDE ONE MESSAGE OF THE PINNED KEEP LEG.
const pinnedKeepBody = JSON.parse((legs.pinnedKeep.recording.find(item => item.method === 'POST' && item.body)).body);
const targetIndex = Math.min(2, (pinnedKeepBody.messages?.length ?? 1) - 1);
const mutatedKeep = replaceProviderBody(legs.pinnedKeep, body => {
    const message = body.messages[targetIndex];
    message.content = `${message.content}Z`;
});
const first = run({ pinnedKeep: mutatedKeep });
record('a one-character change in a message is caught', first.providerRequestEqual === false
    && first.firstDifferences?.keep?.index === targetIndex,
    JSON.stringify({ equal: first.providerRequestEqual, firstDifference: first.firstDifferences?.keep ?? null }));

// 2. THE STOP ARRAY REMOVED FROM THE GOTAVERN DROP LEG.
const mutatedStop = replaceProviderBody(legs.gotavernDrop, body => {
    delete body.stop;
});
const second = run({ gotavernDrop: mutatedStop });
const namedStop = (second.bodyDifferences?.drop ?? []).some(line => line.includes('stop'));
record('a missing stop array is caught and named', second.providerRequestEqual === false && namedStop,
    JSON.stringify({ equal: second.providerRequestEqual, differences: second.bodyDifferences?.drop ?? [] }));

// 3. THE OLDEST TURN PUT BACK INTO THE PINNED DROP LEG: the pair stops binding, which must be reported as
//    an unfaithful differential (a guard), not as a product difference.
const mutatedDrop = replaceProviderBody(legs.pinnedDrop, body => {
    const messages = Array.isArray(body.messages) ? body.messages : [];
    // A kept-by-the-wrong-side drop leg is modelled by re-inserting the oldest turn's marker, which is
    // exactly the observation the boundary guard reads.
    messages.splice(1, 0, { role: 'user', content: `${oldestMarker} re-inserted by the self-test` });
    body.messages = messages;
});
const third = run({ pinnedDrop: mutatedDrop });
record('a drop leg that keeps the oldest turn fails the boundary guard', third.guards?.boundaryBindsOnThePinnedLeg === false
    || third.guards?.boundaryRetainsExactlyOneMoreTurnOnThePinnedLeg === false,
    JSON.stringify({
        keepDrop: third.keepDrop?.drop ?? null,
        guards: {
            binds: third.guards?.boundaryBindsOnThePinnedLeg,
            oneMoreTurn: third.guards?.boundaryRetainsExactlyOneMoreTurnOnThePinnedLeg,
        },
    }));

// 4. A MISSING TOKENIZER ANCHOR MUST REFUSE: this is the Guesstimate path, and comparing counts that are
//    not counts is the failure this lane exists to prevent.
const noAnchor = clone(legs.gotavernKeep);
if (noAnchor.preset) {
    noAnchor.preset.tokenizerAnchor = { model: 'llama', status: 200, count: 13, pinnedCount: 7 };
}
const fourth = run({ gotavernKeep: noAnchor });
record('a guesstimating tokenizer fails the anchor guard', fourth.guards?.tokenizerAnchorExactOnBothLegs === false,
    JSON.stringify(fourth.guards?.tokenizerTree ?? null));

// 5. THE BOUNDARY MUST SAY WHICH HISTORY COUNTS IT MEASURED. `boundaryMatchesTheCapture` used to fall back to
//    the OBSERVED count when the boundary file omitted `keepHistoryMessages`/`dropHistoryMessages`, which made
//    those two conjuncts compare a value with itself: the guard reported "the drive assembled what the boundary
//    was measured on" without having compared anything. The mutation strips the history counts from the
//    boundary file -- the shape a search that stopped recording them would produce -- and the guard must go
//    false by name. It must NOT be excused: a boundary whose own numbers are absent is a harness gap, not a
//    product finding.
if (boundaryFile) {
    const boundaryWithoutHistoryCounts = {
        ...boundaryFile,
        keep: { ...(boundaryFile.keep ?? {}), history: undefined },
        drop: { ...(boundaryFile.drop ?? {}), history: undefined },
    };
    const fifth = run({}, boundaryWithoutHistoryCounts);
    record('a boundary file that omits its history counts is refused, not compared with itself',
        fifth.guards?.boundaryMatchesTheCapture === false,
        JSON.stringify({ guard: fifth.guards?.boundaryMatchesTheCapture ?? 'ABSENT', boundary: { keep: boundaryFile.keep, drop: boundaryFile.drop } }));
} else {
    // A REFUSAL, NOT A PASS: without a boundary file this case cannot run, and reporting it as green would be
    // the absent-input-reads-as-pass defect the case exists to remove.
    record('a boundary file that omits its history counts is refused, not compared with itself', false,
        'no boundary file was supplied to this self-test, so the mutation could not be applied');
}

console.log(failures.length === 0
    ? `preset gate self-test: ${5} mutations caught, baseline green`
    : `preset gate self-test: ${failures.length} mutation(s) NOT caught: ${failures.join(', ')}`);
process.exit(failures.length === 0 ? 0 : 1);
