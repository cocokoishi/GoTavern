#!/usr/bin/env node
// Data-domain drive: perform a WRITE then a RE-READ through each data domain in the real pinned
// frontend, and record what the browser observed. One leg per invocation (GoTavern by default, or
// any server via PROBE_BASE_URL), so the two legs can be compared.
//
// WHY THIS IS NOT A RERUN OF BOOT: the startup differential proves those routes were CALLED and
// their responses consumed. E means the browser's final state matches after an interaction, so this
// drive writes through a domain and then reads it back, and records both the HTTP traffic and the
// values the frontend ends up holding.
//
// CAPTURE CONTROL (the streaming probe's defect): bodies are read through Playwright's response
// object, never by replacing the page's fetch, so nothing here can buffer a response and mislabel
// the path it came from.
//
// DRIVE CONTROL: `preconditions` in the report records, per interaction, the flag the SUBJECT itself
// checks before it will act (rule 10), and `status` distinguishes "driven" from "not-driven" with a
// named reason. A not-driven interaction is a gap in this harness, never a product finding.
//
// Usage: node data-domain-drive.mjs --report <path>
//        PROBE_BASE_URL=http://127.0.0.1:8000 node data-domain-drive.mjs --report <path>   (pinned)

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const playwrightModule = await import('@playwright/test');
const chromium = playwrightModule.chromium ?? playwrightModule.default?.chromium;

function freePort() {
    return new Promise((resolve, reject) => {
        const server = createServer();
        server.unref();
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            server.close(() => resolve(port));
        });
    });
}

async function waitForServer(url, deadlineMs = 60000) {
    const started = Date.now();
    while (Date.now() - started < deadlineMs) {
        try {
            const response = await fetch(url);
            if (response.status < 500) return;
        } catch {
            // not up yet
        }
        await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw new Error(`${url} did not answer`);
}

const exists = target => fs.stat(target).then(() => true, () => false);

const external = Boolean(process.env.PROBE_BASE_URL);
const port = await freePort();
const dataRoot = await fs.mkdtemp(path.join(process.env.TEMP ?? '/tmp', 'gotavern-data-domain-'));
const binarySetting = process.env.GOTAVERN_BINARY ?? '';
const binary = binarySetting ? path.resolve(binarySetting) : path.join(dataRoot, process.platform === 'win32' ? 'gotavern.exe' : 'gotavern');
let server = null;
const origin = process.env.PROBE_BASE_URL ?? `http://127.0.0.1:${port}`;

if (!external) {
    if (!binarySetting) {
        const build = spawn('go', ['build', '-trimpath', '-o', binary, './cmd/gotavern'], { cwd: repoRoot, stdio: 'inherit' });
        if (await new Promise(resolve => build.on('exit', resolve)) !== 0) throw new Error('go build failed');
    }
    // A release layout stages the tokenizer assets beside the binary. The startup differential
    // learned this the hard way: a capture once measured the FALLBACK tokenizer path because
    // `tokenizers/` was missing, so this REFUSES rather than measuring the wrong path.
    // `gotavern start` resolves InstallRoot as the DIRECTORY OF THE EXECUTABLE, so a binary left in
    // the artifact directory made every file staged into <dataRoot> invisible: the tokenizer check
    // failed there and the frontend would have come from that directory's own public/ (or the
    // embedded tree) rather than from this run's layout. The artifact is a SOURCE that is copied
    // into the install root, exactly as a release archive places it.
    if (binarySetting) {
        await fs.copyFile(binarySetting, binary);
    }
    const tokenizerSource = path.join(repoRoot, 'upstream', 'tokenizers');
    if (!(await exists(tokenizerSource))) {
        throw new Error(`tokenizer assets missing at ${tokenizerSource}; a release layout must stage them at <install root>/src/tokenizers`);
    }
    // THE RELEASE LAYOUT IS `src/tokenizers`, not `tokenizers` at the install root: the archive mirrors the
    // pinned SillyTavern tree (upstream reads it as `src/tokenizers/...`, src/endpoints/tokenizers.js:251-254)
    // and the runtime prefers that path, so staging it here keeps the measurement on the layout that ships.
    await fs.mkdir(path.join(dataRoot, 'src'), { recursive: true });
    await fs.cp(tokenizerSource, path.join(dataRoot, 'src', 'tokenizers'), { recursive: true });
    // `public/` IS NOT STAGED. The release archive ships no public/ tree (the frontend is embedded
    // and ARCHITECTURE 8.1 allows an install with none), startup creates an EMPTY
    // public/scripts/extensions, and discovery plus the static fallback read the EMBEDDED tree. An
    // earlier version copied upstream/public/scripts/extensions here, which is a layout no user has
    // and which hid the release-install discovery defect from this very comparison.
    //
    // The config is the pinned fresh-install document, passed explicitly so both legs resolve the
    // same file: without it each server read whichever config.yaml sat in its own checkout, and the
    // file decides accounts, colours and the extension guard.
    const configSource = path.join(repoRoot, 'upstream', 'default', 'config.yaml');
    const configPath = path.join(dataRoot, 'config.yaml');
    await fs.cp(configSource, configPath);
    server = spawn(binary, ['start', '--port', String(port), '--dataRoot', dataRoot, '--configPath', configPath], { cwd: dataRoot, stdio: ['ignore', 'pipe', 'pipe'] });
}

const report = {
    schemaVersion: 1,
    question: 'after a write-then-read interaction in each data domain, does the browser observe the same requests, responses and final values on both legs?',
    provenance: {
        subject: external ? 'pinned' : 'gotavern',
        external,
        baseURL: origin,
        // Leg identity: the tokenizer assets are the control the startup differential added after a
        // capture measured the fallback path. Recorded per leg so a reader can see which leg ran.
        tokenizerAssetsStaged: !external,
        frontendVersion: null,
    },
    reachedUserState: null,
    interactions: [],
    pageErrors: [],
    consoleErrors: [],
    failure: null,
};

const digest = bytes => createHash('sha256').update(bytes).digest('hex');

let browser;
try {
    await waitForServer(`${origin}/version`);
    const version = await (await fetch(`${origin}/version`)).json();
    report.provenance.frontendVersion = { version: version.version, pkgVersion: version.pkgVersion, gitRevision: version.gitRevision };
    browser = await chromium.launch();
    const page = await browser.newPage();
    page.on('pageerror', error => report.pageErrors.push(String(error.message ?? error).slice(0, 300)));
    page.on('console', message => {
        if (message.type() === 'error') report.consoleErrors.push(String(message.text()).slice(0, 300));
    });

    const pending = new Map();
    const requests = [];
    page.on('request', request => {
        const url = new URL(request.url());
        if (url.origin !== origin) return;
        const entry = { method: request.method(), path: url.pathname + url.search, resourceType: request.resourceType(), status: null, contentType: '', bodySha256: null, bodyLength: null, postDataSha256: null, postDataLength: null };
        // The WRITE payload is the strongest evidence that both legs were driven the same way, so it
        // is recorded too. A multipart boundary is random per request, so it is normalized out:
        // without that the digest would differ between two runs of the SAME leg, be discarded as
        // nondeterministic, and the write evidence would be lost.
        try {
            let data = request.postData();
            if (data !== null) {
                const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(request.headers()['content-type'] ?? '');
                const value = boundary?.[1] ?? boundary?.[2];
                if (value) data = data.split(value).join('<multipart-boundary>');
                entry.postDataLength = Buffer.byteLength(data);
                entry.postDataSha256 = digest(Buffer.from(data, 'utf8'));
            }
        } catch {
            entry.postDataSha256 = null;
            entry.postDataLength = null;
        }
        pending.set(request, entry);
        requests.push(entry);
    });
    page.on('response', async response => {
        const entry = pending.get(response.request());
        if (!entry) return;
        entry.status = response.status();
        entry.contentType = response.headers()['content-type'] ?? '';
        try {
            const bytes = await response.body();
            entry.bodyLength = bytes.length;
            entry.bodySha256 = digest(bytes);
        } catch {
            entry.bodyLength = null;
            entry.bodySha256 = null;
        }
    });

    await page.goto(origin + '/');
    await page.waitForFunction('document.getElementById("preloader") === null', { timeout: 90000 });

    // The same entry path the startup differential uses: complete onboarding, then wait for the flag
    // the frontend itself sets. A drive that skipped this would act from a state no user reaches.
    const entry = await page.evaluate(async () => {
        const result = { onboardingCompleted: false, settingsReady: false, selectedMainApi: null };
        const script = await import('./script.js');
        const started = performance.now();
        while (performance.now() - started < 15000) {
            if (script.settingsReady) break;
            const onboarding = document.querySelector('.popup .onboarding');
            if (onboarding) {
                result.onboardingCompleted = true;
                const nameInput = onboarding.closest('.popup')?.querySelector('.popup-input');
                if (nameInput) {
                    nameInput.value = 'Probe User';
                    nameInput.dispatchEvent(new Event('input', { bubbles: true }));
                }
                onboarding.closest('.popup')?.querySelector('.popup-button-ok')?.click();
                break;
            }
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        while (performance.now() - started < 60000) {
            if (script.settingsReady) {
                result.settingsReady = true;
                break;
            }
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        const mainApiSelect = document.querySelector('#main_api');
        if (mainApiSelect) {
            result.selectedMainApi = mainApiSelect.value;
        }
        return result;
    });
    report.reachedUserState = entry;

    // Each interaction runs inside one page.evaluate so it shares the page's module graph and DOM.
    // `observed` holds only what the frontend ended up holding; volatile stamps are marked so the
    // comparison is about behaviour rather than about when the drive ran.
    const runInteraction = async (id, fn) => {
        const startIndex = requests.length;
        let outcome;
        try {
            outcome = await page.evaluate(fn);
        } catch (error) {
            outcome = { status: 'not-driven', reason: `page.evaluate threw: ${String(error.message ?? error).slice(0, 200)}` };
        }
        report.interactions.push({
            id,
            status: outcome?.status ?? 'not-driven',
            reason: outcome?.reason ?? null,
            preconditions: outcome?.preconditions ?? null,
            observed: outcome?.observed ?? null,
            requests: requests.slice(startIndex).map(entry => ({ method: entry.method, path: entry.path, resourceType: entry.resourceType, status: entry.status, contentType: entry.contentType, bodySha256: entry.bodySha256, bodyLength: entry.bodyLength, postDataSha256: entry.postDataSha256, postDataLength: entry.postDataLength })),
        });
    };

    // 1. Settings: save through the frontend's own saveSettings, then re-read through
    //    /api/settings/get and compare the value that came back.
    await runInteraction('settings', async () => {
        const script = await import('./script.js');
        if (!script.settingsReady) return { status: 'not-driven', reason: 'settingsReady is false, so saveSettings would refuse (script.js:8051)' };
        const before = await fetch('/api/settings/get', { method: 'POST', headers: script.getRequestHeaders() });
        const beforeBody = await before.json();
        // Prefer a NUMERIC key: flipping `enable_extensions` was measured to be reverted by the
        // frontend (disabling extensions reloads extension state), so it proved nothing. A number
        // has no such side effect, and the key list is recorded so a reader can see the choice.
        const numeric = Object.keys(beforeBody ?? {}).find(candidate => typeof beforeBody[candidate] === 'number');
        const key = numeric ?? Object.keys(beforeBody ?? {}).find(candidate => typeof beforeBody[candidate] === 'boolean' && candidate !== 'enable_extensions') ?? Object.keys(beforeBody ?? {})[0];
        const flipped = typeof beforeBody?.[key] === 'number' ? beforeBody[key] + 1 : (typeof beforeBody?.[key] === 'boolean' ? !beforeBody[key] : 'probe-value');
        script.settings[key] = flipped;
        await script.saveSettings();
        const reread = await fetch('/api/settings/get', { method: 'POST', headers: script.getRequestHeaders() });
        const rereadBody = await reread.json();
        return {
            status: 'driven',
            preconditions: { settingsReady: script.settingsReady },
            observed: {
                key,
                beforeValue: beforeBody?.[key] ?? null,
                flippedValue: flipped,
                rereadStatus: reread.status,
                rereadValue: rereadBody?.[key] ?? null,
                // The write is only proven if the flipped value comes back; recorded, not assumed.
                writeReflected: rereadBody?.[key] === flipped,
                rereadSettingKeys: Object.keys(rereadBody ?? {}).length,
            },
        };
    });

    // 2. Characters: create through the real create panel and form, read the list and the card back,
    //    then delete and read the list again.
    await runInteraction('characters', async () => {
        const script = await import('./script.js');
        const createButton = document.querySelector('#rm_button_create');
        if (!createButton) return { status: 'not-driven', reason: 'no #rm_button_create control in the served frontend' };
        createButton.click();
        await new Promise(resolve => setTimeout(resolve, 300));
        const form = document.querySelector('#form_create');
        const nameField = document.querySelector('#character_name_pole');
        if (!form || !nameField) return { status: 'not-driven', reason: 'the create panel did not produce #form_create/#character_name_pole' };
        const name = 'Probe Character';
        nameField.value = name;
        nameField.dispatchEvent(new Event('input', { bubbles: true }));
        const description = document.querySelector('#description_textarea');
        if (description) {
            description.value = 'probe description';
            description.dispatchEvent(new Event('input', { bubbles: true }));
        }
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        const deadline = performance.now() + 20000;
        let created = null;
        while (performance.now() < deadline) {
            await script.getCharacters();
            // The frontend's own list is the browser state; matching on the avatar too, because the
            // server may sanitize the stored name.
            created = (script.characters ?? []).find(entry => entry?.name === name || String(entry?.avatar ?? '').startsWith('Probe')) ?? null;
            if (created) break;
            await new Promise(resolve => setTimeout(resolve, 250));
        }
        if (!created) return { status: 'not-driven', reason: 'the created character never appeared in the frontend list', preconditions: { formPresent: true } };
        const cardResponse = await fetch('/api/characters/get', { method: 'POST', headers: script.getRequestHeaders(), body: JSON.stringify({ avatar_url: created.avatar }) });
        const card = await cardResponse.json();
        const deleted = await script.deleteCharacter(created.avatar, { deleteChats: true });
        await script.getCharacters();
        const afterDelete = script.characters ?? [];
        return {
            status: 'driven',
            preconditions: { formPresent: true, createPanelOpened: true },
            observed: {
                createdName: created.name ?? null,
                createdAvatarExtension: String(created.avatar ?? '').split('.').pop() ?? null,
                cardName: card?.name ?? null,
                cardDescription: card?.description ?? null,
                cardAvatar: card?.avatar ?? null,
                deleteReturned: deleted === undefined ? 'undefined' : String(deleted).slice(0, 40),
                stillListedAfterDelete: afterDelete.some(entry => entry?.name === name || String(entry?.avatar ?? '').startsWith('Probe')),
                listCountAfterDelete: afterDelete.length,
            },
        };
    });

    // 3. Chats: save a chat, then get it back and compare the message array and the .jsonl framing.
    await runInteraction('chats', async () => {
        const script = await import('./script.js');
        const headers = script.getRequestHeaders();
        const messages = [
            { chat_metadata: { integrity: 'probe' }, user_name: 'unused', character_name: 'unused' },
            { name: 'Probe User', is_user: true, send_date: '2024-08-01T00:00:00.000Z', mes: 'probe message one' },
            { name: 'Probe Character', is_user: false, send_date: '2024-08-01T00:00:01.000Z', mes: 'probe message two' },
        ];
        const chatBody = messages.map(entry => JSON.stringify(entry)).join('\n');
        const saveResponse = await fetch('/api/chats/save', { method: 'POST', headers, body: JSON.stringify({ ch_name: 'Probe Character', file_name: 'probe-chat', chat: messages, avatar_url: 'Probe.png' }) });
        const saveStatus = saveResponse.status;
        const getResponse = await fetch('/api/chats/get', { method: 'POST', headers, body: JSON.stringify({ ch_name: 'Probe Character', file_name: 'probe-chat', avatar_url: 'Probe.png' }) });
        const getStatus = getResponse.status;
        const getText = await getResponse.text();
        let parsed = null;
        try {
            parsed = JSON.parse(getText);
        } catch {
            parsed = null;
        }
        // The .jsonl FRAMING evidence comes from the server's own export of the stored file: the get
        // route returns a parsed array, so it cannot show the line framing, while the export returns
        // the raw bytes the chat file holds.
        const exportResponse = await fetch('/api/chats/export', { method: 'POST', headers, body: JSON.stringify({ avatar_url: 'Probe.png', is_group: false, file: 'probe-chat.jsonl', exportfilename: 'probe-chat.jsonl', format: 'jsonl' }) });
        const exportStatus = exportResponse.status;
        const exportText = await exportResponse.text();
        return {
            status: 'driven',
            preconditions: { saveStatus, getStatus },
            observed: {
                saveStatus,
                getStatus,
                messageCount: Array.isArray(parsed) ? parsed.length : null,
                messages: Array.isArray(parsed) ? parsed.map(entry => ({ name: entry?.name ?? null, is_user: entry?.is_user ?? null, mes: entry?.mes ?? null, send_date: entry?.send_date ?? null })) : null,
                exportStatus,
                exportLineCount: exportText.length ? exportText.split('\n').length : 0,
                exportEndsWithNewline: exportText.endsWith('\n'),
                exportMatchesSentFraming: exportText === chatBody,
                sentBodyLineCount: chatBody.split('\n').length,
                sentBodyEndsWithNewline: chatBody.endsWith('\n'),
            },
        };
    });

    // 4. Backgrounds: open the panel a user opens, ASSERT the subject's own gate, then upload.
    //
    // The previous version dispatched `change` on `#add_bg_button` in a freshly loaded page and got
    // no request and no console output on BOTH legs, which read like a silent product defect and was
    // not one: the pinned frontend binds that handler when the Backgrounds settings panel is
    // RENDERED, so a page where nobody ever opened the drawer has no listener at all
    // (`jQuery._data(input,'events') === null`). Rule 10: a driver that dispatches into an unbound
    // handler is driving something a user cannot. The precondition below is asserted BEFORE the
    // dispatch, so a repeat failure names itself instead of looking like a no-op.
    await runInteraction('backgrounds', async () => {
        const toggle = document.querySelector('#backgrounds-drawer-toggle');
        if (!toggle) return { status: 'not-driven', reason: 'no #backgrounds-drawer-toggle in the served frontend' };
        const panel = document.querySelector('#Backgrounds');
        if (panel?.classList.contains('closedDrawer')) {
            toggle.click();
        }
        const input = await (async () => {
            const deadline = performance.now() + 10000;
            while (performance.now() < deadline) {
                const candidate = document.querySelector('#add_bg_button');
                const handlers = candidate && globalThis.jQuery ? globalThis.jQuery._data(candidate, 'events') : null;
                if (candidate && handlers?.change?.length) return { candidate, handlers };
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            return { candidate: document.querySelector('#add_bg_button'), handlers: null };
        })();
        const preconditions = {
            drawerTogglePresent: true,
            panelRendered: Boolean(panel) && !panel.classList.contains('closedDrawer'),
            fileInputPresent: Boolean(input.candidate),
            changeHandlerBound: Boolean(input.handlers?.change?.length),
        };
        if (!preconditions.changeHandlerBound) {
            // The subject's own gate, named: without a bound handler the page would ignore the file.
            return { status: 'not-driven', reason: 'no change handler is bound to #add_bg_button after opening the Backgrounds panel, so the frontend would ignore a selected file', preconditions };
        }
        const backgrounds = await import('./scripts/backgrounds.js');
        const canvas = document.createElement('canvas');
        canvas.width = 8;
        canvas.height = 8;
        canvas.getContext('2d').fillStyle = '#3366aa';
        canvas.getContext('2d').fillRect(0, 0, 8, 8);
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
        const transfer = new DataTransfer();
        transfer.items.add(new File([blob], 'probe-background.png', { type: 'image/png' }));
        input.candidate.files = transfer.files;
        input.candidate.dispatchEvent(new Event('change', { bubbles: true }));
        const deadline = performance.now() + 20000;
        let listed = null;
        while (performance.now() < deadline) {
            listed = await backgrounds.getBackgrounds();
            if (String(JSON.stringify(listed ?? null)).includes('probe-background')) break;
            await new Promise(resolve => setTimeout(resolve, 250));
        }
        const serverList = await fetch('/api/backgrounds/all', { method: 'POST', headers: (await import('./script.js')).getRequestHeaders() });
        const serverListText = await serverList.text();
        // The file must also be FETCHABLE at its own URL: the upload landing in the list is not the
        // same observation as the frontend being able to display it.
        const stillUrl = '/backgrounds/probe-background.png';
        const still = await fetch(stillUrl, { headers: { ...(await import('./script.js')).getRequestHeaders() } });
        return {
            status: 'driven',
            preconditions,
            observed: {
                listedContainsUpload: String(JSON.stringify(listed ?? null)).includes('probe-background'),
                listedType: Array.isArray(listed) ? 'array' : typeof listed,
                serverListStatus: serverList.status,
                serverListContainsUpload: serverListText.includes('probe-background'),
                stillStatus: still.status,
                stillBytes: (await still.arrayBuffer()).byteLength,
                folders: (backgrounds.background_settings?.folders ?? []).map(folder => ({ name: folder?.name ?? null, backgroundCount: Array.isArray(folder?.backgrounds) ? folder.backgrounds.length : null })),
            },
        };
    });

    // 5. Quick replies: create a set through the extension's own published API, persist it, then
    // RELOAD and re-read. Two predecessor defects, both rule-10 shaped: the drive imported
    // `api/QuickReplyApi.js` and read a static `instance` that the extension never sets (the instance
    // is published as `globalThis.quickReplyApi` by the `hooks.activate -> init()` path), and its
    // interaction body ended in an unconditional `not-driven` return, so it could never demonstrate a
    // write. Both are gone; the observed value is now the state the SERVER hands back after a reload.
    {
        const startIndex = requests.length;
        let created = null;
        try {
            created = await page.evaluate(async () => {
                const api = globalThis.quickReplyApi;
                const preconditions = { publishedApiOnGlobal: Boolean(api), listSetsBefore: api ? api.listSets().length : null };
                if (!api) {
                    return { status: 'not-driven', reason: 'globalThis.quickReplyApi is undefined: the frontend never ran the extension init() that constructs it', preconditions };
                }
                await api.createSet('probe-set');
                await api.createQuickReply('probe-set', 'probe-qr', { message: 'probe message' });
                const set = api.getSetByName('probe-set');
                if (set && typeof set.save === 'function') {
                    await set.save();
                }
                return {
                    status: 'driven',
                    preconditions,
                    observed: {
                        setCreated: Boolean(set),
                        qrCreated: Boolean(set?.qrList?.some(entry => entry.label === 'probe-qr')),
                        listSetsAfterCreate: api.listSets().sort(),
                    },
                };
            });
        } catch (error) {
            created = { status: 'not-driven', reason: 'page.evaluate threw: ' + String(error.message ?? error).slice(0, 200) };
        }
        // Wait for the extension's own save request rather than for a duration.
        const saveDeadline = Date.now() + 15000;
        while (Date.now() < saveDeadline && !requests.slice(startIndex).some(entry => entry.path.startsWith('/api/quick-replies/') && entry.method === 'POST')) {
            await page.waitForTimeout(100);
        }
        let after = null;
        if (created?.status === 'driven') {
            await page.reload({ waitUntil: 'domcontentloaded' });
            const deadline = Date.now() + 60000;
            while (Date.now() < deadline) {
                after = await page.evaluate(() => {
                    const api = globalThis.quickReplyApi;
                    if (!api) return null;
                    const sets = api.listSets().sort();
                    const set = api.getSetByName('probe-set');
                    return { listSetsAfterReload: sets, setPersisted: sets.includes('probe-set'), qrPersisted: Boolean(set?.qrList?.some(entry => entry.label === 'probe-qr')) };
                }).catch(() => null);
                if (after) break;
                await page.waitForTimeout(250);
            }
        }
        report.interactions.push({
            id: 'quickReplies',
            status: created?.status ?? 'not-driven',
            reason: created?.reason ?? null,
            preconditions: created?.preconditions ?? null,
            observed: created ? { ...(created.observed ?? {}), ...(after ?? {}) } : null,
            requests: requests.slice(startIndex).map(entry => ({ method: entry.method, path: entry.path, resourceType: entry.resourceType, status: entry.status, contentType: entry.contentType, bodySha256: entry.bodySha256, bodyLength: entry.bodyLength, postDataSha256: entry.postDataSha256, postDataLength: entry.postDataLength })),
        });
    }

    report.finalState = await page.evaluate(async () => {
        const script = await import('./script.js');
        return {
            settingsReady: Boolean(script.settingsReady),
            characterCount: Array.isArray(script.characters) ? script.characters.length : null,
            userAvatar: script.settings?.user_avatar ?? null,
        };
    });
} catch (error) {
    report.failure = String(error.message ?? error);
} finally {
    if (browser) await browser.close();
    server?.kill();
    if (process.env.GOTAVERN_KEEP_TEMP !== '1') {
        await new Promise(resolve => setTimeout(resolve, 300));
        await fs.rm(dataRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 }).catch(() => {});
    }
}

const reportPath = path.resolve(process.argv.includes('--report') ? process.argv[process.argv.indexOf('--report') + 1] : path.join(repoRoot, 'tests', 'browser', 'data-domain-report.json'));
await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({
    subject: report.provenance.subject,
    failure: report.failure,
    reachedUserState: report.reachedUserState,
    interactions: report.interactions.map(entry => ({ id: entry.id, status: entry.status, reason: entry.reason, requests: entry.requests.length })),
}, null, 2));
