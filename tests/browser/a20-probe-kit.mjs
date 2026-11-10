// alpha.20 pinned-behaviour probe kit.
//
// WHAT THIS IS. A small, self-contained harness for the M1 pinned-behaviour probes: it boots the
// READ-ONLY pinned SillyTavern checkout as a real server over a scratch data root, drives it over
// HTTP with the CSRF token the unmodified frontend itself uses (GET /csrf-token), and writes raw
// evidence next to the probe that produced it. It is deliberately independent of the five-layer
// oracle kits: a probe here answers a QUESTION about pinned behaviour; it is not a differential.
//
// RULES THIS KIT ENFORCES.
//   - The pinned checkout is never written. Every probe gets a fresh data root outside the repo.
//   - A probe records its own commands, the pinned commit and the config digest it booted with, so
//     the evidence can be re-run rather than trusted.
//   - A probe result is a taxonomy, never a bare boolean: CONFIRMED / DIFFERENT / UNPROVEN, with the
//     raw observation attached. `evidence` is written with sorted keys so two runs diff cleanly.
//   - Nothing here reaches the live network on purpose: the probes only talk to 127.0.0.1.
//
// USAGE: each probe script imports { paths, bootPinned, httpJson, ... } from here.

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, '..', '..');
export const PINNED_ROOT = path.resolve(process.env.A20_PINNED_ROOT ?? path.join(repoRoot, '..', 'SillyTavern'));
export const PINNED_COMMIT = '06bde939fb1e9c4c8d8641d810f0a916b5bce127';
export const SCRATCH_ROOT = path.resolve(process.env.A20_SCRATCH ?? path.join(repoRoot, '..', 'a20-oracle'));
export const EVIDENCE_ROOT = path.join(repoRoot, 'docs', 'alpha20', 'oracle');
// A data root that has been booted ONCE by the pinned product, so it carries the pinned fresh-install
// seed (config.yaml, default content, default-user scaffold) and a warm Webpack cache in _webpack/.
// A prose probe copies this instead of paying the cold ~195 s frontend compile on every boot; the
// template's own census is recorded so the probe says exactly what tree it started from. The template
// is produced by `a20-probe-template.mjs` and is outside the repository.
export const DATA_TEMPLATE = path.join(SCRATCH_ROOT, 'template-data');

export function sha256(value) {
    return createHash('sha256').update(value).digest('hex');
}

export async function ensureDir(target) {
    await fsp.mkdir(target, { recursive: true });
    return target;
}

export function nowIso() {
    return new Date().toISOString();
}

/** Await a TCP port to accept a connection. Returns true when it did within timeoutMs. */
export async function waitForPort(port, timeoutMs = 30000) {
    const { connect } = await import('node:net');
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        const ok = await new Promise(resolve => {
            const socket = connect({ host: '127.0.0.1', port }, () => { socket.destroy(); resolve(true); });
            socket.on('error', () => { socket.destroy(); resolve(false); });
            socket.setTimeout(500, () => { socket.destroy(); resolve(false); });
        });
        if (ok) return true;
        await new Promise(r => setTimeout(r, 100));
    }
    return false;
}

/** Choose a port by binding 0 and closing. The caller still retries on bind failure. */
export async function freePort() {
    const { createServer } = await import('node:net');
    return new Promise((resolve, reject) => {
        const server = createServer();
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const port = server.address().port;
            server.close(() => resolve(port));
        });
    });
}

/**
 * Boots the pinned SillyTavern as a real child process over `dataRoot`.
 *
 * The boot line is the same one every other pinned leg in this repository uses:
 *   node server.js --port <p> --dataRoot <dir> --configPath <dir>/config.yaml --browserLaunchEnabled false
 * `--browserLaunchEnabled false` is NOT optional: the pinned config may request a browser launch, and
 * a probe must never open a desktop window.
 *
 * A fresh dataRoot is seeded by the pinned product itself (config.yaml from default/config.yaml,
 * default content from default/content, the default-user scaffold) — that seeding is part of what a
 * probe may observe, so the kit does not pre-copy it unless `seedConfig` is given.
 */
export async function bootPinned({
    dataRoot,
    label = 'pinned',
    env = {},
    configYaml = null,
    readyTimeoutMs = 120000,
    collectLog = true,
} = {}) {
    await ensureDir(dataRoot);
    if (configYaml !== null) {
        fs.writeFileSync(path.join(dataRoot, 'config.yaml'), configYaml, 'utf8');
    }
    let port = await freePort();
    let lastError = null;
    const attempts = [];
    for (let attempt = 0; attempt < 5; attempt++) {
        const attemptStarted = Date.now();
        const child = spawn(process.execPath, [
            'server.js',
            '--port', String(port),
            '--dataRoot', dataRoot,
            '--configPath', path.join(dataRoot, 'config.yaml'),
            '--browserLaunchEnabled', 'false',
        ], {
            cwd: PINNED_ROOT,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, ...env },
        });
        const log = [];
        const exited = new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal })));
        child.stdout.on('data', chunk => { if (collectLog) log.push(chunk.toString()); });
        child.stderr.on('data', chunk => { if (collectLog) log.push(chunk.toString()); });
        const ready = await waitForPort(port, readyTimeoutMs).catch(() => false);
        if (ready) {
            const baseURL = `http://127.0.0.1:${port}`;
            const version = await pollVersion(baseURL, 30000);
            attempts.push({ port, ready: true, waitedMs: Date.now() - attemptStarted });
            return {
                label,
                baseURL,
                port,
                dataRoot,
                pid: child.pid,
                version,
                bootAttempts: attempts,
                bootWaitedMs: Date.now() - attemptStarted,
                logText: () => log.join(''),
                async stop({ graceMs = 20000 } = {}) {
                    const race = await Promise.race([
                        exited.then(result => ({ ...result, how: 'self-exit' })),
                        new Promise(resolve => setTimeout(() => resolve(null), graceMs)),
                    ]);
                    if (race) return race;
                    try { child.kill('SIGTERM'); } catch { /* already gone */ }
                    const afterTerm = await Promise.race([
                        exited.then(result => ({ ...result, how: 'SIGTERM' })),
                        new Promise(resolve => setTimeout(() => resolve(null), 10000)),
                    ]);
                    if (afterTerm) return afterTerm;
                    try { child.kill('SIGKILL'); } catch { /* already gone */ }
                    return { ...(await exited), how: 'SIGKILL' };
                },
                child,
            };
        }
        lastError = log.join('').slice(-4000);
        attempts.push({ port, ready: false, waitedMs: Date.now() - attemptStarted, logTail: lastError.slice(-800) });
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
        await exited;
        port = await freePort();
    }
    throw new Error(`[${label}] pinned server did not become reachable after ${attempts.length} attempts; last log tail:\n${lastError}`);
}

async function pollVersion(baseURL, timeoutMs) {
    const started = Date.now();
    let last = null;
    while (Date.now() - started < timeoutMs) {
        try {
            const response = await fetch(`${baseURL}/version`);
            const text = await response.text();
            if (response.ok) {
                try { return JSON.parse(text); } catch { return { raw: text }; }
            }
            last = `${response.status} ${text.slice(0, 200)}`;
        } catch (error) {
            last = String(error?.message ?? error);
        }
        await new Promise(r => setTimeout(r, 150));
    }
    throw new Error(`pinned /version never answered: ${last}`);
}

/**
 * A tiny HTTP client that reproduces what the unmodified frontend does: fetch /csrf-token once,
 * keep the session cookie, and send both cookie and X-CSRF-Token on JSON POSTs.
 *
 * The probe records the raw request (method, target, body text and the headers that matter) and the
 * raw response (status, every header, raw body bytes as hex/text, digests) so a classifier can be
 * re-derived from the evidence rather than believed.
 */
export async function makeClient(baseURL) {
    const cookies = new Map();
    const tokenResponse = await fetch(`${baseURL}/csrf-token`);
    const tokenText = await tokenResponse.text();
    for (const cookie of tokenResponse.headers.getSetCookie?.() ?? []) {
        const [pair] = cookie.split(';');
        const index = pair.indexOf('=');
        if (index > 0) cookies.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
    }
    let token = null;
    try { token = JSON.parse(tokenText)?.token ?? null; } catch { token = null; }
    const cookieHeader = () => [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');

    /** Raw request; returns the response with the body kept as a Buffer. */
    async function request(target, {
        method = 'GET',
        json = undefined,
        body = undefined,
        headers = {},
        csrf = method !== 'GET' && method !== 'HEAD',
        accept = '*/*',
    } = {}) {
        const finalHeaders = { accept, ...headers };
        let payload = body;
        if (json !== undefined) {
            payload = Buffer.from(JSON.stringify(json), 'utf8');
            finalHeaders['content-type'] = 'application/json';
        }
        if (csrf) {
            finalHeaders['x-csrf-token'] = token ?? '';
            const cookie = cookieHeader();
            if (cookie) finalHeaders.cookie = cookie;
        }
        const response = await fetch(`${baseURL}${target}`, { method, headers: finalHeaders, body: payload });
        const raw = Buffer.from(await response.arrayBuffer());
        const headerList = [];
        for (const [name, value] of response.headers) headerList.push([name, value]);
        headerList.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
        return {
            target,
            method,
            requestBodySha256: payload ? sha256(payload) : null,
            requestBodyLength: payload ? payload.length : 0,
            status: response.status,
            headers: headerList,
            bodySha256: sha256(raw),
            bodyLength: raw.length,
            bodyText: raw.toString('utf8'),
            bodyBase64: raw.toString('base64'),
        };
    }

    return { baseURL, token, tokenPresent: typeof token === 'string' && token.length > 0, cookies, request, cookieHeader };
}

/** Writes one probe's evidence document, sorted for stable diffs. */
export async function writeEvidence(probeName, document) {
    const dir = await ensureDir(path.join(EVIDENCE_ROOT, probeName));
    const file = path.join(dir, 'evidence.json');
    const stable = stableStringify(document);
    await fsp.writeFile(file, stable + '\n', 'utf8');
    return { file, dir };
}

export function stableStringify(value) {
    const walk = node => {
        if (Array.isArray(node)) return node.map(walk);
        if (node && typeof node === 'object') {
            const out = {};
            for (const key of Object.keys(node).sort()) out[key] = walk(node[key]);
            return out;
        }
        return node;
    };
    return JSON.stringify(walk(value), null, 2);
}

/** Recursively lists a directory: relative path, size, sha256. Used to observe disk state. */
export async function census(root, { exclude = [] } = {}) {
    const entries = [];
    const walk = async dir => {
        let items;
        try { items = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
        for (const item of items) {
            const full = path.join(dir, item.name);
            const rel = path.relative(root, full).split(path.sep).join('/');
            if (exclude.some(x => rel === x || rel.startsWith(x + '/'))) continue;
            if (item.isDirectory()) { await walk(full); continue; }
            try {
                const bytes = await fsp.readFile(full);
                entries.push({ path: rel, bytes: bytes.length, sha256: sha256(bytes) });
            } catch { entries.push({ path: rel, error: 'unreadable' }); }
        }
    };
    await walk(root);
    entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    return entries;
}

export async function readJsonFile(file) {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
}

/** The canonical tree digest: sha256 of sorted "<sha256>  <path>" lines, LF-joined, no trailing LF. */
export function treeDigest(entries) {
    return sha256(entries.map(e => `${e.sha256}  ${e.path}`).join('\n'));
}

export function pinnedIdentity() {
    return { root: PINNED_ROOT, commit: PINNED_COMMIT };
}

export async function assertPinnedClean() {
    const { execFileSync } = await import('node:child_process');
    const head = execFileSync('git', ['-C', PINNED_ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const status = execFileSync('git', ['-C', PINNED_ROOT, 'status', '--porcelain'], { encoding: 'utf8' });
    if (head !== PINNED_COMMIT) throw new Error(`pinned checkout is at ${head}, expected ${PINNED_COMMIT}`);
    if (status.trim() !== '') throw new Error(`pinned checkout is dirty; probes require the read-only pin:\n${status}`);
    return head;
}

/**
 * The evidence header every probe writes: what was booted, from what bytes, and by what command.
 * `argv` is recorded so a reader can re-run the exact probe.
 */
export function probeHeader({ probe, purpose, pinnedCommit = PINNED_COMMIT }) {
    return {
        schemaVersion: 1,
        kind: 'a20-pinned-probe-v1',
        probe,
        purpose,
        pinnedCommit,
        pinnedRoot: PINNED_ROOT,
        repoRoot,
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        argv: process.argv.slice(2),
        startedAt: nowIso(),
        finishedAt: null,
        verdicts: [],
        unproven: [],
    };
}

export function finishHeader(header) {
    header.finishedAt = nowIso();
    return header;
}

/**
 * Builds the GoTavern binary once into the scratch tree and boots it over `dataRoot`.
 *
 * A probe that needs BOTH subjects uses this: the pinned leg answers "what is the oracle", the
 * GoTavern leg answers "what do we currently do". The binary is built with -trimpath from the current
 * worktree; the evidence records its sha256 so a reader can tell which tree produced the answer.
 */
export async function buildGotavern({ out = path.join(SCRATCH_ROOT, 'bin', 'gotavern-probe.exe') } = {}) {
    const { execFileSync } = await import('node:child_process');
    await ensureDir(path.dirname(out));
    const started = Date.now();
    execFileSync('go', ['build', '-trimpath', '-o', out, './cmd/gotavern'], { cwd: repoRoot, stdio: 'pipe' });
    const bytes = await fsp.readFile(out);
    return { binary: out, sha256: sha256(bytes), bytes: bytes.length, buildMs: Date.now() - started };
}

export async function bootGotavern({
    dataRoot,
    binary,
    label = 'gotavern',
    env = {},
    readyTimeoutMs = 120000,
} = {}) {
    await ensureDir(dataRoot);
    const port = await freePort();
    const child = spawn(binary, [
        'start',
        '--port', String(port),
        '--dataRoot', dataRoot,
        '--configPath', path.join(dataRoot, 'config.yaml'),
        '--browserLaunchEnabled', 'false',
    ], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
    const log = [];
    child.stdout.on('data', chunk => log.push(chunk.toString()));
    child.stderr.on('data', chunk => log.push(chunk.toString()));
    const exited = new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal })));
    const started = Date.now();
    const ready = await waitForPort(port, readyTimeoutMs).catch(() => false);
    if (!ready) {
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
        await exited;
        throw new Error(`[${label}] GoTavern did not become reachable; log tail:\n${log.join('').slice(-4000)}`);
    }
    const baseURL = `http://127.0.0.1:${port}`;
    const version = await pollVersionGo(baseURL, 30000);
    return {
        label,
        baseURL,
        port,
        dataRoot,
        pid: child.pid,
        version,
        bootWaitedMs: Date.now() - started,
        logText: () => log.join(''),
        async stop({ graceMs = 20000 } = {}) {
            const race = await Promise.race([
                exited.then(result => ({ ...result, how: 'self-exit' })),
                new Promise(resolve => setTimeout(() => resolve(null), graceMs)),
            ]);
            if (race) return race;
            try { child.kill('SIGTERM'); } catch { /* already gone */ }
            const afterTerm = await Promise.race([
                exited.then(result => ({ ...result, how: 'SIGTERM' })),
                new Promise(resolve => setTimeout(() => resolve(null), 10000)),
            ]);
            if (afterTerm) return afterTerm;
            try { child.kill('SIGKILL'); } catch { /* already gone */ }
            return { ...(await exited), how: 'SIGKILL' };
        },
        child,
    };
}

async function pollVersionGo(baseURL, timeoutMs) {
    const started = Date.now();
    let last = null;
    while (Date.now() - started < timeoutMs) {
        try {
            const response = await fetch(`${baseURL}/version`);
            const text = await response.text();
            if (response.ok) {
                try { return JSON.parse(text); } catch { return { raw: text }; }
            }
            last = `${response.status} ${text.slice(0, 200)}`;
        } catch (error) {
            last = String(error?.message ?? error);
        }
        await new Promise(r => setTimeout(r, 150));
    }
    throw new Error(`GoTavern /version never answered: ${last}`);
}

/**
 * Copies the recorded warm pinned data-root template to a fresh scratch directory for one probe.
 * The copy is byte-identical to the template, so the probe's starting state is a known digest.
 */
export async function freshDataRoot(probeName, { template = DATA_TEMPLATE } = {}) {
    if (!fs.existsSync(template)) {
        throw new Error(`no data-root template at ${template}; run tests/browser/a20-probe-template.mjs first`);
    }
    const target = path.join(SCRATCH_ROOT, probeName, 'data');
    await fsp.rm(target, { recursive: true, force: true });
    await ensureDir(path.dirname(target));
    await fsp.cp(template, target, { recursive: true });
    return target;
}

/** The template's census (path/bytes/sha256) and tree digest, recorded in every probe that copies it. */
export async function templateCensus() {
    const entries = await census(DATA_TEMPLATE);
    return {
        path: 'template-data',
        files: entries.length,
        bytes: entries.reduce((sum, entry) => sum + (entry.bytes ?? 0), 0),
        treeSha256: treeDigest(entries),
        configSha256: sha256(await fsp.readFile(path.join(DATA_TEMPLATE, 'config.yaml'))),
    };
}

export function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Edits one line of a booted data root's config.yaml for a RESTART scenario, reading the file back
 * and refusing a no-op edit. Pinned parses config.yaml at startup only, which is why a restart — not a
 * live edit — is the only faithful way to observe a config-driven branch change.
 */
export async function patchConfigLine(dataRoot, from, to) {
    const file = path.join(dataRoot, 'config.yaml');
    const before = await fsp.readFile(file, 'utf8');
    if (!before.includes(from)) throw new Error(`config edit refused: ${JSON.stringify(from)} not found in ${file}`);
    const after = before.replace(from, to);
    if (after === before) throw new Error(`config edit refused: replacement was a no-op for ${JSON.stringify(from)}`);
    await fsp.writeFile(file, after, 'utf8');
    const readBack = await fsp.readFile(file, 'utf8');
    if (!readBack.includes(to)) throw new Error(`config edit did not persist in ${file}`);
    return { file: 'config.yaml', from, to, sha256: sha256(readBack) };
}

/**
 * Edits the FIRST `target` after the given section anchor (e.g. anchor "backups:" then target
 * "enabled: true"). Pinned REWRITES config.yaml at startup through yaml.stringify, which drops the
 * comments and changes indentation, so a probe that restarts and then edits must not anchor on the
 * original spacing. The anchor keeps the edit pointed at the right section instead of at the first
 * `enabled: true` in the document.
 */
export async function patchConfigLineAfter(dataRoot, anchor, target, replacement, { occurrence = 1 } = {}) {
    const file = path.join(dataRoot, 'config.yaml');
    const before = await fsp.readFile(file, 'utf8');
    const anchorIndex = before.indexOf(anchor);
    if (anchorIndex < 0) throw new Error(`config edit refused: anchor ${JSON.stringify(anchor)} not found in ${file}`);
    const head = before.slice(0, anchorIndex);
    const tail = before.slice(anchorIndex);
    const targetParts = target.split(' ');
    const pattern = new RegExp(targetParts.map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+'));
    let seen = 0;
    let replaced = false;
    const newTail = tail.replace(pattern, match => {
        seen += 1;
        if (seen !== occurrence) return match;
        replaced = true;
        return replacement;
    });
    if (!replaced) throw new Error(`config edit refused: ${JSON.stringify(target)} not found after ${JSON.stringify(anchor)} in ${file}`);
    await fsp.writeFile(file, head + newTail, 'utf8');
    const readBack = await fsp.readFile(file, 'utf8');
    if (!readBack.includes(replacement)) throw new Error(`config edit did not persist in ${file}`);
    return { file: 'config.yaml', anchor, from: target, to: replacement, sha256: sha256(readBack) };
}


