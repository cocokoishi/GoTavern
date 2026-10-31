// DO é…’é¦†åŠ©æ‰‹'s VARIABLES REACH THE FINAL PROVIDER REQUEST -- the NARROW vehicle.
//
// THE CLAIM, in one sentence and in the two halves that either alone cannot prove: a helper writes a variable, and
//   (i)  a prompt that reads it through the HOST macro engine resolves the value DURING GENERATION so the resolved
//        text is in the captured provider request bytes;
//   (ii) the value is still readable FROM DISK after a fresh page and after a NEW server process.
// (i) alone is satisfied by a page-only write that is never saved; (ii) alone by a write no prompt can read.
//
// WHY THIS FILE EXISTS, stated as the record the lead asked for: THE UI-SELECT VEHICLE WAS ATTEMPTED FIRST AND COST
// FOUR REDS, ALL IN THE VEHICLE; THE CLAIM DOES NOT REQUIRE IT.
//   Browser differential 40445034876  card-opened           -- card matched by a field the template does not set
//   Browser differential 40451801982  ready-preset-selected -- card staged after the frontend read the character list
//   Browser differential 40457217583  ready-preset-selected -- DOM `selected` property vs jQuery's cached selection
//   (source-diagnosed, unfixed)       ready-preset-selected -- manager resolved by ambient `main_api`, not the openai
//                                                              select (preset-manager.js:76-96 + st-context.js:288)
// Every one was the vehicle. The claim needs ONE variable, ONE prompt that reads it, and ONE generation; a derived
// three-prompt preset, a staged card, a UI `<select>` and a manager lookup are all machinery the claim never named.
// The UI vehicle is KEPT as the SECOND probe for the `preset` scope only (a preset-scoped variable has no meaning
// without a preset), and its header says it is the harder vehicle for the narrower purpose.
//
// THE MECHANISM, read from pinned source (SillyTavern 06bde939fb1e9c4c8d8641d810f0a916b5bce127), because this leg
// exercises it rather than assuming it:
//   `TavernHelper.generateRaw({ ordered_prompts: [{role, content}], user_input, max_chat_history: 0 })`
//     (extension N0VI028/JS-Slash-Runner@837a6288 src/function/generate/index.ts:407, GenerateRawConfig
//     src/function/generate/types.ts) drives the REAL assembly, so the request that reaches the peer is the product's
//     final provider request -- the same wire the generation leg already compares byte for byte.
//   The prompt content is expanded by the HOST macro engine, not by the extension:
//     public/scripts/macros/definitions/variable-macros.js:99-116   `getvar` -> ctx.variables.local.get(name)
//     public/scripts/st-context.js:258-279                           getContext().variables.local.get
//     public/scripts/variables.js:22-46                             reads chat_metadata.variables
//   An ABSENT variable resolves to '' -- public/scripts/variables.js:45 `(localVariable || '')` -- which is the
//   "absent form" the delete case asserts.
//
// KEPT FROM THE UI VEHICLE WITHOUT EXCEPTION (the lead's instruction, and they are green):
//   * the SIX REFUSAL CHECKS (extension pinned by commit + manifest; the API surface read from the installed source;
//     the two MEASURED absences, `setVariables` and the quiet option; the host macro surface);
//   * the pinned API-SURFACE RECORD with those two absences;
//   * `messageStoredNotSurfaced` as its OWN named row -- a finding about pinned, not a gap in this harness.
//
// WHAT THIS LEG DOES NOT DO, stated so no reader over-reads it: it does not drive a UI `<select>`, a card, or a
// chat switch (that is the second probe, and only for the `preset` scope); it does not stream; it does not use a real
// provider (AGENTS 22 -- a simulated peer is unverified for production, recorded in the artefact's `unproven`).
//
// OFFLINE: the peer binds 127.0.0.1. testingcf.jsdelivr.net is blocked and recorded, as in every helper leg.

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
import {
    buildTrio, readChatRecords, readCommittedPreset, readHelperApiSurface, readPresetStance, readSettingsFile,
    writeProbePresets, here, repoRoot, RESOLVE_IDENTIFIER, TARGET_PRESET_NAME,
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
// THE CONTROL. `off` writes NO variable: every capture must then equal the never-set form. A pair whose on and off
// captures are identical is HARNESS NON-DISCRIMINATING (rule 50).
const writesVariables = variant !== 'off';
const afterRestart = process.argv.includes('--after-restart');
const dataRoot = path.resolve(argumentValue('--data-root') ?? await fs.mkdtemp(path.join(process.env.TEMP ?? '/tmp', 'gotavern-hv-narrow-')));
const reportPath = path.resolve(argumentValue('--report', path.join(here, `helper-vars-${subject}-${variant}${afterRestart ? '-restart' : ''}.json`)));

const MARKERS = {
    first: 'HV-ALPHA-7c31',
    second: 'HV-BETA-9d42',
    global: 'HV-GLOBAL-e05f',
    message: 'HV-MESSAGE-1a88',
};
// THE CLAUSE the preset prompt carries, so the assertion is "the value arrived WHERE THE PRESET ASKED FOR IT", not
// "the token appears somewhere in the body" -- a body that merely echoes a stashed variable would satisfy the weaker
// form. The preset prompt itself is staged on disk as `HV-PRESET-CHAT={{getvar::hv_preset}}`, and `hv_preset` is the
// variable every case writes, because a preset prompt is a single fixed splice point: one variable name, several
// values, and the wire must show which value was live at generation time.
const PROMPTS = {
    chat: 'HV-PRESET-CHAT=',
    global: 'HV-PRESET-GLOBAL=',
    message: 'HV-PRESET-MESSAGE=',
};
const PRESET_VARIABLE = 'hv_preset';

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

/** The capture peer: records the request, answers a canned completion, defines nothing (rule 49). */
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
                id: `chatcmpl-hvn-${entry.at}`,
                object: 'chat.completion',
                created: 1730000000,
                model: 'probe-model',
                choices: [{ index: 0, message: { role: 'assistant', content: `HVN-REPLY-${entry.at}` }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            }));
        });
    });
    return new Promise((resolve, reject) => {
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, requests, close: () => new Promise(done => server.close(done)) }));
    });
}

const report = {
    schemaVersion: 1,
    question: 'Does a é…’é¦†åŠ©æ‰‹ variable resolve into the FINAL provider request during a real generateRaw, and is it still readable from disk after a fresh page and a new server process?',
    vehicle: 'narrow: one variable, one prompt that reads it through the host macro engine, one generateRaw per case. The UI-select vehicle was attempted first and cost four reds, all in the vehicle; the claim does not require it.',
    uiVehicleRedRuns: [
        { run: '40445034876', step: 'card-opened', mechanism: 'card matched by a field the template does not set (title lives on the inner .avatar)' },
        { run: '40451801982', step: 'ready-preset-selected', mechanism: 'card staged after the frontend read the character list' },
        { run: '40457217583', step: 'ready-preset-selected', mechanism: 'DOM selected property vs jQuery cached selection' },
        { run: '(source-diagnosed, unfixed)', step: 'ready-preset-selected', mechanism: 'manager resolved by ambient main_api, not the openai select' },
    ],
    subject,
    variant,
    afterRestart,
    provenance: {
        extension: { key: 'tavern-helper', name: pinnedExtension('tavern-helper').name, repo: pinnedExtension('tavern-helper').repo, commit: pinnedExtension('tavern-helper').commit },
        peer: 'in-process HTTP capture peer on 127.0.0.1; records the request, answers a canned completion; defines nothing (rule 49)',
        blockedExternal: [],
    },
    apiSurface: null,
    marks: MARKERS,
    prompts: PROMPTS,
    steps: [],
    cases: [],
    timings: { phases: [] },
    console: [],
    pageErrors: [],
    failure: null,
};

function step(name, ok, detail = null) {
    report.steps.push({ name, ok, detail });
    if (!ok && !report.failure) report.failure = `${name}: ${detail ?? 'failed'}`;
    return ok;
}

const timings = report.timings;
let phaseStart = Date.now();
const phase = label => {
    const now = Date.now();
    timings.phases.push({ phase: label, ms: now - phaseStart });
    phaseStart = now;
};

const peer = await startCapturePeer();
let server = null;
let browser = null;

function binaryPath() {
    const binarySetting = process.env.GOTAVERN_BINARY ?? '';
    return binarySetting ? path.resolve(binarySetting) : path.join(dataRoot, process.platform === 'win32' ? 'gotavern.exe' : 'gotavern');
}

function git(args, cwd) {
    return new Promise((resolve, reject) => {
        const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
        const output = [];
        child.stdout.on('data', chunk => output.push(chunk.toString()));
        child.stderr.on('data', chunk => output.push(chunk.toString()));
        child.on('error', reject);
        child.on('close', code => (code === 0
            ? resolve(output.join('').trim())
            : reject(new Error(`git ${args.join(' ')} exited ${code}\n${output.join('').slice(-2000)}`))));
    });
}

/**
 * A RECORDED FAILURE MUST NOT CARRY A HOST PATH, even when it fails.
 *
 * MEASURED IN 40878005589: `tools/verify-browser-comparisons.mjs` refused the fresh artefact on
 * `records a host-derived address matching /\/home\//`, and the match was the pinned restart leg's REFUSAL message --
 * `/home/runner/work/_temp/.../JS-Slash-Runner is at e71c9906..., not the pinned ...`, plus its `file:///home/...`
 * stack frames. The refusal is a real, useful observation; the RUNNER'S PATH inside it is not part of the product and
 * belongs to the run that produced it. Both carriers are normalised here (this file owns the two roots): the DATA ROOT
 * and the REPO ROOT become markers, keeping the file and line that make the message actionable.
 *
 * A STACK FRAME INSIDE A DEPENDENCY has neither root, so the fallback is deliberately NARROW -- only the absolute
 * roots that are host-specific (`/home`, `/Users`, `/tmp`, ...), a Windows drive, and `file://` URLs. A broad
 * "replace anything that starts with a slash" rule would rewrite `/api/settings/save` into a marker and destroy the
 * message it was supposed to keep.
 */
function neutraliseHostPaths(text) {
    let out = String(text ?? '');
    const slash = value => String(value ?? '').split(path.sep).join('/');
    for (const [root, marker] of [[repoRoot, '<repo>'], [dataRoot, '<data-root>']]) {
        if (!root) continue;
        for (const form of [root, slash(root), `file:///${slash(root)}`]) {
            if (form) out = out.split(form).join(marker);
        }
    }
    out = out.replace(/(?<![A-Za-z])[A-Za-z]:[\\/][^\s"'`)<>]*/g, '<host-path>');
    out = out.replace(/file:\/\/\/[^\s"'`)<>]*/g, '<host-path>');
    out = out.replace(/\/(?:home|Users|root|tmp|var|opt|mnt|runner|workspace|builds|github)(?:\/[^\s"'`)<>]*)?/g, '<host-path>');
    return out;
}

/**
 * THE GENERATION SCRIPT, run INSIDE the extension's own script iframe. It is the only thing this leg installs, and it
 * uses the extension's own API: `replaceScriptTrees` to exist at all, `insertOrAssignVariables` to write,
 * `getVariables` to read back, and `generateRaw` to drive the real assembly.
 *
 * TWO THINGS THIS SCRIPT MUST NOT CONTAIN, because it is built from an array of STRING LITERALS:
 *   1. a `//` or `/*` line of explanation. A line inside this array is literal text in the generated module, so a
 *      comment here becomes a stray slash inside the user script and the module dies on a syntax error -- a failure
 *      that would present as "no __hvnDone" and look like a product or driver defect. ALL commentary lives above the
 *      array. This was a real defect in the first version of this file (two comment blocks sat inside the array) and
 *      `node --check` cannot see it: it reads the OUTER module only. `check-script.cjs` during development joins the
 *      literals and parses the result, which is the only local check that can catch it.
 *   2. a literal `</script>` or an unescaped backtick: the module the extension generates embeds this text.
 *
 * A NAMED MECHANISM, used inside the script below. `TavernHelper.substitudeMacros(text)` is the extension's own
 * passthrough to the host's `substituteParamsExtended` (src/function/util.ts:9-11 -> public/script.js:2815 ->
 * `substituteParams` :2981 -> `MacroEngine.evaluate`), exposed on TavernHelper at src/function/index.ts:437, and it
 * takes ONE argument. Calling it on the SAME string the prompt carries gives the pre-/post-substitution pair this leg
 * reports, which separates "the value is on the wire" (the claim) from "the macro resolved it" (the inference).
 *
 * AND THE PAIR IS RECORDED PER CASE, for the same reason: `renderedWithMacroEngine` is the host's own substitution
 * called on the same string the prompt carries, so a reader can compare it with what the body actually contains. If
 * the body carries the RAW `{{getvar::...}}` form, the macro did NOT run and the value came from somewhere else; if
 * it carries what `renderedWithMacroEngine` produced, the difference the macro made is visible instead of asserted.
 *
 * A THROWING CASE MUST NOT ABORT THE SCRIPT (measured in Browser differential 40460818792). Case 5, a message-scoped
 * write with `message_id: 0` on a chat with ZERO messages, threw out of the op loop, so every later case never ran and
 * each remaining capture was assigned to the wrong case name -- which is how one set of requests came to be reported
 * as two subjects disagreeing. Each op is therefore tried individually and a throw is RECORDED (`refusedBy`), because
 * a refusal is a FACT about the pinned version: `src/function/variables.ts:58-63` bounds `message_id` to
 * `(-chat.length, chat.length)`, so on an empty chat no index is valid, and "both subjects refuse identically" is the
 * parity claim for that case.
 */
const SCRIPT = [
    'const cfg = window.parent.__hvn;',
    'const out = { cases: [], error: null };',
    // THE RUN ID IS HOW THE DRIVER TELLS A FRESH EXECUTION FROM A STALE ONE. A script tree saved by
    // `replaceScriptTrees` is re-activated on the NEXT page load, before the driver has put its payload back into
    // `window.parent.__hvn`, so on the reload a STALE iframe can carry a `__hvnDone` whose `cases` list is empty and
    // whose only trace is `Cannot read properties of undefined (reading "cases")`. Measured on this host: the reload
    // case then produced NO capture while `script-completed` stayed green. `null` here is itself the diagnosis: the
    // iframe ran without the payload.
    'out.runId = (cfg && cfg.runId) || null;',
    'const record = (name, extra) => out.cases.push(Object.assign({ name }, extra));',
    'const taThelperSubstitute = text => (typeof TavernHelper?.substitudeMacros === "function"',
    '  ? TavernHelper.substitudeMacros(text)',
    '  : "UNAVAILABLE: TavernHelper.substitudeMacros is not a function at this revision");',
    'try {',
    '  const api = {',
    '    getVariables: typeof TavernHelper?.getVariables === "function",',
    '    insertOrAssignVariables: typeof TavernHelper?.insertOrAssignVariables === "function",',
    '    deleteVariable: typeof TavernHelper?.deleteVariable === "function",',
    '    generateRaw: typeof TavernHelper?.generateRaw === "function",',
    '    createChatMessages: typeof TavernHelper?.createChatMessages === "function",',
    '  };',
    '  out.api = api;',
    '  if (!api.getVariables || !api.insertOrAssignVariables || !api.generateRaw) {',
    '    out.error = "the pinned helper API this leg calls is not present: " + JSON.stringify(api);',
    '  } else {',
    '    const run = async (name, ops, prompt) => {',
    '      const applied = [];',
    '      let opError = null;',
    '      for (const op of ops) {',
    '        try {',
    '          if (op.kind === "insert") { TavernHelper.insertOrAssignVariables(op.values, { type: op.scope }); applied.push({ op: "insert", scope: op.scope, ok: true, after: TavernHelper.getVariables({ type: op.scope }) }); }',
    '          else if (op.kind === "delete") { const r = TavernHelper.deleteVariable(op.path, { type: op.scope }); applied.push({ op: "delete", scope: op.scope, ok: true, deleteOccurred: r?.delete_occurred ?? null, variables: r?.variables ?? null }); }',
    '          else if (op.kind === "message") { TavernHelper.insertOrAssignVariables(op.values, { type: "message", message_id: op.message_id }); applied.push({ op: "message", scope: "message", message_id: op.message_id, ok: true, stored: TavernHelper.getVariables({ type: "message", message_id: op.message_id }) }); }',
    '        } catch (e) {',
    '          opError = String(e && e.message || e);',
    '          applied.push({ op: op.kind, scope: op.scope || "message", ok: false, refusedBy: "pinned range check", error: opError });',
    '        }',
    '      }',
    '      let renderedWithMacroEngine = null;',
    '      let renderedError = null;',
    '      try {',
    '        renderedWithMacroEngine = taThelperSubstitute(prompt);',
    '      } catch (e) { renderedError = String(e && e.message || e); }',
    '      let reply = null; let error = null;',
    '      let readBack = null;',
    '      try {',
    '        reply = await TavernHelper.generate({',
    '          preset_name: cfg.presetName,',
    '          user_input: name,',
    '          max_chat_history: 0,',
    '          should_stream: false,',
    '          should_silence: true,',
    '        });',
    '        try {',
    '          const preset = TavernHelper.getPreset(cfg.presetName);',
    // READ BACK BY `id`, NOT `identifier`. `toPresetPrompt` (src/function/preset.ts:353) renames the file's
    // `identifier` to `id` on the way out, so a lookup on `identifier` returns null even when the prompt is present
    // -- measured in 40486762148, where `readBack` was null on all 23 cases for exactly this reason and looked like
    // "the preset does not carry the prompt" rather than "the reader used the file's field name on a projected object".
    '          const staged = (preset?.prompts ?? []).find(entry => entry.id === cfg.resolveIdentifier) ?? null;',
    '          readBack = staged ? { id: staged.id, content: staged.content, enabled: staged.enabled, role: staged.role } : null;',
    '        } catch (e) { readBack = { error: String(e && e.message || e) }; }',
    '      } catch (e) { error = String(e && e.message || e); }',
    '      record(name, { applied, opError, promptRaw: prompt, renderedWithMacroEngine, renderedError, readBack, reply: reply === null ? null : String(reply).slice(0, 120), error });',
    '    };',
    '    for (const item of cfg.cases) await run(item.name, item.ops, item.prompt);',
    '  }',
    '} catch (error) { out.error = String(error && error.message || error); }',
    'window.__hvnDone = out;',
].join('\n');

try {
    await fs.mkdir(dataRoot, { recursive: true });
    const installed = await ensurePinnedExtensionInstalled(dataRoot, pinnedExtension('tavern-helper'));
    report.provenance.extension.installedRevision = installed.revision;
    report.provenance.extension.installSource = installed.source ?? null;
    // THE PIN IS HELD BEFORE THE SERVER BOOTS, because the page's auto-update is what moved it (see
    // ensureFrozenOrigin in install-pinned-extension.mjs).
    // THIS IS THE START-OF-DRIVE ASSERTION the lead asked for: the git HEAD itself, not the API surface that
    // was read from the same tree. A leg that drifts here fails by name instead of measuring a different extension.
    const extensionRevisionAtStart = await git(['rev-parse', 'HEAD'], installed.extensionDirectory).catch(() => null);
    report.provenance.extension.pinnedAtDriveStart = {
        expected: pinnedExtension('tavern-helper').commit,
        atDriveStart: extensionRevisionAtStart,
        frozenOrigin: installed.frozen ?? null,
    };
    step('extension-pinned-at-drive-start', extensionRevisionAtStart === pinnedExtension('tavern-helper').commit,
        JSON.stringify(report.provenance.extension.pinnedAtDriveStart));

    // ---- THE SIX REFUSAL CHECKS, kept from the UI vehicle without exception ------------------------------
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
    step('host-macro-surface-present', apiSurface.host.macros?.present === true && apiSurface.host.variablesBinding === true,
        `macros=${apiSurface.host.macros?.file ?? null} declaresVariableMacros=${JSON.stringify(apiSurface.host.declaredVariableMacros ?? null)} variablesBinding=${apiSurface.host.variablesBinding}`);
    phase('refusals');

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
        server = spawn(binary, ['start', '--port', String(port), '--dataRoot', dataRoot, '--configPath', path.join(dataRoot, 'config.yaml')], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
        server.stdout.on('data', () => {});
        server.stderr.on('data', () => {});
        report.provenance.serverPid = server.pid ?? null;
    }
    // THE PINNED LEG'S PID COMES FROM THE WRAPPER, which owns that process (run-against-pinned.mjs exports it).
    // Without it, restartIsNewProcess was "Boolean(undefined) && ..." = FALSE on this subject for every recording.
    if (external) {
        report.provenance.serverPid = process.env.PROBE_SERVER_PID ? Number(process.env.PROBE_SERVER_PID) : null;
        report.provenance.serverPidSource = process.env.PROBE_SERVER_PID ? 'run-against-pinned.mjs (PROBE_SERVER_PID)' : null;
    }
    report.provenance.configFile = { path: 'config.yaml', sha256: legConfig?.sha256 ?? null, matchesSource: legConfig?.matchesSource ?? null };
    const baseURL = process.env.PROBE_BASE_URL ?? `http://127.0.0.1:${port}`;
    // THE SERVER INSTANCE THIS LEG TALKED TO, AS A DIGEST RATHER THAN A URL.
    //
    // MEASURED IN 40878005589: no PINNED leg recorded `provenance.serverPid` (the pinned server is booted by
    // run-against-pinned.mjs, not by this probe), so the comparator's `restartIsNewProcess` was
    // `Boolean(undefined) && …` = FALSE on the pinned subject for every recording -- a structural asymmetry no product
    // behaviour could clear, and half of the reason `survivesRestart` came out true on one subject and false on the
    // other. The probe cannot see that pid (the wrapper does not pass it), so it records the one identity it CAN see:
    // every invocation is served by its own server -- this probe allocates a port and spawns the binary for a GoTavern
    // leg, the wrapper allocates a port and spawns server.js for a pinned leg -- so a DIFFERENT endpoint means a
    // DIFFERENT SERVER INSTANCE, which is exactly the fact "a new process read this tree" needs. The URL is never
    // recorded, only a digest of it, so no host value reaches the artefact.
    report.provenance.serverEpoch = createHash('sha256').update(`server:${baseURL}`).digest('hex').slice(0, 16);
    await waitForServer(`${baseURL}/version`);
    phase('server-ready');
    report.provenance.serverVersion = await fetch(`${baseURL}/version`).then(response => response.json(), () => null);

    browser = await chromium.launch();
    const page = await browser.newPage();
    page.on('pageerror', error => report.pageErrors.push(String(error?.message ?? error).slice(0, 300)));
    page.on('console', message => report.console.push({ type: message.type(), text: String(message.text()).slice(0, 400) }));
    await page.route('**://testingcf.jsdelivr.net/**', route => {
        report.provenance.blockedExternal.push(route.request().url());
        return route.abort();
    });

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

    /**
     * POINT THE FRONTEND AT THE PEER, through its own controls. `generateRaw` still goes through the OpenAI
     * chat-completion path, so the connection has to be the custom endpoint; this is the same setup the proven
     * generation leg performs, and it is NOT the UI-select machinery the four reds were about.
     */
    const connect = async peerUrl => page.evaluate(async url => {
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
        openai.oai_settings.stream_openai = false;
        return {
            mainApi: script.main_api ?? null,
            source: openai.oai_settings.chat_completion_source ?? null,
            model: openai.oai_settings.custom_model ?? null,
            urlSet: String(openai.oai_settings.custom_url ?? '').includes('127.0.0.1'),
        };
    }, peerUrl);

    /**
     * THE MARKER MOVES TO A PRESET PROMPT, AND THIS IS WHY -- the finding that forced it.
     *
     * THREE substitution surfaces exist on the request path, and the narrow vehicle's first version used the ONE
     * that substitutes nothing:
     *
     *   1. chat history          -> generateRaw.ts:235  `prompt.content = substituteParams(prompt.content)`
     *   2. preset prompts via
     *      `generate()`         -> generate/index.ts:178-189, `toOrderedPrompt`/`toInChatPrompt` both do
     *                              `content: substitudeMacros(prompt.content!)` BEFORE generateRaw sees them
     *   3. caller-supplied
     *      `ordered_prompts`    -> generateRaw.ts:492-497, `Message.createAsync(source.role, source.content)` with
     *                              NO substituteParams anywhere
     *
     * Measured in 40466428732 and 40471775285: with the marker in surface 3, `applied.after` carried the value,
     * `renderedWithMacroEngine` resolved it, and the provider body still carried the literal `{{getvar::hv_chat}}`
     * on BOTH subjects with `mismatches=[]`. That is pinned behaviour, not a GoTavern defect -- but it also means
     * surface 3 cannot answer the claim. Surface 2 is where a real user's preset prompt lives, so the marker goes
     * there, and the vehicle stays at three moving parts: one variable, one preset prompt, one generation.
     *
     * THE PRESET IS A FILE ON DISK WRITTEN BEFORE BOOT. Not a `<select>`, not `getPresetManager()`, not a card:
     * four consecutive reds in this repo came from driving a preset selection through the UI (AGENTS rules 58 and
     * 63), and none of them was a product defect. The file is the input; `TavernHelper.getPreset(name)` is the
     * reader (`preset.ts:588`, `klona(toPreset(...))`, no selection side effects).
     */
    if (!afterRestart) {
        const committed = await readCommittedPreset();
        const presetDirectory = path.join(dataRoot, 'default-user', 'OpenAI Settings');
        const names = (await fs.readdir(presetDirectory).catch(() => [])).filter(name => name.endsWith('.json'));
        if (names.length === 0) throw new Error(`the leg tree has no chat-completion preset to derive from: ${presetDirectory}`);
        const stance = JSON.parse(await fs.readFile(path.join(presetDirectory, names[0]), 'utf8'));
        // ONE PROMPT CARRIES BOTH CLAUSES: the chat-scoped lookup AND the global-scoped one.
        //
        // MEASURED IN 40878005589, and it is why `guards.globalScopeReachesWire` was false on BOTH subjects. The
        // staged prompt carried ONLY `HV-PRESET-CHAT=`, while the global case's clause lived in the `prompt` string the
        // probe substitutes for itself (`renderedWithMacroEngine`) and NEVER SENDS -- `generate()` is called with
        // `preset_name`, so the wire content is the PRESET, not that string. A body can therefore never contain
        // `HV-PRESET-GLOBAL=<value>` no matter what the product does: a guard false on both subjects, and false for a
        // reason the driver created (AGENTS.md 10 -- the probe never drove a state a user can reach, because a user's
        // preset prompt CAN carry `{{getglobalvar::x}}`).
        //
        // THE ORDER IS PART OF THE ASSERTION, NOT TIDINESS. `deleteReturnsToEmptyForm` reads the deleted case's
        // rendered form with `endsWith('HV-PRESET-CHAT=')` -- the deleted chat clause must be the LAST thing in the
        // string, so the CHAT clause goes last. With it first, deleting the variable would leave the global clause
        // after it and that guard could never be satisfied while the global clause was present.
        const identity = `HV-PRESET-GLOBAL={{getglobalvar::hv_global}}|HV-PRESET-CHAT={{getvar::${PRESET_VARIABLE}}}`;
        const trio = buildTrio({ stance, readyMarker: 'hv-preset-ready', identity });
        report.fixture = {
            committedPreset: { file: committed.file, sha256: committed.sha256, byteLength: committed.byteLength },
            stance: { file: names[0], promptCount: (stance.prompts ?? []).length },
            identity,
            resolveIdentifier: RESOLVE_IDENTIFIER,
            trio: { group: trio.group, missingIdentifiers: trio.missingIdentifiers, replaced: trio.replaced },
        };
        report.fixture.files = await writeProbePresets(dataRoot, { trio: { name: TARGET_PRESET_NAME, document: trio.document } });
        const stanceAfter = await readPresetStance(dataRoot, [TARGET_PRESET_NAME]);
        const promptContents = stanceAfter[TARGET_PRESET_NAME]?.promptContents ?? {};
        report.fixture.afterWrite = { present: stanceAfter[TARGET_PRESET_NAME]?.present === true, identifiers: Object.keys(promptContents) };
        // ASSERT THE SPLICE LANDED IN THE FILE. A preset written but not carrying the marker is a leg that would
        // report "the macro did not substitute" for a file that never contained the macro at all.
        step('preset-prompt-staged', stanceAfter[TARGET_PRESET_NAME]?.present === true
            && String(promptContents[RESOLVE_IDENTIFIER] ?? '') === identity,
            JSON.stringify({ present: stanceAfter[TARGET_PRESET_NAME]?.present === true, identity, staged: promptContents[RESOLVE_IDENTIFIER] ?? null }));
    } else {
        const stanceAfter = await readPresetStance(dataRoot, [TARGET_PRESET_NAME]);
        const promptContents = stanceAfter[TARGET_PRESET_NAME]?.promptContents ?? {};
        report.fixture = { afterWrite: { present: stanceAfter[TARGET_PRESET_NAME]?.present === true, identifiers: Object.keys(promptContents) } };
        step('restart-tree-carries-the-preset', stanceAfter[TARGET_PRESET_NAME]?.present === true
            && String(promptContents[RESOLVE_IDENTIFIER] ?? '').includes(`{{getvar::${PRESET_VARIABLE}}}`),
            JSON.stringify({ present: stanceAfter[TARGET_PRESET_NAME]?.present === true, staged: promptContents[RESOLVE_IDENTIFIER] ?? null }));
    }

    const boot = await openPage();
    step('page-loaded', boot?.settingsReady === true, 'script.js settingsReady');
    phase('page-loaded');
    const connection = await connect(`http://127.0.0.1:${peer.port}/v1`);
    step('connection-configured', connection?.source === 'custom' && connection?.urlSet === true && connection?.mainApi === 'openai', JSON.stringify(connection));

    // THE `message` SCOPE NEEDS A NON-EMPTY CHAT, AND THAT IS A PINNED FACT THIS LEG RECORDS.
    //
    // Measured in Browser differential 40460818792: `insertOrAssignVariables({...}, {type:'message', message_id: 0})`
    // on a chat with ZERO messages throws `æä¾›çš„æ¶ˆæ¯æ¥¼å±‚å· '0' è¶…å‡ºäº†èŒƒå›´ [0, 0)`, because the pinned bound is
    // `_.inRange(option.message_id, -chat.length, chat.length)` (src/function/variables.ts:58-63) and with
    // `chat.length === 0` NO index is valid. That is pinned behaving CORRECTLY, so the leg does two things:
    //   1. seeds ONE message through the helper's own `createChatMessages`, so the scope has a valid index and the
    //      stored/not-surfaced row can be measured rather than refused;
    //   2. records whether the seed succeeded (`chatSeeded`), because if it did not, a refusal is the honest result
    //      and the case must not throw its way through the rest of the script.
    const chatSeed = await page.evaluate(async () => {
        try {
            const before = (window.SillyTavern.getContext().chat ?? []).length;
            if (typeof TavernHelper?.createChatMessages === 'function' && before === 0) {
                await TavernHelper.createChatMessages([{ role: 'system', message: 'HV-SEED-MESSAGE' }], { type: 'normal' });
            }
            return { ok: (window.SillyTavern.getContext().chat ?? []).length > 0, before, after: (window.SillyTavern.getContext().chat ?? []).length };
        } catch (error) {
            return { ok: false, error: String(error && error.message || error), before: null, after: null };
        }
    });
    report.chatSeed = chatSeed;
    step('chat-seeded-for-message-scope', chatSeed?.ok === true,
        JSON.stringify(chatSeed) + ' -- the message scope needs a non-empty chat: src/function/variables.ts:58-63 bounds message_id to (-chat.length, chat.length), so on an empty chat every message-scoped write is refused');
    // The LAST message is the valid index whether or not the seed ran: on an empty chat this write is REFUSED by the
    // pinned range check, which the script now records instead of throwing.
    const messageId = 0;

    // THE CASES. Each is ONE variable operation followed by ONE generateRaw whose prompt reads that variable.
    const chatPrompt = `${PROMPTS.chat}{{getvar::${PRESET_VARIABLE}}}`;
    const globalPrompt = `${PROMPTS.global}{{getglobalvar::hv_global}}`;
    const messagePrompt = `${PROMPTS.message}{{getvar::hv_message}}`;
    const cases = afterRestart ? [
        // THE RESTART LEG WRITES NOTHING. It is the ONLY case set that may not, and the earlier version of this file
        // got that wrong in the most expensive way available: it ran the SAME `writesVariables` list, so its
        // `chat-alpha` RE-WROTE `hv_preset` before generating and `survivesRestart` came out true because the leg had
        // just written the value, not because the tree carried it. MEASURED in 40878005589: every restart case's
        // sha256 EQUALS the on-leg's (`chat-alpha` b82308a7…, `chat-beta` 52ba205d…, …) -- the same drive, twice.
        // A guard satisfied by the leg's own write is a green that cannot fail (AGENTS.md 7). So a restart leg is ONE
        // read-only generation whose prompt is the preset's own, and the only value it can resolve is the one the NEW
        // PROCESS reads off the disk the previous process left.
        { name: 'reload-chat', ops: [], prompt: chatPrompt },
    ] : writesVariables ? [
        { name: 'chat-alpha', ops: [{ kind: 'insert', scope: 'chat', values: { [PRESET_VARIABLE]: MARKERS.first } }], prompt: chatPrompt },
        { name: 'chat-beta', ops: [{ kind: 'insert', scope: 'chat', values: { [PRESET_VARIABLE]: MARKERS.second } }], prompt: chatPrompt },
        { name: 'chat-deleted', ops: [{ kind: 'delete', scope: 'chat', path: PRESET_VARIABLE }], prompt: chatPrompt },
        { name: 'global-set', ops: [{ kind: 'insert', scope: 'global', values: { hv_global: MARKERS.global } }], prompt: globalPrompt },
        // THE `message` SCOPE AS ITS OWN ROW: it stores and reads back inside the page, and the wire must NOT carry
        // it, because no host macro consults a message scope (recorded by the refusal check above).
        { name: 'message-set', ops: [{ kind: 'message', message_id: messageId, values: { hv_message: MARKERS.message } }], prompt: messagePrompt },
    ] : [
        // THE OFF CONTROL: the same prompts, no writes. Every capture must equal the never-set form.
        { name: 'chat-alpha', ops: [], prompt: chatPrompt },
        { name: 'chat-deleted', ops: [], prompt: chatPrompt },
        { name: 'global-set', ops: [], prompt: globalPrompt },
        { name: 'message-set', ops: [], prompt: messagePrompt },
    ];
    report.plannedCases = cases.map(entry => entry.name);

    // THE SCRIPT RUNS IN THE EXTENSION'S OWN IFRAME, through the helper's own API, exactly as the render and
    // generation legs do -- so what is captured is the request the helper produced, not one this harness built.
    //
    // A FRESH IDENTITY PER RUN, AND A RUN ID THE DRIVER WAITS FOR. A tree installed by `replaceScriptTrees` is SAVED
    // and re-activated on the next page load, which happens BEFORE `window.parent.__hvn` is set again -- so on the
    // reload the extension executes the previous tree with no payload. Measured on this host (Windows, same drive
    // otherwise byte-identical to CI: every case sha matched): the reload leg recorded
    // `{"cases":[],"error":"Cannot read properties of undefined (reading 'cases')"}` and produced NO capture, while
    // `reload-page-loaded` stayed green because the driver accepted any `__hvnDone` it found. Re-adding a tree with
    // the SAME id and content does not recreate the iframe, so the stale result was read forever. Two changes:
    // the id carries a per-run nonce (a new tree, therefore a new iframe, therefore a real execution), and the poll
    // only accepts a `__hvnDone` whose `runId` is THIS run's.
    let scriptRunCounter = 0;
    const runScript = async list => {
        const before = peer.requests.length;
        scriptRunCounter += 1;
        const payload = { runId: `gotavern-hv-narrow-${scriptRunCounter}`, content: SCRIPT, cases: list, presetName: TARGET_PRESET_NAME, resolveIdentifier: RESOLVE_IDENTIFIER };
        await page.evaluate(item => {
            window.__hvn = item;
            window.TavernHelper.replaceScriptTrees([{
                type: 'script',
                enabled: true,
                name: item.runId,
                id: item.runId,
                content: item.content,
                button: { enabled: false, buttons: [] },
            }], { type: 'global' });
        }, payload);
        const deadline = Date.now() + 120000;
        let done = null;
        let stale = null;
        while (Date.now() < deadline) {
            const found = await page.evaluate(() => Array.from(document.querySelectorAll('iframe')).map(item => {
                try {
                    return item.contentWindow?.__hvnDone ?? null;
                } catch {
                    return null;
                }
            }).filter(Boolean));
            // PREFER THE MATCHING RUN: a stale iframe must never be read as this run's result, and must never be
            // silently ignored either -- it is kept as `stale` so a driver defect names itself.
            done = found.find(item => item.runId === payload.runId) ?? null;
            if (done) {
                stale = found.find(item => item.runId !== payload.runId) ?? null;
                break;
            }
            stale = found.find(item => item.runId !== payload.runId) ?? stale;
            await new Promise(resolve => setTimeout(resolve, 250));
        }
        return { done, stale, runId: payload.runId, requests: peer.requests.slice(before) };
    };

    /**
     * WHICH CASE DOES THIS REQUEST BELONG TO? BY WHAT IT SAYS, NOT BY WHERE IT SITS.
     *
     * Measured in Browser differential 40460818792: the two subjects' capture digests were EQUAL AS A MULTISET but
     * shifted by one slot (`chat-alpha` = the 0-byte body on GoTavern and 239 B on pinned; `chat-beta` the exact
     * reverse). That is not two subjects disagreeing -- it is one set of requests assigned to the wrong case names,
     * i.e. an ACCOUNTING defect. The cause was an `requests[index]` mapping combined with a case that threw and
     * truncated the run, so every later index slid.
     *
     * THE ACCOUNTING IS NOW DERIVED FROM THE REQUEST ITSELF. Every `generateRaw` in this leg passes the CASE NAME as
     * `user_input`, which the host puts on the wire as the last user message, so each captured body names its own
     * case. A capture whose name matches no case is recorded as unmatched rather than silently becoming some case's
     * evidence, and two captures claiming one case is a harness failure by name -- both are facts a positional map
     * could never express.
     */
    const attributeRequests = (requests, list) => {
        const names = new Set(list.map(entry => entry.name));
        const byCase = new Map();
        const unmatched = [];
        for (const request of requests) {
            let matched = null;
            for (const name of names) {
                // The name is the user_input, so it appears as a whole message content. Match it as a token to avoid
                // `chat-alpha` claiming `chat-alphabet`: the boundary is the JSON string terminator or a quote.
                if (new RegExp(`"content"\\s*:\\s*"${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`).test(String(request?.body ?? ''))) {
                    matched = name;
                    break;
                }
            }
            if (matched === null) {
                unmatched.push({ path: request?.path ?? null, byteLength: request?.byteLength ?? null, sha256: request?.sha256 ?? null });
                continue;
            }
            if (byCase.has(matched)) byCase.set(matched, [...byCase.get(matched), request]);
            else byCase.set(matched, [request]);
        }
        return {
            byCase,
            unmatched,
            collisions: [...byCase.entries()].filter(([, list]) => list.length > 1).map(([name]) => name),
        };
    };

    const run = await runScript(cases);
    phase('cases-run');
    report.script = run.done;
    step('script-completed', Boolean(run.done) && !run.done?.error, run.done?.error ?? 'no __hvnDone on any iframe');
    if (run.done?.api) step('helper-api-present', Object.values(run.done.api).every(Boolean), JSON.stringify(run.done.api));

    // ONE CAPTURE PER CASE, in order, because each generateRaw is awaited inside the script.
    //
    // EACH CASE CARRIES THE MECHANISM TRIPLE, so "the macro resolved it" is a comparison a reader can make rather
    // than an inference they must trust: `promptRaw` is the string the prompt carried (`HV-READ-CHAT={{getvar::x}}`),
    // `renderedWithMacroEngine` is the host's own substitution of that string, and `request.body` is what the provider
    // received. If the body contains the raw `{{getvar::...}}` form the macro did NOT run; if it contains what
    // `renderedWithMacroEngine` produced, the macro's contribution is visible as the difference between the first two.
    const attribution = attributeRequests(run.requests, cases);
    report.attribution = {
        unmatched: attribution.unmatched,
        collisions: attribution.collisions,
        mechanism: 'each capture names its own case: generateRaw passes the case name as user_input, so the body carries it as a message content and no positional index is involved',
    };
    report.cases = cases.map(entry => {
        const scripted = (run.done?.cases ?? []).find(item => item.name === entry.name) ?? null;
        const captured = attribution.byCase.get(entry.name) ?? [];
        return {
            case: entry.name,
            applied: scripted?.applied ?? null,
            opError: scripted?.opError ?? null,
            promptRaw: scripted?.promptRaw ?? null,
            renderedWithMacroEngine: scripted?.renderedWithMacroEngine ?? null,
            renderedError: scripted?.renderedError ?? null,
            reply: scripted?.reply ?? null,
            error: scripted?.error ?? null,
            captureCount: captured.length,
            request: summarise(captured[0] ?? null),
        };
    });
    // A CASE WITH NO CAPTURE IS A DRIVE FACT, NOT A VARIABLE RESULT, and a case with TWO is an accounting failure.
    // Both are named, because a positional map could express neither and that is exactly how 40460818792 shifted.
    step('one-capture-per-case', report.cases.every(entry => entry.captureCount === 1),
        report.cases.map(entry => `${entry.case}:${entry.captureCount}`).join(',') + ` unmatched=${attribution.unmatched.length} collisions=${attribution.collisions.length}`);
    // EVERY CASE MUST CARRY ITS MECHANISM TRIPLE. A case without `promptRaw` cannot be read as evidence for the
    // macro mechanism at all, so a missing one is a harness failure rather than a quiet null in the artefact.
    step('mechanism-recorded-per-case', report.cases.every(entry => typeof entry.promptRaw === 'string' && entry.promptRaw.includes('{{') ),
        report.cases.map(entry => `${entry.case}:${typeof entry.promptRaw === 'string' ? 'has-promptRaw' : 'MISSING'}`).join(','));

    // ---- HALF (ii): DISK, and it is a BOUNDED WAIT ON THE FILE, never a sleep ---------------------------------
    //
    // MEASURED IN 40878005589 AND REPRODUCED LOCALLY: `disk.settings.variablesGlobal` was `{}` on BOTH subjects after
    // the global write, which had succeeded in the page (`applied[3].after = {hv_global: "HV-GLOBAL-e05f"}`). The
    // written path is `extension_settings.variables.global` + `saveSettingsDebounced()`
    // (src/function/variables.ts:169-173), and `saveSettingsDebounced` is
    // `debounce(saveSettings, DEFAULT_SAVE_EDIT_TIMEOUT)` with `DEFAULT_SAVE_EDIT_TIMEOUT = debounce_timeout.relaxed`
    // = 1000 ms (public/script.js:466,470; public/scripts/constants.js:14). The drive read the file ~100 ms after the
    // last case, so the queue was still pending; the reload page then NAVIGATED, which kills the pending timer. The
    // artefact therefore had NO disk evidence for half (ii) at all -- and `survivesFreshPage` only looked green
    // because the reloaded preset resolved to the EMPTY clause, which is the `(localVariable || '')` fallback
    // (public/scripts/variables.js:45) and proves nothing about persistence.
    //
    // THE WAIT IS ON THE PRODUCT'S OWN OUTPUT, and a value that never appears is a NAMED drive failure rather than a
    // quiet red on the claim (AGENTS.md 33 forbids masking a readiness race with a sleep; this polls the file).
    // The deadline is 25 s: 25x the debounce, so a slow CI runner cannot turn a correct save into a red.
    let persistence = null;
    if (writesVariables && !afterRestart) {
        const persistenceStart = Date.now();
        const persistenceDeadline = persistenceStart + 25000;
        let settings = await readSettingsFile(dataRoot);
        while (Date.now() < persistenceDeadline && !JSON.stringify(settings?.variablesGlobal ?? null).includes(MARKERS.global)) {
            await new Promise(resolve => setTimeout(resolve, 200));
            settings = await readSettingsFile(dataRoot);
        }
        persistence = {
            waitedMs: Date.now() - persistenceStart,
            found: JSON.stringify(settings?.variablesGlobal ?? null).includes(MARKERS.global),
            settingsSha256: settings?.sha256 ?? null,
            variablesGlobal: settings?.variablesGlobal ?? null,
            mechanism: 'polled default-user/settings.json for the global marker; the write is saved by a 1000 ms debounce (public/script.js:466,470)',
        };
        report.persistence = persistence;
        step('global-write-persisted', persistence.found === true, JSON.stringify({ found: persistence.found, waitedMs: persistence.waitedMs, variablesGlobal: persistence.variablesGlobal }));
    }

    report.disk = { chats: await readChatRecords(dataRoot), settings: await readSettingsFile(dataRoot) };

    // ---- A FRESH PAGE over the same process ----------------------------------------------------------------
    // SKIPPED ON THE RESTART LEG: that leg's single read-only case IS a fresh page in a NEW process, so a second
    // page would double its cost and add nothing. The comparator reads `leg.reload` only for the on legs.
    if (!afterRestart) {
        const reloadBoot = await openPage();
        const reloadConnect = await connect(`http://127.0.0.1:${peer.port}/v1`);
        const reloadRun = await runScript([{ name: 'reload-chat', ops: [], prompt: chatPrompt }]);
        report.reload = {
            boot: reloadBoot,
            connection: reloadConnect,
            script: reloadRun.done,
            staleScript: reloadRun.stale,
            request: summarise((attributeRequests(reloadRun.requests, [{ name: 'reload-chat' }]).byCase.get('reload-chat') ?? [])[0] ?? null),
            disk: { chats: await readChatRecords(dataRoot), settings: await readSettingsFile(dataRoot) },
        };
        step('reload-page-loaded', reloadBoot?.settingsReady === true && reloadRun.done !== null && !reloadRun.done?.error,
            JSON.stringify({ settingsReady: reloadBoot?.settingsReady, scriptError: reloadRun.done?.error ?? null, staleRunId: reloadRun.stale?.runId ?? null, captured: Boolean(report.reload.request) }));
        phase('reload');
    }

    // THE EXTENSION MUST STILL BE THE REVISION THE CLAIM NAMES, AFTER the drive. The pinned page's auto-update runs
    // during the first load of a fresh tree; the frozen origin makes it a local no-op, and this is the assertion
    // that the checkout really did not move -- so a future change that reopens the network path fails HERE, by name,
    // instead of producing an asymmetry two legs later.
    const revisionAfterDrive = await git(['rev-parse', 'HEAD'], installed.extensionDirectory).catch(() => null);
    const expectedRevision = pinnedExtension('tavern-helper').commit;
    step('extension-revision-held', revisionAfterDrive === expectedRevision,
        JSON.stringify({ expected: expectedRevision, after: revisionAfterDrive, held: report.provenance.extension.heldAtPin ?? null }));

    report.completions = peer.requests.filter(entry => /completions$/.test(entry.path ?? '')).length;
} catch (error) {
    report.failure = report.failure ?? neutraliseHostPaths(String(error?.stack ?? error));
} finally {
    const teardownStart = Date.now();
    if (browser) {
        await browser.close();
        timings.phases.push({ phase: 'browser-close', ms: Date.now() - teardownStart });
    }
    await peer.close();
    timings.phases.push({ phase: 'peer-close', ms: Date.now() - teardownStart });
    server?.kill();
}

/**
 * A CAPTURE, as the comparator reads it. The raw body and digest are the contract (rule 2); `bodies` is the whole
 * body text (bounded) because the assertions match CLAUSES inside it.
 */
function summarise(request) {
    if (!request) return null;
    let parsed = null;
    try {
        parsed = JSON.parse(request.body);
    } catch {
        parsed = null;
    }
    return {
        path: request.path,
        contentType: request.contentType,
        byteLength: request.byteLength,
        sha256: request.sha256,
        body: request.body.slice(0, 12000),
        keys: parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? Object.keys(parsed).sort() : null,
        model: parsed?.model ?? null,
        stream: parsed?.stream ?? null,
    };
}

try {
    await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
} catch (writeError) {
    console.error(`could not write ${reportPath}: ${writeError && writeError.message || writeError}`);
    process.exitCode = 1;
}

// THE CONSOLE SUMMARY MUST CARRY THE EVIDENCE NEEDED TO READ ITS OWN RED.
//
// Measured cost: run 40466428732 came back with `guards=[valueOnWire, macroWasTheResolver, changeChangesTheWire,
// globalScopeReachesWire]` and `mismatches=[]`, and the LOG could not say whether `generateRaw` substituted
// `{{getvar::...}}` at all -- `promptRaw`, `renderedWithMacroEngine` and the captured body lived only in the
// artefact, which is uploaded as a zip. The red was undiagnosable from the run that produced it, which is the same
// rule-40 mistake as a green `card-opened` nobody could attribute. The per-case mechanism triple and a bounded slice
// of the body are therefore printed here, so the next verdict is readable without downloading anything.
const bounded = (value, limit = 400) => (typeof value === 'string' && value.length > limit ? `${value.slice(0, limit)}…(${value.length} chars)` : value ?? null);
console.log(JSON.stringify({
    subject: report.subject,
    variant: report.variant,
    afterRestart: report.afterRestart,
    failure: report.failure,
    steps: report.steps.map(item => `${item.ok === null ? 'n/a' : item.ok ? 'ok' : 'FAIL'} ${item.name}`),
    // THE SUMMARY MUST PRINT THE FIELDS ITS OWN GUARDS READ (AGENTS rule 64, second clause -- and this lane is the
    // measurement behind it). Measured in 40471775285: I searched the log for `serverPid`, got 0, and reported a
    // missing field that was in fact assigned at this probe's line 349 and never printed. The absence of a field in
    // a console stream is not the absence of the field, and a reader must not have to download the artefact to
    // learn whether the restart leg really was a NEW process.
    provenance: {
        serverPid: report.provenance?.serverPid ?? null,
        serverVersion: report.provenance?.serverVersion ?? null,
        extension: report.provenance?.extension ?? null,
        configFile: report.provenance?.configFile ?? null,
        blockedExternal: (report.provenance?.blockedExternal ?? []).slice(0, 4),
    },
    attribution: report.attribution ?? null,
    fixture: report.fixture ?? null,
    chatSeed: report.chatSeed ?? null,
    cases: report.cases.map(entry => ({
        case: entry.case,
        sha256: entry.request?.sha256 ?? null,
        bytes: entry.request?.byteLength ?? null,
        captureCount: entry.captureCount ?? null,
        error: entry.error ?? null,
        opError: bounded(entry.opError, 200),
        // THE MECHANISM TRIPLE, per case: what the prompt carried, what the host macro made of it, and what the
        // provider received. These three together are what distinguishes "the macro resolved the value" from "the
        // value appeared somewhere".
        promptRaw: bounded(entry.promptRaw),
        renderedWithMacroEngine: bounded(entry.renderedWithMacroEngine),
        renderedError: bounded(entry.renderedError, 200),
        bodySlice: bounded(entry.request?.body, 600),
        bodyHasRawMacroSyntax: typeof entry.request?.body === 'string' ? /\{\{get(?:global)?var::/.test(entry.request.body) : null,
        // WHAT THE EXTENSION ITSELF BELIEVED THE PRESET PROMPT CONTAINED at generation time, read through
        // `getPreset(name)` inside the page (AGENTS rule 58: read state back through the reader the product uses).
        readBack: entry.readBack ? { content: bounded(entry.readBack.content, 300), enabled: entry.readBack.enabled ?? null, error: entry.readBack.error ?? null } : null,
        applied: entry.applied ?? null,
    })),
    reload: report.reload ? { steps: report.reload.boot ?? null, bodySlice: bounded(report.reload.request?.body, 600), sha256: report.reload.request?.sha256 ?? null } : null,
    timings: report.timings.phases,
}, null, 2));
