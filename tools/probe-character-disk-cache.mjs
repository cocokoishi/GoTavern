#!/usr/bin/env node
// Probe pinned DiskCache.verify() startup cache creation and pruning behavior.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PINNED_COMMIT = '06bde939fb1e9c4c8d8641d810f0a916b5bce127';
const PINNED_VERSION = '1.19.0';
// @gotavern-oracle: this declaration is read by tools/build-generated-lib.mjs,
// which auto-discovers probes so that adding one needs no edit there.
// @gotavern-oracle: fixture=sillytavern-1.19.0-character-disk-cache.json label="character disk-cache"

if (process.argv[2] === '--child') {
    const sourceRoot = path.resolve(process.argv[3]);
    const runtimeRoot = path.resolve(process.argv[4]);
    const input = JSON.parse(readFileSync(path.join(runtimeRoot, 'scenario.json'), 'utf8'));
    delete process.env.SILLYTAVERN_PERFORMANCE_USEDISKCACHE;
    process.env.FORCE_COLOR = '0';
    process.env.NO_COLOR = '1';

    const dataRoot = path.join(runtimeRoot, 'data');
    const characterDirectory = path.join(dataRoot, 'default-user', 'characters');
    mkdirSync(characterDirectory, { recursive: true });
    for (const [relative, body] of Object.entries(input.characterFiles)) {
        const target = path.join(characterDirectory, relative);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, body);
        const fixedTime = new Date(1700000000000);
        utimesSync(target, fixedTime, fixedTime);
    }

    writeFileSync(path.join(runtimeRoot, 'config.yaml'), `${JSON.stringify({ performance: { useDiskCache: input.useDiskCache } })}\n`);
    const { setConfigFilePath } = await import(pathToFileURL(path.join(sourceRoot, 'src', 'util.js')).href);
    setConfigFilePath(path.join(runtimeRoot, 'config.yaml'));
    globalThis.DATA_ROOT = dataRoot;
    const { diskCache } = await import(pathToFileURL(path.join(sourceRoot, 'src', 'endpoints', 'characters.js')).href);

    let cache;
    const originalKeys = {};
    if (input.useDiskCache && input.seeds.length > 0) {
        cache = await diskCache.instance();
        for (const seed of input.seeds) {
            let key;
            if (seed.kind === 'validPng' || seed.kind === 'nonPng') {
                const characterPath = path.join(characterDirectory, seed.file);
                key = `${characterPath}-${statSync(characterPath).mtimeMs}`;
            } else if (seed.kind === 'shadowOfStale') {
                const staleKey = 'missing-character-stale-1700000000000';
                key = createHash('sha256').update(staleKey).digest('hex');
            } else {
                key = `missing-character-${seed.name}-1700000000000`;
            }
            originalKeys[seed.name] = key;
            await cache.setItem(key, { marker: seed.name });
        }
    }

    const errors = [];
    const originalError = console.error;
    console.error = (...items) => errors.push(items.map(item => String(item?.message ?? item)).join(' '));
    try {
        await diskCache.verify([{ characters: characterDirectory }]);
    } finally {
        console.error = originalError;
        diskCache.dispose();
    }

    const cacheDirectory = path.join(dataRoot, '_cache', 'characters');
    let records = [];
    try {
        const names = readdirSync(cacheDirectory);
        records = names.map(filename => {
            const record = JSON.parse(readFileSync(path.join(cacheDirectory, filename), 'utf8'));
            const name = Object.entries(originalKeys).find(([, key]) => key === record.key)?.[0] ?? 'other';
            return { name, value: record.value };
        }).sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
    const values = {};
    if (cache) {
        for (const [name, key] of Object.entries(originalKeys)) values[name] = (await cache.getItem(key)) ?? null;
    }
    console.log(JSON.stringify({
        errors,
        cacheDirectoryExists: records.length > 0 || (() => { try { statSync(cacheDirectory); return true; } catch { return false; } })(),
        records,
        values,
    }));
    process.exit(0);
}

const sourceRoot = path.resolve(process.argv[2] ?? '');
const repositoryRoot = path.resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3]) {
    console.error('usage: node tools/probe-character-disk-cache.mjs <pinned-source-clone> <gotavern-root>');
    process.exit(2);
}

const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'gotavern-character-cache-oracle-'));

function safeCleanup() {
    const resolved = path.resolve(tempRoot);
    const parent = path.resolve(os.tmpdir());
    if (path.dirname(resolved).toLowerCase() !== parent.toLowerCase()
        || !path.basename(resolved).startsWith('gotavern-character-cache-oracle-')) {
        throw new Error(`refusing to remove unexpected character-cache probe path: ${resolved}`);
    }
    rmSync(resolved, { recursive: true, force: true });
}

function runScenario(name, input) {
    const runtimeRoot = path.join(tempRoot, name);
    mkdirSync(runtimeRoot, { recursive: true });
    writeFileSync(path.join(runtimeRoot, 'scenario.json'), `${JSON.stringify(input, null, 2)}\n`);
    const output = execFileSync(process.execPath, [
        fileURLToPath(import.meta.url),
        '--child', sourceRoot, runtimeRoot,
    ], { cwd: sourceRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return JSON.parse(output.trim().split(/\r?\n/u).at(-1));
}

try {
    const scenarios = {
        disabled: runScenario('disabled', { useDiskCache: false, characterFiles: {}, seeds: [] }),
        empty: runScenario('empty', { useDiskCache: true, characterFiles: {}, seeds: [] }),
        prune: runScenario('prune', {
            useDiskCache: true,
            characterFiles: {
                'valid.png': 'png card bytes',
                'ignored.jpg': 'jpeg bytes',
                'upper.PNG': 'uppercase extension bytes',
                'nested/ignored.png': 'nested card bytes',
            },
            seeds: [
                { name: 'valid', kind: 'validPng', file: 'valid.png' },
                { name: 'jpg', kind: 'nonPng', file: 'ignored.jpg' },
                { name: 'stale', kind: 'missing' },
                { name: 'shadow', kind: 'shadowOfStale' },
            ],
        }),
    };
    assert.deepEqual(scenarios.disabled.errors, []);
    assert.deepEqual(scenarios.empty.errors, []);
    assert.deepEqual(scenarios.prune.errors, []);
    const fixture = {
        schemaVersion: 1,
        baseline: { version: PINNED_VERSION, commit: PINNED_COMMIT },
        probe: 'pinned characters.js DiskCache.verify node-persist behavior',
        scenarios,
    };
    const outputDirectory = path.join(repositoryRoot, 'tests', 'oracle');
    mkdirSync(outputDirectory, { recursive: true });
    const outputFile = path.join(outputDirectory, 'sillytavern-1.19.0-character-disk-cache.json');
    writeFileSync(outputFile, `${JSON.stringify(fixture, null, 2)}\n`);
    console.log(`Wrote ${path.relative(repositoryRoot, outputFile)} from pinned DiskCache.verify()`);
} finally {
    safeCleanup();
}
