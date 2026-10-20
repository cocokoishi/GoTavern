#!/usr/bin/env node
// Probe the pinned stats.init() startup file load and recreation behavior.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PINNED_COMMIT = '06bde939fb1e9c4c8d8641d810f0a916b5bce127';
const PINNED_VERSION = '1.19.0';
// @gotavern-oracle: this declaration is read by tools/build-generated-lib.mjs,
// which auto-discovers probes so that adding one needs no edit there.
// @gotavern-oracle: fixture=sillytavern-1.19.0-stats-init.json label="stats-init"
const FIXED_NOW = 1_735_689_600_000;

if (process.argv[2] === '--child') {
    const sourceRoot = path.resolve(process.argv[3]);
    const runtimeRoot = path.resolve(process.argv[4]);
    const input = JSON.parse(readFileSync(path.join(runtimeRoot, 'scenario.json'), 'utf8'));
    const dataRoot = path.join(runtimeRoot, 'data');
    const configPath = path.join(runtimeRoot, 'config.yaml');
    writeFileSync(configPath, `${JSON.stringify({ backups: { common: { numberOfBackups: 50 } } })}\n`);
    const { setConfigFilePath } = await import(pathToFileURL(path.join(sourceRoot, 'src', 'util.js')).href);
    setConfigFilePath(configPath);
    globalThis.DATA_ROOT = dataRoot;
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

    const { initUserStorage, getUserDirectories } = await import(pathToFileURL(path.join(sourceRoot, 'src', 'users.js')).href);
    await initUserStorage(dataRoot);
    const directories = getUserDirectories('default-user');
    mkdirSync(directories.root, { recursive: true });
    mkdirSync(directories.chats, { recursive: true });
    if (input.charactersDirectoryExists !== false) mkdirSync(directories.characters, { recursive: true });
    for (const filename of input.characterFiles ?? []) {
        writeFileSync(path.join(directories.characters, filename), Buffer.alloc(0));
    }
    for (const [character, files] of Object.entries(input.chatFiles ?? {})) {
        const chatDirectory = path.join(directories.chats, character);
        mkdirSync(chatDirectory, { recursive: true });
        for (const [filename, entry] of Object.entries(files)) {
            const contents = typeof entry === 'string' ? entry : entry.contents;
            const chatPath = path.join(chatDirectory, filename);
            writeFileSync(chatPath, contents);
            if (typeof entry === 'object' && entry.mtime !== undefined) {
                const fixedTime = new Date(entry.mtime);
                utimesSync(chatPath, fixedTime, fixedTime);
            }
        }
    }
    if (input.statsFileContent !== undefined && input.statsFileContent !== null) {
        writeFileSync(path.join(directories.root, 'stats.json'), input.statsFileContent);
    }

    const logRecords = [];
    const originalConsole = {
        error: console.error,
        info: console.info,
        log: console.log,
        warn: console.warn,
    };
    for (const level of Object.keys(originalConsole)) {
        console[level] = (...args) => {
            const error = args.find(value => value instanceof Error);
            logRecords.push({
                level,
                message: String(args[0]),
                errorCode: error?.code ?? null,
            });
        };
    }
    const intervalCalls = [];
    const originalSetInterval = globalThis.setInterval;
    globalThis.setInterval = (_callback, delay) => {
        intervalCalls.push(delay);
        return { unref() {} };
    };

    const { init, router } = await import(pathToFileURL(path.join(sourceRoot, 'src', 'endpoints', 'stats.js')).href);
    try {
        await init();
    } finally {
        globalThis.setInterval = originalSetInterval;
        for (const [level, original] of Object.entries(originalConsole)) console[level] = original;
    }

    const getRoute = router.stack.find(layer => layer.route?.path === '/get');
    assert.ok(getRoute, 'stats router must expose the pinned /get handler');
    let memory;
    getRoute.route.stack[0].handle(
        { user: { profile: { handle: 'default-user' } } },
        { send(value) { memory = value; } },
    );

    let statsFileContent = null;
    let statsFileExists = false;
    try {
        statsFileExists = statSync(path.join(directories.root, 'stats.json')).isFile();
        if (statsFileExists) statsFileContent = readFileSync(path.join(directories.root, 'stats.json'), 'utf8');
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }

    console.log(JSON.stringify({
        input,
        observation: {
            logs: logRecords,
            intervalCalls,
            memory: memory ?? {},
            filesystem: { statsFileExists, statsFileContent },
        },
    }));
    process.exit(0);
}

const sourceRoot = path.resolve(process.argv[2] ?? '');
const repositoryRoot = path.resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3]) {
    console.error('usage: node tools/probe-stats-init.mjs <pinned-source-clone> <gotavern-root>');
    process.exit(2);
}

const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'gotavern-stats-init-oracle-'));

function safeCleanup() {
    const resolved = path.resolve(tempRoot);
    const parent = path.resolve(os.tmpdir());
    if (path.dirname(resolved).toLowerCase() !== parent.toLowerCase()
        || !path.basename(resolved).startsWith('gotavern-stats-init-oracle-')) {
        throw new Error(`refusing to remove unexpected stats-init probe path: ${resolved}`);
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
    const firstUserMessage = JSON.stringify({
        mes: 'Hello, world! 2',
        is_user: true,
        send_date: '2024-01-02T03:04:05.006Z',
    });
    const scenarios = {
        existingValid: runScenario('existing-valid', {
            statsFileContent: '{"timestamp":321,"unknown":{"retained":true}}',
            characterFiles: ['default_Seraphina.png'],
        }),
        missingStatsNoCharacters: runScenario('missing-stats-no-characters', {
            characterFiles: ['persona.webp', 'ignored.PNG'],
        }),
        invalidStatsNoCharacters: runScenario('invalid-stats-no-characters', {
            statsFileContent: '{ invalid json',
            characterFiles: [],
        }),
        missingStatsCharacterWithoutChats: runScenario('missing-stats-character-without-chats', {
            characterFiles: ['default_Seraphina.png'],
        }),
        missingStatsChatHistory: runScenario('missing-stats-chat-history', {
            characterFiles: ['default_Seraphina.png'],
            chatFiles: {
                default_Seraphina: {
                    'a.jsonl': {
                        contents: [
                            firstUserMessage,
                            JSON.stringify({
                                mes: 'A reply.',
                                is_user: false,
                                gen_started: '2024-01-02T03:00:00.000Z',
                                gen_finished: '2024-01-02T03:00:02.500Z',
                                swipes: ['A reply.', 'Other possible response'],
                                swipe_info: [
                                    {},
                                    { gen_started: '2024-01-02T03:00:03.000Z', gen_finished: '2024-01-02T03:00:04.250Z' },
                                ],
                            }),
                        ].join('\n') + '\n',
                        mtime: 1_700_000_000_000,
                    },
                    'b.jsonl': {
                        contents: [
                            firstUserMessage,
                            JSON.stringify({
                                mes: 'Generated answer',
                                is_user: false,
                                gen_started: '2024-01-02T03:10:00.000Z',
                                gen_finished: '2024-01-02T03:10:01.000Z',
                                swipes: ['Generated answer', 'Alternate answer'],
                            }),
                        ].join('\n') + '\n',
                        mtime: 1_700_000_001_000,
                    },
                },
            },
        }),
        missingCharactersDirectory: runScenario('missing-characters-directory', {
            charactersDirectoryExists: false,
        }),
    };
    assert.deepEqual(scenarios.missingStatsNoCharacters.observation.memory, { timestamp: FIXED_NOW });
    assert.deepEqual(scenarios.invalidStatsNoCharacters.observation.memory, { timestamp: FIXED_NOW });
    assert.equal(scenarios.missingCharactersDirectory.observation.logs.find(record => record.level === 'error')?.errorCode, 'ENOENT');
    assert.deepEqual(scenarios.existingValid.observation.intervalCalls, [300_000]);

    const roundTripUserRoot = path.join(tempRoot, 'node-go-node', 'default-user');
    const roundTripCharacters = path.join(roundTripUserRoot, 'characters');
    const roundTripChats = path.join(roundTripUserRoot, 'chats');
    mkdirSync(roundTripCharacters, { recursive: true });
    mkdirSync(roundTripChats, { recursive: true });
    const roundTripInput = scenarios.missingStatsChatHistory.input;
    for (const filename of roundTripInput.characterFiles) {
        writeFileSync(path.join(roundTripCharacters, filename), Buffer.alloc(0));
    }
    for (const [character, files] of Object.entries(roundTripInput.chatFiles)) {
        const chatDirectory = path.join(roundTripChats, character);
        mkdirSync(chatDirectory, { recursive: true });
        for (const [filename, entry] of Object.entries(files)) {
            const chatPath = path.join(chatDirectory, filename);
            writeFileSync(chatPath, entry.contents);
            const fixedTime = new Date(entry.mtime);
            utimesSync(chatPath, fixedTime, fixedTime);
        }
    }
    const goRoundTrip = JSON.parse(execFileSync('go', [
        'run', './tools/stats-fixture', roundTripUserRoot, String(FIXED_NOW),
    ], { cwd: repositoryRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim());
    const nodeReadback = JSON.parse(readFileSync(path.join(roundTripUserRoot, 'stats.json'), 'utf8'));
    assert.deepEqual(nodeReadback, scenarios.missingStatsChatHistory.observation.memory);
    assert.deepEqual(goRoundTrip.errors, []);

    const fixture = {
        schemaVersion: 1,
        baseline: { version: PINNED_VERSION, commit: PINNED_COMMIT },
        probe: 'pinned stats.init() file load, JSONL chat aggregation, and interval behavior',
        scenarios,
        roundTrip: {
            input: roundTripInput,
            errors: goRoundTrip.errors,
            fileContent: goRoundTrip.fileContent,
            memory: goRoundTrip.memory,
            nodeReadback,
        },
    };
    const outputDirectory = path.join(repositoryRoot, 'tests', 'oracle');
    mkdirSync(outputDirectory, { recursive: true });
    const outputFile = path.join(outputDirectory, 'sillytavern-1.19.0-stats-init.json');
    writeFileSync(outputFile, `${JSON.stringify(fixture, null, 2)}\n`);
    console.log(`Wrote ${path.relative(repositoryRoot, outputFile)} from pinned stats.init()`);
} finally {
    safeCleanup();
}
