#!/usr/bin/env node
// THE LONG-LIVED QUALIFICATION DRIVER: boot BOTH subjects over COPIES of the same generated corpus, drive the
// whole long-lived journey, judge the four legs, prove the judge has teeth, and write a machine-readable verdict.
//
// WHAT IT ORCHESTRATES (one process, so the CI invocation is one command):
//   1. BUILD or ACCEPT the corpus. Without `--corpus`, `tools/build-longlived-corpus.mjs` generates it with a fixed
//      seed and `--verify-deterministic`; `tools/longlived/verify.mjs` then re-walks the tree and asserts its
//      surfaces by name. The corpus is NEVER booted in place (AGENTS 14/51).
//   2. COPY it once per subject into the run directory. Both copies are byte-identical and the comparator requires
//      the same corpus digest on both sides before any check is a comparison.
//   3. RUN four legs sequentially: GoTavern drive, GoTavern restart (same tree), pinned Node drive, pinned Node
//      restart (same tree). A restart is a separate invocation because that is what a server restart is; the
//      comparator requires the pid to differ.
//   4. COMPARE browser-observable state, provider request bytes and persisted disk state
//      (`longlived-compare-legs.mjs`), with the narrow normalisation table it carries.
//   5. PROVE THE JUDGE HAS TEETH (`longlived-gate-selftest.mjs`): mutations of THIS run's own artefacts must each
//      produce their NAMED red on top of the green baseline.
//
// SAFETY (operator's desktop). No desktop browser may ever be launched:
//   * GoTavern is booted only by `q20-leg-runtime.mjs` with `--browserLaunchEnabled false`;
//   * pinned is booted only by `run-against-pinned.mjs`, which passes the same flag;
//   * Playwright is launched only by the probe with `chromium.launch({ headless: true })`.
// `assertNoDesktopBrowserCanLaunch` below refuses to start if any of those three literals disappears from the
// wrappers/probe, so this property cannot be lost by a future edit without this driver failing first.
//
// USAGE:
//   node tests/browser/longlived-qualify.mjs --size small --out-dir tests/browser/.tmp-artifacts/longlived-small
//   node tests/browser/longlived-qualify.mjs --size medium --corpus <prebuilt> --out-dir <dir>
// Environment: GOTAVERN_BINARY (the candidate binary), GOTAVERN_REFERENCE (the pinned checkout), PINNED_READY_MS.
// `--skip-pinned` exists ONLY for local triage: it records pinned as not-observed and the verdict is NOT a pass.

import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

function argument(name, fallback = null) {
    const index = process.argv.indexOf(name);
    if (index < 0) return fallback;
    const value = process.argv[index + 1];
    return value === undefined ? fallback : value;
}

function run(command, args, { cwd = repoRoot, env = process.env, label } = {}) {
    return new Promise(resolve => {
        const started = Date.now();
        const child = spawn(command, args, { cwd, env, stdio: 'inherit' });
        child.on('error', error => resolve({ code: 1, signal: null, error: String(error?.message ?? error), elapsedMs: Date.now() - started, label }));
        child.on('exit', (code, signal) => resolve({ code: code ?? 1, signal, error: null, elapsedMs: Date.now() - started, label }));
    });
}

/**
 * REFUSE TO START WHEN A DESKTOP BROWSER COULD BE LAUNCHED.
 *
 * The operator's desktop must never receive a browser window from this lane (the lead's urgent instruction). Three
 * literal flags are the whole guarantee, and they live in files this driver does not own -- so they are asserted
 * HERE, at the entry point, and a missing one fails the run instead of opening a window.
 */
async function assertNoDesktopBrowserCanLaunch() {
    const checks = [
        {
            file: path.join(here, 'q20-leg-runtime.mjs'),
            needle: "'--browserLaunchEnabled'",
            why: 'the GoTavern boot must pass --browserLaunchEnabled false',
        },
        {
            file: path.join(here, 'run-against-pinned.mjs'),
            needle: "'--browserLaunchEnabled'",
            why: 'the pinned boot must pass --browserLaunchEnabled false',
        },
        {
            file: path.join(here, 'longlived-corpus-probe.mjs'),
            needle: 'chromium.launch({ headless: true })',
            why: 'Playwright must be launched explicitly headless',
        },
        {
            file: path.join(here, 'longlived-corpus-probe.mjs'),
            needle: 'bootSubject',
            why: 'the probe must not spawn a server of its own',
        },
    ];
    const failures = [];
    for (const check of checks) {
        const body = await fs.readFile(check.file, 'utf8').catch(() => '');
        if (!body.includes(check.needle)) failures.push({ file: path.relative(repoRoot, check.file), needle: check.needle, why: check.why });
    }
    if (failures.length > 0) {
        throw new Error(`REFUSING TO RUN: a desktop-browser launch guard is missing: ${JSON.stringify(failures)}`);
    }
    return checks.map(check => path.relative(repoRoot, check.file));
}

async function copyTree(source, target) {
    await fs.rm(target, { recursive: true, force: true });
    await fs.cp(source, target, { recursive: true });
    return target;
}

function lastJsonLine(output) {
    const lines = String(output ?? '').trim().split('\n');
    for (let index = lines.length - 1; index >= 0; index--) {
        const line = lines[index].trim();
        if (line.startsWith('{') && line.endsWith('}')) return line;
    }
    return null;
}

async function main() {
    const size = argument('--size', 'small');
    if (!['small', 'medium', 'large'].includes(size)) throw new Error(`--size must be small, medium or large, not ${JSON.stringify(size)}`);
    if (size === 'large') {
        // A >100 MB corpus with 5000-message chats is a generator/Go-gate input (nightly/manual); a browser drive over
        // it would spend an hour loading history without adding an assertion. Refuse rather than pretend.
        throw new Error('--size large is generator + Go-gate only (see .github/workflows/longlived.yml); the browser leg supports small and medium');
    }
    const outDir = path.resolve(argument('--out-dir', path.join(here, '.tmp-artifacts', `longlived-${size}`)));
    const skipPinned = process.argv.includes('--skip-pinned');
    const allowPrebuilt = argument('--corpus', null);
    const binary = process.env.GOTAVERN_BINARY ?? '';
    if (!binary) throw new Error('GOTAVERN_BINARY is required: this driver boots the CANDIDATE binary');
    const reference = process.env.GOTAVERN_REFERENCE ?? path.resolve(repoRoot, '..', 'SillyTavern');
    await fs.mkdir(outDir, { recursive: true });

    const verdict = {
        schema: 'gotavern-longlived-verdict',
        schemaVersion: 1,
        size,
        startedWith: { binary, reference, pinned: !skipPinned },
        brokenGuards: [],
        corpus: null,
        legs: [],
        comparison: null,
        teeth: null,
        ok: false,
        residualRisks: [
            'the provider is the recording peer, not a real provider (AGENTS 22); a real completion is out of scope on this gate',
            'a large corpus is qualified by the generator + Go gate, not by a browser drive (declared, not implied)',
            'the pinned leg requires the pinned checkout with its node_modules; a machine without it records pinned as not-observed rather than passing',
        ],
    };

    try {
        verdict.guardsChecked = await assertNoDesktopBrowserCanLaunch();
    } catch (error) {
        verdict.brokenGuards = [String(error?.message ?? error)];
        verdict.error = String(error?.message ?? error);
        await fs.writeFile(path.join(outDir, 'longlived-verdict.json'), `${JSON.stringify(verdict, null, 2)}\n`, 'utf8');
        console.error(verdict.error);
        process.exit(1);
    }

    // ---- 1. THE CORPUS.
    let corpusRoot = allowPrebuilt ? path.resolve(allowPrebuilt) : path.join(outDir, 'corpus');
    if (!allowPrebuilt) {
        const generation = await run(process.execPath, [
            path.join(repoRoot, 'tools', 'build-longlived-corpus.mjs'), '--size', size, '--out', corpusRoot,
            '--seed', 'corpus-qualify', '--force', '--verify-deterministic', '--quiet',
        ], { env: { ...process.env } });
        verdict.legs.push({ name: 'generate-corpus', exitCode: generation.code });
        if (generation.code !== 0) throw new Error(`the corpus generator failed (exit ${generation.code})`);
    }
    const verifier = await run(process.execPath, [path.join(repoRoot, 'tools', 'longlived', 'verify.mjs'), '--corpus', corpusRoot], { env: { ...process.env } });
    verdict.legs.push({ name: 'verify-corpus', exitCode: verifier.code });
    const manifest = JSON.parse(await fs.readFile(path.join(corpusRoot, 'manifest.json'), 'utf8'));
    verdict.corpus = { root: corpusRoot, size: manifest.size, seed: manifest.seed, treeSha256: manifest.tree.sha256, files: manifest.tree.files, bytes: manifest.tree.bytes };
    if (verifier.code !== 0) throw new Error('the corpus verifier refused the generated tree');

    // ---- 2. THE COPIES.
    const goTree = path.join(outDir, 'subjects', 'gotavern');
    const pinnedTree = path.join(outDir, 'subjects', 'pinned');
    await copyTree(corpusRoot, goTree);
    await copyTree(corpusRoot, pinnedTree);
    verdict.subjects = { goTree, pinnedTree };

    // ---- 3. THE FOUR LEGS, sequentially (a restart must follow its drive over the SAME tree).
    const legsDir = path.join(outDir, 'legs');
    await fs.mkdir(legsDir, { recursive: true });
    const legResults = [];
    const baseEnv = { ...process.env, GOTAVERN_BINARY: binary, GOTAVERN_REFERENCE: reference };
    for (const phase of ['drive', 'restart']) {
        for (const subject of ['gotavern', 'pinned']) {
            if (subject === 'pinned' && skipPinned) {
                legResults.push({ subject, phase, skipped: true, reason: '--skip-pinned (triage only; the verdict is NOT a pass)' });
                continue;
            }
            const tree = subject === 'gotavern' ? goTree : pinnedTree;
            const report = path.join(legsDir, `longlived-${phase}-${subject}.json`);
            const prefix = subject === 'gotavern' ? 'LLG_' : 'LLP_';
            const args = subject === 'gotavern'
                ? [path.join(here, 'longlived-corpus-probe.mjs'), '--phase', phase, '--data-root', tree, '--reply-prefix', prefix, '--report', report]
                : [path.join(here, 'run-against-pinned.mjs'), 'longlived-corpus-probe.mjs', '--', '--phase', phase, '--data-root', tree, '--reply-prefix', prefix, '--report', report];
            const execution = await run(process.execPath, args, { env: { ...baseEnv, PINNED_READY_MS: process.env.PINNED_READY_MS ?? '180000' } });
            const reportExists = await fs.stat(report).then(info => info.size > 0, () => false);
            legResults.push({ subject, phase, exitCode: execution.code, elapsedMs: execution.elapsedMs, report: reportExists ? path.relative(outDir, report) : null });
            verdict.legs.push({ name: `${subject}-${phase}`, exitCode: execution.code, elapsedMs: execution.elapsedMs, report: reportExists ? path.relative(outDir, report) : null });
            // A FAILING LEG DOES NOT ABORT THE OTHERS: all four must be attempted, or the repair loop pays for the
            // same partial run repeatedly (whole-session.yml records this lesson).
        }
    }
    verdict.legReports = legResults;

    // ---- 4. THE JUDGE.
    const legPath = name => path.join(legsDir, `longlived-${name}.json`);
    const comparisonPath = path.join(outDir, 'longlived-comparison.json');
    if (!skipPinned) {
        const comparison = await run(process.execPath, [
            path.join(here, 'longlived-compare-legs.mjs'),
            '--drive-go', legPath('drive-gotavern'),
            '--drive-pinned', legPath('drive-pinned'),
            '--restart-go', legPath('restart-gotavern'),
            '--restart-pinned', legPath('restart-pinned'),
            '--out', comparisonPath,
        ], { env: { ...process.env } });
        verdict.legs.push({ name: 'compare', exitCode: comparison.code });
        if (await fs.stat(comparisonPath).then(info => info.size > 0, () => false)) {
            const parsed = JSON.parse(await fs.readFile(comparisonPath, 'utf8'));
            verdict.comparison = { path: comparisonPath, ok: parsed.ok, verdict: parsed.verdict, summary: parsed.summary, normalisations: parsed.normalisations?.length ?? 0, failed: parsed.checks.filter(check => check.verdict === 'mismatch' || check.verdict === 'harness-error').map(check => check.name) };
        }
        // ---- 5. THE TEETH, on THIS run's artefacts.
        if (verdict.comparison?.ok === true) {
            const teethPath = path.join(outDir, 'longlived-teeth.json');
            const teeth = await run(process.execPath, [
                path.join(here, 'longlived-gate-selftest.mjs'),
                '--drive-go', legPath('drive-gotavern'),
                '--drive-pinned', legPath('drive-pinned'),
                '--restart-go', legPath('restart-gotavern'),
                '--restart-pinned', legPath('restart-pinned'),
                '--out', teethPath,
            ], { env: { ...process.env } });
            verdict.legs.push({ name: 'teeth', exitCode: teeth.code });
            if (await fs.stat(teethPath).then(info => info.size > 0, () => false)) {
                verdict.teeth = JSON.parse(await fs.readFile(teethPath, 'utf8'));
            }
        }
    } else {
        verdict.comparison = { ok: false, verdict: 'not-observed', reason: '--skip-pinned was used: there is no pinned leg, so nothing is compared' };
    }

    verdict.ok = skipPinned !== true
        && verdict.legReports.every(leg => leg.skipped !== true && leg.exitCode === 0 && leg.report !== null)
        && verdict.comparison?.ok === true
        && verdict.teeth?.ok === true;
    await fs.writeFile(path.join(outDir, 'longlived-verdict.json'), `${JSON.stringify(verdict, null, 2)}\n`, 'utf8');
    console.error(`long-lived qualification (${size}): ${verdict.ok ? 'PASS' : 'FAIL'} -> ${path.join(outDir, 'longlived-verdict.json')}`);
    if (!verdict.ok) console.error(JSON.stringify({ legs: verdict.legReports, comparison: verdict.comparison, teeth: verdict.teeth?.summary ?? null }, null, 2));
    process.exit(verdict.ok ? 0 : 1);
}

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href.replace(/%20/g, ' ')) {
    main().catch(async error => {
        console.error(`long-lived qualification driver failed: ${error?.message ?? error}`);
        process.exit(1);
    });
}
