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

// THE PEER SERVED THE WIRE THE PAGE ASKED FOR, on both subjects. Without this guard a peer that answers JSON to a
// `stream: true` request satisfies every structural guard while the page stores an EMPTY reply -- which is exactly
// what happened through runs 40387864205..40459475159 and made this leg's greens structure-only. A leg recorded
// before the `served` field existed reports `null` here and is REFUSED, so an old leg cannot be cited as evidence for
// a content claim.
guard('peerServedTheRequestedWire', () => {
    const problems = [];
    const seen = {};
    for (const [subject, report] of Object.entries(reports)) {
        if (!report) continue;
        const completions = contextRequests(report);
        seen[subject] = { wireMode: report.wireMode ?? null, served: completions.map(entry => entry.served ?? null) };
        if (completions.length === 0) {
            problems.push(`${subject}: no completion request to judge`);
            continue;
        }
        for (const [index, entry] of completions.entries()) {
            const served = entry.served ?? null;
            if (!served || !served.wire) {
                problems.push(`${subject}: completion #${index} records no \`served\` field, so nothing says what this peer answered (a leg recorded before that field existed cannot support a content claim)`);
                continue;
            }
            const askedStream = entry.requestedStream === true;
            if (askedStream && served.wire !== 'sse') {
                problems.push(`${subject}: completion #${index} ASKED for streaming (\`stream: true\`) but the peer served ${JSON.stringify(served.wire)} -- the page's reader gets no frames and stores an empty reply`);
            }
            if (askedStream && served.terminal !== true) {
                problems.push(`${subject}: the SSE reply to completion #${index} did not terminate (\`served.terminal\` false), so the reader cannot know the stream ended`);
            }
        }
    }
    details.served = seen;
    if (seen.gotavern?.wireMode !== seen.pinned?.wireMode) {
        problems.push(`the two subjects ran DIFFERENT peers (wireMode ${seen.gotavern?.wireMode} vs ${seen.pinned?.wireMode}); their requests are not comparable`);
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
    // THE CITATION THE SCORECARD ROW RESTS ON, WITH ITS LIMITATION NAMED IN PLACE. `docs/goal-scorecard.md` Q20 cites
    // run 40387864205 ("7/7 guards"). That run's guards were STRUCTURE-ONLY, and this is why: the page STREAMS
    // (`stream_openai` defaults true when the key is missing, public/scripts/openai.js:376; `isStreamingEnabled()`,
    // script.js:3517-3526) while the peer of that era answered `application/json` to a `stream: true` request, so the
    // frontend's `EventSourceStream` (public/scripts/sse-stream.js) received no `data:` frames, the stream ended with
    // zero tokens, and the page stored an assistant message whose text was `''`. The guards that passed judged counts,
    // swipe arrays and request equality -- real things, but not the text of a reply. It is the SAME discipline as the
    // withdrawn Q7 pass: a citation keeps its claim only if the reader is told what it could not see.
    priorCitationLimitation: {
        runId: '40387864205',
        workflow: 'Browser differential',
        mode: 'preset (as cited by the scorecard)',
        guardsAtTheTime: 7,
        limitation: 'structure-only: the page streamed against a JSON peer, so the reply text was empty on both subjects and no guard could have judged it',
        cause: 'peer answered application/json to a request carrying stream: true; EventSourceStream found no data: frames (public/scripts/sse-stream.js, reader at public/scripts/openai.js:3170-3175)',
        repairedBy: 'the SSE peer in this change (--wire honour), which answers data: {delta}\n\n frames and data: [DONE]',
        stillValidFor: 'save/reload/swipe structure: chat identity, message counts, swipe arrays, provider request equality',
        notValidFor: 'anything about the CONTENT of a generated reply',
    },
    // Measured identically on BOTH subjects in runs 40445671791 and 40448869208: the assistant messages the two turns
    // produce are stored with EMPTY text (`mesLen: 0`) while the peer recorded a completion for each turn. It is
    // EQUALLY OBSERVED, which is exactly why it must not be read as parity: an identical wrong outcome is still wrong.
    // A hypothesis (the peer answered in a shape `extractMessageFromData` cannot read) was TESTED AND REFUTED, and a
    // second one (the artefact cannot tell) was replaced by the real cause: THE PEER ANSWERED JSON TO A STREAMING
    // REQUEST. The SSE peer removes the condition; from this change a reply with empty text is a finding, not a
    // tolerated state, and `final-file-reflects-swipe` asserts the persisted text is the peer's reply again.
    emptyReplyOnBothSubjects: {
        observedIn: ['40445671791', '40450959982', '40452820868'],
        gotavern: reports.gotavern?.emptyReplyOnBothSubjects ?? null,
        pinned: reports.pinned?.emptyReplyOnBothSubjects ?? null,
        // RESOLVED, and by evidence rather than by preference. This was first recorded as
        // `unobservable-in-this-harness` because no artefact carried a peer RESPONSE; that was true of the artefact and
        // false as a conclusion. The cause is now measured: THE PAGE STREAMED AND THE PEER ANSWERED JSON.
        //   * `stream_openai` defaults TRUE when the key is missing (public/scripts/openai.js:376), and
        //     `isStreamingEnabled()` (script.js:3517-3526) then routes `Generate` down the streaming branch (:5385);
        //   * the peer answered `content-type: application/json`, and `EventSourceStream`
        //     (public/scripts/sse-stream.js) looks for `data:` frames separated by blank lines -- it found none, so the
        //     reader yielded zero tokens (openai.js:3170-3175) and `StreamingProcessor.generate()` ended with
        //     `Stream stats: 0 tokens, NaN seconds, rate: NaN TPS` (:3893), recorded in that leg's consoleDiagnostics;
        //   * the page therefore stored an assistant message with `mes: ''`, which pinned then normalised, backfilling
        //     an empty swipe (`:6875`, `:6880` -- both warnings are in the leg's own artefact).
        // The peer now honours `stream: true` (`served.wire: 'sse'`), so this condition cannot recur silently: a JSON
        // answer to a streaming request fails `peerServedTheRequestedWire`, and an empty reply fails the setup wait.
        status: 'resolved-by-measurement',
        why: 'the page streamed (`stream_openai` defaults true, openai.js:376) and the peer answered application/json; EventSourceStream found no data: frames, so the stored reply was empty',
        evidence: ['consoleDiagnostics: "Stream stats: 0 tokens, NaN seconds, rate: NaN TPS" at script.js:3898', 'consoleDiagnostics: "The message had a swipe that is not a string" at script.js:6875', 'consoleDiagnostics: "The message had missing or invalid swipe_info for a swipe" at script.js:6880'],
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
        'REGRESSION RISK from the wire: a leg that pins `--wire json` while the page streams will again store an empty reply. That combination is now FAILED by `peerServedTheRequestedWire` rather than tolerated, but no leg currently exercises the `json` mode deliberately',
        'the `savingAfterComplete` flag the leg still sets: it does not exist under pinned `public/**`, so it is inert, and removing it is a change nobody has measured',
    ],
};

process.stdout.write(`${JSON.stringify(artefact, null, 2)}\n`);
if (artefact.verdict !== 'match') {
    console.error(`Q20 comparison failed: ${failedGuards.join(', ')}`);
    process.exitCode = 1;
}
