#!/usr/bin/env node
// BUILD A NODE-ORIGINATED STOCK TREE.
//
// WHAT THIS REPLACES. `scripts/build-stock-tree.sh` builds a stock SillyTavern tree WITHOUT Node by copying
// `upstream/**` and re-implementing the pinned placement rules (src/endpoints/content-manager.js
// getUserTargetByType, src/constants.js USER_DIRECTORY_TEMPLATE). That is a DERIVATION of the pinned SOURCE, and
// `docs/gap-sweep.md` rank 1 has carried it as a P1 since alpha.9: no gate could show that the ORIGINAL Node
// server accepts the tree our gates put in front of GoTavern, or that a tree pinned Node WROTE is accepted by
// GoTavern.
//
// WHAT THIS DOES. It boots the pinned server (its own `server.js`, pinned commit checked below), drives the
// pinned server's OWN HTTP surface -- the same routes the vendored frontend calls -- to create every user-data
// surface, stops the server, and records the bytes the server wrote:
//
//   user account     POST /api/users/create           a SECOND account, not default-user
//   settings         POST /api/settings/save          non-default, with unknown/extension keys
//   character x3     POST /api/characters/create      multipart + a real PNG avatar, then /edit for the
//                                                     deterministic chat binding, alternate greetings and
//                                                     character-scoped regex scripts
//   chat             POST /api/chats/save             multi-message, swipes, an edited message, force_avatar,
//                                                     chat variables and an unknown metadata key
//   group + chat     POST /api/groups/create|edit     three members; group chat via /api/chats/group/save
//   world book       POST /api/worldinfo/edit         entries with unknown per-entry fields
//   preset           POST /api/presets/save           a generated 40-prompt complex preset
//   Quick Replies    POST /api/quick-replies/save     a real QR preset document
//   persona          POST /api/avatars/upload         a real PNG; the persona binding is in settings.json
//   background       POST /api/backgrounds/upload     a real PNG; pinned generates its own metadata entry
//   theme            POST /api/themes/save            a real theme document
//   settings backup  POST /api/settings/make-snapshot the pinned server's own backup file
//
// WHAT IS NOT API-CREATED, and why (all labelled in the report):
//   - a third-party extension directory: pinned installs extensions by cloning a git URL
//     (`/api/extensions/install`), so producing one requires outbound network; the directory is SEEDED and
//     carries no `.git`, so the tree hash cannot race a live repository.
//   - a legacy FLAT chat (`chats/<file>.jsonl` directly under the chats root): pinned's `/api/chats/save` always
//     writes under `chats/<card>/`, so the pre-directory layout is SEEDED.
//   - a `settings.json.bak` legacy backup: pinned's own snapshot route writes
//     `backups/settings_<handle>_<timestamp>.json`, so the older naming convention is SEEDED.
//
// WHAT IS PREPARED, not user data (and labelled): `public/**`, `default/**` and `src/tokenizers/**` are the
// pinned INSTALLATION assets (copied from this repository's vendored pinned baseline -- the release archive
// deliberately does not ship `public/`), and `config.yaml` is written by this generator and then REWRITTEN BY THE
// PINNED SERVER at startup (`src/config-init.js addMissingConfigValues`), so the recorded config is the server's
// own output, carrying the generator's unknown legacy key because the merge preserves it.
//
// DETERMINISM. Everything this generator CHOOSES is deterministic: names, marker text, send dates, the chat a
// card is bound to, the preset document, the PNG pixels (the deterministic encoder from tools/longlived). What
// the PINNED SERVER stamps itself cannot be chosen -- a group id is `String(Date.now())` (src/endpoints/groups.js),
// a settings backup name carries `generateTimestamp()`, `_storage` records carry `created` -- so those are
// DECLARED volatile and masked from a second, normalised digest. Nothing meaningful is rewritten. `--verify-
// deterministic` rebuilds the tree from scratch and requires (a) the normalised digests to be equal and (b) the
// set of differing paths to be exactly the declared volatile set.
//
// USAGE
//   node tools/build-node-stock-tree.mjs --pinned ../SillyTavern --out .tmp-artifacts/node-stock-tree
//   node tools/build-node-stock-tree.mjs --pinned ../SillyTavern --out DIR --verify-deterministic
//   node tools/build-node-stock-tree.mjs --pinned ../SillyTavern --out DIR --workspace WORKDIR
//
// The report (JSON, one object) is written to --report and a human summary is printed to stderr. Exit status is
// non-zero on any refused precondition (pinned checkout dirty, missing pinned commit, an endpoint that answered
// an unexpected status, a card that does not carry the document we asked for).

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { encodePng } from './longlived/corpus-lib.mjs';
import {
    MARKERS, PINNED_COMMIT, PINNED_VERSION, PinnedSession, TREE_USER,
    cardDocument, choosePort, copyTree, fixedIso, formFromObject, normalisedTreeDigest,
    pinnedCheckoutStatus, readJSON, removeWithRetries, selfCheckCardReader, startPinnedServer,
    tempRoot, treeDigest, walkTreeDetailed, writeJSON,
} from './node-stock-tree/lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, '..');
const GENERATOR = 'tools/build-node-stock-tree.mjs';
const GENERATOR_VERSION = '1';

// The card names are EXACT, because pinned derives the PNG file name from `ch_name` (getPngName -> sanitize) and
// every later route names the card by `<file>.png`. A rename here changes the chat names and the driver's
// expectations at once, so the whole vocabulary is one constant.
export const CHARACTERS = Object.freeze([
    {
        name: `${MARKERS.character} Keeper`, role: 'keeper', avatarSeed: 17,
        description: `${MARKERS.character}_DESCRIPTION The keeper of the node-origin archive, written through the pinned character API.`,
        personality: `${MARKERS.character}_PERSONALITY patient, exact, keeps receipts`,
        scenario: `${MARKERS.character}_SCENARIO a lamplit archive where every file has a hash`,
        firstMessage: `${MARKERS.character}_FIRST_MES The ledger is open. What do you want recorded?`,
        example: `<START>\n{{user}}: Record this.\n{{char}}: Recorded, with its digest.`,
        alternateGreetings: [
            `${MARKERS.alternateGreeting}_ONE The archive door is already open.`,
            `${MARKERS.alternateGreeting}_TWO You came back. The ledger waited.`,
        ],
    },
    {
        name: `${MARKERS.characterSecond} Archivist`, role: 'archivist', avatarSeed: 29,
        description: `${MARKERS.characterSecond}_DESCRIPTION The archivist who indexes what the keeper records.`,
        personality: `${MARKERS.characterSecond}_PERSONALITY brisk, curious, cites sources`,
        scenario: `${MARKERS.characterSecond}_SCENARIO the index room next door`,
        firstMessage: `${MARKERS.characterSecond}_FIRST_MES The index is alphabetical and the coffee is not.`,
        example: `<START>\n{{user}}: Where does this go?\n{{char}}: Under "still true".`,
        alternateGreetings: [`${MARKERS.alternateGreeting}_THREE The index has a gap shaped like you.`],
    },
    {
        name: 'Node Origin Lantern', role: 'lantern', avatarSeed: 41,
        description: 'NODE_ORIGIN_LANTERN_DESCRIPTION A third card, so the group has a real ensemble and the roster is not a single file.',
        personality: 'NODE_ORIGIN_LANTERN_PERSONALITY quiet, watchful',
        scenario: 'NODE_ORIGIN_LANTERN_SCENARIO the corridor outside the archive',
        firstMessage: 'NODE_ORIGIN_LANTERN_FIRST_MES The lamp is lit.',
        example: '<START>\n{{user}}: Is it dark?\n{{char}}: Only outside.',
        alternateGreetings: [],
    },
]);

export const CHAT_NAME = `${CHARACTERS[0].name} - 2026-10-01@12h00m00s000ms`;
const WORLD_NAME = `${MARKERS.world} Lore`;
const PRESET_NAME = `${MARKERS.preset} Preset`;
const QUICK_REPLY_NAME = `${MARKERS.quickReply} Replies`;
const PERSONA_FILE = `${MARKERS.persona}.png`;
const BACKGROUND_FILE = `${MARKERS.background}.png`;
const THEME_NAME = `${MARKERS.theme}`;
const EXTENSION_DIR_NAME = 'node-origin-extension';

// The run config. It is written by this generator and then rewritten by the pinned server's own
// `addMissingConfigValues`; the recorded tree carries the SERVER's output. The isolation choices are explicit:
// no basic auth, no whitelist, no auto-update, extensions not loaded, no heartbeat file -- the pinned server is
// bound to 127.0.0.1 by argv and every outbound surface is either disabled or pointed at a closed loopback port.
const RUN_CONFIG = [
    '# Written by tools/build-node-stock-tree.mjs, then rewritten by pinned src/config-init.js',
    "# addMissingConfigValues() at boot. The recorded tree carries the SERVER's output; this is the input.",
    'enableUserAccounts: true',
    'skipContentCheck: true',
    'autoConnect: false',
    'basicAuthMode: false',
    'whitelistMode: false',
    'listen: false',
    'protocol:',
    '  ipv4: true',
    '  ipv6: false',
    'listenAddress:',
    '  ipv4: 127.0.0.1',
    '  ipv6: "[::]"',
    'extensions:',
    '  enabled: false',
    '  autoUpdate: false',
    'browserLaunch:',
    '  enabled: false',
    'backups:',
    '  chat:',
    '    enabled: false',
    '  common:',
    '    numberOfBackups: 5',
    'thumbnails:',
    '  enabled: true',
    '  format: png',
    '# Unknown legacy keys the pinned startup merge must PRESERVE (AGENTS.md 11). The scheduler is a fake key a',
    '# long-lived install carries from a removed plugin; it must survive config-init and both runtimes.',
    'node_origin_legacy_config:',
    '  schema: 2',
    '  migrated_from: 1.12.0',
    '  keep_unknown_keys: true',
    '',
].join('\n');

function parseArguments(argv) {
    const value = (name, fallback = null) => {
        const index = argv.indexOf(name);
        if (index < 0) return fallback;
        return argv[index + 1] ?? fallback;
    };
    return {
        pinned: value('--pinned'),
        out: value('--out'),
        report: value('--report'),
        manifest: value('--manifest'),
        workspace: value('--workspace'),
        seed: value('--seed', 'node-stock-v1'),
        quiet: argv.includes('--quiet'),
        verifyDeterministic: argv.includes('--verify-deterministic'),
        keepRuntime: argv.includes('--keep-runtime'),
    };
}

function say(options, message) {
    if (!options.quiet) process.stderr.write(`${message}\n`);
}

// The deterministic PNG the generator UPLOADS. Pinned re-encodes it as a character card and copies it verbatim
// for personas/backgrounds, so the bytes are only the generator's when the route copies the file.
function pictureFor(seedByte, { width = 288, height = 432, mode = 'gradient' } = {}) {
    return encodePng({ width, height, seedByte, mode });
}

function worldBook() {
    const entries = {};
    const total = 10;
    for (let uid = 0; uid < total; uid++) {
        entries[String(uid)] = {
            uid,
            key: [`${MARKERS.world}_KEY_${uid}`, `NODE_ORIGIN_ALT_${uid}`],
            keysecondary: uid % 4 === 0 ? [`NODE_ORIGIN_SECONDARY_${uid}`] : [],
            comment: `node-origin entry ${uid}`,
            content: `${MARKERS.world}_ENTRY_${uid} ${'lorem '.repeat(6)}`,
            constant: uid % 7 === 0,
            selective: uid % 3 !== 0,
            selectiveLogic: uid % 2 === 0 ? 0 : 3,
            addMemo: true,
            order: 100 + uid,
            position: uid % 4 === 0 ? 4 : (uid % 3 === 0 ? 1 : 0),
            disable: uid === 9,
            excludeRecursion: false,
            preventRecursion: uid % 5 === 0,
            delayUntilRecursion: false,
            probability: 100,
            useProbability: true,
            depth: 4,
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
            displayIndex: uid,
            // An unknown per-entry extension a third-party world-info tool writes; both runtimes must preserve it.
            extensions: { node_origin_unknown_entry_extension: `entry_${uid}`, position: uid % 4 === 0 ? 4 : 0, probability: 100, useProbability: true },
        };
    }
    return {
        name: WORLD_NAME,
        entries,
        // A top-level unknown member, the same class of state a legacy world tool leaves behind.
        node_origin_unknown_world_field: { preserved: true, note: 'written through /api/worldinfo/edit' },
    };
}

function complexPreset() {
    const prompts = [];
    const order = [];
    const promptCount = 40;
    for (let index = 0; index < promptCount; index++) {
        const identifier = `NODE_ORIGIN_PROMPT_${String(index).padStart(2, '0')}`;
        prompts.push({
            identifier,
            name: `node-origin prompt ${index}`,
            system_prompt: index % 5 === 0,
            role: index % 4 === 0 ? 'system' : (index % 3 === 0 ? 'assistant' : 'user'),
            content: `${MARKERS.preset}_PROMPT_${index} ${'context '.repeat(4)}`,
            injection_position: index % 6 === 0 ? 1 : 0,
            injection_depth: 4,
            injection_order: 100 + index,
            marker: false,
            forbid_overrides: false,
        });
        order.push({ identifier, enabled: index % 7 !== 0 });
    }
    return {
        temperature: 0.63,
        frequency_penalty: 0.2,
        presence_penalty: 0.31,
        top_p: 0.92,
        top_k: 40,
        openai_max_context: 32000,
        openai_max_tokens: 1024,
        stream_openai: true,
        names_behavior: 1,
        wrap_in_quotes: true,
        squash_system_messages: true,
        continue_prefill: true,
        assistant_prefill: `${MARKERS.preset}_PREFILL`,
        bias_preset_selected: 'Default (none)',
        prompts,
        prompt_order: [{ character_id: 100001, order }],
        // Preset-scoped regex scripts: the regex extension reads this through presetManager.readPresetExtensionField
        // (public/scripts/preset-manager.js:853-871) from `preset.extensions`.
        extensions: {
            regex_scripts: [{
                id: 'node-origin-preset-regex',
                scriptName: `${MARKERS.preset}_REGEX`,
                disabled: false,
                runOnEdit: true,
                findRegex: '/NODE_ORIGIN_PRESET_FIND/g',
                replaceString: 'NODE_ORIGIN_PRESET_REPLACE',
                trimStrings: [],
                placement: [1, 2],
                substituteRegex: 0,
                minDepth: null,
                maxDepth: null,
                markdownOnly: true,
                promptOnly: false,
            }],
            node_origin_unknown_preset_extension: { schema: 1, keep: true },
        },
    };
}

function quickReplyPreset() {
    return {
        name: QUICK_REPLY_NAME,
        disableGroup: false,
        qrList: [
            {
                id: 'node-origin-qr-one',
                label: 'Record a line',
                message: `/echo NODE_ORIGIN_QR_ONE`,
                showLabel: true,
                automationId: 'NODE_ORIGIN_QR_AUTOMATION',
                preventAutoExecute: false,
                isHidden: false,
                executeOnStartup: false,
                executeOnUser: false,
            },
            {
                id: 'node-origin-qr-two',
                label: 'Hash the room',
                message: '/echo NODE_ORIGIN_QR_TWO',
                showLabel: true,
                automationId: '',
                preventAutoExecute: true,
                isHidden: false,
                executeOnStartup: false,
                executeOnUser: true,
            },
        ],
        extensions: { node_origin_unknown_quick_reply_field: 'preserved' },
    };
}

function chatMessages({ character, userName, marker, count, groupMembers = null }) {
    const messages = [{
        user_name: userName,
        character_name: character.name,
        chat_metadata: {
            world_info: WORLD_NAME,
            note_prompt: 'NODE_ORIGIN_AUTHORS_NOTE',
            note_interval: 3,
            note_position: 1,
            note_depth: 4,
            note_role: 0,
            // CHAT VARIABLES: pinned persists them here (public/scripts/variables.js:23,27,53,270), and the
            // pinned chat-save route writes the array verbatim.
            variables: {
                [MARKERS.chatVariable]: JSON.stringify({ count: 3, note: 'node-origin' }),
                node_origin_local_variable: 'kept',
            },
            // An unknown metadata key a long-lived chat carries; both runtimes must preserve it.
            node_origin_unknown_chat_metadata: { schema: 1, preserved: true },
        },
    }];
    for (let index = 0; index < count; index++) {
        const isUser = index % 2 === 0;
        const base = {
            name: isUser ? userName : character.name,
            is_user: isUser,
            is_system: false,
            send_date: fixedIso(index * 60),
            mes: `${marker}_TURN_${index} ${isUser ? 'the user asks for a record' : 'the character answers'}.`,
            extra: {},
            force_avatar: isUser ? `/User Avatars/${PERSONA_FILE}` : `/characters/${character.name}.png`,
        };
        if (!isUser && index === 3) {
            // SWIPES, as pinned persists them: `swipes` holds every alternative including index 0, and `swipe_id`
            // selects the visible one. This message's visible text is a later branch, i.e. an edited/regenerated
            // message, which is why `mes` is not `swipes[0]`.
            base.swipes = [
                `${MARKERS.chat}_TURN_${index}_SWIPE_0`,
                `${MARKERS.swipe}_TURN_${index}_SWIPE_1`,
                `${MARKERS.swipe}_TURN_${index}_SWIPE_2`,
            ];
            base.swipe_id = 2;
            base.mes = base.swipes[2];
        }
        if (!isUser && index === 1) {
            base.extra = { reasoning: `${MARKERS.chat}_REASONING_${index}`, node_origin_unknown_extra: 'preserved' };
        }
        if (groupMembers && !isUser) {
            base.name = groupMembers[(Math.floor(index / 2)) % groupMembers.length];
            base.force_avatar = `/characters/${base.name}.png`;
        }
        messages.push(base);
    }
    return messages;
}

// ---------------------------------------------------------------------------------------------------------------
// THE BUILD.
// ---------------------------------------------------------------------------------------------------------------
export async function buildNodeStockTree(options) {
    const started = Date.now();
    const pinnedRoot = path.resolve(options.pinned ?? path.join(REPO_ROOT, '..', 'SillyTavern'));
    const out = path.resolve(options.out);
    const reportPath = path.resolve(options.report ?? `${out}.report.json`);
    const manifestPath = path.resolve(options.manifest ?? `${out}.manifest.json`);

    // ---- 0. PRECONDITIONS. A wrong pinned checkout is refused by name, before anything boots or is deleted.
    const { execFile } = await import('node:child_process');
    const head = await new Promise((resolve, reject) => {
        execFile('git', ['rev-parse', 'HEAD'], { cwd: pinnedRoot, encoding: 'utf8' }, (error, stdout) => {
            if (error) return reject(new Error(`the pinned checkout at ${pinnedRoot} is not a readable git checkout: ${error.message}`));
            resolve(stdout.trim());
        });
    });
    if (head !== PINNED_COMMIT) {
        throw new Error(`refusing to generate from ${pinnedRoot}: HEAD is ${head}, the pinned commit is ${PINNED_COMMIT}`);
    }
    const checkoutBefore = await pinnedCheckoutStatus(pinnedRoot);
    if (checkoutBefore.length > 0) {
        throw new Error(`the pinned checkout is dirty before generation:\n${checkoutBefore.join('\n')}`);
    }
    say(options, `node-stock-tree: pinned ${PINNED_VERSION} @ ${PINNED_COMMIT.slice(0, 9)} at ${pinnedRoot}`);

    // ---- 1. THE SCRATCH RUN ROOT. `dataRoot` and `configPath` both live here, so the pinned server's writes
    // (webpack output under <dataRoot>/_webpack, config rewrite under <configPath>, the whole user tree) land in
    // the scratch directory and never in the read-only checkout.
    const runtimeRoot = await tempRoot('gotavern-node-stock-');
    const runtimeData = path.join(runtimeRoot, 'data');
    const runtimeConfig = path.join(runtimeRoot, 'config.yaml');
    await fs.mkdir(runtimeData, { recursive: true });
    await fs.writeFile(runtimeConfig, RUN_CONFIG, 'utf8');
    const port = await choosePort();
    const bootStarted = Date.now();
    const runtime = await startPinnedServer({
        sourceRoot: pinnedRoot,
        runtimeRoot,
        dataRoot: runtimeData,
        configPath: runtimeConfig,
        port,
        logSink: message => {
            if (process.env.NODE_STOCK_TREE_BOOT_LOG === '1') process.stderr.write(message);
        },
    });
    const bootMs = Date.now() - bootStarted;

    const apiOperations = [];
    const record = (surfaceId, route, request) => apiOperations.push({ surface: surfaceId, route, request });
    const surfaces = [];
    const surface = (id, notes) => {
        const entry = { id, apiCreated: true, notes, expected: {} };
        surfaces.push(entry);
        return entry;
    };

    let stopped = false;
    try {
        // ---- 2. LOGIN AS THE ADMIN PINNED CREATES, then CREATE THE TREE'S USER THROUGH THE API.
        const admin = new PinnedSession(runtime.origin, 'admin');
        await admin.login('default-user', '');
        record('account', 'POST /api/users/login', { handle: 'default-user' });
        await admin.post('/api/users/create', { handle: TREE_USER.handle, name: TREE_USER.name, password: TREE_USER.password });
        record('account', 'POST /api/users/create', { handle: TREE_USER.handle, name: TREE_USER.name });
        const accountSurface = surface('account', 'a second account created by the pinned admin API, not default-user');

        const user = new PinnedSession(runtime.origin, TREE_USER.handle);
        await user.login(TREE_USER.handle, TREE_USER.password);
        record('account', 'POST /api/users/login', { handle: TREE_USER.handle });
        const me = await user.postJSON('/api/users/me', {}).catch(() => null);
        accountSurface.expected = { handle: me?.handle ?? TREE_USER.handle, name: me?.name ?? TREE_USER.name };

        // ---- 3. WORLD BOOK, before the characters, because a character's `data.character_book` is derived from
        // its bound world file at character-write time (src/endpoints/characters.js charaFormatData).
        const world = worldBook();
        await user.post('/api/worldinfo/edit', { name: WORLD_NAME, data: world });
        record('world', 'POST /api/worldinfo/edit', { name: WORLD_NAME, entries: Object.keys(world.entries).length });
        const worldSurface = surface('world-info', 'entries, unknown per-entry extension and a top-level unknown member');
        worldSurface.expected = { name: WORLD_NAME, entries: Object.keys(world.entries).length };

        // ---- 4. CHARACTERS. `create` takes the card as multipart form data plus the PNG upload; then `edit`
        // carries the two values the CREATE route chooses for us (`chat`, `create_date`) plus the fields the
        // route does not accept on create (alternate greetings are appended, extensions is JSON).
        const characterSurfaces = [];
        for (const [index, character] of CHARACTERS.entries()) {
            const baseFields = {
                ch_name: character.name,
                description: character.description,
                personality: character.personality,
                scenario: character.scenario,
                first_mes: character.firstMessage,
                mes_example: character.example,
                creator_notes: `NODE_ORIGIN_CREATOR_NOTES_${index}`,
                system_prompt: index === 0 ? 'NODE_ORIGIN_SYSTEM_PROMPT' : '',
                post_history_instructions: index === 0 ? 'NODE_ORIGIN_POST_HISTORY' : '',
                creator: 'Node Origin',
                character_version: '1.0',
                talkativeness: '0.5',
                fav: index === 0 ? 'true' : 'false',
                world: WORLD_NAME,
                depth_prompt_prompt: `NODE_ORIGIN_DEPTH_PROMPT_${index}`,
                depth_prompt_depth: '4',
                depth_prompt_role: 'system',
                tags: 'node-origin, synthetic, api-created',
                alternate_greetings: character.alternateGreetings,
                extensions: JSON.stringify({
                    node_origin_unknown_character_extension: { schema: 1, keep: true, index },
                    depth_prompt: { prompt: `NODE_ORIGIN_DEPTH_PROMPT_${index}`, depth: 4, role: 'system' },
                }),
            };
            const picture = pictureFor(character.avatarSeed);
            const createResponse = await user.postForm('/api/characters/create', formFromObject(baseFields, {
                field: 'avatar', name: `${character.role}.png`, type: 'image/png', bytes: picture,
            }));
            record('characters', 'POST /api/characters/create', { ch_name: character.name, avatarBytes: picture.length });
            const avatarName = createResponse.text.trim();
            if (!avatarName.endsWith('.png')) {
                throw new Error(`/api/characters/create for ${character.name} answered ${JSON.stringify(createResponse.text).slice(0, 200)}, not an avatar name`);
            }
            const avatarPath = path.join(runtimeData, TREE_USER.handle, 'characters', avatarName);
            let storedBytes;
            try {
                storedBytes = await fs.readFile(avatarPath);
            } catch (error) {
                throw new Error(`the pinned server reported ${avatarName} but did not write ${avatarPath}: ${error.message}`);
            }
            // The document pinned wrote must be the one we asked for (ccv3 precedence).
            if (index === 0) selfCheckCardReader();
            const storedDocument = cardDocument(storedBytes);
            if (storedDocument?.data?.name !== character.name) {
                throw new Error(`the stored card for ${avatarName} reads name ${JSON.stringify(storedDocument?.data?.name)}, wanted ${JSON.stringify(character.name)}`);
            }
            // `chat` and `create_date` are hidden fields on the frontend's own form (#selected_chat_pole,
            // #create_date_pole) and the EDIT route is where the frontend writes them.
            const chatName = index === 0 ? CHAT_NAME : `${character.name} - 2026-10-01@12h0${index}m00s000ms`;
            await user.postForm('/api/characters/edit', formFromObject({
                ...baseFields,
                avatar_url: avatarName,
                chat: chatName,
                create_date: fixedIso(index * 3600),
                alternate_greetings: character.alternateGreetings,
                // Character-scoped regex scripts are written through characters/edit
                // (public/scripts/extensions/regex/engine.js:148 writeExtensionField -> characters/edit).
                extensions: JSON.stringify({
                    node_origin_unknown_character_extension: { schema: 1, keep: true, index },
                    depth_prompt: { prompt: `NODE_ORIGIN_DEPTH_PROMPT_${index}`, depth: 4, role: 'system' },
                    regex_scripts: [{
                        id: `node-origin-scoped-regex-${index}`,
                        scriptName: `NODE_ORIGIN_SCOPED_REGEX_${index}`,
                        disabled: false,
                        runOnEdit: true,
                        findRegex: `/NODE_ORIGIN_SCOPED_FIND_${index}/g`,
                        replaceString: `NODE_ORIGIN_SCOPED_REPLACE_${index}`,
                        trimStrings: [],
                        placement: [1, 2],
                        substituteRegex: 0,
                        minDepth: null,
                        maxDepth: null,
                        markdownOnly: true,
                        promptOnly: false,
                    }],
                }),
            }));
            record('characters', 'POST /api/characters/edit', { avatar_url: avatarName, chat: chatName });
            characterSurfaces.push({
                name: character.name,
                avatar: avatarName,
                chat: chatName,
                alternateGreetings: character.alternateGreetings.length,
                description: character.description,
            });
        }
        const characterSurface = surface('characters', 'three cards, real PNG avatars, alternate greetings, character-scoped regex scripts, a deterministic chat binding');
        characterSurface.expected = characterSurfaces;

        // ---- 5. THE CHAT. The message array is the pinned JSONL shape, saved through the route the frontend
        // calls; the whole array (header included) is what the route writes.
        const primaryChat = chatMessages({ character: CHARACTERS[0], userName: TREE_USER.name, marker: MARKERS.chat, count: 8 });
        await user.post('/api/chats/save', {
            avatar_url: characterSurfaces[0].avatar,
            file_name: characterSurfaces[0].chat,
            chat: primaryChat,
        });
        record('chats', 'POST /api/chats/save', { avatar_url: characterSurfaces[0].avatar, file_name: characterSurfaces[0].chat, messages: primaryChat.length });
        const secondaryChat = chatMessages({ character: CHARACTERS[1], userName: TREE_USER.name, marker: 'NODE_ORIGIN_CHAT_SECOND', count: 4 });
        await user.post('/api/chats/save', {
            avatar_url: characterSurfaces[1].avatar,
            file_name: characterSurfaces[1].chat,
            chat: secondaryChat,
        });
        record('chats', 'POST /api/chats/save', { avatar_url: characterSurfaces[1].avatar, file_name: characterSurfaces[1].chat, messages: secondaryChat.length });
        const chatsSurface = surface('chats', 'two JSONL chats, one with swipes and an edited message, both carrying chat variables and an unknown metadata key');
        chatsSurface.expected = {
            primary: { file: characterSurfaces[0].chat, messages: primaryChat.length, variables: MARKERS.chatVariable },
            secondary: { file: characterSurfaces[1].chat, messages: secondaryChat.length },
        };

        // ---- 6. THE GROUP. The pinned route chooses the id (`String(Date.now())`), so the file name is the
        // server's, and the group chat's file name follows it. That id is therefore declared volatile below.
        const groupName = `${MARKERS.group} Ensemble`;
        const groupCreate = await user.post('/api/groups/create', {
            name: groupName,
            members: characterSurfaces.slice(0, 3).map(entry => entry.avatar),
            avatar_url: characterSurfaces[0].avatar,
            allow_self_responses: false,
            activation_strategy: 0,
            generation_mode: 0,
            disabled_members: [],
            fav: true,
            auto_mode_delay: 5,
            generation_mode_join_prefix: '',
            generation_mode_join_suffix: '',
        });
        record('groups', 'POST /api/groups/create', { name: groupName, members: 3 });
        const group = groupCreate.json;
        if (!group?.id || !Array.isArray(group.members)) {
            throw new Error(`/api/groups/create answered ${JSON.stringify(groupCreate.text).slice(0, 300)}`);
        }
        // The frontend saves an edited group through /api/groups/edit with the WHOLE object
        // (public/scripts/group-chats.js). This is where a real group's unknown/legacy members are written.
        await user.post('/api/groups/edit', {
            ...group,
            node_origin_unknown_group_field: { preserved: true },
            members: group.members,
        });
        record('groups', 'POST /api/groups/edit', { id: group.id });
        const groupChatMessages = chatMessages({
            character: CHARACTERS[0], userName: TREE_USER.name, marker: 'NODE_ORIGIN_GROUP_CHAT', count: 6,
            groupMembers: characterSurfaces.slice(0, 3).map(entry => entry.name),
        });
        groupChatMessages[0].chat_metadata.node_origin_group = true;
        await user.post('/api/chats/group/save', { id: group.chat_id, chat: groupChatMessages });
        record('groups', 'POST /api/chats/group/save', { id: group.chat_id, messages: groupChatMessages.length });
        const groupsSurface = surface('groups', 'a three-member group and its own group-chat transcript, both written through pinned routes');
        groupsSurface.expected = {
            name: groupName,
            id: group.id,
            chatId: group.chat_id,
            members: group.members,
            messages: groupChatMessages.length,
            unknownField: 'preserved',
        };

        // ---- 7. PRESET, QUICK REPLIES, THEME. Each route stores the document it is given.
        const preset = complexPreset();
        await user.post('/api/presets/save', { name: PRESET_NAME, preset, apiId: 'openai' });
        record('presets', 'POST /api/presets/save', { name: PRESET_NAME, prompts: preset.prompts.length, apiId: 'openai' });
        const presetsSurface = surface('presets', 'a generated 40-prompt complex preset with prompt_order, samplers and preset-scoped regex');
        presetsSurface.expected = { name: PRESET_NAME, prompts: preset.prompts.length, order: preset.prompt_order[0].order.length, temperature: preset.temperature };

        const quickReplies = quickReplyPreset();
        await user.post('/api/quick-replies/save', quickReplies);
        record('quick-replies', 'POST /api/quick-replies/save', { name: QUICK_REPLY_NAME, items: quickReplies.qrList.length });
        const quickRepliesSurface = surface('quick-replies', 'a two-item Quick Replies preset');
        quickRepliesSurface.expected = { name: QUICK_REPLY_NAME, items: quickReplies.qrList.length };

        const theme = {
            name: THEME_NAME,
            main_text_color: 'rgba(232, 224, 205, 1)',
            italics_text_color: 'rgba(160, 150, 130, 1)',
            underline_text_color: 'rgba(200, 220, 190, 1)',
            quote_text_color: 'rgba(210, 140, 60, 1)',
            blur_tint_color: 'rgba(18, 20, 24, 1)',
            shadow_color: 'rgba(0, 0, 0, 0.7)',
            chat_tint_color: 'rgba(20, 22, 26, 1)',
            user_mes_blur_tint_color: 'rgba(28, 30, 34, 0.9)',
            bot_mes_blur_tint_color: 'rgba(28, 30, 34, 0.9)',
            node_origin_unknown_theme_field: 'preserved',
        };
        await user.post('/api/themes/save', theme);
        record('themes', 'POST /api/themes/save', { name: THEME_NAME });
        const themesSurface = surface('themes', 'a theme document with an unknown member');
        themesSurface.expected = { name: THEME_NAME };

        // ---- 8. BACKGROUND + PERSONA AVATAR, both real PNG uploads through the pinned routes.
        const backgroundBytes = pictureFor(53, { width: 640, height: 360, mode: 'checker' });
        const backgroundResponse = await user.postForm('/api/backgrounds/upload', formFromObject({}, {
            field: 'avatar', name: BACKGROUND_FILE, type: 'image/png', bytes: backgroundBytes,
        }));
        record('backgrounds', 'POST /api/backgrounds/upload', { file: BACKGROUND_FILE, bytes: backgroundBytes.length });
        const backgroundName = backgroundResponse.text.trim() || BACKGROUND_FILE;
        const backgroundsSurface = surface('backgrounds', 'a real PNG uploaded through the pinned route; pinned generates its own metadata entry');
        backgroundsSurface.expected = { file: backgroundName, bytes: backgroundBytes.length };

        const personaBytes = pictureFor(67, { width: 128, height: 160 });
        const personaResponse = await user.postForm('/api/avatars/upload', formFromObject({ overwrite_name: PERSONA_FILE }, {
            field: 'avatar', name: 'persona.png', type: 'image/png', bytes: personaBytes,
        }));
        record('avatars', 'POST /api/avatars/upload', { overwrite_name: PERSONA_FILE, bytes: personaBytes.length });
        const personaName = personaResponse.json?.path ?? PERSONA_FILE;
        if (personaName !== PERSONA_FILE) {
            throw new Error(`/api/avatars/upload stored ${JSON.stringify(personaName)}, wanted ${JSON.stringify(PERSONA_FILE)}`);
        }
        const avatarsSurface = surface('avatars', 'a real PNG persona avatar, re-encoded by the pinned avatar route');
        avatarsSurface.expected = { file: personaName, bytes: personaBytes.length };

        // ---- 9. SETTINGS LAST, because every binding above is a name that settings must reference. The base is
        // the user's own fresh-install settings document, fetched from the pinned server; the modifications are
        // the non-default configuration a long-lived user carries.
        const settingsEnvelope = await user.postJSON('/api/settings/get', {});
        if (typeof settingsEnvelope?.settings !== 'string') {
            throw new Error(`/api/settings/get did not answer a settings string: ${JSON.stringify(settingsEnvelope)?.slice(0, 300)}`);
        }
        const settings = JSON.parse(settingsEnvelope.settings);
        settings.firstRun = false;
        settings.username = TREE_USER.name;
        settings.user_avatar = personaName;
        settings.main_api = 'openai';
        settings.preset_settings = PRESET_NAME;
        settings.amount_gen = 512;
        settings.max_context = 16384;
        settings.swipes = true;
        settings.background = {
            name: backgroundName,
            url: `backgrounds/${encodeURIComponent(backgroundName)}`,
            fitting: 'cover',
            animation: false,
            sortOrder: 'az',
        };
        settings.world_info_settings = {
            ...(settings.world_info_settings ?? {}),
            world_info: { globalSelect: [WORLD_NAME] },
            world_info_depth: 4,
            world_info_budget: 30,
            world_info_recursive: true,
            world_info_include_names: true,
            world_info_case_sensitive: false,
            world_info_match_whole_words: true,
            world_info_character_strategy: 1,
            world_info_budget_cap: 0,
        };
        settings.power_user = {
            ...(settings.power_user ?? {}),
            personas: { [personaName]: MARKERS.persona },
            default_persona: personaName,
            persona_descriptions: {
                [personaName]: {
                    description: `${MARKERS.persona}_DESCRIPTION the archivist's own reader`,
                    position: 1,
                    depth: 2,
                    role: 1,
                    lorebook: WORLD_NAME,
                },
            },
            persona_show_notifications: true,
            theme: THEME_NAME,
            movingUI: false,
            custom_stopping_strings: 'NODE_ORIGIN_STOP_ONE\nNODE_ORIGIN_STOP_TWO',
            instruct: {
                ...(settings.power_user?.instruct ?? {}),
                enabled: true,
                preset: 'ChatML',
                input_sequence: '<|im_start|>user\n',
                output_sequence: '<|im_start|>assistant\n',
                system_sequence: '<|im_start|>system\n',
                stop_sequence: '<|im_end|>',
                wrap: true,
                macro: true,
                names_behavior: 'force',
                activation_regex: '',
                first_output_sequence: '',
                last_output_sequence: '',
                skip_examples: false,
                output_suffix: '\n',
                input_suffix: '\n',
                system_suffix: '\n',
                user_alignment_message: 'NODE_ORIGIN_ALIGNMENT',
                system_same_as_user: false,
            },
            sysprompt: {
                enabled: true,
                name: 'Node Origin Sysprompt',
                content: 'NODE_ORIGIN_SYSPROMPT {{char}} writes in the node-origin register.',
            },
            context: {
                preset: 'Node Origin Context',
                story_string: "{{#if system}}{{system}}\n{{/if}}{{#if wiBefore}}{{wiBefore}}\n{{/if}}{{#if description}}{{description}}\n{{/if}}{{#if personality}}{{char}}'s personality: {{personality}}\n{{/if}}{{#if scenario}}Scenario: {{scenario}}\n{{/if}}{{#if wiAfter}}{{wiAfter}}\n{{/if}}{{#if persona}}{{persona}}\n{{/if}}NODE_ORIGIN_CONTEXT_TAIL",
                chat_start: '*** NODE ORIGIN CHAT START ***',
                example_separator: '*** NODE ORIGIN EXAMPLE SEPARATOR ***',
                use_stop_strings: true,
            },
        };
        settings.oai_settings = {
            ...(settings.oai_settings ?? {}),
            preset_settings_openai: PRESET_NAME,
            temp_openai: preset.temperature,
            freq_pen_openai: preset.frequency_penalty,
            pres_pen_openai: preset.presence_penalty,
            top_p_openai: preset.top_p,
            top_k_openai: preset.top_k,
            stream_openai: true,
            openai_max_context: preset.openai_max_context,
            openai_max_tokens: preset.openai_max_tokens,
            names_behavior: preset.names_behavior,
            squash_system_messages: preset.squash_system_messages,
            wrap_in_quotes: preset.wrap_in_quotes,
            continue_prefill: preset.continue_prefill,
            assistant_prefill: preset.assistant_prefill,
            // The pinned frontend writes the SELECTED preset's prompts into settings when the preset is applied;
            // the same document therefore appears in both places, exactly as a used tree has it.
            prompts: preset.prompts,
            prompt_order: preset.prompt_order,
            // NO PROVIDER MAY BE REACHED. The provider is pinned at a CLOSED loopback port on purpose: a gate
            // that accidentally tried to generate would fail loudly instead of reaching the internet.
            chat_completion_source: 'custom',
            custom_url: 'http://127.0.0.1:9/v1',
            custom_model: 'node-origin-loopback-model',
            reverse_proxy: '',
            use_sysprompt: true,
        };
        settings.extension_settings = {
            ...(settings.extension_settings ?? {}),
            disabledExtensions: [],
            // Global regex scripts live in extension_settings.regex and are saved with settings
            // (public/scripts/extensions/regex/engine.js:113,144).
            regex: [
                {
                    id: 'node-origin-global-regex',
                    scriptName: 'NODE_ORIGIN_GLOBAL_REGEX',
                    disabled: false,
                    runOnEdit: true,
                    findRegex: '/NODE_ORIGIN_GLOBAL_FIND/g',
                    replaceString: 'NODE_ORIGIN_GLOBAL_REPLACE',
                    trimStrings: [],
                    placement: [1, 2],
                    substituteRegex: 0,
                    minDepth: null,
                    maxDepth: null,
                    markdownOnly: true,
                    promptOnly: false,
                },
                {
                    id: 'node-origin-global-regex-two',
                    scriptName: 'NODE_ORIGIN_GLOBAL_REGEX_TWO',
                    disabled: true,
                    runOnEdit: false,
                    findRegex: '/NODE_ORIGIN_GLOBAL_FIND_TWO/g',
                    replaceString: 'NODE_ORIGIN_GLOBAL_REPLACE_TWO',
                    trimStrings: [],
                    placement: [2],
                    substituteRegex: 0,
                    minDepth: null,
                    maxDepth: null,
                    markdownOnly: false,
                    promptOnly: true,
                },
            ],
            character_allowed_regex: characterSurfaces.map(entry => entry.avatar),
            preset_allowed_regex: { openai: [PRESET_NAME] },
            expressions: { showDefault: true, ...(settings.extension_settings?.expressions ?? {}) },
            caption: { refine_mode: false, node_origin_caption_state: 'preserved' },
            // An extension's state subtree, including an unknown member: this is the extension settings half of
            // the tree, and both runtimes must round-trip it untouched.
            [MARKERS.extensionSetting]: {
                enabled: true,
                state: { schema: 3, lastRun: '2026-10-01T12:00:00.000Z', counters: { runs: 4 } },
                unknown_member: { keep: true },
            },
            // Global variables live in extension_settings.variables.global (public/scripts/variables.js:84,130).
            variables: {
                global: {
                    [MARKERS.globalVariable]: JSON.stringify({ records: 4 }),
                },
            },
        };
        // Unknown top-level keys a long-lived install carries because a removed extension wrote them. They are
        // written THROUGH the API (settings/save takes the whole document), so they are API-created, not seeded.
        settings[MARKERS.legacySetting] = {
            schema: 2,
            migratedFrom: '1.9.0',
            notes: ['node-origin', 'not-a-real-extension'],
            unknown: { deep: [1, 2, 3] },
        };
        await user.post('/api/settings/save', settings);
        record('settings', 'POST /api/settings/save', { bytes: JSON.stringify(settings).length, unknownKeys: [MARKERS.legacySetting, MARKERS.extensionSetting] });
        const settingsSurface = surface('settings', 'the whole non-default settings document: personas, presets, prompts, prompt_order, regex, extension state and unknown keys');
        settingsSurface.expected = {
            username: TREE_USER.name,
            persona: personaName,
            theme: THEME_NAME,
            background: backgroundName,
            world: WORLD_NAME,
            preset: PRESET_NAME,
            extensionState: MARKERS.extensionSetting,
            legacyKey: MARKERS.legacySetting,
        };

        // ---- 10. THE PINNED SERVER'S OWN SETTINGS SNAPSHOT, a real API-created backup file.
        await user.post('/api/settings/make-snapshot', {});
        record('settings', 'POST /api/settings/make-snapshot', {});

        // ---- 11. THUMBNAILS ARE GENERATED ON DEMAND. Requesting them through the browser-facing route is what
        // makes the pinned server write its thumbnail cache, so the tree carries the same cache files a browser
        // would have produced; a failure here is recorded but does not fail generation (thumbnails are a cache).
        const thumbnailRequests = [];
        for (const [type, file] of [['avatar', characterSurfaces[0].avatar], ['persona', personaName], ['bg', backgroundName]]) {
            try {
                const response = await user.getBinary(`/thumbnail?type=${encodeURIComponent(type)}&file=${encodeURIComponent(file)}`);
                thumbnailRequests.push({ type, file, status: response.status, contentType: response.contentType, bytes: response.bytes.length });
            } catch (error) {
                thumbnailRequests.push({ type, file, error: String(error?.message ?? error) });
            }
        }
        if (thumbnailRequests.some(entry => entry.status !== 200)) {
            throw new Error(`a /thumbnail request through the logged-in session did not render: ${JSON.stringify(thumbnailRequests).slice(0, 400)}`);
        }
        record('thumbnails', 'GET /thumbnail', { requests: thumbnailRequests.length });
        surfaces.push({ id: 'thumbnails', apiCreated: true, notes: 'the thumbnail route asked to render, so the pinned server writes its own cache', expected: { requests: thumbnailRequests } });

        // ---- 12. STOP THE NODE SERVER. A stopped server is what makes the recorded bytes stable.
        const stopResult = await runtime.stop();
        stopped = true;
        const checkoutAfter = await pinnedCheckoutStatus(pinnedRoot);
        if (checkoutAfter.length > 0) {
            throw new Error(`the pinned checkout was dirtied by generation (it must be read-only):\n${checkoutAfter.join('\n')}`);
        }

        // ---- 13. ASSEMBLE THE QUALIFIED TREE. Installation assets come from this repository's vendored pinned
        // baseline; the DATA comes from the scratch runtime root, minus the pinned server's own regenerable
        // caches, which are named and counted rather than silently dropped.
        await removeWithRetries(out);
        await fs.mkdir(out, { recursive: true });
        for (const area of ['public', 'default']) {
            await copyPlainDirectory(path.join(REPO_ROOT, 'upstream', area), path.join(out, area));
        }
        await copyPlainDirectory(path.join(REPO_ROOT, 'upstream', 'tokenizers'), path.join(out, 'src', 'tokenizers'));
        await fs.mkdir(path.join(out, 'plugins'), { recursive: true });
        await fs.writeFile(path.join(out, 'plugins', '.gitkeep'), '', 'utf8');
        // The config the PINNED SERVER wrote (its startup merge output), not our input document.
        await fs.copyFile(runtimeConfig, path.join(out, 'config.yaml'));

        const excludedDataPaths = [];
        await copyPlainDirectory(runtimeData, path.join(out, 'data'), {
            skip: ['_webpack', '_cache', '_uploads'],
            onSkip: relative => {
                if (!excludedDataPaths.includes(relative)) excludedDataPaths.push(relative);
            },
        });
        // `_uploads` is multer's temp directory: a real install has the directory. It is kept empty.
        await fs.mkdir(path.join(out, 'data', '_uploads'), { recursive: true });

        // ---- 14. SEEDED STATE, labelled. Each item names the reason the pinned API cannot express it.
        const seeded = [];
        const extensionRoot = path.join(out, 'public', 'scripts', 'extensions', 'third-party', EXTENSION_DIR_NAME);
        await writeFileEnsuringDirectory(path.join(extensionRoot, 'manifest.json'), `${JSON.stringify({
            display_name: 'Node Origin Extension',
            loading_order: 100,
            requires: [],
            optional: [],
            js: 'index.js',
            css: 'style.css',
            author: 'GoTavern fixture',
            version: '1.0.0',
            homePage: 'https://example.invalid/node-origin-extension',
        }, null, 4)}\n`);
        await writeFileEnsuringDirectory(path.join(extensionRoot, 'index.js'), [
            '// A third-party extension directory the pinned server cannot install without outbound network.',
            '// The generator seeds it and records it as "seeded, not API-created"; it does nothing.',
            'export function onInstall() {}',
            'export function onEnable() {}',
            'export function onDisable() {}',
            '',
        ].join('\n'));
        await writeFileEnsuringDirectory(path.join(extensionRoot, 'style.css'), '/* node-origin fixture extension */\n');
        await writeFileEnsuringDirectory(path.join(extensionRoot, 'README.md'), '# Node Origin Extension\n\nSeeded by tools/build-node-stock-tree.mjs.\n');
        seeded.push({
            path: `public/scripts/extensions/third-party/${EXTENSION_DIR_NAME}/**`,
            kind: 'third-party extension directory',
            why: 'pinned installs extensions by cloning a git URL (/api/extensions/install), which needs outbound network; the directory carries no .git so the tree hash cannot race a live repository',
        });

        const legacyFlatChat = path.join(out, 'data', TREE_USER.handle, 'chats', 'Legacy Flat Chat - 2024-01-01.jsonl');
        await writeFileEnsuringDirectory(legacyFlatChat, `${JSON.stringify({ user_name: TREE_USER.name, character_name: 'Legacy', chat_metadata: { node_origin_legacy_flat_chat: true } })}\n${JSON.stringify({ name: TREE_USER.name, is_user: true, is_system: false, send_date: '2024-01-01T00:00:00.000Z', mes: 'NODE_ORIGIN_LEGACY_FLAT_CHAT', extra: {} })}\n`);
        seeded.push({
            path: `data/${TREE_USER.handle}/chats/Legacy Flat Chat - 2024-01-01.jsonl`,
            kind: 'legacy flat chat file',
            why: 'pinned /api/chats/save always writes under chats/<card>/, so the pre-directory layout cannot be produced through the API',
        });

        const legacySettingsBackup = path.join(out, 'data', TREE_USER.handle, 'settings.json.bak');
        await writeFileEnsuringDirectory(legacySettingsBackup, `${JSON.stringify({ ...settings, firstRun: true, node_origin_legacy_backup: true }, null, 2)}\n`);
        seeded.push({
            path: `data/${TREE_USER.handle}/settings.json.bak`,
            kind: 'legacy settings backup',
            why: 'the pinned snapshot route writes backups/settings_<handle>_<timestamp>.json; the older settings.json.bak naming cannot be produced alongside it',
        });

        // ---- 15. HASH THE RECORDED TREE. Raw digest over every byte; normalised digest masks ONLY the declared
        // server-stamped values below, and the declarations are data in the report.
        const volatile = {
            pathPatterns: [
                // Account stores and the cookie secret: created at boot, containing `created`/random bytes.
                'data/_storage/*',
                'data/cookie-secret.txt',
                // A group id is String(Date.now()) and names both files (src/endpoints/groups.js).
                `data/${TREE_USER.handle}/groups/*.json`,
                `data/${TREE_USER.handle}/group chats/*.jsonl`,
                // Settings backups are named with generateTimestamp() (src/endpoints/settings.js backupUserSettings).
                `data/${TREE_USER.handle}/backups/*`,
                // Pinned's regenerable caches, present only in the runtime root; recorded here so the exclusion is
                // a declaration, not a silent omission.
                'data/_webpack/**',
                'data/_cache/**',
                'data/_uploads/**',
            ],
            reasons: {
                'data/_storage/*': 'pinned account store records carry the wall-clock `created` value (users-admin.js)',
                'data/cookie-secret.txt': 'pinned generates a random cookie secret at boot (src/users.js)',
                [`data/${TREE_USER.handle}/groups/*.json`]: 'a group id is String(Date.now()) (src/endpoints/groups.js create)',
                [`data/${TREE_USER.handle}/group chats/*.jsonl`]: 'the group-chat file is named by the same generated id',
                [`data/${TREE_USER.handle}/backups/*`]: 'settings backups are named with generateTimestamp() (src/endpoints/settings.js)',
                'data/_webpack/**': 'webpack build cache under <dataRoot>/_webpack (webpack.config.js) -- excluded from the qualified tree, listed here so the exclusion is explicit',
                'data/_cache/**': 'pinned disk cache under <dataRoot>/_cache -- excluded from the qualified tree',
                'data/_uploads/**': 'multer temp directory under <dataRoot>/_uploads -- kept as an empty directory',
            },
            excludedFromTree: excludedDataPaths,
        };
        const { entries } = await walkTreeDetailed(out);
        const treeSha256 = treeDigest(entries);
        const normalisedSha256 = await normalisedTreeDigest(out, entries, { pathPatterns: volatile.pathPatterns });
        // ZERO-BYTE FILES ARE NOT A DEFECT BY THEMSELVES: pinned writes `.gitkeep`-style markers and
        // `sysprompt/.migrated` as empty files, and a rule that refused every empty file would refuse the pinned
        // server's own tree. The qualifier's assertion is therefore narrower and stronger: a file recorded with
        // bytes must still have those bytes (never truncated), and a file recorded empty must still be empty. The
        // empty marker files are NAMED here so a later reader knows they are expected rather than overlooked.
        const emptyMarkerFiles = entries.filter(entry => entry.bytes === 0).map(entry => entry.path);
        const emptyUnexpected = emptyMarkerFiles.filter(relative => !/(^|\/)(\.gitkeep|\.migrated|\.keep)$/.test(relative));
        if (emptyUnexpected.length > 0) {
            throw new Error(`the recorded tree carries ${emptyUnexpected.length} zero-byte file(s) that are not a known marker: ${emptyUnexpected.join(', ')}`);
        }
        const manifest = {
            schemaVersion: 1,
            generator: GENERATOR,
            generatorVersion: GENERATOR_VERSION,
            generatedAt: new Date().toISOString(),
            pinned: { root: pinnedRoot, commit: PINNED_COMMIT, version: PINNED_VERSION },
            user: TREE_USER,
            tree: { root: out, files: entries.length, bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0), sha256: treeSha256, normalisedSha256 },
            volatile,
            entries,
        };

        // ---- 16. COPY INTO THE QUALIFICATION WORKSPACE, if one was named. The reports go BESIDE the tree, never
        // inside it: a manifest file inside the tree would be one more file the runtimes see and the hash covers.
        let workspaceTree = null;
        if (options.workspace) {
            workspaceTree = path.resolve(options.workspace, 'tree');
            await removeWithRetries(workspaceTree);
            await copyTree(out, workspaceTree);
            const copied = await walkTreeDetailed(workspaceTree);
            const copiedDigest = treeDigest(copied.entries);
            if (copiedDigest !== treeSha256) {
                throw new Error(`the workspace copy is not byte-identical to the recorded tree: ${copiedDigest} != ${treeSha256}`);
            }
            await writeJSON(path.resolve(options.workspace, 'tree.manifest.json'), manifest);
        }
        await writeJSON(manifestPath, manifest);

        const report = {
            schemaVersion: 1,
            generator: GENERATOR,
            generatorVersion: GENERATOR_VERSION,
            ok: true,
            pinned: { root: pinnedRoot, commit: PINNED_COMMIT, version: PINNED_VERSION, checkoutCleanBefore: checkoutBefore, checkoutCleanAfter: checkoutAfter },
            tree: {
                root: out, manifest: manifestPath, fileCount: entries.length,
                bytes: manifest.tree.bytes, sha256: treeSha256, normalisedSha256,
                volatilePathPatterns: volatile.pathPatterns, excludedFromTree: excludedDataPaths,
                emptyMarkerFiles,
            },
            user: { ...TREE_USER },
            runtime: {
                port, tempRoot: options.keepRuntime ? runtimeRoot : null,
                stop: stopResult,
                bootLogTail: runtime.logs.join('').slice(-4000),
            },
            surfaces,
            seeded,
            prepared: [
                { path: 'public/**', why: "pinned installation frontend, copied from this repository's vendored pinned baseline (the release archive deliberately does not ship public/)" },
                { path: 'default/**', why: 'pinned installation default content, copied from the vendored pinned baseline' },
                { path: 'src/tokenizers/**', why: 'pinned tokenizer tree, copied from the vendored pinned baseline' },
                { path: 'config.yaml', why: "written by this generator, then REWRITTEN by the pinned server's own src/config-init.js addMissingConfigValues at boot; the recorded file is the server's output" },
                { path: 'plugins/.gitkeep', why: 'stock SillyTavern ships this directory' },
            ],
            counts: {
                users: 2,
                characters: characterSurfaces.length,
                chats: 2,
                groupChats: 1,
                groups: 1,
                worlds: 1,
                worldEntries: Object.keys(world.entries).length,
                presets: 1,
                presetPrompts: preset.prompts.length,
                quickReplies: quickReplies.qrList.length,
                themes: 1,
                backgrounds: 1,
                personas: 1,
                apiOperations: apiOperations.length,
            },
            operations: apiOperations,
            apiCreated: surfaces.map(entry => entry.id),
            seededIds: seeded.map(entry => entry.path),
            timings: { totalMs: Date.now() - started, bootMs },
        };
        await writeJSON(reportPath, report);
        if (!options.quiet) {
            process.stderr.write(`node-stock-tree: ${entries.length} files, ${manifest.tree.bytes} bytes, sha256 ${treeSha256}\n`);
            process.stderr.write(`  normalised sha256 (declared volatile masked): ${normalisedSha256}\n`);
            process.stderr.write(`  user ${TREE_USER.handle}, ${characterSurfaces.length} characters, ${apiOperations.length} API operations, ${seeded.length} seeded item(s)\n`);
            process.stderr.write(`  report: ${reportPath}\n  manifest: ${manifestPath}\n`);
        }
        return { report, manifest, reportPath, manifestPath, workspaceTree, runtimeRoot };
    } catch (error) {
        if (!stopped) {
            try {
                await runtime.stop();
            } catch {
                // The original error is the one worth reporting.
            }
        }
        throw error;
    } finally {
        if (!options.keepRuntime) {
            await removeWithRetries(runtimeRoot).catch(() => {});
        }
    }
}

async function writeFileEnsuringDirectory(target, body) {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, body, 'utf8');
}

// Copy files and (empty) directories, with an explicit skip list whose entries are REPORTED. `fs.cp` is avoided
// because it cannot report what it skipped and does not preserve POSIX modes deterministically on Windows.
async function copyPlainDirectory(source, target, { skip = [], onSkip = null } = {}) {
    const matches = relative => skip.some(pattern => relative === pattern || relative.startsWith(`${pattern}/`));
    const walk = async directory => {
        const children = await fs.readdir(directory, { withFileTypes: true });
        for (const child of children) {
            const full = path.join(directory, child.name);
            const relative = path.relative(source, full).split(path.sep).join('/');
            if (matches(relative)) {
                if (onSkip) onSkip(relative);
                continue;
            }
            const destination = path.join(target, relative);
            if (child.isDirectory()) {
                await fs.mkdir(destination, { recursive: true });
                await walk(full);
            } else if (child.isFile()) {
                await fs.mkdir(path.dirname(destination), { recursive: true });
                await fs.copyFile(full, destination);
                const stat = await fs.stat(full);
                await fs.chmod(destination, stat.mode & 0o777);
            }
        }
    };
    await fs.mkdir(target, { recursive: true });
    await walk(source);
}

// ---------------------------------------------------------------------------------------------------------------
// DETERMINISM SELF-CHECK. A SECOND, independent build must produce the same normalised digest, and the paths that
// differ must be EXACTLY the declared volatile paths. That is the honest claim: the generator is deterministic
// where the pinned server allows, and the instability is named in advance rather than discovered.
// ---------------------------------------------------------------------------------------------------------------
export async function verifyDeterministic({ pinned, out, seed, report }) {
    const first = await readJSON(report);
    const scratchOut = `${out}.rebuild`;
    const scratchReport = `${scratchOut}.report.json`;
    await removeWithRetries(scratchOut);
    const rebuild = await buildNodeStockTree({ pinned, out: scratchOut, seed, report: scratchReport, manifest: `${scratchOut}.manifest.json`, quiet: true });
    const firstManifest = await readJSON(first.tree.manifest ?? `${out}.manifest.json`);
    const secondManifest = rebuild.manifest;
    const firstEntries = new Map(firstManifest.entries.map(entry => [entry.path, entry]));
    const secondEntries = new Map(secondManifest.entries.map(entry => [entry.path, entry]));
    const differing = [];
    for (const [relative, entry] of firstEntries) {
        const other = secondEntries.get(relative);
        if (!other) differing.push({ path: relative, kind: 'missing-in-rebuild' });
        else if (entry.sha256 !== other.sha256) differing.push({ path: relative, kind: 'changed' });
    }
    for (const relative of secondEntries.keys()) {
        if (!firstEntries.has(relative)) differing.push({ path: relative, kind: 'only-in-rebuild' });
    }
    const volatileMatches = relative => firstManifest.volatile.pathPatterns.some(pattern => {
        const regex = new RegExp(`^${pattern.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`);
        return regex.test(relative);
    });
    const undeclared = differing.filter(entry => !volatileMatches(entry.path));
    const result = {
        identicalNormalised: firstManifest.tree.normalisedSha256 === secondManifest.tree.normalisedSha256,
        identicalRaw: firstManifest.tree.sha256 === secondManifest.tree.sha256,
        firstNormalised: firstManifest.tree.normalisedSha256,
        secondNormalised: secondManifest.tree.normalisedSha256,
        differingPaths: differing,
        undeclaredDifferences: undeclared,
        ok: firstManifest.tree.normalisedSha256 === secondManifest.tree.normalisedSha256 && undeclared.length === 0,
    };
    await removeWithRetries(scratchOut);
    await removeWithRetries(`${scratchOut}.manifest.json`).catch(() => {});
    await removeWithRetries(scratchReport).catch(() => {});
    return result;
}

// ---------------------------------------------------------------------------------------------------------------
// CLI.
// ---------------------------------------------------------------------------------------------------------------
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
    const options = parseArguments(process.argv.slice(2));
    if (!options.pinned || !options.out) {
        process.stderr.write('usage: node tools/build-node-stock-tree.mjs --pinned <SillyTavern checkout> --out <tree dir> [--report FILE] [--manifest FILE] [--workspace DIR] [--verify-deterministic] [--keep-runtime] [--quiet]\n');
        process.exit(2);
    }
    try {
        const result = await buildNodeStockTree(options);
        if (options.verifyDeterministic) {
            const determinism = await verifyDeterministic({ pinned: options.pinned, out: options.out, seed: options.seed, report: result.reportPath });
            const report = await readJSON(result.reportPath);
            report.determinism = determinism;
            await writeJSON(result.reportPath, report);
            if (!options.quiet) {
                process.stderr.write(`  determinism: ${determinism.ok ? 'OK' : 'FAILED'} (raw ${determinism.identicalRaw ? 'identical' : 'differs'}, normalised ${determinism.identicalNormalised ? 'identical' : 'DIFFERS'}, ${determinism.differingPaths.length} path(s) differ, ${determinism.undeclaredDifferences.length} undeclared)\n`);
            }
            if (!determinism.ok) process.exit(1);
        }
        process.stdout.write(`${JSON.stringify({
            ok: true,
            tree: result.report.tree,
            report: result.reportPath,
            manifest: result.manifestPath,
            workspace: result.workspaceTree,
            counts: result.report.counts,
        })}\n`);
    } catch (error) {
        process.stderr.write(`node-stock-tree: FAILED: ${error?.stack ?? error}\n`);
        process.exit(1);
    }
}
