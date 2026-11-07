#!/usr/bin/env node
// M5 ROW: 8 CONCURRENT USER ACCOUNTS WRITING OVERLAPPING SETTINGS AND CHATS.
//
// WHY THIS FILE EXISTS. docs/alpha16/baseline/README.md section4 item 2 names the gap in one sentence: "8-user
// concurrent writes. The plan's E06 needs overlapping save/load/delete/rename/import and cross-user
// isolation under contention. No record above drives more than one user; settingsSaveMu's cross-user
// contention is therefore an untested hypothesis, not a measured fact." The existing correctness harnesses
// stop short of it: tests/e2e/a15_concurrent_writers_test.go drives TWO PROCESSES on ONE data root (one
// user), and scripts/a15-bench-suite.mjs --mode concurrency drives 32/128 in-flight requests on ONE route
// as ONE user (scripts/a15-bench-suite.mjs:836-910). Neither can observe eight accounts whose writes are
// serialized by one settingsSaveMu (internal/server/settings_save.go:50-75).
//
// WHAT IT MEASURES. One real GoTavern binary, one fresh data root, accounts enabled, EIGHT accounts, each
// with its own browser-equivalent session (CSRF token + signed cookie, the same three-step handshake the
// frontend performs). Each wave issues, concurrently across the eight accounts:
//   * POST /api/settings/save  (a ~48 KiB document whose marker names account+wave)
//   * POST /api/settings/get   (the load half: reads what this account wrote)
//   * POST /api/chats/save     (a per-account JSONL chat whose marker names account+wave)
// and records every request's wall time. After the waves it reads the files on disk and asserts that each
// account's document/chats contain that account's LAST marker and no other account's marker. Every route's
// p50/p95/p99/max and the end-to-end throughput are written into the JSON report.
//
// READINESS MUST NOT DEPEND ON THE AUTH POLICY THIS ROW ITSELF TURNS ON (added after the first real dispatch,
// GoTavern M5 measurements 42209241061 at 6077405, failed `boot/timeout ... last: GET /version answered 403`).
// bootSubject writes `enableUserAccounts: true`, and with accounts on BOTH servers put /version behind their
// login middleware: pinned mounts `app.use(requireLoginMiddleware)` at src/server-main.js:248 BEFORE the
// /version route at :272, and src/users.js:1027-1030 answers `sendStatus(403)` ("Forbidden") for an anonymous
// request -- recorded in tests/oracle/sillytavern-1.19.0-account-session.json `unauthenticatedVersion`;
// GoTavern refuses every non-public route with 403 at internal/server/http.go:612-614 and pins that against
// the same fixture (internal/server/accounts_test.go:196-201). The old check therefore asked the subject to
// contradict the contract the row is built on; the harness was wrong, not the product. Readiness is now the
// PUBLIC GET /csrf-token route (pinned src/server-main.js:192, before the auth middleware; GoTavern
// isPublicAccountRequest at internal/server/accounts.go:589-610), then the pinned version record read the way
// an authenticated client reads it: if the anonymous GET /version is a 403, log in as the admin the product
// seeds in an empty user store (pinned src/users.js:556-570; GoTavern internal/startup/storage.go) and read it
// again. Every stage fails by name rather than timing out anonymously.
//
// WHAT IT DOES NOT PROVE (recorded in the report's `unproven` array):
//   * the absolute numbers are only comparable WITHIN one runner image AND one host disk performance class.
//     This row's measured routes are fsync-bound (every save is an atomic write), so a host whose storage is
//     slower by several times can move p95 by several times with NO product difference -- measured 2026-11-06:
//     the same product code produced 287.4 ops/s on an Intel Xeon 8573C host and 49.8 ops/s on an AMD EPYC 9V45
//     host, with chat-save p95 87.7 ms vs 614.8 ms. The report therefore carries a DISK FINGERPRINT
//     (sync-write p50/p95/max over the same filesystem and body size the row writes) and, when a threshold
//     file carries one, a cross-host comparison is REFUSED by name instead of grading routes on a host whose
//     storage is not comparable. A refusal is a red run, never a silent pass;
//   * it does not drive delete/rename/import (E06's remaining verbs) - this row is the write/load/isolation
//     cost row, not the whole E06 matrix;
//   * no threshold is asserted unless one is supplied (M5_8USER_MAX_P95_MS). The first run of a new row has
//     no noise estimate, and docs/alpha16/baseline/README.md section5 forbids choosing a threshold after seeing
//     the result. Until two same-tree runs exist, the row is REPORTED, and it fails only on correctness.
//
// WHY NODE, NOT A GO TEST. Every performance row in this repository is a Node harness on a built binary
// (scripts/smoke-metrics.mjs, tests/perf/q22-paired-benchmark.mjs, scripts/a15-bench-suite.mjs,
// tests/browser/extension-overhead.mjs), because the subject must be a shipped process, not a test binary.
// A Go test would also carry this row into `go test ./...` on every push.
//
// USAGE
//   node tests/perf/m5-eight-users.mjs --self-test
//       Pure Node: validates the percentile/threshold/isolation logic and drives the SAME measurement code
//       against an in-process CONTRACT STUB (an HTTP server implementing the documented handshake and write
//       shapes). Proves the row runs and that each named failure fires. No product, no browser, no network.
//   node tests/perf/m5-eight-users.mjs --binary <gotavern-binary> --report <out.json>
//       [--users 8] [--waves 6] [--body-bytes 49152] [--max-seconds 180] [--keep]
//       [--load-label TEXT] [--thresholds-json <existing-report.json> ...]
//       The real measurement. On a failure the report is STILL written, with ok=false and the failed check
//       named, because a red run's numbers are the only evidence it produced.
//
// EXIT CODES: 0 all checks held; 1 a named check failed (report written); 2 usage error.
//
// THRESHOLD SOURCE. Each `--thresholds-json` names a PREVIOUS report of this same row, and the option is
// REPEATABLE so a ratification series can supply all its repeated baselines. Each route's ceiling is
// (1 + max(25%, that route's measured spread across the baseline reports)) x the WORST p95 observed for that
// route, and the run asserts its p95 does not exceed it. BOTH parts are load-bearing and both are derived
// ONLY from the baseline reports, never from the run under test: the 2026-11-07 repeats had each route peak
// in a different run (settingsSave 116.3/117.6/112.3 ms, settingsGet 57.8/35.8/40.6 ms, chatsSave
// 87.6/115.4/87.9 ms), so a single run taken for all three routes under-covered settingsGet, and the
// same-code spread reached 1.615x on settingsGet, so a fixed 1.25x ceiling fails the baseline against itself.
// Without any file nothing is asserted about latency, and the report says so.
//
// THE HOST MUST BE COMPARABLE FIRST. If the previous report carries `environment.disk.p50` (the host's TYPICAL
// sync-write, which is the stable part of the distribution; p95 of a 12-sample probe is one outlier) and this
// host's typical sync write is more than max(3x, +2 ms) worse, the run fails closed with `threshold/host-disk`
// and the per-route ceilings are NOT applied: a route p95 measured on degraded storage says nothing about the
// product. The rule is a REFUSAL to grade, not a widening of the tolerance -- a real regression on a comparable
// host is still red at the same 25 % ceiling.

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { existsSync, readFileSync, statSync, openSync, writeSync, fsyncSync, closeSync, unlinkSync, mkdirSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const SURFACE = 'm5-eight-users';
const SCHEMA_VERSION = 1;
const DEFAULT_USERS = 8;
const DEFAULT_WAVES = 6;
const DEFAULT_BODY_BYTES = 48 * 1024;
const DEFAULT_MAX_SECONDS = 180;
const REQUEST_TIMEOUT_MS = 30_000;
const BOOT_DEADLINE_MS = 120_000;
const DEFAULT_THRESHOLD_TOLERANCE = 0.25;
const CHAT_CARD = 'M5Card';
const CHAT_FILE = 'm5';
const HANDLE_PREFIX = 'm5user';
const PASSWORD = 'm5-bench-password';
const MARKER_PREFIX = 'M5_MARK';

// ---------------------------------------------------------------------------------------------------------
// FAILURES ARE NAMED. A harness that reports "the run failed" costs a turn to localise; every refusal and
// every failed check carries `m5-8users/<check>` so the log names the thing that broke.
// ---------------------------------------------------------------------------------------------------------
class HarnessFailure extends Error {
    constructor(check, detail) {
        super(`${check}: ${detail}`);
        this.name = 'HarnessFailure';
        this.check = check;
        this.detail = detail;
    }
}

function refuse(check, detail) {
    throw new HarnessFailure(check, detail);
}

function argumentValue(argv, name, fallback = null) {
    const index = argv.indexOf(name);
    if (index < 0) return fallback;
    const value = argv[index + 1];
    return value === undefined ? fallback : value;
}

// Every value of a repeatable option, in argv order. `--thresholds-json` is repeatable so a ratification
// series can supply all its repeated baselines and let each route use its own worst observation.
function argumentValues(argv, name) {
    const values = [];
    for (let index = 0; index < argv.length; index += 1) {
        if (argv[index] !== name) continue;
        const value = argv[index + 1];
        if (value !== undefined && value !== '') values.push(value);
        index += 1;
    }
    return values;
}

function optionalNumber(value, fallback) {
    if (value === null || value === undefined || String(value).trim() === '') return fallback;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return parsed;
}

// ---------------------------------------------------------------------------------------------------------
// PURE MATH. `percentile` matches scripts/a15-bench-suite.mjs:423-427 so a number from this row and a number
// from the process-level suite mean the same thing (nearest-rank, 1-based index, clamped).
// ---------------------------------------------------------------------------------------------------------
function percentile(sorted, fraction) {
    if (sorted.length === 0) return null;
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
    return sorted[index];
}

function summarise(values) {
    if (values.length === 0) return { count: 0, min: null, median: null, max: null, p50: null, p95: null, p99: null };
    const sorted = [...values].sort((left, right) => left - right);
    return {
        count: sorted.length,
        min: sorted[0],
        p50: percentile(sorted, 0.5),
        median: sorted[Math.floor(sorted.length / 2)],
        p95: percentile(sorted, 0.95),
        p99: percentile(sorted, 0.99),
        max: sorted[sorted.length - 1],
    };
}

/**
 * Thresholds are a SEPARATE decision from the observation. `deriveThresholds` turns one or more previous
 * reports of this row into per-route ceilings, or returns null when there is no usable previous report (then
 * the row reports only).
 *
 * WITH REPEATED BASELINES, EACH ROUTE USES ITS OWN WORST OBSERVATION AND ITS OWN MEASURED NOISE. The
 * 2026-11-07 ratification series showed that the routes do not peak together (settingsSave 116.3/117.6/112.3,
 * settingsGet 57.8/35.8/40.6, chatsSave 87.6/115.4/87.9 ms), so one run taken for all routes under-covers
 * whichever route peaked elsewhere. It also showed that a fixed 25 % tolerance is smaller than this row's own
 * same-code repeat spread (settingsGet min-to-max 1.615x, chatsSave 1.317x across the three baselines), so a
 * 1.25x ceiling fails the baseline against itself on those routes. The ratified rule is therefore:
 *
 *     ceiling(route) = max p95 observed for that route
 *                      x (1 + max(tolerance, max_p95/min_p95 - 1 across the baseline reports))
 *
 * where the per-route tolerance is DERIVED ONLY FROM THE BASELINE series, never from the AFTER run. The
 * floor keeps a genuinely quiet route (spread < tolerance) on the documented 25 % rule; the derived part is
 * this row's measured repeat noise. The host comparability fingerprint is the HIGHEST median across the
 * baseline reports, i.e. the most conservative host class represented; a run outside it is refused by name.
 */
function deriveThresholds(previousReports, tolerance = DEFAULT_THRESHOLD_TOLERANCE) {
    if (!previousReports) return null;
    const reports = Array.isArray(previousReports)
        ? previousReports.filter(report => report !== null && typeof report === 'object')
        : [previousReports];
    if (reports.length === 0) return null;
    const observed = {}; // route -> array of p95 values across usable reports
    let diskMedian = null;
    for (const report of reports) {
        const routes = report?.results?.routes;
        if (routes && typeof routes === 'object') {
            for (const [route, summary] of Object.entries(routes)) {
                const p95 = Number(summary?.p95);
                if (!Number.isFinite(p95) || p95 <= 0) continue;
                (observed[route] ??= []).push(p95);
            }
        }
        const median = Number(report?.environment?.disk?.p50);
        if (Number.isFinite(median) && median > 0) diskMedian = Math.max(diskMedian ?? 0, median);
    }
    const ceilings = {};
    const routeTolerance = {};
    for (const [route, values] of Object.entries(observed)) {
        const worst = Math.max(...values);
        const best = Math.min(...values);
        // One baseline report cannot measure noise: it keeps the documented tolerance unchanged.
        const observedSpread = values.length > 1 ? worst / best - 1 : 0;
        const effectiveTolerance = Math.max(tolerance, observedSpread);
        ceilings[route] = Math.round(worst * (1 + effectiveTolerance) * 1000) / 1000;
        routeTolerance[route] = Math.round(effectiveTolerance * 1000) / 1000;
    }
    if (Object.keys(ceilings).length === 0) return null;
    return {
        source: reports.length === 1
            ? 'previous report of this row'
            : `worst per-route p95 across ${reports.length} previous reports of this row, with each route's tolerance widened to its measured baseline spread when that exceeds the default`,
        tolerance,
        routeTolerance,
        routeP95Ms: ceilings,
        maxErrorRate: 0,
        // null means "none of the previous reports carries a disk fingerprint"; the host check is then not
        // asserted and the report says so, rather than inventing a comparability claim from a missing
        // measurement.
        diskMedianMs: diskMedian,
    };
}

/**
 * A host-storage fingerprint: the same 48 KiB-ish sync write the measured routes perform, on the same
 * filesystem the row writes to. Absolute values are host-relative; the number exists only to decide whether
 * two reports may be compared. Synchronous on purpose: the probe must not be perturbed by the event loop.
 */
function measureDiskFingerprint(directory, bodyBytes, samples = 12) {
    const probeDirectory = path.join(directory, '.m5-disk-fingerprint');
    const timings = [];
    const payload = Buffer.alloc(Math.max(1, Math.trunc(bodyBytes)), 0x61);
    try {
        mkdirSync(probeDirectory, { recursive: true });
        for (let index = 0; index < samples; index += 1) {
            const target = path.join(probeDirectory, `probe-${process.pid}-${index}.bin`);
            const startedAt = process.hrtime.bigint();
            const descriptor = openSync(target, 'w');
            try {
                writeSync(descriptor, payload);
                fsyncSync(descriptor);
            } finally {
                closeSync(descriptor);
            }
            timings.push(Number(process.hrtime.bigint() - startedAt) / 1e6);
            unlinkSync(target);
        }
    } catch (error) {
        return { ok: false, error: String(error?.message ?? error), samples: [], p50: null, p95: null, max: null };
    }
    const summary = summarise(timings);
    return {
        ok: true,
        method: 'open+write+fsync+close+unlink of bodyBytes on the work-root filesystem, synchronous, once before boot',
        bytes: payload.length,
        count: summary.count,
        p50: summary.p50,
        p95: summary.p95,
        max: summary.max,
        samples: timings.map(value => Math.round(value * 1000) / 1000),
    };
}

// A comparison is refused when this host's TYPICAL storage latency (median) is more than HOST_DISK_RATIO times
// the recorded one AND more than HOST_DISK_ABSOLUTE_SLACK_MS slower. The median is used because the probe's p95
// over 12 samples is a single slow sync, and a single outlier must not decide that a host is different. The slack
// keeps a sub-millisecond baseline from making normal jitter look like a different host; the ratio covers the
// multi-fold differences actually observed.
const HOST_DISK_RATIO = 3;
const HOST_DISK_ABSOLUTE_SLACK_MS = 2;

/**
 * Evaluate the supplied thresholds. Every problem NAMES the route and both numbers, because "the p95 was too
 * high" is not a finding a reader can check. A host-storage mismatch is checked FIRST and, when it fires, the
 * route ceilings are not applied -- they would measure the host, not the product.
 */
function evaluateThresholds(report, thresholds) {
    const problems = [];
    if (!thresholds) return problems;
    const baselineDisk = Number(thresholds.diskMedianMs);
    const observedDisk = Number(report?.environment?.disk?.p50);
    if (Number.isFinite(baselineDisk) && baselineDisk > 0 && !Number.isFinite(observedDisk)) {
        problems.push({ check: 'threshold/host-disk', detail: `the previous report recorded a disk fingerprint median of ${baselineDisk} ms but this run recorded none, so its route timings cannot be compared across hosts` });
        return problems;
    }
    if (Number.isFinite(baselineDisk) && baselineDisk > 0 && Number.isFinite(observedDisk)) {
        const ceiling = Math.max(baselineDisk * HOST_DISK_RATIO, baselineDisk + HOST_DISK_ABSOLUTE_SLACK_MS);
        if (observedDisk > ceiling) {
            problems.push({
                check: 'threshold/host-disk',
                detail: `this host's typical sync-write is ${observedDisk} ms, above the comparable ceiling ${Math.round(ceiling * 1000) / 1000} ms derived from the previous run's ${baselineDisk} ms; the route p95 ceilings were NOT applied because this row is fsync-bound and a slower host measures the disk, not the product - re-run on a comparable host or record a new baseline`,
            });
            return problems;
        }
    }
    for (const [route, ceiling] of Object.entries(thresholds.routeP95Ms ?? {})) {
        const observed = report?.results?.routes?.[route]?.p95;
        if (!Number.isFinite(observed)) {
            problems.push({ check: `threshold/${route}-p95`, detail: `route ${route} produced no p95, so its ceiling ${ceiling} ms cannot be asserted` });
            continue;
        }
        if (observed > ceiling) {
            const effective = thresholds.routeTolerance?.[route] ?? thresholds.tolerance;
            problems.push({ check: `threshold/${route}-p95`, detail: `route ${route} p95 is ${observed} ms, above the recorded ceiling ${ceiling} ms (worst baseline p95 x (1 + ${effective}))` });
        }
    }
    const errorRate = report?.results?.errorRate ?? 0;
    if (Number.isFinite(thresholds.maxErrorRate) && errorRate > thresholds.maxErrorRate) {
        problems.push({ check: 'threshold/error-rate', detail: `error rate is ${errorRate}, above the ceiling ${thresholds.maxErrorRate}` });
    }
    return problems;
}

// ---------------------------------------------------------------------------------------------------------
// HTTP SESSION. The cookie jar + CSRF handshake is the same shape scripts/a15-bench-suite.mjs:359-412 uses,
// because the product requires it for every POST and both must measure the route rather than the handshake.
// ---------------------------------------------------------------------------------------------------------
class HttpSession {
    constructor(origin, label) {
        this.origin = origin;
        this.label = label;
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

    async fetchJson(route, init = {}) {
        const started = process.hrtime.bigint();
        let response;
        try {
            response = await fetch(`${this.origin}${route}`, {
                ...init,
                headers: this.headers(init.headers ?? {}),
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            });
        } catch (error) {
            refuse(`request/${this.label}${route}`, `${this.label} ${route} did not complete within ${REQUEST_TIMEOUT_MS} ms: ${error?.message ?? error}`);
        }
        const bytes = Buffer.from(await response.arrayBuffer());
        const ms = Number(process.hrtime.bigint() - started) / 1e6;
        this.absorb(response);
        let body = null;
        try { body = bytes.length > 0 ? JSON.parse(bytes.toString('utf8')) : null; } catch { body = null; }
        return { status: response.status, ms, bytes: bytes.length, body, text: () => bytes.toString('utf8') };
    }

    async handshake() {
        const response = await this.fetchJson('/csrf-token');
        if (response.status !== 200) refuse(`auth/csrf/${this.label}`, `GET /csrf-token answered ${response.status}`);
        if (!response.body || typeof response.body.token !== 'string' || response.body.token === '') {
            refuse(`auth/csrf/${this.label}`, `GET /csrf-token carried no token: ${response.text().slice(0, 200)}`);
        }
        this.csrfToken = response.body.token;
        return this.csrfToken;
    }

    async get(route) {
        return this.fetchJson(route);
    }

    async post(route, body) {
        return this.fetchJson(route, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
        });
    }

    async login(handle, password) {
        await this.handshake();
        const response = await this.post('/api/users/login', password ? { handle, password } : { handle });
        if (response.status !== 200) {
            refuse(`provision/login/${handle}`, `POST /api/users/login for ${handle} answered ${response.status}: ${response.text().slice(0, 300)}`);
        }
        return this;
    }
}

// ---------------------------------------------------------------------------------------------------------
// MEASUREMENT. Runs identically against the real binary and against the contract stub: that is what makes
// the self-test evidence about the ROW rather than about a second implementation.
// ---------------------------------------------------------------------------------------------------------
async function provisionUsers({ origin, dataRoot, handles }) {
    const admin = new HttpSession(origin, 'admin');
    await admin.login('default-user', '');
    for (const handle of handles) {
        const created = await admin.post('/api/users/create', { handle, name: `M5 ${handle}`, password: PASSWORD });
        if (created.status !== 200) {
            refuse(`provision/create/${handle}`, `POST /api/users/create for ${handle} answered ${created.status}: ${created.text().slice(0, 300)}`);
        }
        // THE PRODUCT'S OWN CREATE PATH MAY SLUGIFY. The report must name the handle the server actually
        // accepted, so the sessions and the disk readers below use `created.body.handle` rather than the input.
        const accepted = created.body?.handle;
        if (typeof accepted !== 'string' || accepted === '') {
            refuse(`provision/create/${handle}`, `POST /api/users/create for ${handle} did not answer a handle: ${created.text().slice(0, 300)}`);
        }
        if (accepted !== handle) {
            refuse(`provision/create/${handle}`, `handle ${handle} was slugified to ${accepted}; this row needs stable handles so the disk assertions name the same account`);
        }
    }
    const sessions = new Map();
    for (const handle of handles) {
        const session = new HttpSession(origin, handle);
        await session.login(handle, PASSWORD);
        sessions.set(handle, session);
    }
    // The chat route needs a character directory; the products' own writers create the file, not the tree.
    // This mirrors tests/e2e/a15_concurrent_writers_test.go:180-188, which makes the same directory itself.
    for (const handle of handles) {
        await fs.mkdir(path.join(dataRoot, handle, 'chats', CHAT_CARD), { recursive: true });
    }
    return sessions;
}

function settingsBody(handle, wave, paddingBytes) {
    const marker = `${MARKER_PREFIX}_SETTINGS_${handle}_${wave}`;
    const document = { marker, oai_settings: { pad: 'p'.repeat(paddingBytes) } };
    return { marker, text: JSON.stringify(document) };
}

function chatBody(handle, wave) {
    const marker = `${MARKER_PREFIX}_CHAT_${handle}_${wave}`;
    const chat = [
        { user_name: 'User', character_name: 'M5', chat_metadata: { marker } },
        { name: 'User', is_user: true, mes: marker },
        { name: 'M5', is_user: false, mes: `ack ${marker}` },
    ];
    return { marker, body: { avatar_url: `${CHAT_CARD}.png`, file_name: CHAT_FILE, chat } };
}

async function driveWaves({ origin, sessions, handles, waves, bodyBytes, deadline }) {
    const routes = {
        settingsSave: { samples: [], errors: [] },
        settingsGet: { samples: [], errors: [] },
        chatsSave: { samples: [], errors: [] },
    };
    const lastMarkers = new Map();
    let waveCount = 0;
    for (let wave = 1; wave <= waves; wave += 1) {
        if (Date.now() > deadline) refuse('bound/deadline', `the run exceeded its bound before wave ${wave}/${waves}`);
        const waveStarted = Date.now();
        await Promise.all(handles.map(async handle => {
            const session = sessions.get(handle);
            const settings = settingsBody(handle, wave, bodyBytes);
            const chat = chatBody(handle, wave);
            const [save, read, chatSave] = await Promise.all([
                session.post('/api/settings/save', JSON.parse(settings.text)),
                session.post('/api/settings/get', {}),
                session.post('/api/chats/save', chat.body),
            ]);
            for (const [route, response] of [['settingsSave', save], ['settingsGet', read], ['chatsSave', chatSave]]) {
                routes[route].samples.push(response.ms);
                if (response.status !== 200) {
                    routes[route].errors.push({ handle, wave, status: response.status, head: response.text().slice(0, 200) });
                }
            }
            lastMarkers.set(handle, { settings: settings.marker, chat: chat.marker });
        }));
        waveCount += 1;
        if (process.env.M5_8USER_VERBOSE === '1') {
            process.stderr.write(`m5-eight-users: wave ${wave}/${waves} in ${Date.now() - waveStarted} ms\n`);
        }
    }
    return { routes, lastMarkers, waveCount };
}

function readJsonlMessages(text) {
    const messages = [];
    for (const line of text.split('\n')) {
        if (line.trim() === '') continue;
        let parsed;
        try { parsed = JSON.parse(line); } catch { refuse('isolation/parse', `a chat line is not valid JSON: ${line.slice(0, 160)}`); }
        if (parsed && typeof parsed === 'object' && typeof parsed.mes === 'string') messages.push(parsed);
    }
    return messages;
}

async function verifyIsolation({ dataRoot, handles, lastMarkers }) {
    const checks = [];
    const perUser = [];
    for (const handle of handles) {
        const own = lastMarkers.get(handle);
        const settingsPath = path.join(dataRoot, handle, 'settings.json');
        const chatPath = path.join(dataRoot, handle, 'chats', CHAT_CARD, `${CHAT_FILE}.jsonl`);
        let settingsText;
        try { settingsText = await fs.readFile(settingsPath, 'utf8'); } catch (error) {
            refuse(`isolation/disk/${handle}`, `the account's settings.json is unreadable at ${settingsPath}: ${error?.message ?? error}`);
        }
        try { JSON.parse(settingsText); } catch (error) {
            refuse(`isolation/parse/${handle}`, `the account's settings.json is not parseable JSON: ${error?.message ?? error}`);
        }
        if (!settingsText.includes(own.settings)) {
            refuse(`isolation/disk-own/${handle}`, `settings.json does not carry this account's last marker ${own.settings}`);
        }
        const chatText = await fs.readFile(chatPath, 'utf8').catch(error => {
            refuse(`isolation/disk/${handle}`, `the account's chat is unreadable at ${chatPath}: ${error?.message ?? error}`);
        });
        const messages = readJsonlMessages(chatText);
        if (messages.length === 0) refuse(`isolation/parse/${handle}`, `the account's chat carries no message records`);
        if (!messages.some(message => String(message.mes).includes(own.chat))) {
            refuse(`isolation/disk-own/${handle}`, `the chat does not carry this account's last marker ${own.chat}`);
        }
        // CROSS-USER: no OTHER account's marker may appear in this account's files. Names are fixed and
        // distinct, so a substring search is exact.
        for (const other of handles) {
            if (other === handle) continue;
            const otherMarkers = lastMarkers.get(other);
            for (const [surfaceName, text] of [['settings.json', settingsText], ['chat', chatText]]) {
                for (const marker of [otherMarkers.settings, otherMarkers.chat]) {
                    if (text.includes(marker)) {
                        refuse(`isolation/cross-user/${handle}`, `${surfaceName} of ${handle} contains ${other}'s marker ${marker}`);
                    }
                }
            }
        }
        perUser.push({ handle, settingsBytes: Buffer.byteLength(settingsText), chatMessages: messages.length });
    }
    checks.push({ name: 'isolation/disk-and-cross-user', ok: true, detail: `${handles.length} accounts, own markers present, no cross-user marker` });
    return { checks, perUser };
}

async function verifyServedSettings({ sessions, handles, lastMarkers }) {
    for (const handle of handles) {
        const response = await sessions.get(handle).post('/api/settings/get', {});
        if (response.status !== 200) refuse(`isolation/read/${handle}`, `GET-side settings read answered ${response.status}`);
        const text = response.text();
        if (!text.includes(lastMarkers.get(handle).settings)) {
            refuse(`isolation/read-own/${handle}`, `settings/get for ${handle} does not carry its last marker ${lastMarkers.get(handle).settings}`);
        }
        for (const other of handles) {
            if (other === handle) continue;
            if (text.includes(lastMarkers.get(other).settings)) {
                refuse(`isolation/read-cross-user/${handle}`, `settings/get for ${handle} carries ${other}'s marker`);
            }
        }
    }
}

async function measure({ origin, dataRoot, users, waves, bodyBytes, deadline, handlePrefix = HANDLE_PREFIX }) {
    const handles = Array.from({ length: users }, (_, index) => `${handlePrefix}${index}`);
    const provisionStarted = Date.now();
    const sessions = await provisionUsers({ origin, dataRoot, handles });
    const provisionMs = Date.now() - provisionStarted;

    // WARMUP IS OUTSIDE EVERY TIMED WINDOW. The first save for an account seeds/creates its settings
    // document; counting that as steady-state write cost would measure first-touch, not contention.
    for (const handle of handles) {
        const warm = settingsBody(handle, 0, bodyBytes);
        const response = await sessions.get(handle).post('/api/settings/save', JSON.parse(warm.text));
        if (response.status !== 200) refuse(`warmup/${handle}`, `warmup settings/save answered ${response.status}: ${response.text().slice(0, 200)}`);
    }

    const started = Date.now();
    const { routes, lastMarkers, waveCount } = await driveWaves({ origin, sessions, handles, waves, bodyBytes, deadline });
    const wallMs = Date.now() - started;

    const errors = [];
    for (const [route, record] of Object.entries(routes)) errors.push(...record.errors.map(error => ({ route, ...error })));
    if (errors.length > 0) {
        const first = errors[0];
        refuse(`write/status/${first.route}`, `${errors.length} request(s) answered non-200; first: ${first.handle} wave ${first.wave} ${first.route} -> ${first.status} ${first.head}`);
    }

    const isolation = await verifyIsolation({ dataRoot, handles, lastMarkers });
    await verifyServedSettings({ sessions, handles, lastMarkers });

    const routeSummaries = Object.fromEntries(Object.entries(routes).map(([route, record]) => [route, summarise(record.samples)]));
    const operations = Object.values(routes).reduce((sum, record) => sum + record.samples.length, 0);
    return {
        handles,
        provisionMs,
        waves: waveCount,
        operations,
        wallMs,
        throughputOpsPerSec: wallMs > 0 ? Math.round((operations / wallMs) * 1000 * 1000) / 1000 : null,
        routes: routeSummaries,
        errorRate: operations > 0 ? errors.length / operations : null,
        isolationChecks: isolation.checks,
        perUser: isolation.perUser,
        lastMarkers: Object.fromEntries([...lastMarkers.entries()]),
    };
}

// ---------------------------------------------------------------------------------------------------------
// SUBJECT LIFECYCLE. Booting the shipped binary is the only way to measure the shipped binary.
// ---------------------------------------------------------------------------------------------------------
function sha256File(file) {
    return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function reservePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const port = server.address().port;
            server.close(error => error ? reject(error) : resolve(port));
        });
    });
}

function guardCleanupRoot(target) {
    const resolved = path.resolve(target);
    const parent = path.resolve(os.tmpdir());
    if (path.dirname(resolved).toLowerCase() !== parent.toLowerCase()) {
        refuse('cleanup/guard', `refusing to remove ${resolved}: it is not a direct child of ${parent}`);
    }
    if (!path.basename(resolved).startsWith('gotavern-m5-eight-users-')) {
        refuse('cleanup/guard', `refusing to remove ${resolved}: its name does not start with gotavern-m5-eight-users-`);
    }
    return resolved;
}

// READINESS IS TWO STAGES, AND NEITHER STAGE ASSUMES THE AUTH POLICY IS "OFF".
//
// Stage 1 is the PUBLIC route. GET /csrf-token is served before login middleware in both implementations
// (pinned src/server-main.js:192 before :248; GoTavern internal/server/accounts.go:589-610), so a 200 with a
// token proves the HTTP handler is serving without depending on enableUserAccounts.
//
// Stage 2 is the pinned version record. It may legitimately be 403 for an anonymous client -- that is the
// pinned contract when accounts are enabled (testable in tests/oracle/sillytavern-1.19.0-account-session.json:
// unauthenticatedVersion.status 403, body "Forbidden"). The old readiness code read that 403 as a boot failure
// and spun for 120 s (Lane run 42209241061). When it is 403, log in as the admin the product SEEDS in an empty
// user store (pinned src/users.js:556-570 writes DEFAULT_USER with an empty password; GoTavern
// internal/startup/storage.go seeds the same record) and read the record again. Each stage refuses by NAME.
async function waitForServing(origin, child) {
    const deadline = Date.now() + BOOT_DEADLINE_MS;
    let last = null;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) {
            refuse('boot/exited', `the subject exited (code ${child.exitCode}) before serving GET /csrf-token; stderr follows:\n${(child.m5Logs ?? []).join('').slice(-4000)}`);
        }
        try {
            const response = await fetch(`${origin}/csrf-token`, { signal: AbortSignal.timeout(5000) });
            if (response.status === 200) {
                const body = await response.json().catch(() => null);
                if (body && typeof body.token === 'string' && body.token !== '') return Date.now();
                last = 'GET /csrf-token answered 200 without a token';
            } else {
                last = `GET /csrf-token answered ${response.status}`;
            }
        } catch (error) {
            last = String(error?.message ?? error);
        }
        await new Promise(resolve => setTimeout(resolve, 200));
    }
    refuse('boot/timeout', `the subject did not start serving the public GET /csrf-token route within ${BOOT_DEADLINE_MS} ms; last: ${last}`);
}

async function waitForReady(origin, child) {
    const servedAt = await waitForServing(origin, child);
    const session = new HttpSession(origin, 'boot-admin');
    let versionRequiresLogin = false;
    let response = await session.get('/version');
    if (response.status === 403) {
        // NOT A BOOT FAILURE: this is the pinned auth contract for an accounts-enabled server. Read the
        // record through the admin session the provisioning step uses anyway, and name an auth failure
        // instead of reporting a timeout.
        versionRequiresLogin = true;
        await session.handshake();
        const login = await session.post('/api/users/login', { handle: 'default-user' });
        if (login.status !== 200) {
            refuse('boot/admin-login', `the row boots with enableUserAccounts: true, so /version is behind requireLoginMiddleware (pinned src/server-main.js:248 vs :272; GoTavern internal/server/http.go:612), and readiness needs the seeded default-user admin session; POST /api/users/login answered ${login.status}: ${login.text().slice(0, 300)}`);
        }
        response = await session.get('/version');
    }
    if (response.status !== 200) {
        refuse('boot/version-record', `GET /version answered ${response.status}: ${response.text().slice(0, 200)}`);
    }
    const pkgVersion = response.body?.pkgVersion;
    if (typeof pkgVersion !== 'string' || !pkgVersion.startsWith('1.19.0')) {
        refuse('boot/version-record', `GET /version answered 200 but its body is not the pinned version record: ${response.text().slice(0, 200)}`);
    }
    return { bootMs: servedAt - (child.m5SpawnedAt ?? servedAt), pkgVersion, versionRequiresLogin };
}

async function bootSubject({ binary, workRoot, loadLabel }) {
    const installRoot = path.join(workRoot, 'install');
    const dataRoot = path.join(workRoot, 'data');
    await fs.mkdir(installRoot, { recursive: true });
    await fs.mkdir(dataRoot, { recursive: true });
    const binaryName = process.platform === 'win32' ? 'gotavern.exe' : 'gotavern';
    const installed = path.join(installRoot, binaryName);
    await fs.copyFile(binary, installed);
    await fs.chmod(installed, 0o755).catch(() => {});
    const configPath = path.join(installRoot, 'config.yaml');
    // ACCOUNTS ON is the precondition of the row; the default config has enableUserAccounts: false and would
    // bind every request to default-user (tests/e2e/harness_test.go:442-450 records that same fact).
    await fs.writeFile(configPath, 'enableUserAccounts: true\nskipContentCheck: true\n', 'utf8');

    const port = await reservePort();
    const origin = `http://127.0.0.1:${port}`;
    const logs = [];
    const child = spawn(installed, [
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
    ], { cwd: path.dirname(dataRoot), env: { ...process.env, GODEBUG: 'gctrace=1' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    child.stdout.on('data', chunk => logs.push(chunk.toString('utf8')));
    child.stderr.on('data', chunk => logs.push(chunk.toString('utf8')));
    child.m5Logs = logs;
    child.m5SpawnedAt = Date.now();
    let ready;
    try {
        ready = await waitForReady(origin, child);
    } catch (error) {
        // A readiness failure must not leave a subject behind; kill and rethrow the named failure.
        try { child.kill('SIGKILL'); } catch { /* gone */ }
        throw error;
    }
    return { child, origin, installRoot, dataRoot, installPath: installed, configPath, logs, bootMs: ready.bootMs, pkgVersion: ready.pkgVersion, versionRequiresLogin: ready.versionRequiresLogin };
}

async function stopSubject(subject) {
    const child = subject.child;
    let stopMode = 'already-exited';
    if (child.exitCode === null) {
        stopMode = process.platform === 'win32' ? 'abrupt-windows' : 'sigterm';
        try { child.kill('SIGTERM'); } catch { /* gone */ }
        const exited = await Promise.race([
            new Promise(resolve => child.once('exit', () => resolve(true))),
            new Promise(resolve => setTimeout(() => resolve(false), 5000)),
        ]);
        if (!exited) {
            stopMode = 'sigkill';
            try { child.kill('SIGKILL'); } catch { /* gone */ }
        }
    }
    return { stopMode };
}

async function subjectVersionJson(binary) {
    const result = spawnSync(binary, ['version', '--json'], { encoding: 'utf8', timeout: 30_000 });
    if (result.status !== 0) return { ok: false, status: result.status, stderr: (result.stderr ?? '').slice(0, 400) };
    try { return { ok: true, json: JSON.parse(result.stdout) }; } catch { return { ok: false, stderr: 'version --json did not print JSON', stdout: (result.stdout ?? '').slice(0, 400) }; }
}

async function environmentFacts({ binary, loadLabel }) {
    const cpus = os.cpus();
    return {
        surface: SURFACE,
        harness: 'tests/perf/m5-eight-users.mjs',
        commit: process.env.GITHUB_SHA ?? null,
        workflow: process.env.GITHUB_WORKFLOW ?? null,
        job: process.env.GITHUB_JOB ?? null,
        runId: process.env.GITHUB_RUN_ID ?? null,
        runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
        event: process.env.GITHUB_EVENT_NAME ?? 'local',
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
        osRelease: os.release(),
        cpuModel: cpus.length > 0 ? cpus[0].model : null,
        logicalCores: cpus.length,
        totalMemoryBytes: os.totalmem(),
        gomaxprocs: { value: process.env.GOMAXPROCS ?? null, reason: 'null means the subject was not given GOMAXPROCS, so Go defaults it to the runner CPU count; the artifact records that rather than inventing a value' },
        loadLabel: loadLabel ?? null,
        binary: {
            path: path.resolve(binary),
            sha256: sha256File(binary),
            sizeBytes: statSync(binary).size,
            version: subjectVersionJson(binary),
        },
        startedAt: new Date().toISOString(),
    };
}

// ---------------------------------------------------------------------------------------------------------
// CONTRACT STUB. This is NOT the product and its report says so. It exists so `--self-test` can drive the
// real measurement code through the documented handshake and write shapes, and so each named failure can be
// planted. A green here is evidence about the ROW, never about GoTavern.
// ---------------------------------------------------------------------------------------------------------
function startContractStub({ dataRoot }) {
    const tokens = new Map();   // cookie value -> csrf token
    const sessions = new Map(); // cookie value -> handle
    const accounts = new Map(); // handle -> password ('' for default-user)
    const mutations = { rejectCsrf: false, failSaveWhenMarkerIncludes: null, serveForeignSettings: null };
    accounts.set('default-user', '');
    const json = (response, status, body) => {
        const payload = Buffer.from(JSON.stringify(body));
        response.writeHead(status, { 'content-type': 'application/json', 'content-length': payload.length });
        response.end(payload);
    };
    const setSession = (response, cookieValue) => {
        response.setHeader('set-cookie', [`session=${cookieValue}; path=/`]);
    };
    const cookieOf = request => {
        const raw = request.headers.cookie ?? '';
        for (const pair of raw.split(';')) {
            const index = pair.indexOf('=');
            if (index > 0 && pair.slice(0, index).trim() === 'session') return pair.slice(index + 1).trim();
        }
        return null;
    };
    const readBody = request => new Promise((resolve, reject) => {
        const chunks = [];
        request.on('data', chunk => chunks.push(chunk));
        request.on('end', () => {
            try { resolve(chunks.length === 0 ? null : JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (error) { reject(error); }
        });
        request.on('error', reject);
    });
    const requireSession = (request, response) => {
        const cookie = cookieOf(request);
        const handle = cookie ? sessions.get(cookie) : null;
        if (!handle) { json(response, 403, { error: 'no session' }); return null; }
        const token = request.headers['x-csrf-token'];
        if (mutations.rejectCsrf || !cookie || token !== tokens.get(cookie)) { json(response, 403, { error: 'bad csrf' }); return null; }
        return { cookie, handle };
    };
    const server = http.createServer(async (request, response) => {
        const url = request.url ?? '/';
        try {
            if (request.method === 'GET' && url === '/csrf-token') {
                const cookie = cookieOf(request) ?? `stub-${Math.random().toString(16).slice(2)}`;
                const token = tokens.get(cookie) ?? `tok-${Math.random().toString(16).slice(2)}`;
                tokens.set(cookie, token);
                if (!sessions.has(cookie)) sessions.set(cookie, null);
                setSession(response, cookie);
                return json(response, 200, { token });
            }
            if (request.method === 'POST' && url === '/api/users/login') {
                const body = await readBody(request);
                const cookie = cookieOf(request);
                if (mutations.rejectCsrf) return json(response, 403, { error: 'bad csrf' });
                if (!cookie || request.headers['x-csrf-token'] !== tokens.get(cookie)) return json(response, 403, { error: 'bad csrf' });
                const handle = body?.handle;
                if (!accounts.has(handle)) return json(response, 403, { error: 'Incorrect credentials' });
                if (accounts.get(handle) !== '' && String(body?.password ?? '') !== accounts.get(handle)) return json(response, 403, { error: 'Incorrect credentials' });
                const nextCookie = `stub-${Math.random().toString(16).slice(2)}`;
                tokens.set(nextCookie, tokens.get(cookie));
                sessions.set(nextCookie, handle);
                setSession(response, nextCookie);
                return json(response, 200, { handle });
            }
            if (request.method === 'GET' && url === '/version') {
                // PINNED PARITY, accounts enabled: tests/oracle/sillytavern-1.19.0-account-session.json records
                // unauthenticatedVersion = {status 403, body "Forbidden"} because pinned mounts
                // requireLoginMiddleware (src/server-main.js:248) before the /version route (:272). The stub
                // reproduces that so `--self-test` proves the readiness path logs in instead of polling an
                // auth-gated route anonymously (the Lane 42209241061 failure).
                const cookie = cookieOf(request);
                const handle = cookie ? sessions.get(cookie) : null;
                if (!handle) {
                    const payload = Buffer.from('Forbidden');
                    response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', 'content-length': payload.length });
                    response.end(payload);
                    return;
                }
                return json(response, 200, { pkgVersion: '1.19.0', gitRevision: 'contract-stub', isLatest: true });
            }
            if (request.method === 'POST' && url === '/api/users/create') {
                const session = requireSession(request, response);
                if (!session) return;
                if (session.handle !== 'default-user') return json(response, 403, { error: 'not admin' });
                const body = await readBody(request);
                const handle = String(body?.handle ?? '');
                if (handle === '' || accounts.has(handle)) return json(response, handle === '' ? 400 : 409, { error: handle === '' ? 'Invalid handle' : 'User already exists' });
                accounts.set(handle, String(body?.password ?? ''));
                await fs.mkdir(path.join(dataRoot, handle, 'chats'), { recursive: true });
                await fs.writeFile(path.join(dataRoot, handle, 'settings.json'), JSON.stringify({ marker: `${MARKER_PREFIX}_SEED_${handle}` }));
                return json(response, 200, { handle });
            }
            if (request.method === 'POST' && url === '/api/settings/save') {
                const session = requireSession(request, response);
                if (!session) return;
                const body = await readBody(request);
                const marker = String(body?.marker ?? '');
                if (mutations.failSaveWhenMarkerIncludes && marker.includes(mutations.failSaveWhenMarkerIncludes)) return json(response, 500, { error: 'planted failure' });
                await fs.writeFile(path.join(dataRoot, session.handle, 'settings.json'), JSON.stringify(body));
                return json(response, 200, { result: 'ok' });
            }
            if (request.method === 'POST' && url === '/api/settings/get') {
                const session = requireSession(request, response);
                if (!session) return;
                let handle = session.handle;
                if (mutations.serveForeignSettings) {
                    const other = [...accounts.keys()].filter(candidate => candidate !== handle && candidate !== 'default-user')[0];
                    if (other) handle = other;
                }
                const text = await fs.readFile(path.join(dataRoot, handle, 'settings.json'), 'utf8');
                return json(response, 200, { settings: text });
            }
            if (request.method === 'POST' && url === '/api/chats/save') {
                const session = requireSession(request, response);
                if (!session) return;
                const body = await readBody(request);
                const card = String(body?.avatar_url ?? '').replace(/\.png$/, '');
                const file = String(body?.file_name ?? CHAT_FILE);
                const directory = path.join(dataRoot, session.handle, 'chats', card);
                await fs.mkdir(directory, { recursive: true });
                const lines = (body?.chat ?? []).filter(message => typeof message?.mes === 'string').map(message => JSON.stringify(message));
                await fs.writeFile(path.join(directory, `${file}.jsonl`), `${lines.join('\n')}\n`);
                return json(response, 200, {});
            }
            return json(response, 404, { error: 'not found' });
        } catch (error) {
            return json(response, 500, { error: String(error?.message ?? error) });
        }
    });
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, mutations, close: () => new Promise(done => server.close(done)) }));
    });
}

// ---------------------------------------------------------------------------------------------------------
// SELF-TEST. Logic first, then the same measurement code against the contract stub, then three planted
// failures that must each be NAMED. A case whose precondition is not reached is a failure, not a pass.
// ---------------------------------------------------------------------------------------------------------
async function runSelfTest() {
    const cases = [];
    const record = (name, condition, detail = null) => {
        cases.push({ name, ok: condition === true, detail });
        process.stderr.write(`${condition === true ? 'ok  ' : 'FAIL'} self-test/${name}${condition === true ? '' : ` -- ${JSON.stringify(detail).slice(0, 500)}`}\n`);
    };
    const expectFailure = async (name, fragment, run) => {
        try {
            await run();
            record(name, false, { expected: fragment, observed: 'no failure' });
        } catch (error) {
            const message = String(error?.message ?? error);
            if (error?.name !== 'HarnessFailure') record(name, false, { expected: fragment, observed: message });
            else record(name, message.includes(fragment), { expected: fragment, observed: message });
        }
    };

    // 1. percentile/summarise
    const summary = summarise([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    record('percentiles', summary.p50 === 5 && summary.p95 === 10 && summary.p99 === 10 && summary.count === 10, summary);
    record('empty-summary', summarise([]).count === 0 && summarise([]).p95 === null, summarise([]));

    // 2. thresholds: none => no assertion; previous report => ceiling; exceeded => named problem.
    record('threshold-absent-records-only', deriveThresholds(null) === null && evaluateThresholds({ results: { routes: {} } }, null).length === 0, null);
    const previous = { results: { routes: { settingsSave: { p95: 100 }, chatsSave: { p95: 40 } } } };
    const thresholds = deriveThresholds(previous, 0.25);
    record('threshold-derived', thresholds?.routeP95Ms?.settingsSave === 125 && thresholds?.routeP95Ms?.chatsSave === 50, thresholds);
    const problems = evaluateThresholds({ results: { routes: { settingsSave: { p95: 126 }, chatsSave: { p95: 10 } }, errorRate: 0 } }, thresholds);
    record('threshold-exceeded-names-the-route', problems.length === 1 && problems[0].check === 'threshold/settingsSave-p95' && problems[0].detail.includes('126'), problems);

    // 2b. HOST-STORAGE FINGERPRINT. The row is fsync-bound: a host with several-times-slower storage moved the
    // same code from 287.4 to 49.8 ops/s (2026-11-06), so a cross-host comparison must be REFUSED by name and
    // must not secretly grade the route ceilings. Both directions are planted: degraded => host-disk refusal,
    // comparable => the normal route ceiling still fires.
    const diskDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'gotavern-m5-disk-probe-'));
    try {
        const fingerprint = measureDiskFingerprint(diskDirectory, 4096, 4);
        record('disk-fingerprint-measured', fingerprint.ok === true && fingerprint.count === 4 && Number.isFinite(fingerprint.p95) && fingerprint.p95 > 0, fingerprint);
    } finally {
        await fs.rm(diskDirectory, { recursive: true, force: true });
    }
    const comparablePrevious = { environment: { disk: { p50: 1 } }, results: { routes: { settingsSave: { p95: 100 } } } };
    const comparableThresholds = deriveThresholds(comparablePrevious, 0.25);
    record('disk-fingerprint-carried-into-thresholds', comparableThresholds?.diskMedianMs === 1, comparableThresholds);
    const degradedProblems = evaluateThresholds({ environment: { disk: { p50: 40 } }, results: { routes: { settingsSave: { p95: 1 } }, errorRate: 0 } }, comparableThresholds);
    record('host-disk-degradation-refused', degradedProblems.length === 1 && degradedProblems[0].check === 'threshold/host-disk' && degradedProblems[0].detail.includes('40'), degradedProblems);
    const comparableProblems = evaluateThresholds({ environment: { disk: { p50: 1.2 } }, results: { routes: { settingsSave: { p95: 126 } }, errorRate: 0 } }, comparableThresholds);
    record('comparable-host-still-grades-routes', comparableProblems.length === 1 && comparableProblems[0].check === 'threshold/settingsSave-p95', comparableProblems);
    const preFingerprintThresholds = deriveThresholds({ results: { routes: { settingsSave: { p95: 100 } } } }, 0.25);
    record('missing-disk-fingerprint-is-not-invented', preFingerprintThresholds?.diskMedianMs === null, preFingerprintThresholds);

    // 2c. REPEATED BASELINES: PER-ROUTE WORST AND PER-ROUTE MEASURED NOISE. The 2026-11-07 series had each
    // route peak in a DIFFERENT repeat (settingsSave 116.3/117.6/112.3, settingsGet 57.8/35.8/40.6, chatsSave
    // 87.6/115.4/87.9) and a same-code repeat spread of 1.615x on settingsGet, LARGER than the 25% floor, so a
    // fixed 1.25x ceiling fails the baseline against itself. The rule must use each route's own worst and its
    // own measured spread, derived ONLY from the baseline reports.
    const merged = deriveThresholds([
        { environment: { disk: { p50: 0.6 } }, results: { routes: { settingsSave: { p95: 116.3 }, settingsGet: { p95: 57.8 }, chatsSave: { p95: 87.6 } } } },
        { environment: { disk: { p50: 8.67 } }, results: { routes: { settingsSave: { p95: 117.6 }, settingsGet: { p95: 35.8 }, chatsSave: { p95: 115.4 } } } },
        { environment: { disk: { p50: 0.35 } }, results: { routes: { settingsSave: { p95: 112.3 }, settingsGet: { p95: 40.6 }, chatsSave: { p95: 87.9 } } } },
    ], 0.25);
    const closeTo = (actual, expected, slack = 0.01) => Number.isFinite(actual) && Math.abs(actual - expected) <= slack;
    const settingsGetSpread = 57.8 / 35.8 - 1;
    const chatsSaveSpread = 115.4 / 87.6 - 1;
    record('merged-baseline-uses-each-routes-worst', closeTo(merged?.routeP95Ms?.settingsSave, 147) && closeTo(merged?.routeP95Ms?.settingsGet, 57.8 * (1 + settingsGetSpread)) && closeTo(merged?.routeP95Ms?.chatsSave, 115.4 * (1 + chatsSaveSpread)), merged);
    record('merged-baseline-keeps-the-floor-on-a-quiet-route', merged?.routeTolerance?.settingsSave === 0.25, merged?.routeTolerance);
    record('merged-baseline-widens-only-the-noisy-routes', merged?.routeTolerance?.settingsGet > 0.6 && merged?.routeTolerance?.chatsSave > 0.31 && merged?.routeTolerance?.chatsSave < 0.32, merged?.routeTolerance);
    record('merged-baseline-carries-the-highest-disk-median', merged?.diskMedianMs === 8.67 && String(merged?.source).includes('3 previous reports'), merged);
    const emergingAfter = evaluateThresholds({
        environment: { disk: { p50: 0.38 } },
        results: { routes: { settingsSave: { p95: 115.2 }, settingsGet: { p95: 56.5 }, chatsSave: { p95: 116.3 } }, errorRate: 0 },
    }, merged);
    record('merged-baseline-passes-the-recorded-after', emergingAfter.length === 0, emergingAfter);
    const oneRouteOverMerged = evaluateThresholds({ environment: { disk: { p50: 0.38 } }, results: { routes: { settingsSave: { p95: 100 }, settingsGet: { p95: 95 }, chatsSave: { p95: 100 } }, errorRate: 0 } }, merged);
    record('merged-baseline-still-fails-the-route-that-exceeds', oneRouteOverMerged.length === 1 && oneRouteOverMerged[0].check === 'threshold/settingsGet-p95', oneRouteOverMerged);
    record('merged-baseline-still-fails-a-real-settingsSave-regression', evaluateThresholds({ environment: { disk: { p50: 0.38 } }, results: { routes: { settingsSave: { p95: 148 }, settingsGet: { p95: 40 }, chatsSave: { p95: 100 } }, errorRate: 0 } }, merged).some(problem => problem.check === 'threshold/settingsSave-p95'), null);

    // 3. cleanup guard refuses a path it did not create.
    await expectFailure('cleanup-refuses-outside-tmp', 'cleanup/guard', async () => guardCleanupRoot(path.join(process.cwd(), 'not-a-m5-work-dir')));

    // 4. the contract stub drives the SAME code path.
    const workRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gotavern-m5-eight-users-selftest-'));
    guardCleanupRoot(workRoot);
    const stub = await startContractStub({ dataRoot: workRoot });
    try {
        const measurement = await measure({ origin: `http://127.0.0.1:${stub.port}`, dataRoot: workRoot, users: 2, waves: 2, bodyBytes: 1024, deadline: Date.now() + 30_000 });
        record('contract-stub-drive', measurement.operations === 12 && measurement.errorRate === 0 && measurement.handles.length === 2, { operations: measurement.operations, errorRate: measurement.errorRate });
        record('contract-stub-isolation', measurement.isolationChecks.length === 1 && measurement.perUser.length === 2, measurement.perUser);
        record('contract-stub-throughput', Number.isFinite(measurement.throughputOpsPerSec) && measurement.throughputOpsPerSec > 0, measurement.throughputOpsPerSec);

        // 4b. READINESS IS AUTH-AWARE. The row's own boot config enables accounts, so an anonymous GET /version
        // is 403 by the pinned contract (the stub reproduces it). The REAL waitForReady must log in and read the
        // record instead of timing out -- this is the Lane 42209241061 defect, driven without a product binary.
        const anonymousVersion = await fetch(`http://127.0.0.1:${stub.port}/version`);
        record('readiness-anonymous-version-is-403', anonymousVersion.status === 403, { status: anonymousVersion.status });
        const readiness = await waitForReady(`http://127.0.0.1:${stub.port}`, { exitCode: null, m5SpawnedAt: Date.now(), m5Logs: [] });
        record('readiness-logs-in-and-reads-version', readiness.versionRequiresLogin === true && readiness.pkgVersion === '1.19.0' && Number.isFinite(readiness.bootMs) && readiness.bootMs >= 0, readiness);

        // 5. three planted failures, each required by name. Each case uses a FRESH handle prefix: the contract
        // stub keeps its accounts and files, and an account that already exists would fail provisioning before
        // the planted failure could be reached (measured: the first version reported 409 for every later case).
        stub.mutations.failSaveWhenMarkerIncludes = 'm5mutw1_1';
        await expectFailure('write-failure-named', 'write/status/settingsSave', () => measure({ origin: `http://127.0.0.1:${stub.port}`, dataRoot: workRoot, users: 2, waves: 1, bodyBytes: 512, deadline: Date.now() + 10_000, handlePrefix: 'm5mutw' }));
        stub.mutations.failSaveWhenMarkerIncludes = null;

        stub.mutations.serveForeignSettings = true;
        await expectFailure('isolation-failure-named', 'isolation/read-own', () => measure({ origin: `http://127.0.0.1:${stub.port}`, dataRoot: workRoot, users: 2, waves: 1, bodyBytes: 512, deadline: Date.now() + 10_000, handlePrefix: 'm5muti' }));
        stub.mutations.serveForeignSettings = false;

        stub.mutations.rejectCsrf = true;
        await expectFailure('auth-failure-named', 'provision/login/default-user', () => measure({ origin: `http://127.0.0.1:${stub.port}`, dataRoot: workRoot, users: 2, waves: 1, bodyBytes: 512, deadline: Date.now() + 10_000, handlePrefix: 'm5muta' }));
        stub.mutations.rejectCsrf = false;
    } finally {
        await stub.close();
        guardCleanupRoot(workRoot);
        await fs.rm(workRoot, { recursive: true, force: true });
    }

    const failed = cases.filter(entry => entry.ok !== true);
    process.stderr.write(`[self-test] ${cases.length - failed.length}/${cases.length} case(s) held${failed.length > 0 ? `; FAILED: ${failed.map(entry => entry.name).join(', ')}` : ''}\n`);
    if (failed.length > 0) process.exitCode = 1;
}

// ---------------------------------------------------------------------------------------------------------
// PRODUCT RUN.
// ---------------------------------------------------------------------------------------------------------
async function runProduct(options) {
    const binary = path.resolve(options.binary);
    if (!existsSync(binary)) refuse('usage/binary', `--binary ${binary} does not exist`);
    const workRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gotavern-m5-eight-users-'));
    guardCleanupRoot(workRoot);
    const environment = await environmentFacts({ binary, loadLabel: options.loadLabel });
    // BEFORE boot: the row's measured routes are fsync-bound, so the report must say what the host's storage
    // looked like. This is the fingerprint the threshold gate refuses a cross-host comparison on.
    environment.disk = measureDiskFingerprint(workRoot, options.bodyBytes);
    const startedAt = Date.now();
    let subject = null;
    let report = null;
    try {
        subject = await bootSubject({ binary, workRoot, loadLabel: options.loadLabel });
        environment.subject = {
            bootMs: Math.round(subject.bootMs * 1000) / 1000,
            pkgVersion: subject.pkgVersion,
            versionRequiresLogin: subject.versionRequiresLogin,
            installRoot: '$WORK/install',
            dataRoot: '$WORK/data',
        };
        const measurement = await measure({
            origin: subject.origin,
            dataRoot: subject.dataRoot,
            users: options.users,
            waves: options.waves,
            bodyBytes: options.bodyBytes,
            deadline: startedAt + options.maxSeconds * 1000,
        });
        const stop = await stopSubject(subject);
        subject = null;
        report = {
            schemaVersion: SCHEMA_VERSION,
            surface: SURFACE,
            question: 'With eight accounts writing settings, reading settings and saving chats concurrently, does every write stay whole and isolated, and what are the per-route latency and throughput cost rows?',
            mode: 'product',
            environment,
            parameters: {
                users: options.users,
                waves: options.waves,
                bodyBytes: options.bodyBytes,
                routes: ['/api/settings/save', '/api/settings/get', '/api/chats/save'],
                requestTimeoutMs: REQUEST_TIMEOUT_MS,
                maxSeconds: options.maxSeconds,
                stopMode: stop.stopMode,
            },
            thresholds: options.thresholds ?? null,
            results: measurement,
            checks: [
                {
                    name: 'boot/auth-readiness',
                    ok: true,
                    detail: environment.subject.versionRequiresLogin
                        ? 'the subject served the public GET /csrf-token route and the pinned version record was read through the seeded default-user admin session; with enableUserAccounts: true both implementations gate /version behind requireLoginMiddleware (pinned oracle unauthenticatedVersion = 403 "Forbidden"), so this is the row\'s documented auth contract rather than a boot failure'
                        : 'the subject served the public GET /csrf-token route and answered the pinned version record anonymously',
                },
                { name: 'write/status', ok: true, detail: `${measurement.operations} request(s), 0 non-200` },
                { name: 'isolation/disk-and-cross-user', ok: true, detail: measurement.isolationChecks[0]?.detail ?? null },
                { name: 'isolation/read-own', ok: true, detail: `${measurement.handles.length} accounts served their own document` },
            ],
            unproven: [
                'absolute numbers are comparable only within one runner image AND one host-storage class; the report carries the runner fingerprint and a sync-write disk fingerprint, and a threshold run refuses a cross-host comparison by name (threshold/host-disk) instead of grading the routes',
                'delete/rename/import were not driven: this row is the write/load/isolation cost row, not E06 in full',
                'no latency threshold was asserted unless `thresholds` is non-null (see docs/alpha16/m5-measurement-plan.md)',
            ],
            ok: true,
            failure: null,
        };
    } catch (error) {
        if (subject) { try { await stopSubject(subject); } catch { /* best effort */ } }
        report = {
            schemaVersion: SCHEMA_VERSION,
            surface: SURFACE,
            mode: 'product',
            environment,
            parameters: { users: options.users, waves: options.waves, bodyBytes: options.bodyBytes, maxSeconds: options.maxSeconds },
            thresholds: options.thresholds ?? null,
            results: null,
            checks: [],
            ok: false,
            failure: error?.name === 'HarnessFailure' ? { check: error.check, detail: error.detail } : { check: 'harness/unexpected', detail: String(error?.stack ?? error) },
            unproven: ['the run did not complete, so its numbers are absent rather than zero'],
        };
        process.exitCode = 1;
    } finally {
        if (!options.keep) {
            guardCleanupRoot(workRoot);
            await fs.rm(workRoot, { recursive: true, force: true });
        } else {
            process.stderr.write(`m5-eight-users: kept work root ${workRoot}\n`);
        }
    }
    report.finishedAt = new Date().toISOString();
    report.wallMs = Date.now() - startedAt;
    if (report.ok && options.thresholds) {
        const problems = evaluateThresholds(report, options.thresholds);
        if (problems.length > 0) {
            report.ok = false;
            report.failure = problems[0];
            for (const problem of problems) process.stderr.write(`FAIL ${problem.check}: ${problem.detail}\n`);
            process.exitCode = 1;
        }
    }
    if (options.report) {
        await fs.mkdir(path.dirname(path.resolve(options.report)), { recursive: true });
        await fs.writeFile(path.resolve(options.report), `${JSON.stringify(report, null, 2)}\n`);
        process.stderr.write(`m5-eight-users: report written to ${path.resolve(options.report)}\n`);
    }
    if (report.ok) {
        const routes = report.results?.routes ?? {};
        for (const [route, summary] of Object.entries(routes)) {
            process.stderr.write(`m5-eight-users: ${route} n=${summary.count} p50=${summary.p50?.toFixed?.(3)} ms p95=${summary.p95?.toFixed?.(3)} ms p99=${summary.p99?.toFixed?.(3)} ms max=${summary.max?.toFixed?.(3)} ms\n`);
        }
        process.stderr.write(`m5-eight-users: ${report.results?.operations} ops in ${report.results?.wallMs} ms = ${report.results?.throughputOpsPerSec} ops/s; users=${options.users} waves=${options.waves}\n`);
        process.stderr.write('m5-eight-users: PASS (correctness + isolation; latency thresholds applied: ' + (options.thresholds ? 'yes' : 'no') + ')\n');
    } else {
        process.stderr.write(`m5-eight-users: FAIL ${report.failure?.check}: ${report.failure?.detail}\n`);
    }
}

// ---------------------------------------------------------------------------------------------------------
async function main() {
    const argv = process.argv.slice(2);
    const selfTest = argv.includes('--self-test');
    if (selfTest) {
        await runSelfTest();
        return;
    }
    const binary = argumentValue(argv, '--binary');
    if (binary && !existsSync(path.resolve(binary))) {
        process.stderr.write(`--binary ${path.resolve(binary)} does not exist\n`);
        process.exitCode = 2;
        return;
    }
    if (!binary) {
        process.stderr.write('usage: node tests/perf/m5-eight-users.mjs --self-test\n       node tests/perf/m5-eight-users.mjs --binary <gotavern> --report <out.json> [--users 8] [--waves 6] [--body-bytes 49152] [--max-seconds 180] [--keep] [--load-label TEXT] [--thresholds-json <previous-report.json>]\n');
        process.exitCode = 2;
        return;
    }
    const users = optionalNumber(argumentValue(argv, '--users'), DEFAULT_USERS);
    const waves = optionalNumber(argumentValue(argv, '--waves'), DEFAULT_WAVES);
    const bodyBytes = optionalNumber(argumentValue(argv, '--body-bytes'), DEFAULT_BODY_BYTES);
    const maxSeconds = optionalNumber(argumentValue(argv, '--max-seconds'), DEFAULT_MAX_SECONDS);
    if (!Number.isInteger(users) || users < 2 || users > 32) { process.stderr.write('--users must be an integer in 2..32\n'); process.exitCode = 2; return; }
    if (!Number.isInteger(waves) || waves < 1 || waves > 200) { process.stderr.write('--waves must be an integer in 1..200\n'); process.exitCode = 2; return; }
    if (!Number.isFinite(bodyBytes) || bodyBytes < 512) { process.stderr.write('--body-bytes must be >= 512\n'); process.exitCode = 2; return; }
    if (!Number.isFinite(maxSeconds) || maxSeconds < 5) { process.stderr.write('--max-seconds must be >= 5\n'); process.exitCode = 2; return; }
    let thresholds = null;
    const thresholdsPaths = argumentValues(argv, '--thresholds-json');
    if (thresholdsPaths.length > 0) {
        const previousReports = [];
        for (const thresholdsPath of thresholdsPaths) {
            try {
                previousReports.push(JSON.parse(readFileSync(path.resolve(thresholdsPath), 'utf8')));
            } catch (error) {
                process.stderr.write(`--thresholds-json ${thresholdsPath} is not readable JSON: ${error?.message ?? error}\n`);
                process.exitCode = 2;
                return;
            }
        }
        thresholds = deriveThresholds(previousReports, DEFAULT_THRESHOLD_TOLERANCE);
        if (!thresholds) { process.stderr.write(`the --thresholds-json report(s) carry no usable per-route p95; refusing to run with threshold files that would assert nothing\n`); process.exitCode = 2; return; }
    }
    await runProduct({
        binary,
        report: argumentValue(argv, '--report'),
        users,
        waves,
        bodyBytes,
        maxSeconds,
        loadLabel: argumentValue(argv, '--load-label'),
        keep: argv.includes('--keep'),
        thresholds,
    });
}


main().catch(error => {
    process.stderr.write(`m5-eight-users: UNCAUGHT ${error?.stack ?? error}\n`);
    process.exitCode = 1;
});
