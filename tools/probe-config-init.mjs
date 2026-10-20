#!/usr/bin/env node
// Capture pinned config-init behavior without touching the supplied checkout.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import yaml from 'yaml';

const PINNED_COMMIT = '06bde939fb1e9c4c8d8641d810f0a916b5bce127';
const PINNED_VERSION = '1.19.0';
// @gotavern-oracle: this declaration is read by tools/build-generated-lib.mjs,
// which auto-discovers probes so that adding one needs no edit there.
// @gotavern-oracle: fixture=sillytavern-1.19.0-config-init.json label="config-init"
const sourceRoot = path.resolve(process.argv[2] ?? '');
const outputRoot = path.resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3]) {
    console.error('usage: node tools/probe-config-init.mjs <pinned-source-clone> <gotavern-root>');
    process.exit(2);
}
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim();
if (sourceCommit !== PINNED_COMMIT) throw new Error(`upstream checkout is ${sourceCommit}; expected ${PINNED_COMMIT}`);
const { addMissingConfigValues } = await import(pathToFileURL(path.join(sourceRoot, 'src', 'config-init.js')));

const runtimeRoot = mkdtempSync(path.join(os.tmpdir(), 'gotavern-config-oracle-'));
const migrationsInput = `port: 24680
whitelist: []
disableThumbnails: true
thumbnails:
  enabled: true
  customUnknown: keep-thumbnails
thumbnailsQuality: 82
avatarThumbnailsPng: false
disableChatBackup: true
numberOfBackups: 7
maxTotalChatBackups: 99
chatBackupThrottleInterval: 11
enableExtensions: false
enableExtensionsAutoUpdate: false
extras:
  disableAutoDownload: false
  classificationModel: compat/classifier
  captioningModel: compat/caption
  embeddingModel: compat/embed
  speechToTextModel: compat/stt
  textToSpeechModel: compat/tts
  promptExpansionModel: legacy/removed
minLogLevel: debug
cardsCacheCapacity: 128
cookieSecret: legacy-secret
autorun: true
autorunHostname: example.test
autorunPortOverride: 1234
avoidLocalhost: true
autheliaAuth: true
authentikAuth: false
customUnknown:
  nested: preserved
  sequence: [alpha, beta]
`;

function safeCleanup() {
    const resolved = path.resolve(runtimeRoot);
    const parent = path.resolve(os.tmpdir());
    if (path.dirname(resolved).toLowerCase() !== parent.toLowerCase()
        || !path.basename(resolved).startsWith('gotavern-config-oracle-')) {
        throw new Error(`refusing to remove unexpected runtime path: ${resolved}`);
    }
    rmSync(resolved, { recursive: true, force: true });
}

function captureScenario(name, input) {
    const scenarioRoot = path.join(runtimeRoot, name);
    const configPath = path.join(scenarioRoot, 'config.yaml');
    mkdirSync(scenarioRoot, { recursive: true });
    if (input !== null) writeFileSync(configPath, input);

    addMissingConfigValues(configPath);

    const output = readFileSync(configPath);
    return {
        input,
        outputYaml: output.toString('utf8'),
        bytes: output.byteLength,
        sha256: createHash('sha256').update(output).digest('hex'),
        parsed: yaml.parse(output.toString('utf8')),
    };
}

function captureEnvironmentMigration() {
    const oldName = 'SILLYTAVERN_DISABLETHUMBNAILS';
    const newName = 'SILLYTAVERN_THUMBNAILS_ENABLED';
    const previousOld = process.env[oldName];
    const previousNew = process.env[newName];
    try {
        delete process.env[oldName];
        delete process.env[newName];
        process.env[oldName] = 'false';
        const scenario = captureScenario('environment', '{}\n');
        scenario.environment = {
            [oldName]: process.env[oldName] ?? null,
            [newName]: process.env[newName] ?? null,
        };
        return scenario;
    } finally {
        if (previousOld === undefined) delete process.env[oldName];
        else process.env[oldName] = previousOld;
        if (previousNew === undefined) delete process.env[newName];
        else process.env[newName] = previousNew;
    }
}

try {
    const log = console.log;
    const warn = console.warn;
    console.log = () => {};
    console.warn = () => {};
    let scenarios;
    try {
        scenarios = {
            fresh: captureScenario('fresh', null),
            migrationsAndUnknownFields: captureScenario('migration', migrationsInput),
            environmentMigration: captureEnvironmentMigration(),
        };
    } finally {
        console.log = log;
        console.warn = warn;
    }

    const fixture = {
        schemaVersion: 1,
        baseline: { version: PINNED_VERSION, commit: PINNED_COMMIT },
        probe: 'pinned addMissingConfigValues fresh creation, legacy migration, defaults merge, and unknown-field preservation',
        source: 'src/config-init.js: addMissingConfigValues',
        scenarios,
    };
    const outputDirectory = path.join(outputRoot, 'tests', 'oracle');
    mkdirSync(outputDirectory, { recursive: true });
    const outputFile = path.join(outputDirectory, 'sillytavern-1.19.0-config-init.json');
    writeFileSync(outputFile, `${JSON.stringify(fixture, null, 2)}\n`);
    console.log(`Wrote ${path.relative(outputRoot, outputFile)} from pinned config-init`);
} finally {
    safeCleanup();
}
