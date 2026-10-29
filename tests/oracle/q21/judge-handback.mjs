// Q21 JUDGE: DOES THE HAND-BACK EVIDENCE ACTUALLY SUPPORT "KEEP RUNNING", IN BOTH DIRECTIONS?
//
// WHY THIS IS A SEPARATE PROGRAM FROM THE TWO LEGS. The probe (`tests/browser/q21-data-handback.mjs`) drives the two
// runtimes and writes one report per leg. The workflow step that calls itself "Judge the hand-back" reads
// `report.failure` and prints the step list -- and that cannot tell a leg which judged seventeen rows from a leg that
// exited 0 having judged none, because an empty `steps` array with no `failure` passes it. A probe that exits 0
// without judging is the failure mode this repository keeps hitting, so the judge is its own program, it names what
// it required, and it refuses to return `match` on a leg whose counts are zero.
//
// WHAT "KEEP RUNNING" REQUIRES, from the question rather than from the documentation (GOAL Q21: data written by
// GoTavern can be handed back to Node and keep running):
//
//   direction (b)  GoTavern writes -> pinned reads -> pinned mutates/writes -> GoTavern reads
//   direction (a)  pinned writes   -> GoTavern reads -> GoTavern mutates/writes -> pinned reads
//
// Each row below is one observation the legs must have MADE. A missing row is `unreached` -- the probe never got
// there, which needs a different fix from a disagreement -- and a red row is `mismatch`. Both are failures; they are
// reported apart because the first question a reader has is "did it even run".
//
// Usage:
//   node tests/oracle/q21/judge-handback.mjs <q21-gotavern.json> <q21-pinned.json> [--out <verdict.json>]
//   node tests/oracle/q21/judge-handback.mjs --selftest [<q21-gotavern.json> <q21-pinned.json>]
//
// Exit: 0 only when the verdict is `match` AND every count is non-zero. 1 otherwise. 2 when a report is missing or
// unreadable (a REFUSAL, never a silent pass).

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

// THE CONTRACT, per leg. `counts` names the numbers that must be non-zero, with the reason each matters.
export const REQUIRED = {
    gotavern: {
        rows: ['dataRootWasEmpty', 'characterStaged', 'pageModelLoaded', 'opened', 'gotavernWrote'],
        nonZeroCounts: {
            chatFilesUnderCard: 'the product must have saved a chat under the STAGED CARD\'s own directory',
            treeFilesWritten: 'the tree the product wrote must have files in it',
            cardChunks: 'the staged card must carry both card chunks',
        },
    },
    pinned: {
        rows: [
            'pageModelLoaded', 'opened', 'pinnedOpened', 'pinnedOpenedSavedChat', 'pinnedReadTheChat', 'pinnedChatIdMatches',
            'noDataLossOnHandBack', 'pinnedWrote', 'pinnedContinued', 'pinnedBranched',
            'rosterAgrees', 'cardMetadataAgrees', 'chatAssociationAgrees', 'gotavernReadsPinned',
            'gotavernMutated', 'branchStateSurvivesGoWrite', 'pinnedReadGotavernsTurn',
        ],
        nonZeroCounts: {
            savedChats: 'there must be a saved conversation to hand back',
            rosterRows: 'the roster compared between the runtimes must have rows',
            chatFilesAssociated: 'the chat files associated with the character must be compared, not zero',
            markersInFinalChat: 'all THREE write hops (GoTavern, pinned, GoTavern-again) must be visible in the final chat',
            continueRequests: 'the continue must have REACHED the provider, which is what a captured request proves',
        },
    },
};

/**
 * Judge one leg's report against the contract. Pure: it reads a parsed report and returns a verdict object, so the
 * selftest can drive it with mutations instead of with a live run.
 */
export function judgeLeg(phase, report) {
    const contract = REQUIRED[phase];
    if (!contract) return { phase, verdict: 'mismatch', reasons: [`no contract for phase ${JSON.stringify(phase)}`], missing: [], failed: [], counts: null };
    const steps = Array.isArray(report?.steps) ? report.steps : [];
    const present = new Set(steps.map(entry => entry?.name));
    const missing = contract.rows.filter(name => !present.has(name));
    const failed = steps.filter(entry => entry?.ok !== true).map(entry => entry?.name ?? '(unnamed)');
    const recorded = report?.judge ?? null;
    const counts = recorded?.counts ?? null;
    const reasons = [];
    if (report?.failure) reasons.push(`the leg reported a failure: ${String(report.failure).slice(0, 400)}`);
    if (steps.length === 0) reasons.push('the leg reported ZERO steps, so it did not judge anything whatever its exit status said');
    if (missing.length > 0) reasons.push(`required row(s) never reached: ${missing.join(', ')}`);
    if (failed.length > 0) reasons.push(`row(s) went red: ${failed.join(', ')}`);
    if (recorded === null) {
        reasons.push('the report carries no `judge` block, so the leg did not reach its own judge');
    } else if (recorded.executed !== true) {
        reasons.push('the report\'s judge block does not say it executed');
    } else if (recorded.verdict !== 'match') {
        reasons.push(`the leg's own judge said ${JSON.stringify(recorded.verdict)}`);
    }
    const nonZero = {};
    if (counts === null) {
        reasons.push('no counts were recorded, so "non-zero" cannot be checked and is not assumed');
    } else {
        for (const [key, why] of Object.entries(contract.nonZeroCounts)) {
            const value = Number(counts[key]);
            nonZero[key] = Number.isFinite(value) ? value : null;
            if (!Number.isFinite(value) || value <= 0) reasons.push(`count ${key} is ${JSON.stringify(counts[key] ?? null)} (${why})`);
        }
    }
    const verdict = missing.length > 0 ? 'unreached' : (reasons.length > 0 ? 'mismatch' : 'match');
    return { phase, verdict, reasons, missing, failed, steps: steps.length, nonZeroCounts: nonZero, counts };
}

const readReport = target => {
    const absolute = path.resolve(target);
    const text = fs.readFileSync(absolute, 'utf8');
    return { path: absolute, report: JSON.parse(text) };
};

function main() {
    const argv = process.argv.slice(2);
    if (argv.includes('--selftest')) return selftest(argv.filter(entry => entry !== '--selftest'));

    const positional = argv.filter((entry, index) => !entry.startsWith('--') && argv[index - 1] !== '--out');
    if (positional.length !== 2) {
        console.error('usage: node tests/oracle/q21/judge-handback.mjs <q21-gotavern.json> <q21-pinned.json> [--out <verdict.json>]');
        process.exit(2);
    }
    const legs = [];
    for (const [index, phase] of ['gotavern', 'pinned'].entries()) {
        try {
            const { path: reportPath, report } = readReport(positional[index]);
            legs.push({ ...judgeLeg(phase, report), report: reportPath });
        } catch (error) {
            console.error(`REFUSING: the ${phase} leg's report at ${positional[index]} cannot be read (${String(error?.message ?? error)}), so nothing is claimed about the hand-back`);
            process.exit(2);
        }
    }
    return emit(legs, argv);
}

function emit(legs, argv) {
    const verdict = legs.every(entry => entry.verdict === 'match') ? 'match' : (legs.some(entry => entry.verdict === 'unreached') ? 'unreached' : 'mismatch');
    const summary = {
        schemaVersion: 1,
        question: 'Can data written by one runtime be handed back to the other and keep running, in both directions?',
        verdict,
        directions: {
            'b: GoTavern writes -> pinned reads -> pinned mutates/writes -> GoTavern reads': legs.find(entry => entry.phase === 'pinned')?.verdict ?? 'unreached',
            'a: pinned writes -> GoTavern reads -> GoTavern mutates/writes -> pinned reads': legs.find(entry => entry.phase === 'pinned')?.verdict ?? 'unreached',
        },
        legs: legs.map(entry => ({
            phase: entry.phase,
            verdict: entry.verdict,
            steps: entry.steps,
            reasons: entry.reasons,
            missing: entry.missing,
            failed: entry.failed,
            nonZeroCounts: entry.nonZeroCounts,
            report: entry.report ?? null,
        })),
    };
    for (const entry of summary.legs) {
        console.log(`${entry.phase}: ${entry.verdict} -- ${entry.steps} step(s); ${entry.reasons.length === 0 ? 'no reason recorded' : entry.reasons.join(' | ')}`);
    }
    console.log(`hand-back verdict: ${summary.verdict}`);
    const outIndex = argv.indexOf('--out');
    if (outIndex >= 0 && argv[outIndex + 1]) {
        fs.writeFileSync(path.resolve(argv[outIndex + 1]), `${JSON.stringify(summary, null, 2)}\n`);
        console.log(`verdict written to ${path.resolve(argv[outIndex + 1])}`);
    }
    process.exit(summary.verdict === 'match' ? 0 : 1);
}

// ---------------------------------------------------------------------------------------------------------------
// THE NEGATIVE CONTROLS. A judge is only worth its green if it can go red, and the reds that matter here are the
// ones a "no failure reported" leg produces: zero steps, a missing required row, and a zero count. Each case below
// builds a report that a naive judge WOULD pass and requires this one to refuse it.
function selftest(basePaths) {
    const cases = [];
    const record = (name, ok, detail) => {
        cases.push({ name, ok, detail });
        console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : ' -- ' + (typeof detail === 'string' ? detail : JSON.stringify(detail))}`);
    };

    // A GREEN pair, built from the live reports when they are supplied (so the control is the same shape the CI
    // produces) and synthesised otherwise.
    const live = basePaths.length === 2 ? basePaths : null;
    const liveGotavern = live ? readReport(live[0]).report : null;
    const livePinned = live ? readReport(live[1]).report : null;
    const synthetic = (phase) => {
        const contract = REQUIRED[phase];
        return {
            phase,
            failure: null,
            steps: contract.rows.map(name => ({ name, ok: true, detail: null })),
            judge: {
                executed: true,
                phase,
                verdict: 'match',
                counts: phase === 'gotavern'
                    ? { chatFilesUnderCard: 1, treeFilesWritten: 200, cardChunks: 2 }
                    : { savedChats: 1, rosterRows: 2, chatFilesAssociated: 2, markersInFinalChat: 3, continueRequests: 1 },
            },
        };
    };
    const greenGotavern = liveGotavern ?? synthetic('gotavern');
    const greenPinned = livePinned ?? synthetic('pinned');

    record('a green pair is `match`',
        judgeLeg('gotavern', greenGotavern).verdict === 'match' && judgeLeg('pinned', greenPinned).verdict === 'match',
        { gotavern: judgeLeg('gotavern', greenGotavern).verdict, pinned: judgeLeg('pinned', greenPinned).verdict });

    // 1. NO FAILURE, NO STEPS, NO JUDGE -- the "probe exited 0 without judging" shape.
    const vacuous = { ...greenPinned, steps: [], judge: undefined };
    record('ZERO steps with no failure goes red (the vacuous-green shape)', judgeLeg('pinned', vacuous).verdict !== 'match',
        judgeLeg('pinned', vacuous).reasons);

    // 2. A MISSING REQUIRED ROW, everything else green.
    const missingRow = { ...greenPinned, steps: greenPinned.steps.filter(entry => entry.name !== 'pinnedContinued') };
    const missingRowVerdict = judgeLeg('pinned', missingRow);
    record('a missing `pinnedContinued` row is `unreached`, not a pass',
        missingRowVerdict.verdict === 'unreached' && missingRowVerdict.missing.includes('pinnedContinued'),
        { verdict: missingRowVerdict.verdict, missing: missingRowVerdict.missing });

    // 3. A ZERO COUNT with every row green: the rows were reported, the observations were not made.
    const zeroCounts = { ...greenPinned, judge: { ...greenPinned.judge, counts: { ...greenPinned.judge.counts, continueRequests: 0 } } };
    record('a zero `continueRequests` count goes red even with every row green', judgeLeg('pinned', zeroCounts).verdict === 'mismatch',
        judgeLeg('pinned', zeroCounts).reasons);

    // 4. NO COUNTS AT ALL: unverifiable is not verified.
    const noCounts = { ...greenPinned, judge: { ...greenPinned.judge, counts: null } };
    record('absent counts go red rather than being assumed non-zero', judgeLeg('pinned', noCounts).verdict === 'mismatch',
        judgeLeg('pinned', noCounts).reasons);

    // 5. A RED ROW with the leg's own judge claiming match (a probe that mis-reports itself).
    const redRow = { ...greenPinned, steps: greenPinned.steps.map(entry => (entry.name === 'cardMetadataAgrees' ? { ...entry, ok: false } : entry)) };
    record('a red row goes red even when the leg\'s own judge says match', judgeLeg('pinned', redRow).verdict === 'mismatch',
        judgeLeg('pinned', redRow).reasons);

    // 6. A FAILURE FIELD present in a report whose rows all look fine.
    const failedField = { ...greenGotavern, failure: 'the GoTavern half could not open the staged card' };
    record('a `failure` field goes red', judgeLeg('gotavern', failedField).verdict === 'mismatch', judgeLeg('gotavern', failedField).reasons);

    const failed = cases.filter(entry => !entry.ok);
    console.log(`[selftest] ${cases.length - failed.length}/${cases.length} case(s) behaved as required`);
    if (failed.length > 0) {
        console.error(`[selftest] DECORATION: ${failed.map(entry => entry.name).join(', ')}`);
        process.exit(1);
    }
    process.exit(0);
}

// Only run when invoked as the entrypoint, so `judgeLeg` can be imported by a future caller without a judge run.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))) {
    main();
}
