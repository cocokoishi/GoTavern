// THE NETWORK HALF OF THE STREAMING SURFACE (Q19), WITHOUT A LIVE NETWORK.
//
// WHAT WAS ALREADY PROVEN, and what it could not reach. `compare-streaming-legs.mjs` compares, on both
// subjects, the provider request bytes, the final text, the frames the peer wrote and the render
// snapshots the page produced; 15 committed `streaming-<source>-comparison.json` artefacts carry that
// verdict, and `streaming-comparison.json` records 14 paced frames with 15 render ticks per leg. Every
// one of those observations is taken with the page talking DIRECTLY to an in-process peer on loopback,
// in one unbroken connection, over plain HTTP. So the matrix row's own gap is exactly right: what was
// never observed is the NETWORK -- real chunk boundaries, a proxy that buffers, a middle that dies.
//
// This module adds the two pieces that can be closed without a live network:
//
//   1. A BUFFERING PROXY between the subject and the peer. It is a real TCP hop with its own framing:
//      it reads the upstream body and holds every byte until the upstream stream ENDS, then writes to
//      the downstream socket in ONE piece. A subject that flushes per chunk therefore renders frame by
//      frame THROUGH the proxy; a subject that assembled the reply before answering shows up as a
//      single render state after the proxy released everything, because the proxy physically did not
//      hand it anything earlier. That is a measured property of the hop rather than an assertion about
//      the server.
//
//   2. A CUTTING PROXY, i.e. the same hop in a mode that releases N bytes of the upstream body and then
//      closes BOTH sockets mid-frame. The peer stays healthy and scripted; what dies is the network in
//      the middle. That is the row's "mid-stream close", minus TLS.
//
// WHY A PROXY AND NOT A MUTATED PEER. A peer that stopped writing would be a test of the PEER's script:
// both subjects would see the same artificial thing and nothing would be learned about the hop. The
// proxy is a real middle with its own buffering and its own close, driven with the SAME settings on both
// subjects, so the comparison is about the subjects.
//
// NO LIVE NETWORK (AGENTS.md doctrine rule 6). The proxy listens on 127.0.0.1 and connects only to a
// loopback upstream; `startStreamingProxy` REFUSES a non-loopback host, so it cannot be aimed at a
// hostname even by a future caller.
//
// HOW A CHUNK BOUNDARY IS PROVEN RATHER THAN ASSUMED. Every body write the proxy issues downstream is
// recorded as {bytes, frames}, where `frames` counts frame terminators. `buffer` mode must show ONE body
// write; `pass-through` must show MORE THAN ONE, and the two must sum to the same bytes. Without those
// two facts side by side, "the proxy buffered" and "the proxy relayed instantly" are the same artefact.

import { createHash } from 'node:crypto';
import http from 'node:http';

export const PROXY_MODES = {
    /** Read the whole upstream body, then hand it downstream in ONE write. */
    BUFFER: 'buffer',
    /** Relay each upstream chunk as it arrives: the control that proves the buffering mode did something. */
    PASS_THROUGH: 'pass-through',
    /** Release `cutAfterBytes` of the upstream body, then close both sockets mid-stream. */
    CUT: 'cut',
};

/** Only a loopback upstream is allowed: a proxy that can be aimed at a host is an egress path. */
export function assertLoopbackHost(host, what) {
    const normalised = String(host ?? '').toLowerCase().replace(/^\[|\]$/g, '');
    const allowed = normalised === '127.0.0.1' || normalised === 'localhost' || normalised === '::1';
    if (!allowed) {
        throw new Error(`${what} must be loopback, got ${JSON.stringify(host)}: a probe may not open an egress path (AGENTS.md doctrine rule 6)`);
    }
}

/** Frame terminators in a piece of text. The peer's payloads are single-line JSON, so a blank line is a
 *  frame boundary, which is the same rule the pinned frontend's SSE reader applies. */
export function countFrames(text) {
    const matches = String(text).match(/\n\n/g);
    return matches ? matches.length : 0;
}

/**
 * Starts a framing proxy in front of `upstream` (a `{host, port}` loopback pair).
 *
 * The request side is byte-faithful: method, target, the framing headers and every body byte are
 * forwarded, and recorded, so "the peer saw identical request bytes" can be asserted from what actually
 * left the proxy rather than from what the subject meant to send.
 */
export function startStreamingProxy({ upstream, mode, cutAfterBytes = 0 }) {
    assertLoopbackHost(upstream?.host, 'the proxy upstream');
    if (!Object.values(PROXY_MODES).includes(mode)) {
        throw new Error(`unknown proxy mode ${JSON.stringify(mode)}; expected one of ${Object.values(PROXY_MODES).join(', ')}`);
    }
    const state = {
        mode,
        cutAfterBytes,
        // Body writes the proxy issued DOWNSTREAM, in order: {bytes, frames}. A zero-byte entry is a
        // release of nothing (an empty upstream body), recorded so the count is never silently zero.
        writes: [],
        releasedBytes: 0,
        // Set when the proxy cut or the upstream died: the reason, by name, so a truncation that did not
        // happen is distinguishable from one that did.
        cut: null,
        forwarded: [],
        requestsSeen: 0,
        upstreamErrors: [],
    };

    const server = http.createServer((clientRequest, clientResponse) => {
        state.requestsSeen += 1;
        const bodyChunks = [];
        clientRequest.on('data', chunk => bodyChunks.push(chunk));
        clientRequest.on('end', () => {
            const body = Buffer.concat(bodyChunks);
            const forwardedHeaders = { ...clientRequest.headers };
            // The upstream leg is a fresh connection: `host` must name it, and `connection` describes the
            // client-to-proxy hop rather than the proxy-to-peer hop.
            forwardedHeaders.host = `${upstream.host}:${upstream.port}`;
            delete forwardedHeaders.connection;

            state.forwarded.push({
                method: clientRequest.method,
                path: clientRequest.url,
                // Header NAMES only, plus the two framing values and a presence bit for the credential:
                // an artefact must never carry an authorization value, even a synthetic one.
                headerNames: Object.keys(clientRequest.headers).sort(),
                authorizationPresent: typeof clientRequest.headers.authorization === 'string' && clientRequest.headers.authorization.length > 0,
                contentLength: clientRequest.headers['content-length'] ?? null,
                transferEncoding: clientRequest.headers['transfer-encoding'] ?? null,
                bodyBytes: body.length,
                bodySha256: createHash('sha256').update(body).digest('hex'),
            });

            const upstreamRequest = http.request({
                host: upstream.host,
                port: upstream.port,
                method: clientRequest.method,
                path: clientRequest.url,
                headers: forwardedHeaders,
            }, upstreamResponse => {
                // The status and the headers travel unchanged, except the framing THIS hop owns: the
                // downstream response is chunked by node, so an upstream content-length would describe
                // bytes the proxy may hold back or cut.
                const responseHeaders = {};
                for (const [name, value] of Object.entries(upstreamResponse.headers)) {
                    const lower = name.toLowerCase();
                    if (lower === 'content-length' || lower === 'transfer-encoding' || lower === 'connection') continue;
                    responseHeaders[name] = value;
                }
                clientResponse.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
                // Headers go out immediately so the subject sees a 200 and starts reading. Only the BODY
                // is what this proxy controls, and only body writes are recorded.
                clientResponse.flushHeaders();

                const release = (buffer, label) => {
                    if (buffer.length === 0) {
                        return;
                    }
                    clientResponse.write(buffer);
                    state.releasedBytes += buffer.length;
                    state.writes.push({ bytes: buffer.length, frames: countFrames(buffer.toString('utf8')), source: label });
                };
                const cutNow = reason => {
                    if (state.cut) {
                        return;
                    }
                    state.cut = reason;
                    // Both directions die: the subject sees a body that ended mid-frame with the
                    // connection closed, and the peer is released rather than left holding a script.
                    clientResponse.destroy();
                    upstreamResponse.destroy();
                };

                if (mode === PROXY_MODES.BUFFER) {
                    const held = [];
                    upstreamResponse.on('data', chunk => held.push(chunk));
                    upstreamResponse.on('end', () => {
                        release(Buffer.concat(held), 'buffered-body');
                        clientResponse.end();
                    });
                    upstreamResponse.on('error', error => {
                        state.upstreamErrors.push(String(error?.message ?? error));
                        cutNow('upstream-error');
                    });
                    return;
                }

                if (mode === PROXY_MODES.CUT) {
                    let released = 0;
                    upstreamResponse.on('data', chunk => {
                        if (state.cut) {
                            return;
                        }
                        const room = cutAfterBytes > 0 ? cutAfterBytes - released : chunk.length;
                        if (room <= 0) {
                            cutNow('cut-after-bytes');
                            return;
                        }
                        const slice = chunk.subarray(0, Math.min(room, chunk.length));
                        released += slice.length;
                        release(slice, 'relay-before-cut');
                        if (cutAfterBytes > 0 && released >= cutAfterBytes) {
                            cutNow('cut-after-bytes');
                        }
                    });
                    upstreamResponse.on('end', () => {
                        if (!state.cut) {
                            // The peer finished before the cut point: recorded, because a cut that never
                            // happened would otherwise look like a truncation the subject produced.
                            state.cut = null;
                            state.completedBeforeCut = true;
                            clientResponse.end();
                        }
                    });
                    upstreamResponse.on('error', error => {
                        state.upstreamErrors.push(String(error?.message ?? error));
                        cutNow('upstream-error');
                    });
                    return;
                }

                // PASS_THROUGH: one downstream write per upstream chunk.
                upstreamResponse.on('data', chunk => release(chunk, 'relayed-chunk'));
                upstreamResponse.on('end', () => clientResponse.end());
                upstreamResponse.on('error', error => {
                    state.upstreamErrors.push(String(error?.message ?? error));
                    cutNow('upstream-error');
                });
            });

            upstreamRequest.on('error', error => {
                state.upstreamErrors.push(String(error?.message ?? error));
                if (!clientResponse.headersSent) {
                    clientResponse.writeHead(502, { 'content-type': 'text/plain' });
                }
                clientResponse.end('upstream error');
            });
            upstreamRequest.end(body);
        });
    });

    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            resolve({
                port,
                address: `127.0.0.1:${port}`,
                state,
                close: () => new Promise(done => {
                    server.closeAllConnections?.();
                    server.close(() => done());
                }),
            });
        });
    });
}

/**
 * Splits a host:port string into a loopback upstream pair, refusing anything else. The probe's peer
 * reports `127.0.0.1:<port>`; this is the one conversion point, so no caller invents a host.
 */
export function loopbackUpstream(address) {
    const match = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(String(address ?? ''));
    if (!match) {
        throw new Error(`cannot parse a loopback address from ${JSON.stringify(address)}`);
    }
    const host = match[1].replace(/^\[|\]$/g, '');
    assertLoopbackHost(host, 'the peer address');
    return { host, port: Number(match[2]) };
}
