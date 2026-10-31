// JUDGE the NARROW vehicle: does a 酒馆助手 variable reach the FINAL provider request, and survive a fresh page and a
// new server process?
//
// WHY THE ASSERTIONS ARE ON CLAUSES, NOT SUBSTRINGS. The claim is that the value arrives WHERE THE PROMPT ASKED FOR
// IT, so each guard matches `<CLAUSE><value>` followed by a boundary inside the RAW BODY BYTES. A body that merely
// echoes the token somewhere -- a settings dump, a second-generation prompt, a stashed variable inside a
// provider-extension member -- satisfies a substring test while the macro never resolved. This is also the guard that
// can fail when the two subjects AGREE AND ARE BOTH WRONG: with digest equality as the only other evidence, a pair of
// identical requests that both lack the value would pass `nodeEqualsGo` and every comparator guard.
//
// THE VERDICT MECHANIC (as every helper comparator, so the artefacts read together):
//   guards.<name>            TRUE only when true on BOTH subjects.
//   false on BOTH            a DRIVER LIMITATION (rule 10) -- excusable ONLY through unproven[] with a mechanism.
//   true on ONE              an ASYMMETRY: never declarable, always fails. That is the difference this exists to find.
//
// THE OFF CONTROL IS PART OF THE VERDICT. Rule 50: if the on and off captures are identical, the pair cannot show the
// variable is what changed anything, so `offIsTheControl` is required and is computed from the OFF legs.

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

function argumentValue(name, fallback = null) {
    const index = process.argv.indexOf(name);
    return index === -1 ? fallback : process.argv[index + 1];
}

/**
 * A COMMITTED ARTEFACT MUST NOT CARRY A HOST PATH, AND A FAILED LEG IS THE EASIEST PLACE FOR ONE TO ARRIVE.
 *
 * MEASURED IN 40878005589: `tools/verify-browser-comparisons.mjs` refused the fresh artefact with
 * `records a host-derived address matching /\/home\//`, and the two carriers were (a) every leg's `path` field, which
 * was the ABSOLUTE report path `/home/runner/work/_temp/browser-differential/legs/helper-vars-*.json`, and (b) the
 * pinned restart leg's refusal message, whose stack frames are `file:///home/runner/work/GoTavern/GoTavern/...`.
 * Neither is a property of the product: the directory belongs to the run that produced it.
 *
 * The probe normalises its own failure against its two roots; this is the defence for a leg recorded by an OLDER probe
 * (a committed artefact can be produced from a leg this file did not write), so it repeats the narrow rule rather than
 * assuming. It is deliberately narrow: a broad "anything starting with a slash" would rewrite `/api/settings/save`
 * inside a message and destroy the information the message exists to carry.
 */
function neutraliseHostPaths(text) {
    if (typeof text !== 'string') return text ?? null;
    return text
        // `(?<![A-Za-z])` because without it the drive-letter alternative matches the "e:/" inside "file:///" and
        // leaves a fragment of the scheme behind ("at fil<host-path>…"), which reads like corruption.
        .replace(/(?<![A-Za-z])[A-Za-z]:[\\/][^\s"'`)<>]*/g, '<host-path>')
        .replace(/file:\/\/\/[^\s"'`)<>]*/g, '<host-path>')
        .replace(/\/(?:home|Users|root|tmp|var|opt|mnt|runner|workspace|builds|github)(?:\/[^\s"'`)<>]*)?/g, '<host-path>');
}

/** The file a leg came from, named rather than located (see neutraliseHostPaths). */
const legFileName = file => (file === null || file === undefined ? null : path.basename(String(file)));

async function readLeg(label, file) {
    if (!file) return { label, present: false, leg: null, path: null };
    try {
        return { label, present: true, leg: JSON.parse(await fs.readFile(file, 'utf8')), path: file };
    } catch (error) {
        return { label, present: false, leg: null, path: file, error: neutraliseHostPaths(String(error?.message ?? error)) };
    }
}

const legs = {
    gotavernOn: await readLeg('gotavern-on', argumentValue('--gotavern-on')),
    pinnedOn: await readLeg('pinned-on', argumentValue('--pinned-on')),
    gotavernOff: await readLeg('gotavern-off', argumentValue('--gotavern-off')),
    pinnedOff: await readLeg('pinned-off', argumentValue('--pinned-off')),
    gotavernRestart: await readLeg('gotavern-restart', argumentValue('--gotavern-restart')),
    pinnedRestart: await readLeg('pinned-restart', argumentValue('--pinned-restart')),
};
const artefactPath = argumentValue('--out');
const subjects = ['gotavern', 'pinned'];
const on = { gotavern: legs.gotavernOn.leg, pinned: legs.pinnedOn.leg };
const off = { gotavern: legs.gotavernOff.leg, pinned: legs.pinnedOff.leg };
const restart = { gotavern: legs.gotavernRestart.leg, pinned: legs.pinnedRestart.leg };

const DRIVE_STEPS = new Set([
    'page-loaded', 'extension-is-pinned', 'api-surface-recorded', 'host-macro-surface-present',
    'connection-configured', 'script-completed', 'helper-api-present', 'one-capture-per-case', 'message-scope-unreadable-by-macro',
    // THE TWO PRECONDITIONS ADDED AFTER 40878005589, because each of them was silently FALSE while the guards that
    // depend on it still passed:
    //   extension-revision-held   the pinned page's auto-update moved the checkout to the remote head mid-leg, so the
    //                             restart invocation refused and the pair no longer shared a revision (see the probe's
    //                             holdExtensionAtPin).
    //   global-write-persisted    the global write never reached settings.json (a 1000 ms debounce whose timer the
    //                             reload navigation killed), so half (ii) had no disk evidence at all.
    'extension-revision-held', 'global-write-persisted',
    // THE PIN AT THE START OF THE DRIVE, asserted on the git HEAD rather than on the API surface read from the same
    // tree: install-pinned-extension.mjs freezes the origin to a local mirror, and this step fails if a page-triggered
    // update ever moves the checkout again.
    'extension-pinned-at-drive-start',
]);
const DRIVE_STEP_FAILURES = [];
for (const [label, entry] of Object.entries(legs)) {
    for (const item of entry.leg?.steps ?? []) {
        if (item.ok === false && DRIVE_STEPS.has(item.name)) DRIVE_STEP_FAILURES.push(`${label}: ${item.name}: ${item.detail ?? 'failed'}`);
    }
}

const escapeRegExp = value => String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const caseOf = (leg, name) => (leg?.cases ?? []).find(entry => entry.case === name) ?? null;
const body = entry => String(entry?.request?.body ?? '');
const hasClause = (entry, clause, value) => Boolean(entry?.request) && new RegExp(`${escapeRegExp(clause)}${escapeRegExp(value)}(?![\\w-])`).test(body(entry));
const hasEmptyClause = (entry, clause) => Boolean(entry?.request) && new RegExp(`${escapeRegExp(clause)}(?![\\w-])`).test(body(entry)) && !new RegExp(`${escapeRegExp(clause)}HV-`).test(body(entry));

const MARKS = on.gotavern?.marks ?? on.pinned?.marks ?? null;
const CLAUSES = on.gotavern?.prompts ?? on.pinned?.prompts ?? null;
const chat = MARKS?.first ?? 'HV-ALPHA-7c31';
const chatBeta = MARKS?.second ?? 'HV-BETA-9d42';
const globalMark = MARKS?.global ?? 'HV-GLOBAL-e05f';
const messageMark = MARKS?.message ?? 'HV-MESSAGE-1a88';
// THE CLAUSE MOVED WITH THE MARKER. These are the preset-prompt clauses (`HV-PRESET-CHAT=` etc.); the earlier
// `HV-READ-*` clauses belonged to a marker placed in generateRaw's caller-supplied `ordered_prompts`, which pinned
// does not substitute (generateRaw.ts:492-497). Keeping the old strings here would make every wire assertion red for
// a reason that has nothing to do with the product, so the default tracks the vehicle.
const C = CLAUSES ?? { chat: 'HV-PRESET-CHAT=', global: 'HV-PRESET-GLOBAL=', message: 'HV-PRESET-MESSAGE=' };

// EVERY CASE NAME ANY LEG RECORDED. Used for exactly one thing: masking the driver's OWN injected input out of the two
// off captures before comparing them (see the off control below). Masking a name needs no knowledge of which leg it
// came from, and taking the union means a renamed case does not silently stop being masked.
const caseNames = [...new Set([on.gotavern, on.pinned, off.gotavern, off.pinned, restart.gotavern, restart.pinned]
    .flatMap(leg => (leg?.cases ?? []).map(entry => entry.case))
    .filter(name => typeof name === 'string'))];
const digestOf = text => createHash('sha256').update(String(text)).digest('hex');

const observed = {};
// THE RESTART LEG'S CASE SET IS PART OF THE CLAIM, NOT A CONVENTION.
//
// `survivesRestart` says "a NEW process read the value off the tree the previous one left". That is only true if the
// restart leg WROTE NOTHING, and nothing in the wire can prove it: the leg could write the value and then read it back.
// The probe therefore runs exactly one read-only case there (`reload-chat`), and this asserts the leg's OWN recorded
// plan is that case list -- so a future edit that quietly restores the write list is a red here rather than a
// survived-from-nowhere green. MEASURED IN 40878005589: the restart leg ran the SAME `writesVariables` list, so its
// `chat-alpha` re-wrote `hv_preset` and every restart sha256 equalled the on-leg's (b82308a7… both) -- the guard was
// satisfied by the leg's own write.
const READ_ONLY_RESTART_CASES = ['reload-chat'];
const restartLegIsReadOnly = subjects.map(subject => {
    const planned = restart[subject]?.plannedCases ?? null;
    return Array.isArray(planned)
        && planned.length === READ_ONLY_RESTART_CASES.length
        && READ_ONLY_RESTART_CASES.every((name, index) => planned[index] === name);
});
const presetStagedPerSubject = subjects.map(subject => on[subject]?.fixture?.afterWrite?.present === true);
for (const subject of subjects) {
    const leg = on[subject];
    const offLeg = off[subject];
    const restartLeg = restart[subject];

    const alpha = caseOf(leg, 'chat-alpha');
    const beta = caseOf(leg, 'chat-beta');
    const deleted = caseOf(leg, 'chat-deleted');
    const globalSet = caseOf(leg, 'global-set');
    const messageSet = caseOf(leg, 'message-set');

    // HALF (i)
    const valueOnWire = hasClause(alpha, C.chat, chat);
    const secondValueOnWire = hasClause(beta, C.chat, chatBeta);
    const changeDiffered = Boolean(alpha?.request && beta?.request) && alpha.request.sha256 !== beta.request.sha256;
    const changeLostOld = !hasClause(beta, C.chat, chat);

    // WHICH MECHANISM PRODUCED THE RESOLUTION -- the claim is "the resolved value is on the wire", and "the MACRO
    // resolved it" is a separate, checkable fact rather than an inference. Three things are compared per probe case:
    //   promptRaw                    the string the prompt carried, e.g. `HV-READ-CHAT={{getvar::hv_chat}}`
    //   renderedWithMacroEngine      the host's own substitution of that same string (TavernHelper.substitudeMacros)
    //   request.body                 what the provider actually received
    // The mechanism is DEMONSTRATED, not assumed, when: the raw form still contains `{{getvar::`, the rendered form
    // does NOT, the rendered form carries the value, and the body carries the rendered form rather than the raw one.
    // A body that still held `{{getvar::...}}` would mean the macro never ran and the value came from somewhere else;
    // that case fails `macroWasTheResolver` rather than quietly satisfying the clause assertions.
    const mechanismOf = entry => {
        const raw = typeof entry?.promptRaw === 'string' ? entry.promptRaw : null;
        const rendered = typeof entry?.renderedWithMacroEngine === 'string' ? entry.renderedWithMacroEngine : null;
        // ON THE PRESET VEHICLE THE PROMPT THAT MATTERS IS THE STAGED PRESET PROMPT, read back through the helper's
        // own reader at generation time (`getPreset(name).prompts[...]`). `promptRaw`/`renderedWithMacroEngine` are
        // the probe's substitution of a string the probe chose, which is NOT what the provider received on this
        // vehicle -- they are kept as a second opinion, and the preset read-back is authoritative when present.
        const staged = typeof entry?.readBack?.content === 'string' ? entry.readBack.content : null;
        const wire = body(entry);
        return {
            staged,
            rawHasMacroSyntax: (staged ?? raw) !== null && /\{\{(?:get|getglobal)var::/.test(String(staged ?? raw)),
            renderedHasNoMacroSyntax: staged === null ? (rendered !== null && !/\{\{(?:get|getglobal)var::/.test(rendered)) : !/\{\{(?:get|getglobal)var::/.test(staged),
            renderedCarriesValue: staged === null
                ? (rendered !== null && (rendered.includes(chat) || rendered.includes(chatBeta) || rendered.includes(globalMark)))
                : (staged.includes(chat) || staged.includes(chatBeta) || staged.includes(globalMark) || staged.includes(messageMark)),
            wireHasRenderedForm: wire.includes(String(staged ?? rendered ?? '').split('\u0000')[0].slice(0, 60)),
            wireStillHasRawForm: raw !== null && wire.includes(raw),
            raw,
            rendered,
        };
    };
    const alphaMechanism = mechanismOf(alpha);
    const betaMechanism = mechanismOf(beta);
    const globalMechanism = mechanismOf(globalSet);
    const macroWasTheResolver = [alphaMechanism, betaMechanism].every(entry => entry.rawHasMacroSyntax)
        && [alphaMechanism, betaMechanism].every(entry => entry.renderedHasNoMacroSyntax)
        && [alphaMechanism, betaMechanism].every(entry => entry.renderedCarriesValue)
        && [alphaMechanism, betaMechanism].every(entry => entry.wireHasRenderedForm)
        && [alphaMechanism, betaMechanism, globalMechanism].every(entry => entry.wireStillHasRawForm === false);

    // THE ABSENT FORM. With the variable deleted the macro resolves to '' (public/scripts/variables.js:45,
    // `(localVariable || '')`), so the clause must be present with NOTHING after it -- the prompt still arrived, the
    // lookup produced nothing. A body missing the clause entirely is a different fact (the prompt did not arrive) and
    // is therefore NOT accepted here.
    const deleteIsEmptyForm = hasEmptyClause(deleted, C.chat);
    const deleteDroppedValue = !hasClause(deleted, C.chat, chat) && !hasClause(deleted, C.chat, chatBeta);
    // The deleted case's HARNESS mechanism: the rendered form must have collapsed to the bare clause, so the empty
    // wire form is the macro's own doing rather than a prompt that lost its text.
    const deleteMechanism = mechanismOf(deleted);
    const deleteMechanismShown = deleteMechanism.rawHasMacroSyntax === true
        && deleteMechanism.renderedHasNoMacroSyntax === true
        && typeof deleteMechanism.rendered === 'string'
        && deleteMechanism.rendered.trim().endsWith(String(C.chat ?? 'HV-PRESET-CHAT='));

    // SCOPES
    const globalOnWire = hasClause(globalSet, C.global, globalMark);
    // THE `message` SCOPE, AS ITS OWN ROW: stored in the page, and NOT on the wire.
    const messageStored = JSON.stringify(caseOf(leg, 'message-set')?.applied ?? null).includes(messageMark);
    const messageNotOnWire = Boolean(messageSet?.request) && !body(messageSet).includes(messageMark);
    // THE REFUSAL IS A PARITY FACT TOO. `src/function/variables.ts:58-63` bounds `message_id` to
    // `(-chat.length, chat.length)`, so on an EMPTY chat every message-scoped write is refused by range check -- pinned
    // behaving correctly. The probe seeds one message so the normal path can be measured; when the seed did not take,
    // the honest row is "both subjects refused identically", which IS the claim for that case. Refused-on-one /
    // stored-on-the-other lands in asymmetries and is refused there.
    const messageRefused = JSON.stringify(caseOf(leg, 'message-set')?.applied ?? null).includes('pinned range check');
    const messageRowComplete = messageStored || messageRefused;
    const chatSeedOk = leg?.chatSeed?.ok === true;

    // HALF (ii): DISK
    const chatVariables = Object.entries(leg?.disk?.chats ?? {})
        .flatMap(([file, record]) => Object.entries(record?.variables ?? {}).map(([name, value]) => ({ file, name, value })));
    // The value that must be on disk is whichever one the run left: alpha was overwritten by beta and then deleted,
    // so the surviving evidence is the GLOBAL write, which nothing deletes.
    const globalOnDisk = JSON.stringify(leg?.disk?.settings?.variablesGlobal ?? null).includes(globalMark);
    const reloadSawEmpty = hasEmptyClause({ request: leg?.reload?.request ?? null }, C.chat);

    // HALF (ii) IS ASSERTED ON THE VALUE THE TREE CAN ACTUALLY CARRY, NOT ON THE EMPTY FORM.
    //
    // MEASURED IN 40878005589: `disk.settings.variablesGlobal` was `{}` on BOTH subjects while `survivesFreshPage`
    // was green, because the old guard accepted `hasEmptyClause(C.chat)` -- "the macro resolved to nothing" -- as
    // evidence that a value had survived. It cannot be: the empty form is exactly what a value that was NEVER written
    // produces (`(localVariable || '')`, public/scripts/variables.js:45), so the assertion was satisfied by the
    // absence of any value. That is the green-that-cannot-fail shape AGENTS.md 7 exists against.
    //
    // The value this vehicle can persist is the GLOBAL one, for a reason read from the pinned semantics rather than
    // chosen: `hv_preset` is DELETED by the last chat case (src/function/variables.ts:130-150 -> chat_metadata), and no
    // chat is open in this vehicle, so the chat scope never reaches a file at all; the global write goes to
    // `extension_settings.variables.global` + `saveSettingsDebounced` (:169-173), and the probe now WAITS for that file
    // (bounded, `global-write-persisted`). The staged preset prompt carries the global clause (`HV-PRESET-GLOBAL=`), so
    // a page -- and a process -- that wrote NOTHING resolves the value from settings.json or not at all.
    const reloadCapture = leg?.reload?.request ?? null;
    const reloadGlobalValue = hasClause({ request: reloadCapture }, C.global, globalMark);
    const survivesFreshPage = Boolean(reloadCapture) && reloadGlobalValue;

    // THE RESTART LEG: a NEW process over the tree the on-leg left, and its case set WRITES NOTHING.
    const restartCase = caseOf(restartLeg, 'reload-chat');
    const restartGlobalValue = hasClause(restartCase, C.global, globalMark);
    // A NEW SERVER INSTANCE, FROM WHAT THE LEG CAN SEE. Two signals, either of which establishes it:
    //   - the process ids, when BOTH legs were spawned by the probe (the GoTavern legs);
    //   - the endpoint epochs, which is the only one available on the pinned leg. MEASURED IN 40878005589: every
    //     PINNED leg recorded NO `serverPid` -- the pinned server is booted by run-against-pinned.mjs, not by the
    //     probe -- so `Boolean(undefined) && …` made this FALSE on the pinned subject for every recording. That is a
    //     structural asymmetry no product behaviour could clear, and half of the survivesRestart asymmetry.
    const onPid = leg?.provenance?.serverPid ?? null;
    const restartPid = restartLeg?.provenance?.serverPid ?? null;
    const onEpoch = leg?.provenance?.serverEpoch ?? null;
    const restartEpoch = restartLeg?.provenance?.serverEpoch ?? null;
    const restartIsNewProcess = (restartPid !== null && onPid !== null && restartPid !== onPid)
        || (restartEpoch !== null && onEpoch !== null && restartEpoch !== onEpoch);
    // NO FALLBACK TO `chat-alpha`. The previous version fell back to the restart leg's `chat-alpha` case, which the
    // restart leg WROTE before generating -- so the guard was satisfied by the leg's own write, not by the tree. The
    // read-only case is the whole assertion; if it is absent the guard is false, and the drive-step list says so.
    const survivesRestart = Boolean(restartCase?.request) && restartGlobalValue && restartIsNewProcess;

    // THE OFF CONTROL
    const offAlpha = caseOf(offLeg, 'chat-alpha');
    const offBeta = caseOf(offLeg, 'chat-deleted');
    const onAlpha = caseOf(leg, 'chat-alpha');
    const offHasNoValue = Boolean(offLeg)
        && !hasClause(offLeg && caseOf(offLeg, 'chat-alpha'), C.chat, chat)
        && !hasClause(offLeg && caseOf(offLeg, 'global-set'), C.global, globalMark)
        && Boolean(offAlpha?.request);
    // THE PAIR MUST BE STABLE, AND THE ONLY THING ALLOWED TO DIFFER IS THE DRIVER'S OWN INPUT.
    //
    // MEASURED IN 40878005589: `offStable` compared the off leg's `chat-alpha` and `chat-deleted` captures by RAW
    // sha256, and they were NEVER equal -- e6659347… (293 B) vs f02c04bb… (295 B), the SAME two digests on BOTH
    // subjects -- because every case passes its own NAME as `generate({user_input})` and the host puts it on the wire
    // as the last user message (`{"role":"user","content":"chat-alpha"}`). The 2-byte difference between the two names
    // was the entire difference, so the guard was unsatisfiable by construction: a harness precondition, not a product
    // observation. The comparator then declared it unproven, and the verifier refused the artefact because a guard can
    // be neither required nor declared away.
    //
    // THE FIX IS NOT TO DROP THE COMPARISON. The property the guard exists for is "nothing the HARNESS did between two
    // otherwise identical cases changed the request", so the two captures are compared with EXACTLY the driver's own
    // injected literal masked on both sides and nothing else edited. Every remaining byte still has to match, so a
    // variable write that leaked into the off leg, a timestamp, or any other interference still fails this.
    const maskOwnInput = entry => {
        let text = body(entry);
        for (const name of caseNames) {
            text = text.replace(new RegExp(`("content"\\s*:\\s*)"${escapeRegExp(name)}"`, 'g'), '$1"<case-input>"');
        }
        return text;
    };
    const offAlphaMaskedSha = offAlpha?.request ? digestOf(maskOwnInput(offAlpha)) : null;
    const offBetaMaskedSha = offBeta?.request ? digestOf(maskOwnInput(offBeta)) : null;
    const offStable = Boolean(offAlpha?.request && offBeta?.request) && offAlphaMaskedSha === offBetaMaskedSha;
    // ...AND THE PAIR MUST DISCRIMINATE (rule 50): the on capture for the same case must DIFFER from the off one, or
    // the variable changed nothing and "the off control matched" is satisfied by two identical requests.
    const offDiffersFromOn = Boolean(onAlpha?.request && offAlpha?.request) && onAlpha.request.sha256 !== offAlpha.request.sha256;

    observed[subject] = {
        legPresent: Boolean(leg),
        apiSurface: leg?.apiSurface ? {
            pinnedCommit: leg.apiSurface.pinnedCommit,
            manifestVersion: leg.apiSurface.manifestVersion,
            scopes: Object.keys(leg.apiSurface.scopes ?? {}),
            exportCount: Object.keys(leg.apiSurface.exports ?? {}).length,
            absentConfirmed: (leg.apiSurface.absentConfirmed ?? []).map(entry => entry.name),
        } : null,
        halfI: { valueOnWire, secondValueOnWire, changeDiffered, changeLostOld, macroWasTheResolver, deleteIsEmptyForm, deleteDroppedValue, deleteMechanismShown },
        mechanism: { alpha: alphaMechanism, beta: betaMechanism, global: globalMechanism, deleted: deleteMechanism },
        scopes: { globalOnWire, messageStored, messageNotOnWire, messageRefused, messageRowComplete, chatSeedOk },
        halfII: {
            chatVariableNames: [...new Set(chatVariables.map(entry => entry.name))],
            globalOnDisk,
            reloadSawEmpty,
            reloadGlobalValue,
            survivesFreshPage,
            restartCaseName: restartCase?.case ?? null,
            restartGlobalValue,
            survivesRestart,
            restartIsNewProcess,
            restartProcessProof: {
                onPid,
                restartPid,
                onEpoch,
                restartEpoch,
                mechanism: 'process ids when the probe spawned both servers; otherwise the endpoint epoch (a digest of the base URL, never the URL), because every invocation is served by its own server',
            },
        },
        offControl: {
            offHasNoValue,
            offStable,
            offDiffersFromOn,
            offRawSha: { alpha: offAlpha?.request?.sha256 ?? null, beta: offBeta?.request?.sha256 ?? null },
            offMaskedSha: { alpha: offAlphaMaskedSha, beta: offBetaMaskedSha },
            mask: 'the driver passes each case NAME as generate({user_input}), so "content":"<case>" is replaced with "content":"<case-input>" on BOTH off captures before they are compared; nothing else is edited',
            maskedTokens: caseNames,
        },
        extensionRevision: {
            installed: leg?.provenance?.extension?.installedRevision ?? null,
            heldAfterDrive: (leg?.steps ?? []).find(item => item.name === 'extension-revision-held')?.ok ?? null,
        },
        captures: (leg?.cases ?? []).map(entry => ({ case: entry.case, sha256: entry.request?.sha256 ?? null, byteLength: entry.request?.byteLength ?? null, arrived: Boolean(entry.request), error: entry.error ?? null })),
        timings: leg?.timings?.phases ?? null,
        failure: neutraliseHostPaths(leg?.failure ?? null),
    };
}

const guards = {};
// THE PINNED COMMIT AS A LITERAL, NOT AS THE OTHER LEG'S RECORD. Same defect and same fix as
// compare-helper-vars-legs.mjs: the right-hand side of the old comparison was `on.pinned.apiSurface`, i.e. the
// object the pinned subject's own value came from, so the pinned half of this guard was a self-comparison and
// could not fail.
const PINNED_HELPER_COMMIT = '837a6288135cde61522a9279173b98020f08807e';
const subjectGuards = {
    legsPresent: subjects.map(subject => observed[subject].legPresent),
    // THE STAGED PRESET MUST EXIST ON BOTH SUBJECTS BEFORE EITHER IS JUDGED, and the probe reports it
    // (`fixture.afterWrite`). Without this guard a leg could generate from whatever preset the tree happened to carry,
    // and every wire assertion would then be about the wrong prompt -- red, or worse green, for a reason that has
    // nothing to do with the product. DECLARED AT MODULE SCOPE, not inside the per-subject loop below: registering it
    // in `subjectGuards` from a loop-local binding threw `ReferenceError: presetStaged is not defined` on run
    // 40479754257, which crashed the comparator and read as a judgment until the log was opened.
    presetStaged: subjects.map((subject, index) => presetStagedPerSubject[index]),
    // THE RESTART LEG MUST HAVE WRITTEN NOTHING (see restartLegIsReadOnly above).
    restartLegIsReadOnly: restartLegIsReadOnly,
    sameApiSurface: subjects.map(subject => {
        const surface = observed[subject].apiSurface;
        return Boolean(surface) && surface.pinnedCommit === PINNED_HELPER_COMMIT && surface.scopes.length === 7 && surface.exportCount >= 14;
    }),
    // HALF (i)
    valueOnWire: subjects.map(subject => observed[subject].halfI.valueOnWire),
    // THE MECHANISM, as its own guard: the resolved value being on the wire and the MACRO resolving it are different
    // facts, and only the second one makes this a test of 酒馆助手's variables rather than of the harness's own string.
    macroWasTheResolver: subjects.map(subject => observed[subject].halfI.macroWasTheResolver),
    changeChangesTheWire: subjects.map(subject => observed[subject].halfI.secondValueOnWire && observed[subject].halfI.changeDiffered && observed[subject].halfI.changeLostOld),
    deleteReturnsToEmptyForm: subjects.map(subject => observed[subject].halfI.deleteIsEmptyForm && observed[subject].halfI.deleteDroppedValue && observed[subject].halfI.deleteMechanismShown),
    // SCOPES
    globalScopeReachesWire: subjects.map(subject => observed[subject].scopes.globalOnWire),
    // Either the write landed and stayed off the wire, or it was refused identically on both subjects. Both are the
    // claim for this row; only one subject refusing would surface as an asymmetry.
    messageStoredNotSurfaced: subjects.map(subject => observed[subject].scopes.chatSeedOk
        ? (observed[subject].scopes.messageStored && observed[subject].scopes.messageNotOnWire)
        : observed[subject].scopes.messageRefused),
    // HALF (ii)
    survivesFreshPage: subjects.map(subject => observed[subject].halfII.survivesFreshPage),
    survivesRestart: subjects.map(subject => observed[subject].halfII.survivesRestart),
    // THE PAIR IS DISCRIMINATING: nothing was written in the off leg, its two captures agree once the driver's own
    // case-name input is masked out, and the on capture for the same case DIFFERS from it (rule 50 -- without the
    // last part the guard is satisfied by two identical requests, which is the state it exists to detect).
    offIsTheControl: subjects.map(subject => observed[subject].offControl.offHasNoValue
        && observed[subject].offControl.offStable
        && observed[subject].offControl.offDiffersFromOn),
};

const asymmetries = [];
for (const [name, values] of Object.entries(subjectGuards)) {
    const trueCount = values.filter(Boolean).length;
    if (trueCount > 0 && trueCount < values.length) asymmetries.push({ guard: name, gotavern: values[0], pinned: values[1] });
    guards[name] = trueCount === values.length;
}

// nodeEqualsGo: the provider-wire contract, case by case.
const mismatches = [];
for (const name of new Set((on.gotavern?.cases ?? []).map(entry => entry.case))) {
    const mine = caseOf(on.gotavern, name)?.request ?? null;
    const theirs = caseOf(on.pinned, name)?.request ?? null;
    if (JSON.stringify(mine?.sha256 ?? null) !== JSON.stringify(theirs?.sha256 ?? null)) mismatches.push({ case: name, field: 'sha256', gotavern: mine?.sha256 ?? null, pinned: theirs?.sha256 ?? null });
    if (JSON.stringify(mine?.byteLength ?? null) !== JSON.stringify(theirs?.byteLength ?? null)) mismatches.push({ case: name, field: 'byteLength', gotavern: mine?.byteLength ?? null, pinned: theirs?.byteLength ?? null });
    if (JSON.stringify(body({ request: mine })) !== JSON.stringify(body({ request: theirs }))) mismatches.push({ case: name, field: 'body', gotavern: mine?.sha256 ?? null, pinned: theirs?.sha256 ?? null });
}
guards.nodeEqualsGo = mismatches.length === 0;

if (DRIVE_STEP_FAILURES.length > 0) guards.driveCompleted = false;
else guards.driveCompleted = true;
const missingLegs = Object.entries(legs).filter(([, entry]) => !entry.present).map(([key, entry]) => `${key}${entry.path ? ` (${legFileName(entry.path)}: ${entry.error ?? 'absent'})` : ''}`);
if (missingLegs.length > 0) guards.legsPresent = false;

const unprovenEntries = [
    'a real provider: the peer is an in-process simulated backend, so rule 22 makes every wire measurement here unverified for PRODUCTION. What is proven is the frontend+helper transform, not the transport to a live endpoint.',
    'the `preset` and `character` scopes: this vehicle writes chat, global and message only. The preset scope needs a preset to exist, which is the SECOND probe (helper-vars-probe.mjs) and the harder vehicle for that narrower purpose.',
    'streaming / cancellation: every generateRaw sets should_stream false so the peer can answer without SSE framing.',
    'the `script` and `extension` scopes: both exist at the pinned commit and neither has a host macro, so neither can reach a provider request; recorded in apiSurface.scopes and not driven.',
];
const guardMechanisms = {
    survivesRestart: () => `the restart leg did not show the GLOBAL value from the tree: restartPids=${JSON.stringify(subjects.map(subject => restart[subject]?.provenance?.serverPid ?? null))}, onPids=${JSON.stringify(subjects.map(subject => on[subject]?.provenance?.serverPid ?? null))}, restartCase=${JSON.stringify(subjects.map(subject => observed[subject].halfII.restartCaseName))}, restartGlobalValue=${JSON.stringify(subjects.map(subject => observed[subject].halfII.restartGlobalValue))}, revisionHeld=${JSON.stringify(subjects.map(subject => observed[subject].extensionRevision.heldAfterDrive))}. A restart leg that did not boot a NEW process, or whose only case is not the read-only one, is a HARNESS failure rather than a product finding -- measured in 40878005589, where the pinned leg was REFUSED because the page's own extension auto-update had moved the checkout off the pin (see the probe's holdExtensionAtPin) and the guard therefore came out true on one subject and false on the other.`,
    offIsTheControl: () => `the off legs did not behave as a control: offHasNoValue=${JSON.stringify(subjects.map(subject => observed[subject].offControl.offHasNoValue))} offStable=${JSON.stringify(subjects.map(subject => observed[subject].offControl.offStable))} offDiffersFromOn=${JSON.stringify(subjects.map(subject => observed[subject].offControl.offDiffersFromOn))} offRawSha=${JSON.stringify(subjects.map(subject => observed[subject].offControl.offRawSha))} offMaskedSha=${JSON.stringify(subjects.map(subject => observed[subject].offControl.offMaskedSha))}. A pair whose on and off captures are identical is HARNESS NON-DISCRIMINATING (rule 50); a pair whose two off captures differ AFTER the driver's own case-name input is masked is the harness changing something on his own.`,
};
for (const [name, mechanism] of Object.entries(guardMechanisms)) {
    if (guards[name] !== true) unprovenEntries.push(`${name}: ${mechanism()}`);
}
const declaredUnproven = new Set(unprovenEntries.map(entry => String(entry).split(':')[0].trim()));

const failedGuards = Object.entries(guards)
    .filter(([name, value]) => value !== true && !declaredUnproven.has(name))
    .map(([name]) => name);
for (const name of ['driveCompleted', 'legsPresent']) if (guards[name] === false && !failedGuards.includes(name)) failedGuards.push(name);

const artefact = {
    schemaVersion: 1,
    question: 'Does a 酒馆助手 variable resolve into the FINAL provider request during a real generateRaw, and is it still readable from disk after a fresh page and a new server process?',
    generatedBy: 'tests/browser/compare-helper-vars-generate-legs.mjs',
    vehicle: on.gotavern?.vehicle ?? on.pinned?.vehicle ?? null,
    uiVehicleRedRuns: on.gotavern?.uiVehicleRedRuns ?? on.pinned?.uiVehicleRedRuns ?? null,
    subject: 'tavern-helper@837a6288135cde61522a9279173b98020f08807e (manifest 4.11.3), host SillyTavern 06bde939fb1e9c4c8d8641d810f0a916b5bce127',
    surface: 'variables through the host macro engine (Q10), narrow vehicle',
    verdict: failedGuards.length === 0 && asymmetries.length === 0 ? 'PASS' : 'FAIL',
    guards,
    failedGuards,
    driveStepFailures: DRIVE_STEP_FAILURES,
    missingLegs,
    asymmetries,
    mismatches,
    marks: MARKS,
    clauses: C,
    apiSurface: { gotavern: observed.gotavern?.apiSurface ?? null, pinned: observed.pinned?.apiSurface ?? null },
    unproven: unprovenEntries,
    declaredUnproven: [...declaredUnproven].sort(),
    subjects: observed,
    answers: {
        // THE SCOPE OF THIS CLAIM, stated as narrowly as it is true. `generateRaw` with ordered_prompts and
        // max_chat_history:0 is a DIFFERENT assembly from an ordinary `Generate` turn, so a green here says exactly
        // this and no more. The UI vehicle is the evidence for the other half; the two together are stronger than
        // either stretched.
        'Q10 do variables reach the final request': 'guards.valueOnWire + guards.macroWasTheResolver + guards.changeChangesTheWire + guards.deleteReturnsToEmptyForm -- on the RAW BODY BYTES, at the clause the prompt carries. SCOPE: generateRaw\'s ordered_prompts assembly, NOT an ordinary chat-completion turn; the claim supported is "a chat-scoped helper variable reaches the wire through generateRaw\'s ordered prompts and the host macro engine", not "through an ordinary Generate turn".',
        'Q10 persistence': 'guards.survivesFreshPage + guards.survivesRestart -- a fresh page and a NEW server process',
        'scope isolation / second scope': 'guards.globalScopeReachesWire',
        'message scope': 'guards.messageStoredNotSurfaced -- a FINDING: stored in the page, absent from the wire because no host macro reads a message scope',
        'not exercised here': 'preset and character scopes (the UI-vehicle probe), real provider, streaming (see unproven[])',
    },
    legs: Object.fromEntries(Object.entries(legs).map(([key, value]) => [key, {
        present: value.present,
        // THE FILE IS NAMED, NOT LOCATED. The report path is the RUN's directory -- `/home/runner/work/_temp/...` in CI,
        // `C:\Users\<user>\AppData\Local\Temp\...` on a development host -- and a committed artefact may not carry it
        // (tools/verify-browser-comparisons.mjs HOST_DERIVED_PATTERNS refused the fresh artefact on exactly this field).
        file: legFileName(value.path),
        subject: value.leg?.subject ?? null,
        variant: value.leg?.variant ?? null,
        afterRestart: value.leg?.afterRestart ?? null,
        // THE EXCEPTION PATH IS KEPT AND THE MACHINE IS REMOVED: a leg that REFUSED is the most valuable record in the
        // artefact, and its message is what makes it actionable, so only the absolute paths inside it are normalised.
        failure: neutraliseHostPaths(value.leg?.failure ?? null),
        cases: (value.leg?.cases ?? []).map(entry => entry.case),
        steps: (value.leg?.steps ?? []).map(item => `${item.ok === null ? 'n/a' : item.ok ? 'ok' : 'FAIL'} ${item.name}`),
    }])),
};

const serialised = `${JSON.stringify(artefact, null, 2)}\n`;
if (artefactPath) await fs.writeFile(artefactPath, serialised);
process.stdout.write(serialised);
if (failedGuards.length > 0 || asymmetries.length > 0) {
    console.error(`helper variables (narrow) comparison FAILED: guards=[${failedGuards.join(', ')}] asymmetries=[${asymmetries.map(item => item.guard).join(', ')}] mismatches=[${mismatches.map(item => `${item.case}.${item.field}`).join(', ')}]`);
    if (DRIVE_STEP_FAILURES.length > 0) console.error(`drive steps that did not happen:\n  ${DRIVE_STEP_FAILURES.join('\n  ')}`);
    if (missingLegs.length > 0) console.error(`legs missing (a leg whose \`if:\` was false reports nothing, so this is a NAMED refusal):\n  ${missingLegs.join('\n  ')}`);
    process.exitCode = 1;
}
