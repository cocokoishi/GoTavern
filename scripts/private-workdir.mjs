// BUILD THE ISOLATED WORK DIRECTORY THE PRIVATE CHANNEL RUNS IN, AND NOTHING ELSE.
//
// WHY THIS IS A PROGRAM AND NOT A PARAGRAPH. docs/development-loop.md §4 authorises executing the user's real
// originals in an isolated copy and forbids every transmission of them. The paragraph cannot enforce either
// half; this script is the part that can. It does three things and refuses to do a fourth:
//
//   1. READS a local-only manifest of aliases -> absolute original paths. The manifest lives OUTSIDE the
//      repository and is never committed; the alias is what every report refers to.
//   2. COPIES each original into a fresh work directory that is outside the repository, outside every git
//      worktree, and outside any cloud-sync folder, and records each file's sha256 BEFORE and AFTER the copy
//      so "the copy is a copy" is measured rather than assumed.
//   3. ASSERTS the copy is not the original: different resolved paths, no symlink along the way, no hard link
//      (a hard link is not a copy -- writing through it writes the original), and the original's mtime and
//      size unchanged across the whole operation.
//
// WHAT IT REFUSES, because each refusal is a hazard this project has recorded:
//   * a work directory inside the repository or inside any git worktree (`git worktree list` is consulted, not
//     guessed), because a file in a worktree is a file one `git add -A` away from being published;
//   * a work directory inside a OneDrive/Dropbox/iCloud path, because a sync client is a remote;
//   * a symlink at any component of the path, because a symlink copy can write back through it;
//   * a hard-linked file (st_nlink > 1) or a file whose inode equals the original's, because the isolation
//     claim would be false;
//   * a source file that is not readable, or a manifest entry that points at a directory.
//
// WHAT IT DOES NOT DO, stated so nobody reads more into a run than happened: it does not execute anything, it
// does not boot a server, it does not netjail a process, and it cannot prove egress did not happen. Those are
// separate steps, and `scripts/private-egress-check.mjs` is the one that can prove the network side.
//
// Usage:
//   node scripts/private-workdir.mjs --manifest <local-manifest.json> [--root <dir>] [--report <file>]
//
// The manifest shape (LOCAL ONLY, outside the repository):
//   { "aliases": [
//       { "alias": "PRIVATE_CARD_A", "path": "C:/Users/.../card.png", "kind": "card" },
//       { "alias": "PRIVATE_PRESET_A", "path": "C:/Users/.../preset.json", "kind": "preset" } ] }
//
// Exit: 0 when the work directory is built and every isolation assertion held; 1 with the reason named
// otherwise. A refusal is a RESULT, not a failure to produce one.

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

function argument(name, fallback = null) {
    const index = process.argv.indexOf(name);
    return index === -1 ? fallback : process.argv[index + 1];
}

// THE SYNC CLIENT LIST IS DELIBERATELY SHORT AND NAMED. A longer list would imply the check is exhaustive;
// it is not, which is why the report records that the check ran and what it looked for.
const SYNC_MARKERS = ['onedrive', 'dropbox', 'icloud', 'googledrive', 'google drive', 'box sync', 'sync'];

function sha256(buffer) {
    return createHash('sha256').update(buffer).digest('hex');
}

/** Every path a file lives under, resolved, with any symlink component named. */
async function realpathChain(target) {
    const found = [];
    let current = path.resolve(target);
    for (;;) {
        try {
            const stats = await fs.lstat(current);
            if (stats.isSymbolicLink()) found.push(current);
        } catch {
            // A component that does not exist yet is not a symlink; the parent chain still matters.
        }
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
    }
    return found;
}

/** The set of git worktrees, asked rather than assumed. */
function worktrees() {
    try {
        const listing = execFileSync('git', ['-C', repoRoot, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' });
        return listing.split(/\r?\n/).filter(line => line.startsWith('worktree ')).map(line => path.resolve(line.slice('worktree '.length)));
    } catch (error) {
        // FAIL CLOSED: if the worktree list cannot be read, the isolation claim cannot be made.
        throw new Error(`cannot list git worktrees from ${repoRoot}, so isolation cannot be asserted: ${error?.message ?? error}`);
    }
}

/** Refuse a work root that could put an original on a remote or inside a published tree. */
function refuseUnsafeRoot(root, trees) {
    const resolved = path.resolve(root);
    const problems = [];
    for (const tree of trees) {
        if (resolved === tree || resolved.startsWith(tree + path.sep)) {
            problems.push(`${resolved} is inside the git worktree ${tree}; a file there is one 'git add -A' from being published`);
        }
    }
    const lowered = resolved.toLowerCase();
    for (const marker of SYNC_MARKERS) {
        if (lowered.includes(marker)) problems.push(`${resolved} names a sync or cloud location ('${marker}'), which is a remote`);
    }
    if (resolved === path.parse(resolved).root) problems.push(`${resolved} is a filesystem root`);
    return problems;
}

async function main() {
    const manifestPath = argument('--manifest');
    if (!manifestPath) {
        console.error('usage: private-workdir.mjs --manifest <local-manifest.json> [--root <dir>] [--report <file>]');
        process.exit(2);
    }
    const reportPath = argument('--report', null);
    const report = {
        step: 'private-workdir',
        what: 'build the isolated copy of the user originals that the private qualification channel runs in',
        whatItDoesNotProve: [
            'that any probe executed: this program copies and asserts isolation only',
            'that no egress happened: scripts/private-egress-check.mjs proves the network side',
            'that the harness will behave: a copied input is not a passing scenario',
        ],
        aliases: [],
        assertions: {},
        problems: [],
        built: false,
    };

    // THE MANIFEST IS LOCAL-ONLY. Reading it is the one place an absolute path is unavoidable, and the report
    // records that it was read, not what it contained.
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    if (!Array.isArray(manifest?.aliases) || manifest.aliases.length === 0) {
        throw new Error(`${manifestPath} declares no aliases, so there is nothing to isolate`);
    }
    // THE MANIFEST MUST NOT LIVE IN THE REPOSITORY, or the paths would travel with a commit.
    const trees = worktrees();
    const manifestInsideTree = trees.find(tree => path.resolve(manifestPath).startsWith(tree + path.sep));
    // A CANARY RUN IS NOT A PRIVATE RUN, AND THE REPORT MUST SAY SO. Exercising these instruments against files
    // that happen to be in this repository is how the refusal logic earns a red and a green without an original;
    // it is recorded rather than refused, because refusing would mean the instruments could never be tested at
    // all, and pretending such a run demonstrated the channel would be the failure this program exists to stop.
    report.manifestInsideRepository = Boolean(manifestInsideTree);
    report.runKind = manifestInsideTree ? 'HARNESS_CANARY' : 'PRIVATE_QUALIFICATION';

    const root = path.resolve(argument('--root', path.join(os.tmpdir(), `gotavern-private-${Date.now()}`)));
    const rootProblems = refuseUnsafeRoot(root, trees);
    if (rootProblems.length > 0) {
        report.problems.push(...rootProblems);
        await finish(report, reportPath);
        return;
    }
    const rootSymlinks = await realpathChain(root);
    if (rootSymlinks.length > 0) {
        report.problems.push(`the work root has a symlink on its path (${rootSymlinks.join(', ')}), so a copy could write back through it`);
        await finish(report, reportPath);
        return;
    }
    await fs.mkdir(root, { recursive: true });
    report.workRootAlias = root.replace(/[\\/][^\\/]+$/, path.sep + '<private-work-root>');

    for (const entry of manifest.aliases) {
        const alias = String(entry?.alias ?? '');
        if (!/^PRIVATE_[A-Z0-9_]+$/.test(alias)) {
            report.problems.push(`alias ${JSON.stringify(alias)} is not of the form PRIVATE_NAME; a report must never carry a real name`);
            continue;
        }
        // A RELATIVE PATH IN THE MANIFEST IS RELATIVE TO THE MANIFEST, NOT TO THE PROCESS CWD. Measured in the
        // canary run: the process started in the worktree while the manifest sat in `tests/private/`, so
        // `../../tests/...` resolved one directory too high and both aliases were refused with ENOENT. The
        // manifest is the document that owns the paths, so it is the base -- and the alternative (a caller
        // remembering to `cd`) is the same class of error that put a relative write in the wrong tree twice
        // today (AGENTS working mode).
        const declared = String(entry?.path ?? '');
        const source = path.resolve(path.dirname(path.resolve(manifestPath)), declared);
        const record = { alias, kind: entry?.kind ?? 'unknown' };
        try {
            const sourceStats = await fs.stat(source);
            if (!sourceStats.isFile()) {
                report.problems.push(`${alias}: the manifest entry is not a regular file`);
                continue;
            }
            // CARRIED, NOT RE-DERIVED: the post-check must stat the file this loop actually read.
            record.sourcePath = source;
            record.bytes = sourceStats.size;
            record.sha256 = sha256(await fs.readFile(source));
            record.mtimeMs = sourceStats.mtimeMs;

            const target = path.join(root, alias + path.extname(source));
            await fs.copyFile(source, target, fs.constants.COPYFILE_EXCL);

            const targetStats = await fs.stat(target);
            const targetHash = sha256(await fs.readFile(target));
            // ISOLATION IS MEASURED, NOT CLAIMED: a different resolved path, a different inode, one link each,
            // and identical bytes.
            const sourceIno = await fs.stat(source, { bigint: true });
            const targetIno = await fs.stat(target, { bigint: true });
            record.copySha256 = targetHash;
            record.samePath = path.resolve(target) === path.resolve(source);
            record.sameInode = sourceIno.ino === targetIno.ino;
            record.sourceLinks = Number(sourceIno.nlink);
            record.bytesEqual = targetStats.size === sourceStats.size && targetHash === record.sha256;
            if (record.samePath) report.problems.push(`${alias}: the copy path equals the original path`);
            if (record.sameInode) report.problems.push(`${alias}: the copy shares an inode with the original (a hard link is not a copy)`);
            if (record.sourceLinks > 1) report.problems.push(`${alias}: the original has ${record.sourceLinks} hard links, so writing to the copy could reach it`);
            if (!record.bytesEqual) report.problems.push(`${alias}: the copy differs from the original`);
            record.stagedAt = `<work-root>/${path.basename(target)}`;
        } catch (error) {
            report.problems.push(`${alias}: ${String(error?.message ?? error).slice(0, 200)}`);
        }
        report.aliases.push(record);
    }

    // SOURCE IMMUTABILITY, AS A POST-CHECK. A copy that modified its source is the failure the whole channel
    // exists to prevent, and the measurement is cheap only if it is taken before anything else runs.
    //
    // THE PATH IS THE ONE THE COPY USED, CARRIED ON THE RECORD. Re-resolving `entry.path` here resolved it
    // against the PROCESS CWD instead of the manifest's directory -- the same bug the copy loop had, surviving
    // in the one place a fix did not reach -- and the canary run failed with ENOENT from a path that had never
    // been used. A second resolution of a path is a second chance to resolve it differently.
    for (const record of report.aliases) {
        if (record.sha256 === undefined || !record.sourcePath) continue;
        const after = await fs.stat(record.sourcePath);
        const afterHash = sha256(await fs.readFile(record.sourcePath));
        record.sourceUnchanged = afterHash === record.sha256 && after.mtimeMs === record.mtimeMs && after.size === record.bytes;
        if (!record.sourceUnchanged) report.problems.push(`${record.alias}: THE ORIGINAL CHANGED during the copy`);
    }

    // EGRESS IS NOT THIS PROGRAM'S CLAIM. Recorded so the report cannot be read as one.
    report.buildMomentEgressAttempted = false;
    report.assertions = {
        workRootOutsideEveryWorktree: refuseUnsafeRoot(root, trees).length === 0,
        noSymlinkOnWorkRootPath: rootSymlinks.length === 0,
        everyAliasCopiedWithEqualBytes: report.aliases.length === manifest.aliases.length && report.aliases.every(record => record.bytesEqual === true),
        everyOriginalUnchanged: report.aliases.every(record => record.sourceUnchanged === true),
        noAliasSharesAnInodeWithItsOriginal: report.aliases.every(record => record.sameInode === false),
    };
    report.built = report.problems.length === 0 && Object.values(report.assertions).every(Boolean);
    await finish(report, reportPath);
}

async function finish(report, reportPath) {
    report.verdict = report.built ? 'PASS' : 'REFUSED';
    const text = `${JSON.stringify(report, null, 2)}\n`;
    if (reportPath) await fs.writeFile(reportPath, text);
    process.stdout.write(text);
    process.exit(report.built ? 0 : 1);
}

main().catch(error => {
    // A REFUSAL MUST NAME ITSELF. A bare stack trace from an isolation program is unreadable and invites the
    // reader to treat it as an infrastructure problem rather than as the refusal it is.
    process.stdout.write(`${JSON.stringify({ step: 'private-workdir', verdict: 'REFUSED', error: String(error?.message ?? error) }, null, 2)}\n`);
    process.exit(1);
});
