#!/usr/bin/env node
// Capture the pinned /api/content/importURL branches implemented this round:
//
//	POST /api/content/importURL   content-manager.js:978
//	  * aicharactercards.com (AICC)      -> downloadAICCCharacter (single hardcoded GET)
//	  * generic whitelisted host         -> downloadGenericPng (caller-supplied GET, filename
//	                                        derived from the RESPONSE url: url.split('?')[0], last '/'
//	                                        segment, sanitized, '.png' appended when content-type is
//	                                        image/png and the name has no extension)
//	  * refusal                          -> host not in whitelistImportDomains and not a provider -> 404
//
// DEFERRED, recorded in the fixture knownDifferences: the chub / janitorai / pygmalion / risu /
// perchance branches (each has its own downloader and needs its own provider oracle), and the whole
// of /api/content/importUUID. The Go route answers 501 Not Implemented for those provider hosts
// instead of pretending they were refused.
//
// SECURITY PROPERTY (AGENTS.md boundary 4): provider classification is SUBSTRING matching on the
// hostname, so chub.ai.attacker.example satisfies isChub (and is therefore classified as chub, not
// refused). The replay fixture pins the generic/refusal behaviour only; the substring property is
// recorded in the compat row, not exercised by the implemented branches.
//
// The stub's response `url` is the requested href (pinned-outbound makeResponse, be7fd3d-era), so
// downloadGenericPng's filename derivation is observable and is asserted here, including reserved
// characters that distinguish encodeURI from encodeURIComponent in Content-Disposition.
//
// @gotavern-oracle: this declaration is read by tools/build-generated-lib.mjs,
// which auto-discovers probes so that adding one needs no edit there.
// @gotavern-oracle: fixture=sillytavern-1.19.0-content.json label="content importURL branches"

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
    console.error('usage: node tools/probe-content.mjs <pinned-source-clone> <gotavern-root>');
    process.exit(2);
}
if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim() !== PINNED_COMMIT) {
    throw new Error(`upstream checkout is not pinned at ${PINNED_COMMIT}`);
}

const COOKIE_SECRET = 'gotavern-pinned-content-cookie-secret';
const FIXED_SECONDS = 1700000000;
const PINNED_PORT = '18080';

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

const scenarios = [];
const add = definition => scenarios.push({ ...definition, upstream: definition.upstream ?? [] });

const png = { status: 200, headers: { 'content-type': 'image/png' }, body: 'PNG-AICC-BYTES' };

add({
    name: 'aicc.ok',
    urlTemplate: 'https://aicharactercards.com/cards/author/card-name',
    seam: 'GOTAVERN_CONTENT_AICC_URL',
    upstream: [{ path: '/wp-json/pngapi/v1/image/author/card-name', ...png }],
});
add({
    name: 'aicc.nonOk',
    urlTemplate: 'https://aicharactercards.com/cards/author/broken',
    seam: 'GOTAVERN_CONTENT_AICC_URL',
    upstream: [{ path: '/wp-json/pngapi/v1/image/author/broken', status: 500, headers: { 'content-type': 'text/plain' }, body: 'no card' }],
});
add({
    name: 'aicc.unparseable',
    urlTemplate: 'https://aicharactercards.com/only-one-segment',
});
add({
    name: 'generic.ok',
    urlTemplate: `http://localhost:<mock>/cards/hero`,
    upstream: [{ path: '/cards/hero', ...png }],
});
add({
    name: 'generic.extensionPreserved',
    urlTemplate: `http://localhost:<mock>/cards/hero.webp`,
    upstream: [{ path: '/cards/hero.webp', status: 200, headers: { 'content-type': 'image/png' }, body: 'WEBP-NAMED-PNG' }],
});
add({
    name: 'generic.nonPngContentType',
    urlTemplate: `http://localhost:<mock>/cards/hero.bin`,
    upstream: [{ path: '/cards/hero.bin', status: 200, headers: { 'content-type': 'application/octet-stream' }, body: 'BINARY-BODY' }],
});
add({
    name: 'generic.reservedChars',
    urlTemplate: `http://localhost:<mock>/files/card&x;y=z`,
    upstream: [{ path: '/files/card&x;y=z', ...png }],
});
add({
    name: 'generic.nonOk',
    urlTemplate: `http://localhost:<mock>/cards/missing`,
    upstream: [{ path: '/cards/missing', status: 404, headers: { 'content-type': 'text/plain' }, body: 'not found' }],
});
add({
    name: 'generic.rejectedFetch',
    urlTemplate: `http://localhost:<mock>/cards/throw`,
    upstream: [{ path: '/cards/throw', throws: true }],
    peer: 'closed',
});
add({
    name: 'refusal.unknownHost',
    urlTemplate: 'https://example.com/card.png',
});
add({
    name: 'refusal.attackerSubstringMustNotBeRefused',
    urlTemplate: 'https://chub.ai.attacker.example/card.png',
    deferred: 'chub',
});
add({
    name: 'missingUrl',
    body: {},
});

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
    const server = await startPinnedProviderServer({ sourceRoot, prefix: 'gotavern-content-oracle-', mocks: [] });
    try {
        const userRoot = server.userRoot;
        mkdirSync(path.join(userRoot, 'characters'), { recursive: true });
        writeFileSync(path.join(userRoot, 'characters', 'seed.txt'), 'SEED');
        utimesSync(path.join(userRoot, 'characters', 'seed.txt'), FIXED_SECONDS, FIXED_SECONDS);
        const observations = {};
        const inputs = [];
        for (const scenario of scenarios) {
            if (scenario.deferred) {
                // The chub branch is NOT implemented in Go; a pinned probe here would only prove
            // that the pinned server downloads from chub, which the Go side deliberately does not
            // claim. Recorded as a known difference below instead of a step.
                continue;
            }
            const urlTemplate = scenario.urlTemplate;
            const sentUrl = urlTemplate ? urlTemplate.split('<mock>').join(PINNED_PORT) : '';
            server.setMocks(scenario.upstream.map(item => ({
                match: item.path,
                status: item.status,
                headers: item.headers ?? {},
                body: item.body,
                throws: item.throws === true,
                url: sentUrl || undefined,
            })));
            const body = scenario.body ?? { url: sentUrl };
            const result = await server.post('/api/content/importURL', JSON.stringify(body));
            inputs.push({
                name: scenario.name,
                urlTemplate,
                bodyText: JSON.stringify(body).split(PINNED_PORT).join('<mock>'),
                seam: scenario.seam ?? null,
                peer: scenario.peer ?? 'mock',
                upstream: scenario.upstream,
            });
            observations[scenario.name] = {
                ...capture(result),
                outbound: server.outbound().map(request => ({
                    url: request.url.split(PINNED_PORT).join('<mock>'),
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
        writeFixture(repositoryRoot, 'sillytavern-1.19.0-content.json', {
            schemaVersion: 1,
            baseline: { version: PINNED_VERSION, commit: PINNED_COMMIT },
            probe: 'pinned /api/content/importURL: AICC, generic whitelisted host, refusal',
            oracle: { file: 'src/endpoints/content-manager.js', lines: { importURL: 978 } },
            nodeFetchWireDefaults: {
                headers: [['accept', '*/*'], ['accept-encoding', 'gzip, deflate, br'], ['user-agent', 'node-fetch']],
                verifiedBy: 'tests/oracle/sillytavern-1.19.0-sd-routes.json records the same defaults on the pinned wire',
            },
            conventions: {
                steps: 'steps are an ordered ARRAY; the two routes share no tree state here, but the array keeps the replay order explicit',
                mock: 'the pinned peer port 18080 is stored as <mock> in inputs and outbound URLs; the replay substitutes its own port',
                filename: 'downloadGenericPng derives the filename from the RESPONSE url (split ? then / then sanitize), which the stub exposes as the requested href',
            },
            fixtureFields: {
                compared: ['observations.*.status', 'observations.*.contentType', 'observations.*.contentLength', 'observations.*.etag', 'observations.*.contentDisposition', 'observations.*.customContentType', 'observations.*.bodyBase64', 'observations.*.bodySha256', 'observations.*.bodyLength', 'observations.*.outbound', 'observations.*.tree'],
                shape: ['observations.*.outbound[].transportConnection'],
            },
            inputs: {
                cookieSecret: COOKIE_SECRET,
                account: { handle: 'default-user', name: 'Content Probe', admin: true, password: '' },
                whitelistImportDomains: ['localhost', 'cdn.discordapp.com', 'files.catbox.moe', 'raw.githubusercontent.com'],
                steps: inputs,
            },
            observations,
            knownDifferences: [{
                routes: ['/api/content/importURL'],
                branches: ['chub.ai / characterhub.org (character and lorebook)', 'janitorai', 'pygmalion.chat', 'realm.risuai.net', 'perchance.org'],
                status: 'not implemented',
                reason: 'each provider branch has its own downloader and needs its own provider oracle; the Go route answers 501 for those hosts instead of pretending they were refused. SECURITY PROPERTY (AGENTS.md boundary 4): pinned classifies providers by SUBSTRING matching on the hostname (host.includes(...)), so chub.ai.attacker.example passes isChub and is treated as chub; only the generic branch is an exact whitelistImportDomains match. That property is inherited and must remain visible in the compat row.',
            }, {
                routes: ['/api/content/importUUID'],
                status: 'not implemented',
                reason: 'importUUID dispatches pygmalion/janitor/AICC/perchance/chub-character/chub-lorebook; all branches need downloaders ported in a later increment.',
            }],
        });
        console.log('Wrote tests/oracle/sillytavern-1.19.0-content.json from pinned importURL behaviour');
    } finally {
        await server.stop();
    }
}

await main();
