// Q20 COMPARATOR — save / reload / swipe preserve equality (GOAL.md §9).
//
// Reads two leg reports produced by q20-persistence-probe.mjs, one per backend, and decides whether a chat the
// product SAVED is READ BACK by a fresh page, and whether the requests that follow -- a second turn and a swipe on
// the same chat -- are equal on GoTavern and pinned Node.
//
// The three model-context requests this leg produces, and what each one isolates:
//   contextRequests[0]  the reply to the FIRST turn (the send that created the chat identity). Content: the
//                       character's greeting plus the first user turn.
//   contextRequests[1]  the reply to the SECOND turn. Content: greeting + first turn + reply + second turn, and
//                       crucially the message pair the PREVIOUS PAGE wrote -- so this request is the one that
//                       proves a fresh page read the saved chat back with its identity intact.
//   contextRequests[2]  the SWIPE of the reply to the second turn. Same chat, same history, one message's swipes
//                       array one longer: it must differ from contextRequests[1] and equal pinned's.
// The first request is why contextRequests[0] is not used for equality: the read-back face is [1], and [1] cannot
// be produced without the reload.
//
// The guards, and the failure each one is designed to catch:
//   legsPresent            a leg report is missing (named, never an ENOENT stack -- run 40257173478's lesson)
//   legsDrove              every leg step passed and the peer was reached
//   saveWroteTheChat       the file on disk contains the marker the leg sent, on both subjects, AND the frontend
//                          issued POST /api/chats/save that answered 200. A backend that answered 200 and wrote
//                          nothing fails here; so does a driver whose promise resolved without a request.
//   reloadReadsTheChat     a FRESH page load has that marker in its in-memory chat, on both subjects, and the chat
//                          it read carries an identity. A save that is not readable back is the failure Q1 cannot
//                          see (the bytes can be intact on disk).
//   nodeEqualsGoAfterReload the second turn's provider request is byte-identical across subjects
//   goSwipeDiffersFromGoTurn  the swipe produced a DIFFERENT request from the second turn from the SAME backend,
//                          so the swipe actually changed the context rather than repeating it
//   nodeEqualsGoAfterSwipe the swipe's provider request is byte-identical across subjects
//
// Usage: node tests/browser/compare-q20-legs.mjs <gotavern.json> <pinned.json>
// Prints the artefact on stdout; exits non-zero unless every guard holds.

import fs from 'node:fs';
import path from 'node:path';

const [gotavernPath, pinnedPath] = process.argv.slice(2);
if (!gotavernPath || !pinnedPath) {
    console.error('usage: node compare-q20-legs.mjs <gotavern-leg.json> <pinned-leg.json>');
    process.exit(2);
}

const missing = [];
const load = file => {
    if (!fs.existsSync(file)) {
        missing.push(path.basename(file));
        return null;
    }
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
        missing.push(`${path.basename(file)} (unreadable: ${error.message})`);
        return null;
    }
};

const reports = { gotavern: load(gotavernPath), pinned: load(pinnedPath) };
const guards = {};
const details = {};

const contextRequests = report => (report?.peerRequests ?? []).filter(entry => /chat\/completions/.test(entry.path ?? ''));
const marker = report => report?.markers?.first ?? null;
const short = entry => (entry ? { sha256: entry.sha256.slice(0, 12), byteLength: entry.byteLength } : null);

function guard(name, run) {
    const problems = run();
    guards[name] = problems.length === 0;
    if (problems.length > 0) details[`${name}Problems`] = problems;
}

guard('legsPresent', () => (missing.length === 0 ? [] : [`leg report(s) missing or unreadable: ${missing.join(', ')}`]));

guard('legsDrove', () => {
    const problems = [];
    for (const [subject, report] of Object.entries(reports)) {
        if (!report) continue;
        for (const entry of report.steps ?? []) {
            if (entry.ok !== true) problems.push(`${subject}: step ${entry.name} failed (${entry.detail ?? 'no detail'})`);
        }
        if ((contextRequests(report).length) < 3) {
            problems.push(`${subject}: ${contextRequests(report).length} model-context request(s); this leg needs 3 (first turn, second turn, swipe)`);
        }
    }
    return problems;
});

guard('saveWroteTheChat', () => {
    const problems = [];
    for (const [subject, report] of Object.entries(reports)) {
        if (!report) continue;
        const want = marker(report);
        const files = report.afterFirstSave ?? [];
        const found = files.some(file => (file.messages ?? []).some(message => String(message?.mes ?? '').includes(want)));
        if (!found) problems.push(`${subject}: no chat file on disk carries ${want} (files: ${files.map(file => `${file.file}:${file.lines}`).join(', ') || 'none'})`);
        // THE REQUEST IS JUDGED TOO: "the file exists" alone cannot distinguish a product save from a file some
        // earlier step left behind, and the failing runs' whole symptom was a resolved promise with no request.
        const saves = (report.chatRequests ?? []).filter(entry => /\/api\/chats\/save$/.test(entry.path ?? ''));
        if (!saves.some(entry => entry.status === 200)) {
            problems.push(`${subject}: the frontend issued no successful POST /api/chats/save (recorded: ${JSON.stringify(report.chatRequests ?? [])})`);
        }
        details[`${subject}SaveFiles`] = files.map(file => ({ file: file.file, lines: file.lines, sha256: file.sha256.slice(0, 12) }));
        details[`${subject}ChatRequests`] = report.chatRequests ?? [];
    }
    return problems;
});

guard('reloadReadsTheChat', () => {
    const problems = [];
    for (const [subject, report] of Object.entries(reports)) {
        if (!report) continue;
        const reload = report.afterReload ?? {};
        if (reload.carriesMarker !== true) {
            problems.push(`${subject}: a fresh page load did not have ${marker(report)} in its chat (messages=${reload.messages}, chatLength=${reload.chatLength}, chatId=${reload.chatId})`);
        }
        if (typeof reload.chatId !== 'string' || reload.chatId.length === 0) {
            problems.push(`${subject}: the chat a fresh page load read has no identity (chatId=${JSON.stringify(reload.chatId)}), so nothing after it could be attached to the saved chat`);
        }
        details[`${subject}Reload`] = { messages: reload.messages, chatLength: reload.chatLength, chatId: reload.chatId };
    }
    return problems;
});

guard('nodeEqualsGoAfterReload', () => {
    const go = contextRequests(reports.gotavern)[1] ?? null;
    const node = contextRequests(reports.pinned)[1] ?? null;
    if (!go || !node) return ['one of the subjects produced no context request for the second turn'];
    details.secondTurn = { gotavern: short(go), pinned: short(node) };
    if (go.sha256 !== node.sha256) return [`the second turn's request differs: gotavern ${go.sha256.slice(0, 12)} (${go.byteLength} B) vs pinned ${node.sha256.slice(0, 12)} (${node.byteLength} B)`];
    return [];
});

guard('goSwipeDiffersFromGoTurn', () => {
    const first = contextRequests(reports.gotavern)[1] ?? null;
    const swipe = contextRequests(reports.gotavern)[2] ?? null;
    if (!first || !swipe) return [`the GoTavern leg produced ${contextRequests(reports.gotavern).length} context request(s), so turn and swipe cannot be compared`];
    details.swipe = { gotavern: short(swipe), pinned: short(contextRequests(reports.pinned)[2] ?? null) };
    if (first.sha256 === swipe.sha256) return ['the swipe produced the SAME request as the second turn, so it did not change the context'];
    return [];
});

guard('nodeEqualsGoAfterSwipe', () => {
    const go = contextRequests(reports.gotavern)[2] ?? null;
    const node = contextRequests(reports.pinned)[2] ?? null;
    if (!go || !node) return ['one of the subjects produced no context request for the swipe'];
    if (go.sha256 !== node.sha256) return [`the swipe's request differs: gotavern ${go.sha256.slice(0, 12)} (${go.byteLength} B) vs pinned ${node.sha256.slice(0, 12)} (${node.byteLength} B)`];
    return [];
});

const failedGuards = Object.entries(guards).filter(([, ok]) => !ok).map(([name]) => name);
// NAMED FINDINGS THIS LEG OBSERVES BUT DOES NOT CLAIM AS PARITY. Each is a fact recorded with its evidence, so it can
// be acted on later without being either asserted away or silently counted as agreement.
const equallyObserved = {
    // Measured identically on BOTH subjects in runs 40445671791 and 40448869208: the assistant messages the two turns
    // produce are stored with EMPTY text (`mesLen: 0`) while the peer recorded a completion for each turn. It is
    // EQUALLY OBSERVED, which is exactly why it must not be read as parity: an identical wrong outcome is still wrong.
    // A hypothesis (the peer answered in a shape `extractMessageFromData` cannot read) was TESTED AND REFUTED -- the
    // peer answers `choices[0].message.content`, which is precisely what the openai branch reads -- so the cause is
    // OPEN. `final-file-reflects-swipe` therefore no longer claims the persisted text is a reply.
    emptyReplyOnBothSubjects: {
        observedIn: ['40445671791', '40450959982', '40452820868'],
        gotavern: reports.gotavern?.emptyReplyOnBothSubjects ?? null,
        pinned: reports.pinned?.emptyReplyOnBothSubjects ?? null,
        // CLOSED BY MEASUREMENT AS UNOBSERVABLE-IN-THIS-HARNESS, not left `open`. The two candidate explanations are
        // "the peer sent empty content" and "the product discarded non-empty content", and the committed evidence
        // cannot separate them: the harness records peer REQUESTS only (`startCapturePeer` pushes method/path/
        // body-sha256/body; `url-recorder` records browser-facing URLs), and a sweep of every leg artefact from
        // 40445671791 / 40450959982 / 40452820868 finds NO field carrying a peer RESPONSE body or status. So a
        // hypothesis about the peer's answer cannot be tested from these artefacts at all -- which is a limit of the
        // instrument, recorded rather than dressed as an open question. Answering it needs the peer to record what it
        // ANSWERED (a `peerResponses` array), which is a harness change of its own.
        status: 'unobservable-in-this-harness',
        why: 'no artefact field carries the peer response; peer requests are recorded, peer answers are not',
        notParity: true,
    },
    // THE ARTEFACT/REPLAY DISAGREEMENT from run 40448869208 is resolved by FIXING WHAT A LEG MAY READ, not by choosing
    // a value: the swipe assertion now requires the file to have been read AFTER a successful /api/chats/save, and
    // refuses (`swipe-save-witnessed`) when that cannot be shown.
    swipeSaveWitness: {
        gotavern: reports.gotavern?.saveWitness ?? null,
        pinned: reports.pinned?.saveWitness ?? null,
    },
};
const artefact = {
    schemaVersion: 1,
    question: 'Does a chat the product SAVED read back on a fresh page load, and do a second turn and a swipe on it reach the model with the same context as pinned?',
    guards,
    details,
    equallyObserved,
    missingLegs: missing,
    failedGuards,
    verdict: failedGuards.length === 0 ? 'match' : 'mismatch',
    notCompared: [
        'a real provider (rule 22): the peer is a simulated backend that captures and answers',
        'the SWIPE BUTTON DOM click: the swipe is the frontend\'s own swipe(), called the way its click handler calls it. Regenerate and continue are NO LONGER in this list -- they have their own legs and comparators (compare-q20-regen-legs.mjs, compare-q20-continue-legs.mjs)',
        'group chats, branch/checkpoint, message editing and deletion',
        'streaming (Q19)',
        'THE CAUSE of the empty reply text: UNOBSERVABLE IN THIS HARNESS, which records peer REQUESTS and never peer ANSWERS, so "the peer sent empty content" and "the product discarded non-empty content" cannot be separated from any leg artefact. Answering it needs the peer to record its own response body -- a harness change, not a probe rerun',
        'the `savingAfterComplete` flag the leg still sets: it does not exist under pinned `public/**`, so it is inert, and removing it is a change nobody has measured',
    ],
};

process.stdout.write(`${JSON.stringify(artefact, null, 2)}\n`);
if (artefact.verdict !== 'match') {
    console.error(`Q20 comparison failed: ${failedGuards.join(', ')}`);
    process.exitCode = 1;
}
