#!/usr/bin/env node
// A15 PROCESS-LEVEL PERFORMANCE HARNESS.
//
// WHY THIS EXISTS. The repository already has two measurement layers: `internal/server/bench_test.go` measures the
// Go handlers in-process (ns/op, B/op, allocs/op at 100/1,000/10,000 cards, chats, worlds, settings, 229 assets,
// provider assemble/marshal), and `scripts/smoke-metrics.mjs` records one binary's cold/warm start, RSS and
// latency. Neither answers the A15 question: what does a SHIPPED alpha.14 binary cost versus the current build,
// on THIS host, in the same run, including peak RSS, CPU user+system, GC activity, tail latency under concurrency
// and a soak drift? That is this script. It REUSES the existing layers rather than competing with them: the data
// roots come from tests/perf/fixturegen (same shapes as bench_test.go), process facts come from
// tests/perf/procstat (GetProcessMemoryInfo/GetProcessTimes on Windows, /proc on Linux), and in-process profiles
// remain the job of scripts/bench-profiles.mjs.
//
// WHAT A RUN PRODUCES. One JSON artifact per invocation under --out, containing:
//   env        OS/arch/CPU/RAM/GOMAXPROCS, Go/Node versions, git commit+branch+dirty, load label, run mode,
//              rounds, data scale, concurrency, build flags, and the RAW ARTIFACT PATH itself;
//   subjects   each binary: path, sha256, size, version identity, and whether it is a PUBLISHED artifact or a
//              locally rebuilt subject (never conflated);
//   rounds     every sample: boot ms, /version, /, representative data-route latencies, steady RSS, peak RSS,
//              CPU user/system ms, GC count/pause (gctrace method recorded), stopped mode;
//   summary    medians and p95 per subject/metric;
//   notes      what could NOT be measured here and why.
//
// MODES
//   --mode smoke        cold + warm boot rounds, latency, RSS/peak/CPU, GC counters          (default)
//   --mode scale        boot each generated scale tree and measure RSS/latency on a data route
//   --mode concurrency  in-flight 32/128 tail latency and throughput, CPU cost
//   --mode assets       229-path page load over HTTP (docs/frontend-startup-calls.md)
//   --mode soak         sustained mixed load with RSS drift and GC counters over --soak-minutes
//   --mode paired       alternating rounds of two subjects over identical fresh trees
//
// SUBJECTS (repeatable; order is measure order)
//   --subject name=<gotavern binary>          e.g. --subject alpha14=...\published\arm64\gotavern.exe
//   --pinned  name=<SillyTavern checkout>     e.g. --pinned node=<...\SillyTavern>   (Node must have node_modules)
//
// EXAMPLES
//   node scripts/a15-bench-suite.mjs --mode smoke --subject current=..\a15-work\build\gotavern-a15-arm64.exe \
//     --subject alpha14=..\a15-work\published\arm64\gotavern.exe --rounds 3 --load-label calibration
//   node scripts/a15-bench-suite.mjs --mode paired --pinned node=..\SillyTavern --subject current=<bin> \
//     --rounds 3 --requests 20
//
// HONEST LIMITS, repeated into every artifact:
//   - a SHARED host makes absolute ms meaningless; the artifact records --load-label and the harness refuses to
//     call a difference significant (it reports every sample, and medians with min/max);
//   - Windows cannot deliver SIGTERM to a console process, so a Windows stop is abrupt and the artifact says so;
//   - Go allocation totals are not observable from outside a process; gctrace gives GC count/pause/heap goals,
//     and B/op stays the in-process benchmark's number;
//   - Node (pinned subject) has no equivalent of GetProcessTimes per-thread accounting here: CPU comes from the
//     same process facts (Windows child process totals), GC counters are recorded only when --trace-gc is passed
//     to Node, and unmeasured fields are null, never zero.

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const HARNESS = 'scripts/a15-bench-suite.mjs';

// ---------------------------------------------------------------------------------------------------------------
// ARGUMENTS
// ---------------------------------------------------------------------------------------------------------------
function parseArguments(argv) {
    const options = {
        mode: 'smoke',
        subjects: [],
        pinned: [],
        dataRoot: null,
        scale: null,
        scaleArgs: [],
        rounds: 3,
        requests: 20,
        inflight: [32, 128],
        durationSeconds: 10,
        soakMinutes: 10,
        soakRate: 4,
        dataRoute: 'settings',
        workDir: path.join(repoRoot, '..', 'a15-work', 'run'),
        outDir: path.join(repoRoot, 'tests', 'perf', 'out', 'a15'),
        loadLabel: 'unlabelled',
        report: null,
        procstat: null,
        fixturegen: null,
        keepTrees: false,
        coldStartCeilingMs: 300000,
        gcTrace: true,
        maxMinutes: 120,
        quiet: false,
    };
    const value = (index, name) => {
        const next = argv[index + 1];
        if (next === undefined) {
            console.error(`${name} needs a value\n\n${USAGE}`);
            process.exit(2);
        }
        return next;
    };
    for (let index = 0; index < argv.length; index += 1) {
        const name = argv[index];
        switch (name) {
            case '--mode': options.mode = value(index, name); index += 1; break;
            case '--subject': options.subjects.push(value(index, name)); index += 1; break;
            case '--pinned': options.pinned.push(value(index, name)); index += 1; break;
            case '--data-root': options.dataRoot = path.resolve(value(index, name)); index += 1; break;
            case '--scale': options.scale = value(index, name); index += 1; break;
            case '--scale-args': options.scaleArgs.push(...value(index, name).split(',')); index += 1; break;
            case '--rounds': options.rounds = Number(value(index, name)); index += 1; break;
            case '--requests': options.requests = Number(value(index, name)); index += 1; break;
            case '--inflight': options.inflight = value(index, name).split(',').map(Number); index += 1; break;
            case '--duration': options.durationSeconds = Number(value(index, name)); index += 1; break;
            case '--soak-minutes': options.soakMinutes = Number(value(index, name)); index += 1; break;
            case '--soak-rate': options.soakRate = Number(value(index, name)); index += 1; break;
            case '--data-route': options.dataRoute = value(index, name); index += 1; break;
            case '--work-dir': options.workDir = path.resolve(value(index, name)); index += 1; break;
            case '--out': options.outDir = path.resolve(value(index, name)); index += 1; break;
            case '--load-label': options.loadLabel = value(index, name); index += 1; break;
            case '--report': options.report = path.resolve(value(index, name)); index += 1; break;
            case '--procstat': options.procstat = path.resolve(value(index, name)); index += 1; break;
            case '--fixturegen': options.fixturegen = path.resolve(value(index, name)); index += 1; break;
            case '--keep-trees': options.keepTrees = true; break;
            case '--cold-start-ceiling-ms': options.coldStartCeilingMs = Number(value(index, name)); index += 1; break;
            case '--no-gc-trace': options.gcTrace = false; break;
            case '--max-minutes': options.maxMinutes = Number(value(index, name)); index += 1; break;
            case '--quiet': options.quiet = true; break;
            case '--help': case '-h': console.log(USAGE); process.exit(0); break;
            default: console.error(`unknown argument ${name}\n\n${USAGE}`); process.exit(2);
        }
    }
    if (options.mode === 'profiles') options.mode = 'smoke';
    if (!['smoke', 'scale', 'concurrency', 'assets', 'soak', 'paired'].includes(options.mode)) {
        console.error(`unknown mode ${options.mode}\n\n${USAGE}`);
        process.exit(2);
    }
    if (options.subjects.length === 0 && options.pinned.length === 0) {
        console.error(`at least one --subject or --pinned is required\n\n${USAGE}`);
        process.exit(2);
    }
    if (options.mode === 'paired' && options.subjects.length + options.pinned.length < 2) {
        console.error('--mode paired needs two subjects (--subject and/or --pinned) to pair');
        process.exit(2);
    }
    return options;
}

const USAGE = `usage: node scripts/a15-bench-suite.mjs --mode <smoke|scale|concurrency|assets|soak|paired>
  --subject name=<gotavern binary>  [--subject name=<binary> ...]
  --pinned  name=<SillyTavern dir>  [--pinned name=<dir> ...]
  [--data-root DIR] [--scale <fixturegen scale>] [--scale-args k=v,...]
  [--rounds N] [--requests N] [--inflight 32,128] [--duration SECONDS]
  [--soak-minutes N] [--soak-rate RPS] [--data-route settings|characters|worlds|chats|recent]
  [--work-dir DIR] [--out DIR] [--load-label TEXT] [--report JSON] [--max-minutes N]
  [--keep-trees] [--quiet]

Exit codes: 0 all assertions held; 1 an assertion failed or a subject did not answer; 2 usage.`;

const options = parseArguments(process.argv.slice(2));
const log = message => { if (!options.quiet) process.stderr.write(`${message}\n`); };
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

// ---------------------------------------------------------------------------------------------------------------
// PROCESS SAFETY: no orphaned subject, ever.
//
// Every spawned subject is registered here, and THREE exit paths drop the whole set: normal completion, an
// exception, and a hard run deadline. The deadline is the answer to "a hang must fail by name instead of pinning
// the machine": without it a wedged readiness poll or a server that never answers keeps a 60 MB binary and a
// benchmark tree alive on a host with ~3 GB free. Windows cannot deliver SIGTERM, so kill() is an abrupt
// TerminateProcess there; the artifact records that per record.
// ---------------------------------------------------------------------------------------------------------------
const activeChildren = new Set();
function trackChild(child) {
    if (child.pid) activeChildren.add(child);
    child.once('exit', () => activeChildren.delete(child));
    return child;
}

async function terminateTrackedChildren(reason) {
    if (activeChildren.size === 0) return;
    log(`terminating ${activeChildren.size} subject(s): ${reason}`);
    for (const child of activeChildren) {
        try { child.kill(); } catch { /* already gone */ }
    }
    const deadline = Date.now() + 5_000;
    while (activeChildren.size > 0 && Date.now() < deadline) await sleep(50);
    activeChildren.clear();
}

let terminating = false;
async function shutdown(reason, exitCode) {
    if (terminating) return;
    terminating = true;
    await terminateTrackedChildren(reason);
    if (options.workDir) await cleanupWorkTrees();
    process.exit(exitCode);
}
process.on('SIGINT', () => { void shutdown('SIGINT', 130); });
process.on('SIGTERM', () => { void shutdown('SIGTERM', 143); });

// Bounded fetch: a subject that accepts a connection and never answers must fail the run BY NAME instead of
// hanging the harness. Every request in every mode goes through this.
const REQUEST_TIMEOUT_MS = 60_000;
function fetchWithTimeout(url, init = {}) {
    return fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
}

async function cleanupWorkTrees() {
    if (options.keepTrees) return;
    const treeRoot = path.join(options.workDir, 'trees');
    try {
        await fsp.rm(treeRoot, { recursive: true, force: true });
    } catch (error) {
        log(`warning: could not remove ${treeRoot}: ${error?.message ?? error}`);
    }
}

// ---------------------------------------------------------------------------------------------------------------
// PROCESS FACTS AND SUBJECTS
// ---------------------------------------------------------------------------------------------------------------
function runCapture(command, args, cwd) {
    const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
    if (result.status !== 0) return { ok: false, stdout: (result.stdout ?? '').trim(), stderr: (result.stderr ?? '').trim() };
    return { ok: true, stdout: (result.stdout ?? '').trim() };
}

function cpuFacts() {
    const cpus = os.cpus();
    return {
        model: cpus.length > 0 ? cpus[0].model : null,
        logicalCores: cpus.length,
        totalMemoryBytes: os.totalmem(),
        platform: process.platform,
        release: os.release(),
        arch: process.arch,
    };
}

function tryJson(command, args, cwd) {
    const result = runCapture(command, args, cwd);
    if (!result.ok) return null;
    try { return JSON.parse(result.stdout); } catch { return null; }
}

function gitFacts() {
    const head = runCapture('git', ['rev-parse', 'HEAD'], repoRoot);
    const branch = runCapture('git', ['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot);
    const status = runCapture('git', ['status', '--porcelain'], repoRoot);
    return {
        commit: head.ok ? head.stdout : null,
        branch: branch.ok ? branch.stdout : null,
        dirty: status.ok ? status.stdout.split('\n').filter(Boolean).length > 0 : null,
        dirtyFileCount: status.ok ? status.stdout.split('\n').filter(Boolean).length : null,
    };
}

function sha256File(file) {
    const hash = createHash('sha256');
    hash.update(fs.readFileSync(file));
    return hash.digest('hex');
}

function binaryVersion(binary) {
    const result = runCapture(binary, ['version'], path.dirname(binary));
    if (!result.ok) return null;
    const firstLine = result.stdout.split('\n')[0] ?? '';
    return firstLine.trim();
}

function parseSubject(flag, value) {
    const equals = value.indexOf('=');
    if (equals <= 0) {
        console.error(`${flag} needs name=value, got ${value}`);
        process.exit(2);
    }
    const name = value.slice(0, equals);
    const target = path.resolve(value.slice(equals + 1));
    if (!fs.existsSync(target)) {
        console.error(`${flag} ${name}: target does not exist: ${target}`);
        process.exit(2);
    }
    if (flag === '--subject') {
        return {
            name,
            kind: 'gotavern',
            binary: target,
            sizeBytes: fs.statSync(target).size,
            sha256: sha256File(target),
            version: binaryVersion(target),
            provenance: options.loadLabel,
        };
    }
    const server = path.join(target, 'server.js');
    if (!fs.existsSync(server)) {
        console.error(`--pinned ${name}: ${target} has no server.js`);
        process.exit(2);
    }
    if (!fs.existsSync(path.join(target, 'node_modules'))) {
        console.error(`--pinned ${name}: ${target} has no node_modules; the pinned server cannot boot (run npm ci)`);
        process.exit(2);
    }
    return {
        name,
        kind: 'pinned-node',
        binary: null,
        sourceRoot: target,
        version: 'pinned SillyTavern (server.js present)',
        sizeBytes: null,
        sha256: null,
        provenance: options.loadLabel,
    };
}

async function buildHelper(helperName) {
    const out = path.join(options.workDir, 'bin');
    await fsp.mkdir(out, { recursive: true });
    const target = path.join(out, process.platform === 'win32' ? `${helperName}.exe` : helperName);
    const source = helperName === 'a15-procstat' ? './tests/perf/procstat' : './tests/perf/fixturegen';
    log(`building ${helperName}...`);
    execFileSync('go', ['build', '-trimpath', '-o', target, source], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    return target;
}

async function resolveHelpers() {
    let procstat = options.procstat;
    if (!procstat) procstat = await buildHelper('a15-procstat');
    let fixturegen = options.fixturegen;
    if (!fixturegen) fixturegen = await buildHelper('a15-fixturegen');
    return { procstat, fixturegen };
}

// ---------------------------------------------------------------------------------------------------------------
// MEASUREMENT PRIMITIVES
// ---------------------------------------------------------------------------------------------------------------
function choosePort() {
    return new Promise((resolve, reject) => {
        const server = createServer();
        server.unref();
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const port = server.address().port;
            server.close(() => resolve(port));
        });
    });
}

function sampleProcess(procstat, pid) {
    const result = spawnSync(procstat, ['--pid', String(pid)], { encoding: 'utf8' });
    const text = (result.stdout ?? '').trim();
    if (text === '') return { ok: false, error: `procstat exit ${result.status}: ${(result.stderr ?? '').trim()}` };
    try { return JSON.parse(text); } catch { return { ok: false, error: `procstat emitted non-JSON: ${text.slice(0, 200)}` }; }
}

// A tiny cookie jar + CSRF handshake. Both runtimes require the same one for POST routes; the harness performs it
// OUTSIDE every timed window so the latency samples measure the route, not the handshake.
class HttpSession {
    constructor(origin) {
        this.origin = origin;
        this.cookies = new Map();
        this.csrfToken = null;
    }

    cookieHeader() {
        return [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
    }

    absorb(response) {
        for (const raw of response.headers.getSetCookie?.() ?? []) {
            const pair = raw.split(';')[0];
            const index = pair.indexOf('=');
            if (index > 0) this.cookies.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
        }
    }

    async handshake() {
        const response = await fetchWithTimeout(`${this.origin}/csrf-token`);
        this.absorb(response);
        const body = await response.text();
        try { this.csrfToken = JSON.parse(body).token ?? null; } catch { this.csrfToken = null; }
        if (!this.csrfToken) this.csrfToken = 'disabled';
        return this.csrfToken;
    }

    headers(extra = {}) {
        const headers = { ...extra };
        if (this.cookies.size > 0) headers.cookie = this.cookieHeader();
        if (this.csrfToken) headers['x-csrf-token'] = this.csrfToken;
        return headers;
    }

    async get(route) {
        const started = process.hrtime.bigint();
        const response = await fetchWithTimeout(`${this.origin}${route}`, { headers: this.headers() });
        const bytes = (await response.arrayBuffer()).byteLength;
        this.absorb(response);
        return { status: response.status, bytes, ms: Number(process.hrtime.bigint() - started) / 1e6 };
    }

    async post(route, body = {}) {
        const started = process.hrtime.bigint();
        const response = await fetchWithTimeout(`${this.origin}${route}`, {
            method: 'POST',
            headers: this.headers({ 'content-type': 'application/json' }),
            body: JSON.stringify(body),
        });
        const bytes = (await response.arrayBuffer()).byteLength;
        this.absorb(response);
        return { status: response.status, bytes, ms: Number(process.hrtime.bigint() - started) / 1e6 };
    }
}

const DATA_ROUTES = {
    settings: { method: 'POST', route: '/api/settings/get' },
    characters: { method: 'POST', route: '/api/characters/all' },
    worlds: { method: 'POST', route: '/api/worldinfo/list' },
    chats: { method: 'POST', route: '/api/characters/chats', body: { avatar_url: 'A15 Character.png' } },
    recent: { method: 'POST', route: '/api/chats/recent', body: { max: 20 } },
};

function percentile(sorted, fraction) {
    if (sorted.length === 0) return null;
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
    return sorted[index];
}

function median(values) {
    if (values.length === 0) return null;
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.floor(sorted.length / 2)];
}

function summariseSamples(values) {
    if (values.length === 0) return null;
    const sorted = [...values].sort((left, right) => left - right);
    return {
        count: sorted.length,
        min: sorted[0],
        median: median(sorted),
        max: sorted[sorted.length - 1],
        p95: percentile(sorted, 0.95),
        p99: percentile(sorted, 0.99),
    };
}

// gctrace parsing: `gc 12 @3.456s 5%: 0.005+0.20+0.003 ms clock, ...` -- count GCs and sum the pause phases.
const GC_TRACE = /^gc (\d+) @([\d.]+)s (\d+)%: ([\d.]+)\+([\d.]+)\+([\d.]+) ms clock/gm;

function parseGcTrace(text) {
    let match;
    let count = 0;
    let pauseMs = 0;
    let lastHeap = null;
    GC_TRACE.lastIndex = 0;
    while ((match = GC_TRACE.exec(text)) !== null) {
        count += 1;
        pauseMs += Number(match[4]) + Number(match[5]) + Number(match[6]);
    }
    for (const line of text.split('\n')) {
        if (!line.startsWith('gc ')) continue;
        const heap = / (\d+)->(\d+)->(\d+) MB/.exec(line);
        if (heap) lastHeap = { beforeMb: Number(heap[1]), goalMb: Number(heap[3]) };
    }
    return { gcCount: count, gcPauseMs: pauseMs, gcLastHeap: lastHeap, method: 'GODEBUG=gctrace=1 stderr parse (count, pause sum, last heap)' };
}

function parseNodeGcTrace(text) {
    let count = 0;
    for (const line of text.split('\n')) if (/\[\d+:[0-9a-f]+\].*GC|Scavenge|Mark-Compact/.test(line)) count += 1;
    return { gcCount: count, gcPauseMs: null, gcLastHeap: null, method: 'NODE --trace-gc stderr parse (count only; pause/objective not parsed)' };
}

async function waitForReady(origin, { seconds, label }) {
    const deadline = Date.now() + seconds * 1000;
    let last = null;
    while (Date.now() < deadline) {
        try {
            const response = await fetchWithTimeout(`${origin}/version`);
            if (response.status === 200) return;
            last = `GET /version -> ${response.status}`;
        } catch (error) {
            last = error?.message ?? String(error);
        }
        await sleep(20);
    }
    throw new Error(`${label} did not answer GET /version within ${seconds}s: ${last}`);
}

function subjectArgv(subject, { dataRoot, configPath, port }) {
    if (subject.kind === 'pinned-node') {
        return {
            command: process.execPath,
            args: [
                // --trace-gc is Node's analogue of Go's GODEBUG=gctrace=1 for the pinned subject: it makes the
                // GC-count field measured rather than null. Enabled for every pinned invocation alike.
                '--trace-gc',
                'server.js',
                '--configPath', configPath,
                '--dataRoot', dataRoot,
                '--listenAddressIPv4', '127.0.0.1',
                '--enableIPv4', 'true',
                '--enableIPv6', 'false',
                '--listen', 'false',
                '--port', String(port),
                '--browserLaunchEnabled', 'false',
                '--whitelistMode', 'false',
                '--heartbeatInterval', '0',
            ],
            cwd: subject.sourceRoot,
            env: { ...process.env, NODE_ENV: 'test' },
        };
    }
    return {
        command: subject.binary,
        args: [
            'start',
            '--port', String(port),
            '--dataRoot', dataRoot,
            '--configPath', configPath,
            '--browserLaunchEnabled', 'false',
            '--listen', 'false',
            '--enableIPv4', 'true',
            '--enableIPv6', 'false',
            '--listenAddressIPv4', '127.0.0.1',
            '--heartbeatInterval', '0',
        ],
        cwd: path.dirname(dataRoot),
        env: { ...process.env, GODEBUG: options.gcTrace ? 'gctrace=1' : 'gctrace=0' },
    };
}

/**
 * Boot one subject over one data root and measure it. The returned record is the unit every mode consumes.
 * The process is killed at the end; Windows has no SIGTERM delivery, which the record states instead of
 * pretending the stop was graceful.
 */
async function measureSubject(procstat, subject, { dataRoot, configPath, rounds, requests, dataRoute }) {
    const port = await choosePort();
    const origin = `http://127.0.0.1:${port}`;
    const { command, args, cwd, env } = subjectArgv(subject, { dataRoot, configPath, port });
    const logs = [];
    const started = process.hrtime.bigint();
    const child = trackChild(spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }));
    child.stdout.on('data', chunk => logs.push(chunk.toString('utf8')));
    child.stderr.on('data', chunk => logs.push(chunk.toString('utf8')));
    let bootError = null;
    try {
        await waitForReady(origin, { seconds: Math.ceil(options.coldStartCeilingMs / 1000), label: `${subject.name} (${subject.kind})` });
    } catch (error) {
        bootError = String(error.message ?? error);
    }
    const bootMs = Number(process.hrtime.bigint() - started) / 1e6;
    const record = {
        subject: subject.name,
        kind: subject.kind,
        origin,
        pid: child.pid ?? null,
        bootMs: bootError ? null : bootMs,
        bootError,
        bootToReadyMs: bootError ? null : bootMs,
        samples: [],
        latency: {},
        gc: null,
        stop: null,
        logTail: null,
    };
    if (bootError) {
        child.kill();
        record.logTail = logs.join('').slice(-4000);
        await sleep(50);
        return record;
    }

    const firstSample = sampleProcess(procstat, child.pid);
    record.samples.push({ at: 'ready', ...firstSample });
    const session = new HttpSession(origin);
    await session.handshake();

    // Warmup: the first requests pay page-cache/JIT/library setup, and they are measured by neither the latency
    // rows nor the steady RSS below. Recorded so the warmup count is part of the provenance.
    const warmupRequests = Math.max(3, Math.min(requests, 10));
    for (let index = 0; index < warmupRequests; index += 1) {
        await session.get('/version');
        await session.get('/');
        const route = DATA_ROUTES[dataRoute] ?? DATA_ROUTES.settings;
        await session.post(route.route, route.body ?? {});
    }

    const steadySample = sampleProcess(procstat, child.pid);
    record.samples.push({ at: 'steady-after-warmup', ...steadySample });
    record.rssSteadyBytes = steadySample.rssBytes ?? null;
    record.cpuAtSteady = { userMs: steadySample.cpuUserMs ?? null, systemMs: steadySample.cpuSystemMs ?? null };

    const latency = { version: [], root: [], data: [] };
    for (let index = 0; index < requests; index += 1) {
        latency.version.push(await session.get('/version'));
        latency.root.push(await session.get('/'));
        const route = DATA_ROUTES[dataRoute] ?? DATA_ROUTES.settings;
        latency.data.push(await session.post(route.route, route.body ?? {}));
    }
    for (const [key, samples] of Object.entries(latency)) {
        record.latency[key] = {
            ms: summariseSamples(samples.map(sample => sample.ms)),
            status: [...new Set(samples.map(sample => sample.status))],
            bytesMedian: median(samples.map(sample => sample.bytes)),
        };
    }

    const finalSample = sampleProcess(procstat, child.pid);
    record.samples.push({ at: 'final', ...finalSample });
    record.rssFinalBytes = finalSample.rssBytes ?? null;
    record.peakRssBytes = finalSample.peakRssBytes ?? null;
    record.cpu = {
        userMs: (finalSample.cpuUserMs ?? 0) - (steadySample.cpuUserMs ?? 0),
        systemMs: (finalSample.cpuSystemMs ?? 0) - (steadySample.cpuSystemMs ?? 0),
        absoluteUserMs: finalSample.cpuUserMs ?? null,
        absoluteSystemMs: finalSample.cpuSystemMs ?? null,
        method: finalSample.method ?? null,
    };
    record.gc = subject.kind === 'pinned-node' ? parseNodeGcTrace(logs.join('')) : parseGcTrace(logs.join(''));

    child.kill();
    await new Promise(resolve => {
        const timer = setTimeout(() => resolve(), 5000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    record.stop = { mode: process.platform === 'win32' ? 'abrupt-windows' : 'SIGTERM', platform: process.platform };
    record.logTail = logs.join('').slice(-2000);
    return record;
}

// ---------------------------------------------------------------------------------------------------------------
// DATA ROOTS
// ---------------------------------------------------------------------------------------------------------------
async function prepareTree({ label, fixturegen, scale, scaleArgs }) {
    const treeParent = path.join(options.workDir, 'trees', label);
    const configPath = path.join(treeParent, 'config.yaml');
    const dataRoot = path.join(treeParent, 'data');
    if (!options.dataRoot) {
        if (fs.existsSync(dataRoot)) {
            // A regenerated tree is required for reproducibility: NEVER reuse a tree from a previous run.
            await fsp.rm(treeParent, { recursive: true, force: true });
        }
        await fsp.mkdir(treeParent, { recursive: true });
        const args = ['--out', treeParent, '--scale', scale, ...scaleArgs];
        const result = spawnSync(fixturegen, args, { encoding: 'utf8' });
        if (result.status !== 0) throw new Error(`a15-fixturegen ${args.join(' ')} failed: ${result.stderr}`);
        const generated = JSON.parse(result.stdout.trim().split('\n').pop());
        return { dataRoot, configPath, generated, temporary: true };
    }
    // A caller-supplied data root is COPIED per round so every round starts from identical bytes and a run cannot
    // change its own input. The caller's tree is never written.
    const copyParent = path.join(options.workDir, 'trees', `${label}-copy`);
    await fsp.rm(copyParent, { recursive: true, force: true });
    await fsp.mkdir(copyParent, { recursive: true });
    await fsp.cp(options.dataRoot, path.join(copyParent, 'data'), { recursive: true });
    const suppliedConfig = path.join(path.dirname(options.dataRoot), 'config.yaml');
    if (fs.existsSync(suppliedConfig)) await fsp.copyFile(suppliedConfig, path.join(copyParent, 'config.yaml'));
    return { dataRoot: path.join(copyParent, 'data'), configPath: path.join(copyParent, 'config.yaml'), generated: null, temporary: true };
}

async function freshRoundTree({ label, fixturegen, scale, scaleArgs, round }) {
    const tree = await prepareTree({ label: `${label}-r${round}`, fixturegen, scale, scaleArgs });
    return tree;
}

// ---------------------------------------------------------------------------------------------------------------
// MODES
// ---------------------------------------------------------------------------------------------------------------
const environment = () => ({
    harness: HARNESS,
    git: gitFacts(),
    go: (() => {
        const version = runCapture('go', ['version'], repoRoot);
        return { version: version.ok ? version.stdout : null };
    })(),
    node: process.version,
    cpu: cpuFacts(),
    GOMAXPROCS: process.env.GOMAXPROCS ?? null,
    buildFlags: {
        gotavern: 'CGO_ENABLED=0, -trimpath, -ldflags "-s -w" (locally rebuilt subjects); published subjects are the release archives (BUILD-INFO.txt read and recorded per subject)',
    },
    loadLabel: options.loadLabel,
    runMode: options.mode,
    rounds: options.rounds,
    requestsPerPath: options.requests,
    inflight: options.inflight,
    dataScale: options.scale ?? (options.dataRoot ? `caller:${options.dataRoot}` : 'fixturegen default'),
    concurrency: options.mode === 'concurrency' ? options.inflight : null,
    startedAt: new Date().toISOString(),
});

function aggregate(records) {
    const bySubject = new Map();
    for (const record of records) {
        if (!bySubject.has(record.subject)) bySubject.set(record.subject, []);
        bySubject.get(record.subject).push(record);
    }
    const summary = {};
    for (const [subjectName, subjectRecords] of bySubject) {
        const coldRecords = subjectRecords.filter(record => record.bootKind === 'cold');
        const warmRecords = subjectRecords.filter(record => record.bootKind === 'warm');
        const bootFor = list => list.map(record => record.bootMs).filter(value => typeof value === 'number');
        const boot = bootFor(subjectRecords);
        const rss = subjectRecords.map(record => record.rssSteadyBytes).filter(value => typeof value === 'number');
        const peak = subjectRecords.map(record => record.peakRssBytes).filter(value => typeof value === 'number');
        const cpuUser = subjectRecords.map(record => record.cpu?.userMs).filter(value => typeof value === 'number');
        const cpuSystem = subjectRecords.map(record => record.cpu?.systemMs).filter(value => typeof value === 'number');
        const gcCounts = subjectRecords.map(record => record.gc?.gcCount).filter(value => typeof value === 'number');
        const latencyFor = key => subjectRecords.flatMap(record => {
            const row = record.latency?.[key];
            if (!row) return [];
            return [row.ms?.median, row.ms?.p95, row.ms?.max].filter(value => typeof value === 'number');
        });
        summary[subjectName] = {
            records: subjectRecords.length,
            bootMs: summariseSamples(boot),
            bootMsCold: summariseSamples(bootFor(coldRecords)),
            bootMsWarm: summariseSamples(bootFor(warmRecords)),
            rssSteadyBytes: summariseSamples(rss),
            peakRssBytes: summariseSamples(peak),
            cpuUserMs: summariseSamples(cpuUser),
            cpuSystemMs: summariseSamples(cpuSystem),
            gcCount: summariseSamples(gcCounts),
            versionMedianMs: summariseSamples(latencyFor('version')),
            rootMedianMs: summariseSamples(latencyFor('root')),
            dataMedianMs: summariseSamples(latencyFor('data')),
        };
    }
    return summary;
}

async function writeArtifact(mode, payload) {
    await fsp.mkdir(options.outDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const artifactPath = options.report ?? path.join(options.outDir, `${mode}-${stamp}.json`);
    const document = {
        schemaVersion: 1,
        mode,
        environment: environment(),
        subjects: subjects.map(subject => ({
            name: subject.name,
            kind: subject.kind,
            binary: subject.binary ?? null,
            sourceRoot: subject.sourceRoot ?? null,
            sha256: subject.sha256 ?? null,
            sizeBytes: subject.sizeBytes ?? null,
            version: subject.version ?? null,
            provenance: subject.provenance,
        })),
        parameters: {
            mode,
            rounds: options.rounds,
            requestsPerPath: options.requests,
            inflight: options.inflight,
            durationSeconds: options.durationSeconds,
            soakMinutes: options.soakMinutes,
            soakRate: options.soakRate,
            dataRoute: options.dataRoute,
            scale: options.scale,
            scaleArgs: options.scaleArgs,
            dataRootSupplied: options.dataRoot,
            gcTrace: options.gcTrace,
            workDir: options.workDir,
        },
        artifactPath,
        payload,
        notes: [
            'Absolute milliseconds on a shared host are comparable only WITHIN this run (same host, same data, alternating or same-order rounds); the --load-label field says whether the host was quiet.',
            'Windows cannot deliver SIGTERM to a console process, so Windows stops are abrupt (recorded in each record.stop).',
            'Go allocation totals are not observable from outside a process; gctrace gives GC count/pause/heap-goal. B/op remains the in-process benchmark number (scripts/bench-profiles.mjs).',
            'pinned Node GC counters are only recorded when Node emits --trace-gc lines; otherwise null, never zero.',
            'This harness changes no product code and caches nothing.',
        ],
    };
    await fsp.writeFile(artifactPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
    return artifactPath;
}

async function modeSmoke({ procstat, fixturegen }) {
    const records = [];
    for (let round = 0; round < options.rounds; round += 1) {
        const order = round % 2 === 0 ? subjects : [...subjects].reverse();
        for (const subject of order) {
            const tree = await freshRoundTree({ label: `smoke-${subject.name}`, fixturegen, scale: options.scale ?? 'base', scaleArgs: options.scaleArgs, round });
            log(`[smoke ${round + 1}/${options.rounds}] ${subject.name} (${subject.kind}) over ${tree.generated ? tree.generated.files + ' files' : 'caller tree'}`);
            const cold = await measureSubject(procstat, subject, { dataRoot: tree.dataRoot, configPath: tree.configPath, rounds: options.rounds, requests: options.requests, dataRoute: options.dataRoute });
            cold.bootKind = 'cold';
            records.push(cold);
            // Warm restart on the same data root: the second boot's page cache and seeded tree differ from cold.
            const warm = await measureSubject(procstat, subject, { dataRoot: tree.dataRoot, configPath: tree.configPath, rounds: options.rounds, requests: options.requests, dataRoute: options.dataRoute });
            warm.bootKind = 'warm';
            records.push(warm);
        }
    }
    const artifactPath = await writeArtifact('smoke', { records, summary: aggregate(records) });
    return { artifactPath, records };
}

async function modeScale({ procstat, fixturegen }) {
    // Each scale is one generated tree, one subject per scale unless several subjects are named (then each round
    // copies the tree). The scales mirror internal/server/bench_test.go's M2 workload names where one exists.
    const scales = options.scale
        ? [{ scale: options.scale, scaleArgs: options.scaleArgs }]
        : [
            { scale: 'cards', scaleArgs: ['--cards', '100'] },
            { scale: 'cards', scaleArgs: ['--cards', '1000'] },
            { scale: 'cards', scaleArgs: ['--cards', '10000'] },
            { scale: 'chats', scaleArgs: ['--chats', '10', '--chat-bytes', '2097152'] },
            { scale: 'chats-large', scaleArgs: ['--chats', '1', '--chat-messages', '2000', '--chat-bytes', '4194304'] },
            { scale: 'worlds', scaleArgs: ['--worlds', '1000', '--world-bytes', '8192'] },
            { scale: 'settings', scaleArgs: ['--files-per-dir', '100', '--file-bytes', '4096'] },
            { scale: 'complex-preset' },
            { scale: 'mixed-large' },
        ];
    const records = [];
    for (const [index, entry] of scales.entries()) {
        for (const subject of subjects) {
            const tree = await prepareTree({ label: `scale-${index}-${entry.scale}-${subject.name}`, fixturegen, scale: entry.scale, scaleArgs: entry.scaleArgs });
            const subjectScale = tree.generated?.scale ?? entry.scale;
            log(`[scale ${index + 1}/${scales.length}] ${subject.name} over ${subjectScale} (${tree.generated?.files ?? '?'} files, ${tree.generated?.bytes ?? '?'} bytes)`);
            const record = await measureSubject(procstat, subject, { dataRoot: tree.dataRoot, configPath: tree.configPath, rounds: 1, requests: options.requests, dataRoute: options.dataRoute });
            record.scale = subjectScale;
            record.scaleArgs = entry.scaleArgs;
            record.fixture = tree.generated;
            records.push(record);
            if (!options.keepTrees && tree.temporary) await fsp.rm(path.dirname(tree.dataRoot), { recursive: true, force: true });
        }
    }
    const artifactPath = await writeArtifact('scale', { records, summary: aggregate(records) });
    return { artifactPath, records };
}

async function modeConcurrency({ procstat, fixturegen }) {
    const route = DATA_ROUTES[options.dataRoute] ?? DATA_ROUTES.settings;
    const results = [];
    for (const subject of subjects) {
        const tree = await prepareTree({ label: `concurrency-${subject.name}`, fixturegen, scale: options.scale ?? 'mixed-large', scaleArgs: options.scaleArgs });
        const port = await choosePort();
        const origin = `http://127.0.0.1:${port}`;
        const { command, args, cwd, env } = subjectArgv(subject, { dataRoot: tree.dataRoot, configPath: tree.configPath, port });
        const child = trackChild(spawn(command, args, { cwd, env, stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true }));
        try {
            await waitForReady(origin, { seconds: 300, label: subject.name });
            const session = new HttpSession(origin);
            await session.handshake();
            const before = sampleProcess(procstat, child.pid);
            for (const inflight of options.inflight) {
                const latencies = [];
                const statuses = new Set();
                let errors = 0;
                const deadline = Date.now() + options.durationSeconds * 1000;
                const started = process.hrtime.bigint();
                const worker = async () => {
                    while (Date.now() < deadline) {
                        const began = process.hrtime.bigint();
                        try {
                            const response = route.method === 'POST'
                                ? await session.post(route.route, route.body ?? {})
                                : await session.get(route.route);
                            statuses.add(response.status);
                            latencies.push(Number(process.hrtime.bigint() - began) / 1e6);
                        } catch {
                            errors += 1;
                        }
                    }
                };
                await Promise.all(Array.from({ length: inflight }, () => worker()));
                const elapsedSeconds = Number(process.hrtime.bigint() - started) / 1e9;
                const sorted = latencies.sort((left, right) => left - right);
                results.push({
                    subject: subject.name,
                    kind: subject.kind,
                    inflight,
                    durationSeconds: elapsedSeconds,
                    requests: sorted.length,
                    errors,
                    statuses: [...statuses],
                    throughputPerSecond: sorted.length / elapsedSeconds,
                    latencyMs: {
                        median: median(sorted),
                        p95: percentile(sorted, 0.95),
                        p99: percentile(sorted, 0.99),
                        max: sorted.length > 0 ? sorted[sorted.length - 1] : null,
                    },
                });
            }
            const after = sampleProcess(procstat, child.pid);
            results.push({
                subject: subject.name,
                kind: subject.kind,
                cpuDelta: {
                    userMs: (after.cpuUserMs ?? 0) - (before.cpuUserMs ?? 0),
                    systemMs: (after.cpuSystemMs ?? 0) - (before.cpuSystemMs ?? 0),
                },
                rssSteadyBytes: before.rssBytes ?? null,
                peakRssBytes: after.peakRssBytes ?? null,
            });
        } finally {
            child.kill();
            await sleep(200);
            if (!options.keepTrees && tree.temporary) await fsp.rm(path.dirname(tree.dataRoot), { recursive: true, force: true });
        }
    }
    const artifactPath = await writeArtifact('concurrency', { results });
    return { artifactPath, records: results };
}

function parseAssetManifest() {
    // Mirrors internal/server/bench_test.go's benchStaticManifest: the document is the manifest, so its METHOD
    // column decides the replay method and the count is asserted against the recorded 229. A page load is NOT 229
    // GETs: startup calls include POST routes (their own handler answers 200) and a few cosmetic non-2xx rows, so
    // an exact-GET filter measures a different page than the committed benchmark does.
    const document = path.join(repoRoot, 'docs', 'frontend-startup-calls.md');
    const text = fs.readFileSync(document, 'utf8');
    const manifest = [];
    const methods = ['GET', 'POST', 'PUT', 'DELETE', 'HEAD', 'OPTIONS'];
    for (const rawLine of text.split('\n')) {
        if (!rawLine.startsWith('| ')) continue;
        const fields = rawLine.split('|').map(field => field.trim());
        if (fields.length < 3) continue;
        const method = fields[1].toUpperCase();
        if (!methods.includes(method)) continue;
        const asset = fields[2].replace(/`/g, '');
        if (!asset.startsWith('/')) continue;
        manifest.push({ method, path: asset });
    }
    if (manifest.length !== 229) throw new Error(`docs/frontend-startup-calls.md enumerates ${manifest.length} paths; the recorded page load is 229`);
    return manifest;
}

async function modeAssets({ procstat, fixturegen }) {
    const manifest = parseAssetManifest();
    const results = [];
    for (const subject of subjects) {
        const tree = await prepareTree({ label: `assets-${subject.name}`, fixturegen, scale: options.scale ?? 'base', scaleArgs: options.scaleArgs });
        const port = await choosePort();
        const origin = `http://127.0.0.1:${port}`;
        const { command, args, cwd, env } = subjectArgv(subject, { dataRoot: tree.dataRoot, configPath: tree.configPath, port });
        const child = trackChild(spawn(command, args, { cwd, env, stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true }));
        try {
            await waitForReady(origin, { seconds: 300, label: subject.name });
            const session = new HttpSession(origin);
            await session.handshake();
            const before = sampleProcess(procstat, child.pid);
            const started = process.hrtime.bigint();
            const rows = [];
            for (const entry of manifest) {
                const began = process.hrtime.bigint();
                try {
                    const response = await fetchWithTimeout(`${origin}${entry.path}`, { method: entry.method, headers: session.headers() });
                    const bytes = (await response.arrayBuffer()).byteLength;
                    rows.push({ path: entry.path, method: entry.method, status: response.status, bytes, ms: Number(process.hrtime.bigint() - began) / 1e6 });
                } catch (error) {
                    rows.push({ path: entry.path, method: entry.method, error: String(error?.message ?? error) });
                }
            }
            const after = sampleProcess(procstat, child.pid);
            rows.sort((left, right) => (left.ms ?? 0) - (right.ms ?? 0));
            const okRows = rows.filter(row => row.status >= 200 && row.status < 300);
            results.push({
                subject: subject.name,
                kind: subject.kind,
                pageLoadMs: Number(process.hrtime.bigint() - started) / 1e6,
                requests: rows.length,
                non2xx: rows.filter(row => !(row.status >= 200 && row.status < 300)).map(row => ({ path: row.path, status: row.status })),
                bytesDecoded: rows.reduce((sum, row) => sum + (row.bytes ?? 0), 0),
                okStatusCount: okRows.length,
                latencyMs: summariseSamples(rows.map(row => row.ms).filter(value => typeof value === 'number')),
                slowest: rows.slice(-5),
                cpuDelta: {
                    userMs: (after.cpuUserMs ?? 0) - (before.cpuUserMs ?? 0),
                    systemMs: (after.cpuSystemMs ?? 0) - (before.cpuSystemMs ?? 0),
                },
                rssSteadyBytes: before.rssBytes ?? null,
                peakRssBytes: after.peakRssBytes ?? null,
            });
        } finally {
            child.kill();
            await sleep(200);
            if (!options.keepTrees && tree.temporary) await fsp.rm(path.dirname(tree.dataRoot), { recursive: true, force: true });
        }
    }
    const artifactPath = await writeArtifact('assets', { manifest: { source: 'docs/frontend-startup-calls.md', count: manifest.length }, results });
    return { artifactPath, records: results };
}

async function modeSoak({ procstat, fixturegen }) {
    const results = [];
    for (const subject of subjects) {
        const tree = await prepareTree({ label: `soak-${subject.name}`, fixturegen, scale: options.scale ?? 'mixed-large', scaleArgs: options.scaleArgs });
        const port = await choosePort();
        const origin = `http://127.0.0.1:${port}`;
        const { command, args, cwd, env } = subjectArgv(subject, { dataRoot: tree.dataRoot, configPath: tree.configPath, port });
        const child = trackChild(spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }));
        const logs = [];
        child.stdout.on('data', chunk => logs.push(chunk.toString('utf8')));
        child.stderr.on('data', chunk => logs.push(chunk.toString('utf8')));
        try {
            await waitForReady(origin, { seconds: 300, label: subject.name });
            const session = new HttpSession(origin);
            await session.handshake();
            // Warmup outside the soak series.
            for (let index = 0; index < 10; index += 1) await session.get('/version');
            const samples = [];
            const latencies = [];
            const deadline = Date.now() + options.soakMinutes * 60 * 1000;
            const intervalMs = Math.max(200, Math.floor(1000 / options.soakRate));
            let nextTick = Date.now();
            while (Date.now() < deadline) {
                const route = DATA_ROUTES[options.dataRoute] ?? DATA_ROUTES.settings;
                const response = route.method === 'POST' ? await session.post(route.route, route.body ?? {}) : await session.get(route.route);
                latencies.push(response.ms);
                if (Date.now() >= nextTick) {
                    samples.push({ atMs: options.soakMinutes * 60 * 1000 - (deadline - Date.now()), ...sampleProcess(procstat, child.pid) });
                    nextTick += 15_000;
                }
                const wait = intervalMs - (Date.now() % intervalMs);
                if (wait > 0) await sleep(wait);
            }
            const finalSample = sampleProcess(procstat, child.pid);
            const first = samples[0] ?? {};
            results.push({
                subject: subject.name,
                kind: subject.kind,
                soakMinutes: options.soakMinutes,
                requests: latencies.length,
                samples,
                firstRssBytes: first.rssBytes ?? null,
                lastRssBytes: finalSample.rssBytes ?? null,
                rssDriftBytes: (first.rssBytes && finalSample.rssBytes) ? finalSample.rssBytes - first.rssBytes : null,
                peakRssBytes: finalSample.peakRssBytes ?? null,
                cpu: { userMs: finalSample.cpuUserMs ?? null, systemMs: finalSample.cpuSystemMs ?? null },
                latencyMs: summariseSamples(latencies),
                gc: parseGcTrace(logs.join(''))
            });
        } finally {
            child.kill();
            await sleep(200);
            if (!options.keepTrees && tree.temporary) await fsp.rm(path.dirname(tree.dataRoot), { recursive: true, force: true });
        }
    }
    const artifactPath = await writeArtifact('soak', { results });
    return { artifactPath, records: results };
}

async function modePaired({ procstat, fixturegen }) {
    // Alternating rounds: the boot order flips every round so a slow thermal/scanning period cannot favour one
    // subject. Every round uses a FRESH copy of the same generated tree, so both subjects see identical bytes.
    const records = [];
    for (let round = 0; round < options.rounds; round += 1) {
        const order = round % 2 === 0 ? subjects : [...subjects].reverse();
        for (const subject of order) {
            const tree = await freshRoundTree({ label: `paired-${subject.name}`, fixturegen, scale: options.scale ?? 'base', scaleArgs: options.scaleArgs, round });
            log(`[paired ${round + 1}/${options.rounds}] ${subject.name} (${subject.kind})`);
            const record = await measureSubject(procstat, subject, { dataRoot: tree.dataRoot, configPath: tree.configPath, rounds: options.rounds, requests: options.requests, dataRoute: options.dataRoute });
            record.round = round;
            records.push(record);
            if (!options.keepTrees && tree.temporary) await fsp.rm(path.dirname(tree.dataRoot), { recursive: true, force: true });
        }
    }
    const summary = aggregate(records);
    // Paired deltas are reported, never asserted: the artifact states both medians and the ratio with the raw
    // sample spread, so a reader sees the noise instead of a threshold that flattered one subject.
    const names = Object.keys(summary);
    const deltas = {};
    if (names.length === 2) {
        const [first, second] = names;
        const ratio = (left, right) => (typeof left === 'number' && typeof right === 'number' && right !== 0) ? left / right : null;
        deltas[`${first}_vs_${second}`] = {
            bootMs: ratio(summary[first].bootMs?.median, summary[second].bootMs?.median),
            rssSteadyBytes: ratio(summary[first].rssSteadyBytes?.median, summary[second].rssSteadyBytes?.median),
            peakRssBytes: ratio(summary[first].peakRssBytes?.median, summary[second].peakRssBytes?.median),
            dataMedianMs: ratio(summary[first].dataMedianMs?.median, summary[second].dataMedianMs?.median),
            note: 'ratio = first/second; only meaningful on a quiet host (see environment.loadLabel)',
        };
    }
    const artifactPath = await writeArtifact('paired', { records, summary, deltas });
    return { artifactPath, records };
}

// ---------------------------------------------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------------------------------------------
const subjects = [
    ...options.subjects.map(value => parseSubject('--subject', value)),
    ...options.pinned.map(value => parseSubject('--pinned', value)),
];

async function main() {
    // HARD RUN DEADLINE: a wedged subject or a wedged readiness poll must fail the run BY NAME, not leave a server
    // and a multi-megabyte tree alive on a host with ~3 GB free. The timer kills every tracked child and exits 1
    // with the reason on stderr.
    const runDeadline = setTimeout(() => {
        console.error(`a15-bench-suite: run exceeded --max-minutes ${options.maxMinutes}; terminating subjects`);
        void shutdown('hard run deadline', 1);
    }, options.maxMinutes * 60 * 1000);
    try {
        await fsp.mkdir(options.workDir, { recursive: true });
        const { procstat, fixturegen } = await resolveHelpers();
        log(`a15-bench-suite: mode=${options.mode} subjects=${subjects.map(subject => `${subject.name}(${subject.kind})`).join(',')} load=${options.loadLabel}`);
        let result;
        switch (options.mode) {
            case 'smoke': result = await modeSmoke({ procstat, fixturegen }); break;
            case 'scale': result = await modeScale({ procstat, fixturegen }); break;
            case 'concurrency': result = await modeConcurrency({ procstat, fixturegen }); break;
            case 'assets': result = await modeAssets({ procstat, fixturegen }); break;
            case 'soak': result = await modeSoak({ procstat, fixturegen }); break;
            case 'paired': result = await modePaired({ procstat, fixturegen }); break;
            default: throw new Error(`unhandled mode ${options.mode}`);
        }
        const artifactPath = result.artifactPath;
        console.log(`artifact: ${artifactPath}`);
        const document = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
        if (document.payload?.summary) {
            for (const [subjectName, summary] of Object.entries(document.payload.summary)) {
                const boot = summary.bootMs ? `${summary.bootMs.median.toFixed(1)} ms (p95 ${summary.bootMs.p95?.toFixed(1)})` : 'no boot';
                const cold = summary.bootMsCold ? `cold ${summary.bootMsCold.median.toFixed(1)} ms` : null;
                const warm = summary.bootMsWarm ? `warm ${summary.bootMsWarm.median.toFixed(1)} ms` : null;
                const rss = summary.rssSteadyBytes ? `${(summary.rssSteadyBytes.median / 1e6).toFixed(1)} MB` : 'rss unmeasured';
                const peak = summary.peakRssBytes ? `${(summary.peakRssBytes.median / 1e6).toFixed(1)} MB` : 'peak unmeasured';
                console.log(`${subjectName}: boot ${boot}${cold ? ` (${cold}, ${warm})` : ''}, rss ${rss}, peak ${peak}`);
            }
        }
        if (document.payload?.deltas) console.log(JSON.stringify(document.payload.deltas, null, 2));
        for (const row of [...(document.payload?.results ?? []), ...(document.payload?.records ?? [])]) {
            if (row.scale) console.log(`${row.subject} ${row.scale}: rss ${row.rssSteadyBytes ? (row.rssSteadyBytes / 1e6).toFixed(1) + ' MB' : 'unmeasured'}, peak ${row.peakRssBytes ? (row.peakRssBytes / 1e6).toFixed(1) + ' MB' : 'unmeasured'}, data ${row.latency?.data?.ms?.median?.toFixed(1) ?? '?'} ms`);
            if (row.inflight) console.log(`${row.subject} inflight ${row.inflight}: ${row.throughputPerSecond?.toFixed(1)} req/s, p95 ${row.latencyMs?.p95?.toFixed(1)} ms, p99 ${row.latencyMs?.p99?.toFixed(1)} ms, errors ${row.errors}`);
            if (row.pageLoadMs) console.log(`${row.subject} page load: ${row.pageLoadMs.toFixed(1)} ms over ${row.requests} calls, ${(row.bytesDecoded / 1e6).toFixed(2)} MB decoded, non-2xx ${row.non2xx?.length ?? 0}`);
            if (row.soakMinutes) console.log(`${row.subject} soak ${row.soakMinutes} min: rss drift ${row.rssDriftBytes} B, peak ${row.peakRssBytes} B`);
        }
        const failures = [];
        for (const record of document.payload?.records ?? []) if (record.bootError) failures.push(`${record.subject}: ${record.bootError}`);
        if (failures.length > 0) {
            console.error(`run had ${failures.length} failed boot(s):\n${failures.join('\n')}`);
            process.exitCode = 1;
        }
    } finally {
        clearTimeout(runDeadline);
        // Every exit path (success, throw, deadline) drops the subjects and the temporary trees this run created.
        await terminateTrackedChildren('end of run');
        await cleanupWorkTrees();
    }
}

await main();
