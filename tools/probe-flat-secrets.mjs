#!/usr/bin/env node
// Probe pinned migrateFlatSecrets() data, backup, and per-user error behavior.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PINNED_COMMIT = '06bde939fb1e9c4c8d8641d810f0a916b5bce127';
const PINNED_VERSION = '1.19.0';
const FIXED_TIME = 1_700_000_000_000;

if (process.argv[2] === '--read-go') {
    const sourceRoot = path.resolve(process.argv[3]);
    const userRoot = path.resolve(process.argv[4]);
    const configPath = path.join(userRoot, 'probe-config.yaml');
    writeFileSync(configPath, '{}\n');
    const { setConfigFilePath } = await import(pathToFileURL(path.join(sourceRoot, 'src', 'util.js')).href);
    setConfigFilePath(configPath);
    globalThis.DATA_ROOT = path.dirname(userRoot);
    const { getAllSecrets } = await import(pathToFileURL(path.join(sourceRoot, 'src', 'endpoints', 'secrets.js')).href);
    const stored = JSON.parse(readFileSync(path.join(userRoot, 'secrets.json'), 'utf8'));
    console.log(JSON.stringify({
        activeSecrets: getAllSecrets({ root: userRoot, backups: path.join(userRoot, 'backups') }),
        migratedMarkerIsArray: Array.isArray(stored._migrated),
        secretKeys: Object.keys(stored),
    }));
    process.exit(0);
}

if (process.argv[2] === '--child') {
    const sourceRoot = path.resolve(process.argv[3]);
    const runtimeRoot = path.resolve(process.argv[4]);
    const input = JSON.parse(readFileSync(path.join(runtimeRoot, 'scenario.json'), 'utf8'));
    process.env.FORCE_COLOR = '0';
    process.env.NO_COLOR = '1';

    const dataRoot = path.join(runtimeRoot, 'data');
    const directories = input.users.map(user => {
        const root = path.join(dataRoot, user.handle);
        const backups = path.join(root, 'backups');
        mkdirSync(backups, { recursive: true });
        if (Object.hasOwn(user, 'secrets')) writeFileSync(path.join(root, 'secrets.json'), user.secrets);
        return { root, backups };
    });
    writeFileSync(path.join(runtimeRoot, 'config.yaml'), '{}\n');

    const { setConfigFilePath } = await import(pathToFileURL(path.join(sourceRoot, 'src', 'util.js')).href);
    setConfigFilePath(path.join(runtimeRoot, 'config.yaml'));
    globalThis.DATA_ROOT = dataRoot;
    Date.now = () => FIXED_TIME;
    let uuidCounter = 0;
    Object.defineProperty(globalThis.crypto, 'randomUUID', {
        configurable: true,
        value: () => `00000000-0000-4000-8000-${String(++uuidCounter).padStart(12, '0')}`,
    });
    const { migrateFlatSecrets } = await import(pathToFileURL(path.join(sourceRoot, 'src', 'endpoints', 'secrets.js')).href);

    const events = [];
    const originalInfo = console.info;
    const originalWarn = console.warn;
    const originalError = console.error;
    const originalLog = console.log;
    const normalizeEventValue = (value, roots) => {
        if (value instanceof Error) return { name: value.name, message: value.message };
        let result = String(value);
        for (const root of roots) result = result.replaceAll(root, '<user-root>');
        return result
            .replaceAll(path.sep, '/')
            .replace(/secrets_migration_\d+\.json/gu, 'secrets_migration_<timestamp>.json');
    };
    const roots = directories.map(item => item.root);
    const capture = level => (...args) => {
        events.push({ level, args: args.map(value => normalizeEventValue(value, roots)) });
    };
    console.info = capture('info');
    console.warn = capture('warn');
    console.error = capture('error');
    try {
        migrateFlatSecrets(directories);
    } finally {
        console.info = originalInfo;
        console.warn = originalWarn;
        console.error = originalError;
        console.log = originalLog;
    }
    const firstEvents = events.splice(0);

    function normalizeSecretJSON(body) {
        let value;
        try {
            value = JSON.parse(body);
        } catch {
            return body;
        }
        const visit = item => {
            if (Array.isArray(item)) return item.map(visit);
            if (item && typeof item === 'object') {
                return Object.fromEntries(Object.entries(item).map(([key, child]) => [
                    key,
                    key === 'id' && typeof child === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(child)
                        ? '<uuid>'
                        : visit(child),
                ]));
            }
            return item;
        };
        return JSON.stringify(visit(value), null, 4);
    }

    function snapshot() {
        return directories.map((directory, index) => {
            let secrets = null;
            try {
                secrets = normalizeSecretJSON(readFileSync(path.join(directory.root, 'secrets.json'), 'utf8'));
            } catch (error) {
                if (error.code !== 'ENOENT') throw error;
            }
            const backups = readdirSync(directory.backups).sort().map(name => ({
                name: name.replace(/secrets_migration_\d+\.json/gu, 'secrets_migration_<timestamp>.json'),
                contents: readFileSync(path.join(directory.backups, name), 'utf8'),
            }));
            return { handle: input.users[index].handle, secrets, backups };
        });
    }

    const firstUsers = snapshot();
    const secondEvents = [];
    console.info = (...args) => secondEvents.push({ level: 'info', args: args.map(value => normalizeEventValue(value, roots)) });
    console.warn = (...args) => secondEvents.push({ level: 'warn', args: args.map(value => normalizeEventValue(value, roots)) });
    console.error = (...args) => secondEvents.push({ level: 'error', args: args.map(value => normalizeEventValue(value, roots)) });
    try {
        migrateFlatSecrets(directories);
    } finally {
        console.info = originalInfo;
        console.warn = originalWarn;
        console.error = originalError;
    }
    console.log(JSON.stringify({
        first: { events: firstEvents, users: firstUsers },
        second: { events: secondEvents, users: snapshot() },
    }));
    process.exit(0);
}

const sourceRoot = path.resolve(process.argv[2] ?? '');
const repositoryRoot = path.resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3]) {
    console.error('usage: node tools/probe-flat-secrets.mjs <pinned-source-clone> <gotavern-root>');
    process.exit(2);
}

const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'gotavern-flat-secrets-oracle-'));

function safeCleanup() {
    const resolved = path.resolve(tempRoot);
    const parent = path.resolve(os.tmpdir());
    if (path.dirname(resolved).toLowerCase() !== parent.toLowerCase()
        || !path.basename(resolved).startsWith('gotavern-flat-secrets-oracle-')) {
        throw new Error(`refusing to remove unexpected flat-secrets probe path: ${resolved}`);
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
    return { inputs: input.users, ...JSON.parse(output.trim().split(/\r?\n/u).at(-1)) };
}

function verifyGoMigrationRoundTrip() {
    const dataRoot = path.join(tempRoot, 'go-roundtrip', 'data');
    const userRoot = path.join(dataRoot, 'default-user');
    const backups = path.join(userRoot, 'backups');
    mkdirSync(backups, { recursive: true });
    const original = JSON.stringify({
        api_key_openai: 'round-trip-secret-value',
        ignored: '  ',
        unknownNumber: 9,
    });
    writeFileSync(path.join(userRoot, 'secrets.json'), original);
    const goResult = JSON.parse(execFileSync('go', ['run', './tools/flat-secrets-fixture', userRoot], {
        cwd: repositoryRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
    }));
    assert.deepEqual(goResult.errors, []);

    const nodeReadOutput = execFileSync(process.execPath, [
        fileURLToPath(import.meta.url), '--read-go', sourceRoot, userRoot,
    ], { cwd: sourceRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const nodeRead = JSON.parse(nodeReadOutput.trim().split(/\r?\n/u).at(-1));
    assert.deepEqual(nodeRead.activeSecrets, { api_key_openai: 'round-trip-secret-value' });
    assert.equal(nodeRead.migratedMarkerIsArray, true);
    assert.deepEqual(nodeRead.secretKeys, ['api_key_openai', '_migrated']);
    const backupNames = readdirSync(backups).sort().map(name => name.replace(/secrets_migration_\d+\.json/gu, 'secrets_migration_<timestamp>.json'));
    assert.deepEqual(backupNames, ['secrets_migration_<timestamp>.json']);
    assert.equal(readFileSync(path.join(backups, readdirSync(backups)[0]), 'utf8'), original);
    return {
        goErrors: goResult.errors,
        nodeReadActiveSecrets: nodeRead.activeSecrets,
        nodeReadMigratedMarkerIsArray: nodeRead.migratedMarkerIsArray,
        nodeReadSecretKeys: nodeRead.secretKeys,
        backupNames,
        backupMatchesOriginal: true,
    };
}

try {
    const scenarios = {
        noFile: runScenario('no-file', { users: [{ handle: 'alice' }] }),
        empty: runScenario('empty', { users: [{ handle: 'alice', secrets: '{}' }] }),
        flat: runScenario('flat', {
            users: [{
                handle: 'alice',
                secrets: JSON.stringify({
                    '10': 'ten',
                    api_key_openai: '  alpha & <beta>  ',
                    '2': 'two',
                    whitespace: '\uFEFF \u00a0 ',
                    number: 7,
                    nullable: null,
                    flag: false,
                    object: { ignored: true },
                    _migrated: false,
                    ['__proto__']: 'prototype-value',
                }),
            }],
        }),
        whitespaceOnly: runScenario('whitespace-only', {
            users: [{ handle: 'alice', secrets: JSON.stringify({ empty: ' \uFEFF ' }) }],
        }),
        alreadyMigrated: runScenario('already-migrated', {
            users: [{ handle: 'alice', secrets: JSON.stringify({ _migrated: true, legacy: 'token' }) }],
        }),
        truthyMarkerArray: runScenario('truthy-marker-array', {
            users: [{ handle: 'alice', secrets: JSON.stringify({ _migrated: [], legacy: 'token' }) }],
        }),
        existingArray: runScenario('existing-array', {
            users: [{ handle: 'alice', secrets: JSON.stringify({ api_key_openai: [{ id: 'old', value: 'token', active: true }], legacy: 'token' }) }],
        }),
        nullRoot: runScenario('null-root', { users: [{ handle: 'alice', secrets: 'null' }] }),
        topLevelArray: runScenario('top-level-array', { users: [{ handle: 'alice', secrets: '["first","",false]' }] }),
        continueAfterError: runScenario('continue-after-error', {
            users: [
                { handle: 'broken', secrets: '{' },
                { handle: 'migrated', secrets: JSON.stringify({ api_key_openai: 'token' }) },
            ],
        }),
    };
    assert.equal(scenarios.flat.first.events.filter(event => event.level === 'info').length, 1);
    assert.equal(scenarios.flat.first.users[0].backups.length, 1);
    assert.equal(scenarios.flat.second.events.length, 0);
    assert.equal(scenarios.continueAfterError.first.events.filter(event => event.level === 'warn').length, 1);
    assert.equal(scenarios.continueAfterError.first.users[1].backups.length, 1);
    const roundTrip = verifyGoMigrationRoundTrip();

    const fixture = {
        schemaVersion: 1,
        baseline: { version: PINNED_VERSION, commit: PINNED_COMMIT },
        probe: 'pinned migrateFlatSecrets() data, backup, error behavior, and Node-to-Go-to-Node round trip',
        scenarios,
        roundTrip,
    };
    const outputDirectory = path.join(repositoryRoot, 'tests', 'oracle');
    mkdirSync(outputDirectory, { recursive: true });
    const outputFile = path.join(outputDirectory, 'sillytavern-1.19.0-flat-secrets.json');
    writeFileSync(outputFile, `${JSON.stringify(fixture, null, 2)}\n`);
    console.log(`Wrote ${path.relative(repositoryRoot, outputFile)} from pinned migrateFlatSecrets()`);
} finally {
    safeCleanup();
}
