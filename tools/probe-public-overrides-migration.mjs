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

const PINNED_COMMIT = '06bde939fb1e9c4c8d8641d810f0a916b5bce127';
const PINNED_VERSION = '1.19.0';
const SOURCE_PATHS = [
    'public/error/forbidden-by-whitelist.html',
    'public/error/host-not-allowed.html',
    'public/error/unauthorized.html',
    'public/error/url-not-found.html',
    'public/css/user.css',
];

function assertTemporarySourceRoot(sourceRoot) {
    const temporaryBuildRoot = path.dirname(sourceRoot);
    if (path.dirname(temporaryBuildRoot).toLowerCase() !== path.resolve(os.tmpdir()).toLowerCase()
        || !path.basename(temporaryBuildRoot).startsWith('gotavern-upstream-webpack-')
        || path.basename(sourceRoot) !== 'source') {
        throw new Error('refusing to modify public overrides outside the isolated temporary upstream clone');
    }
}

if (process.argv[2] === '--child') {
    const sourceRoot = path.resolve(process.argv[3]);
    assertTemporarySourceRoot(sourceRoot);
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

assertTemporarySourceRoot(sourceRoot);

for (const relative of SOURCE_PATHS) {
    assert.equal(existsSync(path.join(sourceRoot, relative)), false, `pinned source unexpectedly contains ${relative}`);
}
assert.equal(existsSync(path.join(sourceRoot, 'public', 'error')), false, 'pinned source unexpectedly contains public/error');

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
        for (const [relative, body] of Object.entries(sources)) {
            const target = path.join(sourceRoot, relative);
            mkdirSync(path.dirname(target), { recursive: true });
            writeFileSync(target, body);
        }
        for (const relative of readOnlySources) chmodSync(path.join(sourceRoot, relative), 0o444);
        const output = execFileSync(process.execPath, [
            fileURLToPath(import.meta.url), '--child', sourceRoot, runtimeRoot,
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
