#!/usr/bin/env node
// Probe pinned migrateSystemPrompts() using isolated node-persist user state.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PINNED_COMMIT = '06bde939fb1e9c4c8d8641d810f0a916b5bce127';
const PINNED_VERSION = '1.19.0';
// @gotavern-oracle: this declaration is read by tools/build-generated-lib.mjs,
// which auto-discovers probes so that adding one needs no edit there.
// @gotavern-oracle: fixture=sillytavern-1.19.0-system-prompt-migration.json label="system-prompt migration"

if (process.argv[2] === '--child') {
    const sourceRoot = path.resolve(process.argv[3]);
    const configPath = path.resolve(process.argv[4]);
    const dataRoot = path.resolve(process.argv[5]);
    const requireFromPinned = createRequire(path.join(sourceRoot, 'package.json'));
    const storage = requireFromPinned('node-persist');
    await storage.init({ dir: path.join(dataRoot, '_storage'), ttl: false, expiredInterval: 0, writeQueue: false });
    const { setConfigFilePath } = await import(pathToFileURL(path.join(sourceRoot, 'src', 'util.js')).href);
    setConfigFilePath(configPath);
    globalThis.DATA_ROOT = dataRoot;
    const { migrateSystemPrompts } = await import(pathToFileURL(path.join(sourceRoot, 'src', 'users.js')).href);
    const errors = [];
    const originalError = console.error;
    console.error = (...items) => errors.push(items.map(String).join(' '));
    await migrateSystemPrompts();
    console.error = originalError;
    console.log(JSON.stringify({ errors }));
    process.exit(0);
}

const sourceRoot = path.resolve(process.argv[2] ?? '');
const repositoryRoot = path.resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3]) {
    console.error('usage: node tools/probe-system-prompt-migration.mjs <pinned-source-clone> <gotavern-root>');
    process.exit(2);
}

const requireFromPinned = createRequire(path.join(sourceRoot, 'package.json'));
const storage = requireFromPinned('node-persist');
const { USER_DIRECTORY_TEMPLATE } = await import(pathToFileURL(path.join(sourceRoot, 'src', 'constants.js')).href);
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'gotavern-system-prompt-oracle-'));

function safeCleanup() {
    const resolved = path.resolve(tempRoot);
    const parent = path.resolve(os.tmpdir());
    if (path.dirname(resolved).toLowerCase() !== parent.toLowerCase()
        || !path.basename(resolved).startsWith('gotavern-system-prompt-oracle-')) {
        throw new Error(`refusing to remove unexpected migration probe path: ${resolved}`);
    }
    rmSync(resolved, { recursive: true, force: true });
}

function snapshotMigrationTree(dataRoot) {
    const output = [];
    const roots = [
        'default-user/instruct',
        'default-user/sysprompt',
        'default-user/backups/_sysprompt',
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
        });
    }
    for (const relative of roots) visit(path.join(dataRoot, relative), relative);
    return output.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

async function runScenario(name, inputs) {
    const scenarioRoot = path.join(tempRoot, name);
    const dataRoot = path.join(scenarioRoot, 'data');
    const configPath = path.join(scenarioRoot, 'config.yaml');
    mkdirSync(dataRoot, { recursive: true });
    writeFileSync(configPath, '{}\n');

    await storage.init({ dir: path.join(dataRoot, '_storage'), ttl: false, expiredInterval: 0, writeQueue: false });
    await storage.setItem('user:default-user', {
        handle: 'default-user',
        name: 'User',
        created: 1700000000000,
        password: '',
        admin: true,
        enabled: true,
        salt: '',
    });

    for (const relative of Object.values(USER_DIRECTORY_TEMPLATE)) {
        mkdirSync(path.join(dataRoot, 'default-user', relative), { recursive: true });
    }
    for (const [relative, body] of Object.entries(inputs)) {
        const target = path.join(dataRoot, 'default-user', relative);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, body);
    }

    const output = execFileSync(process.execPath, [
        fileURLToPath(import.meta.url),
        '--child',
        sourceRoot,
        configPath,
        dataRoot,
    ], { cwd: sourceRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const child = JSON.parse(output.trim().split(/\r?\n/u).at(-1));
    assert.deepEqual(child.errors, [], `${name}: pinned migration reported errors`);
    return { inputs, tree: snapshotMigrationTree(dataRoot) };
}

function legacyInputs() {
    const index = JSON.parse(readFileSync(path.join(sourceRoot, 'default', 'content', 'index.json'), 'utf8'));
    const defaultItem = index.find(item => item.type === 'sysprompt');
    assert.ok(defaultItem, 'pinned default content has no system prompts');
    const defaultPrompt = JSON.parse(readFileSync(path.join(sourceRoot, 'default', 'content', defaultItem.filename), 'utf8'));
    const ordinary = JSON.stringify({ name: 'Ordinary template', template: 'chatml' }, null, 4);
    const legacy = JSON.stringify({ name: 'Imported Prompt', system_prompt: 'Unique legacy system content', template: 'alpaca', extra: { keep: true } }, null, 4);
    const defaultMatch = JSON.stringify({ name: 'Same as built-in', system_prompt: defaultPrompt.content, template: 'chatml' }, null, 4);
    const existing = JSON.stringify({ name: 'Existing Prompt', system_prompt: 'Must remain untouched', template: 'old' }, null, 4);
    const escaped = JSON.stringify({
        name: 'Escaped Prompt',
        system_prompt: 'Line one\nLine two\u2028Line three 😀 <tag> &',
        template: 'chatml',
        metadata: { '10': 'ten', '2': 'two', '01': 'leading zero', value: '\b\f\t\r' },
        magnitude: [1e-7, 1e21, -0],
    }, null, 4);
    const existingTarget = JSON.stringify({ name: 'Existing user prompt', content: 'already present' }, null, 4);
    return {
        'instruct/legacy.json': legacy,
        'instruct/default-match.json': defaultMatch,
        'instruct/existing.json': existing,
        'instruct/ordinary.json': ordinary,
        'instruct/escaped.json': escaped,
        'instruct/notes.txt': 'ignored file',
        'sysprompt/existing.json': existingTarget,
    };
}

try {
    const scenarios = {
        fresh: await runScenario('fresh', {}),
        legacy: await runScenario('legacy', legacyInputs()),
    };
    const fixture = {
        schemaVersion: 1,
        baseline: { version: PINNED_VERSION, commit: PINNED_COMMIT },
        probe: 'pinned users.js migrateSystemPrompts filesystem behavior',
        scenarios,
    };
    const outputDirectory = path.join(repositoryRoot, 'tests', 'oracle');
    mkdirSync(outputDirectory, { recursive: true });
    const outputFile = path.join(outputDirectory, 'sillytavern-1.19.0-system-prompt-migration.json');
    writeFileSync(outputFile, `${JSON.stringify(fixture, null, 2)}\n`);
    console.log(`Wrote ${path.relative(repositoryRoot, outputFile)} from pinned migrateSystemPrompts()`);
} finally {
    safeCleanup();
}
