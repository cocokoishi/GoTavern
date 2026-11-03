// A PORT LEASE AND AN IDENTITY-BOUND READINESS CHECK, shared by every probe that boots a subject.
//
// WHY THIS FILE EXISTS (AGENTS.md rule 33 and the alpha.12 finding): the harness used to allocate a
// port by binding port 0, closing the socket, and handing the NUMBER to a server started later. Between
// the close and the bind anything else on the machine can take that port, and the probe then drives
// the wrong process. Measured in Browser differential 41388200223: the ai21 cancel leg's GoTavern and
// mock-provider legs both recorded 127.0.0.1:41987, the page asked GET / and /scripts/events.js and got
// 404 from the in-process peer, and the comparator read that as a product divergence. The fix in
// a01b536 was local to generation-probe.mjs; the same bind(0) pattern survived in q20-leg-runtime.mjs,
// extension-probe.mjs, run-against-pinned.mjs and several other probes.
//
// WHAT THIS MODULE GUARANTEES, and what it refuses to claim:
//   1. allocatePort() leases from a CONTROLLED range (20000-29999, below Linux's ephemeral range on the
//      images this project runs on) instead of bind(0), keeps a process-wide set so two legs in one
//      process cannot be handed the same port, and retries on a bind collision. It still cannot make
//      the close-then-bind window atomic -- nothing in user space can -- so it is paired with (2).
//   2. waitForIdentity() does not accept "an HTTP response". It requires: the child process this
//      harness spawned is still alive; /version answers 200 with a JSON object whose pkgVersion is the
//      expected baseline; and the LISTENER of the port is owned by that child PID (checked through
//      `ss`/`lsof`/PowerShell). A leftover server of either product, or a peer that took the port,
//      fails with a named error instead of being driven.
//   3. When the listener lookup is unavailable on the host, the check records identityMethod
//      'version-and-child-liveness' rather than silently claiming PID ownership; the caller writes
//      that into its artefact so a reader can see the weaker method. It never falls back to 404-is-ready.
//
// A probe that uses this module must pass `--port`/lease explicitly: there is no hidden default that
// re-introduces bind(0).

import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import process from 'node:process';

// Below the Linux ephemeral range (default 32768-60999) and above the privileged range. The pinned
// server and the Go server both bind only 127.0.0.1 for these probes.
export const PORT_RANGE = { start: 20000, end: 29999 };

const leasedPorts = new Set();

function probeBind(port) {
    return new Promise((resolve, reject) => {
        const server = createServer();
        server.unref();
        server.once('error', error => {
            if (error && error.code === 'EADDRINUSE') resolve(false);
            else reject(error);
        });
        server.listen(port, '127.0.0.1', () => {
            server.close(() => resolve(true));
        });
    });
}

/**
 * Allocate a port from the controlled range.
 *
 * `exclude` is honoured in addition to the process-wide lease set. A collision (another process took
 * the candidate between the probe and the caller's bind) is handled by `waitForIdentity`, which fails
 * loudly rather than driving whatever answered.
 */
export async function allocatePort({ exclude = [], attempts = 400, range = PORT_RANGE } = {}) {
    const excluded = new Set([...exclude, ...leasedPorts]);
    const span = range.end - range.start + 1;
    const offset = Math.floor(Math.random() * span);
    for (let index = 0; index < attempts; index += 1) {
        const port = range.start + ((offset + index * 37) % span);
        if (excluded.has(port)) continue;
        if (await probeBind(port)) {
            leasedPorts.add(port);
            return port;
        }
        excluded.add(port);
    }
    throw new Error(`could not allocate a port in ${range.start}-${range.end} after ${attempts} attempts`);
}

export function releasePort(port) {
    leasedPorts.delete(port);
}

// The listener PID, or null when this host cannot answer the question. A null is RECORDED, never
// treated as "the child owns it".
function listenerPidLinux(port) {
    const result = spawnSync('ss', ['-ltnpH', `sport = :${port}`], { encoding: 'utf8' });
    if (result.status !== 0 || typeof result.stdout !== 'string') return { pid: null, reason: `ss exited ${result.status}` };
    const match = result.stdout.match(/pid=(\d+)/);
    return { pid: match ? Number(match[1]) : null, reason: match ? null : 'no pid= field in ss output' };
}

function listenerPidDarwin(port) {
    const result = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' });
    if (result.status !== 0 || typeof result.stdout !== 'string') return { pid: null, reason: `lsof exited ${result.status}` };
    const first = result.stdout.trim().split(/\s+/).filter(Boolean)[0];
    return { pid: first ? Number(first) : null, reason: first ? null : 'lsof printed no pid' };
}

function listenerPidWindows(port) {
    const script = `$c = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess; if ($c) { $c }`;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' });
    if (result.status !== 0 || typeof result.stdout !== 'string') return { pid: null, reason: `powershell exited ${result.status}` };
    const value = Number(result.stdout.trim());
    return { pid: Number.isInteger(value) && value > 0 ? value : null, reason: Number.isInteger(value) && value > 0 ? null : 'no listener pid' };
}

export function listenerPidForPort(port) {
    if (process.platform === 'linux') return listenerPidLinux(port);
    if (process.platform === 'darwin') return listenerPidDarwin(port);
    if (process.platform === 'win32') return listenerPidWindows(port);
    return { pid: null, reason: `listener lookup is not implemented on ${process.platform}` };
}

/**
 * Wait until the server this harness spawned is the server answering the port.
 *
 * @param {object} options
 * @param {string} options.baseURL              http://127.0.0.1:<port>
 * @param {number} options.port
 * @param {() => boolean} options.childAlive    false when the spawned process has exited
 * @param {number|null} options.childPid        the PID this harness spawned (null for an externally
 *                                              booted subject, where PID ownership cannot be claimed)
 * @param {string} options.expectedPkgVersion   the baseline /version pkgVersion, e.g. '1.19.0'
 * @param {number} [options.deadlineMs]
 * @param {() => string} [options.logTail]      the subject's own log, for the failure message
 */
export async function waitForIdentity({
    baseURL,
    port,
    childAlive,
    childPid = null,
    expectedPkgVersion,
    deadlineMs = 120000,
    logTail = () => '',
}) {
    const started = Date.now();
    let lastError = null;
    let sawVersion = null;
    while (Date.now() - started < deadlineMs) {
        if (!childAlive()) {
            const tail = String(logTail()).slice(-3000);
            throw new Error(`the subject process exited before it owned ${baseURL}/version; log tail:\n${tail}`);
        }
        try {
            const response = await fetch(`${baseURL}/version`, { signal: AbortSignal.timeout(5000) });
            if (response.status === 200) {
                const text = await response.text();
                let payload = null;
                try {
                    payload = JSON.parse(text);
                } catch {
                    payload = null;
                }
                if (payload && typeof payload === 'object' && typeof payload.pkgVersion === 'string') {
                    if (payload.pkgVersion !== expectedPkgVersion) {
                        throw new Error(`${baseURL}/version reports pkgVersion ${JSON.stringify(payload.pkgVersion)}, expected ${JSON.stringify(expectedPkgVersion)}: this is not the pinned baseline product`);
                    }
                    sawVersion = payload;
                    // THE LISTENER MUST BE THE PROCESS WE SPAWNED. A 200 from a leftover server of the
                    // other subject is exactly the alpha.12 failure this check exists to remove.
                    let identityMethod = 'version-and-child-liveness';
                    let listenerPid = null;
                    if (childPid !== null) {
                        const lookup = listenerPidForPort(port);
                        listenerPid = lookup.pid;
                        if (lookup.pid !== null) {
                            if (lookup.pid !== childPid) {
                                throw new Error(`${baseURL} is answered by PID ${lookup.pid}, but this harness spawned PID ${childPid}: the subject did not get the port (a leftover or peer process owns it)`);
                            }
                            identityMethod = 'version-and-listener-pid';
                        } else {
                            lastError = new Error(`listener PID lookup unavailable (${lookup.reason}); continuing with version-and-child-liveness`);
                        }
                    }
                    return { version: payload, identityMethod, listenerPid, elapsedMs: Date.now() - started };
                }
                lastError = new Error(`${baseURL}/version answered 200 but not with a SillyTavern version object: ${text.slice(0, 200)}`);
            } else {
                lastError = new Error(`${baseURL}/version answered ${response.status}`);
            }
        } catch (error) {
            if (String(error.message ?? error).includes('is not the pinned baseline product')
                || String(error.message ?? error).includes('this harness spawned PID')) {
                throw error;
            }
            lastError = error;
        }
        await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw new Error(`${baseURL}/version did not reach the expected identity within ${deadlineMs}ms: ${lastError?.message ?? 'no response'}; last version payload: ${JSON.stringify(sawVersion)}`);
}
