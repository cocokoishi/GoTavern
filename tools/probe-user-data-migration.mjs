#!/usr/bin/env node
// Probe the pinned users.js migrateUserData() filesystem contract.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PINNED_COMMIT = '06bde939fb1e9c4c8d8641d810f0a916b5bce127';
const PINNED_VERSION = '1.19.0';

if (process.argv[2] === '--child') {
    const sourceRoot = path.resolve(process.argv[3]);
    const runtimeRoot = path.resolve(process.argv[4]);
    const configPath = path.join(runtimeRoot, 'config.yaml');
    const dataRoot = path.join(runtimeRoot, 'data');
    const requireFromPinned = createRequire(path.join(sourceRoot, 'package.json'));
    const storage = requireFromPinned('node-persist');
    const { setConfigFilePath } = await import(pathToFileURL(path.join(sourceRoot, 'src', 'util.js')).href);
    setConfigFilePath(configPath);
    globalThis.DATA_ROOT = dataRoot;
    await storage.init({ dir: path.join(dataRoot, '_storage'), ttl: false, expiredInterval: 0, writeQueue: false });
    await storage.setItem('user:default-user', {
        handle: 'default-user', name: 'User', created: 1700000000000,
        password: '', admin: true, enabled: true, salt: '',
    });
    process.chdir(runtimeRoot);
    const { ensurePublicDirectoriesExist, migrateUserData } = await import(pathToFileURL(path.join(sourceRoot, 'src', 'users.js')).href);
    await ensurePublicDirectoriesExist();

    const inputs = JSON.parse(readFileSync(path.join(runtimeRoot, 'inputs.json'), 'utf8'));
    const utcDate = new Date().toISOString().split('T')[0];
    for (const [relative, content] of Object.entries(inputs)) {
        const target = path.join(runtimeRoot, relative.replaceAll('__UTC_DATE__', utcDate));
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, content);
    }

    const originalSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (callback) => originalSetTimeout(callback, 0);
    const errors = [];
    const originalLog = console.log;
    const originalError = console.error;
    console.log = () => {};
    console.error = (...items) => errors.push(items.map(String).join(' '));
    try {
        await migrateUserData();
    } finally {
        globalThis.setTimeout = originalSetTimeout;
        console.log = originalLog;
        console.error = originalError;
    }

    function snapshotTree() {
        const output = [];
        const roots = ['public', 'thumbnails', 'vectors', 'secrets.json', 'data/default-user', 'backups'];
        const normalizePath = (relative) => relative.replace(/(backups\/_migration\/)\d{4}-\d{2}-\d{2}/u, '$1<date>');
        function visit(absolute, relative) {
            const info = statSync(absolute);
            if (info.isDirectory()) {
                output.push({ path: normalizePath(relative), type: 'directory' });
                for (const entry of readdirSync(absolute).sort()) {
                    visit(path.join(absolute, entry), `${relative}/${entry}`);
                }
                return;
            }
            const body = readFileSync(absolute);
            output.push({
                path: normalizePath(relative),
                type: 'file',
                bytes: body.byteLength,
                sha256: createHash('sha256').update(body).digest('hex'),
            });
        }
        for (const relative of roots) {
            const absolute = path.join(runtimeRoot, relative);
            try {
                statSync(absolute);
            } catch (error) {
                if (error.code === 'ENOENT') continue;
                throw error;
            }
            visit(absolute, relative);
        }
        return output.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
    }

    console.log(JSON.stringify({ errors, tree: snapshotTree() }));
    process.exit(0);
}

const sourceRoot = path.resolve(process.argv[2] ?? '');
const repositoryRoot = path.resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3]) {
    console.error('usage: node tools/probe-user-data-migration.mjs <pinned-source-clone> <gotavern-root>');
    process.exit(2);
}

const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'gotavern-user-data-migration-oracle-'));

function safeCleanup() {
    const resolved = path.resolve(tempRoot);
    const parent = path.resolve(os.tmpdir());
    if (path.dirname(resolved).toLowerCase() !== parent.toLowerCase()
        || !path.basename(resolved).startsWith('gotavern-user-data-migration-oracle-')) {
        throw new Error(`refusing to remove unexpected user-data migration probe path: ${resolved}`);
    }
    rmSync(resolved, { recursive: true, force: true });
}

function legacyInputs() {
    return {
        'public/assets/source.json': '{"source":"assets"}',
        'public/backgrounds/bg.png': 'background bytes',
        'public/characters/Alice/Alice.png': 'character bytes',
        'public/characters/Alice/metadata.json': '{"name":"Alice"}',
        'public/chats/Alice/2024.jsonl': '{"mes":"chat"}\n',
        'public/context/context.json': '{"context":true}',
        'public/group chats/Alice/2024.jsonl': '{"group":"chat"}\n',
        'public/groups/groups.json': '[{"id":"group"}]',
        'public/instruct/instruct.json': '{"name":"legacy instruct"}',
        'public/KoboldAI Settings/preset.json': '{"kobold":1}',
        'public/movingUI/moving-ui.json': '{"moving":true}',
        'public/NovelAI Settings/preset.json': '{"novel":1}',
        'public/OpenAI Settings/preset.json': '{"openai":1}',
        'public/QuickReplies/QuickReplies.json': '{"quick":true}',
        'public/TextGen Settings/preset.json': '{"textgen":1}',
        'public/themes/theme.json': '{"theme":"legacy"}',
        'public/user/images/persona.png': 'persona image bytes',
        'public/User Avatars/avatar.png': 'avatar bytes',
        'public/worlds/world.json': '{"world":"legacy"}',
        'public/scripts/extensions/third-party/canary/index.js': 'globalThis.canary = true;',
        'thumbnails/legacy.png': 'thumbnail bytes',
        'vectors/legacy.json': '{"vector":[1,2,3]}',
        'secrets.json': '{"api_key":"legacy"}',
        'public/settings.json': '{"setting":"legacy"}',
        'public/stats.json': '{"stats":{"messages":3}}',
        'data/default-user/assets/source.json': '{"source":"old destination"}',
        'data/default-user/assets/stale.json': '{"retain":true}',
        'data/default-user/settings.json': '{"setting":"old destination"}',
        'backups/_migration/__UTC_DATE__/assets/stale-backup.json': '{"retainBackup":true}',
    };
}

function runScenario(name, inputs) {
    const runtimeRoot = path.join(tempRoot, name);
    mkdirSync(runtimeRoot, { recursive: true });
    writeFileSync(path.join(runtimeRoot, 'config.yaml'), '{}\n');
    writeFileSync(path.join(runtimeRoot, 'inputs.json'), `${JSON.stringify(inputs, null, 2)}\n`);
    const output = execFileSync(process.execPath, [
        fileURLToPath(import.meta.url), '--child', sourceRoot, runtimeRoot,
    ], { cwd: sourceRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const observation = JSON.parse(output.trim().split(/\r?\n/u).at(-1));
    assert.deepEqual(observation.errors, [], `${name}: pinned migration reported errors`);
    return { inputs, tree: observation.tree };
}

try {
    const scenarios = {
        noLegacyCharacters: runScenario('no-legacy-characters', {}),
        legacy: runScenario('legacy', legacyInputs()),
    };
    const fixture = {
        schemaVersion: 1,
        baseline: { version: PINNED_VERSION, commit: PINNED_COMMIT },
        probe: 'pinned users.js migrateUserData filesystem behavior after ensurePublicDirectoriesExist',
        scenarios,
    };
    const outputDirectory = path.join(repositoryRoot, 'tests', 'oracle');
    mkdirSync(outputDirectory, { recursive: true });
    const outputFile = path.join(outputDirectory, 'sillytavern-1.19.0-user-data-migration.json');
    writeFileSync(outputFile, `${JSON.stringify(fixture, null, 2)}\n`);
    console.log(`Wrote ${path.relative(repositoryRoot, outputFile)} from pinned migrateUserData()`);
} finally {
    safeCleanup();
}
