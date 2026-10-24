#!/usr/bin/env node
// Probe pinned migratePublicOverrides() source, destination, and permission effects.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { checkDedicatedBuildRoot } from './lib/dedicated-build-root.mjs';

const PINNED_COMMIT = '06bde939fb1e9c4c8d8641d810f0a916b5bce127';
const PINNED_VERSION = '1.19.0';
// @gotavern-oracle: this declaration is read by tools/build-generated-lib.mjs,
// which auto-discovers probes so that adding one needs no edit there.
// @gotavern-oracle: fixture=sillytavern-1.19.0-public-overrides-migration.json label="public-overrides migration"
const SOURCE_PATHS = [
    'public/error/forbidden-by-whitelist.html',
    'public/error/host-not-allowed.html',
    'public/error/unauthorized.html',
    'public/error/url-not-found.html',
    'public/css/user.css',
];

// THE GUARD IS ABOUT WHO ELSE USES THIS DIRECTORY, NOT WHO CREATED IT.
//
// This probe MUTATES the pinned checkout -- it writes public/error/* and public/css/user.css so the pinned
// migratePublicOverrides() can move them away -- so it must refuse any directory that is not a disposable
// build root. It used to require the exact mkdtemp shape (our own temporary prefix, and the basename
// `source`), which is a statement about the CREATOR: when the oracle gained a persistent, reuse-validated
// build root (GOTAVERN_ORACLE_BUILD_ROOT), a directory that is isolated in every sense that matters was
// rejected and the full sweep failed loudly for the wrong reason.
//
// The property asserted now is the one that protects the pinned tree: the directory IS the pinned checkout
// and is NOT the repository, NOT the read-only reference checkout, and neither an ancestor nor a descendant
// of either. The predicate is shared with the harness's wipe guard (tools/lib/dedicated-build-root.mjs),
// so "dedicated" cannot mean two different things in the two places that act on it.
//
// What proves the directory holds a SillyTavern checkout rather than a user-data tree or an empty folder.
// The pinned COMMIT is the harness's business (it validates the clone and the build-root lock); this probe
// proves the tree it is about to modify is the checkout it imports from.
const CHECKOUT_MARKERS = ['package.json', 'src/users.js', 'src/util.js'];

function assertDedicatedSourceRoot(sourceRoot, guardRepositoryRoot) {
    if (!guardRepositoryRoot) {
        throw new Error('refusing to modify public overrides: the guard needs the repository root to prove this directory is not inside it');
    }
    const decision = checkDedicatedBuildRoot({
        dir: sourceRoot,
        // The reference checkout cannot be discovered from this probe's argv, so the two locations the
        // project uses are named: `.reference/SillyTavern` in CI (ci.yml) and `../SillyTavern` on a
        // development host (HANDOFF section 0). A third location would have to be added here.
        forbiddenPaths: [
            guardRepositoryRoot,
            path.join(guardRepositoryRoot, '.reference', 'SillyTavern'),
            path.resolve(path.dirname(guardRepositoryRoot), 'SillyTavern'),
        ],
        missingMarkers: CHECKOUT_MARKERS.filter(relative => !existsSync(path.join(sourceRoot, relative))),
    });
    if (!decision.ok) {
        throw new Error(`refusing to modify public overrides outside a dedicated build root (${decision.reason}: ${decision.detail})`);
    }
}

if (process.argv[2] === '--child') {
    const sourceRoot = path.resolve(process.argv[3]);
    assertDedicatedSourceRoot(sourceRoot, process.argv[5] ? path.resolve(process.argv[5]) : '');
    const runtimeRoot = path.resolve(process.argv[4]);
    const configPath = path.join(runtimeRoot, 'config.yaml');
    globalThis.DATA_ROOT = path.join(runtimeRoot, 'data');
    const { setConfigFilePath } = await import(pathToFileURL(path.join(sourceRoot, 'src', 'util.js')).href);
    setConfigFilePath(configPath);
    const { migratePublicOverrides } = await import(pathToFileURL(path.join(sourceRoot, 'src', 'users.js')).href);

    const errors = [];
    const originalLog = console.log;
    const originalError = console.error;
    console.log = () => {};
    console.error = (...items) => errors.push(items.map(String).join(' '));
    try {
        await migratePublicOverrides();
    } finally {
        console.log = originalLog;
        console.error = originalError;
    }

    function snapshotTree() {
        const output = [];
        const roots = [
            { base: sourceRoot, relative: 'public/error' },
            { base: sourceRoot, relative: 'public/css/user.css' },
            { base: runtimeRoot, relative: 'data/_errors' },
            { base: runtimeRoot, relative: 'data/_css' },
        ];
        function visit(absolute, relative) {
            const info = statSync(absolute);
            if (info.isDirectory()) {
                output.push({ path: relative, type: 'directory' });
                for (const entry of readdirSync(absolute).sort()) {
                    visit(path.join(absolute, entry), `${relative}/${entry}`);
                }
                return;
            }
            const body = readFileSync(absolute);
            output.push({
                path: relative,
                type: 'file',
                bytes: body.byteLength,
                sha256: createHash('sha256').update(body).digest('hex'),
                ownerWritable: (info.mode & 0o200) !== 0,
            });
        }
        for (const root of roots) {
            const absolute = path.join(root.base, root.relative);
            try {
                statSync(absolute);
            } catch (error) {
                if (error.code === 'ENOENT') continue;
                throw error;
            }
            visit(absolute, root.relative);
        }
        return output.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
    }

    console.log(JSON.stringify({ errors, tree: snapshotTree() }));
    process.exit(0);
}

const sourceRoot = path.resolve(process.argv[2] ?? '');
const repositoryRoot = path.resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3]) {
    console.error('usage: node tools/probe-public-overrides-migration.mjs <pinned-source-clone> <gotavern-root>');
    process.exit(2);
}

assertDedicatedSourceRoot(sourceRoot, repositoryRoot);

// THE SOURCE OVERRIDES ARE RESET, NOT ASSUMED.
//
// This probe writes public/error/* and public/css/user.css into the SHARED build root and the pinned
// migration MOVES them away, so its starting state is part of its own input. It used to ASSERT that
// state ("pinned source unexpectedly contains ...") and leave the cleanup to whichever probe ran
// earlier, which made the recording depend on the probe pool rather than on the pinned code: on
// 2026-10-22 the oracle job failed with "oracle changed across identical pinned Node runs at
// $.scenarios.mixed.tree.length" after new probes changed the pool, and the diff was the source
// overrides surviving from a previous invocation.
//
// A probe that consumes state another probe produced is not an oracle for this code; it is an oracle
// for the schedule. So the state is now ESTABLISHED here -- deterministically, before any scenario runs
// and between the two runs the harness compares -- and the same reset runs in the finally blocks.
function resetSourceOverrides() {
    for (const relative of SOURCE_PATHS) {
        const target = path.join(sourceRoot, relative);
        if (existsSync(target)) chmodSync(target, 0o600);
        rmSync(target, { force: true });
    }
    rmSync(path.join(sourceRoot, 'public', 'error'), { recursive: true, force: true });
}

resetSourceOverrides();
for (const relative of SOURCE_PATHS) {
    assert.equal(existsSync(path.join(sourceRoot, relative)), false, `source reset did not remove ${relative}`);
}
assert.equal(existsSync(path.join(sourceRoot, 'public', 'error')), false, 'source reset did not remove public/error');

const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'gotavern-public-overrides-oracle-'));

function safeCleanup() {
    removeSourceOverrides();
    rmSync(path.join(sourceRoot, 'public', 'error'), { recursive: true, force: true });
    const resolved = path.resolve(tempRoot);
    const parent = path.resolve(os.tmpdir());
    if (path.dirname(resolved).toLowerCase() !== parent.toLowerCase()
        || !path.basename(resolved).startsWith('gotavern-public-overrides-oracle-')) {
        throw new Error(`refusing to remove unexpected public-overrides probe path: ${resolved}`);
    }
    rmSync(resolved, { recursive: true, force: true });
}

function removeSourceOverrides() {
    for (const relative of SOURCE_PATHS) {
        const target = path.join(sourceRoot, relative);
        if (existsSync(target)) chmodSync(target, 0o600);
        rmSync(target, { force: true });
    }
}

function mixedSources() {
    return {
        'public/error/forbidden-by-whitelist.html': '<html>pinned override probe: forbidden</html>',
        'public/error/host-not-allowed.html': '<html>pinned override probe: host</html>',
        'public/error/unauthorized.html': '<html>legacy unauthorized</html>',
        'public/error/url-not-found.html': '<html>legacy 404</html>',
        'public/css/user.css': 'body { --legacy-user-css: true; }',
    };
}

function mixedDestinations() {
    return {
        'data/_errors/unauthorized.html': '<html>existing user override</html>',
    };
}

function runScenario(name, sources, destinations, readOnlySources = [], readOnlyDestinations = []) {
    const runtimeRoot = path.join(tempRoot, name);
    const dataRoot = path.join(runtimeRoot, 'data');
    mkdirSync(dataRoot, { recursive: true });
    writeFileSync(path.join(runtimeRoot, 'config.yaml'), '{}\n');
    for (const [relative, body] of Object.entries(destinations)) {
        const target = path.join(runtimeRoot, relative);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, body);
    }
    for (const relative of readOnlyDestinations) chmodSync(path.join(runtimeRoot, relative), 0o444);

    try {
        // Same reset before the scenario's own sources: the previous scenario's leftovers must not be
        // part of this one's input (see the comment at the top-level reset).
        resetSourceOverrides();
        for (const [relative, body] of Object.entries(sources)) {
            const target = path.join(sourceRoot, relative);
            mkdirSync(path.dirname(target), { recursive: true });
            writeFileSync(target, body);
        }
        for (const relative of readOnlySources) chmodSync(path.join(sourceRoot, relative), 0o444);
        const output = execFileSync(process.execPath, [
            fileURLToPath(import.meta.url), '--child', sourceRoot, runtimeRoot, repositoryRoot,
        ], { cwd: sourceRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        const observation = JSON.parse(output.trim().split(/\r?\n/u).at(-1));
        assert.deepEqual(observation.errors, [], `${name}: pinned migration reported errors`);
        return { inputs: { sources, destinations, readOnlySources, readOnlyDestinations }, tree: observation.tree };
    } finally {
        removeSourceOverrides();
        rmSync(path.join(sourceRoot, 'public', 'error'), { recursive: true, force: true });
    }
}

try {
    const scenarios = {
        noOverrides: runScenario('no-overrides', {}, {}),
        mixed: runScenario(
            'mixed',
            mixedSources(),
            mixedDestinations(),
            ['public/error/forbidden-by-whitelist.html'],
            ['data/_errors/unauthorized.html'],
        ),
    };
    const fixture = {
        schemaVersion: 1,
        baseline: { version: PINNED_VERSION, commit: PINNED_COMMIT },
        probe: 'pinned users.js migratePublicOverrides filesystem behavior',
        scenarios,
    };
    const outputDirectory = path.join(repositoryRoot, 'tests', 'oracle');
    mkdirSync(outputDirectory, { recursive: true });
    const outputFile = path.join(outputDirectory, 'sillytavern-1.19.0-public-overrides-migration.json');
    writeFileSync(outputFile, `${JSON.stringify(fixture, null, 2)}\n`);
    console.log(`Wrote ${path.relative(repositoryRoot, outputFile)} from pinned migratePublicOverrides()`);
} finally {
    safeCleanup();
}
