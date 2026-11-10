// a20-corpus-topup.mjs -- raise an ALREADY-BUILT pinned corpus to a tier's minimums through real UI
// controls, additively and without re-running the base rounds.
//
// The base rounds are produced by tests/browser/a19-corpus-builder.mjs (rounds 1-3) over the same data
// root; this script imports the SHORTFALL only: character cards, world books, OpenAI presets and group
// chats, each through the product control the pinned frontend uses. It does not hand-write product data:
// every card/book/preset is a generated INPUT FILE the import control consumes (the same pattern the base
// builder uses), and every group is created through the group panel (UI-first, with the product-API
// fallback the base builder already records).
//
// RUN (through the pinned wrapper, like the base rounds):
//   node tests/browser/run-against-pinned.mjs a20-corpus-topup.mjs --data-root <corpus data> -- \
//     --cards-target 64 --worlds-target 12 --world-entries 10 --presets-target 20 --groups-target 8 \
//     --report <scratch>/topup.json --actions <scratch>/actions-topup.jsonl
//
// EVIDENCE: the report carries per-category requested/created counts and the exact predicate used to
// measure "current" (files on disk), so a later finalize pass can compare achieved counts to targets.

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import {
    corpusPaths, ensureConnection, ensureDir, openBrowser, openPage, readReadiness, saveSettingsNow,
    startProvider, sha256,
} from './a19-corpus-kit.mjs';
import {
    importCards, importWorldBooks, createGroupUiFirst, writePresetFile,
} from './a19-corpus-journeys.mjs';

const argv = process.argv.slice(2);
const argument = (name, fallback) => {
    const index = argv.indexOf(name);
    return index === -1 ? fallback : argv[index + 1] ?? fallback;
};
const baseURL = process.env.PROBE_BASE_URL ?? argument('--base-url', null);
const dataRoot = path.resolve(process.env.A19_DATA_ROOT ?? argument('--data-root', ''));
const reportPath = path.resolve(argument('--report', path.join(corpusPaths(90).roundDir, 'a20-topup.json')));
const actionPath = path.resolve(argument('--actions', path.join(corpusPaths(90).roundDir, 'actions-a20-topup.jsonl')));
const targets = {
    cards: Number(argument('--cards-target', '64')),
    worlds: Number(argument('--worlds-target', '12')),
    worldEntries: Number(argument('--world-entries', '10')),
    presets: Number(argument('--presets-target', '20')),
    groups: Number(argument('--groups-target', '8')),
};
// A RE-RUN MUST NOT REUSE THE FIRST RUN'S INPUT INDEX: the generated input file names and the display
// names derived from them are the product's duplicate check, so the second top-up over the same corpus
// asks for a fresh index range instead of colliding with worlds/cards it already imported.
const cardStartIndex = Number(argument('--card-start-index', '1000'));
const worldStartIndex = Number(argument('--world-start-index', '1000'));
if (!baseURL) { console.error('a20-corpus-topup: PROBE_BASE_URL is required (run through run-against-pinned.mjs)'); process.exit(2); }
if (!dataRoot) { console.error('a20-corpus-topup: A19_DATA_ROOT or --data-root is required'); process.exit(2); }

const report = {
    schema: 'a20-corpus-topup-v1',
    startedAt: new Date().toISOString(),
    baseURL,
    dataRoot,
    targets,
    measured: {},
    created: { cards: 0, worlds: 0, worldEntries: 0, presets: 0, groups: 0 },
    steps: [],
    failures: [],
};
const step = (name, ok, detail) => { report.steps.push({ name, ok, detail }); console.log(`[a20-topup] ${ok ? 'ok' : 'FAIL'} ${name} ${JSON.stringify(detail ?? {}).slice(0, 200)}`); };
const action = async entry => {
    await fs.mkdir(path.dirname(actionPath), { recursive: true });
    await fs.appendFile(actionPath, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
};
const userRoot = path.join(dataRoot, 'default-user');

async function countFiles(directory, predicate = () => true) {
    try {
        const entries = await fs.readdir(directory);
        return entries.filter(predicate);
    } catch {
        return [];
    }
}
async function measure() {
    const cards = (await countFiles(path.join(userRoot, 'characters'), name => name.endsWith('.png'))).length;
    const worlds = (await countFiles(path.join(userRoot, 'worlds'), name => name.endsWith('.json'))).length;
    const presets = (await countFiles(path.join(userRoot, 'OpenAI Settings'), name => name.endsWith('.json'))).length;
    const groups = (await countFiles(path.join(userRoot, 'groups'), name => name.endsWith('.json'))).length;
    return { cards, worlds, presets, groups };
}

const playwrightModule = await import('@playwright/test');
const chromium = playwrightModule.chromium ?? playwrightModule.default?.chromium;

let browser = null;
let provider = null;
try {
    report.measured.before = await measure();
    provider = await startProvider({ roundDir: corpusPaths(90).roundDir, round: 90, label: 'provider-topup', wire: 'json' });
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
    const page = await context.newPage();
    const loaded = await openPage(page, baseURL);
    const readiness = await readReadiness(page);
    if (loaded !== true || readiness?.settingsReady !== true) throw new Error(`page not ready: ${JSON.stringify(readiness)}`);
    const connection = await ensureConnection(page, provider.baseURL, 'a20-live-model', { streaming: false });
    step('page-and-connection', connection.ok === true, { readiness, connection: connection.state ?? null });

    const ctx = {
        dataRoot,
        paths: { artifactsDir: corpusPaths(90).roundDir },
        provider,
        streaming: false,
        report: {
            counts: {},
            step: (name, ok, detail) => step(name, ok, detail),
            note: message => report.failures.push({ note: message }),
        },
        act: action,
    };

    // CARDS: import the shortfall through #character_import_file.
    const cardShortfall = Math.max(0, targets.cards - report.measured.before.cards);
    report.measured.cardShortfall = cardShortfall;
    if (cardShortfall > 0) {
        const imported = await importCards(page, ctx, 90, cardShortfall, cardStartIndex);
        report.created.cards = imported.length;
        step('cards-imported', imported.length === cardShortfall, { requested: cardShortfall, imported: imported.length, startIndex: cardStartIndex });
    }

    // WORLD BOOKS: import the shortfall through #world_import_file with a real entry count per book.
    const worldShortfall = Math.max(0, targets.worlds - report.measured.before.worlds);
    report.measured.worldShortfall = worldShortfall;
    if (worldShortfall > 0) {
        const imported = await importWorldBooks(page, ctx, 90, { worlds: worldShortfall, entriesPerWorld: targets.worldEntries }, worldStartIndex);
        report.created.worlds = imported.length;
        report.created.worldEntries = imported.reduce((sum, book) => sum + (book.entries ?? 0), 0);
        step('world-books-imported', imported.length === worldShortfall, { requested: worldShortfall, imported: imported.length, requestedEntriesPerBook: targets.worldEntries, startIndex: worldStartIndex });
    }

    // PRESETS: import the shortfall through the AI Response Configuration import control and select each.
    const presetShortfall = Math.max(0, targets.presets - report.measured.before.presets);
    report.measured.presetShortfall = presetShortfall;
    if (presetShortfall > 0) {
        const presetDir = path.join(corpusPaths(90).roundDir, 'presets');
        await fs.mkdir(presetDir, { recursive: true });
        let created = 0;
        for (let index = 0; index < presetShortfall; index += 1) {
            const presetName = `A20 Preset T${index + 1}`;
            const file = await writePresetFile(path.join(presetDir, `a20-preset-topup-${index + 1}.json`), 500 + index);
            const before = await page.evaluate(() => [...document.querySelectorAll('#settings_preset_openai option')].map(option => option.textContent.trim()));
            await page.setInputFiles('#openai_preset_import_file', file);
            const deadline = Date.now() + 30000;
            let appeared = null;
            while (Date.now() < deadline) {
                await page.waitForTimeout(200);
                const options = await page.evaluate(() => [...document.querySelectorAll('#settings_preset_openai option')].map(option => option.textContent.trim()));
                const added = options.filter(option => !before.includes(option));
                if (added.length > 0) { appeared = added[0]; break; }
            }
            const ok = typeof appeared === 'string';
            if (ok) created += 1;
            await action({ page: 'AI Response Configuration', control: '#openai_preset_import_file', field: `preset ${presetName}`, action: 'pick the generated OpenAI preset file in the real import control and read the option list back', result: { ok, appeared, before, requested: presetName } });
        }
        report.created.presets = created;
        step('presets-imported', created === presetShortfall, { requested: presetShortfall, created });
        await saveSettingsNow(page).catch(() => null);
    }

    // GROUPS: create the shortfall through the group panel, members taken from the real roster.
    const groupShortfall = Math.max(0, targets.groups - report.measured.before.groups);
    report.measured.groupShortfall = groupShortfall;
    if (groupShortfall > 0) {
        const roster = await page.evaluate(async () => {
            const script = await import('./script.js');
            await script.getCharacters();
            return (script.characters ?? []).slice(0, 40).map(character => character.name);
        });
        if (roster.length < 3) throw new Error(`group top-up needs at least 3 roster characters on the page, saw ${roster.length}`);
        let created = 0;
        for (let index = 0; index < groupShortfall; index += 1) {
            const name = `A20 Group Topup ${index + 1}`;
            const memberNames = [roster[index % roster.length], roster[(index + 1) % roster.length], roster[(index + 2) % roster.length]];
            const result = await createGroupUiFirst(page, ctx, 90, index, { name, memberNames, activationStrategy: 0, generationMode: 0 });
            const ok = result.ok === true || (result.memberCount ?? 0) >= 3;
            if (ok) created += 1;
            await action({ page: 'Group panel', control: '#rm_group_add_button + member list + create', field: `group ${name}`, action: 'create a group with real roster members through the group panel (UI first, product-API fallback recorded by the base builder)', result });
        }
        report.created.groups = created;
        step('groups-created', created === groupShortfall, { requested: groupShortfall, created });
    }

    report.measured.after = await measure();
    report.finishedAt = new Date().toISOString();
} catch (error) {
    report.failures.push(String(error?.stack ?? error));
    console.error(`[a20-topup] FAILED: ${String(error?.stack ?? error)}`);
} finally {
    if (provider) await provider.stop().catch(() => null);
    if (browser) await browser.close().catch(() => null);
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(`[a20-topup] report: ${reportPath}`);
}
process.exit(report.failures.filter(entry => typeof entry === 'string').length === 0 ? 0 : 1);
