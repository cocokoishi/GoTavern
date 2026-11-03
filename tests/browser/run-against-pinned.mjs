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
// `--browserLaunchEnabled false` is NOT optional. The pinned checkout's config.yaml has
// `browserLaunch.enabled: true`, so every boot opens a real tab in the developer's default browser
// at a port that dies with the harness: six captures meant six dead SillyTavern tabs. The flag
// overrides the config without editing the pinned checkout, which must stay untouched (rule 14).
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
import fs from 'node:fs/promises';
import { existsSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { seedLegConfig } from './seed-leg-config.mjs';
import { allocatePort, releasePort, waitForIdentity } from './port-lease.mjs';

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

// THE PORT COMES FROM THE CONTROLLED-RANGE LEASE, NOT bind(0). See port-lease.mjs for the measured
// defect (Browser differential 41388200223) and for why the number alone is not enough: the readiness
// check below also requires the LISTENER to be the child this wrapper spawned.
const port = await allocatePort();

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
// A caller may supply a prepared data root (for example one with a pinned
// extension already installed) so both legs of a comparison serve the same tree.
// A supplied root belongs to the caller and is NOT deleted here.
const suppliedDataRoot = argumentValue('--data-root');
const dataRoot = suppliedDataRoot ? path.resolve(suppliedDataRoot) : await fs.mkdtemp(path.join(os.tmpdir(), 'gotavern-pinned-data-'));
if (suppliedDataRoot) {
    await fs.mkdir(dataRoot, { recursive: true });
}
const baseURL = `http://127.0.0.1:${port}`;
console.log(`[pinned] checkout   ${reference}`);
console.log(`[pinned] dataRoot   ${dataRoot}`);
console.log(`[pinned] baseURL    ${baseURL}`);

// The SAME pinned default config the GoTavern leg is given, as its own copy: the pinned server
// rewrites config.yaml at startup (it adds missing keys), so one shared file would make the second
// leg read state the first leg wrote.
const legConfig = await seedLegConfig(dataRoot);
console.log('[pinned] config     ' + legConfig.path + ' sha256=' + legConfig.sha256);
// A SOURCE WHOSE PROVIDER URL IS A PINNED LITERAL has no request member that can point it at the probe's
// recording peer (openrouter is the first: chat-completions.js:2302 and the Go seam default are both
// `https://openrouter.ai/api/v1`). The GoTavern leg is aimed through its seam; the PINNED leg needs the
// same thing one layer lower, so this writes a loader hook that keeps the REAL node-fetch and rewrites only
// the scheme and host of the declared prefixes, re-reading the mapping file on every request because the
// peer's port is chosen by the child probe AFTER this server boots.
//
// The hook is installed ONLY when the caller asks for it, so every other pinned boot is byte-identical.
let pinnedHookArgs = [];
const redirectFile = process.env.PROBE_PINNED_REDIRECT_FILE;
if (redirectFile) {
    const redirectPath = path.resolve(redirectFile);
    writeFileSync(redirectPath, JSON.stringify([]));
    const realFetchPath = path.join(reference, 'node_modules', 'node-fetch', 'src', 'index.js');
    if (!existsSync(realFetchPath)) {
        throw new Error(`the pinned checkout has no node-fetch at ${realFetchPath}`);
    }
    const hookPath = path.join(path.dirname(redirectPath), 'pinned-redirect-hook.mjs');
    const source = [
        `import { registerHooks } from 'node:module';`,
        `import { readFileSync } from 'node:fs';`,
        `const REAL = ${JSON.stringify(pathToFileURL(realFetchPath).href)};`,
        `const MAP = ${JSON.stringify(redirectPath)};`,
        `registerHooks({`,
        `  resolve(specifier, context, nextResolve) {`,
        `    if (specifier === 'node-fetch') return { url: 'gotavern-redirect:node-fetch', shortCircuit: true };`,
        `    return nextResolve(specifier, context);`,
        `  },`,
        `  load(url, context, nextLoad) {`,
        `    if (url !== 'gotavern-redirect:node-fetch') return nextLoad(url, context);`,
        `    return { format: 'module', shortCircuit: true, source: SOURCE };`,
        `  },`,
        `});`,
        ``,
        `const SOURCE = [`,
        `  'import realFetch from ' + JSON.stringify(REAL) + ';',`,
        `  'import { readFileSync } from "node:fs";',`,
        `  'const MAP = ' + JSON.stringify(MAP) + ';',`,
        `  'function readMap() { try { const v = JSON.parse(readFileSync(MAP, "utf8")); return Array.isArray(v) ? v : []; } catch { return []; } }',`,
        `  'export default function fetchThroughRedirect(input, options) {',`,
        `  '  const href = typeof input === "string" ? input : (input && input.href ? input.href : String(input));',`,
        `  '  for (const pair of readMap()) {',`,
        `  '    if (href.startsWith(pair.from)) return realFetch(pair.to + href.slice(pair.from.length), options);',`,
        `  '  }',`,
        `  '  return realFetch(href, options);',`,
        `  '}',`,
        `  'globalThis.fetch = fetchThroughRedirect;',`,
        `].join(String.fromCharCode(10));`,
    ].join('\n');
    writeFileSync(hookPath, source);
    pinnedHookArgs = ['--import', pathToFileURL(hookPath).href];
    console.log(`[pinned] transport redirect hook: ${hookPath} (mapping ${redirectPath})`);
}
const server = spawn(process.execPath, [...pinnedHookArgs, 'server.js', '--port', String(port), '--dataRoot', dataRoot, '--configPath', path.join(dataRoot, 'config.yaml'), '--browserLaunchEnabled', 'false'], {
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

// IDENTITY-BOUND READINESS. `response.ok` used to be the whole test, which accepts a 200 from ANY
// process that owns the port -- including a leftover server of the other subject, or an in-process peer
// that took the port between the bind(0) probe and this spawn (Browser differential 41388200223). This
// requires the pinned baseline product AND the listener PID to be the child spawned below.
async function waitForPinnedIdentity() {
    return waitForIdentity({
        baseURL,
        port,
        childAlive: () => serverExit === null,
        childPid: server.pid,
        expectedPkgVersion: '1.19.0',
        deadlineMs: readyMs,
        logTail: () => tail.join(''),
    });
}

let exitCode = 1;
try {
    const identity = await waitForPinnedIdentity();
    const version = identity.version;
    console.log(`[pinned] ready: SillyTavern ${version.pkgVersion} (${version.gitRevision}); identity ${identity.identityMethod}, listener PID ${identity.listenerPid ?? 'unavailable'}`);
    const child = spawn(process.execPath, [scriptPath, '--base-url', baseURL, ...forwarded], {
        cwd: here,
        stdio: 'inherit',
        // PROBE_SERVER_PID IS A REAL OBSERVATION, NOT A HINT. A probe asked to prove "a NEW server process read this
        // tree" cannot see a server it did not spawn, and every leg that recorded `restartIsNewProcess` against this
        // wrapper recorded `Boolean(undefined) && …` = FALSE for the pinned subject -- a structural asymmetry no product
        // behaviour could clear (measured: Browser differential 40878005589, the helper-vars restart leg). The wrapper
        // owns the process, so it is the only place the pid can come from.
        env: { ...process.env, PROBE_BASE_URL: baseURL, CAPTURE_BASE_URL: baseURL, PROBE_LEG_CONFIG_JSON: JSON.stringify(legConfig), PROBE_SERVER_PID: String(server.pid) },
    });
    exitCode = (await new Promise(resolve => child.on('exit', resolve))) ?? 1;
    console.log(`[pinned] child exited ${exitCode}`);
} catch (error) {
    console.error(`[pinned] FAILED: ${error.message}`);
    console.error('[pinned] --- server output tail ---');
    console.error(tail.join('').slice(-4000));
} finally {
    server.kill('SIGKILL');
    releasePort(port);
    if (!suppliedDataRoot) {
        await fs.rm(dataRoot, { recursive: true, force: true }).catch(() => {});
    }
}
process.exit(exitCode);
