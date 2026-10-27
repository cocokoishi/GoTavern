// Q17 -- COMPARE THE AUTHOR'S NOTE LAYOUT ON BOTH SUBJECTS, AGAINST THE PINNED LAYOUT, FAIL-CLOSED.
//
// THE QUESTION (GOAL.md Q17, docs/goal-scorecard.md): "Is Author's Note depth the same?"
//
// WHY A LAYOUT AND NOT A BYTE DIGEST. The preset legs already compare provider bytes, and they would go red
// if the note landed in a different place -- but a red byte digest says "the bodies differ" and nothing about
// WHICH of the note, the history, the world info or the budget moved. Q17 is a positional claim, so this
// comparator measures a layout: the note's index, how many HISTORY turns sit on each side of it, and which
// of the competing injections (world info before/after/at-depth, the scenario's own chat turns) are above
// it. `historyBelow` is the number the pinned frontend's own `injectIdx = depth + totalInserted`
// (public/scripts/openai.js:867) produces, and it is stable when the frontend adds unrelated messages ahead
// of the history -- which the raw index is not.
//
// THREE THINGS MUST HOLD, AND EACH CAN FAIL:
//   1. THE ORACLE EXISTS AND WAS MEASURED BY THE PINNED LEG (prepare-authors-note.mjs). A missing pinned
//      layout is `BLOCKED`, never `PASS`.
//   2. PINNED == PINNED: the pinned layout recorded by the preparation drive equals the layout of the
//      request the pinned LEG of the differential produced. If these differ, the two runs are not the same
//      scenario and nothing below is attributable, so the verdict is `HARNESS_ERROR`.
//   3. GO == PINNED on the LAYOUT AND ON THE BYTES, per case. The request is still compared byte-for-byte
//      (`bodySha256` + `bodyLength`): the layout is the DIAGNOSIS of a difference, never a substitute for it
//      (AGENTS.md differential doctrine 2, and GOAL.md 10 forbids comparing only a parsed view).
//
// PLUS THE CASE-LEVEL CONTRACT, which is what makes this a measurement of DEPTH rather than of "the note is
// somewhere in the body":
//   * the depth-0 case puts the note where the pinned leg put it (the newest position);
//   * a deeper case puts it strictly deeper than the parity case, on both subjects, measured as
//     `historyBelow` -- so the sweep cannot pass by driving the same depth seven times under seven names;
//   * the deeper-than-history case is at least as deep as the oldest turn, i.e. the pinned clamp
//     (`Math.min(depth + totalInserted, messages.length)`) bound;
//   * the disabled case carries NO note on either subject, and its request is still compared -- a leg that
//     sent nothing is `HARNESS_ERROR`, not a pass (there is no "no note" without a request);
//   * the IN_PROMPT case's position does not move with the depth, exactly as the pinned source says
//     (`getPromptPosition`, scripts/openai.js:1140-1150): recorded as a stated property, and asserted as
//     "the note is not in the chat region" rather than as "position == depth".
//
// VERDICT TAXONOMY (AGENTS.md differential doctrine 5), one per case:
//   PASS            both legs produced a request, both agree with the pinned layout and the pinned bytes
//   PRODUCT_MISMATCH the requests differ: the note moved, or the bytes differ
//   PINNED_BEHAVIOR  the pinned leg's own layout is not what the pinned source's stated contract implies
//                    (e.g. an IN_CHAT note that is not in the assembled list at all). A finding about
//                    upstream, reported as such rather than blamed on GoTavern.
//   HARNESS_ERROR   a leg did not produce a request, a leg's overlay did not apply, or the pinned
//                   preparation disagrees with the pinned leg -- the comparison cannot be attributed
//   INFRA_ERROR     a leg's report file is missing or unreadable
//   BLOCKED         the pinned expectation does not cover this case (the preparation drive failed for it)
//
// Usage: node compare-authors-note-legs.mjs --expectations <authors-note-pinned.json> --case <id> \
//            <gotavern-report.json> <pinned-report.json> [--out <file>]
//        node compare-authors-note-legs.mjs --self-check
// Exit:  0 only when every case is PASS.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { MARKERS, authorsNoteOverlaySpec, layoutOf, parseProviderBody, resolveAuthorsNoteCase } from './preset-kit.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

const VERDICTS = ['PRODUCT_MISMATCH', 'PINNED_BEHAVIOR', 'HARNESS_ERROR', 'INFRA_ERROR', 'BLOCKED', 'PASS'];
const FORBIDDEN = [/127\.0\.0\.1/, /localhost:\d+/, /\[::1\]/, /[A-Za-z]:\\\\/, /AppData/i, /\/home\//, /\/tmp\//, /\/Users\//, /\/root\//];

// ---------------------------------------------------------------------------------------------
// SELF-CHECK: resolve every identifier this module uses and REFUSE on a missing fixture or case.
//
// `node --check` validates syntax only. An undefined identifier, a marker that no longer exists, or a case
// name that drifted out of preset-kit.mjs would otherwise surface as a leg that drove for two minutes and
// then reported a body difference. CI runs this first, and it is a REFUSAL (exit 1), never a skip.
// ---------------------------------------------------------------------------------------------
function selfCheck(expectationsPath) {
    const problems = [];
    for (const [name, value] of [['layoutOf', layoutOf], ['parseProviderBody', parseProviderBody], ['resolveAuthorsNoteCase', resolveAuthorsNoteCase], ['authorsNoteOverlaySpec', authorsNoteOverlaySpec]]) {
        if (typeof value !== 'function') problems.push(`preset-kit.mjs does not export ${name}`);
    }
    for (const marker of ['history', 'authorsNote_DEPTH', 'authorsNote', 'wiBefore', 'wiAfter', 'wiDepth']) {
        if (!MARKERS?.[marker]) problems.push(`preset-kit.mjs does not declare MARKERS.${marker}`);
    }
    const overlay = typeof authorsNoteOverlaySpec === 'function' ? authorsNoteOverlaySpec() : null;
    const ids = (overlay?.cases ?? []).map(entry => entry.id);
    for (const required of ['depth0', 'depth-deeper-than-history', 'parity']) {
        if (!ids.includes(required)) problems.push(`the overlay case list has no ${JSON.stringify(required)} case (it has ${JSON.stringify(ids)})`);
    }
    if (!ids.some(id => /in[-_]prompt/i.test(id))) problems.push('the overlay case list records no non-IN_CHAT position case');
    if (!ids.some(id => { try { return resolveAuthorsNoteCase(overlay, id).enabled === false; } catch { return false; } })) problems.push('the overlay case list records no DISABLED case');
    if (!ids.some(id => { try { return resolveAuthorsNoteCase(overlay, id).depth === 0; } catch { return false; } })) problems.push('the overlay case list records no depth-0 case');
    // A DEEP CASE MUST BE DEEPER THAN THE PARITY ANCHOR, by the numbers, or "strictly deeper" below can
    // never hold and the case would pass for the wrong reason.
    const parityDepth = Number(overlay?.parityDepth ?? NaN);
    const deeper = ids.map(id => resolveAuthorsNoteCase(overlay, id)).filter(entry => entry.depthIntent === 'item' && entry.depth > parityDepth);
    if (deeper.length === 0) problems.push(`no case resolves to a depth above the parity anchor ${JSON.stringify(parityDepth)}`);
    // THE FIXTURE. Refuse when the pinned expectation file is absent -- "no oracle" must not read as "equal".
    const target = expectationsPath ?? path.join(here, 'fixtures', 'authors-note-pinned.json');
    try {
        const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
        if (parsed?.measuredBy !== 'pinned-leg') problems.push(`${target} does not say measuredBy: "pinned-leg"`);
        const covered = Object.keys(parsed?.cases ?? {});
        if (covered.length === 0) problems.push(`${target} records no cases`);
        const missing = ids.filter(id => !covered.includes(id));
        if (missing.length > 0) problems.push(`${target} has no measured layout for case(s) ${missing.join(', ')}; the comparator refuses cases the pinned leg never measured`);
    } catch (error) {
        problems.push(`the pinned expectation is unreadable at ${target} (${error?.message ?? error}); run prepare-authors-note.mjs against the pinned leg first`);
    }
    if (problems.length > 0) {
        console.error(`compare-authors-note-legs SELF-CHECK FAILED: ${problems.join('; ')}`);
        return 1;
    }
    console.log(JSON.stringify({ selfCheck: 'ok', cases: ids, expectations: target }));
    return 0;
}

// ---------------------------------------------------------------------------------------------
// Reading one leg.
// ---------------------------------------------------------------------------------------------
function readLeg(file, subject) {
    if (!file) return { __error: `no ${subject} report was supplied` };
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
        return { __error: `the ${subject} report ${path.basename(file)} is unreadable (${error?.message ?? error})` };
    }
}

// legObservation turns a drive report into the observation this comparator judges. Every field it needs is
// named, and a missing one is an error rather than a default: an empty capture must never compare equal to
// another empty capture.
function legObservation(report, subject) {
    if (report.__error) return { error: report.__error };
    const parsed = parseProviderBody(report);
    const recordingCount = Array.isArray(report.recording) ? report.recording.length : 0;
    if (!parsed) {
        return {
            error: recordingCount === 0
                ? `the ${subject} leg captured no provider request at all (recording is empty)`
                : `the ${subject} leg captured ${recordingCount} request(s) but none is a readable POST with a JSON body`,
            requestArrived: report.requestArrived === true,
            recordingCount,
            failure: report.failure ?? null,
        };
    }
    const layout = layoutOf(parsed.body, {
        historyMarker: MARKERS.history,
        noteMarker: MARKERS.authorsNote_DEPTH,
        presetNoteMarker: MARKERS.authorsNote,
    });
    return {
        requestArrived: report.requestArrived === true,
        // THE BYTES ARE THE CONTRACT (doctrine 2): the digest and the length, never a re-serialisation.
        bodySha256: parsed.bodySha256 ?? null,
        bodyLength: parsed.bodyLength ?? null,
        bodyLengthFromRaw: parsed.raw ? Buffer.byteLength(parsed.raw, 'utf8') : null,
        memberOrder: Object.keys(parsed.body ?? {}),
        messageCount: Array.isArray(parsed.body?.messages) ? parsed.body.messages.length : null,
        layout,
        overlay: report.authorsNoteOverlay ?? null,
        overlayProblems: Array.isArray(report.authorsNoteOverlay?.problems) ? report.authorsNoteOverlay.problems : null,
        preset: report.preset
            ? {
                variant: report.preset.variant ?? null,
                maxContextApplied: report.preset.maxContextApplied ?? null,
                problems: Array.isArray(report.preset.problems) ? report.preset.problems : [],
                chatTurns: report.preset.chatTurns ?? null,
            }
            : null,
        failure: report.failure ?? null,
    };
}

// ---------------------------------------------------------------------------------------------
// The comparison for ONE case.
// ---------------------------------------------------------------------------------------------
export function compareCase({ caseId, expectation, gotavern, pinned, overlay }) {
    const resolved = resolveAuthorsNoteCase(overlay, caseId);
    const checks = {};
    const details = {};
    const fail = (verdict, reason, extra = {}) => ({
        caseId,
        case: {
            depth: resolved.depth,
            position: resolved.position,
            interval: resolved.interval,
            role: resolved.role,
            enabled: resolved.enabled !== false,
            depthIntent: resolved.depthIntent ?? null,
        },
        verdict,
        reason,
        checks,
        details: { ...details, ...extra },
    });

    // 0. THE ORACLE. A case the pinned leg never measured cannot be judged, and "unmeasured" is not "equal".
    if (!expectation) {
        return fail('BLOCKED', `the pinned leg measured no layout for case ${caseId}, so there is no oracle to compare against`);
    }
    if (!expectation.layout) {
        return fail('BLOCKED', `the pinned expectation for case ${caseId} carries no layout (the preparation drive recorded ${JSON.stringify(expectation.failure ?? 'no failure reason')})`);
    }
    details.pinnedExpectation = {
        noteIndex: expectation.layout.noteIndex,
        historyAbove: expectation.layout.historyAbove,
        historyBelow: expectation.layout.historyBelow,
        messageCount: expectation.layout.messageCount,
        bodySha256: expectation.bodySha256 ?? null,
        bodyLength: expectation.bodyLength ?? null,
    };

    // 1. BOTH LEGS PRODUCED A REQUEST. An empty capture is a harness alarm, never a pass -- and it is
    //    checked BEFORE any equality, because two empty captures would otherwise "agree".
    for (const [subject, leg] of [['gotavern', gotavern], ['pinned', pinned]]) {
        if (leg.error) {
            // A leg whose REPORT is unreadable is infrastructure; one that read fine but recorded nothing is
            // the harness. The distinction matters when a run is triaged at 3 a.m.
            checks[`${subject}ProducedARequest`] = false;
            const infra = /unreadable|no .* report was supplied/.test(leg.error);
            return fail(infra ? 'INFRA_ERROR' : 'HARNESS_ERROR', leg.error, { [subject]: leg });
        }
        if (leg.requestArrived !== true) {
            checks[`${subject}ProducedARequest`] = false;
            return fail('HARNESS_ERROR', `the ${subject} leg's report says requestArrived=${JSON.stringify(leg.requestArrived)}; a leg that captured nothing cannot agree with anything`, { [subject]: leg });
        }
        checks[`${subject}ProducedARequest`] = true;
    }

    // 2. EACH LEG'S OVERLAY ACTUALLY APPLIED. A leg that drove the preset's own note instead of this case
    //    would produce a request that agrees with the pinned leg for the wrong reason, so the recorded
    //    overlay state is required and must name this case.
    for (const [subject, leg] of [['gotavern', gotavern], ['pinned', pinned]]) {
        const overlayProblems = leg.overlayProblems ?? null;
        const named = leg.overlay?.requested?.caseId ?? null;
        const appliedOk = Array.isArray(overlayProblems) && overlayProblems.length === 0 && named === caseId;
        checks[`${subject}OverlayApplied`] = appliedOk;
        if (!appliedOk) {
            return fail('HARNESS_ERROR',
                `the ${subject} leg did not record a clean application of case ${caseId} (requested caseId ${JSON.stringify(named)}, problems ${JSON.stringify(overlayProblems?.slice(0, 3) ?? null)})`,
                { [subject]: { overlay: leg.overlay, overlayProblems } });
        }
    }

    // 3. PINNED == PINNED. The preparation drive and the pinned leg are two runs of the same program; if
    //    their layouts or digests differ, the scenario is not reproducible and nothing else is attributable.
    checks.pinnedPreparationMatchesPinnedLeg = expectation.layout.messageCount === pinned.layout.messageCount
        && expectation.layout.noteIndex === pinned.layout.noteIndex
        && expectation.layout.historyBelow === pinned.layout.historyBelow;
    checks.pinnedPreparationBytesMatchPinnedLeg = (expectation.bodySha256 ?? null) !== null
        && expectation.bodySha256 === pinned.bodySha256;
    details.pinnedLeg = { noteIndex: pinned.layout.noteIndex, historyBelow: pinned.layout.historyBelow, messageCount: pinned.layout.messageCount, bodySha256: pinned.bodySha256 };
    if (!checks.pinnedPreparationMatchesPinnedLeg || !checks.pinnedPreparationBytesMatchPinnedLeg) {
        return fail('HARNESS_ERROR',
            'the pinned preparation drive and the pinned leg of the differential disagree, so this case measures two different scenarios',
            { pinned });
    }

    // 4. THE LAYOUT, COMPARED FIELD BY FIELD. Byte equality is checked separately below, but a reader of a
    //    red run needs to know WHICH element moved, so every layout field carries its own check.
    const shapeKeys = ['noteIndex', 'noteRole', 'historyCount', 'historyAbove', 'historyBelow', 'messageCount'];
    for (const key of shapeKeys) {
        checks[`layout.${key}`] = gotavern.layout?.[key] === pinned.layout?.[key];
    }
    for (const key of ['worldBefore', 'worldAfter', 'worldDepth', 'chatTurns']) {
        checks[`layout.aboveNote.${key}`] = gotavern.layout?.aboveNote?.[key] === pinned.layout?.aboveNote?.[key];
    }
    checks.layout.noteCarriesTheCaseText = gotavern.layout?.carriesNoteMarker === pinned.layout?.carriesNoteMarker;
    checks.layout.noteIsNotThePresetNote = gotavern.layout?.carriesPresetNoteInsteadOfOverlay === false
        && pinned.layout?.carriesPresetNoteInsteadOfOverlay === false;

    // 5. THE BYTES. The layout is a diagnosis; the request is the contract.
    checks.bodySha256Equal = gotavern.bodySha256 !== null && gotavern.bodySha256 === pinned.bodySha256;
    checks.bodyLengthEqual = gotavern.bodyLength !== null && gotavern.bodyLength === pinned.bodyLength;
    checks.memberOrderEqual = JSON.stringify(gotavern.memberOrder) === JSON.stringify(pinned.memberOrder);
    checks.messageCountEqual = gotavern.messageCount === pinned.messageCount;

    const failedChecks = Object.entries(checks).filter(([, value]) => value !== true).map(([name]) => name);
    if (failedChecks.length > 0) {
        checks.allLayoutAndByteChecksPassed = false;
        // WHICH ELEMENT MOVED, NAMED. "bodies differ" is not a Q17 report.
        const diagnosis = [];
        if (checks['layout.noteIndex'] === false) diagnosis.push(`the note is at index ${gotavern.layout?.noteIndex} on the ${'GoTavern'} leg and ${pinned.layout?.noteIndex} on pinned`);
        if (checks['layout.historyBelow'] === false) diagnosis.push(`${gotavern.layout?.historyBelow} history turn(s) sit below the note on GoTavern and ${pinned.layout?.historyBelow} on pinned`);
        if (checks['layout.historyAbove'] === false) diagnosis.push(`${gotavern.layout?.historyAbove} history turn(s) sit above the note on GoTavern and ${pinned.layout?.historyAbove} on pinned`);
        if (checks['layout.noteRole'] === false) diagnosis.push(`the note's role is ${JSON.stringify(gotavern.layout?.noteRole)} on GoTavern and ${JSON.stringify(pinned.layout?.noteRole)} on pinned`);
        if (checks.bodySha256Equal === false && diagnosis.length === 0) diagnosis.push('the request bytes differ and the note\'s own position is identical, so the difference is elsewhere in the body');
        return fail('PRODUCT_MISMATCH', diagnosis.length > 0 ? diagnosis.join('; ') : `failed checks: ${failedChecks.join(', ')}`, { failedChecks, gotavern, pinned });
    }
    checks.allLayoutAndByteChecksPassed = true;

    // 6. THE PINNED CONTRACT OF THIS CASE -- measured on the pinned leg, so this is a statement about
    //    upstream that the comparison above relies on. Any failure here is a PINNED_BEHAVIOR finding, not a
    //    GoTavern defect: the differential has already established that both subjects agree.
    const contract = {};
    contractViolations();
    if (Object.values(contract).some(value => value === false)) {
        return fail('PINNED_BEHAVIOR', `both subjects agree, and the agreed behaviour contradicts the pinned source's stated contract for this case: ${Object.entries(contract).filter(([, value]) => value === false).map(([name]) => name).join(', ')}`, { contract, pinned: pinned.layout });
    }

    return {
        caseId,
        case: { depth: resolved.depth, position: resolved.position, interval: resolved.interval, role: resolved.role, enabled: resolved.enabled !== false, depthIntent: resolved.depthIntent ?? null },
        verdict: 'PASS',
        reason: `the note sits at ${pinned.layout.noteIndex} with ${pinned.layout.historyBelow} history turn(s) below it on both subjects, and the request bytes are identical (${pinned.bodyLength} B)`,
        checks: { ...checks, allLayoutAndByteChecksPassed: true },
        details: { ...details, pinnedLeg: { noteIndex: pinned.layout.noteIndex, historyBelow: pinned.layout.historyBelow, messageCount: pinned.layout.messageCount, bodySha256: pinned.bodySha256 }, contract, gotavern: { noteIndex: gotavern.layout.noteIndex, historyBelow: gotavern.layout.historyBelow, bodyLength: gotavern.bodyLength } },
    };

    // The pinned contract for THIS case, expressed against the pinned leg's own layout. Declared as a
    // function so it can be called after the agreement checks without re-reading anything.
    function contractViolations() {
        const pinnedLayout = pinned.layout;
        if (resolved.enabled === false) {
            // The product disables a note by writing position NONE with the text cleared
            // (authors-note.js:351-356). The request must therefore carry NEITHER the overlay's marker nor
            // the preset's own note replaced by it -- and the request must exist, which step 1 established.
            contract.disabledCaseCarriesNoNote = pinnedLayout.carriesNoteMarker === false;
            return;
        }
        contract.noteIsInTheRequest = pinnedLayout.carriesNoteMarker === true;
        contract.noteIsNotFoldedIntoAnotherMessage = pinnedLayout.noteIndex >= 0;
        if (resolved.position === 'IN_CHAT') {
            // Every IN_CHAT depth the sweep drives is below the oldest turn, so the note must be inside the
            // chat region -- otherwise "depth" measured nothing.
            contract.noteIsInsideTheChatRegion = pinnedLayout.noteIndex > pinnedLayout.oldestHistoryIndex
                && pinnedLayout.oldestHistoryIndex >= 0;
        } else {
            // IN_PROMPT is injected into the prompt block, ahead of the chat region, and the depth is not
            // read there (getPromptPosition, openai.js:1140-1150). Say so, so a reader is not left with an
            // "unchanged" case that looks like a failed sweep.
            contract.inPromptCaseSitsAboveTheHistory = pinnedLayout.oldestHistoryIndex >= 0
                && pinnedLayout.noteIndex >= 0 && pinnedLayout.noteIndex < pinnedLayout.oldestHistoryIndex;
        }
    }
}

// ---------------------------------------------------------------------------------------------
// THE SWEEP-LEVEL CONTRACT: the cases must be DIFFERENT from each other, and the order must be the one
// depth predicts. Without this the comparator passes seven identical captures seven times.
// ---------------------------------------------------------------------------------------------
export function compareSweep({ results, overlay }) {
    const checks = {};
    const byCase = Object.fromEntries(results.map(entry => [entry.caseId, entry]));
    const passed = results.filter(entry => entry.verdict === 'PASS');
    const layoutOfCase = id => byCase[id]?.details?.pinnedLeg ?? byCase[id]?.details?.pinnedExpectation ?? null;
    const parity = layoutOfCase('parity');
    checks.parityCaseMeasured = Boolean(parity);
    // DEPTH IS MONOTONE IN THE MEASURED POSITION. `historyBelow` is what the pinned `injectIdx` produces;
    // a deeper case must produce a strictly LARGER value than the parity anchor, and the shallower case a
    // strictly smaller one. Recorded on the pinned numbers because those are the oracle; the per-case
    // comparison above carries the same numbers over to GoTavern.
    const deeperIds = (overlay?.cases ?? []).filter(entry => entry.depthIntent === 'item' && (entry.depthFromParity ?? 0) > 0).map(entry => entry.id);
    const shallowerIds = (overlay?.cases ?? []).filter(entry => entry.depthIntent === 'item' && (entry.depthFromParity ?? 0) < 0).map(entry => entry.id);
    const deepest = deeperIds.map(id => layoutOfCase(id)?.historyBelow ?? null).filter(value => value !== null);
    const shallowest = shallowerIds.map(id => layoutOfCase(id)?.historyBelow ?? null).filter(value => value !== null);
    const zero = layoutOfCase('depth0')?.historyBelow ?? null;
    checks.aDeeperCaseIsStrictlyDeeperThanParity = Boolean(parity) && deepest.length > 0
        && deepest.every(value => value < parity.historyBelow);
    checks.aShallowerCaseIsStrictlyShallowerThanParity = Boolean(parity) && shallowest.length > 0
        && shallowest.every(value => value > parity.historyBelow);
    // DEPTH 0 IS THE NEWEST POSITION: no history below it at all is the pinned clamp's other end
    // (`injectIdx = 0 + totalInserted`), and a depth-0 case that behaved like depth 6 would show up here.
    checks.depthZeroIsTheNewestPosition = zero !== null && parity !== null && zero < parity.historyBelow;
    // DEEPER THAN THE HISTORY: the clamp (`Math.min`) bound, which is why that case cannot be strictly
    // deeper than the deepest history turn. Asserted as "the note is above the OLDEST turn", which is the
    // strongest true statement the pinned source supports.
    const deepCase = (overlay?.cases ?? []).find(entry => entry.depthIntent === 'deeper-than-history');
    const deepLayout = deepCase ? layoutOfCase(deepCase.id) : null;
    checks.deeperThanHistoryReachesTheClamp = Boolean(deepLayout) && Boolean(parity)
        && deepLayout.historyBelow <= parity.historyBelow
        && deepLayout.noteIndex >= 0;
    // THE CAPTURES DIFFER. A harness whose cases produce one identical request has not swept anything
    // (rule 50 in AGENTS.md: a harness whose captures do not differ must fail itself).
    const digests = new Set(results.map(entry => entry.details?.pinnedLeg?.bodySha256 ?? entry.details?.pinnedExpectation?.bodySha256 ?? null).filter(Boolean));
    checks.theCapturesDiffer = digests.size > 1 && digests.size === results.filter(entry => entry.verdict === 'PASS').length;
    checks.everyCasePassed = results.length > 0 && passed.length === results.length;
    const failed = Object.entries(checks).filter(([, value]) => value !== true).map(([name]) => name);
    return { checks, failed };
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------
const main = () => {
    const args = process.argv.slice(2);
    if (args.includes('--self-check')) {
        const index = args.indexOf('--expectations');
        process.exit(selfCheck(index >= 0 ? path.resolve(args[index + 1]) : null));
    }
    const expectationIndex = args.indexOf('--expectations');
    const caseIndex = args.indexOf('--case');
    const outIndex = args.indexOf('--out');
    const expectationsPath = expectationIndex >= 0 ? path.resolve(args[expectationIndex + 1]) : null;
    const caseId = caseIndex >= 0 ? args[caseIndex + 1] : null;
    const files = args.filter((value, index) => !value.startsWith('--')
        && index !== expectationIndex + 1 && index !== caseIndex + 1 && index !== outIndex + 1);
    if (!expectationsPath || !caseId || files.length !== 2) {
        console.error('usage: node compare-authors-note-legs.mjs --expectations <pinned.json> --case <id> <gotavern.json> <pinned.json> [--out <file>]');
        process.exit(2);
    }
    const expectations = JSON.parse(fs.readFileSync(expectationsPath, 'utf8'));
    const overlay = authorsNoteOverlaySpec();
    const result = compareCase({
        caseId,
        expectation: expectations?.cases?.[caseId] ?? null,
        gotavern: legObservation(readLeg(files[0], 'GoTavern'), 'GoTavern'),
        pinned: legObservation(readLeg(files[1], 'pinned'), 'pinned'),
        overlay,
    });
    const artifact = {
        schemaVersion: 1,
        surface: 'authors-note',
        question: 'Q17: does Author\'s Note depth place the note where the pinned frontend places it, relative to history, world info and the other injections?',
        pinnedBaseline: expectations?.pinnedBaseline ?? null,
        context: expectations?.context ?? null,
        measuredBy: expectations?.measuredBy ?? null,
        inputs: { gotavern: path.basename(files[0]), pinned: path.basename(files[1]), expectations: path.basename(expectationsPath) },
        cases: [result],
        verdict: result.verdict,
        verdictTaxonomy: VERDICTS,
    };
    const text = JSON.stringify(artifact, null, 2);
    const leaked = FORBIDDEN.filter(pattern => pattern.test(text));
    artifact.noHostDerivedValue = leaked.length === 0;
    if (leaked.length > 0) artifact.hostDerivedPatterns = leaked.map(String);
    const body = `${JSON.stringify(artifact, null, 2)}\n`;
    if (outIndex >= 0) fs.writeFileSync(path.resolve(args[outIndex + 1]), body);
    console.log(body);
    if (result.verdict !== 'PASS' || leaked.length > 0) {
        console.error(`case ${caseId}: ${result.verdict} -- ${result.reason}`);
        process.exit(1);
    }
};

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
    main();
}
