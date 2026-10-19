#!/usr/bin/env node
// Probe pinned migrateGroupChatsMetadataFormat() persistent-data behavior.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PINNED_COMMIT = '06bde939fb1e9c4c8d8641d810f0a916b5bce127';
const PINNED_VERSION = '1.19.0';

if (process.argv[2] === '--child') {
    const sourceRoot = path.resolve(process.argv[3]);
    const runtimeRoot = path.resolve(process.argv[4]);
    const dataRoot = path.join(runtimeRoot, 'data');
    const userRoot = path.join(dataRoot, 'default-user');
    const directories = {
        root: userRoot,
        groups: path.join(userRoot, 'groups'),
        groupChats: path.join(userRoot, 'group chats'),
        backups: path.join(userRoot, 'backups'),
    };
    for (const directory of Object.values(directories)) mkdirSync(directory, { recursive: true });
    const inputs = JSON.parse(readFileSync(path.join(runtimeRoot, 'scenario.json'), 'utf8'));
    for (const [relative, body] of Object.entries(inputs)) {
        const target = path.join(userRoot, relative);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, body);
    }

    writeFileSync(path.join(runtimeRoot, 'config.yaml'), '{}\n');
    const { setConfigFilePath } = await import(pathToFileURL(path.join(sourceRoot, 'src', 'util.js')).href);
    setConfigFilePath(path.join(runtimeRoot, 'config.yaml'));
    globalThis.DATA_ROOT = dataRoot;
    const { migrateGroupChatsMetadataFormat } = await import(pathToFileURL(path.join(sourceRoot, 'src', 'endpoints', 'groups.js')).href);
    const errors = [];
    const originalLog = console.log;
    const originalWarn = console.warn;
    const originalError = console.error;
    console.log = () => {};
    console.warn = () => {};
    console.error = (...items) => errors.push(items.map(item => String(item?.message ?? item)).join(' '));
    try {
        await migrateGroupChatsMetadataFormat([directories]);
    } finally {
        console.log = originalLog;
        console.warn = originalWarn;
        console.error = originalError;
    }

    function snapshotTree() {
        const output = [];
        const roots = [directories.groups, directories.groupChats, directories.backups];
        function visit(absolute) {
            const info = statSync(absolute);
            const relative = path.relative(dataRoot, absolute).split(path.sep).join('/');
            if (info.isDirectory()) {
                output.push({ path: relative, type: 'directory' });
                for (const entry of readdirSync(absolute).sort()) visit(path.join(absolute, entry));
                return;
            }
            const body = readFileSync(absolute);
            output.push({
                path: relative,
                type: 'file',
                bytes: body.byteLength,
                sha256: createHash('sha256').update(body).digest('hex'),
            });
        }
        for (const root of roots) visit(root);
        return output.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
    }

    console.log(JSON.stringify({ errors, tree: snapshotTree() }));
    process.exit(0);
}

const sourceRoot = path.resolve(process.argv[2] ?? '');
const repositoryRoot = path.resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3]) {
    console.error('usage: node tools/probe-group-metadata-migration.mjs <pinned-source-clone> <gotavern-root>');
    process.exit(2);
}

const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'gotavern-group-metadata-oracle-'));

function safeCleanup() {
    const resolved = path.resolve(tempRoot);
    const parent = path.resolve(os.tmpdir());
    if (path.dirname(resolved).toLowerCase() !== parent.toLowerCase()
        || !path.basename(resolved).startsWith('gotavern-group-metadata-oracle-')) {
        throw new Error(`refusing to remove unexpected group-metadata probe path: ${resolved}`);
    }
    rmSync(resolved, { recursive: true, force: true });
}

function migratedInputs() {
    const legacyGroup = {
        id: 'legacy-group',
        name: 'Migrating Group',
        chat_id: 'chat-current',
        chats: ['chat-old', 'chat-current', 'chat-existing', 'missing-chat'],
        past_metadata: {
            'chat-old': { from: 'past', keep: true },
            'chat-current': { from: 'past', overwritten: true },
            'chat-existing': { from: 'past-existing' },
            unused: { keep: false },
        },
        chat_metadata: { from: 'current', nested: { count: 2 } },
        unknown: { preserve: ['field', 7, true] },
    };
    const noChatsGroup = {
        id: 'no-chats',
        name: 'No chats array',
        chat_metadata: { remains: true },
        extension_field: 'preserved',
    };
    const untouchedGroup = { id: 'untouched', name: 'No deprecated metadata', chats: [] };
    return {
        'groups/legacy.json': JSON.stringify(legacyGroup, null, 4),
        'groups/no-chats.json': JSON.stringify(noChatsGroup, null, 4),
        'groups/untouched.json': JSON.stringify(untouchedGroup, null, 4),
        'groups/broken.json': '{ this is not valid JSON',
        'group chats/chat-old.jsonl': `${JSON.stringify({ mes: 'old first line', name: 'Alice' })}\n\n${JSON.stringify({ mes: 'old second line' })}\n`,
        'group chats/chat-current.jsonl': `${JSON.stringify({ mes: 'current line' })}\n`,
        'group chats/chat-existing.jsonl': `${JSON.stringify({ chat_metadata: { already: true }, user_name: 'existing' })}\n${JSON.stringify({ mes: 'existing line' })}\n`,
        'group chats/untouched.jsonl': `${JSON.stringify({ mes: 'untouched line' })}\n`,
    };
}

function runScenario(name, inputs) {
    const runtimeRoot = path.join(tempRoot, name);
    mkdirSync(runtimeRoot, { recursive: true });
    writeFileSync(path.join(runtimeRoot, 'scenario.json'), `${JSON.stringify(inputs, null, 2)}\n`);
    const output = execFileSync(process.execPath, [
        fileURLToPath(import.meta.url), '--child', sourceRoot, runtimeRoot,
    ], { cwd: sourceRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const observation = JSON.parse(output.trim().split(/\r?\n/u).at(-1));
    assert.deepEqual(observation.errors, [], `${name}: pinned migration reported errors`);
    return { inputs, tree: observation.tree };
}

try {
    const scenarios = {
        noChanges: runScenario('no-changes', {}),
        legacy: runScenario('legacy', migratedInputs()),
    };
    const fixture = {
        schemaVersion: 1,
        baseline: { version: PINNED_VERSION, commit: PINNED_COMMIT },
        probe: 'pinned groups.js migrateGroupChatsMetadataFormat filesystem behavior',
        scenarios,
    };
    const outputDirectory = path.join(repositoryRoot, 'tests', 'oracle');
    mkdirSync(outputDirectory, { recursive: true });
    const outputFile = path.join(outputDirectory, 'sillytavern-1.19.0-group-metadata-migration.json');
    writeFileSync(outputFile, `${JSON.stringify(fixture, null, 2)}\n`);
    console.log(`Wrote ${path.relative(repositoryRoot, outputFile)} from pinned migrateGroupChatsMetadataFormat()`);
} finally {
    safeCleanup();
}
