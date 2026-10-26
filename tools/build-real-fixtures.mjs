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
import { MARKER_BYTES, PROSE_THRESHOLD_CHARS, profilePreset, profileCard } from './real-fixture-profile.mjs';

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

const buildCard = ({ name, file }, outDir) => {
    const buffer = fs.readFileSync(file);
    const profile = profileCard(buffer);
    if (!profile || typeof profile.jsonBytes !== 'number') refuse(`${file}: no chara chunk to profile`);
    refuse(`card fixtures are not built yet: ${path.basename(file)} profiles as ${profile.jsonBytes} JSON bytes and needs the chunk re-encoder, which is the next commit rather than a silent skip`);
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
