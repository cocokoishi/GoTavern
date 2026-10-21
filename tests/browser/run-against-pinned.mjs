// Boot the PINNED SillyTavern server on a free port with a scratch data root, run one child script
// against it, then tear everything down.
//
// WHY THIS EXISTS: the capture and measurement scripts in this directory need a RUNNING pinned
// server, and hand-started servers make results unreproducible: the port, the data root and the
// leftover state all differ between runs. This boots a clean one per invocation, so a capture is a
// property of the pinned checkout rather than of whatever was already listening.
//
// A FRESH data root works and needs no stdin (measured): the pinned server seeds `default/**` into
// it and compiles the frontend libraries, which takes 20-40s, so the readiness deadline is generous
// and derived from `/version` rather than from a sleep.
//
// Reference resolution matches run-pinned-suite.mjs: --reference, then $GOTAVERN_REFERENCE, then
// .reference/SillyTavern (the CI checkout), then ../SillyTavern (a local developer checkout).
//
// Usage:
//   node run-against-pinned.mjs <script> [-- extra args...]
//
//   The child receives --base-url <url> and PROBE_BASE_URL/CAPTURE_BASE_URL in its environment.
//   PINNED_READY_MS overrides the readiness deadline (default 90000).

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

function argumentValue(name, fallback) {
    const index = process.argv.indexOf(name);
    if (index === -1) {
        return fallback;
    }
    return process.argv[index + 1];
}

async function exists(target) {
    try {
        await fs.stat(target);
        return true;
    } catch {
        return false;
    }
}

async function resolveReference() {
    const explicit = argumentValue('--reference', process.env.GOTAVERN_REFERENCE);
    const candidates = [
        explicit,
        path.join(repoRoot, '.reference', 'SillyTavern'),
        path.resolve(repoRoot, '..', 'SillyTavern'),
    ].filter(Boolean);
    for (const candidate of candidates) {
        if (await exists(path.join(candidate, 'server.js'))) {
            return candidate;
        }
    }
    throw new Error(`no pinned SillyTavern checkout found; tried: ${candidates.join(', ')}`);
}

function freePort() {
    return new Promise((resolve, reject) => {
        const server = createServer();
        server.unref();
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            server.close(() => resolve(port));
        });
    });
}

// The child is named after the first positional argument; anything after `--` is forwarded.
const separator = process.argv.indexOf('--');
const forwarded = separator === -1 ? [] : process.argv.slice(separator + 1);
const childArgs = separator === -1 ? process.argv.slice(2) : process.argv.slice(2, separator);
const script = childArgs.find(entry => !entry.startsWith('--') && !entry.startsWith('-'));
if (!script) {
    console.error('usage: node run-against-pinned.mjs <script> [-- extra args...]');
    process.exit(2);
}
const scriptPath = path.resolve(here, script);

const reference = await resolveReference();
const readyMs = Number(process.env.PINNED_READY_MS ?? 90000);
const port = await freePort();
const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gotavern-pinned-data-'));
const baseURL = `http://127.0.0.1:${port}`;
console.log(`[pinned] checkout   ${reference}`);
console.log(`[pinned] dataRoot   ${dataRoot}`);
console.log(`[pinned] baseURL    ${baseURL}`);

const server = spawn(process.execPath, ['server.js', '--port', String(port), '--dataRoot', dataRoot], {
    cwd: reference,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
});
const tail = [];
const capture = chunk => {
    const text = chunk.toString();
    tail.push(text);
    while (tail.length > 200) {
        tail.shift();
    }
    // The pinned server is chatty; only surface lines that look like a problem unless asked for all.
    if (process.env.PINNED_VERBOSE === '1') {
        process.stdout.write(text.replace(/^/gm, '[server] '));
    }
};
server.stdout.on('data', capture);
server.stderr.on('data', capture);

let serverExit = null;
server.on('exit', (code, signal) => {
    serverExit = { code, signal };
});

async function waitForVersion() {
    const started = Date.now();
    while (Date.now() - started < readyMs) {
        if (serverExit) {
            throw new Error(`the pinned server exited before answering /version: ${JSON.stringify(serverExit)}`);
        }
        try {
            const response = await fetch(`${baseURL}/version`);
            if (response.ok) {
                return await response.json();
            }
        } catch {
            // not up yet
        }
        await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error(`the pinned server did not answer ${baseURL}/version within ${readyMs}ms`);
}

let exitCode = 1;
try {
    const version = await waitForVersion();
    console.log(`[pinned] ready: SillyTavern ${version.pkgVersion} (${version.gitRevision})`);
    const child = spawn(process.execPath, [scriptPath, '--base-url', baseURL, ...forwarded], {
        cwd: here,
        stdio: 'inherit',
        env: { ...process.env, PROBE_BASE_URL: baseURL, CAPTURE_BASE_URL: baseURL },
    });
    exitCode = (await new Promise(resolve => child.on('exit', resolve))) ?? 1;
    console.log(`[pinned] child exited ${exitCode}`);
} catch (error) {
    console.error(`[pinned] FAILED: ${error.message}`);
    console.error('[pinned] --- server output tail ---');
    console.error(tail.join('').slice(-4000));
} finally {
    server.kill('SIGKILL');
    await fs.rm(dataRoot, { recursive: true, force: true }).catch(() => {});
}
process.exit(exitCode);
