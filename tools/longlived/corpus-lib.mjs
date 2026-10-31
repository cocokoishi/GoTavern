// THE DETERMINISTIC PARTS OF THE LONG-LIVED CORPUS.
//
// WHAT THIS IS. `tools/build-longlived-corpus.mjs` builds SillyTavern-shaped trees for Beta 1's
// long-lived qualification (GOAL.md §5 / AGENTS.md 51,56): no private data, fixed seed, byte-identical
// rebuild. Everything that must be identical between two builds lives here so there is exactly ONE
// definition of "the corpus bytes":
//   * the PRNG (`createRng`) -- seeded from text, no Math.random, no clock;
//   * the PNG writer (`encodePng`) -- zlib DEFLATE with STORED blocks (level 0), which is byte-stable
//     across zlib versions; a compressed stream is not, and a manifest whose identity moves with the
//     runner's zlib is not a determinism claim;
//   * the character-card writer (`writeCardPng`) -- a PNG carrying the same card JSON in `chara` and
//     `ccv3` (the two tEXt keys pinned's `src/character-card-parser.js` reads);
//   * the text builder (`filler`, `prose`) -- markers plus deterministic filler;
//   * the tree writer / walker / digest (`writeTree`, `walkTree`, `treeDigest`) -- sorted, relative,
//     forward-slash paths, sha256 content identity, and NO timestamps anywhere;
//   * the manifest builder (`buildManifest`).
//
// WHAT THIS IS NOT. A probe. It writes fixtures and metadata only; the qualification drivers
// (`tests/browser/longlived-*.mjs`, `tests/e2e/longlived_corpus_test.go`) consume the tree. Expectations
// come from the pinned source / pinned server, never from this file.

import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import zlib from 'node:zlib';

// ---------------------------------------------------------------------------------------------------------------
// DETERMINISM PRIMITIVE.
// ---------------------------------------------------------------------------------------------------------------

/**
 * A small, explicit PRNG (mulberry32 seeded from sha256 of `seedText`), NOT Math.random.
 *
 * It returns numbers in [0,1), integers and picks, and nothing in this module may read a clock or an
 * environment variable: the corpus's identity is `(generator version, seed, size)` and nothing else.
 */
export function createRng(seedText) {
    const digest = createHash('sha256').update(String(seedText)).digest();
    let state = digest.readUInt32LE(0) ^ digest.readUInt32LE(4) ^ digest.readUInt32LE(8) ^ digest.readUInt32LE(12);
    const next = () => {
        state |= 0;
        state = (state + 0x6d2b79f5) | 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const int = bound => Math.floor(next() * bound);
    const pick = list => list[int(list.length)];
    const bool = probability => next() < probability;
    return { next, int, pick, bool };
}

// ---------------------------------------------------------------------------------------------------------------
// DETERMINISTIC PNG WRITER.
// ---------------------------------------------------------------------------------------------------------------

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
    }
    return table;
})();

function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, body) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(body.length, 0);
    const typeBytes = Buffer.from(type, 'ascii');
    const crcInput = Buffer.concat([typeBytes, body]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(crcInput), 0);
    return Buffer.concat([length, typeBytes, body, crc]);
}

/**
 * Encode an RGB picture deterministically: deterministic pixels from `seedByte`, a smooth gradient (so
 * the file stays small), DEFLATE STORED blocks (so the bytes do not move with the zlib library version).
 */
export function encodePng({ width, height, seedByte = 0, mode = 'gradient' }) {
    const stride = width * 3;
    const raw = Buffer.alloc((stride + 1) * height);
    let offset = 0;
    for (let y = 0; y < height; y++) {
        raw[offset++] = 0; // filter: none, fixed, so the byte stream is a function of the pixels alone
        for (let x = 0; x < width; x++) {
            if (mode === 'checker') {
                const cell = ((x >> 4) + (y >> 4)) & 1;
                raw[offset++] = cell ? 0x22 : 0xf2;
                raw[offset++] = (seedByte + ((x * 3) & 0x3f)) & 0xff;
                raw[offset++] = (seedByte + ((y * 5) & 0x7f)) & 0xff;
            } else {
                raw[offset++] = Math.round((x * 255) / Math.max(1, width - 1));
                raw[offset++] = Math.round((y * 255) / Math.max(1, height - 1));
                raw[offset++] = (seedByte + ((x + y) & 0x1f)) & 0xff;
            }
        }
    }
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header[8] = 8; // bit depth
    header[9] = 2; // colour type: truecolour RGB
    header[10] = 0;
    header[11] = 0;
    header[12] = 0;
    const idat = zlib.deflateSync(raw, { level: 0 });
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        pngChunk('IHDR', header),
        pngChunk('IDAT', idat),
        pngChunk('IEND', Buffer.alloc(0)),
    ]);
}

/**
 * Put a character card into a PNG exactly where pinned's parser reads it.
 *
 * `src/character-card-parser.js` decodes `chara` (v2 base64 JSON) and prefers `ccv3` (v3). Writing BOTH,
 * with the same JSON, is what a long-lived card written by pinned actually carries after a v3 save.
 */
export function writeCardPng(card, picture) {
    const payload = Buffer.from(JSON.stringify(card), 'utf8').toString('base64');
    const textChunk = keyword => {
        const body = Buffer.concat([Buffer.from(keyword, 'latin1'), Buffer.from([0]), Buffer.from(payload, 'latin1')]);
        return pngChunk('tEXt', body);
    };
    // Insert before IEND, which is where every card writer puts its metadata.
    const iend = picture.lastIndexOf(Buffer.from('IEND', 'ascii'));
    if (iend < 4) throw new Error('writeCardPng: the encoded picture has no IEND chunk');
    return Buffer.concat([picture.subarray(0, iend - 4), textChunk('chara'), textChunk('ccv3'), picture.subarray(iend - 4)]);
}

// ---------------------------------------------------------------------------------------------------------------
// DETERMINISTIC TEXT.
// ---------------------------------------------------------------------------------------------------------------

const WORD_BANK = [
    'lantern', 'harbour', 'ember', 'quiet', 'signal', 'archive', 'river', 'cipher', 'meadow', 'obsidian',
    'tapestry', 'orbit', 'fracture', 'keepsake', 'threshold', 'vellum', 'compass', 'nettle', 'solstice', 'quarry',
    'gossamer', 'cinder', 'citadel', 'driftwood', 'eclipse', 'garnet', 'hollow', 'ivory', 'juniper', 'kiln',
    'lattice', 'monsoon', 'nocturne', 'opal', 'parchment', 'quiver', 'relic', 'saffron', 'tundra', 'umbra',
];

/** Exactly `bytes` bytes of ASCII filler, deterministic for `(rng, bytes)`. */
export function filler(rng, bytes) {
    if (bytes <= 0) return '';
    const out = [];
    let length = 0;
    while (length < bytes) {
        const word = rng.pick(WORD_BANK);
        out.push(word);
        length += word.length + 1;
    }
    return out.join(' ').slice(0, bytes);
}

/** A marked prose block: the marker a loader/test can count, then exactly `bytes` of filler. */
export function prose(rng, marker, bytes) {
    const head = `${marker} `;
    if (bytes <= head.length) return head.slice(0, bytes);
    return head + filler(rng, bytes - head.length);
}

// Unicode that a real long-lived user directory carries, and that a naive byte-oriented path/JSON
// implementation can corrupt. Kept in one place so the manifest can name what was planted.
export const UNICODE_MARKERS = Object.freeze({
    cjk: '長い旅路の記憶',
    katakana: 'ロングライブ・コーパス',
    accented: 'Élan déjà vu — naïve façade',
    emoji: '🦊🌙✨',
});

// ---------------------------------------------------------------------------------------------------------------
// THE TREE: write, walk, digest.
// ---------------------------------------------------------------------------------------------------------------

export function sha256(buffer) {
    return createHash('sha256').update(buffer).digest('hex');
}

function normaliseRelative(relative) {
    return String(relative).split(path.sep).join('/');
}

/**
 * Write `files` (Map/array of [relativePath, Buffer|string]) under `root`, creating directories.
 *
 * Files are written in SORTED path order so the order of directory creation cannot leak into anything a
 * later walk observes. Existing content is overwritten only when `force` is set; a builder that silently
 * writes into a user directory is how a qualification input becomes a user's damaged tree.
 */
export async function writeTree(root, files, { force = false } = {}) {
    const ordered = [...files].map(([relative, body]) => [normaliseRelative(relative), body]).sort((left, right) => left[0].localeCompare(right[0], 'en'));
    for (const [relative, body] of ordered) {
        const target = path.join(root, relative);
        await fs.mkdir(path.dirname(target), { recursive: true });
        if (!force) {
            const exists = await fs.stat(target).then(() => true, () => false);
            if (exists) throw new Error(`writeTree: refusing to overwrite ${relative} without --force`);
        }
        await fs.writeFile(target, typeof body === 'string' ? Buffer.from(body, 'utf8') : body);
    }
    return ordered.length;
}

/** Every regular file under `root`, sorted, relative, forward-slash, with size and sha256. */
export async function walkTree(root) {
    const entries = [];
    const walk = async directory => {
        const children = await fs.readdir(directory, { withFileTypes: true });
        for (const child of children) {
            const full = path.join(directory, child.name);
            if (child.isDirectory()) await walk(full);
            else if (child.isFile()) {
                const body = await fs.readFile(full);
                entries.push({
                    path: normaliseRelative(path.relative(root, full)),
                    bytes: body.length,
                    sha256: sha256(body),
                });
            }
        }
    };
    await walk(root);
    entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
    return entries;
}

/**
 * The tree's identity: sha256 over sorted `<sha256>  <path>\n` lines.
 *
 * `manifest.json` is excluded because it CONTAINS the digest: including it would make the identity
 * self-referential and therefore unverifiable. Excluding exactly one named file, rather than every
 * `*.json`, keeps the exclusion narrow (differential doctrine 2 in spirit).
 */
export const MANIFEST_NAME = 'manifest.json';

export function treeDigest(entries) {
    const lines = entries
        .filter(entry => entry.path !== MANIFEST_NAME)
        .map(entry => `${entry.sha256}  ${entry.path}\n`)
        .join('');
    return { sha256: sha256(Buffer.from(lines, 'utf8')), files: entries.filter(entry => entry.path !== MANIFEST_NAME).length };
}

export function countWhere(entries, predicate) {
    return entries.filter(predicate).length;
}

// ---------------------------------------------------------------------------------------------------------------
// THE MANIFEST.
// ---------------------------------------------------------------------------------------------------------------

/**
 * The machine-readable record of what was planted. Counts are DERIVED from the file list where possible
 * (so the manifest cannot claim a file that is not there) and otherwise declared by the builder and
 * asserted by `tools/longlived/verify.mjs` against the tree.
 */
export function buildManifest({ generator, generatorVersion, seed, size, profile, entries, counts }) {
    const identity = treeDigest(entries);
    const totalBytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
    return {
        schema: 'gotavern-longlived-corpus',
        schemaVersion: 1,
        generator,
        generatorVersion,
        seed,
        size,
        // NOT a timestamp: a clock in the manifest makes two rebuilds differ, which is exactly the
        // property this corpus exists to deny.
        profile: {
            characters: profile.characters,
            chatsPerCharacter: profile.chatsPerCharacter,
            longChatMessages: profile.longChatMessages,
            longChatMessageBytes: profile.messageBytes,
            worldbooks: profile.worldbooks,
            entriesPerWorld: profile.entriesPerWorld,
            presets: profile.presetCount,
            themes: profile.themes,
            backgrounds: profile.backgrounds,
            groups: profile.groups,
        },
        counts: {
            ...counts,
            files: identity.files,
            bytes: totalBytes,
        },
        tree: { sha256: identity.sha256, files: identity.files, bytes: totalBytes },
        // The file inventory makes the digest reproducible without rebuilding: a verifier walks the tree,
        // compares each sha256, then compares the digest line-for-line.
        inventory: entries.map(entry => ({ path: entry.path, bytes: entry.bytes, sha256: entry.sha256 })),
    };
}
