// THE NETWORK HALF OF THE STREAMING SURFACE (Q19), WITHOUT A LIVE NETWORK.
//
// WHAT WAS ALREADY PROVEN, and what it could not reach. `compare-streaming-legs.mjs` compares, on both
// subjects, the provider request bytes, the final text, the frames the peer wrote and the render
// snapshots the page produced; 15 committed `streaming-<source>-comparison.json` artefacts carry that
// verdict, and each records 14 paced frames with matching render ticks on both legs. Every one of those
// observations is taken with the page talking DIRECTLY to an in-process peer on loopback, in one unbroken
// connection, over plain HTTP. The matrix row's own gap was therefore exactly right: what was never
// observed is the NETWORK.
//
// This module is a real TCP hop between a subject and its peer, in the modes that can be built without a
// live network:
//
//   pass-through  relay each upstream chunk as it arrives. The CONTROL: it proves the other modes did
//                 something, and it is the shape the committed artefacts already record.
//   cut           relay `cutAfterBytes` of the upstream body, then close BOTH sockets mid-stream. The peer
//                 stays healthy and finishes its script; what dies is the middle. This is the row's
//                 "mid-stream close", minus TLS.
//
// WHY THE `buffer` MODE WAS REMOVED, stated rather than hidden, because the first run of this lane
// measured it and the measurement is the finding. A hop that holds the WHOLE body and releases it in one
// write does not slow a streaming server down at all: in one release the page reads the whole body, the
// pinned SSE reader yields every frame in that same tick, and incremental render is lost on BOTH subjects
// for reasons that have nothing to do with either server's flushing. Measured, run 40299346339: through
// that hop GoTavern rendered 2 content states and pinned 1. What discriminated there was the browser's
// commit schedule, not the subject. A single release therefore cannot support a claim about a server's
// flushing (and a CONCURRENT observer of the subject's response socket, which is the only thing that
// could observe a flush arriving, is not reachable from this harness); the mode was deleted rather than
// dressed up. What a hop CAN measure is the middle: a cut, and the identity of the request bytes.
//
// THE EXACT-TEXT REQUIREMENT. A mid-stream cut must leave the page holding exactly the frames that
// arrived. Body framing decides whether that is even possible: with `content-length` or a well-formed
// chunked body an HTTP/1.1 reader cannot tell a cut from a clean end (both simply stop delivering
// chunks), but gzip CAN be made to say so -- a single gzip member whose last deflate block is written
// with Z_FINISH carries a trailer only when the producer really finished. So the `cut` mode re-frames the
// body as a single gzip member with a SYNC-FLUSHED block per frame and a Z_FINISHED block at the end, and
// a cut stream then ends in a decompression ERROR, which is what a real middlebox cut looks like to the
// browser (`DecompressionStream` rejects) and to node (`Z_BUF_ERROR` / `Z_DATA_ERROR`). Measured with
// node 24.19.0 before this file was written: the cut decodes to EXACTLY the partial text, and both
// decompressors report an error rather than a clean end.
//
// WHY A PROXY AND NOT A MUTATED PEER. A peer that stopped writing would be a test of the PEER's script;
// with a hop in front, both subjects cross the SAME hop with the SAME settings, so the comparison is
// about the subjects.
//
// NO LIVE NETWORK (AGENTS.md doctrine rule 6). The hop listens on 127.0.0.1 and connects only to a
// loopback upstream; `startStreamingHop` REFUSES a non-loopback host, so it cannot be aimed at a hostname
// even by a future caller.

import { createHash } from 'node:crypto';
import http from 'node:http';
import zlib from 'node:zlib';

export const HOP_MODES = {
    /** Relay each upstream chunk as it arrives: the control. */
    PASS_THROUGH: 'pass-through',
    /** Relay `cutAfterBytes` of the upstream body, then close both sockets mid-stream. */
    CUT: 'cut',
    /**
     * Write the status line and the headers, then close BOTH sockets before any body byte: the fault a middle
     * produces when the connection dies after the response has begun. The subject sees a 200 with no body and a
     * closed stream, which is the case the frontend's own error path is written for.
     *
     * WHY THIS MODE EXISTS. A cut INSIDE a record -- what `CUT` does -- lands before either frontend has a
     * streamingProcessor, so NEITHER subject reaches its error path and both are left with the stop button up:
     * measured, run 40322630841, identical on both subjects, with zero content states. That is parity of a
     * hairpin, not "the same truncation and the same partial text", and there is no partial text to compare.
     * A cut at the head of the body is the earliest point at which a reader has a RESPONSE to fail on.
     */
    CUT_AT_HEAD: 'cut-at-head',
};

/** Only a loopback upstream is allowed: a hop that can be aimed at a host is an egress path. */
export function assertLoopbackHost(host, what) {
    const normalised = String(host ?? '').toLowerCase().replace(/^\[|\]$/g, '');
    const allowed = normalised === '127.0.0.1' || normalised === 'localhost' || normalised === '::1';
    if (!allowed) {
        throw new Error(`${what} must be loopback, got ${JSON.stringify(host)}: a probe may not open an egress path (AGENTS.md doctrine rule 6)`);
    }
}

/** Frame terminators in a piece of text. The peer's payloads are single-line JSON, so a blank line is a
 *  frame boundary, which is the same rule the pinned frontend's SSE reader applies (sse-stream.js). */
export function countFrames(text) {
    const matches = String(text).match(/\n\n/g);
    return matches ? matches.length : 0;
}

/**
 * Starts the framing hop in front of `upstream` (a `{host, port}` loopback pair).
 *
 * The request side is byte-faithful: method, target, the framing headers and every body byte are
 * forwarded, and recorded, so "the peer saw identical request bytes" is asserted from what actually left
 * the hop rather than from what the subject meant to send.
 */
export function startStreamingHop({ upstream, mode, cutAfterBytes = 0, cutArmOnPath = null }) {
    assertLoopbackHost(upstream?.host, 'the hop upstream');
    if (!Object.values(HOP_MODES).includes(mode)) {
        throw new Error(`unknown hop mode ${JSON.stringify(mode)}; expected one of ${Object.values(HOP_MODES).join(', ')}`);
    }
    const state = {
        mode,
        cutAfterBytes,
        cutArmOnPath,
        // Body writes the hop issued DOWNSTREAM, in order: {bytes, frames}. The cut mode's writers are
        // gzip members, so `frames` there counts the SSE terminators of the PLAINTEXT the hop consumed,
        // which is the frame count a reader of the artefact wants.
        writes: [],
        releasedBytes: 0,
        // Set when the hop cut: the reason, by name, so a cut that did not happen is distinguishable from
        // one that did (and a peer that finished before the cut point is recorded as `completed`).
        cut: null,
        anyCut: null,
        cutsPerformed: 0,
        completed: false,
        forwarded: [],
        requestsSeen: 0,
        upstreamErrors: [],
        // The gzip framing is part of the claim, so it is recorded rather than implied.
        reframedAsGzip: false,
        // Set per RESPONSE on the data path, never at request time: see the note beside isEventStream.
        gzipFramedResponses: 0,
    };

    const server = http.createServer((clientRequest, clientResponse) => {
        state.requestsSeen += 1;
        const bodyChunks = [];
        clientRequest.on('data', chunk => bodyChunks.push(chunk));
        clientRequest.on('end', () => {
            const body = Buffer.concat(bodyChunks);
            const forwardedHeaders = { ...clientRequest.headers };
            // The upstream leg is a fresh connection: `host` must name it, and `connection` describes the
            // client-to-hop hop rather than the hop-to-peer hop.
            forwardedHeaders.host = `${upstream.host}:${upstream.port}`;
            delete forwardedHeaders.connection;

            state.forwarded.push({
                method: clientRequest.method,
                path: clientRequest.url,
                // Header NAMES only, plus the framing values and a presence bit for the credential: an
                // artefact must never carry an authorization value, even a synthetic one.
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
                // THE RE-FRAMING DECISION IS PER RESPONSE, TAKEN HERE AND ONLY HERE. A body is re-framed as
                // ONE gzip member when it is an SSE stream AND this response is the one the cut is armed
                // on: the gzip exists so a decoder can see that the body was cut, and re-encoding a JSON
                // body would only make the hop's own work harder. Measured on this lane twice before it was
                // right: the first cut landed on the reachability check (GET /models, JSON), and the second
                // re-framed a JSON body the cut itself had left alone -- `gzipFramedResponses` was zero on
                // both subjects and the guard said so.
                const isEventStream = String(upstreamResponse.headers['content-type'] ?? '').toLowerCase().includes('text/event-stream');
                const pathMatches = cutAfterPathMatches(clientRequest.url, cutArmOnPath);
                // A HEAD CUT HAS NO BODY TO RE-FRAME: the gzip member exists so a decoder can SEE a truncated body,
                // and at the head there is no body at all. Recorded as 0 re-framed responses, which is the fact.
                state.reframedAsGzip = mode === HOP_MODES.CUT && pathMatches && isEventStream;
                state.headCutResponses = (state.headCutResponses ?? 0) + (mode === HOP_MODES.CUT_AT_HEAD && pathMatches && isEventStream ? 1 : 0);
                // THE HEAD-ONLY CUT: the status line and the headers go out, then BOTH sockets die before a body
                // byte. `cutNow` is defined below, so this branch re-uses it through a local holder that is
                // assigned in the same order the original code did -- the effect is that the subject sees a 200
                // with a closed body, which is the earliest point a reader has a response to fail on.
                const headOnlyCut = mode === HOP_MODES.CUT_AT_HEAD && pathMatches && isEventStream;
                // THE HEADERS TRAVEL UNCHANGED, except the framing THIS hop owns: it re-chunks the body, and
                // in cut mode it re-frames it as gzip, so the upstream content-length, content-encoding and
                // transfer-encoding would all describe bytes the downstream reader will not see.
                const responseHeaders = {};
                for (const [name, value] of Object.entries(upstreamResponse.headers)) {
                    const lower = name.toLowerCase();
                    if (lower === 'content-length' || lower === 'transfer-encoding' || lower === 'connection') continue;
                    if (state.reframedAsGzip && lower === 'content-encoding') continue;
                    responseHeaders[name] = value;
                }
                if (state.reframedAsGzip) {
                    responseHeaders['content-encoding'] = 'gzip';
                    state.gzipFramedResponses += 1;
                }
                clientResponse.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
                // Headers go out immediately so the subject sees a 200 and starts reading. Only body
                // writes are recorded, so an artefact never counts a header flush as a body frame.
                clientResponse.flushHeaders();

                // ---- the downstream wire, per mode ---------------------------------------------------
                let gzip = null;
                if (state.reframedAsGzip) {
                    // A SYNC FLUSH on every write means the bytes for that frame are emitted now, so the
                    // hop is transparent in time (a buffering hop would hide a server's flushing, which is
                    // the very thing this lane must not do); the Z_FINISH at the end is the only thing
                    // that makes the member complete, so a cut is detectable as a decode error.
                    gzip = zlib.createGzip({ flush: zlib.constants.Z_SYNC_FLUSH, finishFlush: zlib.constants.Z_FINISH });
                    gzip.on('data', piece => {
                        // A PIECE THAT ARRIVES AFTER THE CUT IS NOT RELAYED, and it must not be counted
                        // either: measured twice (runs 40314154794, 40316734219), the gzip flush that
                        // `gzip.destroy()` triggers fired AFTER `cutNow` and wrote to a closed response,
                        // so `releasedBytes` kept growing past the cut and the artefact reported a
                        // different cut point than the one the page had seen.
                        if (state.cut) {
                            return;
                        }
                        clientResponse.write(piece);
                        state.releasedBytes += piece.length;
                        // The compressed piece's own length is what crossed the wire; the FRAME count is
                        // the plaintext's, recorded by the caller of `emit`.
                        state.writes.push({ wireBytes: piece.length, frames: 0, source: 'gzip-member-piece' });
                    });
                    gzip.on('error', error => {
                        state.upstreamErrors.push(`gzip: ${String(error?.message ?? error)}`);
                    });
                }

                const emitPlain = (buffer, frames, label) => {
                    if (buffer.length === 0) {
                        return;
                    }
                    if (gzip) {
                        gzip.write(buffer);
                        // One entry per plaintext write, carrying the frame count, so the artefact says
                        // how many SSE frames the hop relayed without depending on how libz batched them.
                        state.writes.push({ bytes: buffer.length, frames, source: label });
                        return;
                    }
                    clientResponse.write(buffer);
                    state.releasedBytes += buffer.length;
                    state.writes.push({ bytes: buffer.length, frames, source: label });
                };
                const finishCleanly = () => {
                    if (state.cut) {
                        return;
                    }
                    if (gzip) {
                        gzip.end();
                    }
                    clientResponse.end();
                };
                const cutNow = reason => {
                    if (state.cut) {
                        return;
                    }
                    state.cut = reason;
                    // THE RECORD IS DUPLICATED WHERE NOTHING LATER CAN CLEAR IT. `cut` belongs to the
                    // REQUEST being served, but the probe reports one flat record, and a later request on
                    // the same connection (`/api/ping`) reset it: two runs in a row reported `cut: null`
                    // beside `releasedBytes: 533`, a recording contradicting itself. `anyCut` is the durable
                    // fact -- a cut happened to THIS hop -- and the probe reports both.
                    state.anyCut = reason;
                    state.cutsPerformed = (state.cutsPerformed ?? 0) + 1;
                    // BOTH DIRECTIONS DIE. The subject sees a body that ended mid-frame with the
                    // connection closed; the peer is released rather than left holding a script. In gzip
                    // mode the trailer is never produced, so the subject's decompressor rejects -- which
                    // is what a real middlebox cut looks like.
                    if (gzip) {
                        gzip.destroy();
                    }
                    clientResponse.destroy();
                    upstreamResponse.destroy();
                };

                // THE CUT IS ARMED ON THE NAMED ROUTE, and `pathMatches` was resolved with the gzip decision
                // above so ONE expression decides both. A hop that cut the FIRST response would truncate the
                // frontend's own reachability check (GET /models) and the subject would never reach a
                // connected state -- measured: the first draft armed every response, both subjects ended
                // with `in flight: 1` and no stream at all, and the surface proved nothing about truncation.
                const armed = (mode === HOP_MODES.CUT || mode === HOP_MODES.CUT_AT_HEAD) && pathMatches && isEventStream;
                state.cutArmedResponses = (state.cutArmedResponses ?? 0) + (armed ? 1 : 0);

                // THE HEAD-ONLY CUT ACTS BEFORE ANY BODY BYTE. The status line and headers were written
                // above; nothing of the body is relayed, `releasedBytes` stays 0, and both ends die. A reader
                // that sees 0 released bytes must conclude "the body never started", not "the hop failed".
                //
                // MEASURED, run 40324760750: the first version of this branch cut AFTER subscribing to
                // `data`, so the gzip header write (169 B) had already reached the page and `releasedBytes`
                // was 169 -- a body that started. The subscription is now installed only on the path that
                // relays, so "head" means the page got a response and no body at all.
                if (headOnlyCut) {
                    cutNow('cut-at-head');
                    return;
                }
                state.relayedWholeResponses = (state.relayedWholeResponses ?? 0) + (armed ? 0 : 1);
                let released = 0;
                upstreamResponse.on('data', chunk => {
                    if (state.cut) {
                        return;
                    }
                    if (!armed) {
                        emitPlain(chunk, countFrames(chunk.toString('utf8')), 'relayed-chunk');
                        return;
                    }
                    // THE LIMIT IS A PLAINTEXT OFFSET AND MUST BE COUNTED IN PLAINTEXT BYTES. `released` is
                    // advanced by the plaintext slice handed to `emitPlain`, never by the compressed bytes that
                    // crossed the wire: measured, run 40320603310, where `releasedBytes` reached 533 against a
                    // 513-byte limit and the cut never fired because the two counters measure different things.
                    const room = cutAfterBytes > 0 ? cutAfterBytes - released : chunk.length;
                    if (room <= 0) {
                        cutNow('cut-after-bytes');
                        return;
                    }
                    const slice = chunk.subarray(0, Math.min(room, chunk.length));
                    emitPlain(slice, countFrames(slice.toString('utf8')), 'relay-before-cut');
                    released += slice.length;
                    if (cutAfterBytes > 0 && released >= cutAfterBytes) {
                        cutNow('cut-after-bytes');
                    }
                });
                upstreamResponse.on('end', () => {
                    if (state.cut) {
                        return;
                    }
                    // A peer that finished before the cut point: recorded, because a cut that never
                    // happened would otherwise be read as a truncation the subject produced.
                    state.completed = true;
                    finishCleanly();
                });
                upstreamResponse.on('error', error => {
                    state.upstreamErrors.push(String(error?.message ?? error));
                    cutNow('upstream-error');
                });
                // A STREAM THE SUBJECT WALKS AWAY FROM IS NOT THE NETWORK DYING. When the caller closes
                // its end (cancellation), the hop must stop writing -- but it must NOT report a cut, or
                // the abort surface would be indistinguishable from the cancel surface.
                clientResponse.on('close', () => {
                    if (!clientResponse.writableFinished && !state.cut) {
                        state.callerClosed = true;
                    }
                    if (gzip) {
                        gzip.destroy();
                    }
                    upstreamResponse.destroy();
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

function cutAfterPathMatches(requestUrl, cutArmOnPath) {
    return cutArmOnPath === null || String(requestUrl ?? '').includes(cutArmOnPath);
}

/** True when the primary content type of an upstream response is an SSE stream: the only body the cut
 *  mode re-frames, because the re-framing exists to make a truncation detectable by the SSE reader. */
export function isEventStream(contentType) {
    return String(contentType ?? '').toLowerCase().includes('text/event-stream');
}
