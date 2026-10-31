// DOES THE WHOLE-SESSION GATE HAVE TEETH? — eleven mutations against the run's OWN four artefacts.
//
// WHY THIS EXISTS AT ALL. A comparator that returns `match` is only evidence if it can return something else. This
// project's doctrine (AGENTS.md "Differential-testing doctrine" 4) requires the red to be OBSERVED, and it requires the
// red to be NAMED, so that "the gate went red" cannot be satisfied by a comparator that fails for an unrelated reason.
// Every mutation below therefore names the guard it intends to break, and this program fails if that guard did not
// fire — a mutation caught by the wrong assertion is not a demonstration of the right one.
//
// IT MUTATES THE ARTEFACTS IN MEMORY, NEVER ON DISK. A mutation that rewrites a recorded leg is the failure mode
// AGENTS rule 57 records: the committed evidence ends up describing something nobody ran. The clean copy is the one
// this program loaded; each mutation is applied to a structuredClone of it and thrown away.
//
// IT IMPORTS `compare` RATHER THAN REIMPLEMENTING IT. A selftest that re-derives the comparator's rules tests its own
// copy of them, and the copy that drifts is always the one nobody re-reads.
//
// THE MUTATIONS, and what each one would look like in production if the gate did not exist:
//   A  not-saving-the-reply            the assistant reply never reaches the chat file (one subject)
//   A2 not-saving-the-reply-on-both    the same defect on BOTH subjects -- invisible to any equality-only comparator,
//                                      which is why the absolute guards exist
//   B  reload-reads-a-different-chat   the reload lands on another conversation and the page shows the wrong history
//   C  regenerate-carries-the-replaced-reply   the prompt still contains the message the verb deleted
//   C2 regenerate-request-differs      the request is not byte-identical to pinned's
//   D  continue-uses-the-wrong-request the driver (or the product) pairs the verb with another turn's request
//   E  disk-persistence-changed        a persisted field is not what the page showed
//   F  restart-is-the-same-process     the "restart" leg re-read the drive leg's own process
//   G  harness-cannot-tell-subjects-apart   the two subjects' artefacts became indistinguishable
//   H  settings-reset-on-both          the user's setting did not survive (symmetrically, so equality still holds)
//   I  wire-journey-shortened-on-both  a verb produced no request at all (symmetrically)
//   J  resumed-request-attributed-to-the-last-request   the OLD `.at(-1)` selection: the helper completion that arrives
//                                      after the send is treated as the resumed turn (needs a helper-injected run)
//   K  resumed-history-dropped-despite-the-structure   the send's request lost the restored history where the prompt
//                                      order REQUIRES it
//   L  omission-claimed-without-a-structural-cause      the leg claims the preset omits chatHistory while the observed
//                                      row enables it and the request still carries history
//   M  resumed-request-differs-from-pinned             the attributed request is not byte-identical to pinned's
//   N  restart-preset-not-read-back                    the new process did not restore the preset the drive leg wrote
//   O  helper-completion-captured-as-the-send          the helper request was recorded as the send's own request
//   P  restart-completion-count-drops                  a leg issued fewer restart completions than its counterpart
//
// EXIT CODES: 0 = the baseline is a match AND every APPLICABLE mutation produced its named red; 1 = at least one
// mutation survived or fired the wrong guard; 2 = REFUSAL (an input cannot be read, or the baseline is not a match, in
// which case there is nothing to mutate and this program says so instead of reporting a vacuous success). A mutation
// whose precondition this run's artefacts do not carry (a preset, an injected helper completion) is reported
// `not-applicable` and is never counted as caught: an unrun mutation is not evidence.

import fs from 'node:fs/promises';
import { compare } from './compare-whole-session-legs.mjs';

function option(name, fallback = null) {
    const index = process.argv.indexOf(name);
    return index === -1 ? fallback : process.argv[index + 1];
}

async function readLeg(target, label) {
    if (!target) throw new Error(`REFUSED: --${label} was not given, so there is no artefact to mutate`);
    return JSON.parse(await fs.readFile(target, 'utf8'));
}

const legs = {
    goDrive: await readLeg(option('--drive-go'), 'drive-go'),
    pinnedDrive: await readLeg(option('--drive-pinned'), 'drive-pinned'),
    goRestart: await readLeg(option('--restart-go'), 'restart-go'),
    pinnedRestart: await readLeg(option('--restart-pinned'), 'restart-pinned'),
};

const clone = () => structuredClone(legs);

// THE BASELINE MUST BE GREEN, and it must be green with a non-trivial number of guards. A comparator that always fails
// would otherwise "catch" every mutation below while proving nothing.
const baseline = compare(legs);
if (baseline.verdict !== 'match') {
    console.error(`REFUSED: the baseline is a MISMATCH (${baseline.failedGuards.join(', ')}), so there is no green to mutate away from`);
    console.error('A teeth proof against a red baseline demonstrates nothing: the mutations would be "caught" by a comparator that never passed.');
    process.exit(2);
}
if (baseline.guardCount < 20) {
    console.error(`REFUSED: the baseline reported only ${baseline.guardCount} guards; that is too few for this surface, and the mutation set would not cover it`);
    process.exit(2);
}

const dropLastAssistant = leg => {
    const messages = leg.disk?.final?.chat?.messages ?? [];
    const index = [...messages].reverse().findIndex(message => message.is_user === false);
    if (index < 0) throw new Error('mutation fixture defect: no assistant message to drop');
    messages.splice(messages.length - 1 - index, 1);
    leg.disk.final.chat.messageCount = messages.length;
};

const MUTATIONS = [
    {
        name: 'A not-saving-the-reply (one subject)',
        // The chat file lost its last assistant message while the page still shows it. A parity comparator sees two
        // DIFFERENT disks and must go red on the equality guard; it must not "explain" either side.
        expected: 'disk-message-count-equal',
        apply: draft => { dropLastAssistant(draft.goDrive); },
    },
    {
        name: 'A2 not-saving-the-reply (BOTH subjects)',
        // THE SYMMETRIC CASE, and the reason the absolute guards exist: equality between two identically broken
        // subjects would hold. What must fire is the fact read from one leg.
        expected: 'disk-journey-is-complete',
        apply: draft => { dropLastAssistant(draft.goDrive); dropLastAssistant(draft.pinnedDrive); },
    },
    {
        name: 'B reload-reads-a-different-chat',
        expected: 'reload-state-equal',
        apply: draft => { draft.goDrive.browser.afterReload.state.chatId = 'a-chat-the-user-never-saved'; },
    },
    {
        name: 'C regenerate-carries-the-replaced-reply',
        expected: 'regenerate-request-excludes-the-replaced-reply',
        apply: draft => { draft.goDrive.browser.regenerate.request.carriesReplacedText = true; },
    },
    {
        name: 'C2 regenerate-request-differs-from-pinned',
        // The fourth completion of the drive journey is regenerate (turn one, swipe, turn two, regenerate, continue).
        expected: 'completion-4-equal',
        apply: draft => {
            const completion = draft.goDrive.wire.completions[3];
            if (!completion) throw new Error('mutation fixture defect: no fourth completion');
            completion.sha256 = `${completion.sha256.split('').reverse().join('')}`;
        },
    },
    {
        name: 'D continue-uses-the-wrong-request',
        expected: 'continue-request-ordinal-equal',
        apply: draft => { draft.goDrive.browser.continue.request.index += 1; },
    },
    {
        name: 'E disk-persistence-changed',
        expected: 'disk-message-fields-equal',
        apply: draft => {
            const message = draft.goDrive.disk.final.chat.messages[1];
            if (!message) throw new Error('mutation fixture defect: no second disk message');
            message.is_user = message.is_user !== true;
        },
    },
    {
        name: 'F restart-is-the-same-process',
        expected: 'restart-is-a-new-process',
        apply: draft => { draft.goRestart.server.pid = draft.goDrive.server.pid; },
    },
    {
        name: 'G harness-cannot-tell-the-subjects-apart',
        // The pinned leg's prefix is planted in the GoTavern leg's own disk swipes: the two artefacts stop differing
        // where the fixture requires them to differ, and "equal requests" would no longer mean the products agreed.
        expected: 'artefacts-differ-per-subject',
        apply: draft => {
            const pinnedPrefix = String(draft.pinnedDrive.replyPrefix ?? '');
            if (pinnedPrefix === '') throw new Error('mutation fixture defect: the pinned leg recorded no reply prefix');
            const message = (draft.goDrive.disk.final.chat.messages ?? []).find(entry => Array.isArray(entry.rawSwipes) && entry.rawSwipes.length > 0);
            if (!message) throw new Error('mutation fixture defect: no swiped message on the GoTavern leg');
            message.rawSwipes = [...message.rawSwipes, `${pinnedPrefix}planted`];
        },
    },
    {
        name: 'H settings-reset-on-both',
        expected: 'settings-value-is-the-requested-value',
        apply: draft => {
            draft.goDrive.disk.final.settings.temperature = 1;
            draft.pinnedDrive.disk.final.settings.temperature = 1;
        },
    },
    {
        name: 'I wire-journey-shortened-on-both',
        expected: 'wire-journey-is-complete',
        apply: draft => {
            for (const leg of [draft.goDrive, draft.pinnedDrive]) {
                leg.wire.completions = leg.wire.completions.slice(0, 3);
                leg.wire.count = 3;
            }
        },
    },
    {
        // THE OLD SELECTION, reproduced as a mutation. The peer's last completion is the helper's quiet one-system
        // request; a leg that armed its ordinal instead of the send's would attribute THAT to the send.
        name: 'J resumed-request-attributed-to-the-last-request',
        expected: 'resumed-request-attributed-to-the-send',
        requires: 'helper',
        apply: draft => {
            const helper = draft.goRestart.helperRequest;
            if (!helper?.injected) throw new Error('mutation fixture defect: this run injected no helper completion');
            draft.goRestart.browser.resumedTurn.armedOrdinal = helper.armedOrdinal;
        },
    },
    {
        name: 'K resumed-history-dropped-despite-the-structure',
        expected: 'restart-turn-carried-the-restored-history',
        // ONLY APPLICABLE WHERE THE STRUCTURE REQUIRES HISTORY: on an omission-control baseline the marker is already
        // absent by design, so dropping it changes nothing. The omission arm's own teeth are mutation Q.
        requires: 'history-required',
        apply: draft => {
            const request = draft.goRestart.browser.resumedTurn.request;
            if (!request) throw new Error('mutation fixture defect: no attributed resumed request');
            request.carriesFirstTurnMarker = false;
        },
    },
    {
        // The leg CLAIMS the preset omits chatHistory while its own observation says the row enables it and its own
        // request still carries the history. Both the classification guard and the omission-attribution guard must
        // refuse the claim; the named red is the one this mutation exists to demonstrate.
        name: 'L omission-claimed-without-a-structural-cause',
        expected: 'restart-history-omission-is-preset-attributable',
        requires: 'history-required',
        apply: draft => {
            const leg = draft.goRestart;
            if (!leg.promptOrder?.restartClassification) throw new Error('mutation fixture defect: no recorded classification');
            leg.promptOrder.restartClassification = { historyExpected: false, reason: 'prompt-order-row-disables-chatHistory' };
        },
    },
    {
        name: 'M resumed-request-differs-from-pinned',
        expected: 'restart-completion-equal',
        apply: draft => {
            const ordinal = Number(draft.goRestart.browser.resumedTurn.armedOrdinal);
            const completion = draft.goRestart.wire.completions[ordinal - 1];
            if (!completion) throw new Error('mutation fixture defect: no completion at the armed ordinal');
            completion.sha256 = completion.sha256.split('').reverse().join('');
        },
    },
    {
        name: 'N restart-preset-not-read-back',
        expected: 'restart-preset-restored-without-selection',
        requires: 'preset',
        apply: draft => {
            if (!draft.goRestart.preset?.name) throw new Error('mutation fixture defect: this run selected no preset');
            draft.goRestart.promptOrder.restart.presetSelected = 'Default';
        },
    },
    {
        name: 'O helper-completion-captured-as-the-send',
        expected: 'helper-completion-was-not-the-resumed-request',
        requires: 'helper',
        apply: draft => {
            const helper = draft.goRestart.helperRequest;
            const resumed = draft.goRestart.browser.resumedTurn.request;
            if (!helper?.request || !resumed) throw new Error('mutation fixture defect: no helper/resumed request pair');
            helper.request.bodySha256 = resumed.bodySha256;
            helper.request.ordinal = resumed.ordinal;
        },
    },
    {
        name: 'P restart-completion-count-drops',
        expected: 'restart-completion-count-equal',
        requires: 'helper',
        apply: draft => {
            if (!draft.goRestart.helperRequest?.injected) throw new Error('mutation fixture defect: no helper completion to drop');
            draft.goRestart.wire.completions = draft.goRestart.wire.completions.filter((_, index) => index !== Number(draft.goRestart.helperRequest.armedOrdinal) - 1);
        },
    },
    {
        // THE OMISSION ARM'S OWN TEETH: a control whose request does carry the restored history must be red. Without
        // this, "the history is absent" could pass by claiming the preset omitted it while the request was judged by
        // nothing at all.
        name: 'Q omission-leg-request-carries-restored-history',
        expected: 'restart-turn-carried-the-restored-history',
        requires: 'history-omitted',
        apply: draft => {
            const request = draft.goRestart.browser.resumedTurn.request;
            if (!request) throw new Error('mutation fixture defect: no attributed resumed request');
            request.carriesFirstTurnMarker = true;
            request.carriesSecondTurnMarker = true;
            request.carriesRestoredReplies = true;
        },
    },
];

let failures = 0;
const observed = [];
// WHICH PRE-CONDITIONS THIS RUN'S ARTEFACTS ACTUALLY CARRY. A mutation is only evidence if it RAN: an unrun mutation
// is reported as `not-applicable` and never as caught (the same rule as a `-run` filter that matches no test).
const baselineCarries = {
    helper: [legs.goRestart, legs.pinnedRestart].every(leg => leg?.helperRequest?.injected === true),
    preset: Boolean(legs.goRestart?.preset?.name) && Boolean(legs.pinnedRestart?.preset?.name),
    // WHICH ARM OF THE CONDITIONAL GUARD THIS BASELINE IS: the resumed-history mutations are only meaningful on the
    // arm they exercise. Both subjects must be on the same arm or the baseline would not have been a match.
    'history-required': [legs.goRestart, legs.pinnedRestart].every(leg => leg?.promptOrder?.restartClassification?.historyExpected === true),
    'history-omitted': [legs.goRestart, legs.pinnedRestart].every(leg => leg?.promptOrder?.restartClassification?.historyExpected === false),
};
for (const mutation of MUTATIONS) {
    if (mutation.requires && baselineCarries[mutation.requires] !== true) {
        console.log(`skip  ${mutation.name} -> needs ${mutation.requires}, which this run's artefacts do not carry`);
        observed.push({ name: mutation.name, expected: mutation.expected, verdict: 'not-applicable', requires: mutation.requires, caught: false, failedGuards: [] });
        continue;
    }
    const draft = clone();
    try {
        mutation.apply(draft);
    } catch (error) {
        console.error(`MUTATION FIXTURE DEFECT in "${mutation.name}": ${error?.message ?? error}`);
        failures += 1;
        observed.push({ name: mutation.name, expected: mutation.expected, verdict: 'unappliable', failedGuards: [] });
        continue;
    }
    const result = compare(draft);
    // THE NAMED RED IS THE ASSERTION. "It went red" is not enough: a mutation caught by an unrelated guard proves the
    // comparator is fragile, not that this rule works.
    const caught = result.verdict === 'mismatch' && result.failedGuards.includes(mutation.expected);
    observed.push({
        name: mutation.name, expected: mutation.expected, verdict: result.verdict,
        caught, failedGuards: result.failedGuards,
    });
    if (caught) {
        console.log(`ok    ${mutation.name} -> ${mutation.expected} went red`);
    } else {
        failures += 1;
        console.error(`FAIL  ${mutation.name}: expected "${mutation.expected}" to go red; verdict=${result.verdict}, failed=[${result.failedGuards.join(', ')}]`);
    }
}

// AND THE BASELINE AGAIN, AT THE END: every mutation above ran on a CLONE, so if the clean legs no longer match, one of
// the mutations escaped its own draft and the whole proof is invalid.
const recheck = compare(clone());
if (recheck.verdict !== 'match') {
    console.error(`FAIL: the baseline no longer matches after the mutations ran (${recheck.failedGuards.join(', ')}); a mutation escaped its draft`);
    failures += 1;
}

const applicable = observed.filter(entry => entry.verdict !== 'not-applicable');
const notApplicable = observed.filter(entry => entry.verdict === 'not-applicable').map(entry => entry.name);
const report = {
    surface: 'whole-session',
    kind: 'gate-teeth',
    baselineVerdict: baseline.verdict,
    baselineGuards: baseline.guardCount,
    baselineCarries,
    applicableMutations: applicable.length,
    notApplicable,
    mutations: observed,
    allCaught: failures === 0 && applicable.length > 0,
};
const out = option('--out', null);
if (out) await fs.writeFile(out, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
console.error(failures === 0
    ? `whole-session gate teeth: ${applicable.length}/${applicable.length} applicable mutations produced their NAMED red, baseline green${notApplicable.length > 0 ? `, ${notApplicable.length} not applicable` : ''}`
    : `whole-session gate teeth: ${failures} failure(s)`);
process.exit(failures === 0 && applicable.length > 0 ? 0 : 1);
