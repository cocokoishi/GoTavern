#!/usr/bin/env node
// RUN THE WHOLE EXTENSION ASSET-SERVING SURFACE, INCLUDING ITS TEETH, IN ONE BOUNDED COMMAND.
//
// WHAT IT DOES, in this order, and why each step exists:
//   1. GOTAVERN leg, flat install   -> a report of every URL the pinned frontend builds, from the GoTavern subject.
//   2. PINNED leg, flat install     -> the same drive against the pinned server, booted by `run-against-pinned.mjs`.
//   3. COMPARE the two              -> must be `match`; every guard named if not.
//   4. TEETH (report mutations)     -> the comparator's own selftest: wrong content type on a nested asset, one asset
//                                      404, the extension one directory deeper, an absent report, and the same leg
//                                      twice. Each must turn a NAMED guard red.
//   5. TEETH (a real re-run)        -> the GoTavern leg installed ONE DIRECTORY DEEPER, against the same pinned leg.
//                                      This is the mutation the release gap names, run against real servers: discovery
//                                      no longer lists the extension and every derived URL answers 404, so the pair
//                                      must go red, with the URLs named.
//   6. RESTORE                      -> the flat GoTavern leg again, compared again: must be `match`, so step 5's red is
//                                      attributable to the mutation rather than to drift between runs.
//
// BOUNDED: three GoTavern boots (seconds each) and ONE pinned boot (its frontend compile dominates; the readiness
// deadline is PINNED_READY_MS, default 420000). No browser is launched; no request leaves 127.0.0.1.
//
// Usage:
//   node tests/browser/extension-assets-run.mjs [--work-root <dir>] [--keep]
//     --work-root  where the two data roots and the four leg reports are written (default: <temp>/gotavern-ext-assets-<pid>)
//     --keep       do not delete the work root at the end (the reports are the evidence, so a CI step keeps them anyway)
//
// Exit 0 only when the flat pair MATCHED, the restore MATCHED, and every teeth case behaved. Exit 1 otherwise, naming the
// stage that failed. Exit 2 on a refusal (no GOTAVERN_BINARY, no pinned checkout).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

function argumentValue(name, fallback = null) {
    const index = process.argv.indexOf(name);
    if (index < 0) return fallback;
    const value = process.argv[index + 1];
    return value === undefined ? fallback : value;
}

const keep = process.argv.includes('--keep');
const workRoot = path.resolve(argumentValue('--work-root', path.join(os.tmpdir(), `gotavern-ext-assets-${process.pid}`)));
fs.mkdirSync(workRoot, { recursive: true });
const reports = path.join(workRoot, 'reports');
fs.mkdirSync(reports, { recursive: true });

function refuse(message) {
    console.error(`REFUSING: ${message}`);
    process.exit(2);
}

const binary = process.env.GOTAVERN_BINARY ?? '';
if (!binary) refuse('GOTAVERN_BINARY must point at a GoTavern binary; this runner boots the GoTavern subject itself and will not substitute one');
if (!fs.existsSync(binary)) refuse(`GOTAVERN_BINARY is ${binary}, which does not exist`);
if (!fs.existsSync(path.join(repoRoot, 'tests', 'browser', 'run-against-pinned.mjs'))) refuse('run-against-pinned.mjs is missing, so the pinned leg cannot boot');

// stderr and stdout both go to this process's own streams; the exit code is the CHILD's, never re-derived from text
// (AGENTS.md rule 8: a wrapper that re-derives a status from captured output manufactures failures).
function run(stage, command, args, options = {}) {
    const started = Date.now();
    console.log(`\n=== ${stage} ===`);
    console.log(`$ ${[command, ...args].join(' ')}`);
    const result = spawnSync(command, args, { cwd: repoRoot, stdio: 'inherit', env: { ...process.env, ...(options.env ?? {}) } });
    const elapsedMs = Date.now() - started;
    console.log(`[${stage}] exit ${result.status} in ${Math.round(elapsedMs / 1000)}s`);
    return result.status;
}

const node = process.execPath;
const stages = [];

// ---- 1. the two flat legs ---------------------------------------------------------------------------------------
const goRoot = path.join(workRoot, 'tree-gotavern');
const pinnedRoot = path.join(workRoot, 'tree-pinned');
for (const root of [goRoot, pinnedRoot]) {
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(root, { recursive: true });
}
const goFlatReport = path.join(reports, 'extension-assets-gotavern.json');
const pinnedFlatReport = path.join(reports, 'extension-assets-pinned.json');
const goFlatDeepReport = path.join(reports, 'extension-assets-gotavern-deep.json');
const goRestoredReport = path.join(reports, 'extension-assets-gotavern-restored.json');
const verdictFlat = path.join(reports, 'extension-assets-verdict.json');

stages.push({ name: 'gotavern-flat', status: run('gotavern leg (flat install)', node, [
    path.join(here, 'extension-assets-probe.mjs'),
    '--data-root', goRoot, '--report', goFlatReport, '--subject', 'gotavern', '--layout', 'flat',
]) });
stages.push({ name: 'pinned-flat', status: run('pinned leg (flat install)', node, [
    path.join(here, 'run-against-pinned.mjs'), 'extension-assets-probe.mjs', '--',
    '--data-root', pinnedRoot, '--report', pinnedFlatReport, '--subject', 'pinned', '--layout', 'flat',
], { env: { PINNED_READY_MS: process.env.PINNED_READY_MS ?? '420000' } }) });

// ---- 3. the pair ------------------------------------------------------------------------------------------------
stages.push({ name: 'compare-flat', status: run('compare the flat pair (must be match)', node, [
    path.join(here, 'extension-assets-compare.mjs'), goFlatReport, pinnedFlatReport, '--out', verdictFlat,
]) });

// ---- 4. the comparator's teeth -----------------------------------------------------------------------------------
stages.push({ name: 'selftest', status: run('teeth: comparator mutations', node, [
    path.join(here, 'extension-assets-compare.mjs'), '--selftest', goFlatReport, pinnedFlatReport,
]) });

// ---- 5. the real mutation: one directory deeper ------------------------------------------------------------------
// THE DEEP LEG IS EXPECTED TO FAIL ITS OWN JUDGE, because the mutation IS the failure: discovery no longer lists the
// extension and every derived URL answers 404, so that leg reports `mismatch` by design. The stage passes when the leg
// goes red, and the comparator stage below then requires the RED PAIR to be red for the named reasons.
const deepProbeStatus = run('gotavern leg installed ONE DIRECTORY DEEPER (expected: its own judge red)', node, [
    path.join(here, 'extension-assets-probe.mjs'),
    '--data-root', goRoot, '--report', goFlatDeepReport, '--subject', 'gotavern', '--layout', 'deep',
]);
stages.push({ name: 'gotavern-deep-is-red', status: deepProbeStatus === 0 ? 1 : 0, note: `probe exit ${deepProbeStatus}, expected non-zero` });
// A red here is the EXPECTED outcome, so the stage passes when the comparator DOES fail. The stage names itself and the
// expectation is written down: this is the one place where a non-zero comparator exit is success.
const deepCompareStatus = run('compare deep-vs-flat (EXPECTED red)', node, [
    path.join(here, 'extension-assets-compare.mjs'), goFlatDeepReport, pinnedFlatReport,
]);
stages.push({ name: 'compare-deep-is-red', status: deepCompareStatus === 0 ? 1 : 0, note: `comparator exit ${deepCompareStatus}, expected non-zero` });

// ---- 6. restore --------------------------------------------------------------------------------------------------
stages.push({ name: 'gotavern-restored', status: run('gotavern leg restored (flat install)', node, [
    path.join(here, 'extension-assets-probe.mjs'),
    '--data-root', goRoot, '--report', goRestoredReport, '--subject', 'gotavern', '--layout', 'flat',
]) });
stages.push({ name: 'compare-restored', status: run('compare the restored pair (must be match again)', node, [
    path.join(here, 'extension-assets-compare.mjs'), goRestoredReport, pinnedFlatReport,
]) });

// ---- summary -----------------------------------------------------------------------------------------------------
console.log('\n=== extension asset-serving: stages ===');
for (const stage of stages) {
    console.log(`${stage.status === 0 ? 'ok  ' : 'FAIL'} ${stage.name}${stage.note === undefined ? '' : ` (${stage.note})`}`);
}
const failed = stages.filter(stage => stage.status !== 0);
console.log(`reports: ${reports}`);
if (!keep) console.log(`(the work root is kept anyway: the leg reports are the evidence -- ${workRoot})`);
if (failed.length > 0) {
    console.error(`FAILED stages: ${failed.map(stage => stage.name).join(', ')}`);
    process.exit(1);
}
console.log('extension asset-serving: every stage behaved as required');
process.exit(0);
