// The pieces the Q17 sweep runner and the comparator have to agree on, in ONE place.
//
// WHY THIS FILE EXISTS. The runner drives, the comparator judges, and the self-test has to exercise the
// judges without a browser. Three things must be identical across all of them or the sweep measures its own
// wiring instead of the product:
//
//   1. WHERE A LEG'S REPORT LIVES (`legReportPaths`), because the runner writes them and the comparator
//      reads them: a naming drift would silently judge a stale file from an earlier case;
//   2. HOW A REPORT BECOMES AN OBSERVATION (`observationOf`), because the self-test mutates observations
//      and the comparator must see exactly what a real leg would have produced;
//   3. WHAT THE SWEEP VERDICT MEANS (`sweepVerdict`), the taxonomy in one expression, so the runner cannot
//      report a different word than the artefact carries.
//
// The per-case judging itself lives in compare-authors-note-legs.mjs, which is the module a reader can run
// by hand with two leg files. This file imports it rather than re-implementing it.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AUTHORS_NOTE_OVERLAY_MARKER, MARKERS, authorsNoteOverlaySpec, layoutOf, parseProviderBody } from './preset-kit.mjs';
import { compareCase } from './compare-authors-note-legs.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

// THE COMMITTED EXPECTATION. It is committed because an oracle nobody can read is not reviewable: a moved
// layout must be a diff in review, not a number that changed in a scratch directory.
export function authorsNotePinnedFixture() {
    return path.join(here, 'fixtures', 'authors-note-pinned.json');
}

// One place decides where each leg's evidence lives. The `.gitignore` pattern `authors-note-*.json` covers
// these names; `catalog.test.mjs` asserts that coverage.
export function legReportPaths(directory, caseId, subject) {
    return {
        report: path.join(directory, `authors-note-${caseId}-${subject}.json`),
        redirect: path.join(directory, `redirect-authors-note-${caseId}-${subject}.json`),
    };
}

// A drive report -> the observation the comparator judges. The same function is used by the comparator's CLI
// and by the self-test, so a mutation the self-test makes is the mutation the comparator would have seen.
export function observationOf(report, subject) {
    if (report && report.__error) return report;
    const parsed = report ? parseProviderBody(report) : null;
    const recordingCount = Array.isArray(report?.recording) ? report.recording.length : 0;
    if (!parsed) {
        return {
            error: recordingCount === 0
                ? `the ${subject} leg captured no provider request at all (its recording is empty)`
                : `the ${subject} leg captured ${recordingCount} request(s) but none is a readable POST with a JSON body`,
            requestArrived: report?.requestArrived === true,
            recordingCount,
            failure: report?.failure ?? null,
        };
    }
    return {
        requestArrived: report.requestArrived === true,
        bodySha256: parsed.bodySha256 ?? null,
        bodyLength: parsed.bodyLength ?? null,
        memberOrder: Object.keys(parsed.body ?? {}),
        messageCount: Array.isArray(parsed.body?.messages) ? parsed.body.messages.length : null,
        layout: layoutOf(parsed.body, {
            historyMarker: MARKERS.history,
            noteMarker: AUTHORS_NOTE_OVERLAY_MARKER,
            presetNoteMarker: MARKERS.authorsNote,
        }),
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

function readReport(file, subject) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
        return { __error: `the ${subject} report ${path.basename(file)} is unreadable or absent (${error?.message ?? error})` };
    }
}

// compareAuthorsNoteCase: one case, from two report PATHS. Kept here so the runner and the self-test call the
// same code on the same inputs.
export function compareAuthorsNoteCase({ caseId, expectations, gotavernReportPath, pinnedReportPath, overlay = authorsNoteOverlaySpec() }) {
    return compareCase({
        caseId,
        expectation: expectations?.cases?.[caseId] ?? null,
        gotavern: observationOf(readReport(gotavernReportPath, 'GoTavern'), 'GoTavern'),
        pinned: observationOf(readReport(pinnedReportPath, 'pinned'), 'pinned'),
        overlay,
    });
}

// sweepVerdict: the WHOLE sweep's verdict. It is not "all cases passed": a sweep whose cases all pass on
// ONE identical capture has swept nothing, so the discriminating checks below are part of the verdict.
//
// Precedence is deliberate and stated: an INFRA_ERROR outranks a HARNESS_ERROR outranks a PRODUCT_MISMATCH
// outranks PINNED_BEHAVIOR outranks BLOCKED, because a run that could not set itself up must not be read as
// a product finding. PASS requires every case to have passed AND the sweep to be discriminating.
export function sweepVerdict({ results, overlay, expectations }) {
    const checks = {};
    const layoutFor = id => {
        const entry = results.find(result => result.caseId === id);
        const measured = entry?.details?.pinnedExpectation ?? entry?.details?.pinnedLeg ?? null;
        return measured;
    };
    const parity = layoutFor('parity');
    checks.parityCaseMeasured = Boolean(parity);
    const deeperIds = (overlay.cases ?? []).filter(entry => entry.depthIntent === 'item' && (entry.depthFromParity ?? 0) > 0).map(entry => entry.id);
    const shallowerIds = (overlay.cases ?? []).filter(entry => entry.depthIntent === 'item' && (entry.depthFromParity ?? 0) < 0).map(entry => entry.id);
    const deeper = deeperIds.map(id => layoutFor(id)?.historyBelow ?? null).filter(value => value !== null);
    const shallower = shallowerIds.map(id => layoutFor(id)?.historyBelow ?? null).filter(value => value !== null);
    const zero = layoutFor('depth0')?.historyBelow ?? null;
    checks.aDeeperCaseIsStrictlyDeeperThanParity = Boolean(parity) && deeper.length > 0 && deeper.every(value => value < parity.historyBelow);
    checks.aShallowerCaseIsStrictlyShallowerThanParity = Boolean(parity) && shallower.length > 0 && shallower.every(value => value > parity.historyBelow);
    // DEPTH 0 IS THE **NEWEST** POSITION, NOT THE FIRST MESSAGE -- and this assertion is the one that would
    // catch a harness (or a product) that had the direction backwards.
    //
    // THE MECHANISM, read from the pinned source and cited because the naive reading is the OPPOSITE of
    // pinned: `setOpenAIMessages` (public/scripts/openai.js:578) builds the list by looping
    // `for (let i = chat.length - 1; i >= 0; i--)`, i.e. NEWEST FIRST; `populationInjectionPrompts`
    // (:819-871) then walks `for (let i = 0; i <= maxDepth; i++)` splicing at
    // `const injectIdx = i + totalInsertedMessages` (:867); the chain ends with `messages.reverse()` (:873).
    // So depth 0 is index 0 of the REVERSED list = the LAST message sent, and depth N sits N messages above
    // the end. The count of HISTORY turns BELOW the note therefore equals the depth while it fits, and at
    // depth 0 it is exactly ZERO.
    //
    // The per-depth role order is `['system','user','assistant']` (:847) with a shared `totalInsertedMessages`
    // counter, so the note can share its depth with up to two sibling injections -- which is why
    // `historyBelow` (a HISTORY count) is the measure and the raw index is not: a sibling system injection
    // occupies the neighbouring slot without moving the count.
    checks.depthZeroIsTheNewestPosition = zero === 0 && Boolean(parity) && parity.historyBelow > 0;
    const deepCase = (overlay.cases ?? []).find(entry => entry.depthIntent === 'deeper-than-history');
    const deepLayout = deepCase ? layoutFor(deepCase.id) : null;
    checks.deeperThanHistoryReachesTheClamp = Boolean(deepLayout) && Boolean(parity)
        && deepLayout.historyBelow <= parity.historyBelow && deepLayout.noteIndex >= 0;
    // A DISCRIMINATING SWEEP: every PASSING case produced a DIFFERENT pinned request. Two cases that agree
    // byte-for-byte are one case wearing two names, and a harness that cannot tell them apart must fail
    // itself (AGENTS.md 50) rather than report a wider claim than it measured.
    const digests = results.map(entry => entry.details?.pinnedExpectation?.bodySha256 ?? entry.details?.pinnedLeg?.bodySha256 ?? null);
    const passedDigests = results.filter(entry => entry.verdict === 'PASS').map(entry => entry.details?.pinnedExpectation?.bodySha256 ?? entry.details?.pinnedLeg?.bodySha256 ?? null);
    checks.theCapturesDiffer = passedDigests.length > 0
        && new Set(passedDigests).size === passedDigests.length
        && digests.every(digest => digest !== null);
    checks.everyCasePassed = results.length > 0 && results.every(entry => entry.verdict === 'PASS');
    // THE DISABLED CASE MUST NOT BE THE SAME AS AN ENABLED ONE: a disable switch that does nothing would
    // produce the parity request under the disabled name and pass every per-case check against itself.
    const disabled = results.filter(entry => entry.case?.enabled === false);
    const enabledDigests = new Set(results.filter(entry => entry.case?.enabled !== false).map(entry => entry.details?.pinnedExpectation?.bodySha256 ?? null).filter(Boolean));
    checks.disabledCaseIsNotAnEnabledCapture = disabled.length > 0
        && disabled.every(entry => !enabledDigests.has(entry.details?.pinnedExpectation?.bodySha256 ?? entry.details?.pinnedLeg?.bodySha256 ?? null));
    checks.expectationIsPinnedDerived = (expectations?.measuredBy ?? null) === 'pinned-leg';

    const failureRank = ['INFRA_ERROR', 'HARNESS_ERROR', 'PRODUCT_MISMATCH', 'PINNED_BEHAVIOR', 'BLOCKED'];
    const worst = failureRank.find(verdict => results.some(entry => entry.verdict === verdict)) ?? null;
    const failedChecks = Object.entries(checks).filter(([, value]) => value !== true).map(([name]) => name);
    if (worst) {
        const named = results.filter(entry => entry.verdict === worst).map(entry => entry.caseId);
        return { checks, verdict: worst, reason: `${named.join(', ')}: ${results.find(entry => entry.verdict === worst)?.reason ?? 'no reason recorded'}` };
    }
    if (failedChecks.length > 0) {
        return { checks, verdict: 'HARNESS_ERROR', reason: `every case agreed, but the SWEEP is not discriminating: ${failedChecks.join(', ')}` };
    }
    return { checks, verdict: 'PASS', reason: null };
}
