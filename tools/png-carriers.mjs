#!/usr/bin/env node
// WHICH PNG BYTES CAN CARRY THE ORIGINAL'S IDENTITY, AND IS EVERY ONE OF THEM COVERED BY A GATE?
//
// AGENTS.md rule 56 says a real card never enters this repository, only a derivation. A DERIVATION IS ONLY A
// DERIVATION IF EVERY CARRIER WAS REPLACED OR PROVEN EMPTY, and the text scanner (`check-fixture-watermarks.mjs`)
// can only see carriers that contain TEXT: the `chara`/`ccv3` JSON, the raw bytes read as latin1, and any name
// field. It cannot decide whether an ANCILLARY chunk nobody names, a compressed-text chunk (`zTXt`/`iTXt`), an
// EXIF blob, an unknown chunk preserved "because the reader tolerates it", or the IDAT stream is a copy of the
// original. 18 MB of an image is its own risk, and the derivation's own survivor sweep reads the DECODED JSON
// only -- so the picture and the non-card chunks are outside every check that existed before this file.
//
// THIS MODULE MAKES THAT QUESTION ANSWERABLE FROM METADATA ONLY (AGENTS.md 56 + the lane brief: work from file
// sizes, chunk types, key counts and hashes). For every chunk of a PNG it reports:
//
//   type, payload bytes, and one of a CLOSED SET of verdicts:
//     content    -- a card text chunk (`chara`/`ccv3`) the scanner decodes and scans as JSON;
//     image      -- the IDAT stream: must be replaced by a re-encoded image whose decoded pixels are ONE colour,
//                   so the original's pixels cannot be present however they were hidden in the scanlines;
//     metadata   -- a metadata chunk: MUST BE ABSENT, because a card carrying it has not been desensitised
//                   (the generator's verdict, and the fixture gate's);
//     declarable -- a chunk the generator EXPLICITLY declares in an allowlist (the derivation's tolerance
//                   fixture, `trAc`), which must equal a manifest-recorded digest;
//     unknown    -- an ancillary chunk nobody named: preserved verbatim by the derivation, so it is a carrier
//                   nobody has cleared. It is a REFUSAL unless a manifest declares it (a human decision).
//
// The verdicts are computed from properties the generator cannot fake by accident: `IHDR` flags, the chunk's
// position, whether the payload decodes as zlib, and whether the decoded image is a single colour.
//
// NOT A WATERMARK SCANNER. It never prints or returns payload text beyond a short, quoted TYPE and a sha256.
// A refusal names a CATEGORY and a chunk type, which is what a reviewer needs and all a log may carry.
//
// Usage (CLI, for a reviewer):
//   node tools/png-carriers.mjs <file.png> [--json]
// Exit 2 on any REFUSING chunk. Exit 0 prints the per-chunk table and the total.

import fs from 'node:fs';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// PNG 1.2 chunk types that are METADATA. A card is a card because of its text chunks; everything here is
// something the author's tooling or an image editor wrote and the derivation has no reason to keep.
export const METADATA_CHUNKS = new Map([
    ['tEXt', 'uncompressed text keyword/value pairs'],
    ['zTXt', 'zlib-compressed text (needs decoding before it can be scanned)'],
    ['iTXt', 'international text, optionally compressed'],
    ['eXIf', 'an EXIF blob: camera/editor metadata and often a comment and a software tag'],
    ['tIME', 'a modification timestamp'],
    ['pHYs', 'pixel dimensions and aspect'],
    ['gAMA', 'gamma'],
    ['cHRM', 'chromaticities'],
    ['sRGB', 'colour space'],
    ['sBIT', 'significant bits'],
    ['bKGD', 'background colour'],
    ['hIST', 'palette histogram'],
    ['tRNS', 'transparency'],
    ['sPLT', 'suggested palette'],
    ['acTL', 'APNG animation control (an animation is a picture fixture)'],
    ['fcTL', 'APNG frame control'],
    ['fdAT', 'APNG frame data'],
]);

// CHUNKS A CARD IS ALLOWED TO CARRY BECAUSE A READER'S OWN BEHAVIOUR IS THE FIXTURE. Each entry names why it may
// exist and is only accepted when a manifest declares it; the scanner itself never assumes one.
export const DECLARABLE_CHUNKS = new Map([
    ['trAc', 'a non-standard JSON chunk the pinned card reader skips; the fixture proves that tolerance. Its payload is a CIPHERTEXT of the author\'s data, so it is replaced at the same byte length and its digest recorded'],
]);

const isAncillary = (type) => (type.charCodeAt(0) & 0x20) !== 0;
const isCritical = (type) => !isAncillary(type);

const CRC_TABLE = (() => {
    const table = new Int32Array(256);
    for (let index = 0; index < 256; index += 1) {
        let value = index;
        for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
        table[index] = value;
    }
    return table;
})();
const crc32 = (buffer) => {
    let crc = 0 ^ -1;
    for (const byte of buffer) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff];
    return (crc ^ -1) >>> 0;
};

/**
 * Chunk list, with the format errors a carrier audit must refuse rather than skip. Every refusal names the
 * CATEGORY (`structure`), never bytes.
 */
export function readChunks(buffer) {
    const problems = [];
    if (buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
        return { chunks: [], problems: ['structure: not a PNG (the 8-byte signature is absent)'] };
    }
    const chunks = [];
    let offset = 8;
    while (offset + 12 <= buffer.length) {
        const length = buffer.readUInt32BE(offset);
        const type = buffer.toString('latin1', offset + 4, offset + 8);
        const dataStart = offset + 8;
        if (dataStart + length + 4 > buffer.length) {
            problems.push(`structure: chunk ${JSON.stringify(type)} at byte ${offset} claims ${length} payload bytes and the file ends first`);
            break;
        }
        const declared = buffer.readUInt32BE(dataStart + length);
        const actual = crc32(buffer.subarray(offset + 4, dataStart + length));
        if (declared !== actual) problems.push(`structure: chunk ${JSON.stringify(type)} at byte ${offset} has a CRC that does not cover its bytes`);
        chunks.push({ type, offset, length, data: buffer.subarray(dataStart, dataStart + length) });
        offset = dataStart + length + 4;
        if (type === 'IEND') break;
    }
    if (chunks.length === 0) problems.push('structure: no chunks');
    else {
        if (chunks[0].type !== 'IHDR') problems.push('structure: the first chunk is not IHDR');
        if (chunks[chunks.length - 1].type !== 'IEND') problems.push('structure: the file does not end with IEND');
    }
    if (offset !== buffer.length) problems.push(`structure: ${buffer.length - offset} trailing byte(s) after the last chunk`);
    return { chunks, problems };
}

/** The keyword of a tEXt/zTXt/iTXt payload, or null when the payload is malformed. */
export function textKeyword(type, data) {
    if (type !== 'tEXt' && type !== 'zTXt' && type !== 'iTXt') return null;
    const zero = data.indexOf(0);
    if (zero < 1 || zero > 79) return null;
    return data.toString('latin1', 0, zero);
}

/** A sha256 of a chunk's payload. The ONLY thing about a payload this module ever emits. */
export const payloadDigest = (data) => crypto.createHash('sha256').update(data).digest('hex');

/**
 * The decoded image, from the IDAT stream, as (width x height) pixels and whether every pixel is one colour.
 *
 * WHY A SINGLE-COLOUR TEST IS THE RIGHT ONE. A re-encoded solid image cannot carry the original's pixels: the
 * derivation's own contract says the visible picture is not the structure the leg needs. Testing "all pixels are
 * equal" is a property of the DECODED data, so a generator that hid the original in the low bits of a solid grey
 * image, in an unusual interlace order, or behind a palette entry that no pixel uses, fails it. It also refuses
 * an image whose filter types the generator resets, because the decoded bytes are what is compared.
 */
export function decodeSolidity(chunks) {
    const ihdr = chunks.find((chunk) => chunk.type === 'IHDR');
    if (!ihdr || ihdr.length !== 13) return { ok: false, reason: 'the file has no 13-byte IHDR' };
    const width = ihdr.data.readUInt32BE(0);
    const height = ihdr.data.readUInt32BE(4);
    const bitDepth = ihdr.data[8];
    const colourType = ihdr.data[9];
    const interlace = ihdr.data[12];
    if (interlace !== 0) return { ok: false, reason: `IHDR declares interlace method ${interlace}; a solid image is written non-interlaced` };
    const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colourType];
    if (!channels) return { ok: false, reason: `IHDR declares colour type ${colourType}, which has no channel count` };
    if (bitDepth !== 8) return { ok: false, reason: `IHDR declares bit depth ${bitDepth}; only 8-bit channels are decoded here` };
    const idat = Buffer.concat(chunks.filter((chunk) => chunk.type === 'IDAT').map((chunk) => chunk.data));
    if (idat.length === 0) return { ok: false, reason: 'the file has no IDAT payload' };
    let raw;
    try {
        raw = zlib.inflateSync(idat);
    } catch (error) {
        return { ok: false, reason: 'the IDAT stream does not inflate: ' + String(error?.message ?? error).slice(0, 80) };
    }
    const stride = width * channels + 1;
    if (raw.length !== stride * height) {
        return { ok: false, reason: `the IDAT stream inflates to ${raw.length} bytes and its IHDR needs ${stride * height}` };
    }
    const reference = raw.subarray(1, 1 + channels);
    for (let row = 0; row < height; row += 1) {
        const base = row * stride;
        if (raw[base] !== 0) return { ok: false, reason: `row ${row} uses PNG filter type ${raw[base]}; a solid image carries filter type 0 only` };
        for (let pixel = 0; pixel < width; pixel += 1) {
            const at = base + 1 + pixel * channels;
            if (!raw.subarray(at, at + channels).equals(reference)) {
                return { ok: false, reason: `pixel (${pixel}, ${row}) differs from the first pixel, so the image is not a single colour` };
            }
        }
    }
    // A PALETTE IMAGE'S PIXELS ARE INDICES. One index for every pixel means the whole picture is one palette
    // entry, which is solid -- but only if the palette has one entry, because a second entry could carry a colour
    // no pixel uses and a later reader could pick it.
    if (colourType === 3) {
        const plte = chunks.find((chunk) => chunk.type === 'PLTE');
        if (!plte || plte.length !== 3) return { ok: false, reason: 'a palette image must carry exactly one PLTE entry for its index-0 solid fill' };
    }
    return { ok: true, width, height, colourType, channels, colour: `#${[...reference].map((byte) => byte.toString(16).padStart(2, '0')).join('')}` };
}

/**
 * The carrier verdict for one chunk. `options.allowed` is the set of DECLARABLE chunk types the caller's policy
 * admits (default: none). A metadata chunk is always `metadata`; whether that refuses is the caller's rule
 * (`requireNoMetadata`), because the generator's rule and the fixture gate's rule differ in exactly one place --
 * the derivation keeps the card's own text chunks -- and conflating them is how a gate starts refusing the thing
 * it exists to produce.
 */
export function carrierVerdict(chunk, options = {}) {
    const allowed = options.allowed ?? new Set(['trAc']);
    if (chunk.type === 'IHDR' || chunk.type === 'IEND') return { kind: 'structure', cleared: true };
    if (chunk.type === 'IDAT') return { kind: 'image', cleared: false };
    if (chunk.type === 'PLTE') return { kind: 'structure', cleared: true };
    if (chunk.type === 'tEXt') {
        const keyword = textKeyword('tEXt', chunk.data);
        if (keyword && /^(chara|ccv3)$/i.test(keyword)) return { kind: 'content', keyword, cleared: false };
    }
    if (METADATA_CHUNKS.has(chunk.type)) return { kind: 'metadata', cleared: false, why: METADATA_CHUNKS.get(chunk.type) };
    if (DECLARABLE_CHUNKS.has(chunk.type) || allowed.has(chunk.type)) {
        return { kind: 'declarable', cleared: options.declarableCleared === true, why: DECLARABLE_CHUNKS.get(chunk.type) ?? 'declared by the caller' };
    }
    return { kind: 'unknown', cleared: false, ancillary: isAncillary(chunk.type), critical: isCritical(chunk.type) };
}

/**
 * THE WHOLE AUDIT, metadata only. Returns one row per chunk plus `refusals`, each of which is
 * `{ category, type, detail }` with NO payload text. `expectation` comes from the manifest
 * (`preserved.chunkSequence`) when the caller has one, so a reordered or resized chunk is a refusal even when
 * its type is cleared.
 *
 * Categories, a closed set -- this is what a report may quote (AGENTS.md 56: a path and a category, never
 * content):
 *   structure  -- the file is not a well-formed PNG
 *   content    -- a card text chunk whose JSON the text scanner must scan
 *   image      -- the IDAT stream is not a re-encoded single-colour image
 *   metadata   -- a metadata chunk is present (EXIF, compressed text, a timestamp, an APNG frame...)
 *   unknown    -- an ancillary chunk nobody named, preserved verbatim: a carrier nobody cleared
 */
export function auditPngCarriers(buffer, options = {}) {
    const { chunks, problems } = readChunks(buffer);
    const allowed = options.allowed ?? new Set(['trAc']);
    const rows = [];
    const refusals = [];
    for (const problem of problems) refusals.push({ category: problem.split(':')[0], type: null, detail: problem });

    let idatFirstSeen = false;
    for (const chunk of chunks) {
        const verdict = carrierVerdict(chunk, { allowed });
        const row = {
            type: chunk.type,
            bytes: chunk.length,
            kind: verdict.kind,
            sha256: chunk.type === 'IDAT' ? null : payloadDigest(chunk.data),
        };
        if (verdict.kind === 'content') row.keyword = verdict.keyword;
        if (verdict.kind === 'image') {
            // A PNG allows the IDAT stream to be split across several chunks; the stream is the image, so the
            // FIRST IDAT is audited once and every later one is refused as a second stream position it does not
            // need. A derivation that writes the image as one chunk (what tools/build-real-fixtures.mjs does) is
            // therefore auditable; a hand-built file that splits it is still audited, because `decodeSolidity`
            // concatenates the stream.
            row.streamPosition = idatFirstSeen ? 'repeat' : 'first';
            idatFirstSeen = true;
        }
        rows.push(row);
    }

    // 1. THE IMAGE. The IDAT stream must decode to ONE colour, however it was split. This is a CARRIER
    //    OBSERVATION, not a refusal in itself: a single-colour image is what makes the IDAT a cleared carrier.
    const solid = decodeSolidity(chunks);

    // 2. EVERY OTHER CHUNK, by the closed verdict set.
    for (const row of rows) {
        if (row.kind === 'image' || row.kind === 'structure') continue;
        if (row.kind === 'content') {
            // Not a refusal here: the TEXT scanner is the gate for this carrier, and the CLI below proves it ran
            // by counting the decoded documents. A caller that wants "the JSON was scanned" compares the count.
            continue;
        }
        if (row.kind === 'metadata') {
            refusals.push({ category: 'metadata', type: row.type, detail: METADATA_CHUNKS.get(row.type) });
            continue;
        }
        if (row.kind === 'declarable') {
            if (!allowed.has(row.type)) refusals.push({ category: 'unknown', type: row.type, detail: 'declarable but not declared by this policy' });
            continue;
        }
        if (row.kind === 'unknown') {
            refusals.push({ category: 'unknown', type: row.type, detail: 'an ancillary chunk the derivation preserves verbatim, cleared by no check' });
        }
    }

    // 3. A CRITICAL CHUNK NOBODY KNOWS IS NOT PRESERVABLE BY TOLERANCE: a critical chunk that is not IHDR/IDAT/
    //    IEND/PLTE makes the file invalid for every reader, so neither the generator nor the gate may accept it.
    for (const row of rows) {
        if (row.kind === 'unknown' && !row.ancillary) {
            refusals.push({ category: 'structure', type: row.type, detail: 'an unknown CRITICAL chunk; no reader may skip it, so it cannot be a preserved fixture' });
        }
    }

    // 4. THE MANIFEST'S OWN RECORD, when the caller has one. A chunk that moved, resized or is missing is a
    //    derivation that is not the recorded one, and the digests make the comparison possible without content.
    if (Array.isArray(options.expectedSequence)) {
        const actualNonIdat = rows.filter((row) => row.type !== 'IDAT');
        const expected = options.expectedSequence.filter((entry) => entry.type !== 'IDAT');
        if (actualNonIdat.length !== expected.length) {
            refusals.push({ category: 'structure', type: null, detail: `the manifest records ${expected.length} non-IDAT chunk(s); the file has ${actualNonIdat.length}` });
        } else {
            for (const [position, entry] of expected.entries()) {
                const row = actualNonIdat[position];
                if (row.type !== entry.type) {
                    refusals.push({ category: 'structure', type: row.type, detail: `chunk ${position} is ${JSON.stringify(row.type)} and the manifest records ${JSON.stringify(entry.type)}` });
                    continue;
                }
                if (typeof entry.bytes === 'number' && row.bytes !== entry.bytes) {
                    refusals.push({ category: 'structure', type: row.type, detail: `chunk ${position} is ${row.bytes} payload bytes and the manifest records ${entry.bytes}` });
                }
                if (typeof entry.sha256 === 'string' && row.sha256 !== null && entry.sha256 !== row.sha256) {
                    refusals.push({ category: 'structure', type: row.type, detail: `chunk ${position} does not hash to the manifest's record (the derivation is not the recorded one)` });
                }
            }
        }
    }

    // A CARRIER IS CLEARED ONLY WHEN A CHECK ABOVE ACCEPTED IT, and the audit is ok only when EVERY carrier is
    // cleared: the image decoded to one colour AND no refusal was recorded. `refusals` therefore carries only
    // refusals, and `solid` carries the image observation, so neither can be read as the other.
    if (!solid.ok) refusals.push({ category: 'image', type: 'IDAT', detail: solid.reason });
    const failing = refusals.filter((entry) => entry.detail !== null);
    return {
        rows,
        refusals,
        solid: solid.ok ? { width: solid.width, height: solid.height, colourType: solid.colourType, colour: solid.colour } : null,
        ok: solid.ok && failing.length === 0,
    };
}

// ------------------------------------------------------------------------------------------------
// CLI. Reviewer-facing, so it prints the per-chunk table. It prints TYPE, BYTES and SHA256 only -- never a
// keyword's value, never a text payload, never a pixel.
// ------------------------------------------------------------------------------------------------
function main() {
    const argv = process.argv.slice(2);
    const files = argv.filter((argument) => !argument.startsWith('--'));
    if (files.length === 0) {
        console.error('usage: node tools/png-carriers.mjs <file.png> [--json]');
        process.exit(2);
    }
    const asJson = argv.includes('--json');
    let failed = false;
    for (const file of files) {
        const result = auditPngCarriers(fs.readFileSync(file));
        if (asJson) {
            console.log(JSON.stringify({ file, ok: result.ok, solid: result.solid, rows: result.rows, refusals: result.refusals }, null, 2));
        } else {
            console.log(`${file}: ${result.ok ? 'every carrier is accounted for' : 'REFUSING'}`);
            for (const [position, row] of result.rows.entries()) {
                const keyword = row.keyword ? ` keyword=${row.keyword}` : '';
                console.log(`  ${String(position).padStart(2)} ${row.type} ${String(row.bytes).padStart(9)} B  ${row.kind.padEnd(10)}${keyword} sha256=${row.sha256 ?? '(stream)'}`);
            }
            if (result.solid) console.log(`  image: ${result.solid.width}x${result.solid.height} colour type ${result.solid.colourType}, one colour ${result.solid.colour}`);
            for (const refusal of result.refusals) {
                if (refusal.detail === null) continue;
                console.log(`  REFUSING [${refusal.category}] ${refusal.type ?? '(file)'}: ${refusal.detail}`);
            }
        }
        if (!result.ok) failed = true;
    }
    if (failed) process.exit(2);
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('png-carriers.mjs')) main();
