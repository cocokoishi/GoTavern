// WHICH DIRECTORIES A PROBE MAY MUTATE, expressed once and shared.
//
// WHY THIS EXISTS. probe-public-overrides-migration.mjs WRITES INTO the pinned checkout -- that is its
// subject, because pinned migratePublicOverrides() MOVES files out of public/ -- so before touching
// anything it guards the directory it was handed. That guard encoded "isolated" as "created by mkdtemp
// with our own prefix", which is a statement about WHO CREATED the directory, not about whether anyone
// else uses it. When the oracle gained a persistent build root (GOTAVERN_ORACLE_BUILD_ROOT, reused
// between runs and validated by its own lock file), the guard rejected a directory that is isolated in
// every sense that matters, and the full sweep failed loudly for the wrong reason.
//
// The property that actually protects the pinned tree is:
//
//   this directory is a dedicated build root -- not the repository, not the read-only reference
//   checkout, neither an ancestor nor a descendant of either, and it IS the pinned checkout (a user-data
//   directory, a shared tree or an arbitrary folder cannot satisfy the checkout markers).
//
// "Not created by mkdtemp" is deliberately NOT part of it: the temporary root and the persistent root are
// equally disposable, and the persistent one is additionally wiped when it cannot prove it is the right
// tree. The caller supplies the fresh mkdtemp root or the persistent root and gets the same answer.
//
// PURE by construction (no fs, no child_process), so every row is testable without a build root: the
// caller reports which markers it FOUND MISSING, because existence is I/O and this module does none.

import path from 'node:path';
import process from 'node:process';

const normalise = value => {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};

// How `target` sits relative to `other`: the same path, inside it, containing it, or neither.
// Directory boundaries are compared with a separator so that `gotavern-cache` is not treated as being
// inside `gotavern` (a substring test would say it was, and would refuse a legitimate sibling).
export function describePathRelation(target, other) {
    const left = normalise(target);
    const right = normalise(other);
    if (left === right) return 'same';
    if (left.startsWith(right + path.sep)) return 'inside';
    if (right.startsWith(left + path.sep)) return 'contains';
    return 'disjoint';
}

const RELATION_WORDING = {
    same: 'IS that path',
    inside: 'is inside that path',
    contains: 'contains that path',
};

// Decides whether `dir` is a dedicated build root.
//
//   forbiddenPaths   paths nobody may mutate: the repository, the reference checkout, a shared user tree,
//                    this run's own temporary root. `dir` must be the same as, inside, or containing
//                    NONE of them -- containment in either direction is refused, because an ancestor
//                    wipe destroys the protected tree and a descendant write lands inside it.
//   missingMarkers   checkout markers the CALLER looked for and did not find. Empty means the directory
//                    holds the pinned checkout; a non-empty list means it is something else (a user data
//                    directory, an empty folder, a tree that was never cloned).
//
// Returns a stable machine-readable `reason` so a test can pin the exact failure instead of a sentence.
export function checkDedicatedBuildRoot({ dir, forbiddenPaths = [], missingMarkers = [] } = {}) {
    if (typeof dir !== 'string' || dir.trim() === '') {
        return { ok: false, reason: 'empty-path', detail: 'no directory was named' };
    }
    if (normalise(dir) === path.parse(normalise(dir)).root) {
        return { ok: false, reason: 'filesystem-root', detail: `${dir} is a filesystem root` };
    }
    for (const forbidden of forbiddenPaths) {
        if (typeof forbidden !== 'string' || forbidden.trim() === '') continue;
        const relation = describePathRelation(dir, forbidden);
        if (relation !== 'disjoint') {
            return {
                ok: false,
                reason: 'not-dedicated',
                detail: `${dir} ${RELATION_WORDING[relation]}: ${forbidden}`,
            };
        }
    }
    if (missingMarkers.length > 0) {
        return {
            ok: false,
            reason: 'not-a-checkout',
            detail: `${dir} does not contain the pinned checkout (missing ${missingMarkers.join(', ')})`,
        };
    }
    return { ok: true, reason: 'dedicated', detail: `${dir} is a dedicated build root` };
}
