// COMPARE THE TWO LAYOUT LEGS, AND REFUSE TO DECLARE ANYTHING TRUE THAT WAS NOT OBSERVED.
//
// The rules this comparator enforces exist because each of them has already been broken in this repository
// in another comparator:
//
//   1. A MISSING LEG IS NOT AGREEMENT. `if (!report) continue` was the shape of eleven vacuous guards in one
//      comparator (found by a lane on 2026-10-26); here absence is a named finding, never a skip.
//   2. BOTH SUBJECTS BROKEN IS NOT A PASS. If a control is unreachable on both servers at the same size the
//      verdict is `equally-unreachable`, which is a finding about the pinned frontend and explicitly NOT a
//      backend-parity result (GOAL.md §15). The two are counted separately.
//   3. AN UNREACHABLE CONTROL IS NOT AN UNREACHABLE PIXEL. An element is only reported as unreachable when
//      the browser's own numbers say so -- zero area, hidden, covered at its own centre, or running past the
//      right edge -- and each reason is named, because "false" alone is what makes a finding unfalsifiable.
//   4. A LEG THAT DID NOT DRIVE CANNOT BE COMPARED. `drove` is asserted, and so is the observation count.
//
// Usage: node compare-ui-layout-legs.mjs <gotavern.json> <pinned.json>
// Prints the artefact on stdout, exits 1 when a guard fails.

import fs from 'node:fs/promises';
import process from 'node:process';

const LEGS = ['gotavern', 'pinned'];

function readJSON(text) {
    return JSON.parse(text);
}

function loadLeg(label, file) {
    return fs.readFile(file, 'utf8').then(readJSON).catch(error => ({ __missing: String(error?.message ?? error) }));
}

/**
 * Reasons an observed element is not usable by a user, using only the numbers the browser computed.
 * Returns an array so a caller can see EVERY reason, not the first one.
 */
function unreachableReasons(observation) {
    if (!observation || observation.present !== true) return null;
    const reasons = [];
    if (observation.visibilityHidden) reasons.push('hidden');
    if (!observation.nonZeroArea) reasons.push(`zero-area(${observation.box?.width ?? '?'}x${observation.box?.height ?? '?'})`);
    if (observation.withinViewport === false) reasons.push('outside-viewport');
    if (observation.topmost === false) reasons.push(`covered-at-centre(${(observation.coveredBy?.chain ?? []).join(' < ')})`);
    if ((observation.overflowRight ?? 0) > 0) reasons.push(`overflow-right(${observation.overflowRight}px)`);
    return reasons;
}

/**
 * A COVERER THAT SPANS THE VIEWPORT IS A HARNESS STATE, NOT A LAYOUT RESULT.
 *
 * Run 40450382265 measured `covered-at-centre` for EVERY control on BOTH subjects at ALL FOUR sizes, and the
 * comparator called it `equally-unreachable` and PASSED. Both halves of that were wrong. The two subjects were
 * serving the same page and the shapes were identical, so "the subjects agree" was true and MEANINGLESS: the
 * send button and the navigation toggles do not share a footprint, and no frontend lays out a page where every
 * control is under the same thing. The cause is a page state the probe never left -- the readiness wait polls
 * `document.getElementById("preloader") === null`, and a preloader removed from the DOM while its container is
 * still painted, or any other full-viewport layer, satisfies that wait and then intercepts every hit test.
 *
 * The rules that follow, and they are the interesting part:
 *   * a full-viewport coverer is reported as `HARNESS_NOT_READY`, never as a finding about either subject;
 *   * the comparator FAILS rather than passing when it sees that shape, because the alternative is a green
 *     artefact whose every row says "broken on both" -- which a reader would either believe or ignore, and both
 *     are worse than a red;
 *   * `equally-unreachable` is only meaningful for a NARROW coverer: an element genuinely under a panel is a
 *     pinned-layout fact, and it is reported as such.
 */
function viewportCoverers(observation) {
    const names = [];
    for (const [name, value] of Object.entries(observation?.controls ?? {})) {
        if (value?.topmost === false && value?.coveredBy?.coversViewport === true) names.push(name);
    }
    return names;
}

function imageReasons(observation) {
    if (!observation || observation.present !== true) return null;
    const reasons = [];
    if (!observation.complete) reasons.push('not-complete');
    if (!(observation.naturalWidth > 0)) reasons.push('naturalWidth=0');
    if (!observation.nonZeroArea) reasons.push(`zero-area(${observation.box?.width ?? '?'}x${observation.box?.height ?? '?'})`);
    return reasons;
}

/**
 * One human-readable line per size, per surface, so a red names the thing that failed.
 *
 * IT MUST TOLERATE A LEG THAT DID NOT LOAD. The first version of `artefact.lines` called this
 * unconditionally, so a MISSING leg report crashed the comparator and the crash became the verdict -- which
 * turned a leg-missing finding into a HARNESS_ERROR and hid the named problem that had already been found.
 * A summary is a convenience; it may never be able to replace a finding.
 */
function summarize(leg, phase) {
    const lines = [];
    if (!leg || leg.__missing) return { phase, lines: [`${phase}: no leg report`] };
    if (!Array.isArray(leg.observations)) return { phase, lines: [`${phase}: the leg recorded no observations`] };
    for (const observation of leg.observations) {
        lines.push(`${observation.viewport}: document overflow ${observation.document?.horizontalOverflow ?? '?'}px`);
        for (const [name, value] of Object.entries(observation.controls ?? {})) {
            const reasons = unreachableReasons(value);
            lines.push(`  control ${name}: ${value?.present === true ? (reasons.length === 0 ? 'reachable' : `UNREACHABLE ${reasons.join(',')}`) : 'absent'}`);
        }
        for (const [name, value] of Object.entries(observation.images ?? {})) {
            const reasons = imageReasons(value);
            lines.push(`  image ${name}: ${value?.present === true ? (reasons.length === 0 ? 'ok' : `BAD ${reasons.join(',')}`) : 'absent'}`);
        }
    }
    return { phase, lines };
}

function main() {
    const [gotavernFile, pinnedFile] = process.argv.slice(2);
    if (!gotavernFile || !pinnedFile) {
        console.error('usage: compare-ui-layout-legs.mjs <gotavern.json> <pinned.json>');
        process.exit(2);
    }
    return Promise.all([loadLeg('gotavern', gotavernFile), loadLeg('pinned', pinnedFile)]).then(([gotavern, pinned]) => {
        const problems = [];
        const findings = [];
        const artefact = {
            compare: 'ui-layout',
            what: 'for each named control and image, at four viewport sizes, whether a user can see and reach it; both subjects observed by the same driver at the same sizes',
            whatItDoesNotSay: [
                'that the picture looks right: reachability is necessary and not sufficient, and no pixel comparison is made here',
                'that a layout difference is a backend difference when BOTH subjects share it (that is reported as equally-unreachable)',
                'anything about hover, focus order, touch gestures or drag targets, none of which this probe exercises',
                'anything about a size other than the four recorded',
            ],
            legs: LEGS,
            guards: {},
            sizes: [],
            problems,
            findings,
        };

        // RULE 1 and 4: a missing report, a leg that did not drive, or a short observation list is a
        // harness finding, never agreement.
        for (const [label, leg] of [['gotavern', gotavern], ['pinned', pinned]]) {
            if (leg.__missing) { problems.push(`${label}: no leg report (${leg.__missing}); nothing is compared`); continue; }
            if (leg.drove !== true) problems.push(`${label}: the leg did not drive (drove=${leg.drove}, failure=${leg.failure ?? 'none'})`);
            if (!Array.isArray(leg.observations) || leg.observations.length === 0) problems.push(`${label}: no observation was recorded`);
        }
        artefact.guards.bothLegsDrove = problems.length === 0;
        artefact.guards.bothLegsAgreeOnTheSizeSet = false;

        if (problems.length === 0) {
            const gotavernSizes = gotavern.observations.map(observation => observation.viewport);
            const pinnedSizes = pinned.observations.map(observation => observation.viewport);
            if (JSON.stringify(gotavernSizes) !== JSON.stringify(pinnedSizes)) {
                problems.push(`the legs observed different sizes: gotavern ${JSON.stringify(gotavernSizes)} pinned ${JSON.stringify(pinnedSizes)}`);
            } else {
                artefact.guards.bothLegsAgreeOnTheSizeSet = true;
            }
        }

        if (problems.length === 0) {
            let disagreeingReachability = 0;
            let equallyUnreachable = 0;
            let unreachableOnGotavernOnly = 0;
            let harnessNotReady = 0;
            // Containers in different render states: a refusal, not a reachability difference.
            let unmatchedRenderState = 0;
            // The product's own roster differing is a DATA/BACKEND finding, a different instrument from layout.
            let rosterDifferences = 0;

            for (let index = 0; index < gotavern.observations.length; index += 1) {
                const left = gotavern.observations[index];
                const right = pinned.observations[index];
                // BEFORE ANY COMPARISON AT THIS SIZE: is the page even in a state where a hit test means
                // anything? See viewportCoverers for why this is a refusal and not a finding.
                let unmeasurable = false;
                for (const [label, observation] of [['gotavern', left], ['pinned', right]]) {
                    const coverers = viewportCoverers(observation);
                    if (coverers.length > 0) {
                        harnessNotReady += 1;
                        unmeasurable = true;
                        const sample = observation.controls[coverers[0]]?.coveredBy;
                        problems.push(`${left.viewport}: HARNESS_NOT_READY -- ${coverers.length} control(s) are covered by a full-viewport node on ${label} (${sample?.chain?.[0] ?? 'unknown'}); the page never left a loading or overlay state, so no layout was measured at this size`);
                    }
                }
                const size = {
                    viewport: left.viewport,
                    // a size whose page was not ready is marked so its rows cannot count as agreement; the
                    // record stays in `sizes` until the summary removes it, so a reader can see it was excluded
                    // rather than absent.
                    unmeasurable,
                    // THE PRODUCT'S OWN ROSTER at this size: a DIFFERENT INSTRUMENT from layout. If the two
                    // backends served different character counts, no layout comparison at this size means
                    // anything, so it is carried here and judged separately in the summary.
                    roster: { gotavern: left.roster ?? null, pinned: right.roster ?? null },
                    gotavernOverflow: left.document?.horizontalOverflow ?? null,
                    pinnedOverflow: right.document?.horizontalOverflow ?? null,
                    controls: {},
                    images: {},
                };

                // THE DOCUMENT ITSELF. A document that overflows horizontally on one subject and not the
                // other means the two rendered different layouts from the same frontend; that is a backend
                // difference and it is named as such.
                if ((left.document?.horizontalOverflow ?? 0) !== (right.document?.horizontalOverflow ?? 0)) {
                    disagreeingReachability += 1;
                    size.documentDifference = { gotavern: left.document?.horizontalOverflow ?? null, pinned: right.document?.horizontalOverflow ?? null };
                    findings.push(`${left.viewport}: horizontal document overflow differs (gotavern ${left.document?.horizontalOverflow}, pinned ${right.document?.horizontalOverflow})`);
                }

                for (const name of Object.keys(left.controls ?? {})) {
                    const a = left.controls[name];
                    const b = right.controls?.[name] ?? null;
                    const aPresent = a?.present === true;
                    const bPresent = b?.present === true;
                    const reasonsA = unreachableReasons(a);
                    const reasonsB = unreachableReasons(b);
                    const reachableA = aPresent && reasonsA.length === 0;
                    const reachableB = bPresent && reasonsB.length === 0;
                    size.controls[name] = {
                        gotavern: { present: aPresent, reachable: reachableA, reasons: reasonsA },
                        pinned: { present: bPresent, reachable: reachableB, reasons: reasonsB },
                    };
                    if (aPresent !== bPresent) {
                        disagreeingReachability += 1;
                        findings.push(`${left.viewport}: control ${name} present on ${aPresent ? 'gotavern' : 'pinned'} and absent on the other`);
                    } else if (aPresent && reachableA !== reachableB) {
                        disagreeingReachability += 1;
                        if (reachableB) unreachableOnGotavernOnly += 1;
                        findings.push(`${left.viewport}: control ${name} reachable=${reachableA} on gotavern, reachable=${reachableB} on pinned (gotavern reasons: ${(reasonsA ?? []).join(',') || 'none'}; pinned reasons: ${(reasonsB ?? []).join(',') || 'none'})`);
                    } else if (aPresent && !reachableA && !reachableB) {
                        // RULE 2. This is a finding about the pinned frontend, and it is NOT parity evidence.
                        equallyUnreachable += 1;
                        findings.push(`${left.viewport}: control ${name} is unreachable on BOTH subjects (${[...new Set([...(reasonsA ?? []), ...(reasonsB ?? [])])].join(',')}); that is a pinned-layout finding, not a backend difference`);
                    }
                }

                for (const name of Object.keys(left.images ?? {})) {
                    const a = left.images[name];
                    const b = right.images?.[name] ?? null;
                    const aPresent = a?.present === true;
                    const bPresent = b?.present === true;
                    const reasonsA = imageReasons(a);
                    const reasonsB = imageReasons(b);
                    size.images[name] = {
                        gotavern: { present: aPresent, ok: aPresent && reasonsA.length === 0, reasons: reasonsA },
                        pinned: { present: bPresent, ok: bPresent && reasonsB.length === 0, reasons: reasonsB },
                    };
                    // A CONTAINER IN A DIFFERENT RENDER STATE IS NOT A LAYOUT DIFFERENCE.
                    //
                    // Run 40458997843 recorded `character-avatar` present on GoTavern and absent on pinned at
                    // three sizes, and absent on both at desktop. The likeliest cause was never a layout: the list
                    // renders when the roster arrives, GoTavern answers `/api/characters/all` in milliseconds while
                    // pinned boots in ~14 s, so the two pages were in DIFFERENT STATES when they were measured.
                    // Comparing an unrendered list against a rendered one compares two different documents, and
                    // calling that "reachability differs" is exactly the cross-layer inference this project keeps
                    // paying for. It is a NAMED refusal, and it fails the run rather than passing quietly.
                    const renderedA = a?.container?.rendered ?? null;
                    const renderedB = b?.container?.rendered ?? null;
                    if (renderedA !== null && renderedB !== null && renderedA !== renderedB) {
                        unmatchedRenderState += 1;
                        problems.push(`${left.viewport}: HARNESS_STATE_MISMATCH -- image ${name}: the container is ${renderedA ? 'rendered' : 'empty'} on gotavern and ${renderedB ? 'rendered' : 'empty'} on pinned (children ${a?.container?.children} vs ${b?.container?.children}), so the two pages are in different states and no layout conclusion can be drawn`);
                        continue;
                    }
                    if (aPresent !== bPresent) {
                        disagreeingReachability += 1;
                        findings.push(`${left.viewport}: image ${name} present on ${aPresent ? 'gotavern' : 'pinned'} and absent on the other (container children ${a?.container?.children} vs ${b?.container?.children}, rendered ${renderedA} vs ${renderedB})`);
                    } else if (aPresent && (reasonsA.length === 0) !== (reasonsB.length === 0)) {
                        disagreeingReachability += 1;
                        findings.push(`${left.viewport}: image ${name} ok=${reasonsA.length === 0} on gotavern, ok=${reasonsB.length === 0} on pinned`);
                    } else if (aPresent) {
                        // AN IMAGE THAT DECODED AT A DIFFERENT INTRINSIC SIZE IS A DIFFERENT PICTURE, and the
                        // existing asset lane compares digests of the RESPONSE, not the decoded dimensions.
                        if (a.naturalWidth !== b.naturalWidth || a.naturalHeight !== b.naturalHeight) {
                            disagreeingReachability += 1;
                            findings.push(`${left.viewport}: image ${name} decodes ${a.naturalWidth}x${a.naturalHeight} on gotavern and ${b.naturalWidth}x${b.naturalHeight} on pinned`);
                        }
                        if (reasonsA.length > 0 && reasonsB.length > 0) {
                            equallyUnreachable += 1;
                            findings.push(`${left.viewport}: image ${name} is BAD on both subjects (${reasonsA.join(',')}); a pinned-layout finding, not a backend difference`);
                        }
                    }
                }

                artefact.sizes.push(size);
            }

            artefact.summary = {
                disagreeingReachability,
                equallyUnreachable,
                unreachableOnGotavernOnly,
                harnessNotReady,
                unmatchedRenderState,
                rosterDifferences,
                note: 'disagreeingReachability must be 0 for parity; equallyUnreachable is reported and never counted as a pass (and is meaningless for a full-viewport coverer, which is counted in harnessNotReady instead); unmatchedRenderState is a REFUSAL (the two pages were in different render states, so nothing about layout can be compared); rosterDifferences is a DATA finding about what each backend served, a different instrument from layout; unreachableOnGotavernOnly is the subset of disagreement that is a GoTavern-only defect',
            };
            // RULE 4, the summary form: the guard that decides is not "no findings" but "nothing DISAGREES".
            artefact.guards.subjectsAgreeOnEveryControlAndImage = disagreeingReachability === 0;
            if (disagreeingReachability !== 0) {
                problems.push(`${disagreeingReachability} reachability difference(s) between the subjects; each is named in findings and none is a pass`);
            }
            // A GATE THAT FOUND NOTHING MUST SAY SO RATHER THAN PASS QUIETLY. Every selector absent on both
            // sides would satisfy "nothing disagrees" while measuring no layout at all.
            const observed = artefact.sizes.reduce((total, size) => total + Object.values(size.controls).filter(entry => entry.gotavern.present || entry.pinned.present).length
                + Object.values(size.images).filter(entry => entry.gotavern.present || entry.pinned.present).length, 0);
            artefact.summary.observedElements = observed;
            if (observed < 8) {
                problems.push(`only ${observed} element(s) were found on either subject across all sizes; the frontend was not rendered the way this probe drives it, so nothing about layout was measured`);
            }
            artefact.guards.measuredSomething = observed >= 8;
            // THE PRODUCT'S OWN ROSTER, COMPARED AS A SEPARATE INSTRUMENT. If the two backends served different
            // character counts, that is a DATA finding -- and it would also invalidate any layout comparison at
            // that size, so it is named and it fails. It is NOT counted as a reachability difference, because
            // "the list is a different length" and "the control is out of reach" are different questions.
            for (const size of artefact.sizes) {
                const rosterA = size.roster?.gotavern;
                const rosterB = size.roster?.pinned;
                if (!rosterA || !rosterB) continue;
                if ((rosterA.count ?? null) !== (rosterB.count ?? null)) {
                    rosterDifferences += 1;
                    problems.push(`${size.viewport}: ROSTER_DIFFERS -- the product reports ${rosterA.count} character(s) on gotavern and ${rosterB.count} on pinned (list children ${rosterA.listChildren} vs ${rosterB.listChildren}); a layout comparison at this size would be between two different pages`);
                }
            }
            artefact.summary.rosterDifferences = rosterDifferences;
            artefact.summary.unmatchedRenderState = unmatchedRenderState;
            // THE LAST GATE, AND THE ONE RUN 40450382265 NEEDED: a size where the page was never ready cannot
            // contribute a comparison, so its rows must not silently count as agreement.
            artefact.guards.everySizeWasMeasurable = harnessNotReady === 0;
            artefact.sizes = artefact.sizes.filter(size => !size.unmeasurable);
            if (harnessNotReady > 0) {
                findings.push(`${harnessNotReady} size(s) were unmeasurable because the page never left a loading or overlay state on at least one subject; those sizes are excluded and their absence is NOT a pass`);
            }
        }

        artefact.verdict = problems.length === 0 ? 'PASS' : 'FAIL';
        if (problems.length > 0) artefact.guards.bothLegsDrove = artefact.guards.bothLegsDrove === true && false;
        // THE HUMAN SUMMARY IS PART OF THE ARTEFACT: a reader must not need this program to see the finding.
        //
        // SPREADING A FUNCTION CALL INTO AN ARRAY ASSUMES THE CALL RETURNED AN ARRAY, and this one returns
        // an OBJECT. The first version wrote `[...summarize(...)]`, which threw `summarize is not a function
        // or its return value is not iterable` -- a message that names the wrong cause, because the function
        // was fine and its RETURN SHAPE was wrong. The throw was then caught by the top-level handler and
        // reported as HARNESS_ERROR, hiding the leg-missing findings that had already been collected. Two
        // lessons, and the second is the expensive one: a convenience appended at the END of a comparator can
        // erase its verdict, so anything added after the verdict is computed must not be able to throw.
        artefact.lines = [summarize(gotavern, 'gotavern'), summarize(pinned, 'pinned')];
        process.stdout.write(`${JSON.stringify(artefact, null, 2)}\n`);
        process.exit(problems.length === 0 ? 0 : 1);
    });
}

main().catch(error => {
    // A COMPARATOR THAT CRASHES MUST NOT EXIT 0. This is its own finding shape: the run could not judge.
    process.stdout.write(`${JSON.stringify({ compare: 'ui-layout', verdict: 'HARNESS_ERROR', error: String(error?.message ?? error) }, null, 2)}\n`);
    process.exit(1);
});
