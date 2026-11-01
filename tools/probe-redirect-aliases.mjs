#!/usr/bin/env node
// Capture the pinned server's deprecated redirect aliases.
//
// THE PINNED TABLE IS PARSED FROM THE PINNED SOURCE, NOT RETYPED HERE. `redirectDeprecatedEndpoints`
// (src/server-startup.js:69-134) registers 50 `app.use` aliases that answer `res.redirect(308, destination)`.
// If this probe carried its own copy of the pairs, a fixture would be recorded for a mapping nobody
// checked; parsing the pinned file makes the fixture's `aliases` array an ORACLE for the mapping and the
// probe refuse to run if upstream's shape changes.
//
// WHAT IS RECORDED, and why each field is observable to a client:
//   - GET and POST for all 50 aliases: the status, `Location`, body and stable headers. A 301 would turn a
//     POST into a GET, so method preservation is the alias's raison d'etre and both methods are captured.
//   - the deprecation `console.warn` line, because it is the only feedback an operator gets for using an
//     old path (src/server-startup.js:78).
//   - request-shape variants on ONE alias (subpath, trailing slash, non-matching prefix, Accept variants,
//     HEAD) so the mount semantics are pinned rather than assumed: `app.use(src, ...)` is a PREFIX match.
//   - the `:folder` alias's own shape, whose destination contains the literal `:folder` and is NOT
//     interpolated (`/listimgfiles/:folder` -> `/api/images/list/:folder`): the placeholder destination is
//     what the pinned handler actually sends, so it is recorded rather than "fixed".
//   - ZERO outbound requests for every case: an alias is a redirect, and the recording-peer seam makes a
//     route that quietly fetched something visible as a recorded request instead of failing to notice.
//
// @gotavern-oracle: fixture=sillytavern-1.19.0-redirect-aliases.json label="redirect aliases"
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import {
    PINNED_COMMIT, PINNED_VERSION, rawRequest, sha256, stableHeaders, startPinnedProviderServer, writeFixture,
} from './lib/pinned-outbound.mjs';

const sourceRoot = path.resolve(process.argv[2] ?? '');
const repositoryRoot = path.resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3]) {
    console.error('usage: node tools/probe-redirect-aliases.mjs <pinned-source-clone> <gotavern-root>');
    process.exit(2);
}
if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim() !== PINNED_COMMIT) {
    throw new Error(`upstream checkout is not pinned at ${PINNED_COMMIT}`);
}

// The mapping, from the pinned declaration itself.
const aliasSource = readFileSync(path.join(sourceRoot, 'src', 'server-startup.js'), 'utf8').split(/\r?\n/);
const aliases = [];
for (const [index, line] of aliasSource.entries()) {
    const match = /^\s*redirect\('([^']+)',\s*'([^']+)'\);/.exec(line);
    if (match) aliases.push({ source: match[1], destination: match[2], line: index + 1 });
}
if (aliases.length !== 50) {
    throw new Error(`pinned redirectDeprecatedEndpoints declares ${aliases.length} aliases, expected the 50 recorded by the surface gate`);
}
for (const alias of aliases) {
    if (!alias.source.startsWith('/') || !alias.destination.startsWith('/api/')) {
        throw new Error(`unexpected pinned alias shape: ${JSON.stringify(alias)}`);
    }
}

const FIXTURE = 'sillytavern-1.19.0-redirect-aliases.json';
const server = await startPinnedProviderServer({
    sourceRoot,
    prefix: 'gotavern-redirect-alias-oracle-',
});

// `app.use(src, ...)` matches the mount path AND every subpath, so a request path needs a concrete value
// for a parameterised source. The placeholder is replaced for the REQUEST only; the recorded mapping keeps
// the pinned spelling.
const requestPathFor = source => source.replace(/:[A-Za-z0-9_]+/g, 'alpha');

const cases = [];
let logCursor = server.logs.join('').length;
const DEPRECATION = 'is deprecated; use ';

const flushWarnings = async (expected) => {
    const deadline = Date.now() + 2000;
    let text = '';
    while (Date.now() < deadline) {
        text = server.logs.join('').slice(logCursor);
        if (text.includes(DEPRECATION)) break;
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    logCursor = server.logs.join('').length;
    const warnings = text.split('\n').map(line => line.trim()).filter(line => line.includes(DEPRECATION));
    if (expected && warnings.length === 0) {
        throw new Error(`expected a deprecation console.warn line, saw none; tail: ${JSON.stringify(server.logs.join('').slice(-500))}`);
    }
    return warnings;
};

const record = async (name, { method = 'GET', requestPath, query = null, accept = null, body = undefined }) => {
    if (cases.some(entry => entry.name === name)) throw new Error(`duplicate case name ${name}`);
    const headers = { Cookie: server.session.cookie };
    if (method !== 'GET' && method !== 'HEAD') headers['X-CSRF-Token'] = server.session.csrfToken;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (accept !== null) headers.Accept = accept;
    const url = `${server.origin}${requestPath}${query ? `?${query}` : ''}`;
    const result = await rawRequest(url, method, headers, body);
    const outbound = server.outbound();
    if (outbound.length !== 0) {
        throw new Error(`${name}: an alias redirect made an outbound request: ${JSON.stringify(outbound)}`);
    }
    const warnings = await flushWarnings(result.response.status === 308);
    cases.push({
        name,
        request: { method, path: requestPath, query, accept },
        status: result.response.status,
        headers: stableHeaders(result.response),
        body: result.body,
        bodySha256: sha256(result.bytes),
        warnings,
    });
};

for (const alias of aliases) {
    const requestPath = requestPathFor(alias.source);
    await record(`alias#${alias.source}#GET`, { method: 'GET', requestPath, query: 'probe=1' });
    await record(`alias#${alias.source}#POST`, { method: 'POST', requestPath, body: JSON.stringify({ probe: 1 }) });
}

// Mount semantics, captured on one alias whose name cannot collide with a real one: a subpath and a
// trailing slash reach the alias; a longer name does not; the Accept header picks the body format.
await record('mount#subpath', { method: 'GET', requestPath: '/createcharacter/extra' });
await record('mount#trailing_slash', { method: 'GET', requestPath: '/createcharacter/' });
await record('mount#nonmatching_prefix', { method: 'GET', requestPath: '/createcharacterx' });
await record('mount#accept_html', { method: 'GET', requestPath: '/createcharacter', accept: 'text/html' });
await record('mount#accept_json', { method: 'GET', requestPath: '/createcharacter', accept: 'application/json' });
await record('mount#head', { method: 'HEAD', requestPath: '/createcharacter' });
await record('mount#query_with_reserved', { method: 'GET', requestPath: '/createcharacter', query: 'a=1&b=two%20words&c=%2F' });

// The parameterised alias: path-to-regexp 0.1.7 requires a NON-EMPTY folder segment, and the destination's
// `:folder` is a literal because the handler ignores the params.
await record('param#folder', { method: 'GET', requestPath: '/listimgfiles/alpha' });
await record('param#folder_nested', { method: 'GET', requestPath: '/listimgfiles/alpha/beta' });
await record('param#missing_folder', { method: 'GET', requestPath: '/listimgfiles' });
await record('param#empty_folder', { method: 'GET', requestPath: '/listimgfiles/' });

await server.stop();

const fixture = {
    schemaVersion: 1,
    baseline: { version: PINNED_VERSION, commit: PINNED_COMMIT },
    probe: 'pinned deprecated redirect aliases (src/server-startup.js redirectDeprecatedEndpoints): status, Location, body, method preservation, prefix-mount semantics and the deprecation console.warn line',
    normalizations: [
        'The alias mapping is parsed from the pinned source at record time; it is the oracle for the table, not a retyped copy.',
        'Transport headers (connection, date, keep-alive) and the session cookie are excluded: they belong to the recording host or are request inputs.',
        'Each scenario asserts ZERO outbound requests through the recording-peer seam, because a redirect must not fetch anything.',
        'The warning is matched by the pinned sentence fragment "is deprecated; use ", so a Node console write that lands after the response is still waited for (2 s bound) instead of being silently dropped.',
        'Request paths substitute a concrete segment for a parameterised alias source (`/listimgfiles/:folder` -> `/listimgfiles/alpha`); the recorded mapping keeps the pinned spelling.',
    ],
    aliases,
    cases,
    bootOutbound: server.bootOutbound,
};
if (server.bootOutbound.length !== 0) {
    throw new Error(`the pinned boot made outbound requests: ${JSON.stringify(server.bootOutbound)}`);
}
const written = writeFixture(repositoryRoot, FIXTURE, fixture);
console.log(`Wrote ${path.relative(repositoryRoot, written)} (${aliases.length} aliases, ${cases.length} cases)`);
