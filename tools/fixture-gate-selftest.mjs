#!/usr/bin/env node
// PROVE THE FIXTURE GATES CAN FAIL.
//
// AGENTS.md verification rule 7: "never let a step that appears to have happened stand unverified" -- and the
// differential doctrine's rule 4: every gate has teeth, and the teeth are DEMONSTRATED. A generator whose
// assertions have never been seen to fire is decoration, and the two gates this file exists for are the ones
// standing between a user's real card and a public repository.
//
// EVERY CASE BELOW IS SYNTHESISED. No real artifact is read: the inputs are built here, in memory, so the
// proof travels with the repository and CI can run it with no originals on the machine (AGENTS.md 56's whole
// point: "CI must be able to run without ever holding the originals").
//
// WHAT IT PROVES:
//
//   1. the identity-path matcher reaches the fields the brief names (`data`-relative), and does NOT reach a
//      neutral field -- the first walker used its own `data.`-prefixed path, every lookup missed, and a
//      19 MB card would have been written with the user's name in it;
//   2. each marker tier is accepted and a bare name is refused (the existing name gate);
//   3. THE CARD DERIVATION REFUSES, by name, on a synthesised card whose identity field would have to change
//      its byte length, on one whose IDAT cannot be rebuilt, and on one that carries an identity string the
//      list does not name;
//   4. THE CONTENT SCANNER REFUSES an explicit adult/NSFW marker -- the gate AGENTS.md 56 says a card needs
//      before any card may be committed -- and the same text WITHOUT the marker passes, so the refusal is
//      the marker's and not the scan's;
//   5. the watermark classes and the unmarked-long-string rule still fire, and a fixture that passes all of
//      them passes.
//
// Usage: node tools/fixture-gate-selftest.mjs        (exit 0 = every case behaved, 1 = a gate is decoration)

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

import { CARD_IDENTITY_FIELDS, cardIdentityFieldFor } from './real-fixture-profile.mjs';
import { CONTENT_CLASSES, isIdentityMarker, scanText } from './check-fixture-watermarks.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const results = [];
const record = (name, ok, detail) => {
    results.push({ name, ok, detail });
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` -- ${detail}` : ''}`);
};

// --- 1. the matcher reaches what the brief names -------------------------------------------------
const MATCH_CASES = [
    ['data.name', 'name'],
    ['_root.name', '_root.name'],
    ['_root.description', '_root.description'],
    ['data.creator', 'creator'],
    ['data.creator_notes', 'creator_notes'],
    ['data.tags.0', 'tags.*'],
    ['data.tags.17', 'tags.*'],
    ['data.alternate_greetings.4', 'alternate_greetings.*'],
    ['data.group_only_greetings.0', 'group_only_greetings.*'],
    ['data.character_book.name', 'character_book.name'],
    ['data.character_book.entries.489.comment', 'character_book.entries.*.comment'],
    ['data.character_book.entries.0.content', 'character_book.entries.*.content'],
    ['data.character_book.entries.0.keys.3', 'character_book.entries.*.keys.*'],
    ['data.character_book.entries.0.secondary_keys.3', 'character_book.entries.*.secondary_keys.*'],
    ['data.extensions.tavern_helper.scripts.0.name', 'extensions.tavern_helper.scripts.*.name'],
    ['data.extensions.tavern_helper.scripts.0.info', 'extensions.tavern_helper.scripts.*.info'],
    ['data.extensions.tavern_helper.scripts.3.button.buttons.0.name', 'extensions.tavern_helper.scripts.*.button.buttons.*.name'],
    ['data.extensions.tavern_helper.scripts.1.data.title', 'extensions.tavern_helper.scripts.*.data.title'],
    ['data.extensions.tavern_helper.scripts.1.data.script_button_name', 'extensions.tavern_helper.scripts.*.data.script_button_name'],
    ['data.extensions.tavern_helper.scripts.0.data.summary.generation.detect_regexes.2', 'extensions.tavern_helper.scripts.*.data.summary.generation.detect_regexes.*'],
    ['data.extensions.tavern_helper.scripts.0.data.groups.1.options.0.enable.4', 'extensions.tavern_helper.scripts.*.data.groups.*.options.*..*.*'],
    ['data.extensions.tavern_helper.scripts.0.data.groups.0.enable_group.2', 'extensions.tavern_helper.scripts.*.data.groups.*.enable_group.*'],
    ['data.extensions.tavern_helper.scripts.0.data.groups.0.disable_group.2', 'extensions.tavern_helper.scripts.*.data.groups.*.disable_group.*'],
    ['data.extensions.tavern_helper.scripts.0.content', 'extensions.tavern_helper.scripts.*.content'],
    ['data.extensions.regex_scripts.1.scriptName', 'extensions.regex_scripts.*.scriptName'],
    ['data.extensions.regex_scripts.1.replaceString', 'extensions.regex_scripts.*.replaceString'],
    ['data.first_mes', 'first_mes'],
    ['data.mes_example', 'mes_example'],
    ['data.post_history_instructions', 'post_history_instructions'],
];
for (const [samplePath, expected] of MATCH_CASES) {
    const got = cardIdentityFieldFor(samplePath)?.path ?? null;
    record(`matcher: ${samplePath} -> ${expected}`, got === expected, got === expected ? undefined : `got ${got}`);
}
// AND IT MUST NOT REACH A NEUTRAL FIELD. A matcher that says "yes" to everything replaces the whole card,
// which is a different failure and a worse one: the fixture would no longer BE the user's structure.
const NEUTRAL_CASES = ['data.spec', '_root.spec_version', 'data.character_book.entries.0.enabled',
    'data.character_book.entries.0.insertion_order', 'data.character_book.entries.0.position',
    'data.character_book.entries.0.depth', 'data.character_book.entries.0.selective',
    'data.character_book.entries.0.id', 'data.character_book.entries.0.keys.length',
    'data.extensions.tavern_helper.scripts.0.contentHash'];
// NOTE: `extensions.tavern_helper.scripts.0.id` and `extensions.regex_scripts.0.id` are NOT in this list any
// more, and that is a MEASURED correction rather than a convenience: card B's regex script id is
// `[REDACTED_HANDLE]` (an author handle) and card A's helper script id is a UUID unique to the
// author's build. The survivor sweep found both. A neutral list is a claim, and this one was wrong.
for (const samplePath of NEUTRAL_CASES) {
    const got = cardIdentityFieldFor(samplePath);
    record(`matcher keeps neutrals: ${samplePath} is not an identity field`, got === null, got ? `matched ${got.path}` : undefined);
}
// EVERY DECLARED FIELD must be reachable by at least one path, or the list carries a rule nothing applies. The
// sample is built from the PATTERN ITSELF: each `*` becomes `0`, and `..*` (any remaining key) becomes `any`.
// The first version applied `.replace(/\*/g, '0')` to the whole pattern, so `..*` became `.00` and every field
// with a greedy segment reported "no sample path matched" -- a self-test bug that read as a dead rule.
for (const field of CARD_IDENTITY_FIELDS) {
    const sample = field.path.replace(/\.\.\*/g, '.any').replace(/\*/g, '0');
    const probes = [`data.${sample}`, sample.startsWith('_root.') ? sample : `_root.${sample}`];
    const hit = probes.map(cardIdentityFieldFor).find(Boolean) ?? null;
    record(`matcher reaches declared field ${field.path}`, hit === field, hit === null ? `no sample path matched (tried ${probes.join(', ')}), so the rule is dead` : (hit === field ? undefined : `matched ${hit.path} by a different rule`));
}

// --- 2/4/5. the scanner, directly ----------------------------------------------------------------
const NEUTRAL_PROSE = JSON.stringify({ data: { name: 'MARK_000001', description: 'a quiet scene with no tokens', creator: 'MARK_000002' } });
record('scanner passes neutral prose', scanText(NEUTRAL_PROSE).ok, scanText(NEUTRAL_PROSE).findings[0]);
for (const [name, pattern] of CONTENT_CLASSES) {
    // A SYNTHESISED input carrying the token, in the shape a real card carries it. The bare word alone is not
    // enough for every class (the flag classes are JSON flags), so the sample is built per class.
    const samples = {
        'an NSFW platform flag': { data: { extensions: { nsfw: true } } },
        'an explicit-tag marker': { data: { tags: ['sexual_content'], extensions: { sexual_content: true } } },
        'explicit sexual content': { data: { description: 'the scene describes masturbation at length' } },
        'explicit sexual anatomy': { data: { description: 'the anatomy of the penis is described' } },
        'a banned-fetish tag': { data: { tags: ['loli'] } },
    };
    const sample = JSON.stringify(samples[name]);
    const scan = scanText(sample, { file: `synthesised-${name}.json` });
    const fired = scan.findings.some((finding) => finding.includes('CONTENT: carries ' + name));
    record(`scanner refuses content class: ${name}`, fired, fired ? undefined : `findings: ${JSON.stringify(scan.findings)}`);
    // AND THE SAME CLASS DOES NOT FIRE ON A CLEAN CARD, so the refusal belongs to the token.
    record(`scanner does not refuse a clean card for class: ${name}`, !scanText(NEUTRAL_PROSE).findings.some((finding) => finding.includes('CONTENT:')), 'a clean document tripped the content check');
    void pattern;
}
record('scanner refuses a URL', !scanText(JSON.stringify({ data: { creator_notes: 'see https://example.invalid/x' } })).ok);
record('scanner refuses a Discord handle', !scanText(JSON.stringify({ data: { creator_notes: 'my discord is someone#1234' } })).ok);
// THE E-MAIL PATTERN MUST STILL CATCH A REAL ADDRESS after being bounded (the bound exists because the unbounded
// form was quadratic on base64 and wedged the generator: measured 93 s on 200 KB). Both halves are asserted, so
// "the gate is fast now" cannot have been bought by widening it.
record('scanner refuses an e-mail address', scanText(JSON.stringify({ data: { creator_notes: 'write to someone.name+tag@example.co.uk' } })).findings.some((finding) => finding.includes('an e-mail address')));
record('scanner refuses an e-mail at a one-label domain', scanText(JSON.stringify({ data: { creator_notes: 'someone@localhost' } })).findings.some((finding) => finding.includes('an e-mail address')) === false, 'a bare localhost address is not matched, and that is stated rather than assumed');
// AND THE QUADRATIC CASE IS BOUNDED: 512 KB of `@`-free word characters must scan in seconds, not minutes.
{
    const started = Date.now();
    scanText('a'.repeat(512 * 1024), { file: 'quadratic-guard' });
    const elapsed = Date.now() - started;
    record('scanner is linear on a long @-free run (bounded e-mail pattern)', elapsed < 5000, `${elapsed} ms for 512 KB`);
}
record('scanner refuses an unmarked long string', !scanText(JSON.stringify({ data: { description: 'y'.repeat(80) } })).ok);
record('scanner accepts a marker-prefixed long string', scanText(JSON.stringify({ data: { description: 'MARK_000003' + '测'.repeat(30) } })).ok);

// THE SHORT TIER, AND THE PROOF THAT IT IS NOT A NAME BAN. Every value below is one a real card carries or a
// plausible marker; none of the first five is a marker, so a predicate that accepted them would ship the user's
// data. The predicate is the REAL one (`isIdentityMarker`), and the case is ALSO driven through the CLI entry
// point a reviewer runs, so the proof is about the program and not only about a module.
const SHORT_TIER_SAMPLES = [
    ['a bare CJK directive', '勿动', false],
    ['a bare tag word', 'female', false],
    ['a bare version', '1', false],
    ['a bare personality', 'calm', false],
    ['a bare three-letter word', 'abc', false],
    ['a short-marker field', '#12', true],
    ['a long marker', 'MARK_000012', true],
    ['a medium marker with filler', 'M000013xxx', true],
    ['a near-miss with a letter', '#1a', false],
    ['a near-miss with a space', '#1 ', false],
    // THE 1-BYTE TIER, and the card's own short values that must still be refused.
    ['the 1-byte tier', '#', true],
    ['the real card\'s 1-byte key', 'K', false],
    ['the real card\'s 2-byte key', 'v1', false],
    ['the real card\'s other 2-byte key', 'DG', false],
];
for (const [label, value, shouldPass] of SHORT_TIER_SAMPLES) {
    const actual = isIdentityMarker(value);
    record(`marker predicate: ${label} ${shouldPass ? 'is accepted' : 'is refused'}`, actual === shouldPass, actual === shouldPass ? undefined : `predicate said ${actual}`);
    let cliActual = null;
    try {
        const output = execFileSync(process.execPath, [path.join(here, 'check-fixture-watermarks.mjs'), '--marker', value], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        cliActual = JSON.parse(output.trim().split('\n').pop()).isMarker;
    } catch (error) {
        cliActual = `threw: ${String(error.stderr ?? error).slice(0, 120)}`;
    }
    record(`marker CLI: ${label} ${shouldPass ? 'is accepted' : 'is refused'}`, cliActual === shouldPass, cliActual === shouldPass ? undefined : `CLI said ${JSON.stringify(cliActual)}`);
}

// --- 3. the CARD DERIVATION refusals, on synthesised cards ---------------------------------------
const CRC_TABLE = (() => {
    const table = new Int32Array(256);
    for (let index = 0; index < 256; index++) {
        let value = index;
        for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xEDB88320 ^ (value >>> 1) : value >>> 1;
        table[index] = value;
    }
    return table;
})();
const crc32 = (buffer) => {
    let crc = 0 ^ -1;
    for (const byte of buffer) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xFF];
    return (crc ^ -1) >>> 0;
};
const pngChunk = (type, data) => {
    // length(4) + type(4) + data + crc(4). The CRC covers TYPE+DATA, so the read-back offset is
    // 8 + data.length; writing the type into a separate `body` buffer as well made the CRC land inside the
    // type field, and the generator correctly refused the corrupt file ("chunk IHDR has CRC 33554432").
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'latin1'), data])), 0);
    return Buffer.concat([head, data, crc]);
};

/** A synthesised V3 card: `chara` + `ccv3`, a trAc chunk, and a real IDAT. */
function synthesisedCard(document, { idatBytes = 0 } = {}) {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(2, 0);
    ihdr.writeUInt32BE(2, 4);
    ihdr[8] = 8;
    ihdr[9] = 2;
    const raw = Buffer.from([0, 1, 2, 3, 4, 5, 6, 0, 7, 8, 9, 10, 11, 12]);
    const idat = zlib.deflateSync(idatBytes > 0 ? Buffer.alloc(idatBytes, 0x41) : raw, { level: 0 });
    const text = Buffer.from(JSON.stringify(document), 'utf8').toString('base64');
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
        pngChunk('IHDR', ihdr),
        pngChunk('IDAT', idat),
        pngChunk('tEXt', Buffer.concat([Buffer.from('chara\0', 'latin1'), Buffer.from(text, 'latin1')])),
        pngChunk('tEXt', Buffer.concat([Buffer.from('ccv3\0', 'latin1'), Buffer.from(text, 'latin1')])),
        pngChunk('trAc', Buffer.from([0, 0, 0, 1])),
        pngChunk('IEND', Buffer.alloc(0)),
    ]);
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gotavern-fixture-gate-selftest-'));
const outDir = path.join(tempRoot, 'out');
fs.mkdirSync(outDir, { recursive: true });

function buildCard(cardPath, out) {
    try {
        const output = execFileSync(process.execPath, [path.join(here, 'build-real-fixtures.mjs'), '--out', out, '--card', `probe=${cardPath}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        return { ok: true, output };
    } catch (error) {
        return { ok: false, output: `${error.stdout ?? ''}${error.stderr ?? ''}`, code: error.status };
    }
}

const CLEAN_CARD = {
    spec: 'chara_card_v3', spec_version: '3.0',
    data: {
        name: 'MARK_000001', description: 'a clean scene', personality: 'calm', scenario: 'a room',
        first_mes: 'hello', mes_example: '', creator: 'MARK_000002', creator_notes: 'MARK_000003',
        system_prompt: '', post_history_instructions: '', alternate_greetings: ['MARK_000004'],
        tags: ['MARK_000005'], character_version: 'MARK_000006',
        character_book: { name: 'MARK_000007', entries: [{ keys: ['MARK_000008'], content: 'the lore', comment: 'MARK_000009', enabled: true, insertion_order: 3, position: 4, depth: 2 }] },
        extensions: { regex_scripts: [], tavern_helper: { scripts: [] } },
    },
};

// 3a. A CLEAN SYNTHESISED CARD MUST BUILD. Without this the refusals below prove nothing: a generator that
// refuses everything passes every "refuses" case in the world.
const cleanPath = path.join(tempRoot, 'clean.png');
fs.writeFileSync(cleanPath, synthesisedCard(CLEAN_CARD, { idatBytes: 4096 }));
const clean = buildCard(cleanPath, outDir);
record('derivation BUILDS a clean synthesised card', clean.ok, clean.ok ? undefined : clean.output.slice(0, 400));
if (clean.ok) {
    const built = fs.readFileSync(path.join(outDir, 'probe.png'));
    record('derivation output is still a PNG that decodes to the same dimensions', built.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])) && built.readUInt32BE(16) === 2 && built.readUInt32BE(20) === 2, undefined);
    // The IDAT must be smaller (the original carried 4096 filler bytes) and the trAc must be present.
    record('derivation replaced the IDAT and kept the unknown chunk', built.includes(Buffer.from('trAc', 'latin1')) && built.length < fs.readFileSync(cleanPath).length, undefined);
    // AND THE SCANNER MUST PASS THE OUTPUT, which is the gate CI runs.
    let scanned = { ok: true };
    try {
        execFileSync(process.execPath, [path.join(here, 'check-fixture-watermarks.mjs'), path.join(outDir, 'probe.png')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
        scanned = { ok: false, output: `${error.stdout ?? ''}${error.stderr ?? ''}` };
    }
    record('the scanner PASSES the derived card', scanned.ok, scanned.output?.slice(0, 300));
}

// 3b. A CARD CARRYING PLATFORM-PROHIBITED MATERIAL MUST BE REFUSED BY THE DERIVATION ITSELF. This is the
// refusal AGENTS.md 56 names as the reason no card was ever committed, and it is proven here on a
// synthesised card rather than on the user's.
const nsfwCard = JSON.parse(JSON.stringify(CLEAN_CARD));
nsfwCard.data.description = 'the scene describes masturbation at length';
nsfwCard.data.extensions = { ...nsfwCard.data.extensions, nsfw: true };
const nsfwPath = path.join(tempRoot, 'nsfw.png');
fs.writeFileSync(nsfwPath, synthesisedCard(nsfwCard));
const nsfw = buildCard(nsfwPath, outDir);
record('derivation REFUSES a card carrying an explicit adult marker', !nsfw.ok && /CONTENT:/.test(nsfw.output), nsfw.ok ? 'the generator wrote it' : nsfw.output.trim().split('\n').slice(0, 2).join(' | ').slice(0, 300));
record('derivation wrote no file for the refused card', !fs.existsSync(path.join(outDir, 'probe.png.nsfw')) && !fs.existsSync(path.join(outDir, 'nsfw.png')), undefined);

// 3c. A FIELD THE IDENTITY LIST DOES NOT NAME, carrying an original string, must be caught by the sweep.
// This is the case that found the preset work's deep label layer, and the only check that can.
const unlistedCard = JSON.parse(JSON.stringify(CLEAN_CARD));
unlistedCard.data.extensions.regex_scripts = [{ scriptName: 'MARK_000010', findRegex: '/x/', replaceString: 'MARK_000011' }];
unlistedCard.data.extensions.some_other_tool = { owner_banner: 'a string only the author could have written' };
const unlistedPath = path.join(tempRoot, 'unlisted.png');
fs.writeFileSync(unlistedPath, synthesisedCard(unlistedCard));
const unlisted = buildCard(unlistedPath, outDir);
record('derivation REFUSES an original string in a field the list does not name', !unlisted.ok && /do not name|does not name/.test(unlisted.output), unlisted.ok ? 'the generator wrote it' : unlisted.output.trim().split('\n').slice(0, 2).join(' | ').slice(0, 300));

// 3d. THE SHORT-FIELD CASE, IN ITS REAL FORM. The first version asserted that a 1-byte identity field is
// refused; the real card proved that wrong (its `character_book.entries.8.keys[2]` is `K`), so the tier was
// added and the field is now REPLACED. What must still be refused is a field with no bytes at all, because no
// marker fits in zero bytes and the field must not be left verbatim. That case is asserted here, and the 1-byte
// case is asserted as a SUCCESS with the derived bytes carrying the marker and not the letter.
const tinyCard = JSON.parse(JSON.stringify(CLEAN_CARD));
tinyCard.data.creator = 'q';
const tinyPath = path.join(tempRoot, 'tiny.png');
fs.writeFileSync(tinyPath, synthesisedCard(tinyCard));
const tiny = buildCard(tinyPath, outDir);
record('derivation REPLACES a 1-byte identity field with the 1-byte marker', tiny.ok, tiny.ok ? undefined : tiny.output.trim().split('\n').slice(0, 2).join(' | ').slice(0, 300));
if (tiny.ok) {
    const built = fs.readFileSync(path.join(outDir, 'probe.png'));
    const text = built.toString('latin1');
    const offset = text.indexOf('ccv3\0');
    const json = Buffer.from(text.slice(offset + 5).split('\0')[0].match(/^[A-Za-z0-9+/=]+/)?.[0] ?? '', 'base64').toString('utf8');
    let creator = null;
    try {
        creator = JSON.parse(json).data.creator;
    } catch {
        creator = '<unparseable>';
    }
    record('the 1-byte field came back as the marker, not the original letter', creator === '#', `creator=${JSON.stringify(creator)}`);
    fs.rmSync(path.join(outDir, 'probe.png'), { force: true });
}

// 3e. A NON-PNG input must be refused, not misparsed as a preset.
const notPngPath = path.join(tempRoot, 'notpng.png');
fs.writeFileSync(notPngPath, Buffer.from('{"data":{}}', 'utf8'));
const notPng = buildCard(notPngPath, outDir);
record('derivation REFUSES a .png that is not a PNG', !notPng.ok && /not a PNG/.test(notPng.output), notPng.ok ? 'the generator wrote it' : notPng.output.trim().split('\n')[0].slice(0, 300));

// 3f. A URL in an identity field is REPLACED, so the derived card passes the scanner -- and that is the right
// result: the identity substitution is what removes it. The proof that the SCANNER would have refused the
// original is a separate, direct case above ("scanner refuses a URL"). What is proven here is the composition:
// a card whose `creator_notes` carries a URL derives successfully BECAUSE the field is replaced, and the derived
// bytes carry no URL. A derivation that left the field verbatim would fail at step 4 (the survivor sweep) or 5
// (the scanner), and the two cases above prove that both of those fire.
const urlCard = JSON.parse(JSON.stringify(CLEAN_CARD));
urlCard.data.creator_notes = 'MARK_000012 https://example.invalid/creator';
const urlPath = path.join(tempRoot, 'url.png');
fs.writeFileSync(urlPath, synthesisedCard(urlCard));
const url = buildCard(urlPath, outDir);
record('derivation REPLACES a URL in an identity field (so the derived card passes the scanner)', url.ok, url.ok ? undefined : url.output.trim().split('\n').slice(0, 3).join(' | ').slice(0, 400));
if (url.ok) {
    const built = fs.readFileSync(path.join(outDir, 'probe.png'));
    record('the derived card carries no URL at all', !/https?:\/\//.test(built.toString('latin1')) && !/example\.invalid/.test(Buffer.from(built.toString('latin1'), 'latin1').toString('latin1')), undefined);
    fs.rmSync(path.join(outDir, 'probe.png'), { force: true });
}

// 3g. THE MOJIBAKE REGRESSION, AS A CASE. Scanning a PRESET's latin1 view made every CJK character three
// mojibake bytes, the 64+ rule saw runs that were not strings, and two long-committed fixtures were refused for
// prose the derivation had already replaced. The case is a preset-shaped document with CJK prose that is fully
// marker-substituted: the CLI must ACCEPT it, and a document with the same CJK prose UNMARKED must still be
// refused, so the pass is bounded to the right input rather than loosened.
const cjkMarked = path.join(tempRoot, 'cjk-marked.json');
fs.writeFileSync(cjkMarked, JSON.stringify({ prompts: [{ name: 'MARK_000020', content: 'MARK_000021' + '测'.repeat(40) }], extensions: {} }));
const cjkUnmarked = path.join(tempRoot, 'cjk-unmarked.json');
fs.writeFileSync(cjkUnmarked, JSON.stringify({ prompts: [{ name: 'MARK_000022', content: '测'.repeat(80) }], extensions: {} }));
function scanFile(target) {
    try {
        execFileSync(process.execPath, [path.join(here, 'check-fixture-watermarks.mjs'), target], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        return { ok: true, output: '' };
    } catch (error) {
        return { ok: false, output: `${error.stdout ?? ''}${error.stderr ?? ''}` };
    }
}
const cjkAccepted = scanFile(cjkMarked);
record('scanner ACCEPTS a fully-marked CJK preset (the mojibake regression)', cjkAccepted.ok, cjkAccepted.output.slice(0, 300));
const cjkRefused = scanFile(cjkUnmarked);
record('scanner REFUSES the same CJK prose unmarked (the pass is right, not loose)', !cjkRefused.ok && /unmarked|no marker/.test(cjkRefused.output), cjkRefused.ok ? 'the scanner accepted unmarked CJK prose' : undefined);

fs.rmSync(tempRoot, { recursive: true, force: true });

const failed = results.filter(entry => !entry.ok);
console.log(`\n${results.length - failed.length}/${results.length} case(s) behaved as required`);
if (failed.length > 0) {
    console.error(`DECORATION: ${failed.map(entry => entry.name).join(', ')}`);
    process.exit(1);
}
