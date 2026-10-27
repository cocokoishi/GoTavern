// DOES THE Q17 GATE HAVE TEETH? Mutate the observation and require the comparator to name the check.
//
// WHY THIS FILE EXISTS (AGENTS.md differential doctrine 4, GOAL.md 8.6). A gate whose failure has never been
// observed is decoration, and this project has shipped several greens whose assertion could not fail. The
// comparator (compare-authors-note-legs.mjs) is therefore run here against SYNTHETIC legs built from a
// known-good pair, with ONE thing broken per case, and every mutation must be caught by a NAMED check.
//
// WHY SYNTHETIC RATHER THAN THE LEGS FROM THE LAST RUN: this file must be runnable before any browser has
// started -- it is the cheap proof that the judge works, so the expensive legs are only paid for once. The
// committed pinned expectation (fixtures/authors-note-pinned.json) supplies the case NUMBERS, so the
// synthetic legs cannot disagree with the real sweep about which depth each case runs at.
//
// THE MUTATIONS, each a real way the product or the harness could be wrong:
//   1. THE NOTE ONE MESSAGE DEEPER on the GoTavern leg  -> layout.historyBelow / layout.noteIndex
//   2. THE NOTE ONE MESSAGE SHALLOWER                   -> the same checks, the other direction
//   3. THE NOTE'S ROLE CHANGED (system -> user)         -> layout.noteRole
//   4. THE NOTE'S TEXT CHANGED, SAME POSITION           -> bodySha256Equal (and NOT a layout check: the
//                                                          note is at the right depth with the wrong text,
//                                                          which the layout alone would call equal)
//   5. THE NOTE REMOVED FROM THE GOTAVERN LEG           -> layout.noteIndex / layout.noteCarriesTheCaseText
//   6. THE GO TAVERN LEG CAPTURED NOTHING               -> HARNESS_ERROR (an empty capture is never a pass)
//   7. THE OVERLAY DID NOT APPLY ON ONE LEG             -> HARNESS_ERROR (the leg drove the preset's note)
//   8. A MEMBER ADDED SOMEWHERE ELSE IN THE BODY        -> bodySha256Equal with an EMPTY layout diagnosis
//                                                          (the "difference is elsewhere" branch)
//   9. THE PINNED EXPECTATION MISSING FOR A CASE        -> BLOCKED (no oracle is not equality)
//  10. THE PINNED PREPARATION AND THE PINNED LEG DISAGREE -> HARNESS_ERROR (not a product finding)
//  11. THE WHOLE SWEEP OF IDENTICAL CAPTURES            -> HARNESS_ERROR (a sweep that cannot discriminate)
//  12. THE DISABLED CASE SENT THE ENABLED CAPTURE       -> the disabled-case contract
//
// Usage: node tests/browser/authors-note-gate-selftest.mjs [--expectations <file>]
// Exit:  0 when every mutation was caught AND the baseline is green; 1 naming what was missed.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { AUTHORS_NOTE_OVERLAY_MARKER, MARKERS, authorsNoteOverlaySpec, parseProviderBody, resolveAuthorsNoteCase } from './preset-kit.mjs';
import { compareCase } from './compare-authors-note-legs.mjs';
import { authorsNotePinnedFixture, observationOf, sweepVerdict } from './authors-note-sweep-kit.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const expectationsIndex = argv.indexOf('--expectations');
const expectationsPath = expectationsIndex >= 0 ? path.resolve(argv[expectationsIndex + 1]) : authorsNotePinnedFixture();
const overlay = authorsNoteOverlaySpec();

const clone = value => JSON.parse(JSON.stringify(value));

// A SYNTHETIC, PARSED BODY FOR A CASE. The note is placed `historyBelow` turns from the newest position,
// every other element the scenario owns sits above it, and the shape is the shape the pinned frontend
// produces ({role, content, name?} -- `MessageCollection.getChat`, scripts/openai.js:3832-3847). It is built
// from the expectation's MEASURED numbers, so a mutation moves the note relative to a layout the pinned leg
// actually produced, not relative to a guess.
function syntheticBody(caseId, expectation) {
    const resolved = resolveAuthorsNoteCase(overlay, caseId);
    const measured = expectation?.layout ?? {};
    const noteIndex = Number.isInteger(measured.noteIndex) ? measured.noteIndex : 6;
    const messageCount = Number.isInteger(measured.messageCount) ? measured.messageCount : 20;
    const messages = [];
    for (let index = 0; index < messageCount; index++) {
        messages.push({ role: 'system', content: `${MARKERS.wiBefore} world before ${index}` });
    }
    // The scenario's history turns occupy the tail, so "history below the note" is a real measurement.
    const historyTurns = 12;
    for (let turn = 0; turn < historyTurns; turn++) {
        messages[messageCount - historyTurns + turn] = {
            role: turn % 2 === 0 ? 'user' : 'assistant',
            name: turn % 2 === 0 ? 'Probe User' : 'Character',
            content: `${MARKERS.history} SYNTH_TURN_${String(turn).padStart(2, '0')} synthetic`,
        };
    }
    if (resolved.enabled !== false) {
        messages[noteIndex] = { role: resolved.role === 'assistant' ? 'assistant' : (resolved.role === 'user' ? 'user' : 'system'), content: resolved.text };
    }
    return { messages };
}

function reportFor(caseId, expectation, options = {}) {
    const body = options.body ?? syntheticBody(caseId, expectation);
    const text = options.raw ?? JSON.stringify(body);
    const resolved = resolveAuthorsNoteCase(overlay, caseId);
    return {
        requestArrived: true,
        recording: [{
            method: 'POST',
            path: '/v1/chat/completions',
            body: text,
            bodyLength: Buffer.byteLength(text, 'utf8'),
            bodySha256: createHash('sha256').update(text).digest('hex'),
        }],
        failure: options.failure ?? null,
        preset: { variant: 'keep', maxContextApplied: 4253, problems: [], chatTurns: 13 },
        authorsNoteOverlay: {
            requested: { ...resolved, caseId },
            applied: { caseId, extensionPrompt: resolved.enabled === false ? { value: '', position: -1 } : { value: resolved.text, position: 1, depth: resolved.depth } },
            problems: options.overlayProblems ?? [],
        },
        ...(options.extra ?? {}),
    };
}

// THE BASELINE COMES FROM THE REAL LEGS WHEN THEY ARE AVAILABLE, AND THAT IS THE POINT.
//
// The first version synthesised a body for every case from the golden's LAYOUT and then demanded that the
// golden's `bodySha256` equal the synthetic body's digest. It cannot: the golden's digest is the PINNED
// PREPARATION run's own bytes, and a synthetic reconstruction differs in every member the reconstruction does
// not model (run 40453196861 reported `pinnedPreparationBytesMatchPinnedLeg: false` for the baseline itself).
// A self-test whose baseline cannot be faithful proves nothing about the mutations below it.
//
// So when `--legs <dir>` is given (CI passes the run's own leg directory), the baseline and the "pinned" side
// of every mutation are the REAL reports: the self-test then asks exactly the question the gate asks, and the
// mutations are made against the bytes the run actually produced. Without `--legs` the synthetic builder is
// still used, and the baseline's byte check is reported as NOT MEASURED rather than as a pass.
const legsIndex = argv.indexOf('--legs');
const legsDir = legsIndex >= 0 ? path.resolve(argv[legsIndex + 1]) : null;
function realLeg(caseId, subject) {
    if (!legsDir) return null;
    try {
        return JSON.parse(fs.readFileSync(path.join(legsDir, `authors-note-${caseId}-${subject}.json`), 'utf8'));
    } catch {
        return null;
    }
}
const realLegsAvailable = Boolean(legsDir) && overlay.cases.every(entry => realLeg(entry.id, 'pinned') && realLeg(entry.id, 'gotavern'));

// Mutating a PARSED body and re-digesting it is how a real leg's bytes would change; the observation is then
// produced by the same `observationOf` a real report goes through, so the self-test cannot construct a state
// the comparator could never see.
//
// IT MUST TARGET THE POST, NOT `recording[0]`. A real leg records the /models GET first and the completion
// POST second (`recording` had 2 entries, only index 1 carrying a body), so writing to index 0 mutated an
// entry `parseProviderBody` never reads: every mutation reported PASS against unchanged bytes (run
// 40453196861's self-test, reproduced locally). The index is found by the same predicate the comparator uses.
function mutate(report, mutateBody) {
    const copy = clone(report);
    const entry = (copy.recording ?? []).find(item => item.method === 'POST' && item.body);
    if (!entry) throw new Error('the report has no POST entry with a body to mutate');
    const parsed = parseProviderBody(copy);
    if (!parsed?.body) throw new Error('the report has no parseable POST body to mutate');
    const body = clone(parsed.body);
    mutateBody(body);
    const text = JSON.stringify(body);
    entry.body = text;
    entry.bodyLength = Buffer.byteLength(text, 'utf8');
    entry.bodySha256 = createHash('sha256').update(text).digest('hex');
    return copy;
}

// `legFor` is the single source of a leg report for a case: the REAL one when the run's legs are available,
// otherwise the synthetic reconstruction. Every assertion below goes through it, so the baseline and the
// mutations cannot accidentally read different sources.
const legFor = (caseId, subject) => realLeg(caseId, subject) ?? reportFor(caseId, expectations.cases[caseId]);

let expectations = null;
try {
    expectations = JSON.parse(fs.readFileSync(expectationsPath, 'utf8'));
} catch (error) {
    console.error(`authors-note-gate-selftest REFUSES: the pinned expectation is unreadable at ${expectationsPath} (${error?.message ?? error})`);
    console.error('the self-test cannot build a discriminating baseline without it; run prepare-authors-note.mjs against the pinned leg first');
    process.exit(1);
}
const caseIds = overlay.cases.map(entry => entry.id);
const missingCases = caseIds.filter(id => !expectations?.cases?.[id]?.layout);
if (missingCases.length > 0) {
    console.error(`authors-note-gate-selftest REFUSES: the pinned expectation covers no layout for ${missingCases.join(', ')}`);
    process.exit(1);
}

const failures = [];
// THE MUTATION COUNT IS DERIVED, not written as a literal that drifts: every `mutation(...)` call increments
// it, so a file that runs 14 mutations cannot print "13 caught", and a mutation silently deleted shows up as
// a smaller number rather than as a passing summary.
let MUTATION_COUNT = 0;
const record = (name, ok, detail) => {
    console.log(`${ok ? 'ok  ' : 'MISS'} ${name}${detail ? ` -- ${detail}` : ''}`);
    if (!ok) failures.push(name);
};
const mutation = (name, ok, detail) => {
    MUTATION_COUNT += 1;
    record(name, ok, detail);
};

// Judge one case from REPORT OBJECTS (the self-test's shape), reusing the comparator's own observation
// function so a mutation cannot mean something different here than it would in a run.
const judge = (caseId, gotavernReport, pinnedReport, expectationsOverride = expectations) => compareCase({
    caseId,
    expectation: expectationsOverride?.cases?.[caseId] ?? null,
    gotavern: gotavernReport ? observationOf(gotavernReport, 'GoTavern') : { __error: 'the GoTavern report is absent' },
    pinned: observationOf(pinnedReport, 'pinned'),
    overlay,
});
const failedChecksOf = result => Object.entries(result.checks ?? {}).filter(([, value]) => value === false).map(([name]) => name);

// 0. THE BASELINE MUST PASS. A comparator that is red on a faithful pair would "catch" every mutation below
//    for the wrong reason. The baseline is the REAL pair when the run's legs are available -- the same two
//    reports the gate itself judged -- so "faithful" here means what it means in the gate.
const parityBaseline = judge('parity', legFor('parity', 'gotavern'), legFor('parity', 'pinned'));
record(`baseline is faithful (verdict PASS, no failed check) [${realLegsAvailable ? 'real legs' : 'synthetic, byte check NOT measured'}]`,
    parityBaseline.verdict === 'PASS' && failedChecksOf(parityBaseline).length === 0,
    JSON.stringify({ verdict: parityBaseline.verdict, failedChecks: failedChecksOf(parityBaseline), reason: parityBaseline.reason }));
if (!realLegsAvailable) {
    // SAID OUT LOUD, because a synthetic baseline cannot check `pinnedPreparationBytesMatchPinnedLeg`: its
    // body is a reconstruction, not the preparation run's bytes. Without this note the synthetic mode reads as
    // a green baseline when one of its two checks was never measured.
    console.log('     note: no --legs directory was supplied, so the golden\'s byte digest is compared against a');
    console.log('           RECONSTRUCTION; the preparation-vs-leg byte check is NOT measured in this mode.');
}

// 1. THE NOTE ONE MESSAGE DEEPER.
{
    const expectation = expectations.cases.parity;
    const moved = mutate(legFor('parity', 'pinned'), body => {
        const index = body.messages.findIndex(message => String(message.content ?? '').includes(AUTHORS_NOTE_OVERLAY_MARKER));
        const [note] = body.messages.splice(index, 1);
        body.messages.splice(Math.max(0, index - 1), 0, note);
    });
    const result = judge('parity', moved, legFor('parity', 'pinned'));
    mutation('a note one message deeper is caught by layout.historyAbove/layout.historyBelow',
        result.verdict === 'PRODUCT_MISMATCH'
        && (result.checks?.['layout.historyBelow'] === false || result.checks?.['layout.historyAbove'] === false || result.checks?.['layout.noteIndex'] === false),
        JSON.stringify({ verdict: result.verdict, failedChecks: failedChecksOf(result), reason: result.reason }));
}

// 2. THE NOTE ONE MESSAGE SHALLOWER.
{
    const expectation = expectations.cases.parity;
    const moved = mutate(legFor('parity', 'pinned'), body => {
        const index = body.messages.findIndex(message => String(message.content ?? '').includes(AUTHORS_NOTE_OVERLAY_MARKER));
        const [note] = body.messages.splice(index, 1);
        body.messages.splice(Math.min(body.messages.length, index + 1), 0, note);
    });
    const result = judge('parity', moved, legFor('parity', 'pinned'));
    mutation('a note one message shallower is caught',
        result.verdict === 'PRODUCT_MISMATCH'
        && (result.checks?.['layout.historyBelow'] === false || result.checks?.['layout.historyAbove'] === false || result.checks?.['layout.noteIndex'] === false),
        JSON.stringify({ verdict: result.verdict, failedChecks: failedChecksOf(result) }));
}

// 3. THE NOTE'S ROLE CHANGED, POSITION UNCHANGED.
{
    const expectation = expectations.cases.parity;
    const changed = mutate(legFor('parity', 'pinned'), body => {
        const note = body.messages.find(message => String(message.content ?? '').includes(AUTHORS_NOTE_OVERLAY_MARKER));
        if (note) note.role = 'user';
    });
    const result = judge('parity', changed, legFor('parity', 'pinned'));
    mutation('a note with the wrong ROLE is caught by layout.noteRole',
        result.verdict === 'PRODUCT_MISMATCH' && result.checks?.['layout.noteRole'] === false,
        JSON.stringify({ verdict: result.verdict, failedChecks: failedChecksOf(result), reason: result.reason }));
}

// 4. THE NOTE'S TEXT CHANGED, SAME POSITION: the mutation a layout-only comparator would MISS.
{
    const expectation = expectations.cases.parity;
    const changed = mutate(legFor('parity', 'pinned'), body => {
        const note = body.messages.find(message => String(message.content ?? '').includes(AUTHORS_NOTE_OVERLAY_MARKER));
        if (note) note.content = `${note.content} (edited)`;
    });
    const result = judge('parity', changed, legFor('parity', 'pinned'));
    const layoutChecksAllTrue = failedChecksOf(result).every(name => !name.startsWith('layout.'));
    mutation('a note with the wrong TEXT at the RIGHT position is caught by the bytes, not by the layout',
        result.verdict === 'PRODUCT_MISMATCH' && result.checks?.bodySha256Equal === false && layoutChecksAllTrue,
        JSON.stringify({ verdict: result.verdict, failedChecks: failedChecksOf(result), reason: result.reason }));
}

// 5. THE NOTE REMOVED FROM THE GOTAVERN LEG.
{
    const expectation = expectations.cases.parity;
    const removed = mutate(legFor('parity', 'pinned'), body => {
        const index = body.messages.findIndex(message => String(message.content ?? '').includes(AUTHORS_NOTE_OVERLAY_MARKER));
        if (index >= 0) body.messages.splice(index, 1);
    });
    const result = judge('parity', removed, legFor('parity', 'pinned'));
    mutation('a missing note is caught by layout.noteIndex/layout.noteCarriesTheCaseText',
        result.verdict === 'PRODUCT_MISMATCH'
        && (result.checks?.['layout.noteIndex'] === false || result.checks?.['layout.noteCarriesTheCaseText'] === false),
        JSON.stringify({ verdict: result.verdict, failedChecks: failedChecksOf(result) }));
}

// 6. THE GOTAVERN LEG CAPTURED NOTHING. An empty capture must be HARNESS_ERROR, never a pass.
{
    const empty = { requestArrived: false, recording: [], failure: null, authorsNoteOverlay: legFor('parity', 'pinned').authorsNoteOverlay };
    const result = judge('parity', empty, legFor('parity', 'pinned'));
    mutation('an empty capture is HARNESS_ERROR, never a comparison',
        result.verdict === 'HARNESS_ERROR' && result.checks?.gotavernProducedARequest === false,
        JSON.stringify({ verdict: result.verdict, reason: result.reason }));
}

// 7. THE OVERLAY DID NOT APPLY ON ONE LEG (the leg drove the preset's own note).
{
    const stale = reportFor('parity', expectations.cases.parity, { overlayProblems: ["the note did not reach extension_prompts[\"2_floating_prompt\"]"] });
    const result = judge('parity', stale, legFor('parity', 'pinned'));
    mutation('a leg whose overlay did not apply is HARNESS_ERROR',
        result.verdict === 'HARNESS_ERROR' && result.checks?.gotavernOverlayApplied === false,
        JSON.stringify({ verdict: result.verdict, reason: result.reason }));
}

// 8. A MEMBER ADDED ELSEWHERE IN THE BODY: right layout, different bytes, and the diagnosis must SAY SO
//    rather than claim the note moved.
{
    const expectation = expectations.cases.parity;
    const changed = mutate(legFor('parity', 'pinned'), body => { body.temperature = 0.99; });
    const result = judge('parity', changed, legFor('parity', 'pinned'));
    mutation('a difference outside the note is reported as such, not as a depth difference',
        result.verdict === 'PRODUCT_MISMATCH'
        && result.checks?.bodySha256Equal === false
        && String(result.reason ?? '').includes('elsewhere in the body'),
        JSON.stringify({ verdict: result.verdict, reason: result.reason }));
}

// 9. NO ORACLE FOR THE CASE.
{
    const withoutCase = clone(expectations);
    delete withoutCase.cases.parity;
    const result = judge('parity', legFor('parity', 'pinned'), legFor('parity', 'pinned'), withoutCase);
    mutation('a case the pinned leg never measured is BLOCKED, not PASS',
        result.verdict === 'BLOCKED',
        JSON.stringify({ verdict: result.verdict, reason: result.reason }));
}

// 10. THE PINNED PREPARATION AND THE PINNED LEG DISAGREE.
{
    const expectation = expectations.cases.parity;
    const drifted = mutate(legFor('parity', 'pinned'), body => { body.messages.push({ role: 'user', content: 'a message the preparation drive never saw' }); });
    const result = judge('parity', legFor('parity', 'pinned'), drifted);
    mutation('a pinned leg that disagrees with the pinned preparation is HARNESS_ERROR',
        result.verdict === 'HARNESS_ERROR'
        && (result.checks?.pinnedPreparationMatchesPinnedLeg === false || result.checks?.pinnedPreparationBytesMatchPinnedLeg === false),
        JSON.stringify({ verdict: result.verdict, reason: result.reason }));
}

// 11. A SWEEP OF IDENTICAL CAPTURES MUST FAIL ITSELF. This is the failure that matters most: seven names, one
//     behaviour, everything "agreeing".
{
    const uniform = clone(expectations);
    const parityCase = uniform.cases.parity;
    for (const id of caseIds) {
        uniform.cases[id] = clone(parityCase);
    }
    const results = caseIds.map(id => compareCase({
        caseId: id,
        expectation: uniform.cases[id],
        gotavern: observationOf(reportFor(id, uniform.cases[id], { body: syntheticBody('parity', parityCase) }), 'GoTavern'),
        pinned: observationOf(reportFor(id, uniform.cases[id], { body: syntheticBody('parity', parityCase) }), 'pinned'),
        overlay,
    }));
    const sweep = sweepVerdict({ results, overlay, expectations: uniform });
    mutation('a sweep whose cases produce one identical capture is HARNESS_ERROR',
        sweep.verdict === 'HARNESS_ERROR'
        && (sweep.checks.theCapturesDiffer === false || sweep.checks.aDeeperCaseIsStrictlyDeeperThanParity === false || sweep.checks.depthZeroIsTheNewestPosition === false),
        JSON.stringify({ verdict: sweep.verdict, reason: sweep.reason, failed: Object.entries(sweep.checks).filter(([, value]) => value !== true).map(([name]) => name) }));
}

// 12. THE DISABLED CASE CARRYING THE ENABLED CAPTURE: a disable switch that does nothing must not pass.
//
// THE REAL DISABLED LEG IS THE INPUT, because a synthetic body cannot express the state this mutation is
// about: the disabled leg's request carries NO note, and the mutation has to put one back. With the run's
// legs available the note is injected into the real disabled POST; the per-case comparator and the
// byte comparison must both reject it. (Without legs the synthetic parity body is used, and the assertion
// still has to hold.)
{
    const disabledId = caseIds.find(id => resolveAuthorsNoteCase(overlay, id).enabled === false);
    if (!disabledId) {
        mutation('the overlay records a disabled case', false, 'no case has enabled === false');
    } else {
        const expectation = expectations.cases[disabledId];
        const disabledLeg = legFor(disabledId, 'pinned');
        const wrong = mutate(disabledLeg, body => {
            const messages = Array.isArray(body.messages) ? body.messages : [];
            if (messages.some(message => String(message.content ?? '').includes(AUTHORS_NOTE_OVERLAY_MARKER))) {
                throw new Error('the disabled capture already carries the note, so this mutation would be vacuous');
            }
            // A note that reached the request for a case the product disables: the newest position is where an
            // enabled depth-0 note would sit, so this models "the disable switch did nothing".
            messages.push({ role: 'system', content: `${AUTHORS_NOTE_OVERLAY_MARKER} a note the disable switch should have removed` });
        });
        const result = judge(disabledId, wrong, legFor(disabledId, 'pinned'));
        mutation(`the disabled case (${disabledId}) carrying an enabled capture is caught`,
            // Any non-PASS is a catch, and the REASON is recorded so a reader can see it was caught for the
            // right cause (bytes differ / the note is present where it must be absent) rather than by accident.
            result.verdict !== 'PASS'
            && (result.checks?.bodySha256Equal === false || result.checks?.['layout.noteCarriesTheCaseText'] === false || String(result.reason ?? '').length > 0),
            JSON.stringify({ verdict: result.verdict, reason: result.reason, failedChecks: failedChecksOf(result) }));
    }
}

// 13. THE EXPECTATION FILE ITSELF MUST CLAIM THE PINNED LEG.
{
    const unattributed = clone(expectations);
    unattributed.measuredBy = 'hand-derived';
    const results = caseIds.map(id => compareCase({
        caseId: id,
        expectation: unattributed.cases[id],
        gotavern: observationOf(reportFor(id, unattributed.cases[id]), 'GoTavern'),
        pinned: observationOf(reportFor(id, unattributed.cases[id]), 'pinned'),
        overlay,
    }));
    const sweep = sweepVerdict({ results, overlay, expectations: unattributed });
    mutation('an expectation that does not say measuredBy="pinned-leg" fails the sweep',
        sweep.checks.expectationIsPinnedDerived === false && sweep.verdict !== 'PASS',
        JSON.stringify({ verdict: sweep.verdict, reason: sweep.reason }));
}

// 14. DEPTH 0 IN THE WRONG DIRECTION. This is the mutation for the mistake the mechanism makes easy: pinned
//     builds the list NEWEST-FIRST (openai.js:578) and splices at `depth + totalInserted` (:867), so depth 0
//     is the LAST message. A harness (or a product) with the direction reversed would put the depth-0 note at
//     the TOP, with every history turn below it -- which the strengthened assertion must catch, because the
//     previous "strictly fewer than parity" form would have called that a pass whenever the note still sat
//     below at least one turn.
{
    const zeroExpectation = expectations.cases.depth0;
    // The WRONG layout for depth 0: the note moved to the HEAD of the list, so every history turn sits below
    // it. Applied through `mutate` -- against the REAL depth-0 GoTavern leg when the run supplies one -- so the
    // only thing changed is the note's position, exactly as a reversed implementation would produce.
    const zeroLeg = legFor('depth0', 'gotavern');
    const wrong = mutate(zeroLeg, body => {
        const messages = Array.isArray(body.messages) ? body.messages : [];
        const noteIndex = messages.findIndex(message => String(message.content ?? '').includes(AUTHORS_NOTE_OVERLAY_MARKER));
        if (noteIndex < 0) throw new Error('the depth-0 leg carries no note to move, so this mutation would be vacuous');
        const [note] = messages.splice(noteIndex, 1);
        messages.unshift(note);
    });
    const results = caseIds.map(id => compareCase({
        caseId: id,
        expectation: expectations.cases[id],
        gotavern: observationOf(id === 'depth0' ? wrong : legFor(id, 'gotavern'), 'GoTavern'),
        pinned: observationOf(legFor(id, 'pinned'), 'pinned'),
        overlay,
    }));
    const sweep = sweepVerdict({ results, overlay, expectations });
    // LOCAL vs SWEEP-LEVEL, STATED EXPLICITLY. The per-case comparator already rejects a depth-0 note at the
    // head of the list as PRODUCT_MISMATCH (it names index 0 vs 21 and 12-vs-0 history below/above), so the
    // sweep never gets the chance to fail -- "every case agreed" is correctly false. The check that matters is
    // therefore EITHER that the case was rejected by name, OR that the sweep-level monotonicity check caught
    // it; demanding only the second made a working gate look broken, which is its own kind of false red.
    const zeroResult = results.find(entry => entry.caseId === 'depth0');
    const rejectedPerCase = zeroResult?.verdict === 'PRODUCT_MISMATCH'
        && (zeroResult?.checks?.['layout.historyBelow'] === false || zeroResult?.checks?.['layout.noteIndex'] === false);
    mutation('a depth-0 case placed at the TOP of the list (the reversed direction) is rejected by name',
        (rejectedPerCase || sweep.checks.depthZeroIsTheNewestPosition === false) && sweep.verdict !== 'PASS',
        JSON.stringify({
            verdict: sweep.verdict,
            depthZeroVerdict: zeroResult?.verdict ?? null,
            depthZeroFailedChecks: Object.entries(zeroResult?.checks ?? {}).filter(([, value]) => value === false).map(([name]) => name),
            sweepDepthZeroCheck: sweep.checks.depthZeroIsTheNewestPosition,
            reason: zeroResult?.reason ?? sweep.reason,
        }));
}

console.log(failures.length === 0
    ? `authors-note gate self-test: ${MUTATION_COUNT} mutations caught, baseline green`
    : `authors-note gate self-test: ${failures.length} mutation(s) NOT caught: ${failures.join(', ')}`);
process.exit(failures.length === 0 ? 0 : 1);
