#!/usr/bin/env node
// A18 60-MINUTE SOAK HARNESS (long-run stability, alpha.18 release qualification).
//
// WHY THIS EXISTS. The repository's process-level harness (scripts/a15-bench-suite.mjs) answers "what does a build
// cost", with short smoke/scale/concurrency/soak modes over ONE data route. It does not answer the release-
// qualification question this lane was asked: does a REAL shipped binary, booted against a real generated
// SillyTavern-shaped tree, survive an hour of MIXED storage traffic while being restarted, while a chat is written
// and re-read across every restart, and while a card file is modified from OUTSIDE the process? That is this script.
// It is deliberately standalone (a15-bench-suite.mjs is not modified and is not imported): its artifact shape, its
// assertions and its failure semantics are its own, so a defect here cannot be hidden by a15's summaries.
//
// WHAT A RUN DOES
//   1. boots <binary> start --dataRoot <data> --configPath <config> --port <p> --listenAddressIPv4 127.0.0.1
//      (plus the pinned-safe flags a15 uses: browserLaunchEnabled=false, listen=false, enableIPv4=true,
//      enableIPv6=false, heartbeatInterval=0), waits for GET /version 200 within a bounded deadline, and performs
//      the /csrf-token + cookie handshake every POST route needs;
//   2. drives a weighted, REQUEST-PACED mix (one request in flight, default ~8 req/s) over /version, /,
//      /api/characters/all, /api/characters/chats, /api/chats/get, /api/settings/get, /api/worldinfo/list and
//      /api/chats/save (create + overwrite the same small chat file), using REAL avatar/file names discovered in
//      the supplied tree;
//   3. every --restart-every-minutes (default 10) stops the process, boots it again on the SAME data root,
//      re-handshakes, and re-reads the chat it last saved, comparing HTTP content AND the on-disk bytes;
//   4. every ~60s rewrites the mtime of ONE card PNG (fs.utimes only, bytes untouched) and immediately reads
//      /api/characters/all, asserting 200 plus the card's name/avatar still present (the external-modification
//      path through the identity-keyed card cache);
//   5. samples procstat every 15s (RSS, peak RSS, CPU user/system), records every request's latency, and checks
//      GET /version availability at each tick;
//   6. writes ONE JSON artifact (environment, parameters, samples, requests, restarts, integrity, notes) and
//      prints a compact summary.
//
// HONEST LIMITS, repeated into every artifact's `notes`:
//   - Windows cannot deliver SIGTERM to a console process. A stop is `taskkill /PID <pid> /T` and, when that is
//     refused, `/T /F`. The exact mode is recorded per restart; graceful-shutdown flush paths are NOT exercised.
//   - procstat reports handles=null on Windows, so NO handle/FD count is claimed anywhere.
//   - goroutine count and live heap are not observable from outside the process (the product exposes no pprof
//     endpoint, and adding one would change the binary under test). RSS is the only memory observable, so a LEAK
//     VERDICT IS UNPROVEN by construction: allocator retention and live heap are not separable from RSS alone.
//   - provider streaming/generation is NOT exercised. This soak drives storage/settings routes; no provider
//     request is issued and no SSE stream is consumed. A provider soak needs a controlled peer and credentials.
//   - each boot takes a fresh loopback port (unless --port pins the first boot), so TCP state or a pooled
//     connection to the previous origin cannot manufacture a restart failure. Same-port restart is not measured.
//   - latencies include loopback transport and harness-side body consumption. On a shared host they are not an
//     SLO; the artifact records the request count so the distribution can be judged with its sample size.
//
// EXIT CODES
//   0  run completed and every assertion passed (integrity, external modification, no unexpected HTTP status)
//   1  run completed or aborted with a named failure (see artifact.failures)
//   2  harness/setup failure (bad arguments, missing binary/tree, helper build failure, boot failure)
//
// USAGE
//   node tools/perf/a18-soak.mjs --binary <gotavern.exe> --data-root <dir/data> [--config <config.yaml>]
//     [--minutes 60] [--rate 8] [--out <artifact.json>] [--port <n>] [--restart-every-minutes 10]
//     [--work-dir <dir>] [--procstat <procstat.exe>] [--boot-timeout-seconds 180]
//     [--request-timeout-seconds 30] [--metrics-interval-seconds 15] [--probe-interval-seconds 60]
//     [--seed 20261107] [--label <text>]
//
//   node tools/perf/a18-soak.mjs --binary %TEMP%\a18\gotavern.exe --data-root %TEMP%\a18\tree\data \
//     --config %TEMP%\a18\tree\config.yaml --minutes 60 --rate 8 --restart-every-minutes 10 \
//     --out %TEMP%\a18\a18-soak-60min.json

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const HARNESS = 'tools/perf/a18-soak.mjs';

// ---------------------------------------------------------------------------------------------------------------
// ARGUMENTS
// ---------------------------------------------------------------------------------------------------------------
class SetupError extends Error {}

const USAGE = `usage: node ${HARNESS} --binary <gotavern.exe> --data-root <dir/data> [options]

  --binary <path>                 GoTavern executable to soak (required)
  --data-root <path>              data root the binary is booted against (required; normally <tree>/data)
  --config <path>                 config.yaml for the binary (default: <data-root>/../config.yaml when it exists)
  --minutes <n>                   soak length in minutes (default 60; fractional allowed)
  --rate <n>                      target requests per second (default 8; one request in flight)
  --out <path>                    artifact JSON path (default <work-dir>/a18-soak-<stamp>.json)
  --port <n>                      port for the FIRST boot (default: a free loopback port; restarts take fresh ports)
  --restart-every-minutes <n>     stop+boot cycle period (default 10; 0 disables restarts)
  --work-dir <dir>                scratch/log directory (default %TEMP%/a18-soak-<stamp>)
  --procstat <path>               procstat executable (default: build ./tests/perf/procstat into <work-dir>/bin)
  --boot-timeout-seconds <n>      readiness deadline per boot (default 180)
  --request-timeout-seconds <n>   per-request timeout (default 30)
  --metrics-interval-seconds <n>  procstat/availability sample period (default 15)
  --probe-interval-seconds <n>    external-modification probe period (default 60)
  --seed <n>                      deterministic workload-selection seed (default 20261107)
  --label <text>                  free-form label recorded in the artifact
  --help                          print this text`;

function parseArguments(argv) {
    const options = {
        binary: null,
        dataRoot: null,
        configPath: null,
        minutes: 60,
        rate: 8,
        out: null,
        port: 0,
        restartEveryMinutes: 10,
        workDir: null,
        procstat: null,
        bootTimeoutSeconds: 180,
        requestTimeoutSeconds: 30,
        metricsIntervalSeconds: 15,
        probeIntervalSeconds: 60,
        seed: 20261107,
        label: null,
        help: false,
    };
    for (let index = 0; index < argv.length; index += 1) {
        const flag = argv[index];
        const take = () => {
            const value = argv[index + 1];
            if (value === undefined) throw new SetupError(`${flag} requires a value`);
            index += 1;
            return value;
        };
        const number = (minimum) => {
            const value = Number(take());
            if (!Number.isFinite(value) || value < minimum) throw new SetupError(`${flag} expects a number >= ${minimum}, got ${value}`);
            return value;
        };
        switch (flag) {
            case '--binary': options.binary = path.resolve(take()); break;
            case '--data-root': options.dataRoot = path.resolve(take()); break;
            case '--config': options.configPath = path.resolve(take()); break;
            case '--minutes': options.minutes = number(0.001); break;
            case '--rate': options.rate = number(0.001); break;
            case '--out': options.out = path.resolve(take()); break;
            case '--port': options.port = Math.trunc(number(0)); break;
            case '--restart-every-minutes': options.restartEveryMinutes = number(0); break;
            case '--work-dir': options.workDir = path.resolve(take()); break;
            case '--procstat': options.procstat = path.resolve(take()); break;
            case '--boot-timeout-seconds': options.bootTimeoutSeconds = number(1); break;
            case '--request-timeout-seconds': options.requestTimeoutSeconds = number(1); break;
            case '--metrics-interval-seconds': options.metricsIntervalSeconds = number(1); break;
            case '--probe-interval-seconds': options.probeIntervalSeconds = number(1); break;
            case '--seed': options.seed = Math.trunc(number(0)); break;
            case '--label': options.label = take(); break;
            case '--help': case '-h': options.help = true; break;
            default: throw new SetupError(`unknown argument ${flag}\n\n${USAGE}`);
        }
    }
    if (options.help) return options;
    if (!options.binary) throw new SetupError(`--binary is required\n\n${USAGE}`);
    if (!options.dataRoot) throw new SetupError(`--data-root is required\n\n${USAGE}`);
    if (options.rate > 100) throw new SetupError(`--rate ${options.rate} is unbounded for this host: the harness is designed for one request in flight and a bounded pace (<= 100 req/s)`);
    return options;
}

const options = parseArguments(process.argv.slice(2));
if (options.help) {
    console.log(USAGE);
    process.exit(0);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const workDir = options.workDir ?? path.join(os.tmpdir(), `a18-soak-${stamp}`);
const artifactPath = options.out ?? path.join(workDir, `a18-soak-${stamp}.json`);
const metricsIntervalMs = options.metricsIntervalSeconds * 1000;
const probeIntervalMs = options.probeIntervalSeconds * 1000;
const restartEveryMs = options.restartEveryMinutes * 60 * 1000;
const soakDurationMs = Math.max(1000, Math.round(options.minutes * 60 * 1000));
const requestTimeoutMs = options.requestTimeoutSeconds * 1000;
const bootTimeoutMs = options.bootTimeoutSeconds * 1000;

// Provenance is captured when the HARNESS starts, not when the artifact is written: a 60-minute run on an active
// repository can see a commit land underneath it, and `git rev-parse HEAD` read at the end would then name a commit
// this run never executed. The binary sha256 is still the authoritative identity of what was soaked.
const gitAtStart = (() => {
    const head = runCapture('git', ['rev-parse', 'HEAD'], repoRoot);
    const status = runCapture('git', ['status', '--porcelain'], repoRoot);
    return {
        head: head.status === 0 ? head.stdout : null,
        headError: head.status === 0 ? null : (head.stderr || head.error),
        worktreeEntryCount: status.status === 0 ? (status.stdout === '' ? 0 : status.stdout.split('\n').length) : null,
    };
})();

// ---------------------------------------------------------------------------------------------------------------
// SMALL UTILITIES
// ---------------------------------------------------------------------------------------------------------------
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function round(value, digits = 3) {
    if (value === null || value === undefined || !Number.isFinite(value)) return null;
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
}

function sha256(buffer) {
    return createHash('sha256').update(buffer).digest('hex');
}

async function sha256File(file) {
    return sha256(await fsp.readFile(file));
}

function runCapture(command, args, cwd) {
    const result = spawnSync(command, args, { cwd, encoding: 'utf8', windowsHide: true });
    return {
        status: result.status,
        stdout: (result.stdout ?? '').trim(),
        stderr: (result.stderr ?? '').trim(),
        error: result.error ? String(result.error.message ?? result.error) : null,
    };
}

function tryJson(text) {
    try { return JSON.parse(text); } catch { return null; }
}

function mulberry32(seed) {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6D2B79F5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function percentile(sorted, fraction) {
    if (sorted.length === 0) return null;
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
    return sorted[index];
}

function latencySummary(values) {
    if (values.length === 0) return { count: 0, min: null, p50: null, p95: null, p99: null, max: null, mean: null };
    const sorted = [...values].sort((left, right) => left - right);
    const sum = sorted.reduce((total, value) => total + value, 0);
    return {
        count: sorted.length,
        min: round(sorted[0]),
        p50: round(percentile(sorted, 0.5)),
        p95: round(percentile(sorted, 0.95)),
        p99: round(percentile(sorted, 0.99)),
        max: round(sorted[sorted.length - 1]),
        mean: round(sum / sorted.length),
    };
}

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

// procstat is the repository's process-facts helper (tests/perf/procstat). It is the only memory/CPU observable
// this harness has: Windows GetProcessMemoryInfo/GetProcessTimes. handles is null there and is recorded as null.
function sampleProcess(pid) {
    const result = spawnSync(procstatPath, ['--pid', String(pid)], { encoding: 'utf8', windowsHide: true });
    const text = (result.stdout ?? '').trim();
    if (text === '') {
        return { ok: false, error: `procstat exit ${result.status}: ${(result.stderr ?? '').trim() || result.error || 'no output'}`, pid, rssBytes: null, peakRssBytes: null, cpuUserMs: null, cpuSystemMs: null, handles: null };
    }
    const parsed = tryJson(text);
    if (parsed === null) {
        return { ok: false, error: `procstat emitted non-JSON: ${text.slice(0, 200)}`, pid, rssBytes: null, peakRssBytes: null, cpuUserMs: null, cpuSystemMs: null, handles: null };
    }
    return parsed;
}

// ---------------------------------------------------------------------------------------------------------------
// TREE INSPECTION: real avatar/file names, so no route is driven with an invented name
// ---------------------------------------------------------------------------------------------------------------
async function walkTree(root) {
    let files = 0;
    let bytes = 0;
    const paths = [];
    const stack = [root];
    while (stack.length > 0) {
        const directory = stack.pop();
        let entries;
        try { entries = await fsp.readdir(directory, { withFileTypes: true }); } catch { continue; }
        for (const entry of entries) {
            const full = path.join(directory, entry.name);
            if (entry.isDirectory()) stack.push(full);
            else if (entry.isFile()) {
                files += 1;
                paths.push(path.relative(root, full).split(path.sep).join('/'));
                try { bytes += (await fsp.stat(full)).size; } catch { /* a file that vanished mid-walk is not counted */ }
            }
        }
    }
    return { files, bytes, paths };
}

async function inspectTree(dataRoot) {
    const rootEntries = await fsp.readdir(dataRoot, { withFileTypes: true }).catch(() => []);
    const handleCandidates = rootEntries.filter(entry => entry.isDirectory()).map(entry => entry.name);
    let handle = null;
    for (const candidate of handleCandidates) {
        if (fs.existsSync(path.join(dataRoot, candidate, 'characters'))) { handle = candidate; break; }
    }
    if (handle === null && handleCandidates.includes('default-user')) handle = 'default-user';
    if (handle === null) throw new SetupError(`data root ${dataRoot} has no per-user directory containing characters/ (generate a tree with tests/perf/fixturegen)`);
    const userDir = path.join(dataRoot, handle);

    const cardNames = (await fsp.readdir(path.join(userDir, 'characters')).catch(() => []))
        .filter(name => name.toLowerCase().endsWith('.png')).sort();
    if (cardNames.length === 0) throw new SetupError(`data root ${dataRoot} has no character cards under ${handle}/characters; generate with --scale cards or --scale mixed-large`);

    // The chat routes address chats/<avatar without .png>/, and in a generated tree that directory may belong to a
    // DIFFERENT avatar than the first card (mixed-large writes chats for "A15 Character.png", cards for "A15 Card
    // NNNNN.png"). Pick the first avatar that BOTH has a card and has a chat directory, so /api/characters/chats,
    // /api/chats/get and /api/chats/save are all driven with names the tree really contains.
    const chatDirectoryNames = (await fsp.readdir(path.join(userDir, 'chats'), { withFileTypes: true }).catch(() => []))
        .filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
    let chatAvatar = null;
    let chatFiles = [];
    for (const directory of chatDirectoryNames) {
        const avatar = `${directory}.png`;
        if (!cardNames.includes(avatar)) continue;
        const files = (await fsp.readdir(path.join(userDir, 'chats', directory)).catch(() => []))
            .filter(name => name.toLowerCase().endsWith('.jsonl')).sort();
        if (files.length === 0) continue;
        chatAvatar = avatar;
        chatFiles = files;
        break;
    }
    // Fall back to the first card when no avatar has chats: the save route creates the directory, and the
    // real-chat GET route is omitted (recorded in the artifact and printed).
    const cardAvatar = chatAvatar ?? cardNames[0];
    const cardName = cardAvatar.replace(/\.png$/i, '');
    const cardPath = path.join(userDir, 'characters', cardAvatar);

    // /api/chats/get appends ".jsonl" to file_name, so the wire file_name is the basename without the extension.
    const realChatFileId = chatFiles.length > 0 ? chatFiles[0].replace(/\.jsonl$/i, '') : null;
    const realChatPath = chatFiles.length > 0 ? path.join(userDir, 'chats', cardName, chatFiles[0]) : null;

    // The external-modification probe touches exactly ONE card PNG. It is a different file from the chat avatar's
    // card when the tree separates them, and the artifact records both so the evidence is unambiguous.
    const probeCardAvatar = cardNames[0];
    // The card's NAME comes from the card JSON, not from the filename (fixturegen writes 1000 cards all named
    // "A15 Card" under avatars "A15 Card NNNNN.png"), so it is calibrated from /api/characters/all before the soak
    // rather than derived. null means the calibration failed and the probe asserts the avatar only.
    const probeCardName = null;
    const probeCardPath = path.join(userDir, 'characters', probeCardAvatar);

    return {
        handle,
        userDir,
        cardCount: cardNames.length,
        cardAvatar,
        cardName,
        cardPath,
        probeCardAvatar,
        probeCardName,
        probeCardPath,
        chatAvatarFromTree: chatAvatar !== null,
        realChatFileId,
        realChatPath,
        realChatBytes: realChatPath ? (await fsp.stat(realChatPath)).size : null,
    };
}

// ---------------------------------------------------------------------------------------------------------------
// HTTP SESSION: cookie jar + CSRF handshake (same handshake a15-bench-suite.mjs documents; independent copy so a
// change in that harness cannot silently change this one's requests)
// ---------------------------------------------------------------------------------------------------------------
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

    headers(extra = {}) {
        const headers = { ...extra };
        if (this.cookies.size > 0) headers.cookie = this.cookieHeader();
        if (this.csrfToken) headers['x-csrf-token'] = this.csrfToken;
        return headers;
    }

    async handshake() {
        const response = await fetch(`${this.origin}/csrf-token`, { signal: AbortSignal.timeout(requestTimeoutMs) });
        this.absorb(response);
        const body = await response.text();
        this.csrfToken = tryJson(body)?.token ?? null;
        if (!this.csrfToken) this.csrfToken = 'disabled';
        return this.csrfToken;
    }

    async request(method, route, body, { readText = false } = {}) {
        const started = process.hrtime.bigint();
        const init = { method, headers: this.headers(), signal: AbortSignal.timeout(requestTimeoutMs) };
        if (body !== undefined) {
            init.headers['content-type'] = 'application/json';
            init.body = JSON.stringify(body);
        }
        const response = await fetch(`${this.origin}${route}`, init);
        this.absorb(response);
        let text = null;
        let bytes;
        if (readText) {
            text = await response.text();
            bytes = Buffer.byteLength(text, 'utf8');
        } else {
            bytes = (await response.arrayBuffer()).byteLength;
        }
        return { status: response.status, bytes, text, ms: Number(process.hrtime.bigint() - started) / 1e6 };
    }

    get(route, extra) { return this.request('GET', route, undefined, extra); }
    post(route, body, extra) { return this.request('POST', route, body, extra); }
}

function classifyError(error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return 'timeout';
    const code = error?.cause?.code ?? error?.code;
    if (code) return String(code);
    return String(error?.message ?? error);
}

// ---------------------------------------------------------------------------------------------------------------
// PROCESS LIFECYCLE
// ---------------------------------------------------------------------------------------------------------------
let currentChild = null;
let currentPort = null;
let logStream = null;
let logTail = '';

function bootArguments({ dataRoot, configPath, port }) {
    const args = ['start',
        '--port', String(port),
        '--dataRoot', dataRoot,
        '--configPath', configPath,
        '--browserLaunchEnabled', 'false',
        '--listen', 'false',
        '--enableIPv4', 'true',
        '--enableIPv6', 'false',
        '--listenAddressIPv4', '127.0.0.1',
        '--heartbeatInterval', '0'];
    return args;
}

function waitForExit(child, timeoutMs) {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
    return new Promise(resolve => {
        const timer = setTimeout(() => { child.off('exit', onExit); resolve(false); }, timeoutMs);
        function onExit() { clearTimeout(timer); resolve(true); }
        child.once('exit', onExit);
    });
}

// Is a pid still a live process? procstat is NOT usable for this: OpenProcess on a just-terminated Windows process
// still succeeds while a handle is open, and procstat then reports a garbage 36 KB RSS. tasklist answers the
// question the orphan check actually asks. (Observed on this host: procstat claimed a dead pid was alive.)
function isPidAlive(pid) {
    if (!pid) return false;
    if (process.platform !== 'win32') {
        try { process.kill(pid, 0); return true; } catch { return false; }
    }
    const result = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'], { encoding: 'utf8', windowsHide: true });
    return result.status === 0 && (result.stdout ?? '').includes(`"${pid}"`);
}

// Host-level leftover check: every live process whose image is this binary's basename. This is what "no orphan
// GoTavern process on the host" means, and it is checked from the OS rather than from our own bookkeeping.
function findProcessesByImageName(imageName) {
    if (process.platform !== 'win32') {
        const result = spawnSync('pgrep', ['-f', imageName], { encoding: 'utf8' });
        return result.status === 0 ? result.stdout.trim().split('\n').filter(Boolean).map(Number) : [];
    }
    const result = spawnSync('tasklist', ['/FI', `IMAGENAME eq ${imageName}`, '/NH', '/FO', 'CSV'], { encoding: 'utf8', windowsHide: true });
    const pids = [];
    for (const line of (result.stdout ?? '').split('\n')) {
        const match = /^"([^"]+)","(\d+)"/.exec(line.trim());
        if (match && match[1].toLowerCase() === imageName.toLowerCase()) pids.push(Number(match[2]));
    }
    return pids;
}

async function stopChild({ reason }) {
    const child = currentChild;
    if (!child) return { pid: null, mode: 'not-running', ms: 0, orphanAfterStop: false, reason };
    const pid = child.pid;
    const started = Date.now();
    if (child.exitCode !== null || child.signalCode !== null) {
        currentChild = null;
        if (logStream) { logStream.end(); logStream = null; }
        return { pid, mode: 'already-exited', ms: 0, orphanAfterStop: false, reason };
    }
    let mode;
    let exited = false;
    if (process.platform === 'win32') {
        const soft = spawnSync('taskkill', ['/PID', String(pid), '/T'], { encoding: 'utf8', windowsHide: true });
        const softText = `${soft.stdout ?? ''}${soft.stderr ?? ''}`.trim().replace(/\s+/g, ' ').slice(0, 160);
        // A console process refuses a non-forced taskkill, so the graceful attempt is given one second and then the
        // forced path is taken. The exact outcome is recorded, not described as graceful.
        if (await waitForExit(child, 1000)) {
            exited = true;
            mode = `taskkill /PID ${pid} /T accepted (exit ${soft.status}${softText ? `: ${softText}` : ''})`;
        } else {
            spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8', windowsHide: true });
            exited = await waitForExit(child, 5000);
            mode = exited
                ? `taskkill /T refused (exit ${soft.status}${softText ? `: ${softText}` : ''}); forced with taskkill /T /F`
                : `taskkill /T and /T /F both failed to end pid ${pid} within 5s`;
        }
    } else {
        child.kill('SIGTERM');
        exited = await waitForExit(child, 5000);
        if (!exited) { child.kill('SIGKILL'); exited = await waitForExit(child, 5000); }
        mode = exited ? 'SIGTERM' : 'SIGTERM then SIGKILL';
    }
    // The child's own exit event is authoritative for the process we spawned; tasklist is the second opinion.
    let orphanAfterStop = !exited || isPidAlive(pid);
    if (orphanAfterStop && process.platform === 'win32') {
        spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8', windowsHide: true });
        await sleep(500);
        orphanAfterStop = isPidAlive(pid);
    }
    currentChild = null;
    if (logStream) { logStream.end(); logStream = null; }
    return { pid, mode, ms: Date.now() - started, orphanAfterStop, reason };
}

async function waitForReady(origin, { deadlineMs, child }) {
    const started = Date.now();
    let last = 'no attempt';
    while (Date.now() - started < deadlineMs) {
        if (child.exitCode !== null || child.signalCode !== null) throw new SetupError(`server exited (code ${child.exitCode}, signal ${child.signalCode}) before answering GET /version: ${last}`);
        try {
            const response = await fetch(`${origin}/version`, { signal: AbortSignal.timeout(2000) });
            if (response.status === 200) return Date.now() - started;
            last = `GET /version -> ${response.status}`;
        } catch (error) {
            last = classifyError(error);
        }
        await sleep(50);
    }
    throw new SetupError(`server did not answer GET /version within ${deadlineMs / 1000}s: ${last}`);
}

async function boot({ dataRoot, configPath, port, bootIndex }) {
    const origin = `http://127.0.0.1:${port}`;
    const args = bootArguments({ dataRoot, configPath, port });
    logTail = '';
    const logPath = path.join(workDir, `boot-${String(bootIndex).padStart(2, '0')}.log`);
    logStream = fs.createWriteStream(logPath, { flags: 'a' });
    const started = Date.now();
    const child = spawn(options.binary, args, {
        cwd: path.dirname(dataRoot),
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
    });
    child.stdout.on('data', chunk => { const text = chunk.toString('utf8'); logTail = (logTail + text).slice(-8000); logStream?.write(text); });
    child.stderr.on('data', chunk => { const text = chunk.toString('utf8'); logTail = (logTail + text).slice(-8000); logStream?.write(text); });
    child.on('error', error => { logTail = (logTail + `spawn error: ${error.message}\n`).slice(-8000); });
    currentChild = child;
    currentPort = port;
    const bootError = await (async () => {
        try {
            await waitForReady(origin, { deadlineMs: bootTimeoutMs, child });
            return null;
        } catch (error) {
            return error;
        }
    })();
    if (bootError) {
        await stopChild({ reason: 'boot-failed' });
        throw new SetupError(`boot ${bootIndex} on port ${port} failed: ${bootError.message}\n--- server log tail ---\n${logTail.slice(-2000)}`);
    }
    const session = new HttpSession(origin);
    try {
        await session.handshake();
    } catch (error) {
        await stopChild({ reason: 'handshake-failed' });
        throw new SetupError(`boot ${bootIndex} answered /version but the /csrf-token handshake failed: ${classifyError(error)}\n--- server log tail ---\n${logTail.slice(-2000)}`);
    }
    return { child, session, origin, port, bootMs: Date.now() - started, args, logPath, pid: child.pid };
}

// ---------------------------------------------------------------------------------------------------------------
// WORKLOAD
// ---------------------------------------------------------------------------------------------------------------
const rng = mulberry32(options.seed);
let tree = null;
let session = null;
let currentBoot = null;

let saveSeq = 0;
let lastSaved = null;
let pendingSave = null;

function jsonlOf(chat) {
    return chat.map(message => JSON.stringify(message)).join('\n');
}

function buildChat(seq) {
    const when = new Date().toISOString();
    return [
        { name: 'A18 Soak User', is_user: true, mes: `a18 soak user line ${seq}`, send_date: when },
        { name: tree.cardName, is_user: false, mes: `a18 soak character line ${seq}`, send_date: when },
    ];
}

function buildRoutes() {
    const savedFileId = 'A18 Soak';  // create + overwrite the same file, in the real avatar's chat directory
    const routes = [
        { id: 'GET /version', method: 'GET', path: '/version', weight: 12 },
        { id: 'GET /', method: 'GET', path: '/', weight: 8 },
        { id: 'POST /api/characters/all', method: 'POST', path: '/api/characters/all', weight: 12, body: () => ({}) },
        { id: 'POST /api/characters/chats', method: 'POST', path: '/api/characters/chats', weight: 10, body: () => ({ avatar_url: tree.cardAvatar, metadata: true }) },
        { id: 'POST /api/settings/get', method: 'POST', path: '/api/settings/get', weight: 10, body: () => ({}) },
        { id: 'POST /api/worldinfo/list', method: 'POST', path: '/api/worldinfo/list', weight: 10, body: () => ({}) },
        {
            id: 'POST /api/chats/save', method: 'POST', path: '/api/chats/save', weight: 16,
            body: () => {
                saveSeq += 1;
                const chat = buildChat(saveSeq);
                pendingSave = { seq: saveSeq, chat, expectedText: jsonlOf(chat) };
                return { avatar_url: tree.cardAvatar, file_name: savedFileId, chat };
            },
            onOk: () => {
                lastSaved = {
                    seq: pendingSave.seq,
                    chat: pendingSave.chat,
                    expectedText: pendingSave.expectedText,
                    expectedSha256: sha256(Buffer.from(pendingSave.expectedText, 'utf8')),
                    atMs: Date.now() - soakStart,
                };
            },
        },
        {
            id: 'POST /api/chats/get (saved)', method: 'POST', path: '/api/chats/get', weight: 12,
            body: () => ({ avatar_url: tree.cardAvatar, file_name: savedFileId }),
        },
    ];
    if (tree.realChatFileId) {
        routes.push({
            id: 'POST /api/chats/get', method: 'POST', path: '/api/chats/get', weight: 10,
            body: () => ({ avatar_url: tree.cardAvatar, file_name: tree.realChatFileId }),
        });
    }
    const total = routes.reduce((sum, route) => sum + route.weight, 0);
    for (const route of routes) route.share = route.weight / total;
    return { routes, savedFileId, totalWeight: total };
}

let routePlan = null;

function pickRoute() {
    let ticket = rng() * routePlan.totalWeight;
    for (const route of routePlan.routes) {
        ticket -= route.weight;
        if (ticket <= 0) return route;
    }
    return routePlan.routes[routePlan.routes.length - 1];
}

// ---------------------------------------------------------------------------------------------------------------
// RUN STATE
// ---------------------------------------------------------------------------------------------------------------
let soakStart = 0;
let aborted = null;             // { reason, route, detail } -- a data-integrity abort
let interrupted = false;
const failures = [];
const requestSamples = [];
const metricSamples = [];
const segments = [];
const restarts = [];
const integrityChecks = [];
const probeResults = [];
const availabilityChecks = [];
const saves = [];
const errorClasses = {};
const statusClasses = {};
let attempted = 0;
let succeeded = 0;
let warmupRequests = 0;
let pacingBehind = 0;

function recordFailure(entry) {
    failures.push(entry);
    if (failures.length <= 20) console.error(`FAILURE [${entry.kind}] ${entry.route ?? ''} ${entry.detail ?? ''}`.trim());
}

async function issue(route, { countAsWorkload = true } = {}) {
    const started = process.hrtime.bigint();
    let status = null;
    let bytes = null;
    let error = null;
    let response = null;
    try {
        response = route.method === 'GET'
            ? await session.get(route.path, { readText: Boolean(route.readText) })
            : await session.post(route.path, route.body ? route.body() : {}, { readText: Boolean(route.readText) });
        status = response.status;
        bytes = response.bytes;
    } catch (caught) {
        error = classifyError(caught);
    }
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    const sample = { t: Date.now() - soakStart, route: route.id, ms: round(ms, 2), status, bytes };
    if (error) sample.error = error;
    requestSamples.push(sample);
    attempted += 1;
    if (error) {
        errorClasses[error] = (errorClasses[error] ?? 0) + 1;
        recordFailure({ kind: 'request-error', route: route.id, detail: error, atMs: sample.t });
    } else if (status !== 200) {
        statusClasses[status] = (statusClasses[status] ?? 0) + 1;
        recordFailure({ kind: 'http-status', route: route.id, detail: `status ${status}`, atMs: sample.t });
    } else {
        succeeded += 1;
        if (route.onOk) route.onOk();
    }
    return { sample, response, ms, status, bytes, error };
}

// ---------------------------------------------------------------------------------------------------------------
// INTEGRITY: write -> restart -> read, HTTP content AND on-disk bytes
// ---------------------------------------------------------------------------------------------------------------
function chatContentMatches(expectedChat, parsed) {
    if (!Array.isArray(parsed)) return { ok: false, reason: `response is not an array (got ${parsed === null ? 'null' : typeof parsed})` };
    if (parsed.length !== expectedChat.length) return { ok: false, reason: `message count ${parsed.length} != ${expectedChat.length}` };
    const fields = ['name', 'is_user', 'mes', 'send_date'];
    for (let index = 0; index < expectedChat.length; index += 1) {
        for (const field of fields) {
            const want = expectedChat[index][field];
            const got = parsed[index]?.[field];
            if (JSON.stringify(want) !== JSON.stringify(got)) {
                return { ok: false, reason: `message ${index}.${field}: saved ${JSON.stringify(want)?.slice(0, 80)} read back ${JSON.stringify(got)?.slice(0, 80)}` };
            }
        }
    }
    return { ok: true };
}

async function checkSavedChat(phase) {
    const check = { phase, atMs: Date.now() - soakStart, savedSeq: lastSaved?.seq ?? null };
    if (!lastSaved) {
        check.ok = false;
        check.reason = 'no chat has been saved yet, so there is nothing to re-read';
        integrityChecks.push(check);
        recordFailure({ kind: 'integrity', route: 'POST /api/chats/get', detail: `${phase}: ${check.reason}`, atMs: check.atMs });
        return check;
    }
    const expectedChat = lastSaved.chat;
    let response = null;
    try {
        response = await session.post('/api/chats/get', { avatar_url: tree.cardAvatar, file_name: routePlan.savedFileId }, { readText: true });
    } catch (error) {
        check.ok = false;
        check.reason = `GET saved chat failed: ${classifyError(error)}`;
        integrityChecks.push(check);
        recordFailure({ kind: 'integrity', route: 'POST /api/chats/get', detail: `${phase}: ${check.reason}`, atMs: check.atMs });
        return check;
    }
    check.httpStatus = response.status;
    const parsed = tryJson(response.text ?? '');
    const content = chatContentMatches(expectedChat, parsed);
    check.httpMatches = content.ok;
    check.messageCount = Array.isArray(parsed) ? parsed.length : null;
    if (!content.ok) check.httpMismatch = content.reason;

    const diskPath = path.join(tree.userDir, 'chats', tree.cardName, `${routePlan.savedFileId}.jsonl`);
    check.diskPath = diskPath;
    try {
        const diskBytes = await fsp.readFile(diskPath);
        check.diskSha256 = sha256(diskBytes);
        check.diskBytes = diskBytes.byteLength;
        check.expectedSha256 = lastSaved.expectedSha256;
        check.diskMatches = check.diskSha256 === lastSaved.expectedSha256;
        if (!check.diskMatches) {
            const text = diskBytes.toString('utf8');
            check.diskMismatch = `disk ${check.diskBytes} bytes (sha ${check.diskSha256.slice(0, 16)}) != saved ${lastSaved.expectedText.length} bytes (sha ${lastSaved.expectedSha256.slice(0, 16)}); head: ${JSON.stringify(text.slice(0, 120))}`;
        }
    } catch (error) {
        check.diskMatches = false;
        check.diskError = String(error?.message ?? error);
    }
    check.ok = response.status === 200 && content.ok && check.diskMatches === true;
    if (!check.ok) {
        check.reason = response.status !== 200
            ? `status ${response.status}`
            : (!content.ok ? `content: ${check.httpMismatch}` : `bytes: ${check.diskMismatch ?? check.diskError}`);
        recordFailure({ kind: 'integrity', route: 'POST /api/chats/get', detail: `${phase}: ${check.reason}`, atMs: check.atMs });
    }
    integrityChecks.push(check);
    return check;
}

// ---------------------------------------------------------------------------------------------------------------
// PROBE CALIBRATION: the card's real `name` comes from the listing, never from the filename
// ---------------------------------------------------------------------------------------------------------------
async function calibrateProbeCard() {
    const calibration = { card: tree.probeCardAvatar, status: null, found: false, name: null };
    try {
        const response = await session.post('/api/characters/all', {}, { readText: true });
        calibration.status = response.status;
        const listing = tryJson(response.text ?? '');
        const entry = Array.isArray(listing) ? listing.find(character => character?.avatar === tree.probeCardAvatar) : null;
        calibration.found = Boolean(entry);
        calibration.name = entry?.name ?? null;
        if (entry?.name) tree.probeCardName = entry.name;
    } catch (error) {
        calibration.error = classifyError(error);
    }
    if (!calibration.found) {
        recordFailure({
            kind: 'probe-calibration',
            route: 'POST /api/characters/all',
            detail: `the probe card ${tree.probeCardAvatar} was not in the startup listing (status ${calibration.status}${calibration.error ? `, ${calibration.error}` : ''}); the external-modification probe will assert the avatar only`,
            atMs: 0,
        });
    }
    return calibration;
}

// ---------------------------------------------------------------------------------------------------------------
// EXTERNAL-MODIFICATION PROBE: utimes one card PNG, then read /api/characters/all
// ---------------------------------------------------------------------------------------------------------------
async function externalModificationProbe() {
    const probe = { atMs: Date.now() - soakStart, card: tree.probeCardAvatar };
    try {
        const before = await fsp.stat(tree.probeCardPath);
        probe.mtimeBeforeMs = before.mtimeMs;
        // Move mtime forward by a non-round amount so a coarse filesystem timestamp cannot make it a no-op. The
        // card BYTES are never touched: this is the external-modification path, not an edit.
        const target = new Date(before.mtimeMs + 7000 + Math.floor(rng() * 5000));
        await fsp.utimes(tree.probeCardPath, new Date(), target);
        const after = await fsp.stat(tree.probeCardPath);
        probe.mtimeAfterMs = after.mtimeMs;
        probe.mtimeChanged = Math.abs(after.mtimeMs - before.mtimeMs) > 0.5;
        if (!probe.mtimeChanged) {
            probe.ok = false;
            probe.reason = 'fs.utimes did not move the card mtime, so the external-modification path was not exercised';
            recordFailure({ kind: 'probe-ineffective', route: 'POST /api/characters/all', detail: probe.reason, atMs: probe.atMs });
            probeResults.push(probe);
            return probe;
        }
        const route = { id: 'probe:POST /api/characters/all (after utimes)', method: 'POST', path: '/api/characters/all', body: () => ({}), readText: true };
        const result = await issue(route);
        probe.status = result.status;
        probe.ms = round(result.ms, 2);
        probe.bytes = result.bytes;
        const characters = tryJson(result.response?.text ?? '');
        probe.cardCount = Array.isArray(characters) ? characters.length : null;
        probe.cardPresent = Array.isArray(characters) && characters.some(character => character?.avatar === tree.probeCardAvatar);
        probe.namePresent = tree.probeCardName === null
            ? null
            : (Array.isArray(characters) && characters.some(character => character?.name === tree.probeCardName));
        probe.ok = result.status === 200 && probe.cardPresent === true && probe.namePresent !== false;
        if (!probe.ok) {
            probe.reason = result.status !== 200
                ? `status ${result.status}`
                : `card ${tree.probeCardAvatar} (name ${tree.probeCardName ?? 'uncalibrated'}) missing from a 200 /api/characters/all response`;
            recordFailure({ kind: 'external-modification', route: 'POST /api/characters/all', detail: probe.reason, atMs: probe.atMs });
        }
    } catch (error) {
        probe.ok = false;
        probe.reason = classifyError(error);
        recordFailure({ kind: 'external-modification', route: 'fs.utimes + POST /api/characters/all', detail: probe.reason, atMs: probe.atMs });
    }
    probeResults.push(probe);
    return probe;
}

// ---------------------------------------------------------------------------------------------------------------
// METRICS
// ---------------------------------------------------------------------------------------------------------------
function segmentFor(pid) {
    let segment = segments.find(candidate => candidate.pid === pid);
    if (!segment) {
        segment = { index: segments.length, pid, bootMs: null, startedAtMs: Date.now() - soakStart, endedAtMs: null, samples: [], stop: null };
        segments.push(segment);
    }
    return segment;
}

function takeMetricSample(segment, label) {
    const facts = sampleProcess(segment.pid);
    const sample = {
        atMs: Date.now() - soakStart,
        label,
        pid: segment.pid,
        segment: segment.index,
        rssBytes: facts.rssBytes ?? null,
        peakRssBytes: facts.peakRssBytes ?? null,
        cpuUserMs: facts.cpuUserMs ?? null,
        cpuSystemMs: facts.cpuSystemMs ?? null,
        handles: facts.handles ?? null,
        ok: facts.ok === true,
    };
    if (facts.ok !== true) sample.error = facts.error ?? 'procstat failed';
    metricSamples.push(sample);
    segment.samples.push(sample);
    return sample;
}

async function availabilityCheck() {
    const started = process.hrtime.bigint();
    let status = null;
    let bytes = null;
    let error = null;
    try {
        const response = await session.get('/version');
        status = response.status;
        bytes = response.bytes;
    } catch (caught) {
        error = classifyError(caught);
    }
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    const check = { atMs: Date.now() - soakStart, status, ms: round(ms, 2), error };
    availabilityChecks.push(check);
    // The availability check is a REQUEST and is counted in the same series as every other request, so
    // requests.attempted and the raw sample count cannot drift apart.
    const sample = { t: check.atMs, route: 'availability:GET /version', ms: round(ms, 2), status, bytes };
    if (error) sample.error = error;
    requestSamples.push(sample);
    attempted += 1;
    if (error || status !== 200) {
        const key = error ?? `status ${status}`;
        errorClasses[key] = (errorClasses[key] ?? 0) + 1;
        recordFailure({ kind: 'availability', route: 'GET /version', detail: key, atMs: check.atMs });
    } else {
        succeeded += 1;
    }
    return check;
}

// ---------------------------------------------------------------------------------------------------------------
// TREND
// ---------------------------------------------------------------------------------------------------------------
function rssTrend(segment) {
    const points = segment.samples.filter(sample => sample.rssBytes !== null);
    if (points.length < 3) {
        return { sampleCount: points.length, firstBytes: points[0]?.rssBytes ?? null, lastBytes: points[points.length - 1]?.rssBytes ?? null, deltaBytes: null, slopeBytesPerMinute: null, verdict: 'UNPROVEN', reason: 'fewer than 3 RSS samples, so no trend can be computed' };
    }
    const first = points[0];
    const last = points[points.length - 1];
    const minutes = (last.atMs - first.atMs) / 60000;
    const meanX = points.reduce((sum, point) => sum + point.atMs, 0) / points.length;
    const meanY = points.reduce((sum, point) => sum + point.rssBytes, 0) / points.length;
    let numerator = 0;
    let denominator = 0;
    for (const point of points) {
        numerator += (point.atMs - meanX) * (point.rssBytes - meanY);
        denominator += (point.atMs - meanX) ** 2;
    }
    const slopePerMs = denominator === 0 ? null : numerator / denominator;
    return {
        sampleCount: points.length,
        firstBytes: first.rssBytes,
        lastBytes: last.rssBytes,
        deltaBytes: last.rssBytes - first.rssBytes,
        slopeBytesPerMinute: slopePerMs === null ? null : Math.round(slopePerMs * 60000),
        windowMinutes: round(minutes, 2),
        verdict: 'UNPROVEN',
        reason: 'RSS is the only external memory observable; live heap and Go allocator retention are not separable from outside, so an upward RSS slope is not evidence of a leak',
    };
}

// ---------------------------------------------------------------------------------------------------------------
// ENVIRONMENT
// ---------------------------------------------------------------------------------------------------------------
function environmentFacts() {
    const cpus = os.cpus();
    const gitHead = runCapture('git', ['rev-parse', 'HEAD'], repoRoot);
    const gitStatus = runCapture('git', ['status', '--porcelain'], repoRoot);
    const goVersion = runCapture('go', ['version'], repoRoot);
    const binaryVersion = runCapture(options.binary, ['version', '--json'], path.dirname(options.binary));
    return {
        os: `${os.type()} ${os.release()}`,
        platform: process.platform,
        arch: process.arch,
        cpuModel: cpus[0]?.model ?? null,
        cpuCount: cpus.length,
        totalMemBytes: os.totalmem(),
        hostname: os.hostname(),
        goVersion: goVersion.status === 0 ? goVersion.stdout : null,
        goVersionError: goVersion.status === 0 ? null : goVersion.stderr || goVersion.error,
        nodeVersion: process.version,
        gitHead: gitAtStart.head,
        gitHeadError: gitAtStart.headError,
        gitHeadAtArtifactTime: gitHead.status === 0 ? gitHead.stdout : null,
        gitWorktreeEntryCount: gitAtStart.worktreeEntryCount,
        gitWorktreeEntryCountAtArtifactTime: gitStatus.status === 0 ? (gitStatus.stdout === '' ? 0 : gitStatus.stdout.split('\n').length) : null,
        binaryPath: options.binary,
        binaryBytes: fs.statSync(options.binary).size,
        binarySha256: sha256FileSync(options.binary),
        binaryVersionIdentity: binaryVersion.status === 0 ? tryJson(binaryVersion.stdout) : null,
        binaryVersionError: binaryVersion.status === 0 ? null : binaryVersion.stderr || binaryVersion.error,
        procstatPath,
        procstatMethod: 'tests/perf/procstat (GetProcessMemoryInfo/GetProcessTimes on Windows); handles is null there',
    };
}

function sha256FileSync(file) {
    return sha256(fs.readFileSync(file));
}

// ---------------------------------------------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------------------------------------------
let procstatPath = null;

async function resolveProcstat() {
    if (options.procstat) {
        if (!fs.existsSync(options.procstat)) throw new SetupError(`--procstat ${options.procstat} does not exist`);
        return options.procstat;
    }
    const binDir = path.join(workDir, 'bin');
    await fsp.mkdir(binDir, { recursive: true });
    const target = path.join(binDir, process.platform === 'win32' ? 'a15-procstat.exe' : 'a15-procstat');
    const build = runCapture('go', ['build', '-o', target, './tests/perf/procstat'], repoRoot);
    if (build.status !== 0) throw new SetupError(`could not build tests/perf/procstat (${build.stderr || build.error}); pass --procstat <path> to reuse a prebuilt helper`);
    return target;
}

async function main() {
    if (!fs.existsSync(options.binary)) throw new SetupError(`--binary ${options.binary} does not exist`);
    if (!fs.existsSync(options.dataRoot)) throw new SetupError(`--data-root ${options.dataRoot} does not exist`);
    const configPath = options.configPath ?? path.join(path.dirname(options.dataRoot), 'config.yaml');
    if (!fs.existsSync(configPath)) throw new SetupError(`config not found at ${configPath}; pass --config <config.yaml>`);

    await fsp.mkdir(workDir, { recursive: true });
    await fsp.mkdir(path.dirname(artifactPath), { recursive: true });
    procstatPath = await resolveProcstat();

    tree = await inspectTree(options.dataRoot);
    const before = await walkTree(options.dataRoot);
    const fixtureChatSha256Before = tree.realChatPath ? await sha256File(tree.realChatPath) : null;
    const probeCardSha256Before = await sha256File(tree.probeCardPath);
    const routeInfo = buildRoutes();
    routePlan = routeInfo;

    console.log(`A18 soak: ${options.minutes} min at ~${options.rate} req/s, restart every ${options.restartEveryMinutes} min, ${routePlan.routes.length} route shapes`);
    console.log(`  binary:    ${options.binary}`);
    console.log(`  data root: ${options.dataRoot} (${tree.cardCount} cards, ${before.files} files, ${before.bytes} bytes)`);
    console.log(`  card:      ${tree.cardAvatar} (chat routes) | probe card: ${tree.probeCardAvatar} | real chat: ${tree.realChatFileId ?? '(none in tree; chats/get-real omitted)'} | saved chat: ${routePlan.savedFileId}`);
    if (!tree.realChatFileId) console.log('  NOTE: the tree has no chat file, so the real-chat GET route is omitted and the remaining weights are renormalised');

    const firstPort = options.port > 0 ? options.port : await choosePort();
    const firstBoot = await boot({ dataRoot: options.dataRoot, configPath, port: firstPort, bootIndex: 0 });
    session = firstBoot.session;
    currentBoot = firstBoot;
    const segment = segmentFor(firstBoot.pid);
    segment.bootMs = firstBoot.bootMs;

    // Warmup is OUTSIDE the measured series: it pays page-cache/JIT/library setup and is recorded by count only.
    const warmupCount = 5;
    for (let index = 0; index < warmupCount; index += 1) {
        await session.get('/version');
        await session.post('/api/settings/get', {});
        warmupRequests += 2;
    }

    // Calibration is OUTSIDE the measured series too: it learns the probe card's real `name` from the listing so
    // the probe cannot assert a filename-derived name the product never reports.
    const probeCalibration = await calibrateProbeCard();

    soakStart = Date.now();
    // The first segment object was created before the soak clock existed; anchor it at 0 (its boot cost is
    // recorded separately in bootMs) so every atMs/startedAtMs field is relative to the same origin.
    segment.startedAtMs = 0;
    const deadline = soakStart + soakDurationMs;
    takeMetricSample(segment, 'segment-start');

    let nextMetricsAt = soakStart + metricsIntervalMs;
    let nextProbeAt = soakStart + probeIntervalMs;
    let nextRestartAt = restartEveryMs > 0 ? soakStart + restartEveryMs : Number.POSITIVE_INFINITY;
    let restartIndex = 0;
    let nextTick = performance.now();
    const intervalMs = 1000 / options.rate;

    while (Date.now() < deadline && aborted === null && !interrupted) {
        // Restart boundary: stop, boot on the same data root, re-handshake, then prove the saved chat survived.
        if (Date.now() >= nextRestartAt) {
            const atMs = Date.now() - soakStart;
            // The segment-end sample is taken BEFORE the stop: procstat on a killed pid can still answer with a
            // stale/absurd value (observed: 36 KB RSS for a dead GoTavern), and a post-mortem sample is not a
            // measurement of the running process.
            const endingSegment = segmentFor(currentBoot.pid);
            takeMetricSample(endingSegment, 'segment-end');
            endingSegment.endedAtMs = Date.now() - soakStart;
            const stop = await stopChild({ reason: `scheduled restart ${restartIndex + 1}` });
            if (endingSegment) endingSegment.stop = { mode: stop.mode, ms: stop.ms, orphanAfterStop: stop.orphanAfterStop };
            const restart = { index: restartIndex + 1, atMs, stoppedPid: stop.pid, stopMode: stop.mode, stopMs: stop.ms, orphanAfterStop: stop.orphanAfterStop };
            // A FRESH port per boot: a restart must not be able to fail because of TCP state, and the previous
            // origin's pooled keep-alive socket must not be reused against the new process. --port pins the first
            // boot only; that is recorded in parameters.port so the scope of --port is not implied.
            const port = await choosePort();
            try {
                const next = await boot({ dataRoot: options.dataRoot, configPath, port, bootIndex: restartIndex + 1 });
                session = next.session;
                currentBoot = next;
                const nextSegment = segmentFor(next.pid);
                nextSegment.bootMs = next.bootMs;
                takeMetricSample(nextSegment, 'segment-start');
                restart.pid = next.pid;
                restart.port = next.port;
                restart.bootMs = next.bootMs;
                restart.downtimeMs = Date.now() - soakStart - atMs;
                restart.integrity = await checkSavedChat(`after-restart-${restart.index}`);
                restart.ok = restart.integrity.ok === true;
            } catch (error) {
                restart.error = String(error?.message ?? error);
                restart.ok = false;
                recordFailure({ kind: 'restart-boot', route: 'boot', detail: restart.error, atMs });
                aborted = { reason: 'restart-boot-failed', detail: restart.error };
            }
            restarts.push(restart);
            restartIndex += 1;
            nextRestartAt += restartEveryMs;
            nextTick = performance.now();
            continue;
        }

        if (Date.now() >= nextMetricsAt) {
            takeMetricSample(segmentFor(currentBoot.pid), 'periodic');
            await availabilityCheck();
            nextMetricsAt += metricsIntervalMs;
        }

        if (Date.now() >= nextProbeAt) {
            await externalModificationProbe();
            nextProbeAt += probeIntervalMs;
        }

        const route = pickRoute();
        const result = await issue(route);
        if (route.id === 'POST /api/chats/save' && result.status === 200) {
            saves.push({ seq: lastSaved.seq, atMs: lastSaved.atMs, ms: round(result.ms, 2), bytes: result.bytes });
        }
        if (aborted !== null) break;

        nextTick += intervalMs;
        const wait = nextTick - performance.now();
        if (wait > 0) {
            await sleep(wait);
        } else if (wait < -5 * intervalMs) {
            // Fell more than five intervals behind (a slow route): resynchronise instead of bursting to catch up.
            // This keeps at most one request in flight, which is the harness's bounded-concurrency contract.
            pacingBehind += 1;
            nextTick = performance.now();
        }
    }

    // Final: force a couple of extra reads, then the last samples and the final integrity check.
    if (aborted === null) {
        const finalVersion = { id: 'final:GET /version', method: 'GET', path: '/version' };
        const finalCharacters = { id: 'final:POST /api/characters/all', method: 'POST', path: '/api/characters/all', body: () => ({}) };
        await issue(finalVersion);
        await issue(finalVersion);
        await issue(finalCharacters);
        await checkSavedChat('final');
        takeMetricSample(segmentFor(currentBoot.pid), 'final');
    }
    const soakEndedAt = Date.now();
    // The segment-end sample is taken BEFORE the stop: a killed pid can still answer procstat with a stale value,
    // and a post-mortem sample is not a measurement of the running process. If a restart boot failed, the current
    // child is already gone and its segment was closed before that stop, so there is nothing to sample here.
    const finalSegment = currentChild ? segments.find(candidate => candidate.pid === currentBoot.pid) : null;
    if (finalSegment) {
        takeMetricSample(finalSegment, 'segment-end');
        finalSegment.endedAtMs = Date.now() - soakStart;
    }
    const finalStop = await stopChild({ reason: 'run-end' });
    if (finalSegment) finalSegment.stop = { mode: finalStop.mode, ms: finalStop.ms, orphanAfterStop: finalStop.orphanAfterStop };
    // Host-level orphan check: no process running this binary's image may survive the run.
    const leftoverPids = findProcessesByImageName(path.basename(options.binary));
    if (leftoverPids.length > 0) {
        recordFailure({ kind: 'orphan-process', route: 'process-lifecycle', detail: `binary image still running after the final stop: pids ${leftoverPids.join(', ')}`, atMs: Date.now() - soakStart });
    }

    const after = await walkTree(options.dataRoot);
    const fixtureChatSha256After = tree.realChatPath ? await sha256File(tree.realChatPath) : null;
    const probeCardSha256After = await sha256File(tree.probeCardPath);
    const beforePaths = new Set(before.paths);
    const afterPaths = new Set(after.paths);
    const createdFiles = after.paths.filter(relative => !beforePaths.has(relative));
    const removedFiles = before.paths.filter(relative => !afterPaths.has(relative));
    // Data-safety assertions: the soak READS a pre-existing chat and only utimes the probe card, so either file
    // changing bytes is a defect (the first is a product one, the second would be the harness's own).
    if (tree.realChatPath && fixtureChatSha256Before !== fixtureChatSha256After) {
        recordFailure({ kind: 'data-safety', route: 'filesystem', detail: `pre-existing chat ${tree.realChatPath} changed during the run (sha256 ${String(fixtureChatSha256Before).slice(0, 16)} -> ${String(fixtureChatSha256After).slice(0, 16)})`, atMs: Date.now() - soakStart });
    }
    if (probeCardSha256Before !== probeCardSha256After) {
        recordFailure({ kind: 'harness-wrote-card', route: 'filesystem', detail: `the probe card ${tree.probeCardPath} changed BYTES; fs.utimes must only move the mtime`, atMs: Date.now() - soakStart });
    }
    const measuredMinutes = (soakEndedAt - soakStart) / 60000;
    const finalisationMs = Date.now() - soakEndedAt;

    // ---- aggregate -------------------------------------------------------------------------------------------
    const latencies = requestSamples.filter(sample => sample.status !== null).map(sample => sample.ms);
    const byRoute = {};
    for (const route of routePlan.routes) {
        const samples = requestSamples.filter(sample => sample.route === route.id);
        byRoute[route.id] = {
            share: round(route.share, 4),
            attempted: samples.length,
            ok: samples.filter(sample => sample.status === 200).length,
            statuses: [...new Set(samples.map(sample => sample.status))],
            latencyMs: latencySummary(samples.filter(sample => sample.status !== null).map(sample => sample.ms)),
        };
    }
    for (const id of ['probe:POST /api/characters/all (after utimes)', 'availability:GET /version', 'final:GET /version', 'final:POST /api/characters/all']) {
        const samples = requestSamples.filter(sample => sample.route === id);
        if (samples.length === 0) continue;
        byRoute[id] = {
            share: null,
            attempted: samples.length,
            ok: samples.filter(sample => sample.status === 200).length,
            statuses: [...new Set(samples.map(sample => sample.status))],
            latencyMs: latencySummary(samples.filter(sample => sample.status !== null).map(sample => sample.ms)),
        };
    }

    const rssPerSegment = segments.map(segmentRecord => ({
        index: segmentRecord.index,
        pid: segmentRecord.pid,
        bootMs: segmentRecord.bootMs,
        startedAtMs: segmentRecord.startedAtMs,
        endedAtMs: segmentRecord.endedAtMs,
        stop: segmentRecord.stop,
        sampleCount: segmentRecord.samples.filter(sample => sample.rssBytes !== null).length,
        firstRssBytes: segmentRecord.samples.find(sample => sample.rssBytes !== null)?.rssBytes ?? null,
        lastRssBytes: [...segmentRecord.samples].reverse().find(sample => sample.rssBytes !== null)?.rssBytes ?? null,
        peakRssBytes: Math.max(...segmentRecord.samples.map(sample => sample.peakRssBytes ?? 0), 0) || null,
        cpu: (() => {
            const cpuSamples = segmentRecord.samples.filter(sample => sample.cpuUserMs !== null);
            if (cpuSamples.length === 0) return { userMs: null, systemMs: null };
            const first = cpuSamples[0];
            const last = cpuSamples[cpuSamples.length - 1];
            return { userMs: last.cpuUserMs - first.cpuUserMs, systemMs: last.cpuSystemMs - first.cpuSystemMs };
        })(),
        rssTrend: rssTrend(segmentRecord),
    }));

    const totalCpuUserMs = rssPerSegment.reduce((sum, segmentRecord) => sum + (segmentRecord.cpu.userMs ?? 0), 0);
    const totalCpuSystemMs = rssPerSegment.reduce((sum, segmentRecord) => sum + (segmentRecord.cpu.systemMs ?? 0), 0);
    const peakRssBytes = Math.max(...segments.flatMap(segmentRecord => segmentRecord.samples.map(sample => sample.peakRssBytes ?? 0)), 0) || null;

    const integrity = {
        savedChat: {
            avatar: tree.cardAvatar,
            fileId: routePlan.savedFileId,
            path: path.join(tree.userDir, 'chats', tree.cardName, `${routePlan.savedFileId}.jsonl`),
            lastSavedSeq: lastSaved?.seq ?? null,
            saveCount: saves.length,
            lastSaveAtMs: saves.length > 0 ? saves[saves.length - 1].atMs : null,
            checks: integrityChecks,
            passed: integrityChecks.filter(check => check.ok).length,
            failed: integrityChecks.filter(check => !check.ok).length,
        },
        fixtureChat: {
            path: tree.realChatPath,
            present: tree.realChatPath !== null,
            sha256Before: fixtureChatSha256Before,
            sha256After: fixtureChatSha256After,
            // null, not false, when the tree has no chat to compare: "not applicable" must not read as "changed".
            unchanged: tree.realChatPath === null ? null : fixtureChatSha256Before === fixtureChatSha256After,
        },
        probeCard: {
            path: tree.probeCardPath,
            sha256Before: probeCardSha256Before,
            sha256After: probeCardSha256After,
            bytesUnchanged: probeCardSha256Before === probeCardSha256After,
        },
    };

    const run = {
        startedAt: new Date(soakStart).toISOString(),
        endedAt: new Date().toISOString(),
        plannedMinutes: options.minutes,
        measuredMinutes: round(measuredMinutes, 3),
        endedBy: aborted !== null ? `aborted: ${aborted.reason}` : (interrupted ? 'interrupted' : 'deadline'),
        abortDetail: aborted?.detail ?? null,
        warmupRequests,
        pacingBehindEvents: pacingBehind,
        achievedRequestsPerSecond: round(requestSamples.length / Math.max(measuredMinutes * 60, 1), 3),
        finalisationMs,
        wallMinutes: round((Date.now() - new Date(run0StartedAt).getTime()) / 60000, 3),
    };

    const artifact = {
        harness: HARNESS,
        label: options.label,
        run,
        environment: {
            ...environmentFacts(),
            dataRoot: options.dataRoot,
            dataRootFilesBefore: before.files,
            dataRootBytesBefore: before.bytes,
            dataRootFilesAfter: after.files,
            dataRootBytesAfter: after.bytes,
            dataRootFileDelta: after.files - before.files,
            dataRootByteDelta: after.bytes - before.bytes,
            dataRootCreatedCount: createdFiles.length,
            dataRootRemovedCount: removedFiles.length,
            dataRootCreatedFiles: createdFiles.slice(0, 50),
            dataRootRemovedFiles: removedFiles.slice(0, 50),
            dataRootDeltaNote: 'files created by the product during the run (startup scaffolding such as cookie-secret.txt, stats.json, _storage/ and .migrated markers, plus the chat this harness saves) and files removed; the harness itself only writes the saved chat and the card mtime',
            configPath,
            workDir,
            leftoverProcessesAfterRun: leftoverPids,
            leftoverCheck: 'tasklist /FI "IMAGENAME eq <binary basename>" after the final stop; empty means no orphan of this binary survived the run',
            logFiles: fs.readdirSync(workDir).filter(name => name.startsWith('boot-') && name.endsWith('.log')).map(name => path.join(workDir, name)),
        },
        parameters: {
            minutes: options.minutes,
            rate: options.rate,
            restartEveryMinutes: options.restartEveryMinutes,
            port: options.port > 0 ? `first boot: ${options.port}; every restart: a fresh free loopback port` : 'every boot: a fresh free loopback port',
            requestTimeoutSeconds: options.requestTimeoutSeconds,
            bootTimeoutSeconds: options.bootTimeoutSeconds,
            metricsIntervalSeconds: options.metricsIntervalSeconds,
            probeIntervalSeconds: options.probeIntervalSeconds,
            seed: options.seed,
            binary: options.binary,
            dataRoot: options.dataRoot,
            configPath,
            out: artifactPath,
            workDir,
            weights: routePlan.routes.map(route => ({ route: route.id, weight: route.weight, share: round(route.share, 4) })),
            savedChatFile: routePlan.savedFileId,
            cardAvatar: tree.cardAvatar,
            realChatFileId: tree.realChatFileId,
            warmupRequestsOnFirstBoot: warmupRequests,
            calibrationRequest: 'one POST /api/characters/all before the soak clock, to learn the probe card\'s real name',
            concurrency: 'one request in flight; the loop never pipelines and resynchronises instead of bursting',
        },
        samples: metricSamples,
        requests: {
            attempted,
            succeeded,
            errors: attempted - succeeded,
            errorClasses,
            statusClasses,
            latencyMs: latencySummary(latencies),
            byRoute,
            raw: requestSamples,
        },
        restarts: {
            count: restarts.length,
            scheduledEveryMinutes: options.restartEveryMinutes,
            stopModeNote: 'Windows has no SIGTERM delivery to a console process: taskkill /T is attempted first and /T /F only if the process survives. The exact mode per restart is in restarts[].stopMode, so a graceful-drain claim cannot be made from this artifact.',
            entries: restarts,
        },
        segments: rssPerSegment,
        integrity,
        externalModification: {
            exercised: probeResults.length > 0,
            probes: probeResults.length,
            passed: probeResults.filter(probe => probe.ok).length,
            failed: probeResults.filter(probe => probe.ok !== true).length,
            card: tree.probeCardAvatar,
            calibration: probeCalibration,
            method: 'fs.utimes on one card PNG (bytes untouched), then POST /api/characters/all; assert 200 and the card avatar/name still present',
            results: probeResults,
        },
        availability: {
            checks: availabilityChecks.length,
            ok: availabilityChecks.filter(check => check.status === 200).length,
            failed: availabilityChecks.filter(check => check.status !== 200).length,
            samples: availabilityChecks,
        },
        memory: {
            peakRssBytes,
            perSegment: rssPerSegment.map(segmentRecord => ({ index: segmentRecord.index, firstRssBytes: segmentRecord.firstRssBytes, lastRssBytes: segmentRecord.lastRssBytes, peakRssBytes: segmentRecord.peakRssBytes, sampleCount: segmentRecord.sampleCount, rssTrend: segmentRecord.rssTrend })),
            crossRestartComparable: restarts.length === 0,
            crossRestartNote: restarts.length === 0 ? null : 'RSS is not comparable across restarts: each boot starts a new process with an empty heap, so first/last/trend are reported PER SEGMENT and never pooled.',
            leakVerdict: 'UNPROVEN',
            leakVerdictReason: 'RSS is the only external memory observable. Live heap and Go allocator retention are not separable from outside the process, so neither an upward slope nor a plateau proves or disproves a leak. A leak claim needs an in-process heap profile (not exposed by this binary).',
            handles: null,
            handlesReason: 'procstat reports handles=null on Windows (GetProcessHandleCount is not sampled); no handle/FD count is claimed anywhere in this artifact.',
        },
        cpu: {
            userMs: totalCpuUserMs,
            systemMs: totalCpuSystemMs,
            perSegment: rssPerSegment.map(segmentRecord => ({ index: segmentRecord.index, ...segmentRecord.cpu })),
            method: 'procstat GetProcessTimes deltas per segment (first vs last sample of that boot)',
        },
        failures,
        notes: [
            'handles/FDs are NOT measured: procstat reports handles=null on Windows and no GetProcessHandleCount sample exists, so this artifact claims no FD count.',
            'goroutine count is NOT measured: it is not observable from outside the process and the product exposes no pprof endpoint; adding one would change the binary under test.',
            'provider streaming/generation is NOT measured: the soak drives storage and settings routes only, issues no provider request and consumes no SSE stream. A provider soak needs a controlled peer plus credentials.',
            'graceful shutdown is NOT measured: Windows cannot deliver SIGTERM to a console process, so the stop is taskkill /T (forced /T /F when refused); shutdown-flush behaviour is therefore not exercised by this artifact.',
            'a LEAK is UNPROVEN: RSS is the only external memory observable, and live heap vs allocator retention cannot be separated from it.',
            'same-port restart is NOT measured: every boot takes a fresh loopback port, so TCP state or a pooled connection to the previous origin cannot manufacture a restart failure.',
            'the chat-save integrity check compares the last successfully saved array to the HTTP read-back AND to the on-disk bytes; a mismatch aborts the run rather than overwriting the evidence.',
            'latencies are loopback and include harness-side body consumption; on a shared host they are not an SLO. The sample count is stated beside every percentile.',
            ...(probeResults.length === 0 ? ['the external-modification probe did NOT run in this artifact: the run was shorter than --probe-interval-seconds, so that path is UNEXERCISED here.'] : []),
        ],
    };

    await fsp.writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');

    // ---- compact summary -------------------------------------------------------------------------------------
    const lines = [];
    lines.push('A18 SOAK SUMMARY');
    lines.push(`  run:        ${run.measuredMinutes} min measured (planned ${run.plannedMinutes}), ended by ${run.endedBy}`);
    lines.push(`  requests:   ${attempted} attempted, ${succeeded} ok, ${attempted - succeeded} errors${attempted - succeeded ? ` (${JSON.stringify(errorClasses)} ${JSON.stringify(statusClasses)})` : ''}`);
    lines.push(`  rate:       ${run.achievedRequestsPerSecond} req/s achieved of ${options.rate} target; ${pacingBehind} resync events; one request in flight`);
    const latency = artifact.requests.latencyMs;
    lines.push(`  latency:    p50 ${latency.p50}ms p95 ${latency.p95}ms p99 ${latency.p99}ms max ${latency.max}ms (n=${latency.count})`);
    lines.push(`  rss:        peak ${fmtBytes(peakRssBytes)}; ${rssPerSegment.map(segmentRecord => `seg${segmentRecord.index} ${fmtBytes(segmentRecord.firstRssBytes)}->${fmtBytes(segmentRecord.lastRssBytes)} (${segmentRecord.sampleCount} samples, slope ${segmentRecord.rssTrend.slopeBytesPerMinute ?? 'n/a'} B/min)`).join('; ')}`);
    lines.push(`  leak:       UNPROVEN (RSS-only; live heap vs allocator growth is not separable from outside)`);
    lines.push(`  cpu:        user ${(totalCpuUserMs / 1000).toFixed(2)}s system ${(totalCpuSystemMs / 1000).toFixed(2)}s`);
    lines.push(`  restarts:   ${restarts.length}${restarts.length ? ` (stop: ${[...new Set(restarts.map(restart => restart.stopMode))].join(' | ')})` : ''}`);
    lines.push(`  integrity:  saved-chat ${integrity.savedChat.passed}/${integrityChecks.length} checks passed; fixture chat unchanged=${integrity.fixtureChat.unchanged === null ? 'n/a (no fixture chat in tree)' : integrity.fixtureChat.unchanged}; probe card bytes unchanged=${integrity.probeCard.bytesUnchanged}`);
    lines.push(`  ext-mod:    ${probeResults.length === 0
        ? `NOT EXERCISED (run shorter than --probe-interval-seconds ${options.probeIntervalSeconds}s)`
        : `${artifact.externalModification.passed}/${artifact.externalModification.probes} probes ok (utimes on ${tree.probeCardAvatar} + POST /api/characters/all)`}`);
    lines.push(`  availability: ${artifact.availability.ok}/${artifact.availability.checks} GET /version checks ok`);
    lines.push(`  data root:  ${after.files} files / ${after.bytes} bytes (delta ${after.files - before.files} files / ${after.bytes - before.bytes} bytes)`);
    lines.push(`  created:    ${createdFiles.length} file(s)${createdFiles.length ? `: ${createdFiles.slice(0, 6).join(', ')}${createdFiles.length > 6 ? ', ...' : ''}` : ''}`);
    lines.push(`  orphans:    ${leftoverPids.length === 0 ? 'none (tasklist finds no process running this binary after the final stop)' : `STILL RUNNING: pids ${leftoverPids.join(', ')}`}`);
    lines.push(`  artifact:   ${artifactPath}`);
    if (failures.length > 0) {
        lines.push(`  FAILURES (${failures.length}):`);
        for (const failure of failures.slice(0, 10)) lines.push(`    - [${failure.kind}] ${failure.route ?? ''}: ${failure.detail}`);
        if (failures.length > 10) lines.push(`    ... ${failures.length - 10} more in the artifact`);
    }
    console.log(lines.join('\n'));

    if (aborted !== null) return 1;
    if (failures.length > 0) return 1;
    if (integrityChecks.some(check => !check.ok)) return 1;
    if (probeResults.some(probe => probe.ok !== true)) return 1;
    return 0;
}

const run0StartedAt = new Date().toISOString();
let exitCode = 2;
process.on('SIGINT', () => {
    interrupted = true;
    console.error('SIGINT received: aborting the soak, killing the subject, and writing the artifact');
});
try {
    exitCode = await main();
} catch (error) {
    const isSetup = error instanceof SetupError;
    console.error(`${isSetup ? 'SETUP ERROR' : 'HARNESS ERROR'}: ${error?.message ?? error}`);
    if (!isSetup && error?.stack) console.error(error.stack);
    exitCode = 2;
} finally {
    // No orphan GoTavern process may survive this script, on any path.
    try {
        if (currentChild) {
            const stop = await stopChild({ reason: 'finally' });
            if (stop.orphanAfterStop) console.error(`ORPHAN: pid ${stop.pid} still alive after forced stop`);
        }
        const leftovers = findProcessesByImageName(path.basename(options.binary));
        if (leftovers.length > 0) console.error(`ORPHAN: processes running ${path.basename(options.binary)} survived: pids ${leftovers.join(', ')}`);
    } catch (error) {
        console.error(`finally: stop failed: ${error?.message ?? error}`);
    }
}
// Give stdout a moment to drain before forcing exit: a piped/redirected stdout is asynchronous on Windows, and
// process.exit() would otherwise truncate the summary this run exists to print.
process.exitCode = exitCode;
await sleep(150);
process.exit(exitCode);

function fmtBytes(bytes) {
    if (bytes === null || bytes === undefined) return 'n/a';
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)}KB`;
    return `${bytes}B`;
}
