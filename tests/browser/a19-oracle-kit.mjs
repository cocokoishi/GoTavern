// a19-oracle-kit.mjs -- the reusable half of the alpha.19 LIVE ORACLE (the GoTavern leg + the
// differential), not of the corpus builder.
//
// WHY A KIT. The live oracle must boot two subjects over two COPIES of the same immutable corpus,
// record the same five observable layers for both, and judge them with a comparator whose normalisation
// table is explicit. Copy/census, the provider wire peer, and the report writer are used by ALL legs and
// by the teeth; a second copy of any of them is a second place the two legs could be driven differently,
// which is the one property the comparison cannot survive.
//
// WHAT IT DOES NOT OWN. The corpus is produced by Subagent A (a19-corpus-builder.mjs); the browser
// journey belongs to A's a19-journey-probe.mjs. This kit NEVER writes product files and NEVER defines an
// expected provider body: the peer records and answers, the corpus manifest is the persistence baseline,
// and every expectation comes from pinned's own leg at the same phase.
//
// SHARING RULES APPLIED (AGENTS differential doctrine 3): process lifecycle, port/tree allocation,
// corpus census, HTTP/provider-wire recording, report-writing and impact selection are shared between the
// two subjects; the EXPECTED provider body, response mapping, message transform and status/error shape
// are NOT here -- they are observed from the pinned leg and compared, never asserted in this file.

import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import http from 'node:http';
import path from 'node:path';

export function sha256(value) {
    return createHash('sha256').update(value).digest('hex');
}

export async function writeJson(file, value) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    // fs.writeFile writes UTF-8 without a BOM by default (AGENTS verification rule 12).
    await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export async function readJson(file) {
    return JSON.parse(await fs.readFile(file, 'utf8'));
}

// ---------------------------------------------------------------------------------------------------------------
// THE IMMUTABLE CORPUS: census, verified copy, and the post-run proof that the originals did not move.
// ---------------------------------------------------------------------------------------------------------------

/**
 * Every file under `root`, relative forward-slash path -> sha256/bytes, plus a tree digest over the same
 * sorted `<sha256>  <path>` lines the long-lived corpus uses, so two censuses are comparable and a copy's
 * identity is a measurement rather than a promise.
 */
export async function censusTree(root, { excludePaths = [] } = {}) {
    const excluded = new Set(excludePaths);
    const files = [];
    const walk = async directory => {
        let entries;
        try {
            entries = await fs.readdir(directory, { withFileTypes: true });
        } catch (error) {
            if (error.code === 'ENOENT') return;
            throw error;
        }
        for (const entry of entries) {
            const full = path.join(directory, entry.name);
            if (entry.isDirectory()) await walk(full);
            else if (entry.isFile()) {
                // A CENSUS MUST NOT TAKE A SNAPSHOT MID-WRITE. Both subjects write state with a temp-file + atomic
                // rename (pinned writes settings.json.<random> then renames), so a file listed by readdir can vanish
                // between the listing and the read. Measured self-check run10: pinned's restart leg died with
                // ENOENT on default-user/settings.json.<temp>. A bounded retry distinguishes that transient window
                // from a file that is really gone (which is still a fact, and the driver diffs the census).
                let body = null;
                for (let attempt = 0; attempt < 5; attempt += 1) {
                    try {
                        body = await fs.readFile(full);
                        break;
                    } catch (error) {
                        if (error.code !== 'ENOENT') throw error;
                        await new Promise(resolve => setTimeout(resolve, 20));
                    }
                }
                if (body === null) continue;
                files.push({
                    path: path.relative(root, full).split(path.sep).join('/'),
                    bytes: body.length,
                    sha256: sha256(body),
                });
            }
        }
    };
    await walk(root);
    files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
    // THE TREE DIGEST EXCLUDES A ROOT `manifest.json`, which is the corpus's own governance document and
    // would make the identity self-referential (docs/longlived-corpus.md §1). `files`/`bytes` are the
    // counted inventory; the digest is over the counted inventory minus the declared exclusions.
    const digested = files.filter(file => !excluded.has(file.path));
    const lines = digested.map(file => `${file.sha256}  ${file.path}`).join('\n');
    const digestedBytes = digested.reduce((sum, file) => sum + file.bytes, 0);
    return {
        root,
        files,
        fileCount: files.length,
        bytes: files.reduce((sum, file) => sum + file.bytes, 0),
        digestedFileCount: digested.length,
        digestedBytes,
        digestExcludes: [...excluded].sort(),
        treeSha256: sha256(lines),
    };
}

/**
 * Copy the corpus ONCE per subject and prove the copy is byte-identical to the source census.
 *
 * The source is never booted and never written (AGENTS hard rules 14/51: copy migration source is
 * read-only; a corpus is an input, not a runtime tree). A copy whose digest differs from the source
 * census is refused by name instead of being driven, because a differential over two amber trees is not
 * a differential.
 */
export async function copyCorpusVerified(source, target, sourceCensus) {
    await fs.rm(target, { recursive: true, force: true });
    await fs.cp(source, target, { recursive: true });
    const copyCensus = await censusTree(target);
    const problems = [];
    if (copyCensus.fileCount !== sourceCensus.fileCount) {
        problems.push(`file count ${copyCensus.fileCount} != source ${sourceCensus.fileCount}`);
    }
    if (copyCensus.bytes !== sourceCensus.bytes) problems.push(`bytes ${copyCensus.bytes} != source ${sourceCensus.bytes}`);
    if (copyCensus.treeSha256 !== sourceCensus.treeSha256) problems.push(`tree sha256 ${copyCensus.treeSha256} != source ${sourceCensus.treeSha256}`);
    if (problems.length > 0) {
        throw new Error(`the corpus copy at ${target} is not byte-identical to the immutable input: ${problems.join('; ')}`);
    }
    return copyCensus;
}

/**
 * After the journey, re-census the ORIGINAL corpus. A journey that mutated the input is a harness defect
 * first (the subject was handed the wrong root) and a data-loss finding second; the caller records this
 * as a named guard rather than assuming either.
 */
export async function assertOriginalUnchanged(censusBefore, root) {
    const after = await censusTree(root);
    const problems = [];
    if (after.treeSha256 !== censusBefore.treeSha256) problems.push(`tree sha256 changed: ${censusBefore.treeSha256} -> ${after.treeSha256}`);
    if (after.fileCount !== censusBefore.fileCount) problems.push(`file count changed: ${censusBefore.fileCount} -> ${after.fileCount}`);
    if (after.bytes !== censusBefore.bytes) problems.push(`bytes changed: ${censusBefore.bytes} -> ${after.bytes}`);
    return { ok: problems.length === 0, problems, before: { treeSha256: censusBefore.treeSha256, fileCount: censusBefore.fileCount, bytes: censusBefore.bytes }, after: { treeSha256: after.treeSha256, fileCount: after.fileCount, bytes: after.bytes } };
}

/** Compare two censuses and name every difference, rather than returning a boolean. */
export function censusDiff(before, after) {
    const beforeByPath = new Map(before.files.map(file => [file.path, file]));
    const afterByPath = new Map(after.files.map(file => [file.path, file]));
    const created = [];
    const modified = [];
    const deleted = [];
    for (const [filePath, file] of afterByPath) {
        const previous = beforeByPath.get(filePath);
        if (!previous) created.push({ path: filePath, bytes: file.bytes, sha256: file.sha256 });
        else if (previous.sha256 !== file.sha256 || previous.bytes !== file.bytes) modified.push({ path: filePath, bytes: file.bytes, sha256: file.sha256, previousSha256: previous.sha256 });
    }
    for (const [filePath, file] of beforeByPath) {
        if (!afterByPath.has(filePath)) deleted.push({ path: filePath, bytes: file.bytes, sha256: file.sha256 });
    }
    return { created, modified, deleted };
}

// ---------------------------------------------------------------------------------------------------------------
// THE PROVIDER WIRE PEER: raw request bytes, raw header order/casing, and what it actually served.
// ---------------------------------------------------------------------------------------------------------------

/**
 * The recording peer for the live oracle. It DEFINES NOTHING (AGENTS 49): replies are markers stamped with
 * the subject's own prefix, so the two subjects are provably fed different bytes and can still be compared
 * on the requests they produced (rule 50). The response format is a FUNCTION of what the request asked for
 * (SSE for `stream: true`, JSON otherwise), and every response records `served` so a leg whose page
 * streamed against a JSON peer is visible as such instead of silently storing an empty reply.
 *
 * RECORDED PER REQUEST, BYTE-ORIENTED (AGENTS differential doctrine 2): method, the RAW request target,
 * the headers as received (name + value + arrival order, from Node's `rawHeaders`), `bodyBase64`,
 * `bodySha256`, `bodyLength`, `requestedStream`, and `served`.
 *
 * `replyPrefix` is mandatory in spirit for a two-subject differential: a peer whose replies are identical
 * for both subjects makes the equality of the requests uninteresting (the harness fed the same bytes).
 * The caller passes the subject's prefix and the comparator asserts it was APPLIED and did not reach a
 * compared request.
 */
export function startWirePeer({ replyPrefix = '', wire = 'honour', replyText = null } = {}) {
    const requests = [];
    let replyIndex = 0;
    const server = http.createServer((request, response) => {
        const chunks = [];
        request.on('data', chunk => chunks.push(chunk));
        request.on('end', () => {
            const body = Buffer.concat(chunks);
            if (request.method === 'OPTIONS') {
                response.writeHead(204, {
                    'access-control-allow-origin': '*',
                    'access-control-allow-headers': request.headers['access-control-request-headers'] ?? '*',
                    'access-control-allow-methods': 'GET,POST,OPTIONS',
                    'access-control-max-age': '600',
                });
                response.end();
                return;
            }
            let wantsStream = false;
            try {
                wantsStream = JSON.parse(body.toString('utf8'))?.stream === true;
            } catch {
                wantsStream = false;
            }
            const rawHeaders = [];
            for (let index = 0; index + 1 < request.rawHeaders.length; index += 2) {
                rawHeaders.push({ name: request.rawHeaders[index], value: request.rawHeaders[index + 1] });
            }
            const record = {
                index: requests.length,
                method: request.method,
                rawTarget: request.url,
                rawHeaders,
                bodyBase64: body.toString('base64'),
                bodySha256: sha256(body),
                bodyLength: body.length,
                bodyText: body.toString('utf8'),
                requestedStream: wantsStream,
                receivedAt: new Date().toISOString(),
                served: { wire: null, frames: 0, bytes: 0, terminal: false },
            };
            requests.push(record);
            const jsonHeaders = { 'content-type': 'application/json', 'access-control-allow-origin': '*' };
            if (request.method === 'GET' && /models/.test(request.url ?? '')) {
                const listing = JSON.stringify({ object: 'list', data: [{ id: 'a19-live-model', object: 'model' }] });
                record.served = { wire: 'json', frames: 0, bytes: Buffer.byteLength(listing), terminal: true };
                response.writeHead(200, jsonHeaders);
                response.end(listing);
                return;
            }
            replyIndex += 1;
            const text = String((replyText ?? (ordinal => `A19_${replyPrefix}REPLY_${ordinal}`))(replyIndex, replyIndex) ?? '');
            const labelled = replyPrefix ? `${replyPrefix}${text}` : text;
            const serveSse = wire === 'sse' || (wire === 'honour' && wantsStream);
            if (serveSse) {
                const delta = JSON.stringify({
                    id: `chatcmpl-a19-${replyIndex}`,
                    object: 'chat.completion.chunk',
                    created: 1730000000,
                    model: 'a19-live-model',
                    choices: [{ index: 0, delta: { role: 'assistant', content: labelled }, finish_reason: null }],
                });
                const stop = JSON.stringify({
                    id: `chatcmpl-a19-${replyIndex}`,
                    object: 'chat.completion.chunk',
                    created: 1730000000,
                    model: 'a19-live-model',
                    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
                });
                const payload = `data: ${delta}\n\ndata: ${stop}\n\ndata: [DONE]\n\n`;
                const frames = [delta, stop, '[DONE]'].map(frame => Buffer.byteLength(`data: ${frame}\n\n`));
                record.served = { wire: 'sse', frames: frames.length, frameBytes: frames, bytes: Buffer.byteLength(payload), terminal: true };
                response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'access-control-allow-origin': '*' });
                response.end(payload);
                return;
            }
            const payload = JSON.stringify({
                id: `chatcmpl-a19-${replyIndex}`,
                object: 'chat.completion',
                created: 1730000000,
                model: 'a19-live-model',
                choices: [{ index: 0, message: { role: 'assistant', content: labelled }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            });
            record.served = { wire: 'json', frames: 0, bytes: Buffer.byteLength(payload), terminal: true };
            response.writeHead(200, jsonHeaders);
            response.end(payload);
        });
    });
    server.keepAliveTimeout = 1000;
    return new Promise((resolve, reject) => {
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => resolve({
            port: server.address().port,
            url: `http://127.0.0.1:${server.address().port}/v1`,
            requests,
            wireMode: wire,
            replyPrefix,
            close: () => new Promise(done => server.close(done)),
        }));
    });
}

/**
 * The provider-wire layer as a comparator input. Byte-oriented: the equality decision is on `bodySha256`,
 * `bodyLength`, the raw target, the method and the raw headers; the parsed `contextShape` is a
 * MEASUREMENT for diagnosis and is never what decides equality.
 */
export function providerWireLayer(peer) {
    return {
        wireMode: peer.wireMode,
        replyPrefix: peer.replyPrefix,
        requests: peer.requests.map(record => ({
            index: record.index,
            method: record.method,
            rawTarget: record.rawTarget,
            rawHeaders: record.rawHeaders,
            bodyLength: record.bodyLength,
            bodySha256: record.bodySha256,
            bodyBase64: record.bodyBase64,
            requestedStream: record.requestedStream,
            served: record.served,
            contextShape: contextShape(record.bodyText),
        })),
    };
}

/**
 * A STRUCTURAL MEASUREMENT of a provider request body -- message count/roles/content lengths, system
 * presence, tool/reasoning/sampler/stops members. Recorded so a red says "6 vs 7 messages" instead of
 * "the bytes differ"; equality is still judged by `bodySha256` (doctrine 2 forbids canonicalising).
 */
export function contextShape(bodyText) {
    let parsed;
    try {
        parsed = JSON.parse(bodyText);
    } catch {
        return { parsable: false };
    }
    if (!parsed || typeof parsed !== 'object') return { parsable: false };
    const messages = Array.isArray(parsed.messages) ? parsed.messages : null;
    return {
        parsable: true,
        topLevelMembers: Object.keys(parsed).sort(),
        model: typeof parsed.model === 'string' ? parsed.model : null,
        stream: parsed.stream === true,
        messageCount: messages ? messages.length : null,
        messages: messages ? messages.map(message => ({
            role: message?.role ?? null,
            contentLength: typeof message?.content === 'string' ? message.content.length : null,
            contentSha256: typeof message?.content === 'string' ? sha256(Buffer.from(message.content, 'utf8')) : null,
            hasName: Object.prototype.hasOwnProperty.call(message ?? {}, 'name'),
        })) : null,
        systemPresent: messages ? messages.some(message => message?.role === 'system') : null,
        toolsCount: Array.isArray(parsed.tools) ? parsed.tools.length : null,
        stopCount: Array.isArray(parsed.stop) ? parsed.stop.length : null,
        toolChoice: parsed.tool_choice ?? null,
        responseFormat: parsed.response_format ?? null,
    };
}

// ---------------------------------------------------------------------------------------------------------------
// THE LEG ARTEFACT CONTRACT
// ---------------------------------------------------------------------------------------------------------------

/**
 * The shape a journey-probe leg report must have for the comparator to accept it. The comparator validates
 * this and refuses a leg that does not provide a layer instead of treating absence as a pass: a missing
 * layer is `not-observed`, never `match`.
 */
export const LEG_SCHEMA = 'a19-live-oracle-leg-v1';

export function emptyLeg({ subject, phase, journey, corpusTreeSha256, startedAt = new Date().toISOString() }) {
    return {
        schema: LEG_SCHEMA,
        subject,
        phase,
        journey,
        corpusTreeSha256,
        startedAt,
        finishedAt: null,
        baseURL: null,
        peerURL: null,
        steps: [],
        failure: null,
        bootRefusal: null,
        serverPid: null,
        layers: {
            browser: null,
            http: null,
            providerWire: null,
            persistence: null,
            lifecycle: null,
        },
    };
}
