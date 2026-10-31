// THE WORLD-INFO SLOT-ORDER RUNNER: one entry point that records both legs and then judges them, fail-closed.
//
// THE SHAPE, and why it is this shape rather than a step per leg:
//   --phase legs   drives the SAME probe on both subjects (GoTavern boots itself, pinned through
//                  run-against-pinned.mjs) and exits non-zero if either drive failed -- a drive failure must never
//                  leave an artefact that reads as a judgment.
//   --phase judge  runs compare-worldinfo-slots-legs.mjs over the recorded pair. It REFUSES (exit 2) when a leg is
//                  absent, so "no evidence" can never be reported as PASS.
//   --self-check   resolves every path this file will touch and exits 1 with a named list if anything is missing. A
//                  sweep that dies on an undefined identifier after two browser boots has wasted the expensive part to
//                  learn something a `fs.access` knew in a millisecond.
//
// WHY THE EXPECTATION IS NOT A SEPARATE "prepare" PHASE (unlike the Author's-Note sweep, which has one). Q17 needs a
// pinned leg to MEASURE a budget that only a bisection can find. This surface needs no such number: the expectation is
// (a) the pinned source's stated order (`worldinfo-slots-kit.mjs` F1..F5, cited per guard) and (b) the pinned leg's own
// capture, which is recorded by the same `legs` phase that records the candidate. So there is nothing to prepare, and
// adding a phase would only add a way for the two to disagree.

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (name, fallback = null) => {
    const index = argv.indexOf(name);
    return index === -1 ? fallback : argv[index + 1];
};

const outDir = path.resolve(arg('--out-dir', path.join(here, 'legs')));
const reportDir = path.resolve(arg('--report', outDir));
const dataRootBase = path.resolve(arg('--data-root', path.join(outDir, 'worldinfo-slots-trees')));
const legPaths = {
    gotavern: path.join(outDir, 'worldinfo-slots-gotavern.json'),
    pinned: path.join(outDir, 'worldinfo-slots-pinned.json'),
};
const artefactPath = path.join(reportDir, 'worldinfo-slots-comparison.json');

const run = (file, args, env) => new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(here, file), ...args], { cwd: here, stdio: 'inherit', env: { ...process.env, ...env } });
    child.on('exit', code => resolve(code ?? 1));
});

if (argv.includes('--self-check')) {
    const problems = [];
    for (const required of ['worldinfo-slots-probe.mjs', 'compare-worldinfo-slots-legs.mjs', 'q20-leg-runtime.mjs', 'run-against-pinned.mjs', 'seed-leg-config.mjs']) {
        try {
            await fs.access(path.join(here, required));
        } catch {
            problems.push(`${required} is missing from the harness`);
        }
    }
    if (!process.env.GOTAVERN_BINARY) {
        problems.push('GOTAVERN_BINARY is not set, so the GoTavern leg would produce the named refusal "GOTAVERN_BINARY is required" instead of a drive');
    } else {
        try {
            await fs.access(path.resolve(process.env.GOTAVERN_BINARY));
        } catch {
            problems.push(`GOTAVERN_BINARY points at ${process.env.GOTAVERN_BINARY}, which does not exist`);
        }
    }
    if (problems.length > 0) {
        console.error(`worldinfo-slots-sweep SELF-CHECK FAILED: ${problems.join('; ')}`);
        process.exit(1);
    }
    console.log(JSON.stringify({ selfCheck: 'ok', outDir, reportDir, artefactPath, legPaths }));
    process.exit(0);
}

await fs.mkdir(outDir, { recursive: true });
await fs.mkdir(reportDir, { recursive: true });

const phase = arg('--phase', null);
if (!['legs', 'judge'].includes(phase)) {
    console.error('worldinfo-slots-sweep needs --phase legs|judge');
    process.exit(2);
}

if (phase === 'legs') {
    const failures = [];
    for (const subject of ['gotavern', 'pinned']) {
        const dataRoot = path.join(dataRootBase, subject);
        await fs.rm(dataRoot, { recursive: true, force: true });
        await fs.mkdir(dataRoot, { recursive: true });
        const args = ['--data-root', dataRoot, '--report', legPaths[subject]];
        const code = subject === 'gotavern'
            ? await run('worldinfo-slots-probe.mjs', args, {})
            : await run('run-against-pinned.mjs', ['worldinfo-slots-probe.mjs', '--', ...args], {});
        console.log(`[wi-slots] ${subject}: drive exited ${code}`);
        if (code !== 0) failures.push(subject);
    }
    if (failures.length > 0) {
        console.error(`the following drives failed and produced no evidence: ${failures.join(', ')}`);
        process.exit(1);
    }
    process.exit(0);
}

// ---- judge: the comparator owns the verdict, and it refuses rather than skips -----------------------------------
const code = await run('compare-worldinfo-slots-legs.mjs', ['--gotavern', legPaths.gotavern, '--pinned', legPaths.pinned, '--out', artefactPath], {});
console.log(`[wi-slots] comparator exited ${code}; artefact ${code === 0 ? 'written' : 'written (FAIL)'} at ${artefactPath}`);
process.exit(code === 0 ? 0 : 1);
