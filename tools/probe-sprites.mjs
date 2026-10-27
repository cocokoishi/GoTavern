#!/usr/bin/env node
// Capture the pinned sprite upload routes:
//
//	POST /api/sprites/upload      sprites.js:239  (multipart part + byte copy + sanitized label)
//	POST /api/sprites/upload-zip  sprites.js:186  (multipart part + zip-entry extraction)
//
// Neither route needs a provider or a codec: getImageBuffers (src/util.js) only unzips entries whose
// mime is image/* and whose name does not start with __MACOSX, returning [basename, bytes]. There is
// no Jimp path here, so byte-level parity is achievable.
//
// The upload middleware is global `multer({ dest: uploadsPath }).single('avatar')` (server-main.js:269),
// so the file part MUST be named `avatar`; label/name/spriteName are text parts. The fixture records
// every part in ORDER with its per-part headers (name, filename, content type) and bytes/SHA-256.
//
// HOST DEPENDENCE: seeded files have fixed whole-second mtimes; tree snapshots use '/' paths and are
// sorted; zip bytes are built deterministically (store method, fixed DOS timestamp) and recorded so
// the replay sends the same archive.
//
// @gotavern-oracle: this declaration is read by tools/build-generated-lib.mjs,
// which auto-discovers probes so that adding one needs no edit there.
// @gotavern-oracle: fixture=sillytavern-1.19.0-sprites.json label="sprite upload routes"

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import {
    PINNED_COMMIT, PINNED_VERSION, rawRequest, startPinnedProviderServer, writeFixture,
} from './lib/pinned-outbound.mjs';

const sourceRoot = path.resolve(process.argv[2] ?? '');
const repositoryRoot = path.resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3]) {
    console.error('usage: node tools/probe-sprites.mjs <pinned-source-clone> <gotavern-root>');
    process.exit(2);
}
if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim() !== PINNED_COMMIT) {
    throw new Error(`upstream checkout is not pinned at ${PINNED_COMMIT}`);
}

const COOKIE_SECRET = 'gotavern-pinned-sprites-cookie-secret';
const BOUNDARY = '----gotavern-sprites-boundary';
const FIXED_SECONDS = 1700000000;

function sha256(value) {
    return createHash('sha256').update(value).digest('hex');
}

function seedFile(userRoot, relative, content) {
    const target = path.join(userRoot, ...relative.split('/'));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
    utimesSync(target, FIXED_SECONDS, FIXED_SECONDS);
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

// Deterministic minimal ZIP writer (store method, fixed DOS timestamp). yauzl in pinned only reads,
// so a store-only archive is a faithful input, and the recorded bytes let the replay send exactly
// the same archive in its own multipart body.
const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let index = 0; index < 256; index++) {
        let value = index;
        for (let bit = 0; bit < 8; bit++) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
        table[index] = value >>> 0;
    }
    return table;
})();

function crc32(buffer) {
    let value = 0xffffffff;
    for (const byte of buffer) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
    return (value ^ 0xffffffff) >>> 0;
}

function buildZip(entries) {
    const locals = [];
    const centrals = [];
    let offset = 0;
    for (const entry of entries) {
        const name = Buffer.from(entry.name, 'utf8');
        const data = Buffer.from(entry.data, 'utf8');
        const crc = crc32(data);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0x0800, 6);
        local.writeUInt16LE(0, 8);
        local.writeUInt16LE(0, 10);
        local.writeUInt16LE(0x0021, 12); // 1980-01-01
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(data.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(name.length, 26);
        local.writeUInt16LE(0, 28);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(0x0800, 8);
        central.writeUInt16LE(0, 10);
        central.writeUInt16LE(0, 12);
        central.writeUInt16LE(0x0021, 14);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(data.length, 20);
        central.writeUInt32LE(data.length, 24);
        central.writeUInt16LE(name.length, 28);
        central.writeUInt16LE(0, 30);
        central.writeUInt16LE(0, 32);
        central.writeUInt16LE(0, 34);
        central.writeUInt16LE(0, 36);
        central.writeUInt32LE(0, 38);
        central.writeUInt32LE(offset, 42);
        locals.push(local, name, data);
        centrals.push(central, name);
        offset += local.length + name.length + data.length;
    }
    const centralBuffer = Buffer.concat(centrals);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(centralBuffer.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, centralBuffer, end]);
}

function buildMultipart(parts) {
    const chunks = [];
    for (const part of parts) {
        const headers = [];
        let headerValue = `Content-Disposition: form-data; name="${part.name}"`;
        if (part.filename !== undefined) headerValue += `; filename="${part.filename}"`;
        headers.push(headerValue);
        if (part.contentType !== undefined) headers.push(`Content-Type: ${part.contentType}`);
        chunks.push(Buffer.from(`--${BOUNDARY}\r\n${headers.join('\r\n')}\r\n\r\n`));
        chunks.push(Buffer.from(part.bytesBase64, 'base64'));
        chunks.push(Buffer.from('\r\n'));
    }
    chunks.push(Buffer.from(`--${BOUNDARY}--\r\n`));
    return Buffer.concat(chunks);
}

const textPart = (name, value) => ({ name, value, bytesBase64: Buffer.from(value, 'utf8').toString('base64') });
const filePart = (filename, contentType, content) => ({ name: 'avatar', filename, contentType, bytesBase64: Buffer.from(content, 'utf8').toString('base64') });

const zipBytes = buildZip([
    { name: 'pack/joy.png', data: 'ZIP-JOY' },
    { name: 'pack/sad.webp', data: 'ZIP-SAD' },
    { name: 'pack/notes.txt', data: 'not an image' },
    { name: '__MACOSX/pack/._joy.png', data: 'resource fork' },
    { name: 'a/b.png', data: 'NESTED-B' },
    { name: 'dup.png', data: 'DUP-ONE' },
    { name: 'dup.png', data: 'DUP-TWO' },
]);

const steps = [];
function addStep(step) {
    steps.push(step);
}

// ---- /upload ---------------------------------------------------------------------------------
addStep({
    name: 'upload.ok.newCharacter',
    route: 'upload',
    parts: [filePart('joy.png', 'image/png', 'PNG-JOY'), textPart('label', 'joy'), textPart('name', 'FreshChar')],
});
addStep({
    name: 'upload.replaceSameLabel',
    route: 'upload',
    parts: [filePart('new.jpeg', 'image/jpeg', 'JPEG-NEW'), textPart('label', 'joy'), textPart('name', 'SpriteChar')],
});
addStep({
    name: 'upload.spriteNameOverride',
    route: 'upload',
    parts: [filePart('x.webp', 'image/webp', 'WEBP-X'), textPart('label', 'base'), textPart('spriteName', 'custom'), textPart('name', 'SpriteChar')],
});
addStep({
    name: 'upload.subfolder',
    route: 'upload',
    parts: [filePart('bg.jpg', 'image/jpeg', 'JPEG-BG'), textPart('label', 'bg'), textPart('name', 'SpriteChar/sub')],
});
addStep({
    name: 'upload.missingFile',
    route: 'upload',
    parts: [textPart('label', 'joy'), textPart('name', 'SpriteChar')],
});
addStep({
    name: 'upload.missingLabel',
    route: 'upload',
    parts: [filePart('a.png', 'image/png', 'A'), textPart('name', 'SpriteChar')],
});
addStep({
    name: 'upload.missingName',
    route: 'upload',
    parts: [filePart('a.png', 'image/png', 'A'), textPart('label', 'joy')],
});
addStep({
    name: 'upload.invalidName',
    route: 'upload',
    parts: [filePart('a.png', 'image/png', 'A'), textPart('label', 'joy'), textPart('name', '../evil')],
});
addStep({
    name: 'upload.illegalCharsSanitized',
    route: 'upload',
    parts: [filePart('a.png', 'image/png', 'A'), textPart('label', 'la:bel'), textPart('name', 'SpriteChar')],
});

// ---- /upload-zip -----------------------------------------------------------------------------
addStep({
    name: 'uploadZip.ok',
    route: 'upload-zip',
    parts: [filePart('pack.zip', 'application/zip', zipBytes), textPart('name', 'ZipChar')],
});
addStep({
    name: 'uploadZip.replaceAndSanitize',
    route: 'upload-zip',
    parts: [filePart('pack.zip', 'application/zip', zipBytes), textPart('name', 'SpriteChar')],
});
addStep({
    name: 'uploadZip.missingFile',
    route: 'upload-zip',
    parts: [textPart('name', 'ZipChar')],
});
addStep({
    name: 'uploadZip.missingName',
    route: 'upload-zip',
    parts: [filePart('pack.zip', 'application/zip', zipBytes)],
});
addStep({
    name: 'uploadZip.invalidZip',
    route: 'upload-zip',
    parts: [filePart('bad.zip', 'application/zip', 'not a zip at all'), textPart('name', 'ZipChar')],
});

async function main() {
    const server = await startPinnedProviderServer({ sourceRoot, prefix: 'gotavern-sprites-oracle-', mocks: [] });
    try {
        const userRoot = server.userRoot;
        seedFile(userRoot, 'characters/SpriteChar/joy.png', 'OLD-JOY-PNG');
        seedFile(userRoot, 'characters/SpriteChar/joy.webp', 'OLD-JOY-WEBP');
        seedFile(userRoot, 'characters/SpriteChar/custom.webp', 'OLD-CUSTOM');
        seedFile(userRoot, 'characters/SpriteChar/keep.png', 'KEEP');
        const observations = {};
        const stepInputs = [];
        const session = server.session;
        for (const step of steps) {
            const body = buildMultipart(step.parts);
            const result = await rawRequest(`${server.origin}/api/sprites/${step.route}`, 'POST', {
                Cookie: session.cookie,
                'X-CSRF-Token': session.csrfToken,
                'Content-Type': `multipart/form-data; boundary=${BOUNDARY}`,
            }, body);
            // SPRITE UPLOAD IS A LOCAL FILE OPERATION AND REACHES NO PROVIDER (lane/privacy egress audit,
            // 2026-10-26). Without this, a request this route made would have been swallowed by the stub and recorded
            // as nothing rather than failing -- the `sd-models` lesson: an escape is only visible if an assertion
            // says the peer received exactly what the fixture claims (AGENTS.md verification rule 14).
            const leaked = server.outbound();
            if (leaked.length > 0) {
                throw new Error(`EGRESS: sprite step ${step.name} made ${leaked.length} outbound request(s) and the `
                    + `sprite routes claim none -- ${JSON.stringify(leaked.map(entry => `${entry.method} ${entry.url}`))}`);
            }
            observations[step.name] = {
                status: result.response.status,
                contentType: result.response.headers.get('content-type'),
                contentLength: result.response.headers.get('content-length'),
                etag: result.response.headers.get('etag'),
                bodyBase64: result.bytes.toString('base64'),
                bodySha256: sha256(result.bytes),
                bodyLength: result.bytes.length,
                comparison: {
                    compared: ['status', 'contentType', 'contentLength', 'etag', 'bodyBase64', 'bodySha256', 'bodyLength', 'tree'],
                    shape: [],
                    shapeReason: {},
                },
            };
            stepInputs.push({
                name: step.name,
                route: step.route,
                parts: step.parts.map(part => ({
                    name: part.name,
                    value: part.value,
                    bytesBase64: part.bytesBase64,
                    filename: part.filename,
                    contentType: part.contentType,
                })),
                boundary: BOUNDARY,
            });
            observations[step.name].tree = { characters: snapshotTree(path.join(userRoot, 'characters')) };
        }
        writeFixture(repositoryRoot, 'sillytavern-1.19.0-sprites.json', {
            schemaVersion: 1,
            baseline: { version: PINNED_VERSION, commit: PINNED_COMMIT },
            probe: 'pinned /api/sprites upload and upload-zip routes (multipart + zip entries)',
            oracle: { file: 'src/endpoints/sprites.js', helpers: ['src/util.js getImageBuffers', 'src/server-main.js:269 multer single(avatar)'] },
            conventions: {
                multipart: 'every part is recorded in order with its name, filename, content type and bytes; the replay rebuilds the same parts',
                zip: 'the archive is built deterministically (store method, fixed DOS timestamp) and its bytes are recorded',
                tree: 'tree snapshots use / paths, are sorted, and exclude mtimes',
            },
            fixtureFields: {
                compared: ['observations.*.status', 'observations.*.contentType', 'observations.*.contentLength', 'observations.*.etag', 'observations.*.bodyBase64', 'observations.*.bodySha256', 'observations.*.bodyLength', 'observations.*.tree'],
                shape: [],
            },
            inputs: {
                cookieSecret: COOKIE_SECRET,
                account: { handle: 'default-user', name: 'Sprites Probe', admin: true, password: '' },
                steps: stepInputs,
            },
            observations,
            knownDifferences: [],
        });
        console.log('Wrote tests/oracle/sillytavern-1.19.0-sprites.json from pinned sprite upload behaviour');
    } finally {
        await server.stop();
    }
}

await main();
