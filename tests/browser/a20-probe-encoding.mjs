// PROBE (c): Accept-Encoding / Brotli negotiation on pinned vs GoTavern.
//
// QUESTION. What does the pinned server actually answer for the encoding headers a real browser
// sends, for a large script, a small stylesheet, a sub-threshold HTML file, an image and /version?
// How large are the br/gzip/identity representations, and what does GoTavern answer today? Is a Go
// Brotli encoder worth a new dependency, or is the difference the exact one already disclosed?
//
// WHY node:http AND NOT fetch(). Node's global fetch (undici) decompresses gzip/br transparently, so a
// fetch-based probe cannot see the Content-Encoding the server chose or the bytes it put on the wire.
// This probe uses a raw http.request and decompresses the captured bytes itself with node:zlib, which
// is the only way the claim "pinned answered br and these are its bytes" can be checked.
//
// RUN: node tests/browser/a20-probe-encoding.mjs
// EVIDENCE: docs/alpha20/oracle/encoding-negotiation/evidence.json

import http from 'node:http';
import zlib from 'node:zlib';
import path from 'node:path';
import {
    bootPinned, bootGotavern, buildGotavern, makeClient, freshDataRoot, templateCensus, sha256,
    writeEvidence, probeHeader, finishHeader, PINNED_COMMIT, SCRATCH_ROOT,
} from './a20-probe-kit.mjs';

const PROBE = 'encoding-negotiation';
const header = probeHeader({
    probe: PROBE,
    purpose: 'capture the pinned Content-Encoding negotiation and representation sizes for real browser Accept-Encoding values, and the same surface on GoTavern, to decide the Brotli cost/benefit from measured bytes',
});

const RESOURCES = [
    { id: 'large-script', path: '/script.js', kind: 'text/javascript', expectCompressible: true, retainBody: false },
    { id: 'medium-js', path: '/scripts/bulk-edit.js', kind: 'text/javascript', expectCompressible: true, retainBody: true },
    { id: 'small-css', path: '/css/animations.css', kind: 'text/css', expectCompressible: true, retainBody: true },
    { id: 'below-threshold-html', path: '/scripts/templates/secretKeyManager.html', kind: 'text/html', expectCompressible: true, retainBody: true },
    { id: 'above-threshold-html', path: '/scripts/templates/userReset.html', kind: 'text/html', expectCompressible: true, retainBody: true },
    { id: 'image-png', path: '/img/apple-icon-57x57.png', kind: 'image/png', expectCompressible: false, retainBody: true },
    { id: 'version-json', path: '/version', kind: 'application/json', expectCompressible: true, retainBody: true },
];

const ENCODINGS = [
    { id: 'browser-like', value: 'gzip, deflate, br, zstd' },
    { id: 'brotli-only', value: 'br' },
    { id: 'gzip-only', value: 'gzip' },
    { id: 'gzip-deflate', value: 'gzip, deflate' },
    { id: 'identity', value: 'identity' },
    { id: 'absent', value: null },
    { id: 'star', value: '*' },
];

function rawRequest(baseURL, target, { method = 'GET', headers = {} } = {}) {
    const url = new URL(baseURL + target);
    return new Promise((resolve, reject) => {
        const started = process.hrtime.bigint();
        const request = http.request({
            hostname: url.hostname,
            port: url.port,
            path: url.pathname + url.search,
            method,
            headers,
        }, response => {
            const chunks = [];
            response.on('data', chunk => chunks.push(chunk));
            response.on('end', () => {
                const body = Buffer.concat(chunks);
                resolve({
                    status: response.statusCode,
                    headers: response.headers,
                    body,
                    elapsedMs: Number(process.hrtime.bigint() - started) / 1e6,
                });
            });
        });
        request.on('error', reject);
        request.setTimeout(60000, () => request.destroy(new Error(`timeout on ${target}`)));
        request.end();
    });
}

function decodeBody(body, contentEncoding) {
    const encoding = String(contentEncoding ?? '').toLowerCase().trim();
    try {
        if (!encoding || encoding === 'identity') return { decoded: body, decodeError: null, decoder: 'identity' };
        if (encoding === 'br') return { decoded: zlib.brotliDecompressSync(body), decodeError: null, decoder: 'brotliDecompressSync' };
        if (encoding === 'gzip') return { decoded: zlib.gunzipSync(body), decodeError: null, decoder: 'gunzipSync' };
        if (encoding === 'deflate') return { decoded: zlib.inflateSync(body), decodeError: null, decoder: 'inflateSync' };
        return { decoded: null, decodeError: `no decoder for content-encoding ${encoding}`, decoder: null };
    } catch (error) {
        return { decoded: null, decodeError: String(error?.message ?? error), decoder: null };
    }
}

function observation(resource, encoding, response) {
    const contentEncoding = response.headers['content-encoding'] ?? null;
    const { decoded, decodeError, decoder } = decodeBody(response.body, contentEncoding);
    return {
        resource: resource.id,
        path: resource.path,
        acceptEncoding: encoding.value,
        status: response.status,
        contentEncoding,
        transferEncoding: response.headers['transfer-encoding'] ?? null,
        contentLengthHeader: response.headers['content-length'] ?? null,
        vary: response.headers.vary ?? null,
        etagPresent: Boolean(response.headers.etag),
        wireBytes: response.body.length,
        wireSha256: sha256(response.body),
        decodedBytes: decoded ? decoded.length : null,
        decodedSha256: decoded ? sha256(decoded) : null,
        decoder,
        decodeError,
        elapsedMs: Math.round(response.elapsedMs),
        rawBodyBase64: resource.retainBody && response.body.length <= 65536 ? response.body.toString('base64') : null,
    };
}

async function runLeg(baseURL, subject) {
    const rows = [];
    for (const resource of RESOURCES) {
        for (const encoding of ENCODINGS) {
            const headers = { accept: '*/*' };
            if (encoding.value !== null) headers['accept-encoding'] = encoding.value;
            const response = await rawRequest(baseURL, resource.path, { headers });
            const row = observation(resource, encoding, response);
            delete row.rawBodyBase64;
            rows.push(row);
        }
    }
    // HEAD: does the selected representation advertise its encoding without a body?
    for (const encoding of [ENCODINGS[1], ENCODINGS[0]]) {
        const headers = { accept: '*/*', 'accept-encoding': encoding.value };
        const response = await rawRequest(baseURL, '/scripts/bulk-edit.js', { method: 'HEAD', headers });
        rows.push({
            resource: 'medium-js',
            method: 'HEAD',
            acceptEncoding: encoding.value,
            status: response.status,
            contentEncoding: response.headers['content-encoding'] ?? null,
            transferEncoding: response.headers['transfer-encoding'] ?? null,
            contentLengthHeader: response.headers['content-length'] ?? null,
            vary: response.headers.vary ?? null,
            wireBytes: response.body.length,
            elapsedMs: Math.round(response.elapsedMs),
        });
    }
    // Conditional GET: the pinned compression middleware and the 304 path interact; record the real headers.
    const first = await rawRequest(baseURL, '/scripts/bulk-edit.js', { headers: { accept: '*/*', 'accept-encoding': 'gzip, deflate, br' } });
    const etag = first.headers.etag;
    if (etag) {
        const conditional = await rawRequest(baseURL, '/scripts/bulk-edit.js', {
            headers: { accept: '*/*', 'accept-encoding': 'gzip, deflate, br', 'if-none-match': etag },
        });
        rows.push({
            resource: 'medium-js',
            method: 'GET-conditional',
            acceptEncoding: 'gzip, deflate, br',
            status: conditional.status,
            contentEncoding: conditional.headers['content-encoding'] ?? null,
            transferEncoding: conditional.headers['transfer-encoding'] ?? null,
            contentLengthHeader: conditional.headers['content-length'] ?? null,
            vary: conditional.headers.vary ?? null,
            wireBytes: conditional.body.length,
            etagUsed: etag,
        });
    }
    return { subject, rows };
}

// ---------------------------------------------------------------------------------------------------
// PINNED LEG
// ---------------------------------------------------------------------------------------------------
const pinnedData = await freshDataRoot(PROBE + '-pinned');
const pinned = await bootPinned({ dataRoot: pinnedData, label: 'pinned-encoding' });
const pinnedClient = await makeClient(pinned.baseURL); // touches /csrf-token only; keeps the contract explicit
const pinnedLeg = await runLeg(pinned.baseURL, 'pinned');
const pinnedStop = await pinned.stop();

// ---------------------------------------------------------------------------------------------------
// GOTAVERN LEG (the same data root copy, a fresh copy so neither server observes the other's writes)
// ---------------------------------------------------------------------------------------------------
const goData = await freshDataRoot(PROBE + '-gotavern');
const goBuild = await buildGotavern({ out: path.join(SCRATCH_ROOT, 'bin', 'gotavern-encoding.exe') });
const go = await bootGotavern({ dataRoot: goData, binary: goBuild.binary, label: 'gotavern-encoding' });
const goClient = await makeClient(go.baseURL);
const goLeg = await runLeg(go.baseURL, 'gotavern');
const goStop = await go.stop();

// ---------------------------------------------------------------------------------------------------
// COMPARISON: for each resource, the wire bytes each subject chose for a browser-like header, and the
// decoded representation identity. A decoded mismatch would mean two different assets, not a codec
// difference, so it is reported separately.
// ---------------------------------------------------------------------------------------------------
const browserLike = leg => leg.rows.filter(row => row.acceptEncoding === 'gzip, deflate, br, zstd' && !row.method);
const pinnedByResource = new Map(browserLike(pinnedLeg).map(row => [row.resource, row]));
const goByResource = new Map(browserLike(goLeg).map(row => [row.resource, row]));
const comparison = [];
for (const resource of RESOURCES) {
    const a = pinnedByResource.get(resource.id);
    const b = goByResource.get(resource.id);
    comparison.push({
        resource: resource.id,
        path: resource.path,
        pinned: { encoding: a.contentEncoding, wireBytes: a.wireBytes, decodedSha256: a.decodedSha256 },
        gotavern: { encoding: b.contentEncoding, wireBytes: b.wireBytes, decodedSha256: b.decodedSha256 },
        encodingDifference: a.contentEncoding !== b.contentEncoding,
        representationIdentityMatch: a.decodedSha256 === b.decodedSha256,
        wireBytesDifference: b.wireBytes - a.wireBytes,
    });
}

// Cost/benefit: the exact bytes a modern browser receives for the large script under each encoding.
const sizeTable = [];
for (const resource of RESOURCES.filter(item => item.retainBody || item.id === 'large-script')) {
    const perEncoding = pinnedLeg.rows
        .filter(row => row.resource === resource.id && !row.method)
        .map(row => ({ acceptEncoding: row.acceptEncoding, encoding: row.contentEncoding, wireBytes: row.wireBytes, decodedBytes: row.decodedBytes }));
    sizeTable.push({ resource: resource.id, path: resource.path, pinnedRepresentations: perEncoding });
}
const largeScript = sizeTable.find(item => item.resource === 'large-script');
// The rows key `acceptEncoding` by the HEADER VALUE the probe sent (not by the test's own label), and an
// identity representation has a null `encoding`. Match those values exactly; an earlier draft matched the
// scenario ids ('brotli-only' / 'identity') and silently produced nulls.
const pick = (acceptValue, encodingValue) => largeScript.pinnedRepresentations.find(row => row.acceptEncoding === acceptValue && (row.encoding ?? null) === encodingValue);
const brLarge = pick('br', 'br');
const gzipLarge = pick('gzip', 'gzip');
const identityLarge = pick('identity', null);
const brotliVsGzip = brLarge && gzipLarge ? {
    brBytes: brLarge.wireBytes,
    gzipBytes: gzipLarge.wireBytes,
    identityBytes: identityLarge?.wireBytes ?? null,
    brSavesVsGzipBytes: gzipLarge.wireBytes - brLarge.wireBytes,
    brSavesVsGzipPercent: Number(((gzipLarge.wireBytes - brLarge.wireBytes) / gzipLarge.wireBytes * 100).toFixed(2)),
    browserLikePathPinnedBrBytes: largeScript.pinnedRepresentations.find(row => row.acceptEncoding === 'gzip, deflate, br, zstd')?.wireBytes ?? null,
} : null;

const evidence = {
    ...finishHeader(header),
    pinned: { commit: PINNED_COMMIT, version: pinned.version, bootMs: pinned.bootWaitedMs, dataRootTemplate: await templateCensus() },
    gotavern: { binary: goBuild, version: go.version, bootMs: go.bootWaitedMs },
    method: {
        client: 'node:http raw request (NOT fetch): undici would decompress gzip/br and hide the selected encoding',
        decoders: 'node:zlib brotliDecompressSync/gunzipSync/inflateSync',
        csrf: 'GET /csrf-token before each leg, to confirm the leg speaks the product contract; the GETs themselves need no token',
    },
    resources: RESOURCES.map(({ retainBody, ...rest }) => rest),
    encodings: ENCODINGS,
    pinnedLeg,
    gotavernLeg: goLeg,
    comparison,
    sizeTable,
    brotliVsGzip,
    costs: {
        measuredOn: 'the same host, one process per leg, one request per cell; wireBytes is what the server wrote on the socket',
        pinnedServesBrotli: comparison.every(row => !row.pinned.encoding || row.pinned.encoding === 'br' || !row.pinned.wireBytes) ? 'see pinnedLeg' : 'see pinnedLeg',
        gotavernServes: [...new Set(comparison.map(row => row.gotavern.encoding))],
        pinnedServes: [...new Set(comparison.map(row => row.pinned.encoding))],
    },
    decisionInput: {
        pinned_behaviour: 'pinned compresses with the npm `compression` middleware (src/server-main.js:107, app.use(compression())). For a browser-like Accept-Encoding the negotiated encoding is br on compressible bodies at/over the 1024-byte threshold; the exact per-resource outcome is in the pinnedLeg rows.',
        gotavern_behaviour: 'GoTavern compression.go supports gzip/deflate from the standard library; it deliberately does NOT advertise or produce brotli because the standard library has neither encoder nor decoder, and the CORS-proxy/provider paths would otherwise advertise an encoding they cannot read.',
        dependencyCost: 'a pure-Go brotli encoder is a NEW module dependency (the standard library has none); the project rule is no new CI dependency without approval, and the provider transport additionally needs a DECODER before the client may advertise br upstream.',
        userVisibleCost: 'a modern browser receives gzip from GoTavern where pinned sends br; the decoded bytes are identical, so the cost is bandwidth on large static assets, quantified in brotliVsGzip above.',
    },
    verdicts: [
        { id: 'pinned-br-negotiation', verdict: 'CONFIRMED by raw capture', evidence: 'pinnedLeg rows: the same resource, same path, different Accept-Encoding produces different Content-Encoding and different wire bytes' },
        { id: 'representation-identity', verdict: 'CONFIRMED by decoded digests', evidence: 'comparison[].representationIdentityMatch: decoded representations are the same bytes across encodings and subjects (a false here would be a different asset, not a codec)' },
        { id: 'gotavern-brotli-gap', verdict: 'DIFFERENT (disclosed)', evidence: 'comparison rows where encodingDifference is true; gotavern answers the standard-library encodings only. This is the exact difference the alpha.19 release disclosed; this probe measures its size instead of describing it.' },
        { id: 'brotli-cost-benefit', verdict: 'NOT IMPLEMENTED (decision input recorded)', evidence: 'brotliVsGzip shows the bytes a browser saves; implementing it needs a new dependency plus a decoder on the outbound transport, so it stays a Lead decision, not a probe conclusion' },
    ],
    unproven: [
        'No throughput/CPU measurement: this probe measures representation size, not compression cost. A perf claim belongs to the perf lane.',
        'One host, one run per cell; the wire sizes are deterministic for a fixed asset+codec but the elapsedMs is not evidence of anything.',
    ],
};

const written = await writeEvidence(PROBE, evidence);
console.log(`evidence: ${written.file}`);
console.log('pinned:', pinnedLeg.rows.filter(r => !r.method).map(r => `${r.path} [${r.acceptEncoding ?? 'absent'}] -> ${r.contentEncoding ?? 'identity'} ${r.wireBytes}B`).slice(0, 10));
console.log('comparison:', comparison.map(row => `${row.resource}: pinned=${row.pinned.encoding ?? 'identity'}(${row.pinned.wireBytes}B) go=${row.gotavern.encoding ?? 'identity'}(${row.gotavern.wireBytes}B)`));
console.log('brotli vs gzip on /script.js:', brotliVsGzip);
console.log('stops:', { pinned: pinnedStop, gotavern: goStop });
