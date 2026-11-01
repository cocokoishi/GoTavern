// THE GROUP-CHAT DIFFERENTIAL'S DETERMINISTIC INPUT TREE.
//
// A group chat is assembled by the FRONTEND (public/scripts/group-chats.js drives one Generate per
// activated member, script.js builds the prompt for each of them), so a provider-request
// differential for group chats needs a browser on BOTH subjects. The subjects must start from the
// SAME user tree or the comparison measures two different chats.
//
// This module writes that tree directly in the PINNED SillyTavern layout:
//
//   default-user/characters/<avatar>.png   V2 cards (1x1 PNG carrying the `chara` tEXt payload)
//   default-user/groups/<group id>.json    group metadata
//   default-user/worlds/<name>.json        world-info books
//   config.yaml                            the pinned fresh-install config, byte-identical on both legs
//
// WHY DIRECTORY FILES INSTEAD OF THE SERVER'S OWN CREATION API: a differential may not let one
// subject's write path decide the other's input. `default-user/characters` written by GoTavern and by
// pinned Node is two different histories of the same data; writing the pinned schema once and booting
// BOTH subjects over it is the only shape where the input is provably identical.
//
// WHAT IS NOT HERE. No expected provider body, prompt text, or response. This file describes the
// USER's data -- named cards, memberships, activation strategies, world books -- because those are
// the scenario; correctness comes from the pinned leg at run time (see group-chat-probe.mjs).
//
// Every character's `talkativeness` is 1 so that NATURAL activation is deterministic in its SET (a
// 0.5 talkativeness makes activation a dice roll). The probe additionally seeds Math.random so the
// shuffled ORDER of a natural activation is reproducible on both subjects; list-order and manual
// cases do not consume it.

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const repositoryRoot = path.resolve(here, '..', '..');
export const PINNED_DEFAULT_CONFIG = path.join(repositoryRoot, 'upstream', 'default', 'config.yaml');

// ---------------------------------------------------------------------------------------------
// A 1x1 PNG carrying a V2 character card in the `chara` tEXt chunk.
// ---------------------------------------------------------------------------------------------
function crc32(buffer) {
    let crc = 0xffffffff;
    for (let n = 0; n < buffer.length; n++) {
        let c = (crc ^ buffer[n]) & 0xff;
        for (let k = 0; k < 8; k++) {
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        }
        crc = (crc >>> 8) ^ c;
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const typeBuffer = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
    return Buffer.concat([length, typeBuffer, data, crc]);
}

function buildCardPng(card) {
    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(1, 0); // width
    ihdr.writeUInt32BE(1, 4); // height
    ihdr[8] = 8; // bit depth
    ihdr[9] = 2; // truecolour
    // zlib stream for one RGB pixel (filter byte 0, then 3 bytes)
    const idat = Buffer.from([0x78, 0x9c, 0x63, 0x60, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01]);
    const payload = Buffer.from(JSON.stringify(card), 'utf8').toString('base64');
    const text = Buffer.concat([Buffer.from('chara\0', 'ascii'), Buffer.from(payload, 'ascii')]);
    return Buffer.concat([
        signature,
        pngChunk('IHDR', ihdr),
        pngChunk('IDAT', idat),
        pngChunk('tEXt', text),
        pngChunk('IEND', Buffer.alloc(0)),
    ]);
}

// ---------------------------------------------------------------------------------------------
// Character cards. A REAL V2 card (`spec` + nested `data`) rather than a flat object: pinned's
// readFromV2 (src/endpoints/characters.js:489-535) only maps `data.extensions.talkativeness` into
// the character's top-level `talkativeness` for a V2 document, and the group activation roll reads
// the TOP-LEVEL field. A card without `data` loads with the 0.5 default, which makes NATURAL
// activation a dice roll -- measured on this lane as one member being activated on one boot and two
// on another.
// ---------------------------------------------------------------------------------------------
function characterCard({ name, description, personality, firstMessage, world = null, depthPrompt = null }) {
    const data = {
        name,
        description,
        personality,
        scenario: '',
        first_mes: firstMessage,
        mes_example: '',
        creator_notes: '',
        system_prompt: '',
        post_history_instructions: '',
        alternate_greetings: [],
        tags: [],
        creator: 'gotavern-group-lane',
        character_version: '1.0',
        extensions: {
            // 1.0, not 0.5: NATURAL activation rolls Math.random() against talkativeness, and a
            // 0.5 card makes the activated SET a dice roll. 1.0 makes activation membership
            // deterministic (every enabled member) while the shuffle still orders them -- which the
            // probe's seeded PRNG makes reproducible on both subjects.
            talkativeness: 1,
            fav: false,
            ...(world ? { world } : {}),
            ...(depthPrompt ? { depth_prompt: depthPrompt } : {}),
        },
    };
    return {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        ...data,
        data,
    };
}

// ---------------------------------------------------------------------------------------------
// World-info books. Shape taken from the pinned default content world (default/content/Eldoria.json)
// so both servers parse the same fields; only the content markers are ours.
// ---------------------------------------------------------------------------------------------
function worldEntry(uid, key, content, overrides = {}) {
    return {
        uid,
        key,
        keysecondary: [],
        comment: key[0],
        content,
        constant: false,
        selective: true,
        order: 100,
        position: 0,
        disable: false,
        displayIndex: uid,
        addMemo: true,
        group: '',
        groupOverride: false,
        groupWeight: 100,
        sticky: 0,
        cooldown: 0,
        delay: 0,
        probability: 100,
        depth: 4,
        useProbability: true,
        role: null,
        vectorized: false,
        excludeRecursion: false,
        preventRecursion: false,
        delayUntilRecursion: false,
        scanDepth: null,
        caseSensitive: null,
        matchWholeWords: null,
        useGroupScoring: null,
        automationId: '',
        ...overrides,
    };
}

function worldBook(entries) {
    return { entries: Object.fromEntries(entries.map((entry, index) => [String(index), entry])) };
}

// ---------------------------------------------------------------------------------------------
// The scenario groups. Each case owns its group AND its fresh chat id: a group chat is created
// from its members' first messages when the chat file does not exist yet (group-chats.js:283-304),
// so one group per case is what makes "fresh greeting" a per-case, independently repeatable state
// instead of a function of the order cases ran in.
// ---------------------------------------------------------------------------------------------
export const MEMBERS = { ALICE: 'alice.png', BOB: 'bob.png', CAROL: 'carol.png' };

const group = ({ id, name, members, activationStrategy = 0, generationMode = 0, disabledMembers = [], chatId }) => ({
    id,
    name,
    members,
    avatar_url: 'img/ai4.png',
    allow_self_responses: false,
    activation_strategy: activationStrategy,
    generation_mode: generationMode,
    disabled_members: disabledMembers,
    fav: false,
    chat_id: chatId,
    chats: [chatId],
    auto_mode_delay: 1,
    generation_mode_join_prefix: '',
    generation_mode_join_suffix: '',
});

export const GROUP_ACTIVATION = { NATURAL: 0, LIST: 1, MANUAL: 2, POOLED: 3 };
export const GROUP_GENERATION_MODE = { SWAP: 0, APPEND: 1, APPEND_DISABLED: 2 };

const TWO = [MEMBERS.ALICE, MEMBERS.BOB];
const THREE = [MEMBERS.ALICE, MEMBERS.BOB, MEMBERS.CAROL];

export const GROUPS = [
    group({ id: 'g-group-greeting', name: 'Greeting Group', members: TWO, activationStrategy: GROUP_ACTIVATION.LIST, chatId: 'chat-group-greeting' }),
    group({ id: 'g-natural-2', name: 'Natural Two', members: TWO, activationStrategy: GROUP_ACTIVATION.NATURAL, chatId: 'chat-natural-2' }),
    group({ id: 'g-natural-3', name: 'Natural Three', members: THREE, activationStrategy: GROUP_ACTIVATION.NATURAL, chatId: 'chat-natural-3' }),
    group({ id: 'g-list-3', name: 'List Three', members: THREE, activationStrategy: GROUP_ACTIVATION.LIST, chatId: 'chat-list-3' }),
    group({
        id: 'g-disabled', name: 'Disabled Member', members: THREE, activationStrategy: GROUP_ACTIVATION.LIST,
        disabledMembers: [MEMBERS.CAROL], chatId: 'chat-disabled',
    }),
    group({ id: 'g-auto', name: 'Auto Mode', members: THREE, activationStrategy: GROUP_ACTIVATION.LIST, chatId: 'chat-auto' }),
    group({ id: 'g-manual', name: 'Manual Activation', members: THREE, activationStrategy: GROUP_ACTIVATION.MANUAL, chatId: 'chat-manual' }),
    group({ id: 'g-previous-speaker', name: 'Previous Speaker', members: THREE, activationStrategy: GROUP_ACTIVATION.NATURAL, chatId: 'chat-previous-speaker' }),
    group({ id: 'g-world-info', name: 'World Info Group', members: TWO, activationStrategy: GROUP_ACTIVATION.LIST, chatId: 'chat-world-info' }),
    group({ id: 'g-continue', name: 'Continue Group', members: TWO, activationStrategy: GROUP_ACTIVATION.LIST, chatId: 'chat-continue' }),
    group({ id: 'g-swipe', name: 'Swipe Group', members: TWO, activationStrategy: GROUP_ACTIVATION.LIST, chatId: 'chat-swipe' }),
    group({ id: 'g-regenerate', name: 'Regenerate Group', members: TWO, activationStrategy: GROUP_ACTIVATION.LIST, chatId: 'chat-regenerate' }),
    group({ id: 'g-impersonate', name: 'Impersonate Group', members: TWO, activationStrategy: GROUP_ACTIVATION.LIST, chatId: 'chat-impersonate' }),
    group({ id: 'g-truncation', name: 'Truncation Group', members: TWO, activationStrategy: GROUP_ACTIVATION.LIST, chatId: 'chat-truncation' }),
    group({ id: 'g-restart', name: 'Restart Group', members: TWO, activationStrategy: GROUP_ACTIVATION.LIST, chatId: 'chat-restart' }),
];

// Markers are unique so a provider-wire capture names which mechanism produced a line.
export const MARKERS = {
    ALICE_LORE: 'WI_ALICE_LANTERN_MARKER',
    GLOBAL_LORE: 'WI_GLOBAL_ORCHARD_MARKER',
    CHAT_LORE: 'WI_CHAT_GROUPBOOK_MARKER',
    AUTHORS_NOTE: 'AN_GROUP_DEPTH_MARKER',
    ALICE_DEPTH: 'CHAR_ALICE_DEPTH_MARKER',
    USER_INPUT: 'GROUP_USER_INPUT_MARKER',
};

// ---------------------------------------------------------------------------------------------

export async function seedGroupChatTree(dataRoot) {
    const root = path.resolve(dataRoot);
    const userDirectory = path.join(root, 'default-user');
    for (const directory of ['characters', 'groups', 'worlds', 'chats', 'group chats']) {
        await fs.mkdir(path.join(userDirectory, directory), { recursive: true });
    }

    const cards = {
        [MEMBERS.ALICE]: characterCard({
            name: 'Alice',
            description: 'Alice keeps the lantern and knows the way through the orchard.',
            personality: 'Quiet, observant, precise.',
            firstMessage: 'Alice raises the lantern and says: the orchard is this way.',
            world: 'AliceLore',
            depthPrompt: { prompt: MARKERS.ALICE_DEPTH, depth: 2, role: 'system' },
        }),
        [MEMBERS.BOB]: characterCard({
            name: 'Bob',
            description: 'Bob argues about maps and rarely agrees with anyone.',
            personality: 'Loud, contrary, loyal.',
            firstMessage: 'Bob checks the map and disagrees with everyone.',
        }),
        [MEMBERS.CAROL]: characterCard({
            name: 'Carol',
            description: 'Carol counts the supplies and keeps the ledger.',
            personality: 'Patient, methodical, dry.',
            firstMessage: 'Carol opens the ledger and starts counting the supplies.',
        }),
    };
    for (const [avatar, card] of Object.entries(cards)) {
        await fs.writeFile(path.join(userDirectory, 'characters', avatar), buildCardPng(card));
    }

    const worlds = {
        'AliceLore.json': worldBook([
            worldEntry(0, ['lantern', 'alice'], `${MARKERS.ALICE_LORE}: Alice's lantern lights the orchard path.`),
        ]),
        'GlobalLore.json': worldBook([
            worldEntry(0, ['orchard', 'global'], `${MARKERS.GLOBAL_LORE}: the global book knows this orchard.`),
        ]),
        'ChatLore.json': worldBook([
            worldEntry(0, ['map', 'groupbook'], `${MARKERS.CHAT_LORE}: the group chat's own book notes the map.`),
        ]),
    };
    for (const [name, book] of Object.entries(worlds)) {
        await fs.writeFile(path.join(userDirectory, 'worlds', name), `${JSON.stringify(book, null, 4)}\n`);
    }

    for (const groupDefinition of GROUPS) {
        await fs.writeFile(
            path.join(userDirectory, 'groups', `${groupDefinition.id}.json`),
            `${JSON.stringify(groupDefinition, null, 4)}\n`,
        );
    }

    const configBody = await fs.readFile(PINNED_DEFAULT_CONFIG);
    await fs.writeFile(path.join(root, 'config.yaml'), configBody);

    return {
        dataRoot: root,
        cards: Object.keys(cards),
        groups: GROUPS.map(entry => ({ id: entry.id, members: entry.members, activation: entry.activation_strategy, disabled: entry.disabled_members })),
        worlds: Object.keys(worlds),
        configSha256: createHash('sha256').update(configBody).digest('hex'),
    };
}

// The seed is deterministic byte-for-byte; the comparator records this digest so two legs that
// started from different inputs can be refused rather than compared. Computed from the declared
// fixture + the pinned config bytes, so the PINNED leg (which never writes the tree itself) can
// record the same digest as the Go leg that did.
export function seedDigest(seeded) {
    return createHash('sha256')
        .update(JSON.stringify({ cards: seeded.cards, groups: seeded.groups, worlds: seeded.worlds, configSha256: seeded.configSha256 }))
        .digest('hex');
}

export async function expectedSeedDigest() {
    const configBody = await fs.readFile(PINNED_DEFAULT_CONFIG);
    return seedDigest({
        cards: Object.values(MEMBERS),
        groups: GROUPS.map(entry => ({ id: entry.id, members: entry.members, activation: entry.activation_strategy, disabled: entry.disabled_members })),
        worlds: ['AliceLore.json', 'GlobalLore.json', 'ChatLore.json'],
        configSha256: createHash('sha256').update(configBody).digest('hex'),
    });
}
