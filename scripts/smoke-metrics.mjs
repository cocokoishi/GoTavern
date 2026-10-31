#!/usr/bin/env node
// Record the smoke/resource numbers for the release binary.
//
// WHY THIS EXISTS. Release-acceptance item 13 ("resource benchmark is recorded") had no harness
// anywhere in the repository, so the line was marked NOT GATED. This script produces a RECORD, not a
// gate: it builds nothing (the workflow builds the exact release binary and stages it the way
// release.yml does), it boots that binary twice over ONE data root, and it writes every number it
// observed into a machine-readable file next to one printed table.
//
// WHAT IS ASSERTED, and why only these:
//
//   A1  cold start to /version <= --cold-start-ceiling-ms (default 60 s).
//       A cold start that takes a minute is not a slow runner, it is a HANG, and a hang is a
//       correctness failure of the artefact users download. The default is ~30x the number measured
//       on CI, so it cannot fail merely because the runner was busy; it can only fail because
//       startup stopped making progress.
//   A2  every recorded number is present and finite.
//       A record with a missing or NaN measurement would READ as evidence while proving nothing, so
//       the script refuses to write it (AGENTS rule 7: never let a step that appears to have
//       happened stand unverified).
//   A3  /version answers the product's own version record, and the same binary prints one.
//       This is the CONTRACT that the thing being timed is the product, not a static handler or a
//       proxy that happens to answer 200.
//   A4  the fresh install seeded at least one file.
//       If the tree is empty, "seeded file count" measures an empty directory and the number is
//       decoration.
//
// WHAT IS REPORTED AND NOT ASSERTED, and why:
//
//   warmStartToVersionMs   A restart is EXPECTED to be faster, but "faster than cold" is a claim
//                          about the runner's page cache as much as about the product, and a
//                          threshold here would flake on a loaded runner.
//   version/root latency   Single-request wall-clock numbers on a shared VM. A p95 threshold would
//                          encode the runner's noise into the release contract. Recorded so a
//                          REGRESSION across runs is visible by eye.
//   rssBytes               Resident memory after boot. The product has no published memory contract,
//                          so inventing one here would be a promise nobody can keep.
//   seededFiles/Bytes      The COUNT is recorded because item 13 asks for it, but not thresholded: a
//                          change is a signal to review, not a failure to block a release on.
//   stopMs                 Graceful-shutdown duration, same argument.
//
// The record carries the RUNNER IMAGE identity, so a number is never compared across hosts silently.
// Nothing else host-specific is written: no hostname, no absolute paths, no pid.

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import {
    existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const USAGE = `usage: node scripts/smoke-metrics.mjs --binary <gotavern> --work-dir <dir> [options]

  --binary <path>               the built release binary (required)
  --work-dir <path>             scratch parent for data/ and logs/ (required; those two are removed)
  --install-dir <path>          the staged install root, used as the server's working directory
                                (default: the binary's own directory), because config.yaml resolves
                                against the working directory and a real install runs from there
  --out <path>                  where to write the record (default: smoke-metrics.json)
  --requests <n>                sequential requests per path (default: 50)
  --cold-start-ceiling-ms <n>   asserted cold-start ceiling (default: 60000)
  --port <n>                    listen port (default: an ephemeral free port)
`;

function parseArguments(argv) {
    const options = {
        binary: null,
        workDir: null,
        installDir: null,
        out: 'smoke-metrics.json',
        requests: 50,
        coldStartCeilingMs: 60000,
        port: 0,
    };
    for (let index = 0; index < argv.length; index += 1) {
        const name = argv[index];
        const take = () => {
            const value = argv[index + 1];
            if (value === undefined) {
                console.error(`${name} needs a value\n\n${USAGE}`);
                process.exit(2);
            }
            index += 1;
            return value;
        };
        switch (name) {
            case '--binary': options.binary = take(); break;
            case '--work-dir': options.workDir = take(); break;
            case '--install-dir': options.installDir = take(); break;
            case '--out': options.out = take(); break;
            case '--requests': options.requests = Number.parseInt(take(), 10); break;
            case '--cold-start-ceiling-ms': options.coldStartCeilingMs = Number.parseInt(take(), 10); break;
            case '--port': options.port = Number.parseInt(take(), 10); break;
            case '--help': case '-h': console.log(USAGE); process.exit(0); break;
            default:
                console.error(`unknown argument ${name}\n\n${USAGE}`);
                process.exit(2);
        }
    }
    if (!options.binary || !options.workDir) {
        console.error(USAGE);
        process.exit(2);
    }
    if (!Number.isFinite(options.requests) || options.requests < 1) {
        console.error('--requests must be a positive integer');
        process.exit(2);
    }
    if (!Number.isFinite(options.coldStartCeilingMs) || options.coldStartCeilingMs < 1) {
        console.error('--cold-start-ceiling-ms must be a positive integer');
        process.exit(2);
    }
    return options;
}

const options = parseArguments(process.argv.slice(2));
const binary = path.resolve(options.binary);
const installDir = path.resolve(options.installDir ?? path.dirname(binary));
const workDir = path.resolve(options.workDir);
const dataRoot = path.join(workDir, 'data');
const logsDir = path.join(workDir, 'logs');
const configPath = path.join(installDir, 'config.yaml');

// The readiness poll interval bounds the measurement error of every start time, so it is recorded
// with the numbers instead of being left implicit: a 20 ms poll cannot resolve a 5 ms difference.
const READINESS_POLL_MS = 20;
const REQUEST_TIMEOUT_MS = 30000;
const SHUTDOWN_WAIT_MS = 15000;

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function assertFiniteNumber(value, label) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`A2: the measurement "${label}" is ${value}; refusing to write a record that would read as evidence`);
    }
    return value;
}

async function choosePort() {
    if (options.port > 0) return options.port;
    const server = createServer();
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address();
    await new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
    return port;
}

// A tree census: file count and total bytes. Deliberately not hashed -- this is a resource record,
// not an idempotence check (release-qualification.yml owns that comparison).
function census(root) {
    let files = 0;
    let bytes = 0;
    const walk = absolute => {
        if (!existsSync(absolute)) return;
        for (const entry of readdirSync(absolute, { withFileTypes: true })) {
            const child = path.join(absolute, entry.name);
            if (entry.isDirectory()) {
                walk(child);
                continue;
            }
            files += 1;
            bytes += statSync(child).size;
        }
    };
    walk(root);
    return { files, bytes };
}

function readResidentBytes(pid) {
    if (process.platform !== 'linux') {
        return { rssBytes: null, rssUnavailableReason: 'resident memory is read from /proc, which exists only on Linux' };
    }
    try {
        const status = readFileSync(`/proc/${pid}/status`, 'utf8');
        const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
        if (!match) return { rssBytes: null, rssUnavailableReason: '/proc/<pid>/status has no VmRSS line' };
        return { rssBytes: Number.parseInt(match[1], 10) * 1024, rssUnavailableReason: null };
    } catch (error) {
        return { rssBytes: null, rssUnavailableReason: `reading /proc failed: ${error.message}` };
    }
}

function productVersion() {
    const result = spawnSync(binary, ['version', '--json'], { encoding: 'utf8', timeout: REQUEST_TIMEOUT_MS });
    if (result.status !== 0) {
        throw new Error(`A3: "${binary} version --json" exited ${result.status}: ${result.stderr ?? ''}`);
    }
    let parsed;
    try {
        parsed = JSON.parse(result.stdout);
    } catch (error) {
        throw new Error(`A3: "gotavern version --json" did not print JSON: ${error.message}`);
    }
    if (typeof parsed.gotavern_version !== 'string' || typeof parsed.sillytavern_version !== 'string') {
        throw new Error(`A3: the version record is missing gotavern_version/sillytavern_version: ${result.stdout}`);
    }
    return parsed;
}

// One boot of the real binary, timed from spawn to the first /version answer that carries the pinned
// SillyTavern version record. A3 is deliberately about THAT body: `/version` is a SillyTavern
// COMPATIBILITY endpoint (AGENTS rule 17 — GoTavern identity lives in `gotavern version`), so the
// contract is `pkgVersion` + `gitRevision`, not a GoTavern field. The first version of this script
// asserted a `sillytavern_version` member from memory, and the runner answered
// {"agent":...,"pkgVersion":"1.19.0","gitRevision":"06bde939f",...}: a measured correction, not a
// guess. The listen line the server prints is timestamped too, because it separates "the process
// started" from "startup finished and the socket accepted a connection".
async function boot({ port, logName, label, ceilingMs, asserted }) {
    const logPath = path.join(logsDir, logName);
    const chunks = [];
    const startedAt = process.hrtime.bigint();
    const elapsedMs = () => Number(process.hrtime.bigint() - startedAt) / 1e6;
    const child = spawn(binary, ['start', '--port', String(port), '--dataRoot', dataRoot, '--browserLaunchEnabled', 'false'], {
        cwd: installDir,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let listenAtMs = null;
    const record = chunk => {
        const text = chunk.toString();
        chunks.push(text);
        if (listenAtMs === null && /listening on IPv4/i.test(text)) listenAtMs = elapsedMs();
    };
    child.stdout.on('data', record);
    child.stderr.on('data', record);
    const flushLog = () => writeFileSync(logPath, chunks.join(''));

    const url = `http://127.0.0.1:${port}/version`;
    const deadline = Date.now() + ceilingMs;
    let versionBody = null;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) {
            flushLog();
            throw new Error(`the binary exited with code ${child.exitCode} before answering /version; ${logName} follows:\n${chunks.join('')}`);
        }
        try {
            const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
            const body = await response.text();
            if (response.status === 200) {
                versionBody = JSON.parse(body);
                break;
            }
        } catch {
            // Not listening yet, or the body is not JSON yet. Both mean "not ready".
        }
        await sleep(READINESS_POLL_MS);
    }
    const startToVersionMs = elapsedMs();
    if (versionBody === null) {
        await stop(child);
        flushLog();
        const why = asserted
            ? `A1: the ${label} boot did not answer /version within ${ceilingMs} ms. A start this slow is a HANG, not a slow runner.`
            : `the ${label} boot did not answer /version within ${ceilingMs} ms.`;
        throw new Error(`${why} ${logName} follows:\n${chunks.join('')}`);
    }
    if (typeof versionBody.pkgVersion !== 'string' || typeof versionBody.gitRevision !== 'string') {
        await stop(child);
        flushLog();
        throw new Error(`A3: /version answered 200 but its body is not the pinned SillyTavern version record: ${JSON.stringify(versionBody)}`);
    }
    return { child, startToVersionMs, startToListenMs: listenAtMs, versionBody, flushLog };
}

// Graceful stop, timed. SIGTERM first (the pinned launcher contract), then SIGKILL after a bounded
// wait so a wedged process cannot hang this job.
async function stop(child) {
    if (!child || child.exitCode !== null) return 0;
    const startedAt = process.hrtime.bigint();
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGTERM');
    const timedOut = await Promise.race([exited.then(() => false), sleep(SHUTDOWN_WAIT_MS).then(() => true)]);
    if (timedOut) {
        child.kill('SIGKILL');
        await exited;
    }
    return Number(process.hrtime.bigint() - startedAt) / 1e6;
}

// N SEQUENTIAL requests, one at a time, each fully consumed. Sequential on purpose: concurrent
// requests measure the queue, not the route, and this record is about single-request latency. The
// connection is reused, so connection setup is paid once; the first sample therefore includes it and
// is reported on its own as well.
async function measureLatency(port, route, samples) {
    const url = `http://127.0.0.1:${port}${route}`;
    const timings = [];
    const statuses = new Set();
    let bodyBytes = 0;
    for (let index = 0; index < samples; index += 1) {
        const startedAt = process.hrtime.bigint();
        const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
        const body = Buffer.from(await response.arrayBuffer());
        timings.push(Number(process.hrtime.bigint() - startedAt) / 1e6);
        statuses.add(response.status);
        if (index === 0) bodyBytes = body.length;
    }
    const sorted = [...timings].sort((left, right) => left - right);
    const at = fraction => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))];
    return {
        route,
        samples,
        statusCodes: [...statuses].sort(),
        bodyBytes,
        firstMs: timings[0],
        minMs: sorted[0],
        medianMs: at(0.5),
        p95Ms: at(0.95),
        maxMs: sorted[sorted.length - 1],
        meanMs: timings.reduce((total, value) => total + value, 0) / timings.length,
        samplesMs: timings,
    };
}

function hostIdentity() {
    return {
        // The runner image is the identity a future reader needs BEFORE comparing any number here.
        // ImageOS/ImageVersion are the runner-image variables GitHub sets; RUNNER_* name the job.
        runnerImage: process.env.ImageOS ?? null,
        runnerImageVersion: process.env.ImageVersion ?? null,
        runnerOs: process.env.RUNNER_OS ?? null,
        runnerArch: process.env.RUNNER_ARCH ?? null,
        workflow: process.env.GITHUB_WORKFLOW ?? null,
        runId: process.env.GITHUB_RUN_ID ?? null,
        runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
        sha: process.env.GITHUB_SHA ?? null,
        ref: process.env.GITHUB_REF ?? null,
        platform: process.platform,
        arch: process.arch,
        kernel: os.release(),
        cpuCount: os.cpus().length,
        totalMemoryBytes: os.totalmem(),
        nodeVersion: process.version,
    };
}

function pad(value, width) {
    return String(value).padEnd(width);
}

function printTable(record) {
    const rows = [];
    const add = (label, value, unit, verdict) => rows.push([label, String(value), unit, verdict]);
    add('coldStartToVersionMs', record.startup.cold.startToVersionMs.toFixed(1), 'ms', `ASSERTED <= ${record.budgets.coldStartCeilingMs}`);
    add('coldStartToListenMs', record.startup.cold.startToListenMs === null ? 'n/a' : record.startup.cold.startToListenMs.toFixed(1), 'ms', 'reported');
    add('warmStartToVersionMs', record.startup.warm.startToVersionMs.toFixed(1), 'ms', 'reported');
    add('warmStartToListenMs', record.startup.warm.startToListenMs === null ? 'n/a' : record.startup.warm.startToListenMs.toFixed(1), 'ms', 'reported');
    add('shutdownMs', record.startup.cold.stopMs.toFixed(1), 'ms', 'reported');
    add('GET /version median', record.latency.version.medianMs.toFixed(3), 'ms', 'reported');
    add('GET /version p95', record.latency.version.p95Ms.toFixed(3), 'ms', 'reported');
    add('GET /version max', record.latency.version.maxMs.toFixed(3), 'ms', 'reported');
    add('GET / median', record.latency.root.medianMs.toFixed(3), 'ms', 'reported');
    add('GET / p95', record.latency.root.p95Ms.toFixed(3), 'ms', 'reported');
    add('GET / max', record.latency.root.maxMs.toFixed(3), 'ms', 'reported');
    add('freshSeedFiles', record.freshInstall.files, 'files', 'reported (asserted > 0)');
    add('freshSeedBytes', record.freshInstall.bytes, 'bytes', 'reported');
    add('rssAfterColdBoot', record.memory.cold.rssBytes === null ? 'n/a' : record.memory.cold.rssBytes, 'bytes', 'reported');
    add('rssAfterWarmBoot', record.memory.warm.rssBytes === null ? 'n/a' : record.memory.warm.rssBytes, 'bytes', 'reported');
    const widths = [24, 15, 7, 24];
    console.log(['measurement', 'value', 'unit', 'status'].map((value, index) => pad(value, widths[index])).join(''));
    console.log(widths.map(width => '-'.repeat(width)).join(''));
    for (const row of rows) console.log(row.map((value, index) => pad(value, widths[index])).join(''));
}

async function main() {
    if (!existsSync(binary)) throw new Error(`the binary does not exist: ${binary}`);
    // A previous run's state is removed rather than reused: a warm boot over an older data root would
    // silently change what "cold" and "fresh" mean. config.yaml is a PRODUCT-created file (the release
    // archive contains none), so removing it is what makes this a fresh install.
    rmSync(dataRoot, { recursive: true, force: true });
    rmSync(logsDir, { recursive: true, force: true });
    mkdirSync(dataRoot, { recursive: true });
    mkdirSync(logsDir, { recursive: true });
    if (existsSync(configPath)) rmSync(configPath, { force: true });

    const version = productVersion();
    const port = await choosePort();
    const ceilingMs = options.coldStartCeilingMs;

    const record = {
        schemaVersion: 1,
        recordedAtUtc: new Date().toISOString(),
        product: {
            // Two identities, deliberately separate: the artefact's own (`gotavern version --json`)
            // and what the compatibility endpoint reports (`GET /version`). Recording only one would
            // leave a reader unable to tell which build produced these numbers.
            gotavernVersion: version.gotavern_version,
            sillytavernVersion: version.sillytavern_version,
            binaryBytes: statSync(binary).size,

        },
        host: hostIdentity(),
        method: {
            coldStart: 'spawn -> first HTTP 200 from GET /version whose body carries the pinned version record (pkgVersion + gitRevision)',
            warmStart: 'the same, on the SAME data root and install directory, after a graceful SIGTERM stop',
            latency: `${options.requests} SEQUENTIAL requests per path on a reused keep-alive connection, body fully consumed`,
            readinessPollMs: READINESS_POLL_MS,
            freshSeed: 'files and bytes under the data root immediately after the cold boot',
            installRoot: 'the staged install directory, which is also the server working directory, so config.yaml resolves where a real install keeps it',
        },
        budgets: {
            coldStartCeilingMs: ceilingMs,
            asserted: ['coldStartToVersionMs <= coldStartCeilingMs', 'every recorded number is finite', 'GET /version answers the pinned SillyTavern version record (pkgVersion + gitRevision)', 'freshInstall.files > 0'],
            notAsserted: ['warmStartToVersionMs', 'latency.version.*', 'latency.root.*', 'memory.*.rssBytes', 'freshInstall.bytes', 'startup.*.stopMs'],
        },
    };

    // ---- cold boot over a fresh data root ----------------------------------------------------
    const cold = await boot({ port, logName: 'cold-start.log', label: 'cold', ceilingMs, asserted: true });
    // Recorded from the FIRST answer, which is also the moment the cold-start number stops.
    record.product.versionEndpoint = {
        pkgVersion: cold.versionBody.pkgVersion,
        gitRevision: cold.versionBody.gitRevision,
        gitBranch: cold.versionBody.gitBranch ?? null,
        // `isLatest` is NOT recorded: it is a freshness flag that can depend on an upstream
        // comparison, so it is not a property of this artefact.
    };
    const coldRss = readResidentBytes(cold.child.pid);
    const freshSeed = census(dataRoot);
    const installAfterCold = census(installDir);
    const latencyVersion = await measureLatency(port, '/version', options.requests);
    const latencyRoot = await measureLatency(port, '/', options.requests);
    const coldStopMs = await stop(cold.child);
    cold.flushLog();

    // ---- warm boot over the SAME data root ---------------------------------------------------
    const warm = await boot({ port, logName: 'warm-start.log', label: 'warm', ceilingMs, asserted: false });
    const warmRss = readResidentBytes(warm.child.pid);
    const warmSeed = census(dataRoot);
    const warmStopMs = await stop(warm.child);
    warm.flushLog();

    record.startup = {
        cold: { startToVersionMs: cold.startToVersionMs, startToListenMs: cold.startToListenMs, stopMs: coldStopMs },
        warm: { startToVersionMs: warm.startToVersionMs, startToListenMs: warm.startToListenMs, stopMs: warmStopMs },
        warmMinusColdMs: warm.startToVersionMs - cold.startToVersionMs,
    };
    record.latency = { version: latencyVersion, root: latencyRoot };
    record.memory = { cold: coldRss, warm: warmRss };
    record.freshInstall = { files: freshSeed.files, bytes: freshSeed.bytes };
    record.install = {
        filesAfterColdBoot: installAfterCold.files,
        bytesAfterColdBoot: installAfterCold.bytes,
        // A second boot must not grow the seeded tree. The DELTA is reported (not asserted) so a
        // silent change is visible.
        seededFilesWarmMinusCold: warmSeed.files - freshSeed.files,
        seededBytesWarmMinusCold: warmSeed.bytes - freshSeed.bytes,
    };

    // ---- A2/A3: the record must be VALID before it is a record at all. These throw, because a
    // record with a missing number or a non-200 latency sample would read as evidence while proving
    // nothing, and a file that reads as evidence is worse than no file.
    assertFiniteNumber(record.startup.cold.startToVersionMs, 'startup.cold.startToVersionMs');
    assertFiniteNumber(record.startup.warm.startToVersionMs, 'startup.warm.startToVersionMs');
    assertFiniteNumber(record.latency.version.medianMs, 'latency.version.medianMs');
    assertFiniteNumber(record.latency.root.medianMs, 'latency.root.medianMs');
    assertFiniteNumber(record.freshInstall.files, 'freshInstall.files');
    for (const measurement of [record.latency.version, record.latency.root]) {
        for (const status of measurement.statusCodes) {
            if (status !== 200) throw new Error(`A3: ${measurement.route} answered ${status}`);
        }
    }

    // ---- A1/A4: the numbers themselves. A failure here is RECORDED IN THE ARTEFACT as well as
    // failing the job, so the numbers that produced the failure are never lost with the log.
    const failures = [];
    if (record.startup.cold.startToVersionMs > ceilingMs) {
        failures.push(`A1: the cold start took ${record.startup.cold.startToVersionMs.toFixed(0)} ms, over the ${ceilingMs} ms ceiling; a start this slow is a hang, not a slow runner`);
    }
    if (record.freshInstall.files < 1) {
        failures.push('A4: the fresh install seeded no files, so the seed measurement is about an empty directory');
    }
    record.verdict = Object.freeze({ passed: failures.length === 0, assertionFailures: failures });

    writeFileSync(options.out, `${JSON.stringify(record, null, 2)}\n`);
    printTable(record);
    console.log(`\nwrote ${options.out} -- cold ${record.startup.cold.startToVersionMs.toFixed(0)} ms, warm ${record.startup.warm.startToVersionMs.toFixed(0)} ms, runner ${record.host.runnerImage ?? 'unknown'} ${record.host.runnerImageVersion ?? ''}`);
    if (failures.length > 0) {
        for (const failure of failures) console.error(failure);
        process.exitCode = 1;
    }
}

try {
    await main();
} catch (error) {
    console.error(error.message ?? error);
    process.exitCode = 1;
}
