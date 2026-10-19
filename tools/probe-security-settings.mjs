#!/usr/bin/env node
// Probe the pinned verifySecuritySettings() warning and process-exit contract.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
    const input = JSON.parse(await (await import('node:fs/promises')).readFile(path.join(runtimeRoot, 'scenario.json'), 'utf8'));

    for (const key of [
        'SILLYTAVERN_ENABLEUSERACCOUNTS',
        'SILLYTAVERN_SECURITYOVERRIDE',
        'SILLYTAVERN_PERUSERBASICAUTH',
        'SILLYTAVERN_BASICAUTHUSER_USERNAME',
        'SILLYTAVERN_BASICAUTHUSER_PASSWORD',
    ]) delete process.env[key];
    process.env.FORCE_COLOR = '0';
    process.env.NO_COLOR = '1';

    const requireFromPinned = createRequire(path.join(sourceRoot, 'package.json'));
    const storage = requireFromPinned('node-persist');
    await storage.init({ dir: path.join(dataRoot, '_storage'), ttl: false, expiredInterval: 0, writeQueue: false });
    for (const user of input.users) await storage.setItem(`user:${user.handle}`, user);

    const { setConfigFilePath } = await import(pathToFileURL(path.join(sourceRoot, 'src', 'util.js')).href);
    setConfigFilePath(configPath);
    globalThis.DATA_ROOT = dataRoot;
    globalThis.COMMAND_LINE_ARGS = input.args;
    const { verifySecuritySettings } = await import(pathToFileURL(path.join(sourceRoot, 'src', 'users.js')).href);

    const events = [];
    const originalLog = console.log;
    const originalWarn = console.warn;
    const originalError = console.error;
    const originalExit = process.exit;
    console.log = (...args) => events.push({ level: 'log', args });
    console.warn = (...args) => events.push({ level: 'warn', args });
    console.error = (...args) => events.push({ level: 'error', args });
    process.exit = (code = 0) => {
        const captured = new Error('captured process.exit');
        captured.gotavernExit = code;
        throw captured;
    };

    let exitCode = null;
    try {
        await verifySecuritySettings();
    } catch (error) {
        if (!Object.hasOwn(error, 'gotavernExit')) throw error;
        exitCode = error.gotavernExit;
    } finally {
        console.log = originalLog;
        console.warn = originalWarn;
        console.error = originalError;
        process.exit = originalExit;
    }

    const storageDirectory = path.join(dataRoot, '_storage');
    const storageRecords = readdirSync(storageDirectory, { withFileTypes: true })
        .filter(entry => entry.isFile() && !entry.name.startsWith('.'))
        .map(entry => ({ filename: entry.name, body: readFileSync(path.join(storageDirectory, entry.name), 'utf8') }));
    console.log(JSON.stringify({ exitCode, events, storageRecords }));
    process.exit(0);
}

const sourceRoot = path.resolve(process.argv[2] ?? '');
const repositoryRoot = path.resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3]) {
    console.error('usage: node tools/probe-security-settings.mjs <pinned-source-clone> <gotavern-root>');
    process.exit(2);
}

const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'gotavern-security-settings-oracle-'));

function safeCleanup() {
    const resolved = path.resolve(tempRoot);
    const parent = path.resolve(os.tmpdir());
    if (path.dirname(resolved).toLowerCase() !== parent.toLowerCase()
        || !path.basename(resolved).startsWith('gotavern-security-settings-oracle-')) {
        throw new Error(`refusing to remove unexpected security probe path: ${resolved}`);
    }
    rmSync(resolved, { recursive: true, force: true });
}

const baseUsers = [];
const scenarios = {
    listenDisabled: {
        config: { enableUserAccounts: false, securityOverride: false, perUserBasicAuth: false },
        args: { listen: false, basicAuthMode: false, whitelistMode: false },
        users: baseUsers,
    },
    accountsDisabledExits: {
        config: { enableUserAccounts: false, securityOverride: false, perUserBasicAuth: false },
        args: { listen: true, basicAuthMode: false, whitelistMode: false },
        users: baseUsers,
    },
    securityOverrideContinues: {
        config: { enableUserAccounts: false, securityOverride: true, perUserBasicAuth: false },
        args: { listen: true, basicAuthMode: false, whitelistMode: false },
        users: baseUsers,
    },
    stringBooleanConfig: {
        config: { enableUserAccounts: 'false', securityOverride: 'true', perUserBasicAuth: 'false' },
        args: { listen: true, basicAuthMode: false, whitelistMode: false },
        users: baseUsers,
    },
    basicAuthMissingCredentials: {
        config: { enableUserAccounts: false, securityOverride: false, perUserBasicAuth: false, basicAuthUser: { username: '', password: '' } },
        args: { listen: true, basicAuthMode: true, whitelistMode: false },
        users: baseUsers,
    },
    basicAuthConfigured: {
        config: { enableUserAccounts: false, securityOverride: false, perUserBasicAuth: false, basicAuthUser: { username: 'user', password: 'pass' } },
        args: { listen: true, basicAuthMode: true, whitelistMode: false },
        users: baseUsers,
    },
    whitelistBypassesAlerts: {
        config: { enableUserAccounts: false, securityOverride: false, perUserBasicAuth: false },
        args: { listen: true, basicAuthMode: false, whitelistMode: true },
        users: baseUsers,
    },
    unprotectedAdminExits: {
        config: { enableUserAccounts: true, securityOverride: false, perUserBasicAuth: false },
        args: { listen: true, basicAuthMode: false, whitelistMode: false },
        users: [{ handle: 'admin', password: '', admin: true, enabled: true }],
    },
    unprotectedRegularUserWarns: {
        config: { enableUserAccounts: true, securityOverride: false, perUserBasicAuth: false },
        args: { listen: true, basicAuthMode: false, whitelistMode: false },
        users: [{ handle: 'regular', password: '', admin: false, enabled: true }],
    },
    protectedAdmin: {
        config: { enableUserAccounts: true, securityOverride: false, perUserBasicAuth: false },
        args: { listen: true, basicAuthMode: false, whitelistMode: false },
        users: [{ handle: 'admin', password: 'scrypt-hash', admin: true, enabled: true }],
    },
    disabledAdminIgnored: {
        config: { enableUserAccounts: true, securityOverride: false, perUserBasicAuth: false },
        args: { listen: true, basicAuthMode: false, whitelistMode: false },
        users: [{ handle: 'disabled', password: '', admin: true, enabled: false }],
    },
    perUserBasicAuthWithoutAccounts: {
        config: { enableUserAccounts: false, securityOverride: false, perUserBasicAuth: true },
        args: { listen: true, basicAuthMode: true, whitelistMode: false },
        users: baseUsers,
    },
};

function runScenario(name, input) {
    const runtimeRoot = path.join(tempRoot, name);
    mkdirSync(path.join(runtimeRoot, 'data'), { recursive: true });
    writeFileSync(path.join(runtimeRoot, 'config.yaml'), `${JSON.stringify(input.config)}\n`);
    writeFileSync(path.join(runtimeRoot, 'scenario.json'), `${JSON.stringify(input)}\n`);
    const output = execFileSync(process.execPath, [
        fileURLToPath(import.meta.url),
        '--child', sourceRoot, runtimeRoot,
    ], { cwd: sourceRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return JSON.parse(output.trim().split(/\r?\n/u).at(-1));
}

try {
    const observations = {};
    for (const [name, scenario] of Object.entries(scenarios)) {
        observations[name] = { inputs: scenario, ...runScenario(name, scenario) };
    }
    assert.equal(observations.accountsDisabledExits.exitCode, 1);
    assert.equal(observations.unprotectedAdminExits.exitCode, 1);
    assert.equal(observations.listenDisabled.events.length, 0);

    const fixture = {
        schemaVersion: 1,
        baseline: { version: PINNED_VERSION, commit: PINNED_COMMIT },
        probe: 'pinned users.js verifySecuritySettings logs and process exit behavior',
        scenarios: observations,
    };
    const outputDirectory = path.join(repositoryRoot, 'tests', 'oracle');
    mkdirSync(outputDirectory, { recursive: true });
    const outputFile = path.join(outputDirectory, 'sillytavern-1.19.0-security-settings.json');
    writeFileSync(outputFile, `${JSON.stringify(fixture, null, 2)}\n`);
    console.log(`Wrote ${path.relative(repositoryRoot, outputFile)} from pinned verifySecuritySettings()`);
} finally {
    safeCleanup();
}
