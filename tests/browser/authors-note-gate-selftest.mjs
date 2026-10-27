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

// Mutating a PARSED body and re-digesting it is how a real leg's bytes would change; the observation is then
// produced by the same `observationOf` a real report goes through, so the self-test cannot construct a state
// the comparator could never see.
function mutate(report, mutateBody) {
    const parsed = parseProviderBody(report);
    const body = parsed?.body ? clone(parsed.body) : null;
    if (!body) throw new Error('the synthetic report has no parseable body to mutate');
    mutateBody(body);
    const text = JSON.stringify(body);
    const copy = clone(report);
    copy.recording[0].body = text;
    copy.recording[0].bodyLength = Buffer.byteLength(text, 'utf8');
    copy.recording[0].bodySha256 = createHash('sha256').update(text).digest('hex');
    return copy;
}

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
//    for the wrong reason.
const parityBaseline = judge('parity', reportFor('parity', expectations.cases.parity), reportFor('parity', expectations.cases.parity));
record('baseline is faithful (verdict PASS, no failed check)',
    parityBaseline.verdict === 'PASS' && failedChecksOf(parityBaseline).length === 0,
    JSON.stringify({ verdict: parityBaseline.verdict, failedChecks: failedChecksOf(parityBaseline), reason: parityBaseline.reason }));

// 1. THE NOTE ONE MESSAGE DEEPER.
{
    const expectation = expectations.cases.parity;
    const moved = mutate(reportFor('parity', expectation), body => {
        const index = body.messages.findIndex(message => String(message.content ?? '').includes(AUTHORS_NOTE_OVERLAY_MARKER));
        const [note] = body.messages.splice(index, 1);
        body.messages.splice(Math.max(0, index - 1), 0, note);
    });
    const result = judge('parity', moved, reportFor('parity', expectation));
    mutation('a note one message deeper is caught by layout.historyAbove/layout.historyBelow',
        result.verdict === 'PRODUCT_MISMATCH'
        && (result.checks?.['layout.historyBelow'] === false || result.checks?.['layout.historyAbove'] === false || result.checks?.['layout.noteIndex'] === false),
        JSON.stringify({ verdict: result.verdict, failedChecks: failedChecksOf(result), reason: result.reason }));
}

// 2. THE NOTE ONE MESSAGE SHALLOWER.
{
    const expectation = expectations.cases.parity;
    const moved = mutate(reportFor('parity', expectation), body => {
        const index = body.messages.findIndex(message => String(message.content ?? '').includes(AUTHORS_NOTE_OVERLAY_MARKER));
        const [note] = body.messages.splice(index, 1);
        body.messages.splice(Math.min(body.messages.length, index + 1), 0, note);
    });
    const result = judge('parity', moved, reportFor('parity', expectation));
    mutation('a note one message shallower is caught',
        result.verdict === 'PRODUCT_MISMATCH'
        && (result.checks?.['layout.historyBelow'] === false || result.checks?.['layout.historyAbove'] === false || result.checks?.['layout.noteIndex'] === false),
        JSON.stringify({ verdict: result.verdict, failedChecks: failedChecksOf(result) }));
}

// 3. THE NOTE'S ROLE CHANGED, POSITION UNCHANGED.
{
    const expectation = expectations.cases.parity;
    const changed = mutate(reportFor('parity', expectation), body => {
        const note = body.messages.find(message => String(message.content ?? '').includes(AUTHORS_NOTE_OVERLAY_MARKER));
        if (note) note.role = 'user';
    });
    const result = judge('parity', changed, reportFor('parity', expectation));
    mutation('a note with the wrong ROLE is caught by layout.noteRole',
        result.verdict === 'PRODUCT_MISMATCH' && result.checks?.['layout.noteRole'] === false,
        JSON.stringify({ verdict: result.verdict, failedChecks: failedChecksOf(result), reason: result.reason }));
}

// 4. THE NOTE'S TEXT CHANGED, SAME POSITION: the mutation a layout-only comparator would MISS.
{
    const expectation = expectations.cases.parity;
    const changed = mutate(reportFor('parity', expectation), body => {
        const note = body.messages.find(message => String(message.content ?? '').includes(AUTHORS_NOTE_OVERLAY_MARKER));
        if (note) note.content = `${note.content} (edited)`;
    });
    const result = judge('parity', changed, reportFor('parity', expectation));
    const layoutChecksAllTrue = failedChecksOf(result).every(name => !name.startsWith('layout.'));
    mutation('a note with the wrong TEXT at the RIGHT position is caught by the bytes, not by the layout',
        result.verdict === 'PRODUCT_MISMATCH' && result.checks?.bodySha256Equal === false && layoutChecksAllTrue,
        JSON.stringify({ verdict: result.verdict, failedChecks: failedChecksOf(result), reason: result.reason }));
}

// 5. THE NOTE REMOVED FROM THE GOTAVERN LEG.
{
    const expectation = expectations.cases.parity;
    const removed = mutate(reportFor('parity', expectation), body => {
        const index = body.messages.findIndex(message => String(message.content ?? '').includes(AUTHORS_NOTE_OVERLAY_MARKER));
        if (index >= 0) body.messages.splice(index, 1);
    });
    const result = judge('parity', removed, reportFor('parity', expectation));
    mutation('a missing note is caught by layout.noteIndex/layout.noteCarriesTheCaseText',
        result.verdict === 'PRODUCT_MISMATCH'
        && (result.checks?.['layout.noteIndex'] === false || result.checks?.['layout.noteCarriesTheCaseText'] === false),
        JSON.stringify({ verdict: result.verdict, failedChecks: failedChecksOf(result) }));
}

// 6. THE GOTAVERN LEG CAPTURED NOTHING. An empty capture must be HARNESS_ERROR, never a pass.
{
    const empty = { requestArrived: false, recording: [], failure: null, authorsNoteOverlay: reportFor('parity', expectations.cases.parity).authorsNoteOverlay };
    const result = judge('parity', empty, reportFor('parity', expectations.cases.parity));
    mutation('an empty capture is HARNESS_ERROR, never a comparison',
        result.verdict === 'HARNESS_ERROR' && result.checks?.gotavernProducedARequest === false,
        JSON.stringify({ verdict: result.verdict, reason: result.reason }));
}

// 7. THE OVERLAY DID NOT APPLY ON ONE LEG (the leg drove the preset's own note).
{
    const stale = reportFor('parity', expectations.cases.parity, { overlayProblems: ["the note did not reach extension_prompts[\"2_floating_prompt\"]"] });
    const result = judge('parity', stale, reportFor('parity', expectations.cases.parity));
    mutation('a leg whose overlay did not apply is HARNESS_ERROR',
        result.verdict === 'HARNESS_ERROR' && result.checks?.gotavernOverlayApplied === false,
        JSON.stringify({ verdict: result.verdict, reason: result.reason }));
}

// 8. A MEMBER ADDED ELSEWHERE IN THE BODY: right layout, different bytes, and the diagnosis must SAY SO
//    rather than claim the note moved.
{
    const expectation = expectations.cases.parity;
    const changed = mutate(reportFor('parity', expectation), body => { body.temperature = 0.99; });
    const result = judge('parity', changed, reportFor('parity', expectation));
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
    const result = judge('parity', reportFor('parity', expectations.cases.parity), reportFor('parity', expectations.cases.parity), withoutCase);
    mutation('a case the pinned leg never measured is BLOCKED, not PASS',
        result.verdict === 'BLOCKED',
        JSON.stringify({ verdict: result.verdict, reason: result.reason }));
}

// 10. THE PINNED PREPARATION AND THE PINNED LEG DISAGREE.
{
    const expectation = expectations.cases.parity;
    const drifted = mutate(reportFor('parity', expectation), body => { body.messages.push({ role: 'user', content: 'a message the preparation drive never saw' }); });
    const result = judge('parity', reportFor('parity', expectation), drifted);
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
{
    const disabledId = caseIds.find(id => resolveAuthorsNoteCase(overlay, id).enabled === false);
    if (!disabledId) {
        mutation('the overlay records a disabled case', false, 'no case has enabled === false');
    } else {
        const expectation = expectations.cases[disabledId];
        const wrong = reportFor(disabledId, expectation, { body: syntheticBody('parity', expectations.cases.parity) });
        const result = judge(disabledId, wrong, reportFor(disabledId, expectation));
        mutation(`the disabled case (${disabledId}) carrying an enabled capture is caught`,
            result.verdict === 'PRODUCT_MISMATCH' || result.verdict === 'PINNED_BEHAVIOR',
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
    // The WRONG layout: the note at the head of the list, so all the history sits below it.
    const wrong = reportFor('depth0', zeroExpectation, { body: syntheticBody('parity', expectations.cases.parity) });
    const results = caseIds.map(id => {
        const expectation = expectations.cases[id];
        const body = id === 'depth0' ? (wrong.recording[0].body) : undefined;
        const report = body
            ? { ...reportFor(id, expectation), recording: [{ ...reportFor(id, expectation).recording[0], body, bodySha256: createHash('sha256').update(body).digest('hex'), bodyLength: Buffer.byteLength(body, 'utf8') }] }
            : reportFor(id, expectation);
        return compareCase({
            caseId: id,
            expectation,
            gotavern: observationOf(report, 'GoTavern'),
            pinned: observationOf(reportFor(id, expectation), 'pinned'),
            overlay,
        });
    });
    const sweep = sweepVerdict({ results, overlay, expectations });
    mutation('a depth-0 case placed at the TOP of the list (the reversed direction) fails depthZeroIsTheNewestPosition',
        sweep.checks.depthZeroIsTheNewestPosition === false && sweep.verdict !== 'PASS',
        JSON.stringify({ verdict: sweep.verdict, reason: sweep.reason, depthZeroHistoryBelow: results.find(entry => entry.caseId === 'depth0')?.details?.pinnedExpectation?.historyBelow ?? null, failed: Object.entries(sweep.checks).filter(([, value]) => value !== true).map(([name]) => name) }));
}

console.log(failures.length === 0
    ? `authors-note gate self-test: ${MUTATION_COUNT} mutations caught, baseline green`
    : `authors-note gate self-test: ${failures.length} mutation(s) NOT caught: ${failures.join(', ')}`);
process.exit(failures.length === 0 ? 0 : 1);
