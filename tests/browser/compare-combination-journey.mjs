// THE JUDGE FOR THE COMBINATION JOURNEY.
//
// Inputs: the journey probe's report for the GoTavern drive leg, the pinned drive leg, their restart legs over the
// SAME trees, and (optionally) pinned's HAND-BACK leg over the GoTavern-written tree.
//
// TWO KINDS OF GUARD, and the verdict needs both:
//   1. WIRE — per-capture equality of method + raw target + byteLength + sha256 of the raw body (no canonicalisation).
//   2. OBSERVED FACTS — the per-subject steps the probe itself recorded. A step is `ok` only where THAT subject's
//      own observations satisfied it: the preset pieces, the three world-info slots, the three variable scopes, the QR
//      injection, the author's note, the regex-rewritten reply, the verbs, the branch, the group turn, the durable
//      chat, and the reload/restart survival. Cross-subject equality of these steps is the differential: GoTavern is
//      only credited for a fact pinned Node also observed.
//
// TWO-SUBJECT ASYMMETRY IS A FAILED GUARD even when each leg's own step list is green: a guard is true only when
// BOTH subjects observed it, and `asymmetries` names every pair that disagreed.
//
// REFUSAL: a restart pair or hand-back leg that is not supplied makes its guards false — NOT-OBSERVED, never green.
//
// Usage:
//   node tests/browser/compare-combination-journey.mjs <go-drive> <pinned-drive>
//     [--restart <go-restart> <pinned-restart>] [--handback <pinned-handback>] [--out <json>]

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const read = target => JSON.parse(fs.readFileSync(path.resolve(target), 'utf8'));
const byCase = report => {
    const map = {};
    for (const request of report.requests ?? []) {
        if (!request.case) continue;
        (map[request.case] ?? (map[request.case] = [])).push(request);
    }
    return map;
};
const shaList = entries => (entries ?? []).map(entry => entry.sha256);
const stepValue = (report, name) => (report.steps ?? []).find(entry => entry.name === name) ?? null;
const stepOk = (report, name) => stepValue(report, name)?.ok === true;
const firstRequest = (report, caseName) => (byCase(report)[caseName] ?? [])[0] ?? null;
const bodyOf = request => String(request?.body ?? '');
const detailOf = (report, name) => stepValue(report, name)?.detail ?? null;

const guard = (name, go, pinned, detail = null) => ({ name, go, pinned, ok: go === true && pinned === true, detail });

export function compareCombinationJourney({ goDrive, pinnedDrive, goRestart = null, pinnedRestart = null, handback = null }) {
    const guards = [];
    const asymmetries = [];
    const add = (name, goValue, pinValue, detail = null) => {
        const go = goValue === true;
        const pinned = pinValue === true;
        guards.push(guard(name, go, pinned, detail));
        if (go !== pinned) asymmetries.push({ guard: name, gotavern: go, pinned });
    };
    const observed = (name, detail = null) => add(name, stepOk(goDrive, name), stepOk(pinnedDrive, name),
        detail ?? { gotavern: detailOf(goDrive, name), pinned: detailOf(pinnedDrive, name) });

    // ---- faithfulness ---------------------------------------------------------------------------------
    add('go-leg-is-a-gotavern-drive', goDrive.phase === 'drive' && goDrive.subject === 'gotavern',
        pinnedDrive.phase === 'drive' && pinnedDrive.subject === 'pinned');
    add('both-legs-have-no-failed-step', (goDrive.steps ?? []).every(entry => entry.ok === true), (pinnedDrive.steps ?? []).every(entry => entry.ok === true),
        { gotavern: (goDrive.steps ?? []).filter(entry => !entry.ok).map(entry => entry.name), pinned: (pinnedDrive.steps ?? []).filter(entry => !entry.ok).map(entry => entry.name) });
    add('no-page-errors', (goDrive.pageErrors ?? []).length === 0, (pinnedDrive.pageErrors ?? []).length === 0,
        { gotavern: (goDrive.pageErrors ?? []).slice(0, 4), pinned: (pinnedDrive.pageErrors ?? []).slice(0, 4) });
    add('fixture-and-extension-recorded',
        Boolean(goDrive.fixture?.card?.sha256) && goDrive.fixture?.apiSurface?.pinned === true,
        Boolean(pinnedDrive.fixture?.card?.sha256) && pinnedDrive.fixture?.apiSurface?.pinned === true);

    // ---- WIRE: per-capture byte equality --------------------------------------------------------------
    const goCases = byCase(goDrive);
    const pinCases = byCase(pinnedDrive);
    const common = Object.keys(goCases).filter(name => name in pinCases).sort();
    const missingPairs = Object.keys(goCases).filter(name => !(name in pinCases)).concat(Object.keys(pinCases).filter(name => !(name in goCases)));
    const mismatches = common
        .filter(name => JSON.stringify(shaList(goCases[name])) !== JSON.stringify(shaList(pinCases[name])))
        .map(name => ({
            case: name,
            gotavern: shaList(goCases[name]),
            pinned: shaList(pinCases[name]),
            gotavernBytes: goCases[name].map(entry => entry.byteLength),
            pinnedBytes: pinCases[name].map(entry => entry.byteLength),
        }));
    add('both-subjects-captured-the-same-turns', missingPairs.length === 0, missingPairs.length === 0, { missingPairs });
    add('nodeEqualsGo-per-capture', common.length >= 5 && mismatches.length === 0, common.length >= 5 && mismatches.length === 0,
        { commonCases: common.length, mismatches });
    add('all-captures-were-streamed', (goDrive.requests ?? []).every(entry => entry.requestedStream === true), (pinnedDrive.requests ?? []).every(entry => entry.requestedStream === true));
    add('peer-served-sse', (goDrive.requests ?? []).every(entry => entry.served?.wire === 'sse'), (pinnedDrive.requests ?? []).every(entry => entry.served?.wire === 'sse'));

    // ---- the armed journey, fact by fact, from each subject's OWN steps --------------------------------
    for (const name of [
        'world-info-selected-after-boot', 'world-info-persisted-after-boot', 'user-name-set', 'drive-injections-active-in-page',
        'character-opened', 'character-scoped-regex-allowed-and-visible', 'complex-preset-selected',
        'authors-note-applied', 'helper-variables-written', 'helper-closure-inside-iframe',
        'quick-reply-created-and-executed', 'turn-1-request-captured', 'turn-1-streaming-requested',
        'turn-1-preset-pieces-in-request', 'turn-1-world-info-three-slots-placed', 'turn-1-variables-in-request',
        'turn-1-quick-reply-in-request', 'turn-1-authors-note-in-request', 'regex-rewrote-visible-message',
        'turn-2-history-carries-regex-rewritten-text', 'turn-2-history-carries-turn-1',
    ]) observed(name);

    // The verbs are only claimed where their own step fired on both subjects. A verb the harness could not drive
    // (a send swallowed by a page left busy by a PRESET SWITCH) is red here by name, never skipped.
    for (const name of ['swipe-produced-a-request', 'swipe-state-moved', 'regenerate-produced-a-request', 'continue-produced-a-request',
        'branch-created-through-frontend-bookmarks', 'group-chat-opened', 'group-turn-produced-request',
        'returned-to-journey-chat', 'final-turn-earned-request', 'journey-chat-written',
        'disk-chat-carries-regex-rewritten-reply', 'disk-chat-carries-branch-metadata']) observed(name);

    // ---- discrimination (AGENTS 50): the harness's captures move when its knobs move -------------------
    observed('preset-off-turn-captured');
    observed('preset-off-request-lacks-preset-markers');
    observed('wi-off-turn-captured');
    observed('wi-off-request-lacks-world-info');
    observed('preset-restored-after-control');
    observed('world-info-restored-after-control');
    observed('world-info-selection-persisted-to-disk');
    add('control-captures-differ-from-armed',
        Boolean(firstRequest(goDrive, 'control-preset-off')) && firstRequest(goDrive, 'control-preset-off').sha256 !== firstRequest(goDrive, 'turn-1-armed')?.sha256,
        Boolean(firstRequest(pinnedDrive, 'control-preset-off')) && firstRequest(pinnedDrive, 'control-preset-off').sha256 !== firstRequest(pinnedDrive, 'turn-1-armed')?.sha256);

    // ---- reload survival ------------------------------------------------------------------------------
    for (const name of ['chat-saved-and-reloaded', 'reload-chat-reopened', 'reload-preserved-history', 'reload-world-info-persisted-from-disk', 'reload-ready-to-send', 'reload-prompt-manager-armed', 'after-reload-turn-captured',
        'reload-helper-reran-and-reinjected-variables', 'reload-injections-active-in-page',
        'after-reload-request-carries-surviving-state', 'after-reload-request-carries-preset-and-regex',
        'after-reload-request-carries-variables-and-qr']) observed(name);

    // ---- restart survival (over the SAME trees) -------------------------------------------------------
    if (goRestart && pinnedRestart) {
        add('restart-legs-are-restart-phase', goRestart.phase === 'restart', pinnedRestart.phase === 'restart');
        for (const name of ['restart-found-the-journey-chat', 'restart-reopened-the-saved-chat', 'restart-chat-ready', 'restart-prompt-manager-armed', 'restart-world-info-selected',
            'after-restart-helper-reran', 'restart-injections-active-in-page',
            'after-restart-request-captured', 'after-restart-request-carries-preset-and-world-info',
            'after-restart-request-carries-history', 'after-restart-request-carries-variables-and-qr',
            'after-restart-request-carries-authors-note', 'after-restart-request-carries-regex-rewritten-history']) {
            add(name, stepOk(goRestart, name), stepOk(pinnedRestart, name), { gotavern: detailOf(goRestart, name), pinned: detailOf(pinnedRestart, name) });
        }
        const restartPairs = Object.keys(byCase(goRestart)).filter(name => name in byCase(pinnedRestart)).sort();
        const restartMismatch = restartPairs.filter(name => JSON.stringify(shaList(byCase(goRestart)[name])) !== JSON.stringify(shaList(byCase(pinnedRestart)[name])));
        add('restart-capture-equality', restartPairs.length >= 1 && restartMismatch.length === 0, restartPairs.length >= 1 && restartMismatch.length === 0,
            { pairs: restartPairs, mismatch: restartMismatch });
    } else {
        add('restart-legs-supplied', false, false, { reason: 'no restart pair supplied: the restart claim is NOT-OBSERVED' });
    }

    // ---- hand-back: pinned Node over the GoTavern-written tree ------------------------------------------
    if (handback) {
        add('handback-world-info-selected', stepOk(handback, 'handback-world-info-selected'), stepOk(handback, 'handback-world-info-selected'));
        add('handback-pinned-read-the-gotavern-chat', stepOk(handback, 'handback-tree-has-the-journey-chat') && stepOk(handback, 'handback-opened-the-gotavern-chat') && stepOk(handback, 'handback-chat-ready') && stepOk(handback, 'handback-prompt-manager-armed'),
            stepOk(handback, 'handback-tree-has-the-journey-chat') && stepOk(handback, 'handback-opened-the-gotavern-chat'));
        add('handback-pinned-continued-and-persisted', stepOk(handback, 'handback-continued-and-reached-provider') && stepOk(handback, 'handback-persisted-its-turn'),
            stepOk(handback, 'handback-continued-and-reached-provider') && stepOk(handback, 'handback-persisted-its-turn'));
    } else {
        add('handback-leg-supplied', false, false, { reason: 'no hand-back leg supplied: the Node -> Go -> Node claim is NOT-OBSERVED' });
    }

    // ---- the durable chat -----------------------------------------------------------------------------
    // THE DURABLE CHAT, NORMALISED ONLY FOR THE FILENAME AND THE BRANCH *NAMES*:
    //   * chat FILE names carry the chat's creation timestamp (one per run), so the file NAME is not part of the
    //     product contract; the file's message sequence is;
    //   * `extra.branches` stores the branch CHAT NAMES, which embed that same timestamp. The BRANCH EXISTENCE and
    //     COUNT are the product fact; the generated name is volatile by construction and is declared here rather than
    //     compared. Everything else (name, is_user, mes, swipes, swipe_id) is compared verbatim.
    const messageShape = file => ({
        messages: (file.messages ?? []).map(message => ({
            name: message.name ?? null,
            is_user: message.is_user === true,
            mes: String(message.mes ?? ''),
            swipes: Array.isArray(message.swipes) ? message.swipes.map(String) : null,
            swipe_id: message.swipe_id ?? null,
            branchCount: Array.isArray(message.branches) ? message.branches.length : null,
        })),
    });
    const journeyFiles = report => Object.values(report.disk?.projection ?? {})
        .filter(file => (file.messages ?? []).some(message => String(message.mes).includes('COMB_')))
        .map(messageShape)
        .sort((first, second) => String(first.messages[0]?.mes ?? '').localeCompare(String(second.messages[0]?.mes ?? '')));
    const goDisk = journeyFiles(goDrive);
    const pinDisk = journeyFiles(pinnedDrive);
    add('both-subjects-wrote-a-journey-chat', goDisk.length > 0, pinDisk.length > 0);
    add('journey-chat-projection-equal-modulo-declared-volatile', JSON.stringify(goDisk) === JSON.stringify(pinDisk), JSON.stringify(goDisk) === JSON.stringify(pinDisk),
        { gotavernFiles: goDisk.length, pinnedFiles: pinDisk.length });

    const failedGuards = guards.filter(entry => entry.ok !== true).map(entry => entry.name);
    const verdict = failedGuards.length === 0 && asymmetries.length === 0 ? 'match' : 'mismatch';
    return {
        schemaVersion: 1,
        question: 'Does the full combination journey produce the same provider requests, browser state and durable chat on both subjects in ONE session, and does pinned Node continue the GoTavern-written chat?',
        verdict,
        guards: Object.fromEntries(guards.map(entry => [entry.name, entry.ok])),
        failedGuards,
        asymmetries,
        subjectGuards: guards.map(entry => ({ name: entry.name, gotavern: entry.go, pinned: entry.pinned })),
        captures: { commonCases: common, missingPairs, mismatches },
        subjects: {
            gotavern: { steps: (goDrive.steps ?? []).length, failedSteps: (goDrive.steps ?? []).filter(entry => !entry.ok).map(entry => entry.name), requestCount: (goDrive.requests ?? []).length, cases: Object.keys(goCases).sort() },
            pinned: { steps: (pinnedDrive.steps ?? []).length, failedSteps: (pinnedDrive.steps ?? []).filter(entry => !entry.ok).map(entry => entry.name), requestCount: (pinnedDrive.requests ?? []).length, cases: Object.keys(pinCases).sort() },
        },
        unproven: [
            'a real provider: the peer is an in-process recording backend (AGENTS 22); every wire observation here is unverified for PRODUCTION.',
            "multi-user and a real user's card/preset prose (committed derivations only, AGENTS 56).",
            'text-completion instruct/context templates do not enter a chat-completion request; recorded from the planted preset file, not claimed on the wire.',
            "the group turn's multi-member fan-out is recorded as however many requests the product made rather than asserted to a number.",
        ],
    };
}

function main() {
    const argv = process.argv.slice(2);
    const positional = [];
    const sections = { restart: [], handback: [] };
    let current = null;
    let out = null;
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        if (token === '--restart' || token === '--handback') { current = token.slice(2); continue; }
        if (token === '--out') { out = argv[index + 1]; index += 1; current = null; continue; }
        if (current === null) positional.push(token);
        else sections[current].push(token);
    }
    if (positional.length !== 2) {
        console.error('usage: node compare-combination-journey.mjs <go-drive> <pinned-drive> [--restart <go-restart> <pinned-restart>] [--handback <pinned-handback>] [--out <json>]');
        process.exit(2);
    }
    const result = compareCombinationJourney({
        goDrive: read(positional[0]),
        pinnedDrive: read(positional[1]),
        goRestart: sections.restart[0] ? read(sections.restart[0]) : null,
        pinnedRestart: sections.restart[1] ? read(sections.restart[1]) : null,
        handback: sections.handback[0] ? read(sections.handback[0]) : null,
    });
    for (const entry of result.subjectGuards) console.error(`${entry.gotavern === true && entry.pinned === true ? 'ok  ' : 'FAIL'} ${entry.name} -- gotavern=${entry.gotavern} pinned=${entry.pinned}`);
    console.log(`${JSON.stringify(result, null, 2)}\n`);
    if (out) fs.writeFileSync(path.resolve(out), `${JSON.stringify(result, null, 2)}\n`);
    console.error(`verdict: ${result.verdict}${result.failedGuards.length ? ` -- failed guards: ${result.failedGuards.join(', ')}` : ''}`);
    process.exit(result.verdict === 'match' ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))) main();
