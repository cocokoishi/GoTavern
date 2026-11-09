// a19-corpus-gapfill.mjs -- bounded gap-fill on the FINALIZED corpus root: created minima, the pinned
// Tavern Helper extension, and the verb matrix. Run through the pinned wrapper.
//
//   node tests/browser/run-against-pinned.mjs a19-corpus-gapfill.mjs --data-root <corpus> -- \
//        --report <path> --actions <path>
//
// Everything goes through the product: one card through #character_import_file, two lorebook entries
// through the real World Info entry editor, the extension enabled through its Extensions-panel toggle and
// exercised through the helper's own global API (`globalThis.TavernHelper`, measured present in the pinned
// bundle), then swipe / regenerate / continue / edit / delete / save-reopen on existing chats.

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { openPage, readReadiness, openCharacter, sendTurn, waitForReply, saveConditional, readChatFiles, pressContinue, pressRegenerateThroughMenu } from './q20-persistence-drive.mjs';
import { corpusPaths, ensureConnection, startProvider, createWorldEntry, openWorldInEditor, saveSettingsNow } from './a19-corpus-kit.mjs';
import { importCards, swipeLastMessage, editLastMessage, deleteLastMessage, diskCounts } from './a19-corpus-journeys.mjs';

const argv = process.argv.slice(2);
const argument = (name, fallback) => {
    const index = argv.indexOf(name);
    return index === -1 ? fallback : argv[index + 1] ?? fallback;
};
const baseURL = process.env.PROBE_BASE_URL ?? argument('--base-url', null);
const dataRoot = path.resolve(process.env.A19_DATA_ROOT ?? argument('--data-root', ''));
const reportPath = path.resolve(argument('--report', path.join(corpusPaths(11).roundDir, 'gapfill.json')));
const actionsPath = path.resolve(argument('--actions', path.join(corpusPaths(11).roundDir, 'actions-gapfill.jsonl')));
const report = { schema: 'a19-gapfill-v1', startedAt: new Date().toISOString(), dataRoot, countsBefore: null, countsAfter: null, steps: [], extension: null, verbs: [], failures: [] };
const step = (name, ok, detail) => {
    report.steps.push({ name, ok: ok === true, detail, at: new Date().toISOString() });
    if (ok !== true) report.failures.push({ name, detail });
    return ok;
};
const act = async entry => {
    await fs.mkdir(path.dirname(actionsPath), { recursive: true });
    await fs.appendFile(actionsPath, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
};

const chromium = (await import('@playwright/test')).chromium;
let browser = null;
let provider = null;
try {
    report.countsBefore = await diskCounts(dataRoot);
    provider = await startProvider({ roundDir: path.dirname(reportPath), round: 11, label: 'provider-gapfill', wire: 'json' });
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
    const page = await context.newPage();
    const helperRequests = [];
    page.on('response', response => {
        const url = response.url();
        if (url.includes('JS-Slash-Runner') || url.includes('third-party')) helperRequests.push({ url: url.replace(baseURL, '<base>').slice(0, 200), status: response.status() });
    });
    const loaded = await openPage(page, baseURL);
    const readiness = await readReadiness(page);
    step('page-loaded', loaded === true && readiness?.settingsReady === true, readiness);
    const connection = await ensureConnection(page, provider.baseURL, 'a19-live-model', { streaming: false });
    step('connection', connection.ok === true, { state: connection.state });

    // 1) ONE MORE CARD through the character import control (created cards 29 -> 30).
    const cardCtx = { dataRoot, paths: corpusPaths(11), report: { step: (name, ok, detail) => step(name, ok, detail), notes: [] }, act: entry => act({ phase: 'cards', ...entry }), provider, streaming: false };
    const importedCards = await importCards(page, cardCtx, 3, 1, 70);
    step('gap-card-imported', importedCards.length === 1, importedCards);

    // 2) TWO MORE WORLD ENTRIES through the real entry editor of an existing corpus lorebook.
    const worlds = [];
    const walkWorlds = async directory => {
        for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch(() => [])) {
            const full = path.join(directory, entry.name);
            if (entry.isDirectory()) await walkWorlds(full);
            else if (entry.isFile() && entry.name.endsWith('.json')) worlds.push(full);
        }
    };
    await walkWorlds(path.join(dataRoot, 'default-user', 'worlds'));
    const targetWorldFile = worlds.find(file => /Imported Lore/.test(file)) ?? worlds[0];
    const targetWorld = targetWorldFile ? path.basename(targetWorldFile, '.json') : null;
    let entriesAdded = 0;
    if (targetWorld) {
        const editor = await openWorldInEditor(page, targetWorld);
        step('gap-world-editor-opened', editor.ok === true, { world: targetWorld, editor });
        for (const index of [0, 1]) {
            const entry = await createWorldEntry(page, targetWorld, {
                comment: `A19 GAPFILL ENTRY ${index + 1}`,
                content: `A19_GAPFILL_${index + 1} 补齐条目：雨停之后，账本多了一页。${index === 0 ? ' First gap entry.' : ' Second gap entry with 中文 and emoji 🌂.'}`,
                keys: [`a19gapfill${index + 1}`],
                position: index === 0 ? 0 : 4,
                depth: 2,
                order: 200 + index,
            });
            if (entry.ok) entriesAdded += 1;
            await act({ phase: 'world-entry', page: 'World Info entry editor', control: '#world_popup_new + editor fields', field: `entry A19 GAPFILL ENTRY ${index + 1}`, action: 'create an entry through the real New Entry button and type its fields through the editor', result: entry });
        }
        await saveSettingsNow(page).catch(() => {});
    }
    step('gap-world-entries', entriesAdded === 2, { world: targetWorld, entriesAdded });

    // 3) THE PINNED TAVERN HELPER / JS-SLASH-RUNNER extension: enabled through its Extensions-panel
    // toggle, then exercised through the helper's own global API and its settings state.
    const extension = await page.evaluate(async () => {
        const { extension_settings } = await import('./scripts/extensions.js');
        const result = { settingsBefore: null, toggle: null, apiPresent: false, apiKeys: [], state: null, variableRoundTrip: null, iframes: [] };
        const settings = extension_settings;
        result.settingsBefore = Object.keys(settings).filter(key => /helper|slash/i.test(key));
        // THE EXTENSIONS PANEL TOGGLE (the product's own control).
        const blocks = [...document.querySelectorAll('#extensions_settings .extension_block, #extensions_settings [data-extension-id], #extensions_settings .inline-drawer')];
        let block = blocks.find(element => /JS-Slash-Runner|helper/i.test(element.getAttribute('data-extension-id') ?? element.id ?? element.textContent ?? ''));
        if (!block) block = blocks.find(element => /JS-Slash-Runner|helper/i.test(element.textContent ?? ''));
        if (block) {
            const checkbox = block.querySelector('input[type="checkbox"]');
            result.toggle = { found: true, checkedBefore: checkbox ? checkbox.checked : null };
            if (checkbox && !checkbox.checked) {
                checkbox.click();
                await new Promise(resolve => setTimeout(resolve, 800));
            }
            result.toggle.checkedAfter = checkbox ? checkbox.checked : null;
        } else {
            result.toggle = { found: false };
        }
        await new Promise(resolve => setTimeout(resolve, 1200));
        const api = globalThis.TavernHelper ?? null;
        result.apiPresent = api !== null && typeof api === 'object';
        if (result.apiPresent) {
            result.apiKeys = Object.keys(api).slice(0, 80);
            const chat = window.SillyTavern?.getContext?.()?.chatId ?? null;
            try {
                if (typeof api.getVariables === 'function') {
                    const before = await api.getVariables({ type: 'chat' });
                    if (typeof api.insertOrAssignVariables === 'function') {
                        await api.insertOrAssignVariables({ A19_GAPFILL_VAR: `gapfill-${Date.now()}` }, { type: 'chat' });
                    } else if (typeof api.replaceVariables === 'function') {
                        await api.replaceVariables({ ...(before ?? {}), A19_GAPFILL_VAR: 'gapfill' }, { type: 'chat' });
                    }
                    const after = await api.getVariables({ type: 'chat' });
                    result.variableRoundTrip = { chat, before, after };
                }
            } catch (error) {
                result.variableRoundTrip = { error: String(error?.message ?? error) };
            }
            try {
                if (typeof api.getExtensionSettings === 'function') result.state = await api.getExtensionSettings();
            } catch (error) {
                result.state = { error: String(error?.message ?? error) };
            }
        }
        result.iframes = [...document.querySelectorAll('iframe')].map(frame => String(frame.getAttribute('src') ?? '').slice(0, 160));
        result.helperSettings = Object.fromEntries(Object.entries(extension_settings.tavern_helper ?? {}).map(([key, value]) => [key, typeof value === 'object' ? (Array.isArray(value) ? `array:${value.length}` : 'object') : value]));
        return result;
    });
    report.extension = { ...extension, helperRequests: helperRequests.slice(0, 40) };
    const helperLoaded = helperRequests.some(request => /JS-Slash-Runner/.test(request.url) && request.status === 200);
    step('extension-loaded', helperLoaded || extension.settingsBefore.length > 0, { helperLoaded, settingsKeys: extension.settingsBefore });
    step('extension-enabled-through-ui', extension.toggle?.found === true, extension.toggle);
    step('extension-api-and-state', extension.apiPresent === true, { apiPresent: extension.apiPresent, apiKeys: extension.apiKeys.slice(0, 30), helperSettings: extension.helperSettings, variableRoundTrip: extension.variableRoundTrip });
    await act({ phase: 'extension', page: 'Extensions panel + Tavern Helper API', control: '#extensions_settings toggle + globalThis.TavernHelper', field: 'Tavern Helper / JS-Slash-Runner', action: 'enable the pinned extension through its panel toggle, then set and read a chat variable through the helper API', result: report.extension });

    // 4) VERB MATRIX on three existing chats: swipe, regenerate, continue, edit, delete, save/reopen.
    const chats = [...(await readChatFiles(dataRoot))].sort((left, right) => String(left.file).localeCompare(String(right.file))).slice(0, 3);
    for (const [index, chat] of chats.entries()) {
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
        const before = await page.evaluate(async () => {
            const script = await import('./script.js');
            const live = script.chat ?? [];
            return { chatLength: live.length, lastTextLength: String(live[live.length - 1]?.mes ?? '').length };
        });
        const turn = resumed.ok ? await sendTurn(page, `A19 GAPFILL VERB ${index} 动词测试。`) : { clicked: false };
        const reply = resumed.ok ? await waitForReply(page, { timeoutMs: 45000, requireText: true, baseline: before }) : { ok: false };
        const verbs = { chat: chat.file, opened: opened?.opened === true, resumed, turnOk: reply.ok === true };
        verbs.swipe = await swipeLastMessage(page);
        verbs.regenerate = await pressRegenerateThroughMenu(page);
        verbs.continue = await pressContinue(page);
        verbs.edit = await editLastMessage(page, `A19 GAPFILL EDITED ${index} 编辑 ✍️`);
        verbs.delete = await deleteLastMessage(page);
        await saveConditional(page);
        const reopen = await page.evaluate(async name => {
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
        verbs.reopen = reopen;
        report.verbs.push(verbs);
        step(`verb-matrix-chat-${index}`, reply.ok === true && reopen.ok === true, verbs);
        await act({ phase: 'verbs', page: 'Chat', control: '#send_but / swipe / regenerate / continue / edit / delete / openCharacterChat', field: `verbs on ${chat.file}`, action: 'send one turn then swipe, regenerate, continue, edit, delete, save and reopen', result: verbs });
    }
    report.countsAfter = await diskCounts(dataRoot);
} catch (error) {
    report.failures.push({ name: 'fatal', detail: String(error?.stack ?? error) });
} finally {
    if (browser) await browser.close().catch(() => {});
    if (provider) await provider.stop().catch(() => {});
    report.finishedAt = new Date().toISOString();
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    const failed = report.steps.filter(step => step.ok !== true).map(step => step.name);
    console.log(JSON.stringify({ steps: report.steps.length, failed, countsBefore: report.countsBefore, countsAfter: report.countsAfter, extension: { loaded: report.extension ? true : false }, verbs: report.verbs.length, report: reportPath }));
}
process.exit(report.failures.filter(failure => failure.name === 'fatal').length === 0 ? 0 : 1);
