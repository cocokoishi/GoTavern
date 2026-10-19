#!/usr/bin/env node
// Probe the pinned users.js getCookieSecret() behavior in isolated runtimes.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const PINNED_COMMIT = '06bde939fb1e9c4c8d8641d810f0a916b5bce127';
const PINNED_VERSION = '1.19.0';
const sourceRoot = path.resolve(process.argv[2] ?? '');
const repositoryRoot = path.resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3]) {
    console.error('usage: node tools/probe-cookie-secret.mjs <pinned-source-clone> <gotavern-root>');
    process.exit(2);
}

function sha256(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
}

function safeCleanup(root) {
    const resolved = path.resolve(root);
    const parent = path.resolve(os.tmpdir());
    if (path.dirname(resolved).toLowerCase() !== parent.toLowerCase()
        || !path.basename(resolved).startsWith('gotavern-cookie-secret-oracle-')) {
        throw new Error(`refusing to remove unexpected cookie-secret path: ${resolved}`);
    }
    rmSync(resolved, { recursive: true, force: true });
}

function runCookieSecretChild(configPath, dataRoot) {
    const childSource = `
import { setConfigFilePath } from ${JSON.stringify(pathToFileURL(path.join(sourceRoot, 'src', 'util.js')).href)};
setConfigFilePath(${JSON.stringify(configPath)});
globalThis.DATA_ROOT = ${JSON.stringify(dataRoot)};
const { getCookieSecret } = await import(${JSON.stringify(pathToFileURL(path.join(sourceRoot, 'src', 'users.js')).href)});
const secret = getCookieSecret(globalThis.DATA_ROOT);
const file = await import('node:fs').then(({ readFileSync }) => readFileSync(${JSON.stringify(path.join(dataRoot, 'cookie-secret.txt'))}));
const text = file.toString('utf8');
if (secret !== text) throw new Error('getCookieSecret return value differs from the written file');
console.log(JSON.stringify({ bytes: file.byteLength, returnedMatchesFile: secret === text }));
`;
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', childSource], {
        cwd: sourceRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    return JSON.parse(output.trim().split(/\r?\n/u).at(-1));
}

function observeScenario(root, name, legacySecret, initialSecret) {
    const dataRoot = path.join(root, name);
    mkdirSync(dataRoot, { recursive: true });
    const configPath = path.join(root, `${name}.yaml`);
    const config = legacySecret === undefined ? '{}\n' : `cookieSecret: ${JSON.stringify(legacySecret)}\n`;
    writeFileSync(configPath, config);
    const secretPath = path.join(dataRoot, 'cookie-secret.txt');
    if (initialSecret !== undefined) writeFileSync(secretPath, initialSecret);
    const before = initialSecret === undefined ? null : readFileSync(secretPath);
    const child = runCookieSecretChild(configPath, dataRoot);
    const after = readFileSync(secretPath);
    if (!child.returnedMatchesFile || child.bytes !== after.byteLength) throw new Error(`${name}: returned value differs from file`);
    const generated = name === 'generated' || name === 'emptyFileGenerated';
    if (generated) {
        const decoded = Buffer.from(after.toString('utf8'), 'base64');
        assert.equal(after.byteLength, 88);
        assert.equal(decoded.byteLength, 64);
        assert.match(after.toString('utf8'), /^[A-Za-z0-9+/]+={0,2}$/u);
        return { fileBytes: after.byteLength, decodedRandomBytes: decoded.byteLength, returnedMatchesFile: true };
    }
    const expected = initialSecret && initialSecret.byteLength > 0 ? initialSecret : Buffer.from(legacySecret ?? '');
    if (!before || before.byteLength === 0) assert.deepEqual(after, expected);
    else assert.deepEqual(after, before);
    return { fileBytes: after.byteLength, sha256: sha256(after), returnedMatchesFile: true, preexistingBytesPreserved: before?.byteLength > 0 };
}

const runtimeRoot = mkdtempSync(path.join(os.tmpdir(), 'gotavern-cookie-secret-oracle-'));
try {
    const scenarios = {
        generated: observeScenario(runtimeRoot, 'generated', undefined, undefined),
        migrated: observeScenario(runtimeRoot, 'migrated', 'pinned-legacy-cookie-secret', undefined),
        emptyFileMigrated: observeScenario(runtimeRoot, 'emptyFileMigrated', 'pinned-empty-file-legacy-secret', Buffer.alloc(0)),
        emptyFileGenerated: observeScenario(runtimeRoot, 'emptyFileGenerated', undefined, Buffer.alloc(0)),
        existing: observeScenario(runtimeRoot, 'existing', 'ignored-legacy-secret', Buffer.from('existing-cookie-secret')),
    };
    const fixture = {
        schemaVersion: 1,
        baseline: { version: PINNED_VERSION, commit: PINNED_COMMIT },
        probe: 'pinned users.js getCookieSecret filesystem behavior',
        scenarios,
    };
    const outputDirectory = path.join(repositoryRoot, 'tests', 'oracle');
    mkdirSync(outputDirectory, { recursive: true });
    const outputFile = path.join(outputDirectory, 'sillytavern-1.19.0-cookie-secret.json');
    writeFileSync(outputFile, `${JSON.stringify(fixture, null, 2)}\n`);
    console.log(`Wrote ${path.relative(repositoryRoot, outputFile)} from pinned getCookieSecret()`);
} finally {
    safeCleanup(runtimeRoot);
}
