// Q17 -- MEASURE THE AUTHOR'S NOTE DEPTH LAYOUT ON THE PINNED LEG, AND NOTHING ELSE.
//
// WHAT THIS FILE IS FOR, IN ONE SENTENCE: the expected POSITION of the Author's Note for each depth is a
// pinned OBSERVATION, produced by the same program that produces the compared request
// (`run-against-pinned.mjs generation-probe.mjs` with PROBE_MODE=preset and PROBE_AUTHORS_NOTE_CASE), and
// this file only reads it back out and writes it down. It never derives a position from the pinned source,
// never recomputes it from the depth, and never compares anything: the comparator
// (compare-authors-note-legs.mjs) refuses to run without the file this produces.
//
// WHY A SEPARATE PREPARATION DRIVE RATHER THAN A GUESS. `preset-boundary-search.mjs` set the precedent one
// surface over: seven runs failed because a boundary was measured by a procedure merely SIMILAR to the one
// that produced the compared request. The depth sweep has the same trap. A hand-derived expectation
// ("depth 6 means six messages below the note") would encode my reading of `populationInjectionPrompts`
// instead of the pinned frontend's behaviour -- and the frontend's own example and world-info messages move
// the whole list as the budget changes, so the DERIVABLE number and the OBSERVED number are not the same
// number. The pinned drive is therefore the only source of the expectation.
//
// WHY IT IS A SEPARATE SCRIPT FROM THE LEG ITSELF. Two identical drives at the same path would make a
// regression look like a re-recorded oracle (doctrine 9). Keeping the oracle in its own file means the CI
// step that measures it is visible as a step, and a moved expectation is a committed diff of a file that
// says it is pinned-derived.
//
// Usage:
//   node prepare-authors-note.mjs --context <keepContext> --out <dir>/authors-note-pinned.json [--cases a,b]
//   node prepare-authors-note.mjs --self-check
// Exit: 0 with every case measured, 1 with the failures named (no partial file).

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { AUTHORS_NOTE_OVERLAY_MARKER, MARKERS, authorsNoteOverlaySpec, parseProviderBody, resolveAuthorsNoteCase, layoutOf } from './preset-kit.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
    const index = argv.indexOf(name);
    return index === -1 ? fallback : argv[index + 1];
};
const outDir = path.resolve(arg('--out-dir', path.join(here, 'legs')));
const outPath = path.resolve(arg('--out', path.join(outDir, 'authors-note-pinned.json')));
const requestedContext = arg('--context', null);
const overlay = authorsNoteOverlaySpec();
// `--cases` narrows the sweep (a hand run, or a debugging run); the default is EVERY case the comparator
// knows about, because a sweep that silently covers four of seven cases is a narrower oracle wearing the
// whole one's name.
const cases = (arg('--cases', '') || overlay.cases.map(entry => entry.id).join(','))
    .split(',')
    .map(entry => entry.trim())
    .filter(Boolean);

// SELF-CHECK. `node --check` cannot see an undefined identifier, and the first thing this script otherwise
// does is boot a pinned server and drive a real send. CI runs this as its step's first command, so a broken
// reference fails in under a second instead of after a pinned boot.
if (argv.includes('--self-check')) {
    const resolved = cases.map(id => resolveAuthorsNoteCase(overlay, id));
    const problems = [];
    if (typeof layoutOf !== 'function') problems.push('layoutOf is not exported by preset-kit.mjs');
    if (typeof parseProviderBody !== 'function') problems.push('parseProviderBody is not exported by preset-kit.mjs');
    if (!MARKERS.history || !AUTHORS_NOTE_OVERLAY_MARKER) problems.push('preset-kit.mjs does not declare both markers');
    if (overlay.parityDepth < 1) problems.push('the parity depth must be >= 1, or "deeper than parity" cases cannot exist');
    if (!resolved.some(entry => entry.depth === 0)) problems.push('the case list has no depth-0 case');
    // The deeper-than-history case is RETIRED (preset-kit.mjs records the two runs that forced it), so its
    // absence is correct. What must still be present is a case DEEPER than the parity anchor but inside the
    // budget -- depth 8 -- because that is the only remaining case in which depth itself can move the note.
    if (!resolved.some(entry => entry.depthIntent === 'item' && entry.depth > overlay.parityDepth)) {
        problems.push('the case list has no case deeper than the parity anchor that still delivers the note; depth 8 is the deepest point this fixture can measure');
    }
    if (!resolved.some(entry => entry.enabled === false)) problems.push('the case list has no disabled case');
    if (!resolved.some(entry => entry.position === 'IN_PROMPT')) problems.push('the case list records no non-IN_CHAT position');
    if (problems.length > 0) {
        console.error(`prepare-authors-note SELF-CHECK FAILED: ${problems.join('; ')}`);
        process.exit(1);
    }
    console.log(JSON.stringify({
        selfCheck: 'ok',
        outPath: typeof outPath === 'string' && outPath.length > 0,
        cases: resolved.map(entry => ({ id: entry.caseId, depth: entry.depth, position: entry.position, interval: entry.interval, role: entry.role })),
    }, null, 2));
    process.exit(0);
}

if (!requestedContext || !Number.isInteger(Number(requestedContext))) {
    console.error('prepare-authors-note needs --context <keepContext>: the boundary the drive legs will run at, measured by preset-boundary-search.mjs');
    process.exit(2);
}
const context = Number(requestedContext);
await fs.mkdir(outDir, { recursive: true });

async function readJSON(file) {
    return JSON.parse(await fs.readFile(file, 'utf8'));
}

// ONE PINNED DRIVE, THE SAME INVOCATION THE COMPARED LEG USES. `run-against-pinned.mjs` boots a fresh
// pinned server and a fresh data root per call, so every case is measured from the same clean state a real
// leg starts from -- the property that made the boundary search trustworthy.
async function drivePinned(caseId, resolved) {
    const reportPath = path.join(outDir, `authors-note-pinned-${caseId}.json`);
    const redirectPath = path.join(outDir, `redirect-authors-note-pinned-${caseId}.json`);
    const child = spawn(process.execPath, [
        path.join(here, 'run-against-pinned.mjs'),
        'generation-probe.mjs',
        '--',
        '--report',
        reportPath,
    ], {
        cwd: here,
        stdio: ['ignore', 'inherit', 'inherit'],
        env: {
            ...process.env,
            PROBE_MODE: 'preset',
            PROBE_SOURCE: 'custom',
            PROBE_PRESET_VARIANT: 'keep',
            PROBE_PRESET_CONTEXT: String(context),
            PROBE_AUTHORS_NOTE_CASE: caseId,
            PROBE_PINNED_REDIRECT_FILE: redirectPath,
        },
    });
    const code = await new Promise(resolve => child.on('exit', resolve));
    if (code !== 0) {
        return { failure: `the pinned drive for case ${caseId} exited ${code}` };
    }
    const report = await readJSON(reportPath);
    if (report.requestArrived !== true) {
        return { failure: `the pinned drive for case ${caseId} produced no provider request`, diagnosis: report.failure ?? null };
    }
    const parsed = parseProviderBody(report);
    if (!parsed) {
        return { failure: `the pinned drive for case ${caseId} recorded no POST body` };
    }
    const layout = layoutOf(parsed.body, {
        historyMarker: MARKERS.history,
        noteMarker: AUTHORS_NOTE_OVERLAY_MARKER,
        presetNoteMarker: MARKERS.authorsNote,
    });
    const overlayReport = report.authorsNoteOverlay ?? null;
    const preSend = report.presetPreSend ?? null;
    return {
        failure: null,
        // THE BYTES, so the comparator can record what the oracle actually sent (a body digest difference
        // between the pinned preparation and the pinned leg would mean the two runs are not the same
        // request, which is a harness finding rather than a product one).
        bodySha256: parsed.bodySha256 ?? null,
        bodyLength: parsed.bodyLength ?? null,
        layout,
        // THE DECLARED TURN COUNT TRAVELS ON EACH CASE, not only at the top level, so a comparator reading a
        // single case record can state "the note is below every declared turn" without needing the whole
        // file. (A top-level field alone was the first shape and the sweep's check silently degraded to the
        // weaker form when it read an older golden that predates the field.)
        declaredTurns: declaredTurns.map(turn => turn.id),
        // WHAT THE PAGE HELD IMMEDIATELY BEFORE THE CLICK, including the note's `extension_prompts` entry.
        // This is not the expectation of where the note LANDS (the layout above is); it is the record that
        // the case reached the frontend's state at all.
        overlay: overlayReport,
        preSend: preSend?.authorsNoteOverlay ?? null,
        requested: resolved,
    };
}

const measured = {};
const failures = [];
// THE SCENARIO'S DECLARED HISTORY TURNS, recorded so the sweep can state "deeper than EVERY declared turn"
// instead of the weaker "deeper than the parity anchor". Read from the committed preset fixture, which is
// the same fixture the drives apply.
let declaredTurns = null;
try {
    const presetFixture = await readJSON(path.join(here, 'fixtures', 'preset-complex-settings.json'));
    const turns = presetFixture?.capture?.spec?.history;
    declaredTurns = Array.isArray(turns) ? turns.map((turn, index) => ({ id: `TURN_${String(index).padStart(2, '0')}`, textHead: String(turn?.text ?? '').slice(0, 40) })) : null;
} catch (error) {
    console.error(`prepare-authors-note cannot read the preset fixture, so the declared turn count cannot be recorded: ${error?.message ?? error}`);
    process.exit(2);
}
if (!Array.isArray(declaredTurns) || declaredTurns.length === 0) {
    console.error('prepare-authors-note: the preset fixture declares no history turns; a depth sweep needs them');
    process.exit(2);
}
for (const caseId of cases) {
    const resolved = resolveAuthorsNoteCase(overlay, caseId);
    console.log(`[q17] pinned drive: case ${caseId} depth=${resolved.depth} position=${resolved.position} interval=${resolved.interval} role=${resolved.role}`);
    const result = await drivePinned(caseId, resolved);
    measured[caseId] = result;
    if (result.failure) {
        failures.push(result.failure);
    } else {
        console.log(`[q17]   measured: noteIndex=${result.layout.noteIndex} historyBelow=${result.layout.historyBelow} historyAbove=${result.layout.historyAbove} messages=${result.layout.messageCount} sha=${String(result.bodySha256).slice(0, 12)}`);
    }
}

const artifact = {
    schemaVersion: 1,
    surface: 'authors-note',
    question: 'At which position RELATIVE to the history turns, the world-info entries and the other injections does the pinned frontend put the Author\'s Note, for each (position, depth, role, enabled) the UI offers?',
    measuredBy: 'pinned-leg',
    method: 'every case is driven by run-against-pinned.mjs generation-probe.mjs with PROBE_MODE=preset PROBE_AUTHORS_NOTE_CASE=<id> (the same program, arguments and clean state as the compared pinned leg); the observation is the provider REQUEST that drive produced',
    pinnedBaseline: 'SillyTavern 1.19.0, commit 06bde939fb1e9c4c8d8641d810f0a916b5bce127',
    context: {
        keepContext: context,
        note: 'the context preset-boundary-search.mjs measured; the legs and this sweep must run at the SAME budget or the note and the trimmer compete for it',
    },
    parityDepth: overlay.parityDepth,
    // THE DECLARED TURN COUNT TRAVELS WITH THE EXPECTATION, because the sweep's "deeper than the history"
    // check is stated against it: a note deeper than every declared turn must have at least this many
    // history turns below it. Without it the check can only say "deeper than the parity anchor", which is
    // weaker and must be visible as weaker (the sweep records which form it used).
    turns: declaredTurns,
    cases: measured,
    failures,
};
await fs.writeFile(outPath, `${JSON.stringify(artifact, null, 2)}\n`);

if (failures.length > 0) {
    console.error(`prepare-authors-note FAILED: ${failures.length} case(s) produced no observation.`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
}
console.log(JSON.stringify({
    out: outPath,
    cases: Object.entries(measured).map(([id, entry]) => ({
        id,
        noteIndex: entry.layout.noteIndex,
        historyBelow: entry.layout.historyBelow,
        messages: entry.layout.messageCount,
    })),
}));
