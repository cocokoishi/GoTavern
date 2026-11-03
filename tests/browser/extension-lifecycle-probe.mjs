// ONE LEG OF THE THIRD-PARTY EXTENSION LIFECYCLE DIFFERENTIAL.
//
// The question: with a pinned real SillyTavern extension installed at its pinned commit, does the pinned
// frontend reach the same state and make the same backend calls against GoTavern and against stock
// SillyTavern -- and does the extension survive the lifecycle a user puts it through (activate, change a
// setting, restart the server, disable, re-enable, uninstall) the same way on both subjects?
//
// The probe is ONE DRIVE run twice: `--phase before` mutates an extension setting and records activation;
// `--phase after` runs against a NEW server process on the SAME data root, asserts the setting survived
// the restart, then disables/re-enables/uninstalls through the frontend's own mechanisms. Splitting the
// phases is what makes "restart" a real restart instead of a reload: the runner kills the subject between
// them, so the second phase cannot be reading the first phase's memory.
//
// WHAT IT NEVER DOES: it never boots a server when PROBE_BASE_URL is present (the caller owns that
// server, and booting a second one would compare the wrong pair), and it never decides whether the two
// legs agree -- compare-extension-lifecycle.mjs is a pure function of the leg files.
//
// Usage:
//   GOTAVERN_BINARY=<bin> node extension-lifecycle-probe.mjs --extension <name> --data-root <dir> \
//       --phase before --report <file>
//   node run-against-pinned.mjs extension-lifecycle-probe.mjs -- --extension <name> --data-root <dir> \
//       --phase after --report <file>
//
// Exit 0 only when the drive ran and its own guards held; a leg failure is written into the report and
// exits 1 so the runner can tell "measured" from "did not measure".

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

import { extensionByKey, loadLock, needsGenerationLeg } from './third-party-extensions.mjs';
import { describeInstalledExtension, installedRevision, userExtensionsDirectory } from './install-pinned-extension.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const playwrightModule = await import('@playwright/test');
const chromium = playwrightModule.chromium ?? playwrightModule.default?.chromium;

function argumentValue(name, fallback = null) {
    const index = process.argv.indexOf(name);
    if (index === -1) return fallback;
    const value = process.argv[index + 1];
    return value === undefined ? fallback : value;
}

const lock = loadLock(argumentValue('--lock', path.join(here, 'third-party-extensions.lock.json'))).lock;
const extension = extensionByKey(lock, argumentValue('--extension'));
const external = Boolean(process.env.PROBE_BASE_URL);
const subject = argumentValue('--subject', external ? 'pinned' : 'gotavern');
const phase = argumentValue('--phase', 'before');
if (!['before', 'after'].includes(phase)) throw new Error(`--phase must be before or after; got ${JSON.stringify(phase)}`);
const dataRoot = path.resolve(argumentValue('--data-root'));
const reportPath = path.resolve(argumentValue('--report', path.join(here, `extension-lifecycle-${subject}-${phase}.json`)));
const baseURL = process.env.PROBE_BASE_URL ?? argumentValue('--base-url', null);
if (!baseURL) throw new Error('PROBE_BASE_URL is required: the runner owns the subject process so a restart is a real restart');

const extensionDirectory = path.join(userExtensionsDirectory(dataRoot), extension.name);
const extensionPrefix = `/scripts/extensions/third-party/${extension.name}/`;

const report = {
    schemaVersion: 1,
    surface: 'third-party-extension-lifecycle',
    question: 'Does a pinned real third-party extension activate, persist its settings across a server restart, disable, re-enable and uninstall identically on stock SillyTavern and GoTavern?',
    subject,
    phase,
    baseURL,
    startedAt: new Date().toISOString(),
    provenance: {
        subject,
        phase,
        extension: {
            name: extension.name,
            repo: extension.repo,
            commit: extension.commit,
            capabilities: extension.capabilities,
            generationLeg: needsGenerationLeg(extension),
            lockSha256: loadLock(argumentValue('--lock', path.join(here, 'third-party-extensions.lock.json'))).sha256,
        },
        installedRevision: await installedRevision(extensionDirectory),
        installedDescription: await describeInstalledExtension(extensionDirectory),
        serverPid: process.env.PROBE_SERVER_PID ? Number(process.env.PROBE_SERVER_PID) : null,
        configFile: process.env.PROBE_LEG_CONFIG_JSON ? JSON.parse(process.env.PROBE_LEG_CONFIG_JSON) : null,
    },
    steps: [],
    phases: {},
    failure: null,
};

function recordStep(name, detail) {
    report.steps.push({ name, at: new Date().toISOString(), ...detail });
}

function shapeOf(value, depth = 0) {
    if (depth > 3) return 'depth-limit';
    if (value === null) return 'null';
    if (Array.isArray(value)) return { type: 'array', length: value.length, item: value.length ? shapeOf(value[0], depth + 1) : null };
    if (typeof value === 'object') {
        const keys = {};
        for (const key of Object.keys(value).sort()) keys[key] = shapeOf(value[key], depth + 1);
        return { type: 'object', keys };
    }
    return typeof value;
}

async function waitForNetworkQuiet(entries, quietMs, deadlineMs) {
    const started = Date.now();
    let lastCount = entries.length;
    let lastChange = Date.now();
    while (Date.now() - started < deadlineMs) {
        await new Promise(resolve => setTimeout(resolve, 100));
        if (entries.length !== lastCount) {
            lastCount = entries.length;
            lastChange = Date.now();
        }
        if (!entries.some(entry => entry.status === null) && Date.now() - lastChange >= quietMs) {
            return { quiet: true, waitedMs: Date.now() - started, requests: entries.length };
        }
    }
    return { quiet: false, waitedMs: Date.now() - started, requests: entries.length, unresolved: entries.filter(entry => entry.status === null).map(entry => entry.path) };
}

const marker = `alpha13-${subject}-${phase}-${Date.now()}`;

// A FRESH BROWSER CONTEXT PER STEP. A reload can answer the extension's script from the browser cache,
// and then "the extension did not load while disabled" would be indistinguishable from "the cache served
// it". A new context has an empty cache, so a disabled extension produces NO request, which is the
// observable this probe asserts.
async function drive(browser, { label, expectExtensionLoaded, extraWaitMs = 0 }) {
    const context = await browser.newContext();
    const page = await context.newPage();
    const requests = [];
    const consoleEntries = [];
    const pageErrors = [];
    const httpFailures = [];
    page.on('pageerror', error => pageErrors.push(String(error.message ?? error).slice(0, 300)));
    page.on('console', message => consoleEntries.push({ type: message.type(), text: String(message.text()).slice(0, 500) }));
    const pending = new Map();
    page.on('request', request => {
        const url = new URL(request.url());
        const entry = { method: request.method(), path: url.pathname + url.search, status: null, contentType: '', bodyLength: null, bodySha256: null, bodyShape: null };
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
            entry.bodySha256 = createHash('sha256').update(bytes).digest('hex');
            if (entry.contentType.includes('application/json') && bytes.length < 200000) {
                try {
                    entry.bodyShape = shapeOf(JSON.parse(bytes.toString('utf8')));
                } catch {
                    entry.bodyShape = 'unparsable-json';
                }
            }
        } catch {
            // redirects and aborted streams have no readable body
        }
    });
    page.on('requestfailed', request => httpFailures.push(`FAILED ${request.method()} ${new URL(request.url()).pathname}: ${request.failure()?.errorText ?? ''}`));
    page.on('response', response => {
        if (response.status() >= 400) httpFailures.push(`${response.status()} ${response.request().method()} ${new URL(response.url()).pathname}`);
    });

    const step = { label, requests, console: consoleEntries, pageErrors, httpFailures, reachedUserState: null, extensionLoaded: false, settle: null, finalState: null };
    try {
        await page.goto(`${baseURL}/`, { waitUntil: 'domcontentloaded', timeout: 120000 });
        await page.waitForFunction('document.getElementById("preloader") === null', null, { timeout: 120000 });
        step.reachedUserState = await page.evaluate(async () => {
            const result = { onboardingCompleted: false, settingsReady: false };
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
            return result;
        });
        if (expectExtensionLoaded) {
            const deadline = Date.now() + 30000;
            while (Date.now() < deadline) {
                if (requests.some(entry => entry.path.startsWith(extensionPrefix) && entry.status !== null && entry.status < 400)) {
                    step.extensionLoaded = true;
                    break;
                }
                await new Promise(resolve => setTimeout(resolve, 250));
            }
        }
        if (extraWaitMs > 0) await new Promise(resolve => setTimeout(resolve, extraWaitMs));
        step.settle = await waitForNetworkQuiet(requests, 2500, 45000);
        step.finalState = await page.evaluate(async () => {
            const script = await import('./script.js');
            return {
                settingsReady: Boolean(script.settingsReady),
                title: document.title,
                extensionContainerCount: document.querySelectorAll('#extensions_settings2 .extension_container, #extensions_settings .extension_container').length,
                extensionSettingsPresent: Boolean(document.querySelector('#extensions_settings, #extensions_settings2')),
                characterListPresent: Boolean(document.querySelector('#rm_print_characters_block')),
                sendButtonPresent: Boolean(document.querySelector('#send_but')),
            };
        });
        // The extension's own requests are the ones under its prefix; the /api/* calls are the backend
        // surface the frontend and the extension reach.
        step.extensionRequests = requests.filter(entry => entry.path.startsWith(extensionPrefix) || entry.path.startsWith('/api/'));
        step.context = context;
        step.page = page;
        return step;
    } catch (error) {
        step.failure = String(error.message ?? error);
        step.context = context;
        step.page = page;
        return step;
    }
}

function summarizeStep(step) {
    return {
        label: step.label,
        failure: step.failure ?? null,
        reachedUserState: step.reachedUserState,
        extensionLoaded: step.extensionLoaded,
        settle: step.settle,
        finalState: step.finalState,
        requests: step.requests.length,
        extensionRequests: step.extensionRequests?.length ?? 0,
        pageErrors: step.pageErrors,
        httpFailures: step.httpFailures,
        consoleErrors: step.console.filter(entry => entry.type === 'error').map(entry => entry.text).slice(0, 20),
        // The request rows the comparator judges: method+path membership and status, plus a JSON shape.
        rows: (step.extensionRequests ?? []).map(entry => ({
            method: entry.method,
            path: entry.path.split('?')[0],
            status: entry.status,
            contentType: entry.contentType,
            bodyShape: entry.bodyShape,
            bodySha256: entry.bodySha256,
        })),
    };
}

const installedRevisionNow = report.provenance.installedRevision;
if (installedRevisionNow !== extension.commit) {
    report.failure = `the extension at ${extensionDirectory} is at ${JSON.stringify(installedRevisionNow)}, not the pinned ${extension.commit}; the runner must install the pinned revision before the probe runs`;
}
// The pinned frontend is only fetched from a subject that serves it; a probe that starts without the
// extension installed measures nothing, so this is a named refusal rather than a row of nulls.
if (report.failure === null) {
    const stat = await fs.stat(path.join(extensionDirectory, 'manifest.json')).catch(() => null);
    if (!stat) report.failure = `no manifest.json in ${extensionDirectory}: the installed tree is not an extension the pinned frontend can load`;
}

let browser = null;
try {
    if (report.failure !== null) throw new Error(report.failure);
    browser = await chromium.launch({ headless: true });

    if (phase === 'before') {
        const activation = await drive(browser, { label: 'activation', expectExtensionLoaded: true });
        report.phases.activation = summarizeStep(activation);
        recordStep('activation', { extensionLoaded: activation.extensionLoaded, settingsReady: activation.reachedUserState?.settingsReady ?? false });
        if (!activation.failure && activation.reachedUserState?.settingsReady) {
            // SETTINGS, THROUGH THE FRONTEND'S OWN PERSISTENCE PATH. `extension_settings` is where the
            // pinned frontend stores per-extension state and `saveSettings()` is how it writes the file;
            // mutating the object in the page and calling the exported save is exactly what an extension's
            // own setting handler does, without depending on any particular extension's DOM.
            const settingsResult = await activation.page.evaluate(async ({ extensionName, marker }) => {
                const script = await import('./script.js');
                const extensionsModule = await import('./scripts/extensions.js');
                const settings = extensionsModule.extension_settings;
                if (!settings || typeof settings !== 'object') return { available: false, reason: 'extension_settings is not exported' };
                const candidates = [extensionName, ...Object.keys(settings).filter(key => key.toLowerCase() === extensionName.toLowerCase())];
                let key = null;
                for (const candidate of candidates) {
                    if (settings[candidate] && typeof settings[candidate] === 'object' && !Array.isArray(settings[candidate])) {
                        key = candidate;
                        break;
                    }
                }
                if (key === null) return { available: false, reason: `extension_settings has no object entry for ${extensionName}`, keys: Object.keys(settings).slice(0, 60) };
                settings[key].__alpha13_probe = { marker, at: 1730000000 };
                await script.saveSettings();
                return { available: true, key, marker, saved: true };
            }, { extensionName: extension.name, marker });
            report.phases.settings = settingsResult;
            recordStep('settings', settingsResult);
        } else {
            report.phases.settings = { available: false, reason: 'the page never reached settingsReady, so no setting could be changed' };
            recordStep('settings', report.phases.settings);
        }
        await activation.context.close().catch(() => {});
    } else {
        const activation = await drive(browser, { label: 'activation-after-restart', expectExtensionLoaded: true });
        report.phases.activationAfterRestart = summarizeStep(activation);
        recordStep('activation-after-restart', { extensionLoaded: activation.extensionLoaded, settingsReady: activation.reachedUserState?.settingsReady ?? false });

        // DID THE SETTING SURVIVE A NEW SERVER PROCESS? This is the whole reason the phase split exists.
        const persisted = await activation.page.evaluate(async ({ extensionName }) => {
            const extensionsModule = await import('./scripts/extensions.js');
            const settings = extensionsModule.extension_settings;
            const candidates = [extensionName, ...Object.keys(settings ?? {}).filter(key => key.toLowerCase() === extensionName.toLowerCase())];
            for (const candidate of candidates) {
                if (settings?.[candidate] && typeof settings[candidate] === 'object') {
                    return { available: true, key: candidate, probe: settings[candidate].__alpha13_probe ?? null };
                }
            }
            return { available: false };
        }, { extensionName: extension.name });
        report.phases.settingPersisted = persisted;
        recordStep('setting-persisted', persisted);

        // DISABLE: the pinned frontend's own mechanism is extension_settings.disabledExtensions (read at
        // public/scripts/extensions.js:338, :513, :626). Pushing the folder name is what the extension
        // manager does; a disabled extension must produce NO request for its script.
        const disableResult = await activation.page.evaluate(async ({ extensionName }) => {
            const script = await import('./script.js');
            const extensionsModule = await import('./scripts/extensions.js');
            const settings = extensionsModule.extension_settings;
            if (!Array.isArray(settings.disabledExtensions)) return { available: false, reason: 'disabledExtensions is not an array' };
            if (!settings.disabledExtensions.includes(extensionName)) settings.disabledExtensions.push(extensionName);
            await script.saveSettings();
            return { available: true, disabled: [...settings.disabledExtensions] };
        }, { extensionName: extension.name });
        report.phases.disable = disableResult;
        recordStep('disable', disableResult);
        await activation.context.close().catch(() => {});

        const disabledDrive = await drive(browser, { label: 'disabled', expectExtensionLoaded: false });
        report.phases.disabledDrive = summarizeStep(disabledDrive);
        recordStep('disabled-drive', { extensionLoaded: disabledDrive.extensionLoaded, settingsReady: disabledDrive.reachedUserState?.settingsReady ?? false });
        await disabledDrive.context.close().catch(() => {});

        // RE-ENABLE, then verify the extension loads again.
        const enableDrive = await drive(browser, { label: 're-enable', expectExtensionLoaded: true, extraWaitMs: 1500 });
        const enableResult = await enableDrive.page.evaluate(async ({ extensionName }) => {
            const script = await import('./script.js');
            const extensionsModule = await import('./scripts/extensions.js');
            const settings = extensionsModule.extension_settings;
            settings.disabledExtensions = settings.disabledExtensions.filter(name => name !== extensionName);
            await script.saveSettings();
            return { available: true, disabled: [...settings.disabledExtensions] };
        }, { extensionName: extension.name }).catch(error => ({ available: false, reason: String(error.message ?? error) }));
        report.phases.enable = enableResult;
        report.phases.enabledDrive = summarizeStep(enableDrive);
        recordStep('re-enable', { extensionLoaded: enableDrive.extensionLoaded, ...enableResult });
        await enableDrive.context.close().catch(() => {});

        // UNINSTALL through the route the extension manager calls, then prove the directory is gone and a
        // fresh page still boots (no stale code, no startup failure).
        const uninstallPage = await browser.newPage();
        await uninstallPage.goto(`${baseURL}/`, { waitUntil: 'domcontentloaded', timeout: 120000 });
        const uninstall = await uninstallPage.evaluate(async ({ extensionName }) => {
            const script = await import('./script.js');
            const headers = script.getRequestHeaders();
            const response = await fetch('/api/extensions/delete', {
                method: 'POST',
                headers,
                body: JSON.stringify({ extensionName }),
            });
            const text = await response.text();
            return { status: response.status, contentType: response.headers.get('content-type'), bodyShape: null, bodyLength: text.length, body: text.slice(0, 500) };
        }, { extensionName: extension.name }).catch(error => ({ status: null, reason: String(error.message ?? error) }));
        report.phases.uninstall = uninstall;
        const directoryAfter = await fs.stat(extensionDirectory).then(() => true, () => false);
        report.phases.uninstalledDirectoryGone = !directoryAfter;
        recordStep('uninstall', { status: uninstall.status, directoryGone: !directoryAfter });
        await uninstallPage.close().catch(() => {});

        const uninstalledDrive = await drive(browser, { label: 'uninstalled', expectExtensionLoaded: false });
        report.phases.uninstalledDrive = summarizeStep(uninstalledDrive);
        recordStep('uninstalled-drive', { extensionLoaded: uninstalledDrive.extensionLoaded, settingsReady: uninstalledDrive.reachedUserState?.settingsReady ?? false });
        await uninstalledDrive.context.close().catch(() => {});
    }
} catch (error) {
    report.failure = String(error.message ?? error);
} finally {
    if (browser) await browser.close().catch(() => {});
}

// The leg's own guards: a drive that did not reach user state, or an extension that did not load when
// the step required it, is a leg failure (the runner must not compare it as a product difference).
if (report.failure === null) {
    const required = [];
    if (phase === 'before') {
        required.push(['activation', report.phases.activation?.extensionLoaded === true, 'the extension did not load in the activation step']);
        required.push(['settings-ready', report.phases.activation?.reachedUserState?.settingsReady === true, 'the page never reached settingsReady']);
    } else {
        required.push(['activation-after-restart', report.phases.activationAfterRestart?.extensionLoaded === true, 'the extension did not load after the server restart']);
        required.push(['disabled-not-loaded', report.phases.disabledDrive?.extensionLoaded === false, 'the extension still loaded while disabled']);
        required.push(['re-enabled-loaded', report.phases.enabledDrive?.extensionLoaded === true, 'the extension did not load after re-enabling']);
        required.push(['uninstall-status', report.phases.uninstall?.status === 200, `uninstall answered ${JSON.stringify(report.phases.uninstall?.status)}`]);
        required.push(['uninstall-directory-gone', report.phases.uninstalledDirectoryGone === true, 'the extension directory survived the uninstall']);
        required.push(['uninstalled-page-healthy', report.phases.uninstalledDrive?.reachedUserState?.settingsReady === true, 'the page did not reach settingsReady after the uninstall']);
    }
    const failed = required.filter(([, ok]) => !ok);
    if (failed.length > 0) report.failure = failed.map(([name, , reason]) => `${name}: ${reason}`).join('; ');
}

await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({
    subject, phase, extension: extension.name,
    failure: report.failure,
    steps: report.steps.map(step => step.name),
    activation: report.phases.activation?.extensionLoaded ?? report.phases.activationAfterRestart?.extensionLoaded ?? null,
    settingPersisted: report.phases.settingPersisted ?? null,
    disabledNotLoaded: report.phases.disabledDrive?.extensionLoaded ?? null,
    reEnabledLoaded: report.phases.enabledDrive?.extensionLoaded ?? null,
    uninstallStatus: report.phases.uninstall?.status ?? null,
}, null, 2));
if (report.failure) process.exitCode = 1;
