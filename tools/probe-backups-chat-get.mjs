#!/usr/bin/env node
// Capture the pinned chat-backup listing route:
//
//	POST /api/backups/chat/get  backups.js:9
//
// The route enumerates `<user>/backups`, keeps only entries that are FILES whose extension is
// exactly `.jsonl` and whose name starts with CHAT_BACKUPS_PREFIX ("chat_"), and builds one
// `getChatInfo` record per file (src/endpoints/chats.js:393). Three things make this a route that
// needs an oracle rather than a reading:
//
//   - `getChatInfo` is a SHARED helper with four branches (empty file, valid last line, degraded
//     last line, vanished file), and two of them set `chat_items` by different arithmetic;
//   - `file_size` is `formatBytes`, i.e. the `bytes` package's own formatting;
//   - `last_mes` is the last line's `send_date` when there is one and the file's MTIME otherwise,
//     which is why every seeded file gets a fixed whole-second mtime.
//
// The seeded tree is deliberately dense: one file per branch of the helper, plus the four
// exclusion cases (wrong extension, uppercase extension, non-prefix name, a DIRECTORY named like a
// backup), so the filter is asserted rather than assumed.
//
// The steps are ORDERED DATA: the second listing exists to observe the first deletion, so the
// fixture stores them as an array and the replay iterates them in recorded order.
//
// No outbound request is expected from any step, and the pinned process runs with node-fetch AND
// the global fetch replaced (tools/lib/pinned-outbound.mjs), so "zero outbound" is asserted after
// every single step instead of being assumed.
//
// HOST-DEPENDENCE: every seeded file has mtime 1700000000 (whole seconds), so `last_mes` is a
// constant on every filesystem; the listing's ORDER is readdir order and is therefore normalised
// (elements sorted by file_name) with the raw-byte ETag classified shape; snapshot paths use '/'.
//
// @gotavern-oracle: this declaration is read by tools/build-generated-lib.mjs,
// which auto-discovers probes so that adding one needs no edit there.
// @gotavern-oracle: fixture=sillytavern-1.19.0-backups-chat-get.json label="backups chat/get"

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
    existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import {
    PINNED_COMMIT, PINNED_VERSION, stableHeaders, startPinnedProviderServer, writeFixture,
} from './lib/pinned-outbound.mjs';

const sourceRoot = path.resolve(process.argv[2] ?? '');
const repositoryRoot = path.resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3]) {
    console.error('usage: node tools/probe-backups-chat-get.mjs <pinned-source-clone> <gotavern-root>');
    process.exit(2);
}
if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim() !== PINNED_COMMIT) {
    throw new Error(`upstream checkout is not pinned at ${PINNED_COMMIT}`);
}

const COOKIE_SECRET = 'gotavern-pinned-backups-chat-get-cookie-secret';
const FIXED_SECONDS = 1700000000;
const FIXED_ISO = new Date(FIXED_SECONDS * 1000).toISOString();

function sha256(value) {
    return createHash('sha256').update(value).digest('hex');
}

// The seeded tree. Each entry states which branch of getChatInfo it reaches.
const BIG_MESSAGE = 'y'.repeat(1200);
const SEED = {
    // valid last line carrying a numeric send_date: chat_items = lines - 1, mes = last mes.
    'chat_valid.jsonl': '{"user_name":"u"}\n{"name":"A","mes":"first"}\n{"is_user":true,"name":"B","mes":"latest","send_date":1700000000123}\n',
    // valid last line with NO send_date: last_mes falls back to the mtime, formatted as an ISO string.
    'chat_nosenddate.jsonl': '{"user_name":"u"}\n{"character_name":"C","mes":"no date"}\n',
    // degraded: the last line parses but carries no name/character_name/chat_metadata.
    'chat_alpha.jsonl': '{"user_name":"u"}\n{"mes":"a"}\n{"mes":"b"}\n',
    // degraded: the last line does not parse at all (a truncated write).
    'chat_badlast.jsonl': '{"user_name":"u"}\n{"mes":"a"}\n{"mes":"b"}\n{"name":\n',
    // empty file: the early return, so match stays false and mes is the empty-chat sentinel.
    'chat_empty.jsonl': '',
    // >1 KiB, so formatBytes leaves the "B" unit.
    'chat_big.jsonl': `{"user_name":"u"}\n{"name":"D","mes":"${BIG_MESSAGE}","send_date":"2024-05-05T00:00:00.000Z"}\n`,
    // CRLF framing: readline treats \r\n as one terminator.
    'chat_crlf.jsonl': '{"user_name":"u"}\r\n{"name":"E","mes":"crlf","send_date":"2024-06-06T00:00:00.000Z"}\r\n',
    // EXCLUDED: uppercase extension (path.extname is case-sensitive).
    'chat_upper.JSONL': '{"user_name":"u"}\n{"mes":"never listed"}\n',
    // EXCLUDED: does not start with the "chat_" prefix.
    'other.jsonl': '{"user_name":"u"}\n{"mes":"never listed"}\n',
    // EXCLUDED: not a .jsonl file.
    'note.txt': 'note\n',
};

function seedTree(userRoot) {
    const backups = path.join(userRoot, 'backups');
    mkdirSync(backups, { recursive: true });
    for (const [name, content] of Object.entries(SEED)) {
        const target = path.join(backups, name);
        writeFileSync(target, content);
        utimesSync(target, FIXED_SECONDS, FIXED_SECONDS);
    }
    // EXCLUDED: a DIRECTORY named like a backup file (readdir withFileTypes + isFile()).
    mkdirSync(path.join(backups, 'chat_dir.jsonl'), { recursive: true });
    writeFileSync(path.join(backups, 'chat_dir.jsonl', 'inside.jsonl'), '{"mes":"inside"}\n');
    utimesSync(path.join(backups, 'chat_dir.jsonl', 'inside.jsonl'), FIXED_SECONDS, FIXED_SECONDS);
}

function snapshotTree(root) {
    const entries = [];
    const walk = (absolute, relative) => {
        if (!existsSync(absolute)) return;
        for (const name of readdirSync(absolute).sort()) {
            const childAbsolute = path.join(absolute, name);
            const childRelative = relative === '' ? name : `${relative}/${name}`;
            const info = statSync(childAbsolute);
            if (info.isDirectory()) {
                entries.push({ path: childRelative, kind: 'directory', size: 0, sha256: null });
                walk(childAbsolute, childRelative);
            } else {
                const content = readFileSync(childAbsolute);
                entries.push({ path: childRelative, kind: 'file', size: content.length, sha256: sha256(content) });
            }
        }
    };
    walk(root, '');
    return entries;
}

// The listing order is readdir order, so the recorded array is sorted by file_name: a host
// INDEPENDENT property of the scenario (a listing of several entries) decides the ETag
// classification, and the key order of every object is recorded separately because it is NOT
// host-dependent (it is the pinned object literal's insertion order).
function recordBody(result, orderFree) {
    const text = result.text;
    let body = null;
    if (text.trim() !== '' && text.trim().startsWith('[')) {
        body = JSON.parse(text);
        body.sort((left, right) => {
            const leftName = String(left.file_name);
            const rightName = String(right.file_name);
            // Code-point order, not localeCompare: the replay must reproduce it with plain byte
            // comparison, and a collation-dependent order would not be reproducible at all.
            return leftName < rightName ? -1 : leftName > rightName ? 1 : 0;
        });
    }
    const keyOrderByName = {};
    for (const entry of body ?? []) {
        if (entry && typeof entry === 'object') keyOrderByName[String(entry.file_name)] = Object.keys(entry);
    }
    return { body, bodyText: body === null ? text : null, keyOrderByName, orderFree };
}

async function main() {
    const server = await startPinnedProviderServer({ sourceRoot, prefix: 'gotavern-backups-chat-get-oracle-', mocks: [] });
    try {
        if (server.bootOutbound.length !== 0) {
            throw new Error(`pinned startup made ${server.bootOutbound.length} outbound requests, so zero-outbound assertions would be meaningless`);
        }
        seedTree(server.userRoot);
        if (server.outbound().length !== 0) {
            throw new Error('seeding produced an outbound request');
        }
        const backupsRoot = path.join(server.userRoot, 'backups');
        const steps = [];

        const record = async (name, route, body, options = {}) => {
            if (options.prepare) options.prepare();
            const result = await server.post(`/api/backups/chat/${route}`, JSON.stringify(body ?? {}));
            const stray = server.outbound();
            if (stray.length !== 0) {
                throw new Error(`${name}: the pinned route made ${stray.length} outbound requests; this route must make none (${stray.map(request => request.url).join(', ')})`);
            }
            const headers = stableHeaders(result.response);
            const isListing = (headers['content-type'] ?? '').includes('application/json');
            const orderFree = options.orderFree ?? !isListing;
            const recorded = recordBody(result, orderFree);
            if (!orderFree) {
                // The ETag hashes the raw body bytes in readdir order, which differs between NTFS
                // and ext4, so it is a property of the recording host and records NO value.
                delete headers.etag;
            }
            const comparison = {
                compared: orderFree
                    ? ['status', 'headers', 'body', 'bodyText', 'bodyLength']
                    : ['status', 'headers', 'body', 'bodyLength', 'keyOrderByName'],
                shape: orderFree ? [] : ['etag', 'body order'],
                shapeReason: orderFree ? {} : {
                    etag: 'the ETag hashes the raw body bytes in readdir order, which differs between NTFS and ext4; it records no value',
                    'body order': 'the listing is built in readdir order; the fixture records the set sorted by file_name and the replay sorts its own answer the same way',
                },
            };
            steps.push({
                name,
                route,
                body: body ?? {},
                // The tree precondition a step needs, declared as DATA so the replay executes it
                // instead of inferring it from a snapshot: the missing-directory branch only answers
                // 500 because the directory was really removed, and a replay that skipped the removal
                // would answer 200 [] and pass for the wrong reason.
                prepare: options.prepareName ?? null,
                response: {
                    status: result.response.status,
                    headers,
                    body: recorded.body,
                    bodyText: recorded.bodyText,
                    bodyLength: result.bytes.length,
                    keyOrderByName: recorded.keyOrderByName,
                    comparison,
                },
                state: { backups: snapshotTree(backupsRoot) },
            });
        };

        await record('chat.get.seeded', 'get', {});
        await record('chat.delete.valid', 'delete', { name: 'chat_valid.jsonl' });
        await record('chat.get.afterDelete', 'get', {});
        await record('chat.delete.alpha', 'delete', { name: 'chat_alpha.jsonl' });
        await record('chat.delete.empty', 'delete', { name: 'chat_empty.jsonl' });
        await record('chat.delete.noSendDate', 'delete', { name: 'chat_nosenddate.jsonl' });
        await record('chat.delete.badLast', 'delete', { name: 'chat_badlast.jsonl' });
        await record('chat.delete.big', 'delete', { name: 'chat_big.jsonl' });
        await record('chat.delete.crlf', 'delete', { name: 'chat_crlf.jsonl' });
        await record('chat.get.noBackupsLeft', 'get', {});
        // The last branch: the backups DIRECTORY is gone, so readdir rejects and the route's own
        // catch answers 500. Produced by removing the directory, not by mocking an error.
        await record('chat.get.missingDirectory', 'get', {}, {
            prepare: () => rmSync(backupsRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }),
            prepareName: 'remove-backups-directory',
        });

        const listings = steps.filter(step => (step.response.headers['content-type'] ?? '').includes('application/json'));
        if (listings.length === 0) throw new Error('no step recorded a JSON listing');
        const seeded = steps[0].response.body;
        const afterDelete = steps[2].response.body;
        if (!Array.isArray(seeded) || seeded.length < 5) {
            throw new Error(`the seeded listing recorded ${Array.isArray(seeded) ? seeded.length : 'no'} entries; the seeded tree is not dense enough to prove the filter`);
        }
        if (Array.isArray(afterDelete) && afterDelete.length !== seeded.length - 1) {
            throw new Error(`the listing after one delete has ${afterDelete.length} entries and the seeded one ${seeded.length}; a deletion must be observable`);
        }
        if (steps[9].response.body.length !== 0) {
            throw new Error('the listing after deleting every chat_ file is not empty');
        }
        if (steps[10].response.status !== 500) {
            throw new Error(`a missing backups directory answered ${steps[10].response.status}, expected the pinned catch's 500`);
        }

        writeFixture(repositoryRoot, 'sillytavern-1.19.0-backups-chat-get.json', {
            schemaVersion: 1,
            baseline: { version: PINNED_VERSION, commit: PINNED_COMMIT },
            probe: 'pinned /api/backups/chat/get route, with the sibling delete route used to move the tree between listings',
            oracle: { file: 'src/endpoints/backups.js', helper: 'src/endpoints/chats.js getChatInfo (line 393) + src/util.js formatBytes' },
            mechanism: 'the pinned process runs with node-fetch AND the global fetch replaced by a controlled peer, so every step asserts ZERO outbound requests rather than assuming it',
            conventions: {
                fixedMtimes: `every seeded file has mtime ${FIXED_SECONDS} (whole seconds, ${FIXED_ISO}) so last_mes is a constant on every filesystem`,
                listingOrder: 'the listing is readdir order, so recorded arrays are sorted by file_name and the raw-byte ETag is classified shape with no value; each object\'s KEY ORDER is recorded under keyOrderByName and compared, because it is the pinned object literal\'s order and is host-independent',
                steps: 'the steps are ordered data: the listings exist to observe the deletions before them, so the replay iterates them in recorded order',
                paths: 'snapshot paths use forward slashes and are sorted',
            },
            fixtureFields: {
                compared: ['steps[].response.status', 'steps[].response.headers', 'steps[].response.body (sorted by file_name)', 'steps[].response.bodyText', 'steps[].response.bodyLength', 'steps[].response.keyOrderByName', 'steps[].state.backups (path, kind, size, sha256)', 'zero outbound requests per step'],
                shape: ['steps[].response.headers.etag (listing steps)', 'steps[].response.body order (listing steps)'],
                shapeReason: {
                    'etag': 'the ETag hashes the raw body bytes in readdir order; the value differs between NTFS and ext4, so it is classified shape AND records no value',
                    'body order': 'the listing is built in readdir order; the fixture records the set sorted by file_name and the replay sorts its answer identically',
                },
                notRecorded: ['the pinned server listen port', 'absolute paths', 'startup log'],
            },
            inputs: {
                cookieSecret: COOKIE_SECRET,
                account: { handle: 'default-user', name: 'Chat Journal', admin: true, password: '' },
                fixedMtimeSeconds: FIXED_SECONDS,
                seed: SEED,
                seedDirectories: ['chat_dir.jsonl'],
            },
            steps,
            knownDifferences: [],
        });
        console.log(`Wrote tests/oracle/sillytavern-1.19.0-backups-chat-get.json (${steps.length} ordered steps, 0 outbound requests each)`);
    } finally {
        await server.stop();
    }
}

await main();
