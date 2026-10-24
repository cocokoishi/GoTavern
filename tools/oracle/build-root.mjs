// WHETHER A PERSISTENT, REUSABLE ORACLE BUILD ROOT IS THE RIGHT TREE TO BUILD IN.
//
// WHY THIS EXISTS. Every oracle run pays the same fixed cost before it records anything: mkdtemp,
// `git clone --shared`, `git checkout` of the pinned commit, `npm ci` over SillyTavern's dependency
// tree, then a pruned webpack build. None of that depends on WHICH probes the run is recording, and
// the oracle is this project's expensive job, so it was a repeated compile paid on every push.
// GOTAVERN_ORACLE_BUILD_ROOT=<dir> names a directory to keep between runs.
//
// THE RULE IS REUSE-OR-REBUILD, NEVER REPAIR. A directory that fails ANY check is deleted and rebuilt
// from scratch, because a half-built tree (a clone without node_modules, an npm ci that died midway)
// is worse than no tree at all: it builds a lib.js that is *nearly* right. There is no partial reuse
// and no fix-up path.
//
// WHAT REUSE DELIBERATELY DOES NOT COVER, stated here so nobody assumes the opposite: the webpack
// OUTPUT and its FILESYSTEM CACHE are never reused. The runner removes every untracked file except
// node_modules before building, so the bundler starts from the same empty `dist/_webpack` that a
// fresh clone gives it. That matters because pinned webpack.config.js is called with
// `{forceDist: true, pruneCache: true}`: forceDist roots the build at `<cwd>/dist/_webpack`, and
// pruneCache deletes only cache directories that do NOT match the current cache version -- so a
// reused root would otherwise hand webpack its own previous cache and output. What this module buys
// is the clone and the dependency install; what gets built is still built cold.
//
// This module is PURE by construction (no fs, no child_process) so the decision can be tested against
// every way a directory can be wrong without creating a build root at all. The runner performs the
// I/O and reports the decision line.

import path from 'node:path';
import process from 'node:process';

export const BUILD_ROOT_ENV = 'GOTAVERN_ORACLE_BUILD_ROOT';
export const BUILD_LOCK_FILE = '.gotavern-oracle-build-lock.json';
export const BUILD_LOCK_VERSION = 1;

// Which build root this run uses. UNSET KEEPS TODAY'S BEHAVIOUR EXACTLY: a temporary root under the
// OS temp directory, deleted at the end, so a developer's or a harness-only run cannot be affected by
// a directory left behind by an earlier run.
export function resolveBuildRootMode({ envValue } = {}) {
    const raw = typeof envValue === 'string' ? envValue.trim() : '';
    if (raw === '') {
        return {
            mode: 'temp',
            why: `${BUILD_ROOT_ENV} is unset, so a temporary build root is created and deleted after the run`,
        };
    }
    return { mode: 'persistent', dir: raw, why: `${BUILD_ROOT_ENV}=${raw}` };
}

// The identity of a build root, written into it after a SUCCESSFUL build and compared before any
// reuse. The commit alone is not enough: the dependency graph and the Node used to install it both
// change what is built.
export function buildLockRecord({ commit, lockHash, nodeVersion }) {
    return { version: BUILD_LOCK_VERSION, commit, lockHash, nodeVersion };
}

// A lock file is untrusted input: a truncated write from a killed job is exactly the case this has to
// survive, so anything unparseable, incomplete or from another lock format yields null (= no lock).
export function parseBuildLock(text) {
    if (typeof text !== 'string' || text.trim() === '') return null;
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch {
        return null;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    if (parsed.version !== BUILD_LOCK_VERSION) return null;
    if (typeof parsed.commit !== 'string' || typeof parsed.lockHash !== 'string') return null;
    if (typeof parsed.nodeVersion !== 'string') return null;
    return parsed;
}

// Reuse only if the directory is PROVABLY the tree the lock describes. Every field is required: an
// unknown value is never treated as a match, and the returned `reason` is a stable machine-readable
// code so a test can pin the exact failure rather than a message.
//
//   headSha              `git rev-parse HEAD` in the directory, or null when it is not a git checkout
//   worktreeClean        `git status --porcelain --untracked-files=no` is empty (tracked files intact)
//   nodeModulesPresent   `node_modules/` exists
//   lock                 parseBuildLock(...) of the lock file, or null
//   expected             { commit, lockHash, nodeVersion } of THIS run's pinned reference
export function buildRootReuseDecision({ headSha, worktreeClean, nodeModulesPresent, lock, expected } = {}) {
    if (!expected || typeof expected.commit !== 'string') {
        throw new TypeError('buildRootReuseDecision needs expected: { commit, lockHash, nodeVersion }');
    }
    if (typeof headSha !== 'string' || headSha === '') {
        return { reuse: false, reason: 'not-a-git-tree', detail: 'the directory is not a git checkout, so it cannot be the pinned tree' };
    }
    if (headSha !== expected.commit) {
        return { reuse: false, reason: 'commit-mismatch', detail: `the checkout is ${headSha.slice(0, 12)}, not the pinned ${expected.commit.slice(0, 12)}` };
    }
    if (!nodeModulesPresent) {
        return { reuse: false, reason: 'node-modules-missing', detail: 'node_modules/ is absent, so the dependency install never finished' };
    }
    if (!lock) {
        return { reuse: false, reason: 'lock-missing-or-unreadable', detail: `no readable ${BUILD_LOCK_FILE}, so this root was never verified complete` };
    }
    if (lock.commit !== expected.commit) {
        return { reuse: false, reason: 'lock-commit-mismatch', detail: `the root was built for ${String(lock.commit).slice(0, 12)}, not the pinned ${expected.commit.slice(0, 12)}` };
    }
    if (lock.lockHash !== expected.lockHash) {
        return { reuse: false, reason: 'lock-hash-mismatch', detail: `the dependency graph moved: built with package-lock ${String(lock.lockHash).slice(0, 12)}, this run has ${String(expected.lockHash).slice(0, 12)}` };
    }
    if (lock.nodeVersion !== expected.nodeVersion) {
        return { reuse: false, reason: 'lock-node-mismatch', detail: `the root was built by node ${lock.nodeVersion}, this run is node ${expected.nodeVersion}` };
    }
    if (worktreeClean !== true) {
        return { reuse: false, reason: 'worktree-dirty', detail: 'tracked files in the root were modified after it was built' };
    }
    return { reuse: true, reason: 'reuse', detail: `pinned ${expected.commit.slice(0, 7)}..., lock ${expected.lockHash.slice(0, 12)}` };
}

// ONE LINE, printed once, so a reviewer can tell whether the persistence actually worked instead of
// assuming it: "build root: reuse <dir> (pinned ..., lock ...)" or "build root: rebuild <dir> (why)".
export function formatBuildRootDecision({ dir, decision }) {
    const action = decision && decision.reuse ? 'reuse' : 'rebuild';
    const detail = decision && decision.detail ? decision.detail : 'no decision was made';
    return `build root: ${action} ${dir} (${detail})`;
}

export function formatTempBuildRoot({ dir }) {
    return `build root: temp ${dir} (${BUILD_ROOT_ENV} is unset, so this root is created fresh and deleted after the run)`;
}

// THE WIPE IS DESTRUCTIVE, SO IT REFUSES THE PATHS WHOSE LOSS WOULD BE CATASTROPHIC. Rebuilding means
// `rm -rf <dir>`, and the value comes from an environment variable: `GOTAVERN_ORACLE_BUILD_ROOT=.`
// must be an error, not a deleted repository. Refused: the protected paths themselves, anything inside
// them, any of their ANCESTORS (which would delete them), and a filesystem root.
export function isSafeBuildRoot({ dir, protectedPaths = [] } = {}) {
    if (typeof dir !== 'string' || dir.trim() === '') return false;
    const normalise = value => {
        const resolved = path.resolve(value);
        return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    };
    const target = normalise(dir);
    if (target === path.parse(target).root) return false;
    for (const candidate of protectedPaths) {
        if (typeof candidate !== 'string' || candidate === '') continue;
        const guarded = normalise(candidate);
        if (target === guarded) return false;
        if (target.startsWith(guarded + path.sep)) return false;
        if (guarded.startsWith(target + path.sep)) return false;
    }
    return true;
}
