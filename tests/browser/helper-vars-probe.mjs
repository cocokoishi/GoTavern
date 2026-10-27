// DO 酒馆助手's VARIABLES CHANGE THE FINAL PROVIDER REQUEST, and does its INJECTION move the context at the pinned
// position? (GOAL.md Q10, Q11, §3; AGENTS.md 47, 48, 49, 50.)
//
// WHY THIS LEG EXISTS. The evidence for variables stopped at "the value persisted to the chat file" (`helper-probe.mjs`
// guard `variablePersisted`, run 40250495167). GOAL §3 makes a stronger claim and no leg in this repository asserts
// it: `helper-generation-probe.mjs` greps clean for every variable API (getVariables / insertOrAssignVariables /
// deleteVariable / injectPrompts), so a variable could be entirely broken and every existing gate would stay green.
//
// =====================================================================================================================
// THE PINNED SEMANTICS, READ FROM SOURCE. Extension N0VI028/JS-Slash-Runner@837a6288135cde61522a9279173b98020f08807e
// (manifest 4.11.3, read from the installed tree); host page SillyTavern 06bde939fb1e9c4c8d8641d810f0a9165b5ce127.
//
// SCOPES (src/function/variables.ts:39-54, reader :56-94, writer :128-191):
//   chat      chat_metadata.variables          :72-74 / :151-155 -> saveMetadataDebounced :153
//   character card data.extensions.tavern_helper.variables  :75-77 / :156-163 -> store/settings/character.ts:36-42
//             -> writeExtensionField -> POST /api/characters/merge-attributes
//   preset    preset file extensions.tavern_helper.variables :78-80 / :164-168 -> store/settings/preset.ts:26-37
//   global    extension_settings.variables.global            :81-83 / :169-173 -> saveSettingsDebounced
//   message   chat[i].variables[swipe_id]                    :58-71 / :130-150
//   script    per-script iframe store                        :84-89 / :174-184
//   extension extension_settings[extension_id]               :90-92 / :185-189
//
// API (exported :10-:301, bound onto TavernHelper at src/function/index.ts:442-449): getVariables, _getVariables,
// _getAllVariables, replaceVariables, updateVariablesWith, insertVariables, insertOrAssignVariables, deleteVariable,
// registerVariableSchema. THERE IS NO `setVariables`. THERE IS NO quiet/no-op option anywhere in the family: every
// writer takes (variables, option) and nothing else. The artefact RECORDS both absences (the kit measures them) and
// does not test a feature the pinned version does not have.
//
// THE MECHANISM, AND WHY THE PRODUCT CLAIM HAS TWO HALVES. The extension never expands a variable. A prompt's
// `{{getvar::x}}` is expanded by the HOST macro engine during ordinary request assembly
// (public/scripts/macros/definitions/variable-macros.js:99-116 -> getContext().variables.local.get ->
// public/scripts/st-context.js:258-279 -> public/scripts/variables.js:22-46 over chat_metadata.variables). So:
//   HALF (i)  the resolved text is in `messages[]` ON THE WIRE during a real Generate.
//   HALF (ii) the value is re-readable FROM DISK after a fresh page AND after a NEW SERVER PROCESS.
// Either alone is satisfiable by a broken implementation -- (i) by a page-only write that is never saved, (ii) by a
// write no prompt can read. The leg asserts both, per case, and the comparator requires both on both subjects.
//
// THE `message` SCOPE IS A FINDING, NOT A FEATURE. It stores and retrieves inside the iframe (:58-71, :130-150), but
// NO host macro reads it: HOST_VARIABLE_MACROS contains getvar/getglobalvar/getvarkey/getglobalvarkey/hasvar/
// hasglobalvar and none of them consults a message scope. The leg therefore asserts the two halves SEPARATELY --
// stored-and-retrieved in the page, and DOES NOT REACH the provider request -- and the artefact's row says
// "stored, not surfaced". Asserting the second half as a positive would be inventing the feature.
//
// INJECTION (src/function/inject.ts:21-55 -> public/script.js:8926-8935 setExtensionPrompt -> extension_prompts[key];
// uninjectPrompts :57-61 deletes the key; once:true also removes on GENERATION_ENDED/STOPPED/pagehide :44-50).
// Placement is public/scripts/openai.js:810-875 `populationInjectionPrompts`: depth loop :820, per-depth splice :868
// with `injectIdx = i + totalInsertedMessages`, role order ['system','user','assistant'] :847-864, reverse :873. So
// depth d is NOT "the d-th message from the start"; the leg asserts the MEASURED INDEX at depths 0, 1 and 2 and
// reports the offset it observed. This is a DIFFERENT path from the existing generation leg, which passes
// `generate({injects:[...]})` and never touches extension_prompts at all -- the D3 case in the artefact says so.
// =====================================================================================================================
//
// THE DRIVE, one browser session (plus a second page and, in the restart leg, a second server process):
//   B  READY probe: select a derived preset whose four content prompts are markers, send once, capture. Not a
//      variable case -- it teaches the leg the captured body's exact member names (`messages[]` vs `prompt`), so
//      every later assertion is written against a measured shape. Its capture is also the "prior form" a delete
//      must return to.
//   C  chat scope: set ALPHA -> send -> capture (half i: the token is on the wire). set BETA -> send -> capture
//      (the request DIFFERS, and the diff is the variable's text, not a timestamp).
//   D  delete -> send -> capture: the token is gone and the form matches the no-variable form.
//   E  global scope: set ROLE-SIGNAL -> send -> capture (a second scope, so "chat only" is excluded).
//   F  character scope: set CHAR-SCOPE -> send -> capture; then assert the CARD file gained it (half ii).
//   G  nested value: `{{getvarkey::market_object::tier}}` -> send -> capture.
//   H  message scope: write -> read back IN THE PAGE -> send -> capture; the marker must NOT be on the wire.
//   I  injection: depth 2 role user -> send -> capture index; depth 0, depth 1 likewise; uninject -> send ->
//      capture: absent.
//   J  chat isolation: open a SECOND chat -> send -> capture: chat one's value is absent, the global one present.
//   K  fresh page, same process -> select trio -> send: the value from DISK is on the wire (half ii, reload).
//   L  THE RESTART LEG is a separate invocation (`--after-restart`) over the tree K left behind, on a NEW server
//      process: same assertions, and the artefact records that the process is not the one that wrote.
//
// WHY THE EXISTING RENDER LEGS NEVER HIT THE CARD BUG THIS ONE DID (recorded because the difference is invisible in
// the log, and the next probe that finds a character card will otherwise inherit it): `helper-probe.mjs` opens a
// character by clicking `#rm_print_characters_block .avatar[data-type="character"]` -- BY CSS CLASS, taking whichever
// card renders first -- and it needs nothing from the card but a greeting to make a chat exist. It therefore never
// reads an attribute off the card. THIS leg needs the card's OWN `data.name` (to prove it opened the card it staged,
// not a neighbour) and its `extensions.chat` trigger (to prove the chat's preset is the trio), so it must MATCH a
// card, and matching by a field the template does not set is a failure that a class-based click cannot produce.
// Measured in Browser differential 40445034876: `rendered:[null,null]` -- two cards, both with a null `title`, because
// public/script.js:951-952 puts the title on the INNER `.avatar` and the name in `.ch_name`.
//
// =====================================================================================================================
// HAZARD FOR EVERY OTHER LANE: A SELECTION CAN BE TRUE IN THE DOM AND FALSE IN THE FRAMEWORK THAT READS IT.
//
// MEASURED in Browser differential 40451801982 and recorded here because it is a RULE, not a bug in this file. The
// probe found the `<option>` whose text was `ready-probe`, assigned `option.selected = true`, and the preset panel
// still reported the PREVIOUS preset. Why:
//
//   READ    public/scripts/preset-manager.js:399-401
//             getSelectedPresetName() { return $(this.select).find('option:selected').text(); }
//           `:selected` is jQuery's CACHED selection state, not the DOM property. Assigning `option.selected`
//           updates the DOM and does NOT refresh what jQuery sees, so the two views disagree.
//   WRITE   public/scripts/preset-manager.js:415-424 (`PresetManager.selectPreset`)
//             option.prop('selected', true); $(this.select).val(value).trigger('change');
//           and public/scripts/openai.js:4369 does the same with `.prop('selected', true)`. jQuery's `.prop()`/`.val()`
//           are the operations that keep the two views in step.
//
// The failure this produces is the worst shape available: `selected:false` on the row I asked for while `Default` was
// still `selected:true`, i.e. the request looked answered and the state had not moved. A driver that trusted its own
// dispatch would have measured the WRONG PRESET FOREVER and reported a green. The permanent answer, implemented in
// `selectPreset` below, is to RECORD BOTH VIEWS SIDE BY SIDE (`domSelected` and `jquerySelected`) so a future reader
// can see them disagree without reproducing the defect, and to assert the EFFECT read back from the framework
// (`getSelectedPresetName()`) rather than the action performed.
//
// THE SAME CLASS OF ERROR appears wherever a browser state has two readers -- `elementFromPoint` returning a coverer
// the CSS says is not there; `document.activeElement` after a programmatic focus; a checkbox `checked` property
// versus a framework's model. If a leg asserts a selection, focus, checked or scroll state, it must read that state
// back THROUGH THE READER THE PRODUCT USES, not through the setter it used to create it.
//
// ---------------------------------------------------------------------------------------------------------------------
// SECOND HAZARD, AND IT AFFECTS LEGS THAT HAVE ALREADY RUN: OPENING A CHARACTER SILENTLY CHANGES THE PRESET.
//
// `autoSelectPreset` (public/scripts/preset-manager.js:49-73) is bound to CHAT_CHANGED and does:
//     const name = selected_group ? groups.find(...)?.name : characters[this_chid]?.name;
//     const preset = presetManager.findPreset(name);
//     if (preset !== undefined && preset !== null) presetManager.selectPreset(preset);
// So opening a character selects a preset NAMED AFTER THAT CHARACTER, if one exists. That is why this leg saw the
// panel report a character-derived preset ("RecoveredRuins" in 40451801982) after it opened its staged card.
//
// The consequence is wider than this leg: ANY leg that opens a character and then assumes the preset it selected
// is still the preset in effect has been measuring the CHARACTER-DERIVED preset, not the one it chose. The exposed
// shape is precise and checkable -- a leg that (a) selects a preset, (b) opens a character or switches chat, and
// (c) never reads the selection back -- and any lane in that shape should check itself against the two readers
// above. This lane does not name other lanes' files as affected: a lane's own artifact is the only place that can
// decide whether its ordering puts it in the shape. The defence is the same one used here: select, then READ THE
// EFFECT BACK, and fail by name when it did not take; and prefer a fixture tree where no preset is NAMED AFTER the
// character being opened, so `autoSelectPreset` has nothing to switch to.
// =====================================================================================================================
//
// THE PEER CAPTURES AND ANSWERS; IT NEVER DEFINES CORRECTNESS (AGENTS 49). Every expectation is a property of an
// input this leg supplied (a token it set, a marker it injected) or the pinned leg's bytes.
//
// OFFLINE: the peer binds 127.0.0.1; testingcf.jsdelivr.net is blocked and recorded, as in the other helper legs.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import { createServer } from 'node:net';
import path from 'node:path';
import process from 'node:process';

import { ensurePinnedExtensionInstalled } from './install-pinned-extension.mjs';
import { pinnedExtension } from './pinned-extensions.mjs';
import { seedLegConfig } from './seed-leg-config.mjs';
import { attachUrlRecorder } from './url-recorder.mjs';
import {
    PINNED_HELPER_VERSION, PROBE_CARD, PROBE_MARKERS, READY_PROBE_NAME, RESOLVE_IDENTIFIER, TARGET_PRESET_NAME,
    buildTrio, hashTree, readCardStance, readChatRecords, readCommittedPreset, readHelperApiSurface,
    readPresetStance, readSettingsFile, seedChats, stageProbeCard, writeProbePresets, here, repoRoot,
} from './extensions/helper-vars-kit.mjs';

const playwrightModule = await import('@playwright/test');
const chromium = playwrightModule.chromium ?? playwrightModule.default?.chromium;

function argumentValue(name, fallback = null) {
    const index = process.argv.indexOf(name);
    return index === -1 ? fallback : process.argv[index + 1];
}

const subject = process.env.PROBE_BASE_URL ? 'pinned' : 'gotavern';
const external = Boolean(process.env.PROBE_BASE_URL);
const variant = argumentValue('--variant', 'on');
// THE CONTROL. `--variant off` writes NO variable and injects nothing: every capture must then be identical to the
// no-variable form. A leg whose on and off captures are identical is HARNESS NON-DISCRIMINATING (rule 50).
const writesVariables = variant !== 'off';
const afterRestart = process.argv.includes('--after-restart');
const dataRoot = path.resolve(argumentValue('--data-root') ?? await fs.mkdtemp(path.join(process.env.TEMP ?? '/tmp', 'gotavern-helper-vars-')));
const reportPath = path.resolve(argumentValue('--report', path.join(here, `helper-vars-${subject}-${variant}${afterRestart ? '-restart' : ''}.json`)));

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
            if ((await fetch(url)).ok) return;
        } catch {
            // not up yet
        }
        await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error(`${url} did not answer within ${deadlineMs} ms`);
}

// ---------------------------------------------------------------------------------------------------------------
// THE CAPTURE PEER. CORS is answered because the pinned frontend posts to a custom endpoint FROM THE BROWSER.
// ---------------------------------------------------------------------------------------------------------------
function startCapturePeer() {
    const requests = [];
    const server = http.createServer((request, response) => {
        const chunks = [];
        request.on('data', chunk => chunks.push(chunk));
        request.on('end', () => {
            const body = Buffer.concat(chunks);
            const headers = { 'content-type': 'application/json', 'access-control-allow-origin': '*' };
            if (request.method === 'OPTIONS') {
                response.writeHead(204, {
                    'access-control-allow-origin': '*',
                    'access-control-allow-headers': request.headers['access-control-request-headers'] ?? '*',
                    'access-control-allow-methods': 'GET,POST,OPTIONS',
                    'access-control-max-age': '600',
                });
                response.end();
                return;
            }
            const entry = {
                method: request.method,
                path: request.url,
                contentType: request.headers['content-type'] ?? null,
                byteLength: body.length,
                sha256: createHash('sha256').update(body).digest('hex'),
                body: body.toString('utf8'),
                at: requests.length,
            };
            requests.push(entry);
            if (request.method === 'GET' && /models/.test(request.url ?? '')) {
                response.writeHead(200, headers);
                response.end(JSON.stringify({ object: 'list', data: [{ id: 'probe-model', object: 'model' }] }));
                return;
            }
            response.writeHead(200, headers);
            response.end(JSON.stringify({
                id: `chatcmpl-hv-${entry.at}`,
                object: 'chat.completion',
                created: 1730000000,
                model: 'probe-model',
                choices: [{ index: 0, message: { role: 'assistant', content: `HV-REPLY-${entry.at}` }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            }));
        });
    });
    return new Promise((resolve, reject) => {
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
            resolve({ port: server.address().port, requests, close: () => new Promise(done => server.close(done)) });
        });
    });
}

const report = {
    schemaVersion: 1,
    question: 'Does a 酒馆助手 variable change the FINAL provider request through host macro substitution AND survive on disk, does an injection land at the position pinned produces, and do both hold across chat switch, fresh page and a new server process?',
    subject,
    variant,
    afterRestart,
    provenance: {
        extension: { key: 'tavern-helper', name: pinnedExtension('tavern-helper').name, repo: pinnedExtension('tavern-helper').repo, commit: pinnedExtension('tavern-helper').commit, pinnedVersion: PINNED_HELPER_VERSION },
        peer: 'in-process HTTP capture peer on 127.0.0.1; records the request, answers a canned completion; defines nothing (rule 49)',
        blockedExternal: [],
    },
    apiSurface: null,
    claim: {
        halves: [
            '(i) a live preset prompt\'s {{getvar::x}} resolves the helper\'s value during an ordinary Generate, and the resolved text is in messages[] on the wire',
            '(ii) the value is re-readable from DISK after a fresh page and after a new server process, through the scope\'s own persist path',
        ],
        whyBothNeeded: '(i) alone is satisfied by a page-only write that is never saved; (ii) alone is satisfied by a write no prompt can read',
        messageScope: 'src/function/variables.ts:58-71 stores and :130-150 saves chat[i].variables[swipe_id], but NO host macro reads a message scope (HOST_VARIABLE_MACROS = getvar/getglobalvar/getvarkey/getglobalvarkey/hasvar/hasglobalvar). The row this leg produces is "stored, not surfaced", and the second half is asserted as ABSENCE.',
        injectionPaths: {
            thisLeg: 'TavernHelper.injectPrompts -> setExtensionPrompt -> extension_prompts[key] -> populationInjectionPrompts (openai.js:810-875)',
            existingGenerationLeg: 'generate({injects:[...]}) -> InjectionPrompt[] passed in the config, spliced by the extension itself (generate/generateRaw.ts:281-414) -- a DIFFERENT path that never touches extension_prompts. That leg only ever used depth 0 and declared the gap.',
        },
    },
    fixture: null,
    markers: PROBE_MARKERS,
    steps: [],
    cases: [],
    units: null,
    offControl: variant === 'off' ? 'no variable is written and nothing is injected: every capture must equal the no-variable form' : null,
    disk: null,
    console: [],
    pageErrors: [],
    failure: null,
};

function observation(name, ok, detail = null) {
    report.steps.push({ name, ok, detail });
}

function step(name, ok, detail = null) {
    report.steps.push({ name, ok, detail });
    if (!ok && !report.failure) report.failure = `${name}: ${detail ?? 'failed'}`;
    return ok;
}

/**
 * WHAT A CAPTURE IS COMPARED AS. The raw body and its digest are the contract (rule 2: byte-oriented, no
 * canonicalising). `units` is ATTRIBUTION only, and it is DISCOVERED from the READY capture: a body may carry
 * `messages[]`, a `prompt` string, or both, and a leg that hardcoded one would silently assert nothing.
 */
function summarise(request) {
    if (!request) return null;
    let parsed = null;
    try {
        parsed = JSON.parse(request.body);
    } catch {
        parsed = null;
    }
    const units = [];
    if (Array.isArray(parsed?.messages)) {
        parsed.messages.forEach((message, index) => units.push({
            index,
            role: message.role ?? null,
            content: typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? null),
        }));
    } else if (typeof parsed?.prompt === 'string') {
        units.push({ index: 0, role: null, content: parsed.prompt });
    } else if (Array.isArray(parsed?.prompt)) {
        parsed.prompt.forEach((content, index) => units.push({ index, role: null, content: typeof content === 'string' ? content : JSON.stringify(content) }));
    }
    return {
        path: request.path,
        contentType: request.contentType,
        byteLength: request.byteLength,
        sha256: request.sha256,
        body: request.body.slice(0, 12000),
        parsedKeys: parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? Object.keys(parsed).sort() : null,
        model: parsed?.model ?? null,
        stream: parsed?.stream ?? null,
        units,
    };
}

function identifyUnits(capture) {
    if (!capture) return null;
    if (Array.isArray(capture.parsedKeys) && capture.units.length > 0) {
        const field = capture.parsedKeys.includes('messages') ? 'messages' : 'prompt';
        return { kind: 'json', field, count: capture.units.length, keys: capture.parsedKeys, model: capture.model, stream: capture.stream };
    }
    return null;
}

const peer = await startCapturePeer();
let server = null;
let browser = null;
// Hoisted OUT of the drive so the finally block can record teardown cost even when the drive throws early --
// otherwise a wedged close after a failure would be the one thing the artefact could not explain.
const timings = { phases: [], notes: [] };

/** The GoTavern binary. Defined before the drive: it is spawned FROM the drive. */
function binaryPath() {
    const binarySetting = process.env.GOTAVERN_BINARY ?? '';
    return binarySetting ? path.resolve(binarySetting) : path.join(dataRoot, process.platform === 'win32' ? 'gotavern.exe' : 'gotavern');
}

try {
    await fs.mkdir(dataRoot, { recursive: true });
    const installed = await ensurePinnedExtensionInstalled(dataRoot, pinnedExtension('tavern-helper'));
    report.provenance.extension.installedRevision = installed.revision;
    report.provenance.extension.installSource = installed.source ?? null;

    {
        // THE REFUSAL. A different extension, or an API that moved, is not a comparison -- and the leg writes its
        // artefact and exits non-zero rather than driving a subject it cannot describe.
        const apiSurface = await readHelperApiSurface(installed, installed.extensionDirectory);
        report.apiSurface = apiSurface;
        if (!apiSurface.pinned) {
            throw new Error(`REFUSED: the pinned variable semantics are not the ones on disk: ${apiSurface.reasons.join('; ')}`);
        }
        step('extension-is-pinned', true, `${apiSurface.pinnedCommit} manifest ${apiSurface.manifestVersion}`);
        step('api-surface-recorded', Object.keys(apiSurface.exports).length >= 14 && Object.keys(apiSurface.scopes).length === 7,
            `exports=${Object.keys(apiSurface.exports).length} scopes=${Object.keys(apiSurface.scopes).join(',')}`);
        step('absent-features-recorded', apiSurface.absentUnexpected.length === 0,
            apiSurface.absentUnexpected.length === 0
                ? `confirmed absent at the pin: ${apiSurface.absentConfirmed.map(entry => entry.name).join(', ')}`
                : `UNEXPECTED at the pin: ${JSON.stringify(apiSurface.absentUnexpected)}`);
        step('message-scope-unreadable-by-macro', apiSurface.host.messageScopeMacro === false,
            'no host variable macro consults a message scope, so the message row is "stored, not surfaced"');
    }

    // THE FIXTURE MUST EXIST BEFORE THE SERVER BOOTS, AND BEFORE THE BROWSER READS THE CHARACTER LIST.
    //
    // MEASURED, run 40445034876: the first version staged the card and the chats AFTER `waitForServer`, and every
    // leg recorded `card-opened: {"opened":false,"rendered":[null,null]}` -- two cards rendered with a null `title`,
    // because the frontend's character list had been read before the card was on disk. Staging after boot is only
    // safe when the driver clicks the card by CSS CLASS and takes whatever renders first (`helper-probe.mjs` does
    // exactly that, and so never depends on any attribute of the card); this leg matches a card by its own name, so
    // it depends on BOTH the ordering and the attribute. `tests/browser/q21-data-handback.mjs` stages the card
    // BEFORE `seedLegConfig` and boot for the same reason, and that ordering is copied here rather than re-derived.
    // `startup.SeedDefaultContent` retains existing targets (internal/startup/content.go, "Existing targets are
    // retained"), so pre-staging survives the GoTavern leg's own seeding.
    report.fixture = { card: await stageProbeCard(dataRoot) };
    if (!afterRestart) {
        report.fixture.chats = await seedChats(dataRoot, {
            avatar: PROBE_CARD.fileName,
            names: ['probe-chat-one', 'probe-chat-two'],
            firstUser: 'PROBE_USER_GREETING',
            firstAssistant: PROBE_CARD.greeting,
        });
    }

    const port = await freePort();
    let legConfig = process.env.PROBE_LEG_CONFIG_JSON ? JSON.parse(process.env.PROBE_LEG_CONFIG_JSON) : null;
    if (!external) {
        const binary = binaryPath();
        if (!process.env.GOTAVERN_BINARY) {
            const build = spawn('go', ['build', '-trimpath', '-o', binary, './cmd/gotavern'], { cwd: repoRoot, stdio: 'inherit' });
            if (await new Promise(resolve => build.on('exit', resolve)) !== 0) throw new Error('go build ./cmd/gotavern failed');
        } else {
            await fs.copyFile(path.resolve(process.env.GOTAVERN_BINARY), binary);
        }
        const tokenizers = path.join(repoRoot, 'upstream', 'tokenizers');
        if (!(await fs.stat(tokenizers).then(() => true, () => false))) throw new Error(`tokenizer data missing at ${tokenizers}`);
        await fs.cp(tokenizers, path.join(dataRoot, 'tokenizers'), { recursive: true });
        legConfig = await seedLegConfig(dataRoot);
        // A NEW PROCESS ON EVERY INVOCATION, which is what makes the restart leg a restart: the pid is recorded so
        // the artefact proves the process changed rather than asserting it.
        server = spawn(binary, ['start', '--port', String(port), '--dataRoot', dataRoot, '--configPath', path.join(dataRoot, 'config.yaml')], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
        server.stdout.on('data', () => {});
        server.stderr.on('data', () => {});
        report.provenance.serverPid = server.pid ?? null;
    }
    report.provenance.configFile = { path: 'config.yaml', sha256: legConfig?.sha256 ?? null, matchesSource: legConfig?.matchesSource ?? null };
    const baseURL = process.env.PROBE_BASE_URL ?? `http://127.0.0.1:${port}`;
    // THE TIMING BREAKDOWN, measured rather than described. Six legs at ~10 minutes each is ~1 hour of CI per run of
    // this workflow, so WHERE the time goes has to be a number in the artefact -- otherwise a cost that is paid six
    // times can only be argued about. Each phase records milliseconds since the phase before it.
    report.timings = timings;
    let phaseStart = Date.now();
    const phase = label => {
        const now = Date.now();
        timings.phases.push({ phase: label, ms: now - phaseStart });
        phaseStart = now;
    };
    phase('fixture-staged');
    await waitForServer(`${baseURL}/version`);
    phase('server-ready');
    report.provenance.serverVersion = await fetch(`${baseURL}/version`).then(response => response.json(), () => null);

    if (!afterRestart) {
        const committed = await readCommittedPreset();
        report.fixture.committedPreset = { file: committed.file, sha256: committed.sha256, byteLength: committed.byteLength };
        const stanceDirectory = path.join(dataRoot, 'default-user', 'OpenAI Settings');
        const stanceNames = (await fs.readdir(stanceDirectory).catch(() => [])).filter(name => name.endsWith('.json')).map(name => name.slice(0, -5));
        report.fixture.stanceNames = stanceNames;
        if (stanceNames.length === 0) throw new Error('the tree has no chat-completion preset to clone the trio from');
        const stanceName = stanceNames.includes('Default') ? 'Default' : stanceNames[0];
        const stanceBody = await fs.readFile(path.join(stanceDirectory, `${stanceName}.json`), 'utf8');
        const stance = JSON.parse(stanceBody);
        report.fixture.stance = { name: stanceName, sha256: createHash('sha256').update(stanceBody).digest('hex'), promptCount: (stance.prompts ?? []).length, orderGroups: (stance.prompt_order ?? []).length };
        // THE IDENTITY PROMPT IS WHERE EVERY VARIABLE IS READ. One prompt carries all four lookups, so a single
        // splice point proves them and a diff has one place to be attributed to.
        const identity = [
            `HV-IDENTITY-CHAT={{getvar::market_value}}`,
            `HV-IDENTITY-GLOBAL={{getglobalvar::role_signal}}`,
            `HV-IDENTITY-CHAR={{getvar::char_scope_value}}`,
            `HV-IDENTITY-NESTED={{getvarkey::market_object::tier}}`,
            `HV-IDENTITY-END`,
        ].join('|');
        const ready = buildTrio({ stance, readyMarker: PROBE_MARKERS.ready, identity: '' });
        const trio = buildTrio({ stance, readyMarker: `${PROBE_MARKERS.ready}-${PROBE_MARKERS.identity}`, identity });
        report.fixture.derivation = { ready: { group: ready.group, missingIdentifiers: ready.missingIdentifiers }, trio: { group: trio.group, missingIdentifiers: trio.missingIdentifiers }, identity, resolveIdentifier: RESOLVE_IDENTIFIER };
        report.fixture.files = await writeProbePresets(dataRoot, {
            ready: { name: READY_PROBE_NAME, document: ready.document },
            trio: { name: TARGET_PRESET_NAME, document: trio.document },
        });
        report.fixture.afterWrite = await readPresetStance(dataRoot, [READY_PROBE_NAME, TARGET_PRESET_NAME]);
        step('fixture-written',
            report.fixture.afterWrite[READY_PROBE_NAME]?.present === true
            && Object.keys(report.fixture.afterWrite[TARGET_PRESET_NAME]?.promptContents ?? {}).includes(RESOLVE_IDENTIFIER),
            JSON.stringify({ trioPrompts: Object.keys(report.fixture.afterWrite[TARGET_PRESET_NAME]?.promptContents ?? {}).length, hasResolve: Object.keys(report.fixture.afterWrite[TARGET_PRESET_NAME]?.promptContents ?? {}).includes(RESOLVE_IDENTIFIER) }));
    } else {
        // THE RESTART LEG ASSERTS ITS OWN PRECONDITION: the tree already carries what a previous process wrote. A
        // restart leg over an empty tree would drive a scenario nobody ran.
        const presets = await readPresetStance(dataRoot, [TARGET_PRESET_NAME, READY_PROBE_NAME]);
        step('restart-tree-carries-the-fixture', presets[TARGET_PRESET_NAME]?.present === true && presets[READY_PROBE_NAME]?.present === true, JSON.stringify(Object.fromEntries(Object.entries(presets).map(([name, value]) => [name, value.present]))));
        report.fixture.presetsBeforeRestart = presets;
    }

    const peerUrl = `http://127.0.0.1:${peer.port}/v1`;
    browser = await chromium.launch();
    const page = await browser.newPage();
    page.on('pageerror', error => report.pageErrors.push(String(error?.message ?? error).slice(0, 300)));
    page.on('console', message => report.console.push({ type: message.type(), text: String(message.text()).slice(0, 400) }));
    await page.route('**://testingcf.jsdelivr.net/**', route => {
        report.provenance.blockedExternal.push(route.request().url());
        return route.abort();
    });
    const recorder = attachUrlRecorder(page);

    const openPage = async () => {
        await page.goto(`${baseURL}/`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction('document.getElementById("preloader") === null', null, { timeout: 120000 });
        return page.evaluate(async () => {
            const script = await import('./script.js');
            const started = performance.now();
            while (performance.now() - started < 90000) {
                if (script.settingsReady) return { settingsReady: true };
                const onboarding = document.querySelector('.popup .onboarding');
                if (onboarding) {
                    const input = onboarding.closest('.popup')?.querySelector('.popup-input');
                    if (input) {
                        input.value = 'Probe User';
                        input.dispatchEvent(new Event('input', { bubbles: true }));
                    }
                    onboarding.closest('.popup')?.querySelector('.popup-button-ok')?.click();
                }
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            return { settingsReady: false };
        });
    };

    // OPEN THE CARD THE PROBE STAGED, BY THE NAME THE FRONTEND ITSELF RENDERS FOR IT.
    //
    // MEASURED, run 40445034876: every leg reported `card-opened: {"opened":false,"rendered":[null,null]}`. The
    // matcher read `title` off the OUTER card, and the pinned template puts it on the INNER `.avatar`:
    //   public/script.js:951  template.find('.avatar').attr('title', `[Character] ${item.name}\nFile: ${item.avatar}`);
    //   public/script.js:952  template.find('.ch_name').text(item.name).attr('title', `[Character] ${item.name}`);
    // The OUTER `.character_select` therefore carries no title at all -- hence `[null,null]`. Two fixes, in order of
    // preference, both reading what `getCharacterBlock` renders: the `.ch_name` text (the plain name), then the
    // `.avatar` title (which is `[Character] <name>` + a File line). The rendered labels are returned whether or not
    // the match succeeds, so a future mismatch is a field rather than a boolean.
    const openCard = async () => page.evaluate(async wanted => {
        const describe = () => [...document.querySelectorAll('#rm_print_characters_block .character_select')].map(entry => ({
            chName: entry.querySelector('.ch_name')?.textContent?.trim() ?? null,
            avatarTitle: entry.querySelector('.avatar')?.getAttribute('title') ?? null,
            dataChid: entry.getAttribute('data-chid') ?? null,
        }));
        const deadline = Date.now() + 60000;
        let card = null;
        while (Date.now() < deadline) {
            const cards = [...document.querySelectorAll('#rm_print_characters_block .character_select')];
            card = cards.find(entry => String(entry.querySelector('.ch_name')?.textContent ?? '').trim() === wanted)
                ?? cards.find(entry => String(entry.querySelector('.avatar')?.getAttribute('title') ?? '').includes(wanted))
                ?? null;
            if (card) break;
            await new Promise(resolve => setTimeout(resolve, 250));
        }
        if (!card) return { opened: false, rendered: describe() };
        const matched = {
            byChName: String(card.querySelector('.ch_name')?.textContent ?? '').trim() === wanted,
            chName: card.querySelector('.ch_name')?.textContent?.trim() ?? null,
            dataChid: card.getAttribute('data-chid') ?? null,
            rendered: describe(),
        };
        card.click();
        const settle = Date.now() + 45000;
        while (Date.now() < settle) {
            if (document.querySelectorAll('#chat .mes').length > 0) break;
            await new Promise(resolve => setTimeout(resolve, 250));
        }
        const context = window.SillyTavern.getContext();
        return {
            opened: true,
            matched,
            messages: document.querySelectorAll('#chat .mes').length,
            chatId: context.getCurrentChatId ? context.getCurrentChatId() : (context.chatId ?? null),
            characterId: context.characterId ?? null,
            // THE CHAT'S PRESET AFTER OPENING, which is the CARD's own `extensions.chat` trigger applied by
            // `autoSelectPreset` on CHAT_CHANGED. If it is not the trio, the chat-scope assertion is about whatever
            // preset happened to be selected, so this is recorded rather than assumed.
            selectedPreset: context.getPresetManager().getSelectedPresetName(),
            cardChatPreset: context.characters?.[context.characterId]?.data?.extensions?.chat ?? null,
        };
    }, PROBE_CARD.dataName);

    const selectPreset = async name => page.evaluate(async wanted => {
        const context = window.SillyTavern.getContext();
        const manager = context.getPresetManager();
        // SELECT BY THE DOM THE FRONTEND RENDERS, NOT BY A jQuery-INTERNALS HELPER.
        //
        // MEASURED, run 40445034876: `manager.findPreset('ready-probe')` returned **undefined** on BOTH subjects
        // while the option list visibly contained `["Default","probe-preset","ready-probe"]`. `findPreset` is
        // `public/scripts/preset-manager.js:385-390`:
        //     return $(this.select).find('option').filter(function () { return $(this).text() === name; }).val();
        // -- an exact `text()` comparison through a jQuery collection captured in the manager's constructor, so what
        // it compares is not necessarily what `document.querySelectorAll` returns here. The frontend's own call sites
        // (`:1200`, `:945`, `:965`) use it on the SELECTED or freshly saved entry, which is a narrower situation than
        // "find a row by name from outside". Reading the rendered `<option>`s directly is the same source of truth
        // the user's click reads, and it is what the failure message was already printing.
        //
        // THIS MANAGER IS NOT KEYED (`isKeyedApi()` false for openai, `:593-598`): a row's VALUE is its index and the
        // NAME is the option text. Applying a preset requires the CHANGE EDGE (`onSettingsPresetChange`,
        // `public/scripts/openai.js:5020-5075`) -- setting `.value` alone applies nothing.
        const select = document.querySelector('#settings_preset_openai');
        if (!select) return { selected: false, reason: '#settings_preset_openai is not in the DOM' };
        const rows = [...select.options].map(option => ({ value: option.value, text: String(option.text), selected: option.selected }));
        // EXACT text match first (the same predicate the frontend uses), then a trimmed match, so a label the
        // frontend decorated with whitespace is a reported near-miss rather than a silent failure.
        const exact = rows.find(row => row.text === wanted);
        const loose = rows.find(row => row.text.trim() === wanted);
        const row = exact ?? loose;
        if (!row) {
            return { selected: false, reason: `no <option> whose text is ${JSON.stringify(wanted)}`, rows, tried: 'exact then trimmed text match on the rendered options' };
        }
        const option = select.querySelector(`option[value="${row.value}"]`);
        if (!option) {
            return { selected: false, reason: `the row for ${JSON.stringify(wanted)} exists in the list but has no option element`, rows };
        }
        // SELECT THROUGH jQuery, WHICH IS WHAT THE FRONTEND ITSELF DOES -- NOT THROUGH THE DOM PROPERTY.
        //
        // MEASURED, run 40451801982: the option was found by exact text, `option.selected = true` was assigned, and
        // the manager still reported `getSelectedPresetName()` = "RecoveredRuins" while the row list showed
        // `Default` as `selected:true`. That is not a product defect: jQuery's `:selected` reads its own cached
        // selection state, and `presetManager.getSelectedPresetName()` is
        // `$(this.select).find('option:selected').text()` (public/scripts/preset-manager.js:399-401). Assigning the
        // DOM `selected` property does not refresh what jQuery sees, so the option LOOKED selected and the manager
        // read the old one. The frontend's own path is `option.prop('selected', true); $(select).val(value)
        // .trigger('change')` (`PresetManager.selectPreset`, :415-424), and `openai.js:4369` does the same with
        // `.prop('selected', true)`. Both lines below are that path, so the leg drives the mechanism the page uses
        // instead of a DOM operation that happens to look equivalent.
        if (window.jQuery) {
            const $select = window.jQuery(select);
            $select.find(`option[value="${row.value}"]`).prop('selected', true);
            $select.val(String(row.value)).trigger('change');
        } else {
            // No jQuery on the page would itself be a finding, but the leg still drives SOMETHING and says which.
            option.selected = true;
            select.dispatchEvent(new Event('change', { bubbles: true }));
        }
        // THE CHANGE IS ASYNCHRONOUS (`onSettingsPresetChange` awaits a promise chain), so the wait is on the
        // PRODUCT's state -- the manager reporting the name -- rather than on a fixed delay.
        const deadline = Date.now() + 15000;
        let selectedName = manager.getSelectedPresetName();
        while (Date.now() < deadline && selectedName !== wanted) {
            await new Promise(resolve => setTimeout(resolve, 150));
            selectedName = manager.getSelectedPresetName();
        }
        const loaded = manager.getCompletionPresetByName(wanted);
        return {
            selected: selectedName === wanted,
            selectedName,
            rowValue: row.value,
            matchedBy: exact ? 'exact text' : 'trimmed text',
            selectionMechanism: window.jQuery ? 'jQuery prop+val+trigger(change), as PresetManager.selectPreset does' : 'DOM property + change event (no jQuery on the page)',
            // Read back what jQuery reports AFTER the change, so the failure that produced this fix can never be
            // ambiguous again: `domSelected` is the DOM's view, `jquerySelected` is the panel's.
            domSelected: [...select.options].filter(entry => entry.selected).map(entry => entry.text),
            jquerySelected: window.jQuery ? window.jQuery(select).find('option:selected').map((_, entry) => String(entry.text)).get() : null,
            rows: [...select.options].map(entry => ({ value: entry.value, text: String(entry.text), selected: entry.selected })),
            promptCount: (loaded?.prompts ?? []).length,
            hasResolveRow: (loaded?.prompt_order ?? []).some(group => (group.order ?? []).some(row => row.identifier === 'resolve_identity')),
            identityContent: (loaded?.prompts ?? []).find(prompt => prompt.identifier === 'resolve_identity')?.content ?? null,
            tavernHelperExtension: loaded?.extensions?.tavern_helper ?? null,
        };
    }, name);

    // THE SEND. Through the frontend's own controls and its own button. Records the page's own view of the chat's
    // variables alongside, so "the wire changed" can be attributed rather than merely observed.
    const send = async input => page.evaluate(async payload => {
        const script = await import('./script.js');
        const openai = await import('./scripts/openai.js');
        const power = await import('./scripts/power-user.js');
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
        set('#custom_api_url_text', payload.peerUrl);
        set('#custom_model_id', 'probe-model');
        set('#api_key_custom', 'probe-key');
        power.power_user.savingAfterComplete = true;
        // A NON-STREAMING REQUEST: the assertion is about the assembled body, and a default can flip between legs.
        openai.oai_settings.stream_openai = false;
        const context = window.SillyTavern.getContext();
        const before = (script.chat ?? []).length;
        const textarea = document.querySelector('#send_textarea');
        const button = document.querySelector('#send_but');
        if (!textarea || !button) return { error: 'send controls missing' };
        textarea.value = payload.input;
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        button.click();
        const deadline = Date.now() + 45000;
        let state = null;
        while (Date.now() < deadline) {
            const chat = script.chat ?? [];
            const userIndex = chat.findIndex((entry, position) => position >= before && entry?.is_user === true);
            const replied = userIndex >= 0 && chat.slice(userIndex + 1).some(entry => entry?.is_user === false);
            state = { chatLength: chat.length, userIndex, replied };
            if (replied) break;
            await new Promise(resolve => setTimeout(resolve, 250));
        }
        return {
            state,
            input: payload.input,
            chatId: context.getCurrentChatId ? context.getCurrentChatId() : (context.chatId ?? null),
            characterName: context.characters?.[context.characterId]?.name ?? null,
            selectedPreset: context.getPresetManager().getSelectedPresetName(),
            pageVariables: window.TavernHelper?.getVariables ? {
                chat: window.TavernHelper.getVariables({ type: 'chat' }),
                global: window.TavernHelper.getVariables({ type: 'global' }),
                character: window.TavernHelper.getVariables({ type: 'character' }),
                message: window.TavernHelper.getVariables({ type: 'message' }),
            } : null,
            extensionPromptKeys: Object.keys(context.extensionPrompts ?? {}),
        };
    }, { input, peerUrl });

    const VARIABLE_WRITES = {
        chatAlpha: [{ action: 'insert', scope: 'chat', values: { market_value: PROBE_MARKERS.first } }],
        chatBeta: [{ action: 'insert', scope: 'chat', values: { market_value: PROBE_MARKERS.second } }],
        chatDelete: [{ action: 'delete', scope: 'chat', path: 'market_value' }],
        global: [{ action: 'insert', scope: 'global', values: { role_signal: PROBE_MARKERS.global } }],
        character: [{ action: 'insert', scope: 'character', values: { char_scope_value: PROBE_MARKERS.charScope } }],
        nested: [{ action: 'insert', scope: 'chat', values: { market_object: { tier: PROBE_MARKERS.nested } } }],
        message: [{ action: 'message', messageId: 0, values: { message_value: PROBE_MARKERS.messageScope } }],
        injectDepth2: [{ action: 'inject', id: 'hv-probe-injection', depth: 2, role: 'user', content: `${PROBE_MARKERS.injection}-D2` }],
        uninject: [{ action: 'uninject', ids: ['hv-probe-injection'] }],
    };

    const applyWrites = async operations => page.evaluate(async ops => {
        const outcomes = [];
        for (const op of ops) {
            try {
                if (op.action === 'insert') {
                    window.TavernHelper.insertOrAssignVariables(op.values, { type: op.scope });
                    outcomes.push({ op, ok: true, after: window.TavernHelper.getVariables({ type: op.scope }) });
                } else if (op.action === 'delete') {
                    const result = window.TavernHelper.deleteVariable(op.path, { type: op.scope });
                    outcomes.push({ op, ok: true, deleteOccurred: result?.delete_occurred ?? null, variables: result?.variables ?? null });
                } else if (op.action === 'message') {
                    // THE MESSAGE SCOPE, HALF ONE: the extension must store and retrieve it inside the page.
                    window.TavernHelper.insertOrAssignVariables(op.values, { type: 'message', message_id: op.messageId });
                    const read = window.TavernHelper.getVariables({ type: 'message', message_id: op.messageId });
                    outcomes.push({ op, ok: true, stored: read });
                } else if (op.action === 'inject') {
                    const handle = window.TavernHelper.injectPrompts([{ id: op.id, position: 'in_chat', depth: op.depth, role: op.role, content: op.content }]);
                    const prompts = window.SillyTavern.getContext().extensionPrompts ?? {};
                    outcomes.push({ op, ok: true, hasUninject: typeof handle?.uninject === 'function', recorded: prompts[op.id] ?? null, keys: Object.keys(prompts) });
                } else if (op.action === 'uninject') {
                    window.TavernHelper.uninjectPrompts(op.ids);
                    const prompts = window.SillyTavern.getContext().extensionPrompts ?? {};
                    outcomes.push({ op, ok: true, stillPresent: op.ids.some(id => id in prompts), keys: Object.keys(prompts) });
                }
            } catch (error) {
                outcomes.push({ op, ok: false, error: String(error && error.message || error) });
            }
        }
        return outcomes;
    }, operations);

    const runCase = async (name, { writes = null, input }) => {
        const startedAt = Date.now();
        const applied = writes && writesVariables ? await applyWrites(writes) : null;
        const afterWrites = Date.now();
        const before = peer.requests.length;
        const sent = await send(input);
        const afterSend = Date.now();
        // BOUNDED WAIT ON THE PEER, not a sleep: the request either arrives or the case is a named failure.
        const deadline = Date.now() + 30000;
        while (Date.now() < deadline && peer.requests.length === before) await page.waitForTimeout(250);
        const afterArrival = Date.now();
        await page.waitForTimeout(600);
        await recorder.settled();
        const request = peer.requests[before] ?? null;
        const entry = {
            case: name,
            applied,
            sent,
            request: summarise(request),
            // PER-CASE COST, split so a leg that idles names the phase it idled in: the write, the send (which
            // includes the page's own generation round-trip), the wait for the peer, and the recorder settle.
            ms: { writes: afterWrites - startedAt, send: afterSend - afterWrites, peerWait: afterArrival - afterSend, settle: Date.now() - afterArrival, total: Date.now() - startedAt },
        };
        report.cases.push(entry);
        return entry;
    };

    // ---- boot, card, chat one ------------------------------------------------------------------------------
    const boot = await openPage();
    phase('page-loaded');
    step('page-loaded', boot?.settingsReady === true, 'script.js settingsReady');
    const opened = await openCard();
    phase('card-opened');
    step('card-opened', opened?.opened === true && (opened.messages ?? 0) > 0, JSON.stringify(opened));
    report.provenance.chatOne = opened;
    timings.notes.push('card-opened is the FIRST place a pinned-install delay can show: the frontend reads the character list at startup, so a card staged after boot is invisible and this phase then burns its full 60 s bound.');

    if (afterRestart) {
        // THE RESTART LEG: the tree is the one the previous process wrote. Only the two halves of the CLAIM are
        // re-asserted -- the resolved value on the wire, and the value still on disk -- plus the injection, because
        // injection is page state and is NOT expected to survive a restart (the artefact says so).
        const selection = await selectPreset(TARGET_PRESET_NAME);
        step('restart-trio-selected', selection?.selected === true && selection.hasResolveRow === true, JSON.stringify(selection));
        const persisted = await runCase('restart-chat-value', { input: 'HV_INPUT_RESTART' });
        report.cases.at(-1).diskBeforeCase = { chats: await readChatRecords(dataRoot), settings: await readSettingsFile(dataRoot), card: await readCardStance(dataRoot) };
        const injectAfterRestart = await runCase('restart-inject', { writes: VARIABLE_WRITES.injectDepth2, input: 'HV_INPUT_RESTART_INJECT' });
        report.restart = {
            selection,
            cases: report.cases.map(entry => entry.case),
            expectation: 'injection is page state (extension_prompts) and is NOT expected to survive a new server process; the variable halves ARE',
            persistedWireHasValue: null,
            injectAfterRestart: Boolean(injectAfterRestart.request),
        };
    } else {
        // ---- B: the READY probe, whose capture teaches the leg the body's shape ----------------------------
        //
        // ASSERT THE EFFECT, NOT THE ACTION. `selectPreset` dispatches `change` and then reads the MANAGER's live
        // identity back (`getSelectedPresetName()`), so a future refactor of `onSettingsPresetChange` cannot leave
        // this leg dispatching into silence while an option merely LOOKS selected -- which would make every later
        // capture a measurement of the wrong preset, with no failure. The step name is the failure a reader needs.
        const readySelection = await selectPreset(READY_PROBE_NAME);
        step('ready-preset-selected', readySelection?.selected === true
            && readySelection?.selectedName === READY_PROBE_NAME, JSON.stringify(readySelection));
        if (readySelection?.selected !== true || readySelection?.selectedName !== READY_PROBE_NAME) {
            throw new Error(`preset-selection-did-not-take: asked for ${READY_PROBE_NAME}, the manager reports ${JSON.stringify(readySelection?.selectedName)}; attempted via ${readySelection?.matchedBy ?? 'no match'} over ${JSON.stringify(readySelection?.rows ?? readySelection?.reason ?? null)}`);
        }
        phase('ready-preset-selected');
        const ready = await runCase('ready', { input: 'HV_INPUT_READY' });
        phase('ready-sent');
        report.units = identifyUnits(ready.request);
        step('ready-provider-reached', Boolean(ready.request), `${peer.requests.length} request(s) at the peer`);
        step('capture-shape-identified', report.units !== null, JSON.stringify(report.units));
        if (report.units === null) throw new Error('the READY probe produced a body whose prompt shape this leg does not recognise, so no variable assertion could be written against it');

        const trioSelection = await selectPreset(TARGET_PRESET_NAME);
        step('trio-selected', trioSelection?.selected === true
            && trioSelection?.selectedName === TARGET_PRESET_NAME
            && trioSelection.hasResolveRow === true, JSON.stringify(trioSelection));
        if (trioSelection?.selected !== true || trioSelection?.selectedName !== TARGET_PRESET_NAME) {
            throw new Error(`preset-selection-did-not-take: asked for ${TARGET_PRESET_NAME}, the manager reports ${JSON.stringify(trioSelection?.selectedName)}`);
        }
        // THE TRIO MUST BE THE PRESET THE REQUESTS CARRY, and that is a different fact from "the manager says so": the
        // one ROW this leg added has to be in the group the frontend reads, or the identity prompt never reaches the
        // wire and every variable case would compare bodies that differ for some other reason. This is the
        // precondition that makes the rest of the drive attributable, so it is a step, not a comment.
        phase('trio-preset-selected');
        step('trio-row-is-live', trioSelection.hasResolveRow === true && typeof trioSelection.identityContent === 'string' && trioSelection.identityContent.includes('{{getvar::market_value}}'),
            JSON.stringify({ hasResolveRow: trioSelection?.hasResolveRow, identityContent: trioSelection?.identityContent ?? null, promptCount: trioSelection?.promptCount ?? null }));
        report.provenance.trio = trioSelection;

        // ---- C..H: the variable cases ------------------------------------------------------------------
        await runCase('chat-alpha', { writes: VARIABLE_WRITES.chatAlpha, input: 'HV_INPUT_ALPHA' });
        await runCase('chat-beta', { writes: VARIABLE_WRITES.chatBeta, input: 'HV_INPUT_BETA' });
        await runCase('chat-deleted', { writes: VARIABLE_WRITES.chatDelete, input: 'HV_INPUT_DELETE' });
        await runCase('global-set', { writes: VARIABLE_WRITES.global, input: 'HV_INPUT_GLOBAL' });
        await runCase('character-set', { writes: VARIABLE_WRITES.character, input: 'HV_INPUT_CHAR' });
        await runCase('nested-set', { writes: VARIABLE_WRITES.nested, input: 'HV_INPUT_NESTED' });
        await runCase('message-set', { writes: VARIABLE_WRITES.message, input: 'HV_INPUT_MESSAGE' });

        // ---- I: injection at three depths, then uninject -----------------------------------------------
        await runCase('inject-d2', { writes: VARIABLE_WRITES.injectDepth2, input: 'HV_INPUT_INJECT_D2' });
        await runCase('inject-d0', { writes: [{ action: 'inject', id: 'hv-probe-injection', depth: 0, role: 'user', content: `${PROBE_MARKERS.injection}-D0` }], input: 'HV_INPUT_INJECT_D0' });
        await runCase('inject-d1', { writes: [{ action: 'inject', id: 'hv-probe-injection', depth: 1, role: 'system', content: `${PROBE_MARKERS.injection}-D1` }], input: 'HV_INPUT_INJECT_D1' });
        await runCase('uninject', { writes: VARIABLE_WRITES.uninject, input: 'HV_INPUT_UNINJECT' });

        // ---- J: a SECOND chat must not see chat one's value --------------------------------------------
        // A user's path to another chat on the same card: the New Chat control (`#option_start_new_chat`,
        // public/script.js:11612-11627 -> doNewChat `:10618`). It names the new chat and saves it, which is also
        // what makes the second chat's file exist for the comparator to read.
        const newChat = await page.evaluate(async () => {
            const script = await import('./script.js');
            try {
                await script.doNewChat({ deleteCurrentChat: false });
            } catch (error) {
                return { ok: false, error: String(error && error.message || error) };
            }
            const deadline = Date.now() + 30000;
            let state = null;
            while (Date.now() < deadline) {
                const context = window.SillyTavern.getContext();
                state = {
                    chatId: context.getCurrentChatId ? context.getCurrentChatId() : (context.chatId ?? null),
                    chatLength: (context.chat ?? []).length,
                    chatVariables: window.TavernHelper.getVariables({ type: 'chat' }),
                    selectedPreset: context.getPresetManager().getSelectedPresetName(),
                };
                if (String(state.chatId ?? '').endsWith('.jsonl') || (state.chatLength ?? 0) >= 1) break;
                await new Promise(resolve => setTimeout(resolve, 250));
            }
            return { ok: true, state };
        });
        report.provenance.chatTwo = newChat;
        step('chat-two-opened', newChat?.ok === true && newChat.state?.chatId !== opened?.chatId, JSON.stringify(newChat));
        await runCase('chat-two', { input: 'HV_INPUT_CHAT_TWO' });
        // ...and chat two's OWN value, so the third read is "the right value came back", not merely "no value".
        await runCase('chat-two-set', { writes: [{ action: 'insert', scope: 'chat', values: { market_value: PROBE_MARKERS.chatTwo } }], input: 'HV_INPUT_CHAT_TWO_SET' });

        report.disk = {
            chats: await readChatRecords(dataRoot),
            settings: await readSettingsFile(dataRoot),
            card: await readCardStance(dataRoot),
            presets: await readPresetStance(dataRoot, [READY_PROBE_NAME, TARGET_PRESET_NAME]),
            requests: recorder.requests.filter(entry => /\/api\/(chats|characters|settings|presets)/.test(entry.pathAndQuery ?? '')).map(entry => `${entry.method} ${entry.pathAndQuery} ${entry.status}`),
        };

        // ---- K: a FRESH PAGE over the same process ------------------------------------------------------
        const reloadBoot = await openPage();
        const reloadOpen = await openCard();
        const reloadSelection = await selectPreset(TARGET_PRESET_NAME);
        // The fresh page reopens the card's chat: whichever chat that is, the point is that a value written by the
        // PREVIOUS page is still resolvable from what the chat FILE says.
        await runCase('reload-chat-value', { input: 'HV_INPUT_RELOAD' });
        report.reload = { boot: reloadBoot, open: reloadOpen, selection: reloadSelection, caseName: 'reload-chat-value' };
        report.diskAfterReload = {
            chats: await readChatRecords(dataRoot),
            settings: await readSettingsFile(dataRoot),
            card: await readCardStance(dataRoot),
        };
        report.treeHash = await hashTree(dataRoot, { skip: ['tokenizers/'] });
    }
    step('drive-completed', true, `${report.cases.length} case(s) captured`);
} catch (error) {
    report.failure = report.failure ?? String(error?.stack ?? error);
} finally {
    // TEARDOWN IS A MEASURED PHASE, because it runs OUTSIDE every other timing and a browser that takes minutes to
    // close would otherwise look like a slow drive. This is also why the timings are pushed BEFORE the close: a
    // `process.exit` after a wedged close would lose the breakdown that explains the wedge.
    const teardownStart = Date.now();
    if (browser) {
        const closeStart = Date.now();
        await browser.close();
        timings.phases.push({ phase: 'browser-close', ms: Date.now() - closeStart });
    }
    await peer.close();
    timings.phases.push({ phase: 'peer-close', ms: Date.now() - teardownStart });
    server?.kill();
}

try {
    await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
} catch (writeError) {
    console.error(`could not write ${reportPath}: ${writeError && writeError.message || writeError}`);
    process.exitCode = 1;
}

console.log(JSON.stringify({
    subject: report.subject,
    variant: report.variant,
    afterRestart: report.afterRestart,
    failure: report.failure,
    units: report.units,
    // THE FIXTURE, because a leg whose card and preset identity are not in its own summary cannot be diagnosed from
    // the log it produced -- which is exactly what happened in run 40451801982: `card-opened` was green while the
    // manager reported a character-derived preset name, and the log could not say WHICH card was opened.
    card: report.provenance?.chatOne?.matched ?? null,
    openedCharacter: report.provenance?.chatOne ?? null,
    trio: report.provenance?.trio ? { selected: report.provenance.trio.selected, selectedName: report.provenance.trio.selectedName, hasResolveRow: report.provenance.trio.hasResolveRow, promptCount: report.provenance.trio.promptCount } : null,
    timings: report.timings ? report.timings.phases : null,
    cases: report.cases.map(entry => ({ case: entry.case, sha256: entry.request?.sha256 ?? null, bytes: entry.request?.byteLength ?? null, arrived: Boolean(entry.request), ms: entry.ms ?? null })),
    steps: report.steps.map(item => `${item.ok === null ? 'n/a' : item.ok ? 'ok' : 'FAIL'} ${item.name}`),
}, null, 2));
