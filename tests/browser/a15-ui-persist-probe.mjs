#!/usr/bin/env node
// A15 LANE D: FIVE EVIDENCE CLASSES ON THE ASSET/UI/PERSISTENCE SURFACES THAT HAD NO BROWSER EVIDENCE.
//
// THE PROBLEM THIS FILE EXISTS FOR. Browser evidence has repeatedly let one observation stand in for a different
// claim: an HTTP 200 for "the picture decoded", `naturalWidth > 0` for "a user can see it", a file on disk for "the
// frontend re-read it", a request for "the state was saved". The lane brief names five classes and forbids the
// substitution:
//
//   1 LOAD     the resource was requested and answered (status, content-type, bytes);
//   2 EXECUTE  the frontend's own code ran in a real browser (handlers fired, models populated, DOM updated);
//   3 PAINT    the user can actually see it (decoded AND non-zero box AND inside the viewport AND not invisible);
//   4 REQUEST  the provider request actually changed -- or, on surfaces that must not talk to a provider, that NO
//              provider request happened. This probe records class 4 as NOT APPLICABLE with its reason and asserts
//              the absence, so "no provider evidence" is a stated fact rather than an omission;
//   5 PERSIST  the data was saved and survives a reload AND a new server process reading the same tree.
//
// The surfaces covered here had NO browser assertion before this probe:
//   * THE OPENED CARD IMAGE. The asset probe asserts list avatars and chat avatars; the character editor's own
//     full-size image (`#avatar_load_preview`) had nothing, so class 1 (the file is served) could have stood in
//     for class 2 (the editor opened and populated) and class 3 (the picture is on screen).
//   * MOVING UI. `grep -l moving_ui tests/browser/*probe*.mjs` was EMPTY: a pinned user-facing feature (apply a
//     MovingUI preset -> inline styles on movable panels, state in `power_user.movingUIState`, saved into the
//     settings file) had zero browser evidence. This probe drives the frontend's own <select>, asserts the handler
//     changed the page, asserts the settings file on disk, then asserts a FRESH PAGE and a NEW PROCESS re-apply it.
//
// DELIBERATELY NOT CLAIMED HERE: chat-message RESUME across a restart is covered by `whole-session-probe.mjs` and
// `q20-persistence-*`; this probe's restart phase covers the state THIS probe wrote (MovingUI preset + staged card
// avatar) and records that boundary in `restartCovered` rather than implying more.
//
// USAGE (two phases per subject, the same phase-split pattern whole-session uses):
//   # GoTavern leg self-boots; restart is a second invocation on the SAME tree
//   node tests/browser/a15-ui-persist-probe.mjs --phase drive   --data-root <gv> --stage --report gv-drive.json
//   node tests/browser/a15-ui-persist-probe.mjs --phase restart --data-root <gv>            --report gv-restart.json
//   # pinned leg: the wrapper owns the server, so pass --data-root to BOTH the wrapper and the child
//   node tests/browser/run-against-pinned.mjs a15-ui-persist-probe.mjs --data-root <pn> -- \
//       --phase drive --stage --data-root <pn> --report pn-drive.json
//   node tests/browser/run-against-pinned.mjs a15-ui-persist-probe.mjs --data-root <pn> -- \
//       --phase restart --data-root <pn> --report pn-restart.json
//   # differential
//   node tests/browser/a15-ui-persist-probe.mjs --assert gv-drive.json gv-restart.json pn-drive.json pn-restart.json
//
// EXIT STATUS: 0 every check passed; 1 a named check failed; 2 usage; 3 probe-faithfulness alarm (a check failed
// and NO request/console/pageerror names a cause -- AGENTS.md rule 10).

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

import { allocatePort, releasePort, waitForIdentity } from './port-lease.mjs';
import { seedLegConfig } from './seed-leg-config.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

function argumentValue(name, fallback = null) {
    const index = process.argv.indexOf(name);
    if (index < 0) return fallback;
    return process.argv[index + 1] ?? fallback;
}
const flag = name => process.argv.includes(name);

const PRESET_NAME = 'A15 Probe Preset';
const PRESET_FILE = `${PRESET_NAME}.json`;
const PRESET_LEFT = '123px';
const PRESET_STATE = { chat: { left: PRESET_LEFT, top: '77px', width: '641px' } };
const CARD_NAME = 'A15 Card';
const CARD_FILE = `${CARD_NAME}.png`;
const USER_HANDLE = 'default-user';

// ===============================================================================================================
// ASSERT MODE: the differential half. Both subjects are driven by the SAME script; a green pair means agreement.
// ===============================================================================================================
if (flag('--assert')) {
    const reports = process.argv.slice(process.argv.indexOf('--assert') + 1);
    if (reports.length !== 4) {
        console.error('usage: a15-ui-persist-probe.mjs --assert <gotavern-drive.json> <gotavern-restart.json> <pinned-drive.json> <pinned-restart.json>');
        process.exit(2);
    }
    const load = async file => JSON.parse(await fs.readFile(path.resolve(file), 'utf8'));
    const [gvDrive, gvRestart, pnDrive, pnRestart] = await Promise.all(reports.map(load));
    const guards = {};
    const problems = [];
    const requireGuard = (id, condition, detail) => {
        guards[id] = Boolean(condition);
        if (!condition) problems.push(`${id}: ${detail}`);
    };
    for (const [subject, drive, restart] of [['gotavern', gvDrive, gvRestart], ['pinned', pnDrive, pnRestart]]) {
        requireGuard(`${subject}.probeCompleted`, drive.failure == null && restart.failure == null, `probe failed: ${JSON.stringify(drive.failure ?? restart.failure)}`);
        for (const item of [...(drive.checks ?? []), ...(restart.checks ?? [])]) {
            requireGuard(`${subject}.${item.id}`, item.passed === true, `${item.evidenceClass ? `class ${item.evidenceClass} ` : ''}${item.detail ?? 'failed'}`);
        }
    }
    const compareField = (id, extractor, why) => {
        const gv = extractor(gvDrive);
        const pn = extractor(pnDrive);
        requireGuard(id, JSON.stringify(gv) === JSON.stringify(pn), `${why} (gotavern=${JSON.stringify(gv)}, pinned=${JSON.stringify(pn)})`);
    };
    compareField('cardImageSrcPathEqual', r => r.cardPanel?.image?.srcPath, 'the opened card image src path differs across subjects');
    compareField('cardImageVisibleEqual', r => r.cardPanel?.image?.visible, 'the opened card image visibility differs across subjects');
    compareField('cardPanelNameEqual', r => r.cardPanel?.nameField, 'the character editor name field differs across subjects');
    compareField('messageGreetingTextEqual', r => r.messageAvatar?.messageText, 'the rendered greeting text differs across subjects');
    compareField('messageAvatarVisibleEqual', r => r.messageAvatar?.image?.visible, 'the chat-message avatar visibility differs across subjects');
    compareField('movingUIPresetListedEqual', r => (r.movingUI?.presetOptions ?? []).includes(PRESET_NAME), 'the staged MovingUI preset is not listed on both subjects');
    compareField('movingUIAppliedInlineEqual', r => r.movingUI?.afterApply?.inlineStyle, 'the applied inline style differs across subjects');
    compareField('movingUIAppliedComputedEqual', r => r.movingUI?.afterApply?.computedLeft, 'the applied computed left differs across subjects');
    compareField('movingUISavedToDiskEqual', r => r.movingUI?.savedOnDisk?.state?.chat?.left, 'the persisted settings file differs across subjects');
    compareField('movingUIAppliedAfterReloadEqual', r => r.movingUI?.afterReload?.computedLeft, 'the reloaded page differs across subjects');
    requireGuard('noProviderRequestOnEitherLeg',
        (gvDrive.recorders?.providerRequests ?? []).length === 0 && (pnDrive.recorders?.providerRequests ?? []).length === 0,
        `a UI-only surface reached a provider: gotavern=${JSON.stringify(gvDrive.recorders?.providerRequests)}, pinned=${JSON.stringify(pnDrive.recorders?.providerRequests)}`);
    const restartSides = [['gotavern', gvRestart], ['pinned', pnRestart]];
    requireGuard('restartPhaseAppliedPresetOnBothLegs',
        restartSides.every(([, report]) => report.restart?.movingUIAppliedWithoutUserAction === true),
        `a new server process did not re-apply the MovingUI state: ${restartSides.map(([name, report]) => `${name}=${report.restart?.movingUIAppliedWithoutUserAction}`).join(', ')}`);
    requireGuard('restartPhasePaintedCardAvatarOnBothLegs',
        restartSides.every(([, report]) => report.restart?.cardAvatar?.visible === true),
        `a new server process did not paint the staged card avatar: ${restartSides.map(([name, report]) => `${name}=${JSON.stringify(report.restart?.cardAvatar)}`).join(', ')}`);
    requireGuard('class1NeverSubstitutedForClass3OnEitherLeg',
        [...(gvDrive.checks ?? []), ...(pnDrive.checks ?? [])].every(item => item.id !== 'noLoadedButUnpaintedSurfaces' || item.passed === true),
        'a surface loaded but a user could not see it on at least one leg');
    const artifact = {
        schema: 'a15-ui-persist-comparison/1',
        guards,
        problems,
        failedGuards: Object.entries(guards).filter(([, value]) => !value).map(([id]) => id),
        reports: reports.map(file => path.basename(file)),
    };
    const artifactPath = path.resolve(argumentValue('--out', path.join(here, 'a15-ui-persist-comparison.json')));
    await fs.writeFile(artifactPath, JSON.stringify(artifact, null, 2) + '\n', 'utf8');
    if (problems.length > 0) {
        console.error(`A15 ui/persist differential FAILED, ${problems.length} problem(s):`);
        for (const problem of problems.slice(0, 12)) console.error(`  - ${problem}`);
        process.exit(1);
    }
    console.log(`A15 ui/persist differential: OK (${path.basename(artifactPath)}; guards=${Object.keys(guards).length})`);
    process.exit(0);
}

// ===============================================================================================================
// PROBE MODE.
// ===============================================================================================================
const phase = argumentValue('--phase', 'drive');
if (!['drive', 'restart'].includes(phase)) {
    console.error(`a15-ui-persist-probe: --phase must be drive or restart, not ${JSON.stringify(phase)}`);
    process.exit(2);
}
const external = Boolean(process.env.PROBE_BASE_URL);
const subject = external ? 'pinned' : 'gotavern';
const dataRootArgument = argumentValue('--data-root');
if (phase === 'restart' && !dataRootArgument) {
    console.error('a15-ui-persist-probe: --phase restart requires the SAME --data-root the drive phase used');
    process.exit(2);
}
const dataRoot = path.resolve(dataRootArgument ?? await fs.mkdtemp(path.join(process.env.TEMP ?? '/tmp', 'gotavern-a15-ui-')));
const reportPath = path.resolve(argumentValue('--report', path.join(here, `a15-ui-${subject}-${phase}.json`)));
const stage = flag('--stage') || phase === 'drive';

const checks = [];
function check({ id, evidenceClass, passed, detail, request = null, selector = null, expected = null, observed = null }) {
    checks.push({ id, evidenceClass, passed: Boolean(passed), detail, request, selector, expected, observed });
    return Boolean(passed);
}
const recorder = { console: [], pageErrors: [], failedRequests: [], imageRequests: [], providerRequests: [], settingsSaveRequests: [] };
const report = {
    schema: 'a15-ui-persist/1',
    subject,
    phase,
    baseURL: null,
    dataRoot,
    staged: [],
    fixture: { card: { file: CARD_FILE, firstMes: 'A15_UI_GREETING hello' }, movingUI: { name: PRESET_NAME, file: PRESET_FILE, state: PRESET_STATE } },
    checks,
    recorders: recorder,
    restartCovered: phase === 'drive'
        ? { byThisProbe: 'MovingUI preset re-application and staged-card avatar paint after a NEW process reads the same tree (phase restart)', notCovered: 'chat-message resume across restart (covered by whole-session-probe.mjs / q20-persistence-*)' }
        : undefined,
    failure: null,
};

// ---- PNG card, built here (same technique as asset-probe.mjs: a PNG card is the pinned card format) ----------
const CRC_TABLE = (() => {
    const table = new Int32Array(256);
    for (let index = 0; index < 256; index++) {
        let value = index;
        for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
        table[index] = value;
    }
    return table;
})();
function crc32(buffer) {
    let crc = -1;
    for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
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
function buildPng(textChunks) {
    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(96, 0); ihdr.writeUInt32BE(96, 4); ihdr[8] = 8; ihdr[9] = 6;
    const raw = Buffer.alloc(96 * (1 + 96 * 4));
    for (let y = 0; y < 96; y++) {
        const row = y * (1 + 96 * 4);
        raw[row] = 0;
        for (let x = 0; x < 96; x++) {
            const at = row + 1 + x * 4;
            raw[at] = 40 + ((x * 3) % 200); raw[at + 1] = 20 + ((y * 5) % 200); raw[at + 2] = 160; raw[at + 3] = 255;
        }
    }
    const chunks = [signature, pngChunk('IHDR', ihdr)];
    for (const [keyword, text] of textChunks) chunks.push(pngChunk('tEXt', Buffer.concat([Buffer.from(keyword, 'latin1'), Buffer.from([0]), Buffer.from(text, 'latin1')])));
    chunks.push(pngChunk('IDAT', zlib.deflateSync(raw, { level: 0 })), pngChunk('IEND', Buffer.alloc(0)));
    return Buffer.concat(chunks);
}
const CARD_DATA = {
    name: CARD_NAME,
    description: 'A15_UI_CARD a card whose only job is to be opened in the character editor.',
    personality: 'A15_UI_CARD',
    first_mes: 'A15_UI_GREETING hello',
    mes_example: '',
    talkativeness: '0.5',
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
        name: CARD_NAME,
        description: 'A15_UI_CARD a card whose only job is to be opened in the character editor.',
        personality: 'A15_UI_CARD',
        first_mes: 'A15_UI_GREETING hello',
        mes_example: '',
        creator_notes: '',
        system_prompt: '',
        post_history_instructions: '',
        alternate_greetings: [],
        tags: [],
        creator: 'gotavern-a15-lane-d',
        character_version: '1',
        extensions: {},
    },
};

async function stageFixture() {
    const files = [
        // A15_CARD_PNG lets a diagnostic run substitute a known-good card image byte-for-byte; production path builds the PNG above.
        { relative: path.join(USER_HANDLE, 'characters', CARD_FILE), bytes: process.env.A15_CARD_PNG ? await fs.readFile(process.env.A15_CARD_PNG) : buildPng([['chara', Buffer.from(JSON.stringify(CARD_DATA), 'utf8').toString('base64')]]) },
        { relative: path.join(USER_HANDLE, 'movingUI', PRESET_FILE), bytes: Buffer.from(JSON.stringify({ name: PRESET_NAME, movingUIState: PRESET_STATE }, null, 4), 'utf8') },
    ];
    const staged = [];
    for (const file of files) {
        const target = path.join(dataRoot, file.relative);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, file.bytes);
        staged.push({ relative: file.relative.split(path.sep).join('/'), byteLength: file.bytes.length, sha256: createHash('sha256').update(file.bytes).digest('hex') });
    }
    return staged.sort((left, right) => left.relative.localeCompare(right.relative));
}
// Page-side helpers are INSTALLED into the page, not serialised closures: each is a plain function passed to
// page.evaluate, so it must be self-contained (PAGE-CONTEXT.md rule 1). Nothing host-side leaks into them.
const VISIBILITY_FN = `
(image) => {
    if (!image) return { decoded: false, visible: false, reason: 'no image element' };
    const rect = image.getBoundingClientRect();
    const style = getComputedStyle(image);
    const onScreen = rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth;
    const painted = style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0.05;
    return {
        decoded: image.complete === true && image.naturalWidth > 0,
        visible: onScreen && painted,
        box: { width: Math.round(rect.width), height: Math.round(rect.height), top: Math.round(rect.top), left: Math.round(rect.left) },
        naturalWidth: image.naturalWidth,
        naturalHeight: image.naturalHeight,
        reason: !image.complete ? 'not complete' : image.naturalWidth === 0 ? 'naturalWidth 0' : !onScreen ? 'zero area or outside viewport' : !painted ? 'hidden or transparent' : null
    };
}`;

let server = null;
let browser = null;

// NO ORPHANED BROWSERS OR SERVERS. If this process is interrupted (Ctrl+C, SIGTERM, an uncaught signal), the
// browser and the self-spawned server are killed before exit; the normal and error paths already do it in
// `finally`. Playwright's browser is a child process, so leaving it behind would outlive the probe.
const shutdown = signal => {
    try { if (browser) browser.close().catch(() => {}); } catch { /* already gone */ }
    try { if (server) server.kill('SIGKILL'); } catch { /* already dead */ }
    process.exitCode = signal === 'SIGINT' ? 130 : 143;
};
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
let port = 0;
let exitCode = 1;

async function waitForServer(url, deadlineMs) {
    const until = Date.now() + deadlineMs;
    let last = null;
    while (Date.now() < until) {
        try {
            const response = await fetch(`${url}/version`, { signal: AbortSignal.timeout(5000) });
            if (response.status === 200) return JSON.parse(await response.text());
            last = `status ${response.status}`;
        } catch (error) { last = String(error?.message ?? error); }
        await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error(`the subject never answered ${url}/version within ${deadlineMs} ms (last: ${last})`);
}

try {
    // STAGE BEFORE BOOT on the GoTavern leg (this probe owns the server). On the pinned leg the wrapper boots
    // first, so the same files are staged after boot; the character list and the MovingUI preset list are read per
    // request by pinned's own routes, and the report records the order so a reader is not left to assume it.
    if (stage && !external) report.staged = await stageFixture();

    let baseURL = process.env.PROBE_BASE_URL ?? null;
    let version = null;
    if (!external) {
        const binarySetting = process.env.GOTAVERN_BINARY ?? '';
        const binary = binarySetting ? path.resolve(binarySetting) : path.join(dataRoot, process.platform === 'win32' ? 'gotavern.exe' : 'gotavern');
        if (!binarySetting) {
            const build = spawn('go', ['build', '-trimpath', '-o', binary, './cmd/gotavern'], { cwd: repoRoot, stdio: 'inherit' });
            if (await new Promise(resolve => build.on('exit', resolve)) !== 0) throw new Error('go build ./cmd/gotavern failed');
        } else {
            await fs.copyFile(binarySetting, binary);
        }
        await fs.cp(path.join(repoRoot, 'upstream', 'tokenizers'), path.join(dataRoot, 'tokenizers'), { recursive: true });
        const legConfig = await seedLegConfig(dataRoot);
        report.legConfig = { path: legConfig.path, sha256: legConfig.sha256 };
        // BOUNDED BOOT WITH IDENTITY, AND RETRY ON A LOST PORT RACE. Two lanes share this host, so a port chosen,
        // probed and closed can be taken by the other lane's server before this child binds (port-lease.mjs records
        // the measured defect). The retry re-allocates a port and requires the LISTENER PID to be THIS child, so a
        // page driven from the wrong process is impossible; three bounded attempts then a named failure.
        let lastBootError = null;
        for (let attempt = 1; attempt <= 3; attempt++) {
            port = await allocatePort();
            const logTail = [];
            server = spawn(binary, ['start', '--port', String(port), '--dataRoot', dataRoot, '--configPath', path.join(dataRoot, 'config.yaml'), '--browserLaunchEnabled', 'false'], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
            server.stdout.on('data', chunk => { logTail.push(chunk.toString()); while (logTail.length > 200) logTail.shift(); });
            server.stderr.on('data', chunk => { logTail.push(chunk.toString()); while (logTail.length > 200) logTail.shift(); });
            try {
                const identity = await waitForIdentity({ baseURL: `http://127.0.0.1:${port}`, port, childAlive: () => server !== null && server.exitCode === null, childPid: server.pid, expectedPkgVersion: '1.19.0', deadlineMs: Number(process.env.A15_READY_MS ?? 90000), logTail: () => logTail.join('') });
                version = identity.version;
                baseURL = `http://127.0.0.1:${port}`;
                report.server = { pid: server.pid, identity: identity.identityMethod, listenerPid: identity.listenerPid, pkgVersion: version?.pkgVersion ?? null, bootAttempt: attempt };
                lastBootError = null;
                break;
            } catch (error) {
                lastBootError = error;
                try { server.kill('SIGKILL'); } catch { /* already dead */ }
                if (port) releasePort(port);
                server = null;
                port = 0;
            }
        }
        if (lastBootError) throw new Error(`the GoTavern server could not be booted as the listener within three bounded attempts: ${String(lastBootError?.message ?? lastBootError).slice(0, 600)}`);
    } else {
        baseURL = process.env.PROBE_BASE_URL;
        version = await waitForServer(baseURL, Number(process.env.A15_READY_MS ?? 90000));
        report.server = { pid: Number(process.env.PROBE_SERVER_PID ?? 0) || null, identity: 'wrapper-owned', pkgVersion: version?.pkgVersion ?? null };
    }
    report.baseURL = baseURL;
    if (stage && external) report.staged = await stageFixture();

    const playwrightModule = await import('@playwright/test');
    const chromium = playwrightModule.chromium ?? playwrightModule.default?.chromium;
    browser = await chromium.launch({ headless: true });
    browser.on('disconnected', () => { report.recorders.browserDisconnected = true; });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    // EVERY browser step is bounded, so a hung page fails by the name of the step rather than pinning the host.
    page.setDefaultTimeout(Number(process.env.A15_STEP_MS ?? 20000));
    page.setDefaultNavigationTimeout(Number(process.env.A15_GOTO_MS ?? 60000));
    // NO LIVE EGRESS FROM THE PAGE. Every request that is not the subject's own origin is aborted and recorded;
    // the checks below require the list to be empty. This is the same rule the differential doctrine applies to
    // probes: a request that escapes must appear as a failure, never as plausible data.
    const blockedEgress = [];
    await page.route('**/*', route => {
        const url = route.request().url();
        let hostname = '';
        try { hostname = new URL(url).hostname; } catch { hostname = ''; }
        if (hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]') {
            return route.continue();
        }
        blockedEgress.push({ url, method: route.request().method() });
        // OBSERVED, NOT ABORTED (yet). Aborting every external request measurably breaks pinned frontend init
        // (an extension activation stalls and `settingsReady` never becomes true), which would substitute a
        // harness-caused failure for a product observation. The dangerous dependency found by this lane is the
        // HORDE fetch at init, and that is removed by the staged `main_api: openai`; any other external request is
        // recorded as an isolation finding and asserted below.
        return route.continue();
    });
    recorder.blockedEgress = blockedEgress;
    page.on('console', message => { if (recorder.console.length < 400) recorder.console.push({ type: message.type(), text: message.text().slice(0, 400) }); });
    page.on('pageerror', error => recorder.pageErrors.push(String(error?.message ?? error).slice(0, 400)));
    page.on('requestfailed', request => recorder.failedRequests.push({ url: request.url(), method: request.method(), failure: request.failure()?.errorText ?? null }));
    page.on('response', async response => {
        const url = response.url();
        if (/\/(thumbnail|characters|User%20Avatars|backgrounds)\//.test(url) || /\/(thumbnail|backgrounds|sprites)\?/.test(url)) {
            try {
                const body = await response.body();
                recorder.imageRequests.push({ url, status: response.status(), contentType: response.headers()['content-type'] ?? null, byteLength: body.length });
            } catch { recorder.imageRequests.push({ url, status: response.status(), contentType: response.headers()['content-type'] ?? null, byteLength: null }); }
        }
    });
    page.on('request', request => {
        const url = request.url();
        if (/\/api\/backends\/(chat|text)-completions\/generate|\/api\/(novelai|minimax|kobold)\/generate|\/v1\/(chat\/)?completions|\/api\/google\/|generativelanguage\.googleapis|api\.openai\.com|anthropic\.com/i.test(url)) recorder.providerRequests.push({ url, method: request.method() });
        if (/\/api\/settings\/save/.test(url)) {
            const body = request.postData() ?? '';
            recorder.settingsSaveRequests.push({ url, method: request.method(), bodyLength: body.length, hasMovingUIState: body.includes('movingUIState'), hasPresetName: body.includes(PRESET_NAME) });
        }
    });

    const waitFor = async (fn, label, deadlineMs, arg = null) => {
        const until = Date.now() + deadlineMs;
        let last = null;
        while (Date.now() < until) {
            try {
                last = await page.evaluate(fn, arg);
                if (last) return last;
            } catch (error) { last = { error: String(error?.message ?? error) }; }
            await new Promise(resolve => setTimeout(resolve, 150));
        }
        return last;
    };

    await page.goto(`${baseURL}/`, { waitUntil: 'domcontentloaded', timeout: Number(process.env.A15_GOTO_MS ?? 60000) });
    await page.waitForSelector('#rm_print_characters_block .avatar[data-type="character"]', { timeout: Number(process.env.A15_LIST_MS ?? 60000) }).catch(() => null);
    await page.waitForLoadState('networkidle', { timeout: 25000 }).catch(() => null);

    // ===========================================================================================================
    // RESTART PHASE: class 5 only. A NEW process over the SAME tree, a fresh page, no user action.
    // ===========================================================================================================
    if (phase === 'restart') {
        const applied = await waitFor(() => {
            const chat = document.querySelector('#chat');
            return chat ? getComputedStyle(chat).left : null;
        }, 'restart applied left', Number(process.env.A15_RESTART_MS ?? 45000));
        const detail = await page.evaluate(`(${VISIBILITY_FN})(document.querySelector('#rm_print_characters_block .avatar[data-type="character"] img'))`).catch(() => null);
        const state = await page.evaluate(() => {
            const chat = document.querySelector('#chat');
            const rows = [...document.querySelectorAll('#rm_print_characters_block .avatar[data-type="character"] img')];
            return {
                rowCount: document.querySelectorAll('#rm_print_characters_block .avatar[data-type="character"]').length,
                chatInline: chat ? `${chat.style.left}|${chat.style.top}|${chat.style.width}` : null,
                computedLeft: chat ? getComputedStyle(chat).left : null,
                presetOptionPresent: [...document.querySelectorAll('#movingUIPresets option')].some(option => option.value === 'A15 Probe Preset'),
                firstAvatarSrc: rows[0]?.getAttribute('src') ?? null,
            };
        });
        report.restart = {
            movingUIAppliedWithoutUserAction: state.computedLeft === PRESET_LEFT || String(state.chatInline ?? '').startsWith(`${PRESET_LEFT}|`),
            cardAvatar: detail ? { src: state.firstAvatarSrc, decoded: detail.decoded, visible: detail.visible, box: detail.box, reason: detail.reason } : null,
            rowCount: state.rowCount,
            presetOptionPresent: state.presetOptionPresent,
            observed: state,
        };
        check({ id: 'restart.newProcessReadTheTree', evidenceClass: 5, passed: state.rowCount > 0, detail: `a fresh page on a NEW server process saw no staged character (rowCount=${state.rowCount})`, selector: '#rm_print_characters_block', expected: '>0 rows', observed: state.rowCount });
        check({ id: 'restart.movingUIAppliedWithoutUserAction', evidenceClass: 5, passed: report.restart.movingUIAppliedWithoutUserAction === true, detail: `the MovingUI state (chat.left=${PRESET_LEFT}) was not re-applied by a new process (computed=${JSON.stringify(state.computedLeft)}, inline=${JSON.stringify(state.chatInline)})`, selector: '#chat', expected: PRESET_LEFT, observed: state.computedLeft });
        check({ id: 'restart.cardAvatarPainted', evidenceClass: 3, passed: report.restart.cardAvatar?.visible === true, detail: `the staged card avatar was not painted after restart (${JSON.stringify(report.restart.cardAvatar)})`, selector: '#rm_print_characters_block .avatar img', observed: report.restart.cardAvatar });
        check({ id: 'restart.movingUIPresetListed', evidenceClass: 1, passed: state.presetOptionPresent, detail: 'the staged MovingUI preset was not listed by the new process, so a page could not apply it', selector: '#movingUIPresets option', observed: state.presetOptionPresent });
        check({ id: 'noLiveEgress', evidenceClass: 4, passed: blockedEgress.length === 0, detail: `the page attempted non-local requests, which a probe must never allow: ${JSON.stringify(blockedEgress.slice(0, 5))}`, selector: 'network', observed: blockedEgress });
        exitCode = checks.every(item => item.passed) ? 0 : 1;
    } else {
        // ---- 0. PROBE FAITHFULNESS BEFORE ANY PRODUCT CLAIM ------------------------------------------------
        // AGENTS.md rule 10: a `false` with no named failing request is a HARNESS alarm. The probe measures the
        // character list as the precondition of every drive below. If the API served characters but the page
        // rendered none, the drive cannot say anything about the product, so this names the missing half and
        // stops instead of reporting five card failures that all reduce to one harness cause.
        const renderedRows = await page.evaluate(() => document.querySelectorAll('#rm_print_characters_block .avatar[data-type="character"]').length).catch(() => -1);
        if (renderedRows <= 0) {
            const served = await page.evaluate(async () => {
                try {
                    const ctx = window.SillyTavern?.getContext?.();
                    const headers = ctx ? ctx.getRequestHeaders() : { 'Content-Type': 'application/json' };
                    const response = await fetch('/api/characters/all', { method: 'POST', headers });
                    const payload = await response.json();
                    return { status: response.status, count: Array.isArray(payload) ? payload.length : null, names: Array.isArray(payload) ? payload.slice(0, 5).map(entry => entry?.name ?? null) : null };
                } catch (error) { return { error: String(error?.message ?? error) }; }
            }).catch(error => ({ error: String(error?.message ?? error) }));
            report.faithfulness = { alarm: true, renderedRows, servedByApi: served, openConsole: recorder.console.slice(-10) };
            check({ id: 'characterListRenderedPrecondition', evidenceClass: 2, passed: false, detail: `HARNESS FAITHFULNESS: the page rendered ${renderedRows} character row(s) although /api/characters/all answered ${JSON.stringify(served)}; every card/UI check below would fail from this one harness cause, so they are not product findings`, selector: '#rm_print_characters_block', observed: { renderedRows, served } });
            throw Object.assign(new Error(`harness-faithfulness: character list rendered ${renderedRows} row(s) but the characters API served ${JSON.stringify(served).slice(0, 300)}`), { reported: true, faithfulness: true });
        }
        check({ id: 'characterListRenderedPrecondition', evidenceClass: 2, passed: true, detail: `the page rendered ${renderedRows} character row(s), so the drives below have a subject`, selector: '#rm_print_characters_block', observed: renderedRows });
        // =======================================================================================================
        // DRIVE PHASE.
        // =======================================================================================================
        // ---- 1. open the staged character (a real click on the row a user clicks) ----------------------------
        const clickResult = await page.evaluate(`(() => {
            const cardName = ${JSON.stringify(CARD_NAME)};
            const nodes = [...document.querySelectorAll('#rm_print_characters_block .character_select, #rm_print_characters_block .avatar[data-chid]')];
            const row = nodes.find(node => node.textContent.includes(cardName)) ?? null;
            const target = row ?? nodes[0] ?? null;
            if (!target) return { found: false, rows: nodes.length };
            (target.querySelector('.avatar') ?? target).click();
            return { found: true, matchedByName: row !== null, rows: nodes.length };
        })()`);
        check({ id: 'cardRowFound', evidenceClass: 2, passed: clickResult.found === true && clickResult.matchedByName === true, detail: `no character row matched the staged card name ${JSON.stringify(CARD_NAME)} (rows=${clickResult.rows}, matchedByName=${clickResult.matchedByName})`, selector: '#rm_print_characters_block', observed: clickResult });

        const message = await waitFor(`(() => {
            const nodes = [...document.querySelectorAll('.mes')];
            const last = nodes[nodes.length - 1];
            const text = last?.querySelector('.mes_text')?.innerText ?? '';
            const image = last?.querySelector('.mesAvatarWrapper .avatar img') ?? null;
            if (!image || !text) return null;
            const visibility = (${VISIBILITY_FN})(image);
            return {
                messageCount: nodes.length,
                text,
                image: { src: image.getAttribute('src'), decoded: visibility.decoded, visible: visibility.visible, box: visibility.box, naturalWidth: visibility.naturalWidth, naturalHeight: visibility.naturalHeight, reason: visibility.reason }
            };
        })()`, 'chat message + avatar', Number(process.env.A15_MESSAGE_MS ?? 45000));
        report.messageAvatar = message;
        report.messageAvatarCheck = { selector: '.mes .mesMessageWrapper .avatar img' };
        check({ id: 'chatOpenedAndGreetingRendered', evidenceClass: 2, passed: Boolean(message?.text) && (message?.messageCount ?? 0) > 0, detail: `clicking the staged card did not open a chat with the card's greeting in the DOM (messageCount=${message?.messageCount}, text=${JSON.stringify(message?.text ?? null)})`, selector: '.mes .mes_text', observed: message?.text ?? null });
        check({ id: 'messageAvatarDecoded', evidenceClass: 1, passed: message?.image?.decoded === true, detail: `the chat-message avatar did not decode (${JSON.stringify(message?.image ?? null)})`, selector: '.mes .mesAvatarWrapper .avatar img', observed: message?.image ?? null });
        check({ id: 'messageAvatarVisible', evidenceClass: 3, passed: message?.image?.visible === true, detail: `the chat-message avatar decoded but a user could not see it (${JSON.stringify(message?.image ?? null)})`, selector: '.mes .mesAvatarWrapper .avatar img', observed: message?.image ?? null });

        // ---- 2. OPEN THE CARD: click the same row again -> character editor (pinned switchMenu behaviour) ----
        const secondClick = await page.evaluate(`(() => {
            const cardName = ${JSON.stringify(CARD_NAME)};
            const nodes = [...document.querySelectorAll('#rm_print_characters_block .character_select, #rm_print_characters_block .avatar[data-chid]')];
            const row = nodes.find(node => node.textContent.includes(cardName)) ?? null;
            if (!row) return false;
            (row.querySelector('.avatar') ?? row).click();
            return true;
        })()`);
        const cardPanel = await waitFor(`(() => {
            const panel = document.querySelector('#rm_ch_create_block');
            const image = document.querySelector('#avatar_load_preview');
            const open = Boolean(panel) && panel.offsetParent !== null;
            const visibility = image ? (${VISIBILITY_FN})(image) : null;
            if (!open || !visibility?.decoded) return null;
            return {
                editorOpen: open,
                nameField: document.querySelector('#character_name_pole')?.value ?? null,
                image: { src: image.getAttribute('src'), resolvedSrc: image.currentSrc || image.src, decoded: visibility.decoded, visible: visibility.visible, box: visibility.box, naturalWidth: visibility.naturalWidth, naturalHeight: visibility.naturalHeight, reason: visibility.reason }
            };
        })()`, 'character editor + card image', Number(process.env.A15_EDITOR_MS ?? 45000));
        if (cardPanel?.image?.resolvedSrc) cardPanel.image.srcPath = (() => { try { return new URL(cardPanel.image.resolvedSrc).pathname; } catch { return cardPanel.image.resolvedSrc; } })();
        report.cardPanel = cardPanel;
        const cardRequest = recorder.imageRequests.find(entry => cardPanel?.image?.srcPath && entry.url.includes(cardPanel.image.srcPath));
        report.cardPanelImageRequest = cardRequest ?? null;
        check({ id: 'cardEditorOpenedBySecondClick', evidenceClass: 2, passed: secondClick === true && cardPanel?.editorOpen === true, detail: `clicking the selected character row did not open the character editor (secondClick=${secondClick}, editorOpen=${cardPanel?.editorOpen})`, selector: '#rm_ch_create_block', observed: cardPanel?.editorOpen ?? false });
        check({ id: 'cardEditorPopulatedWithTheStagedCard', evidenceClass: 2, passed: cardPanel?.nameField === CARD_NAME, detail: `the editor's name field is ${JSON.stringify(cardPanel?.nameField)}, not the staged ${JSON.stringify(CARD_NAME)}: the editor opened but did not load this card`, selector: '#character_name_pole', expected: CARD_NAME, observed: cardPanel?.nameField ?? null });
        check({ id: 'cardImageLoaded', evidenceClass: 1, passed: cardPanel?.image?.decoded === true, detail: `the opened card's image did not decode (${JSON.stringify(cardPanel?.image ?? null)})`, selector: '#avatar_load_preview', request: cardRequest?.url ?? cardPanel?.image?.resolvedSrc ?? null, observed: cardPanel?.image ?? null });
        check({ id: 'cardImageVisible', evidenceClass: 3, passed: cardPanel?.image?.visible === true, detail: `the opened card's image decoded but a user could not see it (${JSON.stringify(cardPanel?.image ?? null)})`, selector: '#avatar_load_preview', observed: cardPanel?.image ?? null });

        // ---- 3. MOVING UI: apply a staged preset through the frontend's own control -------------------------
        const settingsOpened = await page.evaluate(`(() => {
            const panel = document.querySelector('#user-settings-block');
            const alreadyOpen = Boolean(panel) && !panel.classList.contains('closedDrawer');
            if (!alreadyOpen) {
                const toggle = document.querySelector('#user-settings-button .drawer-toggle');
                if (!toggle) return { opened: false, reason: 'no #user-settings-button .drawer-toggle' };
                toggle.click();
            }
            return { opened: true, alreadyOpen };
        })()`);
        const presetOptions = await waitFor(`(() => {
            const select = document.querySelector('#movingUIPresets');
            if (!select) return null;
            const options = [...select.options].map(option => option.value);
            return options.length > 0 ? options : null;
        })()`, 'moving UI preset options', Number(process.env.A15_PRESETS_MS ?? 30000));
        const beforeState = await page.evaluate(`(() => {
            const chat = document.querySelector('#chat');
            return chat ? { inlineStyle: chat.style.cssText, computedLeft: getComputedStyle(chat).left, rect: (() => { const r = chat.getBoundingClientRect(); return { width: r.width, height: r.height, left: r.left, top: r.top }; })() } : null;
        })()`);
        let selectError = null;
        try {
            await page.selectOption('#movingUIPresets', PRESET_NAME, { timeout: Number(process.env.A15_SELECT_MS ?? 15000) });
        } catch (error) { selectError = String(error?.message ?? error).slice(0, 400); }
        const afterState = await waitFor(`(() => {
            const chat = document.querySelector('#chat');
            if (!chat) return null;
            if (chat.style.left !== ${JSON.stringify(PRESET_LEFT)}) return null;
            const r = chat.getBoundingClientRect();
            return { inlineStyle: chat.style.cssText, computedLeft: getComputedStyle(chat).left, rect: { width: r.width, height: r.height, left: r.left, top: r.top } };
        })()`, 'moving UI applied state', Number(process.env.A15_APPLY_MS ?? 20000));
        // the settings save is debounced by the frontend; wait for the request, not a sleep
        const saveRequest = await (async () => {
            const until = Date.now() + Number(process.env.A15_SAVE_MS ?? 30000);
            while (Date.now() < until) {
                const found = recorder.settingsSaveRequests.find(entry => entry.hasMovingUIState);
                if (found) return found;
                await new Promise(resolve => setTimeout(resolve, 200));
            }
            return null;
        })();
        // class 5a: the disk is the persistence layer; read it host-side and assert the state is in the file
        let savedOnDisk = null;
        try {
            const settingsText = await fs.readFile(path.join(dataRoot, USER_HANDLE, 'settings.json'), 'utf8');
            const settings = JSON.parse(settingsText);
            savedOnDisk = { bytes: settingsText.length, movingUIPreset: settings.movingUIPreset ?? null, state: settings.movingUIState ?? null };
        } catch (error) { savedOnDisk = { error: String(error?.message ?? error).slice(0, 300) }; }
        report.movingUI = {
            settingsOpened,
            presetOptions,
            selectError,
            before: beforeState,
            afterApply: afterState,
            handlerConsoleLog: recorder.console.some(entry => /MovingUI Preset applied/i.test(entry.text)),
            saveRequest,
            savedOnDisk,
        };
        check({ id: 'movingUIPresetListed', evidenceClass: 1, passed: (presetOptions ?? []).includes(PRESET_NAME), detail: `the staged MovingUI preset ${JSON.stringify(PRESET_NAME)} is not in #movingUIPresets (options=${JSON.stringify(presetOptions)})`, selector: '#movingUIPresets option', observed: presetOptions });
        check({ id: 'movingUIHandlerExecutedAndChangedThePage', evidenceClass: 2, passed: afterState?.inlineStyle != null && String(afterState.inlineStyle).includes(`left: ${PRESET_LEFT}`), detail: `selecting the preset did not run the frontend's apply handler: #chat inline style is ${JSON.stringify(afterState?.inlineStyle ?? null)} (selectError=${JSON.stringify(selectError)})`, selector: '#chat', expected: `inline style contains left: ${PRESET_LEFT}`, observed: afterState?.inlineStyle ?? null });
        check({ id: 'movingUIPresetAppliedVisibly', evidenceClass: 3, passed: afterState?.computedLeft === PRESET_LEFT && (afterState?.rect?.width ?? 0) > 0, detail: `the preset was selected but the panel was not visibly moved (computedLeft=${JSON.stringify(afterState?.computedLeft ?? null)}, rect=${JSON.stringify(afterState?.rect ?? null)})`, selector: '#chat', expected: PRESET_LEFT, observed: afterState?.computedLeft ?? null });
        check({ id: 'movingUIHandlerLoggedItsRun', evidenceClass: 2, passed: report.movingUI.handlerConsoleLog === true, detail: 'the frontend console never logged "MovingUI Preset applied", so the handler that should have run did not', selector: 'console', observed: recorder.console.slice(-5) });
        check({ id: 'movingUIStateSavedToDisk', evidenceClass: 5, passed: savedOnDisk?.state?.chat?.left === PRESET_LEFT && savedOnDisk?.movingUIPreset === PRESET_NAME, detail: `the settings file does not carry ${PRESET_NAME}/${PRESET_LEFT} (movingUIPreset=${JSON.stringify(savedOnDisk?.movingUIPreset ?? null)}, state=${JSON.stringify(savedOnDisk?.state ?? null)})`, request: saveRequest?.url ?? null, expected: `${PRESET_NAME} chat.left=${PRESET_LEFT}`, observed: savedOnDisk ?? null });
        check({ id: 'movingUIWriteWasASettingsSave', evidenceClass: 5, passed: saveRequest?.hasMovingUIState === true && saveRequest?.hasPresetName === true, detail: `no /api/settings/save request carried the preset (${JSON.stringify(saveRequest ?? null)})`, request: saveRequest?.url ?? null, observed: saveRequest ?? null });

        // ---- 4. RELOAD: a fresh page must re-apply the saved state with NO user action -----------------------
        await page.reload({ waitUntil: 'domcontentloaded', timeout: Number(process.env.A15_GOTO_MS ?? 60000) });
        await page.waitForSelector('#rm_print_characters_block .avatar[data-type="character"]', { timeout: Number(process.env.A15_LIST_MS ?? 60000) }).catch(() => null);
        const reloadApplied = await waitFor(`(() => {
            const chat = document.querySelector('#chat');
            return chat && getComputedStyle(chat).left === ${JSON.stringify(PRESET_LEFT)} ? getComputedStyle(chat).left : null;
        })()`, 'moving UI after reload', Number(process.env.A15_RELOAD_MS ?? 30000));
        const reloadDetail = await page.evaluate(`(() => {
            const chat = document.querySelector('#chat');
            const image = document.querySelector('#rm_print_characters_block .avatar[data-type="character"] img');
            return {
                computedLeft: chat ? getComputedStyle(chat).left : null,
                inlineStyle: chat ? chat.style.cssText : null,
                listAvatar: image ? (${VISIBILITY_FN})(image) : null,
            };
        })()`);
        report.movingUI.afterReload = { computedLeft: reloadDetail.computedLeft, inlineStyle: reloadDetail.inlineStyle, appliedAfterReload: reloadApplied === PRESET_LEFT };
        report.reloadListAvatar = reloadDetail.listAvatar;
        check({ id: 'movingUIReappliedAfterReload', evidenceClass: 5, passed: reloadDetail.computedLeft === PRESET_LEFT, detail: `a fresh page load did not re-apply the saved MovingUI state (computedLeft=${JSON.stringify(reloadDetail.computedLeft)}, inline=${JSON.stringify(reloadDetail.inlineStyle)})`, selector: '#chat', expected: PRESET_LEFT, observed: reloadDetail.computedLeft });
        check({ id: 'cardAvatarPaintedAfterReload', evidenceClass: 3, passed: reloadDetail.listAvatar?.visible === true, detail: `the character-list avatar was not painted on a fresh page (${JSON.stringify(reloadDetail.listAvatar)})`, selector: '#rm_print_characters_block .avatar img', observed: reloadDetail.listAvatar });

        // ---- 5. CLASS DISCIPLINE: loaded-but-not-painted is a finding, not a pass ----------------------------
        const surfaces = [
            { name: 'character-list-avatar', loaded: reloadDetail.listAvatar?.decoded === true, painted: reloadDetail.listAvatar?.visible === true },
            { name: 'chat-message-avatar', loaded: message?.image?.decoded === true, painted: message?.image?.visible === true },
            { name: 'opened-card-image', loaded: cardPanel?.image?.decoded === true, painted: cardPanel?.image?.visible === true },
        ];
        report.surfaces = surfaces;
        const unpainted = surfaces.filter(surface => surface.loaded && !surface.painted);
        check({ id: 'noLoadedButUnpaintedSurfaces', evidenceClass: 3, passed: unpainted.length === 0, detail: `surfaces loaded but a user could not see them: ${JSON.stringify(unpainted)}`, selector: 'asset surfaces', observed: surfaces });
        // ---- 4 (not applicable): a UI-only surface must not reach a provider at all --------------------------
        report.providerRequestClass = { applicable: false, reason: 'opened-card image, character-list/chat avatars and MovingUI preset application are served/rendered without a model request; the asserted property is ABSENCE', observed: recorder.providerRequests };
        check({ id: 'noProviderRequestOnUISurfaces', evidenceClass: 4, passed: recorder.providerRequests.length === 0, detail: `a UI-only surface made a provider request: ${JSON.stringify(recorder.providerRequests.slice(0, 3))}`, selector: 'network', observed: recorder.providerRequests });
        // ---- class discipline: verify the page actually EXECUTED the pinned frontend, not a shell -------------
        check({ id: 'frontendScriptExecuted', evidenceClass: 2, passed: (await page.evaluate(() => Boolean(window.SillyTavern)) || (await page.evaluate(() => typeof window.getContext === 'function'))) === true, detail: 'the page did not expose the pinned frontend globals, so nothing above can be attributed to frontend script execution', selector: 'window', observed: await page.evaluate(() => Object.keys(window).filter(key => /silly|tavern|context/i.test(key)).slice(0, 10)) });
        check({ id: 'noLiveEgress', evidenceClass: 4, passed: blockedEgress.length === 0, detail: `the page attempted non-local requests, which a probe must never allow: ${JSON.stringify(blockedEgress.slice(0, 5))}`, selector: 'network', observed: blockedEgress });
        exitCode = checks.every(item => item.passed) ? 0 : 1;
    }
} catch (error) {
    report.failure = { message: String(error?.message ?? error).slice(0, 1000) };
    console.error(`a15-ui-persist-probe: FAILED (${subject}/${phase}): ${report.failure.message}`);
    exitCode = 3;
}

// The report is written on EVERY path (including a failure), so a later reader gets a field instead of a stack.
try {
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
    const failed = checks.filter(item => !item.passed);
    if (exitCode === 0 && failed.length > 0) exitCode = 1;
    if (failed.length > 0) {
        console.error(`a15-ui-persist-probe: ${subject}/${phase}: ${failed.length} check(s) failed; report ${reportPath}`);
        for (const item of failed.slice(0, 10)) console.error(`  - [class ${item.evidenceClass}] ${item.id}: ${item.detail}`);
        for (const ids of ['pageErrors', 'failedRequests']) {
            if ((recorder[ids] ?? []).length > 0) console.error(`  ${ids}: ${JSON.stringify(recorder[ids].slice(0, 3))}`);
        }
    } else {
        console.log(`a15-ui-persist-probe: ${subject}/${phase}: OK (${checks.length} checks, report ${reportPath})`);
    }
} finally {
    try { if (browser) await browser.close(); } catch { /* already gone */ }
    if (server) { server.kill('SIGKILL'); }
    if (port) releasePort(port);
}
process.exit(exitCode);
