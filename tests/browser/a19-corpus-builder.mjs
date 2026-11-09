// a19-corpus-builder.mjs -- one round of the alpha.19 Node-UI-Originated Corpus.
//
// RUN ONE ROUND (the wrapper boots the pinned server on a leased port over a supplied data root):
//
//   node tests/browser/run-against-pinned.mjs a19-corpus-builder.mjs \
//        --data-root C:\Users\koishi\Desktop\GoTavern\a19-oracle\data -- --round 1
//
// Each invocation is a FRESH pinned server process over the SAME data root. That is the restart step
// the charter requires between rounds: round 1 creates, round 2 keeps using and edits, round 3 restarts
// and continues in the tree the first two rounds wrote.
//
// `--smoke` runs the environment proof (one card, one lorebook, three turns) and asserts the provider
// recording, the stored PNG, the world JSON and the chat JSONL all exist. It is not part of the corpus.
//
// NOTHING HERE WRITES PRODUCT DATA. Cards/lorebooks/presets/chats are produced by real UI actions or by
// the frontend module functions those actions call; the only files this process writes are the provider
// recording, the action log, screenshots, the browser trace and the round report, all under the scratch
// tree outside the repository.

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import {
    ActionLog,
    RoundReport,
    census,
    chatTurn,
    configureConnection,
    corpusPaths,
    createCharacter,
    createWorldBook,
    createWorldEntry,
    dataRootPaths,
    ensureDir,
    openBrowser,
    openCharacter,
    openPage,
    readBackCard,
    readCharacterCardBytes,
    readChatFiles,
    readReadiness,
    readSettingsFile,
    readUserName,
    readWorldBookFile,
    saveConditional,
    saveSettingsNow,
    screenshot,
    selectWorldGlobally,
    sha256,
    startNewChat,
    startProvider,
    summariseRecording,
    waitInPage,
} from './a19-corpus-kit.mjs';

function argumentValue(argv, name, fallback = null) {
    const index = argv.indexOf(name);
    if (index === -1) return fallback;
    return argv[index + 1] ?? fallback;
}

const argv = process.argv.slice(2);
const round = Number(argumentValue(argv, '--round', '0'));
const smoke = argv.includes('--smoke');
const baseURL = process.env.PROBE_BASE_URL ?? argumentValue(argv, '--base-url', null);
const dataRoot = path.resolve(process.env.A19_DATA_ROOT ?? argumentValue(argv, '--data-root', ''));
if (!baseURL) {
    console.error('a19-corpus-builder: PROBE_BASE_URL is required (run through run-against-pinned.mjs)');
    process.exit(2);
}
if (!dataRoot) {
    console.error('a19-corpus-builder: A19_DATA_ROOT is required');
    process.exit(2);
}

const paths = corpusPaths(smoke ? 0 : round);
await ensureDir(paths.roundDir);
await ensureDir(paths.artifactsDir);

const report = new RoundReport({
    round: smoke ? 0 : round,
    surface: smoke ? 'a19-smoke' : 'a19-corpus',
    subject: 'pinned-sillytavern-1.19.0',
    dataRoot,
});
const actions = await new ActionLog(paths.actions).open();
report.artifacts = { actions: paths.actions, roundDir: paths.roundDir, trace: paths.trace };

const act = (entry) => actions.record({ round: report.round, ...entry });

let provider = null;
let browser = null;
let failure = null;

// THE MILESTONE JOURNEY. Every item is a real control; each is recorded with its observed result.
async function smokeJourney(page) {
    const user = await readUserName(page);
    await act({ page: 'app', control: 'onboarding/user', field: 'user name', action: 'read the user identity the page reports', result: user });

    // 1. POINT THE PAGE AT THE RECORDING PROVIDER through the product's own connection controls.
    const providerBefore = await provider.stats();
    const connection = await page.evaluate(async ({ url, model }) => {
        const openai = await import('./scripts/openai.js');
        const script = await import('./script.js');
        const power = await import('./scripts/power-user.js');
        script.changeMainAPI('openai');
        const set = (selector, value) => {
            const control = document.querySelector(selector);
            if (!control) return false;
            control.value = value;
            control.dispatchEvent(new Event('input', { bubbles: true }));
            control.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
        };
        set('#main_api', 'openai');
        set('#chat_completion_source', 'custom');
        set('#custom_api_url_text', url);
        set('#custom_model_id', model);
        set('#api_key_custom', 'a19-probe-key');
        // THE STREAMING TOGGLE IS A REAL USER SETTING, and the corpus keeps it ON: the custom
        // OpenAI-compatible source streams by default and the recording provider answers SSE for
        // `stream: true`. If the setting were off the provider's SSE answer would be parsed as a
        // non-streaming body, so the state is recorded rather than assumed.
        const toggle = document.querySelector('#stream_toggle');
        if (toggle && !toggle.checked) toggle.click();
        power.power_user.savingAfterComplete = false;
        return {
            mainApi: script.main_api ?? null,
            source: openai.oai_settings.chat_completion_source ?? null,
            url: openai.oai_settings.custom_url ?? null,
            model: openai.oai_settings.custom_model ?? null,
            streaming: openai.oai_settings.stream_openai ?? null,
            streamToggle: toggle ? toggle.checked : null,
            savingAfterComplete: power.power_user.savingAfterComplete ?? null,
        };
    }, { url: provider.baseURL, model: 'a19-deterministic' });
    await page.waitForTimeout(500);
    const providerAfterConnect = await provider.stats();
    await act({ page: 'AI Response Configuration', control: '#chat_completion_source / #custom_api_url_text / #stream_toggle', field: 'connection', action: 'set connection to the local recording provider (custom OpenAI-compatible, streaming on)', result: connection });
    report.step('connection-set-to-recording-provider', connection.source === 'custom' && connection.url === provider.baseURL, connection);
    report.notes.push(`provider requests during connection setup: ${providerAfterConnect.requests - providerBefore.requests}`);

    // 2. CREATE ONE CHARACTER through the create panel.
    const cardSpec = {
        name: 'A19 烟雨客栈 Keeper',
        description: 'A19_SMOKE_DESCRIPTION 中文描述：烟雨客栈的掌柜，记得每一位旅人的名字。English line about the keeper of the Rain-Inn.',
        firstMessage: 'A19_SMOKE_GREETING 欢迎来到烟雨客栈。The rain writes its own ledger on the window. ✨',
        personality: 'patient, observant, quietly amused',
        mesExample: '<START>\n{{user}}: 还有房间吗？\n{{char}}: 有的，靠窗那间。',
        scenario: 'A19_SMOKE_SCENARIO 夜里下雨，客栈的门没有关。',
        creatorNotes: 'A19_SMOKE_NOTES creator note for the smoke card.',
        characterVersion: '0.1-smoke',
        depthPrompt: 'A19_SMOKE_DEPTH_NOTE 掌柜记得每一笔账。',
        depthPromptDepth: 4,
        depthPromptRole: 0,
    };
    const created = await createCharacter(page, cardSpec);
    await act({ page: 'Character create panel', control: '#rm_button_create → #form_create → #create_button', field: 'character card', action: 'type the card fields and press Create', result: created });
    report.step('character-created-through-create-panel', created.ok === true && typeof created.avatar === 'string', created);

    const cardReadBack = await readBackCard(page, created.avatar);
    const cardBytes = await readCharacterCardBytes(dataRoot, created.avatar);
    const readBackFields = cardReadBack.card?.data ?? cardReadBack.card ?? null;
    await act({ page: 'Characters', control: 'POST /api/characters/export?format=json', field: 'stored card', action: 'read the created card back through the product export route and the stored PNG bytes', result: { status: cardReadBack.status, storedBytes: cardBytes.bytes, storedSha256: cardBytes.sha256, charaDecoded: cardBytes.chara !== null } });
    report.step('created-card-persisted',
        cardReadBack.status === 200
        && readBackFields?.name === cardSpec.name
        && readBackFields?.first_mes === cardSpec.firstMessage
        && cardBytes.chara !== null
        && cardBytes.chara?.data?.name === cardSpec.name,
        { status: cardReadBack.status, name: readBackFields?.name ?? null, firstMes: readBackFields?.first_mes ?? null, cardFile: cardBytes.file, cardSha256: cardBytes.sha256 });
    report.artifacts.card = { file: cardBytes.file, bytes: cardBytes.bytes, sha256: cardBytes.sha256 };

    // 3. OPEN THE CHARACTER (a real card click) and confirm the greeting became message 0.
    const opened = await openCharacter(page, cardSpec.name);
    await act({ page: 'Character list', control: '#rm_print_characters_block .character_select[data-chid]', field: 'character', action: `open ${JSON.stringify(cardSpec.name)}`, result: opened });
    report.step('character-opened', opened.opened === true, opened);
    // THE OPEN IS SETTLED ON THE PRODUCT'S OWN CONTEXT before the greeting is judged: `opened.opened` can
    // be true while `context.characterId` is still null (measured: the smoke run read chatLength 2 with
    // `characterName: null` and the greeting check 700 ms later was correct), so a race would be recorded
    // as a missing character rather than as a slow one. Wait on the identity the corpus actually needs.
    const settledIdentity = await waitInPage(page, async () => {
        const script = await import('./script.js');
        const context = window.SillyTavern && window.SillyTavern.getContext ? window.SillyTavern.getContext() : null;
        const name = context?.characterId !== null && context?.characterId !== undefined ? (script.characters?.[context.characterId]?.name ?? null) : null;
        return { ok: name !== null && context?.chatId !== null, characterName: name, chatId: context?.chatId ?? null, characterId: context?.characterId ?? null };
    }, null, { timeoutMs: 30000 });
    report.step('character-identity-settled-after-open', settledIdentity.ok === true && settledIdentity.characterName === cardSpec.name, settledIdentity);
    const greeting = await page.evaluate(async () => {
        const script = await import('./script.js');
        const chat = script.chat ?? [];
        return { chatLength: chat.length, first: String(chat[0]?.mes ?? '').slice(0, 200), chatId: window.SillyTavern?.getContext?.()?.chatId ?? null };
    });
    report.step('greeting-present-after-open', greeting.first.includes('A19_SMOKE_GREETING'), greeting);

    // 4. CREATE ONE LOREBOOK through the real button+popup, then real New Entry buttons + editor fields.
    const worldName = 'A19 Smoke Lore 烟雨札记';
    const createdWorld = await createWorldBook(page, worldName);
    await act({ page: 'World Info drawer', control: '#world_create_button + popup', field: 'world name', action: `create lorebook ${JSON.stringify(worldName)}`, result: createdWorld });
    report.step('world-book-created-through-ui', createdWorld.ok === true, createdWorld);

    const editorOpen = await page.evaluate(async wanted => {
        const worldInfo = await import('./scripts/world-info.js');
        worldInfo.openWorldInfoEditor(wanted);
        return { opened: true };
    }, worldName);
    await act({ page: 'World Info drawer', control: '#world_editor_select (openWorldInfoEditor)', field: 'entry list', action: 'open the created lorebook in the editor', result: editorOpen });

    const entrySpecs = [
        { comment: 'A19_SMOKE_WI_CONSTANT', keys: [], constant: true, position: 0, order: 10, content: 'A19_SMOKE_WI_CONSTANT_CONTENT 客栈的灯笼永远亮着。' },
        { comment: 'A19_SMOKE_WI_KEYWORD', keys: ['A19_SMOKE_TRIGGER_ALPHA', '灯笼'], constant: false, position: 0, order: 20, content: 'A19_SMOKE_WI_KEYWORD_CONTENT 灯笼下挂着一枚铜铃。' },
        { comment: 'A19_SMOKE_WI_DEPTH', keys: ['A19_SMOKE_TRIGGER_BETA'], constant: false, position: 4, depth: 2, role: 0, order: 30, content: 'A19_SMOKE_WI_DEPTH_CONTENT 更深处的账本记着旧名字。' },
    ];
    const entries = [];
    for (const spec of entrySpecs) {
        const createdEntry = await createWorldEntry(page, worldName, spec);
        entries.push(createdEntry);
        await act({ page: 'World Info entry editor', control: '#world_popup_new + editor fields', field: `entry ${spec.comment}`, action: 'create an entry and type its keys/content/position through the editor', result: createdEntry });
    }
    report.step('world-entries-created-through-editor', entries.every(entry => entry.ok === true) && entries.length === 3, entries.map(entry => ({ ok: entry.ok, uid: entry.uid, mechanism: entry.mechanism ?? null, stage: entry.stage ?? null, reason: entry.reason ?? null, verification: entry.verification ?? null })));
    report.artifacts.world = { name: worldName, entries: entries.map(entry => entry.uid) };

    const selected = await selectWorldGlobally(page, [worldName]);
    await act({ page: 'World Info drawer', control: '#world_info + updateWorldInfoSettings', field: 'global selection', action: `select ${JSON.stringify(worldName)} as a global lorebook`, result: selected });
    report.step('world-book-selected-globally', selected.ok === true, selected);

    // THE DISK IS THE CORPUS. Read the world book and the settings file the product wrote and assert the
    // entries and the persisted global selection are there, so a page-only illusion cannot pass.
    const settingsWrite = await saveSettingsNow(page);
    await act({ page: 'AI Response Configuration / World Info', control: 'saveSettingsDebounced flush', field: 'settings.json', action: 'flush the settings the page changed', result: settingsWrite });
    const worldDisk = await readWorldBookFile(dataRoot, worldName);
    const settingsDisk = await readSettingsFile(dataRoot);
    const globalSelect = settingsDisk.settings?.world_info_settings?.world_info?.globalSelect ?? settingsDisk.settings?.world_info?.globalSelect ?? null;
    const diskEntriesOk = worldDisk.entryCount === entrySpecs.length
        && entrySpecs.every(spec => worldDisk.entries.some(entry => entry.comment === spec.comment && entry.content === spec.content));
    report.step('world-book-persisted-to-disk', diskEntriesOk, { file: worldDisk.file, sha256: worldDisk.sha256, entryCount: worldDisk.entryCount, entries: worldDisk.entries.map(entry => ({ comment: entry.comment, contentLength: entry.content.length, position: entry.position, depth: entry.depth, order: entry.order })) });
    report.step('world-selection-persisted-to-disk', Array.isArray(globalSelect) ? globalSelect.includes(worldName) : globalSelect?.globalSelect?.includes?.(worldName) === true, { globalSelect, settingsSha256: settingsDisk.sha256 });
    report.artifacts.settings = { file: settingsDisk.file, sha256: settingsDisk.sha256 };

    // 5. THREE REAL TURNS through #send_textarea + #send_but against the recording provider.
    const providerBeforeTurns = await provider.stats();
    const turns = [];
    for (const text of [
        'A19_SMOKE_TURN_1 你好，还有空房吗？',
        'A19_SMOKE_TURN_2 灯笼下真的有一枚铜铃吗？',
        'A19_SMOKE_TURN_3 那就住一晚吧。🌙',
    ]) {
        const turn = await chatTurn(page, text);
        turns.push({ text, ok: turn.ok, before: turn.before, after: turn.after, reply: { ok: turn.reply.ok, state: turn.reply.state, reading: turn.reply.reading ?? null } });
        await act({ page: 'Chat', control: '#send_textarea + #send_but', field: 'message', action: `send ${JSON.stringify(text)} and wait for the product to store the reply`, result: { ok: turn.ok, chatLength: turn.after.chatLength, lastIsUser: turn.after.lastIsUser, lastText: turn.after.lastText } });
    }
    const providerAfterTurns = await provider.stats();
    report.step('three-turns-reached-the-provider', turns.every(turn => turn.ok === true) && providerAfterTurns.requests - providerBeforeTurns.requests === 3, { turns: turns.map(turn => turn.ok), providerRequests: providerAfterTurns.requests - providerBeforeTurns.requests });

    const saved = await saveConditional(page);
    await act({ page: 'Chat', control: 'saveChatConditional() (the frontend save the chat menu uses)', field: 'chat file', action: 'save the chat now, then read the .jsonl from disk', result: saved });

    const chatFiles = await readChatFiles(dataRoot);
    const chatFile = chatFiles.find(file => (file.messages ?? []).some(message => String(message?.mes ?? '').includes('A19_SMOKE_TURN_1')));
    const messageCount = chatFile ? chatFile.messages.length : 0;
    report.step('chat-file-written-with-the-turns', Boolean(chatFile) && messageCount >= 7, { file: chatFile?.file ?? null, lines: chatFile?.lines ?? 0, messages: messageCount, sha256: chatFile?.sha256 ?? null });
    report.artifacts.chat = { file: chatFile?.file ?? null, lines: chatFile?.lines ?? 0, sha256: chatFile?.sha256 ?? null };

    await screenshot(page, path.join(paths.artifactsDir, 'smoke-app.png'));
    report.artifacts.screenshot = path.join(paths.artifactsDir, 'smoke-app.png');
    return { turns, cardSpec, worldName };
}

try {
    provider = await startProvider({ roundDir: paths.roundDir, round: report.round, label: smoke ? 'provider-smoke' : `provider-round${round}` });
    report.notes.push(`provider recorder ${provider.recorderUrl} control ${provider.controlUrl} binary ${provider.binary}`);

    browser = await openBrowser({ profileDir: paths.profileDir, tracePath: paths.trace });
    const page = browser.page;
    const loaded = await openPage(page, baseURL);
    const readiness = await readReadiness(page);
    await act({ page: 'app', control: 'window.load / APP_READY', field: 'readiness', action: 'load the pinned frontend at ' + baseURL, result: readiness });
    report.step('page-loaded', loaded === true && readiness?.settingsReady === true, readiness);
    if (loaded !== true) throw new Error(`the page was not ready: ${JSON.stringify(readiness)}`);

    if (smoke) {
        await smokeJourney(page);
    } else {
        throw new Error(`round ${round} journey is not implemented yet; use --smoke for the environment proof`);
    }

    const disk = await census(path.join(dataRoot, 'default-user'));
    report.counts.diskFiles = disk.fileCount;
    report.counts.diskBytes = disk.totalBytes;
    report.artifacts.diskManifest = path.join(paths.roundDir, 'disk-round.jsonl');
    await fs.writeFile(report.artifacts.diskManifest, disk.files.map(file => JSON.stringify(file)).join('\n') + '\n');

    if (browser.pageErrors.length > 0) {
        report.note(`page errors observed (${browser.pageErrors.length}): ${JSON.stringify(browser.pageErrors.slice(0, 5))}`);
    }
    report.counts.consoleMessages = browser.consoleMessages.length;
    report.counts.pageErrors = browser.pageErrors.length;
    report.counts.failedRequests = browser.failedRequests.length;
    report.artifacts.console = path.join(paths.roundDir, 'console.json');
    await fs.writeFile(report.artifacts.console, `${JSON.stringify({ consoleMessages: browser.consoleMessages, pageErrors: browser.pageErrors, failedRequests: browser.failedRequests }, null, 2)}\n`);
} catch (error) {
    failure = String(error?.stack ?? error);
    report.failures.push(failure);
} finally {
    // THE WIRE CAPTURE IS WRITTEN EVEN WHEN THE JOURNEY THREW, so a failed round still says what it sent.
    if (provider) {
        const recordingPath = await provider.stop().catch(() => null);
        try {
            const recording = JSON.parse(await fs.readFile(recordingPath, 'utf8'));
            const summary = summariseRecording(recording);
            report.counts.providerRequests = summary.requestCount;
            report.counts.providerCompletions = summary.completionCount;
            report.artifacts.providerRecording = recordingPath;
            report.artifacts.providerSummary = path.join(paths.roundDir, 'provider-summary.json');
            await fs.writeFile(report.artifacts.providerSummary, `${JSON.stringify(summary, null, 2)}\n`);
            report.notes.push(`provider summary: ${summary.completionCount} completion request(s), ${summary.requestCount} total`);
        } catch (error) {
            report.note(`provider recording could not be summarised: ${String(error?.message ?? error)}`);
        }
    }
    if (browser) await browser.close().catch(() => {});
    await report.write(paths.report);
    console.log(`[a19] round ${report.round}: ${report.steps.map(step => `${step.ok ? 'ok' : 'FAIL'} ${step.name}`).join(', ')}`);
    console.log(`[a19] report: ${paths.report}`);
    if (report.failures.length > 0) console.error(`[a19] FAILURES: ${report.failures.join(' | ')}`);
}
process.exit(report.ok ? 0 : 1);
