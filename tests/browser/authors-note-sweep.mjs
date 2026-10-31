// Q17 -- DRIVE THE WHOLE AUTHOR'S NOTE DEPTH SWEEP AND JUDGE IT, PER CASE, FAIL-CLOSED.
//
// THE SHAPE OF THE RUN, and why it is this shape:
//   1. THE PINNED LEG MEASURES THE EXPECTATION (prepare-authors-note.mjs), by driving the SAME program the
//      compared leg uses. The file it writes says `measuredBy: "pinned-leg"` and this runner REFUSES to
//      judge anything without it (exit 2 = the run could not be set up; exit 1 = a case was judged and
//      failed).
//   2. EACH CASE IS THEN DRIVEN ON BOTH SUBJECTS: the GoTavern leg through `generation-probe.mjs`
//      (which builds and boots the binary), the pinned leg through `run-against-pinned.mjs`. Both get the
//      same PROBE_MODE=preset, the same PROBE_PRESET_CONTEXT and the same PROBE_AUTHORS_NOTE_CASE, so a
//      difference in the compared request cannot come from a different scenario.
//   3. EVERY CASE IS COMPARED BY compare-authors-note-legs.mjs, whose verdict is one of
//      PRODUCT_MISMATCH | PINNED_BEHAVIOR | HARNESS_ERROR | INFRA_ERROR | BLOCKED | PASS.
//   4. THE SWEEP ITSELF IS JUDGED: cases must differ from one another, and the deeper case must be
//      strictly deeper than the parity anchor on the pinned leg. A sweep of seven identical captures
//      fails as HARNESS NON-DISCRIMINATING instead of passing (AGENTS.md 50).
//
// WHY ONE SCRIPT AND NOT ELEVEN WORKFLOW STEPS. Each case costs two browser drives; the workflow keeps ONE
// step for the pinned preparation, ONE for the legs and ONE for the verdict, so a red run names the case and
// the leg without the workflow growing a step per depth.
//
// Usage:
//   node authors-note-sweep.mjs --phase prepare --context <keepContext> --out-dir <legs> [--expectations <file>]
//   node authors-note-sweep.mjs --phase legs    --context <keepContext> --out-dir <legs> [--cases a,b]
//   node authors-note-sweep.mjs --phase judge   --out-dir <legs> [--expectations <file>] [--report <dir>]
//   node authors-note-sweep.mjs --self-check
//
// THE EXPECTATION FILE IS AN INPUT TO `judge` AND AN OUTPUT OF `prepare`; the default path for both is
// tests/browser/fixtures/authors-note-pinned.json, which is committed so the expectation is REVIEWABLE as a
// diff rather than living only in a run's scratch directory (the boundary search learned the opposite lesson:
// its pair was per-run, and nothing could see it move). It is re-measured on every run and compared with the
// committed file by the workflow's freshness report.

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
    authorsNotePinnedFixture,
    compareAuthorsNoteCase,
    legReportPaths,
    sweepVerdict,
} from './authors-note-sweep-kit.mjs';
import { authorsNoteOverlaySpec, resolveAuthorsNoteCase } from './preset-kit.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
    const index = argv.indexOf(name);
    return index === -1 ? fallback : argv[index + 1];
};
const phase = arg('--phase', null);
const outDir = path.resolve(arg('--out-dir', path.join(here, 'legs')));
const reportDir = path.resolve(arg('--report', outDir));
const expectationsPath = path.resolve(arg('--expectations', authorsNotePinnedFixture()));
const contextArg = arg('--context', null);
const overlay = authorsNoteOverlaySpec();
const cases = (arg('--cases', '') || overlay.cases.map(entry => entry.id).join(',')).split(',').map(entry => entry.trim()).filter(Boolean);

// SELF-CHECK. A leg sweep that starts with an undefined identifier burns two browser boots per case before
// anyone learns why; this resolves every identifier and every case up front and REFUSES (exit 1).
if (argv.includes('--self-check')) {
    const problems = [];
    for (const required of cases) {
        try {
            const resolved = resolveAuthorsNoteCase(overlay, required);
            if (!Number.isInteger(resolved.depth) && resolved.depth !== null) problems.push(`case ${required} resolved to a non-integer depth ${JSON.stringify(resolved.depth)}`);
        } catch (error) {
            problems.push(`case ${required}: ${error?.message ?? error}`);
        }
    }
    if (typeof compareAuthorsNoteCase !== 'function') problems.push('authors-note-sweep-kit.mjs does not export compareAuthorsNoteCase');
    if (typeof sweepVerdict !== 'function') problems.push('authors-note-sweep-kit.mjs does not export sweepVerdict');
    for (const required of ['prepare-authors-note.mjs', 'generation-probe.mjs', 'run-against-pinned.mjs', 'compare-authors-note-legs.mjs']) {
        try {
            await fs.access(path.join(here, required));
        } catch {
            problems.push(`${required} is missing from the harness, so phase ${phase ?? 'any'} cannot run`);
        }
    }
    if (problems.length > 0) {
        console.error(`authors-note-sweep SELF-CHECK FAILED: ${problems.join('; ')}`);
        process.exit(1);
    }
    console.log(JSON.stringify({ selfCheck: 'ok', phase: phase ?? '(none)', cases, outDir, expectationsPath }));
    process.exit(0);
}

if (!['prepare', 'legs', 'judge'].includes(phase)) {
    console.error('authors-note-sweep needs --phase prepare|legs|judge');
    process.exit(2);
}
await fs.mkdir(outDir, { recursive: true });
await fs.mkdir(reportDir, { recursive: true });

const run = (file, args, env) => new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(here, file), ...args], { cwd: here, stdio: 'inherit', env: { ...process.env, ...env } });
    child.on('exit', code => resolve(code ?? 1));
});

// --------------------------------------------------------------------------------------------- prepare
if (phase === 'prepare') {
    if (!contextArg || !Number.isInteger(Number(contextArg))) {
        console.error('phase prepare needs --context <keepContext>, measured by preset-boundary-search.mjs');
        process.exit(2);
    }
    const code = await run('prepare-authors-note.mjs', ['--context', String(Number(contextArg)), '--out', expectationsPath, '--out-dir', outDir]);
    if (code !== 0) {
        console.error('the pinned leg could not measure the expectation; nothing can be judged, so NO case is reported as passed');
        process.exit(1);
    }
    process.exit(0);
}

// ------------------------------------------------------------------------------------------------ legs
if (phase === 'legs') {
    if (!contextArg || !Number.isInteger(Number(contextArg))) {
        console.error('phase legs needs --context <keepContext>, measured by preset-boundary-search.mjs');
        process.exit(2);
    }
    const failures = [];
    for (const caseId of cases) {
        for (const subject of ['gotavern', 'pinned']) {
            const paths = legReportPaths(outDir, caseId, subject);
            const env = {
                PROBE_MODE: 'preset',
                PROBE_SOURCE: 'custom',
                PROBE_PRESET_VARIANT: 'keep',
                PROBE_PRESET_CONTEXT: String(Number(contextArg)),
                PROBE_AUTHORS_NOTE_CASE: caseId,
            };
            const code = subject === 'gotavern'
                ? await run('generation-probe.mjs', ['--report', paths.report], env)
                : await run('run-against-pinned.mjs', ['generation-probe.mjs', '--', '--report', paths.report], { ...env, PROBE_PINNED_REDIRECT_FILE: paths.redirect });
            console.log(`[q17] ${subject}/${caseId}: drive exited ${code}`);
            if (code !== 0) failures.push(`${subject}/${caseId}`);
        }
    }
    // A DRIVE FAILURE IS NOT A STOP: the judge still runs, and judges each case from what exists. The
    // workflow's step turns red on this marker, so a failed drive can never leave an "ok" artefact behind.
    if (failures.length > 0) {
        console.error(`the following drives failed and produced no evidence: ${failures.join(', ')}`);
        process.exit(1);
    }
    process.exit(0);
}

// ----------------------------------------------------------------------------------------------- judge
let expectations = null;
try {
    expectations = JSON.parse(await fs.readFile(expectationsPath, 'utf8'));
} catch (error) {
    console.error(`the pinned expectation is unreadable at ${expectationsPath} (${error?.message ?? error}); every case is BLOCKED and nothing is claimed`);
}
const results = [];
for (const caseId of cases) {
    const paths = legReportPaths(outDir, caseId, 'subject');
    const result = compareAuthorsNoteCase({
        caseId,
        expectations,
        gotavernReportPath: paths.report.replace('-subject.json', '-gotavern.json'),
        pinnedReportPath: paths.report.replace('-subject.json', '-pinned.json'),
    });
    results.push(result);
    console.log(`${result.verdict.padEnd(16)} ${caseId}${result.verdict === 'PASS' ? '' : ` -- ${result.reason}`}`);
}
const sweep = sweepVerdict({ results, overlay, expectations });
// The deepest depth this sweep actually drove AND that PASSed, computed from the case records rather than
// written as a literal: a number that describes the run must come from the run.
const deepestMeasured = results
    .filter(entry => entry.verdict === 'PASS' && entry.case?.position === 'IN_CHAT')
    .map(entry => entry.case?.depth)
    .filter(depth => Number.isInteger(depth))
    .reduce((a, b) => Math.max(a, b), 0);
const artifact = {
    schemaVersion: 1,
    surface: 'authors-note',
    question: 'Q17: is Author\'s Note depth the same -- does the note land at the position the pinned frontend puts it, relative to history, world info and the other injections?',
    pinnedBaseline: expectations?.pinnedBaseline ?? 'SillyTavern 1.19.0, commit 06bde939fb1e9c4c8d8641d810f0a916b5bce127',
    measuredBy: expectations?.measuredBy ?? null,
    method: 'the expectation is the pinned leg\'s own provider request (prepare-authors-note.mjs -> run-against-pinned.mjs generation-probe.mjs PROBE_MODE=preset); the compared legs are the same program with the same arguments; the request is compared byte-for-byte and the note\'s layout is compared field by field',
    // WHAT THIS ARTEFACT DOES NOT ESTABLISH, carried WITH the evidence because a reader who opens the
    // artefact alone must be able to size the claim. The legs drive the `custom` chat-completion source,
    // and that source is a SERVER-SIDE PASSTHROUGH
    // (`src/endpoints/backends/chat-completions.js:2394-2421`): it resolves the URL, key and headers, calls
    // `embedOpenRouterMedia`, and forwards the message array without reading, reordering or re-counting it.
    // So a green here compares THE FRONTEND running against two servers; it is not evidence about either
    // server's prompt handling, because on this path neither server handles the prompt.
    doesNotEstablish: 'server-side prompt handling: the `custom` source is a server-side passthrough (pinned chat-completions.js:2394-2421 never reads `messages`), so these legs compare the pinned frontend against two servers, not two backends. A claim about a server-side transform needs a source whose pinned branch DOES read `messages` (the MINIMAX fold, custom_prompt_post_processing, or a provider that re-encodes roles)',

    context: expectations?.context ?? null,
    parityDepth: expectations?.parityDepth ?? overlay.parityDepth,
    // `inputs` NAMES PER-RUN LEGS ONLY, and that is a contract, not a preference.
    //
    // `catalog.test.mjs` reads every string in a committed artefact's `captures`/`inputs` and requires
    // tests/browser/.gitignore to ignore it -- because a name there is what the harness WROTE for one run.
    // Putting the golden expectation in `inputs` therefore failed that test with "the harness wrote
    // authors-note-pinned.json and tests/browser/.gitignore does not ignore it" (Browser differential
    // 40456523411, step 12), and the test was RIGHT: the golden is COMMITTED evidence, not a per-run leg, so
    // it must never be ignored. It is recorded in its own field below.
    inputs: { legs: cases.map(caseId => `${caseId}-{gotavern,pinned}.json`) },
    // THE ORACLE IS COMMITTED, and it is named where a reader looks for the expectation, not where the
    // ignore-coverage test looks for throwaway leg names.
    expectsPinnedRecording: path.basename(expectationsPath),
    // WHICH DEPTH CLASSES THIS SWEEP COVERS, AND WHICH IT DOES NOT. Stated as named fields because the
    // difference between "we measured it", "we decided it is out of scope" and "we never tested it" is the
    // whole point of a coverage claim, and prose in a commit message does not travel with the artefact.
    depthCoverage: {
        deepestMeasuredDepth: deepestMeasured,
        // `null` is deliberate: there is NO depth at this budget that keeps the note AND every declared turn
        // (measured, see the numbers below), so "an implementation clamps depth to the history length" is
        // UNTESTED. Null means unproven; it must never be read as covered.
        pastHistoryInsideBudget: null,
        pastHistoryInsideBudgetWhy: 'MEASURED ABSENT: at the keep context the budget holds 12 history turns only when the note is absent. Pinned legs: depth 8 -> 26 messages, 11 history turns, note present; depth 14 -> 23 messages, 12 history turns, note absent (Browser differential 40451173262); depth 20 -> the same 23/12/absent shape (40447689701). The class is therefore unmeasurable against this fixture and the case is retired, not tuned.',
        pastBudgetOutOfScope: {
            depths: [14, 20],
            rule: 'depth past the budget is a truncation fact, not a depth fact',
            measured: {
                depth20Run: '40447689701',
                depth14Run: '40451173262',
                noteAbsentBothRuns: true,
                collapsedOntoTheDisabledCase: 'c94a514779239e5d (identical bytes for depth 20 and interval 0, on both subjects)',
            },
            ownedBy: 'Q18 (truncation-set-gate.mjs) at the boundary preset-boundary-search.mjs measured',
        },
    },
    cases: results,
    sweep: sweep.checks,
    // Checks that are `null` were deliberately NOT MEASURED. Reported beside the verdict so a decided
    // exclusion is a stated gap and never a silent pass.
    notMeasured: sweep.notMeasured ?? [],
    failureReason: sweep.reason,
    verdict: sweep.verdict,
    verdictTaxonomy: ['PRODUCT_MISMATCH', 'PINNED_BEHAVIOR', 'HARNESS_ERROR', 'INFRA_ERROR', 'BLOCKED', 'PASS'],
};
const target = path.join(reportDir, 'authors-note-comparison.json');
await fs.writeFile(target, `${JSON.stringify(artifact, null, 2)}\n`);
console.log(`\nq17 sweep: ${sweep.verdict} (${results.filter(entry => entry.verdict === 'PASS').length}/${results.length} cases PASS)`);
console.log(`artefact: ${target}`);
process.exit(sweep.verdict === 'PASS' ? 0 : 1);
