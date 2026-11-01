// SHARED FIXTURE AND DISK READERS FOR THE SECOND-ORDER HELPER STATE LEG.
//
// The variables leg already proves chat/global values reach the provider request and survive a reload
// and a restart (tests/browser/helper-vars-generate-probe.mjs). This leg adds what that one deliberately
// left out -- the `character` and `preset` scopes, script/temporary scope, simultaneous/list/delete
// semantics, PRESET MUTATION reaching the NEXT request, and lifecycle EVENTS -- so it needs three things
// the narrow kit does not provide:
//
//   1. A SECOND character card, because "the character scope follows the character" cannot be observed
//      with one card. The card is synthesised here as a valid PNG with a ccv3 tEXt chunk: the committed
//      derivation is 18 MB and carries a real user card's prose (AGENTS 56), and copying it under another
//      name would produce the SAME character name, which makes a switch unobservable. The synthetic card
//      carries no prose and no user data -- only the name the store is keyed by.
//   2. A second preset, because "the preset scope follows the preset" and "the in-use preset mutation
//      reaches the next request" both need a preset to switch AWAY from.
//   3. Projections of the PERSISTED bytes per scope: chat_metadata.variables, settings.json
//      extension_settings.variables.global, the card's data.extensions.tavern_helper.variables, and the
//      preset file's extensions.tavern_helper.variables. The comparator compares these projections and
//      their digests, never free text.
//
// Reused without a second copy: readCommittedPreset/buildTrio/writeProbePresets/stageProbeCard/seedChats/
// readChatRecords/readSettingsFile/readCardStance/extractCardTavernHelper come from helper-vars-kit.mjs.

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';

import {
    browserDirectory, extractCardTavernHelper, readCardStance, readChatRecords, readCommittedPreset,
    imageChunksOnly, readSettingsFile, repoRoot, stageProbeCard, buildTrio, writeProbePresets, seedChats,
} from './helper-vars-kit.mjs';

export { browserDirectory, repoRoot, readCommittedPreset, readCardStance, readChatRecords, readSettingsFile, stageProbeCard, buildTrio, writeProbePresets, seedChats, extractCardTavernHelper };

export const HELPERS = { name: 'HS-Character-B', avatar: 'HS-Character-B.png', file: 'HS-Character-B.png' };

export const PRESET_A = 'hs-state-preset-a';
export const PRESET_B = 'hs-state-preset-b';

export const STATE_MARKERS = {
    chat: 'HS-CHAT-',
    global: 'HS-GLOBAL-',
    character: 'HS-CHARACTER-',
    preset: 'HS-PRESET-',
    script: 'HS-SCRIPT-',
    message: 'HS-MESSAGE-',
    injected: 'HS-INJECTED-',
    mutation: 'HS-MUTATION-MARKER-',
    presetB: 'HS-PRESET-B-MARKER',
};

// ---------------------------------------------------------------------------------------------------------
// A SYNTHETIC SECOND CARD: a real PNG with one 1x1 image and a `ccv3` tEXt chunk carrying the card JSON.
// No prose, no user data, no image content beyond one pixel -- and a DISTINCT name, which is what the
// character scope is keyed by (src/store/settings/character.ts reads `.data.extensions` of the OPEN card).
// ---------------------------------------------------------------------------------------------------------

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

export function syntheticCardPng(name) {
    const signature = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(1, 0); // width
    ihdr.writeUInt32BE(1, 4); // height
    ihdr[8] = 8; // bit depth
    ihdr[9] = 2; // colour type: truecolour
    ihdr[10] = 0; // compression
    ihdr[11] = 0; // filter
    ihdr[12] = 0; // interlace
    // One pixel, filter byte 0 + RGB(64,64,64).
    const raw = Buffer.from([0x00, 0x40, 0x40, 0x40]);
    const idat = zlib.deflateSync(raw);
    const card = {
        spec: 'chara_card_v3',
        spec_version: '3.0',
        name: `root-${name}`,
        data: {
            name,
            description: 'state-probe synthetic card (no user prose)',
            personality: '',
            scenario: '',
            first_mes: 'HS-SYNTHETIC-GREETING',
            mes_example: '',
            creator_notes: '',
            system_prompt: '',
            post_history_instructions: '',
            tags: [],
            creator: '',
            character_version: '',
            alternate_greetings: [],
            extensions: {},
        },
    };
    const text = Buffer.concat([Buffer.from('ccv3\0', 'latin1'), Buffer.from(Buffer.from(JSON.stringify(card), 'utf8').toString('base64'), 'latin1')]);
    return Buffer.concat([signature, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('tEXt', text), pngChunk('IEND', Buffer.alloc(0))]);
}

export async function stageSecondCard(dataRoot) {
    const charactersDirectory = path.join(dataRoot, 'default-user', 'characters');
    await fs.mkdir(charactersDirectory, { recursive: true });
    const bytes = syntheticCardPng(HELPERS.name);
    await fs.writeFile(path.join(charactersDirectory, HELPERS.avatar), bytes);
    return {
        avatar: HELPERS.avatar,
        name: HELPERS.name,
        byteLength: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        note: 'synthetic 1x1 PNG carrying a ccv3 tEXt chunk; no user prose is copied (AGENTS 56)',
    };
}

export async function stageChats(dataRoot, { primaryAvatar, secondaryAvatar }) {
    // A chat for the primary card and a chat for the switch case, plus a chat for the second character so
    // "another chat of the SAME character" is a switch the panel can perform. seedChats writes the canonical
    // chat shape that the pinned frontend opens; the directory is the AVATAR WITHOUT `.png`
    // (src/endpoints/chats.js:592-614), which is also the chatId the panel row carries.
    const primary = await seedChats(dataRoot, {
        avatar: primaryAvatar,
        names: ['HS Primary Chat'],
        firstUser: 'HS-CANARY-USER',
        firstAssistant: 'HS-CANARY-ASSISTANT',
    });
    const secondaryChat = await seedChats(dataRoot, {
        avatar: primaryAvatar,
        names: ['HS Second Chat'],
        firstUser: 'HS-SECOND-USER',
        firstAssistant: 'HS-SECOND-ASSISTANT',
    });
    const switchedCharacter = await seedChats(dataRoot, {
        avatar: secondaryAvatar,
        names: ['HS Character B Chat'],
        firstUser: 'HS-B-USER',
        firstAssistant: 'HS-B-ASSISTANT',
    });
    return { primary, secondaryChat, switchedCharacter };
}

// ---------------------------------------------------------------------------------------------------------
// A DETERMINISTIC DERIVED PRESET, twice: one to mutate, one to switch to. Both derive from the committed
// derivation (`buildTrio` splices the marker prompt into a real complex preset), so the request shape is
// the product's ordinary assembly, not a hand-written body.
// ---------------------------------------------------------------------------------------------------------

export async function writeStatePresets(dataRoot, { nonce }) {
    const committed = await readCommittedPreset();
    const identityA = 'HS-IDENT={{getvar::hs_chat}}|{{getglobalvar::hs_global}}';
    const identityB = `${STATE_MARKERS.presetB}={{getvar::hs_chat}}`;
    const a = buildTrio({ stance: committed.document, readyMarker: 'hs-state-ready-a', identity: identityA });
    const b = buildTrio({ stance: committed.document, readyMarker: 'hs-state-ready-b', identity: identityB });
    const written = await writeProbePresets(dataRoot, {
        a: { name: PRESET_A, document: a.document },
        b: { name: PRESET_B, document: b.document },
    });
    return {
        committed: { file: committed.file, sha256: committed.sha256, byteLength: committed.byteLength },
        presets: {
            [PRESET_A]: { identity: identityA, missingIdentifiers: a.missingIdentifiers, group: a.group },
            [PRESET_B]: { identity: identityB, missingIdentifiers: b.missingIdentifiers, group: b.group },
        },
        files: written,
    };
}

// ---------------------------------------------------------------------------------------------------------
// PERSISTED PROJECTIONS PER SCOPE. Every reader returns a digest of the exact bytes it read plus the
// projection the claim is about, so a difference is locatable (file + field) rather than "the tree moved".
// ---------------------------------------------------------------------------------------------------------

const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export async function readChatMetadataVariables(dataRoot, avatar, chatName) {
    // The chat file's FIRST line is the metadata line (pinned writes character_name/chat_metadata/user_name
    // there); fall back to scanning the lines for an object carrying chat_metadata so a future format change
    // is recorded as a miss rather than silently reading "no variables".
    const directory = path.join(dataRoot, 'default-user', 'chats', avatar);
    const files = (await fs.readdir(directory).catch(() => [])).filter(name => name.endsWith('.jsonl')).sort();
    const target = chatName ? files.find(name => name.includes(chatName)) ?? files[0] : files[0];
    if (!target) return { ok: false, reason: 'no chat file', files, variables: null };
    const text = await fs.readFile(path.join(directory, target), 'utf8');
    const lines = text.split('\n').filter(Boolean);
    let metadata = null;
    for (const line of lines) {
        try {
            const parsed = JSON.parse(line);
            if (parsed && typeof parsed === 'object' && parsed.chat_metadata) {
                metadata = parsed.chat_metadata;
                break;
            }
        } catch {
            // not a metadata line
        }
    }
    return {
        ok: true,
        file: `default-user/chats/${avatar}/${target}`,
        sha256: digest(Buffer.from(text, 'utf8')),
        lineCount: lines.length,
        variables: metadata?.variables ?? null,
        chatId: metadata?.chat_id ?? null,
    };
}

export async function readSettingsGlobalVariables(dataRoot) {
    const settings = await readSettingsFile(dataRoot);
    return {
        ok: settings !== null,
        sha256: settings?.sha256 ?? null,
        variablesGlobal: settings?.variablesGlobal ?? null,
        file: 'default-user/settings.json',
    };
}

// A VALID V3 CARD HAS A NESTED `data` MEMBER, AND THE SHARED FIXTURE DOES NOT -- which is a finding this helper
// records. `stageProbeCard` writes its payload FLAT, so `readFromV2` (pinned characters.js:504-557, port
// characters_format.go) returns it unchanged ("Spec v2 data missing") and the character object has no `.data`.
// The helper's character-scope write then does `character.data.extensions[...]` directly (src/util/tavern.ts,
// writeExtensionField) and THROWS: the character scope can never persist from that fixture, which is why it was
// unproven. This card keeps the derivation (image chunks of the committed fixture; no user prose) but writes the
// Spec-V3 shape the readers require.
function pngTextChunkLocal(keyword, value) {
    return pngChunk('tEXt', Buffer.concat([Buffer.from(keyword, 'latin1'), Buffer.from([0]), Buffer.from(value, 'latin1')]));
}

export async function stageValidCard(dataRoot) {
    const fixture = await fs.readFile(path.join(browserDirectory, 'fixtures', 'real', 'card-a.png'));
    const data = {
        name: 'PROBE_VARS_CARD',
        description: 'PROBE_CARD_DESCRIPTION',
        personality: 'PROBE_CARD_PERSONALITY',
        scenario: 'PROBE_CARD_SCENARIO',
        first_mes: 'PROBE_CARD_GREETING',
        mes_example: '',
        creator_notes: '',
        system_prompt: '',
        post_history_instructions: '',
        alternate_greetings: [],
        tags: [],
        creator: '',
        character_version: '',
        extensions: { chat: 'probe-chat-preset', talkativeness: '0.5', fav: false, world: '' },
        group_only_greetings: [],
    };
    const document = { spec: 'chara_card_v3', spec_version: '3.0', name: data.name, ...data, data };
    const encoded = Buffer.from(JSON.stringify(document), 'utf8').toString('base64');
    // The fixture's own image chunks, then the two text chunks, then IEND -- the same construction the shared kit
    // uses, except the payload is the nested V3 shape.
    const fixtureChunks = imageChunksOnly(fixture);
    const png = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        fixtureChunks[0],
        pngTextChunkLocal('chara', encoded),
        pngTextChunkLocal('ccv3', encoded),
        ...fixtureChunks.slice(1),
    ]);
    const charactersDirectory = path.join(dataRoot, 'default-user', 'characters');
    await fs.mkdir(charactersDirectory, { recursive: true });
    await fs.writeFile(path.join(charactersDirectory, 'probe-vars-card.png'), png);
    return {
        file: 'probe-vars-card.png',
        byteLength: png.length,
        sha256: digest(png),
        shape: 'Spec-V3: nested data[] present (the shared flat payload is the fixture defect that made the character scope unpersistable)',
        derivedFrom: 'tests/browser/fixtures/real/card-a.png (image chunks only; no user prose copied)',
    };
}

export async function readCardVariables(dataRoot, avatar) {
    const directory = path.join(dataRoot, 'default-user', 'characters');
    const bytes = await fs.readFile(path.join(directory, avatar)).catch(() => null);
    if (bytes === null) return { ok: false, reason: 'card file missing', variables: null };
    const helper = extractCardTavernHelper(bytes);
    return {
        ok: helper !== null,
        file: `default-user/characters/${avatar}`,
        sha256: digest(bytes),
        keyword: helper?.keyword ?? null,
        present: helper?.present ?? false,
        variables: helper?.variables ?? null,
        chatPreset: helper?.chatPreset ?? null,
    };
}

export async function readPresetDocument(dataRoot, name) {
    const file = path.join(dataRoot, 'default-user', 'OpenAI Settings', `${name}.json`);
    const bytes = await fs.readFile(file).catch(() => null);
    if (bytes === null) return { ok: false, reason: `preset not on disk: ${name}`, document: null };
    let document = null;
    try {
        document = JSON.parse(bytes.toString('utf8'));
    } catch (error) {
        return { ok: false, reason: `preset is not JSON: ${String(error?.message ?? error)}`, sha256: digest(bytes), document: null };
    }
    const prompts = Array.isArray(document?.prompts) ? document.prompts : [];
    return {
        ok: true,
        file: `default-user/OpenAI Settings/${name}.json`,
        sha256: digest(bytes),
        byteLength: bytes.length,
        // The projection a claim can name: prompt order/content/enabled/role, the sampler subset this leg
        // changes, and the helper's preset-scoped variables. Full-file bytes are recorded beside it.
        projection: {
            promptCount: prompts.length,
            promptOrder: prompts.map(entry => String(entry?.identifier ?? entry?.id ?? '')),
            promptContents: prompts.map(entry => String(entry?.content ?? '')),
            promptEnabled: prompts.map(entry => entry?.enabled !== false),
            promptRoles: prompts.map(entry => String(entry?.role ?? '')),
            temperature: document?.temperature ?? null,
            topP: document?.top_p ?? null,
            maxContext: document?.openai_max_context ?? null,
            helperVariables: document?.extensions?.tavern_helper?.variables ?? null,
        },
        document,
    };
}

// ---------------------------------------------------------------------------------------------------------
// BOUNDED DISK CONDITION WAIT. A debounced save is the product's own output; polling the FILE is a real
// condition (helper-vars-generate-probe measured the 1000 ms debounce and the cost of reading too early).
// A value that never appears is a NAMED drive failure, never a quiet red on the claim.
// ---------------------------------------------------------------------------------------------------------

export async function waitForDisk(name, produce, accept, { deadlineMs = 30000, intervalMs = 200 } = {}) {
    const started = Date.now();
    let last = null;
    while (Date.now() - started < deadlineMs) {
        last = await produce();
        if (accept(last)) return { ok: true, name, waitedMs: Date.now() - started, value: last };
        await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
    return { ok: false, name, waitedMs: Date.now() - started, value: last };
}

export function variablesOf(projection, key) {
    if (projection === null || typeof projection !== 'object') return null;
    return Object.prototype.hasOwnProperty.call(projection, key) ? projection[key] : null;
}
