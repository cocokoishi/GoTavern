// Does 酒馆助手 / JS-Slash-Runner actually RUN on this backend?
//
// WHY THIS LEG EXISTS. `extension-tavern-helper-comparison.json` installs the pinned extension, reaches
// user state, counts 32 extension containers and compares the requests the page makes — and never
// executes one line of helper script. The extension's entire architecture is user code in an
// unsandboxed same-origin `srcdoc` iframe whose bridge is property injection at document start
// (`src/iframe/predefine.js`), with 25 static `../../../../../` imports of the host's own modules. None
// of that is exercised by a container count. AGENTS.md 47: a helper test must drive a real browser
// against the unmodified frontend and assert on the provider request and the persisted state the helper
// produced, not on the presence of a script element.
//
// WHAT IT DRIVES (measured from the pinned extension at N0VI028/JS-Slash-Runner@837a6288, manifest
// 4.11.3, not from this comment):
//   1. install the pinned extension where the frontend serves it (reusing install-pinned-extension.mjs);
//   2. load the real page and open a real character chat (a click, as a user does);
//   3. enable one probe SCRIPT through the helper's own API (`replaceScriptTrees`), which makes the
//      extension create its script iframe and run the module inside it;
//   4. the script reads and writes a CHAT variable (`getVariables` / `insertOrAssignVariables`, the
//      pinned names — there is no `setVariables`) and writes one message whose body is an HTML code
//      block, which is exactly the shape the extension's renderer scans for (`src/util/is_frontend.ts`
//      matches `<body`/`<html>`/`<head>` inside a `<pre>`; `src/store/iframe_runtimes/message.ts` wraps
//      it in `div.TH-render` and mounts a render iframe);
//   5. it reads back the iframe's own record of what it could see, the chat file's variables before and
//      after, the rendered DOM inside the render iframe, and every URL those two iframes put into the
//      DOM.
//
// WHAT IT NEVER DOES. It does not call the model. The generation leg is a separate drive
// (helper-generation-probe.mjs) because a render script that also generates would make one failure
// impossible to attribute, and because the generation leg needs the capture peer the other legs use.
//
// OFFLINE DECISION, RECORDED. Every iframe head loads Vue and Vue-Router from
// `https://testingcf.jsdelivr.net` with blocking `<script src>` tags and no `onerror`
// (`src/iframe/third_party_script.html`). This probe BLOCKS that host explicitly and records every
// blocked URL in `blockedExternal`: a blocking tag that resolves slowly turns a page-load budget into a
// timing test, and one that fails silently leaves `Vue` undefined. The probe script uses only
// `TavernHelper`, so the block does not weaken the assertions it makes; a user script that needs Vue is
// OUTSIDE what this leg proves and is listed in the comparator's `unproven` reasons.
//
// VARIANTS. `--variant off` runs the identical drive without enabling the probe script. A comparison
// whose on and off runs are identical is `HARNESS NON-DISCRIMINATING` (AGENTS.md 50), so the pair is
// recorded together rather than trusted.

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { describeInstalledExtension, ensurePinnedExtensionInstalled } from './install-pinned-extension.mjs';
import { pinnedExtension } from './pinned-extensions.mjs';
import { seedLegConfig } from './seed-leg-config.mjs';
import { attachUrlRecorder } from './url-recorder.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const playwrightModule = await import('@playwright/test');
const chromium = playwrightModule.chromium ?? playwrightModule.default?.chromium;

function argumentValue(name, fallback = null) {
    const index = process.argv.indexOf(name);
    return index === -1 ? fallback : process.argv[index + 1];
}

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

async function waitForServer(url, deadlineMs = 90000) {
    const deadline = Date.now() + deadlineMs;
    while (Date.now() < deadline) {
        try {
            const response = await fetch(url);
            if (response.ok) return;
        } catch {
            // not up yet
        }
        await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error(`${url} did not answer within ${deadlineMs} ms`);
}

// The 25 static host imports of dist/index.js, extracted from the pinned bundle:
//   node -e "…match(/from\"(\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/[^\"]+)\"/g)…" at 837a6288
// They resolve against /scripts/extensions/third-party/<name>/dist/ five levels up, i.e. to the host's
// own root. Each must answer 200 with bytes or the extension cannot load at all; the artefact records
// the status of every one rather than only the first failure.
const HOST_MODULES = [
    '/script.js',
    '/scripts/authors-note.js',
    '/scripts/extensions.js',
    '/scripts/extensions/regex/engine.js',
    '/scripts/i18n.js',
    '/scripts/macros.js',
    '/scripts/openai.js',
    '/scripts/personas.js',
    '/scripts/popup.js',
    '/scripts/power-user.js',
    '/scripts/preset-manager.js',
    '/scripts/PromptManager.js',
    '/scripts/reasoning.js',
    '/scripts/RossAscends-mods.js',
    '/scripts/slash-commands.js',
    '/scripts/slash-commands/SlashCommand.js',
    '/scripts/slash-commands/SlashCommandArgument.js',
    '/scripts/slash-commands/SlashCommandCommonEnumsProvider.js',
    '/scripts/slash-commands/SlashCommandEnumValue.js',
    '/scripts/slash-commands/SlashCommandParser.js',
    '/scripts/sse-stream.js',
    '/scripts/tokenizers.js',
    '/scripts/user.js',
    '/scripts/utils.js',
    '/scripts/world-info.js',
];

// The script that runs INSIDE the extension's iframe. Written as concatenated lines because it is
// embedded in a module the extension generates, and a nested template literal or a literal
// `</script>` would end that module early.
const PROBE_SCRIPT = [
    "const bridge = {",
    "  isIframe: window !== window.parent,",
    "  parentHelperType: typeof window.parent.TavernHelper,",
    "  parentHelperKeys: window.parent.TavernHelper ? Object.keys(window.parent.TavernHelper).length : 0,",
    "  localHelperType: typeof TavernHelper,",
    "  hasGetVariables: typeof TavernHelper?.getVariables === 'function',",
    "  hasInsertOrAssignVariables: typeof TavernHelper?.insertOrAssignVariables === 'function',",
    "  hasSetChatMessage: typeof TavernHelper?.setChatMessage === 'function',",
    "};",
    "window.__helperProbeBridge = bridge;",
    "try {",
    "  const before = TavernHelper.getVariables({ type: 'chat' });",
    "  const counter = (Number(before.helper_probe_counter) || 0) + 1;",
    "  TavernHelper.insertOrAssignVariables({ helper_probe_counter: counter, helper_probe_marker: 'HELPER_PROBE_WROTE_VARIABLE' }, { type: 'chat' });",
    "  const urls = window.__helperProbeRenderedUrls || {};",
    "  const lines = ['```html', '<body>', '<div id=\"helper-probe-rendered\">HELPER_PROBE_RENDERED</div>'];",
    "  if (urls.character) lines.push('<img id=\"helper-probe-character\" src=\"' + urls.character + '\">');",
    "  if (urls.thumbnail) lines.push('<img id=\"helper-probe-thumbnail\" src=\"' + urls.thumbnail + '\">');",
    "  lines.push('</body>', '```');",
    "  await TavernHelper.setChatMessage({ message_id: 0, message: lines.join('\\n') });",
    "  window.__helperProbeDone = { marker: 'HELPER_PROBE_SCRIPT_DONE', counter, after: TavernHelper.getVariables({ type: 'chat' }).helper_probe_counter };",
    "} catch (error) {",
    "  window.__helperProbeError = String(error && error.message || error);",
    "}",
].join('\n');

const extensionKey = 'tavern-helper';
const extension = pinnedExtension(extensionKey);
const external = Boolean(process.env.PROBE_BASE_URL);
const variant = argumentValue('--variant', 'on');
const mutation = argumentValue('--mutation', 'none');
const dataRoot = path.resolve(argumentValue('--data-root') ?? await fs.mkdtemp(path.join(process.env.TEMP ?? '/tmp', 'gotavern-helper-probe-')));
const reportPath = path.resolve(argumentValue('--report', path.join(here, `helper-${variant}-leg.json`)));

await fs.mkdir(dataRoot, { recursive: true });
const installed = await ensurePinnedExtensionInstalled(dataRoot, extension);
const described = await describeInstalledExtension(installed.extensionDirectory);

// The data root's pre-drive state, so two legs that did not begin identically can be refused by the
// comparison rather than reported as a difference between two servers.
async function countFiles(directory) {
    let total = 0;
    for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch(() => [])) {
        if (entry.name === '.git') continue;
        total += entry.isDirectory() ? await countFiles(path.join(directory, entry.name)) : 1;
    }
    return total;
}
const startingState = {
    hasChats: await fs.stat(path.join(dataRoot, 'default-user', 'chats')).then(() => true, () => false),
    characterFiles: await fs.readdir(path.join(dataRoot, 'default-user', 'characters')).then(entries => entries.length, () => 0),
    extensionFiles: await countFiles(installed.extensionDirectory),
    extensionRevision: installed.revision,
};

const port = await freePort();
let server = null;
let stagedLayout = null;
let legConfig = process.env.PROBE_LEG_CONFIG_JSON ? JSON.parse(process.env.PROBE_LEG_CONFIG_JSON) : null;
if (!external) {
    const binarySetting = process.env.GOTAVERN_BINARY ?? '';
    const binary = binarySetting ? path.resolve(binarySetting) : path.join(dataRoot, process.platform === 'win32' ? 'gotavern.exe' : 'gotavern');
    if (!binarySetting) {
        const build = spawn('go', ['build', '-trimpath', '-o', binary, './cmd/gotavern'], { cwd: repoRoot, stdio: 'inherit' });
        if (await new Promise(resolve => build.on('exit', resolve)) !== 0) {
            throw new Error('go build ./cmd/gotavern failed');
        }
    }
    if (binarySetting) {
        await fs.copyFile(binarySetting, binary);
    }
    const tokenizerSource = path.join(repoRoot, 'upstream', 'tokenizers');
    if (!(await fs.stat(tokenizerSource).then(() => true, () => false))) {
        throw new Error(`tokenizer data missing at ${tokenizerSource}; a leg without it is not a release install`);
    }
    await fs.cp(tokenizerSource, path.join(dataRoot, 'tokenizers'), { recursive: true });
    stagedLayout = { installRootIsDataRoot: true, stagedTokenizers: true, stagedPublic: false, source: binarySetting ? 'GOTAVERN_BINARY' : 'go build ./cmd/gotavern' };
    legConfig = await seedLegConfig(dataRoot);
    server = spawn(binary, ['start', '--port', String(port), '--dataRoot', dataRoot, '--configPath', path.join(dataRoot, 'config.yaml')], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stdout.on('data', () => {});
    server.stderr.on('data', () => {});
}

const baseURL = process.env.PROBE_BASE_URL ?? `http://127.0.0.1:${port}`;
const extensionPrefix = `/scripts/extensions/third-party/${extension.name}/`;

const report = {
    schemaVersion: 1,
    question: `does the pinned frontend RUN ${extension.label} user code and the state it produces, and is every URL that helper code puts into the DOM served?`,
    subject: external ? 'pinned' : 'gotavern',
    variant,
    mutation,
    baseURL,
    provenance: {
        subject: external ? 'pinned' : 'gotavern',
        startingState,
        layout: stagedLayout,
        configFile: legConfig,
        extension: {
            key: extensionKey,
            label: extension.label,
            name: extension.name,
            repo: extension.repo,
            commit: extension.commit,
            installedRevision: installed.revision,
            installSource: installed.source ?? null,
            remoteKind: installed.remote ?? 'remote',
            ...described,
        },
        hostModules: { source: `dist/index.js static imports at ${extension.commit}`, count: HOST_MODULES.length },
        blockedExternal: [],
        blockedExternalReason: 'the iframe heads load Vue/Vue-Router from testingcf.jsdelivr.net with blocking <script> tags and no onerror; the probe blocks the host so a network stall cannot become a page-load budget. The probe script uses only TavernHelper, so this does not weaken what is asserted; a user script that needs Vue is outside this leg.',
    },
    steps: [],
    bridge: null,
    iframe: null,
    hostImportStatus: null,
    variableState: null,
    render: null,
    urls: [],
    console: [],
    pageErrors: [],
    httpFailures: [],
    failure: null,
};

function step(name, ok, detail = null) {
    report.steps.push({ name, ok, detail });
    if (!ok && !report.failure) report.failure = `${name}: ${detail ?? 'failed'}`;
    return ok;
}

// The chat file's own record of the chat variables, read from disk. This is the persisted-state half
// of the assertion: a variable that only exists in the page's memory is not saved.
async function readChatVariables() {
    const chatsDirectory = path.join(dataRoot, 'default-user', 'chats');
    const entries = await fs.readdir(chatsDirectory).catch(() => []);
    const chatFiles = entries.filter(name => name.endsWith('.jsonl'));
    if (chatFiles.length === 0) return { chatFile: null, variables: null };
    const withTimes = await Promise.all(chatFiles.map(async name => ({
        name,
        mtime: (await fs.stat(path.join(chatsDirectory, name))).mtimeMs,
    })));
    withTimes.sort((left, right) => right.mtime - left.mtime);
    const chatFile = withTimes[0].name;
    const body = await fs.readFile(path.join(chatsDirectory, chatFile), 'utf8');
    const firstLine = body.split('\n').find(line => line.trim() !== '');
    let variables = null;
    try {
        variables = JSON.parse(firstLine)?.chat_metadata?.variables ?? null;
    } catch {
        variables = 'unparsable-first-line';
    }
    return { chatFile, variables };
}

let browser;
try {
    await waitForServer(`${baseURL}/version`);
    browser = await chromium.launch();
    const page = await browser.newPage();
    page.on('pageerror', error => report.pageErrors.push(String(error?.message ?? error).slice(0, 300)));
    page.on('console', message => report.console.push({ type: message.type(), text: String(message.text()).slice(0, 400) }));
    page.on('response', response => {
        if (response.status() >= 400) {
            try {
                report.httpFailures.push(`${response.status()} ${new URL(response.url()).pathname}`);
            } catch {
                // a non-URL response has no pathname
            }
        }
    });
    const recorder = attachUrlRecorder(page);

    // The offline decision, recorded per URL rather than asserted in a comment.
    await page.route('**://testingcf.jsdelivr.net/**', route => {
        report.provenance.blockedExternal.push(route.request().url());
        return route.abort();
    });

    if (mutation === 'sandbox-iframes') {
        // Models a frontend that sandboxed extension iframes: the bridge (property injection at
        // document start) cannot work cross-document without same-origin, so the guard must go red.
        await page.addInitScript(() => {
            const create = document.createElement.bind(document);
            document.createElement = function patched(tagName, options) {
                const element = create(tagName, options);
                if (String(tagName).toLowerCase() === 'iframe') element.setAttribute('sandbox', '');
                return element;
            };
        });
    }

    await page.goto(`${baseURL}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction('document.getElementById("preloader") === null', null, { timeout: 120000 });
    step('page-loaded', true);
    report.reachedUserState = await page.evaluate(async () => {
        const script = await import('./script.js');
        const started = performance.now();
        while (performance.now() - started < 60000) {
            if (script.settingsReady) return { settingsReady: true };
            const onboarding = document.querySelector('.popup .onboarding');
            if (onboarding) {
                const nameInput = onboarding.closest('.popup')?.querySelector('.popup-input');
                if (nameInput) {
                    nameInput.value = 'Probe User';
                    nameInput.dispatchEvent(new Event('input', { bubbles: true }));
                }
                onboarding.closest('.popup')?.querySelector('.popup-button-ok')?.click();
            }
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        return { settingsReady: false };
    });
    step('settings-ready', report.reachedUserState?.settingsReady === true, 'script.js settingsReady');

    // The 25 host imports, judged as URLs: the extension is an ES module that imports the host's own
    // modules five levels up, so a single 404 makes the extension unable to load.
    report.hostImportStatus = await page.evaluate(async paths => {
        const results = [];
        for (const item of paths) {
            try {
                const response = await fetch(item, { credentials: 'same-origin' });
                const body = await response.arrayBuffer();
                results.push({ path: item, status: response.status, byteLength: body.byteLength });
            } catch (error) {
                results.push({ path: item, status: 0, byteLength: 0, error: String(error?.message ?? error) });
            }
        }
        return results;
    }, HOST_MODULES);
    const brokenHostModules = report.hostImportStatus.filter(entry => entry.status !== 200 || entry.byteLength === 0);
    step('host-modules', brokenHostModules.length === 0, brokenHostModules.map(entry => `${entry.status} ${entry.path}`).join(', ') || null);

    // OPEN A REAL CHAT, as a user does: click the first character card.
    const characterAvatar = await page.evaluate(async () => {
        const script = await import('./script.js');
        const characters = script.characters ?? [];
        return characters.length > 0 ? characters[0].avatar : null;
    });
    await page.waitForSelector('#rm_print_characters_block .avatar[data-type="character"]', { timeout: 60000 }).catch(() => null);
    const clicked = await page.click('#rm_print_characters_block .avatar[data-type="character"]', { timeout: 30000 }).then(() => true, () => false);
    step('character-opened', clicked);
    const messageArrived = await page.waitForSelector('#chat .mes', { timeout: 60000 }).then(() => true, () => false);
    step('chat-has-message', messageArrived);

    const beforeVariables = await readChatVariables();
    report.variableState = { before: beforeVariables.variables, after: null, changed: false };

    // The URLs the rendered message will carry. Taken from the page's own state (the first card's own
    // avatar and the frontend's own thumbnail URL builder) so the guard judges real mounts rather than
    // paths invented here.
    const renderedUrls = await page.evaluate(async avatar => {
        const script = await import('./script.js');
        const thumbnail = typeof script.getThumbnailUrl === 'function'
            ? script.getThumbnailUrl('avatar', avatar)
            : `/thumbnail?type=avatar&file=${encodeURIComponent(avatar)}`;
        return { character: `/characters/${encodeURIComponent(avatar)}`, thumbnail };
    }, characterAvatar);
    report.urls = [{ purpose: 'rendered-message', ...renderedUrls }];

    if (variant === 'on') {
        await page.evaluate(script => {
            window.__helperProbeRenderedUrls = script.urls;
            window.TavernHelper.replaceScriptTrees([{
                type: 'script',
                enabled: true,
                name: 'gotavern-probe-script',
                id: 'gotavern-probe-script',
                content: script.content,
                button: { enabled: true, buttons: [{ name: 'probe', visible: true }] },
            }], { type: 'global' });
        }, { content: PROBE_SCRIPT, urls: renderedUrls });
        step('script-enabled', true);
    } else {
        report.steps.push({ name: 'script-enabled', ok: null, detail: 'variant off: no probe script is installed, so the iframe/render/variable observations must not appear' });
    }

    // Wait for the extension's own script iframe to exist and to have reported its bridge.
    const scriptDeadline = Date.now() + (variant === 'on' ? 45000 : 8000);
    let iframeObservation = null;
    while (Date.now() < scriptDeadline) {
        iframeObservation = await page.evaluate(() => {
            const frames = Array.from(document.querySelectorAll('iframe'));
            const scriptFrame = frames.find(frame => {
                try {
                    return Boolean(frame.contentWindow?.__helperProbeBridge);
                } catch {
                    return false;
                }
            });
            const candidate = scriptFrame ?? frames.find(frame => (frame.getAttribute('srcdoc') ?? '').includes('__helperProbeBridge'));
            if (!candidate) return null;
            let bridge = null;
            let error = null;
            try {
                bridge = candidate.contentWindow?.__helperProbeBridge ?? null;
            } catch (caught) {
                error = String(caught?.message ?? caught);
            }
            return {
                id: candidate.getAttribute('id'),
                hasSandboxAttribute: candidate.hasAttribute('sandbox'),
                sandboxValue: candidate.getAttribute('sandbox'),
                srcdocLength: (candidate.getAttribute('srcdoc') ?? '').length,
                src: candidate.getAttribute('src'),
                sameOriginReadable: error === null,
                readError: error,
                bridge,
                done: candidate.contentWindow?.__helperProbeDone ?? null,
                scriptError: candidate.contentWindow?.__helperProbeError ?? null,
                parentHelperReachable: (() => {
                    try {
                        return typeof candidate.contentWindow?.parent?.TavernHelper === 'object';
                    } catch {
                        return false;
                    }
                })(),
            };
        });
        if (iframeObservation?.done || iframeObservation?.scriptError) break;
        await new Promise(resolve => setTimeout(resolve, 250));
    }
    report.iframe = iframeObservation;
    if (variant === 'on') {
        step('script-iframe', iframeObservation !== null, 'an iframe whose contentWindow exposes the probe bridge');
        if (iframeObservation) {
            report.bridge = iframeObservation.bridge;
            step('bridge-reachable', iframeObservation.sameOriginReadable === true && iframeObservation.parentHelperReachable === true, iframeObservation.readError);
            step('iframe-not-sandboxed', iframeObservation.hasSandboxAttribute === false, `sandbox=${iframeObservation.sandboxValue}`);
            step('script-ran', iframeObservation.done?.marker === 'HELPER_PROBE_SCRIPT_DONE', iframeObservation.scriptError ?? 'no completion marker');
        }
    } else {
        // The off leg must NOT fail for being off: its whole purpose is to produce a capture that
        // differs from the on leg, and a red off leg would let a non-discriminating harness hide behind
        // "the off run failed, so compare nothing".
        report.steps.push({ name: 'script-iframe', ok: null, detail: 'variant off: no probe script was installed, so no script iframe may appear' });
        report.steps.push({ name: 'bridge-reachable', ok: null, detail: 'variant off' });
        report.steps.push({ name: 'iframe-not-sandboxed', ok: null, detail: 'variant off' });
        report.steps.push({ name: 'script-ran', ok: null, detail: 'variant off' });
    }

    // THE RENDER PATH: the extension wraps an HTML code block in div.TH-render and mounts an iframe.
    if (variant === 'on') {
        const renderedDeadline = Date.now() + 45000;
        let render = null;
        while (Date.now() < renderedDeadline) {
            render = await page.evaluate(() => {
                const host = document.querySelector('div.TH-render');
                if (!host) return null;
                const frame = host.querySelector('iframe');
                if (!frame) return { wrapPresent: true, iframePresent: false };
                let inner = null;
                try {
                    inner = frame.contentDocument?.getElementById('helper-probe-rendered')?.textContent ?? null;
                } catch {
                    inner = null;
                }
                return {
                    wrapPresent: true,
                    iframePresent: true,
                    hasSandboxAttribute: frame.hasAttribute('sandbox'),
                    renderedText: inner,
                    rawPreStillPresent: Boolean(host.querySelector('pre')),
                };
            });
            if (render?.renderedText) break;
            await new Promise(resolve => setTimeout(resolve, 250));
        }
        report.render = render;
        step('render-path', render?.renderedText === 'HELPER_PROBE_RENDERED', JSON.stringify(render));
    }

    // The persisted half: the chat file's variables, after the helper's own write.
    if (variant === 'on') {
        const saveDeadline = Date.now() + 30000;
        let after = await readChatVariables();
        while (Date.now() < saveDeadline) {
            const counter = Number(after.variables?.helper_probe_counter ?? NaN);
            if (Number.isFinite(counter) && counter >= 1) break;
            await new Promise(resolve => setTimeout(resolve, 250));
            after = await readChatVariables();
        }
        report.variableState.after = after.variables;
        report.variableState.chatFile = after.chatFile;
        report.variableState.changed = JSON.stringify(after.variables) !== JSON.stringify(report.variableState.before);
        step('variable-persisted', Number(report.variableState.after?.helper_probe_counter ?? 0) >= 1, `counter=${report.variableState.after?.helper_probe_counter ?? '(absent)'} in ${after.chatFile ?? '(no chat file)'}`);
    }

    // EVERY URL THE TWO IFRAMES PUT INTO THE DOM MUST ANSWER 200 WITH BYTES. The bespoke URLs are judged
    // from the recorder; the two images are additionally judged by the DOM's own decode state, because a
    // 200 with an error page is complete with naturalWidth 0 and has shipped once already.
    await recorder.settled();
    for (const target of report.urls) {
        for (const purpose of ['character', 'thumbnail']) {
            const wanted = target[purpose];
            if (!wanted) continue;
            const pathAndQuery = wanted.startsWith('http') ? new URL(wanted).pathname + new URL(wanted).search : wanted;
            const entry = recorder.requests.filter(item => item.pathAndQuery === pathAndQuery).sort((left, right) => (right.status ?? 0) - (left.status ?? 0))[0];
            target[`${purpose}Response`] = entry ?? null;
        }
    }
    const failedUrls = report.urls.flatMap(target => ['character', 'thumbnail']
        .map(purpose => ({ purpose, response: target[`${purpose}Response`] }))
        .filter(item => item.response === null || item.response?.status !== 200 || !(item.response?.byteLength > 0))
        .map(item => `${item.purpose}=${item.response === null ? 'not-requested' : `${item.response.status}/${item.response.byteLength}`}`));
    if (variant === 'on') {
        step('dom-urls', failedUrls.length === 0, failedUrls.join(', ') || null);
    } else {
        report.steps.push({ name: 'dom-urls', ok: null, detail: 'variant off: the rendered message is not produced, so there are no rendered URLs to judge' });
    }
} catch (error) {
    report.failure = report.failure ?? String(error?.message ?? error);
} finally {
    if (browser) await browser.close();
    server?.kill();
}

await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({
    subject: report.subject,
    variant: report.variant,
    mutation: report.mutation,
    failure: report.failure,
    bridge: report.bridge,
    iframe: report.iframe ? { id: report.iframe.id, sandbox: report.iframe.hasSandboxAttribute, sameOriginReadable: report.iframe.sameOriginReadable } : null,
    render: report.render,
    variableCounter: report.variableState?.after?.helper_probe_counter ?? null,
    hostModulesBroken: (report.hostImportStatus ?? []).filter(entry => entry.status !== 200 || entry.byteLength === 0).length,
    steps: report.steps.map(item => `${item.ok === null ? 'n/a' : item.ok ? 'ok' : 'FAIL'} ${item.name}`),
}, null, 2));
if (report.failure) process.exitCode = 1;
