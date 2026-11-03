#!/usr/bin/env node
// MEASURE THE OVERHEAD OF HAVING THE 20 PINNED THIRD-PARTY EXTENSIONS INSTALLED, ON BOTH SUBJECTS,
// ON THE SAME RUNNER AND THE SAME DATA SHAPE.
//
// WHY THIS FILE EXISTS. The release notes wanted to say something about what installing the pinned
// extension corpus costs a user (boot time, memory, request latency, page readiness). "It feels
// heavier" is not a release claim, and a number measured on one subject only is not a comparison.
// This script produces FOUR conditions in FRESH data roots:
//
//   1. gotavern-clean   GoTavern, config only
//   2. gotavern-20      GoTavern, all 20 pinned extensions installed
//   3. pinned-clean     stock SillyTavern, config only
//   4. pinned-20        stock SillyTavern, all 20 pinned extensions installed
//
// so the artefact carries `-20 minus -clean` deltas for BOTH subjects for bootMs, RSS and the
// /version p50, plus the browser-side readiness and extension-asset evidence. It does NOT assert a
// regression or a speedup: the deltas are descriptive, and the notes name everything unmeasured
// (browser RSS in particular is not invented).
//
// WHAT IS SHARED, SO THE PAIR IS COMPARABLE:
//   - one pinned default config (`seedLegConfig`) copied into each root, digest recorded;
//   - one pinned extension corpus from `third-party-extensions.lock.json`;
//   - ONE local seed of that corpus at `<work>/seed/default-user/extensions`, installed from the
//     remote pins exactly once at setup; every condition is then copied FROM THE SEED through
//     `GOTAVERN_EXTENSION_SEED_ROOT`, so the network is touched once per extension at setup and
//     NEVER during a measurement (each checkout's origin is also frozen to a local bare mirror by
//     ensurePinnedExtensionInstalled, so a page-triggered auto-update cannot advance it);
//   - the same port lease and identity-bound readiness check (`allocatePort`/`waitForIdentity`), so
//     a leftover process of either product can never be the subject that was measured;
//   - the same samples count for the HTTP latency measurements.
//
// WHAT EACH CONDITION RECORDS:
//   server side: bootMs (spawn -> identity readiness), working set immediately after boot
//   (VmRSS on Linux, ps on macOS, Get-Process on Windows; NULL plus a reason when unavailable),
//   /version and / latency (p50/p95/max over N samples), and the 10-second idle RSS delta.
//   browser side: chromium against `/`, preloader gone and `settingsReady`, msToSettingsReady,
//   msUntilAllExtensionAssetsRequested (20 for -20, NULL with a reason for clean),
//   extensionContainerCount, page errors, console errors, failed requests, live-egress/direct-host
//   observations. Browser RSS is NOT recorded: it is not reliably attributable to the page.
//
// EXIT CODES: 0 all four conditions booted and (for -20) all 20 extension assets loaded;
//             2 refusal (missing lock, binary, pinned reference, or a pinned checkout at the wrong
//               SHA / wrong invocation);
//             1 a condition failed to boot, a -20 condition did not have all 20 extensions load, or
//               setup failed.
//
// Usage:
//   GOTAVERN_BINARY=<bin> node tests/browser/extension-overhead.mjs --work-root <dir>
//     [--samples N] [--keep]
//
//   GOTAVERN_REFERENCE names the pinned checkout; when unset, `../SillyTavern` beside this repository
//   is used. GOTAVERN_MOCK_PROVIDER_BINARY is accepted for symmetry with the other lanes but unused:
//   no provider is configured in any condition and any /api/horde/ request is recorded, not asserted.

import fs from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { loadLock } from './third-party-extensions.mjs';
import { ensurePinnedExtensionInstalled, installedRevision, userExtensionsDirectory } from './install-pinned-extension.mjs';
import { seedLegConfig } from './seed-leg-config.mjs';
import { allocatePort, releasePort, waitForIdentity } from './port-lease.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const STOCK_SILLYTAVERN_SHA = '06bde939fb1e9c4c8d8641d810f0a916b5bce127';
const PINNED_PACKAGE_VERSION = '1.19.0';
const EXTENSION_ASSET_PREFIX = '/scripts/extensions/third-party/';
const CONDITION_SPECS = [
    { id: 'gotavern-clean', subject: 'gotavern', withExtensions: false },
    { id: 'gotavern-20', subject: 'gotavern', withExtensions: true },
    { id: 'pinned-clean', subject: 'pinned', withExtensions: false },
    { id: 'pinned-20', subject: 'pinned', withExtensions: true },
];
// Browser-side bounds. The corpus case is 20 real extensions loading in one page and the release gate
// may share a runner with other jobs, so the preloader/readiness bounds are generous but BOUNDED and
// recorded in the report; a page that never reaches user state fails the condition instead of hanging
// the gate.
const NAVIGATION_TIMEOUT_MS = 120000;
const PRELOADER_TIMEOUT_MS = 180000;
const SETTINGS_READY_BUDGET_MS = 120000;
const ASSET_WAIT_MS = 90000;
const SETTLE_QUIET_MS = 2500;
const SETTLE_DEADLINE_MS = 60000;
const EVALUATE_TIMEOUT_MS = 180000;
const CONTEXT_CLOSE_TIMEOUT_MS = 20000;
const BROWSER_CLOSE_TIMEOUT_MS = 30000;
// Requests a page makes that can START a server-side egress path. The browser only talks to the
// subject, so this list is the observable side of "did the corpus reach the network through the
// server": recorded as observations, NEVER asserted against a body (the peer is not configured).
const LIVE_EGRESS_PATH_PATTERNS = [
    /^\/api\/horde\//,
    /^\/api\/backends\//,
    /^\/api\/openai\//,
    /^\/api\/anthropic\//,
    /^\/api\/google\//,
    /^\/api\/novelai\//,
    /^\/api\/sd\//,
    /^\/api\/extra\//,
];

function argumentValue(name, fallback = null) {
    const index = process.argv.indexOf(name);
    if (index < 0) return fallback;
    const value = process.argv[index + 1];
    return value === undefined ? fallback : value;
}

function hasFlag(name) {
    return process.argv.includes(name);
}

function refuse(message) {
    console.error(`REFUSING: ${message}`);
    process.exit(2);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Bound an await that has no built-in timeout (Playwright's evaluate is not timeout-controlled, and a
// hung page/evaluation must fail the condition rather than hang the release gate).
async function withTimeout(promise, timeoutMs, label) {
    let timer = null;
    try {
        return await Promise.race([
            promise,
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error(`${label} did not finish within ${timeoutMs} ms`)), timeoutMs);
            }),
        ]);
    } finally {
        if (timer !== null) clearTimeout(timer);
    }
}

function round(value, digits = 1) {
    return typeof value === 'number' && Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

// Nearest-rank percentile over the sample array. `p` is a fraction (0.5, 0.95).
function percentile(values, p) {
    if (!values.length) return null;
    const sorted = [...values].sort((left, right) => left - right);
    const rank = Math.max(1, Math.ceil(p * sorted.length));
    return sorted[rank - 1];
}

function subtract(high, low) {
    return typeof high === 'number' && typeof low === 'number' ? high - low : null;
}

const workRoot = path.resolve(argumentValue('--work-root', '') || '');
if (!argumentValue('--work-root')) refuse('--work-root <dir> is required');
const samples = Number(argumentValue('--samples', '5'));
const samplesArgument = argumentValue('--samples');
if (!Number.isInteger(samples) || samples < 1 || samples > 100) refuse(`--samples must be an integer in 1..100; got ${JSON.stringify(samplesArgument)}`);
const keep = hasFlag('--keep');

const binaryArgument = process.env.GOTAVERN_BINARY ?? '';
if (!binaryArgument) refuse('GOTAVERN_BINARY must point at a built GoTavern binary (the release artifact shape: an executable inside an install directory)');
const binary = path.resolve(binaryArgument);
if (!existsSync(binary)) refuse(`GOTAVERN_BINARY points at ${binary}, which does not exist; build it with \`go build -trimpath -o .browser-bin/gotavern.exe ./cmd/gotavern\``);

const pinnedReferenceCandidates = process.env.GOTAVERN_REFERENCE
    ? [path.resolve(process.env.GOTAVERN_REFERENCE)]
    : [path.resolve(repoRoot, '..', 'SillyTavern')];
const pinnedReference = pinnedReferenceCandidates.find(candidate => existsSync(path.join(candidate, 'server.js')));
if (!pinnedReference) {
    refuse(`no pinned SillyTavern checkout found; tried: ${pinnedReferenceCandidates.join(', ')} (set GOTAVERN_REFERENCE)`);
}

let lockInfo;
try {
    lockInfo = loadLock();
} catch (error) {
    refuse(`the third-party extension lock is unusable: ${error.message ?? error}`);
}
if (!Array.isArray(lockInfo.lock.selected) || lockInfo.lock.selected.length !== 20) {
    refuse(`the lock must select exactly 20 extensions; got ${lockInfo.lock.selected?.length}`);
}

// THE PINNED CHECKOUT MUST BE THE BASELINE, NOT "SOMETHING WITH A server.js". A measurement against a
// different stock revision would describe a different product and make the pinned pair incomparable.
const pinnedHead = spawnSync('git', ['-C', pinnedReference, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
const pinnedCheckoutSha = String(pinnedHead.stdout ?? '').trim();
if (pinnedHead.status !== 0 || pinnedCheckoutSha !== STOCK_SILLYTAVERN_SHA) {
    refuse(`the pinned checkout at ${pinnedReference} is at ${JSON.stringify(pinnedCheckoutSha)}, not the stock ${STOCK_SILLYTAVERN_SHA}`);
}

// The browser half is OPTIONAL-IF-UNAVAILABLE: a runner without the harness's node_modules can still
// measure the server side, but a -20 condition cannot be declared valid without seeing all 20 assets,
// so that condition fails (exit 1) while the reason is recorded. Nothing here fabricates a metric.
let chromium = null;
let playwrightError = null;
try {
    const playwrightModule = await import('@playwright/test');
    chromium = playwrightModule.chromium ?? playwrightModule.default?.chromium ?? null;
    if (!chromium) throw new Error('@playwright/test has no chromium export');
} catch (error) {
    playwrightError = String(error.message ?? error);
}

const startedAt = new Date().toISOString();
await fs.mkdir(workRoot, { recursive: true });

// ---------------------------------------------------------------------------------------------------
// RSS. The numbers are the process's CURRENT working set at the sampling point, not a peak; the
// platform command is recorded so a reader can see what was measured. An unavailable reading is NULL
// with its reason, never a guess.
// ---------------------------------------------------------------------------------------------------
function readRss(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return { bytes: null, method: null, reason: 'no child PID' };
    if (process.platform === 'linux') {
        try {
            const status = readFileSync(`/proc/${pid}/status`, 'utf8');
            const match = status.match(/^VmRSS:\s+(\d+)\s+kB/m);
            if (!match) return { bytes: null, method: 'proc-vmrss', reason: 'VmRSS is absent from /proc/<pid>/status' };
            return { bytes: Number(match[1]) * 1024, method: 'proc-vmrss', reason: null };
        } catch (error) {
            return { bytes: null, method: 'proc-vmrss', reason: `read /proc/${pid}/status failed: ${error.message ?? error}` };
        }
    }
    if (process.platform === 'darwin') {
        const result = spawnSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' });
        const kilobytes = Number(String(result.stdout ?? '').trim());
        if (result.status !== 0 || !Number.isFinite(kilobytes) || kilobytes <= 0) {
            return { bytes: null, method: 'ps-rss', reason: `ps exited ${result.status} with ${JSON.stringify(String(result.stdout ?? '').trim())}` };
        }
        return { bytes: kilobytes * 1024, method: 'ps-rss', reason: null };
    }
    if (process.platform === 'win32') {
        const script = `try { (Get-Process -Id ${pid} -ErrorAction Stop).WorkingSet64 } catch { exit 3 }`;
        const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' });
        const bytes = Number(String(result.stdout ?? '').trim());
        if (result.status !== 0 || !Number.isFinite(bytes) || bytes <= 0) {
            return { bytes: null, method: 'powershell-get-process', reason: `Get-Process exited ${result.status}; output ${JSON.stringify(String(result.stdout ?? '').trim())}` };
        }
        return { bytes, method: 'powershell-get-process', reason: null };
    }
    return { bytes: null, method: null, reason: `RSS reading is not implemented on ${process.platform}` };
}

// ---------------------------------------------------------------------------------------------------
// HTTP latency. Every sample is a real request that is fully drained, so a slow body is part of the
// latency rather than hidden by a headers-only fetch. No warm-up sample is discarded: the count and
// the values are reported so a reader can see exactly what was measured.
// ---------------------------------------------------------------------------------------------------
async function sampleLatency(baseURL, route, count, { verifyVersion = false } = {}) {
    const values = [];
    for (let index = 0; index < count; index += 1) {
        const started = performance.now();
        const response = await fetch(`${baseURL}${route}`, { signal: AbortSignal.timeout(30000) });
        const body = await response.arrayBuffer();
        const elapsed = performance.now() - started;
        if (!response.ok) throw new Error(`${route} answered ${response.status}`);
        if (verifyVersion) {
            let payload = null;
            try {
                payload = JSON.parse(Buffer.from(body).toString('utf8'));
            } catch {
                payload = null;
            }
            if (!payload || payload.pkgVersion !== PINNED_PACKAGE_VERSION) {
                throw new Error(`/version reports ${JSON.stringify(payload?.pkgVersion ?? null)}, expected the pinned ${PINNED_PACKAGE_VERSION}`);
            }
        }
        values.push(elapsed);
    }
    return {
        samples: count,
        valuesMs: values.map(value => round(value, 2)),
        p50Ms: round(percentile(values, 0.5), 2),
        p95Ms: round(percentile(values, 0.95), 2),
        maxMs: round(Math.max(...values), 2),
    };
}

async function waitExit(child, timeoutMs = 15000) {
    if (child.exitCode !== null) return;
    await new Promise(resolve => {
        const timer = setTimeout(resolve, timeoutMs);
        child.once('exit', () => {
            clearTimeout(timer);
            resolve();
        });
    });
}

function captureChildOutput(child) {
    const lines = [];
    const capture = chunk => {
        const text = String(chunk);
        for (const line of text.split(/\r?\n/)) {
            if (line.trim() === '') continue;
            lines.push(line.slice(0, 500));
            if (lines.length > 400) lines.shift();
        }
    };
    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);
    return () => lines.join('\n');
}

// ---------------------------------------------------------------------------------------------------
// SERVER BOOTS. The recipes are the ones `third-party-extensions-run.mjs` and
// `run-against-pinned.mjs` already use, including `--browserLaunchEnabled false` and the
// `--configPath` in the condition's own root. The only addition is the wall-clock start captured
// before the spawn, so bootMs is spawn -> identity readiness rather than the readiness helper's own
// elapsed time.
// ---------------------------------------------------------------------------------------------------
async function bootGoTavern(dataRoot) {
    const port = await allocatePort();
    const baseURL = `http://127.0.0.1:${port}`;
    const started = Date.now();
    const child = spawn(binary, [
        'start',
        '--port', String(port),
        '--dataRoot', dataRoot,
        '--configPath', path.join(dataRoot, 'config.yaml'),
        '--browserLaunchEnabled', 'false',
    ], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    const logTail = captureChildOutput(child);
    let exited = false;
    child.on('exit', () => {
        exited = true;
    });
    try {
        const identity = await waitForIdentity({
            baseURL,
            port,
            childAlive: () => !exited,
            childPid: child.pid,
            expectedPkgVersion: PINNED_PACKAGE_VERSION,
            deadlineMs: 180000,
            logTail,
        });
        return {
            baseURL,
            port,
            child,
            identity,
            bootMs: Date.now() - started,
            logTail,
            close: async () => {
                if (child.exitCode === null) child.kill();
                await waitExit(child, 15000);
                if (child.exitCode === null) {
                    child.kill('SIGKILL');
                    await waitExit(child, 5000);
                }
                releasePort(port);
            },
        };
    } catch (error) {
        if (child.exitCode === null) child.kill();
        await waitExit(child, 10000);
        releasePort(port);
        throw error;
    }
}

async function bootPinned(dataRoot) {
    const port = await allocatePort();
    const baseURL = `http://127.0.0.1:${port}`;
    const started = Date.now();
    const child = spawn(process.execPath, [
        'server.js',
        '--port', String(port),
        '--dataRoot', dataRoot,
        '--configPath', path.join(dataRoot, 'config.yaml'),
        '--browserLaunchEnabled', 'false',
    ], { cwd: pinnedReference, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    const logTail = captureChildOutput(child);
    let exited = false;
    child.on('exit', () => {
        exited = true;
    });
    try {
        const identity = await waitForIdentity({
            baseURL,
            port,
            childAlive: () => !exited,
            childPid: child.pid,
            expectedPkgVersion: PINNED_PACKAGE_VERSION,
            // A FRESH PINNED DATA ROOT SEEDS default/** AND COMPILES THE FRONTEND LIBRARIES; the runner's
            // commented measurement is 20-40 s and its override for the same boot is 420 s. This is a
            // readiness bound, not a performance measurement: bootMs is recorded from the spawn.
            deadlineMs: 420000,
            logTail,
        });
        return {
            baseURL,
            port,
            child,
            identity,
            bootMs: Date.now() - started,
            logTail,
            close: async () => {
                if (child.exitCode === null) child.kill();
                await waitExit(child, 15000);
                if (child.exitCode === null) {
                    child.kill('SIGKILL');
                    await waitExit(child, 5000);
                }
                releasePort(port);
            },
        };
    } catch (error) {
        if (child.exitCode === null) child.kill();
        await waitExit(child, 10000);
        releasePort(port);
        throw error;
    }
}

// ---------------------------------------------------------------------------------------------------
// THE EXTENSION SEED. `ensurePinnedExtensionInstalled` installs one extension at its pinned commit,
// from `GOTAVERN_EXTENSION_SEED_ROOT` when it is set (a deterministic copy, no network) and from the
// remote pin otherwise. The seed is built ONCE; the four conditions only ever copy from it.
// ---------------------------------------------------------------------------------------------------
async function installIntoRoot(dataRoot, extension, seedRoot) {
    const previousSeed = process.env.GOTAVERN_EXTENSION_SEED_ROOT;
    if (seedRoot) process.env.GOTAVERN_EXTENSION_SEED_ROOT = seedRoot;
    try {
        const installed = await ensurePinnedExtensionInstalled(dataRoot, extension);
        const revision = await installedRevision(installed.extensionDirectory);
        if (revision !== extension.commit) {
            throw new Error(`installed ${extension.name} at ${revision}, not the pinned ${extension.commit}`);
        }
        return installed;
    } finally {
        if (previousSeed === undefined) delete process.env.GOTAVERN_EXTENSION_SEED_ROOT;
        else process.env.GOTAVERN_EXTENSION_SEED_ROOT = previousSeed;
    }
}

async function prepareSeed() {
    const seedDataRoot = path.join(workRoot, 'seed');
    await fs.mkdir(seedDataRoot, { recursive: true });
    const seedExtensionsRoot = userExtensionsDirectory(seedDataRoot);
    const rows = [];
    let remoteInstalls = 0;
    let reusedInstalls = 0;
    for (const extension of lockInfo.lock.selected) {
        const result = await installIntoRoot(seedDataRoot, extension, null);
        if (result.source === 'remote') remoteInstalls += 1;
        else reusedInstalls += 1;
        rows.push({ name: extension.name, commit: extension.commit, revision: result.revision, source: result.source });
    }
    return { seedDataRoot, seedExtensionsRoot, rows, remoteInstalls, reusedInstalls };
}

// ---------------------------------------------------------------------------------------------------
// BROWSER DRIVE. One fresh browser context per condition (empty cache), so a clean condition cannot be
// served an extension script by the cache and a -20 condition is not judged through a stale one.
// ---------------------------------------------------------------------------------------------------
function extensionNameFromPath(pathname) {
    if (!pathname.startsWith(EXTENSION_ASSET_PREFIX)) return null;
    const segment = pathname.slice(EXTENSION_ASSET_PREFIX.length).split('/')[0];
    try {
        return decodeURIComponent(segment);
    } catch {
        return segment;
    }
}

async function waitForNetworkQuiet(requests, quietMs, deadlineMs) {
    const started = Date.now();
    let lastCount = requests.length;
    let lastChange = Date.now();
    while (Date.now() - started < deadlineMs) {
        await sleep(100);
        if (requests.length !== lastCount) {
            lastCount = requests.length;
            lastChange = Date.now();
        }
        if (!requests.some(entry => entry.status === null) && Date.now() - lastChange >= quietMs) {
            return { quiet: true, waitedMs: Date.now() - started, requests: requests.length };
        }
    }
    return {
        quiet: false,
        waitedMs: Date.now() - started,
        requests: requests.length,
        unresolved: requests.filter(entry => entry.status === null).map(entry => entry.path).slice(0, 20),
    };
}

async function driveBrowser({ browser, baseURL, expectedExtensionNames }) {
    const context = await browser.newContext();
    const page = await context.newPage();
    const navigationStarted = Date.now();
    const requests = [];
    const pageErrors = [];
    const consoleErrors = [];
    const httpFailures = [];
    const liveEgressObservations = [];
    const externalHostObservations = [];
    const extensionAssetFirstSuccess = new Map();
    const failedExtensionAssets = [];
    const pending = new Map();
    page.on('pageerror', error => pageErrors.push(String(error.message ?? error).slice(0, 300)));
    page.on('console', message => {
        if (message.type() === 'error') consoleErrors.push(String(message.text()).slice(0, 500));
    });
    page.on('request', request => {
        const url = new URL(request.url());
        const entry = { method: request.method(), path: url.pathname + url.search, status: null };
        pending.set(request, entry);
        requests.push(entry);
        const host = url.hostname;
        if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
            externalHostObservations.push({ host, path: url.pathname, method: entry.method });
        }
        if (LIVE_EGRESS_PATH_PATTERNS.some(pattern => pattern.test(url.pathname))
            && !liveEgressObservations.some(observation => observation.path === url.pathname)) {
            liveEgressObservations.push({ path: url.pathname, method: entry.method, status: null });
        }
    });
    page.on('response', response => {
        const url = new URL(response.url());
        const entry = pending.get(response.request());
        if (entry) entry.status = response.status();
        const extensionName = extensionNameFromPath(url.pathname);
        if (extensionName !== null) {
            if (response.status() < 400) {
                if (!extensionAssetFirstSuccess.has(extensionName)) {
                    extensionAssetFirstSuccess.set(extensionName, Date.now() - navigationStarted);
                }
            } else {
                failedExtensionAssets.push({ name: extensionName, path: url.pathname, status: response.status() });
            }
        }
        if (LIVE_EGRESS_PATH_PATTERNS.some(pattern => pattern.test(url.pathname))) {
            const observation = liveEgressObservations.find(candidate => candidate.path === url.pathname);
            if (observation) observation.status = response.status();
        }
        if (response.status() >= 400) httpFailures.push(`${response.status()} ${url.pathname}`);
    });
    page.on('requestfailed', request => {
        const url = new URL(request.url());
        httpFailures.push(`FAILED ${request.method()} ${url.pathname}: ${request.failure()?.errorText ?? ''}`);
    });

    const result = {
        available: true,
        clock: 'wall-clock-ms-from-goto-start',
        deadlinesMs: {
            navigation: NAVIGATION_TIMEOUT_MS,
            preloader: PRELOADER_TIMEOUT_MS,
            settingsReadyBudget: SETTINGS_READY_BUDGET_MS,
            assetWait: ASSET_WAIT_MS,
            settleQuiet: SETTLE_QUIET_MS,
            settleDeadline: SETTLE_DEADLINE_MS,
            evaluate: EVALUATE_TIMEOUT_MS,
        },
        msToSettingsReady: null,
        settingsReady: false,
        onboardingCompleted: false,
        msUntilAllExtensionAssetsRequested: null,
        extensionAssets: { expected: expectedExtensionNames.length, observed: 0, loadedNames: [], missing: [], failed: [] },
        extensionContainerCount: null,
        extensionAssetRequestCount: 0,
        requestCount: 0,
        pageErrors: [],
        consoleErrors: [],
        httpFailures: [],
        liveEgressObservations: [],
        externalHostObservations: [],
        settle: null,
        finalState: null,
        failure: null,
    };
    try {
        await page.goto(`${baseURL}/`, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS });
        await page.waitForFunction('document.getElementById("preloader") === null', null, { timeout: PRELOADER_TIMEOUT_MS });
        const readiness = await withTimeout(page.evaluate(async settingsReadyBudgetMs => {
            const outcome = { onboardingCompleted: false, settingsReady: false };
            const script = await import('./script.js');
            const started = performance.now();
            while (performance.now() - started < 15000) {
                if (script.settingsReady) break;
                const onboarding = document.querySelector('.popup .onboarding');
                if (onboarding) {
                    outcome.onboardingCompleted = true;
                    const nameInput = onboarding.closest('.popup')?.querySelector('.popup-input');
                    if (nameInput) {
                        nameInput.value = 'Overhead Probe';
                        nameInput.dispatchEvent(new Event('input', { bubbles: true }));
                    }
                    onboarding.closest('.popup')?.querySelector('.popup-button-ok')?.click();
                    break;
                }
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            while (performance.now() - started < settingsReadyBudgetMs) {
                if (script.settingsReady) {
                    outcome.settingsReady = true;
                    break;
                }
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            return outcome;
        }, SETTINGS_READY_BUDGET_MS), EVALUATE_TIMEOUT_MS, 'page readiness evaluation');
        result.settingsReady = readiness.settingsReady === true;
        result.onboardingCompleted = readiness.onboardingCompleted === true;
        result.msToSettingsReady = result.settingsReady ? Date.now() - navigationStarted : null;

        if (expectedExtensionNames.length > 0) {
            const deadline = Date.now() + ASSET_WAIT_MS;
            while (Date.now() < deadline) {
                if (expectedExtensionNames.every(name => extensionAssetFirstSuccess.has(name))) break;
                await sleep(250);
            }
            if (expectedExtensionNames.every(name => extensionAssetFirstSuccess.has(name))) {
                result.msUntilAllExtensionAssetsRequested = Math.max(
                    ...expectedExtensionNames.map(name => extensionAssetFirstSuccess.get(name)),
                );
            } else {
                result.msUntilAllExtensionAssetsRequestedReason = `only ${extensionAssetFirstSuccess.size} of ${expectedExtensionNames.length} extension asset sets were observed within the ${ASSET_WAIT_MS} ms window`;
            }
        } else {
            result.msUntilAllExtensionAssetsRequestedReason = 'no extensions are installed in the clean condition, so the expected set is empty and there is no completion moment to measure';
        }

        result.settle = await waitForNetworkQuiet(requests, SETTLE_QUIET_MS, SETTLE_DEADLINE_MS);
        result.requestCount = requests.length;
        result.extensionAssetRequestCount = requests.filter(entry => extensionNameFromPath(entry.path.split('?')[0]) !== null).length;
        result.extensionAssets = {
            expected: expectedExtensionNames.length,
            observed: extensionAssetFirstSuccess.size,
            loadedNames: [...extensionAssetFirstSuccess.keys()].sort(),
            missing: expectedExtensionNames.filter(name => !extensionAssetFirstSuccess.has(name)).sort(),
            failed: failedExtensionAssets.slice(0, 40),
        };
        result.finalState = await withTimeout(page.evaluate(async () => {
            const script = await import('./script.js');
            return {
                settingsReady: Boolean(script.settingsReady),
                title: document.title,
                extensionContainerCount: document.querySelectorAll('#extensions_settings2 .extension_container, #extensions_settings .extension_container').length,
                extensionSettingsPresent: Boolean(document.querySelector('#extensions_settings, #extensions_settings2')),
                characterListPresent: Boolean(document.querySelector('#rm_print_characters_block')),
            };
        }), EVALUATE_TIMEOUT_MS, 'final-state evaluation');
        result.extensionContainerCount = result.finalState.extensionContainerCount;
        result.pageErrors = pageErrors.slice(0, 20);
        result.consoleErrors = consoleErrors.slice(0, 20);
        result.httpFailures = httpFailures.slice(0, 40);
        result.liveEgressObservations = liveEgressObservations.slice(0, 20);
        result.externalHostObservations = externalHostObservations.slice(0, 20);
    } catch (error) {
        result.failure = String(error.message ?? error);
        result.pageErrors = pageErrors.slice(0, 20);
        result.consoleErrors = consoleErrors.slice(0, 20);
        result.httpFailures = httpFailures.slice(0, 40);
        result.liveEgressObservations = liveEgressObservations.slice(0, 20);
        result.externalHostObservations = externalHostObservations.slice(0, 20);
        result.requestCount = requests.length;
    } finally {
        await withTimeout(context.close().catch(() => {}), CONTEXT_CLOSE_TIMEOUT_MS, 'browser context close').catch(() => {});
    }
    return result;
}

// ---------------------------------------------------------------------------------------------------
// ONE CONDITION. Every condition gets its own root, its own config copy and (for -20) its own copies
// of the seeded checkouts. Cleanup happens in `finally` and only touches the child this run spawned.
// ---------------------------------------------------------------------------------------------------
async function runCondition(spec, seed) {
    const condition = {
        id: spec.id,
        subject: spec.subject,
        extensions: spec.withExtensions ? 'pinned-20' : 'none',
        startedAt: new Date().toISOString(),
        dataRoot: null,
        configSha256: null,
        installedExtensions: [],
        installSources: {},
        boot: null,
        rss: null,
        latency: null,
        browser: null,
        failure: null,
        durationMs: null,
    };
    const conditionRoot = path.join(workRoot, 'conditions', `${spec.id}-${Date.now()}`);
    const started = Date.now();
    let server = null;
    let browser = null;
    try {
        await fs.mkdir(conditionRoot, { recursive: true });
        condition.dataRoot = path.relative(workRoot, conditionRoot).replace(/\\/g, '/');
        const config = await seedLegConfig(conditionRoot);
        condition.configSha256 = config.sha256;
        if (spec.withExtensions) {
            const sources = { seed: 0, existing: 0, remote: 0 };
            for (const extension of lockInfo.lock.selected) {
                const installed = await installIntoRoot(conditionRoot, extension, seed.seedExtensionsRoot);
                sources[installed.source] = (sources[installed.source] ?? 0) + 1;
                condition.installedExtensions.push({ name: extension.name, commit: extension.commit, revision: installed.revision });
            }
            condition.installSources = sources;
        }
        server = spec.subject === 'gotavern' ? await bootGoTavern(conditionRoot) : await bootPinned(conditionRoot);
        condition.boot = {
            bootMs: server.bootMs,
            identityMethod: server.identity.identityMethod,
            pkgVersion: server.identity.version.pkgVersion,
            gitRevision: typeof server.identity.version.gitRevision === 'string' ? server.identity.version.gitRevision : null,
        };
        const bootRss = readRss(server.child.pid);
        condition.rss = {
            bootBytes: bootRss.bytes,
            method: bootRss.method,
            unavailableReason: bootRss.reason,
            afterIdleBytes: null,
            idleDeltaBytes: null,
            idleWindowMs: 10000,
        };
        // The idle window is measured BEFORE any latency traffic, so it is an idle delta rather than a
        // "10 s after N warm requests" delta.
        await sleep(10000);
        const idleRss = readRss(server.child.pid);
        condition.rss.afterIdleBytes = idleRss.bytes;
        condition.rss.idleDeltaBytes = subtract(idleRss.bytes, bootRss.bytes);
        if (condition.rss.unavailableReason === null && idleRss.reason !== null) condition.rss.unavailableReason = idleRss.reason;
        condition.latency = {
            version: await sampleLatency(server.baseURL, '/version', samples, { verifyVersion: true }),
            root: await sampleLatency(server.baseURL, '/', samples),
        };

        if (chromium) {
            browser = await chromium.launch({ headless: true });
            condition.browser = await driveBrowser({
                browser,
                baseURL: server.baseURL,
                expectedExtensionNames: spec.withExtensions ? lockInfo.lock.selected.map(extension => extension.name) : [],
            });
            if (condition.browser.failure) {
                condition.failure = `browser drive failed: ${condition.browser.failure}`;
            } else if (condition.browser.settingsReady !== true) {
                condition.failure = 'the page never reached settingsReady, so its readiness and extension measurements are not comparable';
            }
        } else {
            condition.browser = {
                available: false,
                reason: `the browser driver is unavailable: ${playwrightError ?? 'unknown reason'}`,
                msToSettingsReady: null,
                msUntilAllExtensionAssetsRequested: null,
            };
        }
    } catch (error) {
        condition.failure = condition.failure ?? `condition failed: ${error.message ?? error}`;
        condition.serverLogTail = server?.logTail ? server.logTail().slice(-3000) : null;
    } finally {
        if (browser) await withTimeout(browser.close().catch(() => {}), BROWSER_CLOSE_TIMEOUT_MS, 'browser close').catch(() => {});
        if (server) await server.close().catch(() => {});
        condition.durationMs = Date.now() - started;
    }

    // THE -20 VALIDITY RULE: the overhead number is only meaningful on a corpus that actually loaded.
    // A clean condition has no set to load, so it records NULL (with its reason) rather than a fake 0.
    if (spec.withExtensions) {
        const assets = condition.browser?.extensionAssets ?? null;
        if (!condition.failure && assets && assets.missing.length > 0) {
            condition.failure = `only ${assets.observed}/${assets.expected} extension assets loaded; missing: ${assets.missing.join(', ')}${assets.failed.length ? `; failed requests: ${assets.failed.map(failure => `${failure.name}(${failure.status})`).join(', ')}` : ''}`;
        } else if (!condition.failure && !condition.browser?.available) {
            condition.failure = `all 20 extension assets could not be verified because the browser driver is unavailable: ${condition.browser?.reason ?? 'unknown reason'}`;
        } else if (!condition.failure && assets && assets.observed !== assets.expected) {
            condition.failure = `observed ${assets.observed} extension asset sets, expected ${assets.expected}`;
        }
    }
    if (!keep) await fs.rm(conditionRoot, { recursive: true, force: true }).catch(() => {});
    return condition;
}

// ---------------------------------------------------------------------------------------------------
// REPORT.
// ---------------------------------------------------------------------------------------------------
function conditionById(conditions, id) {
    return conditions.find(condition => condition.id === id) ?? null;
}

function buildComparison(conditions) {
    const buildPair = subject => {
        const clean = conditionById(conditions, `${subject}-clean`);
        const twenty = conditionById(conditions, `${subject}-20`);
        const missing = [];
        if (!clean) missing.push(`${subject}-clean is missing or failed to boot`);
        if (!twenty) missing.push(`${subject}-20 is missing or failed to boot`);
        return {
            bootMsDelta: missing.length ? null : subtract(twenty.boot?.bootMs, clean.boot?.bootMs),
            rssBootBytesDelta: missing.length ? null : subtract(twenty.rss?.bootBytes, clean.rss?.bootBytes),
            versionP50MsDelta: missing.length ? null : subtract(twenty.latency?.version?.p50Ms, clean.latency?.version?.p50Ms),
            unavailable: missing.length ? missing : null,
        };
    };
    return {
        convention: 'delta = (<subject>-20) minus (<subject>-clean); a positive delta means the 20-extension condition was larger or slower. Boot and latency deltas are milliseconds, RSS is bytes. No regression/speedup assertion is made.',
        gotavern: buildPair('gotavern'),
        pinned: buildPair('pinned'),
    };
}

function buildTable(conditions) {
    const rows = conditions.map(condition => ({
        condition: condition.id,
        bootMs: condition.boot?.bootMs ?? null,
        rssBootMB: condition.rss?.bootBytes === null || condition.rss?.bootBytes === undefined ? null : round(condition.rss.bootBytes / (1024 * 1024), 1),
        rssIdleDeltaMB: condition.rss?.idleDeltaBytes === null || condition.rss?.idleDeltaBytes === undefined ? null : round(condition.rss.idleDeltaBytes / (1024 * 1024), 1),
        verP50Ms: condition.latency?.version?.p50Ms ?? null,
        rootP50Ms: condition.latency?.root?.p50Ms ?? null,
        msToSettingsReady: condition.browser?.msToSettingsReady ?? null,
        assets: condition.browser?.extensionAssets
            ? `${condition.browser.extensionAssets.observed}/${condition.browser.extensionAssets.expected}`
            : null,
        msUntilAllAssets: condition.browser?.msUntilAllExtensionAssetsRequested ?? null,
        containers: condition.browser?.extensionContainerCount ?? null,
        pageErrors: condition.browser?.pageErrors?.length ?? null,
        consoleErrors: condition.browser?.consoleErrors?.length ?? null,
    }));
    const columns = ['condition', 'bootMs', 'rssBootMB', 'rssIdleDeltaMB', 'verP50Ms', 'rootP50Ms', 'msToSettingsReady', 'assets', 'msUntilAllAssets', 'containers', 'pageErrors', 'consoleErrors'];
    const widths = {};
    for (const column of columns) {
        widths[column] = Math.max(column.length, ...rows.map(row => String(row[column] ?? 'null').length));
    }
    const line = row => columns.map(column => String(row[column] ?? 'null').padEnd(widths[column])).join('  ');
    const lines = [line(Object.fromEntries(columns.map(column => [column, column]))), columns.map(column => '-'.repeat(widths[column])).join('  ')];
    for (const row of rows) lines.push(line(row));
    for (const condition of conditions) if (condition.failure) lines.push(`FAILED ${condition.id}: ${condition.failure}`);
    return lines.join('\n');
}

const report = {
    schemaVersion: 1,
    surface: 'third-party-extension-overhead',
    question: 'On one runner, with the same pinned config and the same pinned extension corpus, what does having all 20 third-party extensions installed cost stock SillyTavern and GoTavern in boot time, memory, request latency and page readiness?',
    provenance: {
        repository: process.env.GITHUB_REPOSITORY ?? null,
        workflow: process.env.GITHUB_WORKFLOW ?? null,
        runId: process.env.GITHUB_RUN_ID ?? null,
        runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
        headSha: process.env.GITHUB_SHA ?? null,
        ref: process.env.GITHUB_REF ?? null,
        event: process.env.GITHUB_EVENT_NAME ?? null,
        stockSillyTavernSha: STOCK_SILLYTAVERN_SHA,
        pinnedCheckoutSha: pinnedCheckoutSha,
        extensionsLockSha256: lockInfo.sha256,
        selectedExtensions: lockInfo.lock.selected.length,
        gotavernBinary: path.basename(binary),
        gotavernBinarySha256: createHash('sha256').update(await fs.readFile(binary)).digest('hex'),
        runner: {
            os: process.platform,
            arch: process.arch,
            node: process.version,
            cpuCount: os.cpus().length,
            totalMemoryBytes: os.totalmem(),
        },
        startedAt,
        samples,
        keepConditionRoots: keep,
        configSource: 'upstream/default/config.yaml',
    },
    conditions: [],
    comparison: null,
    notes: [],
};

const notes = report.notes;
let exitCode = 1;
try {
    // The tokenizer tree is part of a release installation, not of a bare `go build`; staging it beside the
    // executable keeps the GoTavern condition in the shape a user runs (and the runner already does this).
    const installRoot = path.dirname(binary);
    if (!existsSync(path.join(installRoot, 'tokenizers', 'tiktoken', 'model_to_encoding.json'))
        && !existsSync(path.join(installRoot, 'src', 'tokenizers', 'tiktoken', 'model_to_encoding.json'))) {
        await fs.cp(path.join(repoRoot, 'upstream', 'tokenizers'), path.join(installRoot, 'tokenizers'), { recursive: true });
        notes.push('the GoTavern binary was a bare build: the pinned tokenizer tree was staged beside it so the condition matches a release installation');
    }

    const seed = await prepareSeed();
    report.seed = {
        dataRoot: path.relative(workRoot, seed.seedDataRoot).replace(/\\/g, '/'),
        extensionsRoot: 'seed/default-user/extensions',
        installed: seed.rows,
        networkInstallsAtSetup: seed.remoteInstalls,
        reusedExistingInstalls: seed.reusedInstalls,
    };
    notes.push(`extension seed: ${seed.remoteInstalls} extension(s) installed from their remote pins at setup, ${seed.reusedInstalls} reused from an existing seed; every condition was then installed from the local seed through GOTAVERN_EXTENSION_SEED_ROOT, so no measurement touches the network`);
    notes.push('browser RSS is not recorded: the browser process memory is not reliably attributable to the page/extension corpus, and the task forbids inventing it.');
    notes.push('RSS is the process working set at the sampling point, not a peak; the platform method is recorded per condition and the 10 s idle delta is recorded beside the boot reading.');
    notes.push(`HTTP latency is ${samples} sample(s) per route with no discarded warm-up; /version latency includes the body read.`);
    notes.push('no provider is configured in any condition; a page request under /api/horde/ or another live-egress prefix is recorded as an observation only and no response body is asserted.');
    notes.push('a -20 condition is valid when EACH of the 20 extensions produced at least one successful request under its /scripts/extensions/third-party/<name>/ prefix; failing sub-resources are listed in extensionAssets.failed but do not by themselves invalidate the corpus (the same load criterion the extension lifecycle gate uses).');
    notes.push('the four conditions ran sequentially on one runner in the listed order; nothing was reused between them except the pinned config bytes, the pinned corpus seed and the runner itself.');
    notes.push('page readiness is a wall-clock measurement from the navigation start, so it includes the network and browser scheduling on this runner; it is comparable across the four conditions but is not a browser-internal performance number.');

    for (const spec of CONDITION_SPECS) {
        console.log(`\n--- ${spec.id} ---`);
        const condition = await runCondition(spec, seed);
        report.conditions.push(condition);
        console.log(`${condition.failure ? 'FAILED' : 'ok'}: ${spec.id}${condition.failure ? ` (${condition.failure})` : ''}`);
    }

    if (!chromium) {
        notes.push(`the browser driver is unavailable (${playwrightError}); server-side metrics were still measured, but a -20 condition cannot be declared valid, so the run exits 1.`);
    }
    notes.push('GOTAVERN_MOCK_PROVIDER_BINARY is accepted for symmetry with the other lanes and intentionally unused: no provider is configured, so nothing in these numbers depends on a provider peer.');
    if (!keep) {
        notes.push('condition data roots were removed after the report; the --keep flag retains them. The extension seed cache under <work-root>/seed is always kept so a re-run is offline.');
    }
    report.comparison = buildComparison(report.conditions);
    exitCode = report.conditions.length === CONDITION_SPECS.length && report.conditions.every(condition => !condition.failure) ? 0 : 1;
    if (exitCode !== 0) {
        notes.push('at least one condition failed; the comparison block is still written with nulls for any pair that could not be measured, and no delta is inferred.');
    }
} catch (error) {
    report.setupFailure = String(error.message ?? error);
    notes.push(`setup failed before all conditions could run: ${report.setupFailure}`);
    exitCode = 1;
}

const reportPath = path.join(workRoot, 'extension-overhead.json');
await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);

console.log('\n=== third-party extension overhead ===');
if (report.setupFailure) console.error(`setupFailure: ${report.setupFailure}`);
console.log(buildTable(report.conditions));
if (report.comparison) {
    console.log('\ncomparison (-20 minus -clean; RSS in bytes, boot/latency in ms; NULL means the pair could not be measured):');
    for (const subject of ['gotavern', 'pinned']) {
        const pair = report.comparison[subject];
        console.log(`  ${subject}: bootMs delta ${pair.bootMsDelta === null ? 'null' : pair.bootMsDelta}`
            + ` | rssBoot delta ${pair.rssBootBytesDelta === null ? 'null' : pair.rssBootBytesDelta} bytes`
            + ` | /version p50 delta ${pair.versionP50MsDelta === null ? 'null' : pair.versionP50MsDelta} ms`);
    }
}
console.log('\nnotes:');
for (const note of report.notes) console.log(`  - ${note}`);
console.log(`\nreport: ${reportPath}`);
process.exit(exitCode);
