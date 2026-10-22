// Dynamic E2E drive for one pinned frontend extension (hard rule 15).
//
// The extension is INSTALLED the way a user installs one — a git checkout of the
// pinned revision in the per-user extensions directory — and then the real pinned
// frontend is driven against a server with that extension present. The same drive
// runs against both legs, so the comparison is of two servers under one drive
// rather than of two drives.
//
// Run the GoTavern leg directly (it builds and boots the binary), and the pinned
// leg through run-against-pinned.mjs, which boots the pinned checkout and sets
// PROBE_BASE_URL. Both legs are handed the SAME --data-root, so both serve the
// same installed extension revision.
//
// What is recorded, per leg:
//   * every request the page made: method, path, status, content type, body
//     length, body SHA-256, and — for JSON — a bounded SHAPE skeleton. A route
//     that answers 200 with the wrong shape is worse than a 404 because the
//     extension proceeds and fails later, so the shape is recorded rather than
//     only the status;
//   * the final browser state, including how many extension containers the
//     frontend built;
//   * console output, page errors and failed requests, because the extension
//     reports several problems without throwing.
//
// It does NOT decide whether the legs agree: that is compare-extension-legs.mjs,
// which is a pure function of two leg files and is what CI recomputes.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { describeInstalledExtension, ensurePinnedExtensionInstalled } from './install-pinned-extension.mjs';
import { seedLegConfig } from './seed-leg-config.mjs';
import { pinnedExtension } from './pinned-extensions.mjs';

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
    const started = Date.now();
    let lastError = null;
    while (Date.now() - started < deadlineMs) {
        try {
            const response = await fetch(url);
            if (response.ok) return;
            lastError = new Error(`${url} answered ${response.status}`);
        } catch (error) {
            lastError = error;
        }
        await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error(`server did not answer ${url} within ${deadlineMs}ms: ${lastError?.message ?? 'no response'}`);
}

// A bounded structural skeleton: keys and types, array lengths, no values. Two
// bodies with the same shape and different values are then distinguishable from
// two bodies with different shapes, which a digest alone cannot express.
// Resolves when the page has stopped issuing requests: no request for quietMs and none without a
// response. Returns what happened, so the leg states it rather than a reader having to trust a sleep.
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

// The extension's own user-data files: presence, size, digest and (for JSON) the same bounded
// skeleton the request bodies use. Bounded so a runaway directory cannot inflate a leg.
async function describeUserFiles(directory) {
    const entries = [];
    let names;
    try {
        names = (await fs.readdir(directory)).sort();
    } catch {
        return entries;
    }
    for (const name of names.slice(0, 50)) {
        const target = path.join(directory, name);
        const info = await fs.stat(target).catch(() => null);
        if (!info || !info.isFile()) continue;
        const bytes = await fs.readFile(target);
        const entry = { path: name, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), bodyShape: null };
        if (name.endsWith('.json') && bytes.length < 200000) {
            try {
                entry.bodyShape = shapeOf(JSON.parse(bytes.toString('utf8')));
            } catch {
                entry.bodyShape = 'unparsable-json';
            }
        }
        entries.push(entry);
    }
    return entries;
}

function shapeOf(value, depth = 0) {
    if (depth > 3) return 'depth-limit';
    if (value === null) return 'null';
    if (Array.isArray(value)) {
        return { type: 'array', length: value.length, item: value.length ? shapeOf(value[0], depth + 1) : null };
    }
    if (typeof value === 'object') {
        const keys = {};
        for (const key of Object.keys(value).sort()) keys[key] = shapeOf(value[key], depth + 1);
        return { type: 'object', keys };
    }
    return typeof value;
}

const extensionKey = argumentValue('--extension', 'tavern-helper');
const extension = pinnedExtension(extensionKey);
const external = Boolean(process.env.PROBE_BASE_URL);
const dataRoot = path.resolve(argumentValue('--data-root') ?? await fs.mkdtemp(path.join(process.env.TEMP ?? '/tmp', 'gotavern-extension-probe-')));
const reportPath = path.resolve(argumentValue('--report', path.join(here, `extension-${extensionKey}-leg.json`)));

await fs.mkdir(dataRoot, { recursive: true });
const installed = await ensurePinnedExtensionInstalled(dataRoot, extension);
const described = await describeInstalledExtension(installed.extensionDirectory);

// The state the drive STARTS from, recorded so the comparison can refuse a pair
// of legs that did not begin identically. Two legs sharing one data root is the
// shared-state hazard: the first leg created <dataRoot>/_css/user.css, the second
// leg's server then served it, and the comparison reported a /css/user.css
// difference that was purely the order the legs ran in. Each leg must be given its
// own freshly prepared root with the same CONTENT.
async function dataRootFingerprint(root) {
    const countFiles = async directory => {
        let total = 0;
        for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch(() => [])) {
            if (entry.name === '.git') continue;
            total += entry.isDirectory() ? await countFiles(path.join(directory, entry.name)) : 1;
        }
        return total;
    };
    return {
        userCssPresent: await fs.stat(path.join(root, '_css', 'user.css')).then(() => true, () => false),
        userFiles: await countFiles(path.join(root, 'default-user')),
    };
}
const startingState = await dataRootFingerprint(dataRoot);

// The GoTavern leg builds and boots the binary itself, staged the way a RELEASE ships it.
//
// WHAT IS STAGED, AND WHY `public/` IS NOT — do not restore it:
//   * `tokenizers/` IS staged, and its absence is fatal here. `upstream/assets.go` embeds
//     public/default/generated/manifests only, and the runtime resolves tokenizer data from
//     <InstallRoot>/tokenizers on DISK. Without it every prompt takes the pinned fallback and is
//     estimated roughly 25% high while still answering, so the leg would measure a build no
//     release ships and would look fine doing it.
//   * `public/` is NOT staged. The release archive carries the binary, the launchers, the licence
//     files, `tokenizers/` and BUILD-INFO — and release.yml asserts it carries no `config.yaml`,
//     no `data/` and no `extensions`. `public/**` is EMBEDDED, and ARCHITECTURE.md 8.1 states the
//     frontend may be embedded "even when no physical `public/` source tree exists at runtime".
//     An earlier version of this probe copied `upstream/public` beside the binary and called that
//     the release layout. It is a layout NO USER HAS, and it did not merely add noise: startup
//     creates an EMPTY `public/scripts/extensions` on a release install, and
//     `/api/extensions/discover` lists `<InstallRoot>/public/scripts/extensions` from DISK with no
//     embedded fallback, so a staged tree answered 15 built-in extensions on a build whose real
//     install answers none. The discovery bug that the extensions-discovery lane fixes was
//     therefore INVISIBLE to this probe — the staged pair would have been green for the wrong
//     reason, which is the same defect class as the withdrawn artifact this probe replaced.
//     A build that needs a `public/` tree on disk is not the product we ship.
//
// The staged layout is recorded in the report's provenance so an artifact states which layout it
// measured instead of leaving that to the reader.
const port = await freePort();
let server = null;
let stagedLayout = null;
// The config file this leg was given, recorded so the comparison can refuse a pair that did not
// start from the same bytes. The pinned leg is seeded by run-against-pinned.mjs, which passes the
// record through the environment because it seeds BEFORE this script starts.
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
    // THE BINARY MUST LIVE IN THE INSTALL ROOT. gotavern start resolves InstallRoot as the
    // directory of the executable, so a binary left in the artifact directory would read
    // tokenizers/ and create its public/ directories THERE, and every file this probe stages into
    // <dataRoot> would be ignored while the report still claimed it was staged. So GOTAVERN_BINARY
    // is a SOURCE: it is copied into the install root exactly as a release archive places it.
    if (binarySetting) {
        await fs.copyFile(binarySetting, binary);
    }
    const tokenizerSource = path.join(repoRoot, 'upstream', 'tokenizers');
    if (!(await fs.stat(tokenizerSource).then(() => true, () => false))) {
        throw new Error(`tokenizer data missing at ${tokenizerSource}; every release archive ships it and a leg without it is not a release install`);
    }
    await fs.cp(tokenizerSource, path.join(dataRoot, 'tokenizers'), { recursive: true });
    stagedLayout = {
        installRootIsDataRoot: true,
        stagedTokenizers: true,
        stagedPublic: false,
        stagedPublicReason: 'the release archive ships no public/ tree; public/** is embedded and a staged tree hides a discovery defect',
        source: binarySetting ? 'GOTAVERN_BINARY (copied into the install root)' : 'go build ./cmd/gotavern',
    };
    // An explicit --configPath for BOTH legs, seeded from the pinned default: without it each
    // server resolves config.yaml against its own working directory, which is this checkout for
    // GoTavern and the pinned checkout for pinned — two different files deciding accounts on/off.
    legConfig = await seedLegConfig(dataRoot);
    server = spawn(binary, ['start', '--port', String(port), '--dataRoot', dataRoot, '--configPath', path.join(dataRoot, 'config.yaml')], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stdout.on('data', () => {});
    server.stderr.on('data', () => {});
}

const baseURL = process.env.PROBE_BASE_URL ?? `http://127.0.0.1:${port}`;
const extensionPrefix = `/scripts/extensions/third-party/${extension.name}/`;

const report = {
    schemaVersion: 1,
    question: `does the pinned frontend reach the same final state and make the same backend calls with ${extension.label} installed on GoTavern and on pinned?`,
    subject: external ? 'pinned' : 'gotavern',
    baseURL,
    provenance: {
        subject: external ? 'pinned' : 'gotavern',
        // The pre-drive state, so a comparison can refuse legs that did not start
        // identically rather than reporting the difference between them as a
        // product finding.
        startingState,
        // The layout this leg measured. The pinned leg serves its own checkout, so it has
        // none; the GoTavern leg states exactly what was staged beside the binary.
        layout: stagedLayout,
        // The same pinned default config on both legs; null only if a caller did not seed one.
        configFile: legConfig,
        extension: {
            key: extensionKey,
            label: extension.label,
            name: extension.name,
            repo: extension.repo,
            commit: extension.commit,
            installedRevision: installed.revision,
            installedNow: installed.installed,
            installSource: installed.source ?? null,
            remoteKind: installed.remote ?? 'remote',
            ...described,
        },
    },
    requests: [],
    extensionRequests: [],
    // The built-in list the page actually received, names and order included.
    discovery: null,
    // The extension's own written user data: presence/size/skeleton compared, digest classified.
    writtenUserFiles: null,
    // Anonymous vs authenticated, because a release install serves built-in extension assets
    // without a session and the account gate decides publicness by the EMBEDDED tree.
    authMix: null,
    extensionLoaded: false,
    console: [],
    pageErrors: [],
    httpFailures: [],
    reachedUserState: null,
    finalState: null,
    failure: null,
};

let discoveredExtensions = null;
let browser;
try {
    await waitForServer(`${baseURL}/version`);
    browser = await chromium.launch();
    const page = await browser.newPage();
    page.on('pageerror', error => report.pageErrors.push(String(error.message ?? error).slice(0, 300)));
    page.on('console', message => {
        report.console.push({ type: message.type(), text: String(message.text()).slice(0, 500) });
    });

    const pending = new Map();
    page.on('request', request => {
        const url = new URL(request.url());
        const entry = { method: request.method(), path: url.pathname + url.search, status: null, contentType: '', bodyLength: null, bodySha256: null, bodyShape: null, withCookie: Boolean(request.headers()['cookie']) };
        pending.set(request, entry);
        report.requests.push(entry);
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
            // The built-in extension LIST as the frontend received it: the names and their ORDER,
            // not only a count. A leg that discovered 15 different names, or the same 15 in a
            // different order, answers a different question than a count comparison does.
            if (new URL(response.url()).pathname === '/api/extensions/discover') {
                try {
                    discoveredExtensions = JSON.parse(bytes.toString('utf8'));
                } catch {
                    discoveredExtensions = 'unparsable-json';
                }
            }
        } catch {
            // A redirect or an aborted stream has no readable body.
        }
    });
    page.on('requestfailed', request => {
        report.httpFailures.push(`FAILED ${request.method()} ${new URL(request.url()).pathname}: ${request.failure()?.errorText ?? ''}`);
    });
    page.on('response', response => {
        if (response.status() >= 400) {
            report.httpFailures.push(`${response.status()} ${response.request().method()} ${new URL(response.url()).pathname}`);
        }
    });

    // domcontentloaded, not load: an optional stylesheet the server declines
    // (/css/user.css on a fresh install, which BOTH legs 404) is aborted by the
    // browser and can delay the load event indefinitely. The readiness signal that
    // matters is settingsReady, waited for explicitly below with its own guard.
    await page.goto(`${baseURL}/`, { waitUntil: 'domcontentloaded' });
    // The timeout is the THIRD argument: Playwright's signature is
    // (pageFunction, arg, options), so the { timeout } object in the second
    // position is silently taken as `arg` and the default 30 s applies. The
    // existing probes use the two-argument form, which is why 30 s is what this
    // drive gets; on a weak development machine that is not enough for a page
    // with an installed extension, and the failure reads as "the frontend never
    // finished" rather than as a harness timeout.
    await page.waitForFunction('document.getElementById("preloader") === null', null, { timeout: 120000 });

    report.reachedUserState = await page.evaluate(async () => {
        const result = { onboardingCompleted: false, settingsReady: false };
        const script = await import('./script.js');
        const started = performance.now();
        // getSettings() awaits the first-run onboarding popup, so settingsReady
        // never turns true until a user completes it (script.js:8041).
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

    // The extension's own script is fetched by the frontend once it is discovered.
    // Waiting for that request is what distinguishes "installed" from "loaded":
    // a manifest the frontend rejected produces no request at all, and promoting
    // a row on the strength of the directory existing would be the
    // "loaded" claim this probe exists to avoid.
    const extensionLoadDeadline = Date.now() + 30000;
    while (Date.now() < extensionLoadDeadline) {
        if (report.requests.some(entry => entry.path.startsWith(extensionPrefix) && entry.status !== null && entry.status < 400)) {
            report.extensionLoaded = true;
            break;
        }
        await new Promise(resolve => setTimeout(resolve, 250));
    }
    // Wait for the PAGE's OWN idle signal instead of a fixed sleep. A fixed 5 s settle is what made
    // four frontend assets differ between two otherwise identical drives: one leg was still fetching
    // a font when the other had finished, and the request-set difference then read like a server
    // difference. The page is idle when NO request has been issued for QUIET_MS and none is still
    // unresolved; the deadline only exists so a page that polls forever cannot hang the probe, and
    // the outcome is RECORDED so an artifact states how each drive ended instead of asserting it.
    // 2500 ms, not 750: LittleWhiteBox's startup chain has GAPS longer than three quarters of a
    // second (it finishes loading settings, then fires backgrounds/folders and chats/recent), and a
    // 750 ms threshold ended one leg inside such a gap -- which showed up as three API rows that
    // only one leg had requested, i.e. a timing artefact wearing a product difference's clothes.
    // The threshold is still the page's own signal, not a sleep: a fixed wait cannot know when the
    // chain ended, and this can.
    report.settle = await waitForNetworkQuiet(report.requests, 2500, 45000);

    report.extensionRequests = report.requests.filter(entry => entry.path.startsWith(extensionPrefix) || entry.path.startsWith('/api/'));
    report.finalState = await page.evaluate(async () => {
        const script = await import('./script.js');
        return {
            settingsReady: Boolean(script.settingsReady),
            title: document.title,
            extensionContainerCount: document.querySelectorAll('#extensions_settings2 .extension_container, #extensions_settings .extension_container').length,
            extensionSettingsPresent: Boolean(document.querySelector('#extensions_settings, #extensions_settings2')),
            characterListPresent: Boolean(document.querySelector('#rm_print_characters_block')),
            sendButtonPresent: Boolean(document.querySelector('#send_but')),
            quickReplyPresent: Boolean(document.querySelector('#quick_reply_bar')),
        };
    });

    report.discovery = discoveredExtensions;
    // Built-in extension assets are every /scripts/extensions/ path that is NOT the third-party
    // mount, which extensions_static.go owns separately. A release install serves these from the
    // embedded tree and must do it without a session, so the anonymous count is the observable.
    const isBuiltInExtensionAsset = entryPath => entryPath.startsWith('/scripts/extensions/')
        && !entryPath.startsWith('/scripts/extensions/third-party/');
    const summarizeAuth = entries => ({
        total: entries.length,
        withCookie: entries.filter(entry => entry.withCookie).length,
        withoutCookie: entries.filter(entry => !entry.withCookie).length,
        paths: entries.filter(entry => !entry.withCookie).map(entry => entry.path.split('?')[0]).slice(0, 40),
    });
    report.authMix = {
        builtInExtensionAssets: summarizeAuth(report.requests.filter(entry => isBuiltInExtensionAsset(entry.path.split('?')[0]))),
        api: summarizeAuth(report.requests.filter(entry => entry.path.startsWith('/api/'))),
        all: summarizeAuth(report.requests),
    };

    // WHAT THE EXTENSION WROTE. A user-data file the extension created through /api/files/upload is a
    // real observable, and the artifact must say how it is compared. Its BYTES are not comparable: the
    // content carries a per-run random transaction id (measured on LittleWhiteBox), so two runs of the
    // same server differ. Presence, size and the JSON skeleton are comparable, and the digest is
    // recorded with that reason rather than dropped.
    report.writtenUserFiles = await describeUserFiles(path.join(dataRoot, 'default-user', 'user', 'files'));

    if (!report.reachedUserState.settingsReady) {
        report.failure = 'settingsReady never became true: the page is not in a state a user can act from';
    } else if (!report.extensionLoaded) {
        report.failure = `no successful request under ${extensionPrefix} was observed: the frontend did not load the installed extension`;
    }
} catch (error) {
    report.failure = String(error.message ?? error);
} finally {
    if (browser) await browser.close();
    server?.kill();
}

await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({
    subject: report.provenance.subject,
    extension: report.provenance.extension.key,
    installedRevision: report.provenance.extension.installedRevision,
    failure: report.failure,
    settingsReady: report.reachedUserState?.settingsReady ?? false,
    extensionLoaded: report.extensionLoaded,
    requests: report.requests.length,
    extensionRequests: report.extensionRequests.length,
    finalState: report.finalState,
}, null, 2));
if (report.failure) process.exitCode = 1;
