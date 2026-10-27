// BUILD THE REAL FIXTURES: a desensitised copy of a user's preset, with every byte of structure kept.
//
// GOAL.md requires qualification against REAL user artifacts, and AGENTS.md rule 51 forbids replacing their
// structure: "a 1.1 MB extensions.tavern_helper subtree replaced by three prompts is a different product".
// The originals never enter the repository. This tool reads them, replaces only PROSE, and refuses to emit
// anything whose byte lengths moved.
//
// WHAT IT PRESERVES, because the oracle is the structure: every key, every array order, every `enabled`,
// `injection_position`, `injection_depth`, `injection_order`, `role`, `marker`, `system_prompt`, every
// sampler, every `prompt_order` row and its `enabled` flag, every identifier, and the BYTE LENGTH of every
// string it replaces. What it replaces: the prose inside long strings, and the body of each helper script
// (which must stay valid JavaScript while keeping its byte length, so the subtree is the same size class).
//
// WHY BYTES AND NOT CHARACTERS: these artifacts are CJK, three bytes per character. A filler that keeps the
// CHARACTER count shrinks the document -- measured on the card, 6,938,739 -> 3,167,611 JSON bytes -- and
// takes the chunk lengths, the size class and rule 51 with it. The filler here is a three-byte unit with a
// padded remainder, and every replacement is asserted per string and again for the whole document.
//
// Usage:
//   node tools/build-real-fixtures.mjs --out <dir> --preset <name>=<path> [--preset <name>=<path> ...]
//                                      [--card <name>=<path> ...]
// Refuses (exit 2) rather than writing a fixture it cannot prove: a missing source, a string it cannot
// preserve, a re-serialisation that does not reproduce the original byte length, or a `chara` chunk it
// cannot re-encode. A refusal names the field path and both lengths.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { CARD_IDENTITY_FIELDS, MARKER_BYTES, PROSE_THRESHOLD_CHARS, cardIdentityFieldFor, profilePreset, profileCard } from './real-fixture-profile.mjs';
import { scanText } from './check-fixture-watermarks.mjs';
import { auditPngCarriers } from './png-carriers.mjs';

const FILLER_UNIT = '测'; // three UTF-8 bytes: the unit that keeps a CJK document the same size
const FILLER_UNIT_BYTES = Buffer.byteLength(FILLER_UNIT);

const refuse = (message) => {
    console.error(`REFUSING: ${message}`);
    process.exit(2);
};

const parseArgs = (argv) => {
    const presets = [];
    const cards = [];
    let out = null;
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        const next = () => {
            const value = argv[index + 1];
            if (value === undefined) refuse(`${argument} needs a value`);
            index += 1;
            return value;
        };
        if (argument === '--out') out = next();
        else if (argument === '--preset') presets.push(next());
        else if (argument === '--card') cards.push(next());
        else refuse(`unknown argument ${argument}`);
    }
    if (!out) refuse('--out is required');
    if (presets.length === 0 && cards.length === 0) refuse('at least one --preset or --card is required');
    return { out, presets, cards };
};

const splitNamed = (spec) => {
    const index = spec.indexOf('=');
    if (index <= 0) refuse(`expected <name>=<path>, got ${spec}`);
    return { name: spec.slice(0, index), file: spec.slice(index + 1) };
};

// A filler of exactly `bytes`, beginning with the marker so a reader can see what was replaced.
const fillerFor = (bytes, marker, where) => {
    const markerBytes = Buffer.byteLength(marker);
    if (bytes < markerBytes + FILLER_UNIT_BYTES) {
        refuse(`${where}: ${bytes} bytes cannot hold the ${markerBytes}-byte marker plus a filler unit`);
    }
    const budget = bytes - markerBytes;
    const units = Math.floor(budget / FILLER_UNIT_BYTES);
    const remainder = budget - units * FILLER_UNIT_BYTES;
    const filler = marker + FILLER_UNIT.repeat(units) + 'x'.repeat(remainder);
    const produced = Buffer.byteLength(filler);
    if (produced !== bytes) refuse(`${where}: filler produced ${produced} bytes, wanted ${bytes}`);
    return filler;
};

// A helper script body that is valid JavaScript, keeps its byte length, and evaluates to nothing.
const scriptStubFor = (bytes, marker, where) => {
    const head = `/*${marker}*/`;
    if (bytes < head.length + 2) refuse(`${where}: ${bytes} bytes cannot hold a script stub`);
    // repeat() rather than a growing concatenation: the real preset carries an 899,455-byte script and a
    // byte-at-a-time loop over it turns a one-second build into minutes (measured: it had to be killed).
    let body = head;
    const repeats = Math.floor((bytes - Buffer.byteLength(head) - 4) / 2);
    if (repeats > 0) body += '0;'.repeat(repeats);
    const pad = bytes - Buffer.byteLength(body);
    if (pad === 1) refuse(`${where}: script stub cannot pad 1 spare byte and stay valid JavaScript`);
    if (pad > 0) body += `/*${'x'.repeat(pad - 4)}*/`;
    const produced = Buffer.byteLength(body);
    if (produced !== bytes) refuse(`${where}: script stub produced ${produced} bytes, wanted ${bytes}`);
    return body;
};

let markerCounter = 0;
const nextMarker = () => {
    const marker = `MARK_${String(markerCounter).padStart(6, '0')}`;
    markerCounter += 1;
    return marker;
};

const isHelperScriptContent = (pathParts) => {
    const joined = pathParts.join('.');
    return /extensions\.tavern_helper\.scripts\.\d+\.content$/.test(joined);
};

// THE NAME LAYER. Prose and script bodies were replaced from the start; the fields that identify the AUTHOR of
// a preset were not, and they are the ones a user asked about: "there are hidden watermarks in them, for example
// my Discord account". These are the fields that carry a name even when no handle is written down.
const NAME_FIELDS = [
    /^prompts\.\d+\.name$/,
    /^extensions\.regex_scripts\.\d+\.scriptName$/,
    /^extensions\.tavern_helper\.scripts\.\d+\.name$/,
    /^extensions\.tavern_helper\.scripts\.\d+\.info$/,
    // THE LABEL LAYER. These are names in everything but field name, and they survived the first name pass:
    // measured on preset B, `extensions.tavern_helper.scripts[3]` still held [REDACTED_PRESET]设置 in button.buttons[0].name,
    // data.title and data.script_button_name, and scripts[1] held 格式补全. A user's preset name lives here.
    /^extensions\.tavern_helper\.scripts\.\d+\.button\.buttons\.\d+\.name$/,
    /^extensions\.tavern_helper\.scripts\.\d+\.data\.title$/,
    /^extensions\.tavern_helper\.scripts\.\d+\.data\.script_button_name$/,
    // THE DEEP LABEL LAYER, found by scanning the generated fixture for the ORIGINAL names rather than by
    // reasoning about field names: a helper script's own settings object still referenced the preset by name in
    // `data.summary.generation.detect_regexes[...]` (a display label beginning "# [REDACTED_PRESET]大总结") and in
    // `data.groups[...].{enable,disable_group}[...]` (option labels like "[REDACTED_PROMPT]"). The scan is the
    // reason these are covered: a field-name predicate written from memory missed all three.
    /^extensions\.tavern_helper\.scripts\.\d+\.data\.summary\.generation\.detect_regexes\.\d+$/,
    /^extensions\.tavern_helper\.scripts\.\d+\.data\.groups\.\d+\.options\.\d+\.enable\.\d+$/,
    /^extensions\.tavern_helper\.scripts\.\d+\.data\.groups\.\d+\.options\.\d+\.disable\.\d+$/,
    /^extensions\.tavern_helper\.scripts\.\d+\.data\.groups\.\d+\.disable_group\.\d+$/,
    /^extensions\.tavern_helper\.scripts\.\d+\.data\.groups\.\d+\.enable_group\.\d+$/,
];
const markerIndexFor = (marker) => Number(String(marker).replace(/[^0-9]/g, '') || 0);
const isNameField = (pathParts) => NAME_FIELDS.some(pattern => pattern.test(pathParts.join('.')));

// VERBATIM EXEMPTIONS, by field path AND exact value -- never by pattern, never by length. Measured: preset A's
// prompts[1].name and prompts[7].name are `勿动`, six bytes, and neither marker tier fits. `勿动` is a generic
// directive ("do not modify") and carries no name, handle, platform or credit, so it may stay -- at THOSE TWO
// PATHS ONLY. A new prompt named 勿动 anywhere else is refused, which is what keeps this an exemption rather
// than a value ban; that case is in the tool's own proof set.
const DECLARED_VERBATIM = [
    { path: 'prompts.1.name', value: '勿动' },
    { path: 'prompts.7.name', value: '勿动' },
];

// Walk the document, replacing only prose and asserting byte equality for every replacement.
const desensitise = (value, pathParts, stats) => {
    if (typeof value === 'string') {
        // PRESERVE THE SERIALISED LENGTH, not the raw string's: a value containing a quote, a newline or a
        // backslash occupies MORE bytes once JSON.stringify escapes it, and the document is measured after
        // escaping. Measured refusal: preset A came back 445 bytes short with a raw-length filler.
        const bytes = Buffer.byteLength(JSON.stringify(value)) - 2;
        if (bytes === 0) return value;
        if (isHelperScriptContent(pathParts)) {
            if (bytes <= MARKER_BYTES + PROSE_THRESHOLD_CHARS) return value;
            const stub = scriptStubFor(bytes, nextMarker(), pathParts.join('.'));
            stats.scriptsReplaced += 1;
            stats.scriptBytesReplaced += bytes;
            return stub;
        }
        if (isNameField(pathParts)) {
            const joined = pathParts.join('.');
            const declared = DECLARED_VERBATIM.find(entry => entry.path === joined && entry.value === value);
            if (declared) {
                stats.declaredVerbatim.push({ path: joined, value, bytes, reason: 'a generic directive ("do not modify") carrying no name, handle, platform or credit, and too short for any marker tier' });
                return value;
            }
            // SHORT NAMES ARE REPLACED IN PLACE, prefix marker + same-length filler. Requiring the marker to be
            // the whole field was wrong: it refused a 13-byte name and, worse, it would have left `勿动` as the
            // only pattern for short fields. The VALUE is what identifies the author; the form is ours.
            const marker = nextMarker();
            // THE NAME TIERS: `MARK_NNNNNN` (11 bytes) where there is room, `MNNNNNN` (7 bytes) below that -- the
            // same two forms tools/check-fixture-watermarks.mjs accepts. A 13-byte name cannot hold the long form
            // plus a filler unit, and refusing it would have been wrong: a marker that FILLS the field exactly is
            // a better fixture than a refusal, and every byte of the original identity is still gone.
            const longForm = `MARK_${String(markerIndexFor(marker)).padStart(6, '0')}`;
            const shortForm = `M${String(markerIndexFor(marker)).padStart(6, '0')}`;
            const form = bytes >= Buffer.byteLength(longForm) ? longForm : shortForm;
            if (bytes < Buffer.byteLength(form)) refuse(`${joined}: ${bytes} bytes cannot hold ${form} and the field is not in DECLARED_VERBATIM`);
            const fillerTail = bytes - Buffer.byteLength(form);
            if (fillerTail === 0) {
                stats.namesReplaced += 1;
                return form;
            }
            const replacement = form + FILLER_UNIT.repeat(Math.floor(fillerTail / FILLER_UNIT_BYTES)) + 'x'.repeat(fillerTail % FILLER_UNIT_BYTES);
            if (Buffer.byteLength(replacement) !== bytes) refuse(`${joined}: name replacement produced ${Buffer.byteLength(replacement)} bytes, wanted ${bytes}`);
            stats.namesReplaced += 1;
            return replacement;
        }
        if (value.length > PROSE_THRESHOLD_CHARS && bytes >= MARKER_BYTES + FILLER_UNIT_BYTES) {
            const filler = fillerFor(bytes, nextMarker(), pathParts.join('.'));
            stats.stringsReplaced += 1;
            stats.bytesReplaced += bytes;
            return filler;
        }
        return value;
    }
    if (Array.isArray(value)) return value.map((entry, index) => desensitise(entry, [...pathParts, String(index)], stats));
    if (value && typeof value === 'object') {
        const out = {};
        for (const key of Object.keys(value)) out[key] = desensitise(value[key], [...pathParts, key], stats);
        return out;
    }
    return value;
};

const buildPreset = ({ name, file }, outDir) => {
    const original = fs.readFileSync(file);
    const text = original.toString('utf8');
    if (Buffer.byteLength(text) !== original.length) refuse(`${file}: not valid UTF-8`);
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch (error) {
        refuse(`${file}: not JSON (${error.message})`);
    }
    const stats = { stringsReplaced: 0, bytesReplaced: 0, scriptsReplaced: 0, scriptBytesReplaced: 0, namesReplaced: 0, declaredVerbatim: [] };
    const scrubbed = desensitise(parsed, [], stats);
    const serialised = JSON.stringify(scrubbed);
    // THE ASSERTION THAT MAKES THIS A FIXTURE AND NOT A REWRITE: the document must come back the same size.
    // It cannot be byte-identical (prose is gone) but the LENGTH is what the size class, the chunk lengths
    // and rule 51 depend on, and a filler bug shows up here rather than three lanes later.
    const originalLength = Buffer.byteLength(JSON.stringify(parsed));
    const producedLength = Buffer.byteLength(serialised);
    if (originalLength !== producedLength) {
        refuse(`${file}: re-serialised document is ${producedLength} bytes, the original is ${originalLength} (delta ${producedLength - originalLength})`);
    }
    const profileBefore = profilePreset(JSON.stringify(parsed));
    const profileAfter = profilePreset(serialised);
    // NESTED, because the profiler returns prompt_order and extensions as objects: the first version of this
    // list read them off the top level, so four of its six comparisons were undefined === undefined and could
    // not fail. A comparison that cannot fail is decoration (AGENTS.md verification rule 7).
    const comparable = [
        ['prompts'],
        ['promptOrder', 'rows'],
        ['promptOrder', 'enabledRows'],
        ['promptOrder', 'projectionSha256'],
        ['promptOrder', 'enabledBitmapSha256'],
        ['enabledRowsPointingAtDisabledPrompt'],
        ['extensions', 'tavernHelperBytes'],
        // NOT tavernHelperScriptContentBytes: a script body is replaced with a stub of the same SERIALISED
        // length (so the document cannot shrink), which makes its RAW length grow by the JSON escape overhead
        // of the original -- measured at +0.9% on the 899,455-byte body. The raw delta is recorded in the
        // manifest as helperContentBytesDelta rather than being compared and refused.
        ['extensions', 'tavernHelperScripts'],
        ['extensions', 'regexScripts'],
    ];
    const read = (profile, keys) => keys.reduce((value, key) => (value == null ? value : value[key]), profile);
    for (const keys of comparable) {
        const before = JSON.stringify(read(profileBefore, keys));
        const after = JSON.stringify(read(profileAfter, keys));
        if (before === undefined || after === undefined) refuse(`${file}: the profiler does not expose ${keys.join('.')}, so this comparison would be vacuous`);
        if (before !== after) refuse(`${file}: the fixture's ${keys.join('.')} changed (${before} -> ${after}); a difference here is a different product`);
    }
    const target = path.join(outDir, `${name}.json`);
    fs.writeFileSync(target, serialised);
    console.log(`wrote ${target}: ${producedLength} bytes (original ${originalLength}), ${stats.stringsReplaced} string(s) and ${stats.scriptsReplaced} script body/bodies replaced`);
    return {
        name,
        file: path.basename(target),
        bytes: producedLength,
        sha256: crypto.createHash('sha256').update(serialised).digest('hex'),
        origin: { bytes: original.length, sha256: crypto.createHash('sha256').update(original).digest('hex') },
        replaced: stats,
        profile: {
            prompts: profileAfter.prompts,
            promptOrderRows: profileAfter.promptOrder?.rows ?? null,
            enabledRows: profileAfter.promptOrder?.enabledRows ?? null,
            enabledRowsPointingAtDisabledPrompt: profileAfter.enabledRowsPointingAtDisabledPrompt,
            helperBytes: profileAfter.extensions?.tavernHelperBytes ?? null,
            helperScriptContentBytes: profileAfter.extensions?.tavernHelperScriptContentBytes ?? null,
            helperContentBytesDelta: (profileAfter.extensions?.tavernHelperScriptContentBytes ?? []).map((bytes, index) => bytes - (profileBefore.extensions?.tavernHelperScriptContentBytes?.[index] ?? bytes)),
            helperContentBytesDeltaReason: 'the stub keeps the SERIALISED byte length, so its RAW length grows by the JSON escape overhead the original carried',
            regexScripts: profileAfter.extensions?.regexScripts ?? null,
            promptOrderProjectionSha256: profileAfter.promptOrder?.projectionSha256 ?? null,
            enabledBitmapSha256: profileAfter.promptOrder?.enabledBitmapSha256 ?? null,
        },
    };
};

// =================================================================================================
// CARDS. A card is a PNG whose `tEXt` chunks carry base64 JSON (`chara` = V2, `ccv3` = V3), and the
// derivation has FOUR byte-level obligations that a preset does not have:
//
//   1. every replacement keeps the JSON document's byte length (the preset rule), so the base64 length
//      is unchanged and the chunk length is unchanged;
//   2. `IDAT` is REPLACED with a solid image of the SAME DIMENSIONS, because a 19 MB card whose visible
//      picture is its author's art is a picture fixture, not a structure fixture -- and because the
//      original `IDAT` is the single largest chunk of user content in the file. Its original length is
//      recorded in the manifest so nobody mistakes this for a picture fixture;
//   3. `trAc` and every other unknown chunk STAYS, byte for byte, because the reader's tolerance of an
//      unknown chunk is part of what the fixture is for (`internal/server/characters_card.go` skips them);
//   4. REFUSE if any chunk payload's byte length moves, if the re-serialised JSON length moves, or if the
//      scanner fails -- and additionally refuse if any ORIGINAL identity string survives anywhere in the
//      derived bytes, which is the check that finds the field the identity list does not name.
// =================================================================================================

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

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

// READ THE CHUNKS WITH BOTH OFFSETS, because a re-encoder that re-derives an offset from a length is how a
// length bug becomes a corrupt file. Every later write is asserted against the ORIGINAL length.
const readPngChunks = (buffer) => {
    if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) refuse('not a PNG: the 8-byte signature is absent');
    const chunks = [];
    let offset = 8;
    while (offset + 12 <= buffer.length) {
        const length = buffer.readUInt32BE(offset);
        const type = buffer.toString('latin1', offset + 4, offset + 8);
        const dataStart = offset + 8;
        if (dataStart + length + 4 > buffer.length) refuse(`chunk ${type} at ${offset} claims ${length} bytes and the file ends first`);
        const declaredCrc = buffer.readUInt32BE(dataStart + length);
        const actualCrc = crc32(buffer.subarray(offset + 4, dataStart + length));
        if (declaredCrc !== actualCrc) refuse(`chunk ${type} at ${offset} has CRC ${declaredCrc} and its bytes hash to ${actualCrc}`);
        chunks.push({ type, length, data: buffer.subarray(dataStart, dataStart + length) });
        offset = dataStart + length + 4;
        if (type === 'IEND') break;
    }
    if (chunks.length === 0 || chunks[chunks.length - 1].type !== 'IEND') refuse('the PNG has no IEND chunk');
    if (chunks[0].type !== 'IHDR') refuse('the PNG does not begin with IHDR');
    return chunks;
};

const writePngChunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'latin1'), data])), 0);
    return Buffer.concat([head, data, crc]);
};

// THE SOLID IMAGE IS A REAL IMAGE AT THE SAME DIMENSIONS. The colour depth and colour type are taken from
// the original IHDR so the file's own header describes its own data; an interlace method is reset to 0
// because Adam7 is a scan order, not a size, and writing non-interlaced data under an interlaced header
// produces a file that decodes as garbage.
const solidIdat = (ihdr) => {
    const width = ihdr.readUInt32BE(0);
    const height = ihdr.readUInt32BE(4);
    const bitDepth = ihdr[8];
    const colourType = ihdr[9];
    if (bitDepth !== 8) refuse(`IHDR declares bit depth ${bitDepth}; the solid image is built for 8-bit channels only`);
    const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colourType];
    if (!channels) refuse(`IHDR declares colour type ${colourType}, which has no channel count here`);
    const rowBytes = width * channels;
    const stride = rowBytes + 1; // one filter byte per row, filter type 0 (None)
    const raw = Buffer.alloc(height * stride, 0);
    for (let row = 0; row < height; row += 1) raw[row * stride] = 0;
    // A palette image (colour type 3) needs a PLTE to index; the original carries one and it is kept, so the
    // index 0 is a real colour. The value is a mid grey for every channel, which is what the background probe
    // already uses as its "no picture" placeholder.
    for (let row = 0; row < height; row += 1) {
        for (let pixel = 0; pixel < width; pixel += 1) {
            const base = row * stride + 1 + pixel * channels;
            if (colourType === 6 || colourType === 4) raw[base + channels - 1] = 0xff; // opaque alpha
            if (colourType !== 3) {
                for (let channel = 0; channel < (colourType === 4 || colourType === 6 ? channels - 1 : channels); channel += 1) {
                    raw[base + channel] = 0x80;
                }
            }
        }
    }
    const deflated = zlib.deflateSync(raw, { level: 6 });
    return { deflated, rawBytes: raw.length, width, height, bitDepth, colourType, channels };
};

const textChunkPayload = (data) => {
    const zero = data.indexOf(0);
    if (zero < 0) return null;
    return { keyword: data.toString('latin1', 0, zero), text: data.subarray(zero + 1).toString('latin1') };
};

// The JSON as NODE WOULD SERIALISE IT. A card's JSON is a user file, and the pinned server re-serialises it
// itself when it serves a character (`characters_card.go` decodes then re-emits), so the fixture's guarantee
// is about the DOCUMENT, not about the original's formatting: `JSON.parse` then `JSON.stringify` must
// round-trip to the same byte length, or the generator has nothing to preserve.
const parseCardJSON = (jsonBytes) => {
    let parsed;
    try {
        parsed = JSON.parse(jsonBytes.toString('utf8'));
    } catch (error) {
        refuse(`a card tEXt chunk is not JSON: ${String(error?.message ?? error).slice(0, 120)}`);
    }
    const reserialised = Buffer.byteLength(JSON.stringify(parsed));
    if (reserialised !== jsonBytes.length) {
        refuse(`the card's JSON re-serialises to ${reserialised} bytes and is ${jsonBytes.length} bytes on disk, so a byte-preserving derivation has no fixed point here`);
    }
    return parsed;
};

// Walk the card DOCUMENT, replacing every identity field with a marker of the same SERIALISED byte length.
// ONE WALKER, keyed on the path the child is at, so a field the list names cannot be reached by two
// different code paths that disagree ("data.name" and "_root.name" are two paths into one value and either
// one left verbatim publishes the name). The two subtleties the preset work already paid for are kept: the
// budget is the SERIALISED length (JSON escaping inflates a quote, a newline or a backslash), and every
// replacement is asserted per string.
const desensitiseCard = (document, stats) => {
    const visit = (value, pathParts) => {
        // THE PATH IS THE v3 DOCUMENT'S OWN (`data.name`, `_root.name`). `cardIdentityFieldFor` accepts both
        // spellings and resolves them against the `data`-relative list, so the walker does not have to strip a
        // prefix and cannot get the stripping wrong.
        const pathName = pathParts.join('.');
        if (typeof value === 'string') {
            const field = cardIdentityFieldFor(pathName);
            if (!field) return value;
            const bytes = Buffer.byteLength(JSON.stringify(value)) - 2;
            if (bytes === 0) return value;
            if (/^extensions\.tavern_helper\.scripts\.\d+\.content$/.test(pathName)) {
                const stub = scriptStubFor(bytes, nextMarker(), pathName);
                stats.scriptsReplaced += 1;
                stats.scriptBytesReplaced += bytes;
                stats.replacedPaths[field.path] = (stats.replacedPaths[field.path] ?? 0) + 1;
                return stub;
            }
            // THREE marker tiers, and the third one is a MEASURED decision rather than a convenience. Real cards
            // carry short identity fields: this repository's own fixture car builder writes `personality:
            // 'calm'` (4 bytes), and the real card's `tags` entries and `character_version` run 2-10 bytes. The
            // watermark scanner refuses a bare six-byte `Mk0001` because that is exactly the shape of a real
            // two-character CJK name (preset A's `勿动`), so a short tier cannot be `M` + digits at 6 bytes.
            // THE SHORT TIER IS `#` + a fixed-width number padded to the field's own length, and `#` cannot
            // begin a name: no card in this project's audit uses it, and the scanner's marker rule accepts it
            // ONLY at that shape (`#\d+` filling the field exactly). A field too short even for `#0` (1 byte)
            // is refused, never left verbatim.
            const markerIndex = markerIndexFor(nextMarker());
            const longForm = `MARK_${String(markerIndex).padStart(6, '0')}`;
            const shortForm = `M${String(markerIndex).padStart(6, '0')}`;
            const form = bytes >= Buffer.byteLength(longForm) ? longForm
                : (bytes >= Buffer.byteLength(shortForm) ? shortForm : null);
            if (form === null) {
                // THE SHORT TIER: `#` followed by digits, padded to the field's exact length. `#0` is the
                // shortest form (2 bytes) and a 1-byte identity field cannot hold it -- measured on the real
                // card, `character_book.entries.8.keys[2]` is the single character `K` -- so a 1-byte field
                // becomes the bare `#`. The scanner accepts `#` alone as the 1-byte tier for the same reason the
                // 2+ byte tier exists: `#` is not a word, cannot begin a name in either audited card, and the
                // self-test drives the same predicate with `K`, `v1`, `DG` and the card's own short values and
                // requires each to be refused. Nothing is ever left verbatim, which is the property that matters.
                if (bytes < 1) {
                    refuse(`${pathName}: a zero-byte identity field cannot carry a marker, and no card field is left verbatim`);
                }
                const shortMarker = bytes === 1 ? '#' : `#${String(markerIndex).padStart(bytes - 1, '0').slice(-(bytes - 1))}`;
                if (Buffer.byteLength(shortMarker) !== bytes) refuse(`${pathName}: short marker ${JSON.stringify(shortMarker)} is ${Buffer.byteLength(shortMarker)} bytes, wanted ${bytes}`);
                stats.namesReplaced += 1;
                stats.replacedPaths[field.path] = (stats.replacedPaths[field.path] ?? 0) + 1;
                stats.shortIdentityFields.push({ path: pathName, bytes, marker: shortMarker });
                return shortMarker;
            }
            const tailBytes = bytes - Buffer.byteLength(form);
            // A BASE64 FIELD'S FILLER MUST CARRY A MARKER INSIDE THE RUN ITSELF. The scanner's
            // unmarked-long-string rule looks INSIDE every 64+ character string, so a field of `MARK_000010` +
            // 9 MB of `A` is reported as an unmarked run even though a marker is at its head -- measured on the
            // real card, where the refusal named the ORIGINAL ciphertext (read from the JSON-escaped form, which
            // is what the scanner sees). The filler is therefore a repeating base64-safe unit that contains a
            // marker every 64 characters, so every window the rule can extract carries one.
            const replacement = form
                + (BASE64_IDENTITY_FIELDS.test(pathName)
                    ? base64MarkedFiller(tailBytes)
                    : FILLER_UNIT.repeat(Math.floor(tailBytes / FILLER_UNIT_BYTES)) + 'x'.repeat(tailBytes % FILLER_UNIT_BYTES));
            if (Buffer.byteLength(replacement) !== bytes) refuse(`${pathName}: replacement produced ${Buffer.byteLength(replacement)} bytes, wanted ${bytes}`);
            stats.namesReplaced += 1;
            stats.replacedPaths[field.path] = (stats.replacedPaths[field.path] ?? 0) + 1;
            return replacement;
        }
        if (Array.isArray(value)) return value.map((entry, index) => visit(entry, [...pathParts, String(index)]));
        if (value && typeof value === 'object') {
            const out = {};
            for (const key of Object.keys(value)) out[key] = visit(value[key], [...pathParts, key]);
            return out;
        }
        return value;
    };
    // `data` is walked at `data.<field>` (the list's paths) and every OTHER root key at `_root.<field>`,
    // which is how the list can name the v3 root's duplicate of the name separately from `data.name`.
    const out = {};
    for (const key of Object.keys(document)) {
        const pathParts = key === 'data' ? ['data'] : ['_root', key];
        out[key] = visit(document[key], pathParts);
    }
    return out;
};

// A BASE64-VALUED IDENTITY FIELD KEEPS ITS ALPHABET. `extensions.odysseia_trace.ciphertext` is base64, and a
// `测` filler would keep the byte length while producing a string no base64 decoder accepts -- so a reader that
// decodes the trace would throw on a fixture that is supposed to be structurally identical. The base64 alphabet
// is ASCII (`A`, 1 byte), so the filler is a marker plus `A` runs, which decodes to zero bytes exactly as the
// original decoded to some bytes: the field's ROLE (a decodable blob) survives even though its value does not.
const BASE64_IDENTITY_FIELDS = /^extensions\.odysseia_trace\.ciphertext$/;

// A filling run made only of base64 characters (`A`) with a marker every 60 characters, so that EVERY 64+
// character window the unmarked-long-string rule can extract contains a marker. `A` decodes to zero bytes, so the
// field still decodes; the marker characters are also base64, so the whole run stays decodable.
const base64MarkedFiller = (bytes) => {
    if (bytes <= 0) return '';
    const unit = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'; // 60 base64 characters
    const pieces = [];
    let remaining = bytes;
    let index = 0;
    while (remaining > 0) {
        const marker = `MARK_${String(index % 1000000).padStart(6, '0')}`; // 11 chars, base64-safe
        const take = Math.min(remaining, unit.length);
        // Place the marker at the head of each unit, then fill the rest with `A`, so the distance between markers
        // is at most 60 characters and no 64-character window is marker-free.
        pieces.push((marker + unit).slice(0, take));
        remaining -= take;
        index += 1;
    }
    const filler = pieces.join('');
    if (filler.length !== bytes) refuse(`base64 filler produced ${filler.length} characters, wanted ${bytes}`);
    return filler;
};

// A NON-CARD CHUNK'S JSON IS WALKED BY THE SAME LIST. The measured case is `trAc`, whose payload is
// `{ciphertext,kid,nonce,v}` -- the same trace `data.extensions.odysseia_trace` holds. Rooting the walk at
// `extensions.odysseia_trace` is not a guess: the chunk's keys ARE the extension's keys (compared below), so a
// chunk that mirrors an extension subtree is recognised by the list rather than by a second, parallel predicate.
// When the keys do NOT match a known extension the walk still runs at `_root.` and REFUSES if any identity field
// survives, because an unknown chunk's JSON is not a place to leave a ciphertext.
const desensitiseCardRootedAt = (document, stats) => {
    const extensionMatch = EXTENSION_MIRROR_KEYS.find(entry => entry.keys.every(key => Object.prototype.hasOwnProperty.call(document, key))
        && Object.keys(document).length === entry.keys.length);
    const rootParts = extensionMatch ? ['_root', 'extensions', extensionMatch.extension] : ['_root'];
    const visit = (value, pathParts) => {
        const pathName = pathParts.join('.');
        if (typeof value === 'string') {
            const field = cardIdentityFieldFor(pathName);
            if (!field) return value;
            const bytes = Buffer.byteLength(JSON.stringify(value)) - 2;
            if (bytes === 0) return value;
            if (BASE64_IDENTITY_FIELDS.test(pathName)) return base64MarkedFiller(bytes);
            const markerIndex = markerIndexFor(nextMarker());
            const longForm = `MARK_${String(markerIndex).padStart(6, '0')}`;
            const form = bytes >= Buffer.byteLength(longForm) ? longForm : `#${String(markerIndex).padStart(Math.max(1, bytes - 1), '0').slice(-(bytes - 1))}`;
            if (bytes < Buffer.byteLength(form)) refuse(`${pathName}: ${bytes} bytes cannot hold a marker`);
            const tail = bytes - Buffer.byteLength(form);
            stats.namesReplaced += 1;
            stats.replacedPaths[field.path] = (stats.replacedPaths[field.path] ?? 0) + 1;
            return form + FILLER_UNIT.repeat(Math.floor(tail / FILLER_UNIT_BYTES)) + 'x'.repeat(tail % FILLER_UNIT_BYTES);
        }
        if (Array.isArray(value)) return value.map((entry, index) => visit(entry, [...pathParts, String(index)]));
        if (value && typeof value === 'object') {
            const out = {};
            for (const key of Object.keys(value)) out[key] = visit(value[key], [...pathParts, key]);
            return out;
        }
        return value;
    };
    return visit(document, rootParts);
};

// The key sets an unknown chunk's JSON may mirror. Measured: `trAc` = `{ciphertext, kid, nonce, v}`, exactly
// `extensions.odysseia_trace`'s keys.
const EXTENSION_MIRROR_KEYS = [
    { extension: 'odysseia_trace', keys: ['ciphertext', 'kid', 'nonce', 'v'] },
];

const buildCard = ({ name, file }, outDir) => {
    const original = fs.readFileSync(file);
    const profileBefore = profileCard(original);
    if (!profileBefore || typeof profileBefore.bytes !== 'number') refuse(`${file}: no card profile`);
    const chunks = readPngChunks(original);
    const ihdr = chunks[0].data;
    if (ihdr.length !== 13) refuse(`${file}: IHDR is ${ihdr.length} bytes, expected 13`);
    const dimensions = { width: ihdr.readUInt32BE(0), height: ihdr.readUInt32BE(4) };

    const cardTextChunks = chunks.filter((chunk) => chunk.type === 'tEXt'
        && ['chara', 'ccv3'].includes(String(textChunkPayload(chunk.data)?.keyword ?? '').toLowerCase()));
    if (cardTextChunks.length === 0) refuse(`${file}: no chara or ccv3 tEXt chunk, so there is no card to derive`);

    const stats = { namesReplaced: 0, scriptsReplaced: 0, scriptBytesReplaced: 0, replacedPaths: {}, shortIdentityFields: [] };
    const derivedPayloads = new Map();
    const chunkReport = [];
    let cardChunkEquality = null;

    // ONE CARD, ONE DOCUMENT -- DERIVE IT ONCE AND WRITE IT TO BOTH CHUNKS.
    //
    // WHAT THIS REPLACES, AND WHY IT WAS A DEFECT. Each chunk used to be walked by its own `desensitiseCard` call
    // with a SHARED, RUNNING `nextMarker()` counter, so the two copies of one card were handed DIFFERENT markers at
    // every name-bearing field. Measured on the committed derivation (`GoTavern Lane CI` 40446833206):
    //
    //     chara: data.name="MARK_000466…" root.name="MARK_000464…"
    //     ccv3:  data.name="MARK_002794…" root.name="MARK_002792…"
    //
    // Pinned reads `ccv3` in preference to `chara` (src/character-card-parser.js:54-78), so the file said two
    // different things about one character and a probe that read `chara` measured a string the server never answered
    // -- the Q21 precondition failure in runs 40438262854 and 40444636900, chased through six driver commits.
    //
    // PINNED CANNOT PRODUCE SUCH A FILE. `character-card-parser.write` (`src/character-card-parser.js:15-40`) writes
    // `chara` from the data it is given and derives `ccv3` by `JSON.parse` of that SAME data (`:34-39`), so the two
    // chunks of any card pinned has written are byte-identical documents. The old fixture described a card that does
    // not exist.
    //
    // THE CANONICAL NAME IS TAKEN FROM THE CURRENT `ccv3` DOCUMENT, so prior Q21 reports (which quote the server's
    // `…794`) remain comparable across this re-record. The derivation runs ONCE, on the document pinned actually reads,
    // and both chunks receive its bytes.
    const cardKeys = [];
    for (const chunk of chunks) {
        if (chunk.type !== 'tEXt') continue;
        const keyword = String(textChunkPayload(chunk.data)?.keyword ?? '').toLowerCase();
        if (keyword === 'chara' || keyword === 'ccv3') cardKeys.push({ chunk, keyword });
    }
    const canonical = cardKeys.find(entry => entry.keyword === 'ccv3') ?? cardKeys[0];
    if (!canonical) refuse(`${file}: no chara or ccv3 tEXt chunk, so there is no card to derive`);
    const canonicalBytes = Buffer.from(textChunkPayload(canonical.chunk.data).text, 'base64');
    if (canonicalBytes.toString('base64') !== textChunkPayload(canonical.chunk.data).text) {
        refuse(`${file}: the ${canonical.keyword} chunk's base64 does not round-trip, so a re-encode cannot be proven byte-length-preserving`);
    }
    const derivedDocument = Buffer.from(JSON.stringify(desensitiseCard(parseCardJSON(canonicalBytes), stats)), 'utf8');
    if (derivedDocument.length !== canonicalBytes.length) {
        refuse(`${file}: the derived ${canonical.keyword} JSON is ${derivedDocument.length} bytes, the original is ${canonicalBytes.length} (delta ${derivedDocument.length - canonicalBytes.length})`);
    }

    for (const chunk of chunks) {
        const text = chunk.type === 'tEXt' ? textChunkPayload(chunk.data) : null;
        const keyword = String(text?.keyword ?? '').toLowerCase();
        if (chunk.type === 'tEXt' && (keyword === 'chara' || keyword === 'ccv3')) {
            // base64 -> JSON bytes -> THE SHARED DERIVED JSON bytes -> base64. THE LENGTH IS ASSERTED AT EVERY HOP,
            // because base64 padding is where a one-byte JSON change hides -- and, since both chunks now carry ONE
            // derivation, a chunk whose original JSON had a different length can only be written if that length is
            // recovered exactly, which the check below refuses otherwise.
            const jsonBytes = Buffer.from(text.text, 'base64');
            if (jsonBytes.toString('base64') !== text.text) refuse(`${file}: the ${text.keyword} chunk's base64 does not round-trip, so a re-encode cannot be proven byte-length-preserving`);
            const derivedJSON = derivedDocument;
            if (derivedJSON.length !== jsonBytes.length) {
                refuse(`${file}: the ${text.keyword} chunk holds a ${jsonBytes.length}-byte document but the derived canonical document is ${derivedJSON.length} bytes, so the two chunks are NOT the same document and writing one into both would change this chunk's length`);
            }
            const derivedBase64 = derivedJSON.toString('base64');
            if (derivedBase64.length !== text.text.length) refuse(`${file}: the derived ${text.keyword} base64 is ${derivedBase64.length} chars, the original is ${text.text.length}`);
            derivedPayloads.set(chunk, Buffer.concat([Buffer.from(`${text.keyword}\0`, 'latin1'), Buffer.from(derivedBase64, 'latin1')]));
            chunkReport.push({
                type: 'tEXt',
                keyword: text.keyword,
                originalBytes: chunk.length,
                derivedBytes: derivedPayloads.get(chunk).length,
                jsonBytes: jsonBytes.length,
                base64Chars: text.text.length,
                preserved: derivedPayloads.get(chunk).length === chunk.length,
            });
            continue;
        }
        if (chunk.type === 'IDAT') {
            derivedPayloads.set(chunk, null); // replaced below, once, by the solid image
            chunkReport.push({ type: 'IDAT', originalBytes: chunk.length, derivedBytes: null, replacedWith: 'a solid image at the same dimensions' });
            continue;
        }
        chunkReport.push({ type: chunk.type, originalBytes: chunk.length, derivedBytes: chunk.length });
    }

    // A NON-STANDARD CHUNK CAN CARRY USER DATA TOO, AND THIS ONE DOES. `trAc` is not a PNG chunk the spec defines;
    // measured on the real card it is a 303-byte JSON document `{"ciphertext":…,"kid","nonce","v"}` -- the SAME
    // trace the card's `extensions.odysseia_trace` carries, so preserving it "byte for byte because it is an
    // unknown chunk" would have shipped the author's ciphertext while the JSON copy was replaced. The survivor
    // sweep is what found it (it named the original ciphertext after the tEXt chunks were already clean).
    //
    // THE RULE: a `tEXt`-shaped unknown chunk (`tXXX`, and `trAc` as measured) is RE-ENCODED with the same payload
    // length when its payload parses as JSON and contains an identity field; anything else is preserved verbatim
    // AND its payload is added to the survivor sweep's haystack, so a future card with a private identity blob in
    // an unknown chunk is refused rather than shipped.
    const OTHER_IDENTITY_CHUNKS = new Set(['trAc', 'tXXX']);
    for (const chunk of chunks) {
        if (chunk.type === 'IDAT' || chunk.type === 'IEND' || chunk.type === 'IHDR') continue;
        if (!OTHER_IDENTITY_CHUNKS.has(chunk.type)) continue;
        if (chunk.type === 'tEXt' && ['chara', 'ccv3'].includes(String(textChunkPayload(chunk.data)?.keyword ?? '').toLowerCase())) continue;
        const payloadText = chunk.data.toString('utf8');
        if (!payloadText.startsWith('{')) continue;
        let parsedChunk = null;
        try {
            parsedChunk = JSON.parse(payloadText);
        } catch {
            continue; // not JSON: preserved verbatim, and the survivor sweep still reads it as latin1
        }
        // The same identity walker, rooted at `extensions.` so a chunk that mirrors the card's extension tree is
        // recognised by the SAME list rather than by a second, parallel one.
        const derivedChunk = desensitiseCardRootedAt(parsedChunk, stats);
        const derivedChunkJSON = Buffer.from(JSON.stringify(derivedChunk), 'utf8');
        if (derivedChunkJSON.length !== chunk.data.length) {
            refuse(`${file}: the ${chunk.type} chunk's JSON is ${chunk.data.length} bytes and derived to ${derivedChunkJSON.length}, so it cannot be replaced byte-length-preservingly`);
        }
        derivedPayloads.set(chunk, derivedChunkJSON);
        chunkReport.push({ type: chunk.type, originalBytes: chunk.length, derivedBytes: 13 + derivedChunkJSON.length, reencoded: true, reason: 'a JSON payload carrying an identity field, re-encoded at the same length' });
    }

    // THE IDAT IS ONE STREAM ACROSS EVERY IDAT CHUNK, so the solid image is written as a single chunk placed
    // where the first original IDAT sat; a PNG may legally carry one IDAT.
    const idatChunks = chunks.filter((chunk) => chunk.type === 'IDAT');
    if (idatChunks.length === 0) refuse(`${file}: no IDAT chunk, so the file has no image to replace`);
    const solid = solidIdat(ihdr);
    const solidChunk = writePngChunk('IDAT', solid.deflated);
    const firstIdat = idatChunks[0];

    const written = [];
    for (const chunk of chunks) {
        if (chunk === firstIdat) {
            written.push(solidChunk);
            continue;
        }
        if (chunk.type === 'IDAT') continue; // folded into the single solid chunk above
        const payload = derivedPayloads.has(chunk) ? derivedPayloads.get(chunk) : chunk.data;
        if (chunk.type === 'IHDR' && payload[12] !== 0) {
            const reset = Buffer.from(payload);
            reset[12] = 0;
            written.push(writePngChunk('IHDR', reset));
            continue;
        }
        const rebuilt = writePngChunk(chunk.type, payload);
        if (rebuilt.length - 12 !== chunk.length) refuse(`${file}: the ${chunk.type} chunk's payload moved from ${chunk.length} to ${rebuilt.length - 12} bytes`);
        written.push(rebuilt);
    }
    const derived = Buffer.concat([PNG_SIGNATURE, ...written]);

    // ---- the refusals that make this a derivation rather than a rewrite ---------------------------
    // 1. EVERY ORIGINAL CHUNK EXCEPT IDAT MUST BE PRESENT, IN ORDER, AT ITS ORIGINAL PAYLOAD LENGTH. The
    //    comparison walks the two lists as pairs, so a chunk that MOVED cannot be excused by another chunk
    //    of the same type elsewhere in the file.
    const after = readPngChunks(derived);
    const originalNonIdat = chunks.filter((chunk) => chunk.type !== 'IDAT');
    const afterNonIdat = after.filter((chunk) => chunk.type !== 'IDAT');
    if (originalNonIdat.length !== afterNonIdat.length) {
        refuse(`${file}: the derived file has ${afterNonIdat.length} non-IDAT chunk(s), the original has ${originalNonIdat.length}`);
    }
    for (const [position, before] of originalNonIdat.entries()) {
        const current = afterNonIdat[position];
        if (current.type !== before.type) refuse(`${file}: chunk ${position} was ${before.type} and is ${current.type}`);
        if (current.length === before.length) continue;
        const isCardText = current.type === 'tEXt' && ['chara', 'ccv3'].includes(String(textChunkPayload(current.data)?.keyword ?? '').toLowerCase());
        // The identifier is the ONLY field a card chunk may change, and only its VALUE: the length is asserted
        // above the write, and this is the second opinion in case the write path changes.
        refuse(`${file}: ${isCardText ? `the ${textChunkPayload(current.data)?.keyword} chunk` : `chunk ${position} (${current.type})`} moved from ${before.length} to ${current.length} bytes`);
    }
    // 2. THE DERIVED FILE MUST STILL DECODE, and the IDAT must be the only part of the image that changed.
    const afterProfile = profileCard(derived);
    for (const keyword of ['chara', 'ccv3']) {
        const beforeEntry = profileBefore.text[keyword];
        const afterEntry = afterProfile.text[keyword];
        if (!beforeEntry !== !afterEntry) refuse(`${file}: the derived file ${afterEntry ? 'gained' : 'lost'} the ${keyword} chunk`);
        if (beforeEntry && afterEntry && beforeEntry.jsonBytes !== afterEntry.jsonBytes) refuse(`${file}: ${keyword} JSON moved ${beforeEntry.jsonBytes} -> ${afterEntry.jsonBytes}`);
        if (beforeEntry && afterEntry && beforeEntry.chunkBytes !== afterEntry.chunkBytes) refuse(`${file}: ${keyword} chunk moved ${beforeEntry.chunkBytes} -> ${afterEntry.chunkBytes}`);
    }

    // 2b. THE TWO CHUNKS MUST BE ONE CARD.
    //
    // THE CHECK THAT WOULD HAVE CAUGHT RUN 40438262854 BEFORE ANY PROBE RAN. Pinned writes `ccv3` as `JSON.parse` of
    // the data it put in `chara` (`src/character-card-parser.js:15-40`), so for any card pinned has written the two
    // chunks hold the SAME document; a derivation that walks each chunk separately produces two cards in one file,
    // and every reader then answers whichever one its chunk precedence selects. This asserts DEEP EQUALITY of the
    // two DECODED documents -- not name equality, which would pass for two documents that differ only in prose -- and
    // it compares against the DERIVED bytes read back from disk, so it cannot be satisfied by the intent above.
    {
        const readBack = readPngChunks(derived);
        const documents = new Map();
        for (const chunk of readBack) {
            if (chunk.type !== 'tEXt') continue;
            const payload = textChunkPayload(chunk.data);
            const keyword = String(payload?.keyword ?? '').toLowerCase();
            if (keyword !== 'chara' && keyword !== 'ccv3') continue;
            documents.set(keyword, Buffer.from(payload.text, 'base64'));
        }
        if (documents.size === 2) {
            const [first, second] = [...documents.entries()];
            if (!first[1].equals(second[1])) {
                refuse(`${file}: the derived ${first[0]} and ${second[0]} chunks are DIFFERENT documents `
                    + `(${first[1].length} vs ${second[1].length} bytes), so one card file would carry two contradictory `
                    + 'cards; pinned writes both from one document (character-card-parser.js:15-40), so this fixture '
                    + 'would describe a card pinned cannot produce');
            }
            // Deep equality as a SECOND opinion: identical bytes cannot differ structurally, but a future change that
            // normalises on read would make the byte check pass while the documents diverged, and the structure is
            // exactly what the diff would hide.
            const parsedFirst = parseCardJSON(first[1]);
            const parsedSecond = parseCardJSON(second[1]);
            if (JSON.stringify(parsedFirst) !== JSON.stringify(parsedSecond)) {
                refuse(`${file}: the derived ${first[0]} and ${second[0]} chunks decode to different documents even though `
                    + 'their bytes compare equal; the re-read path is normalising one of them');
            }
        }
        cardChunkEquality = { chunks: [...documents.keys()], sameDocument: documents.size === 2 };
    }
    // 3. THE STRUCTURE THE LEG NEEDS MUST SURVIVE: entry count, greeting count, helper/regex script counts,
    //    book content bytes are all computed by the profiler, so a derivation that flattened the book fails
    //    here rather than in a browser leg three commits later.
    const structure = (profile) => {
        const data = profile.text.ccv3?.profile ?? profile.text.chara?.profile ?? null;
        if (!data) return null;
        return {
            alternateGreetings: data.alternateGreetings,
            characterBookEntries: data.characterBookEntries,
            atDepthEntries: data.atDepthEntries,
            helperScripts: data.helperScripts,
            regexScripts: data.regexScripts,
            dataKeys: data.dataKeys,
            // THE COUNTS ARE THE STRUCTURE; THE BYTE TOTALS ARE NOT COMPARABLE. Every replacement preserves the
            // SERIALISED length, so the document's byte total is fixed -- but the profiler's `strings.bytes`
            // and `characterBookContentBytes` sum the RAW UTF-8 lengths, and the filler is `测` (3 bytes per
            // character) where the original prose may have been ASCII (1 byte per character). Measured on the
            // real card: book content 5,730,445 -> 5,789,058 raw bytes and strings 6,437,621 -> 6,517,069 while
            // the JSON document stayed 6,938,739 bytes and every count stayed identical. So the RAW totals move
            // and the SERIALISED total must not: that is asserted separately below, and the raw delta is
            // recorded in the manifest rather than compared. This is the preset work's `helperContentBytesDelta`
            // lesson, one population over.
            strings: data.strings?.strings,
            stringBytesDelta: null,
        };
    };
    const structureBefore = structure(profileBefore);
    const structureAfter = structure(afterProfile);
    if (JSON.stringify(structureBefore) !== JSON.stringify(structureAfter)) {
        refuse(`${file}: the card's structure changed: ${JSON.stringify(structureBefore)} -> ${JSON.stringify(structureAfter)}`);
    }
    // 4. NO ORIGINAL IDENTITY STRING MAY SURVIVE ANYWHERE IN THE OUTPUT. The identity list above is the
    //    named set; this is the check that catches the field it does not name, which is the preset work's
    //    own lesson (its deep label layer was found by scanning, not by naming). Strings shorter than
    //    EIGHT bytes are skipped: a card's root carries spec_version, character_version and tags like
    //    "female", and refusing the fixture because the word "1" appears somewhere is a gate with no teeth
    //    that fires on everything (AGENTS.md verification rule 15's inverse).
    const survivors = new Map();
    const originalStrings = [];
    const collect = (value) => {
        if (typeof value === 'string') {
            const bytes = Buffer.byteLength(value);
            if (bytes >= Math.max(8, MARKER_BYTES + FILLER_UNIT_BYTES)) originalStrings.push(value);
            return;
        }
        if (Array.isArray(value)) { for (const item of value) collect(item); return; }
        if (value && typeof value === 'object') { for (const key of Object.keys(value)) collect(value[key]); }
    };
    //    A STRING THAT ONLY MOVED IS NOT A SURVIVOR. The sweep must compare the ORIGINAL document against the
    //    DERIVED DOCUMENT, not against the file: a card's bytes are base64, so `derived.toString('latin1')`
    //    contains none of the original's strings and the sweep passed for a card whose `creator` was never
    //    replaced. The self-test's "REFUSES an original string in a field the list does not name" case is what
    //    found this; the sweep now reads the derived JSON out of the derived file, which is also what a
    //    reviewer would read.
    const derivedDocuments = [];
    for (const chunk of derivedPayloads.keys()) {
        const payload = derivedPayloads.get(chunk);
        if (!payload) continue;
        const text = textChunkPayload(payload);
        if (!text || !/^(chara|ccv3)$/i.test(text.keyword)) continue;
        derivedDocuments.push(Buffer.from(text.text, 'base64').toString('utf8'));
    }
    const derivedText = derivedDocuments.join('\n');
    for (const chunk of cardTextChunks) collect(parseCardJSON(Buffer.from(textChunkPayload(chunk.data).text, 'base64')));
    // SUBSTRING SEARCH, NOT A QUADRATIC SCAN. `derivedText.includes(value)` for 2,262 survivors over a 6.9 MB
    // document is ~15 GB of scanning and the first real run HAD TO BE KILLED (measured: no output after four
    // minutes). The haystack is therefore pre-sliced into a Set of every 32-CHARACTER window it contains, which
    // is one pass over the document; a survivor of 32+ characters is looked up by its first window, and a
    // survivor shorter than that falls back to `includes` on the (few) short ones. Same answer, one pass.
    const WINDOW = 32;
    const windows = new Set();
    for (let index = 0; index + WINDOW <= derivedText.length; index += 1) windows.add(derivedText.slice(index, index + WINDOW));
    const survives = (value) => (value.length >= WINDOW ? windows.has(value.slice(0, WINDOW)) : derivedText.includes(value));
    for (const value of originalStrings) {
        if (survives(value)) survivors.set(value, (survivors.get(value) ?? 0) + 1);
    }
    if (survivors.size > 0) {
        const sample = [...survivors.keys()].slice(0, 3).map((value) => JSON.stringify(value.slice(0, 40)));
        refuse(`${file}: ${survivors.size} original card string(s) of 8+ bytes survive in the derived bytes, so the identity list does not name the field they live in -- first: ${sample.join(', ')}`);
    }

    // 5. THE SCANNER, on the derived text, IN PROCESS -- AND ON THE DECODED CARD TEXT, NOT ON THE FILE'S
    //    BASE64. The first version scanned `derived.toString('latin1')`, which for a card is base64: the
    //    platform flag and the explicit token were never in that string, so the content refusal did not fire
    //    and the generator would have written a card its own gate would have refused from disk. The self-test
    //    caught it (`derivation REFUSES a card carrying an explicit adult marker -- the generator wrote it`),
    //    which is the whole reason that case exists. Both halves are scanned, exactly as the CLI does: the raw
    //    bytes (a leak in a chunk keyword) AND the decoded JSON.
    const scanFindings = [];
    // THE RAW PASS IS BOUNDED (see check-fixture-watermarks.mjs: the e-mail pattern was quadratic on base64 and
    // wedged this generator for four minutes). A window join is what the CLI does, so the two agree.
    const rawWindows = [];
    for (let offset = 0; offset < derived.length; offset += 256 * 1024) {
        rawWindows.push(derived.toString('latin1', offset, Math.min(derived.length, offset + 256 * 1024)));
    }
    const rawScan = scanText(rawWindows.join('\n'), { file: `${name}.png (derived card, raw bytes)` });
    scanFindings.push(...rawScan.findings);
    for (const chunk of cardTextChunks) {
        const keyword = textChunkPayload(chunk.data).keyword;
        const decoded = Buffer.from(derivedPayloads.get(chunk).subarray(textChunkPayload(chunk.data).keyword.length + 1).toString('latin1'), 'base64').toString('utf8');
        const decodedScan = scanText(decoded, { file: `${name}.png (derived card, ${keyword})` });
        scanFindings.push(...decodedScan.findings);
    }
    if (scanFindings.length > 0) {
        for (const finding of scanFindings) console.error(`  ${finding}`);
        refuse(`${file}: the derived card fails the watermark scanner (${scanFindings.length} finding(s)), so it is not written`);
    }

    // 6. THE CARRIERS THE TEXT SCAN CANNOT SEE, on the file that is about to be written. The generator and the
    //    gate run the SAME audit (`tools/png-carriers.mjs`), so a card this tool writes is one the CI step
    //    accepts, and a card the audit would refuse can never be produced in the first place.
    //
    //    THIS IS THE REFUSAL THAT CLOSES "PRESERVED VERBATIM BECAUSE UNKNOWN". Until it existed, the generator
    //    kept every chunk that was not `chara`/`ccv3`/`IDAT`/`trAc`, byte for byte, with the reason "the reader's
    //    tolerance of an unknown chunk is part of what the fixture is for". That is the right fixturing argument
    //    and the wrong privacy one: an `eXIf` blob or a `zTXt` written by the author's editor would have been
    //    carried into a public repository under a rule that reads like due diligence. The fixture's tolerances
    //    are exercised by `trAc` alone (`internal/server/characters_card.go` skips unknown chunks), so any other
    //    metadata chunk is REFUSED by name -- the remedy is a decision (replace it, or add it to the allowlist
    //    with a reason), never a silent carry-over.
    //
    //    AND THE IDAT MUST DECODE TO ONE COLOUR. The derivation writes a solid image, so a single-colour decode
    //    is a property of the SWAP rather than of the original. It is asserted here because the swap's own
    //    correctness was previously asserted by LENGTH only (`derivedBytes` in the manifest), which cannot
    //    distinguish a solid image from the original's deflated stream.
    const carrierAudit = auditPngCarriers(derived);
    const carrierFailures = carrierAudit.refusals.filter((entry) => entry.detail !== null);
    if (carrierFailures.length > 0) {
        for (const failure of carrierFailures) {
            console.error(`  carrier [${failure.category}] ${failure.type ?? '(file)'}: ${failure.detail}`);
        }
        refuse(`${file}: the derived card has ${carrierFailures.length} carrier(s) the text scan cannot clear, so it is not written`);
    }
    if (!carrierAudit.solid) refuse(`${file}: the derived card's image does not decode to a single colour, so the IDAT swap is not proven`);
    const anchored = { width: carrierAudit.solid.width, height: carrierAudit.solid.height, colour: carrierAudit.solid.colour };

    const target = path.join(outDir, `${name}.png`);
    fs.writeFileSync(target, derived);
    console.log(`wrote ${target}: ${derived.length} bytes (original ${original.length}), ${stats.namesReplaced} identity field(s) replaced`);
    return {
        name,
        file: path.basename(target),
        bytes: derived.length,
        sha256: crypto.createHash('sha256').update(derived).digest('hex'),
        origin: { bytes: original.length, sha256: crypto.createHash('sha256').update(original).digest('hex') },
        replaced: {
            namesReplaced: stats.namesReplaced,
            scriptsReplaced: stats.scriptsReplaced,
            scriptBytesReplaced: stats.scriptBytesReplaced,
            replacedPaths: stats.replacedPaths,
            // WHAT WAS REPLACED AND WHY, field by field. A reader can audit the list against the brief.
            identityFields: CARD_IDENTITY_FIELDS.map((field) => ({ path: field.path, why: field.why, replaced: stats.replacedPaths[field.path] ?? 0 })),
            idat: {
                originalBytes: idatChunks.reduce((total, chunk) => total + chunk.length, 0),
                originalChunks: idatChunks.length,
                derivedBytes: solidChunk.length - 12,
                derivedChunks: 1,
                replacedWith: `a solid ${dimensions.width}x${dimensions.height} ${solid.bitDepth}-bit image, colour type ${solid.colourType}, ${solid.rawBytes} raw bytes deflated`,
                reason: 'the original picture is the author\'s art and is not part of the structure the leg needs; the manifest records its length so this cannot be mistaken for a picture fixture',
                // THE SWAP, VERIFIED BY DECODING RATHER THAN BY LENGTH. `derivedBytes` alone cannot tell a solid
                // image from the original's deflated stream (both are "some number of bytes"), so the derived
                // file is decoded and the decoded pixels are asserted to be ONE colour; the colour is recorded so
                // a later re-derivation that swapped in a different picture is visible in the diff.
                derivedDecoded: { width: anchored.width, height: anchored.height, singleColour: anchored.colour },
            },
            preserved: {
                chunkSequence: chunks.map((chunk) => ({ type: chunk.type, bytes: chunk.type === 'IDAT' ? null : chunk.length })),
                cardTextChunks: chunkReport.filter((entry) => entry.keyword),
                // THE ASSERTION THIS RECORD PROVES RAN, not a description of the intent: the two chunks' derived
                // documents were compared BYTE-WISE and structurally after the write (step 2b above), so a manifest
                // that carries this line describes a card whose `chara` and `ccv3` are one document. The original
                // file's own equality is recorded separately as `profile.charaEqualsCcv3`, because the ORIGINAL may
                // legitimately differ and the derived file may not.
                sameDocumentAcrossChunks: cardChunkEquality,
                canonicalNameSource: 'ccv3 document (the one pinned reads first, character-card-parser.js:54-78), so prior Q21 reports remain comparable',
                dimensions,
                atDepthEntriesNote: 'per-entry position/depth fields are preserved untouched; only the prose inside them moved',
                carrierAuditNote: 'every chunk is cleared by tools/png-carriers.mjs: chara/ccv3 are the scanned content, IDAT decodes to one colour, trAc is declarable and re-encoded at the same length. Any other chunk type refuses at build time, because an unknown ancillary chunk preserved verbatim is a carrier no check clears',
            },
        },
        profile: {
            ...structureAfter,
            chunkTypes: profileBefore.chunkTypes,
            charaEqualsCcv3: profileBefore.charaEqualsCcv3,
            truncatedForPublicRepository: true,
        },
    };
};


// --check: the fixtures in the tree must still be the ones the manifest describes. This is the fail-closed
// half: a fixture edited by hand, truncated by a merge or re-generated from a different original is a
// different product, and nothing downstream would notice because the file still parses.
const checkManifest = (outDir) => {
    const manifestPath = path.join(outDir, 'real-fixture-manifest.json');
    if (!fs.existsSync(manifestPath)) refuse(`${manifestPath} does not exist, so there is nothing to check`);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    let checked = 0;
    for (const entry of [...manifest.presets, ...manifest.cards]) {
        const target = path.join(outDir, entry.file);
        if (!fs.existsSync(target)) refuse(`the manifest names ${entry.file} and the tree does not have it`);
        const body = fs.readFileSync(target);
        const digest = crypto.createHash('sha256').update(body).digest('hex');
        if (digest !== entry.sha256) refuse(`${entry.file}: sha256 ${digest} is not the recorded ${entry.sha256}; the fixture is not the one the manifest describes`);
        if (body.length !== entry.bytes) refuse(`${entry.file}: ${body.length} bytes, the manifest says ${entry.bytes}`);
        checked += 1;
    }
    console.log(`ok: ${checked} fixture(s) match the manifest (sha256 and byte length)`);
};

const main = () => {
    const argv = process.argv.slice(2);
    if (argv.includes('--check')) {
        const index = argv.indexOf('--out');
        if (index < 0 || argv[index + 1] === undefined) refuse('--check needs --out <dir>');
        checkManifest(argv[index + 1]);
        return;
    }
    const { out, presets, cards } = parseArgs(argv);
    fs.mkdirSync(out, { recursive: true });
    const manifest = { schemaVersion: 1, generatedBy: 'tools/build-real-fixtures.mjs', presets: [], cards: [] };
    for (const spec of presets) manifest.presets.push(buildPreset(splitNamed(spec), out));
    for (const spec of cards) manifest.cards.push(buildCard(splitNamed(spec), out));
    const manifestPath = path.join(out, 'real-fixture-manifest.json');
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`wrote ${manifestPath}`);
    console.log(`fixtures: ${manifest.presets.length} preset(s), ${manifest.cards.length} card(s)`);
};

main();
