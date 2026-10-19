#!/usr/bin/env node
// Probe pinned migrateAccessLog() move/precedence/error behavior.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PINNED_COMMIT = '06bde939fb1e9c4c8d8641d810f0a916b5bce127';
const PINNED_VERSION = '1.19.0';

if (process.argv[2] === '--child') {
    const sourceRoot = path.resolve(process.argv[3]);
    const runtimeRoot = path.resolve(process.argv[4]);
    const input = JSON.parse(readFileSync(path.join(runtimeRoot, 'scenario.json'), 'utf8'));
    process.env.FORCE_COLOR = '0';
    process.env.NO_COLOR = '1';
    process.chdir(runtimeRoot);
    const dataRoot = input.sameRoot ? runtimeRoot : path.join(runtimeRoot, 'data');
    if (input.sameRoot) mkdirSync(dataRoot, { recursive: true });
    else if (input.dataRootKind === 'file') writeFileSync(dataRoot, input.dataRootContents);
    else mkdirSync(dataRoot, { recursive: true });
    if (input.sourceKind === 'directory') {
        mkdirSync(path.join(runtimeRoot, 'access.log'), { recursive: true });
        writeFileSync(path.join(runtimeRoot, 'access.log', 'legacy-entry.txt'), 'nested legacy log entry');
    } else if (input.sourceContents !== undefined) {
        writeFileSync(path.join(runtimeRoot, 'access.log'), input.sourceContents);
    }
    if (input.destinationContents !== undefined) {
        mkdirSync(dataRoot, { recursive: true });
        writeFileSync(path.join(dataRoot, 'access.log'), input.destinationContents);
    }

    writeFileSync(path.join(runtimeRoot, 'config.yaml'), '{}\n');
    const { setConfigFilePath } = await import(pathToFileURL(path.join(sourceRoot, 'src', 'util.js')).href);
    setConfigFilePath(path.join(runtimeRoot, 'config.yaml'));
    globalThis.DATA_ROOT = dataRoot;
    const { migrateAccessLog, getAccessLogPath } = await import(pathToFileURL(path.join(sourceRoot, 'src', 'middleware', 'accessLogWriter.js')).href);

    const normalize = value => String(value).replaceAll(dataRoot, '<data-root>').replaceAll(path.sep, '/');
    function invoke() {
        const events = { logs: [], errorCount: 0, infos: [] };
        const originalLog = console.log;
        const originalError = console.error;
        const originalInfo = console.info;
        console.log = (...args) => events.logs.push(args.map(normalize).join(' '));
        console.error = () => events.errorCount++;
        console.info = (...args) => events.infos.push(args.map(normalize).join(' '));
        try {
            migrateAccessLog();
        } finally {
            console.log = originalLog;
            console.error = originalError;
            console.info = originalInfo;
        }
        return events;
    }

    function snapshotPath(target) {
        let info;
        try {
            info = lstatSync(target);
        } catch (error) {
            if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return { exists: false, type: '', contents: null, entries: [] };
            throw error;
        }
        if (info.isDirectory()) {
            const entries = [];
            function visit(directory, prefix = '') {
                for (const name of readdirSync(directory).sort()) {
                    const absolute = path.join(directory, name);
                    const relative = prefix ? `${prefix}/${name}` : name;
                    const entryInfo = lstatSync(absolute);
                    if (entryInfo.isDirectory()) {
                        entries.push({ path: relative, type: 'directory', contents: null });
                        visit(absolute, relative);
                    } else {
                        entries.push({ path: relative, type: 'file', contents: readFileSync(absolute, 'utf8') });
                    }
                }
            }
            visit(target);
            return { exists: true, type: 'directory', contents: null, entries };
        }
        return { exists: true, type: 'file', contents: readFileSync(target, 'utf8'), entries: [] };
    }

    function snapshotDataRoot() {
        const snapshot = snapshotPath(dataRoot);
        if (snapshot.type === 'directory') {
            snapshot.entries = snapshot.entries.filter(entry => entry.path === 'access.log' || entry.path.startsWith('access.log/'));
        }
        return snapshot;
    }

    const sourcePath = path.join(runtimeRoot, 'access.log');
    const destinationPath = getAccessLogPath();
    const firstEvents = invoke();
    const first = {
        ...firstEvents,
        destinationPath: normalize(destinationPath),
        filesystem: {
            dataRoot: snapshotDataRoot(),
            source: snapshotPath(sourcePath),
            destination: snapshotPath(destinationPath),
        },
    };
    const secondEvents = invoke();
    const second = {
        ...secondEvents,
        destinationPath: normalize(destinationPath),
        filesystem: {
            dataRoot: snapshotDataRoot(),
            source: snapshotPath(sourcePath),
            destination: snapshotPath(destinationPath),
        },
    };
    console.log(JSON.stringify({ input, first, second }));
    process.exit(0);
}

const sourceRoot = path.resolve(process.argv[2] ?? '');
const repositoryRoot = path.resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3]) {
    console.error('usage: node tools/probe-access-log-migration.mjs <pinned-source-clone> <gotavern-root>');
    process.exit(2);
}

const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'gotavern-access-log-oracle-'));

function safeCleanup() {
    const resolved = path.resolve(tempRoot);
    const parent = path.resolve(os.tmpdir());
    if (path.dirname(resolved).toLowerCase() !== parent.toLowerCase()
        || !path.basename(resolved).startsWith('gotavern-access-log-oracle-')) {
        throw new Error(`refusing to remove unexpected access-log probe path: ${resolved}`);
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
        absent: runScenario('absent', {}),
        legacyOnly: runScenario('legacy-only', { sourceContents: 'legacy access data\n' }),
        destinationOnly: runScenario('destination-only', { destinationContents: 'current access data\n' }),
        destinationPrecedence: runScenario('destination-precedence', { sourceContents: 'legacy data\n', destinationContents: 'current data\n' }),
        sameRoot: runScenario('same-root', { sameRoot: true, sourceContents: 'single access data\n' }),
        directorySource: runScenario('directory-source', { sourceKind: 'directory' }),
        invalidDataRoot: runScenario('invalid-data-root', { dataRootKind: 'file', dataRootContents: 'not a directory', sourceContents: 'legacy access data\n' }),
    };
    assert.equal(scenarios.legacyOnly.first.logs.length, 1);
    assert.equal(scenarios.legacyOnly.second.logs.length, 0);
    assert.equal(scenarios.destinationPrecedence.first.logs.length, 0);
    assert.equal(scenarios.invalidDataRoot.first.errorCount, 1);
    assert.equal(scenarios.invalidDataRoot.first.infos.length, 1);

    const fixture = {
        schemaVersion: 1,
        baseline: { version: PINNED_VERSION, commit: PINNED_COMMIT },
        probe: 'pinned migrateAccessLog() source/destination precedence and error behavior',
        scenarios,
    };
    const outputDirectory = path.join(repositoryRoot, 'tests', 'oracle');
    mkdirSync(outputDirectory, { recursive: true });
    const outputFile = path.join(outputDirectory, 'sillytavern-1.19.0-access-log-migration.json');
    writeFileSync(outputFile, `${JSON.stringify(fixture, null, 2)}\n`);
    console.log(`Wrote ${path.relative(repositoryRoot, outputFile)} from pinned migrateAccessLog()`);
} finally {
    safeCleanup();
}
