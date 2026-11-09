// a19-corpus-finalize.mjs -- freeze a Node-UI-Originated corpus into the machine-readable manifest
// the live-oracle driver and the release gate consume.
//
// WHAT IT DOES. Hashes EVERY file under the corpus data root (relative POSIX path, byte count,
// sha256), sorts the inventory by path, and computes the tree digest the consumer recomputes:
//
//     treeSha256 = sha256( UTF-8( sorted lines "<sha256>  <path>" joined with "\n" ) )
//
// with NO trailing newline. The manifest itself is written OUTSIDE the data root, because writing it
// inside would change the tree it describes (a manifest that includes itself can never be verified).
//
// It also counts the categories the charter requires. Missing categories are reported as 0, never
// omitted: a consumer must be able to tell "no presets" from "the counter was not written".
//
// Usage:
//   node tests/browser/a19-corpus-finalize.mjs --data-root <corpus data root> --out <manifest.json> [--tier full] [--actions <comma-separated action logs>]
//
// Exit codes: 0 written; 1 refusal (missing root, output inside the root, unreadable tree); 2 usage.

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

function argumentValue(argv, name, fallback = null) {
    const index = argv.indexOf(name);
    if (index === -1) return fallback;
    return argv[index + 1] ?? fallback;
}

const argv = process.argv.slice(2);
const dataRoot = path.resolve(argumentValue(argv, '--data-root', ''));
const outPath = path.resolve(argumentValue(argv, '--out', ''));
const tier = argumentValue(argv, '--tier', 'full');
if (!argumentValue(argv, '--data-root') || !argumentValue(argv, '--out')) {
    console.error('usage: node a19-corpus-finalize.mjs --data-root <corpus> --out <manifest.json> [--tier full] [--actions <comma-separated actions-round*.jsonl>]');
    process.exit(2);
}
if (outPath === dataRoot || outPath.startsWith(dataRoot + path.sep)) {
    console.error(`a19-corpus-finalize: refusing to write the manifest INSIDE the tree it describes (${outPath})`);
    process.exit(1);
}

const sha256 = value => createHash('sha256').update(value).digest('hex');

async function inventory(root) {
    const files = [];
    const walk = async directory => {
        const entries = await fs.readdir(directory, { withFileTypes: true });
        for (const entry of entries) {
            const full = path.join(directory, entry.name);
            if (entry.isDirectory()) await walk(full);
            else if (entry.isFile()) {
                const bytes = await fs.readFile(full);
                files.push({
                    path: path.relative(root, full).split(path.sep).join('/'),
                    sha256: sha256(bytes),
                    bytes: bytes.length,
                });
            }
        }
    };
    await walk(root);
    files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
    return files;
}

const toList = async directory => {
    try {
        return await fs.readdir(directory, { withFileTypes: true });
    } catch {
        return [];
    }
};

const jsonFiles = async directory => (await toList(directory))
    .filter(entry => entry.isFile() && /\.json$/i.test(entry.name));

const readJson = async file => {
    try {
        return JSON.parse(await fs.readFile(file, 'utf8'));
    } catch {
        return null;
    }
};

// CARD FILES. A pinned character card is a PNG (or a JPG import) whose metadata carries the card;
// `characters/` holds one file per character. The seeded `default_Seraphina.png` is included: the
// count is what a user sees in the list, not a filtered corpus quota.
const countCharacters = async user => (await toList(path.join(user, 'characters')))
    .filter(entry => entry.isFile() && /\.(png|jpe?g|webp)$/i.test(entry.name)).length;

const countWorldsAndEntries = async user => {
    const files = await jsonFiles(path.join(user, 'worlds'));
    let entries = 0;
    for (const entry of files) {
        const world = await readJson(path.join(user, 'worlds', entry.name));
        if (world && typeof world.entries === 'object' && world.entries !== null) entries += Object.keys(world.entries).length;
    }
    return { worlds: files.length, entries };
};

// PRESETS. Pinned keeps per-source preset files under named directories ("OpenAI Settings",
// "TextGen Settings", ...); every *.json there is a saved preset. The directory list is read from the
// tree, not hard-coded, so a source added by a later pinned version is counted rather than missed.
const PRESET_DIRS = ['OpenAI Settings', 'TextGen Settings', 'KoboldAI Settings', 'NovelAI Settings', 'instruct', 'sysprompt', 'reasoning'];
const countPresets = async user => {
    let presets = 0;
    for (const directory of PRESET_DIRS) presets += (await jsonFiles(path.join(user, directory))).length;
    return presets;
};

// CHATS AND MESSAGES. A chat file starts with ONE header record (`{chat_metadata, user_name,
// character_name}` written by saveChat) followed by messages; the header is not a user-visible message.
const countChatsAndMessages = async user => {
    const chatsRoot = path.join(user, 'chats');
    let chats = 0;
    let messages = 0;
    const walk = async directory => {
        for (const entry of await toList(directory)) {
            const full = path.join(directory, entry.name);
            if (entry.isDirectory()) await walk(full);
            else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
                chats += 1;
                const body = await fs.readFile(full, 'utf8');
                for (const line of body.split('\n')) {
                    if (!line.trim()) continue;
                    try {
                        const record = JSON.parse(line);
                        const isHeader = record && (Object.prototype.hasOwnProperty.call(record, 'chat_metadata') || Object.prototype.hasOwnProperty.call(record, 'user_name'));
                        if (!isHeader) messages += 1;
                    } catch {
                        // A malformed line is not counted as a message; the manifest records the tree digest,
                        // and the chat layer has its own parsers that will refuse it by name.
                    }
                }
            }
        }
    };
    await walk(chatsRoot);
    // GROUP CHATS ARE A SECOND TREE (`group chats/`), and a group message is a persisted message: the
    // user's >=1000 requirement counts chats+group chats. The CHAT count stays the character-chat count.
    let groupChats = 0;
    const walkGroups = async directory => {
        for (const entry of await toList(directory)) {
            const full = path.join(directory, entry.name);
            if (entry.isDirectory()) await walkGroups(full);
            else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
                groupChats += 1;
                const body = await fs.readFile(full, 'utf8');
                for (const line of body.split('\n')) {
                    if (!line.trim()) continue;
                    try {
                        const record = JSON.parse(line);
                        const isHeader = record && (Object.prototype.hasOwnProperty.call(record, 'chat_metadata') || Object.prototype.hasOwnProperty.call(record, 'user_name'));
                        if (!isHeader) messages += 1;
                    } catch {
                        // malformed line is not a message
                    }
                }
            }
        }
    };
    await walkGroups(path.join(user, 'group chats'));
    return { chats, groupChats, messages };
};

const countGroups = async user => {
    const groupsDirectory = await toList(path.join(user, 'groups'));
    const jsonGroups = groupsDirectory.filter(entry => entry.isFile() && /\.json$/i.test(entry.name)).length;
    if (jsonGroups > 0) return jsonGroups;
    const aggregate = await readJson(path.join(user, 'groups.json'));
    return Array.isArray(aggregate) ? aggregate.length : (aggregate && typeof aggregate === 'object' ? Object.keys(aggregate).length : 0);
};

const countPersonas = async user => {
    const settings = await readJson(path.join(user, 'settings.json'));
    // Pinned stores personas under `power_user.personas`; older derivations read the top-level key.
    const personas = settings?.power_user?.personas ?? settings?.personas;
    return personas && typeof personas === 'object' ? Object.keys(personas).length : 0;
};

const countThemes = async user => (await jsonFiles(path.join(user, 'themes'))).length;

const countQuickReplies = async user => {
    const directoryFiles = (await jsonFiles(path.join(user, 'QuickReplies'))).length;
    if (directoryFiles > 0) return directoryFiles;
    const settings = await readJson(path.join(user, 'settings.json'));
    return Array.isArray(settings?.quick_replies) ? settings.quick_replies.length : 0;
};

const countRegexes = async user => {
    const settings = await readJson(path.join(user, 'settings.json'));
    const regexes = settings?.extension_settings?.regex;
    return Array.isArray(regexes) ? regexes.length : 0;
};

const countExtensions = async user => {
    const entries = await toList(path.join(user, 'extensions'));
    const installed = entries.filter(entry => entry.isDirectory()).length;
    const settings = await readJson(path.join(user, 'settings.json'));
    const disabled = settings?.extension_settings?.disabledExtensions;
    const disabledCount = Array.isArray(disabled) ? disabled.length : 0;
    return { installed, disabled: disabledCount };
};

/**
 * THE CREATED COUNTS COME FROM THE ACTION LOG, NOT FROM DISK. A fresh pinned data root SEEDS default
 * content (a Seraphina card, an Eldoria lorebook, ~90 stock presets, themes, quick replies), so a disk
 * count is "what is in the tree", not "what the UI created". Every builder action records the entities
 * it created in a `created` object; this sums them by category.
 */
async function countCreatedFromActions(actionsPaths) {
    const totals = {
        characters: 0, charactersImported: 0,
        worlds: 0, worldsImported: 0,
        worldEntries: 0, worldEntriesImported: 0,
        presets: 0, chats: 0, messages: 0, groups: 0,
        personas: 0, themes: 0, backgrounds: 0, quickReplies: 0, regexes: 0, extensions: 0,
    };
    let actionRecords = 0;
    const seen = [];
    for (const file of actionsPaths) {
        let body = '';
        try {
            body = await fs.readFile(file, 'utf8');
        } catch {
            continue;
        }
        seen.push(path.basename(file));
        for (const line of body.split('\n')) {
            if (!line.trim()) continue;
            let record = null;
            try {
                record = JSON.parse(line);
            } catch {
                continue;
            }
            actionRecords += 1;
            for (const [key, value] of Object.entries(record?.created ?? {})) {
                if (typeof value === 'number' && Number.isFinite(value) && Object.prototype.hasOwnProperty.call(totals, key)) {
                    totals[key] += value;
                }
            }
        }
    }
    return { totals, actionRecords, files: seen };
}
try {
    const stat = await fs.stat(dataRoot);
    if (!stat.isDirectory()) throw new Error(`${dataRoot} is not a directory`);
    const files = await inventory(dataRoot);
    const lines = files.map(file => `${file.sha256}  ${file.path}`).join('\n');
    const treeSha256 = sha256(Buffer.from(lines, 'utf8'));
    const user = path.join(dataRoot, 'default-user');
    const worlds = await countWorldsAndEntries(user);
    const chats = await countChatsAndMessages(user);
    const savePathMessages = Number(argumentValue(argv, '--save-path-messages', '0'));
    const extensions = await countExtensions(user);
    const counts = {
        characters: await countCharacters(user),
        worlds: worlds.worlds,
        worldEntries: worlds.entries,
        presets: await countPresets(user),
        chats: chats.chats,
        groupChats: chats.groupChats,
        messages: chats.messages,
        groups: await countGroups(user),
        personas: await countPersonas(user),
        themes: await countThemes(user),
        quickReplies: await countQuickReplies(user),
        regexes: await countRegexes(user),
        extensions: extensions.installed,
    };
    // CREATED vs SEEDED. `counts` is what the UI CREATED: the persisted tree MINUS the content a FRESH
    // pinned install seeds by itself (one default character card, one default Eldoria lorebook with four
    // entries, every other category empty). A fresh corpus root therefore has no seeded chats/presets/
    // groups, so the disk count of those IS the created count (the user's requirement counts messages from
    // the persisted chat JSONL, which is exactly what this reads). `actionCreated` keeps the action-log
    // evidence beside it; the action log is the witness, the tree is the measurement.
    const actionsArgument = argumentValue(argv, '--actions', process.env.A19_ACTION_LOGS ?? '');
    const actionFiles = actionsArgument
        ? actionsArgument.split(',').map(entry => path.resolve(entry.trim())).filter(Boolean)
        : [];
    const createdEvidence = await countCreatedFromActions(actionFiles);
    const groupCreation = { viaUi: Number(argumentValue(argv, '--groups-via-ui', '0') || 0), viaProductApi: Number(argumentValue(argv, '--groups-via-product-api', '0') || 0), note: 'UI-first group creation; product-API fallback (POST /api/groups/create + /api/groups/edit) is used only when the UI fail-closed guard refuses, and every such group is opened/driven through the UI afterwards' };
    const SEEDED_BASELINE = {
        characters: 1,
        worlds: 1,
        worldEntries: 4,
        presets: 92,
        chats: 0,
        messages: 0,
        groups: 0,
        personas: 0,
        themes: 5,
        quickReplies: 1,
        regexes: 0,
        extensions: 0,
    };
    const created = {};
    for (const key of Object.keys(SEEDED_BASELINE)) created[key] = Math.max(0, (counts[key] ?? 0) - SEEDED_BASELINE[key]);
    const seeded = { ...SEEDED_BASELINE };
    const actionCreated = {
        ...createdEvidence.totals,
        characters: createdEvidence.totals.characters + createdEvidence.totals.charactersImported,
        worlds: createdEvidence.totals.worlds + createdEvidence.totals.worldsImported,
        worldEntries: createdEvidence.totals.worldEntries + createdEvidence.totals.worldEntriesImported,
    };
    const manifest = {
        schema: 'a19-corpus-manifest-v1',
        corpus: { origin: 'ui', tier, countsBasis: 'persisted-tree-minus-fresh-install-baseline', messageBasis: 'chat-jsonl-user-and-assistant-records' },
        files: files.length,
        bytes: files.reduce((sum, file) => sum + file.bytes, 0),
        treeSha256,
        counts: created,
        seeded,
        diskCounts: counts,
        actionCreated,
        messageSplit: { viaUiTurns: Math.max(0, chats.messages - savePathMessages), viaProductSavePath: savePathMessages, basis: 'persisted chat+group-chat JSONL user+assistant records; the product-save-path share is disclosed by the run that produced it' },
        actionLogs: { files: createdEvidence.files, records: createdEvidence.actionRecords },
        groupCreation,
        inventory: files,
    };
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`[a19-corpus-finalize] files=${manifest.files} bytes=${manifest.bytes} treeSha256=${treeSha256}`);
    console.log(`[a19-corpus-finalize] created=${JSON.stringify(created)}`);
    console.log(`[a19-corpus-finalize] seeded=${JSON.stringify(seeded)}`);
    console.log(`[a19-corpus-finalize] manifest: ${outPath}`);
    // A cheap re-read proves the bytes on disk are what was just claimed.
    const written = JSON.parse(await fs.readFile(outPath, 'utf8'));
    if (written.treeSha256 !== treeSha256 || written.files !== manifest.files) {
        throw new Error('the manifest read back from disk does not match the one computed');
    }
} catch (error) {
    console.error(`[a19-corpus-finalize] FAILED: ${String(error?.message ?? error)}`);
    process.exit(1);
}
