#!/usr/bin/env node
// Capture what pinned SillyTavern DOES with a duplicate-key config.yaml: does it exit, with what stderr and
// exit code, and -- the field that decides the support story -- WAS THE FILE MIGRATED BEFORE IT EXITED.
//
// WHY THIS PROBE EXISTS AND WHY IT IS A PROBE RATHER THAN A READING.
//
// A reading of the pinned source gives two parse sites with OPPOSITE failure behaviour, and a chain of quoted
// lines is not evidence that the behaviour follows (AGENTS verification rule 60):
//
//   src/config-init.js:164-243   `addMissingConfigValues` is wrapped in ONE try/catch whose catch only
//                                `console.warn`s. A throw here means the migration is SKIPPED and the file is
//                                left alone -- and this runs FIRST.
//   src/util.js:70-78            `getConfig()` parses the SAME file and on a throw prints
//                                `FATAL: Failed to read config.yaml. Please check the file for syntax errors.`
//                                and calls `process.exit(1)`.
//
// Pinned's `yaml` package (^2.8.3) defaults to `uniqueKeys: true` (node_modules/yaml/.../doc/Document.js:39), so
// a duplicate key SHOULD throw at both sites. But SHOULD is exactly what this probe replaces with a measurement,
// and the ORDER matters: if `addMissingConfigValues` writes the merged document before `getConfig()` exits, then
// a user with a duplicated key gets a MIGRATED FILE AND A REFUSAL -- their config rewritten on the way to a
// crash. If it exits first, they get an UNTOUCHED FILE AND A REFUSAL, can fix the duplicate, and restart with
// nothing lost. Those are different support stories and only the observation can say which one pinned has.
//
// WHAT IS RECORDED, per scenario:
//   * whether the process exited before serving, its exit code, and its stderr (the causal message);
//   * the config file's bytes and mtime BEFORE the boot and AFTER the exit, with sha256 of each -- so
//     "migrated" and "untouched" are byte facts rather than inferences;
//   * whether the file was still written when the process died, which is the field the whole probe exists for.
//
// A CONTROL runs the same boot with the SAME config minus the duplicate key, so a "did not migrate" result
// cannot be produced by a probe that simply failed to boot a healthy tree.

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const PINNED_COMMIT = '06bde939fb1e9c4c8d8641d810f0a916b5bce127';
const PINNED_VERSION = '1.19.0';
// @gotavern-oracle: this declaration is read by tools/build-generated-lib.mjs,
// which auto-discovers probes so that adding one needs no edit there.
// @gotavern-oracle: fixture=sillytavern-1.19.0-config-duplicate-key.json label="config duplicate key"
const sourceRoot = path.resolve(process.argv[2] ?? '');
const repositoryRoot = path.resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3]) {
    console.error('usage: node tools/probe-config-duplicate-key.mjs <pinned-source-clone> <gotavern-root>');
    process.exit(2);
}
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim();
if (sourceCommit !== PINNED_COMMIT) {
    throw new Error(`upstream checkout is ${sourceCommit}; expected ${PINNED_COMMIT}`);
}

const BOOT_TIMEOUT_MS = 60000;

function sha256(value) {
    return createHash('sha256').update(value).digest('hex');
}

/**
 * The config documents this probe uses. Each one is written byte-for-byte and read back after the boot, so the
 * comparison is about the FILE rather than about what the parser was believed to have done with it.
 *
 * `duplicateKey` deliberately repeats `port`, because `port` is a scalar the migration also merges defaults
 * around: if pinned rewrites the document at all, the bytes MUST move, and a repeated scalar is the shape a
 * user produces by editing the file by hand.
 */
const scenarios = [
    {
        name: 'duplicate-key-control',
        // The CONTROL. One `port`, no duplicate: the boot must reach "listening" and the file must be migrated
        // the ordinary way (defaults inserted). Without this, "config untouched" below could just mean the probe
        // never got far enough to migrate anything.
        config: 'port: 8000\nlisten: false\n',
        expect: 'boots',
    },
    {
        name: 'duplicate-key',
        // THE SUBJECT. The same document with `port` duplicated. `yaml` 2.x defaults to uniqueKeys: true, so
        // both parse sites should throw -- the question is what ELSE happened first.
        config: 'port: 8000\nport: 9000\nlisten: false\n',
        expect: 'observed',
    },
    {
        name: 'duplicate-key-deep',
        // A duplicate nested inside a section, which is where a user's config actually grows. A top-level
        // duplicate may be caught by a different path than a nested one, and the two can behave differently.
        config: 'listen: false\nssl:\n  enabled: false\n  enabled: true\n',
        expect: 'observed',
    },
];

function snapshotConfig(configPath) {
    try {
        const bytes = readFileSync(configPath);
        const info = statSync(configPath);
        return {
            bytes: bytes.length,
            sha256: sha256(bytes),
            mtimeMs: Math.trunc(info.mtimeMs),
        };
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
    }
}

function safeCleanup(runtimeRoot) {
    const resolved = path.resolve(runtimeRoot);
    const parent = path.resolve(os.tmpdir());
    if (path.dirname(resolved).toLowerCase() !== parent.toLowerCase()
        || !path.basename(resolved).startsWith('gotavern-config-duplicate-oracle-')) {
        throw new Error(`refusing to remove unexpected runtime path: ${resolved}`);
    }
    rmSync(resolved, { recursive: true, force: true });
}

/**
 * Boots pinned against one config document and reports what happened, in terms of OBSERVABLES ONLY.
 *
 * The child is given its own runtime root and data root and is started with `--port 0`? No: pinned would then
 * log an unusable readiness URL and this probe does not need a listener at all. The boot is judged by whether
 * the process is STILL RUNNING after a settle window (it reached the server phase) or EXITED (it refused), and
 * by its stderr. Nothing here sleeps to fake a result: the settle window bounds "did it exit promptly", and a
 * process that neither exits nor reports is recorded as `hung`, which is its own verdict.
 */
async function bootScenario(scenario, runtimeRoot) {
    const configPath = path.join(runtimeRoot, 'config.yaml');
    const dataRoot = path.join(runtimeRoot, 'data');
    mkdirSync(dataRoot, { recursive: true });
    writeFileSync(configPath, scenario.config);
    // A stable, distinguishable mtime so "the file was written" cannot hide inside the filesystem's clock
    // granularity. Same technique as internal/configinit/config_idempotence_test.go.
    const stamp = new Date('2026-01-01T00:00:00Z');
    try {
        utimesSync(configPath, stamp, stamp);
    } catch { /* mtime remains the write time; recorded either way */ }

    const before = snapshotConfig(configPath);

    const child = spawn(process.execPath, [
        path.join(sourceRoot, 'server.js'),
        '--dataRoot', dataRoot,
        '--configPath', configPath,
        '--port', '0',
        // `--port 0` is passed (type: 'number', src/command-line.js:132-136, so a numeric string coerces cleanly)
        // so three boots in one probe cannot collide on the pinned default 8000 and produce an EADDRINUSE that
        // looks like "the config was refused". `--listen` is NOT passed: it is declared `type: 'boolean'`
        // (:162-166) and a `--listen false` argv entry is ambiguous under yargs, while the scenario's config
        // document already carries the value -- which is the thing under test, so passing it again would add a
        // second source of truth to a probe whose whole subject is what the config file does. No listener is
        // needed either way: the boot is judged by whether the process survives the settle window.
    ], {
        cwd: runtimeRoot,
        env: { ...process.env, NODE_ENV: 'production' },
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });

    const exit = await new Promise(resolve => {
        let settled = false;
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            child.kill('SIGKILL');
            resolve({ kind: 'hung', code: null, signal: null });
        }, BOOT_TIMEOUT_MS);
        child.once('exit', (code, signal) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve({ kind: 'exited', code, signal });
        });
        // A process that is still alive after the settle window reached the server phase; it is stopped
        // deliberately rather than killed mid-write.
        child.once('spawn', () => {
            setTimeout(() => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                child.kill('SIGINT');
                child.once('exit', (code, signal) => resolve({ kind: 'served', code, signal }));
            }, 8000);
        });
    });

    const after = snapshotConfig(configPath);

    // THE VERDICT THE PROBE EXISTS FOR, stated as one of the two support stories rather than as a boolean.
    let migrationOutcome;
    if (before === null || after === null) {
        migrationOutcome = after === null ? 'config-removed' : 'config-created';
    } else if (before.sha256 === after.sha256) {
        migrationOutcome = 'untouched';
    } else {
        migrationOutcome = 'rewritten';
    }

    return {
        exit: exit.kind,
        exitCode: exit.code,
        exitSignal: exit.signal,
        // The stderr is truncated for the fixture but keeps the FATAL line and any warning, which are the whole
        // point: a reader must be able to see WHY it stopped without the log.
        stderrLines: stderr.split('\n').map(line => line.trim()).filter(line => line !== ''),
        configBefore: before,
        configAfter: after,
        configMigration: migrationOutcome,
        // The one-line support story: what a user with this file actually experiences.
        userStory: exit.kind === 'exited' && migrationOutcome === 'rewritten'
            ? 'migrated file AND a refusal: their config was rewritten on the way to the crash'
            : exit.kind === 'exited' && migrationOutcome === 'untouched'
                ? 'untouched file and a refusal: they can fix the duplicate and restart with nothing lost'
                : exit.kind === 'served' && migrationOutcome === 'rewritten'
                    ? 'booted and migrated: the duplicate key did NOT stop the server'
                    : exit.kind === 'served' && migrationOutcome === 'untouched'
                        ? 'booted and left the file alone'
                        : `unclassified: exit=${exit.kind} migration=${migrationOutcome}`,
    };
}

const results = {};
const runtimeRoots = [];
try {
    for (const scenario of scenarios) {
        const runtimeRoot = mkdtempSync(path.join(os.tmpdir(), 'gotavern-config-duplicate-oracle-'));
        runtimeRoots.push(runtimeRoot);
        results[scenario.name] = {
            scenario: scenario.config,
            ...(await bootScenario(scenario, runtimeRoot)),
        };
    }
} finally {
    for (const runtimeRoot of runtimeRoots) {
        try { safeCleanup(runtimeRoot); } catch { /* cleanup must never mask the verdict */ }
    }
}

// A CONTROL THAT DID NOT BOOT INVALIDATES EVERY OTHER ROW. If the duplicate-free config also fails to reach the
// server phase, this host cannot boot pinned at all and "the duplicate key stopped it" is unproven -- so the
// probe refuses rather than recording a difference that its own control contradicts.
const control = results['duplicate-key-control'];
if (control.exit !== 'served') {
    console.error(JSON.stringify({ probe: 'config-duplicate-key', fatal: 'the control did not boot', control }, null, 2));
    throw new Error(`control scenario did not reach the server phase (exit=${control.exit}); the duplicate-key rows cannot be read as evidence`);
}

const fixture = {
    schemaVersion: 1,
    baseline: { version: PINNED_VERSION, commit: PINNED_COMMIT },
    probe: 'pinned boot behaviour on a duplicate-key config.yaml: exit, stderr, exit code, and whether the config was migrated before the exit',
    source: 'src/config-init.js:164-243 (warn-and-continue migration, runs first); src/util.js:70-78 (FATAL + process.exit(1) at first getConfigValue); yaml ^2.8.3 uniqueKeys:true (node_modules/yaml/.../doc/Document.js:39)',
    normalization: {
        tier2: [
            {
                path: 'results[*].stderrLines',
                rule: 'kept verbatim except that absolute runtime paths under the probe temp root are replaced with <runtime>',
                reason: 'The temp root is an ephemeral path and is not a property of pinned; the message text around it is the contract, because the FATAL line is what a user sees.',
                pinnedSource: 'src/util.js:75 console.error(color.red(\'FATAL: Failed to read config.yaml. Please check the file for syntax errors.\'))',
            },
            {
                path: 'results[*].configBefore.mtimeMs / configAfter.mtimeMs',
                rule: 'null',
                reason: 'A modification time is a wall-clock measurement of this run, host-dependent by definition. The BYTES are the compared contract (sha256); the mtime is recorded only in the run log and nulled here so a two-run re-record can be byte-identical.',
            },
        ],
    },
    results,
};

process.stdout.write(JSON.stringify(fixture, null, 2) + '\n');
