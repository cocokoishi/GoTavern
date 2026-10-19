#!/usr/bin/env node
// Probe pinned settings.init() backup, duplicate, retention, and error behavior.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PINNED_COMMIT = '06bde939fb1e9c4c8d8641d810f0a916b5bce127';
const PINNED_VERSION = '1.19.0';
const FIXED_NOW = 1_735_689_600_000;

if (process.argv[2] === '--child') {
    const sourceRoot = path.resolve(process.argv[3]);
    const runtimeRoot = path.resolve(process.argv[4]);
    const input = JSON.parse(readFileSync(path.join(runtimeRoot, 'scenario.json'), 'utf8'));
    process.env.FORCE_COLOR = '0';
    process.env.NO_COLOR = '1';
    const dataRoot = path.join(runtimeRoot, 'data');
    writeFileSync(path.join(runtimeRoot, 'config.yaml'), `${JSON.stringify({ backups: { common: { numberOfBackups: input.maxBackups } } })}\n`);
    const { setConfigFilePath } = await import(pathToFileURL(path.join(sourceRoot, 'src', 'util.js')).href);
    setConfigFilePath(path.join(runtimeRoot, 'config.yaml'));
    globalThis.DATA_ROOT = dataRoot;
    const { initUserStorage } = await import(pathToFileURL(path.join(sourceRoot, 'src', 'users.js')).href);
    await initUserStorage(dataRoot);

    const userRoot = path.join(dataRoot, 'default-user');
    const backupsDirectory = path.join(userRoot, 'backups');
    if (input.rootExists) {
        mkdirSync(userRoot, { recursive: true });
        if (input.backupsDirectoryExists !== false) mkdirSync(backupsDirectory, { recursive: true });
        if (input.settings !== undefined && input.settings !== null) writeFileSync(path.join(userRoot, 'settings.json'), input.settings);
        for (const [index, backup] of (input.backups ?? []).entries()) {
            const target = path.join(backupsDirectory, backup.name);
            writeFileSync(target, backup.contents);
            const fixedTime = new Date(backup.mtime);
            utimesSync(target, fixedTime, fixedTime);
            if (input.changeTimeGapMs && index < input.backups.length - 1) {
                await new Promise(resolve => setTimeout(resolve, input.changeTimeGapMs));
            }
        }
    }

    const NativeDate = Date;
    globalThis.Date = class FixedDate extends NativeDate {
        constructor(...args) {
            if (args.length === 0) super(FIXED_NOW);
            else super(...args);
        }

        static now() {
            return FIXED_NOW;
        }
    };

    const { init } = await import(pathToFileURL(path.join(sourceRoot, 'src', 'endpoints', 'settings.js')).href);
    async function invoke() {
        let errorCount = 0;
        const originalError = console.error;
        console.error = () => errorCount++;
        try {
            await init();
        } finally {
            console.error = originalError;
        }
        return { errorCount, state: snapshot() };
    }

    function snapshot() {
        let rootExists = false;
        try {
            rootExists = statSync(userRoot).isDirectory();
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
        let settings = null;
        try {
            settings = readFileSync(path.join(userRoot, 'settings.json'), 'utf8');
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
        let backupsDirectoryExists = false;
        let backups = [];
        try {
            backupsDirectoryExists = statSync(backupsDirectory).isDirectory();
            backups = readdirSync(backupsDirectory).sort().map(name => ({
                name: name.replace(/settings_default-user_\d{8}-\d{6}\.json/gu, 'settings_default-user_<timestamp>.json'),
                contents: readFileSync(path.join(backupsDirectory, name), 'utf8'),
            }));
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
        return { rootExists, settings, backupsDirectoryExists, backups };
    }

    const first = await invoke();
    const second = await invoke();
    console.log(JSON.stringify({ input, first, second }));
    process.exit(0);
}

const sourceRoot = path.resolve(process.argv[2] ?? '');
const repositoryRoot = path.resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3]) {
    console.error('usage: node tools/probe-settings-backup.mjs <pinned-source-clone> <gotavern-root>');
    process.exit(2);
}

const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'gotavern-settings-backup-oracle-'));

function safeCleanup() {
    const resolved = path.resolve(tempRoot);
    const parent = path.resolve(os.tmpdir());
    if (path.dirname(resolved).toLowerCase() !== parent.toLowerCase()
        || !path.basename(resolved).startsWith('gotavern-settings-backup-oracle-')) {
        throw new Error(`refusing to remove unexpected settings-backup probe path: ${resolved}`);
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
        rootMissing: runScenario('root-missing', { rootExists: false, maxBackups: 2 }),
        settingsMissing: runScenario('settings-missing', { rootExists: true, backupsDirectoryExists: true, maxBackups: 2 }),
        newBackup: runScenario('new-backup', { rootExists: true, settings: '{"name":"current","unknown":7}', backups: [], maxBackups: 2 }),
        duplicate: runScenario('duplicate', {
            rootExists: true,
            settings: '{"name":"same"}',
            backups: [{ name: 'settings_default-user_20000101-000000.json', contents: '{"name":"same"}', mtime: 1_000 }],
            maxBackups: 2,
        }),
        latestByChangeTime: runScenario('latest-by-change-time', {
            rootExists: true,
            settings: '{"name":"same"}',
            backups: [
                { name: 'settings_default-user_20000101-000000.json', contents: '{"name":"older change time"}', mtime: 3_000 },
                { name: 'settings_default-user_20000102-000000.json', contents: '{"name":"same"}', mtime: 1_000 },
            ],
            changeTimeGapMs: 25,
            maxBackups: 3,
        }),
        changed: runScenario('changed', {
            rootExists: true,
            settings: '{"name":"new"}',
            backups: [{ name: 'settings_default-user_20000101-000000.json', contents: '{"name":"old"}', mtime: 1_000 }],
            maxBackups: 2,
        }),
        pruneOldest: runScenario('prune-oldest', {
            rootExists: true,
            settings: '{"name":"new"}',
            backups: [
                { name: 'settings_default-user_20000101-000000.json', contents: 'oldest', mtime: 1_000 },
                { name: 'settings_default-user_20000102-000000.json', contents: 'newer', mtime: 2_000 },
            ],
            maxBackups: 2,
        }),
        backupsMissing: runScenario('backups-missing', {
            rootExists: true,
            backupsDirectoryExists: false,
            settings: '{"name":"current"}',
            maxBackups: 2,
        }),
    };
    assert.equal(scenarios.newBackup.first.state.backups.length, 1);
    assert.equal(scenarios.newBackup.second.state.backups.length, 1);
    assert.equal(scenarios.duplicate.first.state.backups.length, 1);
    assert.equal(scenarios.latestByChangeTime.first.state.backups.length, 2);
    assert.equal(scenarios.pruneOldest.first.state.backups.length, 2);
    assert.equal(scenarios.backupsMissing.first.errorCount, 1);

    const fixture = {
        schemaVersion: 1,
        baseline: { version: PINNED_VERSION, commit: PINNED_COMMIT },
        probe: 'pinned settings.init() backup, duplicate, retention, and error behavior',
        scenarios,
    };
    const outputDirectory = path.join(repositoryRoot, 'tests', 'oracle');
    mkdirSync(outputDirectory, { recursive: true });
    const outputFile = path.join(outputDirectory, 'sillytavern-1.19.0-settings-backup.json');
    writeFileSync(outputFile, `${JSON.stringify(fixture, null, 2)}\n`);
    console.log(`Wrote ${path.relative(repositoryRoot, outputFile)} from pinned settings.init()`);
} finally {
    safeCleanup();
}
