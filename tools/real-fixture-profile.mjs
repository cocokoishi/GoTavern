#!/usr/bin/env node
// real-fixture-profile: the ONE definition of "what a real preset/card fixture must preserve".
//
// Every number the desensitising generator refuses on, and every number the manifest test compares, is
// computed here and nowhere else (differential doctrine 10: extract a helper only when two real callers
// share semantics). The generator imports it; the manifest check imports it; a human reads its output.
//
// It reads its inputs and writes NOTHING. Sources are real user artifacts and are read-only inputs to
// qualification (AGENTS.md rule 51): this file must never gain a write path, and it takes paths as
// arguments so no host-derived path is committed.
//
// Usage:
//   node tools/real-fixture-profile.mjs <preset.json> [<preset.json> ...] [<card.png> ...]
//   node tools/real-fixture-profile.mjs --preset <path> --card <path> ...
// Output: one JSON object per input on stdout, then a summary object with provenance (sha256 + bytes).

import { createHash } from 'node:crypto';
import fs from 'node:fs';

// The marker vocabulary. Length matters: a string shorter than the marker cannot carry marker + filler,
// so the generator handles short and long strings differently and this module reports BOTH populations.
export const MARKER_PREFIX = 'MARK_';
export const MARKER_EXAMPLE = 'MARK_000000';
export const MARKER_BYTES = Buffer.byteLength(MARKER_EXAMPLE);
// AGENTS.md rule 51 / the lane brief: any string longer than this must carry a marker or the generator
// refuses to write. It is the prose threshold, not the marker threshold.
export const PROSE_THRESHOLD_CHARS = 64;

const sha256 = buffer => createHash('sha256').update(buffer).digest('hex');

// A deterministic projection of prompt_order: group ids in order, and for each group the ordered list of
// (identifier, enabled) rows. Identifiers only -- no prose -- so the digest is stable across desensitising
// and can be compared between the original and the fixture.
export const promptOrderProjection = order => (Array.isArray(order) ? order : []).map(group => ({
    id: group?.id ?? null,
    character_id: group?.character_id ?? null,
    rows: (Array.isArray(group?.order) ? group.order : []).map(row => ({
        identifier: row?.identifier ?? null,
        enabled: row?.enabled === true,
    })),
}));

// The enabled bitmap: the ordered sequence of every row's enabled flag across every group, which is what
// PromptManager.js:1516-1541 actually consults (it walks order rows and includes iff row.enabled).
export const enabledBitmap = order => (Array.isArray(order) ? order : [])
    .flatMap(group => (Array.isArray(group?.order) ? group.order : []).map(row => (row?.enabled === true ? '1' : '0')))
    .join('');

const walkStrings = (value, visit) => {
    if (typeof value === 'string') { visit(value); return; }
    if (Array.isArray(value)) { for (const item of value) walkStrings(item, visit); return; }
    if (value && typeof value === 'object') { for (const key of Object.keys(value)) walkStrings(value[key], visit); }
};

export function stringCensus(root) {
    const census = { strings: 0, bytes: 0, shorterThanMarker: 0, proseOverThreshold: 0, markerLike: 0 };
    walkStrings(root, value => {
        census.strings += 1;
        const bytes = Buffer.byteLength(value);
        census.bytes += bytes;
        if (bytes < MARKER_BYTES) census.shorterThanMarker += 1;
        if (value.length > PROSE_THRESHOLD_CHARS) census.proseOverThreshold += 1;
        if (value.startsWith(MARKER_PREFIX)) census.markerLike += 1;
    });
    return census;
}

export function profilePreset(text) {
    const root = JSON.parse(text);
    const prompts = Array.isArray(root.prompts) ? root.prompts : [];
    const order = promptOrderProjection(root.prompt_order);
    const identifiers = new Set(prompts.map(prompt => prompt?.identifier).filter(id => typeof id === 'string'));
    const referenced = new Set();
    const rowsEnabledNotInPrompts = [];
    let enabledRows = 0;
    let rowsTotal = 0;
    let enabledRowsPointingAtDisabledPrompt = 0;
    for (const group of order) {
        for (const row of group.rows) {
            rowsTotal += 1;
            if (row.identifier !== null) referenced.add(row.identifier);
            if (!row.enabled) continue;
            enabledRows += 1;
            if (row.identifier !== null && !identifiers.has(row.identifier)) rowsEnabledNotInPrompts.push(row.identifier);
            const prompt = prompts.find(candidate => candidate?.identifier === row.identifier);
            if (prompt && prompt.enabled === false) enabledRowsPointingAtDisabledPrompt += 1;
        }
    }
    const unreachable = [...identifiers].filter(id => !referenced.has(id)).sort();
    const helper = root?.extensions?.tavern_helper;
    const helperScripts = Array.isArray(helper?.scripts) ? helper.scripts : [];
    const regexScripts = Array.isArray(root.extensions?.regex_scripts) ? root.extensions.regex_scripts
        : (Array.isArray(root.regex_scripts) ? root.regex_scripts : []);
    const markers = [...new Set(prompts.map(prompt => prompt?.marker).filter(marker => typeof marker === 'boolean'))].length;
    return {
        kind: 'preset',
        keys: Object.keys(root).length,
        prompts: prompts.length,
        promptOrder: {
            groups: order.length,
            groupIds: order.map(group => group.id),
            rows: rowsTotal,
            enabledRows,
            projectionSha256: sha256(JSON.stringify(order)),
            enabledBitmapSha256: sha256(enabledBitmap(root.prompt_order)),
            enabledBitmap: enabledBitmap(root.prompt_order),
        },
        rowsEnabledWhoseIdentifierIsNotAPrompt: rowsEnabledNotInPrompts.sort(),
        unreferencedPromptIdentifiers: unreachable,
        unreachablePromptCount: unreachable.length,
        enabledRowsPointingAtDisabledPrompt,
        promptsEnabledButUnreferenced: prompts
            .filter(prompt => prompt?.enabled === true && !referenced.has(prompt?.identifier))
            .map(prompt => prompt?.identifier)
            .sort(),
        settings: {
            squash_system_messages: root.squash_system_messages ?? null,
            names_behavior: root.names_behavior ?? null,
            wrap_in_quotes: root.wrap_in_quotes ?? null,
            use_sysprompt: root.use_sysprompt ?? null,
            continue_prefill: root.continue_prefill ?? null,
            openai_max_context: root.openai_max_context ?? null,
            openai_max_tokens: root.openai_max_tokens ?? null,
        },
        markerCount: markers,
        extensions: {
            tavernHelperBytes: helper === undefined ? 0 : Buffer.byteLength(JSON.stringify(helper)),
            tavernHelperScripts: helperScripts.length,
            tavernHelperScriptContentBytes: helperScripts.map(script => Buffer.byteLength(String(script?.content ?? ''))),
            tavernHelperScriptKeys: helperScripts.map(script => Object.keys(script ?? {}).sort()),
            tavernHelperScriptIds: helperScripts.map(script => script?.id ?? null),
            regexScripts: regexScripts.length,
            regexReplaceStringBytes: regexScripts.map(script => Buffer.byteLength(String(script?.replaceString ?? ''))),
            regexPromptOnly: regexScripts.filter(script => script?.promptOnly === true).length,
        },
        strings: stringCensus(root),
    };
}

// --- PNG cards ---------------------------------------------------------------------------------
// A card is a PNG whose tEXt chunks carry base64 JSON (chara = V2, ccv3 = V3). The profile reports every
// chunk so the generator can prove it kept them all: dropping trAc would silently change the reader's
// tolerance surface, and changing an IDAT length would change the file's size class.
export function pngChunks(buffer) {
    const chunks = [];
    let offset = 8; // PNG signature
    while (offset + 8 <= buffer.length) {
        const length = buffer.readUInt32BE(offset);
        const type = buffer.toString('ascii', offset + 4, offset + 8);
        chunks.push({ type, length, dataStart: offset + 8 });
        offset += 12 + length;
        if (type === 'IEND') break;
    }
    return chunks;
}

export function profileCard(buffer) {
    const chunks = pngChunks(buffer);
    const text = {};
    for (const chunk of chunks) {
        if (chunk.type !== 'tEXt') continue;
        const data = buffer.subarray(chunk.dataStart, chunk.dataStart + chunk.length);
        const zero = data.indexOf(0);
        const keyword = data.toString('latin1', 0, zero < 0 ? data.length : zero);
        if (zero < 0) continue;
        const base64 = data.subarray(zero + 1).toString('latin1');
        const jsonBytes = Buffer.from(base64, 'base64');
        const jsonText = jsonBytes.toString('utf8');
        let profile = null;
        let reserialisedBytes = null;
        try {
            const parsed = JSON.parse(jsonText);
            reserialisedBytes = Buffer.byteLength(JSON.stringify(parsed));
            const data2 = parsed?.data ?? {};
            const book = data2?.character_book;
            profile = {
                spec: parsed?.spec ?? null,
                specVersion: parsed?.spec_version ?? null,
                dataKeys: Object.keys(data2).sort(),
                alternateGreetings: Array.isArray(data2?.alternate_greetings) ? data2.alternate_greetings.length : 0,
                characterBookEntries: Array.isArray(book?.entries) ? book.entries.length : 0,
                characterBookContentBytes: Array.isArray(book?.entries)
                    ? book.entries.reduce((total, entry) => total + Buffer.byteLength(String(entry?.content ?? '')), 0) : 0,
                atDepthEntries: Array.isArray(book?.entries) ? book.entries.filter(entry => (entry?.position ?? 0) !== 0).length : 0,
                helperScripts: Array.isArray(data2?.extensions?.tavern_helper?.scripts) ? data2.extensions.tavern_helper.scripts.length : 0,
                helperBytes: data2?.extensions?.tavern_helper === undefined ? 0 : Buffer.byteLength(JSON.stringify(data2.extensions.tavern_helper)),
                helperContentBytes: (Array.isArray(data2?.extensions?.tavern_helper?.scripts) ? data2.extensions.tavern_helper.scripts : [])
                    .map(script => Buffer.byteLength(String(script?.content ?? ''))),
                regexScripts: Array.isArray(data2?.extensions?.regex_scripts) ? data2.extensions.regex_scripts.length : 0,
                strings: stringCensus(parsed),
            };
        } catch (error) {
            profile = { parseError: String(error?.message ?? error).slice(0, 120) };
        }
        text[keyword] = {
            chunkBytes: chunk.length,
            base64Chars: base64.length,
            jsonBytes: jsonBytes.length,
            jsonChars: jsonText.length,
            reserialisedBytes,
            reserialiseDelta: reserialisedBytes === null ? null : reserialisedBytes - jsonBytes.length,
            profile,
        };
    }
    return {
        kind: 'card',
        bytes: buffer.length,
        chunks: chunks.map(chunk => ({ type: chunk.type, length: chunk.length })),
        chunkTypes: chunks.map(chunk => chunk.type),
        text,
        charaEqualsCcv3: text.chara && text.ccv3
            ? text.chara.base64Chars === text.ccv3.base64Chars && text.chara.jsonBytes === text.ccv3.jsonBytes
            : null,
    };
}

export function profileFile(path) {
    const buffer = fs.readFileSync(path);
    const isPng = buffer.length > 8 && buffer.readUInt32BE(0) === 0x89504e47;
    const body = isPng ? profileCard(buffer) : profilePreset(buffer.toString('utf8'));
    return {
        ...body,
        provenance: { name: path.replace(/^.*[\\/]/, ''), bytes: buffer.length, sha256: sha256(buffer) },
    };
}

const main = () => {
    const args = process.argv.slice(2);
    if (args.length === 0) {
        console.error('usage: node tools/real-fixture-profile.mjs <file> [<file> ...]');
        console.error('  .json  -> preset profile      .png -> card profile');
        console.error('  reads only; refuses nothing here (the generator owns the refusals)');
        process.exit(2);
    }
    const profiles = args.map(profileFile);
    for (const profile of profiles) console.log(JSON.stringify(profile));
    console.log(JSON.stringify({
        summary: {
            files: profiles.length,
            presets: profiles.filter(profile => profile.kind === 'preset').length,
            cards: profiles.filter(profile => profile.kind === 'card').length,
            provenance: profiles.map(profile => profile.provenance),
        },
    }));
};

if (process.argv[1] && process.argv[1].endsWith('real-fixture-profile.mjs')) main();
