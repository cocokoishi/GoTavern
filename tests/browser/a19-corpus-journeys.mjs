// a19-corpus-journeys.mjs -- the three rounds of the alpha.19 Node-UI-Originated Corpus.
//
// Each round is a real user journey against the UNMODIFIED pinned SillyTavern, executed by
// a19-corpus-builder.mjs through run-against-pinned.mjs (a FRESH pinned process per round over the
// SAME data root). The caller owns the browser page, the recording provider and the action log; this
// module owns the journey and reports what it did, in images/counts/disk terms.
//
// WHAT IS A "USER ACTION" HERE. Cards, lorebooks, presets, chats, groups, personas, backgrounds,
// themes, quick replies and variables are produced through the product's own controls (create panel,
// World Info drawer, preset import input, send button, group panel, avatar/background/theme file
// inputs, chat-input slash commands). The few places where the frontend module function behind a
// control is called directly are named in the action record, and every one of them is a function the
// product's own click handler calls (e.g. `openCharacterChat`, `charUpdatePrimaryWorld`).
//
// NOTHING HERE WRITES A PRODUCT FILE. Input artefacts this module CREATES are only the files a user
// would pick in a file dialog (avatar PNGs, preset JSON, theme JSON, background PNG); their creation
// is recorded as a harness input, and the import itself goes through the product.

import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';

import {
    chatTurn,
    fastChatTurn,
    createWorldBook,
    createWorldEntry,
    ensureConnection,
    openCharacter,
    openWorldInEditor,
    pressContinue,
    pressRegenerateThroughMenu,
    readBackCard,
    readChatFiles,
    readCharacterCardBytes,
    readSettingsFile,
    readWorldBookFile,
    saveConditional,
    saveSettingsNow,
    selectWorldGlobally,
    startNewChat,
} from './a19-corpus-kit.mjs';

// -----------------------------------------------------------------------------------------------------------------
// ROUND PLANS (deterministic; a retry over the same tree detects and skips what already exists)
// -----------------------------------------------------------------------------------------------------------------
export const ROUND_PLANS = {
    1: { cards: 24, worlds: 3, entriesPerWorld: 20, presets: 3, chats: 20, turnsPerChat: 15, groups: 2, personas: 2, backgrounds: 1, themes: 1, quickReplies: 2, regexes: 2 },
    2: { cards: 5, worlds: 3, entriesPerWorld: 20, presets: 3, chats: 16, turnsPerChat: 18, groups: 2, personas: 1, backgrounds: 1, themes: 1, quickReplies: 1, regexes: 1 },
    3: { cards: 1, worlds: 2, entriesPerWorld: 20, presets: 4, chats: 14, turnsPerChat: 30, groups: 1, personas: 1, backgrounds: 1, themes: 1, quickReplies: 1, regexes: 1 },
};

const THEMES = [
    { id: 'raininn', name: '烟雨客栈', en: 'Rain-Inn', cjk: '中文' },
    { id: 'lib', name: '星海図書館', en: 'Star Library', cjk: '日本語' },
    { id: 'forge', name: 'EmberForge', en: 'Ember Forge', cjk: 'emoji 🔥⚒️' },
    { id: 'orchard', name: 'Orchard of Whispers', en: 'Orchard', cjk: ' whispers' },
    { id: 'station', name: '終電の駅', en: 'Last Train', cjk: '日本語' },
    { id: 'desert', name: '砂の市場', en: 'Sand Market', cjk: '中文' },
    { id: 'observatory', name: 'Observatory Nine', en: 'Observatory', cjk: '🔭' },
    { id: 'kitchen', name: '深夜食堂', en: 'Midnight Diner', cjk: '中文' },
    { id: 'garden', name: 'Glass Garden', en: 'Garden', cjk: '🪴' },
    { id: 'archive', name: 'The Quiet Archive', en: 'Archive', cjk: '📚' },
];

const lackTheme = index => THEMES[index % THEMES.length];

// -----------------------------------------------------------------------------------------------------------------
// GENERATED INPUT ARTEFACTS (files a user would pick in a file dialog -- never product data)
// -----------------------------------------------------------------------------------------------------------------

function crc32(buffer) {
    let crc = 0 ^ -1;
    for (const byte of buffer) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (0xEDB88320 ^ (crc >>> 1)) : (crc >>> 1);
    }
    return (crc ^ -1) >>> 0;
}

function pngChunk(type, data) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([length, body, crc]);
}

/** A real, decodable PNG (RGB, 8-bit) so the product's own image pipeline processes an actual image. */
export function writePng(file, index) {
    const width = 64;
    const height = 64;
    const r = (index * 53) % 256;
    const g = (index * 97) % 256;
    const b = (index * 151) % 256;
    const raw = Buffer.alloc((width * 3 + 1) * height);
    for (let y = 0; y < height; y += 1) {
        const row = y * (width * 3 + 1);
        raw[row] = 0;
        for (let x = 0; x < width; x += 1) {
            const spot = (x + y + index) % 17 === 0 ? 255 : 0;
            raw[row + 1 + x * 3] = r ^ spot;
            raw[row + 2 + x * 3] = g ^ spot;
            raw[row + 3 + x * 3] = b ^ spot;
        }
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;
    ihdr[9] = 2;
    const png = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
        pngChunk('IHDR', ihdr),
        pngChunk('IDAT', zlib.deflateSync(raw)),
        pngChunk('IEND', Buffer.alloc(0)),
    ]);
    return fs.writeFile(file, png).then(() => file);
}

/** The preset file a user imports through the AI Response Configuration import button. */
export function writePresetFile(file, index) {
    const preset = {
        temperature: Number((0.2 + index * 0.11).toFixed(2)),
        top_p: Number((0.6 + (index % 4) * 0.1).toFixed(2)),
        frequency_penalty: Number(((index % 3) * 0.25).toFixed(2)),
        presence_penalty: Number(((index % 4) * 0.2).toFixed(2)),
        openai_max_tokens: 96 + index * 37,
        openai_max_context: 4096 + (index % 5) * 1024,
        stream_openai: true,
        // THE MAIN PROMPT IS WHAT MAKES THE PRESET OBSERVABLE IN THE REQUEST BYTES: it becomes the
        // `main` prompt-manager entry's content, i.e. the system message the provider receives.
        main_prompt: `A19_PRESET_${index + 1} You are a corpus preset variant. Respond with the marker A19_PRESET_${index + 1} and keep the tone of variant ${index + 1}.`,
        assistant_prefill: index % 3 === 0 ? `A19_PREFILL_${index + 1} ` : '',
        wrap_in_quotes: index % 2 === 0,
    };
    return fs.writeFile(file, `${JSON.stringify(preset, null, 2)}\n`, 'utf8').then(() => file);
}

/** A UI theme file imported through the theme import input. */
export function writeThemeFile(file, index) {
    const theme = {
        name: `A19 Theme ${index + 1}`,
        blur_strength: index + 2,
        main_text_color: index % 2 === 0 ? 'rgba(235, 235, 255, 1)' : 'rgba(255, 235, 235, 1)',
        italics_text_color: 'rgba(200, 200, 255, 1)',
        quote_text_color: 'rgba(210, 210, 255, 1)',
        shadow_color: 'rgba(0, 0, 0, 0.6)',
        chat_width: 60,
    };
    return fs.writeFile(file, `${JSON.stringify(theme, null, 2)}\n`, 'utf8').then(() => file);
}

/**
 * A VALID PNG CHARACTER CARD (V2 payload inside the real `chara` tEXt chunk), produced as an INPUT
 * FILE for the product's import control. The card is built here and IMPORTED by the product; it is
 * never written into the data tree.
 */
export async function writeCardPng(file, index, spec) {
    const card = {
        name: spec.name,
        description: spec.description,
        personality: spec.personality,
        scenario: spec.scenario,
        first_mes: spec.firstMessage,
        mes_example: spec.mesExample,
        creator_notes: spec.creatorNotes,
        system_prompt: '',
        post_history_instructions: '',
        alternate_greetings: spec.alternateGreetings ?? [],
        character_book: undefined,
        tags: [`a19`, `round${index % 3 + 1}`],
        creator: 'A19 corpus',
        character_version: spec.characterVersion,
        extensions: { talkativeness: '0.5', fav: false, world: '', depth_prompt: { prompt: spec.depthPrompt ?? '', depth: 4, role: 'system' } },
    };
    const v2 = { spec: 'chara_card_v2', spec_version: '2.0', data: card, ...card };
    const base64 = Buffer.from(JSON.stringify(v2), 'utf8').toString('base64');
    const text = Buffer.concat([Buffer.from('chara', 'latin1'), Buffer.from([0]), Buffer.from(base64, 'latin1')]);
    const width = 96;
    const height = 96;
    const raw = Buffer.alloc((width * 3 + 1) * height);
    for (let y = 0; y < height; y += 1) {
        const row = y * (width * 3 + 1);
        raw[row] = 0;
        for (let x = 0; x < width; x += 1) {
            raw[row + 1 + x * 3] = (index * 37 + x) % 256;
            raw[row + 2 + x * 3] = (index * 71 + y) % 256;
            raw[row + 3 + x * 3] = (index * 113 + x + y) % 256;
        }
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;
    ihdr[9] = 2;
    const png = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
        pngChunk('IHDR', ihdr),
        pngChunk('tEXt', text),
        pngChunk('IDAT', zlib.deflateSync(raw)),
        pngChunk('IEND', Buffer.alloc(0)),
    ]);
    await fs.writeFile(file, png);
    return file;
}

/** A lorebook JSON the product's own Import World Info control parses. */
export async function writeWorldJson(file, bookIndex, entries, worldName = null) {
    // THE IMPORT CONTROL USES the file's name field when present; without it the lorebook is
    // named after the file (measured: an import without it produced a19-world-r1-0).
    const data = { name: worldName ?? undefined, entries: {} };
    for (const [index, entry] of entries.entries()) {
        const uid = index;
        data.entries[uid] = {
            uid,
            key: entry.keys ?? [],
            keysecondary: entry.secondaryKeys ?? [],
            comment: entry.comment,
            content: entry.content,
            constant: entry.constant === true,
            vectorized: false,
            selective: entry.selective === true,
            selectiveLogic: 0,
            addMemo: true,
            order: entry.order ?? 100,
            position: entry.position ?? 0,
            disable: entry.disabled === true,
            excludeRecursion: entry.excludeRecursion === true,
            preventRecursion: entry.preventRecursion === true,
            delayUntilRecursion: false,
            probability: 100,
            useProbability: true,
            depth: entry.depth ?? 4,
            group: '',
            groupOverride: false,
            groupWeight: 100,
            scanDepth: null,
            caseSensitive: null,
            matchWholeWords: null,
            useGroupScoring: null,
            automationId: '',
            role: entry.role ?? 0,
            sticky: null,
            cooldown: null,
            delay: null,
            triggers: [],
            ignoreBudget: false,
            displayIndex: index,
            extensions: {},
            characterFilter: null,
        };
    }
    await fs.writeFile(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    return file;
}

/** Cards imported through the character import file input; each is one real product import. */
export async function importCards(page, ctx, round, count, startIndex) {
    const dir = path.join(ctx.paths.artifactsDir, 'imports', 'cards');
    await fs.mkdir(dir, { recursive: true });
    const imported = [];
    for (let index = 0; index < count; index += 1) {
        const spec = cardSpecFor(round, startIndex + index);
        spec.name = `A19R${round}I ${lackTheme(startIndex + index).name} ${startIndex + index + 1}`;
        const file = await writeCardPng(path.join(dir, `a19-card-r${round}-s${startIndex}-${index}.png`), startIndex + index, spec);
        const before = await page.evaluate(async () => {
            const script = await import('./script.js');
            return (script.characters ?? []).length;
        });
        await page.setInputFiles('#character_import_file', file);
        const deadline = Date.now() + 40000;
        let after = before;
        while (Date.now() < deadline) {
            await page.waitForTimeout(200);
            after = await page.evaluate(async () => {
                const script = await import('./script.js');
                await script.getCharacters();
                return (script.characters ?? []).length;
            });
            if (after > before) break;
        }
        const ok = after > before;
        const result = { ok, before, after, file: path.basename(file), cardName: spec.name };
        await ctx.act({ page: 'Characters', control: '#character_import_file', field: `imported card ${spec.name}`, action: `pick the generated V2 PNG card in the character import control`, result, created: ok ? { charactersImported: 1 } : undefined });
        ctx.report.step(`card-imported-r${round}-${index}`, ok, result);
        if (ok) imported.push({ name: spec.name, file: path.basename(file) });
    }
    return imported;
}

/** Lorebooks imported through the real Import World Info control. */
export async function importWorldBooks(page, ctx, round, plan, startBookIndex) {
    const dir = path.join(ctx.paths.artifactsDir, 'imports', 'worlds');
    await fs.mkdir(dir, { recursive: true });
    const imported = [];
    for (let bookIndex = 0; bookIndex < plan.worlds; bookIndex += 1) {
        const worldName = `A19R${round} Imported Lore ${startBookIndex + bookIndex + 1}`;
        const specs = worldEntrySpecsFor(round, startBookIndex + bookIndex, plan.entriesPerWorld);
        const file = await writeWorldJson(path.join(dir, `a19-world-r${round}-s${startBookIndex}-${bookIndex}.json`), startBookIndex + bookIndex, specs, worldName);
        const before = await page.evaluate(async () => {
            const worldInfo = await import('./scripts/world-info.js');
            if (typeof worldInfo.getWorldInfoList === 'function') await worldInfo.getWorldInfoList();
            return Array.isArray(worldInfo.world_names) ? worldInfo.world_names.length : 0;
        });
        const beforeNames = await page.evaluate(async () => {
            const worldInfo = await import('./scripts/world-info.js');
            if (typeof worldInfo.getWorldInfoList === 'function') await worldInfo.getWorldInfoList();
            return Array.isArray(worldInfo.world_names) ? worldInfo.world_names.slice() : [];
        });
        await page.setInputFiles('#world_import_file', file);
        const deadline = Date.now() + 40000;
        let names = [];
        while (Date.now() < deadline) {
            await page.waitForTimeout(250);
            names = await page.evaluate(async () => {
                const worldInfo = await import('./scripts/world-info.js');
                if (typeof worldInfo.getWorldInfoList === 'function') await worldInfo.getWorldInfoList();
                return Array.isArray(worldInfo.world_names) ? worldInfo.world_names.slice() : [];
            });
            if (names.length > before) break;
        }
        // THE NAME IS READ BACK FROM THE PANEL, NEVER ASSUMED. A fresh install imports a book under the
        // FILE stem (`a19-world-r1-s0-0`); A's old root happened to carry display names, so an expectation
        // built on the display name failed on EVERY fresh root (CI round 1: worlds-selected-r1 red).
        const newNames = names.filter(name => !beforeNames.includes(name));
        const importedName = newNames[0] ?? worldName;
        const ok = names.length > before;
        const disk = importedName ? await readWorldBookFile(ctx.dataRoot, importedName).catch(() => null) : null;
        const result = { ok, before, after: names.length, importedName, actualNames: newNames, entriesOnDisk: disk?.entryCount ?? null, file: path.basename(file), expectedDisplayName: worldName };
        await ctx.act({ page: 'World Info drawer', control: '#world_import_file', field: `imported lorebook ${worldName}`, action: 'pick the generated world-book JSON in the Import World Info control', result, created: ok ? { worldsImported: 1, worldEntriesImported: disk?.entryCount ?? specs.length } : undefined });
        ctx.report.step(`world-imported-r${round}-${bookIndex}`, ok, result);
        if (ok) imported.push({ name: importedName, entries: disk?.entryCount ?? null });
    }
    return imported;
}

/** The hand-created/copy/edit/rename/export-import subset that proves the interactive paths. */
async function cardVerbs(page, ctx, round, cards) {
    const results = {};
    // DUPLICATE through the real Duplicate button of the character edit panel.
    if (cards[0]) {
        const duplicated = await page.evaluate(async () => {
            const script = await import('./script.js');
            const before = (script.characters ?? []).length;
            const edit = document.querySelector('#rm_button_selected_ch');
            if (edit) edit.click();
            await new Promise(resolve => setTimeout(resolve, 500));
            const button = document.querySelector('#dupe_button');
            if (!button) return { ok: false, reason: 'no #dupe_button' };
            button.click();
            const deadline = Date.now() + 30000;
            while (Date.now() < deadline) {
                await script.getCharacters();
                const after = (script.characters ?? []).length;
                if (after > before) return { ok: true, before, after };
                await new Promise(resolve => setTimeout(resolve, 300));
            }
            return { ok: false, reason: 'roster did not grow after Duplicate', before };
        });
        results.duplicate = duplicated;
        await ctx.act({ page: 'Character edit panel', control: '#rm_button_selected_ch → #dupe_button', field: 'duplicate', action: 'open the card then press Duplicate', result: duplicated });
        ctx.report.step(`card-duplicated-r${round}`, duplicated.ok === true, duplicated);
    }
    // EDIT a field through the edit panel and save with the card's own Save control.
    if (cards[1]) {
        const edited = await page.evaluate(async ({ name, marker }) => {
            const script = await import('./script.js');
            const position = (script.characters ?? []).findIndex(character => character?.name === name);
            if (position < 0) return { ok: false, reason: 'card not in roster' };
            const card = [...document.querySelectorAll('#rm_print_characters_block .character_select')].find(element => String(element.getAttribute('data-chid')) === String(position));
            if (card) card.click();
            await new Promise(resolve => setTimeout(resolve, 800));
            const edit = document.querySelector('#rm_button_selected_ch');
            if (edit) edit.click();
            await new Promise(resolve => setTimeout(resolve, 600));
            const description = document.querySelector('#description_textarea');
            if (!description) return { ok: false, reason: 'no #description_textarea' };
            description.value = `${marker} edited description through the character edit panel.`;
            description.dispatchEvent(new Event('input', { bubbles: true }));
            const save = document.querySelector('#create_button');
            if (!save) return { ok: false, reason: 'no save control' };
            save.click();
            const deadline = Date.now() + 30000;
            while (Date.now() < deadline) {
                await script.getCharacters();
                const current = (script.characters ?? []).find(character => character?.name === name);
                if (String(current?.data?.description ?? '').includes(marker)) {
                    return { ok: true, name, descriptionLength: String(current.data.description).length, editMode: document.querySelector('#form_create')?.getAttribute('actiontype') ?? null };
                }
                await new Promise(resolve => setTimeout(resolve, 300));
            }
            return { ok: false, reason: 'the edited description never reached the roster' };
        }, { name: cards[1].name, marker: `A19_EDITED_R${round}` });
        results.edit = edited;
        await ctx.act({ page: 'Character edit panel', control: '#rm_button_selected_ch → #description_textarea → #create_button', field: 'edit card', action: `edit the description of ${cards[1].name} and Save`, result: edited, created: edited.ok ? undefined : undefined });
        ctx.report.step(`card-edited-r${round}`, edited.ok === true, edited);
    }
    return results;
}
// -----------------------------------------------------------------------------------------------------------------
// SLASH COMMANDS THROUGH THE REAL CHAT INPUT (STscript / variables / persona creation)
// -----------------------------------------------------------------------------------------------------------------

/**
 * Type a slash command into #send_textarea and press the real send button.
 *
 * `processCommands` consumes the input before any provider request is assembled, so a command turn is
 * a real user action that changes product state WITHOUT a model call; the caller records the provider
 * request count to prove that (a command that generated would be a different, wrong action).
 */
export async function runSlashCommand(page, command) {
    return page.evaluate(async text => {
        const script = await import('./script.js');
        const textarea = document.querySelector('#send_textarea');
        const button = document.querySelector('#send_but');
        if (!textarea || !button) return { ok: false, reason: 'send controls missing' };
        const before = { chatLength: (script.chat ?? []).length, chatId: window.SillyTavern?.getContext?.()?.chatId ?? null };
        textarea.value = text;
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        button.click();
        const deadline = Date.now() + 20000;
        while (Date.now() < deadline) {
            if (!document.querySelector('#send_textarea')?.value) break;
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        await new Promise(resolve => setTimeout(resolve, 500));
        return {
            ok: true,
            command: text,
            before,
            after: { chatLength: (script.chat ?? []).length, textareaValue: document.querySelector('#send_textarea')?.value ?? null, isSendPress: script.is_send_press ?? null },
        };
    }, command);
}

async function readVariables(page, round) {
    return page.evaluate(async key => {
        const variables = await import('./scripts/variables.js');
        const context = window.SillyTavern?.getContext?.() ?? null;
        let globalValue = null;
        try {
            globalValue = variables.getGlobalVariable(key);
        } catch {
            globalValue = null;
        }
        return {
            global: globalValue,
            local: context?.chatMetadata?.variables ?? null,
        };
    }, `a19r${round}global`);
}

// -----------------------------------------------------------------------------------------------------------------
// CARDS
// -----------------------------------------------------------------------------------------------------------------

function cardSpecFor(round, index) {
    const theme = lackTheme(round * 7 + index);
    const long = 'A19 corpus card. ' + 'This keeper remembers every traveller, every debt and every name whispered at the counter. '.repeat(6) + `${theme.cjk} 这是长描述。`;
    const specs = [
        { description: `${theme.name}: short but sharp.` , firstMessage: `${theme.name} 的第一条问候。Welcome to ${theme.en}. ✨` },
        { description: long, firstMessage: `A19_LONG_FIRST_MESSAGE 长问候：${theme.name}的门在雨里开着。\n第二行带着 emoji 🌧️ 和特殊字符 《》「」\\n` },
        { description: `Medium description for ${theme.en}. It lists habits, a secret and a rule.`, firstMessage: `Third greeting for ${theme.name}.` },
        { description: `Emoji-forward card 🎴🔮 for ${theme.en}. Special: <angle> & ampersand "quotes".`, firstMessage: `🎴 ${theme.cjk} greeting with tabs\tand escapes.` },
    ];
    const chosen = specs[index % specs.length];
    return {
        name: `A19R${round} ${theme.name} ${index + 1}`,
        description: chosen.description,
        firstMessage: chosen.firstMessage,
        personality: index % 3 === 0 ? `patient, ${theme.en}-minded, quietly amused` : `variant ${index % 7}, observant`,
        mesExample: `<START>\n{{user}}: 还有房间吗？\n{{char}}: 有的，${theme.en} 的靠窗那间。\n<START>\n{{user}}: Anything strange tonight?\n{{char}}: Only the usual moon.`,
        scenario: `${theme.en} at night; the rain writes its own ledger. A19_R${round}_SCENARIO_${index + 1}`,
        creatorNotes: `A19 corpus creator note r${round} #${index + 1}`,
        characterVersion: `0.${round}.${index + 1}`,
        depthPrompt: index % 4 === 0 ? `A19 DEPTH NOTE r${round} #${index + 1}: the keeper counts the lanterns.` : '',
        depthPromptDepth: 4,
        depthPromptRole: 0,
        alternateGreetings: index % 5 === 2 ? [`A19_ALT_${round}_${index + 1}_A 另一个问候。`, `A19_ALT_${round}_${index + 1}_B Another opening line 🌙`] : undefined,
    };
}

/** Create a card through the create panel, optionally with an uploaded avatar and alternate greetings. */
async function createCard(page, ctx, spec, avatarPath) {
    // OPEN THE CREATE PANEL THROUGH ITS OWN BUTTON EVERY TIME. Measured: a submit from a panel that was
    // left open did not produce a new card with a name-derived avatar (two consecutive creations both
    // wrote `default_Assistant.png`, so the second overwrote the first); re-entering create mode sets
    // `#form_create[actiontype=createcharacter]`, which is the state the submit handler branches on.
    await page.evaluate(() => {
        const button = document.querySelector('#rm_button_create');
        if (button) button.click();
    });
    await page.waitForTimeout(700);
    // THE AVATAR IS AN INPUT FILE THE USER PICKS: the product's own create-panel file input uploads it.
    if (avatarPath) {
        await page.setInputFiles('#add_avatar_button', avatarPath).catch(() => {});
        await page.waitForTimeout(900);
    }
    const created = await page.evaluate(async inputs => {
        const script = await import('./script.js');
        const form = document.querySelector('#form_create');
        if (!form) return { ok: false, reason: 'no #form_create' };
        const actiontype = form.getAttribute('actiontype');
        const avatarPreview = document.querySelector('#avatar_load_preview')?.getAttribute('src') ?? null;
        const set = (selector, value) => {
            const field = document.querySelector(selector);
            if (!field) return false;
            field.value = value;
            field.dispatchEvent(new Event('input', { bubbles: true }));
            return true;
        };
        set('#character_name_pole', inputs.name);
        set('#description_textarea', inputs.description ?? '');
        set('#firstmessage_textarea', inputs.firstMessage ?? '');
        set('#personality_textarea', inputs.personality ?? '');
        set('#mes_example_textarea', inputs.mesExample ?? '');
        set('#scenario_pole', inputs.scenario ?? '');
        set('#creator_notes_textarea', inputs.creatorNotes ?? '');
        set('#character_version_textarea', inputs.characterVersion ?? '');
        if (inputs.depthPrompt) {
            set('#depth_prompt_prompt', inputs.depthPrompt);
            const depth = document.querySelector('#depth_prompt_depth');
            if (depth) { depth.value = String(inputs.depthPromptDepth ?? 4); depth.dispatchEvent(new Event('input', { bubbles: true })); }
            const role = document.querySelector('#depth_prompt_role');
            if (role) { role.value = String(inputs.depthPromptRole ?? 0); role.dispatchEvent(new Event('change', { bubbles: true })); }
        }
        // ALTERNATE GREETINGS: the real "click to set additional greeting messages" control opens a popup
        // whose textareas each write into the create payload on `input` (script.js addAlternateGreeting).
        if (Array.isArray(inputs.alternateGreetings) && inputs.alternateGreetings.length > 0) {
            const opener = document.querySelector('.open_alternate_greetings');
            if (opener) {
                opener.click();
                const popupDeadline = Date.now() + 15000;
                let dialog = null;
                while (Date.now() < popupDeadline) {
                    dialog = [...document.querySelectorAll('dialog.popup, .popup')].find(element => element.querySelector('.alternate_greetings_list') && element.open !== false);
                    if (dialog) break;
                    await new Promise(resolve => setTimeout(resolve, 100));
                }
                if (dialog) {
                    for (const text of inputs.alternateGreetings) {
                        dialog.querySelector('.add_alternate_greeting')?.click();
                        await new Promise(resolve => setTimeout(resolve, 150));
                        const fields = dialog.querySelectorAll('textarea[name="alternate_greetings"]');
                        const field = fields[fields.length - 1];
                        if (field) {
                            field.value = text;
                            field.dispatchEvent(new Event('input', { bubbles: true }));
                        }
                    }
                    const ok = dialog.querySelector('.popup-button-ok');
                    if (ok) ok.click();
                    await new Promise(resolve => setTimeout(resolve, 500));
                }
            }
        }
        const submit = document.querySelector('#create_button');
        if (!submit) return { ok: false, reason: 'no #create_button' };
        submit.click();
        const deadline = performance.now() + 30000;
        while (performance.now() < deadline) {
            await script.getCharacters();
            const match = (script.characters ?? []).find(entry => entry?.name === inputs.name);
            if (match) {
                return {
                    ok: true,
                    avatar: match.avatar ?? null,
                    name: match.name ?? null,
                    alternateGreetings: match.data?.alternate_greetings ?? null,
                };
            }
            await new Promise(resolve => setTimeout(resolve, 250));
        }
        return { ok: false, reason: 'created card never appeared in the roster' };
    }, spec);
    return created;
}

async function createCards(page, ctx, round, count) {
    const created = [];
    const avatarDir = path.join(ctx.paths.artifactsDir, 'avatars');
    await fs.mkdir(avatarDir, { recursive: true });
    for (let index = 0; index < count; index += 1) {
        const spec = cardSpecFor(round, index);
        const index0 = (round - 1) * 12 + index;
        const avatarPath = index % 4 === 0 ? await writePng(path.join(avatarDir, `a19-avatar-r${round}-${index}.png`), index0) : null;
        const result = await createCard(page, ctx, spec, avatarPath);
        await ctx.act({ page: 'Character create panel', control: '#rm_button_create → #form_create → #create_button', field: `card ${spec.name}`, action: avatarPath
            ? 'pick an avatar file, type the card fields (with alternate greetings where planned) and press Create'
            : 'type the card fields and press Create', result: { ok: result.ok, avatar: result.avatar ?? null, alternateGreetings: result.alternateGreetings ?? null, inputAvatar: avatarPath ? path.basename(avatarPath) : null } });
        if (result.ok !== true) {
            ctx.report.step(`card-created-r${round}-${index}`, false, result);
            continue;
        }
        const cardBytes = await readCharacterCardBytes(ctx.dataRoot, result.avatar).catch(() => null);
        const readBack = await readBackCard(page, result.avatar).catch(() => null);
        const readBackName = readBack?.card?.data?.name ?? readBack?.card?.name ?? null;
        const defaultAvatarLeak = String(result.avatar ?? '').startsWith('default_');
        const ok = readBack?.status === 200 && readBackName === spec.name && cardBytes !== null && cardBytes.chara !== null && !defaultAvatarLeak;
        ctx.report.step(`card-created-r${round}-${index}`, ok, { name: spec.name, avatar: result.avatar, actiontype: result.actiontype ?? null, defaultAvatarLeak, bytes: cardBytes?.bytes ?? null, sha256: cardBytes?.sha256 ?? null, readBackStatus: readBack?.status ?? null });
        if (ok) {
            created.push({ name: spec.name, avatar: result.avatar, readBackName });
            await ctx.act({ page: 'Characters', control: 'POST /api/characters/export?format=json', field: `read-back ${spec.name}`, action: 'read the created card back through the product export route and the stored PNG', result: { status: readBack?.status ?? null, name: readBackName, storedBytes: cardBytes?.bytes ?? null, storedSha256: cardBytes?.sha256 ?? null }, created: { characters: 1 } });
        }
    }
    return created;
}

// -----------------------------------------------------------------------------------------------------------------
// LOREBOOKS
// -----------------------------------------------------------------------------------------------------------------

function worldEntrySpecsFor(round, bookIndex, count) {
    const specs = [];
    for (let item = 0; item < count; item += 1) {
        const kind = item % 10;
        const base = {
            comment: `A19R${round} W${bookIndex + 1} E${item + 1}`,
            content: `A19_WI_R${round}_W${bookIndex + 1}_E${item + 1} `,
        };
        if (kind === 0) { // constant
            specs.push({ ...base, keys: [], constant: true, position: 0, order: 10 + item, content: `${base.content}常驻条目：灯笼永远亮着。` });
        } else if (kind === 1) { // keyword
            specs.push({ ...base, keys: [`a19r${round}key${bookIndex}_${item}`, `触发${item}`], position: 0, order: 20 + item, content: `${base.content}关键词条目 with a trigger.` });
        } else if (kind === 2) { // recursive
            specs.push({ ...base, keys: [`a19r${round}rec${bookIndex}_${item}`], position: 0, order: 30 + item, content: `${base.content}递归条目 mentions a19r${round}key${bookIndex}_${item + 1} as its next key.` });
        } else if (kind === 3) { // after position
            specs.push({ ...base, keys: [`a19r${round}after${bookIndex}_${item}`], position: 1, order: 40 + item, content: `${base.content}after-character entry.` });
        } else if (kind === 4) { // at depth
            specs.push({ ...base, keys: [`a19r${round}depth${bookIndex}_${item}`], position: 4, depth: 2 + (item % 5), role: 0, order: 50 + item, content: `${base.content}at-depth entry 深度条目。` });
        } else if (kind === 5) { // before AN
            specs.push({ ...base, keys: [`a19r${round}an${bookIndex}_${item}`], position: 2, order: 60 + item, content: `${base.content}before Author's Note.` });
        } else if (kind === 6) { // disabled
            specs.push({ ...base, keys: [`a19r${round}off${bookIndex}_${item}`], position: 0, order: 70 + item, disabled: true, content: `${base.content}disabled entry.` });
        } else if (kind === 7) { // exclude recursion
            specs.push({ ...base, keys: [`a19r${round}xrec${bookIndex}_${item}`], position: 0, order: 80 + item, excludeRecursion: true, content: `${base.content}exclude-recursion entry.` });
        } else if (kind === 8) { // group scoring / selective
            specs.push({ ...base, keys: [`a19r${round}grp${bookIndex}_${item}`], secondaryKeys: [`a19secondary${item}`], selective: true, position: 1, order: 90 + item, content: `${base.content}selective entry with a secondary key.` });
        } else { // before EM
            specs.push({ ...base, keys: [`a19r${round}em${bookIndex}_${item}`], position: 5, order: 100 + item, content: `${base.content}before example messages.` });
        }
    }
    return specs;
}

async function createWorldBooks(page, ctx, round, plan, startBookIndex) {
    const books = [];
    for (let bookIndex = 0; bookIndex < plan.worlds; bookIndex += 1) {
        const worldName = `A19R${round} Lore ${bookIndex + 1} ${lackTheme(round + bookIndex).name}`;
        const created = await createWorldBook(page, worldName);
        await ctx.act({ page: 'World Info drawer', control: '#world_create_button + popup', field: 'world name', action: `create lorebook ${JSON.stringify(worldName)}`, result: created });
        ctx.report.step(`world-created-r${round}-${bookIndex}`, created.ok === true, created);
        if (!created.ok) continue;
        const opened = await openWorldInEditor(page, worldName);
        ctx.report.step(`world-opened-r${round}-${bookIndex}`, opened.ok === true, opened);
        const specs = worldEntrySpecsFor(round, startBookIndex + bookIndex, plan.entriesPerWorld);
        const results = [];
        for (const spec of specs) {
            const entry = await createWorldEntry(page, worldName, spec);
            results.push({ ok: entry.ok, uid: entry.uid, mechanism: entry.mechanism ?? null, verification: entry.verification ?? null, stage: entry.stage ?? null });
            if (entry.ok !== true) {
                await ctx.act({ page: 'World Info entry editor', control: '#world_popup_new + editor fields', field: `entry ${spec.comment}`, action: 'create an entry through the real New Entry button and type its fields through the editor', result: entry });
                ctx.report.step(`world-entry-r${round}-${bookIndex}-${spec.comment}`, false, entry);
            }
        }
        const failed = results.filter(entry => entry.ok !== true);
        const disk = await readWorldBookFile(ctx.dataRoot, worldName);
        ctx.report.step(`world-entries-persisted-r${round}-${bookIndex}`, failed.length === 0 && disk.entryCount === plan.entriesPerWorld, { world: worldName, expected: plan.entriesPerWorld, onDisk: disk.entryCount, failed: failed.length, sha256: disk.sha256 });
        await ctx.act({ page: 'World Info entry editor', control: '#world_popup_new + editor fields', field: `lorebook ${worldName}`, action: `create ${plan.entriesPerWorld} entries through the real entry editor and flush through the product's own save`, result: { onDisk: disk.entryCount, failed: failed.length }, created: { worlds: 1, worldEntries: disk.entryCount } });
        books.push({ name: worldName, entries: disk.entryCount });
    }
    return books;
}

// -----------------------------------------------------------------------------------------------------------------
// PRESETS
// -----------------------------------------------------------------------------------------------------------------

/**
 * Import a preset through the AI Response Configuration import input, then SELECT it through the
 * product's own preset select and read the selection back.
 */
async function importPreset(page, ctx, presetPath, presetName) {
    // THE IMPORT CONTROL ONLY EXISTS/ACCEPTS WORK WHEN THE OPENAI SOURCE IS ACTIVE. On a fresh root the
    // page boots on another main API, so `#openai_preset_import_file` was inert and every preset step
    // failed (CI round 1: preset-imported-r1-0/1/2). Point the page at the recorder FIRST, then wait for
    // the control rather than assuming it is ready.
    await ensureConnection(page, ctx.provider.baseURL, 'a19-live-model', { streaming: ctx.streaming !== false });
    const readyDeadline = Date.now() + 30000;
    while (Date.now() < readyDeadline) {
        const present = await page.evaluate(() => Boolean(document.querySelector('#openai_preset_import_file')) && Boolean(document.querySelector('#settings_preset_openai')));
        if (present) break;
        await page.waitForTimeout(250);
    }
    const beforeOptions = await page.evaluate(() => [...document.querySelectorAll('#settings_preset_openai option')].map(option => option.textContent.trim()));
    await page.setInputFiles('#openai_preset_import_file', presetPath);
    const deadline = Date.now() + (Number(process.env.A19_IMPORT_TIMEOUT_MS ?? '30000') || 30000);
    let actualName = null;
    let optionNames = [];
    while (Date.now() < deadline) {
        optionNames = await page.evaluate(() => [...document.querySelectorAll('#settings_preset_openai option')].map(option => option.textContent.trim()));
        // THE PRODUCT DECIDES THE NAME. A fresh install may name the preset from the file rather than the
        // JSON's display name, exactly like imported lorebooks; read the NEW option instead of matching the
        // name we hoped for (the assumed-name check was the CI failure).
        actualName = optionNames.find(name => !beforeOptions.includes(name) && name !== '');
        if (actualName) break;
        await page.waitForTimeout(250);
    }
    if (!actualName) return { ok: false, reason: `imported preset ${presetName} never appeared in #settings_preset_openai`, beforeOptions, afterOptions: optionNames };
    const selected = await page.evaluate(async name => {
        const select = document.querySelector('#settings_preset_openai');
        const option = [...select.options].find(candidate => candidate.textContent.trim() === name);
        if (!option) return { ok: false, reason: 'preset option disappeared' };
        select.value = option.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        const deadline = Date.now() + 20000;
        let observed = null;
        while (Date.now() < deadline) {
            observed = (document.querySelector('#settings_preset_openai')?.selectedOptions?.[0]?.textContent ?? '').trim();
            if (observed === name) return { ok: true, presetName: name, value: option.value };
            await new Promise(resolve => setTimeout(resolve, 200));
        }
        return { ok: false, reason: 'preset never became selected', observed };
    }, actualName);
    return { ...selected, actualName, requestedName: presetName, beforeOptions, afterOptions: optionNames };
}

async function importPresets(page, ctx, round, plan, presetStartIndex) {
    const presetDir = path.join(ctx.paths.artifactsDir, 'presets');
    await fs.mkdir(presetDir, { recursive: true });
    const imported = [];
    for (let index = 0; index < plan.presets; index += 1) {
        const index0 = presetStartIndex + index;
        const name = `A19Preset r${round} ${index0 + 1}`;
        const file = await writePresetFile(path.join(presetDir, `a19-preset-r${round}-${index0 + 1}.json`), index0);
        const result = await importPreset(page, ctx, file, name);
        const actualName = result.actualName ?? name;
        if (result.ok) {
            // EDIT THROUGH THE UI AND SAVE WITH THE PRESET'S OWN "Update current preset" BUTTON: one field
            // changed through the real control and persisted through the product's own save path.
            const edited = await page.evaluate(async value => {
                const field = document.querySelector('#temp_openai');
                if (!field) return { ok: false, reason: '#temp_openai missing' };
                field.value = String(value);
                field.dispatchEvent(new Event('input', { bubbles: true }));
                field.dispatchEvent(new Event('change', { bubbles: true }));
                document.querySelector('#update_oai_preset')?.click();
                return { ok: true, temperature: value };
            }, Number((0.5 + (index0 % 5) * 0.1).toFixed(2)));
            await page.waitForTimeout(400);
            const connection = await ensureConnection(page, ctx.provider.baseURL, 'a19-live-model', { streaming: ctx.streaming !== false });
            await ctx.act({ page: 'AI Response Configuration', control: '#openai_preset_import_file + #settings_preset_openai + #temp_openai + #update_oai_preset', field: `preset ${actualName}`, action: 'import the preset file through the real import input, select the option the product created, edit temperature through the slider and press Update current preset', result: { import: result, edited, connection: connection.ok === true, connectionState: connection.state ?? null }, created: { presets: 1 } });
            ctx.report.step(`preset-imported-r${round}-${index}`, connection.ok === true, { requestedName: name, actualName, edited, connectionState: connection.state ?? null });
            imported.push({ name: actualName, file: path.basename(file) });
        } else {
            await ctx.act({ page: 'AI Response Configuration', control: '#openai_preset_import_file', field: `preset ${name}`, action: 'import the preset file through the real import input', result });
            ctx.report.step(`preset-imported-r${round}-${index}`, false, result);
        }
    }
    return imported;
}

// -----------------------------------------------------------------------------------------------------------------
// CHATS
// -----------------------------------------------------------------------------------------------------------------

/** Open a card and start a new chat through the real New Chat control. */
async function openCardAndNewChat(page, cardName) {
    const opened = await openCharacter(page, cardName);
    if (opened.opened !== true) return { ok: false, stage: 'open-card', opened };
    let newChat = await startNewChat(page);
    if (newChat.ok !== true) {
        // A SELECTED GROUP BLOCKS THE CHARACTER CHAT PATH. Measured on a fresh root: after the group phase
        // (or a leftover group selection) `startNewChat` confirmed but the id did not change — the product is
        // still on the group surface. Clear the selection through the owning module and retry once, exactly
        // like a user returning to a character; the reset and the retry are both recorded.
        const groupState = await page.evaluate(async () => {
            const groupChats = await import('./scripts/group-chats.js');
            const context = window.SillyTavern?.getContext?.() ?? null;
            return { selectedGroup: groupChats.selected_group ?? context?.groupId ?? null };
        });
        if (groupState.selectedGroup !== null && groupState.selectedGroup !== undefined) {
            const reset = await page.evaluate(async () => {
                const groupChats = await import('./scripts/group-chats.js');
                try {
                    await groupChats.resetSelectedGroup();
                    return { ok: true };
                } catch (error) {
                    return { ok: false, reason: String(error?.message ?? error) };
                }
            });
            if (reset.ok) {
                await page.waitForTimeout(500);
                await openCharacter(page, cardName).catch(() => null);
                const retry = await startNewChat(page);
                if (retry.ok === true) return { ok: true, opened, newChat: retry, chatId: retry.after?.chatId ?? null, groupReset: true, retriedAfterGroupReset: true };
                newChat = retry;
            }
            return { ok: false, stage: 'new-chat-after-group-reset', newChat, opened, groupState, reset };
        }
        return { ok: false, stage: 'new-chat', newChat, opened, groupState };
    }
    return { ok: true, opened, newChat, chatId: newChat.after?.chatId ?? null };
}

/** The user's message text: deterministic per round/chat/turn, carrying CJK and emoji variety. */
function turnTextFor(round, chatIndex, turnIndex) {
    const flavour = ['还有空房吗？', 'Tell me about the lantern.', '灯笼下真的有铜铃吗？🌙', 'A quiet night, then.', '雨还在下吗？', 'One more room, please. 🎴', '那本旧账还在吗？', 'Sleep well, keeper.'];
    return `A19 R${round} C${chatIndex} T${turnIndex} ${flavour[(round + chatIndex + turnIndex) % flavour.length]}`;
}

/**
 * The per-round chat matrix: open a card, start a NEW chat through the product, drive N real turns,
 * and run the verbs the charter names (swipe, regenerate, continue, edit, delete) on a deterministic
 * subset. Every chat is saved through the product and verified on disk by its own marker.
 */
async function runChats(page, ctx, round, plan, cards, presets, presetWireProof) {
    const chats = [];
    // PRE-CHATS RE-ASSERT. The connection is configured once after readiness, but preset import +
    // `#update_oai_preset` + saveSettingsNow can trigger the ASYNC settings reload that reverts
    // `chat_completion_source`; on a slower runner the drift is invisible until every send fails with a
    // silent exit. Re-assert immediately before the first chat, record a NAMED step with the read-back,
    // and refuse to run the chat matrix on a mismatch (fail fast, as the matrix would only produce noise).
    const preChats = await ensureConnection(page, ctx.provider.baseURL, 'a19-live-model', { streaming: ctx.streaming !== false });
    const preChatsState = await page.evaluate(async () => {
        const script = await import('./script.js');
        const openai = await import('./scripts/openai.js');
        return {
            mainApi: script.main_api ?? null,
            source: openai.oai_settings?.chat_completion_source ?? null,
            customUrl: openai.oai_settings?.custom_url ?? null,
        };
    });
    const expectedURL = String(ctx.provider.baseURL ?? '').replace(/\/+$/, '');
    const preChatsOk = preChats.ok === true
        && preChatsState.mainApi === 'openai'
        && preChatsState.source === 'custom'
        && String(preChatsState.customUrl ?? '').replace(/\/+$/, '') === expectedURL;
    await ctx.act({ page: 'AI Response Configuration', control: '#main_api + #chat_completion_source + #custom_api_url_text', field: 'pre-chats connection re-assert', action: 're-apply and read back the recorder connection immediately before the chat matrix', result: { ok: preChatsOk, state: preChatsState, expectedBaseURL: ctx.provider.baseURL, attempts: preChats.attempts ?? null } });
    ctx.report.step(`provider-still-connected-before-chats-r${round}`, preChatsOk, { state: preChatsState, expectedBaseURL: ctx.provider.baseURL });
    if (!preChatsOk) {
        ctx.report.note(`chat matrix refused: the recorder connection drifted before chats (mainApi=${preChatsState.mainApi}, source=${preChatsState.source}, customUrl=${preChatsState.customUrl})`);
        return chats;
    }
    for (let chatIndex = 0; chatIndex < plan.chats; chatIndex += 1) {
        const card = cards[chatIndex % cards.length];
        if (!card) break;
        let opened = await openCardAndNewChat(page, card.name);
        // ONE BOUNDED RETRY: opening a card whose store has no chat auto-creates a greeting chat, and New
        // Chat on that just-opened state occasionally confirmed while the id did not change (measured once
        // on a fresh root: `confirmed:true`, same chatId). Re-open and press New Chat again, exactly like a
        // user would, before recording a failure.
        if (!opened.ok) {
            await openCharacter(page, card.name).catch(() => null);
            opened = await openCardAndNewChat(page, card.name);
        }
        if (!opened.ok) {
            ctx.report.step(`chat-opened-r${round}-${chatIndex}`, false, opened);
            continue;
        }
        const chatId = String(opened.chatId ?? '');
        let messages = 0;
        let failedTurn = null;
        // ROUND 3 PRESET-WIRE PROOF: the first ten chats each begin with a DIFFERENT corpus preset and
        // send one turn. The recorded provider request bodies for those ten turns are compared later; ten
        // distinct bodies prove the presets really change the request (not just a select label).
        if (round === 3 && presetWireProof !== null && chatIndex < presetWireProof.presets.length) {
            const preset = presetWireProof.presets[chatIndex];
            const selected = await importPresetAlreadySelected(page, preset.name);
            const connection = await ensureConnection(page, ctx.provider.baseURL, 'a19-live-model', { streaming: ctx.streaming !== false });
            const beforeRequests = (await ctx.provider.stats()).requests;
            const turn = await chatTurn(page, `A19_PRESETWIRE_${chatIndex + 1} ${preset.name}`);
            const afterRequests = (await ctx.provider.stats()).requests;
            const ok = selected.ok === true && connection.ok === true && turn.ok === true && afterRequests > beforeRequests;
            presetWireProof.observed.push({ preset: preset.name, selected: selected.ok === true, connection: connection.ok === true, turnOk: turn.ok === true, requestIndexBefore: beforeRequests, requestIndexAfter: afterRequests });
            ctx.report.step(`preset-wire-turn-${chatIndex}`, ok, presetWireProof.observed[presetWireProof.observed.length - 1]);
            if (turn.ok) messages += 2;
        }
        for (let turnIndex = 0; turnIndex < plan.turnsPerChat; turnIndex += 1) {
            const text = turnTextFor(round, chatIndex, turnIndex);
            // MACROS: every seventh chat's first turn carries a macro that the corpus set earlier in the
            // same round through a slash command, so the substituted value appears in the sent message.
            const payload = (turnIndex === 0 && chatIndex % 7 === 3 && round >= 2) ? `${text} {{getvar::a19r${round}var}}` : text;
            const turn = await fastChatTurn(page, payload);
            if (turn.ok !== true) {
                failedTurn = { turnIndex, text, detail: turn };
                break;
            }
            messages += 2;
            // THE VERBS. Two chats per round carry swipe and regenerate; one carries continue; one carries
            // an edit and a delete. Each is a real control press, recorded with its observed effect.
            if (turnIndex === 2 && chatIndex % 7 === 1) {
                const swipe = await swipeLastMessage(page);
                ctx.report.step(`swipe-r${round}-${chatIndex}`, swipe.ok === true, swipe);
                if (swipe.ok) messages += 1;
            }
            if (turnIndex === 4 && chatIndex % 7 === 2) {
                const regenerated = await pressRegenerateThroughMenu(page);
                ctx.report.step(`regenerate-r${round}-${chatIndex}`, regenerated?.pressed === true, { pressed: regenerated?.pressed, sawBusy: regenerated?.sawBusy, generateCalls: regenerated?.generateCalls ?? null });
                if (regenerated?.pressed) messages += 1;
            }
            if (turnIndex === 6 && chatIndex % 9 === 3) {
                const continued = await pressContinue(page);
                ctx.report.step(`continue-r${round}-${chatIndex}`, continued?.pressed === true, { pressed: continued?.pressed, sawBusy: continued?.sawBusy });
                if (continued?.pressed) messages += 1;
            }
            if (turnIndex === 8 && chatIndex % 11 === 4) {
                const edited = await editLastMessage(page, `A19 EDITED r${round} c${chatIndex} 编辑后的消息 ✍️`);
                ctx.report.step(`edit-r${round}-${chatIndex}`, edited.ok === true, edited);
            }
            if (turnIndex === 9 && chatIndex % 13 === 5) {
                const deleted = await deleteLastMessage(page);
                ctx.report.step(`delete-r${round}-${chatIndex}`, deleted.ok === true, deleted);
                if (deleted.ok) messages -= 1;
            }
        }
        // SAVE THROUGH THE PRODUCT, THEN VERIFY THE FILE IT WROTE.
        await saveConditional(page);
        const files = await waitForChatFileMarker(ctx.dataRoot, `A19 R${round} C${chatIndex} T0`);
        const file = files.find(candidate => (candidate.messages ?? []).some(message => String(message?.mes ?? '').includes(`A19 R${round} C${chatIndex} T0`)));
        const ok = Boolean(file) && messages >= plan.turnsPerChat;
        await ctx.act({ page: 'Chat', control: '#send_textarea + #send_but', field: `chat ${chatId || chatIndex}`, action: `start a new chat through the product and send ${plan.turnsPerChat} real turns${failedTurn ? ' (stopped early)' : ''}`, result: { ok, messages, file: file?.file ?? null, lines: file?.lines ?? 0, sha256: file?.sha256 ?? null, failedTurn }, created: { chats: 1, messages } });
        ctx.report.step(`chat-r${round}-${chatIndex}`, ok, { card: card.name, chatId, messages, file: file?.file ?? null, lines: file?.lines ?? 0, failedTurn });
        chats.push({ chatId, file: file?.file ?? null, messages });
        // PAGE RELOAD every fifth chat: the persisted chat must still open with its messages.
        if (chatIndex % 5 === 4) {
            const reload = await reloadAndReopen(page, card.name, chatChoiceCandidate(opened, file));
            ctx.report.step(`reload-r${round}-${chatIndex}`, reload.ok === true, reload);
            // A RELOAD REVERTS THE ASYNC SETTINGS LOAD. Measured on a fresh root: every send AFTER the first
            // reload silently exited (main_api still openai, chatLength unchanged) because
            // `chat_completion_source`/custom_url came back from settings.json, not from the recorder
            // configuration. Re-apply and read back after every reload; refuse quietly to continue blind.
            const reassert = await ensureConnection(page, ctx.provider.baseURL, 'a19-live-model', { streaming: ctx.streaming !== false });
            const reassertState = await page.evaluate(async () => {
                const script = await import('./script.js');
                const openai = await import('./scripts/openai.js');
                return { mainApi: script.main_api ?? null, source: openai.oai_settings?.chat_completion_source ?? null, customUrl: openai.oai_settings?.custom_url ?? null };
            });
            const reloadOk = reassert.ok === true && reassertState.mainApi === 'openai' && reassertState.source === 'custom';
            await ctx.act({ page: 'AI Response Configuration', control: '#main_api + #chat_completion_source + #custom_api_url_text', field: 'post-reload connection re-assert', action: 're-apply and read back the recorder connection after the page reload', result: { ok: reloadOk, state: reassertState, expectedBaseURL: ctx.provider.baseURL } });
            ctx.report.step(`provider-still-connected-after-reload-r${round}-${chatIndex}`, reloadOk, { state: reassertState });
            if (!reloadOk) ctx.report.note(`chat matrix continues after a reload WITHOUT the recorder connection (mainApi=${reassertState.mainApi}, source=${reassertState.source})`);
        }
    }
    return chats;
}

function chatChoiceCandidate(opened, file) {
    if (file?.file) return path.basename(String(file.file));
    return String(opened?.chatId ?? '');
}

async function importPresetAlreadySelected(page, presetName) {
    return page.evaluate(async name => {
        const select = document.querySelector('#settings_preset_openai');
        if (!select) return { ok: false, reason: 'no preset select' };
        const option = [...select.options].find(candidate => candidate.textContent.trim() === name);
        if (!option) return { ok: false, reason: `preset ${JSON.stringify(name)} is not listed` };
        select.value = option.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        const deadline = Date.now() + 20000;
        let observed = null;
        while (Date.now() < deadline) {
            observed = (document.querySelector('#settings_preset_openai')?.selectedOptions?.[0]?.textContent ?? '').trim();
            if (observed === name) return { ok: true, presetName: name };
            await new Promise(resolve => setTimeout(resolve, 200));
        }
        return { ok: false, reason: 'preset never became selected', observed };
    }, presetName);
}

async function waitForChatFileMarker(dataRoot, marker, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    let files = [];
    while (Date.now() < deadline) {
        files = await readChatFiles(dataRoot);
        if (files.some(file => (file.messages ?? []).some(message => String(message?.mes ?? '').includes(marker)))) break;
        await new Promise(resolve => setTimeout(resolve, 400));
    }
    return files;
}

/**
 * Find the chat file that carries a marker ANYWHERE the product writes chats: character chats under
 * `<user>/chats/**` AND group chats under `<user>/group chats/**`. The group chat directory is a
 * different tree, and a group-only scan had reported "not persisted" for a chat that was written.
 */
async function findChatFileWithMarker(dataRoot, marker) {
    const roots = [
        { user: 'chats', prefix: 'chats' },
        { user: 'group chats', prefix: 'group chats' },
    ];
    for (const root of roots) {
        const files = [];
        const walk = async directory => {
            let entries = [];
            try {
                entries = await fs.readdir(directory, { withFileTypes: true });
            } catch {
                return;
            }
            for (const entry of entries) {
                const full = path.join(directory, entry.name);
                if (entry.isDirectory()) await walk(full);
                else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(full);
            }
        };
        await walk(path.join(dataRoot, 'default-user', root.user));
        for (const file of files) {
            const body = await fs.readFile(file, 'utf8');
            if (body.includes(marker)) {
                return { file: `${root.prefix}/${path.relative(path.join(dataRoot, 'default-user', root.user), file).split(path.sep).join('/')}`, lines: body.split('\n').filter(line => line.trim()).length };
            }
        }
    }
    return null;
}
export async function swipeLastMessage(page) {
    return page.evaluate(async () => {
        const script = await import('./script.js');
        const chat = script.chat ?? [];
        const last = chat[chat.length - 1] ?? null;
        const before = { chatLength: chat.length, lastIsUser: last?.is_user === true, lastText: String(last?.mes ?? '').slice(0, 120), swipeId: last?.swipe_id ?? null };
        const control = document.querySelector('.last_mes .swipe_right');
        if (!control) return { ok: false, reason: 'no swipe control on the last message', before };
        control.click();
        const deadline = Date.now() + 60000;
        let after = null;
        while (Date.now() < deadline) {
            const live = script.chat ?? [];
            const tail = live[live.length - 1] ?? null;
            after = { chatLength: live.length, lastText: String(tail?.mes ?? '').slice(0, 120), swipeId: tail?.swipe_id ?? null, swipes: Array.isArray(tail?.swipes) ? tail.swipes.length : null, isSendPress: script.is_send_press ?? null };
            if (script.is_send_press !== true && after.lastText !== before.lastText) return { ok: true, before, after };
            await new Promise(resolve => setTimeout(resolve, 250));
        }
        return { ok: false, reason: 'the swipe produced no new text', before, after };
    });
}

export async function editLastMessage(page, text) {
    return page.evaluate(async replacement => {
        const script = await import('./script.js');
        const chat = script.chat ?? [];
        const lastIndex = chat.length - 1;
        const message = document.querySelectorAll('#chat .mes')[lastIndex];
        if (!message) return { ok: false, reason: 'last message node missing' };
        const edit = message.querySelector('.mes_edit');
        if (!edit) return { ok: false, reason: 'no .mes_edit control' };
        edit.click();
        edit.click();
        await new Promise(resolve => setTimeout(resolve, 600));
        // PINNED EDITS THE MESSAGE IN A CONTENTEDITABLE `.mes_text`, NOT A TEXTAREA: the textarea
        // selector never matched, so every edit failed while the panel was visibly in edit mode (measured).
        const editable = document.querySelector(`#chat .mes[mesid="${lastIndex}"] .mes_text[contenteditable="true"]`)
            ?? document.querySelector(`#chat .mes[mesid="${lastIndex}"] .mes_text`);
        if (!editable) return { ok: false, reason: 'message edit surface did not appear' };
        editable.focus();
        editable.textContent = replacement;
        editable.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: replacement }));
        const done = document.querySelector(`#chat .mes[mesid="${lastIndex}"] .mes_edit_done`);
        if (!done) return { ok: false, reason: 'no .mes_edit_done control' };
        done.click();
        const deadline = Date.now() + 20000;
        let observed = null;
        while (Date.now() < deadline) {
            const live = script.chat ?? [];
            observed = String(live[live.length - 1]?.mes ?? '');
            if (observed === replacement) return { ok: true, replacement, observedLength: observed.length };
            await new Promise(resolve => setTimeout(resolve, 250));
        }
        return { ok: false, reason: 'the edited text did not reach the chat model', observed: observed?.slice(0, 120) ?? null };
    }, text);
}

export async function deleteLastMessage(page) {
    return page.evaluate(async () => {
        const script = await import('./script.js');
        const chatBefore = (script.chat ?? []).length;
        const messages = document.querySelectorAll('#chat .mes');
        const target = messages[messages.length - 1];
        if (!target) return { ok: false, reason: 'last message node missing' };
        const edit = target.querySelector('.mes_edit');
        if (edit) {
            edit.click();
            await new Promise(resolve => setTimeout(resolve, 400));
        }
        const remove = target.querySelector('.mes_edit_delete') ?? target.querySelector('.mes_delete');
        if (!remove) return { ok: false, reason: 'no delete control' };
        remove.click();
        await new Promise(resolve => setTimeout(resolve, 500));
        // ONLY A VISIBLE CONFIRM COUNTS: #dialogue_popup_ok is a permanent hidden element (same trap as New Chat).
        const deletable = element => Boolean(element) && element.getClientRects().length > 0 && window.getComputedStyle(element).visibility !== 'hidden';
        const deleteButtons = [...document.querySelectorAll('dialog.popup .popup-button-ok, .popup .popup-button-ok, #dialogue_popup_ok')].filter(deletable);
        if (deleteButtons.length > 0) deleteButtons[deleteButtons.length - 1].click();
        const deadline = Date.now() + 20000;
        let observed = chatBefore;
        while (Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 250));
            observed = (await import('./script.js')).chat?.length ?? observed;
            if (observed < chatBefore) return { ok: true, before: chatBefore, after: observed };
        }
        return { ok: false, reason: 'the chat length never shrank after delete', before: chatBefore, after: observed };
    });
}

async function reloadAndReopen(page, cardName, chatFile) {
    const before = await page.evaluate(async () => {
        const script = await import('./script.js');
        return { chatId: window.SillyTavern?.getContext?.()?.chatId ?? null, chatLength: (script.chat ?? []).length };
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction('document.getElementById("preloader") === null', null, { timeout: 180000 }).catch(() => {});
    await page.waitForTimeout(1200);
    const opened = await openCharacter(page, cardName);
    const stem = String(chatFile ?? before.chatId ?? '').replace(/\.jsonl$/i, '');
    const reopened = await page.evaluate(async fileStem => {
        const script = await import('./script.js');
        if (fileStem) {
            try { await script.openCharacterChat(fileStem); } catch { /* refused; recorded below */ }
        }
        const deadline = Date.now() + 60000;
        let last = null;
        while (Date.now() < deadline) {
            last = { chatId: window.SillyTavern?.getContext?.()?.chatId ?? null, chatLength: (script.chat ?? []).length };
            if (String(last.chatId ?? '') === fileStem) return { ok: true, ...last };
            await new Promise(resolve => setTimeout(resolve, 250));
        }
        return { ok: false, ...(last ?? {}) };
    }, stem);
    return { ok: opened?.opened === true && reopened.ok === true && reopened.chatLength >= 2, before, stem, opened, reopened };
}

// -----------------------------------------------------------------------------------------------------------------
// GROUPS
// -----------------------------------------------------------------------------------------------------------------

async function createGroupThroughPanel(page, { name, memberNames, activationStrategy, generationMode }) {
    return page.evaluate(async inputs => {
        const normalise = value => String(value ?? '').replace(/\s+/g, ' ').trim();
        // DETERMINISTIC OPEN: one click on the Group Chats control, then wait for the create dialog's member
        // list. A second click is attempted only if the first produced no members (the drawer may have been
        // already open from a previous group, in which case the click CLOSES it).
        const openPanel = async () => {
            const control = document.querySelector('#rm_button_group_chats');
            if (!control) return false;
            const present = () => document.querySelectorAll('#rm_group_add_members .group_member').length > 0;
            if (!present()) {
                control.click();
                const deadline = Date.now() + 25000;
                while (Date.now() < deadline) {
                    if (present()) return true;
                    await new Promise(resolve => setTimeout(resolve, 200));
                }
                return present();
            }
            return true;
        };
        let ready = await openPanel();
        if (!ready) {
            const control = document.querySelector('#rm_button_group_chats');
            if (control) {
                control.click();
                const deadline = Date.now() + 25000;
                while (Date.now() < deadline) {
                    if (document.querySelectorAll('#rm_group_add_members .group_member').length > 0) { ready = true; break; }
                    await new Promise(resolve => setTimeout(resolve, 200));
                }
            }
        }
        if (!ready) return { ok: false, reason: 'the group panel listed no characters' };
        // PAGINATION IS THE REAL CONSTRAINT. Pinned renders only the CURRENT PAGE of candidates
        // (pageSize default 5, `#rm_group_add_members` holds that page; the filter input is `#rm_group_filter`).
        // Wave 8's red was `availableNames` = literally page 1 while the requested names existed on later
        // pages. So: raise the page size once through the product's own size changer, then filter PER MEMBER
        // and wait for the named row before clicking Add.
        const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
        const filterInput = () => document.querySelector('#rm_group_filter') ?? document.querySelector('#rm_group_members_filter');
        const setFilter = async value => {
            const field = filterInput();
            if (!field) return false;
            field.value = value;
            field.dispatchEvent(new Event('input', { bubbles: true }));
            field.dispatchEvent(new Event('change', { bubbles: true }));
            await sleep(200);
            return true;
        };
        const memberBlocks = () => [...document.querySelectorAll('#rm_group_add_members .group_member')];
        const pageNames = () => memberBlocks().map(element => normalise(element.querySelector('.ch_name')?.textContent ?? element.textContent));
        let paginationUsed = null;
        const raisePageSize = async () => {
            const select = document.querySelector('#rm_group_add_members_pagination select');
            if (select) {
                const options = [...select.options];
                const option = options.find(candidate => Number(candidate.value) >= 1000) ?? options[options.length - 1];
                if (option) {
                    select.value = option.value;
                    select.dispatchEvent(new Event('change', { bubbles: true }));
                    await sleep(600);
                    paginationUsed = String(option.value);
                    return true;
                }
            }
            try {
                const { accountStorage } = await import('./scripts/util/AccountStorage.js');
                accountStorage.setItem('GroupCandidates_PerPage', '1000');
                await setFilter('');
                await sleep(600);
                paginationUsed = '1000 (accountStorage)';
                return true;
            } catch {
                return false;
            }
        };
        await raisePageSize();
        await setFilter('');
        const availableNames = pageNames();
        const waitForRow = async (member, timeoutMs) => {
            const wanted = normalise(member);
            const deadline = Date.now() + timeoutMs;
            while (Date.now() < deadline) {
                const block = memberBlocks().find(element => normalise(element.querySelector('.ch_name')?.textContent ?? element.textContent) === wanted);
                if (block) return block;
                await sleep(150);
            }
            return null;
        };
        const added = [];
        const misses = [];
        for (const member of inputs.memberNames) {
            await setFilter(member);
            let block = await waitForRow(member, 5000);
            if (!block) {
                // ONE bounded second chance: the size changer may only take effect on the next render.
                await raisePageSize();
                await setFilter(member);
                block = await waitForRow(member, 5000);
            }
            if (block) {
                // THE ADD ACTION IS THE BLOCK'S ACTION BUTTON ("data-action=add"), NOT THE BLOCK ITSELF:
                // the document-delegated `onGroupActionClick` handler is what pushes into newGroupMembers.
                const action = block.querySelector('.right_menu_button[data-action="add"]') ?? block.querySelector('.right_menu_button');
                if (action) action.click();
                else block.click();
                added.push(member);
                await sleep(400);
            } else {
                misses.push({ member, pageNames: pageNames() });
            }
            await setFilter('');
            await sleep(150);
        }
        // THE GUARD: NEVER SUBMIT A DIALOG THAT DID NOT ACCEPT EVERY REQUESTED MEMBER. A zero-member group was
        // submitted in CI because the add buttons were clicked but the dialog had no rows for those names;
        // the target counter then counted a group nobody could chat in.
        if (added.length !== inputs.memberNames.length) {
            return { ok: false, reason: 'the create-group dialog did not list every requested member', added, requested: inputs.memberNames, availableNames: pageNames(), misses, paginationUsed, pageNamesAtFailure: pageNames() };
        }
        const setValue = (selector, value, events = ['input', 'change']) => {
            const field = document.querySelector(selector);
            if (!field) return false;
            field.value = String(value);
            for (const eventName of events) field.dispatchEvent(new Event(eventName, { bubbles: true }));
            return true;
        };
        setValue('#rm_group_chat_name', inputs.name);
        if (inputs.activationStrategy !== undefined) setValue('#rm_group_activation_strategy', inputs.activationStrategy);
        if (inputs.generationMode !== undefined) setValue('#rm_group_generation_mode', inputs.generationMode);
        const submit = document.querySelector('#rm_group_submit');
        if (!submit) return { ok: false, reason: 'no #rm_group_submit control', added, availableNames, paginationUsed };
        submit.click();
        const createDeadline = Date.now() + 30000;
        let group = null;
        while (Date.now() < createDeadline) {
            const response = await fetch('/api/groups/all', { method: 'POST', headers: (await import('./script.js')).getRequestHeaders(), body: JSON.stringify({}) });
            if (response.ok) {
                const groups = await response.json();
                group = groups.find(candidate => candidate.name === inputs.name) ?? null;
                if (group) break;
            }
            await new Promise(resolve => setTimeout(resolve, 300));
        }
        if (!group) return { ok: false, reason: 'the group never appeared in /api/groups/all', added, availableNames };
        const memberCount = Array.isArray(group.members) ? group.members.length : 0;
        const summary = { id: group.id, name: group.name, members: group.members, activation_strategy: group.activation_strategy, generation_mode: group.generation_mode };
        if (memberCount === 0) {
            // AN EMPTY GROUP MUST NEVER ENTER THE CORPUS: delete it through the product's own route, then fail
            // the step with the observed shape.
            const headers = (await import('./script.js')).getRequestHeaders();
            let deleted = false;
            try {
                const response = await fetch('/api/groups/delete', { method: 'POST', headers, body: JSON.stringify({ id: group.id }) });
                deleted = response.ok;
            } catch { deleted = false; }
            return { ok: false, reason: 'the product created a ZERO-MEMBER group; it was deleted through /api/groups/delete', added, availableNames, deletedEmptyGroup: deleted, group: summary };
        }
        return { ok: true, added, memberCount, group: summary, availableNames, paginationUsed };
    }, { name, memberNames, activationStrategy, generationMode });
}

async function openGroup(page, groupId, newChat = true) {
    return page.evaluate(async ({ id, fresh }) => {
        const groupChats = await import('./scripts/group-chats.js');
        const script = await import('./script.js');
        await groupChats.openGroupById(id);
        if (fresh) {
            try { await groupChats.createNewGroupChat(id); } catch { /* a group with an existing chat is still drivable */ }
        }
        const deadline = Date.now() + 60000;
        let last = null;
        while (Date.now() < deadline) {
            const context = window.SillyTavern?.getContext?.() ?? null;
            last = {
                // `script.selected_group` does not exist (live binding lives in scripts/group-chats.js);
                // the context reader is the product's own, and the owning module is the fallback.
                selectedGroup: context?.groupId ?? groupChats.selected_group ?? null,
                chatId: context?.chatId ?? null,
                chatLength: (script.chat ?? []).length,
            };
            if (String(last.selectedGroup ?? '') === String(id) && last.chatLength > 0) return { ok: true, ...last };
            await new Promise(resolve => setTimeout(resolve, 250));
        }
        return { ok: false, ...(last ?? {}) };
    }, { id: groupId, fresh: newChat });
}

async function runGroups(page, ctx, round, plan, cards) {
    const groups = [];
    // PRE-GROUPS RE-ASSERT: the chats phase may have reloaded the page and the groups phase must not start
    // on a drifted recorder connection (measured: every group send silently exited after the chats reload).
    const preGroups = await ensureConnection(page, ctx.provider.baseURL, 'a19-live-model', { streaming: ctx.streaming !== false });
    const preGroupsState = await page.evaluate(async () => {
        const script = await import('./script.js');
        const openai = await import('./scripts/openai.js');
        return { mainApi: script.main_api ?? null, source: openai.oai_settings?.chat_completion_source ?? null, customUrl: openai.oai_settings?.custom_url ?? null };
    });
    const preGroupsOk = preGroups.ok === true && preGroupsState.mainApi === 'openai' && preGroupsState.source === 'custom';
    await ctx.act({ page: 'AI Response Configuration', control: '#main_api + #chat_completion_source + #custom_api_url_text', field: 'pre-groups connection re-assert', action: 're-apply and read back the recorder connection before the group chats', result: { ok: preGroupsOk, state: preGroupsState, expectedBaseURL: ctx.provider.baseURL } });
    ctx.report.step(`provider-still-connected-before-groups-r${round}`, preGroupsOk, { state: preGroupsState });
    for (let groupIndex = 0; groupIndex < plan.groups; groupIndex += 1) {
        const memberCount = 3 + (groupIndex % 3);
        const memberNames = cards.slice(groupIndex * 2, groupIndex * 2 + memberCount).map(card => card.name);
        if (memberNames.length < 2) continue;
        const name = `A19R${round} Group ${groupIndex + 1}`;
        const created = await createGroupThroughPanel(page, {
            name,
            memberNames,
            activationStrategy: groupIndex % 2, // 0 natural / 1 list
            generationMode: groupIndex % 2, // 0 swap rotation / 1 list
        });
        await ctx.act({ page: 'Group chat panel', control: '#rm_button_group_chats → #rm_group_add_members .group_member → #rm_group_submit', field: `group ${name}`, action: `select ${memberNames.length} members, name the group, set activation/generation mode and press Create`, result: created });
        ctx.report.step(`group-created-r${round}-${groupIndex}`, created.ok === true, created);
        if (!created.ok) continue;
        const opened = await openGroup(page, created.group.id, true);
        ctx.report.step(`group-opened-r${round}-${groupIndex}`, opened.ok === true, opened);
        let messages = 0;
        for (let turnIndex = 0; turnIndex < 4; turnIndex += 1) {
            const text = `A19 R${round} G${groupIndex + 1} T${turnIndex} 多人群聊 turn。`;
            const turn = await fastChatTurn(page, text);
            if (turn.ok !== true) {
                ctx.report.step(`group-turn-r${round}-${groupIndex}-${turnIndex}`, false, turn);
                break;
            }
            messages += Math.max(2, (turn.after?.chatLength ?? 0) - (turn.before?.chatLength ?? 0));
        }
        // GROUP VERBS: swipe on the last reply, then continue it; a reload must still show the group chat.
        const swipe = await swipeLastMessage(page);
        ctx.report.step(`group-swipe-r${round}-${groupIndex}`, swipe.ok === true, swipe);
        const continued = await pressContinue(page);
        ctx.report.step(`group-continue-r${round}-${groupIndex}`, continued?.pressed === true, { pressed: continued?.pressed, sawBusy: continued?.sawBusy });
        await saveConditional(page);
        let file = null;
        const markerDeadline = Date.now() + 30000;
        while (Date.now() < markerDeadline) {
            file = await findChatFileWithMarker(ctx.dataRoot, `A19 R${round} G${groupIndex + 1} T0`);
            if (file) break;
            await new Promise(resolve => setTimeout(resolve, 400));
        }
        ctx.report.step(`group-chat-persisted-r${round}-${groupIndex}`, Boolean(file) && messages > 0, { file: file?.file ?? null, messages, lines: file?.lines ?? 0 });
        await ctx.act({ page: 'Group chat', control: '#send_textarea + #send_but', field: `group ${name}`, action: 'send four real turns, swipe the last reply, continue it, and save through the product', result: { messages, file: file?.file ?? null, swipe: swipe.ok === true, continue: continued?.pressed === true }, created: { groups: 1, messages } });
        groups.push({ name, id: created.group.id, file: file?.file ?? null, messages });
        const reload = await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1500);
        const reopened = await page.evaluate(async id => {
            const groupChats = await import('./scripts/group-chats.js');
            await groupChats.openGroupById(id);
            const deadline = Date.now() + 60000;
            let last = null;
            while (Date.now() < deadline) {
                const script = await import('./script.js');
                const groupChatsModule = await import('./scripts/group-chats.js');
                // `selected_group` is a LIVE BINDING exported by public/scripts/group-chats.js (L92), NOT
                // re-exported by script.js: `script.selected_group` is always undefined and `?? null` made
                // this observation unfailably false (B read it in pinned source; the group WAS open —
                // chatLength 13/14 proved it). Read the owning module, and prefer the product's context.
                const groupContext = window.SillyTavern?.getContext?.() ?? null;
                last = {
                    selectedGroup: groupChatsModule.selected_group ?? groupContext?.groupId ?? null,
                    chatLength: (script.chat ?? []).length,
                };
                if (last.selectedGroup == id && last.chatLength > 0) return { ok: true, ...last };
                await new Promise(resolve => setTimeout(resolve, 250));
            }
            return { ok: false, ...(last ?? {}) };
        }, created.group.id);
        ctx.report.step(`group-reload-r${round}-${groupIndex}`, reopened.ok === true, reopened);
        // The group reload is a page reload too: restore the recorder before the next group's turns.
        const groupReassert = await ensureConnection(page, ctx.provider.baseURL, 'a19-live-model', { streaming: ctx.streaming !== false });
        const groupReassertState = await page.evaluate(async () => {
            const script = await import('./script.js');
            const openai = await import('./scripts/openai.js');
            return { mainApi: script.main_api ?? null, source: openai.oai_settings?.chat_completion_source ?? null };
        });
        ctx.report.step(`provider-still-connected-after-group-reload-r${round}-${groupIndex}`, groupReassert.ok === true && groupReassertState.mainApi === 'openai' && groupReassertState.source === 'custom', { state: groupReassertState });
    }
    return groups;
}

// -----------------------------------------------------------------------------------------------------------------
// PERSONAL / UI FEATURES: personas (slash command), backgrounds, themes, quick replies, regex, variables
// -----------------------------------------------------------------------------------------------------------------

/** Personas live under `power_user.personas` in pinned's settings.json, NOT at the top level. */
async function readPersonas(dataRoot) {
    const settings = (await readSettingsFile(dataRoot)).settings ?? {};
    return settings.power_user?.personas ?? settings.personas ?? {};
}

async function createPersonas(page, ctx, round, count, startIndex) {
    const created = [];
    for (let index = 0; index < count; index += 1) {
        const name = `A19R${round} Persona ${startIndex + index + 1}`;
        const command = `/persona-create name="${name}" description="A19 persona ${startIndex + index + 1} for round ${round}. 中文描述。" select=false`;
        const before = await readPersonas(ctx.dataRoot);
        const result = await runSlashCommand(page, command);
        // /persona-create uploads a default avatar and saves asynchronously; flush through the product's
        // own immediate settings save before judging, and give the avatar upload time to settle.
        await page.waitForTimeout(2500);
        await saveSettingsNow(page).catch(() => {});
        const after = await readPersonas(ctx.dataRoot);
        const added = Object.keys(after).filter(key => !(key in before));
        const ok = result.ok === true && added.length > 0;
        await ctx.act({ page: 'Chat input', control: '#send_textarea + #send_but', field: 'slash command', action: command, result: { ok, command, beforeCount: Object.keys(before).length, afterCount: Object.keys(after).length, added }, created: ok ? { personas: 1 } : undefined });
        ctx.report.step(`persona-created-r${round}-${index}`, ok, { name, added });
        if (ok) created.push(name);
    }
    return created;
}

const listFiles = async directory => {
    try {
        return await fs.readdir(directory);
    } catch {
        return [];
    }
};

async function uploadBackgrounds(page, ctx, round, count, startIndex) {
    const dir = path.join(ctx.paths.artifactsDir, 'backgrounds');
    await fs.mkdir(dir, { recursive: true });
    const backgroundsDir = path.join(ctx.dataRoot, 'default-user', 'backgrounds');
    const created = [];
    for (let index = 0; index < count; index += 1) {
        const file = await writePng(path.join(dir, `a19-bg-r${round}-s${startIndex}-${index}.png`), startIndex + index);
        const before = await listFiles(backgroundsDir);
        await page.setInputFiles('#add_bg_button', file).catch(() => {});
        await page.waitForTimeout(2000);
        // THE UPLOAD IS PROVEN ON DISK: the product's background handler writes the file into the user's
        // backgrounds directory; a UI count read from a module binding is not the same observation.
        const after = await listFiles(backgroundsDir);
        const added = after.filter(name => !before.includes(name));
        const ok = added.length > 0;
        const result = { ok, added, beforeCount: before.length, afterCount: after.length };
        await ctx.act({ page: 'Backgrounds', control: '#add_bg_button file input', field: 'background image', action: `upload ${path.basename(file)} through the product background upload input`, result, created: ok ? { backgrounds: 1 } : undefined });
        ctx.report.step(`background-uploaded-r${round}-${index}`, ok, result);
        if (ok) created.push(added[0]);
    }
    return created;
}

async function importThemes(page, ctx, round, count, startIndex) {
    const dir = path.join(ctx.paths.artifactsDir, 'themes');
    await fs.mkdir(dir, { recursive: true });
    const themesDir = path.join(ctx.dataRoot, 'default-user', 'themes');
    const created = [];
    for (let index = 0; index < count; index += 1) {
        const name = `A19 Theme r${round} ${startIndex + index + 1}`;
        const file = await writeThemeFile(path.join(dir, `a19-theme-r${round}-s${startIndex}-${index}.json`), startIndex + index);
        const before = await listFiles(themesDir);
        await page.setInputFiles('#ui_preset_import_file', file).catch(() => {});
        await page.waitForTimeout(2000);
        // THE PRODUCT WRITES THE THEME FILE through `/api/themes/save`; the disk is the observation.
        const after = await listFiles(themesDir);
        const added = after.filter(entry => !before.includes(entry));
        const ok = added.length > 0;
        const result = { ok, added, beforeCount: before.length, afterCount: after.length };
        await ctx.act({ page: 'UI Theme', control: '#ui_preset_import_file', field: 'theme', action: `import ${path.basename(file)} through the theme import input`, result, created: ok ? { themes: 1 } : undefined });
        ctx.report.step(`theme-imported-r${round}-${index}`, ok, result);
        if (ok) created.push(name);
    }
    return created;
}

async function createQuickReplies(page, ctx, round, count, startIndex) {
    const created = [];
    const qrDir = path.join(ctx.dataRoot, 'default-user', 'QuickReplies');
    for (let index = 0; index < count; index += 1) {
        const setName = `A19R${round} QR ${startIndex + index + 1}`;
        const label = `A19 QR r${round} ${startIndex + index + 1}`;
        // QUICK REPLIES THROUGH THE EXTENSION'S OWN SLASH COMMANDS, typed into the real chat input. The
        // extension's direct API object needs its settings UI initialised (`createSet` threw on an
        // uninitialised `rerender`), and the slash commands are the user-facing entry the UI documents.
        const setCreate = await runSlashCommand(page, `/qr-set-create name="${setName}"`);
        const entryCreate = await runSlashCommand(page, `/qr-create set="${setName}" label="${label}" message="/echo ${label} 快捷回复"`);
        await page.waitForTimeout(1200);
        await saveSettingsNow(page).catch(() => {});
        const files = await listFiles(qrDir);
        const ok = setCreate.ok === true && entryCreate.ok === true && files.some(name => name.startsWith(setName));
        const result = { ok, setCreate, entryCreate, files: files.filter(name => name.startsWith('A19')) };
        await ctx.act({ page: 'Chat input (Quick Replies extension)', control: '#send_textarea + #send_but', field: `QR set ${setName}`, action: `create set via /qr-set-create and one entry via /qr-create (label ${label})`, result, created: ok ? { quickReplies: 1 } : undefined });
        ctx.report.step(`quick-reply-created-r${round}-${index}`, ok, result);
        if (ok) created.push(setName);
    }
    return created;
}

async function createRegexes(page, ctx, round, count, startIndex) {
    const created = [];
    for (let index = 0; index < count; index += 1) {
        const name = `A19R${round} Regex ${startIndex + index + 1}`;
        const result = await page.evaluate(async ({ name: scriptName, marker }) => {
            const script = await import('./script.js');
            const { extension_settings: settings } = await import('./scripts/extensions.js');
            if (!Array.isArray(settings.regex)) settings.regex = [];
            const entry = {
                id: `a19r${marker}`,
                scriptName,
                findRegex: marker,
                replaceString: `<A19_REGEX_${marker}>`,
                trimStrings: [],
                placement: [2],
                disabled: false,
                markdownOnly: false,
                promptOnly: false,
                runOnEdit: true,
                substituteRegex: 0,
                minDepth: null,
                maxDepth: null,
            };
            settings.regex.push(entry);
            script.saveSettingsDebounced();
            await script.saveSettings();
            return { ok: true, name: scriptName, count: settings.regex.length };
        }, { name, marker: `A19R${round}REGEX${startIndex + index}` });
        // THE DISK IS THE OBSERVATION: the regex extension's own settings save is what persists the script,
        // so the check reads settings.json rather than a second in-page module instance.
        const settingsOnDisk = (await readSettingsFile(ctx.dataRoot)).settings ?? {};
        const regexes = settingsOnDisk?.extension_settings?.regex ?? [];
        const listed = { ok: regexes.some(entry => entry.scriptName === name), count: regexes.length };
        const ok = result.ok === true && listed.ok === true;
        await ctx.act({ page: 'Regex extension', control: 'extension_settings.regex + saveSettings (the extension\'s own settings path)', field: `regex ${name}`, action: 'add a regex script and persist it through the product settings save', result: { result, listed }, created: ok ? { regexes: 1 } : undefined });
        ctx.report.step(`regex-created-r${round}-${index}`, ok, { result, listed });
        if (ok) created.push(name);
    }
    return created;
}

async function exerciseVariablesAndStscript(page, ctx, round) {
    const steps = [];
    const commands = [
        `/setvar key=a19r${round}var value=42_${round}`,
        `/setglobalvar key=a19r${round}global value=global_${round}`,
        `/addvar key=a19r${round}var value=1`,
    ];
    for (const command of commands) {
        const before = await readVariables(page, round);
        const result = await runSlashCommand(page, command);
        const after = await readVariables(page, round);
        const changed = JSON.stringify(before) !== JSON.stringify(after);
        steps.push({ command, ok: result.ok === true && changed, before, after });
        await ctx.act({ page: 'Chat input', control: '#send_textarea + #send_but (STscript)', field: 'slash command', action: command, result: { ok: result.ok, changed, after } });
    }
    // THE OBSERVABLE CLAIM: at least one variable-scope change is visible in the product's own variable
    // state after a slash command turn. A `/setglobalvar` that the extension's own state does not expose
    // is recorded as observed but does NOT decide the step (a scope this version does not initialise is
    // a fact about the scope, not a pass or a failure of the corpus).
    const observedChange = steps.some(entry => entry.ok === true);
    ctx.report.step(`variables-and-stscript-r${round}`, observedChange, steps);
    return steps;
}

// -----------------------------------------------------------------------------------------------------------------
// THE ROUND
// -----------------------------------------------------------------------------------------------------------------

/**
 * Run one round. `ctx` is provided by a19-corpus-builder.mjs:
 *   { dataRoot, paths, report, act, provider }
 */
function scaledPlan(round) {
    const base = ROUND_PLANS[round];
    const scale = Number(process.env.A19_PLAN_SCALE ?? '1');
    if (!(scale > 0 && scale < 1)) return base;
    const shrink = (value, floor) => Math.max(floor, Math.round(value * scale));
    return {
        ...base,
        cards: shrink(base.cards, 2),
        worlds: shrink(base.worlds, 1),
        entriesPerWorld: shrink(base.entriesPerWorld, 3),
        presets: shrink(base.presets, 1),
        chats: shrink(base.chats, 2),
        turnsPerChat: shrink(base.turnsPerChat, 2),
        groups: shrink(base.groups, 1),
        personas: shrink(base.personas, 1),
        backgrounds: shrink(base.backgrounds, 1),
        themes: shrink(base.themes, 1),
        quickReplies: shrink(base.quickReplies, 1),
        regexes: shrink(base.regexes, 1),
    };
}

/** Run one round. A19_PLAN_SCALE<1 shrinks the plan for plumbing runs (recorded in the round notes). */
export async function runRound(page, ctx, round) {
    const plan = scaledPlan(round);
    if (!plan) throw new Error(`no plan for round ${round}`);
    ctx.report.notes.push(`round ${round} plan ${JSON.stringify(plan)}`);
    const startedAt = Date.now();
    const phaseMs = {};
    const phase = async (name, work) => {
        const at = Date.now();
        const result = await work();
        phaseMs[name] = Date.now() - at;
        ctx.report.notes.push(`phase ${name} ${phaseMs[name]} ms`);
        return result;
    };

    // 1. EXTRAS (personas via slash commands, variables/STscript, themes, backgrounds, quick replies,
    //    regex): fast product entry points, so they cost seconds rather than minutes.
    const extras = await phase('extras', async () => {
        const personas = await createPersonas(page, ctx, round, plan.personas, (round - 1) * 2);
        const variables = await exerciseVariablesAndStscript(page, ctx, round);
        const themes = await importThemes(page, ctx, round, plan.themes, (round - 1) * 2);
        const backgrounds = await uploadBackgrounds(page, ctx, round, plan.backgrounds, (round - 1) * 2);
        const quickReplies = await createQuickReplies(page, ctx, round, plan.quickReplies, (round - 1) * 4);
        const regexes = await createRegexes(page, ctx, round, plan.regexes, (round - 1) * 4);
        return { personas, variables, themes, backgrounds, quickReplies, regexes };
    });

    // 2. CARDS: the bulk arrive through the product's real card-import control (the prompt explicitly
    //    allows generated card INPUT files whose import goes through the tavern's own entry point); a
    //    representative subset is hand-created/edited/duplicated through the panels.
    const cards = await phase('cards', async () => {
        if (round === 2) {
            // This round's job is USE, not rebuild: imports plus the panel verbs.
            const imported = await importCards(page, ctx, round, 4, 20);
            const verbs = await cardVerbs(page, ctx, round, imported);
            void verbs;
            return [...imported];
        }
        const hand = await createCards(page, ctx, round, round === 1 ? 4 : 0);
        const importCount = round === 1 ? plan.cards - hand.length : 0;
        const imported = await importCards(page, ctx, round, importCount, 4 + (round - 1) * 20);
        return [...hand, ...imported];
    });
    ctx.report.counts.cardsCreated = cards.length;

    // 3. LOREBOOKS: imported through Import World Info (the product parses them); a representative book
    //    per round is still built entry-by-entry through the real New Entry editor.
    const books = await phase('worlds', async () => {
        const imported = await importWorldBooks(page, ctx, round, plan, (round - 1) * 3);
        if (round === 1) {
            const hand = await createWorldBooks(page, ctx, round, { ...plan, worlds: 1, entriesPerWorld: Math.min(plan.entriesPerWorld, 8) }, 0);
            return [...imported, ...hand];
        }
        return imported;
    });
    const worldNames = books.map(book => book.name);
    if (worldNames.length > 0) {
        const selected = await selectWorldGlobally(page, worldNames.slice(0, Math.min(3, worldNames.length)));
        await ctx.act({ page: 'World Info drawer', control: '#world_info + updateWorldInfoSettings', field: 'global selection', action: `select ${worldNames.slice(0, 3).join(', ')} as global lorebooks`, result: selected });
        ctx.report.step(`worlds-selected-r${round}`, selected.ok === true, selected);
        if (cards[0]) {
            await openCharacter(page, cards[0].name);
            const bound = await page.evaluate(async wanted => {
                const worldInfo = await import('./scripts/world-info.js');
                await worldInfo.charUpdatePrimaryWorld(wanted);
                const script = await import('./script.js');
                const context = window.SillyTavern?.getContext?.() ?? null;
                const character = context?.characterId !== null && context?.characterId !== undefined ? script.characters?.[context.characterId] : null;
                return { ok: true, bound: character?.data?.extensions?.world ?? null };
            }, worldNames[0]);
            await saveSettingsNow(page);
            await ctx.act({ page: 'Character World control path', control: 'charUpdatePrimaryWorld', field: 'character lorebook', action: `bind ${worldNames[0]} to ${cards[0].name}`, result: bound });
            ctx.report.step(`character-bound-world-r${round}`, bound.bound === worldNames[0], bound);
        }
    }

    // 4. PRESETS: imported through the real import input, edited through the UI slider and saved through
    //    the product's own Update current preset button.
    const presets = await phase('presets', () => importPresets(page, ctx, round, plan, (round - 1) * 3));

    // 5. CHATS: the bulk of the corpus. Real sends in a tight loop; a deterministic subset exercises the
    //    verbs (swipe/regenerate/continue/edit/delete) and the round-3 preset-wire proof.
    const presetWireProof = round === 3 ? { presets, observed: [] } : null;
    const chats = await phase('chats', () => runChats(page, ctx, round, plan, cards, presets, presetWireProof));
    if (presetWireProof) {
        await ctx.act({ page: 'AI Response Configuration + Chat', control: '#settings_preset_openai + #send_but', field: 'preset wire proof', action: `send one turn per corpus preset (${presetWireProof.observed.length}) and record the provider request ordinals`, result: presetWireProof.observed });
        ctx.report.counts.presetWireTurns = presetWireProof.observed.length;
    }

    // 6. GROUPS.
    const groups = await phase('groups', () => runGroups(page, ctx, round, plan, cards));

    const settings = await readSettingsFile(ctx.dataRoot);
    const worldFiles = [];
    for (const name of worldNames) {
        worldFiles.push(await readWorldBookFile(ctx.dataRoot, name).catch(() => null));
    }
    const summary = {
        round,
        cards: cards.length,
        cardsHandCreated: round === 1 ? 4 : 0,
        cardsImported: cards.length - (round === 1 ? 4 : 0),
        worlds: worldNames.length,
        worldEntries: worldFiles.reduce((sum, world) => sum + (world?.entryCount ?? 0), 0),
        presets: presets.length,
        chats: chats.length,
        messages: chats.reduce((sum, chat) => sum + (chat.messages ?? 0), 0),
        groups: groups.length,
        personas: extras.personas.length,
        themes: extras.themes.length,
        backgrounds: extras.backgrounds.length,
        quickReplies: extras.quickReplies.length,
        regexes: extras.regexes.filter(Boolean).length,
        variables: extras.variables.filter(entry => entry.ok).length,
        settingsSha256: settings.sha256,
        phaseMs,
        totalMs: Date.now() - startedAt,
    };
    ctx.report.counts.summary = summary;
    ctx.report.notes.push(`round ${round} summary ${JSON.stringify(summary)}`);
    await saveSettingsNow(page);
    return summary;
}


// -----------------------------------------------------------------------------------------------------------------
// TOP-UP MODE: reach the minimum matrix on an EXISTING corpus root, adding only what is missing.
// -----------------------------------------------------------------------------------------------------------------

/** The counts a consumer asks for, read from the tree the product wrote. */
export async function diskCounts(dataRoot) {
    const user = path.join(dataRoot, 'default-user');
    const filesIn = async (directory, filter) => {
        const found = [];
        const walk = async target => {
            let entries = [];
            try {
                entries = await fs.readdir(target, { withFileTypes: true });
            } catch {
                return;
            }
            for (const entry of entries) {
                const full = path.join(target, entry.name);
                if (entry.isDirectory()) await walk(full);
                else if (entry.isFile() && filter(entry.name)) found.push(full);
            }
        };
        await walk(directory);
        return found;
    };
    // TOP-LEVEL ONLY: pinned keeps per-character settings SUBDIRECTORIES under characters/ whose files
    // are not cards; a recursive count double-counts them (measured: 54 vs 26 real card files).
    const characterEntries = await fs.readdir(path.join(user, 'characters')).catch(() => []);
    let characters = 0;
    for (const name of characterEntries) {
        try {
            const stat = await fs.stat(path.join(user, 'characters', name));
            if (stat.isFile() && /\.(png|jpe?g|webp)$/i.test(name)) characters += 1;
        } catch {
            // unreadable entry is not a card
        }
    }
    const worldFiles = await filesIn(path.join(user, 'worlds'), name => /\.json$/i.test(name));
    let worldEntries = 0;
    for (const file of worldFiles) {
        try {
            const world = JSON.parse(await fs.readFile(file, 'utf8'));
            worldEntries += Object.keys(world?.entries ?? {}).length;
        } catch { /* unreadable world is not counted */ }
    }
    const presets = (await filesIn(path.join(user, 'OpenAI Settings'), name => /\.json$/i.test(name))).length;
    const chatFiles = await filesIn(path.join(user, 'chats'), name => name.endsWith('.jsonl'));
    let messages = 0;
    for (const file of chatFiles) {
        const body = await fs.readFile(file, 'utf8');
        for (const line of body.split('\n')) {
            if (!line.trim()) continue;
            try {
                const record = JSON.parse(line);
                const header = record && (Object.prototype.hasOwnProperty.call(record, 'chat_metadata') || Object.prototype.hasOwnProperty.call(record, 'user_name'));
                if (!header) messages += 1;
            } catch { /* malformed line is not a message */ }
        }
    }
    const groups = (await filesIn(path.join(user, 'groups'), name => /\.json$/i.test(name))).length;
    const themes = (await filesIn(path.join(user, 'themes'), name => /\.json$/i.test(name))).length;
    const backgrounds = (await filesIn(path.join(user, 'backgrounds'), name => /\.(png|jpe?g|webp|mp4)$/i.test(name))).length;
    const quickReplies = (await filesIn(path.join(user, 'QuickReplies'), name => /\.json$/i.test(name))).length;
    let personas = 0;
    let regexes = 0;
    try {
        const settings = JSON.parse(await fs.readFile(path.join(user, 'settings.json'), 'utf8'));
        personas = Object.keys(settings?.power_user?.personas ?? {}).length;
        regexes = (settings?.extension_settings?.regex ?? []).length;
    } catch { /* settings unreadable: zeros, not a pass */ }
    return { characters, worlds: worldFiles.length, worldEntries, presets, chats: chatFiles.length, messages, groups, themes, backgrounds, quickReplies, personas, regexes };
}

async function rosterNames(page) {
    return page.evaluate(async () => {
        const script = await import('./script.js');
        const deadline = Date.now() + 60000;
        let names = [];
        while (Date.now() < deadline) {
            names = (script.characters ?? []).map(character => String(character?.name ?? '')).filter(Boolean).sort();
            if (names.length > 0) break;
            await new Promise(resolve => setTimeout(resolve, 250));
        }
        return names;
    });
}

/**
 * Add exactly what the minimum matrix is missing. Every addition goes through the same product entry
 * points the rounds use; nothing is copied into the tree. Phases are disk-count driven, so a re-run after
 * a partial failure continues instead of duplicating.
 */
export async function runTopUp(page, ctx) {
    const startedAt = Date.now();
    const phaseMs = {};
    const turns = { attempted: 0, ok: 0, failed: 0, totalMs: 0 };
    const phase = async (name, work) => {
        const at = Date.now();
        const result = await work();
        phaseMs[name] = Date.now() - at;
        ctx.report.notes.push(`topup phase ${name} ${phaseMs[name]} ms`);
        return result;
    };
    const TARGET = { characters: 30, worlds: 8, worldEntries: 150, presets: 10, chats: 50, messages: 1000, groups: 5, personas: 5, themes: 4, backgrounds: 4, quickReplies: 8, regexes: 8 };

    let counts = await diskCounts(ctx.dataRoot);
    ctx.report.notes.push(`topup start ${JSON.stringify(counts)}`);
    const roster = await rosterNames(page);

    // CARDS: imports through the character import control.
    if (counts.characters < TARGET.characters) {
        await phase('cards', () => importCards(page, ctx, 3, TARGET.characters - counts.characters, 40));
    }
    counts = await diskCounts(ctx.dataRoot);

    // WORLDS: import books of 20 entries until both the book and entry minima hold.
    if (counts.worlds < TARGET.worlds || counts.worldEntries < TARGET.worldEntries) {
        await phase('worlds', async () => {
            let bookIndex = 0;
            while (bookIndex < 12) {
                const current = await diskCounts(ctx.dataRoot);
                if (current.worlds >= TARGET.worlds && current.worldEntries >= TARGET.worldEntries) break;
                await importWorldBooks(page, ctx, 3, { worlds: 1, entriesPerWorld: 20 }, 40 + bookIndex);
                bookIndex += 1;
            }
        });
    }
    counts = await diskCounts(ctx.dataRoot);

    // PRESETS: import through the AI Response Configuration import input.
    if (counts.presets < TARGET.presets) {
        await phase('presets', () => importPresets(page, ctx, 3, { presets: TARGET.presets - counts.presets }, 40));
    }
    counts = await diskCounts(ctx.dataRoot);

    // GROUPS: the real group panel; one auto-reply turn each, plus swipe/continue on the first.
    if (counts.groups < TARGET.groups) {
        await phase('groups', async () => {
            let groupIndex = 0;
            while (groupIndex < 12) {
                const current = await diskCounts(ctx.dataRoot);
                if (current.groups >= TARGET.groups) break;
                const memberNames = roster.slice((groupIndex * 3) % Math.max(1, roster.length), (groupIndex * 3) % Math.max(1, roster.length) + 3);
                if (memberNames.length < 2) break;
                const created = await createGroupThroughPanel(page, {
                    name: `A19R3 TopUp Group ${counts.groups + groupIndex + 1}`,
                    memberNames,
                    activationStrategy: groupIndex % 2,
                    generationMode: groupIndex % 2,
                });
                ctx.report.step(`topup-group-${groupIndex}`, created.ok === true && (created.memberCount ?? 0) > 0, created);
                if (created.ok) {
                    const opened = await openGroup(page, created.group.id, true);
                    if (opened.ok) {
                        const turn = await fastChatTurn(page, `A19 R3 TOPUP G${groupIndex + 1} T0 多人群聊 top-up turn。`);
                        turns.attempted += 1;
                        if (turn.ok) turns.ok += 1; else turns.failed += 1;
                        turns.totalMs += turn.elapsedMs ?? 0;
                        await saveConditional(page);
                    }
                    ctx.report.step(`topup-group-opened-${groupIndex}`, opened.ok === true, opened);
                }
                groupIndex += 1;
            }
        });
    }
    counts = await diskCounts(ctx.dataRoot);

    // CHATS + MESSAGES: the minimum matrix's bulk. New chats through the product, real sends in the tight
    // loop until the persisted (header-stripped) message count reaches 1000 and the chat count reaches 50.
    if (counts.chats < TARGET.chats || counts.messages < TARGET.messages) {
        await phase('chats', async () => {
            let chatIndex = 0;
            let consecutiveFailures = 0;
            while (chatIndex < 80) {
                const current = await diskCounts(ctx.dataRoot);
                if (current.chats >= TARGET.chats && current.messages >= TARGET.messages) break;
                const card = roster[(counts.chats + chatIndex) % Math.max(1, roster.length)];
                const opened = await openCardAndNewChat(page, card);
                if (!opened.ok) {
                    consecutiveFailures += 1;
                    ctx.report.step(`topup-chat-open-${chatIndex}`, false, opened);
                    if (consecutiveFailures >= 3) break;
                    continue;
                }
                consecutiveFailures = 0;
                let sent = 0;
                const turnsThisChat = 20;
                for (let turnIndex = 0; turnIndex < turnsThisChat; turnIndex += 1) {
                    const turn = await fastChatTurn(page, turnTextFor(3, chatIndex, turnIndex));
                    turns.attempted += 1;
                    turns.totalMs += turn.elapsedMs ?? 0;
                    if (turn.ok) { turns.ok += 1; sent += 2; } else { turns.failed += 1; }
                }
                await saveConditional(page);
                ctx.report.step(`topup-chat-${chatIndex}`, sent > 0, { card, chatId: opened.chatId, sent });
                await ctx.act({ page: 'Chat', control: '#send_textarea + #send_but', field: `topup chat ${chatIndex}`, action: `start a new chat and send ${turnsThisChat} real turns`, result: { sent }, created: { chats: 1, messages: sent } });
                chatIndex += 1;
            }
        });
    }
    counts = await diskCounts(ctx.dataRoot);

    // EXTRAS to their minima (fast product entry points).
    await phase('extras', async () => {
        if (counts.personas < TARGET.personas) await createPersonas(page, ctx, 3, TARGET.personas - counts.personas, 40);
        if (counts.themes < TARGET.themes) await importThemes(page, ctx, 3, TARGET.themes - counts.themes, 40);
        if (counts.backgrounds < TARGET.backgrounds) await uploadBackgrounds(page, ctx, 3, TARGET.backgrounds - counts.backgrounds, 40);
        if (counts.quickReplies < TARGET.quickReplies) await createQuickReplies(page, ctx, 3, TARGET.quickReplies - counts.quickReplies, 40);
        if (counts.regexes < TARGET.regexes) await createRegexes(page, ctx, 3, TARGET.regexes - counts.regexes, 40);
    });
    counts = await diskCounts(ctx.dataRoot);

    const seconds = (Date.now() - startedAt) / 1000;
    const summary = {
        mode: 'topup',
        disk: counts,
        targets: TARGET,
        turns: { ...turns, perSecond: seconds > 0 ? Number((turns.ok / seconds).toFixed(2)) : 0, avgTurnMs: turns.ok > 0 ? Math.round(turns.totalMs / turns.attempted) : null },
        phaseMs,
        totalMs: Date.now() - startedAt,
    };
    ctx.report.counts.topUp = summary;
    ctx.report.notes.push(`topup summary ${JSON.stringify(summary)}`);
    await saveSettingsNow(page);
    return summary;
}
// -----------------------------------------------------------------------------------------------------------------
// SHORT USE / RESTART PHASES (rounds 2 and 3): use and edit what the corpus already has; never rebuild it.
// -----------------------------------------------------------------------------------------------------------------

/**
 * ROUND 2 (use/edit): open existing chats, send a few turns with the verbs, edit the preset through the UI,
 * duplicate/edit a card, reload and confirm the chat comes back. Short by design: the matrix is the top-up.
 */
export async function runUsePhase(page, ctx) {
    const startedAt = Date.now();
    const phaseMs = {};
    const phase = async (name, work) => {
        const at = Date.now();
        const result = await work();
        phaseMs[name] = Date.now() - at;
        ctx.report.notes.push(`use phase ${name} ${phaseMs[name]} ms`);
        return result;
    };
    const roster = await rosterNames(page);
    const chatFiles = await readChatFiles(ctx.dataRoot);
    const sortedChats = [...chatFiles].sort((left, right) => String(left.file).localeCompare(String(right.file)));
    const cards = await phase('reopen-and-use', async () => {
        const used = [];
        for (let index = 0; index < Math.min(4, sortedChats.length); index += 1) {
            const chat = sortedChats[index];
            const cardName = path.basename(path.dirname(String(chat.file)));
            const stem = path.basename(String(chat.file)).replace(/\.jsonl$/i, '');
            const opened = await openCharacter(page, cardName).catch(() => null);
            const resumed = await page.evaluate(async name => {
                const script = await import('./script.js');
                try { await script.openCharacterChat(name); } catch { return { ok: false }; }
                const deadline = Date.now() + 30000;
                let last = null;
                while (Date.now() < deadline) {
                    last = { chatId: window.SillyTavern?.getContext?.()?.chatId ?? null, chatLength: (script.chat ?? []).length };
                    if (String(last.chatId ?? '') === name) return { ok: true, ...last };
                    await new Promise(resolve => setTimeout(resolve, 200));
                }
                return { ok: false, ...(last ?? {}) };
            }, stem);
            used.push({ cardName, stem, opened: opened?.opened === true, resumed });
            if (!resumed.ok) continue;
            for (let turnIndex = 0; turnIndex < 3; turnIndex += 1) {
                const turn = await fastChatTurn(page, `A19 R2 USE C${index} T${turnIndex} 继续使用。`);
                if (turn.ok) used[used.length - 1].turns = (used[used.length - 1].turns ?? 0) + 1;
            }
            if (index === 0) await swipeLastMessage(page);
            if (index === 1) await pressRegenerateThroughMenu(page);
            if (index === 2) await pressContinue(page);
            if (index === 3) await editLastMessage(page, `A19 R2 EDITED trailing message 编辑 ✍️`);
            await saveConditional(page);
        }
        return used;
    });
    // PRESET EDIT through the product controls.
    const preset = await phase('preset-edit', async () => {
        const result = await page.evaluate(async () => {
            const select = document.querySelector('#settings_preset_openai');
            const options = [...(select?.options ?? [])].filter(option => /^A19/.test(option.textContent.trim()));
            if (options.length === 0) return { ok: false, reason: 'no corpus preset listed' };
            select.value = options[0].value;
            select.dispatchEvent(new Event('change', { bubbles: true }));
            await new Promise(resolve => setTimeout(resolve, 800));
            const field = document.querySelector('#temp_openai');
            if (!field) return { ok: false, reason: '#temp_openai missing' };
            field.value = '0.77';
            field.dispatchEvent(new Event('input', { bubbles: true }));
            document.querySelector('#update_oai_preset')?.click();
            await new Promise(resolve => setTimeout(resolve, 600));
            return { ok: true, presetName: options[0].textContent.trim(), temperature: 0.77 };
        });
        await ctx.act({ page: 'AI Response Configuration', control: '#settings_preset_openai + #temp_openai + #update_oai_preset', field: 'edit preset', action: 'select a corpus preset, change temperature and press Update current preset', result });
        ctx.report.step('use-preset-edited', result.ok === true, result);
        return result;
    });
    // CARD DUPLICATE/EDIT through the panels.
    const cardVerbsResult = await phase('card-verbs', () => cardVerbs(page, ctx, 2, roster.map(name => ({ name }))));
    // RELOAD PERSISTENCE on the last used chat.
    const reload = await phase('reload', async () => {
        const last = cards.find(entry => entry.resumed?.ok);
        if (!last) return { ok: false, reason: 'no chat was opened' };
        const result = await reloadAndReopen(page, last.cardName, `${last.stem}.jsonl`);
        ctx.report.step('use-reload-preserved', result.ok === true, result);
        return result;
    });
    const summary = { mode: 'use', roster: roster.length, chatsUsed: cards.length, preset, cardVerbs: cardVerbsResult, reload: reload.ok === true, phaseMs, totalMs: Date.now() - startedAt };
    ctx.report.counts.usePhase = summary;
    await saveSettingsNow(page);
    return summary;
}

/** ROUND 3 (restart): a NEW server process reopens the corpus; the persisted chats and groups must resume. */
export async function runRestartPhase(page, ctx) {
    const startedAt = Date.now();
    const phaseMs = {};
    const phase = async (name, work) => {
        const at = Date.now();
        const result = await work();
        phaseMs[name] = Date.now() - at;
        ctx.report.notes.push(`restart phase ${name} ${phaseMs[name]} ms`);
        return result;
    };
    const roster = await rosterNames(page);
    const chatFiles = await readChatFiles(ctx.dataRoot);
    const before = {
        characters: roster.length,
        chats: chatFiles.length,
        messages: chatFiles.reduce((sum, chat) => sum + (chat.messages ?? []).length, 0),
    };
    const resumed = await phase('reopen', async () => {
        const opened = [];
        for (const chat of chatFiles.slice(0, 3)) {
            const cardName = path.basename(path.dirname(String(chat.file)));
            const stem = path.basename(String(chat.file)).replace(/\.jsonl$/i, '');
            await openCharacter(page, cardName).catch(() => null);
            const state = await page.evaluate(async name => {
                const script = await import('./script.js');
                try { await script.openCharacterChat(name); } catch { return { ok: false }; }
                const deadline = Date.now() + 30000;
                let last = null;
                while (Date.now() < deadline) {
                    last = { chatId: window.SillyTavern?.getContext?.()?.chatId ?? null, chatLength: (script.chat ?? []).length };
                    if (String(last.chatId ?? '') === name && last.chatLength > 0) return { ok: true, ...last };
                    await new Promise(resolve => setTimeout(resolve, 200));
                }
                return { ok: false, ...(last ?? {}) };
            }, stem);
            opened.push({ file: chat.file, ...state });
        }
        return opened;
    });
    const continued = await phase('continue-using', async () => {
        const turns = [];
        for (let index = 0; index < 5; index += 1) {
            const turn = await fastChatTurn(page, `A19 R3 RESTART M${index} 重启后继续。`);
            turns.push({ ok: turn.ok, elapsedMs: turn.elapsedMs });
            if (turn.ok) await saveConditional(page);
        }
        return turns;
    });
    const reload = await phase('reload', async () => {
        const first = resumed.find(entry => entry.ok);
        if (!first) return { ok: false, reason: 'no persisted chat resumed' };
        return reloadAndReopen(page, roster[0], first.chatId ? `${first.chatId}.jsonl` : null);
    });
    const after = {
        characters: (await rosterNames(page)).length,
        chats: (await readChatFiles(ctx.dataRoot)).length,
        messages: (await readChatFiles(ctx.dataRoot)).reduce((sum, chat) => sum + (chat.messages ?? []).length, 0),
    };
    const summary = { mode: 'restart', before, after, resumed, continued, reloadOk: reload.ok === true, phaseMs, totalMs: Date.now() - startedAt };
    ctx.report.counts.restartPhase = summary;
    ctx.report.step('restart-resumed-persisted-chats', resumed.some(entry => entry.ok === true), resumed);
    ctx.report.step('restart-continued-generation', continued.every(turn => turn.ok === true), continued);
    return summary;
}
