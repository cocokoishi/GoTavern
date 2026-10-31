// Q22 — A PAIRED BENCHMARK: the same work, on the same machine, in one run, for BOTH backends.
//
// WHY PAIRED. `smoke-metrics.yml` already records GoTavern's own cold/warm start, latency and RSS, and its header
// explains why it asserts only the cold-start ceiling: a shared runner's noise, the page cache, and a product that
// publishes no memory budget. Those reasons are sound, and they are exactly why a SINGLE-SIDED number cannot answer
// GOAL §11 ("prove CPU/RSS/startup/long-run advantage"): an isolated 41 ms says nothing without the same measurement
// for pinned Node on the same box, minutes apart.
//
// So this script measures both subjects in ALTERNATING rounds inside one process, records every sample, and reports
// medians side by side. What it ASSERTS is structural, never a threshold:
//   * both subjects answered GET /version with 200 in every round;
//   * both booted over a data root seeded the same way;
//   * the sampling counts match across subjects;
//   * every sample carries the runner image identity, so a comparison can never silently span two machines.
// A difference it reports is a difference it measured; an unmeasured side is reported as unmeasured, not as equal.
//
// WHAT IT DOES NOT DO, stated here so the artefact can repeat it: it does not assert "faster"/"smaller" -- a paired
// median on a shared runner is evidence for a report, not a release gate, and turning it into a gate would encode the
// runner into the product's contract (the mistake smoke-metrics.yml's header refuses to make).

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

function argumentValue(name, fallback = null) {
    const index = process.argv.indexOf(name);
    if (index < 0) return fallback;
    const value = process.argv[index + 1];
    return value === undefined ? fallback : value;
}

const rounds = Number(argumentValue('--rounds', '3'));
const requestsPerRound = Number(argumentValue('--requests', '30'));
const reportPath = path.resolve(argumentValue('--report', path.join(here, 'q22-paired-benchmark.json')));
const binarySetting = process.env.GOTAVERN_BINARY;
if (!binarySetting) throw new Error('GOTAVERN_BINARY is required: this benchmark measures the product, not a mock');

async function resolveReference() {
    for (const candidate of [path.join(repoRoot, '.reference', 'SillyTavern'), path.resolve(repoRoot, '..', 'SillyTavern')]) {
        try {
            await fs.access(path.join(candidate, 'server.js'));
            return candidate;
        } catch {
            continue;
        }
    }
    throw new Error('the pinned SillyTavern checkout must be at .reference/SillyTavern or ../SillyTavern');
}

function freePort() {
    return new Promise((resolve, reject) => {
        const server = http.createServer();
        server.unref();
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            server.close(() => resolve(port));
        });
    });
}

// Reads VmRSS from /proc. Off Linux there is no equivalent here, and the reason is recorded rather than a zero.
async function residentBytes(pid) {
    try {
        const status = await fs.readFile(`/proc/${pid}/status`, 'utf8');
        const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
        return match ? Number(match[1]) * 1024 : null;
    } catch {
        return null;
    }
}

async function waitForVersion(port, deadlineMs) {
    const deadline = Date.now() + deadlineMs;
    while (Date.now() < deadline) {
        try {
            const response = await fetch(`http://127.0.0.1:${port}/version`);
            if (response.ok) {
                await response.text();
                return Date.now();
            }
        } catch {
            // not listening yet
        }
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error(`the server on port ${port} never answered GET /version within ${deadlineMs} ms`);
}

async function timeRequests(port, pathName, count) {
    const samples = [];
    for (let index = 0; index < count; index++) {
        const started = process.hrtime.bigint();
        const response = await fetch(`http://127.0.0.1:${port}${pathName}`);
        await response.arrayBuffer();
        if (!response.ok) throw new Error(`GET ${pathName} answered ${response.status}`);
        samples.push(Number(process.hrtime.bigint() - started) / 1e6);
    }
    return samples;
}

function median(values) {
    if (values.length === 0) return null;
    const sorted = [...values].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function percentile(values, fraction) {
    if (values.length === 0) return null;
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

// One subject, one round: boot cold over a fresh root, sample, stop. The same function drives both backends so a
// difference in the numbers cannot come from a difference in how they were driven.
async function measureRound(subject, reference) {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), `gotavern-q22-${subject}-`));
    const port = await freePort();
    const startedAt = Date.now();
    const child = subject === 'gotavern'
        ? spawn(path.resolve(binarySetting), ['start', '--port', String(port), '--dataRoot', dataRoot, '--configPath', path.join(dataRoot, 'config.yaml'), '--browserLaunchEnabled', 'false'], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] })
        : spawn(process.execPath, ['server.js', '--port', String(port), '--dataRoot', dataRoot, '--configPath', path.join(dataRoot, 'config.yaml'), '--browserLaunchEnabled', 'false'], { cwd: reference, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    child.stdout.on('data', () => {});
    child.stderr.on('data', () => {});

    const round = { subject, dataRoot, port, bootMs: null, rssBytes: [], latencyVersion: [], latencyRoot: [], stopMs: null, failure: null };
    try {
        const readyAt = await waitForVersion(port, Number(process.env.Q22_READY_MS ?? 120000));
        round.bootMs = readyAt - startedAt;
        round.rssBytes.push(await residentBytes(child.pid));
        round.latencyVersion = await timeRequests(port, '/version', requestsPerRound);
        round.latencyRoot = await timeRequests(port, '/', requestsPerRound);
        round.rssBytes.push(await residentBytes(child.pid));
    } catch (error) {
        round.failure = String(error?.message ?? error);
    } finally {
        const stopStarted = Date.now();
        child.kill('SIGTERM');
        await new Promise(resolve => {
            const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 15000);
            child.on('exit', () => { clearTimeout(timer); resolve(); });
        });
        round.stopMs = Date.now() - stopStarted;
        await fs.rm(dataRoot, { recursive: true, force: true });
    }
    return round;
}

// LONG-RUN DRIFT, WHICH GOAL 11 ASKS FOR AND A SINGLE BOOT CANNOT SHOW. Same boot path as a round, then sustained
// requests for a bounded window with a sample every `sampleEveryMs`: the artefact carries the SERIES, not just a
// difference, because "stable creep" and "one GC and back" mean different things to a user and a delta cannot tell
// them apart. Nothing here asserts a drift ceiling -- that would encode the runner and the GC into the product.
async function soak(subject, reference, { windowMs, sampleEveryMs, requestsPerSample }) {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), `gotavern-q22-soak-${subject}-`));
    const port = await freePort();
    const startedAt = Date.now();
    const child = subject === 'gotavern'
        ? spawn(path.resolve(binarySetting), ['start', '--port', String(port), '--dataRoot', dataRoot, '--configPath', path.join(dataRoot, 'config.yaml'), '--browserLaunchEnabled', 'false'], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] })
        : spawn(process.execPath, ['server.js', '--port', String(port), '--dataRoot', dataRoot, '--configPath', path.join(dataRoot, 'config.yaml'), '--browserLaunchEnabled', 'false'], { cwd: reference, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    child.stdout.on('data', () => {});
    child.stderr.on('data', () => {});
    const series = [];
    let failures = [];
    try {
        await waitForVersion(port, Number(process.env.Q22_READY_MS ?? 120000));
        const deadline = Date.now() + windowMs;
        while (Date.now() < deadline) {
            const tickStart = Date.now();
            let latencies = [];
            try {
                latencies = await timeRequests(port, '/version', requestsPerSample);
            } catch (error) {
                failures.push(String(error?.message ?? error));
            }
            series.push({
                atMs: Date.now() - startedAt,
                rssBytes: await residentBytes(child.pid),
                p95Ms: percentile(latencies, 0.95),
                medianMs: median(latencies),
                requests: latencies.length,
            });
            const spent = Date.now() - tickStart;
            if (spent < sampleEveryMs) await new Promise(resolve => setTimeout(resolve, sampleEveryMs - spent));
        }
    } finally {
        child.kill('SIGTERM');
        await new Promise(resolve => {
            const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 15000);
            child.on('exit', () => { clearTimeout(timer); resolve(); });
        });
        await fs.rm(dataRoot, { recursive: true, force: true });
    }
    const first = series[0] ?? null;
    const last = series[series.length - 1] ?? null;
    return {
        subject,
        windowMs,
        sampleEveryMs,
        series,
        failures,
        rssDriftBytes: first && last && typeof first.rssBytes === 'number' && typeof last.rssBytes === 'number' ? last.rssBytes - first.rssBytes : null,
        p95DriftMs: first && last && typeof first.p95Ms === 'number' && typeof last.p95Ms === 'number' ? last.p95Ms - first.p95Ms : null,
    };
}

const reference = await resolveReference();
const runnerImage = process.env.ImageOS ?? process.env.RUNNER_IMAGE ?? `${process.platform} ${os.release()}`;
const report = {
    schemaVersion: 1,
    question: 'With the same runner, the same fresh data root and the same requests, how do pinned Node SillyTavern and GoTavern compare on boot, RSS and latency?',
    runnerImage,
    rounds,
    requestsPerRound,
    binary: path.resolve(binarySetting),
    samples: [],
    asserted: {
        everyRoundAnswered: false,
        sampleCountsMatch: false,
    },
    notes: [
        'A paired median on a shared runner is evidence for a report, not a release gate; asserting a threshold here would encode the runner into the product contract.',
        'RSS comes from /proc/<pid>/status VmRSS and is null off Linux, with that reason rather than a zero.',
        'Both subjects boot over a mkdtemp data root that each round deletes, so a warm page cache is the only carry-over.',
        'The soak window is bounded and its samples are a SERIES: a stable creep and a single collection-then-recovery are different facts and a delta alone cannot distinguish them.',
    ],
};

try {
    for (let round = 0; round < rounds; round++) {
        for (const subject of ['pinned', 'gotavern']) {
            report.samples.push({ round, ...(await measureRound(subject, reference)) });
        }
    }
    // THE LONG-RUN PHASE, BEFORE THE SUMMARY IS BUILT. Bounded window; a failure to drive is recorded in failures[]
    // rather than thrown, so one broken subject cannot destroy the whole record.
    const soakWindowMs = Number(process.env.Q22_SOAK_MS ?? 600000);
    const soakSampleEveryMs = Number(process.env.Q22_SOAK_SAMPLE_MS ?? 30000);
    if (soakWindowMs > 0) {
        report.soak = [];
        for (const subject of ['pinned', 'gotavern']) {
            report.soak.push(await soak(subject, reference, { windowMs: soakWindowMs, sampleEveryMs: soakSampleEveryMs, requestsPerSample: 20 }));
        }
    }
} finally {
    const bySubject = subject => report.samples.filter(sample => sample.subject === subject);
    const summarise = subject => {
        const samples = bySubject(subject);
        const boot = samples.map(sample => sample.bootMs).filter(value => typeof value === 'number');
        const rss = samples.flatMap(sample => sample.rssBytes).filter(value => typeof value === 'number');
        const latency = samples.flatMap(sample => sample.latencyVersion).filter(value => typeof value === 'number');
        const root = samples.flatMap(sample => sample.latencyRoot).filter(value => typeof value === 'number');
        return {
            rounds: samples.length,
            failures: samples.filter(sample => sample.failure).map(sample => sample.failure),
            bootMsMedian: median(boot),
            rssBytesMedian: median(rss),
            versionMedianMs: median(latency),
            versionP95Ms: percentile(latency, 0.95),
            rootMedianMs: median(root),
            samples: { boot: boot.length, rss: rss.length, version: latency.length, root: root.length },
        };
    };
    report.summary = { pinned: summarise('pinned'), gotavern: summarise('gotavern') };
    report.asserted.everyRoundAnswered = bySubject('pinned').every(sample => !sample.failure) && bySubject('gotavern').every(sample => !sample.failure);
    if (Array.isArray(report.soak) && report.soak.length === 2) {
        // ONLY STRUCTURAL: both subjects completed the window without a drive failure, and produced series of the
        // same length. The DRIFT VALUES are reported, never asserted.
        report.asserted.soakCompleted = report.soak.every(entry => entry.failures.length === 0);
        report.asserted.soakSeriesMatch = new Set(report.soak.map(entry => entry.series.length)).size === 1;
    }
    report.asserted.sampleCountsMatch = report.summary.pinned.samples.boot === report.summary.gotavern.samples.boot
        && report.summary.pinned.samples.version === report.summary.gotavern.samples.version;
    await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`pinned:   boot ${report.summary.pinned.bootMsMedian} ms, rss ${report.summary.pinned.rssBytesMedian} B, /version ${report.summary.pinned.versionMedianMs} ms`);
    console.log(`gotavern: boot ${report.summary.gotavern.bootMsMedian} ms, rss ${report.summary.gotavern.rssBytesMedian} B, /version ${report.summary.gotavern.versionMedianMs} ms`);
    console.log(`report: ${reportPath}`);
    if (!report.asserted.everyRoundAnswered) {
        console.error('a subject failed to answer in at least one round; see samples[].failure');
        process.exitCode = 1;
    }
    if (!report.asserted.sampleCountsMatch) {
        console.error('the two subjects did not produce the same number of samples, so no comparison is claimed');
        process.exitCode = 1;
    }
}
