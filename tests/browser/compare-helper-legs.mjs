// Judge the four 酒馆助手 legs: {gotavern,pinned} × {helper on, helper off}.
//
// WHAT THIS IS ALLOWED TO CLAIM. It compares two RUNS of the pinned extension in the unmodified pinned
// frontend, one against each server, and it fails itself when the pair it judges cannot tell helper-on
// from helper-off (AGENTS.md 50). It never defines what the correct rendered HTML is: the assertion is
// that the SAME script produced the SAME observable state through both servers.
//
// THE GUARDS, and why each exists rather than being folded into a diff:
//   legs-drove            a drive that failed to record is not evidence; a red leg must not be read as
//                         a product difference.
//   same-fixture          two legs that did not start from the same extension revision, config bytes and
//                         pre-drive tree cannot be compared.
//   host-modules          the extension is an ES module that imports 25 of the host's own modules five
//                         levels up; one 404 makes the extension unable to load and every later guard
//                         meaningless. Judged per URL, not as a count.
//   bridge                the iframe exists, is NOT sandboxed, `window.parent.TavernHelper` is reachable
//                         from inside it, and the module inside it reached its completion marker. This is
//                         the architecture (property injection at document start), so it is asserted as
//                         such rather than inferred from "the panel appeared".
//   variable-persisted    the chat variable the script wrote reached the CHAT FILE (read from disk),
//                         which is the persisted-state half.
//   render-path           the helper's own renderer wrapped the HTML code block and the DOM inside its
//                         iframe is what the script produced.
//   dom-urls              every URL those iframes put into the DOM answered 200 WITH BYTES; a 200 with
//                         an error page is separated by the byte length.
//   node-equals-go        the two subjects agree on every compared field, with a named reason for every
//                         field that is not compared.
//   discriminating        on vs off must differ; otherwise the verdict is HARNESS NON-DISCRIMINATING.
//
// Fields that are NOT compared, each with its reason, land in `notCompared[]`; anything the leg did not
// attempt lands in `unproven[]` WITH a reason, never silently.

import fs from 'node:fs/promises';
import process from 'node:process';

function argumentValue(name, fallback = null) {
    const index = process.argv.indexOf(name);
    return index === -1 ? fallback : process.argv[index + 1];
}

async function readLeg(label, file) {
    if (!file) return { label, present: false, leg: null };
    try {
        return { label, present: true, leg: JSON.parse(await fs.readFile(file, 'utf8')) };
    } catch (error) {
        return { label, present: false, leg: null, error: String(error?.message ?? error) };
    }
}

const legs = {
    gotavernOn: await readLeg('gotavern-on', argumentValue('--gotavern-on')),
    gotavernOff: await readLeg('gotavern-off', argumentValue('--gotavern-off')),
    pinnedOn: await readLeg('pinned-on', argumentValue('--pinned-on')),
    pinnedOff: await readLeg('pinned-off', argumentValue('--pinned-off')),
};
const mutated = await readLeg('gotavern-mutated', argumentValue('--gotavern-mutated'));
const artefactPath = argumentValue('--out');

const guards = [];
const mismatches = [];
const notCompared = [];
const unproven = [];

function guard(name, ok, detail = null) {
    guards.push({ guard: name, ok: Boolean(ok), detail });
    return Boolean(ok);
}

function field(pathName, reason) {
    notCompared.push({ field: pathName, reason });
}

function unprovenItem(capability, reason) {
    unproven.push({ capability, reason });
}

// 1. Every leg that was asked for must be present, must have driven, and must be a subject/variant pair.
const required = ['gotavernOn', 'gotavernOff', 'pinnedOn', 'pinnedOff'];
// WHICH STEPS ARE DRIVE, NOT GUARD. A red assertion is the comparator's business; a drive step that did
// not happen makes everything after it unattributable. 40217283368 read `legs-drove: render-path: null`,
// which named the guard as if it were a drive failure.
const DRIVE_STEPS = new Set(['page-loaded', 'settings-ready', 'host-modules', 'character-opened', 'chat-has-message', 'chat-open', 'script-enabled', 'script-iframe', 'script-ran', 'script-completed']);
const missing = required.filter(key => !legs[key].present);
const driveFailures = required
    .filter(key => legs[key].present)
    .map(key => ({ key, failure: legs[key].leg?.failure, steps: (legs[key].leg?.steps ?? []).filter(step => step.ok === false) }))
    .filter(item => item.failure);
guard('legs-present', missing.length === 0, missing.length ? `missing: ${missing.join(', ')}` : null);
const driveStepFailures = required
    .filter(key => legs[key].present)
    .flatMap(key => (legs[key].leg?.steps ?? []).filter(item => item.ok === false && DRIVE_STEPS.has(item.name)).map(item => `${key}: ${item.name}: ${item.detail ?? 'failed'}`));
guard('legs-drove', driveFailures.length === 0 && driveStepFailures.length === 0, (driveFailures.length || driveStepFailures.length)
    ? driveFailures.map(item => `${item.key}: ${item.failure}`).concat(driveStepFailures).join(' | ')
    : null);

const on = { gotavern: legs.gotavernOn.leg, pinned: legs.pinnedOn.leg };
const off = { gotavern: legs.gotavernOff.leg, pinned: legs.pinnedOff.leg };

// 2. Same fixture: the extension revision, the config bytes and the pre-drive tree.
const fixtureProblems = [];
for (const subject of ['gotavern', 'pinned']) {
    const leg = on[subject];
    if (!leg) continue;
    if (leg.provenance?.extension?.installedRevision !== '837a6288135cde61522a9279173b98020f08807e') {
        fixtureProblems.push(`${subject}: extension revision ${leg.provenance?.extension?.installedRevision}`);
    }
    if (!leg.provenance?.configFile?.matchesSource) {
        fixtureProblems.push(`${subject}: config bytes differ from upstream/default/config.yaml`);
    }
    // AFTER BOOT, because the server seeds `default/content/characters` at startup: a pre-boot count is
    // zero on a fresh root by construction (run 40215174430 failed same-fixture for that reason).
    if (!(leg.provenance?.startingState?.characterFilesAfterBoot > 0)) {
        fixtureProblems.push(`${subject}: no character cards were present after boot (${leg.provenance?.startingState?.characterFilesAfterBoot ?? 'unrecorded'})`);
    }
}
const configs = ['gotavern', 'pinned'].map(subject => on[subject]?.provenance?.configFile?.sha256 ?? null);
if (configs[0] !== null && configs[1] !== null && configs[0] !== configs[1]) {
    fixtureProblems.push(`the two legs started from different config bytes (${configs[0]} vs ${configs[1]})`);
}
guard('same-fixture', fixtureProblems.length === 0, fixtureProblems.join(' | ') || null);

// 3. The 25 host modules, per URL, on both subjects.
const hostModuleProblems = [];
for (const subject of ['gotavern', 'pinned']) {
    const status = on[subject]?.hostImportStatus ?? [];
    const broken = status.filter(entry => entry.status !== 200 || !(entry.byteLength > 0));
    if (status.length === 0) hostModuleProblems.push(`${subject}: the drive recorded no host-module status`);
    if (broken.length > 0) hostModuleProblems.push(`${subject}: ${broken.map(entry => `${entry.status} ${entry.path}`).join(', ')}`);
}
guard('host-modules', hostModuleProblems.length === 0, hostModuleProblems.join(' | ') || null);

// 4-7. The four "really runs" assertions, on each subject.
const subjectFindings = {};
for (const subject of ['gotavern', 'pinned']) {
    const leg = on[subject];
    if (!leg) {
        subjectFindings[subject] = { present: false };
        continue;
    }
    const bridgeProblems = [];
    if (!leg.iframe) bridgeProblems.push('no script iframe was observed');
    else {
        if (leg.iframe.hasSandboxAttribute !== false) bridgeProblems.push(`the script iframe carries sandbox="${leg.iframe.sandboxValue}"`);
        if (leg.iframe.sameOriginReadable !== true) bridgeProblems.push(`the iframe was not readable from the page (${leg.iframe.readError})`);
        if (leg.iframe.parentHelperReachable !== true) bridgeProblems.push('window.parent.TavernHelper was not reachable from inside the iframe');
        if (leg.iframe.done?.marker !== 'HELPER_PROBE_SCRIPT_DONE') bridgeProblems.push(`the module inside the iframe did not complete (${leg.iframe.scriptError ?? 'no marker'})`);
    }
    const variableProblems = [];
    const counter = Number(leg.variableState?.after?.helper_probe_counter ?? NaN);
    if (!Number.isFinite(counter) || counter < 1) variableProblems.push(`the chat file carries helper_probe_counter=${leg.variableState?.after?.helper_probe_counter ?? '(absent)'}`);
    if (leg.variableState?.changed !== true) variableProblems.push('the chat file variables did not change');
    const renderProblems = [];
    if (leg.render?.renderedText !== 'HELPER_PROBE_RENDERED') renderProblems.push(`the render iframe's DOM carried ${JSON.stringify(leg.render?.renderedText)}`);
    const urlProblems = [];
    for (const target of leg.urls ?? []) {
        for (const purpose of ['character', 'thumbnail']) {
            const response = target[`${purpose}Response`];
            if (!response || response.status !== 200 || !(response.byteLength > 0)) {
                urlProblems.push(`${purpose}: ${response ? `${response.status}/${response.byteLength}` : 'not requested'}`);
            }
        }
    }
    subjectFindings[subject] = { present: true, counter, bridgeProblems, variableProblems, renderProblems, urlProblems };
}
guard('bridge', ['gotavern', 'pinned'].every(subject => subjectFindings[subject].present && subjectFindings[subject].bridgeProblems.length === 0),
    Object.entries(subjectFindings).flatMap(([subject, findings]) => (findings.bridgeProblems ?? []).map(problem => `${subject}: ${problem}`)).join(' | ') || null);
guard('variable-persisted', ['gotavern', 'pinned'].every(subject => subjectFindings[subject].present && subjectFindings[subject].variableProblems.length === 0),
    Object.entries(subjectFindings).flatMap(([subject, findings]) => (findings.variableProblems ?? []).map(problem => `${subject}: ${problem}`)).join(' | ') || null);
guard('render-path', ['gotavern', 'pinned'].every(subject => subjectFindings[subject].present && subjectFindings[subject].renderProblems.length === 0),
    Object.entries(subjectFindings).flatMap(([subject, findings]) => (findings.renderProblems ?? []).map(problem => `${subject}: ${problem}`)).join(' | ') || null);
guard('dom-urls', ['gotavern', 'pinned'].every(subject => subjectFindings[subject].present && subjectFindings[subject].urlProblems.length === 0),
    Object.entries(subjectFindings).flatMap(([subject, findings]) => (findings.urlProblems ?? []).map(problem => `${subject}: ${problem}`)).join(' | ') || null);

// 8. Node == Go on the compared fields, with a named reason for everything else.
function compareField(name, pick) {
    const gotavern = pick(on.gotavern);
    const pinned = pick(on.pinned);
    if (JSON.stringify(gotavern) === JSON.stringify(pinned)) return;
    mismatches.push({ field: name, gotavern, pinned });
}
compareField('bridge.hasGetVariables', leg => leg?.bridge?.hasGetVariables ?? null);
compareField('bridge.hasInsertOrAssignVariables', leg => leg?.bridge?.hasInsertOrAssignVariables ?? null);
compareField('bridge.hasSetChatMessage', leg => leg?.bridge?.hasSetChatMessage ?? null);
compareField('iframe.notSandboxed', leg => leg?.iframe ? leg.iframe.hasSandboxAttribute === false : null);
compareField('variable.counter', leg => Number(leg?.variableState?.after?.helper_probe_counter ?? NaN));
compareField('variable.marker', leg => leg?.variableState?.after?.helper_probe_marker ?? null);
compareField('render.renderedText', leg => leg?.render?.renderedText ?? null);
compareField('hostModule.statuses', leg => (leg?.hostImportStatus ?? []).map(entry => `${entry.path}=${entry.status}/${entry.byteLength > 0}`));
compareField('url.statuses', leg => (leg?.urls ?? []).flatMap(target => ['character', 'thumbnail'].map(purpose => `${purpose}=${target[`${purpose}Response`]?.status ?? 'none'}/${target[`${purpose}Response`]?.byteLength > 0}`)));
field('url.sha256', 'the pinned frontend builds /thumbnail from the same source; /thumbnail BYTES are a declared divergence (ARCHITECTURE 35.2, Jimp vs the pure-Go codec), so the comparison records status and non-emptiness per URL instead of a digest. The digest is still recorded in each leg.');
field('iframe.id / iframe.srcdocLength', 'the iframe id embeds a UUID generated per run and the srcdoc embeds blob URLs, so both are per-run values; their PRESENCE is compared through the bridge guard.');
field('request.order / request.count', 'the drive waits for network quiet and then judges URL statuses as a set; arrival order is a timing property, not a contract (AGENTS.md 18).');
field('console / pageErrors', 'recorded in each leg and reported, not compared: the unmodified frontend emits the same console noise on both servers and a global ignore rule is forbidden (differential doctrine 2).');
// THE NEGATIVE CONTROL. A leg that is helper-on with the variable write removed must leave the
// persistence guard RED while the bridge stays GREEN. If it stays green, the persistence guard cannot
// fail and every green it produces is decoration (rule 7). This is the guard that makes the chat-saved
// precondition worth having.
const controlCounter = Number(mutated.leg?.variableState?.after?.helper_probe_counter ?? 0);
const controlBridgeOk = mutated.leg?.iframe?.done?.marker === 'HELPER_PROBE_SCRIPT_DONE';
guard('negative-control-bites', mutated.present && controlCounter === 0 && controlBridgeOk,
    mutated.present
        ? `counter=${controlCounter} (must be 0) bridge-completed=${controlBridgeOk} (must be true); chatFile=${mutated.leg?.variableState?.chatFile ?? '(none)'}`
        : 'the no-variable-write control leg was not recorded');
guard('node-equals-go', mismatches.length === 0, mismatches.map(item => item.field).join(', ') || null);

// 9. Rule 50: on and off must differ, per subject.
const discrimination = {};
for (const subject of ['gotavern', 'pinned']) {
    const offLeg = off[subject];
    const onLeg = on[subject];
    if (!offLeg || !onLeg) {
        discrimination[subject] = { comparable: false };
        continue;
    }
    const observations = {
        on: {
            scriptIframe: Boolean(onLeg.iframe?.id) || Boolean(onLeg.bridge),
            variableCounter: Number(onLeg.variableState?.after?.helper_probe_counter ?? 0),
            renderedMarker: onLeg.render?.renderedText ?? null,
        },
        off: {
            scriptIframe: Boolean(offLeg.iframe?.id) || Boolean(offLeg.bridge),
            variableCounter: Number(offLeg.variableState?.after?.helper_probe_counter ?? 0),
            renderedMarker: offLeg.render?.renderedText ?? null,
        },
    };
    const differs = JSON.stringify(observations.on) !== JSON.stringify(observations.off);
    discrimination[subject] = { comparable: true, differs, observations };
}
guard('discriminating', required.every(key => legs[key].present) && ['gotavern', 'pinned'].every(subject => discrimination[subject].comparable && discrimination[subject].differs),
    JSON.stringify(discrimination));

// 10. What this leg does NOT prove, named rather than absorbed.
unprovenItem('user scripts that load Vue / Vue-Router inside the iframe', 'the probe blocks testingcf.jsdelivr.net (the iframe heads load Vue there with blocking tags and no onerror) and the probe script uses only TavernHelper; a script that needs Vue is untested by this leg.');
unprovenItem('generation APIs (GOAL Q9)', 'this leg does not call generate()/generateRaw(); the generation path is a separate drive so a render failure cannot be misattributed, and it must compare the provider request Node==Go through the capture peer.');
unprovenItem('helper injection changing model context (GOAL Q11)', 'injection is a generate() concern; it is asserted only by the generation leg.');
unprovenItem('in_use preset mutation affecting generation immediately (GOAL Q12)', 'needs a generate() call after a preset mutation; not in this leg.');
unprovenItem('streaming / helper events (GOAL Q19)', 'not driven here.');
unprovenItem('reload / swipe / regenerate / continue (GOAL Q20)', 'not driven here.');
unprovenItem('a real user\'s own helper script and preset trees', 'the probe script is synthetic by necessity; the real 1.1 MB extensions.tavern_helper subtree from the audited tree is a fixture this leg does not yet load (AGENTS.md 51).');
unprovenItem('pinned leg reaching the same bridge through a DIFFERENT frontend build', 'both legs load the SAME pinned public/** (hard rule 3), so a helper bug that depends on a Go-specific frontend difference cannot appear here.');

const failedGuards = guards.filter(item => !item.ok);
const artefact = {
    schemaVersion: 1,
    question: 'Does 酒馆助手 / JS-Slash-Runner RUN user code through the pinned frontend on GoTavern as it does on pinned Node, and is every URL it puts into the DOM served?',
    generatedBy: 'tests/browser/compare-helper-legs.mjs',
    subject: 'tavern-helper@837a6288135cde61522a9279173b98020f08807e (manifest 4.11.3)',
    verdict: failedGuards.length === 0 ? 'PASS' : 'FAIL',
    guards,
    mismatches,
    discrimination,
    subjects: subjectFindings,
    blockedExternal: {
        host: 'testingcf.jsdelivr.net',
        decision: 'blocked',
        reason: 'blocking <script> tags with no onerror in every iframe head; a slow resolve turns the page-load budget into a timing test and a silent failure leaves Vue undefined. The probe script uses only TavernHelper.',
        urlsBlocked: on.gotavern?.provenance?.blockedExternal?.length ?? 0,
    },
    negativeControl: mutated.present
        ? { leg: 'helper-gotavern-mutated', mutation: mutated.leg?.mutation ?? null, counter: controlCounter, bridgeCompleted: controlBridgeOk, chatFile: mutated.leg?.variableState?.chatFile ?? null }
        : null,
    notCompared,
    unproven,
    legs: Object.fromEntries(Object.entries(legs).map(([key, value]) => [key, { present: value.present, subject: value.leg?.subject ?? null, variant: value.leg?.variant ?? null, failure: value.leg?.failure ?? null }])),
};
const serialised = `${JSON.stringify(artefact, null, 2)}\n`;
if (artefactPath) await fs.writeFile(artefactPath, serialised);
process.stdout.write(serialised);
if (failedGuards.length > 0) {
    console.error(`helper comparison failed: ${failedGuards.map(item => item.guard).join(', ')}`);
    process.exitCode = 1;
}
