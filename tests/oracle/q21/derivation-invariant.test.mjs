// Q21 / FIXTURE-INTEGRITY GATE: EVERY REPRESENTATION OF ONE LOGICAL OBJECT MUST CO
// ME FROM ONE DERIVATION.
//
// THIS IS NOT A PRODUCT TEST. It guards the generator that makes the Q21 hand-back fixture, because the hand-back
// judge is only worth something if the container it drives is a container the PINNED SERVER could itself have written.
// The defect it exists for, measured in `GoTavern Lane CI` 40446833206 and repaired in 55a686d:
//
//     chara: data.name="MARK_000466..."   root.name="MARK_000464..."
//     ccv3:  data.name="MARK_002794..."   root.name="MARK_002792..."
//
// One card file, two documents, four different names for one character, while pinned answers `ccv3`
// (`src/character-card-parser.js:54-78`) and pinned's own writer emits both chunks from ONE document (`:28-39`).
// The generic form of the defect is the one this gate enforces: ANY carrier of one identity value -- the `chara` and
// `ccv3` documents, a document's V1 root copies beside their V2 `data` twins, an ancillary chunk whose JSON mirrors
// an `extensions` subtree -- must be derived from the same canonical value. Equal in the source must stay equal;
// different in the source must stay different (a derivation may not invent an identity either).
//
// WHY THE SOURCE IS SYNTHETIC AND NOT THE USER'S CARD: `AGENTS.md` rule 56 forbids the original entering this
// repository or any test artifact. The relations are what matters, so the fixture here is BUILT with the relations
// the real card has (root copies equal to their `data` twins; a `trAc` chunk carrying the same trace as
// `data.extensions.odysseia_trace`), marked with the fixture's own `MARK_NNNNNN` vocabulary, and small enough to run
// in a second.
//
// RED-THEN-GREEN, measured 2026-10-29 on this host before and after the generator patch:
//   before  4 relations violated -- root.name MARK_000000 vs data.name MARK_000005, root.description vs
//           data.description, root.first_mes vs data.first_mes, and trAc.ciphertext MARK_000017 vs
//           data.extensions.odysseia_trace.ciphertext MARK_000016
//   after   identityRelations {occurrences: 28, equalPairs: 35, differencePairs: 343, violations: 0}
// The `--teeth` half below reproduces both failure kinds on the DERIVED bytes, so the gate is proven able to fail
// rather than assumed able.
//
// Usage:
//   node --test tests/oracle/q21/derivation-invariant.test.mjs
//   node tests/oracle/q21/derivation-invariant.test.mjs            (same tests, non-zero exit on failure)

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

import {
    CARD_MIRRORED_CHUNKS,
    cardIdentityOccurrences,
    cardIdentityRelationViolations,
} from '../../../tools/real-fixture-profile.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const GENERATOR = path.join(repoRoot, 'tools', 'build-real-fixtures.mjs');
const COMMITTED_CARD = path.join(repoRoot, 'tests', 'browser', 'fixtures', 'real', 'card-a.png');

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
const crc32 = buffer => {
    let crc = 0 ^ -1;
    for (const byte of buffer) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff];
    return (crc ^ -1) >>> 0;
};
const encodeChunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'latin1'), data])), 0);
    return Buffer.concat([head, data, crc]);
};
const readChunks = image => {
    assert.ok(image.subarray(0, 8).equals(PNG_SIGNATURE), 'not a PNG');
    const chunks = [];
    let offset = 8;
    while (offset + 12 <= image.length) {
        const length = image.readUInt32BE(offset);
        const type = image.toString('latin1', offset + 4, offset + 8);
        const dataStart = offset + 8;
        chunks.push({ type, length, data: image.subarray(dataStart, dataStart + length) });
        offset = dataStart + length + 4;
        if (type === 'IEND') break;
    }
    return chunks;
};
const decodeText = data => {
    const zero = data.indexOf(0);
    return { keyword: data.toString('latin1', 0, zero), text: data.subarray(zero + 1).toString('latin1') };
};

// THE SYNTHETIC SOURCE, WITH THE REAL CARD'S RELATIONS AND NONE OF ITS CONTENT.
// `equalCopies: true` is the contract the generator is now required to preserve; `equalCopies: false` builds the
// OTHER legal source (a card whose V1 root copy is stale) and is used to prove the generator preserves a DIFFERENCE
// rather than manufacturing equality.
function sourceCard({ equalCopies = true } = {}) {
    const identity = {
        name: 'Ariadne the Lantern Keeper',
        description: 'A wandering keeper of lanterns who keeps a long and detailed ledger of every road she has walked.',
        firstMes: 'The lantern swings as she turns, and she says: you are late, traveller, but the road waited for you.',
        creatorNotes: 'Written in a long winter, from notes kept on the road between the salt flats and the pass.',
    };
    const document = {
        name: identity.name,
        description: identity.description,
        personality: '',
        scenario: '',
        first_mes: identity.firstMes,
        mes_example: '',
        creatorcomment: identity.creatorNotes,
        avatar: 'none',
        talkativeness: '0.5',
        fav: false,
        tags: ['fantasy'],
        spec: 'chara_card_v3',
        spec_version: '3.0',
        create_date: '2024-01-01T00:00:00.000Z',
        data: {
            name: equalCopies ? identity.name : 'Ariadne of the Older Draft',
            description: identity.description,
            personality: '',
            scenario: '',
            first_mes: equalCopies ? identity.firstMes : 'An older greeting, from the draft this card was copied out of.',
            mes_example: '',
            creator_notes: identity.creatorNotes,
            system_prompt: '',
            post_history_instructions: '',
            tags: ['fantasy'],
            creator: 'lanternkeeper',
            character_version: '1.4',
            alternate_greetings: ['A second greeting, this one shorter, offered at the gate before the road opens.'],
            extensions: {
                talkativeness: '0.5',
                fav: false,
                world: 'The Salt Road Ledger',
                odysseia_trace: {
                    v: 1,
                    kid: 'key-0001',
                    nonce: 'nonce-0000000001',
                    ciphertext: 'Y2lwaGVydGV4dC1vZi10aGUtYXV0aG9ycy1wcml2YXRlLWRhdGEtMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDA=',
                },
                regex_scripts: [],
            },
        },
    };
    const trace = document.data.extensions.odysseia_trace;
    const chunkPayload = Buffer.from(JSON.stringify(trace), 'utf8');
    const docText = Buffer.from(JSON.stringify(document), 'utf8');
    const base64 = docText.toString('base64');
    const width = 8;
    const height = 8;
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 6; // RGBA
    ihdr[10] = 0;
    ihdr[11] = 0;
    ihdr[12] = 0;
    const stride = width * 4 + 1;
    const raw = Buffer.alloc(height * stride, 0);
    for (let row = 0; row < height; row += 1) {
        for (let pixel = 0; pixel < width; pixel += 1) {
            const base = row * stride + 1 + pixel * 4;
            raw[base] = 0x80;
            raw[base + 1] = 0x80;
            raw[base + 2] = 0x80;
            raw[base + 3] = 0xff;
        }
    }
    const image = Buffer.concat([
        PNG_SIGNATURE,
        encodeChunk('IHDR', ihdr),
        encodeChunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
        encodeChunk('tEXt', Buffer.concat([Buffer.from('chara\0', 'latin1'), Buffer.from(base64, 'latin1')])),
        encodeChunk('tEXt', Buffer.concat([Buffer.from('ccv3\0', 'latin1'), Buffer.from(base64, 'latin1')])),
        encodeChunk('trAc', chunkPayload),
        encodeChunk('IEND', Buffer.alloc(0)),
    ]);
    return { image, document, trace };
}

// The generator writes its refusals to stderr and its narration to stdout; both go to ONE file so the exit status is
// the process's own (AGENTS.md rule 8: never re-derive a status from captured text).
function runGenerator(args) {
    const logPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gotavern-q21-gen-')), 'generator.log');
    const fd = fs.openSync(logPath, 'w');
    try {
        const result = spawnSync(process.execPath, [GENERATOR, ...args], { cwd: repoRoot, stdio: ['ignore', fd, fd] });
        const log = fs.readFileSync(logPath, 'utf8');
        fs.rmSync(path.dirname(logPath), { recursive: true, force: true });
        return { status: result.status, log };
    } finally {
        fs.closeSync(fd);
    }
}

// The derived container, decoded the way both readers decode it: keyword, then base64, then JSON.
function decodeContainer(image) {
    const card = {};
    const others = {};
    for (const chunk of readChunks(image)) {
        if (chunk.type === 'tEXt') {
            const { keyword, text } = decodeText(chunk.data);
            card[keyword.toLowerCase()] = Buffer.from(text, 'base64');
            continue;
        }
        if (chunk.type === 'IDAT' || chunk.type === 'IHDR' || chunk.type === 'IEND') continue;
        try {
            others[chunk.type] = JSON.parse(chunk.data.toString('utf8'));
        } catch {
            // not JSON: not a carrier this gate reads
        }
    }
    return { card, others };
}

// THE CONTAINER AS A LIST OF (carrier, path, value) OCCURRENCES. The card document is taken from `ccv3` because that
// is the chunk pinned reads first (`character-card-parser.js:64-74`) and the one the derivation is defined on.
const occurrencesOf = ({ document, others }) => cardIdentityOccurrences({
    documents: [{ carrier: 'card document', document }],
    chunks: Object.entries(others ?? {}).map(([type, body]) => ({ carrier: `${type} chunk`, document: body })),
});

const derivedOccurrences = derived => occurrencesOf({
    document: JSON.parse(derived.card.ccv3.toString('utf8')),
    others: derived.others,
});

test('the generator derives every carrier of one identity value from ONE canonical value', () => {
    const source = sourceCard({ equalCopies: true });
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gotavern-q21-invariant-'));
    const sourcePath = path.join(workDir, 'source-card.png');
    const outDir = path.join(workDir, 'out');
    fs.writeFileSync(sourcePath, source.image);
    const run = runGenerator(['--out', outDir, '--card', `card-invariant=${sourcePath}`]);
    assert.equal(run.status, 0, `the generator refused a source whose carriers AGREE, which is the case it must accept:\n${run.log}`);

    const derivedPath = path.join(outDir, 'card-invariant.png');
    assert.ok(fs.existsSync(derivedPath), `the generator wrote no card:\n${run.log}`);
    const derived = decodeContainer(fs.readFileSync(derivedPath));

    // (1) ONE CARD, ONE DOCUMENT: the `chara` and `ccv3` chunks decode to the SAME bytes. This is the shape the
    // committed fixture got wrong, and it is the check pinned's own writer rule (`:28-39`) makes necessary.
    assert.ok(derived.card.chara && derived.card.ccv3, 'the derived container lost a card chunk');
    assert.ok(derived.card.chara.equals(derived.card.ccv3),
        `the derived chara and ccv3 chunks carry DIFFERENT documents (${derived.card.chara.length} vs ${derived.card.ccv3.length} bytes)`);

    // (2) EQUALITY AND DIFFERENCE PRESERVED ACROSS EVERY CARRIER, compared position by position.
    const relations = cardIdentityRelationViolations(occurrencesOf({ document: source.document, others: { trAc: source.trace } }), derivedOccurrences(derived));
    assert.deepEqual(relations.violations, [],
        `the derivation split or invented ${relations.violations.length} identity relation(s): ${JSON.stringify(relations.violations.slice(0, 2))}`);
    assert.ok(relations.equalityPairs > 0, 'no equal pair was compared, so the gate proved nothing');
    assert.ok(relations.differencePairs > 0, 'no different pair was compared, so the gate proved nothing on the other side');

    // (3) THE ROOT COPIES AND THE MIRRORED CHUNK, NAMED INDIVIDUALLY. The generic comparison above is the gate; these
    // assertions exist so a failure names the carrier a reader would look at.
    const document = JSON.parse(derived.card.ccv3.toString('utf8'));
    assert.equal(document.name, document.data.name, 'the V1 root name and the V2 data name disagree');
    assert.equal(document.description, document.data.description, 'the V1 root description and the V2 data description disagree');
    assert.equal(document.first_mes, document.data.first_mes, 'the V1 root first_mes and the V2 data first_mes disagree');
    assert.ok(derived.others.trAc, 'the derived container lost the mirrored chunk, so the tolerance surface changed');
    for (const key of CARD_MIRRORED_CHUNKS[0].keys) {
        assert.deepEqual(derived.others.trAc[key], document.data.extensions.odysseia_trace[key],
            `the mirrored chunk and its extension twin disagree about ${key}, so one trace has two representations`);
    }

    // (4) THE MANIFEST RECORDS THE CHECK THAT RAN, not the intent. A manifest with no `identityRelations` block is a
    // generator that did not run the gate, and it must not be mistaken for one that passed.
    const manifest = JSON.parse(fs.readFileSync(path.join(outDir, 'real-fixture-manifest.json'), 'utf8'));
    const recorded = manifest.cards[0]?.replaced?.preserved?.identityRelations ?? null;
    assert.ok(recorded, 'the manifest does not record identityRelations, so the gate cannot be shown to have run');
    const sourceOccurrences = occurrencesOf({ document: source.document, others: { trAc: source.trace } });
    assert.equal(recorded.occurrences, sourceOccurrences.length,
        `the manifest compared ${recorded.occurrences} occurrence(s) and the source carries ${sourceOccurrences.length}`);
    assert.ok(recorded.occurrences > 0, 'the manifest records zero identity occurrences');
    assert.ok(recorded.sharedReplacements > 0,
        'no replacement was shared between carriers, so every carrier of one value got its own marker -- the Q21 defect');
    fs.rmSync(workDir, { recursive: true, force: true });
});

test('a source whose V1 root copies DISAGREE keeps them disagreeing, so the derivation invents no identity', () => {
    const source = sourceCard({ equalCopies: false });
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gotavern-q21-differ-'));
    const sourcePath = path.join(workDir, 'source-card.png');
    const outDir = path.join(workDir, 'out');
    fs.writeFileSync(sourcePath, source.image);
    const run = runGenerator(['--out', outDir, '--card', `card-differ=${sourcePath}`]);
    assert.equal(run.status, 0, `the generator refused a legal stale-root source:\n${run.log}`);
    const derived = decodeContainer(fs.readFileSync(path.join(outDir, 'card-differ.png')));
    const document = JSON.parse(derived.card.ccv3.toString('utf8'));
    assert.notEqual(document.name, document.data.name,
        'the source said two different names and the derivation made them EQUAL, which manufactures an identity the card did not have');
    const relations = cardIdentityRelationViolations(
        occurrencesOf({ document: source.document, others: { trAc: source.trace } }),
        derivedOccurrences(derived));
    assert.deepEqual(relations.violations, [], `a stale-root source produced ${relations.violations.length} relation violation(s)`);
    fs.rmSync(workDir, { recursive: true, force: true });
});

test('a source that already carries two card documents yields ONE derivation, and the choice is recorded', () => {
    // The pre-repair container's shape, built as a source: `ccv3` holds one document, `chara` a different one at the
    // same length. Pinned's reader answers `ccv3` (`character-card-parser.js:64-74`), so the derivation must be
    // defined on THAT document and the other chunk REPLACED -- never derived on its own, which is the Q21 defect.
    //
    // THE ASSERTION IS BYTE EQUALITY, NOT INTENT: the file produced from the two-document source must be IDENTICAL to
    // the file produced from a source whose two chunks already agree. If the `chara` document influenced the derivation
    // in any way -- its own walk, its own marker counter, its own filler -- the two files would differ.
    const reference = sourceCard({ equalCopies: true });
    const divergentSource = sourceCard({ equalCopies: true });
    const chunks = readChunks(divergentSource.image);
    const text = chunks.filter(chunk => chunk.type === 'tEXt').map(chunk => decodeText(chunk.data));
    const canonical = JSON.parse(Buffer.from(text.find(entry => entry.keyword.toLowerCase() === 'ccv3').text, 'base64').toString('utf8'));
    const divergent = JSON.parse(JSON.stringify(canonical));
    const originalName = String(divergent.data.name);
    divergent.data.name = `${originalName.slice(0, originalName.length - 1)}Z`;
    assert.equal(Buffer.byteLength(JSON.stringify(divergent)), Buffer.byteLength(JSON.stringify(canonical)),
        'the divergent document changed length, so this case would prove the wrong thing');
    const rebuilt = [PNG_SIGNATURE];
    for (const chunk of chunks) {
        if (chunk.type !== 'tEXt') {
            rebuilt.push(encodeChunk(chunk.type, chunk.data));
            continue;
        }
        const { keyword } = decodeText(chunk.data);
        if (keyword.toLowerCase() === 'chara') {
            const payload = Buffer.concat([Buffer.from('chara\0', 'latin1'), Buffer.from(Buffer.from(JSON.stringify(divergent), 'utf8').toString('base64'), 'latin1')]);
            rebuilt.push(encodeChunk('tEXt', payload));
            continue;
        }
        rebuilt.push(encodeChunk('tEXt', chunk.data));
    }

    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gotavern-q21-two-docs-'));
    const twoDocumentPath = path.join(workDir, 'two-documents.png');
    const referencePath = path.join(workDir, 'one-document.png');
    fs.writeFileSync(twoDocumentPath, Buffer.concat(rebuilt));
    fs.writeFileSync(referencePath, reference.image);
    const twoDocumentOut = path.join(workDir, 'out-two');
    const referenceOut = path.join(workDir, 'out-one');
    const twoDocumentRun = runGenerator(['--out', twoDocumentOut, '--card', `card-two=${twoDocumentPath}`]);
    assert.equal(twoDocumentRun.status, 0, `the generator refused a two-document source instead of normalising it:\n${twoDocumentRun.log}`);
    const referenceRun = runGenerator(['--out', referenceOut, '--card', `card-one=${referencePath}`]);
    assert.equal(referenceRun.status, 0, `the generator refused the one-document control:\n${referenceRun.log}`);

    const twoDocumentBytes = fs.readFileSync(path.join(twoDocumentOut, 'card-two.png'));
    const referenceBytes = fs.readFileSync(path.join(referenceOut, 'card-one.png'));
    assert.ok(twoDocumentBytes.equals(referenceBytes),
        'the derived file differs when the DISCARDED `chara` document differs, so that chunk was still contributing a derivation of its own');

    // AND THE CHOICE IS VISIBLE. A normalisation that cannot be audited is the silent rewrite this repository forbids.
    const manifest = JSON.parse(fs.readFileSync(path.join(twoDocumentOut, 'real-fixture-manifest.json'), 'utf8'));
    const normalisation = manifest.cards[0]?.replaced?.preserved?.sourceChunkNormalisation ?? null;
    assert.ok(normalisation, 'the manifest does not record which source chunk was authoritative');
    assert.equal(normalisation.agreed, false, 'the manifest claims the source chunks agreed, and they did not');
    assert.equal(normalisation.kept, 'ccv3', `the authoritative chunk is ${JSON.stringify(normalisation.kept)}; pinned reads ccv3 first (character-card-parser.js:64-74)`);
    assert.deepEqual(normalisation.replaced, ['chara'], `the replaced chunks are ${JSON.stringify(normalisation.replaced)}`);
    assert.ok(normalisation.differingFields.some(entry => entry.includes('data.name')),
        `the differing fields do not name data.name, which is the only field that differed: ${JSON.stringify(normalisation.differingFields)}`);
    fs.rmSync(workDir, { recursive: true, force: true });
});

test('the invariant reports BOTH failure kinds on a container that has them', () => {
    // THE GATE'S TEETH, on the derived bytes rather than on the generator's intent. A gate that cannot report the
    // defect it was written for is decoration; these two mutations are the defect and its mirror image.
    const source = sourceCard({ equalCopies: true });
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gotavern-q21-teeth-'));
    const sourcePath = path.join(workDir, 'source-card.png');
    const outDir = path.join(workDir, 'out');
    fs.writeFileSync(sourcePath, source.image);
    const run = runGenerator(['--out', outDir, '--card', `card-teeth=${sourcePath}`]);
    assert.equal(run.status, 0, `the generator refused the reference source:\n${run.log}`);
    const derived = decodeContainer(fs.readFileSync(path.join(outDir, 'card-teeth.png')));
    const sourceOccurrences = occurrencesOf({ document: source.document, others: { trAc: source.trace } });
    const referenceOccurrences = derivedOccurrences(derived);
    assert.deepEqual(cardIdentityRelationViolations(sourceOccurrences, referenceOccurrences).violations, [],
        'the reference derivation already violates the invariant, so the teeth case proves nothing');

    // (a) SPLIT ONE IDENTITY: the V1 root name gets a different marker while `data.name` keeps its own. This is the
    // committed fixture's original defect, reproduced on the fixed bytes.
    // NO `structuredClone`: it turns a Buffer into a Uint8Array, whose `toString('utf8')` is a comma-joined byte list.
    // The container is rebuilt from parsed JSON instead, which is also what a reader sees.
    const splitDocument = JSON.parse(derived.card.ccv3.toString('utf8'));
    const originalRootName = String(splitDocument.name);
    splitDocument.name = `${originalRootName.slice(0, originalRootName.length - 1)}9`;
    const splitJson = Buffer.from(JSON.stringify(splitDocument), 'utf8');
    const split = { card: { ...derived.card, ccv3: splitJson, chara: splitJson }, others: derived.others };
    const splitViolations = cardIdentityRelationViolations(sourceOccurrences, derivedOccurrences(split));
    assert.ok(splitViolations.violations.some(violation => violation.kind === 'split-identity'),
        'the gate did NOT report a split identity, so it cannot catch the Q21 defect');

    // (b) COLLAPSE AN IDENTITY: two DIFFERENT source values are given ONE derived value. `creator` and
    // `character_version` are independent in the source, so equalising them in the derivation is an identity the card
    // did not have. (Using `description` here would prove nothing: the source's root and `data` copies are equal, so
    // the derivation legitimately gives them one marker already.)
    const collapsedDocument = JSON.parse(derived.card.ccv3.toString('utf8'));
    collapsedDocument.data.character_version = collapsedDocument.data.creator;
    const collapsedJson = Buffer.from(JSON.stringify(collapsedDocument), 'utf8');
    const collapsed = { card: { ...derived.card, ccv3: collapsedJson, chara: collapsedJson }, others: derived.others };
    const collapsedViolations = cardIdentityRelationViolations(sourceOccurrences, derivedOccurrences(collapsed));
    assert.ok(collapsedViolations.violations.some(violation => violation.kind === 'invented-identity'),
        'the gate did NOT report an invented identity, so a derivation that merges two objects would pass it');
    fs.rmSync(workDir, { recursive: true, force: true });
});

test('the COMMITTED fixture is one card, and its derivation record is not evidence for the new invariant', () => {
    // WHAT IS PROVABLE ON THE COMMITTED BYTES: the two card chunks decode to the SAME document. That is the defect the
    // ledger cites, and it is repaired.
    assert.ok(fs.existsSync(COMMITTED_CARD), `the committed card is missing at ${COMMITTED_CARD}`);
    const derived = decodeContainer(fs.readFileSync(COMMITTED_CARD));
    assert.ok(derived.card.chara && derived.card.ccv3, 'the committed fixture has no chara/ccv3 pair');
    assert.ok(derived.card.chara.equals(derived.card.ccv3), 'the committed fixture carries two different card documents');
    const document = JSON.parse(derived.card.ccv3.toString('utf8'));
    assert.equal(typeof document.data?.name, 'string');

    // WHAT IS NOT PROVABLE, STATED RATHER THAN SKIPPED: the ROOT-vs-DATA and CHUNK-vs-EXTENSION relations cannot be
    // checked without the source they came from, and the original card is not in this repository (AGENTS.md rule 56).
    // The committed fixture was produced by the PRE-fix generator -- every NAME field was replaced TWICE, once per
    // card chunk, which is the 2-walks-per-field signature -- and was then repaired from itself by
    // `tools/repair-card-chunks.mjs`. Its derivation statistics therefore predate the invariant, so this test REFUSES
    // to call the file's relations verified and says so here, in the assertion messages a reader will see.
    const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'tests', 'browser', 'fixtures', 'real', 'real-fixture-manifest.json'), 'utf8'));
    const card = manifest.cards.find(entry => entry.file === 'card-a.png') ?? null;
    assert.ok(card, 'the manifest does not describe card-a.png');
    const replacedPaths = card.replaced?.replacedPaths ?? {};
    assert.equal(replacedPaths.name ?? 0, 2,
        'the committed card\'s `name` was no longer replaced twice, so its manifest was produced by a DIFFERENT generator version than the one this test documents; re-read the derivation before trusting the note above');
    assert.equal(replacedPaths['_root.name'] ?? 0, 2,
        'the committed card\'s root `name` was no longer replaced twice, so the pre-fix two-walk signature this test documents is gone');
    // A NON-NULL `identityRelations` HERE WOULD MEAN THE FILE WAS RE-DERIVED BY THE FIXED GENERATOR, which is the change
    // that would let the relation invariant be claimed on the committed bytes -- and it would need this test and the
    // Q21 report updated in the same change, never silently.
    assert.equal(card.replaced?.preserved?.identityRelations ?? null, null,
        'the committed manifest now records identityRelations, which means card-a was RE-DERIVED -- update this test and the Q21 report instead of leaving a stale claim');
});
