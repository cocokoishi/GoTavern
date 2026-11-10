#!/usr/bin/env node
// alpha.20 mixed-load soak COMPANION (Layer A, development host).
//
// `tools/perf/a18-soak.mjs` (unmodified) is the primary 60-minute soak: weighted storage routes, restarts,
// write->restart->read integrity, and an external card modification. It deliberately does NOT drive a large
// world-book get/edit, multi-session switching or provider streaming. This companion adds those on the SAME
// candidate process at a low rate and records its own p50/p95/p99/errors, so the two artifacts together describe
// the mixed load. It never defines product correctness: it asserts only HTTP status and the on-disk/on-wire
// equality of the chat file and world book it owns.
//
// USAGE
//   node tools/perf/a20-soak-companion.mjs \
//     --binary <gotavern.exe> --data-root <tree>/data --config <tree>/config.yaml \
//     --minutes 60 --rate 2 --out <artifact.json> [--port <n>] [--provider-base <url>]
//
// `--provider-base` is optional. When given, the companion also drives
// POST /api/backends/chat-completions/generate with `reverse_proxy: <provider-base>` and cancels one SSE request
// mid-stream per minute; when absent (the default) that row is recorded as UNEXECUTED with the reason, never
// fabricated. The world-info edit is REVERSIBLE: the companion reads `A15 World 00000.json`, writes a temporary
// entry through /api/worldinfo/edit, re-reads, then restores the original on-disk bytes and verifies the restore.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const argv = process.argv.slice(2);
const argument = (name, fallback = null) => {
    const index = argv.indexOf(name);
    return index < 0 ? fallback : argv[index + 1] ?? fallback;
};
const binary = argument('--binary');
const dataRoot = argument('--data-root');
const configPath = argument('--config');
const minutes = Number(argument('--minutes', '60'));
const rate = Number(argument('--rate', '2'));
const outPath = argument('--out');
const port = Number(argument('--port', '18950'));
const providerBase = argument('--provider-base');
if (!binary || !dataRoot || !configPath || !outPath || !(minutes > 0) || !(rate > 0)) {
    console.error('usage: node tools/perf/a20-soak-companion.mjs --binary <exe> --data-root <dir/data> --config <file> --minutes <n> --rate <n> --out <file> [--port <n>] [--provider-base <url>]');
    process.exit(2);
}

const artifact = {
    harness: 'tools/perf/a20-soak-companion.mjs',
    startedAt: new Date().toISOString(),
    host: { os: `${os.platform()} ${os.arch()}`, cpus: os.cpus().length, totalMemoryBytes: os.totalmem() },
    parameters: { binary, dataRoot, configPath, minutes, rate, port, providerBase: providerBase ?? null, combinedWith: 'tools/perf/a18-soak.mjs (primary, same process)' },
    environment: { node: process.version, note: 'Windows arm64 development host, shared with the other alpha.20 lanes; a18-soak is the primary load, this companion adds a low extra rate' },
    routes: {},
    errors: [],
    worldInfo: { executed: false, reason: null },
    chatIntegrity: { checks: 0, failures: 0 },
    provider: { executed: false, reason: providerBase ? null : 'no --provider-base supplied; generation/SSE-cancel UNEXECUTED for this run (a deterministic loopback peer is required)' },
    sessions: { executed: false, detail: null },
    model: 'one process, one data root; sessions are independent cookie jars on the same default user. Multi-ACCOUNT isolation is covered by tests/perf/m5-eight-users.mjs, not by this soak.',
    leakVerdict: 'UNPROVEN (an RSS trend over 60 minutes is not a proof; allocator retention is not separable from RSS; the companion process is killed with force)',
};

function rawRequest(method, route, body, session, onResponse) {
    return new Promise((resolve, reject) => {
        const payload = body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body);
        const headers = {};
        if (session) {
            headers['x-csrf-token'] = session.token;
            headers.cookie = session.cookie;
        }
        if (payload !== null) {
            headers['content-type'] = 'application/json';
            headers['content-length'] = Buffer.byteLength(payload);
        }
        const started = process.hrtime.bigint();
        const req = http.request({ method, host: '127.0.0.1', port, path: route, headers, agent: false }, onResponse ?? (response => {
            const chunks = [];
            let bytes = 0;
            response.on('data', chunk => { chunks.push(chunk); bytes += chunk.length; });
            response.on('end', () => {
                const ms = Number(process.hrtime.bigint() - started) / 1e6;
                resolve({ method, route, status: response.statusCode, bytes, ms, body: Buffer.concat(chunks).toString('utf8'), durationMs: ms });
            });
        }));
        req.on('error', reject);
        if (payload !== null) req.write(payload);
        req.end();
    });
}
const request = (method, route, body, session) => rawRequest(method, route, body, session);

async function newSession(label) {
    const response = await new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path: '/csrf-token', agent: false }, res => {
            const cookies = res.headers['set-cookie'] ?? [];
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => resolve({ cookies, body: Buffer.concat(chunks).toString('utf8') }));
        }).on('error', reject);
    });
    return { label, token: JSON.parse(response.body).token, cookie: response.cookies.map(value => value.split(';')[0]).join('; ') };
}

async function waitForServer(deadlineMs) {
    const deadline = Date.now() + deadlineMs;
    while (Date.now() < deadline) {
        try {
            const row = await request('GET', '/version');
            if (row.status === 200) return true;
        } catch {
            // not up yet
        }
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    return false;
}

function bucketFor(name) {
    artifact.routes[name] ??= { count: 0, non200: 0, ms: [] };
    return artifact.routes[name];
}

async function drive(name, method, route, body, session) {
    try {
        const row = await request(method, route, body, session);
        const bucket = bucketFor(name);
        bucket.count += 1;
        bucket.ms.push(row.ms);
        if (row.status !== 200) {
            bucket.non200 += 1;
            artifact.errors.push({ kind: 'http', route: name, status: row.status, body: row.body.slice(0, 300) });
        }
        return row;
    } catch (error) {
        artifact.errors.push({ kind: 'request', route: name, detail: String(error) });
        return null;
    }
}

async function run() {
    const child = spawn(binary, ['--dataRoot', dataRoot, '--configPath', configPath, '--port', String(port), '--listenAddressIPv4', '127.0.0.1'], { cwd: path.dirname(path.resolve(configPath)), stdio: ['ignore', 'pipe', 'pipe'] });
    let childError = '';
    child.stderr.on('data', chunk => { childError += chunk.toString(); });
    artifact.process = { pid: child.pid };
    const ready = await waitForServer(30000);
    artifact.process.ready = ready;
    if (!ready) {
        artifact.errors.push({ kind: 'boot', detail: 'server did not answer /version within 30 s', stderr: childError.slice(0, 2000) });
        child.kill();
        fs.writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
        process.exit(1);
    }
    const sessions = [];
    for (let index = 0; index < 3; index++) sessions.push(await newSession(`session-${index + 1}`));
    artifact.sessions = { executed: true, detail: `${sessions.length} independent cookie-jar sessions on one default-user process, each driving its own requests` };

    const chatsDir = path.join(dataRoot, 'default-user', 'chats', 'A15 Character');
    const chatFile = path.join(chatsDir, 'a20-companion-soak.jsonl');
    fs.mkdirSync(chatsDir, { recursive: true });
    const worldFile = path.join(dataRoot, 'default-user', 'worlds', 'A15 World 00000.json');
    const worldOriginal = fs.existsSync(worldFile) ? fs.readFileSync(worldFile) : null;
    if (!worldOriginal) artifact.worldInfo.reason = 'world file A15 World 00000.json not present in this tree';
    let worldEntries = null;
    if (worldOriginal) {
        try { worldEntries = JSON.parse(worldOriginal.toString('utf8')).entries ?? {}; } catch (error) { artifact.worldInfo.reason = `world file is not parseable: ${String(error)}`; }
    }

    const durationMs = minutes * 60 * 1000;
    const started = Date.now();
    let nextProviderCancel = Date.now();
    let iterations = 0;
    let lastEditMinute = 0;
    while (Date.now() - started < durationMs && child.exitCode === null) {
        const session = sessions[iterations % sessions.length];
        iterations += 1;
        await drive('characters-all', 'POST', '/api/characters/all', {}, session);
        await drive('worldinfo-get', 'POST', '/api/worldinfo/get', { name: 'A15 World 00000' }, session);
        await drive('chats-get', 'POST', '/api/chats/get', { avatar_url: 'A15 Character.png', file_name: 'A15 Chat 0000' }, session);
        await drive('settings-get', 'POST', '/api/settings/get', {}, session);
        const saved = await drive('chat-save', 'POST', '/api/chats/save', { avatar_url: 'A15 Character.png', file_name: 'a20-companion-soak', chat: [{ name: 'A15 Character', is_user: false, mes: `companion turn ${iterations}`, send_date: new Date().toISOString() }] }, session);
        if (saved && saved.status === 200) {
            const reload = await drive('chats-get (saved)', 'POST', '/api/chats/get', { avatar_url: 'A15 Character.png', file_name: 'a20-companion-soak' }, session);
            if (reload && reload.status === 200) {
                artifact.chatIntegrity.checks += 1;
                try {
                    const parsed = JSON.parse(reload.body);
                    const last = Array.isArray(parsed) ? parsed[parsed.length - 1] : null;
                    const onDisk = fs.existsSync(chatFile) ? fs.readFileSync(chatFile, 'utf8') : '';
                    if (!last || !String(last.mes ?? '').startsWith('companion turn') || !onDisk.includes(String(last.mes))) artifact.chatIntegrity.failures += 1;
                } catch {
                    artifact.chatIntegrity.failures += 1;
                }
            }
        }
        const minute = Math.floor((Date.now() - started) / 60000);
        if (worldEntries && minute > lastEditMinute) {
            lastEditMinute = minute;
            artifact.worldInfo.executed = true;
            try {
                const editedEntries = { ...JSON.parse(worldOriginal.toString('utf8')).entries };
                editedEntries[`a20soak${minute}`] = { uid: 900000 + minute, key: ['a20-soak'], keysecondary: [], comment: '', content: 'soak marker', constant: false, selective: true, selectiveLogic: 0, addMemo: true, order: 100, position: 0, disable: false, excludeRecursion: false, preventRecursion: false, delayUntilRecursion: false, probability: 100, useProbability: true, depth: 4, group: '', groupOverride: false, groupWeight: 100, scanDepth: null, caseSensitive: null, matchWholeWords: null, useGroupScoring: null, automationId: '', role: 0, vectorized: false, sticky: 0, cooldown: 0, delay: 0, extensions: {} };
                const edit = await drive('worldinfo-edit', 'POST', '/api/worldinfo/edit', { name: 'A15 World 00000', data: { entries: editedEntries } }, session);
                const reread = await drive('worldinfo-get (edited)', 'POST', '/api/worldinfo/get', { name: 'A15 World 00000' }, session);
                artifact.worldInfo.lastEditStatus = edit ? edit.status : null;
                artifact.worldInfo.lastRereadStatus = reread ? reread.status : null;
                if (reread && reread.status === 200) {
                    try {
                        const parsed = JSON.parse(reread.body);
                        artifact.worldInfo.markerPresentAfterEdit = Boolean(parsed.entries?.[`a20soak${minute}`]);
                    } catch { artifact.worldInfo.markerPresentAfterEdit = false; }
                }
                fs.writeFileSync(worldFile, worldOriginal);
                artifact.worldInfo.restoreAttempts = (artifact.worldInfo.restoreAttempts ?? 0) + 1;
                artifact.worldInfo.restoredByteIdentical = fs.readFileSync(worldFile).equals(worldOriginal);
            } catch (error) {
                artifact.worldInfo.reason = `edit cycle failed: ${String(error)}`;
            }
        }
        if (providerBase && Date.now() >= nextProviderCancel) {
            nextProviderCancel = Date.now() + 60000;
            artifact.provider.executed = true;
            artifact.provider.cancels = (artifact.provider.cancels ?? 0) + 1;
            await new Promise(resolve => {
                const payload = JSON.stringify({ chat_completion_source: 'openai', model: 'soak-mock', messages: [{ role: 'user', content: 'soak marker' }], stream: true, reverse_proxy: providerBase });
                const req = http.request({ method: 'POST', host: '127.0.0.1', port, path: '/api/backends/chat-completions/generate', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), 'x-csrf-token': session.token, cookie: session.cookie }, agent: false }, response => {
                    let received = 0;
                    response.on('data', chunk => { received += chunk.length; if (received > 64) { req.destroy(); resolve(); } });
                    response.on('end', resolve);
                });
                req.on('error', error => { artifact.provider.lastError = String(error); resolve(); });
                req.write(payload);
                req.end();
                setTimeout(() => { req.destroy(); resolve(); }, 5000);
            });
        }
        await new Promise(resolve => setTimeout(resolve, Math.max(0, Math.floor(1000 / rate) - 20)));
    }
    artifact.finishedAt = new Date().toISOString();
    artifact.wallMs = Date.now() - started;
    artifact.iterations = iterations;
    artifact.process.exitedDuringRun = child.exitCode !== null;
    for (const bucket of Object.values(artifact.routes)) {
        bucket.ms.sort((a, b) => a - b);
        const q = p => bucket.ms[Math.min(bucket.ms.length - 1, Math.floor(p * bucket.ms.length))];
        bucket.p50 = Number(q(0.5).toFixed(2));
        bucket.p95 = Number(q(0.95).toFixed(2));
        bucket.p99 = Number(q(0.99).toFixed(2));
        bucket.max = Number(bucket.ms[bucket.ms.length - 1].toFixed(2));
        delete bucket.ms;
    }
    if (worldOriginal) {
        try { fs.writeFileSync(worldFile, worldOriginal); } catch { artifact.worldInfo.reason = 'restore-write failed'; }
        artifact.worldInfo.restoredByteIdenticalFinal = fs.existsSync(worldFile) && fs.readFileSync(worldFile).equals(worldOriginal);
    }
    if (!child.killed) child.kill();
    fs.writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
    const requestCount = Object.values(artifact.routes).reduce((sum, bucket) => sum + bucket.count, 0);
    console.log(`companion: ${iterations} iterations, ${requestCount} requests, ${artifact.errors.length} error(s), ${Math.round(artifact.wallMs / 1000)}s -> ${outPath}`);
    process.exit(artifact.errors.length === 0 ? 0 : 1);
}

run().catch(error => {
    artifact.errors.push({ kind: 'harness', detail: String(error && error.stack ? error.stack : error) });
    try { fs.writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8'); } catch { /* ignored */ }
    console.error(`companion harness failure: ${error && error.stack ? error.stack : error}`);
    process.exit(2);
});
