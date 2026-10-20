#!/usr/bin/env node
// Probe the pinned pre-listen cleanUploads() behavior and filesystem effects.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PINNED_COMMIT = '06bde939fb1e9c4c8d8641d810f0a916b5bce127';
const PINNED_VERSION = '1.19.0';
// @gotavern-oracle: this declaration is read by tools/build-generated-lib.mjs,
// which auto-discovers probes so that adding one needs no edit there.
// @gotavern-oracle: fixture=sillytavern-1.19.0-upload-cleanup.json label="upload-cleanup"

if (process.argv[2] === '--child') {
    const sourceRoot = path.resolve(process.argv[3]);
    const runtimeRoot = path.resolve(process.argv[4]);
    const input = JSON.parse(readFileSync(path.join(runtimeRoot, 'scenario.json'), 'utf8'));
    process.env.FORCE_COLOR = '0';
    process.env.NO_COLOR = '1';
    const dataRoot = path.join(runtimeRoot, 'data');
    mkdirSync(dataRoot, { recursive: true });
    const uploadsPath = path.join(dataRoot, '_uploads');
    if (input.setup === 'empty' || input.setup === 'files' || input.setup === 'childDirectory') {
        mkdirSync(uploadsPath, { recursive: true });
    }
    if (input.setup === 'files') {
        for (const [name, contents] of Object.entries(input.files)) writeFileSync(path.join(uploadsPath, name), contents);
    }
    if (input.setup === 'childDirectory') {
        mkdirSync(path.join(uploadsPath, 'pending'), { recursive: true });
        writeFileSync(path.join(uploadsPath, 'pending', 'keep.tmp'), 'inside nested directory');
    }
    if (input.setup === 'pathFile') writeFileSync(uploadsPath, input.contents);

    writeFileSync(path.join(runtimeRoot, 'config.yaml'), '{}\n');
    const { setConfigFilePath } = await import(pathToFileURL(path.join(sourceRoot, 'src', 'util.js')).href);
    setConfigFilePath(path.join(runtimeRoot, 'config.yaml'));
    globalThis.DATA_ROOT = dataRoot;
    const { cleanUploads } = await import(pathToFileURL(path.join(sourceRoot, 'src', 'users.js')).href);

    function invoke() {
        const debug = [];
        const originalDebug = console.debug;
        const originalError = console.error;
        let errorCount = 0;
        console.debug = (...args) => debug.push(args.map(String).join(' '));
        console.error = () => errorCount++;
        try {
            cleanUploads();
        } finally {
            console.debug = originalDebug;
            console.error = originalError;
        }
        return { debug, errorCount };
    }

    function snapshot() {
        try {
            const info = statSync(uploadsPath);
            if (!info.isDirectory()) return { exists: true, isDirectory: false, contents: readFileSync(uploadsPath, 'utf8'), entries: [] };
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
            return { exists: false, isDirectory: false, contents: null, entries: [] };
        }
        const entries = [];
        function visit(directory, prefix = '') {
            for (const name of readdirSync(directory).sort()) {
                const absolute = path.join(directory, name);
                const relative = prefix ? `${prefix}/${name}` : name;
                const info = lstatSync(absolute);
                if (info.isDirectory()) {
                    entries.push({ path: relative, type: 'directory', contents: null });
                    visit(absolute, relative);
                } else {
                    entries.push({ path: relative, type: 'file', contents: readFileSync(absolute, 'utf8') });
                }
            }
        }
        visit(uploadsPath);
        return { exists: true, isDirectory: true, contents: null, entries };
    }

    const firstEvents = invoke();
    const first = { ...firstEvents, state: snapshot() };
    const secondEvents = invoke();
    const second = { ...secondEvents, state: snapshot() };
    console.log(JSON.stringify({ input, first, second }));
    process.exit(0);
}

const sourceRoot = path.resolve(process.argv[2] ?? '');
const repositoryRoot = path.resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3]) {
    console.error('usage: node tools/probe-upload-cleanup.mjs <pinned-source-clone> <gotavern-root>');
    process.exit(2);
}

const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'gotavern-upload-cleanup-oracle-'));

function safeCleanup() {
    const resolved = path.resolve(tempRoot);
    const parent = path.resolve(os.tmpdir());
    if (path.dirname(resolved).toLowerCase() !== parent.toLowerCase()
        || !path.basename(resolved).startsWith('gotavern-upload-cleanup-oracle-')) {
        throw new Error(`refusing to remove unexpected upload-cleanup probe path: ${resolved}`);
    }
    rmSync(resolved, { recursive: true, force: true });
}

function runScenario(name, input) {
    const runtimeRoot = path.join(tempRoot, name);
    mkdirSync(runtimeRoot, { recursive: true });
    writeFileSync(path.join(runtimeRoot, 'scenario.json'), `${JSON.stringify(input, null, 2)}\n`);
    const output = execFileSync(process.execPath, [
        fileURLToPath(import.meta.url), '--child', sourceRoot, runtimeRoot,
    ], { cwd: sourceRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return JSON.parse(output.trim().split(/\r?\n/u).at(-1));
}

try {
    const scenarios = {
        absent: runScenario('absent', { setup: 'absent' }),
        empty: runScenario('empty', { setup: 'empty' }),
        files: runScenario('files', { setup: 'files', files: { 'one.tmp': 'first upload', 'two.bin': 'second upload' } }),
        childDirectory: runScenario('child-directory', { setup: 'childDirectory' }),
        pathIsFile: runScenario('path-is-file', { setup: 'pathFile', contents: 'not an uploads directory' }),
    };
    assert.deepEqual(scenarios.absent.first.debug, []);
    assert.deepEqual(scenarios.files.first.debug, ['Cleaning uploads folder (2 files)']);
    assert.deepEqual(scenarios.files.second.debug, []);
    assert.equal(scenarios.childDirectory.first.errorCount, 1);
    assert.equal(scenarios.pathIsFile.first.errorCount, 1);

    const fixture = {
        schemaVersion: 1,
        baseline: { version: PINNED_VERSION, commit: PINNED_COMMIT },
        probe: 'pinned cleanUploads() listing, deletion, and caught-error behavior',
        scenarios,
    };
    const outputDirectory = path.join(repositoryRoot, 'tests', 'oracle');
    mkdirSync(outputDirectory, { recursive: true });
    const outputFile = path.join(outputDirectory, 'sillytavern-1.19.0-upload-cleanup.json');
    writeFileSync(outputFile, `${JSON.stringify(fixture, null, 2)}\n`);
    console.log(`Wrote ${path.relative(repositoryRoot, outputFile)} from pinned cleanUploads()`);
} finally {
    safeCleanup();
}
