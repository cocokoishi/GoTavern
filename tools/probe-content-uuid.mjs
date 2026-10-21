#!/usr/bin/env node
// Capture the pinned /api/content/importUUID branch that is provable this round: AICC.
//
//	POST /api/content/importUUID   content-manager.js:1071
//
// Dispatch (source-derived, pinned in content-manager.js:1080-1112):
//   isJannny    = uuid.includes('_character')
//   isPygmalion = !isJannny && uuid.length == 36
//   isAICC      = uuid.startsWith('AICC/')
//   isPerchance = /^\w+~[a-f0-9]{32}\.gz$/.test(uuid)
//   uuidType    = uuid.includes('lorebook') ? 'lorebook' : 'character'
//   order: pygmalion, janny, AICC, perchance, else chub (character/lorebook)
// The AICC branch destructures `uuid.split('/')` as [, author, card], so `AICC/only` becomes
// `only/undefined`, and it reuses downloadAICCCharacter. importUUID's response envelope differs
// from importURL: Content-Disposition is the RAW filename (no encodeURI) and
// X-Custom-Content-Type is the uuidType.
//
// Every branch except AICC calls an unimplemented provider downloader (chub, janny, pygmalion,
// risu/perchance) and answers 501 in Go (rule 17), so those shapes are NOT recorded here — the
// pinned server would fetch and return a 200, and recording a Go 501 as an "oracle" would be a fake
// fixture. The classifier itself is covered by unit tests against the source-derived rules.
//
// @gotavern-oracle: this declaration is read by tools/build-generated-lib.mjs,
// which auto-discovers probes so that adding one needs no edit there.
// @gotavern-oracle: fixture=sillytavern-1.19.0-content-uuid.json label="content importUUID AICC branch"

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
    console.error('usage: node tools/probe-content-uuid.mjs <pinned-source-clone> <gotavern-root>');
    process.exit(2);
}
if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim() !== PINNED_COMMIT) {
    throw new Error(`upstream checkout is not pinned at ${PINNED_COMMIT}`);
}

const COOKIE_SECRET = 'gotavern-pinned-content-uuid-cookie-secret';
const FIXED_SECONDS = 1700000000;

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

const png = { status: 200, headers: { 'content-type': 'image/png' }, body: 'PNG-UUID-BYTES' };

const scenarios = [
    { name: 'uuid.aicc.ok', uuid: 'AICC/author/card', upstream: [{ path: '/wp-json/pngapi/v1/image/author/card', ...png }] },
    { name: 'uuid.aicc.lorebook', uuid: 'AICC/author/card-lorebook', upstream: [{ path: '/wp-json/pngapi/v1/image/author/card-lorebook', ...png }] },
    { name: 'uuid.aicc.twoSegments', uuid: 'AICC/only', upstream: [{ path: '/wp-json/pngapi/v1/image/only/undefined', ...png }] },
    { name: 'uuid.aicc.nonOk', uuid: 'AICC/author/broken', upstream: [{ path: '/wp-json/pngapi/v1/image/author/broken', status: 500, headers: { 'content-type': 'text/plain' }, body: 'broken' }] },
    { name: 'uuid.missingUrl', body: {} },
    { name: 'uuid.emptyUrl', body: { url: '' } },
];

function capture(result) {
    const body = result.bytes ?? Buffer.from(result.text ?? '', 'utf8');
    return {
        status: result.response.status,
        contentType: result.response.headers.get('content-type'),
        contentLength: result.response.headers.get('content-length'),
        etag: result.response.headers.get('etag'),
        contentDisposition: result.response.headers.get('content-disposition'),
        customContentType: result.response.headers.get('x-custom-content-type'),
        bodyBase64: body.toString('base64'),
        bodySha256: sha256(body),
        bodyLength: body.length,
    };
}

async function main() {
    const server = await startPinnedProviderServer({ sourceRoot, prefix: 'gotavern-content-uuid-oracle-', mocks: [] });
    try {
        const userRoot = server.userRoot;
        mkdirSync(path.join(userRoot, 'characters'), { recursive: true });
        writeFileSync(path.join(userRoot, 'characters', 'seed.txt'), 'SEED');
        utimesSync(path.join(userRoot, 'characters', 'seed.txt'), FIXED_SECONDS, FIXED_SECONDS);
        const observations = {};
        const steps = [];
        for (const scenario of scenarios) {
            server.setMocks((scenario.upstream ?? []).map(item => ({
                match: item.path,
                status: item.status,
                headers: item.headers ?? {},
                body: item.body,
            })));
            const body = scenario.body ?? { url: scenario.uuid };
            const result = await server.post('/api/content/importUUID', JSON.stringify(body));
            steps.push({ name: scenario.name, body, upstream: scenario.upstream ?? [], seam: scenario.seam ?? null });
            observations[scenario.name] = {
                ...capture(result),
                outbound: server.outbound().map(request => ({
                    url: request.url,
                    method: request.method,
                    explicitHeaders: Object.entries(request.headers ?? {})
                        .map(([name, value]) => [String(name).toLowerCase(), String(value)])
                        .sort((left, right) => left[0].localeCompare(right[0])),
                    body: request.body ?? '',
                })),
                tree: snapshotTree(path.join(userRoot, 'characters')),
                comparison: {
                    compared: ['status', 'contentType', 'contentLength', 'etag', 'contentDisposition', 'customContentType', 'bodyBase64', 'bodySha256', 'bodyLength', 'outbound', 'tree'],
                    shape: ['outbound[].transportConnection'],
                    shapeReason: {
                        'outbound[].transportConnection': 'the stub records headers the route passed, not the transport Connection Node appends; presence only',
                    },
                },
            };
        }
        writeFixture(repositoryRoot, 'sillytavern-1.19.0-content-uuid.json', {
            schemaVersion: 1,
            baseline: { version: PINNED_VERSION, commit: PINNED_COMMIT },
            probe: 'pinned /api/content/importUUID AICC branch',
            oracle: { file: 'src/endpoints/content-manager.js', lines: { importUUID: 1071 } },
            conventions: {
                steps: 'ordered ARRAY; the replay iterates in recorded order',
                seam: 'the AICC base URL is hardcoded in pinned and is replaced by GOTAVERN_CONTENT_AICC_URL in the replay',
            },
            nodeFetchWireDefaults: {
                headers: [['accept', '*/*'], ['accept-encoding', 'gzip, deflate, br'], ['user-agent', 'node-fetch']],
                verifiedBy: 'tests/oracle/sillytavern-1.19.0-sd-routes.json records the same defaults on the pinned wire',
            },
            fixtureFields: {
                compared: ['observations.*.status', 'observations.*.contentType', 'observations.*.contentLength', 'observations.*.etag', 'observations.*.contentDisposition', 'observations.*.customContentType', 'observations.*.bodyBase64', 'observations.*.bodySha256', 'observations.*.bodyLength', 'observations.*.outbound', 'observations.*.tree'],
                shape: ['observations.*.outbound[].transportConnection'],
            },
            inputs: {
                cookieSecret: COOKIE_SECRET,
                account: { handle: 'default-user', name: 'Content UUID Probe', admin: true, password: '' },
                steps,
            },
            observations,
            knownDifferences: [{
                routes: ['/api/content/importUUID'],
                branches: ['pygmalion (length 36)', 'janitorai (*_character)', 'perchance (name~32hex.gz)', 'chub character', 'chub lorebook'],
                status: 'not implemented',
                reason: 'every other branch calls a provider downloader that is still unimplemented (chub/janny/pygmalion/perchance); those UUID shapes answer 501 so they stay distinguishable from a policy refusal. The UUID-shape classifier is covered by source-derived unit tests because the pinned server would fetch for those shapes and cannot produce a 501 oracle.',
            }],
        });
        console.log('Wrote tests/oracle/sillytavern-1.19.0-content-uuid.json from pinned importUUID behaviour');
    } finally {
        await server.stop();
    }
}

await main();
