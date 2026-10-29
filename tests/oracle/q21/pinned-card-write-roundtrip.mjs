// Q21 / CONTAINER PROOF: CAN PINNED'S OWN WRITE PATH EMIT THE CARD FIXTURE, AND DOES PINNED READ IT BACK AS ONE CARD?
//
// WHY THIS IS AN ORACLE SCRIPT AND NOT A PROBE-SIDE ASSERTION. The Q21 hand-back leg stages
// `tests/browser/fixtures/real/card-a.png` and then asks whether a user's conversation survives a runtime swap. A
// fixture the PINNED SERVER could not itself have written makes every later agreement uninteresting: it would be an
// agreement about a container pinned cannot produce. So the container is proved against the PINNED MODULE ITSELF,
// imported from the pinned checkout, and not against a transcription of its rules.
//
// THE PINNED RULES THIS EXECUTES (SillyTavern @ 06bde939fb1e9c4c8d8641d810f0a916b5bce127, read, never guessed):
//
//   src/character-card-parser.js:15-46  `write` REMOVES every existing chara/ccv3 tEXt chunk (`:20-25`), writes
//                                       `chara` = base64 of THE DATA IT WAS GIVEN (`:28-29`), and derives `ccv3` from
//                                       `JSON.parse` of THAT SAME data, stamping `spec`/`spec_version` (`:32-39`).
//                                       Two chunks, ONE document: the container cannot carry two cards.
//   src/character-card-parser.js:54-78  `read` takes the FIRST `ccv3` chunk (`:64-68`) and only falls back to
//                                       `chara` (`:70-74`). So when a container does carry two documents, `ccv3` is
//                                       the one the server answers, which is exactly the Q21 precondition defect
//                                       measured in `GoTavern Lane CI` 40446833206.
//
// WHAT IS ASSERTED (each able to fail, each reported by name):
//   pinnedReadsTheFixture        `read(fixture)` answers a document, and it is the `ccv3` chunk's document
//   chunksCarryOneDocument       the fixture's `chara` and `ccv3` decode to the SAME JSON bytes (the invariant the
//                                pre-repair fixture violated; `tools/repair-card-chunks.mjs` records the repair)
//   pinnedCanEmitIt              `write(fixture, thatDocument)` succeeds and its two chunk payloads are BYTE-EQUAL
//                                to the fixture's two chunk payloads, so pinned's own writer emits this card
//   pinnedReadsBackWhatItWrote   `read(write(...))` is BYTE-EQUAL to the document that went in
//   specStampsArePinneds         the document already carries `spec: chara_card_v3` / `spec_version: 3.0`, which is
//                                what `:35-36` stamps, so `write` is a fixed point rather than a rewrite
//
// `--selftest` proves the gate is not decoration: it builds a container whose `chara` and `ccv3` carry DIFFERENT
// names (the pre-repair shape) and requires (a) `pinnedReadsTheFixture`-style reading to reach the `ccv3` document,
// which is the source-derived precedence claim, and (b) `chunksCarryOneDocument` to go RED on it. A gate that cannot
// report the defect it was written for is the failure this project keeps hitting.
//
// Usage:
//   node tests/oracle/q21/pinned-card-write-roundtrip.mjs [--card <card.png>] [--reference <SillyTavern checkout>]
//   node tests/oracle/q21/pinned-card-write-roundtrip.mjs --selftest
// Exit: 0 all assertions held; 1 an assertion failed; 2 the pinned checkout or the card is missing (REFUSAL, never a
// silent skip -- a proof that did not run is unverified, not verified-equal).

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const DEFAULT_CARD = path.join(repoRoot, 'tests', 'browser', 'fixtures', 'real', 'card-a.png');

const PINNED_COMMIT = '06bde939fb1e9c4c8d8641d810f0a916b5bce127';
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function argumentValue(name, fallback = null) {
    const index = process.argv.indexOf(name);
    if (index < 0) return fallback;
    const value = process.argv[index + 1];
    return value === undefined ? fallback : value;
}

const sha256 = buffer => crypto.createHash('sha256').update(buffer).digest('hex');

// --- the container, read with an INDEPENDENT parser ---------------------------------------------------------
// Deliberately not pinned's `png-chunks-extract`: if both the fixture reader and the subject used one parser, a
// parser bug would agree with itself. This one is 20 lines of the PNG spec and reports offsets so a length bug is
// named rather than inferred.
function readChunks(image) {
    if (!image.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('not a PNG: the 8-byte signature is absent');
    const chunks = [];
    let offset = 8;
    while (offset + 12 <= image.length) {
        const length = image.readUInt32BE(offset);
        const type = image.toString('latin1', offset + 4, offset + 8);
        const dataStart = offset + 8;
        if (dataStart + length + 4 > image.length) throw new Error(`chunk ${type} at ${offset} claims ${length} bytes and the file ends first`);
        chunks.push({ type, length, data: image.subarray(dataStart, dataStart + length) });
        offset = dataStart + length + 4;
        if (type === 'IEND') break;
    }
    return chunks;
}

function decodeTextChunk(data) {
    const zero = data.indexOf(0);
    if (zero < 0) throw new Error('a tEXt chunk has no keyword terminator');
    return { keyword: data.toString('latin1', 0, zero), text: data.subarray(zero + 1).toString('latin1') };
}

// The two card chunks as the READERS see them: keyword plus the DECODED JSON bytes. Nothing here percent-decodes:
// pinned's `read` is base64 only (`character-card-parser.js:67`, `:73`), and the percent step lives in the
// FRONTEND's own card import path, not in the server's reader.
function cardChunks(image) {
    const found = [];
    for (const chunk of readChunks(image)) {
        if (chunk.type !== 'tEXt') continue;
        const { keyword, text } = decodeTextChunk(chunk.data);
        const lowered = keyword.toLowerCase();
        if (lowered !== 'chara' && lowered !== 'ccv3') continue;
        const jsonBytes = Buffer.from(text, 'base64');
        if (jsonBytes.toString('base64') !== text) throw new Error(`the ${keyword} chunk's base64 does not round-trip`);
        found.push({ keyword: lowered, base64: text, jsonBytes, chunkBytes: chunk.length });
    }
    return found;
}

const CRC_TABLE = (() => {
    const table = new Int32Array(256);
    for (let index = 0; index < 256; index += 1) {
        let value = index;
        for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
        table[index] = value;
    }
    return table;
})();

const crc32 = buffer => {
    let crc = 0 ^ -1;
    for (const byte of buffer) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff];
    return (crc ^ -1) >>> 0;
};

function encodeChunk(type, data) {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'latin1'), data])), 0);
    return Buffer.concat([head, data, crc]);
}

// --- the pinned module ----------------------------------------------------------------------------------------
async function loadPinned(reference) {
    const parser = path.join(reference, 'src', 'character-card-parser.js');
    if (!fs.existsSync(parser)) return { ok: false, reason: `no pinned module at ${parser}` };
    const module = await import(pathToFileURL(parser).href);
    if (typeof module.write !== 'function' || typeof module.read !== 'function') {
        return { ok: false, reason: `${parser} does not export both write and read` };
    }
    return { ok: true, reference, write: module.write, read: module.read };
}

function resolveReference(explicit) {
    const candidates = [
        explicit,
        process.env.GOTAVERN_REFERENCE,
        path.join(repoRoot, '.reference', 'SillyTavern'),
        path.resolve(repoRoot, '..', 'SillyTavern'),
    ].filter(Boolean);
    for (const candidate of candidates) {
        if (fs.existsSync(path.join(candidate, 'src', 'character-card-parser.js'))) return path.resolve(candidate);
    }
    return null;
}

// ---------------------------------------------------------------------------------------------------------------
const steps = [];
const check = (name, ok, detail) => {
    steps.push({ name, ok: ok === true, detail: detail ?? null });
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : ' -- ' + (typeof detail === 'string' ? detail : JSON.stringify(detail))}`);
    return ok === true;
};

const main = async () => {
    if (process.argv.includes('--selftest')) return selfTest();

    const cardPath = path.resolve(argumentValue('--card', DEFAULT_CARD));
    const reference = resolveReference(argumentValue('--reference'));
    if (!reference) {
        console.error(`REFUSING: no pinned SillyTavern checkout found (tried --reference, $GOTAVERN_REFERENCE, .reference/SillyTavern, ../SillyTavern). The container proof is about the PINNED module and cannot be replaced by a transcription of it.`);
        process.exit(2);
    }
    if (!fs.existsSync(cardPath)) {
        console.error(`REFUSING: the card fixture is missing at ${cardPath}. A proof that did not run is not evidence.`);
        process.exit(2);
    }
    const image = fs.readFileSync(cardPath);
    console.log(`card       ${cardPath}`);
    console.log(`bytes      ${image.length}  sha256 ${sha256(image)}`);
    console.log(`pinned     ${reference} (baseline ${PINNED_COMMIT})`);

    const pinned = await loadPinned(reference);
    if (!pinned.ok) {
        console.error(`REFUSING: ${pinned.reason}`);
        process.exit(2);
    }

    const chunks = cardChunks(image);
    const byKeyword = new Map(chunks.map(chunk => [chunk.keyword, chunk]));
    const chara = byKeyword.get('chara');
    const ccv3 = byKeyword.get('ccv3');
    check('bothCardChunksExist', Boolean(chara && ccv3), `keywords ${JSON.stringify(chunks.map(chunk => chunk.keyword))}`);
    if (!chara || !ccv3) process.exit(1);

    // PINNED'S ANSWER, executed: the module reads the committed bytes.
    const readText = pinned.read(image);
    const readsCcv3 = Buffer.from(readText, 'utf8').equals(ccv3.jsonBytes);
    check('pinnedReadsTheFixture', readsCcv3 && Buffer.from(readText, 'utf8').equals(chara.jsonBytes),
        { readsTheCcv3Document: readsCcv3, documentBytes: Buffer.byteLength(readText) });

    // ONE CARD, ONE DOCUMENT -- the invariant the pre-repair fixture violated.
    check('chunksCarryOneDocument', chara.jsonBytes.equals(ccv3.jsonBytes),
        { charaBytes: chara.jsonBytes.length, ccv3Bytes: ccv3.jsonBytes.length, identical: chara.jsonBytes.equals(ccv3.jsonBytes) });

    const document = JSON.parse(readText);
    check('specStampsArePinneds', document.spec === 'chara_card_v3' && document.spec_version === '3.0',
        { spec: document.spec ?? null, spec_version: document.spec_version ?? null, stampedBy: 'src/character-card-parser.js:35-36' });

    // PINNED WRITES IT: the data it is handed is the document pinned itself just read.
    const written = Buffer.from(pinned.write(image, readText));
    const writtenChunks = cardChunks(written);
    const writtenByKeyword = new Map(writtenChunks.map(chunk => [chunk.keyword, chunk]));
    const samePayloads = writtenByKeyword.size === 2
        && writtenByKeyword.get('chara')?.base64 === chara.base64
        && writtenByKeyword.get('ccv3')?.base64 === ccv3.base64;
    check('pinnedCanEmitIt', samePayloads, {
        writtenBytes: written.length,
        chunkOrder: readChunks(written).map(chunk => chunk.type),
        fixtureChunkOrder: readChunks(image).map(chunk => chunk.type),
        charaPayloadIdentical: writtenByKeyword.get('chara')?.base64 === chara.base64,
        ccv3PayloadIdentical: writtenByKeyword.get('ccv3')?.base64 === ccv3.base64,
        placementNote: 'pinned appends chara/ccv3 before IEND (:29, :39), so the FILE is not byte-identical when the fixture carries another chunk after them (trAc); the DOCUMENT is.',
    });

    const readBack = pinned.read(written);
    check('pinnedReadsBackWhatItWrote', Buffer.from(readBack, 'utf8').equals(Buffer.from(readText, 'utf8')),
        { inBytes: Buffer.byteLength(readText), outBytes: Buffer.byteLength(readBack), sha256: sha256(Buffer.from(readBack, 'utf8')) });

    // THE PICTURE SURVIVES pinned's RE-ENCODE, otherwise "pinned can emit it" would be a metadata-only claim.
    const beforeIdat = readChunks(image).filter(chunk => chunk.type === 'IDAT').map(chunk => chunk.data);
    const afterIdat = readChunks(written).filter(chunk => chunk.type === 'IDAT').map(chunk => chunk.data);
    check('pinnedReencodeKeepsThePicture',
        beforeIdat.length === afterIdat.length && beforeIdat.every((entry, index) => entry.equals(afterIdat[index])),
        { idatChunks: afterIdat.length, idatBytes: afterIdat.reduce((total, entry) => total + entry.length, 0) });

    const failed = steps.filter(entry => !entry.ok);
    console.log(`verdict: ${steps.length - failed.length}/${steps.length} held${failed.length ? `; failed: ${failed.map(entry => entry.name).join(', ')}` : ''}`);
    process.exit(failed.length === 0 ? 0 : 1);
};

// ---------------------------------------------------------------------------------------------------------------
// THE GATE'S TEETH. The pre-repair fixture is reconstructed from the CURRENT bytes: a copy of the committed card
// whose `chara` chunk carries a DIFFERENT `data.name` at the same byte length. Two assertions must then hold:
//   * pinned's `read` answers the `ccv3` document, not the `chara` one -- the precedence claim of `:54-78`, executed
//     on bytes rather than cited;
//   * `chunksCarryOneDocument` is FALSE on those bytes -- the gate reports the defect it exists for.
function selfTest() {
    const cardPath = DEFAULT_CARD;
    if (!fs.existsSync(cardPath)) {
        console.error(`REFUSING: the card fixture is missing at ${cardPath}`);
        process.exit(2);
    }
    const image = fs.readFileSync(cardPath);
    const chunks = cardChunks(image);
    const ccv3 = chunks.find(chunk => chunk.keyword === 'ccv3');
    const chara = chunks.find(chunk => chunk.keyword === 'chara');
    if (!ccv3 || !chara) {
        console.error('REFUSING: the fixture has no chara/ccv3 pair, so the teeth case cannot be built');
        process.exit(2);
    }
    const canonical = JSON.parse(ccv3.jsonBytes.toString('utf8'));
    const divergent = JSON.parse(canonical ? JSON.stringify(canonical) : '{}');

    // A DIFFERENT NAME AT THE SAME LENGTH. `MARK_NNNNNN` + filler is the fixture's own name shape
    // (`tools/real-fixture-profile.mjs:MARKER_PREFIX`), so this is a name pinned could be handed, not a corrupt one.
    const originalName = String(divergent?.data?.name ?? '');
    const digits = /^MARK_(\d{6})/.exec(originalName);
    if (!digits) {
        console.error(`REFUSING: the fixture's data.name ${JSON.stringify(originalName)} is not the MARK_NNNNNN shape, so the teeth case cannot build a same-length divergent name`);
        process.exit(2);
    }
    const otherName = `MARK_${String((Number(digits[1]) + 1) % 1000000).padStart(6, '0')}${originalName.slice(11)}`;
    if (Buffer.byteLength(otherName) !== Buffer.byteLength(originalName)) {
        console.error('REFUSING: the divergent name is not the same byte length, so the replacement would change the chunk size and prove the wrong thing');
        process.exit(2);
    }
    divergent.data.name = otherName;
    const divergentJson = Buffer.from(JSON.stringify(divergent), 'utf8');
    if (divergentJson.length !== ccv3.jsonBytes.length) {
        console.error(`REFUSING: the divergent document is ${divergentJson.length} bytes, the fixture's is ${ccv3.jsonBytes.length}`);
        process.exit(2);
    }

    // Rebuild the file with the DIVERGENT document in `chara` and the canonical one in `ccv3`, keeping every other
    // chunk byte-identical, so the only difference the case measures is the one it names.
    const rebuilt = [PNG_SIGNATURE];
    const divergentPayload = Buffer.concat([Buffer.from('chara\0', 'latin1'), Buffer.from(divergentJson.toString('base64'), 'latin1')]);
    for (const chunk of readChunks(image)) {
        if (chunk.type !== 'tEXt') {
            rebuilt.push(encodeChunk(chunk.type, chunk.data));
            continue;
        }
        const { keyword } = decodeTextChunk(chunk.data);
        rebuilt.push(encodeChunk('tEXt', String(keyword).toLowerCase() === 'chara' ? divergentPayload : chunk.data));
    }
    const mutated = Buffer.concat(rebuilt);
    const mutatedChunks = cardChunks(mutated);
    const mutatedByKeyword = new Map(mutatedChunks.map(chunk => [chunk.keyword, chunk]));
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gotavern-q21-selftest-'));
    const tempPath = path.join(tempDir, 'card-two-documents.png');
    fs.writeFileSync(tempPath, mutated);
    console.log(`[selftest] wrote a two-document container to ${tempPath} (${mutated.length} bytes, tempdir only)`);
    console.log(`[selftest] chara data.name ${JSON.stringify(divergent.data.name)}  ccv3 data.name ${JSON.stringify(JSON.parse(ccv3.jsonBytes.toString('utf8'))?.data?.name)}`);

    const oneDocument = mutatedByKeyword.get('chara').jsonBytes.equals(mutatedByKeyword.get('ccv3').jsonBytes);
    check('selftest:chunksCarryOneDocumentGoesRed', oneDocument === false,
        { identical: oneDocument, why: 'the two chunks carry different documents, so the invariant MUST report false' });

    const reference = resolveReference(null);
    if (!reference) {
        console.error('REFUSING: no pinned checkout, so the precedence half of the selftest cannot execute. Half a selftest is not a selftest.');
        process.exit(2);
    }
    return loadPinned(reference).then(pinned => {
        if (!pinned.ok) {
            console.error(`REFUSING: ${pinned.reason}`);
            process.exit(2);
        }
        const answer = Buffer.from(pinned.read(mutated), 'utf8');
        const answersCcv3 = answer.equals(mutatedByKeyword.get('ccv3').jsonBytes);
        const answersChara = answer.equals(mutatedByKeyword.get('chara').jsonBytes);
        check('selftest:pinnedAnswersTheCcv3Document', answersCcv3 && answer.includes(Buffer.from(JSON.parse(ccv3.jsonBytes.toString('utf8')).data.name, 'utf8')) && !answersChara,
            { answersCcv3, answersChara, citedRule: 'src/character-card-parser.js:64-74' });
        fs.rmSync(tempDir, { recursive: true, force: true });
        const failed = steps.filter(entry => !entry.ok);
        console.log(`[selftest] verdict: ${steps.length - failed.length}/${steps.length} held${failed.length ? `; failed: ${failed.map(entry => entry.name).join(', ')}` : ''}`);
        process.exit(failed.length === 0 ? 0 : 1);
    });
}

await main();
