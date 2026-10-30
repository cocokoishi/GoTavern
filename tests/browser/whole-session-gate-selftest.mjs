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
//
// EXIT CODES: 0 = the baseline is a match AND every mutation produced its named red; 1 = at least one mutation survived
// or fired the wrong guard; 2 = REFUSAL (an input cannot be read, or the baseline is not a match, in which case there
// is nothing to mutate and this program says so instead of reporting a vacuous success).

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
];

let failures = 0;
const observed = [];
for (const mutation of MUTATIONS) {
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

const report = {
    surface: 'whole-session',
    kind: 'gate-teeth',
    baselineVerdict: baseline.verdict,
    baselineGuards: baseline.guardCount,
    mutations: observed,
    allCaught: failures === 0,
};
const out = option('--out', null);
if (out) await fs.writeFile(out, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
console.error(failures === 0
    ? `whole-session gate teeth: ${observed.length}/${observed.length} mutations produced their NAMED red, baseline green`
    : `whole-session gate teeth: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
