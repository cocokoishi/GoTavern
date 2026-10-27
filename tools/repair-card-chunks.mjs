// REPAIR ONE COMMITTED CARD DERIVATION SO ITS TWO CHUNKS CARRY ONE DOCUMENT.
//
// WHY THIS EXISTS. `tools/build-real-fixtures.mjs` used to derive `chara` and `ccv3` in two separate walks sharing a
// RUNNING marker counter, so a committed derivation carried two DIFFERENT documents in one file. Measured on
// `tests/browser/fixtures/real/card-a.png` (`GoTavern Lane CI` 40446833206):
//
//     chara: data.name="MARK_000466…" root.name="MARK_000464…"
//     ccv3:  data.name="MARK_002794…" root.name="MARK_002792…"
//
// Pinned reads `ccv3` first (src/character-card-parser.js:54-78), so the file said two different things about one
// character; a probe that read `chara` then measured a string the server never answered -- the Q21 precondition
// failure in runs 40438262854 and 40444636900.
//
// WHY THIS IS A REPAIR OF THE ARTEFACT FROM ITSELF AND NOT A RE-RECORD. The original card is never read: the
// `ccv3` document already inside the committed derivation IS the canonical document (it is the one pinned reads and
// the one whose name `…794` the roster answers today, so prior Q21 reports stay comparable). This tool copies that
// document into the `chara` chunk, and touches nothing else -- IHDR, IDAT, every unknown chunk and IEND stay
// byte-identical.
//
// WHAT IT DOES NOT DO: re-derive, re-desensitise, re-scan for watermarks, or invent content. The bytes written into
// `chara` are the bytes that were already in `ccv3`, base64-encoded the way both pinned readers decode
// (node_modules/png-chunk-text/decode.js is plain latin1; there is NO percent-decode on either keyword), which the
// tool verifies by reading the result back through both chunk decoders and comparing the parsed documents.
//
// Usage: node tools/repair-card-chunks.mjs <card.png> [--write]
//   Without --write it reports what it would do and exits non-zero if the file is already one document.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const readChunks = (image) => {
    if (!image.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG: bad signature');
    const chunks = [];
    let offset = 8;
    while (offset + 8 <= image.length) {
        const length = image.readUInt32BE(offset);
        const type = image.toString('latin1', offset + 4, offset + 8);
        const dataStart = offset + 8;
        if (dataStart + length + 4 > image.length) throw new Error(`chunk ${type} at ${offset} runs past the end of the file`);
        chunks.push({ type, offset, data: image.subarray(dataStart, dataStart + length), crc: image.readUInt32BE(dataStart + length) });
        offset = dataStart + length + 4;
        if (type === 'IEND') break;
    }
    return chunks;
};

const encodeChunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'latin1');
    const table = [];
    for (let n = 0; n < 256; n += 1) {
        let c = n;
        for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
    }
    let crc = 0xffffffff;
    for (const byte of Buffer.concat([Buffer.from(type, 'latin1'), data])) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 0);
    return Buffer.concat([head, data, tail]);
};

// png-chunk-text decode, transcribed: keyword up to the first NUL, text after it (a later NUL is an error).
const decodeText = (data) => {
    const zero = data.indexOf(0);
    if (zero < 0) throw new Error('tEXt chunk has no keyword terminator');
    const body = data.subarray(zero + 1);
    if (body.includes(0)) throw new Error('Invalid NULL character found. 0x00 character is not permitted in tEXt content');
    return { keyword: data.toString('latin1', 0, zero), text: body.toString('latin1') };
};

const cardChunks = (chunks) => chunks.filter((chunk) => {
    if (chunk.type !== 'tEXt') return false;
    const keyword = decodeText(chunk.data).keyword.toLowerCase();
    return keyword === 'chara' || keyword === 'ccv3';
});

const documentOf = (chunk) => {
    const { text } = decodeText(chunk.data);
    const bytes = Buffer.from(text, 'base64');
    if (bytes.toString('base64') !== text) throw new Error(`the ${decodeText(chunk.data).keyword} chunk's base64 does not round-trip`);
    return bytes;
};

const digest = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

const main = () => {
    const target = process.argv[2];
    const write = process.argv.includes('--write');
    if (!target) {
        console.error('usage: node tools/repair-card-chunks.mjs <card.png> [--write]');
        process.exit(2);
    }
    const absolute = path.resolve(target);
    const image = fs.readFileSync(absolute);
    const chunks = readChunks(image);
    const cards = cardChunks(chunks);
    const byKeyword = new Map(cards.map((chunk) => [decodeText(chunk.data).keyword.toLowerCase(), chunk]));
    const ccv3 = byKeyword.get('ccv3');
    const chara = byKeyword.get('chara');
    if (!ccv3) throw new Error(`${target}: no ccv3 chunk, so there is no canonical document to copy`);
    if (!chara) throw new Error(`${target}: no chara chunk`);

    const canonical = documentOf(ccv3);
    const canonicalDoc = JSON.parse(canonical.toString('utf8'));
    const charaDoc = JSON.parse(documentOf(chara).toString('utf8'));
    const sameBefore = documentOf(chara).equals(canonical);

    console.log(`image    ${image.length} bytes  sha256 ${digest(image)}`);
    console.log(`ccv3     ${canonical.length} JSON bytes  data.name=${JSON.stringify(canonicalDoc?.data?.name)}  root.name=${JSON.stringify(canonicalDoc?.name)}`);
    console.log(`chara    ${documentOf(chara).length} JSON bytes  data.name=${JSON.stringify(charaDoc?.data?.name)}  root.name=${JSON.stringify(charaDoc?.name)}`);
    console.log(`same document before repair: ${sameBefore}`);

    // THE NEW chara CHUNK: the canonical JSON, base64, behind the same keyword. Byte-for-byte the convention both
    // readers use, so nothing here depends on a convention this tool invented.
    const payload = Buffer.concat([
        Buffer.from('chara\0', 'latin1'),
        Buffer.from(canonical.toString('base64'), 'latin1'),
    ]);
    // A LATER NUL WOULD MAKE pinned's decoder throw, so the payload is self-checked before it is written.
    decodeText(payload);

    const rebuilt = [];
    for (const chunk of chunks) {
        if (chunk === chara) {
            rebuilt.push(encodeChunk('tEXt', payload));
        } else {
            rebuilt.push(encodeChunk(chunk.type, chunk.data));
        }
    }
    const output = Buffer.concat([SIGNATURE, ...rebuilt]);

    // THE IMAGE AND EVERY NON-CARD CHUNK MUST BE BYTE-IDENTICAL. This is asserted on the REBUILT BYTES, not on the
    // intent: the same chunk sequence, the same data for every chunk except `chara`, and the same CRC for each.
    const after = readChunks(output);
    const beforeOther = chunks.filter((chunk) => chunk !== chara);
    const afterOther = after.filter((chunk) => chunk.type !== 'tEXt' || decodeText(chunk.data).keyword.toLowerCase() !== 'chara');
    if (beforeOther.length !== afterOther.length) throw new Error('the rebuild changed the non-card chunk count');
    for (const [index, before] of beforeOther.entries()) {
        const current = afterOther[index];
        if (current.type !== before.type || !current.data.equals(before.data)) {
            throw new Error(`chunk ${index} (${before.type}) is not byte-identical after the rebuild`);
        }
    }
    const imageBefore = Buffer.concat(chunks.filter((chunk) => chunk.type === 'IDAT').map((chunk) => chunk.data));
    const imageAfter = Buffer.concat(after.filter((chunk) => chunk.type === 'IDAT').map((chunk) => chunk.data));
    if (!imageBefore.equals(imageAfter)) throw new Error('the IDAT payload changed');
    console.log(`image chunks byte-identical: ${imageBefore.equals(imageAfter)} (${imageBefore.length} IDAT bytes)`);

    // READ IT BACK THROUGH BOTH READERS. `ccv3` precedence for the pinned path; `chara` explicitly for the other,
    // because a repair that satisfied one reader and not the other would look exactly like this one passing.
    const afterCards = new Map(cardChunks(after).map((chunk) => [decodeText(chunk.data).keyword.toLowerCase(), chunk]));
    const afterCcv3 = JSON.parse(documentOf(afterCards.get('ccv3')).toString('utf8'));
    const afterChara = JSON.parse(documentOf(afterCards.get('chara')).toString('utf8'));
    const readNames = (doc) => ({ dataName: doc?.data?.name ?? null, rootName: doc?.name ?? null });
    console.log(`read back via ccv3: ${JSON.stringify(readNames(afterCcv3))}`);
    console.log(`read back via chara: ${JSON.stringify(readNames(afterChara))}`);
    if (JSON.stringify(readNames(afterCcv3)) !== JSON.stringify(readNames(afterChara))) {
        throw new Error('the two chunks still disagree about the names after the repair');
    }
    if (JSON.stringify(afterCcv3) !== JSON.stringify(afterChara)) {
        throw new Error('the two chunks decode to different documents after the repair');
    }
    console.log(`repaired ${output.length} bytes  sha256 ${digest(output)}`);

    if (write) {
        fs.writeFileSync(absolute, output);
        console.log(`wrote ${absolute}`);
    } else {
        console.log('dry run: pass --write to replace the file');
    }
    // A file that was already one document is not a failure, but it IS a no-op and the caller should know.
    process.exitCode = sameBefore ? 1 : 0;
};

main();
