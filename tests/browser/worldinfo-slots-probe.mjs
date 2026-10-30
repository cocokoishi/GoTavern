// WORLD-INFO SLOT ORDER, LEG PROBE: drive the UNMODIFIED frontend on one subject and record the FINAL provider request.
//
// WHY A BROWSER AT ALL. The claim is about the ORDER of three world-info slots inside the request the MODEL receives.
// The server never assembles that prompt on this path -- the pinned frontend does (`getWorldInfoPrompt` ->
// `preparePromptsForChatCompletion` -> the provider body, worldinfo-slots-kit.mjs F2/F3/F4) -- so the only faithful
// observer is a real page driving a real send against a recording peer.
//
// THE DRIVE, one page, one send:
//   1. stage the world book on disk BEFORE the page reads the world list (both subjects read `.worlds/<name>.json`);
//   2. load the page, wait for `settingsReady` (the frontend's own gate, not a sleep);
//   3. SELECT the world through the product's own `<select id="world_info">` + `change`, and READ THE EFFECT BACK
//      through the product's own live binding `selected_world_info` (public/scripts/world-info.js:66) -- rule 58: a
//      selection that is true in the DOM and false in the model is the failure mode this project has already paid for;
//   4. point the chat-completion `custom` source at the capture peer through the frontend's own controls;
//   5. send ONE ordinary turn (the send button, not a helper API), so the assembly is the one a user gets;
//   6. record the raw body, its digest, the raw target, method and the layout attribution, then exit.
//
// BOTH SUBJECTS RUN THIS SAME FILE: the GoTavern leg boots its own binary (`GOTAVERN_BINARY` +
// `q20-leg-runtime.bootSubject`), and the pinned leg is started by `run-against-pinned.mjs`, which supplies
// `PROBE_BASE_URL`; this probe never boots a second server when that is present.
//
// NO LIVE NETWORK. The only outbound request the page makes is to the peer on 127.0.0.1, and the peer answers a canned
// completion; the reply text carries the SUBJECT'S OWN prefix so the two legs are distinguishable by construction
// (a per-subject discriminator that does NOT touch the compared body -- the reply is not part of the single request).
//
// Usage:
//   node worldinfo-slots-probe.mjs --data-root <dir> --report <file>          (GoTavern: needs GOTAVERN_BINARY)
//   node run-against-pinned.mjs worldinfo-slots-probe.mjs -- --data-root <dir> --report <file>   (pinned)

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { bootSubject, freePort, startCapturePeer, waitForServer } from './q20-leg-runtime.mjs';
import { DEPTH, DEPTH_ROLE, INPUT_TEXT, MARKERS, PINNED_BASELINE, WORLD_NAME, extractLayout, stageSelection, stageWorldBook } from './worldinfo-slots-kit.mjs';

const argv = process.argv.slice(2);
const arg = (name, fallback = null) => {
    const index = argv.indexOf(name);
    return index === -1 ? fallback : argv[index + 1];
};

const external = Boolean(process.env.PROBE_BASE_URL);
const subject = external ? 'pinned' : 'gotavern';
const dataRoot = path.resolve(arg('--data-root') ?? path.join(process.cwd(), 'legs', `worldinfo-slots-${subject}`));
const reportPath = path.resolve(arg('--report', `worldinfo-slots-${subject}.json`));
// THE DISCRIMINATOR. It is stamped into the PEER'S REPLY, which is not part of the single request this leg compares, so
// two subjects can be proven to be two drives without the comparison being able to see the stamp (AGENTS rule 50).
const replyPrefix = `${subject.toUpperCase()}_`;
const replyText = ordinal => `WISLOT_REPLY_${ordinal}`;

const report = {
    schemaVersion: 1,
    surface: 'worldinfo-slots',
    question: 'Do a `before`, an `after` and an `atDepth` world-info entry reach the FINAL provider request at the positions and in the order pinned produces?',
    subject,
    pinnedBaseline: PINNED_BASELINE,
    provenance: {
        subject,
        proxy: external ? 'run-against-pinned.mjs (PROBE_BASE_URL)' : 'in-process spawn of GOTAVERN_BINARY',
        peer: 'in-process HTTP capture peer on 127.0.0.1; records the request and answers a canned completion; defines nothing (rule 49)',
        // RECORDED SO THE COMPARATOR CAN REQUIRE THE TWO LEGS TO DIFFER: this value must NOT equal the other subject's.
        peerReplyPrefix: replyPrefix,
        blockedExternal: [],
    },
    fixture: null,
    steps: [],
    cases: [],
    failure: null,
};

const step = (name, ok, detail = null) => {
    report.steps.push({ name, ok, detail });
    if (!ok && !report.failure) report.failure = `${name}: ${detail ?? 'failed'}`;
    return ok;
};

let browser = null;
let server = null;
// The peer is created inside the try (it needs the data root already staged), and closed in the finally block, so a
// failure before it exists must not mask the original error with a ReferenceError.
let peer = null;
const timings = { phases: [] };
let phaseStart = Date.now();
const phase = label => {
    const now = Date.now();
    timings.phases.push({ phase: label, ms: now - phaseStart });
    phaseStart = now;
};

try {
    await fs.mkdir(dataRoot, { recursive: true });
    // (1) THE FIXTURE GOES DOWN BEFORE ANY PAGE EXISTS. The world list is fetched at page load, so a world staged after
    // that is invisible -- the same defect the helper legs measured for character cards (Browser differential
    // 40445034876), and it presents as "the entry did not activate" rather than as "the file was late".
    report.fixture = await stageWorldBook(dataRoot);
    report.fixture.selection = await stageSelection(dataRoot);

    peer = await startCapturePeer({ replyText, replyPrefix });
    const port = await freePort();
    const boot = await bootSubject({ argv, dataRoot, port, external });
    server = boot.server;
    report.provenance.bootRefusal = boot.bootRefusal ?? null;
    step('subject-booted', boot.bootRefusal === null, boot.bootRefusal ?? `baseURL ${boot.baseURL}`);
    report.provenance.serverPid = server?.pid ?? (process.env.PROBE_SERVER_PID ? Number(process.env.PROBE_SERVER_PID) : null);
    await waitForServer(`${boot.baseURL}/version`);
    phase('server-ready');

    const playwrightModule = await import('@playwright/test');
    const chromium = playwrightModule.chromium ?? playwrightModule.default?.chromium;
    browser = await chromium.launch();
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(String(error?.message ?? error).slice(0, 300)));
    await page.route('**://testingcf.jsdelivr.net/**', route => {
        report.provenance.blockedExternal.push(route.request().url());
        return route.abort();
    });

    await page.goto(`${boot.baseURL}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction('document.getElementById("preloader") === null', null, { timeout: 120000 });
    const bootState = await page.evaluate(async () => {
        const script = await import('./script.js');
        const started = performance.now();
        while (performance.now() - started < 90000) {
            if (script.settingsReady) return { settingsReady: true };
            const onboarding = document.querySelector('.popup .onboarding');
            if (onboarding) {
                const input = onboarding.closest('.popup')?.querySelector('.popup-input');
                if (input) {
                    input.value = 'WI Probe';
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                }
                onboarding.closest('.popup')?.querySelector('.popup-button-ok')?.click();
            }
            // THE WORLD LIST IS ASYNCHRONOUS (world-info.js `updateWorldInfoList`). Waiting for the option to EXIST is
            // a wait on the product's own output rather than a fixed delay.
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        return { settingsReady: false };
    });
    step('page-loaded', bootState?.settingsReady === true, 'script.js settingsReady');
    phase('page-loaded');

    // (3) SELECT THE WORLD, THEN READ THE EFFECT BACK THROUGH THE PRODUCT'S OWN BINDING.
    //
    // MEASURED ON THIS PAIR, and it changed the mechanism: writing `settings.world_info.globalSelect` on disk is enough
    // for the GoTavern leg but NOT for the pinned one, because `run-against-pinned.mjs` boots the pinned server BEFORE
    // this probe runs, so a settings file written here is not what the already-running server serves at
    // `/api/settings/get` -- the AGENTS rule-7 lesson (state read at STARTUP is not re-read by a live process) in a new
    // costume. Driving `<select id="world_info">` did not take on either subject (`{"selected":false,
    // "selectedWorldInfo":[]}` with `reason: null`, i.e. the option was found and the change event fired and the model
    // did not move).
    //
    // So the selection is written where the FRONTEND keeps it -- `selected_world_info`
    // (public/scripts/world-info.js:66) -- and the READ-BACK is that same live binding, which is what
    // `getWorldInfoPrompt` consumes when the turn is assembled (:5281). This is the same state a user's click produces;
    // what it deliberately does NOT claim is that a click was simulated. The disk write (`stageSelection`) stays, so on
    // the GoTavern subject both paths agree and a subject where only one of them works is visible in the record.
    const selection = await page.evaluate(async wanted => {
        const worldInfo = await import('./scripts/world-info.js');
        const deadline = Date.now() + 30000;
        let options = [];
        while (Date.now() < deadline) {
            const select = document.querySelector('#world_info');
            options = select ? Array.from(select.options).map(option => ({ value: option.value, text: String(option.text ?? '') })) : [];
            if (options.some(option => option.text === wanted)) break;
            await new Promise(resolve => setTimeout(resolve, 200));
        }
        const select = document.querySelector('#world_info');
        if (!select) return { selected: false, reason: '#world_info is not in the DOM', options };
        const row = options.find(option => option.text === wanted);
        if (!row) return { selected: false, reason: `no <option> whose text is ${JSON.stringify(wanted)}`, options };

        // (a) TRY THE PRODUCT'S OWN CONTROL FIRST, and record whether it took.
        if (window.jQuery) {
            const $select = window.jQuery(select);
            $select.val([String(row.value)]).trigger('change');
        } else {
            select.value = String(row.value);
            select.dispatchEvent(new Event('change', { bubbles: true }));
        }
        await new Promise(resolve => setTimeout(resolve, 500));
        const afterControl = [...(worldInfo.selected_world_info ?? [])];
        const controlTook = afterControl.includes(wanted);
        // (b) IF IT DID NOT TAKE, WRITE THE SAME STATE THE CONTROL WRITES. The array is the module's own; mutating it in
        // place is what keeps the live binding and the consumer in step (a re-assignment from outside cannot be done
        // through a namespace object, and re-binding is exactly what the module itself does at startup).
        let written = false;
        if (!controlTook) {
            const list = worldInfo.selected_world_info;
            if (Array.isArray(list)) {
                list.length = 0;
                list.push(wanted);
                written = true;
            }
            // The DOM view is kept in step so the two readers cannot disagree, and both are recorded.
            if (window.jQuery) window.jQuery(select).find(`option[value="${row.value}"]`).prop('selected', true);
        }
        // (c) READ BACK THROUGH THE BINDING THE ASSEMBLY USES.
        const deadlineRead = Date.now() + 10000;
        let selected = [];
        while (Date.now() < deadlineRead) {
            selected = Array.isArray(worldInfo.selected_world_info) ? [...worldInfo.selected_world_info] : [];
            if (selected.includes(wanted)) break;
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        return {
            selected: selected.includes(wanted),
            selectedWorldInfo: selected,
            controlTook,
            selectedWorldInfoAfterControl: afterControl,
            wroteTheBindingDirectly: written,
            domSelected: window.jQuery ? window.jQuery(select).val() : null,
            selectionMechanism: controlTook
                ? "jQuery val([name]) + trigger('change'), the frontend's own control"
                : 'selected_world_info mutated in place (the state the control writes); the control did not take on this subject',
            options,
        };
    }, WORLD_NAME);
    report.provenance.selection = selection;
    step('world-selected', selection?.selected === true, JSON.stringify({ selected: selection?.selected, selectedWorldInfo: selection?.selectedWorldInfo, controlTook: selection?.controlTook ?? null, wroteTheBindingDirectly: selection?.wroteTheBindingDirectly ?? null, reason: selection?.reason ?? null }));
    phase('world-selected');

    // (4) POINT THE FRONTEND AT THE PEER, through its own controls.
    const connection = await page.evaluate(async url => {
        const script = await import('./script.js');
        const openai = await import('./scripts/openai.js');
        if (typeof script.changeMainAPI === 'function') script.changeMainAPI('openai');
        const set = (selector, value, eventName = 'input') => {
            const control = document.querySelector(selector);
            if (!control) return false;
            control.value = value;
            control.dispatchEvent(new Event(eventName, { bubbles: true }));
            return true;
        };
        set('#main_api', 'openai', 'change');
        set('#chat_completion_source', 'custom', 'change');
        set('#custom_api_url_text', url);
        set('#custom_model_id', 'probe-model');
        set('#api_key_custom', 'probe-key');
        // A NON-STREAMING REQUEST: a JSON body is what the slot layout is read from, and a default can flip between legs.
        openai.oai_settings.stream_openai = false;
        return {
            mainApi: script.main_api ?? null,
            source: openai.oai_settings.chat_completion_source ?? null,
            streamOpenai: openai.oai_settings.stream_openai ?? null,
            urlSet: String(openai.oai_settings.custom_url ?? '').includes('127.0.0.1'),
        };
    }, `http://127.0.0.1:${peer.port}/v1`);
    report.provenance.connection = connection;
    step('connection-configured', connection?.source === 'custom' && connection?.urlSet === true && connection?.streamOpenai === false, JSON.stringify(connection));

    // (5) ONE ORDINARY TURN, through the send button.
    const before = peer.requests.length;
    const sent = await page.evaluate(async input => {
        const script = await import('./script.js');
        const textarea = document.querySelector('#send_textarea');
        const button = document.querySelector('#send_but');
        if (!textarea || !button) return { error: 'send controls missing' };
        textarea.value = input;
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        button.click();
        const deadline = Date.now() + 60000;
        let state = null;
        while (Date.now() < deadline) {
            const chat = script.chat ?? [];
            const userIndex = chat.findIndex(entry => entry?.is_user === true && String(entry?.mes ?? '').includes(input));
            const replied = userIndex >= 0 && chat.slice(userIndex + 1).some(entry => entry?.is_user === false);
            state = { chatLength: chat.length, userIndex, replied };
            if (replied) break;
            await new Promise(resolve => setTimeout(resolve, 200));
        }
        return { state, input, chatLengthAfter: (script.chat ?? []).length };
    }, INPUT_TEXT);
    // A BOUNDED WAIT ON THE PEER, not a sleep: the request either arrives or this case is a named failure.
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline && peer.requests.length === before) await page.waitForTimeout(250);
    phase('sent');

    const request = peer.requests[before] ?? null;
    if (!request) {
        step('provider-request-arrived', false, `${peer.requests.length - before} request(s) reached the peer after the send`);
    } else {
        step('provider-request-arrived', true, `${request.method} ${request.path} ${request.byteLength} B`);
        step('turn-completed', sent?.state?.replied === true, JSON.stringify(sent?.state ?? null));
        report.cases.push({
            case: 'slots',
            input: INPUT_TEXT,
            sent,
            // THE WIRE CONTRACT: raw body bytes and their digest, the method and the raw request target. No
            // canonicalising, no re-marshalling (differential doctrine 2).
            request: {
                method: request.method,
                path: request.path,
                byteLength: request.byteLength,
                sha256: request.sha256,
                body: request.body,
                served: request.served ?? null,
                headers: request.headers ?? null,
            },
            // ATTRIBUTION ONLY, never the contract: where each marker sat in the messages array.
            layout: extractLayout(request.body),
        });
    }
    report.cases[0].markers = MARKERS;
    report.cases[0].depth = DEPTH;
    report.cases[0].depthRole = DEPTH_ROLE;
    report.pageErrors = pageErrors;
    step('drive-completed', true, `${report.cases.length} case(s) captured`);
} catch (error) {
    report.failure = report.failure ?? String(error?.stack ?? error);
} finally {
    if (browser) await browser.close();
    // The peer is created inside the try; a failure before it exists must not mask the original error.
    if (peer) await peer.close().catch(() => {});
    server?.kill();
}

report.timings = timings;
try {
    await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
} catch (error) {
    console.error(`could not write ${reportPath}: ${error?.message ?? error}`);
    process.exitCode = 1;
}
// A FAILED DRIVE IS A NON-ZERO EXIT. The report is still written (so the comparator can REFUSE by name), but the
// runner keys on the exit code and a silent 0 here would let a leg that recorded nothing look like a clean drive.
if (report.failure || report.cases.length === 0) process.exitCode = 1;

console.log(JSON.stringify({
    subject: report.subject,
    failure: report.failure,
    steps: report.steps.map(item => `${item.ok ? 'ok' : 'FAIL'} ${item.name}`),
    layout: report.cases[0]?.layout ?? null,
    sha256: report.cases[0]?.request?.sha256 ?? null,
    bytes: report.cases[0]?.request?.byteLength ?? null,
    prefix: report.provenance.peerReplyPrefix,
}, null, 2));
