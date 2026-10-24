// THE REUSABLE BUILD ROOT, proved by pure-function tests: every case below is a way the directory on
// disk can be wrong, expressed without creating a build root, cloning anything, or running npm.
//
// The contract is deliberately total: REUSE only when the tree is provably the one the lock describes
// (right commit, dependencies installed, same package-lock, same node, no modified tracked files),
// and REBUILD otherwise -- never repair. A half-built tree is worse than no tree, because it builds a
// lib.js that is nearly right and no fixture would name the difference.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
    BUILD_ROOT_ENV,
    BUILD_LOCK_FILE,
    buildLockRecord,
    buildRootReuseDecision,
    formatBuildRootDecision,
    formatTempBuildRoot,
    isSafeBuildRoot,
    parseBuildLock,
    resolveBuildRootMode,
} from '../../tools/oracle/build-root.mjs';
import { checkDedicatedBuildRoot, describePathRelation } from '../../tools/lib/dedicated-build-root.mjs';

const COMMIT = '06bde939fb1e9c4c8d8641d810f0a916b5bce127';
const LOCK_HASH = '9f'.repeat(32);
const NODE = 'v24.19.0';
const EXPECTED = { commit: COMMIT, lockHash: LOCK_HASH, nodeVersion: NODE };
const GOOD_LOCK = buildLockRecord({ commit: COMMIT, lockHash: LOCK_HASH, nodeVersion: NODE });

function decision(overrides = {}) {
    return buildRootReuseDecision({
        headSha: COMMIT,
        worktreeClean: true,
        nodeModulesPresent: true,
        lock: GOOD_LOCK,
        expected: EXPECTED,
        ...overrides,
    });
}

// ---------------------------------------------------------------------------------------------
// Mode: no env var keeps today's behaviour exactly
// ---------------------------------------------------------------------------------------------

test('mode: with no environment variable the root is temporary, exactly as before this feature', () => {
    for (const envValue of [undefined, null, '', '   ']) {
        const mode = resolveBuildRootMode({ envValue });
        assert.equal(mode.mode, 'temp', `envValue=${JSON.stringify(envValue)} must not switch to a persistent root`);
        assert.match(mode.why, new RegExp(BUILD_ROOT_ENV));
        assert.match(mode.why, /temporary/);
    }
});

test('mode: the environment variable names a persistent root', () => {
    const mode = resolveBuildRootMode({ envValue: ' /srv/oracle-build\n' });
    assert.equal(mode.mode, 'persistent');
    assert.equal(mode.dir, '/srv/oracle-build', 'the value is trimmed but otherwise taken as given');
});

// ---------------------------------------------------------------------------------------------
// Reuse is all-or-nothing
// ---------------------------------------------------------------------------------------------

test('decision: reuse only when commit, node_modules, lock, package-lock, node and tracked files all agree', () => {
    const result = decision();
    assert.equal(result.reuse, true, `expected reuse, got: ${JSON.stringify(result)}`);
    assert.equal(result.reason, 'reuse');
    assert.match(result.detail, /pinned 06bde93\.\.\./);
    assert.match(result.detail, new RegExp(`lock ${LOCK_HASH.slice(0, 12)}`));
});

test('decision: a different checkout commit rebuilds (the directory is not the pinned tree)', () => {
    const result = decision({ headSha: 'f'.repeat(40) });
    assert.equal(result.reuse, false);
    assert.equal(result.reason, 'commit-mismatch');
    assert.match(result.detail, /not the pinned/);
});

test('decision: a directory that is not a git checkout rebuilds', () => {
    for (const headSha of [null, undefined, '']) {
        const result = decision({ headSha });
        assert.equal(result.reuse, false, `headSha=${JSON.stringify(headSha)} must not be reused`);
        assert.equal(result.reason, 'not-a-git-tree');
    }
});

test('decision: a missing node_modules rebuilds (an install that never finished)', () => {
    const result = decision({ nodeModulesPresent: false });
    assert.equal(result.reuse, false);
    assert.equal(result.reason, 'node-modules-missing');
});

test('decision: a missing lock rebuilds (the root was never verified complete)', () => {
    const result = decision({ lock: null });
    assert.equal(result.reuse, false);
    assert.equal(result.reason, 'lock-missing-or-unreadable');
    assert.match(result.detail, new RegExp(BUILD_LOCK_FILE.replace('.', '\\.')));
});

test('decision: a different package-lock hash rebuilds (the dependency graph moved)', () => {
    const result = decision({ lock: { ...GOOD_LOCK, lockHash: '11'.repeat(32) } });
    assert.equal(result.reuse, false);
    assert.equal(result.reason, 'lock-hash-mismatch');
    assert.match(result.detail, /dependency graph moved/);
});

test('decision: a lock written for another commit rebuilds', () => {
    const result = decision({ lock: { ...GOOD_LOCK, commit: 'e'.repeat(40) } });
    assert.equal(result.reuse, false);
    assert.equal(result.reason, 'lock-commit-mismatch');
});

test('decision: a lock written by another node rebuilds (the install environment changed)', () => {
    const result = decision({ lock: { ...GOOD_LOCK, nodeVersion: 'v22.0.0' } });
    assert.equal(result.reuse, false);
    assert.equal(result.reason, 'lock-node-mismatch');
    assert.match(result.detail, /v22\.0\.0/);
});

test('decision: modified tracked files in the root rebuild', () => {
    const result = decision({ worktreeClean: false });
    assert.equal(result.reuse, false);
    assert.equal(result.reason, 'worktree-dirty');
});

test('decision: every individual fault on its own forces a rebuild (no field is optional)', () => {
    const faults = {
        'not-a-git-tree': { headSha: null },
        'commit-mismatch': { headSha: 'a'.repeat(40) },
        'node-modules-missing': { nodeModulesPresent: false },
        'lock-missing-or-unreadable': { lock: null },
        'lock-commit-mismatch': { lock: { ...GOOD_LOCK, commit: 'b'.repeat(40) } },
        'lock-hash-mismatch': { lock: { ...GOOD_LOCK, lockHash: 'c'.repeat(64) } },
        'lock-node-mismatch': { lock: { ...GOOD_LOCK, nodeVersion: 'v20.0.0' } },
        'worktree-dirty': { worktreeClean: false },
    };
    for (const [reason, overrides] of Object.entries(faults)) {
        const result = decision(overrides);
        assert.equal(result.reuse, false, `${reason} must not be reused`);
        assert.equal(result.reason, reason);
    }
});

test('decision: an unstated expectation is refused rather than guessed', () => {
    assert.throws(() => buildRootReuseDecision({ headSha: COMMIT }), /expected/);
});

// ---------------------------------------------------------------------------------------------
// The lock file is untrusted input
// ---------------------------------------------------------------------------------------------

test('lock: round-trips and carries the format version', () => {
    const text = JSON.stringify(GOOD_LOCK);
    assert.deepEqual(parseBuildLock(text), GOOD_LOCK);
    assert.equal(GOOD_LOCK.version, 1);
});

test('lock: corrupt, truncated, empty, foreign-shaped and old-version locks all read as "no lock"', () => {
    const cases = {
        'empty': '',
        'whitespace': '  \n',
        'truncated json': '{"version":1,"commit":"06bde93',
        'not an object': '[1,2,3]',
        'null': 'null',
        'missing lockHash': JSON.stringify({ version: 1, commit: COMMIT, nodeVersion: NODE }),
        'missing nodeVersion': JSON.stringify({ version: 1, commit: COMMIT, lockHash: LOCK_HASH }),
        'foreign version': JSON.stringify({ ...GOOD_LOCK, version: 2 }),
    };
    for (const [name, text] of Object.entries(cases)) {
        assert.equal(parseBuildLock(text), null, `${name} must not be accepted as a lock`);
    }
    assert.equal(parseBuildLock(undefined), null);
});

test('lock: a corrupt lock file leads to a rebuild, not a crash and not a reuse', () => {
    const lock = parseBuildLock('{"version":1,"commit":');
    const result = decision({ lock });
    assert.equal(result.reuse, false);
    assert.equal(result.reason, 'lock-missing-or-unreadable');
});

// ---------------------------------------------------------------------------------------------
// The printed decision
// ---------------------------------------------------------------------------------------------

test('format: one line names the branch taken and why', () => {
    const reused = formatBuildRootDecision({ dir: '/srv/build', decision: decision() });
    assert.equal(reused.split('\n').length, 1, 'the decision must be a single line');
    assert.match(reused, /^build root: reuse \/srv\/build \(pinned 06bde93\.\.\., lock 9f9f/);

    const rebuilt = formatBuildRootDecision({ dir: '/srv/build', decision: decision({ lock: null }) });
    assert.equal(rebuilt.split('\n').length, 1);
    assert.match(rebuilt, /^build root: rebuild \/srv\/build \(no readable \.gotavern-oracle-build-lock\.json/);
});

test('format: the temporary mode says so, so its absence cannot be mistaken for a failed cache', () => {
    const line = formatTempBuildRoot({ dir: '/tmp/x/source' });
    assert.equal(line.split('\n').length, 1);
    assert.match(line, /^build root: temp \/tmp\/x\/source \(/);
    assert.match(line, new RegExp(BUILD_ROOT_ENV));
});

// ---------------------------------------------------------------------------------------------
// The wipe is destructive, so the safe paths are checked
// ---------------------------------------------------------------------------------------------

test('safety: refuse to wipe the repository, the reference checkout, their ancestors, or a filesystem root', () => {
    const base = path.resolve(path.sep, 'lanes');
    const repositoryRoot = path.join(base, 'gotavern');
    const upstreamRoot = path.join(base, 'reference', 'SillyTavern');
    const guarded = { protectedPaths: [repositoryRoot, upstreamRoot] };

    assert.equal(isSafeBuildRoot({ dir: repositoryRoot, ...guarded }), false, 'the repository itself');
    assert.equal(isSafeBuildRoot({ dir: path.join(repositoryRoot, 'internal'), ...guarded }), false, 'inside the repository');
    assert.equal(isSafeBuildRoot({ dir: base, ...guarded }), false, 'an ancestor of the repository');
    assert.equal(isSafeBuildRoot({ dir: upstreamRoot, ...guarded }), false, 'the reference checkout');
    assert.equal(isSafeBuildRoot({ dir: path.parse(repositoryRoot).root, ...guarded }), false, 'a filesystem root');
    assert.equal(isSafeBuildRoot({ dir: '', ...guarded }), false, 'an empty path');

    assert.equal(isSafeBuildRoot({ dir: path.join(base, 'oracle-build'), ...guarded }), true, 'a sibling directory');
    assert.equal(isSafeBuildRoot({ dir: path.join(base, 'gotavern-build'), ...guarded }), true, 'a differently-named sibling');
    assert.equal(isSafeBuildRoot({ dir: path.join(base, 'gotavern-cache'), ...guarded }), true, 'a prefix-sharing sibling is not inside');
});

// ---------------------------------------------------------------------------------------------
// The PROBE-side guard: which directories a probe may WRITE INTO.
//
// This is the rows that matter for the regression this check exists to prevent. The full sweep failed
// because the guard encoded "created by mkdtemp with our prefix" and refused the persistent build root,
// which is isolated in every sense that matters. The guard must now answer the real question -- does
// anyone else use this directory -- for BOTH kinds of root, and refuse everything that is not disposable.
// ---------------------------------------------------------------------------------------------

// Deep enough that an "ancestor" is not the filesystem root, which has its own refusal clause and would
// otherwise make the ancestor row pass-or-fail for the wrong reason.
const BASE = path.resolve(path.sep, 'work', 'lanes');
const REPO = path.join(BASE, 'gotavern');
// The two locations the project puts the read-only reference checkout in (ci.yml and HANDOFF section 0).
const REFERENCES = [path.join(REPO, '.reference', 'SillyTavern'), path.join(BASE, 'SillyTavern')];

function guard(dir, { forbidden = [REPO, ...REFERENCES], missing = [] } = {}) {
    return checkDedicatedBuildRoot({ dir, forbiddenPaths: forbidden, missingMarkers: missing });
}

test('guard: a fresh mkdtemp source root is accepted (the behaviour that must not change)', () => {
    const dir = path.join(path.resolve(path.sep, 'tmp'), 'gotavern-upstream-webpack-ab12cd', 'source');
    const result = guard(dir);
    assert.equal(result.ok, true, JSON.stringify(result));
});

test('guard: the persistent build root is accepted even though it was NOT created by mkdtemp', () => {
    // The exact directory the sweep failed on: <runner.temp>/oracle-build -- no `source` basename, no
    // mkdtemp prefix, in fact nothing about it that the old check looked at. Its LOCATION is irrelevant;
    // what matters is that it is a checkout nobody else uses.
    for (const dir of [
        path.join(path.resolve(path.sep, 'tmp'), 'oracle-build'),
        path.join(BASE, 'oracle-build-persistent'),
    ]) {
        const result = guard(dir);
        assert.equal(result.ok, true, `${dir} must be accepted: ${JSON.stringify(result)}`);
    }
});

test('guard: the repository itself is refused', () => {
    const result = guard(REPO);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'not-dedicated');
    assert.match(result.detail, /IS that path/);
});

test('guard: a path inside the repository is refused', () => {
    const result = guard(path.join(REPO, 'public'));
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'not-dedicated');
    assert.match(result.detail, /is inside that path/);
});

test('guard: the read-only reference checkout is refused, in both documented locations', () => {
    for (const reference of REFERENCES) {
        const result = guard(reference);
        assert.equal(result.ok, false, `${reference} must be refused`);
        assert.equal(result.reason, 'not-dedicated');
    }
});

test('guard: an ancestor of the repository is refused', () => {
    const result = guard(path.dirname(path.dirname(REPO)));
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'not-dedicated');
});

test("guard: a root that EQUALS the repository's parent is refused", () => {
    const result = guard(path.dirname(REPO));
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'not-dedicated');
    assert.match(result.detail, /contains that path/, 'an ancestor must be named as such, not as "inside"');
});

test('guard: a directory without the pinned checkout is refused (a user tree is not a build root)', () => {
    const dir = path.join(BASE, 'oracle-build-but-not-a-checkout');
    const result = guard(dir, { missing: ['package.json', 'src/users.js'] });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'not-a-checkout');
    assert.match(result.detail, /package\.json/);
});

test('guard: a prefix-sharing sibling is not treated as being inside the repository', () => {
    assert.equal(describePathRelation(path.join(BASE, 'gotavern-cache'), REPO), 'disjoint');
    assert.equal(describePathRelation(path.join(BASE, 'gotavern-cache'), path.join(BASE, 'gotavern')), 'disjoint');
    assert.equal(describePathRelation(path.join(REPO, 'src'), REPO), 'inside');
    assert.equal(describePathRelation(BASE, REPO), 'contains');
    assert.equal(describePathRelation(REPO, REPO), 'same');
    assert.equal(guard(path.join(BASE, 'gotavern-cache')).ok, true);
});

test('wiring: the probe uses the SHARED guard and no longer encodes who created the directory', () => {
    // The defect was a private copy of an isolation test that drifted from the harness's own. This asserts
    // the two callers share one predicate, so they cannot disagree again.
    const probe = readFileSync(new URL('../../tools/probe-public-overrides-migration.mjs', import.meta.url), 'utf8');
    assert.match(probe, /from '\.\/lib\/dedicated-build-root\.mjs'/, 'the probe must import the shared predicate');
    assert.ok(probe.includes('checkDedicatedBuildRoot('), 'the probe must call the shared predicate');
    assert.doesNotMatch(probe, /assertTemporarySourceRoot/, 'the mkdtemp-shape guard must be gone');
    assert.doesNotMatch(probe, /gotavern-upstream-webpack-/, 'the probe must not encode the temporary root\'s name');
    assert.match(probe, /'\.reference', 'SillyTavern'/, 'the CI reference-checkout location must be refused by name');
});

// ---------------------------------------------------------------------------------------------
// Wiring: the decision must reach the build root, or the feature is decorative
// ---------------------------------------------------------------------------------------------

test('wiring: the runner consults the decision, prints it, guard the wipe and writes the lock', () => {
    // Source-shape assertion on purpose: this lane has already shipped one pure, correct function that
    // nothing called (`doubleRunFor`), and no behavioural test can see an orphan.
    const source = readFileSync(new URL('../../tools/build-generated-lib.mjs', import.meta.url), 'utf8');
    const lines = source.split('\n').map((text, index) => ({ text: text.trim(), line: index + 1 }));
    const calls = name => lines.filter(({ text }) => new RegExp(`\\b${name}\\s*\\(`).test(text) && !/^\s*import\b/.test(text));

    assert.equal(calls('resolveBuildRootMode').length, 1, 'the environment variable must be read exactly once');
    assert.equal(calls('buildRootReuseDecision').length, 1, 'the reuse decision must be taken exactly once');
    assert.equal(calls('formatBuildRootDecision').length, 1, 'the reuse/rebuild decision must be reported exactly once');
    assert.ok(calls('formatTempBuildRoot').length >= 1, 'the temporary mode must also say which branch it took');
    assert.ok(calls('isSafeBuildRoot').length >= 1, 'a destructive wipe must be guarded by the safety check');
    assert.ok(calls('parseBuildLock').length >= 1, 'the lock file must be parsed through the shared parser');
    assert.ok(calls('buildLockRecord').length >= 1, 'the lock record must be built by the shared function');
    assert.ok(
        lines.some(({ text }) => /writeFileSync\(/.test(text) && /BUILD_LOCK_FILE/.test(text)),
        'the lock file must be written when a persistent root finishes building',
    );
    assert.ok(
        lines.some(({ text }) => new RegExp(BUILD_ROOT_ENV).test(text)),
        `the runner must name ${BUILD_ROOT_ENV}`,
    );
});
