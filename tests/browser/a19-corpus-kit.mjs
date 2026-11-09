// a19-corpus-kit.mjs -- the reusable half of the alpha.19 Node-UI-Originated Corpus builder.
//
// WHAT THIS IS. Shared helpers that drive the UNMODIFIED pinned SillyTavern 1.19.0 through real
// headless Playwright user actions, with a deterministic OpenAI-compatible RECORDING provider behind
// it. The corpus itself is produced by `a19-corpus-builder.mjs` in three rounds over one data root;
// this module owns the mechanics so a round file only contains the round's user journey.
//
// WHAT IT IS NOT. It never writes product files. Every card, world book, preset and chat in the
// corpus is created through the product's own controls or through the frontend module functions the
// controls call, which POST to the product's own API. Generated PNG/JSON/card INPUT files are
// allowed (the import buttons consume them); they are inputs, never data.
//
// PROVIDER. `tools/a19-corpus/provider` is a thin main over `tests/mockprovider` (the same raw
// recorder the provider-wire differential uses) in KEYED mode: it records method, raw target,
// header names/casing/order and body bytes exactly as received, and answers with deterministic
// marker text. A positional script cannot survive a thousand-request corpus (one unanticipated
// request shifts every later answer); keyed pre-scripting can. The provider defines NO business
// semantics: replies are markers with varied text, and no corpus expectation is derived from them.
//
// REUSE. Page readiness (`openPage`/`readReadiness`), the connection configuration, the send
// primitive and `waitForReply`/`saveConditional`/`readChatFiles` are imported from
// `q20-persistence-drive.mjs`, which measured their selectors against pinned. This module does not
// re-derive them.

import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, '..', '..');
export const scratchRoot = path.resolve(process.env.A19_SCRATCH ?? path.join(repoRoot, '..', 'a19-oracle'));

export const {
    openPage,
    readReadiness,
    configureConnection,
    sendTurn,
    waitForReply,
    pressRegenerate,
    pressRegenerateThroughMenu,
    pressContinue,
    saveConditional,
    readChatFiles,
    chatCarrying,
    carries,
    settleQuiet,
    openCharacter,
    resolveRoster,
} = await import('./q20-persistence-drive.mjs');

const playwrightModule = await import('@playwright/test');
export const chromium = playwrightModule.chromium ?? playwrightModule.default?.chromium;

export function sha256(value) {
    return createHash('sha256').update(value).digest('hex');
}

/**
 * Flush the settings the page changed, through the frontend's own IMMEDIATE save (`saveSettings`,
 * script.js:8051). Settings changes in the UI go through `saveSettingsDebounced`; a corpus round that
 * moved on before the debounce fired would read a settings.json that does not contain its own actions,
 * so every round that changes a setting flushes it explicitly here.
 */
export const saveSettingsNow = page => page.evaluate(async () => {
    const script = await import('./script.js');
    try {
        await script.saveSettings();
        return { ok: true };
    } catch (error) {
        return { ok: false, error: String(error?.message ?? error) };
    }
});

export function nowIso() {
    return new Date().toISOString();
}

export function ensureDir(target) {
    return fs.mkdir(target, { recursive: true });
}

// -----------------------------------------------------------------------------------------------------------------
// DETERMINISTIC RECORDING PROVIDER
// -----------------------------------------------------------------------------------------------------------------

/**
 * Build the provider binary into the scratch tree unless a newer one is supplied.
 * Returns the absolute binary path. Building is a DEVELOPMENT step; the corpus itself only needs the binary.
 */
export async function ensureProviderBinary() {
    const supplied = process.env.A19_PROVIDER_BINARY ? path.resolve(process.env.A19_PROVIDER_BINARY) : null;
    if (supplied) return supplied;
    const binDir = path.join(scratchRoot, 'bin');
    await ensureDir(binDir);
    const binary = path.join(binDir, process.platform === 'win32' ? 'a19-provider.exe' : 'a19-provider');
    const source = path.join(repoRoot, 'tools', 'a19-corpus', 'provider');
    const newestSource = (await fs.readdir(source)).filter(name => name.endsWith('.go')).sort().pop();
    const sourceStat = await fs.stat(path.join(source, newestSource));
    const binaryStat = existsSync(binary) ? await fs.stat(binary) : null;
    if (binaryStat && binaryStat.mtimeMs >= sourceStat.mtimeMs) return binary;
    await new Promise((resolve, reject) => {
        const build = spawn('go', ['build', '-trimpath', '-o', binary, './tools/a19-corpus/provider'], { cwd: repoRoot, stdio: 'inherit' });
        build.on('exit', code => (code === 0 ? resolve() : reject(new Error(`go build a19-provider failed with exit ${code}`))));
    });
    return binary;
}

const providerLine = /a19-provider recorder=(\S+) control=(\S+)/;

/**
 * Start the recording provider. Returns { recorderUrl, controlUrl, requests(), dump(), stop() }.
 * `requests()` reads the live count from the control listener, which is how an action can name the
 * provider-request ordinals it caused instead of a later reader guessing.
 */
export async function startProvider({ roundDir, round, replies = 6000, label = 'provider' } = {}) {
    const binary = await ensureProviderBinary();
    await ensureDir(roundDir);
    const recordingOut = path.join(roundDir, `${label}-recording.json`);
    const stdoutPath = path.join(roundDir, `${label}-stdout.log`);
    const handle = await fs.open(stdoutPath, 'w');
    const child = spawn(binary, ['--port', '0', '--control-port', '0', '--replies', String(replies), '--recording-out', recordingOut], {
        stdio: ['ignore', handle.fd, handle.fd],
    });
    let addresses = null;
    const deadline = Date.now() + 30000;
    while (!addresses && Date.now() < deadline) {
        const text = await fs.readFile(stdoutPath, 'utf8').catch(() => '');
        const match = providerLine.exec(text);
        if (match) addresses = { recorder: match[1], control: match[2] };
        else await new Promise(resolve => setTimeout(resolve, 100));
    }
    await handle.close();
    if (!addresses) {
        child.kill();
        throw new Error(`the recording provider did not print its addresses; log: ${stdoutPath}`);
    }
    const control = async suffix => {
        const response = await fetch(`http://${addresses.control}/__mock/${suffix}`);
        if (!response.ok) throw new Error(`provider control ${suffix} answered ${response.status}`);
        return response.json();
    };
    const api = {
        round,
        binary,
        recordingOut,
        stdoutPath,
        recorderUrl: `http://${addresses.recorder}`,
        controlUrl: `http://${addresses.control}`,
        baseURL: `http://${addresses.recorder}/v1`,
        stats: () => control('stats'),
        unused: () => control('unused'),
        recording: () => control('recording'),
        dump: () => control('dump'),
        async stop() {
            await api.dump().catch(() => {});
            if (child.exitCode === null) {
                child.kill('SIGTERM');
                await new Promise(resolve => child.on('exit', resolve));
            }
            return recordingOut;
        },
        child,
    };
    return api;
}

// -----------------------------------------------------------------------------------------------------------------
// ACTION LOG
// -----------------------------------------------------------------------------------------------------------------

/**
 * Record every user action WITH ITS RESULT, append-only on disk, so a later reader sees the journey
 * rather than a script name. `page` + `control` + `field` + `result` are mandatory by construction.
 */
export class ActionLog {
    constructor(file) {
        this.file = file;
        this.entries = [];
    }

    async open() {
        await ensureDir(path.dirname(this.file));
        await fs.writeFile(this.file, '');
        return this;
    }

    async record(entry) {
        const record = { seq: this.entries.length + 1, at: nowIso(), ...entry };
        this.entries.push(record);
        await fs.appendFile(this.file, `${JSON.stringify(record)}\n`);
        return record;
    }
}

// A ROUND REPORT: steps + counts + paths, written as JSON at the end. A failure names itself.
export class RoundReport {
    constructor({ round, surface, dataRoot, subject }) {
        this.round = round;
        this.surface = surface;
        this.subject = subject;
        this.dataRoot = dataRoot;
        this.startedAt = nowIso();
        this.steps = [];
        this.counts = {};
        this.artifacts = {};
        this.failures = [];
        this.notes = [];
    }

    step(name, ok, detail = null) {
        const entry = { name, ok: ok === true, detail, at: nowIso() };
        this.steps.push(entry);
        if (ok !== true) this.failures.push(`${name}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
        return entry;
    }

    note(message) {
        this.notes.push(message);
        return message;
    }

    async write(file) {
        this.finishedAt = nowIso();
        await ensureDir(path.dirname(file));
        await fs.writeFile(file, `${JSON.stringify(this, null, 2)}\n`);
        return file;
    }

    get ok() {
        return this.failures.length === 0;
    }
}

// -----------------------------------------------------------------------------------------------------------------
// THE BROWSER
// -----------------------------------------------------------------------------------------------------------------

/**
 * Launch an INDEPENDENT, headless Chromium profile for one round.
 *
 * `launchPersistentContext` with a round-owned directory is used instead of `browser.newPage()`
 * because the corpus requirement is an independent browser profile per round: cookies, localStorage,
 * IndexedDB and service workers must not leak between rounds through a shared throwaway profile, and
 * the profile directory itself becomes evidence. Nothing visible is opened and the context is always
 * closed by the caller.
 */
export async function openBrowser({ profileDir, tracePath }) {
    await ensureDir(profileDir);
    const context = await chromium.launchPersistentContext(profileDir, {
        headless: true,
        viewport: { width: 1366, height: 900 },
        args: ['--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions-except='],
    });
    const consoleMessages = [];
    const pageErrors = [];
    const failedRequests = [];
    const context_ = context;
    if (tracePath) {
        await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
    }
    const page = context.pages()[0] ?? (await context.newPage());
    page.on('console', message => {
        if (consoleMessages.length < 4000) consoleMessages.push({ type: message.type(), text: message.text().slice(0, 2000) });
    });
    page.on('pageerror', error => {
        if (pageErrors.length < 1000) pageErrors.push(String(error?.message ?? error).slice(0, 2000));
    });
    page.on('requestfailed', request => {
        if (failedRequests.length < 1000) failedRequests.push({ url: request.url().slice(0, 500), failure: request.failure()?.errorText ?? null });
    });
    return {
        context: context_,
        page,
        consoleMessages,
        pageErrors,
        failedRequests,
        async close() {
            if (tracePath) {
                await ensureDir(path.dirname(tracePath));
                await context.tracing.stop({ path: tracePath }).catch(() => {});
            }
            await context.close();
        },
    };
}

export async function screenshot(page, target) {
    await ensureDir(path.dirname(target));
    await page.screenshot({ path: target, fullPage: false });
    return target;
}

// -----------------------------------------------------------------------------------------------------------------
// SMALL UI PRIMITIVES
// -----------------------------------------------------------------------------------------------------------------

/** Set a value on an element and fire the events the product's own handlers listen for. */
export const setField = (page, selector, value, eventNames = ['input', 'change']) => page.evaluate(({ selector: sel, value: val, eventNames: events }) => {
    const field = document.querySelector(sel);
    if (!field) return { ok: false, reason: `no element for ${sel}` };
    if ('value' in field) field.value = val;
    else field.textContent = val;
    for (const eventName of events) field.dispatchEvent(new Event(eventName, { bubbles: true }));
    return { ok: true, value: 'value' in field ? field.value : field.textContent };
}, { selector, value, eventNames });

/** Fill the product popup input and press its OK button. Returns what was observed. */
export async function answerPopup(page, value, { button = '.popup-button-ok', timeoutMs = 15000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let observed = null;
    while (Date.now() < deadline) {
        observed = await page.evaluate(({ value: val, button: buttonSelector }) => {
            const popup = [...document.querySelectorAll('dialog.popup, .popup')].find(element => element.open !== false && (element.querySelector('.popup-input') || element.querySelector('.popup-button-ok')));
            if (!popup) return { found: false };
            const input = popup.querySelector('.popup-input');
            if (input) {
                input.value = val;
                input.dispatchEvent(new Event('input', { bubbles: true }));
            }
            const ok = popup.querySelector(buttonSelector);
            if (ok) ok.click();
            return { found: true, hadInput: Boolean(input), clicked: Boolean(ok) };
        }, { value, button });
        if (observed.found) break;
        await page.waitForTimeout(100);
    }
    return observed;
}

/**
 * Make the pinned page's user identity non-empty and record it. The onboarding popup is answered by
 * `openPage` already; this read-back exists so the corpus report carries the user the data belongs to.
 */
export async function readUserName(page) {
    return page.evaluate(async () => {
        const script = await import('./script.js');
        return { name: script.name1 ?? null, avatar: script.user_avatar ?? null };
    });
}

/** Wait until the frontend's own module reports a condition, bounded, returning the last observation. */
export async function waitInPage(page, evaluateFn, arg = null, { timeoutMs = 30000, pollMs = 200 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
        last = await page.evaluate(evaluateFn, arg).catch(error => ({ error: String(error?.message ?? error) }));
        if (last && last.ok === true) return last;
        await page.waitForTimeout(pollMs);
    }
    return { ...(last ?? {}), timedOut: true };
}

// -----------------------------------------------------------------------------------------------------------------
// CHARACTERS -- through the real create panel, plus the real edit/duplicate/export/import controls
// -----------------------------------------------------------------------------------------------------------------

/**
 * Fill `#form_create` and submit it with the real `#create_button`.
 *
 * The create panel is a normal (not modal) panel: `#rm_button_create` shows it, the fields live in
 * `#form_create`, and the submit input is `#create_button` (inside `label#print_create_button_label`).
 * Everything here is a control a user sees; the wrapper is only the typing.
 */
export async function createCharacter(page, spec) {
    return page.evaluate(async inputs => {
        const script = await import('./script.js');
        const open = document.querySelector('#rm_button_create');
        if (!open) return { ok: false, reason: 'no #rm_button_create control' };
        open.click();
        await new Promise(resolve => setTimeout(resolve, 400));
        const form = document.querySelector('#form_create');
        if (!form) return { ok: false, reason: 'the create panel did not produce #form_create' };
        const set = (selector, value) => {
            const field = document.querySelector(selector);
            if (!field) return false;
            field.value = value;
            field.dispatchEvent(new Event('input', { bubbles: true }));
            return true;
        };
        const fields = {};
        fields.name = set('#character_name_pole', inputs.name);
        fields.description = set('#description_textarea', inputs.description ?? '');
        fields.firstMessage = set('#firstmessage_textarea', inputs.firstMessage ?? '');
        fields.personality = set('#personality_textarea', inputs.personality ?? '');
        fields.mesExample = set('#mes_example_textarea', inputs.mesExample ?? '');
        fields.scenario = set('#scenario_pole', inputs.scenario ?? '');
        fields.creatorNotes = set('#creator_notes_textarea', inputs.creatorNotes ?? '');
        fields.characterVersion = set('#character_version_textarea', inputs.characterVersion ?? '');
        fields.depthPrompt = set('#depth_prompt_prompt', inputs.depthPrompt ?? '');
        const depth = document.querySelector('#depth_prompt_depth');
        if (depth && inputs.depthPromptDepth !== undefined) {
            depth.value = String(inputs.depthPromptDepth);
            depth.dispatchEvent(new Event('input', { bubbles: true }));
            fields.depthPromptDepth = true;
        }
        const role = document.querySelector('#depth_prompt_role');
        if (role && inputs.depthPromptRole !== undefined) {
            role.value = String(inputs.depthPromptRole);
            role.dispatchEvent(new Event('change', { bubbles: true }));
            fields.depthPromptRole = true;
        }
        const submit = document.querySelector('#create_button');
        if (!submit) return { ok: false, reason: 'the create panel has no #create_button', fields };
        submit.click();
        const deadline = performance.now() + 30000;
        while (performance.now() < deadline) {
            await script.getCharacters();
            const match = (script.characters ?? []).find(entry => entry?.name === inputs.name);
            if (match) return { ok: true, avatar: match.avatar ?? null, name: match.name ?? null, fields, data: match.data ?? null };
            await new Promise(resolve => setTimeout(resolve, 250));
        }
        return { ok: false, reason: 'the created character never appeared in the frontend roster', fields };
    }, spec);
}

/**
 * Wait for the created card to be readable through the product's own export route.
 * This is the read-back that proves the stored PNG carries what the panel typed; the disk bytes are
 * checked separately by `readCharacterCardBytes`.
 */
export async function readBackCard(page, avatar) {
    return page.evaluate(async avatarName => {
        const script = await import('./script.js');
        const response = await fetch('/api/characters/export', {
            method: 'POST',
            headers: script.getRequestHeaders(),
            body: JSON.stringify({ avatar_url: avatarName, format: 'json' }),
        });
        const text = await response.text();
        let card = null;
        try {
            card = JSON.parse(text);
        } catch {
            card = null;
        }
        return { status: response.status, card };
    }, avatar);
}

/** The stored card's own bytes (PNG with base64 JSON in a tEXt chunk), decoded without the product. */
export function decodePngChara(bytes) {
    const signature = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    if (bytes.length < 8 || !bytes.subarray(0, 8).equals(signature)) return null;
    let offset = 8;
    while (offset + 12 <= bytes.length) {
        const length = bytes.readUInt32BE(offset);
        const type = bytes.toString('latin1', offset + 4, offset + 8);
        const data = bytes.subarray(offset + 8, offset + 8 + length);
        if (type === 'tEXt') {
            const zero = data.indexOf(0);
            if (zero >= 0 && data.toString('latin1', 0, zero).toLowerCase() === 'chara') {
                try {
                    return JSON.parse(Buffer.from(data.toString('latin1', zero + 1), 'base64').toString('utf8'));
                } catch {
                    return null;
                }
            }
        }
        if (type === 'IEND') break;
        offset += 12 + length;
    }
    return null;
}

export async function readCharacterCardBytes(dataRoot, avatar, handle = 'default-user') {
    const cardPath = path.join(dataRoot, handle, 'characters', avatar);
    const bytes = await fs.readFile(cardPath);
    return {
        file: `characters/${avatar}`,
        bytes: bytes.length,
        sha256: sha256(bytes),
        chara: decodePngChara(bytes),
    };
}

// -----------------------------------------------------------------------------------------------------------------
// WORLD INFO -- create the book through the real button+popup, each entry through the real New Entry UI
// -----------------------------------------------------------------------------------------------------------------

/**
 * Create a lorebook with the real `#world_create_button` + name popup, then verify it is in the
 * product's own world list. Returns the world name the product stored.
 */
export async function createWorldBook(page, worldName) {
    const clicked = await page.evaluate(() => {
        const button = document.querySelector('#world_create_button');
        if (!button) return { ok: false, reason: 'no #world_create_button' };
        button.click();
        return { ok: true };
    });
    if (!clicked.ok) return clicked;
    const popup = await answerPopup(page, worldName);
    const confirmed = await page.evaluate(async wanted => {
        const worldInfo = await import('./scripts/world-info.js');
        const deadline = Date.now() + 20000;
        while (Date.now() < deadline) {
            if (typeof worldInfo.getWorldInfoList === 'function') await worldInfo.getWorldInfoList();
            const names = Array.isArray(worldInfo.world_names) ? worldInfo.world_names.slice() : [];
            if (names.includes(wanted)) return { ok: true, names };
            await new Promise(resolve => setTimeout(resolve, 250));
        }
        return { ok: false, names: Array.isArray(worldInfo.world_names) ? worldInfo.world_names.slice() : [] };
    }, worldName);
    return { ok: confirmed.ok === true, popup, names: confirmed.names };
}

/**
 * Open a world's editor in the World Info drawer through the product's own selector, so the New
 * Entry button is bound to this book (`#world_popup_new`'s handler closes over the displayed book).
 */
export async function openWorldInEditor(page, worldName) {
    return page.evaluate(async wanted => {
        const worldInfo = await import('./scripts/world-info.js');
        if (typeof worldInfo.openWorldInfoEditor === 'function') worldInfo.openWorldInfoEditor(wanted);
        // Wait for the entries list to belong to `wanted`: the editor select's selected index must map
        // to it and the list must be rendered by displayWorldEntries.
        const deadline = Date.now() + 20000;
        let last = null;
        while (Date.now() < deadline) {
            const select = document.querySelector('#world_editor_select');
            const index = select ? Number(select.value) : NaN;
            const names = Array.isArray(worldInfo.world_names) ? worldInfo.world_names : [];
            const selected = Number.isInteger(index) && names[index] === wanted;
            const list = document.querySelector('#world_popup_entries_list');
            const rendered = Boolean(list) && list.children.length >= 0 && list.style.display !== 'none';
            last = { selected, rendered, index, names };
            if (selected && rendered && document.querySelector('#world_popup_new')) return { ok: true, ...last };
            await new Promise(resolve => setTimeout(resolve, 250));
        }
        return { ok: false, ...(last ?? {}) };
    }, worldName);
}

/**
 * Create ONE entry through the real New Entry button, then type every field through the real editor
 * controls (plaintext keys mode, which is a real user toggle stored in `power_user`).
 *
 * THE MEASURED TRAPS, each of which produced a green-looking smoke run whose entries were EMPTY or
 * whose fields landed on the wrong entry:
 *
 *   1. THE PRODUCT CACHE HANDS OUT CLONES. `worldInfoCache` is a `StructuredCloneMap({cloneOnGet:true})`,
 *      so `loadWorldInfo(name)` returns a COPY. A driver that keeps that object and later saves it back
 *      (`saveWorldInfo(name, copy, true)`) OVERWRITES the edits its own input events made in the live
 *      object. The read-back must be a FRESH `loadWorldInfo` call and the flush must save THAT clone.
 *   2. THE UID MUST COME FROM RENDERED CARDS, NOT FROM MODEL ORDER OR "the last rendered entry".
 *      `#world_popup_entries_list` re-renders asynchronously and sorts by displayIndex/order; reading
 *      the last node returned the SAME uid for three consecutive creations.
 *   3. THE EDITOR FIELDS ARE LAZY. `textarea[name="content"]` / `textarea[name="key"]` live in the
 *      entry's inline-drawer outlet, populated only when the drawer is expanded.
 *   4. THE NEW ENTRY BUTTON'S HANDLER IS (RE)BOUND AT THE END OF AN ASYNC RENDER, and a click that
 *      lands before the binding does nothing. The wait below uses the RENDERED CARD SET as the durable
 *      signal, and falls back to `createWorldInfoEntry(name, data)` -- THE SAME PRODUCT FUNCTION the
 *      button handler calls -- if the real press still did not produce a card, recording the mechanism.
 *   5. `constant` IS A SELECT (`select[name="entryStateSelector"]`), and the enable/disable kill switch
 *      TOGGLES on click, so it is read first and clicked only when it disagrees.
 *
 * Every typed field is read back out of a FRESH product load and the read-back rides in the return
 * value, so a silent no-op is a red step instead of a plausible-looking entry.
 */
export async function createWorldEntry(page, worldName, entrySpec) {
    return page.evaluate(async ({ worldName: wanted, spec }) => {
        const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
        const worldInfo = await import('./scripts/world-info.js');
        const powerUser = await import('./scripts/power-user.js');
        // PLAINTEXT KEYS: a real per-user toggle (`power_user.wi_key_input_plaintext`) exposed by the
        // keyboard icon in the entry editor. Setting it selects the textarea branch of
        // `enableKeysInputHelper`, whose own `change` handler parses comma-separated keys.
        powerUser.power_user.wi_key_input_plaintext = true;

        const renderedUids = () => [...document.querySelectorAll('#world_popup_entries_list .world_entry')]
            .map(element => element.getAttribute('uid'))
            .filter(uid => uid !== null);
        const newEntryHandler = () => {
            const element = document.querySelector('#world_popup_new');
            const events = element && window.jQuery ? window.jQuery._data(element, 'events') : null;
            return { present: Boolean(element), hasHandler: Boolean(events?.click?.length) };
        };
        const reopenWorld = async () => {
            worldInfo.openWorldInfoEditor(wanted);
            const deadline = Date.now() + 25000;
            let last = null;
            while (Date.now() < deadline) {
                const select = document.querySelector('#world_editor_select');
                const index = select ? Number(select.value) : NaN;
                const names = Array.isArray(worldInfo.world_names) ? worldInfo.world_names : [];
                last = {
                    mapped: Number.isInteger(index) && names[index] === wanted,
                    ...newEntryHandler(),
                    renderedUids: renderedUids(),
                };
                if (last.mapped && last.hasHandler) {
                    // Give the pagination callback a moment to finish appending the page's cards, then
                    // report what was actually rendered: the caller asserts on this, not on a sleep.
                    await sleep(400);
                    return { ok: true, ...last, renderedUidsAfterSettle: renderedUids() };
                }
                await sleep(120);
            }
            return { ok: false, ...(last ?? {}) };
        };

        const editor = await reopenWorld();
        if (!editor.ok) return { ok: false, stage: 'open-world-editor', editor };

        const uidsBefore = editor.renderedUidsAfterSettle;
        const button = document.querySelector('#world_popup_new');
        button.click();
        let newUid = null;
        let mechanism = 'new-entry-button';
        const buttonDeadline = Date.now() + 8000;
        while (Date.now() < buttonDeadline) {
            const fresh = renderedUids().filter(uid => !uidsBefore.includes(uid));
            if (fresh.length > 0) {
                newUid = fresh[fresh.length - 1];
                break;
            }
            await sleep(100);
        }
        if (newUid === null) {
            // FALLBACK: the product function the button handler itself calls. The object handed to it is
            // the CURRENT clone from the product loader; it is saved immediately through the product's
            // own save so the cache and disk agree before the render below.
            mechanism = 'createWorldInfoEntry (the product function #world_popup_new calls; the button press produced no card within 8000 ms)';
            const clone = await worldInfo.loadWorldInfo(wanted);
            const created = worldInfo.createWorldInfoEntry(wanted, clone);
            if (!created || created.uid === undefined) return { ok: false, stage: 'create-entry', reason: 'the product create function returned no entry', mechanism };
            newUid = String(created.uid);
            await worldInfo.saveWorldInfo(wanted, clone, true);
            await reopenWorld();
        }
        const deadline = Date.now() + 25000;
        let card = null;
        while (Date.now() < deadline) {
            card = document.querySelector(`#world_popup_entries_list .world_entry[uid="${newUid}"]`);
            if (card) break;
            await sleep(120);
        }
        if (!card) return { ok: false, stage: 'render-entry', uid: newUid, mechanism, renderedUids: renderedUids() };
        const toggle = card.querySelector('.inline-drawer-header .inline-drawer-toggle');
        if (toggle) toggle.click();
        let contentField = null;
        while (Date.now() < deadline) {
            const node = document.querySelector(`#world_popup_entries_list .world_entry[uid="${newUid}"]`);
            contentField = node?.querySelector('textarea[name="content"]') ?? null;
            if (contentField) break;
            await sleep(120);
        }
        if (!contentField) return { ok: false, stage: 'expand-editor', uid: newUid, mechanism };

        // ONE FIELD, ONE READ-BACK. Each helper dispatches the events the product's own handler listens
        // for, then polls the FRESH product load until the field's model value matches what was typed.
        const field = (selector, transform = value => value) => async (value, events = ['input', 'change'], predicate = null) => {
            const node = () => document.querySelector(`#world_popup_entries_list .world_entry[uid="${newUid}"]`);
            const target = node()?.querySelector(selector) ?? null;
            if (!target) return { ok: false, selector, reason: 'no such field in the rendered card' };
            if (target.type === 'checkbox') {
                target.checked = value === true;
                target.dispatchEvent(new Event('input', { bubbles: true }));
            } else {
                target.value = String(value);
                for (const eventName of events) target.dispatchEvent(new Event(eventName, { bubbles: true }));
            }
            const readBackDeadline = Date.now() + 8000;
            let observed = null;
            while (Date.now() < readBackDeadline) {
                const fresh = await worldInfo.loadWorldInfo(wanted);
                observed = fresh?.entries?.[newUid] ?? null;
                if (observed !== null && predicate(observed)) return { ok: true, selector, observed: transform(observed) };
                await sleep(100);
            }
            return { ok: false, selector, observed: observed === null ? null : transform(observed) };
        };

        const readEntry = async () => {
            const fresh = await worldInfo.loadWorldInfo(wanted);
            return fresh?.entries?.[newUid] ?? null;
        };
        const applied = {};
        applied.comment = await field('textarea[name="comment"]')(spec.comment ?? spec.title ?? '', ['input'], entry => entry.comment === (spec.comment ?? spec.title ?? ''));
        applied.content = await field('textarea[name="content"]')(spec.content ?? '', ['input'], entry => entry.content === (spec.content ?? ''));
        applied.keys = await field('textarea[name="key"]')((spec.keys ?? []).join(', '), ['change'], entry => JSON.stringify(entry.key ?? []) === JSON.stringify(spec.keys ?? []));
        if ((spec.secondaryKeys ?? []).length > 0 || spec.secondaryKeys !== undefined) {
            applied.secondaryKeys = await field('textarea[name="keysecondary"]')((spec.secondaryKeys ?? []).join(', '), ['change'], entry => JSON.stringify(entry.keysecondary ?? []) === JSON.stringify(spec.secondaryKeys ?? []));
        }
        // POSITION FIRST: its handler enables the depth input and derives the ROLE from the chosen
        // option's `data-role` attribute (index.html: the three at-Depth options all carry value="4" and
        // differ only in data-role 0/1/2). There is no `select[name="role"]` control in this version, so
        // the role is selected by picking the right option and the read-back checks both fields.
        if (spec.position !== undefined) {
            const selectOf = () => document.querySelector(`#world_popup_entries_list .world_entry[uid="${newUid}"] select[name="position"]`);
            const target = selectOf();
            if (!target) {
                applied.position = { ok: false, selector: 'select[name="position"]', reason: 'no position control in the rendered card' };
            } else {
                const optionIndex = [...target.options].findIndex(option => Number(option.value) === spec.position
                    && (spec.role === undefined || Number(option.dataset.role) === Number(spec.role)));
                target.selectedIndex = optionIndex >= 0 ? optionIndex : 0;
                target.dispatchEvent(new Event('input', { bubbles: true }));
                target.dispatchEvent(new Event('change', { bubbles: true }));
                const positionDeadline = Date.now() + 8000;
                let observed = null;
                let ok = false;
                while (Date.now() < positionDeadline) {
                    const fresh = await worldInfo.loadWorldInfo(wanted);
                    observed = fresh?.entries?.[newUid] ?? null;
                    ok = observed !== null
                        && observed.position === spec.position
                        && (spec.role === undefined || Number(observed.role) === Number(spec.role));
                    if (ok) break;
                    await sleep(100);
                }
                applied.position = {
                    ok,
                    selector: 'select[name="position"] (option selected by value + option[data-role])',
                    selectedOptionIndex: target.selectedIndex,
                    selectedOptionRole: target.selectedOptions?.[0]?.dataset?.role ?? null,
                    observedPosition: observed?.position ?? null,
                    observedRole: observed?.role ?? null,
                };
            }
        }
        if (spec.order !== undefined) {
            applied.order = await field('input[name="order"]')(spec.order, ['input'], entry => entry.order === spec.order);
        }
        if (spec.depth !== undefined) {
            applied.depth = await field('input[name="depth"]')(spec.depth, ['input'], entry => entry.depth === spec.depth);
        }
        if (spec.constant !== undefined) {
            applied.constant = await field('select[name="entryStateSelector"]')(spec.constant === true ? 'constant' : 'normal', ['input', 'change'], entry => (entry.constant === true) === (spec.constant === true));
        }
        applied.selective = await field('input[name="selective"]')(spec.selective === true, ['input'], entry => (entry.selective === true) === (spec.selective === true));
        for (const [name, key] of [['excludeRecursion', 'excludeRecursion'], ['preventRecursion', 'preventRecursion'], ['delayUntilRecursion', 'delayUntilRecursion'], ['ignoreBudget', 'ignoreBudget']]) {
            if (spec[name] !== undefined) {
                applied[name] = await field(`input[name="${key}"]`)(spec[name] === true, ['input'], entry => (entry[key] === true) === (spec[name] === true));
            }
        }
        if (spec.probability !== undefined) {
            applied.probability = await field('input[name="probability"]')(spec.probability, ['input'], entry => Number(entry.probability) === Number(spec.probability));
        }
        if (spec.scanDepth !== undefined) {
            applied.scanDepth = await field('input[name="scanDepth"]')(spec.scanDepth, ['input'], entry => Number(entry.scanDepth) === Number(spec.scanDepth));
        }
        if (spec.automationId !== undefined) {
            applied.automationId = await field('input[name="automationId"]')(spec.automationId, ['input'], entry => entry.automationId === spec.automationId);
        }
        if (spec.group !== undefined) {
            applied.group = await field('input[name="group"]')(spec.group, ['input'], entry => entry.group === spec.group);
        }
        // ENABLE/DISABLE: the kill switch toggles, so the model state decides whether to click.
        if (spec.disabled !== undefined) {
            const before = await readEntry();
            if ((before?.disable === true) !== (spec.disabled === true)) {
                document.querySelector(`#world_popup_entries_list .world_entry[uid="${newUid}"] div[name="entryKillSwitch"]`)?.click();
                const toggleDeadline = Date.now() + 8000;
                let matched = false;
                while (Date.now() < toggleDeadline) {
                    const fresh = await readEntry();
                    if ((fresh?.disable === true) === (spec.disabled === true)) { matched = true; break; }
                    await sleep(100);
                }
                applied.disabled = { ok: matched };
            } else {
                applied.disabled = { ok: true, alreadyInState: before?.disable === true };
            }
        }
        // FLUSH: save the FRESH product load (never the stale clone), through the product's own save.
        const finalClone = await worldInfo.loadWorldInfo(wanted);
        await worldInfo.saveWorldInfo(wanted, finalClone, true);
        const stored = await readEntry();
        const verification = Object.fromEntries(Object.entries(applied).map(([name, result]) => [name, result.ok === true]));
        const ok = Object.values(verification).every(Boolean);
        return {
            ok,
            uid: newUid,
            mechanism,
            editor,
            applied,
            verification,
            stored: stored
                ? {
                    uid: stored.uid,
                    key: stored.key,
                    keysecondary: stored.keysecondary,
                    constant: stored.constant,
                    disable: stored.disable,
                    position: stored.position,
                    depth: stored.depth,
                    order: stored.order,
                    selective: stored.selective,
                    excludeRecursion: stored.excludeRecursion,
                    preventRecursion: stored.preventRecursion,
                    content: String(stored.content ?? '').slice(0, 160),
                    comment: String(stored.comment ?? '').slice(0, 160),
                }
                : null,
        };
    }, { worldName, spec: entrySpec });
}

/**
 * Select lorebook(s) globally through the product's own `#world_info` control.
 *
 * THE SELECT IS THE CONTROL; THE PERSIST IS A DEBOUNCE. Setting the `<option selected>` flags and
 * firing `change` runs `initWorldInfo`'s handler -> `onWorldInfoChange('__notSlashCommand__')`, which
 * rebuilds `selected_world_info` from the select and calls the module's own debounced settings save.
 * That debounced callback is what performs `Object.assign(world_info, {globalSelect: selected_world_info})`,
 * so a driver that calls the global settings save immediately after the event writes the OLD
 * `globalSelect` (measured: the smoke run's settings.json held `globalSelect: []`). The durable signal
 * is `world_info.globalSelect` itself; it is polled here before returning.
 */
export async function selectWorldGlobally(page, worldNames) {
    return page.evaluate(async want => {
        const wanted = Array.isArray(want) ? want : [want];
        const worldInfo = await import('./scripts/world-info.js');
        const deadline = Date.now() + 25000;
        while (Date.now() < deadline) {
            if (typeof worldInfo.getWorldInfoList === 'function') await worldInfo.getWorldInfoList();
            if (Array.isArray(worldInfo.world_names) && wanted.every(name => worldInfo.world_names.includes(name))) break;
            await new Promise(resolve => setTimeout(resolve, 250));
        }
        const names = Array.isArray(worldInfo.world_names) ? worldInfo.world_names.slice() : [];
        const missing = wanted.filter(name => !names.includes(name));
        if (missing.length > 0) return { ok: false, reason: `world(s) not listed: ${missing.join(', ')}`, names };
        const select = document.querySelector('#world_info');
        if (!select) return { ok: false, reason: '#world_info is not in the DOM', names };
        const indexes = wanted.map(name => names.indexOf(name));
        for (const option of select.options) option.selected = indexes.includes(Number(option.value));
        select.dispatchEvent(new Event('change', { bubbles: true }));
        // THE DEBOUNCED SAVE'S OWN SIDE EFFECT IS THE READINESS SIGNAL.
        let last = null;
        while (Date.now() < deadline) {
            last = {
                selected: Array.isArray(worldInfo.selected_world_info) ? worldInfo.selected_world_info.slice() : null,
                globalSelect: worldInfo.world_info?.globalSelect ?? null,
                selectValues: [...select.selectedOptions].map(option => option.textContent),
            };
            const persisted = Array.isArray(last.globalSelect) && wanted.every(name => last.globalSelect.includes(name));
            const inMemory = Array.isArray(last.selected) && wanted.every(name => last.selected.includes(name));
            if (persisted && inMemory) return { ok: true, names, ...last, mechanism: '#world_info change -> onWorldInfoChange -> module saveSettingsDebounced (globalSelect observed)' };
            await new Promise(resolve => setTimeout(resolve, 150));
        }
        return { ok: false, reason: 'the product never applied the selection to selected_world_info/globalSelect', names, ...(last ?? {}) };
    }, worldNames);
}

// -----------------------------------------------------------------------------------------------------------------
// CHATS
// -----------------------------------------------------------------------------------------------------------------

/**
 * Start a NEW chat with the currently selected character through the real options control
 * (`#option_start_new_chat`, the handler at script.js:11613). The element lives inside `#options`,
 * whose delegated handler is what a real press reaches, so the menu is opened first.
 */
export async function startNewChat(page) {
    return page.evaluate(async () => {
        const script = await import('./script.js');
        const context = window.SillyTavern && window.SillyTavern.getContext ? window.SillyTavern.getContext() : null;
        const before = { chatId: context?.chatId ?? null, chatLength: (script.chat ?? []).length };
        const button = document.querySelector('#options_button');
        if (button) button.click();
        await new Promise(resolve => setTimeout(resolve, 400));
        const control = document.querySelector('#option_start_new_chat');
        if (!control) return { ok: false, reason: '#option_start_new_chat is not in the page', before };
        control.click();
        const deadline = Date.now() + 30000;
        let last = null;
        while (Date.now() < deadline) {
            const live = window.SillyTavern && window.SillyTavern.getContext ? window.SillyTavern.getContext() : null;
            last = { chatId: live?.chatId ?? null, chatLength: (script.chat ?? []).length, isSendPress: script.is_send_press ?? null };
            if (last.chatId !== before.chatId && last.chatId !== null && last.isSendPress !== true) return { ok: true, before, after: last };
            await new Promise(resolve => setTimeout(resolve, 250));
        }
        return { ok: false, reason: 'the chat id did not change after New Chat', before, after: last };
    });
}

/** Send one chat turn and wait for the reply, recording the before/after state used by the assertions. */
export async function chatTurn(page, text) {
    const before = await page.evaluate(async () => {
        const script = await import('./script.js');
        const chat = script.chat ?? [];
        return {
            chatLength: chat.length,
            lastTextLength: String(chat[chat.length - 1]?.mes ?? '').length,
            chatId: (window.SillyTavern?.getContext?.() ?? null)?.chatId ?? null,
        };
    });
    const sent = await sendTurn(page, text);
    const reply = await waitForReply(page, { timeoutMs: 120000, requireText: true, baseline: before });
    const after = await page.evaluate(async () => {
        const script = await import('./script.js');
        const chat = script.chat ?? [];
        const last = chat[chat.length - 1] ?? null;
        return {
            chatLength: chat.length,
            lastIsUser: last?.is_user === true,
            lastText: String(last?.mes ?? '').slice(0, 200),
            lastTextLength: String(last?.mes ?? '').length,
            chatId: (window.SillyTavern?.getContext?.() ?? null)?.chatId ?? null,
        };
    });
    return { sent, reply, before, after, ok: reply.ok === true && after.lastIsUser === false && after.lastTextLength > 0 };
}

// -----------------------------------------------------------------------------------------------------------------
// DISK CENSUS + MANIFEST
// -----------------------------------------------------------------------------------------------------------------

/** Walk a tree and hash every file. Relative paths use forward slashes so a manifest is host-neutral. */
export async function census(root, { maxFiles = 200000 } = {}) {
    const files = [];
    const walk = async directory => {
        let entries = [];
        try {
            entries = await fs.readdir(directory, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            if (files.length >= maxFiles) return;
            const full = path.join(directory, entry.name);
            if (entry.isDirectory()) await walk(full);
            else if (entry.isFile()) {
                const stat = await fs.stat(full);
                const bytes = await fs.readFile(full);
                files.push({
                    path: path.relative(root, full).split(path.sep).join('/'),
                    bytes: stat.size,
                    sha256: sha256(bytes),
                });
            }
        }
    };
    await walk(root);
    files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
    return { root, fileCount: files.length, totalBytes: files.reduce((sum, file) => sum + file.bytes, 0), files };
}

/** The immutable input tree the corpus rounds write into: outside the repository, per the charter. */
export function corpusPaths(round) {
    const roundDir = path.join(scratchRoot, `round${round}`);
    return {
        roundDir,
        artifactsDir: path.join(roundDir, 'artifacts'),
        profileDir: path.join(scratchRoot, 'profiles', `round${round}`),
        actions: path.join(roundDir, `actions-round${round}.jsonl`),
        report: path.join(roundDir, `round${round}.json`),
        manifest: path.join(roundDir, `manifest-round${round}.json`),
        trace: path.join(roundDir, `trace-round${round}.zip`),
    };
}

export function dataRootPaths(dataRoot, handle = 'default-user') {
    return {
        root: dataRoot,
        user: path.join(dataRoot, handle),
        characters: path.join(dataRoot, handle, 'characters'),
        chats: path.join(dataRoot, handle, 'chats'),
        worlds: path.join(dataRoot, handle, 'worlds'),
        presets: path.join(dataRoot, handle, 'presets'),
        settings: path.join(dataRoot, handle, 'settings.json'),
        groups: path.join(dataRoot, handle, 'groups.json'),
    };
}

/**
 * The world book AS THE PRODUCT WROTE IT, read from disk rather than from the page model. An entry
 * that only exists in the frontend's in-memory book is not corpus data.
 */
export async function readWorldBookFile(dataRoot, worldName, handle = 'default-user') {
    const file = path.join(dataRoot, handle, 'worlds', `${worldName}.json`);
    const body = await fs.readFile(file, 'utf8');
    const data = JSON.parse(body);
    const rawEntries = data.entries && typeof data.entries === 'object' ? Object.values(data.entries) : [];
    return {
        file: `worlds/${worldName}.json`,
        bytes: Buffer.byteLength(body),
        sha256: sha256(body),
        entryCount: rawEntries.length,
        entries: rawEntries.map(entry => ({
            uid: entry.uid,
            comment: entry.comment,
            key: entry.key,
            keysecondary: entry.keysecondary,
            content: String(entry.content ?? ''),
            constant: entry.constant,
            disable: entry.disable,
            position: entry.position,
            depth: entry.depth,
            order: entry.order,
            selective: entry.selective,
            excludeRecursion: entry.excludeRecursion,
            preventRecursion: entry.preventRecursion,
        })),
    };
}

/** The persisted settings file, parsed, with its own digest (the world selection lives here). */
export async function readSettingsFile(dataRoot, handle = 'default-user') {
    const file = path.join(dataRoot, handle, 'settings.json');
    const body = await fs.readFile(file, 'utf8');
    return { file: 'settings.json', bytes: Buffer.byteLength(body), sha256: sha256(body), settings: JSON.parse(body) };
}

// -----------------------------------------------------------------------------------------------------------------
// PROVIDER CAPTURE SUMMARY
// -----------------------------------------------------------------------------------------------------------------

/**
 * Read the provider recording and summarise it WITHOUT canonicalising the bytes.
 * `bodySha256`/`bodyLength`/`rawTarget`/method/ordered headers are the wire contract; parsing is only
 * used to report what SHAPE was requested (stream flag, model) and never to compare bodies.
 */
export function summariseRecording(recording) {
    const requests = Array.isArray(recording?.requests) ? recording.requests : [];
    const completions = requests.filter(request => request.method === 'POST' && /chat\/completions$/.test(request.rawPath ?? ''));
    return {
        requestCount: requests.length,
        completionCount: completions.length,
        otherRequests: requests.filter(request => !completions.includes(request)).map(request => `${request.method} ${request.rawPath}`),
        completionKeys: completions.map(request => ({
            index: request.index,
            method: request.method,
            rawTarget: request.rawTarget,
            bodyLength: request.bodyLength,
            bodySha256: request.bodySha256,
            headerCount: Array.isArray(request.headers) ? request.headers.length : 0,
            requestedStream: (() => {
                try {
                    return JSON.parse(request.bodyText ?? '{}').stream ?? null;
                } catch {
                    return 'unparseable';
                }
            })(),
        })),
        bodySha256InOrder: completions.map(request => request.bodySha256),
        duplicateBodyCount: completions.length - new Set(completions.map(request => request.bodySha256)).size,
    };
}
