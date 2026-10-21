#!/usr/bin/env node
// @gotavern-oracle: fixture=sillytavern-1.19.0-images.json label="images"
// Probe the pinned /api/images/* routes against the REAL pinned listener.
//
// These four routes are local: they read and write the per-user `user/images` tree and answer from it,
// so the differential is between two servers over the same seeded tree. Two design choices keep the
// fixture host-independent:
//
//   - every seeded file gets a whole-second mtime, so the pinned `date` sort is reproducible (a
//     sub-second mtime would let two files tie and make the observable depend on stat precision);
//   - file state is recorded as a sorted list of relative path, size and SHA-256, never as mtimes or
//     directory sizes, and the folder listing is compared as a sorted set because the pinned
//     `fs.readdirSync` order is filesystem-dependent (NTFS sorts, ext4 does not).
//
// The upload route names an unnamed file `${Date.now()}.${format}`, so those timestamps are replaced
// by a marker in both the response and the recorded tree.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import {
    PINNED_COMMIT, PINNED_VERSION, captureHttp, startPinnedProviderServer, writeFixture,
} from './lib/pinned-outbound.mjs';

const sourceRoot = path.resolve(process.argv[2] ?? '');
const repositoryRoot = path.resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3]) {
    console.error('usage: node tools/probe-images.mjs <pinned-source-clone> <gotavern-root>');
    process.exit(2);
}
if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim() !== PINNED_COMMIT) {
    throw new Error(`upstream checkout is not pinned at ${PINNED_COMMIT}`);
}

// A real 1x1 PNG and a few bytes for the other types: the routes never decode them, they only store
// and list, so the content only needs to be distinguishable.
const PNG_ONE_PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const FILE_BYTES = {
    'alpha.png': PNG_ONE_PIXEL,
    'beta.jpg': Buffer.from('JFIF-gotavern-beta.jpg'),
    'gamma.gif': Buffer.from('GIF89a-gotavern-gamma.gif'),
    'delta.txt': Buffer.from('not a media file'),
    'epsilon.mp4': Buffer.from('mp4-gotavern-epsilon'),
    'zeta.mp3': Buffer.from('ID3-gotavern-zeta'),
    'eta.svg': Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
    'theta.webp': Buffer.from('RIFFgotavern-theta'),
    'nested/inside.png': PNG_ONE_PIXEL,
};
// Distinct whole seconds so the `date` sort is meaningful on every host.
const MTIMES = {
    'alpha.png': 1700000001000,
    'beta.jpg': 1700000002000,
    'gamma.gif': 1700000003000,
    'delta.txt': 1700000004000,
    'epsilon.mp4': 1700000005000,
    'zeta.mp3': 1700000006000,
    'eta.svg': 1700000007000,
    'theta.webp': 1700000008000,
    'nested/inside.png': 1700000009000,
};

const TIMESTAMP_PATTERN = /\b1\d{12}\b/g;
function normalizeTimestamp(value) {
    return typeof value === 'string' ? value.replace(TIMESTAMP_PATTERN, '<timestamp>') : value;
}

function treeState(imagesRoot) {
    const state = [];
    const walk = (relative) => {
        const directory = path.join(imagesRoot, relative);
        if (!existsSync(directory)) return;
        for (const name of readdirSync(directory).sort()) {
            const childRelative = relative ? `${relative}/${name}` : name;
            const absolute = path.join(imagesRoot, childRelative);
            const stats = statSync(absolute);
            if (stats.isDirectory()) {
                state.push({ path: childRelative + '/', kind: 'directory' });
                walk(childRelative);
                continue;
            }
            state.push({
                path: normalizeTimestamp(childRelative),
                kind: 'file',
                bytes: stats.size,
                sha256: createHash('sha256').update(readFileSync(absolute)).digest('hex'),
            });
        }
    };
    walk('');
    return state;
}

function seedTree(imagesRoot) {
    for (const [relative, content] of Object.entries(FILE_BYTES)) {
        const absolute = path.join(imagesRoot, relative);
        mkdirSync(path.dirname(absolute), { recursive: true });
        writeFileSync(absolute, content);
        // utimes takes seconds, so the mtime lands exactly on a whole second.
        const seconds = Math.floor(MTIMES[relative] / 1000);
        utimesSync(absolute, seconds, seconds);
    }
}

const server = await startPinnedProviderServer({ sourceRoot, prefix: 'gotavern-images-oracle-', mocks: [] });
const scenarios = {};
let bootOutbound = [];
try {
    bootOutbound = server.bootOutbound;
    const imagesRoot = path.join(server.userRoot, 'user', 'images');

    const requests = {};
    const record = async (label, route, body) => {
        // Every scenario starts from the same seeded tree, so a mutation in one cannot explain the
        // next one.
        rmTree(imagesRoot);
        seedTree(imagesRoot);
        const result = await server.post(route, body);
        const response = captureHttp(result);
        if (response.body && typeof response.body === 'object') {
            response.body = JSON.parse(normalizeTimestamp(JSON.stringify(response.body)));
        }
        response.bodyText = normalizeTimestamp(result.text);
        // The ETag hashes the RAW body, so an upload whose name carries Date.now() necessarily has a
        // different one per run. It is recorded as a marker and the Go test skips exactly that marker.
        if (result.text !== response.bodyText) {
            response.headers.etag = '<unstable-body>';
        }
        // An unknown sortField falls through getImages' default branch, which returns readdir order.
        // That order is a filesystem property, not endpoint behaviour, so the recorded array is sorted
        // and the field is classified shape in the fixture.
        if (label === 'listUnknownSortField' && Array.isArray(response.body)) {
            response.body = [...response.body].sort();
            response.bodyText = JSON.stringify(response.body);
        }
        const state = treeState(imagesRoot);
        scenarios[label] = {
            route,
            requestBody: body,
            response,
            treeAfter: state,
        };
        requests[label] = response.status;
    };

    // ── /api/images/upload ──────────────────────────────────────────────────────────────────────
    await record('uploadNamed', '/api/images/upload', JSON.stringify({ image: PNG_ONE_PIXEL.toString('base64'), format: 'png', filename: 'custom.png' }));
    await record('uploadUnnamed', '/api/images/upload', JSON.stringify({ image: PNG_ONE_PIXEL.toString('base64'), format: 'png' }));
    await record('uploadCharacterFolder', '/api/images/upload', JSON.stringify({ image: PNG_ONE_PIXEL.toString('base64'), format: 'png', filename: 'char.png', ch_name: 'Alice / Bob' }));
    await record('uploadFilenameExtensionReplaced', '/api/images/upload', JSON.stringify({ image: PNG_ONE_PIXEL.toString('base64'), format: 'jpg', filename: 'picture.png' }));
    await record('uploadTraversalFilename', '/api/images/upload', JSON.stringify({ image: PNG_ONE_PIXEL.toString('base64'), format: 'png', filename: '../evil.png' }));
    await record('uploadInvalidFormat', '/api/images/upload', JSON.stringify({ image: PNG_ONE_PIXEL.toString('base64'), format: 'exe', filename: 'x.png' }));
    await record('uploadMissingFormat', '/api/images/upload', JSON.stringify({ image: PNG_ONE_PIXEL.toString('base64') }));
    await record('uploadMissingImage', '/api/images/upload', JSON.stringify({ format: 'png' }));
    await record('uploadMalformedBase64', '/api/images/upload', JSON.stringify({ image: '!!!not-base64!!!', format: 'png', filename: 'garbage.png' }));

    // ── /api/images/list/:folder? ──────────────────────────────────────────────────────────────
    await record('listDeprecatedParam', '/api/images/list/nested', '{}');
    await record('listParamAndBody', '/api/images/list/nested', JSON.stringify({ folder: 'nested' }));
    await record('listNoFolder', '/api/images/list', '{}');
    await record('listCreatesMissing', '/api/images/list', JSON.stringify({ folder: 'brand-new' }));
    await record('listEmptyFolder', '/api/images/list', JSON.stringify({ folder: '', sortField: 'name' }));
    await record('listDefaultTypeSort', '/api/images/list', JSON.stringify({ folder: '.' }));
    await record('listByName', '/api/images/list', JSON.stringify({ folder: '.', sortField: 'name' }));
    await record('listByNameDesc', '/api/images/list', JSON.stringify({ folder: '.', sortField: 'name', sortOrder: 'desc' }));
    await record('listByDate', '/api/images/list', JSON.stringify({ folder: '.', sortField: 'date' }));
    await record('listByDateDesc', '/api/images/list', JSON.stringify({ folder: '.', sortField: 'date', sortOrder: 'desc' }));
    await record('listUnknownSortField', '/api/images/list', JSON.stringify({ folder: '.', sortField: 'nope' }));
    await record('listVideoType', '/api/images/list', JSON.stringify({ folder: '.', type: 2 }));
    await record('listAudioType', '/api/images/list', JSON.stringify({ folder: '.', type: 4 }));
    await record('listAllTypes', '/api/images/list', JSON.stringify({ folder: '.', type: 7 }));
    await record('listStringType', '/api/images/list', JSON.stringify({ folder: '.', type: '1' }));
    await record('listSubfolderScope', '/api/images/list', JSON.stringify({ folder: 'nested' }));

    // ── /api/images/folders ────────────────────────────────────────────────────────────────────
    await record('foldersList', '/api/images/folders', '{}');

    // ── /api/images/delete ─────────────────────────────────────────────────────────────────────
    await record('deleteMissingPath', '/api/images/delete', '{}');
    await record('deleteEmptyPath', '/api/images/delete', JSON.stringify({ path: '' }));
    await record('deleteOutsideRoot', '/api/images/delete', JSON.stringify({ path: '/characters/alpha.png' }));
    await record('deleteTraversal', '/api/images/delete', JSON.stringify({ path: '/user/images/../../characters/x.png' }));
    await record('deleteMissingFile', '/api/images/delete', JSON.stringify({ path: '/user/images/missing.png' }));
    await record('deleteFile', '/api/images/delete', JSON.stringify({ path: '/user/images/alpha.png' }));
    await record('deleteNestedFile', '/api/images/delete', JSON.stringify({ path: '/user/images/nested/inside.png' }));
} finally {
    await server.stop();
}

function rmTree(target) {
    rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

// ── assertions: the projection, the tree and the error bodies are pinned, not just the status ───
assert.equal(scenarios.uploadNamed.response.status, 200, 'upload answers 200');
assert.deepEqual(scenarios.uploadNamed.response.body, { path: '/user/images/custom.png' }, 'the saved path is client-relative');
assert.equal(scenarios.uploadNamed.treeAfter.some(entry => entry.path === 'custom.png' && entry.sha256 === createHash('sha256').update(PNG_ONE_PIXEL).digest('hex')), true,
    'the decoded image bytes are written');
assert.equal(scenarios.uploadUnnamed.response.body.path, '/user/images/<timestamp>.png',
    'an unnamed upload is named `${Date.now()}.${format}`, recorded with the timestamp marker');
assert.equal(scenarios.uploadUnnamed.treeAfter.some(entry => entry.path === '<timestamp>.png'), true, 'the unnamed file is recorded with a timestamp marker');
assert.deepEqual(scenarios.uploadCharacterFolder.response.body, { path: '/user/images/Alice  Bob/char.png' },
    'ch_name is sanitized (the path separator is removed) and creates a subfolder');
assert.deepEqual(scenarios.uploadFilenameExtensionReplaced.response.body, { path: '/user/images/picture.jpg' },
    'the submitted extension is replaced by the requested format');
assert.deepEqual(scenarios.uploadTraversalFilename.response.body, { path: '/user/images/..evil.png' },
    'a traversal filename is sanitized rather than escaping the tree');
assert.equal(scenarios.uploadInvalidFormat.response.status, 400, 'an unknown format answers 400');
assert.deepEqual(scenarios.uploadInvalidFormat.response.body, { error: 'Invalid image format' }, 'the invalid-format body');
assert.deepEqual(scenarios.uploadMissingImage.response.body, { error: 'No image data provided' }, 'the missing-image body');
assert.deepEqual(scenarios.uploadMissingFormat.response.body, { error: 'Invalid image format' }, 'a missing format is invalid');
assert.deepEqual(scenarios.uploadMalformedBase64.treeAfter.find(entry => entry.path === 'garbage.png'), 
    { path: 'garbage.png', kind: 'file', bytes: Buffer.from('!!!not-base64!!!', 'base64').length, sha256: createHash('sha256').update(Buffer.from('!!!not-base64!!!', 'base64')).digest('hex') },
    'the malformed base64 is decoded leniently, exactly as Buffer.from does');

assert.deepEqual(scenarios.listDeprecatedParam.response.body, ['inside.png'], 'the deprecated URL folder lists its own scope');
assert.deepEqual(scenarios.listParamAndBody.response.body, { error: 'Folder specified in both URL and body' }, 'the conflict body');
assert.deepEqual(scenarios.listNoFolder.response.body, { error: 'No folder specified' }, 'the missing-folder body');
assert.deepEqual(scenarios.listEmptyFolder.response.body, { error: 'No folder specified' }, 'an EMPTY folder is falsy, so it answers 400 as well');
assert.deepEqual(scenarios.listCreatesMissing.response.body, [], 'a missing folder is created and listed empty');
assert.equal(scenarios.listCreatesMissing.treeAfter.some(entry => entry.path === 'brand-new/'), true, 'the folder is created on disk');
// The default `type` is MEDIA_REQUEST_TYPE.IMAGE, so the media filter keeps images only (svg maps to
// image/svg+xml, so eta.svg is included) and the default sort field is `date`.
const IMAGES_BY_NAME = ['alpha.png', 'beta.jpg', 'eta.svg', 'gamma.gif', 'theta.webp'];
const IMAGES_BY_DATE = ['alpha.png', 'beta.jpg', 'gamma.gif', 'eta.svg', 'theta.webp'];
assert.deepEqual(scenarios.listByName.response.body, IMAGES_BY_NAME,
    'the name sort is Intl.Collator order; the text file and every non-image are excluded');
assert.deepEqual(scenarios.listByNameDesc.response.body, [...IMAGES_BY_NAME].reverse(), 'desc reverses the sorted list');
assert.deepEqual(scenarios.listDefaultTypeSort.response.body, IMAGES_BY_DATE,
    'the DEFAULT sort field is date, not name, and the default type is image');
assert.deepEqual(scenarios.listByDate.response.body, IMAGES_BY_DATE, 'the date sort follows the seeded mtimes');
assert.deepEqual(scenarios.listByDateDesc.response.body, [...IMAGES_BY_DATE].reverse(), 'date desc reverses it');
assert.deepEqual(scenarios.listVideoType.response.body, ['epsilon.mp4'], 'type 2 lists video only');
assert.deepEqual(scenarios.listAudioType.response.body, ['zeta.mp3'], 'type 4 lists audio only');
assert.deepEqual(scenarios.listAllTypes.response.body, ['alpha.png', 'beta.jpg', 'gamma.gif', 'epsilon.mp4', 'zeta.mp3', 'eta.svg', 'theta.webp'],
    'type 7 lists every media type in date order and still excludes the text file');
assert.deepEqual(scenarios.listStringType.response.body, IMAGES_BY_DATE,
    'a string type is coerced by Number() and the default sort is still date');
assert.deepEqual(scenarios.listSubfolderScope.response.body, ['inside.png'], 'the folder scope is the named subfolder');

assert.deepEqual(scenarios.foldersList.response.body.sort(), ['nested'], 'only directories are listed');

assert.equal(scenarios.deleteMissingPath.response.status, 400, 'delete without a path answers 400');
assert.equal(scenarios.deleteMissingPath.response.bodyText, 'No path specified', 'the missing-path body is plain text');
assert.equal(scenarios.deleteEmptyPath.response.status, 400, 'an empty path answers 400');
assert.equal(scenarios.deleteOutsideRoot.response.status, 400, 'a path outside user/images answers 400');
assert.equal(scenarios.deleteOutsideRoot.response.bodyText, 'Invalid path', 'the invalid-path body');
assert.equal(scenarios.deleteTraversal.response.status, 400, 'a traversal path answers 400');
assert.equal(scenarios.deleteMissingFile.response.status, 404, 'a missing file answers 404');
assert.equal(scenarios.deleteMissingFile.response.bodyText, 'File not found', 'the missing-file body');
assert.equal(scenarios.deleteFile.response.status, 200, 'a successful delete answers 200');
assert.equal(scenarios.deleteFile.response.bodyText, 'OK', 'sendStatus(200) writes OK');
assert.equal(scenarios.deleteFile.treeAfter.some(entry => entry.path === 'alpha.png'), false, 'the file is gone');
assert.equal(scenarios.deleteNestedFile.treeAfter.some(entry => entry.path === 'nested/inside.png'), false, 'a nested file can be deleted');

const fixture = {
    schemaVersion: 1,
    baseline: { version: PINNED_VERSION, commit: PINNED_COMMIT },
    probe: 'tools/probe-images.mjs',
    pinnedSource: {
        'src/endpoints/images.js:39': 'POST /upload: MEDIA_EXTENSIONS gate, removeFileExtension, sanitize, clientRelativePath',
        'src/endpoints/images.js:80': 'POST /list/:folder?: param/body conflict, Number(type), sanitize, getImages sort, desc reverse',
        'src/endpoints/images.js:115': 'POST /folders: readdir withFileTypes, directories only',
        'src/endpoints/images.js:133': 'POST /delete: isPathUnderParent, 404, unlink, sendStatus(200)',
        'src/util.js:682': "getImages: mime.lookup media filter, Intl.Collator name sort, mtimeMs date sort",
    },
    mechanism: 'The four routes are local: the probe seeds one per-user user/images tree (fixed whole-second mtimes) and drives the real pinned listener, recording the response plus the resulting tree.',
    fields: [
        { path: 'scenarios.*.response.status', comparison: 'compared', reason: 'the pinned handlers choose 200/400/404/500 themselves' },
        { path: 'scenarios.*.response.headers', comparison: 'compared', reason: 'Express and the pinned middleware stack set them' },
        { path: 'scenarios.*.response.body/bodyText', comparison: 'compared', reason: 'the response projection and the exact error text are endpoint behaviour' },
        { path: 'scenarios.*.treeAfter', comparison: 'compared', reason: 'the written/removed files are a persistent side effect; paths, sizes and digests only' },
        { path: 'scenarios.uploadUnnamed.*', comparison: 'compared', reason: 'the Date.now() filename is normalized to <timestamp> in both the response and the tree' },
        { path: 'foldersList ordering', comparison: 'shape', reason: 'pinned fs.readdirSync order is filesystem-dependent, so the folder set is compared after sorting; the fixture stores the sorted list for that reason' },
        { path: 'mtimes', comparison: 'shape', reason: 'never recorded; the date sort is pinned by seeding distinct whole-second mtimes instead' },
    ],
    normalizations: [
        'An unnamed upload is named `${Date.now()}.${format}`; every 13-digit millisecond value is replaced by <timestamp> in the recorded response and tree.',
        'Seeded files carry fixed whole-second mtimes, so the pinned mtime sort is reproducible on any host.',
        'The folder list is recorded sorted because pinned fs.readdirSync order is filesystem-dependent, and the name sort is Intl.Collator over lowercase ASCII names only.',
        'The images tree is recorded as relative path, size and SHA-256; never as mtimes, ctimes or directory sizes.',
        'The seed tree is recorded with its exact bytes (base64) and whole-second mtime so the Go test replays the same initial state instead of re-deriving it.',
        'A response whose raw body contains Date.now() records its ETag as <unstable-body>, because the ETag hashes the raw body; the Go test skips exactly that marker and nothing else.',
    ],
    seeds: { files: Object.fromEntries(Object.entries(FILE_BYTES).map(([name, content]) => [name, { sha256: createHash('sha256').update(content).digest('hex'), bytes: content.length, mtimeMs: MTIMES[name], base64: content.toString('base64') }])) },
    bootOutbound,
    scenarios,
};

const outputFile = writeFixture(repositoryRoot, 'sillytavern-1.19.0-images.json', fixture);
console.log(`scenarios: ${Object.keys(scenarios).length}, boot outbound: ${bootOutbound.length}`);
console.log(`fixture written to ${outputFile}`);
