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

export function journeyCardDocument() {
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
    return { spec: 'chara_card_v3', spec_version: '3.0', name: data.name, ...data, data };
}

export async function stageJourneyCard(dataRoot) {
    const fixture = await fs.readFile(path.join(browserDirectory, 'fixtures', 'real', 'card-a.png'));
    const encoded = Buffer.from(JSON.stringify(journeyCardDocument()), 'utf8').toString('base64');
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
        derivedFrom: 'tests/browser/fixtures/real/card-a.png (image chunks only)',
    };
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

export async function readChatFiles(dataRoot) {
    const root = path.join(dataRoot, 'default-user', 'chats');
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
