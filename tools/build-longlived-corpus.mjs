#!/usr/bin/env node
// BUILD THE LONG-LIVED CORPUS: deterministic, synthetic, NO PRIVATE DATA (AGENTS.md 51,56).
//
// WHY THIS EXISTS. Beta 1 must qualify LONG-LIVED session data, not only a freshly seeded 27-step journey.
// Every packaged gate in this repository starts from `default/**`; none of them starts from a tree shaped
// like one a user brings after years of use. A real long-lived tree cannot be committed (AGENTS 56), so
// this generator BUILDS one: fixed seed, byte-identical rebuild, three sizes, a machine-readable manifest.
//
// WHAT IT PRODUCES. A directory that is BOTH a SillyTavern data root and a GoTavern install-side tree:
//
//   <out>/config.yaml                 the pinned fresh-install config verbatim, plus legacy/unknown keys
//   <out>/default-user/characters/    PNG cards (unicode/CJK/emoji names, unusual filenames, long content)
//   <out>/default-user/chats/         multiple chats per character: long, swiped/edited, branch-like
//   <out>/default-user/groups/        group definitions + `group chats/` transcripts
//   <out>/default-user/worlds/        multiple world books, including a legacy-shaped one
//   <out>/default-user/OpenAI Settings/  presets: the repo's committed complex DERIVATION (verbatim),
//                                      upstream presets, and a generated legacy preset
//   <out>/default-user/themes|backgrounds|User Avatars|assets|QuickReplies/
//   <out>/default-user/settings.json  legacy/unknown keys, active preset/world/character, personas
//   <out>/default-user/user/{files,images}  user files the product has no opinion about
//   <out>/default-user/backups/       stale but valid backups
//   <out>/manifest.json               counts, file inventory and the tree digest
//
// THE SHAPE IS THE HARNESS'S DATA-ROOT SHAPE, deliberately: `config.yaml` at the root and `default-user/`
// beside it is exactly what `tests/browser/q20-leg-runtime.mjs`/`run-against-pinned.mjs` hand each subject
// and what `tests/e2e` boots with `--dataRoot`. A "SillyTavern-shaped tree" whose paths no driver reads is
// the failure `tests/e2e/longlived_test.go` records: the tree boots and the history is invisible.
//
// SIZES (measured by `--size`; `tools/longlived/verify.mjs` bounds them):
//   small   <5 MB    fast CI: one Go boot + one browser drive
//   medium  ~30 MB   full qualification: browser drive against long histories
//   large   >100 MB  nightly/manual: generator determinism + Go long-lived boot, NOT a browser drive
//
// USAGE:
//   node tools/build-longlived-corpus.mjs --size small --out .tmp-artifacts/corpus/small [--seed corpus-v1]
//   node tools/build-longlived-corpus.mjs --size small --out DIR --verify-deterministic
//   node tools/build-longlived-corpus.mjs --size small --out DIR --force
//
// The manifest printed on stdout is JSON (one line), so a workflow can pipe it into a verdict without
// parsing prose.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    MANIFEST_NAME, UNICODE_MARKERS, buildManifest, createRng, encodePng, prose,
    walkTree, writeCardPng, writeTree,
} from './longlived/corpus-lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, '..');
const GENERATOR = 'tools/build-longlived-corpus.mjs';
const GENERATOR_VERSION = '1';

// ---------------------------------------------------------------------------------------------------------------
// THE THREE SIZE PROFILES. Every number a tree's size depends on is here, so "small", "medium" and "large"
// cannot silently drift into each other; `verify.mjs` re-measures the bytes and refuses a tree outside its
// class's bounds.
// ---------------------------------------------------------------------------------------------------------------
export const PROFILES = Object.freeze({
    small: {
        characters: 4, chatsPerCharacter: 3, longChatMessages: 120, shortChatMessages: 14,
        messageBytes: 190, cardDescriptionBytes: 4000, cardExampleBytes: 2500,
        worldbooks: 3, entriesPerWorld: 80, entryBytes: 300,
        groups: 1, groupChatMessages: 18, groupChatBytes: 220,
        backgrounds: 3, avatars: 2, assets: 4, themes: 3, quickreplies: 3,
        legacyPresets: 2, presetCount: 3, staleFiles: 6,
        sizeBounds: { minimumBytes: 500 * 1024, maximumBytes: 5 * 1024 * 1024 },
    },
    medium: {
        characters: 12, chatsPerCharacter: 6, longChatMessages: 2400, shortChatMessages: 40,
        messageBytes: 900, cardDescriptionBytes: 60000, cardExampleBytes: 20000,
        worldbooks: 8, entriesPerWorld: 300, entryBytes: 500,
        groups: 3, groupChatMessages: 300, groupChatBytes: 300,
        backgrounds: 12, avatars: 6, assets: 18, themes: 6, quickreplies: 5,
        legacyPresets: 4, presetCount: 5, staleFiles: 30,
        sizeBounds: { minimumBytes: 10 * 1024 * 1024, maximumBytes: 90 * 1024 * 1024 },
    },
    large: {
        characters: 12, chatsPerCharacter: 14, longChatMessages: 5000, shortChatMessages: 120,
        messageBytes: 900, cardDescriptionBytes: 200000, cardExampleBytes: 80000,
        worldbooks: 12, entriesPerWorld: 600, entryBytes: 600,
        groups: 6, groupChatMessages: 1500, groupChatBytes: 400,
        backgrounds: 20, avatars: 8, assets: 36, themes: 8, quickreplies: 7,
        legacyPresets: 6, presetCount: 7, staleFiles: 60,
        sizeBounds: { minimumBytes: 100 * 1024 * 1024, maximumBytes: 400 * 1024 * 1024 },
    },
});

const COMPLEX_PRESET_SOURCE = path.join(REPO_ROOT, 'tests', 'browser', 'fixtures', 'real', 'preset-b.json');
const UPSTREAM_CONTENT = path.join(REPO_ROOT, 'upstream', 'default', 'content');
const COMPLEX_PRESET_NAME = 'Long-Lived Complex';

// The character roster. Names and filenames are the corpus's UNICODE/UNUSUAL-FILENAME surface, so they are
// named here and asserted by the verifier instead of being scattered through the builder.
const CHARACTERS = Object.freeze([
    { name: 'Aiden Cross', avatar: 'Aiden (Alt) #2.png', unicode: false },
    { name: '星野 ひかり', avatar: '星野 ひかり.png', unicode: true },
    { name: 'Élan 🦊 Moon', avatar: 'Élan 🦊 Moon.png', unicode: true },
    { name: 'Quote & Percent %', avatar: 'Quote & Percent %.png', unicode: false },
]);

export function characterFor(profile, index) {
    if (index < CHARACTERS.length) return CHARACTERS[index];
    const label = String(index + 1).padStart(2, '0');
    return { name: `Corpus Chronicle ${label}`, avatar: `Corpus_Chronicle_${label}.png`, unicode: false };
}

function profileCharacters(profile) {
    return Array.from({ length: profile.characters }, (_, index) => characterFor(profile, index));
}

// ---------------------------------------------------------------------------------------------------------------
// SOURCE DOCUMENTS. The corpus copies committed upstream/default assets where a shape must be pinned's own,
// and never invents a document it could read.
// ---------------------------------------------------------------------------------------------------------------

async function readSourceDocuments() {
    const configBase = await fs.readFile(path.join(REPO_ROOT, 'upstream', 'default', 'config.yaml'), 'utf8');
    const settingsBase = JSON.parse(await fs.readFile(path.join(UPSTREAM_CONTENT, 'settings.json'), 'utf8'));
    const contentIndex = JSON.parse(await fs.readFile(path.join(UPSTREAM_CONTENT, 'index.json'), 'utf8'));
    const complexPreset = await fs.readFile(COMPLEX_PRESET_SOURCE);
    const themeNames = (await fs.readdir(path.join(UPSTREAM_CONTENT, 'themes'))).filter(name => name.endsWith('.json')).sort();
    const themes = new Map();
    for (const name of themeNames.slice(0, 4)) {
        themes.set(name, await fs.readFile(path.join(UPSTREAM_CONTENT, 'themes', name)));
    }
    const presetNames = (await fs.readdir(path.join(UPSTREAM_CONTENT, 'presets', 'openai'))).filter(name => name.endsWith('.json')).sort();
    const upstreamPresets = new Map();
    for (const name of presetNames.slice(0, 2)) {
        upstreamPresets.set(name, await fs.readFile(path.join(UPSTREAM_CONTENT, 'presets', 'openai', name)));
    }
    const quickReplyNames = (await fs.readdir(path.join(UPSTREAM_CONTENT, 'presets', 'quick-replies'))).filter(name => name.endsWith('.json')).sort();
    const quickReplies = new Map();
    for (const name of quickReplyNames.slice(0, 1)) {
        quickReplies.set(name, await fs.readFile(path.join(UPSTREAM_CONTENT, 'presets', 'quick-replies', name)));
    }
    const userDefaultAvatar = await fs.readFile(path.join(UPSTREAM_CONTENT, 'user-default.png'));
    return { configBase, settingsBase, contentIndex, complexPreset, themes, upstreamPresets, quickReplies, userDefaultAvatar };
}

// ---------------------------------------------------------------------------------------------------------------
// THE BUILDER.
// ---------------------------------------------------------------------------------------------------------------

function isoAt(chatEpoch, turn) {
    // A FIXED epoch per chat plus whole minutes: no clock, no Date.now(). Pinned and GoTavern both only read
    // these as opaque strings, and the comparator treats send_date as a narrow-normalised field (documented
    // in docs/longlived-corpus.md) exactly because two subjects stamp their own.
    return new Date(Date.UTC(2025, 0, 1) + chatEpoch * 86400000 + turn * 60000).toISOString();
}

function makeMessage({ rng, character, chatLabel, marker, turn, isUser, messageBytes, unicode, worldName }) {
    const body = prose(rng, marker, messageBytes);
    const message = {
        name: character.name,
        is_user: isUser,
        is_system: false,
        send_date: isoAt(chatLabel.epoch, turn),
        mes: body,
        extra: turn % 11 === 0 ? { reasoning: prose(rng, `${marker}_REASONING`, Math.min(400, messageBytes)) } : {},
        // `force_avatar` is what pinned persists for a persona/character avatar in a chat message
        // (public/script.js getThumbnailUrl); carrying it exercises the thumbnail route on reopen.
        force_avatar: isUser ? '/User Avatars/user-default.png' : `/characters/${character.avatar}`,
    };
    if (!isUser && turn % 5 === 2) {
        // SWIPES: the persisted form of a swipe/edit history. `swipe_id` selects the visible one; the other
        // entries are the earlier alternatives. Pinned's own chat files hold exactly these fields.
        const swipes = [message.mes];
        for (let branch = 1; branch <= 2 + (turn % 2); branch++) {
            swipes.push(prose(rng, `${marker}_SWIPE_${branch}`, Math.max(40, Math.floor(messageBytes / 2))));
        }
        // A message whose CURRENT text is not swipes[0] is an edited message as pinned persists it: the file
        // holds the edited text and the earlier branches, and nothing else.
        message.swipes = swipes;
        message.swipe_id = turn % 5 === 2 ? 1 : 0;
        message.mes = swipes[message.swipe_id];
    }
    if (unicode && turn % 17 === 3) {
        message.mes += ` ${UNICODE_MARKERS.cjk} ${UNICODE_MARKERS.emoji}`;
    }
    void worldName;
    return message;
}

function chatFileBody({ rng, character, chatLabel, profile, worldName, messageCount, sharedPrefix = null, deletedTurns = [] }) {
    const header = {
        // chat_metadata is where a long-lived chat binds its world book and Author's Note; pinned reads the
        // world binding from here (public/scripts/world-info.js:1014,1168) and preserves unknown keys.
        chat_metadata: {
            world_info: worldName,
            note_prompt: `CORPUS_AUTHORS_NOTE_${chatLabel.index}`,
            note_interval: 4,
            note_position: 1,
            note_depth: 4,
            note_role: 0,
            longlived_legacy_metadata: { schema: 1, origin: 'synthetic-corpus' },
        },
        user_name: 'unused',
        character_name: 'unused',
    };
    const lines = [JSON.stringify(header)];
    const messages = [];
    for (let turn = 0; turn < messageCount; turn++) {
        // DELETED MESSAGES are ABSENT, which is all pinned persists after a delete (public/script.js
        // deleteMessage splices the array and saves). The deletion positions are declared in the manifest so a
        // reader can tell a deleted turn from a short chat.
        if (deletedTurns.includes(turn)) continue;
        const userName = turn % 41 === 7 ? 'Corpus User' : 'default-user';
        const isUser = turn % 2 === 0;
        // A branch-like pair shares its prefix BYTE-IDENTICALLY: same text, same send_date. A branch chat
        // whose prefix differs is not a branch, it is a second chat with a coincidence.
        const shared = sharedPrefix !== null && turn < sharedPrefix.length;
        const message = shared
            ? structuredClone(sharedPrefix[turn])
            : makeMessage({
                rng, character, chatLabel, marker: `CORPUS_MSG_${chatLabel.index}_${turn}`,
                turn, isUser, messageBytes: profile.messageBytes, unicode: character.unicode, worldName,
            });
        if (!shared) message.name = isUser ? userName : character.name;
        messages.push(message);
        lines.push(JSON.stringify(message));
    }
    return { body: `${lines.join('\n')}\n`, messages, header };
}

function worldEntries({ rng, profile, worldIndex, worldName }) {
    const entries = {};
    for (let uid = 0; uid < profile.entriesPerWorld; uid++) {
        const marker = `CORPUS_WI_${worldIndex}_${uid}`;
        entries[String(uid)] = {
            uid,
            key: [`KEY_${worldIndex}_${uid}`, uid % 9 === 0 ? UNICODE_MARKERS.cjk : `KEY_ALT_${uid}`],
            keysecondary: [],
            comment: `entry ${uid}`,
            content: prose(rng, marker, profile.entryBytes),
            // Constant entries are always injected, which is what makes a world-book switch OBSERVABLE in the
            // provider request rather than only in settings.
            constant: uid % 13 === 0,
            selective: true,
            selectiveLogic: 0,
            order: 100 + uid,
            position: uid % 3 === 0 ? 4 : 0,
            disable: uid % 17 === 0,
            addMemo: true,
            excludeRecursion: false,
            preventRecursion: false,
            delayUntilRecursion: false,
            probability: 100,
            useProbability: true,
            group: '',
            groupOverride: false,
            groupWeight: 100,
            scanDepth: null,
            caseSensitive: null,
            matchWholeWords: null,
            useGroupScoring: null,
            automationId: '',
            role: 0,
            vectorized: false,
            sticky: null,
            cooldown: null,
            delay: null,
            depth: 4,
            displayIndex: uid,
            extensions: { longlived_unknown_entry_field: `entry_extension_${uid}` },
        };
    }
    return { name: worldName, entries };
}

function generatedPreset({ rng, profile, index, promptCount }) {
    const prompts = [];
    const order = [];
    for (let entry = 0; entry < promptCount; entry++) {
        const identifier = `LONGLIVED_PRESET_${index}_${entry}`;
        prompts.push({
            identifier,
            name: `entry ${entry}`,
            role: entry % 4 === 0 ? 'user' : 'system',
            content: prose(rng, `CORPUS_PROMPT_${index}_${entry}`, 240),
            system_prompt: entry % 7 === 0,
            marker: false,
            injection_position: 0,
            injection_depth: 4,
            injection_order: 100,
        });
        order.push({ identifier, enabled: entry % 5 !== 0 });
    }
    return {
        temperature: 0.8 + (index % 4) * 0.05,
        frequency_penalty: 0,
        presence_penalty: 0.1,
        top_p: 0.95,
        top_k: 40,
        openai_max_context: 16000,
        openai_max_tokens: 900,
        stream_openai: true,
        names_behavior: 0,
        squash_system_messages: true,
        wrap_in_quotes: false,
        continue_prefill: true,
        prompts,
        prompt_order: [{ character_id: 100001, order }],
        extensions: { longlived_legacy_preset: { schema: 1, note: `generated preset ${index}` } },
        promptCount,
    };
}

export async function buildCorpus({ size, out, seed = 'corpus-v1', force = false }) {
    const profile = PROFILES[size];
    if (!profile) throw new Error(`unknown --size ${JSON.stringify(size)}; expected small, medium or large`);
    const rng = createRng(`${seed}|${size}`);
    const sources = await readSourceDocuments();
    const files = [];
    const add = (relative, body) => files.push([relative, body]);
    const characters = profileCharacters(profile);
    const user = 'default-user';
    const worldNames = [];
    const planted = { characters: [], chats: [], groups: [], worlds: [], presets: [], themes: [], backgrounds: [], avatars: [], assets: [], quickreplies: [], cards: [] };

    // ---- config.yaml: the pinned fresh-install document verbatim, plus the keys a long-lived install carries.
    const configYaml = [
        sources.configBase.replace(/\s*$/, ''),
        '',
        '# --- appended by tools/build-longlived-corpus.mjs: legacy/unknown fields a long-lived install carries.',
        '# Both servers must PRESERVE these (AGENTS.md 11); dropping one is the defect this corpus detects.',
        'longlived_legacy:',
        '  schema: 3',
        '  migrated_from: 1.12.0',
        '  unknown_plugin_state:',
        '    enabled: false',
        '    note: synthetic-corpus',
        '  keep_unknown_keys: true',
        '',
    ].join('\n');
    add('config.yaml', configYaml);

    // ---- world books.
    for (let index = 0; index < profile.worldbooks; index++) {
        const suffix = String(index + 1).padStart(2, '0');
        const worldName = index === 1 ? `Longlived_Lore_${suffix} ${UNICODE_MARKERS.katakana}` : `Longlived_Lore_${suffix}`;
        worldNames.push(worldName);
        const book = worldEntries({ rng, profile, worldIndex: index, worldName });
        add(`${user}/worlds/${worldName}.json`, JSON.stringify(book, null, 4));
        planted.worlds.push({ name: worldName, file: `${user}/worlds/${worldName}.json`, entries: profile.entriesPerWorld });
    }
    // A LEGACY-SHAPED world: the same entry map with old/unknown members, to prove loading is not version-locked.
    add(`${user}/worlds/Legacy Format World.json`, JSON.stringify({
        entries: {
            0: { uid: 0, key: ['LEGACY_WI_KEY'], content: 'CORPUS_LEGACY_WI_CONTENT', comment: 'legacy', order: 10, position: 0, disable: false, legacy_member: 'preserved' },
            1: { uid: 1, key: ['LEGACY_WI_KEY_TWO'], content: 'CORPUS_LEGACY_WI_CONTENT_TWO', comment: 'legacy two', order: 20, position: 0, disable: false },
        },
        legacy_top_level: { schema: 0 },
    }, null, 4));
    worldNames.push('Legacy Format World');
    planted.worlds.push({ name: 'Legacy Format World', file: `${user}/worlds/Legacy Format World.json`, entries: 2, legacy: true });

    // ---- characters and their chats.
    const chatSummaries = [];
    for (let index = 0; index < characters.length; index++) {
        const character = characters[index];
        const worldName = worldNames[index % (profile.worldbooks + 1)];
        const cardRng = createRng(`${seed}|card|${index}`);
        const bookEntries = Array.from({ length: 24 }, (_, uid) => ({
            id: uid,
            keys: [`CARD_KEY_${index}_${uid}`],
            secondary_keys: [],
            comment: `card entry ${uid}`,
            content: prose(cardRng, `CORPUS_CARD_BOOK_${index}_${uid}`, 300),
            constant: uid % 8 === 0,
            selective: true,
            insertion_order: 100 + uid,
            enabled: uid % 7 !== 0,
            position: 'before_char',
            use_regex: true,
            extensions: { position: 0, depth: 4, probability: 100, useProbability: true },
        }));
        const card = {
            name: character.name,
            description: prose(cardRng, `CORPUS_CARD_DESC_${index}`, profile.cardDescriptionBytes),
            personality: prose(cardRng, `CORPUS_CARD_PERSONALITY_${index}`, Math.floor(profile.cardDescriptionBytes / 4)),
            scenario: `CORPUS_CARD_SCENARIO_${index} ${UNICODE_MARKERS.accented}`,
            first_mes: prose(cardRng, `CORPUS_CARD_FIRST_MES_${index}`, 500),
            mes_example: prose(cardRng, `CORPUS_CARD_EXAMPLE_${index}`, profile.cardExampleBytes),
            creatorcomment: '',
            avatar: 'none',
            talkativeness: '0.5',
            fav: index % 2 === 0,
            tags: ['longlived', 'synthetic-corpus'],
            spec: 'chara_card_v3',
            spec_version: '3.0',
            create_date: '2025-01-01T00:00:00.000Z',
            data: {
                name: character.name,
                description: prose(cardRng, `CORPUS_CARD_DATA_DESC_${index}`, 800),
                personality: 'CORPUS_CARD_DATA_PERSONALITY',
                scenario: 'CORPUS_CARD_DATA_SCENARIO',
                first_mes: 'CORPUS_CARD_DATA_FIRST_MES',
                mes_example: 'CORPUS_CARD_DATA_EXAMPLE',
                creator_notes: '',
                system_prompt: '',
                post_history_instructions: '',
                tags: ['longlived', 'synthetic-corpus'],
                creator: 'synthetic-corpus',
                character_version: '1.0',
                alternate_greetings: ['CORPUS_ALT_GREETING_ONE', 'CORPUS_ALT_GREETING_TWO'],
                extensions: {
                    world: worldName,
                    depth_prompt: { depth: 4, role: 'system', prompt: `CORPUS_DEPTH_PROMPT_${index}` },
                    tavern_helper: {
                        scripts: [{
                            type: 'script', enabled: true, name: `CORPUS_HELPER_SCRIPT_${index}`,
                            id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
                            content: `// CORPUS_HELPER_CONTENT_${index}`, info: '', button: {}, data: {}, export_with: {},
                        }],
                        variables: { global: { [`CORPUS_GLOBAL_VAR_${index}`]: 'value' } },
                    },
                    regex_scripts: [{
                        id: `corpus-regex-${index}`, scriptName: `CORPUS_REGEX_${index}`, disabled: false,
                        runOnEdit: true, findRegex: `/CORPUS_FIND_${index}/g`, replaceString: `CORPUS_REPLACE_${index}`,
                        trimStrings: [], placement: [1, 2], substituteRegex: 0, minDepth: null, maxDepth: null,
                        markdownOnly: true, promptOnly: false,
                    }],
                    longlived_unknown_card_extension: { schema: 1, keep: true },
                },
                character_book: { name: `CORPUS_CARD_BOOK_${index}`, entries: bookEntries },
                group_only_greetings: [],
            },
        };
        const picture = encodePng({ width: 96, height: 144, seedByte: (index * 37) & 0xff });
        planted.characters.push({ name: character.name, avatar: `${user}/characters/${character.avatar}`, world: worldName, unicode: character.unicode });

        // Chats: a long one (the card's `chat` binding), a short one, and a branch PAIR whose shared prefix is
        // byte-identical. The card's `chat` field is how pinned reopens the right history on click
        // (public/script.js:1309,1389,7644): a card that does not name its chat opens an empty conversation.
        const chatDir = `${user}/chats/${character.avatar.replace(/\.png$/, '')}`;
        const chatNames = [
            `${character.avatar.replace(/\.png$/, '')} - 2026-09-14`,
            `${character.avatar.replace(/\.png$/, '')} - 2025-06-01`,
            `${character.avatar.replace(/\.png$/, '')} - 2025-12-31`,
            `${character.avatar.replace(/\.png$/, '')} - 2026-01-02 (branch)`,
        ];
        const longChat = chatFileBody({
            rng, character, profile, worldName,
            chatLabel: { index: `L${index}`, epoch: index + 1 },
            messageCount: profile.longChatMessages,
            deletedTurns: [9, 10],
        });
        add(`${chatDir}/${chatNames[0]}.jsonl`, longChat.body);
        chatSummaries.push({
            file: `${chatDir}/${chatNames[0]}.jsonl`, character: character.name, messages: longChat.messages.length,
            long: true, sharedPrefix: 0, deletedTurns: 2,
        });

        const shortChat = chatFileBody({
            rng, character, profile, worldName,
            chatLabel: { index: `S${index}`, epoch: 100 + index },
            messageCount: profile.shortChatMessages,
        });
        add(`${chatDir}/${chatNames[1]}.jsonl`, shortChat.body);
        chatSummaries.push({ file: `${chatDir}/${chatNames[1]}.jsonl`, character: character.name, messages: shortChat.messages.length, long: false, sharedPrefix: 0, deletedTurns: 0 });

        // Branch pair: the same first 24 messages, then two different continuations.
        const sharedPrefix = longChat.messages.slice(0, 24);
        const branchBase = chatFileBody({
            rng, character, profile, worldName,
            chatLabel: { index: `B${index}A`, epoch: 200 + index },
            messageCount: 40, sharedPrefix,
        });
        const branchOther = chatFileBody({
            rng, character, profile, worldName,
            chatLabel: { index: `B${index}B`, epoch: 201 + index },
            messageCount: 44, sharedPrefix,
        });
        add(`${chatDir}/${chatNames[2]}.jsonl`, branchBase.body);
        add(`${chatDir}/${chatNames[3]}.jsonl`, branchOther.body);
        chatSummaries.push({ file: `${chatDir}/${chatNames[2]}.jsonl`, character: character.name, messages: branchBase.messages.length, long: false, sharedPrefix: 24, deletedTurns: 0, branch: 'base' });
        chatSummaries.push({ file: `${chatDir}/${chatNames[3]}.jsonl`, character: character.name, messages: branchOther.messages.length, long: false, sharedPrefix: 24, deletedTurns: 0, branch: 'diverged' });

        // The card is REWRITTEN with its `chat` binding now that the chat file's name is known: the first write
        // above kept the card self-describing, and this is the field the browser uses.
        card.chat = chatNames[0];
        add(`${user}/characters/${character.avatar}`, writeCardPng(card, picture));
        planted.cards.push({ avatar: `${user}/characters/${character.avatar}`, chat: `${chatDir}/${chatNames[0]}.jsonl`, spec: 'chara_card_v3' });
    }

    // A LEGACY v2 card: a long-lived directory holds cards from before v3.
    const legacyRng = createRng(`${seed}|legacy-card`);
    const legacyCard = {
        name: 'Legacy Card (v2)', description: 'CORPUS_LEGACY_CARD_DESC', personality: 'CORPUS_LEGACY_CARD_PERSONALITY',
        scenario: 'CORPUS_LEGACY_CARD_SCENARIO', first_mes: 'CORPUS_LEGACY_CARD_FIRST_MES', mes_example: 'CORPUS_LEGACY_CARD_EXAMPLE',
        creatorcomment: '', avatar: 'none', talkativeness: '0.5', fav: false, tags: ['legacy'],
        spec: 'chara_card_v2', spec_version: '2.0', create_date: '2023-05-05T00:00:00.000Z',
        data: {
            name: 'Legacy Card (v2)', description: 'CORPUS_LEGACY_CARD_DATA_DESC', personality: 'CORPUS_LEGACY_CARD_DATA_PERSONALITY',
            scenario: 'CORPUS_LEGACY_CARD_DATA_SCENARIO', first_mes: 'CORPUS_LEGACY_CARD_DATA_FIRST_MES', mes_example: 'CORPUS_LEGACY_CARD_DATA_EXAMPLE',
            creator_notes: '', system_prompt: '', post_history_instructions: '', tags: ['legacy'], creator: 'synthetic-corpus',
            character_version: '1.0', alternate_greetings: [], extensions: { world: worldNames[0] }, character_book: { name: 'CORPUS_LEGACY_BOOK', entries: [] }, group_only_greetings: [],
        },
    };
    add(`${user}/characters/Legacy_Card_v2.png`, writeCardPng(legacyCard, encodePng({ width: 64, height: 96, seedByte: 7 })));
    planted.cards.push({ avatar: `${user}/characters/Legacy_Card_v2.png`, chat: null, spec: 'chara_card_v2' });

    // ---- groups and group chats.
    for (let index = 0; index < profile.groups; index++) {
        const id = index === 0 ? 'Long-Lived Ensemble' : `Corpus Group ${String(index + 1).padStart(2, '0')}`;
        const members = characters.slice(0, Math.min(3, characters.length)).map(character => character.avatar);
        const groupChatId = `${id} - 2026-09-20`;
        const groupMessages = [];
        const lines = [JSON.stringify({
            chat_metadata: { world_info: worldNames[index % worldNames.length], longlived_group: true },
            user_name: 'unused',
            character_name: 'unused',
        })];
        for (let turn = 0; turn < profile.groupChatMessages; turn++) {
            const speaker = members[turn % members.length].replace(/\.png$/, '');
            const message = {
                name: speaker,
                is_user: false,
                is_system: false,
                send_date: isoAt(300 + index, turn),
                mes: prose(rng, `CORPUS_GROUP_${index}_MSG_${turn}`, profile.groupChatBytes),
                extra: {},
                force_avatar: `/characters/${members[turn % members.length]}`,
            };
            lines.push(JSON.stringify(message));
            groupMessages.push(message);
        }
        add(`${user}/group chats/${groupChatId}.jsonl`, `${lines.join('\n')}\n`);
        add(`${user}/groups/${id}.json`, JSON.stringify({
            id,
            name: id,
            members,
            avatar_url: members[0],
            allow_self_responses: false,
            activation_strategy: 0,
            generation_mode: 0,
            disabled_members: [],
            fav: index === 0,
            chat_id: groupChatId,
            chats: [groupChatId],
            auto_mode_delay: 5,
            generation_mode_join_prefix: '',
            generation_mode_join_suffix: '',
            longlived_unknown_group_field: { preserved: true },
        }, null, 4));
        planted.groups.push({ id, file: `${user}/groups/${id}.json`, chat: `${user}/group chats/${groupChatId}.jsonl`, messages: groupMessages.length });
    }

    // ---- presets. The complex one is the repository's committed DERIVATION, byte-for-byte: it is a
    // structure-preserving desensitised derivation, never the private original (AGENTS 51,56).
    const complexPresetJson = JSON.parse(sources.complexPreset.toString('utf8'));
    add(`${user}/OpenAI Settings/${COMPLEX_PRESET_NAME}.json`, sources.complexPreset);
    planted.presets.push({
        name: COMPLEX_PRESET_NAME, file: `${user}/OpenAI Settings/${COMPLEX_PRESET_NAME}.json`,
        prompts: Array.isArray(complexPresetJson.prompts) ? complexPresetJson.prompts.length : null,
        order: Array.isArray(complexPresetJson.prompt_order) && Array.isArray(complexPresetJson.prompt_order[0]?.order)
            ? complexPresetJson.prompt_order[0].order.length : null,
        source: 'tests/browser/fixtures/real/preset-b.json',
        structurePreserving: true,
    });
    let upstreamIndex = 0;
    for (const [name, body] of sources.upstreamPresets) {
        const presetName = `Upstream ${name.replace(/\.json$/, '')}`;
        add(`${user}/OpenAI Settings/${presetName}.json`, body);
        const parsed = JSON.parse(body.toString('utf8'));
        planted.presets.push({ name: presetName, file: `${user}/OpenAI Settings/${presetName}.json`, prompts: Array.isArray(parsed.prompts) ? parsed.prompts.length : null, source: 'upstream/default/content/presets/openai', structurePreserving: true });
        upstreamIndex++;
        if (upstreamIndex >= 2) break;
    }
    for (let index = 0; index < profile.legacyPresets; index++) {
        const presetName = index === 0 ? 'Long-Lived Legacy' : `Long-Lived Legacy ${index + 1}`;
        const preset = generatedPreset({ rng, profile, index, promptCount: index === 0 ? 40 : 60 + index });
        const { promptCount, ...body } = preset;
        add(`${user}/OpenAI Settings/${presetName}.json`, JSON.stringify(body, null, 4));
        planted.presets.push({ name: presetName, file: `${user}/OpenAI Settings/${presetName}.json`, prompts: promptCount, source: 'generated' });
    }

    // ---- themes, backgrounds, personas/avatars, assets, Quick Replies, user files, backups, stale thumbs.
    let themeIndex = 0;
    for (const [name, body] of sources.themes) {
        add(`${user}/themes/${name}`, body);
        planted.themes.push({ name, file: `${user}/themes/${name}` });
        themeIndex++;
        if (themeIndex >= profile.themes) break;
    }
    for (let index = themeIndex; index < profile.themes; index++) {
        const name = `Corpus Theme ${index + 1}.json`;
        add(`${user}/themes/${name}`, JSON.stringify({ main_text_color: `#${((index + 1) * 0x203040).toString(16).padStart(6, '0')}`, background_color: '#101418', longlived_unknown_theme_field: 'preserved' }, null, 4));
        planted.themes.push({ name, file: `${user}/themes/${name}` });
    }
    const backgroundMetadata = {};
    for (let index = 0; index < profile.backgrounds; index++) {
        const name = index === 0 ? 'Longlived Background.png' : `Corpus Background ${String(index + 1).padStart(2, '0')}.${index % 2 === 0 ? 'png' : 'jpg'}`;
        const isPng = name.endsWith('.png');
        // A JPEG-named file that is actually PNG would be a defect, so the extension decides the encoder. The
        // corpus keeps both because a real directory mixes them and the served Content-Type must follow the
        // BYTES, not the extension (pinned's /thumbnail branch order).
        add(`${user}/backgrounds/${name}`, encodePng({ width: 320, height: 180, seedByte: (index * 13) & 0xff, mode: index % 3 === 0 ? 'checker' : 'gradient' }));
        backgroundMetadata[name] = { extra: [], shown: true, longlived_unknown_bg_field: `bg_${index}` };
        planted.backgrounds.push({ name, file: `${user}/backgrounds/${name}`, pngBytes: true, contentTypeHint: isPng ? 'image/png' : 'image/png' });
    }
    add(`${user}/backgrounds/backgrounds.json`, JSON.stringify(backgroundMetadata, null, 4));
    add(`${user}/backgrounds/__transparent.png`, encodePng({ width: 32, height: 32, seedByte: 3 }));
    add(`${user}/User Avatars/user-default.png`, sources.userDefaultAvatar);
    planted.avatars.push({ name: 'user-default.png', file: `${user}/User Avatars/user-default.png`, source: 'upstream/default/content/user-default.png' });
    for (let index = 0; index < profile.avatars; index++) {
        const name = `Corpus Persona ${String(index + 1).padStart(2, '0')}.png`;
        add(`${user}/User Avatars/${name}`, encodePng({ width: 64, height: 96, seedByte: (index * 29) & 0xff }));
        planted.avatars.push({ name, file: `${user}/User Avatars/${name}` });
    }
    for (let index = 0; index < profile.assets; index++) {
        const name = index % 2 === 0 ? `Corpus Asset ${String(index + 1).padStart(2, '0')}.png` : `corpus_asset_${index + 1}.bin`;
        const body = name.endsWith('.png') ? encodePng({ width: 48, height: 48, seedByte: (index * 17) & 0xff }) : Buffer.from(`CORPUS_ASSET_BINARY_${index}`, 'utf8');
        add(`${user}/assets/${name}`, body);
        planted.assets.push({ name, file: `${user}/assets/${name}` });
    }
    for (const [name, body] of sources.quickReplies) {
        const quickName = `Corpus ${name}`;
        add(`${user}/QuickReplies/${quickName}`, body);
        planted.quickreplies.push({ name: quickName, file: `${user}/QuickReplies/${quickName}` });
    }
    for (let index = 0; index < profile.quickreplies - sources.quickReplies.size; index++) {
        const name = `Corpus Quick Replies ${index + 1}.json`;
        add(`${user}/QuickReplies/${name}`, JSON.stringify({
            qrList: [{
                id: `corpus-qr-${index}`, label: `Corpus QR ${index}`, message: `/echo CORPUS_QR_${index}`,
                showLabel: true, automationId: '', preventAutoExecute: false, isHidden: false,
                executeOnStartup: false, executeOnUser: false,
            }],
            longlived_unknown_qr_field: 'preserved',
        }, null, 4));
        planted.quickreplies.push({ name, file: `${user}/QuickReplies/${name}` });
    }
    for (let index = 0; index < profile.staleFiles; index++) {
        const name = `CORPUS_STALE_FILE_${String(index).padStart(2, '0')}.txt`;
        add(`${user}/user/files/${name}`, prose(rng, `CORPUS_STALE_${index}`, 400 + index * 40));
    }
    add(`${user}/user/files/unknown-binary.dat`, Buffer.from([0x00, 0x01, 0xfe, 0xff, 0x43, 0x4f, 0x52, 0x50, 0x55, 0x53]));
    add(`${user}/user/images/CORPUS_USER_IMAGE.png`, encodePng({ width: 40, height: 40, seedByte: 9 }));
    add(`${user}/backups/settings_2025-09-01.json`, JSON.stringify({ backup: 'older settings', longlived: true }, null, 4));
    add(`${user}/backups/chats/Longlived_Card - 2025-08-01.jsonl`, '{"user_name":"default-user","mes":"CORPUS_BACKUP_CHAT_MESSAGE"}\n');
    add(`${user}/thumbnails/avatar/stale.png`, Buffer.from('STALE_AVATAR_THUMBNAIL'));
    add(`${user}/thumbnails/persona/stale.png`, Buffer.from('STALE_PERSONA_THUMBNAIL'));
    add(`${user}/thumbnails/bg/stale.png`, Buffer.from('STALE_BG_THUMBNAIL'));
    // THE FLAT LEGACY CHAT: an old install kept chats at the user root before chats moved under
    // `chats/<card>/`. It must be preserved and must not break anything.
    add(`${user}/chats/Legacy Flat Chat - 2024-01-01.jsonl`, '{"user_name":"default-user","mes":"CORPUS_LEGACY_FLAT_CHAT"}\n');
    add(`${user}/stats.json`, JSON.stringify({ longlived_stats: { messages: 1 }, unknown: true }, null, 4));

    // ---- settings.json: built from the pinned fresh-install settings, then made LONG-LIVED.
    const settings = sources.settingsBase;
    settings.firstRun = false;
    settings.username = 'default-user';
    settings.user_avatar = 'user-default.png';
    settings.world_names = worldNames;
    settings.world_info = { globalSelect: [worldNames[0], worldNames[1]].filter(Boolean) };
    settings.preset_settings = 'Long-Lived Legacy'; // legacy key name, still read by pinned
    settings.themes = planted.themes.map(theme => theme.name);
    settings.oai_settings = {
        ...(settings.oai_settings ?? {}),
        preset_settings_openai: COMPLEX_PRESET_NAME,
        temp_openai: 0.63,
        openai_max_tokens: 900,
        openai_max_context: 16000,
        chat_completion_source: 'custom',
        openai_model: 'corpus-model',
        reverse_proxy: 'http://127.0.0.1:9/unused',
        prompts: [],
        prompt_order: [{ character_id: 100001, order: [] }],
    };
    settings.power_user = {
        ...(settings.power_user ?? {}),
        persona_descriptions: Object.fromEntries(planted.avatars.map((avatar, index) => [avatar.name, { description: `CORPUS_PERSONA_${index}`, position: 0, depth: 4, role: 0, lorebook: '' }])),
        longlived_legacy_power_user: { imported: true },
    };
    settings.extension_settings = {
        ...(settings.extension_settings ?? {}),
        disabledExtensions: [],
        notifyUpdates: false,
        tavern_helper: { scripts: [], variables: { global: { CORPUS_GLOBAL_VAR: 'CORPUS_GLOBAL_VALUE' } } },
        longlived_legacy_extension: { enabled: false, note: 'synthetic-corpus', schema: 2 },
    };
    // UNKNOWN top-level keys a long-lived install carries because an extension wrote them. Both servers must
    // preserve them (AGENTS 11); the Go corpus test asserts they are still there after a boot.
    settings.longlived_legacy_state = { schema: 2, migratedFrom: '1.9.0', notes: ['synthetic-corpus', UNICODE_MARKERS.accented], unknown: { deep: [1, 2, 3] } };
    add(`${user}/settings.json`, JSON.stringify(settings, null, 4));
    add(`${user}/settings.json.bak`, JSON.stringify({ ...settings, firstRun: true, longlived_backup: true }, null, 2));

    // ---- content.log: the file a long-lived install HAS, and a fresh one does not.
    //
    // Pinned's content seeding (`src/endpoints/content-manager.js:135-180`) copies each default-content item whose
    // filename is NOT in the user's content.log. A corpus without this file makes every boot re-seed Seraphina,
    // the upstream presets and the upstream themes into a directory that already has a user's data -- which is a
    // startup mutation of a long-lived tree, exactly what this corpus must be able to detect. Writing the log is
    // what a real install looks like after its first boot.
    const globalContentTypes = new Set(['error_page', 'stylesheet']);
    const userContentLog = sources.contentIndex.filter(item => !globalContentTypes.has(item.type)).map(item => item.filename);
    const globalContentLog = sources.contentIndex.filter(item => globalContentTypes.has(item.type)).map(item => item.filename);
    add(`${user}/content.log`, `${userContentLog.join('\n')}\n`);
    add('content.log', `${globalContentLog.join('\n')}\n`);

    // ---- write the tree, then build the manifest FROM THE TREE (never from the builder's own declarations).
    //
    // `--force` REMOVES the previous tree first, so a rebuild with a different seed cannot leave files from the
    // earlier build inside the new digest. The removal is refused for a path that could be the repository, the
    // filesystem root, or an ancestor of the repository: a generator that can delete a checkout is not a tool.
    if (force) {
        const resolved = path.resolve(out);
        const filesystemRoot = path.parse(resolved).root;
        if (resolved === filesystemRoot || resolved === REPO_ROOT || REPO_ROOT.startsWith(resolved + path.sep)) {
            throw new Error(`refusing --force on ${resolved}: it is the filesystem root, this repository, or an ancestor of it`);
        }
        await fs.rm(resolved, { recursive: true, force: true });
    }
    await fs.mkdir(out, { recursive: true });
    // A stale manifest from an earlier build is removed first, or the walk would digest two manifests.
    await fs.rm(path.join(out, MANIFEST_NAME), { force: true });
    await writeTree(out, files, { force });
    const entries = await walkTree(out);
    const manifest = buildManifest({
        generator: GENERATOR,
        generatorVersion: GENERATOR_VERSION,
        seed,
        size,
        profile,
        entries,
        counts: {
            characters: characters.length + 1,
            chats: chatSummaries.length + 1,
            messages: chatSummaries.reduce((sum, chat) => sum + chat.messages, 0),
            swipedMessages: planted.characters.length,
            groups: planted.groups.length,
            groupMessages: planted.groups.reduce((sum, group) => sum + group.messages, 0),
            worldbooks: planted.worlds.length,
            worldEntries: planted.worlds.reduce((sum, world) => sum + world.entries, 0),
            presets: planted.presets.length,
            themes: planted.themes.length,
            backgrounds: planted.backgrounds.length,
            avatars: planted.avatars.length,
            assets: planted.assets.length,
            quickreplies: planted.quickreplies.length,
            legacyUnknownSettingsKeys: ['longlived_legacy_state'],
            legacyUnknownConfigKeys: ['longlived_legacy'],
        },
    });
    manifest.surfaces = {
        config: 'config.yaml',
        settings: `${user}/settings.json`,
        characters: planted.characters,
        cards: planted.cards,
        chats: chatSummaries,
        groups: planted.groups,
        worlds: planted.worlds,
        presets: planted.presets,
        themes: planted.themes,
        backgrounds: planted.backgrounds,
        avatars: planted.avatars,
        assets: planted.assets,
        quickreplies: planted.quickreplies,
        worldNames,
        unicode: UNICODE_MARKERS,
        // The narrow normalisations this corpus's own qualifiers apply are declared in docs/longlived-corpus.md;
        // the manifest names the one field the manifest itself depends on NOT being compared.
        determinism: { comparedFields: ['tree.sha256', 'tree.files', 'counts'], excludedFields: [MANIFEST_NAME] },
    };
    await fs.writeFile(path.join(out, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    return manifest;
}

// ---------------------------------------------------------------------------------------------------------------
// DETERMINISM SELF-CHECK.
// ---------------------------------------------------------------------------------------------------------------

/**
 * Rebuild into a scratch directory with the SAME seed and size and require the same tree digest.
 *
 * This is the corpus's own teeth: a generator that reads a clock, an environment variable or Math.random
 * fails HERE, before any qualification consumes the tree.
 */
export async function verifyDeterministic({ size, seed, out }) {
    const scratch = await fs.mkdtemp(path.join(path.dirname(out), '.determinism-'));
    try {
        const rebuilt = await buildCorpus({ size, seed, out: scratch, force: true });
        const originalManifest = JSON.parse(await fs.readFile(path.join(out, MANIFEST_NAME), 'utf8'));
        return {
            identical: rebuilt.tree.sha256 === originalManifest.tree.sha256,
            originalSha256: originalManifest.tree.sha256,
            rebuiltSha256: rebuilt.tree.sha256,
            files: rebuilt.tree.files,
            bytes: rebuilt.tree.bytes,
        };
    } finally {
        await fs.rm(scratch, { recursive: true, force: true });
    }
}

// ---------------------------------------------------------------------------------------------------------------
// CLI.
// ---------------------------------------------------------------------------------------------------------------

function argument(name, fallback = null) {
    const index = process.argv.indexOf(name);
    if (index < 0) return fallback;
    const value = process.argv[index + 1];
    return value === undefined ? fallback : value;
}

function usage(message) {
    if (message) console.error(`build-longlived-corpus: ${message}`);
    console.error('usage: node tools/build-longlived-corpus.mjs --size <small|medium|large> --out <dir> [--seed <text>] [--force] [--verify-deterministic] [--quiet]');
    process.exit(2);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
    const size = argument('--size');
    const outArgument = argument('--out');
    const seed = argument('--seed', 'corpus-v1');
    if (!size) usage('--size is required');
    if (!outArgument) usage('--out is required');
    if (!PROFILES[size]) usage(`unknown --size ${JSON.stringify(size)}`);
    const out = path.resolve(outArgument);
    const force = process.argv.includes('--force');
    const quiet = process.argv.includes('--quiet');
    const started = Date.now();
    const manifest = await buildCorpus({ size, out, seed, force });
    let determinism = null;
    if (process.argv.includes('--verify-deterministic')) {
        determinism = await verifyDeterministic({ size, seed, out });
        if (!determinism.identical) {
            console.error(`build-longlived-corpus: NOT DETERMINISTIC: first build ${determinism.originalSha256}, rebuild ${determinism.rebuiltSha256}`);
            process.exit(1);
        }
        determinism.elapsedMs = Date.now() - started;
    }
    const summary = {
        ok: true,
        size,
        seed,
        out,
        treeSha256: manifest.tree.sha256,
        files: manifest.tree.files,
        bytes: manifest.tree.bytes,
        counts: manifest.counts,
        determinism,
    };
    console.log(JSON.stringify(summary));
    if (!quiet) {
        console.error(`long-lived corpus (${size}): ${manifest.tree.files} files, ${(manifest.tree.bytes / (1024 * 1024)).toFixed(2)} MiB, tree sha256 ${manifest.tree.sha256}`);
        for (const [name, count] of Object.entries(manifest.counts)) console.error(`  ${name}: ${count}`);
        if (determinism) console.error(`  deterministic rebuild: ${determinism.identical ? 'BYTE-IDENTICAL' : 'DIFFERENT'} (${determinism.rebuiltSha256})`);
    }
}
