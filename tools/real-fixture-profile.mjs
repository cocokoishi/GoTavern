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

// --- the CARD's identity fields, in one place --------------------------------------------------
//
// The brief names them: "`name`, `creator`, `creator_notes`, `tags`, alternate greetings,
// `character_book.name`, entry `comment`/`content`/`keys`, and the `extensions` label subtrees that the preset
// work already found". The preset work's own lesson is that a predicate written from FIELD NAMES misses fields
// a SCAN finds (`detect_regexes`, `groups[].{enable,disable}_group` were found by scanning the generated
// fixture for the original names), so this list is the named set and the generator ADDITIONALLY sweeps the whole
// document for the original strings afterwards: a field this list does not name is still refused by the sweep
// rather than shipped.
//
// PATHS ARE RELATIVE TO THE v3 `data` OBJECT, with `_root` for the top level (a V3 card carries a same-value
// copy of name/description/first_mes there, and a reader may take either). `*` is an array index or an object
// key. `..*` is "any key at this depth" and is used where the pinned shape nests an object the list cannot name
// ahead of time (`data.groups[].options[].{enable,disable}` is a map of option lists).
//
// `why` is written into the generator's manifest, because "why is THIS field replaced" is the question a
// reviewer asks about a list like this, and a field replaced with no reason is how a fixture grows a hole.
export const CARD_IDENTITY_FIELDS = [
    { path: '_root.name', why: 'the character name, duplicated at the v3 root' },
    { path: '_root.description', why: 'prose, duplicated at the v3 root' },
    { path: '_root.personality', why: 'prose, duplicated at the v3 root' },
    { path: '_root.scenario', why: 'prose, duplicated at the v3 root' },
    { path: '_root.first_mes', why: 'prose, duplicated at the v3 root' },
    { path: '_root.mes_example', why: 'prose, duplicated at the v3 root' },
    { path: '_root.creatorcomment', why: 'the V1 author note at the root' },
    { path: '_root.create_date', why: 'a build stamp that dates the card to its author' },
    { path: 'name', why: 'the character name' },
    { path: 'creator', why: 'the author handle' },
    { path: 'creator_notes', why: 'the author note, which carries platforms, links and handles' },
    { path: 'tags.*', why: 'tags name the source, the fandom and often the author' },
    { path: 'character_version', why: 'versions are the author\'s own build label' },
    { path: 'description', why: 'prose' },
    { path: 'personality', why: 'prose' },
    { path: 'scenario', why: 'prose' },
    { path: 'first_mes', why: 'prose' },
    { path: 'mes_example', why: 'prose' },
    { path: 'post_history_instructions', why: 'prose' },
    { path: 'system_prompt', why: 'prose' },
    { path: 'alternate_greetings.*', why: 'prose, one entire greeting per entry' },
    { path: 'group_only_greetings.*', why: 'prose' },
    { path: 'character_book.name', why: 'the lorebook title, usually the character or the author\'s project' },
    { path: 'character_book.description', why: 'prose' },
    { path: 'character_book.entries.*.comment', why: 'an entry title, written by the author' },
    { path: 'character_book.entries.*.content', why: 'prose, the largest prose population in a real card' },
    { path: 'character_book.entries.*.keys.*', why: 'trigger keys quote the character and the author\'s world' },
    { path: 'character_book.entries.*.secondary_keys.*', why: 'the same, secondary' },
    { path: 'character_book.entries.*.name', why: 'a V2 entry may carry a name' },
    // The label subtrees the PRESET work found, transplanted: both real cards carry
    // `data.extensions.tavern_helper`, and a helper script's own settings repeat the author's labels.
    { path: 'extensions.tavern_helper.scripts.*.name', why: 'a helper script name: the preset work\'s name layer' },
    { path: 'extensions.tavern_helper.scripts.*.info', why: 'the helper script\'s description field' },
    // THE SCRIPT ID. A UUID is structure the helper keys on (`getScriptTrees` matches by id), so it is
    // replaced byte-length-preserving rather than dropped; it is also an identity field the sweep found, because
    // a UUID is unique to the author's build and a reader can search it.
    { path: 'extensions.tavern_helper.scripts.*.id', why: 'a UUID unique to the author\'s build, found by the survivor sweep' },
    { path: 'extensions.tavern_helper.scripts.*.button.buttons.*.name', why: 'button.buttons[].name, the label layer the preset work found' },
    { path: 'extensions.tavern_helper.scripts.*.data.title', why: 'data.title, the label layer the preset work found' },
    { path: 'extensions.tavern_helper.scripts.*.data.script_button_name', why: 'data.script_button_name, same layer' },
    { path: 'extensions.tavern_helper.scripts.*.data.summary.generation.detect_regexes.*', why: 'the deep label layer the preset work found by SCANNING, not by naming' },
    { path: 'extensions.tavern_helper.scripts.*.data.groups.*.options.*..*.*', why: 'the deep label layer: data.groups[].options[].{enable,disable}[] option labels' },
    { path: 'extensions.tavern_helper.scripts.*.data.groups.*.enable_group.*', why: 'the deep label layer: data.groups[].enable_group[]' },
    { path: 'extensions.tavern_helper.scripts.*.data.groups.*.disable_group.*', why: 'the deep label layer: data.groups[].disable_group[]' },
    { path: 'extensions.tavern_helper.scripts.*.content', why: 'a helper script body: kept valid JavaScript at the same byte length' },
    { path: 'extensions.regex_scripts.*.scriptName', why: 'a regex script name' },
    { path: 'extensions.regex_scripts.*.replaceString', why: 'the regex replacement text, written by the author' },
    { path: 'extensions.regex_scripts.*.findRegex', why: 'a find pattern that quotes the author\'s names and prose' },
    // THE FIELDS THE SWEEP FOUND, which the named list did not. This is exactly the preset work's lesson: a
    // predicate written from the brief's field names misses the fields that carry identity in practice, and only
    // scanning the derived bytes for the original strings finds them. Measured on the two audited cards:
    //   * `extensions.world` is the LINKED WORLD BOOK's name -- card A's is `[REDACTED_WORLD_BOOK]`,
    //     the card's own title, and it survived into the derived bytes;
    //   * `extensions.odysseia_trace` is an encrypted trace blob (both cards carry one, `{v,kid,nonce,
    //     ciphertext}`) whose ciphertext is opaque but whose presence names the tool the author used. It is
    //     replaced whole, byte-length-preserving, because a ciphertext that decrypts to the author's data is
    //     the worst possible thing to ship;
    //   * a regex script's `id` EMBEDS THE AUTHOR'S HANDLE: card B's first script id is
    //     `[REDACTED_HANDLE]`. An id is structure the frontend keys on, so it is replaced with a
    //     marker of the same length rather than dropped.
    { path: 'extensions.world', why: 'the linked world book\'s name, which is the card\'s own title' },
    { path: 'extensions.depth_prompt.prompt', why: 'prose, the author-notebook depth prompt' },
    { path: 'extensions.odysseia_trace.*', why: 'an encrypted trace blob: a ciphertext of the author\'s data' },
    { path: 'extensions.regex_scripts.*.id', why: 'measured: card B\'s script id is `[REDACTED_HANDLE]`, a handle' },
];

/** Does `path` (a `data`-relative dotted path, `_root` for the top level) match an identity pattern? */
export function cardIdentityFieldFor(path) {
    // BOTH SPELLINGS ARE ACCEPTED, and that is deliberate rather than convenient: the list is `data`-relative
    // (`name`), the walker naturally carries `data` as its first segment (`data.name`), and the CARD's chunk
    // JSON is `{spec, spec_version, name, ..., data: {name, ...}}` -- so `name` at the ROOT is a real field, and
    // a function that silently accepted `data.name` as `name` would replace the root copy while believing it
    // had replaced the `data` copy (or not at all). The rule: an `_root.` prefix addresses the root, ANY OTHER
    // path addresses `data`, and a bare `name` therefore means `data.name` (the first version of this function
    // returned null for every `data.`-prefixed path, so a 19 MB card would have shipped with the user's name in
    // it -- the self-test caught it before the build, which is the only reason it is a comment and not a leak).
    //
    // THE `_root.` FORM IS TRIED TWICE, AND THE SECOND TRY IS A MEASURED FIX. A non-card chunk's JSON (measured:
    // `trAc`, `{ciphertext,kid,nonce,v}`) is walked rooted at `_root.extensions.odysseia_trace`, so its paths are
    // `_root.extensions.odysseia_trace.ciphertext`; the list names `extensions.odysseia_trace.*`, which is a
    // `data`-relative pattern. The first version therefore matched NOTHING for that chunk, the chunk was written
    // back with its original bytes, and the survivor sweep named the author's ciphertext -- which is exactly the
    // leak the sweep exists to catch. So `_root.extensions.…` is ALSO matched against the `extensions.…` patterns,
    // and `_root.name` stays matched only by the explicit `_root.name` entry so the root copy cannot silently
    // fall through to the `data` rule.
    const candidates = [];
    if (path.startsWith('_root.extensions.')) {
        candidates.push(path, path.slice('_root.'.length));
    } else if (path.startsWith('_root.')) {
        candidates.push(path);
    } else {
        candidates.push(path.replace(/^data\./, ''));
    }
    for (const candidate of candidates) {
        for (const field of CARD_IDENTITY_FIELDS) {
            if (cardPathMatches(field.path, candidate)) return field;
        }
    }
    return null;
}

function cardPathMatches(pattern, path) {
    const patternParts = pattern.split('.');
    const pathParts = path.split('.');
    // A NON-FIELD PATH IS NEVER A FIELD. `keys.length`, `tags.length` and every `.constructor`-style path are
    // traversals a document walker does not take, but a hand-written path passed in from outside could name
    // one, and replacing the number stored at `keys.length` would not be replacing the keys. Named ONCE here
    // rather than in every caller.
    if (INHERITED_ACCESSORS.has(pathParts[pathParts.length - 1])) return false;
    // THE GREEDY SEGMENT IS `..*`, WHICH `split('.')` PRODUCES AS AN EMPTY PART FOLLOWED BY `*`. Written
    // `groups.*.options.*..*.*` the pattern splits to `[...,'options','*','','*','*']`, so the greedy point is
    // at index `i` where `parts[i] === ''` and `parts[i+1] === '*'`; `indexOf('..*')` never matches (the first
    // version used it, so the greedy rule matched nothing and the self-test reported "the rule is dead" -- which
    // is exactly the report a dead rule should produce). `..*` means ONE OR MORE path segments.
    const emptyAt = patternParts.findIndex((part, index) => part === '' && patternParts[index + 1] === '*');
    if (emptyAt >= 0) {
        const head = patternParts.slice(0, emptyAt);
        const tail = patternParts.slice(emptyAt + 2);
        if (pathParts.length < head.length + tail.length + 1) return false;
        for (let index = 0; index < head.length; index += 1) {
            if (head[index] !== '*' && head[index] !== pathParts[index]) return false;
        }
        for (let index = 0; index < tail.length; index += 1) {
            const patternPart = tail[tail.length - 1 - index];
            const pathPart = pathParts[pathParts.length - 1 - index];
            if (patternPart !== '*' && patternPart !== pathPart) return false;
        }
        return true;
    }
    if (patternParts.length !== pathParts.length) return false;
    return patternParts.every((part, index) => part === '*' || part === pathParts[index]);
}

// Path segments that are OBJECT INTRINSICS, never a field a card carries. `keys.length` is the number of keys,
// and replacing it would either throw or produce a document whose array length disagrees with its contents.
const INHERITED_ACCESSORS = new Set(['length', 'constructor', '__proto__', 'prototype', 'toString', 'valueOf']);

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

// --- ONE LOGICAL OBJECT, MANY REPRESENTATIONS ---------------------------------------------------
//
// A card container describes ONE character through SEVERAL carriers, and a derivation that gives each carrier its
// own replacement manufactures a container that contradicts itself about identity. Measured on the committed
// derivation before this rule existed (`GoTavern Lane CI` 40446833206):
//
//     chara: data.name="MARK_000466…" root.name="MARK_000464…"
//     ccv3:  data.name="MARK_002794…" root.name="MARK_000792…"
//
// Two different names for one character in one file, while pinned answers `ccv3`
// (`src/character-card-parser.js:64-74`) and pinned's own writer emits both carriers from ONE document
// (`:28-39`, `ccv3` = `JSON.parse` of the data given for `chara`) -- so that file was not a card pinned can produce.
//
// THE REPRESENTATIONS, enumerated from the container rather than from the identity list:
//   1. the `chara` and `ccv3` tEXt documents (must be ONE document; the writer rule above);
//   2. inside a document, the V1 root copies (`name`, `description`, … at the root) beside their V2 `data` twins --
//      pinned's `readFromV2` OVERWRITES the root from `data` and only WARNS on a mismatch
//      (`src/endpoints/characters.js:525-552`, the warning at `:548-550`), so both carriers exist and either may be
//      what a reader answers;
//   3. an ancillary chunk whose JSON mirrors an `extensions` subtree -- measured: `trAc` =
//      `{ciphertext,kid,nonce,v}`, exactly the keys of `data.extensions.odysseia_trace`.
//
// THE RULE THIS MODULE COMPUTES: the derivation must preserve the EQUALITY PARTITION of identity values across every
// carrier. Equal in the source -> equal in the derivation (one logical object, one representation); different in the
// source -> still different (the fixture may not invent an identity either). `cardIdentityOccurrence`s and
// `cardIdentityRelationViolations` below are that rule, and `tools/build-real-fixtures.mjs` refuses on them.
export const CARD_MIRRORED_CHUNKS = [
    { extension: 'odysseia_trace', keys: ['ciphertext', 'kid', 'nonce', 'v'] },
];

// THE SHORT TIER CANNOT CARRY DIFFERENCE, and this is where that limit is named rather than silently tolerated: a
// one-byte identity field has exactly one representable marker (`#`, see the generator's tier rules), so two
// DIFFERENT one-byte values necessarily collide. Equality is still preserved (same value -> same marker); only
// difference is not. Occurrences in this tier are reported separately, never counted as a violation.
const SHORTEST_TIER_BYTES = 1;

const identityWalk = (value, pathParts, visit) => {
    if (typeof value === 'string') {
        const field = cardIdentityFieldFor(pathParts.join('.'));
        if (field) visit({ path: pathParts.join('.'), value, field: field.path });
        return;
    }
    if (Array.isArray(value)) {
        value.forEach((entry, index) => identityWalk(entry, [...pathParts, String(index)], visit));
        return;
    }
    if (value && typeof value === 'object') {
        for (const key of Object.keys(value)) identityWalk(value[key], [...pathParts, key], visit);
    }
};

/**
 * Every identity-bearing string the container carries, WITH ITS CARRIER, so two carriers of one value can be
 * compared.
 *
 * `documents` is an ordered list `[{carrier, document}]`; a card document is rooted the way the GENERATOR roots it
 * (`data.<field>` for the V2 subtree, `_root.<field>` for everything at the top), so a path means the same thing in
 * the source and in the derivation and the two occurrence lists are positionally comparable.
 *
 * `chunks` is an ordered list `[{carrier, document}]` for ancillary carriers; a chunk whose key set equals a
 * `CARD_MIRRORED_CHUNKS` entry is walked rooted at that extension (mirroring the generator), any other chunk at
 * `_root`.
 */
export function cardIdentityOccurrences({ documents = [], chunks = [] } = {}) {
    const occurrences = [];
    for (const { carrier, document } of documents) {
        for (const key of Object.keys(document ?? {})) {
            const pathParts = key === 'data' ? ['data'] : ['_root', key];
            identityWalk(document[key], pathParts, entry => occurrences.push({ carrier, ...entry }));
        }
    }
    for (const { carrier, document } of chunks) {
        const mirror = CARD_MIRRORED_CHUNKS.find(entry => Object.prototype.hasOwnProperty.call(document ?? {}, entry.keys[0])
            && entry.keys.every(key => Object.prototype.hasOwnProperty.call(document, key))
            && Object.keys(document ?? {}).length === entry.keys.length);
        const rootParts = mirror ? ['_root', 'extensions', mirror.extension] : ['_root'];
        for (const key of Object.keys(document ?? {})) {
            identityWalk(document[key], [...rootParts, key], entry => occurrences.push({ carrier, ...entry }));
        }
    }
    return occurrences;
}

/**
 * Compare the SOURCE container's identity occurrence list with the DERIVED one, position by position.
 *
 * Returns `{ violations, equalityPairs, differencePairs, shortTierPairs }`. A violation is a pair of positions
 * where the source values agreed and the derived values do not (an object split into two identities) or where the
 * source values differed and the derived values agree (an identity invented by the derivation). Both are refused by
 * the generator: the first is the Q21 defect, the second is its mirror image.
 */
export function cardIdentityRelationViolations(sourceOccurrences, derivedOccurrences) {
    const violations = [];
    const shortTierPairs = [];
    let equalityPairs = 0;
    let differencePairs = 0;
    if (sourceOccurrences.length !== derivedOccurrences.length) {
        return {
            violations: [{
                kind: 'shape',
                detail: `the source has ${sourceOccurrences.length} identity occurrence(s) and the derived container has ${derivedOccurrences.length}, so the two carriers cannot be compared position by position`,
            }],
            equalityPairs,
            differencePairs,
            shortTierPairs,
        };
    }
    for (let left = 0; left < sourceOccurrences.length; left += 1) {
        for (let right = left + 1; right < sourceOccurrences.length; right += 1) {
            const sourceEqual = sourceOccurrences[left].value === sourceOccurrences[right].value;
            const derivedEqual = derivedOccurrences[left].value === derivedOccurrences[right].value;
            if (sourceEqual === derivedEqual) {
                if (sourceEqual) equalityPairs += 1;
                else differencePairs += 1;
                continue;
            }
            const pair = {
                sourceEqual,
                derivedEqual,
                left: { carrier: sourceOccurrences[left].carrier, path: sourceOccurrences[left].path },
                right: { carrier: sourceOccurrences[right].carrier, path: sourceOccurrences[right].path },
                sourceValues: [sourceOccurrences[left].value, sourceOccurrences[right].value].map(value => value.slice(0, 24)),
            };
            // A DIFFERENT one-byte value cannot be represented as different, so its collision is recorded against
            // the short tier instead of being called a derivation defect.
            if (!sourceEqual && derivedEqual
                && Buffer.byteLength(sourceOccurrences[left].value) <= SHORTEST_TIER_BYTES
                && Buffer.byteLength(sourceOccurrences[right].value) <= SHORTEST_TIER_BYTES) {
                shortTierPairs.push(pair);
                continue;
            }
            violations.push({
                kind: sourceEqual ? 'split-identity' : 'invented-identity',
                detail: sourceEqual
                    ? 'two carriers of ONE value were given different replacements, so the derived container says two different things about one identity'
                    : 'two DIFFERENT values were given the same replacement, so the derived container claims an identity the source did not have',
                ...pair,
            });
        }
    }
    return { violations, equalityPairs, differencePairs, shortTierPairs };
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
