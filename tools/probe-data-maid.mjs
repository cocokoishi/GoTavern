#!/usr/bin/env node
// Capture the four pinned data-maid routes:
//
//	POST /api/data-maid/report     data-maid.js:673
//	POST /api/data-maid/finalize   data-maid.js:692
//	GET  /api/data-maid/view       data-maid.js:721
//	POST /api/data-maid/delete     data-maid.js:770
//
// WHAT THIS DOMAIN IS, because the name suggests otherwise. `/report` returns JSON
// `{report, token}`, not a ZIP: each record is a sanitized loose file (`name`, `hash` =
// sha256 of the ABSOLUTE path, optional `parent` basename, `size`, `mtime`), and the token is an
// in-memory handle over the unsanitized absolute paths. `/view` serves one of those files by
// hash, `/finalize` drops the token, `/delete` unlinks files the token lists. So the entry-level
// comparison this repository applies to archive-producing routes is applied here to the report's
// RECORDS and to the user tree's files (path, kind, size, sha256) after every step.
//
// TWO OBSERVABLES CANNOT BE RECORDED AS VALUES, AND NEITHER IS `shape`:
//
//   1. The token is 32 random bytes. The fixture records REFERENCES (`<token:report.seeded>`) in
//      requests and a `<token>` marker inside the response body, and asserts the CONSEQUENCES:
//      what a token unlocks, what an unknown/consumed token answers, that minting a token for
//      another handle leaves this handle's token usable, and that a 400 does not consume it.
//   2. Each `hash` is sha256(absolute path), i.e. it contains this host's data root. The fixture
//      records a `<hash:category:parent/name>` marker. The hash RULE is asserted in the replay as
//      a LABELLED source-derived test, because no value for it can cross a host boundary.
//
// NO OUTBOUND. This domain never leaves the process, so the probe asserts the recorded outbound
// count is 0 for every step and fails otherwise. The pinned server still boots under the shared
// egress stub (tools/lib/pinned-outbound.mjs replaces `node-fetch` AND the global `fetch`), so a
// route that unexpectedly fetched would be recorded rather than reaching the internet.
//
// HOST DEPENDENCE, all of it removed on purpose:
//   - report arrays are emitted in DIRECTORY ENUMERATION order, which differs between NTFS and
//     ext4. They are sorted by (name, parent) before recording, and consequently the report's
//     `content-length` and `etag` (digests of that order) are classified `shape` for report steps
//     only. Every other response is byte-comparable and IS compared, ETag included.
//   - seeded files have whole-second mtimes (utimes), so `mtime` is the same integer on any host.
//   - tree snapshots use '/' paths, are sorted, and exclude `stats.json`, whose content is the
//     boot wall-clock timestamp written by pinned startup, not by this domain.
//   - paths, origins and the data root are swept out of the fixture before it is written.
//
// @gotavern-oracle: this declaration is read by tools/build-generated-lib.mjs,
// which auto-discovers probes so that adding one needs no edit there.
// @gotavern-oracle: fixture=sillytavern-1.19.0-data-maid.json label="data maid"

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import {
    PINNED_COMMIT, PINNED_VERSION, rawRequest, stableHeaders, startPinnedProviderServer, writeFixture,
} from './lib/pinned-outbound.mjs';

const sourceRoot = path.resolve(process.argv[2] ?? '');
const repositoryRoot = path.resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3]) {
    console.error('usage: node tools/probe-data-maid.mjs <pinned-source-clone> <gotavern-root>');
    process.exit(2);
}
if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim() !== PINNED_COMMIT) {
    throw new Error(`upstream checkout is not pinned at ${PINNED_COMMIT}`);
}

const COOKIE_SECRET = 'gotavern-pinned-data-maid-cookie-secret';
const FIXED_SECONDS = 1700000000;
const DEFAULT_HANDLE = 'default-user';
const GUEST_HANDLE = 'guest-user';
const GUEST_PASSWORD = 'guest-password';

const CATEGORIES = [
    'images', 'files', 'chats', 'groupChats', 'avatarThumbnails',
    'backgroundThumbnails', 'personaThumbnails', 'chatBackups', 'settingsBackups',
];

// The tree is seeded AFTER boot, exactly as a user's own files would sit next to the directories
// startup creates. Every entry earns its place by being a counterexample to a collector:
// a referenced file must NOT be reported, the matching unreferenced one must be.
const SEED_FILES = [
    // characters: `.png` decides which chat folders are loose; every file name is a "known" avatar.
    ['characters/Alpha.png', 'CHAR-ALPHA'],
    ['characters/Beta.png', 'CHAR-BETA'],
    ['characters/notes.txt', 'not a character card'],
    // chats: Alpha has a character, Orphan does not; a stray file is not a chat folder.
    ['chats/Alpha/alpha-one.jsonl', JSON.stringify({ user_name: 'User', mes: 'look', extra: { image: 'user/images/referenced.png' } }) + '\n'
        + JSON.stringify({ user_name: 'Char', mes: 'and look', extra: { media: [{ url: 'user/images/sub/referenced-two.png' }] } }) + '\n'],
    ['chats/Alpha/alpha-two.jsonl', JSON.stringify({ user_name: 'User', mes: 'file', extra: { files: [{ url: 'user/files/referenced.txt' }] } }) + '\n'
        + JSON.stringify({ user_name: 'Char', mes: 'plain' }) + '\n' + 'not json at all\n'],
    ['chats/Orphan/orphan.jsonl', JSON.stringify({ user_name: 'User', mes: 'orphan' }) + '\n'],
    ['chats/notes.txt', 'not a chat folder'],
    // groups: group-a claims two chat ids; group-loose is claimed by neither.
    ['groups/group-a.json', JSON.stringify({ id: 1, name: 'Group A', chat_id: 'group-known', chats: ['group-other'] })],
    ['groups/unrelated.txt', 'not a group definition'],
    ['group chats/group-known.jsonl', JSON.stringify({ user_name: 'User', mes: 'known' }) + '\n'],
    ['group chats/group-other.jsonl', JSON.stringify({ user_name: 'User', mes: 'other' }) + '\n'],
    ['group chats/group-loose.jsonl', JSON.stringify({ user_name: 'User', mes: 'loose' }) + '\n'],
    // images: referenced top-level and one level down are known; both loose ones must be reported.
    ['user/images/loose-one.png', 'LOOSE-ONE'],
    ['user/images/referenced.png', 'REFERENCED-PNG'],
    ['user/images/sub/nested.png', 'LOOSE-NESTED'],
    ['user/images/sub/referenced-two.png', 'REFERENCED-TWO'],
    // files: `referenced.txt` comes from a chat message, the other two from settings.json.
    ['user/files/loose.bin', 'LOOSE-BINARY'],
    ['user/files/referenced.txt', 'REFERENCED-TEXT'],
    ['user/files/attach.txt', 'ATTACHMENT-TEXT'],
    ['user/files/char-attach.txt', 'CHARACTER-ATTACHMENT'],
    // personas/avatars and the three thumbnail families.
    ['User Avatars/persona-known.png', 'PERSONA-KNOWN'],
    ['User Avatars/persona-orphan.png', 'PERSONA-ORPHAN'],
    ['backgrounds/bg-known.jpg', 'BACKGROUND-KNOWN'],
    ['thumbnails/avatar/Alpha.png', 'THUMB-AVATAR-KNOWN'],
    ['thumbnails/avatar/gone.png', 'THUMB-AVATAR-LOOSE'],
    ['thumbnails/bg/bg-known.jpg', 'THUMB-BG-KNOWN'],
    ['thumbnails/bg/bg-gone.jpg', 'THUMB-BG-LOOSE'],
    ['thumbnails/persona/persona-known.png', 'THUMB-PERSONA-KNOWN'],
    ['thumbnails/persona/persona-gone.png', 'THUMB-PERSONA-LOOSE'],
    // backups: only the `chat_` prefix and THIS handle's `settings_` prefix are reported.
    ['backups/chat_2025-01-01.json', '{"mes":"chat backup"}'],
    ['backups/settings_default-user_2025-01-01.json', '{"settings":"this user"}'],
    ['backups/settings_other-user_2025-01-01.json', '{"settings":"another user"}'],
    ['backups/ordinary.txt', 'neither a chat nor a settings backup'],
    // settings.json makes two of the files above "known" without any chat referencing them.
    ['settings.json', JSON.stringify({
        extension_settings: {
            attachments: [{ url: 'user/files/attach.txt' }],
            character_attachments: { Alpha: [{ url: 'user/files/char-attach.txt' }] },
        },
    })],
];

function sha256(value) {
    return createHash('sha256').update(value).digest('hex');
}

function seedTree(userRoot) {
    for (const [relative, content] of SEED_FILES) {
        const target = path.join(userRoot, ...relative.split('/'));
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, content);
        utimesSync(target, FIXED_SECONDS, FIXED_SECONDS);
    }
}

// `stats.json` is pinned startup's boot timestamp, not this domain's data: its bytes differ on
// every boot, so the snapshot excludes it BY NAME and the exclusion is asserted rather than
// assumed (the replay applies the same list and also refuses to run if the file is missing).
const VOLATILE_TREE_FILES = ['stats.json'];

function snapshotTree(root) {
    const entries = [];
    const walk = (directory, relative) => {
        let names;
        try {
            names = readdirSync(directory);
        } catch {
            return;
        }
        names.sort();
        for (const name of names) {
            const absolute = path.join(directory, name);
            const child = relative === '' ? name : `${relative}/${name}`;
            if (VOLATILE_TREE_FILES.includes(child)) continue;
            const info = statSync(absolute);
            if (info.isDirectory()) {
                entries.push({ path: child, kind: 'directory', size: 0, sha256: null });
                walk(absolute, child);
            } else {
                const content = readFileSync(absolute);
                entries.push({ path: child, kind: 'file', size: content.length, sha256: sha256(content) });
            }
        }
    };
    walk(root, '');
    entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
    return entries;
}

function identityOf(category, record) {
    return category === 'images' || category === 'chats'
        ? `${record.parent ?? ''}/${record.name}`
        : record.name;
}

function hashReference(category, record) {
    return `<hash:${category}:${identityOf(category, record)}>`;
}

// Normalizes a report body into what the fixture records: every hash replaced by an
// identity marker, the token replaced by `<token>`, and each array sorted so the recording does
// not depend on the filesystem's enumeration order.
function normalizeReportBody(body) {
    const report = {};
    for (const category of CATEGORIES) {
        const records = (body.report[category] ?? []).map(record => {
            const ordered = { name: record.name, hash: hashReference(category, record) };
            if (record.parent !== undefined) ordered.parent = record.parent;
            if (record.size !== undefined) ordered.size = record.size;
            if (record.mtime !== undefined) ordered.mtime = record.mtime;
            return ordered;
        });
        records.sort((left, right) => {
            const leftKey = `${left.parent ?? ''}\u0000${left.name}`;
            const rightKey = `${right.parent ?? ''}\u0000${right.name}`;
            return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
        });
        report[category] = records;
    }
    return { report, token: '<token>' };
}

const steps = [];
const addStep = step => steps.push(step);

// A helper for the common "report step" tooling: which refs a request uses.
const tokenRef = name => `<token:${name}>`;
const hashRef = (name, category, identity) => `<hash:${name}:${category}:${identity}>`;
const literal = value => `<literal:${value}>`;

addStep({
    name: 'report.seeded',
    method: 'POST',
    route: '/api/data-maid/report',
    session: 'default',
    description: 'mints a token over the seeded tree; every collector reports its loose files and not the referenced ones',
});
addStep({
    name: 'view.looseImage',
    method: 'GET',
    route: '/api/data-maid/view',
    session: 'default',
    query: { token: tokenRef('report.seeded'), hash: hashRef('report.seeded', 'images', 'images/loose-one.png') },
    description: 'the token addresses a file by hash and the bytes come back with the mime-types type',
});
addStep({
    name: 'view.unknownExtension',
    method: 'GET',
    route: '/api/data-maid/view',
    session: 'default',
    query: { token: tokenRef('report.seeded'), hash: hashRef('report.seeded', 'files', 'loose.bin') },
    description: 'a known mime type (.bin) is served as application/octet-stream, not as text/plain',
});
addStep({
    name: 'view.chatJsonl',
    method: 'GET',
    route: '/api/data-maid/view',
    session: 'default',
    query: { token: tokenRef('report.seeded'), hash: hashRef('report.seeded', 'chats', 'Orphan/orphan.jsonl') },
    description: 'mime-types has no .jsonl entry, so the pinned `|| text/plain` fallback answers without a charset',
});
addStep({
    name: 'view.unknownHash',
    method: 'GET',
    route: '/api/data-maid/view',
    session: 'default',
    query: { token: tokenRef('report.seeded'), hash: literal('0000000000000000000000000000000000000000000000000000000000000000') },
    description: 'a hash the token does not cover is 404, which is distinct from the 403 of a bad token',
});
addStep({
    name: 'view.missingQuery',
    method: 'GET',
    route: '/api/data-maid/view',
    session: 'default',
    query: {},
    description: 'neither query member present is 400, before any token lookup',
});
addStep({
    name: 'view.emptyToken',
    method: 'GET',
    route: '/api/data-maid/view',
    session: 'default',
    query: { token: literal(''), hash: hashRef('report.seeded', 'images', 'images/loose-one.png') },
    description: 'an empty token is falsy in JS, so this is 400 rather than the 403 of an unknown token',
});
addStep({
    name: 'view.duplicateToken',
    method: 'GET',
    route: '/api/data-maid/view',
    session: 'default',
    duplicateQuery: { token: tokenRef('report.seeded') },
    query: { hash: hashRef('report.seeded', 'images', 'images/loose-one.png') },
    description: 'Express turns a repeated query key into an array, and the pinned `.toString()` joins it with "," — so the token no longer matches: 403',
});
addStep({
    name: 'view.duplicateHash',
    method: 'GET',
    route: '/api/data-maid/view',
    session: 'default',
    duplicateQuery: { hash: hashRef('report.seeded', 'images', 'images/loose-one.png') },
    query: { token: tokenRef('report.seeded') },
    description: 'the same join on the hash reaches the token and then misses the path list: 404, which is the 403/404 split between token and hash',
});
addStep({
    name: 'view.unknownToken',
    method: 'GET',
    route: '/api/data-maid/view',
    session: 'default',
    query: { token: literal('ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'), hash: hashRef('report.seeded', 'images', 'images/loose-one.png') },
    description: 'an unknown token is 403, and the hash being real changes nothing',
});
addStep({
    name: 'finalize.missingToken',
    method: 'POST',
    route: '/api/data-maid/finalize',
    session: 'default',
    body: {},
    description: 'a body without a token is 400',
});
addStep({
    name: 'view.afterFailedFinalize',
    method: 'GET',
    route: '/api/data-maid/view',
    session: 'default',
    query: { token: tokenRef('report.seeded'), hash: hashRef('report.seeded', 'images', 'images/loose-one.png') },
    description: 'a rejected finalize does not consume the token: the same view still answers 200',
});
addStep({
    name: 'finalize.unknownToken',
    method: 'POST',
    route: '/api/data-maid/finalize',
    session: 'default',
    body: { token: literal('ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff') },
    description: 'an unknown token is 403',
});
addStep({
    name: 'finalize.ok',
    method: 'POST',
    route: '/api/data-maid/finalize',
    session: 'default',
    body: { token: tokenRef('report.seeded') },
    description: '204 with the pinned 204 framing (no content-type or length, ETag of "No Content")',
});
addStep({
    name: 'view.afterFinalize',
    method: 'GET',
    route: '/api/data-maid/view',
    session: 'default',
    query: { token: tokenRef('report.seeded'), hash: hashRef('report.seeded', 'images', 'images/loose-one.png') },
    description: 'finalize really removed the token: the same view is now 403',
});
addStep({
    name: 'delete.afterFinalize',
    method: 'POST',
    route: '/api/data-maid/delete',
    session: 'default',
    body: { token: tokenRef('report.seeded'), hashes: [hashRef('report.seeded', 'images', 'images/loose-one.png')] },
    description: 'delete with a consumed token is 403 and removes nothing',
});
addStep({
    name: 'report.second',
    method: 'POST',
    route: '/api/data-maid/report',
    session: 'default',
    description: 'a second report; the consumed token is gone and this one replaces it',
});
addStep({
    name: 'delete.missingHashes',
    method: 'POST',
    route: '/api/data-maid/delete',
    session: 'default',
    body: { token: tokenRef('report.second') },
    description: 'the shape guard (400) runs before the token lookup',
});
addStep({
    name: 'delete.hashesNotArray',
    method: 'POST',
    route: '/api/data-maid/delete',
    session: 'default',
    body: { token: tokenRef('report.second'), hashes: 'abc' },
    description: 'a non-array hashes member is 400',
});
addStep({
    name: 'delete.emptyHashes',
    method: 'POST',
    route: '/api/data-maid/delete',
    session: 'default',
    body: { token: tokenRef('report.second'), hashes: [] },
    description: 'an empty hashes array is 400',
});
addStep({
    name: 'delete.unknownHashSkipped',
    method: 'POST',
    route: '/api/data-maid/delete',
    session: 'default',
    body: { token: tokenRef('report.second'), hashes: [literal('0000000000000000000000000000000000000000000000000000000000000000')] },
    description: 'a hash the token does not cover is silently skipped and the answer is still 204',
});
addStep({
    name: 'delete.ok',
    method: 'POST',
    route: '/api/data-maid/delete',
    session: 'default',
    body: { token: tokenRef('report.second'), hashes: [hashRef('report.second', 'images', 'images/loose-one.png')] },
    description: '204 and the tree loses exactly that one file',
});
addStep({
    name: 'view.deletedFile',
    method: 'GET',
    route: '/api/data-maid/view',
    session: 'default',
    query: { token: tokenRef('report.second'), hash: hashRef('report.second', 'images', 'images/loose-one.png') },
    description: 'the token still lists the path but the file is gone: 404, not 500',
});
addStep({
    name: 'report.afterDelete',
    method: 'POST',
    route: '/api/data-maid/report',
    session: 'default',
    description: 'the deleted image no longer appears in a fresh report',
});
addStep({
    name: 'view.guestCannotUseToken',
    method: 'GET',
    route: '/api/data-maid/view',
    session: 'guest',
    query: { token: tokenRef('report.afterDelete'), hash: hashRef('report.afterDelete', 'images', 'sub/nested.png') },
    description: `a token belongs to the handle that minted it: the ${GUEST_HANDLE} session gets 403`,
});
addStep({
    name: 'finalize.guestCannotUseToken',
    method: 'POST',
    route: '/api/data-maid/finalize',
    session: 'guest',
    body: { token: tokenRef('report.afterDelete') },
    description: 'the same gate on finalize, so a borrow attempt cannot destroy the owner\'s token',
});
addStep({
    name: 'delete.guestCannotUseToken',
    method: 'POST',
    route: '/api/data-maid/delete',
    session: 'guest',
    body: { token: tokenRef('report.afterDelete'), hashes: [hashRef('report.afterDelete', 'images', 'sub/nested.png')] },
    description: 'and on delete, the destructive route: 403 and nothing removed',
});
addStep({
    name: 'report.guest',
    method: 'POST',
    route: '/api/data-maid/report',
    session: 'guest',
    description: 'a handle whose user directories were never created gets empty arrays, not a 500',
});
addStep({
    name: 'view.defaultTokenSurvivesGuestMint',
    method: 'GET',
    route: '/api/data-maid/view',
    session: 'default',
    query: { token: tokenRef('report.afterDelete'), hash: hashRef('report.afterDelete', 'images', 'sub/nested.png') },
    description: 'generateToken only replaces tokens of the SAME handle, so the guest mint left this one valid',
});

function resolveReference(reference, state) {
    const match = /^<token:(.+?)>$/.exec(reference);
    if (match) {
        const token = state.minted.get(match[1]);
        if (!token) throw new Error(`probe defect: no token was minted by step ${match[1]}`);
        return token;
    }
    const hashMatch = /^<hash:([^:]+):([a-z]+):(.*)>$/.exec(reference);
    if (hashMatch) {
        const [, stepName, category, identity] = hashMatch;
        const report = state.reports.get(stepName);
        if (!report) throw new Error(`probe defect: no report was minted by step ${stepName}`);
        const record = (report[category] ?? []).find(entry => identityOf(category, entry) === identity);
        if (!record) throw new Error(`probe defect: ${stepName} has no ${category} record ${identity}`);
        return record.hash;
    }
    const literalMatch = /^<literal:(.*)>$/.exec(reference);
    if (literalMatch) return literalMatch[1];
    return reference;
}

function resolveBody(value, state) {
    if (typeof value === 'string') return resolveReference(value, state);
    if (Array.isArray(value)) return value.map(item => resolveBody(item, state));
    if (value !== null && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveBody(item, state)]));
    }
    return value;
}

async function main() {
    const server = await startPinnedProviderServer({ sourceRoot, prefix: 'gotavern-data-maid-oracle-', mocks: [] });
    try {
        if (server.bootOutbound.length !== 0) {
            throw new Error(`pinned boot made ${server.bootOutbound.length} outbound requests; this probe requires zero`);
        }
        seedTree(server.userRoot);
        const initialTree = snapshotTree(server.userRoot);

        // A second account, created through the pinned route, is what makes the per-handle token
        // gate observable. Its own answer is a PRECONDITION, never recorded.
        const created = await server.post('/api/users/create', JSON.stringify({
            handle: GUEST_HANDLE, name: 'Guest User', password: GUEST_PASSWORD, admin: false, enabled: true, salt: '',
        }));
        if (created.response.status !== 200) {
            throw new Error(`could not create ${GUEST_HANDLE}: ${created.response.status} ${created.text}`);
        }
        const guestCsrf = await rawRequest(`${server.origin}/csrf-token`);
        const guestCookieSeed = guestCsrf.response.headers.getSetCookie().map(cookie => cookie.split(';', 1)[0]).join('; ');
        const guestLogin = await rawRequest(`${server.origin}/api/users/login`, 'POST', {
            Cookie: guestCookieSeed, 'Content-Type': 'application/json', 'X-CSRF-Token': guestCsrf.body.token,
        }, JSON.stringify({ handle: GUEST_HANDLE, password: GUEST_PASSWORD }));
        if (guestLogin.response.status !== 200) {
            throw new Error(`could not log in ${GUEST_HANDLE}: ${guestLogin.response.status} ${guestLogin.text}`);
        }
        const sessions = {
            default: { cookie: server.session.cookie, csrfToken: server.session.csrfToken },
            guest: {
                cookie: guestLogin.response.headers.getSetCookie().map(cookie => cookie.split(';', 1)[0]).join('; '),
                csrfToken: guestCsrf.body.token,
            },
        };
        server.outbound();

        const state = { minted: new Map(), reports: new Map() };
        const recordedSteps = [];
        for (const step of steps) {
            const session = sessions[step.session];
            const url = new URL(`${server.origin}${step.route}`);
            if (step.query) {
                for (const [name, value] of Object.entries(step.query)) {
                    url.searchParams.set(name, resolveReference(value, state));
                }
            }
            if (step.duplicateQuery) {
                // The SAME key sent twice: Express turns a repeated query key into an array and the
                // pinned handler calls `.toString()`, which joins it with ",".
                for (const [name, value] of Object.entries(step.duplicateQuery)) {
                    const resolved = resolveReference(value, state);
                    url.searchParams.append(name, resolved);
                    url.searchParams.append(name, resolved);
                }
            }
            const headers = { Cookie: session.cookie };
            // A POST needs the CSRF token even when it carries no body: /report reads nothing from
            // the request, but the global csrf middleware runs first and a missing token is a 403.
            if (step.method !== 'GET') headers['X-CSRF-Token'] = session.csrfToken;
            let bodyText;
            if (step.body !== undefined) {
                bodyText = JSON.stringify(resolveBody(step.body, state));
                headers['Content-Type'] = 'application/json';
            }
            const result = await rawRequest(url.href, step.method, headers, bodyText);
            if (step.route === '/api/data-maid/report' && (result.response.status !== 200 || typeof result.body?.token !== 'string' || result.body.token.length !== 64)) {
                throw new Error(`${step.name}: /report answered ${result.response.status} with no 64-character token: ${result.text.slice(0, 400)}`);
            }
            const outbound = server.outbound();
            if (outbound.length !== 0) {
                throw new Error(`${step.name}: the route made ${outbound.length} outbound request(s): ${JSON.stringify(outbound.map(entry => entry.url))}`);
            }

            let parsedBody = null;
            if (result.text !== '') {
                try {
                    parsedBody = JSON.parse(result.text);
                } catch {
                    parsedBody = null;
                }
            }

            const response = {
                status: result.response.status,
                headers: stableHeaders(result.response),
                bodyKind: 'bytes',
                body: null,
                bodyBase64: result.bytes.toString('base64'),
                bodySha256: sha256(result.bytes),
                bodyLength: result.bytes.length,
            };
            let comparison = {
                compared: ['status', 'headers', 'bodyBase64', 'bodySha256', 'bodyLength', 'tree', 'outbound'],
                shape: [],
                shapeReason: {},
            };
            // Only /report answers a JSON OBJECT that must be normalized. A body that merely happens
            // to parse as JSON — a chat file `/view` served, say — is still bytes, and recording it
            // as structure would let a formatting difference pass as equal.
            if (step.route === '/api/data-maid/report') {
                state.reports.set(step.name, parsedBody.report);
                state.minted.set(step.name, parsedBody.token);
                response.bodyKind = 'json';
                response.body = normalizeReportBody(parsedBody);
                response.bodyBase64 = null;
                response.bodySha256 = null;
                response.bodyLength = null;
                // content-length and etag are digests of a body whose ARRAY ORDER is the
                // filesystem's enumeration order, which differs between hosts. They are derived
                // from the recorded (sorted) body, so they are recorded as null (rule 18) with the
                // reason below, rather than with the observed value.
                response.headers['content-length'] = null;
                response.headers['etag'] = null;
                comparison = {
                    compared: ['status', 'headers', 'body', 'tree', 'outbound'],
                    shape: ['headers.content-length', 'headers.etag', 'bodyBase64', 'bodySha256', 'bodyLength'],
                    shapeReason: {
                        'headers.content-length': 'content-length measures the report body, whose array order is directory enumeration order (NTFS != ext4); the fixture records the arrays sorted',
                        'headers.etag': 'the ETag is a digest of the report body and therefore of the enumeration order, which is host-dependent',
                        bodyBase64: 'the report body cannot be recorded verbatim: it carries the random token and one sha256 of an absolute path per record',
                        bodySha256: 'a digest of the verbatim report body, which contains the token and absolute-path hashes',
                        bodyLength: 'the length of the verbatim report body, which is only meaningful with the unsorted arrays',
                    },
                };
            }
            recordedSteps.push({
                name: step.name,
                description: step.description,
                request: {
                    method: step.method,
                    route: step.route,
                    session: step.session,
                    query: step.query ?? null,
                    duplicateQuery: step.duplicateQuery ?? null,
                    body: step.body ?? null,
                },
                response,
                tree: snapshotTree(server.userRoot),
                outbound: 0,
                comparison,
            });
        }

        // The probe's own invariants: the token must never be recorded, an entry must stay an
        // entry (not a deletion), and the last steps must still be exercising a live token.
        const finalTree = recordedSteps[recordedSteps.length - 1].tree;
        if (finalTree.length >= initialTree.length) {
            throw new Error('probe defect: /delete removed nothing, so the tree assertions cannot fail');
        }

        const fixture = {
            schemaVersion: 1,
            baseline: { version: PINNED_VERSION, commit: PINNED_COMMIT },
            probe: 'pinned /api/data-maid report, finalize, view and delete (JSON report + in-memory token over absolute paths)',
            oracle: {
                file: 'src/endpoints/data-maid.js',
                helpers: [
                    'DataMaidService collectors (:90-669)',
                    'src/util.js isPathUnderParent, tryParse',
                    'src/endpoints/chats.js:32 CHAT_BACKUPS_PREFIX',
                    'src/endpoints/settings.js:88 getSettingsBackupFilePrefix',
                    'mime-types lookup (src/endpoints/data-maid.js:5,761)',
                ],
            },
            conventions: {
                orderedSteps: 'steps is an ARRAY and MUST be replayed in order: every step shares one user tree and one token store, so a keyed map would desynchronise every later snapshot while still passing',
                tokens: 'the token is 32 random bytes and is never recorded: requests carry a <token:STEP> reference, the report body carries <token>, and the CONSEQUENCES are asserted (what it unlocks, what an unknown/consumed cross-handle token answers, that a 400 does not consume it)',
                hashes: 'each record hash is sha256 of an ABSOLUTE path, so the fixture records <hash:CATEGORY:IDENTITY> and the replay substitutes its own hash for the same identity. The hash RULE is a labelled source-derived assertion in the replay.',
                reportArrays: 'report arrays are sorted by (parent, name) before recording because pinned emits directory enumeration order; report content-length and ETag are therefore shape-classified and not recorded',
                tree: 'the whole user root after every step, with / paths, sorted, excluding stats.json (pinned startup writes the boot wall-clock timestamp there, not this domain)',
                outbound: 'this domain never leaves the process; every step asserts 0 outbound requests, and the pinned server boots under the shared egress stub (node-fetch AND global fetch replaced)',
                mtime: 'seeded files carry a whole-second mtime (utimes 1700000000), so mtime is the same integer on every host',
            },
            fixtureFields: {
                readOnce: ['inputs.account', 'inputs.guest', 'inputs.seedFiles', 'inputs.fixedMtimeSeconds', 'inputs.volatileTreeFiles'],
                compared: ['steps[].response.status', 'steps[].response.headers', 'steps[].response.body', 'steps[].response.bodyBase64', 'steps[].response.bodySha256', 'steps[].response.bodyLength', 'steps[].tree', 'steps[].outbound'],
                shape: ['steps[].response.headers.content-length (report steps)', 'steps[].response.headers.etag (report steps)', 'steps[].response.bodyBase64/bodySha256/bodyLength (report steps)'],
            },
            inputs: {
                cookieSecret: COOKIE_SECRET,
                fixedMtimeSeconds: FIXED_SECONDS,
                volatileTreeFiles: VOLATILE_TREE_FILES,
                account: { handle: DEFAULT_HANDLE, name: 'Data Maid Probe', admin: true, password: '' },
                guest: { handle: GUEST_HANDLE, name: 'Guest User', admin: false, password: GUEST_PASSWORD, salt: 'data-maid-guest-salt' },
                seedFiles: SEED_FILES.map(([relative, content]) => ({
                    path: relative,
                    bytesBase64: Buffer.from(content, 'utf8').toString('base64'),
                })),
            },
            steps: recordedSteps,
            knownDifferences: [],
        };

        // Refuse to write a fixture that carries anything host-derived. The sweep is over the
        // SERIALIZED fixture, so it covers bodies, headers and targets at once.
        const text = JSON.stringify(fixture, null, 2);
        const forbidden = [
            ...state.minted.values(),
            path.resolve(server.userRoot),
            server.origin,
            '127.0.0.1',
            'C:\\',
            'AppData',
            '/tmp/',
            '/home/',
            '/Users/',
            'gotavern-data-maid-oracle-',
        ];
        for (const value of forbidden) {
            if (value && text.includes(value)) {
                throw new Error(`fixture would record host-derived value ${JSON.stringify(value)}`);
            }
        }
        for (const [stepName, report] of state.reports) {
            for (const category of CATEGORIES) {
                for (const record of report[category] ?? []) {
                    if (text.includes(record.hash)) {
                        throw new Error(`fixture would record the absolute-path hash of ${stepName}/${category}/${record.name}`);
                    }
                }
            }
        }

        writeFixture(repositoryRoot, 'sillytavern-1.19.0-data-maid.json', fixture);
        console.log(`Wrote tests/oracle/sillytavern-1.19.0-data-maid.json with ${recordedSteps.length} ordered steps`);
    } finally {
        await server.stop();
    }
}

await main();
