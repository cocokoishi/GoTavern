#!/usr/bin/env node
// Probe the pinned secrets state and masking semantics in isolated runtimes.
//
// The masked value is pinned HERE rather than derived from getMaskedValue: the measured output is
// seven placeholders plus the last three characters with no visible prefix, which is NOT what the
// six source lines suggest. The formula is recorded in docs/tokenizer-parity-plan.md so the
// implementation is written from the pinned value.
//
// allowKeysExposure is evaluated once at module load in the pinned source, so each configuration
// needs its own runtime; the probe spawns one child per configuration.
//
// Construction note, because it cost three iterations once: the child is WRITTEN TO A FILE and run,
// not passed through `node -e` with a template literal. Nested template construction is exactly the
// kind of second layer that should never be written before the first layer has executed.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const PINNED_COMMIT = '06bde939fb1e9c4c8d8641d810f0a916b5bce127';
const PINNED_VERSION = '1.19.0';
// @gotavern-oracle: this declaration is read by tools/build-generated-lib.mjs,
// which auto-discovers probes so that adding one needs no edit there.
// @gotavern-oracle: fixture=sillytavern-1.19.0-secrets.json label="secrets"
const sourceRoot = path.resolve(process.argv[2] ?? '');
const repositoryRoot = path.resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3]) {
    console.error('usage: node tools/probe-secrets.mjs <pinned-source-clone> <gotavern-root>');
    process.exit(2);
}

const utilURL = pathToFileURL(path.join(sourceRoot, 'src', 'util.js')).href;
const secretsURL = pathToFileURL(path.join(sourceRoot, 'src', 'endpoints', 'secrets.js')).href;

// Synthetic values only. Nothing here resembles a real credential.
const SEED_LONG = 'sk-synthetic-0123456789abcdefgh'; // 25 characters
const SEED_SHORT = 'short';                          // 5 characters
const SEED_TEN = 'exactlyten';                       // exactly the boundary of the length test
const SEED_LIBRE = 'synthetic-libre-value';          // exportable key: never masked

function safeCleanup(root) {
    const resolved = path.resolve(root);
    const parent = path.resolve(os.tmpdir());
    if (path.dirname(resolved).toLowerCase() !== parent.toLowerCase()
        || !path.basename(resolved).startsWith('gotavern-secrets-oracle-')) {
        throw new Error(`refusing to remove unexpected secrets path: ${resolved}`);
    }
    rmSync(resolved, { recursive: true, force: true });
}

// The child program, as a file. Written with plain string concatenation so no layer of quoting sits
// between this text and the program that runs.
function childProgram({ userRoot, dataRoot, configPath, flippedPath, seedFile }) {
    const lines = [
        `import { setConfigFilePath } from ${JSON.stringify(utilURL)};`,
        ``,
        `const userRoot = ${JSON.stringify(userRoot)};`,
        `const dataRoot = ${JSON.stringify(dataRoot)};`,
        `setConfigFilePath(${JSON.stringify(configPath)});`,
        `globalThis.DATA_ROOT = dataRoot;`,
        `Date.now = () => 1700000000000;`,
        ``,
        `const secrets = await import(${JSON.stringify(secretsURL)});`,
        `const { SecretManager, SECRET_KEYS, allowKeysExposure } = secrets;`,
        `const fs = await import('node:fs');`,
        `const directories = { root: userRoot, backups: userRoot + '/backups' };`,
        ``,
    ];
    if (seedFile === 'seeded') {
        lines.push(
            `// Seed from the pinned key ids rather than guessing them: a guessed id is silently`,
            `// absent from the state map instead of erroring, which is how the first version of`,
            `// this probe "passed" with an empty entry.`,
            `const seed = {`,
            `    [SECRET_KEYS.OPENAI]: [`,
            `        { id: 'sid-openai-1', value: ${JSON.stringify(SEED_LONG)}, label: 'primary', active: true, unknown_field: { nested: 1 } },`,
            `        { id: 'sid-openai-2', value: ${JSON.stringify(SEED_SHORT)}, label: 'secondary', active: false },`,
            `        { id: 'sid-openai-3', value: ${JSON.stringify(SEED_TEN)}, label: 'ten', active: true },`,
            `    ],`,
            `    [SECRET_KEYS.LIBRE_URL]: [`,
            `        { id: 'sid-libre-1', value: ${JSON.stringify(SEED_LIBRE)}, label: 'libre', active: true },`,
            `    ],`,
            `    [SECRET_KEYS.CUSTOM]: [],`,
            `    [SECRET_KEYS._MIGRATED]: [],`,
            `};`,
            `fs.writeFileSync(userRoot + '/secrets.json', JSON.stringify(seed, null, 4) + String.fromCharCode(10));`,
        );
    }
    lines.push(
        `const fileBefore = fs.existsSync(userRoot + '/secrets.json') ? fs.readFileSync(userRoot + '/secrets.json', 'utf8') : null;`,
        `const state = new SecretManager(directories).getSecretState();`,
        `const fileAfter = fs.existsSync(userRoot + '/secrets.json') ? fs.readFileSync(userRoot + '/secrets.json', 'utf8') : null;`,
        ``,
        `// Flip the config file under the running module: the pinned constant must NOT change.`,
        `setConfigFilePath(${JSON.stringify(flippedPath)});`,
        `const stateAfterFlip = new SecretManager(directories).getSecretState();`,
        ``,
        `console.log(JSON.stringify({`,
        `    allowKeysExposure: !!allowKeysExposure,`,
        `    secretKeyCount: Object.values(SECRET_KEYS).length,`,
        `    keyIds: { openai: SECRET_KEYS.OPENAI, libre: SECRET_KEYS.LIBRE_URL, custom: SECRET_KEYS.CUSTOM, migrated: SECRET_KEYS._MIGRATED },`,
        `    state,`,
        `    stateAfterFlipMatchesState: JSON.stringify(stateAfterFlip) === JSON.stringify(state),`,
        `    fileUnchangedByRead: fileAfter === fileBefore,`,
        `    seededFile: fileBefore ? JSON.parse(fileBefore) : null,`,
        `}));`,
        ``,
    );
    return lines.join('\n');
}

function runChild({ allowKeysExposure, seedFile }) {
    const runtimeRoot = mkdtempSync(path.join(os.tmpdir(), 'gotavern-secrets-oracle-'));
    try {
        const dataRoot = path.join(runtimeRoot, 'data');
        const userRoot = path.join(dataRoot, 'default-user');
        mkdirSync(path.join(userRoot, 'backups'), { recursive: true });
        const configPath = path.join(runtimeRoot, 'config.yaml');
        writeFileSync(configPath, `allowKeysExposure: ${allowKeysExposure}\n`);
        const flippedPath = path.join(runtimeRoot, 'config-flipped.yaml');
        writeFileSync(flippedPath, `allowKeysExposure: ${!allowKeysExposure}\n`);
        // 'absent' leaves no secrets.json at all; 'empty' writes an empty object. They are
        // different inputs and the pinned code branches on existsSync.
        if (seedFile === 'empty') {
            writeFileSync(path.join(userRoot, 'secrets.json'), '{}\n');
        }
        const childPath = path.join(runtimeRoot, 'child.mjs');
        writeFileSync(childPath, childProgram({ userRoot, dataRoot, configPath, flippedPath, seedFile }));
        const output = execFileSync(process.execPath, [childPath], {
            cwd: sourceRoot,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
        });
        return JSON.parse(output);
    } finally {
        safeCleanup(runtimeRoot);
    }
}

const runs = {
    exposureDisabled: runChild({ allowKeysExposure: false, seedFile: 'seeded' }),
    exposureEnabled: runChild({ allowKeysExposure: true, seedFile: 'seeded' }),
    fileAbsent: runChild({ allowKeysExposure: false, seedFile: 'absent' }),
    fileEmpty: runChild({ allowKeysExposure: false, seedFile: 'empty' }),
};

// The contract this probe exists to pin. Asserted here so a silent upstream change fails the probe
// instead of being recorded as a new expectation.
assert.equal(runs.exposureDisabled.allowKeysExposure, false);
assert.equal(runs.exposureEnabled.allowKeysExposure, true);
// The pinned util refuses to change the config path once set, so a single runtime cannot flip the
// configuration; the module-load semantics are instead proven by the two runs below producing
// DIFFERENT masking for the same seeded file, because each loaded the module with its own config.
assert.notEqual(runs.exposureDisabled.state[runs.exposureDisabled.keyIds.openai][0].value, runs.exposureEnabled.state[runs.exposureEnabled.keyIds.openai][0].value,
    'the two runs must disagree about masking, which is the evidence that allowKeysExposure is fixed at module load');
assert.equal(runs.exposureDisabled.fileUnchangedByRead, true,
    'reading secrets must not rewrite the file, or rule 11 retention has no baseline');

const keys = runs.exposureDisabled.keyIds;
assert.equal(Object.hasOwn(runs.exposureDisabled.state, keys.migrated), false,
    'the migration marker must be skipped in the state map');
assert.equal(runs.exposureDisabled.state[keys.custom], null, 'an empty array must surface as null');
assert.equal(runs.exposureDisabled.state.api_key_claude, null, 'an absent key must surface as null');
assert.equal(Array.isArray(runs.exposureDisabled.state[keys.openai]), true);
assert.equal(runs.exposureDisabled.state[keys.openai].length, 3);

// THE MASKING CONTRACT, pinned by measurement rather than derived from the source.
assert.equal(runs.exposureDisabled.state[keys.openai][0].value, '*******fgh',
    'a value longer than ten characters masks to seven placeholders plus its last three characters');
assert.equal(runs.exposureDisabled.state[keys.openai][1].value, '**********',
    'a value of ten characters or fewer masks to ten placeholders');
assert.equal(runs.exposureDisabled.state[keys.openai][2].value, '**********',
    'exactly ten characters is still the short branch');
assert.equal(runs.exposureDisabled.state[keys.libre][0].value, SEED_LIBRE,
    'an exportable key must not be masked');
assert.equal(runs.exposureEnabled.state[keys.openai][0].value, SEED_LONG,
    'with exposure enabled the value is raw');
// The state projection keeps only id, value, label and active: the unknown field is not echoed.
assert.deepEqual(Object.keys(runs.exposureDisabled.state[keys.openai][0]).sort(), ['active', 'id', 'label', 'value']);

// A missing file and an empty file are different inputs, and both must produce the full null map.
for (const [label, probeRun] of [['absent', runs.fileAbsent], ['empty', runs.fileEmpty]]) {
    assert.equal(Object.keys(probeRun.state).length, runs.exposureDisabled.secretKeyCount - 1,
        `every SECRET_KEYS value except the migration marker must appear (${label} file)`);
    for (const [key, value] of Object.entries(probeRun.state)) {
        assert.equal(value, null, `${key} must be null on a ${label} file`);
    }
}

const fixture = {
    schemaVersion: 1,
    baseline: { version: PINNED_VERSION, commit: PINNED_COMMIT },
    probe: 'tools/probe-secrets.mjs',
    pinnedMasking: {
        longValue: { input: SEED_LONG, output: '*******fgh', formula: "'*'.repeat(10 - 3) + value.slice(-3)" },
        shortValue: { input: SEED_SHORT, output: '**********' },
        tenCharacters: { input: SEED_TEN, output: '**********' },
        exportableKey: { keyId: 'libre_url', input: SEED_LIBRE, output: SEED_LIBRE },
    },
    runs,
};
const fixturePath = path.join(repositoryRoot, 'tests', 'oracle', 'sillytavern-1.19.0-secrets.json');
writeFileSync(fixturePath, JSON.stringify(fixture, null, 2) + '\n');

console.log(`exposure disabled state[api_key_openai] = ${JSON.stringify(runs.exposureDisabled.state[keys.openai])}`);
console.log(`exportable key raw = ${JSON.stringify(runs.exposureDisabled.state[keys.libre])}`);
console.log(`absent file: ${Object.keys(runs.fileAbsent.state).length} keys, all null = ${Object.values(runs.fileAbsent.state).every(value => value === null)}`);
console.log(`fixture written to ${fixturePath}`);
