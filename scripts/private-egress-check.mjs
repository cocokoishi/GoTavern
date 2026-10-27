// PROVE THE NETWORK SIDE OF THE PRIVATE CHANNEL: nothing leaves this machine while the originals are in use.
//
// WHY THIS IS SEPARATE FROM private-workdir.mjs. That program proves the COPY is isolated. It says nothing
// about egress, and "I copied carefully" is exactly the reasoning that let a Horde probe reach the live
// internet in this repository's history while its author believed the transport was replaced (`AGENTS.md`
// verification rule 14: replacing the module is not the claim "no request left this process").
//
// WHAT THIS MEASURES, and it is deliberately narrow so that a PASS means something:
//
//   1. A CANARY THAT MUST BE BLOCKED OUTSIDE THE ALLOWLIST. A real TCP connect is attempted to a peer the
//      environment provides (`--outside-host`, default a public DNS resolver) from inside the same guard the
//      private run uses. If that connect SUCCEEDS, the guard is not in force and the whole channel is void.
//      The canary proves the guard works, in the same process, immediately before the observation.
//   2. A CANARY THAT MUST BE ALLOWED INSIDE IT. A loopback listener is started and reached. If that fails,
//      the guard blocks legitimate local traffic and the qualification would be blocked for the wrong reason.
//   3. THE OBSERVATION ITSELF: with the guard installed, the guarded code runs and every attempted connect is
//      recorded. A connect that is not to the allowlist is REFUSED and COUNTED, so an escape appears as a
//      refusal rather than as plausible data.
//
// WHAT IT CANNOT DO, stated because the sentence must exist somewhere a reader will see it: a JavaScript-level
// guard cannot stop a native library, a subprocess that does its own networking, or a syscall that bypasses
// this module. It is a tripwire for the paths a Node program actually takes (net, http, https, fetch,
// WebSocket), and its honesty is that it says so. The syscall/namespace isolation is the operator's job, and
// the report carries a field asserting it was NOT proven here.
//
// Usage:
//   node scripts/private-egress-check.mjs [--outside-host 1.1.1.1] [--outside-port 53] [--report <file>]

import net from 'node:net';
import fs from 'node:fs/promises';
import process from 'node:process';

function argument(name, fallback = null) {
    const index = process.argv.indexOf(name);
    return index === -1 ? fallback : process.argv[index + 1];
}

const outsideHost = argument('--outside-host', '1.1.1.1');
const outsidePort = Number(argument('--outside-port', '53'));
const reportPath = argument('--report', null);

// THE GUARD. Installed by replacing the CONNECT path rather than by inspecting traffic after the fact, so a
// refused attempt is refused rather than merely recorded -- the same shape the tests/egressguard package uses
// for the Go side, and for the same reason: a request that escapes must appear as a missing/failed request.
function installGuard(allowlist) {
    const attempts = [];
    const originalConnect = net.Socket.prototype.connect;

    const allowed = address => {
        if (typeof address !== 'object' || address === null) return true; // a path/pipe socket is local
        const host = String(address.host ?? '127.0.0.1');
        if (!allowlist.hosts.includes(host)) return false;
        // AN EMPTY PORT LIST MEANS "ANY LOOPBACK PORT", AND THAT DEFAULT IS LOAD-BEARING. The first version
        // compared against `allowlist.ports` unconditionally, and the OUTSIDE canary ran with an empty list --
        // so the loopback canary that ran afterwards was refused as well, the report said
        // `loopbackPermitted: false`, and the check failed on its own bug. Refusing every loopback port would
        // mean a private run cannot start its own server, which is the whole point of the channel.
        return allowlist.ports.length === 0 || allowlist.ports.includes(Number(address.port));
    };

    const records = record => ({
        host: record.host,
        port: record.port,
        // THE DECISION IS RECORDED ON THE ATTEMPT, not recomputed later against a list that may have changed.
        // The canary evaluates several allowlists in sequence through one report; recomputing made the earlier
        // canary's verdict depend on the later canary's configuration.
        allowed: allowed({ host: record.host, port: record.port }),
    });

    net.Socket.prototype.connect = function guardedConnect(...args) {
        // NORMALISE THE ARGUMENTS THE WAY node:net ITSELF DOES, OR THE GUARD INSPECTS NOTHING.
        //
        // Measured 2026-10-27 in this file: `net.connect(options)` reaches `Socket.prototype.connect` with a
        // SINGLE argument that is an ARRAY `[{host, port}, null]`, not the plain options object the first
        // version assumed. `args[0]` was therefore an array, `args[0].host` was undefined, the record fell back
        // to the hard-coded `127.0.0.1:0`, and `allowed` returned TRUE for every connect -- including the outside
        // canary, which CONNECTED to 1.1.1.1:53 while the guard reported itself in force. The canary is the only
        // reason this was caught: without it the check would have passed every loopback assertion and certified
        // an instrument that permitted everything (AGENTS verification rule 14, "I replaced the HTTP client" is
        // not the claim "no request left this process").
        const first = Array.isArray(args[0]) ? args[0][0] : args[0];
        const options = typeof first === 'object' && first !== null ? first : { port: args[0], host: args[1] };
        const decided = records({ host: String(options?.host ?? '127.0.0.1'), port: Number(options?.port ?? 0) });
        attempts.push(decided);
        if (!decided.allowed) {
            const error = new Error(`egress blocked by the private-channel guard: ${decided.host}:${decided.port}`);
            error.code = 'EGRESS_BLOCKED';
            process.nextTick(() => this.destroy(error));
            return this;
        }
        return originalConnect.apply(this, args);
    };

    return {
        attempts,
        uninstall() {
            net.Socket.prototype.connect = originalConnect;
        },
        refused() {
            return attempts.filter(record => record.allowed !== true);
        },
    };
}

/** One TCP connect with a bound, reporting whether it CONNECTED rather than whether it threw. */
function probe(host, port, timeoutMs = 4000) {
    return new Promise(resolve => {
        const socket = net.connect({ host, port });
        const finish = outcome => {
            socket.destroy();
            resolve(outcome);
        };
        socket.setTimeout(timeoutMs);
        socket.once('connect', () => finish({ connected: true }));
        socket.once('timeout', () => finish({ connected: false, reason: 'timeout' }));
        socket.once('error', error => finish({ connected: false, reason: String(error?.code ?? error?.message ?? error) }));
    });
}

async function main() {
    const allowlist = { hosts: ['127.0.0.1', '::1', 'localhost'], ports: [] };
    const report = {
        step: 'private-egress-check',
        what: 'prove that the guard the private run uses refuses an outside connect and permits a loopback one',
        whatItDoesNotProve: [
            'that a native library or a subprocess did no networking: this guard covers the Node paths a probe takes (net/http/https/fetch/WebSocket)',
            'that the operating system blocked anything: no namespace, container or firewall is involved',
        ],
        osLevelIsolationProven: false,
        canary: null,
        loopback: null,
        problems: [],
    };

    // (1) THE OUTSIDE CANARY, WITH THE GUARD INSTALLED. If this CONNECTS, nothing else in the report matters.
    const first = installGuard(allowlist);
    try {
        report.canary = await probe(outsideHost, outsidePort);
    } finally {
        first.uninstall();
    }
    report.canary.target = `${outsideHost}:${outsidePort}`;
    report.canary.attemptsRecorded = first.attempts.length;
    if (report.canary.connected === true) {
        report.problems.push(`THE GUARD IS NOT IN FORCE: an outside connect to ${outsideHost}:${outsidePort} SUCCEEDED while the guard was installed, so no private observation can be trusted`);
    }

    // (2) THE LOOPBACK CANARY, WITH THE GUARD INSTALLED. A guard that blocks local traffic would produce a
    //     PASS for the wrong reason everywhere else, so this half is mandatory.
    const server = net.createServer(socket => socket.end());
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const loopbackPort = server.address().port;
    allowlist.ports = [loopbackPort];
    const second = installGuard(allowlist);
    try {
        report.loopback = await probe('127.0.0.1', loopbackPort);
    } finally {
        second.uninstall();
        server.close();
    }
    report.loopback.port = loopbackPort;
    if (report.loopback.connected !== true) {
        report.problems.push(`the guard blocked a LOOPBACK connect to 127.0.0.1:${loopbackPort} (${report.loopback.reason}), so a private run would fail for the wrong reason`);
    }

    // (3) THE FIRST CANARY'S ATTEMPT MUST BE IN THE RECORD. A guard that silently allows a call to pass through
    //     unrecorded is the failure mode rule 14 describes; the recording is what makes an escape visible.
    if (report.canary.attemptsRecorded === 0) {
        report.problems.push('the guard recorded no attempt for the outside canary, so an escaping connect would be invisible');
    }

    report.guardInForce = report.canary.connected === false && report.canary.reason === 'EGRESS_BLOCKED';
    report.loopbackPermitted = report.loopback.connected === true;
    report.verdict = report.problems.length === 0 && report.guardInForce && report.loopbackPermitted ? 'PASS' : 'FAIL';

    const text = `${JSON.stringify(report, null, 2)}\n`;
    if (reportPath) await fs.writeFile(reportPath, text);
    process.stdout.write(text);
    process.exit(report.verdict === 'PASS' ? 0 : 1);
}

main().catch(error => {
    process.stdout.write(`${JSON.stringify({ step: 'private-egress-check', verdict: 'FAIL', error: String(error?.message ?? error) }, null, 2)}\n`);
    process.exit(1);
});
