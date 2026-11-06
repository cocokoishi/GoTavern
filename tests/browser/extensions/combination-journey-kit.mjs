// FIXTURE AND DISK READERS FOR THE COMBINATION JOURNEY.
//
// The journey composes features that each already have a probe (preset semantics, world-info slots, regex,
// Quick Replies, helper variables, group chats, persistence/restart, hand-back) inside ONE session on BOTH
// subjects. This kit stages only what can be staged BEFORE the server boots: the journey card (with a
// CHARACTER-SCOPED regex script in its V3 extension payload), the complex world book + its persisted
// selection, the pinned frontend's Quick Reply storage shape (not used: QR is created through the extension's
// own API in the page), and the group fixture. Everything that must be created through the frontend
// afterwards (preset scenario, variables through the helper bridge, Quick Reply create+execute) is driven by
// the probe, not written by this file.
//
// AGENTS 56: the card is a SYNTHETIC Spec-V3 card carrying the image chunks of the committed desensitised
// fixture; no user prose is copied. The card's name is a marker so the roster and the chat directory are
// attributable, and its `data.extensions.regex_scripts` is the character-scoped regex the journey needs.

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

import { imageChunksOnly } from './helper-vars-kit.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const browserDirectory = path.dirname(here);
export const repoRoot = path.resolve(browserDirectory, '..', '..');

export const CARD = {
    fileName: 'comb-journey-card.png',
    chatDirectory: 'comb-journey-card',
    name: 'COMB_JOURNEY_CARD',
    description: 'COMB_CARD_DESCRIPTION The keeper of the combination gate.',
    personality: 'COMB_CARD_PERSONALITY patient, exact, quietly amused.',
    scenario: 'COMB_CARD_SCENARIO A gate between the map room and the orchard.',
    firstMessage: 'COMB_CARD_GREETING The keeper looks up from the ledger.',
    regexFind: 'COMB_RAW_REPLY',
    regexReplace: 'COMB_REGEX_OK',
};

export const JOURNEY = {
    worldName: 'comb-journey-lore',
    // Two entries at DIFFERENT POSITIONS from the world-info kit's own three-slot document (before/after/
    // depth) so the request proves placement, not merely presence. The kit's document carries all three and
    // its MARKERS are re-exported by value here to keep the assertions in ONE place.
    groupId: 'g-natural-2',
    qrSet: 'comb-journey-set',
    qrLabel: 'COMB_QR',
    qrInjection: 'COMB_QR_INJECTED_MARKER',
    helperChatVar: 'comb_chat_var',
    helperGlobalVar: 'comb_global_var',
    helperCharacterVar: 'comb_character_var',
};

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
        let c = n;
        for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
    }
    return table;
})();

function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type, payload) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(payload.length, 0);
    const typeBytes = Buffer.from(type, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, payload])), 0);
    return Buffer.concat([length, typeBytes, payload, crc]);
}

function pngTextChunk(keyword, value) {
    return pngChunk('tEXt', Buffer.concat([Buffer.from(keyword, 'latin1'), Buffer.from([0]), Buffer.from(value, 'latin1')]));
}

const digest = bytes => createHash('sha256').update(bytes).digest('hex');

// THE CARD'S EMBEDDED LOREBOOK IS OPTIONAL AND OFF BY DEFAULT, so every existing leg stages byte-identical bytes.
// For the E03+E04 profile the payload comes from `e03e04-profile-kit.mjs` (`buildBooks().cardEmbedded.characterBook`);
// this kit owns the PNG staging (the `tEXt` chunks), so it embeds the payload into `data.character_book` in BOTH the
// `chara` and `ccv3` chunks. `data.extensions.world` is deliberately LEFT EMPTY: the embedded book is activated by the
// product's own import path (`checkEmbeddedWorld` -> `importEmbeddedWorldInfo`, world-info.js:5691-5760), which sets
// the character's world; pre-binding it here would fake that path.
export function journeyCardDocument({ characterBook = null } = {}) {
    const data = {
        name: CARD.name,
        description: CARD.description,
        personality: CARD.personality,
        scenario: CARD.scenario,
        first_mes: CARD.firstMessage,
        mes_example: '',
        creator_notes: 'synthetic combination-journey card (no user prose)',
        system_prompt: '',
        post_history_instructions: '',
        alternate_greetings: [],
        tags: ['combination-journey'],
        creator: '',
        character_version: '',
        extensions: {
            chat: 'comb-journey-greeting',
            talkativeness: '0.5',
            fav: false,
            world: '',
            // CHARACTER-SCOPED REGEX, stored where the pinned frontend reads it: a character's regex scripts
            // live in the card's `data.extensions.regex_scripts` and are merged into the regex extension's
            // script list for that character. placement 2 = AI_OUTPUT, so the rule transforms the model's
            // reply BEFORE it is stored, which is why the transformed text is BOTH what the page shows and
            // what the NEXT request carries as history.
            regex_scripts: [{
                id: 'comb-journey-regex',
                scriptName: 'COMB journey output rewrite',
                findRegex: CARD.regexFind,
                replaceString: CARD.regexReplace,
                trimStrings: [],
                placement: [2],
                disabled: false,
                markdownOnly: false,
                promptOnly: false,
                runOnEdit: false,
                substituteRegex: 0,
                minDepth: null,
                maxDepth: null,
            }],
        },
        group_only_greetings: [],
    };
    if (characterBook) data.character_book = characterBook;
    return { spec: 'chara_card_v3', spec_version: '3.0', name: data.name, ...data, data };
}

export async function stageJourneyCard(dataRoot, { characterBook = null } = {}) {
    const fixture = await fs.readFile(path.join(browserDirectory, 'fixtures', 'real', 'card-a.png'));
    const encoded = Buffer.from(JSON.stringify(journeyCardDocument({ characterBook })), 'utf8').toString('base64');
    const chunks = imageChunksOnly(fixture);
    const png = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunks[0],
        pngTextChunk('chara', encoded),
        pngTextChunk('ccv3', encoded),
        ...chunks.slice(1),
    ]);
    const directory = path.join(dataRoot, 'default-user', 'characters');
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, CARD.fileName), png);
    return {
        file: CARD.fileName,
        chatDirectory: CARD.chatDirectory,
        sha256: digest(png),
        byteLength: png.length,
        regex: { find: CARD.regexFind, replace: CARD.regexReplace, placement: [2] },
        characterBook: characterBook
            ? {
                name: String(characterBook.name ?? ''),
                entries: Array.isArray(characterBook.entries) ? characterBook.entries.length : 0,
                sha256: digest(Buffer.from(canonicalJson(characterBook), 'utf8')),
                embeddedIn: ['chara', 'ccv3'],
            }
            : null,
        derivedFrom: 'tests/browser/fixtures/real/card-a.png (image chunks only)',
    };
}

/**
 * Canonical JSON for the payload digest (object keys sorted, arrays in order). Kept local to this kit so the card
 * fixture's provenance does not depend on the profile kit's serialiser; the two agree by construction on the same
 * payload, and the probe records the profile kit's digest of the same object so a disagreement is visible.
 */
function canonicalJson(value) {
    const normalise = item => {
        if (Array.isArray(item)) return item.map(normalise);
        if (item && typeof item === 'object') {
            const sorted = {};
            for (const key of Object.keys(item).sort()) sorted[key] = normalise(item[key]);
            return sorted;
        }
        return item;
    };
    return JSON.stringify(normalise(value));
}

/** Stage the complex world book and the persisted selection BEFORE the page reads its settings. */
export async function stageJourneyWorldBook(dataRoot) {
    const slots = await import('../worldinfo-slots-kit.mjs');
    const book = await slots.stageWorldBook(dataRoot);
    const selection = await slots.stageSelection(dataRoot);
    return { book, selection, markers: slots.MARKERS };
}

/** The group fixture seeds its own config + three member cards + worlds + groups; call BEFORE boot. */
export async function stageJourneyGroups(dataRoot) {
    const groups = await import('../group-chat-fixture.mjs');
    const seeded = await groups.seedGroupChatTree(dataRoot);
    return { seeded, groupId: JOURNEY.groupId, groupName: (groups.GROUPS.find(entry => entry.id === JOURNEY.groupId) ?? {}).name ?? null, members: groups.MEMBERS, markers: groups.MARKERS };
}

// ---------------------------------------------------------------------------------------------------------
// DISK READERS. The journey's disk claim is the chat file the product wrote; nothing here parses a chat in
// order to define correctness (that is the pinned leg's capture). Volatile fields are listed, not hidden:
// `send_date`, `chat_metadata.integrity`, `chat_metadata.chat_id` and per-message `extra` timestamps differ
// by construction between two runs and are EXCLUDED by name in the comparator, with the reason recorded.
// ---------------------------------------------------------------------------------------------------------

/**
 * Read every `.jsonl` chat file under one user chat directory, keyed by its path relative to `default-user`.
 * Shared by character chats (`chats/...`) and group chats (`group chats/...`), whose layout is otherwise identical
 * (a header line carrying `chat_metadata`, then one message per line).
 */
async function readChatTree(dataRoot, directoryName) {
    const root = path.join(dataRoot, 'default-user', directoryName);
    const files = {};
    const walk = async directory => {
        for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch(() => [])) {
            const full = path.join(directory, entry.name);
            if (entry.isDirectory()) {
                await walk(full);
                continue;
            }
            if (!entry.name.endsWith('.jsonl')) continue;
            const relative = path.relative(path.join(dataRoot, 'default-user'), full).split(path.sep).join('/');
            const bytes = await fs.readFile(full);
            const lines = bytes.toString('utf8').split('\n').filter(Boolean);
            const messages = [];
            let metadata = null;
            for (const line of lines) {
                try {
                    const parsed = JSON.parse(line);
                    if (parsed && typeof parsed === 'object' && parsed.chat_metadata) metadata = parsed.chat_metadata;
                    if (parsed && typeof parsed === 'object' && typeof parsed.mes === 'string') messages.push(parsed);
                } catch {
                    // a line that does not parse is recorded as a count, never silently skipped from the count
                    messages.push({ __unparsable: true });
                }
            }
            files[relative] = {
                bytes: bytes.length,
                sha256: digest(bytes),
                lineCount: lines.length,
                messageCount: messages.length,
                metadata,
                messages: messages.map(message => ({
                    name: message.name ?? null,
                    is_user: message.is_user === true,
                    mes: String(message.mes ?? ''),
                    swipes: Array.isArray(message.swipes) ? message.swipes.map(String) : null,
                    swipe_id: message.swipe_id ?? null,
                    hasExtra: message.extra !== undefined,
                    branches: Array.isArray(message?.extra?.branches) ? message.extra.branches.map(String) : null,
                })),
            };
        }
    };
    await walk(root);
    return files;
}

export async function readChatFiles(dataRoot) {
    return readChatTree(dataRoot, 'chats');
}

/**
 * GROUP CHATS LIVE IN THEIR OWN USER DIRECTORY (pinned `USER_DIRECTORY_TEMPLATE.groupChats = 'group chats'`,
 * constants.js:16-25; the save route writes `<user>/group chats/<id>.jsonl`, src/endpoints/chats.js:922-947, and
 * GoTavern mirrors that path in internal/startup/storage.go:68). `readChatFiles` walks only `<user>/chats`, so a
 * group turn's persisted file is INVISIBLE to it -- dispatch 42182251438's `filesCarrying: []` was this reader-scope
 * defect, not a failure to persist (the product's `saveChatConditional` had already reported `{ok:true}` through
 * `saveGroupChat` -> POST /api/chats/group/save). Callers that assert a group-chat effect read THIS directory.
 */
export async function readGroupChatFiles(dataRoot) {
    return readChatTree(dataRoot, 'group chats');
}

export function chatCarrying(files, marker) {
    return Object.entries(files)
        .filter(([, file]) => file.messages.some(message => String(message.mes ?? '').includes(marker)))
        .map(([name]) => name)
        .sort();
}

export function chatProjection(files) {
    // VOLATILE EXCLUSIONS, by name and with the reason recorded once here:
    //   send_date / create_date / integrity / chat_id  -- clocks and per-run UUIDs a second run cannot repeat;
    //   extra (branches aside)                         -- carries `token_count` and per-generation ids;
    //   the metadata member itself                     -- contains the per-run integrity/chat_id.
    return Object.fromEntries(Object.entries(files).map(([name, file]) => [name, {
        bytes: file.bytes,
        lineCount: file.lineCount,
        messageCount: file.messageCount,
        messages: file.messages.map(message => ({
            name: message.name,
            is_user: message.is_user,
            mes: message.mes,
            swipes: message.swipes,
            swipe_id: message.swipe_id,
            branches: message.branches,
        })),
        metadataVariables: file.metadata?.variables ?? null,
    }]));
}

export async function readSettings(dataRoot) {
    const file = path.join(dataRoot, 'default-user', 'settings.json');
    try {
        const text = await fs.readFile(file, 'utf8');
        const parsed = JSON.parse(text);
        return {
            ok: true,
            sha256: digest(Buffer.from(text, 'utf8')),
            globalSelect: parsed?.world_info?.globalSelect ?? null,
            variablesGlobal: parsed?.extension_settings?.variables?.global ?? null,
            quickReplySets: parsed?.extension_settings?.quick_replies ? Object.keys(parsed.extension_settings.quick_replies) : null,
        };
    } catch (error) {
        return { ok: false, reason: String(error?.message ?? error) };
    }
}

// =================================================================================================================
// THE STAGED PRESET'S PROMPT-ORDER ROW (dispatch 42173399186 root cause; pure, dependency-free, testable without a
// browser). The e03e04 profile kit (frozen, M1) keys its `prompt_order` row on `character_id: 100000`, the
// PromptManager CLASS default (`PromptManager.js:312-339`). The LIVE prompt manager is constructed with
// `oai_settings` (`script.js:7869` -> `openai.js:675-721`), whose configuration OVERRIDES the dummyId to 100001
// (`openai.js:696-699`), and `getPromptOrderForCharacter` matches `String(list.character_id) === String(character.id)`
// (`PromptManager.js:1207-1212`). A row keyed 100000 is therefore INVISIBLE; `sanitizeServiceSettings`
// (`PromptManager.js:1006-1015`) then injects `promptManagerDefaultPromptOrder`, which is exactly the 11-prompt
// default order dispatch 42173399186 recorded (`promptCount:11`, `activeCharacter:{id:100001}`).
//
// The probe therefore stages the kit document WITH AN ADDITIONAL ACTIVE ROW for 100001 (a frontend-saved preset can
// carry several character rows: committed preset-a.json carries 100000 AND 100001), and this module owns the pure
// functions so the transformation and its assertion are checkable by `node` alone:
//   * `stagedPresetDocument(preset)` -> the document to write;
//   * `validateStagedPreset(document)` -> the assertion; it returns `ok:false` for a kit-only document.
// The kit document itself is NOT edited (the M1 lane owns it); the probe records both the staged and kit digests.
// =================================================================================================================

export const GLOBAL_PROMPT_ORDER_DUMMY_ID = 100001;

export const STAGED_PROMPT_ORDER_REASON = 'the live prompt manager matches order rows against activeCharacter.id = '
    + '100001 (openai.js:698 overrides the PromptManager.js:336 class default of 100000; script.js:7869 passes '
    + 'oai_settings), and a row keyed 100000 is invisible to PromptManager.js:1207-1212 - measured in dispatch '
    + '42173399186, where the selected preset left the 11 default prompts in the manager';

/**
 * The preset document AS STAGED: a deep clone of the kit document with an ACTIVE `prompt_order` row for the live
 * global dummyId. Deterministic (no timestamps, same order array) so `--stage-only` can assert the bytes.
 */
export function stagedPresetDocument(presetDocument) {
    if (presetDocument === null || typeof presetDocument !== 'object' || Array.isArray(presetDocument)) {
        throw new Error('stagedPresetDocument requires the kit preset document');
    }
    const document = JSON.parse(JSON.stringify(presetDocument));
    const rows = Array.isArray(document.prompt_order) ? document.prompt_order : [];
    const template = rows[0] ?? { character_id: null, order: [] };
    const orderCopy = JSON.parse(JSON.stringify(template.order ?? []));
    const hasActiveRow = rows.some(row => String(row?.character_id) === String(GLOBAL_PROMPT_ORDER_DUMMY_ID));
    if (!hasActiveRow) rows.unshift({ character_id: GLOBAL_PROMPT_ORDER_DUMMY_ID, order: orderCopy });
    document.prompt_order = rows;
    return document;
}

/**
 * Validate the STAGED preset the way the frontend will read it: JSON shape, every declared prompt referenced exactly
 * once by the active order, a boolean `enabled` on each order entry, and an active row for the live dummyId. A
 * kit-only document fails this (`activeCharacterId` 100000, `ok:false`) - that is the assertion that would have
 * caught dispatch 42173399186 before a browser booted.
 */
export function validateStagedPreset(document) {
    const problems = [];
    const prompts = Array.isArray(document?.prompts) ? document.prompts : [];
    const rows = Array.isArray(document?.prompt_order) ? document.prompt_order : [];
    const activeRow = rows.find(row => String(row?.character_id) === String(GLOBAL_PROMPT_ORDER_DUMMY_ID)) ?? null;
    const order = Array.isArray(activeRow?.order) ? activeRow.order : [];
    const declared = new Set();
    for (const prompt of prompts) {
        if (!prompt || typeof prompt.identifier !== 'string' || prompt.identifier.length === 0) problems.push('a declared prompt has no identifier');
        else if (declared.has(prompt.identifier)) problems.push(`duplicate prompt identifier ${prompt.identifier}`);
        else declared.add(prompt.identifier);
    }
    const referenced = new Set();
    for (const entry of order) {
        if (!entry || typeof entry.identifier !== 'string') problems.push('an active order entry has no identifier');
        else if (!declared.has(entry.identifier)) problems.push(`active order references undeclared ${entry.identifier}`);
        else if (referenced.has(entry.identifier)) problems.push(`active order references ${entry.identifier} twice`);
        else referenced.add(entry.identifier);
        if (typeof entry?.enabled !== 'boolean') problems.push(`active order entry ${entry?.identifier} has no boolean enabled`);
    }
    for (const identifier of declared) if (!referenced.has(identifier)) problems.push(`declared prompt ${identifier} is not referenced by the active order`);
    return {
        ok: problems.length === 0 && prompts.length > 0 && order.length > 0,
        problems,
        promptOrderCharacterIds: rows.map(row => String(row?.character_id)),
        activeCharacterId: activeRow ? activeRow.character_id : null,
        declaredPrompts: prompts.length,
        activeOrderLength: order.length,
    };
}
