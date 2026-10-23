#!/usr/bin/env node
// Apply the Linux `oracle-linux-rerecord` patch for the CURRENT HEAD, or refuse and say why.
//
// WHY THIS EXISTS. A source lane can record scenario INPUTS but not captures: several fixtures cannot be
// recorded faithfully on the Windows development host, so CI's oracle job re-records on Linux and
// publishes the difference as a `git diff --binary` patch artifact. Applying that patch used to be a
// hand sequence (download, check, apply, count, commit, push) repeated for every unrecorded source. This
// script makes the mechanical part mechanical and keeps the two judgements a human still owns:
//
//   * the patch must belong to the COMMIT YOU ARE ON -- a push between the oracle start and its
//     completion produces a patch for a commit you no longer have (`headSha` is checked, not assumed);
//   * the patch must touch ONLY fixture files by default -- the job also diffs docs/api-inventory.md,
//     docs/config-inventory.md and upstream/, and those carry hand-maintained and release-owned content
//     that a re-record may legitimately move but that a fixture patch must not smuggle in.
//
// It NEVER commits and NEVER pushes. Those two acts stay with the person who read the counts.
//
// Usage:
//   node scripts/apply-oracle-rerecord.mjs                 # newest successful oracle artifact for HEAD
//   node scripts/apply-oracle-rerecord.mjs --dry-run       # every check, no `git apply`
//   node scripts/apply-oracle-rerecord.mjs --patch FILE    # a patch already on disk (e.g. from a colleague)
//   node scripts/apply-oracle-rerecord.mjs --run 123456    # pin an Actions run id
//   node scripts/apply-oracle-rerecord.mjs --allow-non-oracle path1,path2
//                                                          # opt in to extra paths, printed for review
//
// Exit codes: 0 applied (or dry-run passed), 1 refused, 2 usage error.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const WORKFLOW = 'ci.yml';
const ARTIFACT = 'oracle-linux-rerecord';
const PATCH_NAME = 'oracle-rerecord.patch';
// The fixture tree is the ONLY thing this script applies by default; see the header for why the others
// exist in the artifact at all.
const FIXTURE_PREFIX = 'tests/oracle/';

class Refusal extends Error {
    constructor(message) {
        super(message);
        this.name = 'Refusal';
    }
}

function say(message) {
    process.stdout.write(`${message}\n`);
}

function refuse(message) {
    throw new Refusal(message);
}

function git(args, options = {}) {
    return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options });
}

function gh(args) {
    try {
        return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
        const detail = (error.stderr ?? '').toString().trim();
        refuse(`gh ${args.join(' ')} failed${detail === '' ? '' : `: ${detail}`}`);
    }
}

function parseArguments(argv) {
    const options = { dryRun: false, patchPath: null, runId: null, allowNonOracle: [] };
    for (let index = 0; index < argv.length; index++) {
        const argument = argv[index];
        if (argument === '--dry-run') {
            options.dryRun = true;
        } else if (argument === '--patch') {
            options.patchPath = argv[++index];
            if (!options.patchPath) refuse('--patch needs a file path');
        } else if (argument === '--run') {
            options.runId = argv[++index];
            if (!options.runId) refuse('--run needs a run id');
        } else if (argument === '--allow-non-oracle') {
            const value = argv[++index];
            if (!value) refuse('--allow-non-oracle needs a comma-separated list of paths');
            options.allowNonOracle.push(...value.split(',').map(entry => entry.trim()).filter(Boolean));
        } else if (argument === '--help' || argument === '-h') {
            say(readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter(line => line.startsWith('//')).map(line => line.slice(3)).join('\n'));
            process.exit(0);
        } else {
            refuse(`unknown argument ${argument} (try --help)`);
        }
    }
    return options;
}

function headCommit() {
    try {
        return git(['rev-parse', 'HEAD']).trim();
    } catch {
        refuse('this is not a git checkout, so there is no HEAD to match a patch against');
    }
}

// The oracle artifact must belong to the commit the working tree is on. Two real failures this guards:
// a lane pushed to main between the oracle start and its completion (the patch is for a commit that is no
// longer HEAD, and applying it silently reverts that lane's fixtures), and an IN-FLIGHT run (whose patch
// does not exist yet, and whose push would be cancelled by another push -- hazard (a) in the runbook).
function findRun(options, head) {
    if (options.runId) {
        const run = JSON.parse(gh(['run', 'view', options.runId, '--json', 'databaseId,headSha,status,conclusion,url,event,workflowName']));
        return run;
    }
    const runs = JSON.parse(gh(['run', 'list', '--workflow', WORKFLOW, '--limit', '60', '--json',
        'databaseId,headSha,status,conclusion,url,event,createdAt,workflowName']));
    const forHead = runs.filter(run => run.headSha === head);
    if (forHead.length === 0) {
        const newest = runs.slice(0, 3).map(run => `  ${run.databaseId} ${run.headSha.slice(0, 8)} ${run.status}/${run.conclusion ?? '-'} ${run.url}`).join('\n');
        refuse(`no "${WORKFLOW}" run exists for HEAD ${head.slice(0, 8)}.\n`
            + `The oracle re-records the commit that was PUSHED, so push this commit (or wait for its run) first.\n`
            + `Newest runs, none of which is this commit:\n${newest}`);
    }
    const completed = forHead.filter(run => run.status === 'completed');
    const successful = completed.filter(run => run.conclusion === 'success');
    if (successful.length === 0) {
        const inFlight = completed.length === 0;
        refuse(inFlight
            ? `the "${WORKFLOW}" run for HEAD ${head.slice(0, 8)} is still ${forHead[0].status} (${forHead[0].url}).\n`
                + 'Wait for it to COMPLETE: pushing again now cancels it (concurrency.cancel-in-progress), and a cancelled run publishes no patch.'
            : `the "${WORKFLOW}" run for HEAD ${head.slice(0, 8)} completed with conclusion "${completed[0].conclusion}" (${completed[0].url}).\n`
                + 'A failed run still uploads the patch, but the failure is the first thing to read: rerun this with --run '
                + `${completed[0].databaseId} once you know why, or fix the failure and push.`);
    }
    return successful.sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))[0];
}

function downloadPatch(options, run) {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'gotavern-oracle-patch-'));
    try {
        gh(['run', 'download', String(run.databaseId), '-n', ARTIFACT, '-D', directory]);
    } catch (error) {
        if (error instanceof Refusal) throw error;
        rmSync(directory, { recursive: true, force: true });
        refuse(`run ${run.databaseId} has no "${ARTIFACT}" artifact (${run.url}).\n`
            + 'The artifact is uploaded by the oracle job on every run it starts; a run SKIPPED by the changes gate has none.');
    }
    const patchPath = path.join(directory, PATCH_NAME);
    if (!existsSync(patchPath)) {
        rmSync(directory, { recursive: true, force: true });
        refuse(`the artifact of run ${run.databaseId} does not contain ${PATCH_NAME}`);
    }
    return { patchPath, directory };
}

// A zero-byte patch is the SUCCESS case of the oracle job on an already-recorded commit, and applying it is
// a no-op. It is reported as such instead of looking like a silent failure.
function readPatch(patchPath) {
    const contents = readFileSync(patchPath, 'utf8');
    if (contents.trim() === '') return { contents, touched: [] };
    const touched = new Map();
    for (const line of contents.split('\n')) {
        if (!line.startsWith('diff --git ')) continue;
        const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
        if (!match) refuse(`the patch has a diff header this script cannot read: ${line}`);
        touched.set(match[2], match[1]);
    }
    if (touched.size === 0) refuse(`the patch has bytes but no "diff --git" header, so it is not a unified diff`);
    return { contents, touched: [...touched.values()] };
}

function assertOnlyFixtures(touched, allowNonOracle) {
    const allowed = new Set(allowNonOracle);
    const offenders = touched.filter(entry => !entry.startsWith(FIXTURE_PREFIX) && !allowed.has(entry));
    if (offenders.length === 0) return;
    refuse(`the patch touches ${offenders.length} path(s) outside ${FIXTURE_PREFIX}:\n`
        + offenders.map(entry => `  ${entry}`).join('\n')
        + '\nThose carry hand-maintained (docs/*-inventory.md status columns) or release-owned (upstream/) content,'
        + '\nso applying them silently is a decision, not a mechanical step. Review them, then either apply them'
        + '\nyourself or re-run with --allow-non-oracle <comma-separated paths> to say so explicitly.');
}

function checkApplies(patchPath) {
    // The patch is recorded on LINUX, so it carries LF context lines. A Windows worktree with
    // `core.autocrlf=true` can hold CRLF bytes, where a worktree apply fails for a line-ending reason that
    // has nothing to do with whether the patch is right. So: try the worktree first, then the INDEX (which
    // always holds the clean LF form, exactly like the runner that produced the patch), and report which one
    // was used instead of refusing on an encoding artefact.
    try {
        git(['apply', '--check', '--binary', patchPath]);
        return 'worktree';
    } catch (worktreeError) {
        try {
            git(['apply', '--cached', '--check', '--binary', patchPath]);
            return 'index';
        } catch {
            const detail = String(worktreeError.stderr ?? worktreeError.stdout ?? '').trim();
            refuse(`git apply --check REFUSED this patch for the current tree (tried the worktree and the index):\n${detail}\n`
                + 'The usual cause is hazard (b) in docs/oracle-record-loop.md: a commit landed on this branch'
                + '\nafter the oracle run started, so the patch is against a tree that no longer exists. Re-run the'
                + '\noracle on the current HEAD instead of forcing it (never use --3way to "make it fit").');
        }
    }
}

function applyPatch(patchPath, mode, touched) {
    if (mode === 'worktree') {
        git(['apply', '--binary', patchPath]);
        return;
    }
    // Applied through the index because the worktree bytes differ by line endings; checkout then writes the
    // worktree in the form this repository's own checkout would produce, and the files are already STAGED.
    say('note: the worktree bytes differ from the patch by line endings (core.autocrlf); applying through the index');
    git(['apply', '--cached', '--binary', patchPath]);
    git(['checkout', '--', ...touched]);
}

function scenarioNames(commitOrWorking, fixture) {
    let text;
    try {
        text = commitOrWorking === 'HEAD'
            ? git(['show', `HEAD:${fixture}`])
            : readFileSync(fixture, 'utf8');
    } catch {
        return null;
    }
    try {
        const parsed = JSON.parse(text);
        const scenarios = parsed?.scenarios;
        return scenarios && typeof scenarios === 'object' ? Object.keys(scenarios) : [];
    } catch {
        return null;
    }
}

function reportScenarioDelta(touched) {
    const fixtures = touched.filter(entry => entry.startsWith(FIXTURE_PREFIX) && entry.endsWith('.json'));
    if (fixtures.length === 0) {
        say('scenario delta: no fixture files in the patch');
        return;
    }
    say('scenario delta (per fixture: before -> after):');
    let added = 0;
    let removed = 0;
    for (const fixture of fixtures) {
        const before = scenarioNames('HEAD', fixture);
        const after = scenarioNames('working', fixture);
        if (before === null || after === null) {
            say(`  ${fixture}: not both sides are JSON scenario fixtures (new or deleted file)`);
            continue;
        }
        const beforeSet = new Set(before);
        const afterSet = new Set(after);
        const gained = after.filter(name => !beforeSet.has(name));
        const lost = before.filter(name => !afterSet.has(name));
        added += gained.length;
        removed += lost.length;
        const detail = [
            gained.length > 0 ? `+${gained.length} (${gained.slice(0, 4).join(', ')}${gained.length > 4 ? ', ...' : ''})` : '',
            lost.length > 0 ? `-${lost.length} (${lost.slice(0, 4).join(', ')}${lost.length > 4 ? ', ...' : ''})` : '',
        ].filter(Boolean).join(' ');
        say(`  ${fixture}: ${before.length} -> ${after.length}${detail === '' ? ' (same set: values changed)' : ` ${detail}`}`);
    }
    say(`scenario delta total: +${added} -${removed} across ${fixtures.length} fixture(s)`);
}

function main() {
    const options = parseArguments(process.argv.slice(2));
    const head = headCommit();
    say(`HEAD: ${head}`);
    say(`working tree: ${git(['status', '--porcelain']).trim() === '' ? 'clean' : 'DIRTY (the patch is applied to whatever is here; commit or stash first if that is not what you want)'}`);

    let patchPath = options.patchPath;
    let temporaryDirectory = null;
    let run = null;
    if (patchPath) {
        if (!existsSync(patchPath)) refuse(`--patch ${patchPath} does not exist`);
        say(`patch: ${patchPath} (given)`);
    } else {
        run = findRun(options, head);
        say(`run: ${run.databaseId} ${run.status}/${run.conclusion} ${run.url}`);
        if (run.headSha !== head) {
            refuse(`run ${run.databaseId} is for ${String(run.headSha).slice(0, 8)}, not HEAD ${head.slice(0, 8)};`
                + ' a patch recorded against another commit is exactly the hazard this refuses to paper over');
        }
        const downloaded = downloadPatch(options, run);
        patchPath = downloaded.patchPath;
        temporaryDirectory = downloaded.directory;
        say(`patch: ${ARTIFACT}/${PATCH_NAME} from run ${run.databaseId}`);
    }

    try {
        const patch = readPatch(patchPath);
        if (patch.touched.length === 0) {
            say('the patch is EMPTY: this commit is already recorded on Linux, so there is nothing to apply.');
            return 0;
        }
        say(`touched paths (${patch.touched.length}):`);
        for (const entry of patch.touched) say(`  ${entry}`);
        assertOnlyFixtures(patch.touched, options.allowNonOracle);
        const mode = checkApplies(patchPath);
        say(`git apply --check: the patch applies cleanly (${mode})`);
        if (options.dryRun) {
            say('dry run: not applying (remove --dry-run to apply)');
            return 0;
        }
        applyPatch(patchPath, mode, patch.touched);
        say('applied.');
        reportScenarioDelta(patch.touched);
        say('');
        say('next steps (this script does not do them):');
        say('  git status --porcelain            # the fixtures that moved');
        say('  git add tests/oracle             # only what you reviewed');
        say('  git commit -m "..."              # record the measurement, not just the change');
        say('  git push                          # the next run must be GREEN, or the re-record disagreed with GoTavern');
        return 0;
    } finally {
        if (temporaryDirectory !== null) rmSync(temporaryDirectory, { recursive: true, force: true });
    }
}

try {
    process.exitCode = main();
} catch (error) {
    if (error instanceof Refusal) {
        process.stderr.write(`\nREFUSED: ${error.message}\n`);
        process.exitCode = 1;
    } else {
        process.stderr.write(`\nUNEXPECTED: ${error?.stack ?? error}\n`);
        process.exitCode = 1;
    }
}
