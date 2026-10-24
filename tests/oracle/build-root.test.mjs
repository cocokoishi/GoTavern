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
