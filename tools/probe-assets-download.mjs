#!/usr/bin/env node
// Capture the pinned /api/assets/download route (src/endpoints/assets.js:190) with a controlled peer.
//
// THE ROUTE HAS FOUR GUARDS AND TWO RESPONSE SHAPES, and the fixture records all of them because a
// two-guard plan leaves two refusals unasserted while everything stays green:
//
//	192-195  !isValidUrl(request.body.url)            -> sendStatus(400)  text/plain "Bad Request"
//	200-204  !isHostWhitelisted(getHostFromUrl(url))  -> sendStatus(404)  text/plain "Not Found"
//	206-215  category not in VALID_CATEGORIES         -> sendStatus(400)  text/plain "Bad Request"
//	217-221  validateAssetFileName(filename).error    -> status(400).send(message)  TEXT BODY
//	228      fetch(url)                               -> the ONLY outbound, after all four
//
// `sendStatus` is not an empty body: Express sends the status message as text/plain with an ETag, so
// the refusals are recorded with their body, content type and digest like any other response. The
// filename guard is the one branch whose body is a MESSAGE rather than a status phrase, so it is
// recorded as text and compared as text.
//
// VALID_CATEGORIES is ['bgm','ambient','blip','live2d','vrm','character','temp'] (assets.js:14), so
// the legal-category scenarios use a real member and the refusal uses a value outside the list.
// validateAssetFileName (assets.js:21) has four distinct messages, and the fixture exercises three
// of them plus the throw path (`path.extname(undefined)` for an absent filename -> 500).
//
// OUTBOUND COUNT IS FIXTURE DATA. Every refusal is recorded with ZERO outbound requests, and every
// forwarding step with exactly one, so a Go implementation that fetched before a guard would fail
// rather than look correct. The peer is the shared node-fetch stub, which is also the global fetch,
// so no request can leave the process.
//
// The host is USER-SUPPLIED, so the whitelist is a boot-time config projection
// (`whitelistImportDomains: ['127.0.0.1']`) and the URL is stored as <mock>.
//
// @gotavern-oracle: this declaration is read by tools/build-generated-lib.mjs,
// which auto-discovers probes so that adding one needs no edit there.
// @gotavern-oracle: fixture=sillytavern-1.19.0-assets-download.json label="assets download route"

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import {
    PINNED_COMMIT, PINNED_VERSION, startPinnedProviderServer, writeFixture,
} from './lib/pinned-outbound.mjs';

const sourceRoot = path.resolve(process.argv[2] ?? '');
const repositoryRoot = path.resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3]) {
    console.error('usage: node tools/probe-assets-download.mjs <pinned-source-clone> <gotavern-root>');
    process.exit(2);
}
if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim() !== PINNED_COMMIT) {
    throw new Error(`upstream checkout is not pinned at ${PINNED_COMMIT}`);
}

const COOKIE_SECRET = 'gotavern-pinned-assets-download-cookie-secret';
const FIXED_SECONDS = 1700000000;
// The stub answers without a socket, so the authority in the scenario URL is a fixed constant
// instead of an ephemeral port. It is stored as <mock> and the replay substitutes its own peer.
const PINNED_AUTHORITY = '127.0.0.1:18080';
const WHITELIST = ['127.0.0.1'];
const mockURL = pathname => `http://${PINNED_AUTHORITY}${pathname}`;

function sha256(value) {
    return createHash('sha256').update(value).digest('hex');
}

function snapshotTree(root, relative = '') {
    const entries = [];
    let names;
    try {
        names = readdirSync(root).sort();
    } catch {
        return entries;
    }
    for (const name of names) {
        const absolute = path.join(root, name);
        const child = relative === '' ? name : `${relative}/${name}`;
        const info = statSync(absolute);
        if (info.isDirectory()) {
            entries.push({ path: child, kind: 'directory', size: 0, sha256: null });
            entries.push(...snapshotTree(absolute, child));
        } else {
            const content = readFileSync(absolute);
            entries.push({ path: child, kind: 'file', size: content.length, sha256: sha256(content) });
        }
    }
    return entries;
}

// Every step declares its own peer rules. `match` is a substring of the request URL, and each step
// installs a fresh rule list, so no rule can answer a later step's request (AGENTS.md rule 20).
const steps = [];
const add = definition => steps.push({ upstream: [], seed: {}, ...definition });

// ---- the four guards, each with ZERO outbound -----------------------------------------------------------------
add({
    name: 'download.invalidUrl',
    body: { url: 'not a url', category: 'bgm', filename: 'one.mp3' },
});
add({
    name: 'download.hostNotWhitelisted',
    // A valid absolute URL whose host is not in whitelistImportDomains. `.invalid` never resolves,
    // so a Go implementation that fetched before this guard would be visible as a failed request
    // rather than as a plausible download.
    body: { url: 'http://blocked.invalid/one.mp3', category: 'bgm', filename: 'one.mp3' },
});
add({
    name: 'download.badCategory',
    body: { url: mockURL('/audio/one.mp3'), category: 'nope', filename: 'one.mp3' },
});
add({
    name: 'download.invalidFilename',
    body: { url: mockURL('/audio/one.mp3'), category: 'bgm', filename: 'bad?name.mp3' },
});
add({
    name: 'download.unsafeExtension',
    body: { url: mockURL('/audio/one.mp3'), category: 'bgm', filename: 'evil.php' },
});
add({
    name: 'download.leadingDot',
    body: { url: mockURL('/audio/one.mp3'), category: 'bgm', filename: '.hidden.mp3' },
});
add({
    // No filename: the pinned regex tests the string "undefined" (which matches) and then
    // path.extname(undefined) throws, so the route's catch answers 500.
    name: 'download.missingFilename',
    body: { url: mockURL('/audio/one.mp3'), category: 'bgm' },
});
add({
    // The upstream answers a non-2xx status: `!res.ok` throws into the same catch -> 500.
    name: 'download.upstreamNotOk',
    body: { url: mockURL('/audio/missing.mp3'), category: 'bgm', filename: 'missing.mp3' },
    upstream: [{ match: '/audio/missing.mp3', status: 404, headers: { 'content-type': 'text/plain' }, body: 'no such asset' }],
});
add({
    // The fetch itself rejects, which is how a closed port presents. Nothing is written.
    name: 'download.fetchRejected',
    body: { url: mockURL('/audio/rejected.mp3'), category: 'bgm', filename: 'rejected.mp3' },
    upstream: [{ match: '/audio/rejected.mp3', throws: true }],
});

// ---- the forwarding steps, each with exactly ONE outbound -----------------------------------------------------
add({
    name: 'download.ok.bgm',
    body: { url: mockURL('/audio/one.mp3'), category: 'bgm', filename: 'one.mp3' },
    upstream: [{ match: '/audio/one.mp3', status: 200, headers: { 'content-type': 'audio/mpeg' }, body: 'BGM-DL' }],
});
add({
    // The character branch answers the downloaded BYTES with the content type mime.lookup derives
    // from the temp filename, and does not copy the file into the category directory.
    name: 'download.ok.characterPng',
    body: { url: mockURL('/img/hero.png'), category: 'character', filename: 'hero.png' },
    upstream: [{ match: '/img/hero.png', status: 200, headers: { 'content-type': 'image/png' }, body: 'PNG-DL' }],
});
add({
    // A text extension, where mime.lookup and Go's mime package disagree about the charset.
    name: 'download.ok.characterTxt',
    body: { url: mockURL('/img/note.txt'), category: 'character', filename: 'note.txt' },
    upstream: [{ match: '/img/note.txt', status: 200, headers: { 'content-type': 'text/plain' }, body: 'NOTE-DL' }],
});
add({
    // A stale temp file with the same name exists: the pinned route unlinks it before opening the
    // write stream with the exclusive flag, so the download succeeds and the temp file is replaced.
    name: 'download.tempReplaced',
    body: { url: mockURL('/audio/replace.mp3'), category: 'bgm', filename: 'replace.mp3' },
    seed: { 'assets/temp/replace.mp3': 'STALE-TEMP' },
    upstream: [{ match: '/audio/replace.mp3', status: 200, headers: { 'content-type': 'audio/mpeg' }, body: 'REPLACED' }],
});

function capture(result) {
    const body = result.bytes ?? Buffer.from(result.text ?? '', 'utf8');
    return {
        status: result.response.status,
        contentType: result.response.headers.get('content-type'),
        contentLength: result.response.headers.get('content-length'),
        etag: result.response.headers.get('etag'),
        bodyText: body.toString('utf8'),
        bodyBase64: body.toString('base64'),
        bodySha256: sha256(body),
        bodyLength: body.length,
    };
}

async function main() {
    const server = await startPinnedProviderServer({
        sourceRoot,
        prefix: 'gotavern-assets-download-oracle-',
        mocks: [],
        config: { whitelistImportDomains: WHITELIST },
    });
    try {
        const userRoot = server.userRoot;
        const assetsRoot = path.join(userRoot, 'assets');
        const state = { before: snapshotTree(assetsRoot) };
        const observations = {};
        const inputs = [];

        for (const step of steps) {
            for (const [relative, content] of Object.entries(step.seed)) {
                const target = path.join(userRoot, ...relative.split('/'));
                mkdirSync(path.dirname(target), { recursive: true });
                writeFileSync(target, content);
                utimesSync(target, FIXED_SECONDS, FIXED_SECONDS);
            }
            server.setMocks(step.upstream.map(rule => ({
                match: rule.match,
                status: rule.status,
                headers: rule.headers ?? {},
                body: rule.body,
                throws: rule.throws === true,
            })));
            const body = JSON.stringify(step.body);
            const result = await server.post('/api/assets/download', body);
            const outbound = server.outbound();
            inputs.push({
                name: step.name,
                bodyText: body.split(PINNED_AUTHORITY).join('<mock>'),
                upstream: step.upstream,
                seed: step.seed,
            });
            observations[step.name] = {
                ...capture(result),
                // The peer observes the request the route made: method and target, plus the count.
                // Headers are NOT recorded: the stub sees only the headers the route passed, while
                // the transport adds node-fetch's defaults and Host/Connection, so only the target
                // and method are a property of the route.
                outbound: outbound.map(request => ({
                    url: request.url.split(PINNED_AUTHORITY).join('<mock>'),
                    method: request.method,
                })),
                tree: snapshotTree(assetsRoot),
                comparison: {
                    compared: ['status', 'contentType', 'contentLength', 'etag', 'bodyText', 'bodyBase64', 'bodySha256', 'bodyLength', 'outbound', 'tree'],
                    shape: [],
                    shapeReason: {},
                },
            };
        }

        writeFixture(repositoryRoot, 'sillytavern-1.19.0-assets-download.json', {
            schemaVersion: 1,
            baseline: { version: PINNED_VERSION, commit: PINNED_COMMIT },
            probe: 'pinned /api/assets/download: four guards, the filename-message branch, and the forwarding branches',
            oracle: { file: 'src/endpoints/assets.js', lines: { download: 190 } },
            conventions: {
                steps: 'steps are an ordered ARRAY: every step snapshots the assets tree the next step starts from',
                mock: `the peer authority ${PINNED_AUTHORITY} is stored as <mock> in inputs and outbound URLs; the replay substitutes its own peer`,
                refusals: 'a refusal records ZERO outbound requests; a forwarding step records exactly one, so a guard that fetched early cannot look correct',
                filename: 'the filename guard answers status(400).send(message), so its body is TEXT and is compared as text; sendStatus branches answer the status phrase as text/plain',
                mime: 'the character branch content type comes from mime.lookup of the temp filename',
            },
            fixtureFields: {
                compared: ['observations.*.status', 'observations.*.contentType', 'observations.*.contentLength', 'observations.*.etag', 'observations.*.bodyText', 'observations.*.bodyBase64', 'observations.*.bodySha256', 'observations.*.bodyLength', 'observations.*.outbound', 'observations.*.tree', 'state.before'],
                shape: [],
                shapeReason: {},
            },
            inputs: {
                cookieSecret: COOKIE_SECRET,
                account: { handle: 'default-user', name: 'Assets Download Probe', admin: true, password: '' },
                whitelistImportDomains: WHITELIST,
                steps: inputs,
            },
            state,
            observations,
            knownDifferences: [{
                routes: ['/api/assets/download'],
                branches: ['a download that fails MID-STREAM'],
                status: 'partial',
                reason: 'pinned streams the response body into assets/temp/<name> with the exclusive flag and only then copies it into the category; a failure after the headers leaves the partial temp file behind. GoTavern reads the body and writes the destination atomically under the user content lock, so a mid-stream failure leaves no partial file. The observable end state for every branch the fixture records is identical; the partial-temp artifact is not reproduced.',
            }, {
                routes: ['/api/assets/download'],
                branches: ['a 2xx response with no body object (101/204/205/304)'],
                status: 'derivation',
                reason: 'node-fetch gives res.body === null for these statuses and the pinned route throws (assets.js:229), so a 204 from the asset host answers 500 rather than writing an empty asset. The shared peer stub always attaches a readable body to its response object, so it cannot express a null body and NO fixture can record the branch. The Go decision is asserted by the labelled derivation test TestAssetsDownloadTreatsANullBodyStatusAsAFailure, not by a recorded response.',
            }],
        });
        console.log('Wrote tests/oracle/sillytavern-1.19.0-assets-download.json from pinned download behaviour');
    } finally {
        await server.stop();
    }
}

await main();
