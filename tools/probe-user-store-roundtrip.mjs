#!/usr/bin/env node
// Prove node-persist@4.0.4 can read Go-created users and that Go preserves
// Node-created records without converting their canonical storage format.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const PINNED_COMMIT = '06bde939fb1e9c4c8d8641d810f0a916b5bce127';
const PINNED_VERSION = '1.19.0';
const sourceRoot = path.resolve(process.argv[2] ?? '');
const repositoryRoot = path.resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3]) {
    console.error('usage: node tools/probe-user-store-roundtrip.mjs <pinned-source-clone> <gotavern-root>');
    process.exit(2);
}

const requireFromPinned = createRequire(path.join(sourceRoot, 'package.json'));
const storage = requireFromPinned('node-persist');
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'gotavern-user-store-roundtrip-'));

function sha256(text) {
    return createHash('sha256').update(text).digest('hex');
}

function storagePath(dataRoot, key) {
    return path.join(dataRoot, '_storage', sha256(key));
}

async function initStorage(dataRoot) {
    await storage.init({ dir: path.join(dataRoot, '_storage'), ttl: false, expiredInterval: 0, writeQueue: false });
}

function runGoInitializer(dataRoot) {
    const output = execFileSync('go', ['run', './tools/user-store-fixture', dataRoot], {
        cwd: repositoryRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    return JSON.parse(output);
}

async function verifyNodeWrittenRecordSurvivesGo() {
    const dataRoot = path.join(tempRoot, 'node-written');
    const user = {
        handle: 'roundtrip',
        name: 'Node-created account',
        created: 1700000000000,
        password: 'pinned-test-hash',
        admin: false,
        enabled: true,
        salt: 'pinned-test-salt',
        unknownField: { preserve: ['existing', 7, true] },
    };
    const avatar = 'data:image/png;base64,AA==';
    await initStorage(dataRoot);
    await storage.setItem('user:roundtrip', user);
    await storage.setItem('avatar:roundtrip', avatar);
    const userPath = storagePath(dataRoot, 'user:roundtrip');
    const avatarPath = storagePath(dataRoot, 'avatar:roundtrip');
    const userBytes = readFileSync(userPath);
    const avatarBytes = readFileSync(avatarPath);

    const initialized = runGoInitializer(dataRoot);
    assert.deepEqual(initialized.handles, ['roundtrip']);
    assert.equal(readFileSync(userPath).compare(userBytes), 0, 'Go rewrote the Node-created user record');
    assert.equal(readFileSync(avatarPath).compare(avatarBytes), 0, 'Go rewrote the Node-created avatar record');

    await initStorage(dataRoot);
    assert.deepEqual(await storage.getItem('user:roundtrip'), user);
    assert.equal(await storage.getItem('avatar:roundtrip'), avatar);
    assert.equal(await storage.getItem('user:default-user'), undefined);
    return {
        nodeCreatedUserRecordPreserved: true,
        nodeCreatedAvatarRecordPreserved: true,
        goObservedHandles: initialized.handles,
        nodeReadBackUser: user,
        nodeReadBackAvatar: avatar,
        defaultUserAdded: false,
    };
}

async function verifyNodeReadsGoCreatedRecord() {
    const dataRoot = path.join(tempRoot, 'go-created');
    mkdirSync(dataRoot, { recursive: true });
    const initialized = runGoInitializer(dataRoot);
    assert.deepEqual(initialized.handles, ['default-user']);

    await initStorage(dataRoot);
    const user = await storage.getItem('user:default-user');
    assert.deepEqual(Object.keys(user), ['handle', 'name', 'created', 'password', 'admin', 'enabled', 'salt']);
    assert.deepEqual(user, {
        handle: 'default-user',
        name: 'User',
        created: user.created,
        password: '',
        admin: true,
        enabled: true,
        salt: '',
    });
    assert.equal(typeof user.created, 'number');
    assert.ok(user.created > 0);

    const filePath = storagePath(dataRoot, 'user:default-user');
    const record = JSON.parse(readFileSync(filePath, 'utf8'));
    assert.deepEqual(Object.keys(record), ['key', 'value']);
    assert.equal(record.key, 'user:default-user');
    assert.equal(Object.hasOwn(record, 'ttl'), false);
    return {
        goObservedHandles: initialized.handles,
        nodeReadGoCreatedUser: { ...user, created: '<timestamp>' },
        nodePersistKeys: Object.keys(record),
        ttlPresent: Object.hasOwn(record, 'ttl'),
        recordPath: `_storage/${path.basename(filePath)}`,
    };
}

function safeCleanup() {
    const resolved = path.resolve(tempRoot);
    const parent = path.resolve(os.tmpdir());
    if (path.dirname(resolved).toLowerCase() !== parent.toLowerCase()
        || !path.basename(resolved).startsWith('gotavern-user-store-roundtrip-')) {
        throw new Error(`refusing to remove unexpected round-trip path: ${resolved}`);
    }
    rmSync(resolved, { recursive: true, force: true });
}

try {
    const fixture = {
        schemaVersion: 1,
        baseline: { version: PINNED_VERSION, commit: PINNED_COMMIT },
        probe: 'node-persist account-store Node-to-Go-to-Node round trip',
        implementation: 'pinned node-persist@4.0.4',
        scenarios: {
            nodeWritten: await verifyNodeWrittenRecordSurvivesGo(),
            goWritten: await verifyNodeReadsGoCreatedRecord(),
        },
    };
    const outputDirectory = path.join(repositoryRoot, 'tests', 'oracle');
    mkdirSync(outputDirectory, { recursive: true });
    const outputFile = path.join(outputDirectory, 'sillytavern-1.19.0-user-storage-roundtrip.json');
    writeFileSync(outputFile, `${JSON.stringify(fixture, null, 2)}\n`);
    console.log(`Wrote ${path.relative(repositoryRoot, outputFile)} after Node→Go→Node account-store checks`);
} finally {
    safeCleanup();
}
