// Q20 / REGENERATE COMPARATOR -- regenerate preserves equality (GOAL.md §9).
//
// Reads two leg reports produced by `q20-regenerate-probe.mjs`, one per backend, and decides whether pressing the real
// Regenerate control on the same saved chat produces the same model context on both subjects, leaves the same file on
// disk, and leaves no residual state for the next request.
//
// ---------------------------------------------------------------------------------------------------------------
// THE CONTRACT THIS FILE ENFORCES, taken from pinned source rather than from a preference. It is DELIBERATELY
// DIFFERENT from the continue contract in `compare-q20-continue-legs.mjs`, because pinned's two verbs are different:
//
//   public/script.js:4399-4406   `} else if (type !== 'quiet' && type !== 'swipe' && !isImpersonate && !dryRun &&
//                                !depth && chat.length) { ... chat.length = chat.length - 1;
//                                await removeLastMessage(); ... }`
//                                -> REGENERATE DELETES the last assistant message BEFORE the prompt is assembled.
//                                   So the regenerated request's history must END AT THE USER TURN, and it must NOT
//                                   contain the reply that was replaced. That is the assertion `requestDropsReplacedReply`.
//   public/script.js:6651        `if (type != 'append' && type != 'continue' && type != 'appendFinal' && chat.length &&
//                                (lastMessage.swipe_id === undefined || lastMessage.is_user)) { type = 'normal'; }`
//                                -> the coercion does NOT fire for regenerate (the message that will be replaced has a
//                                   `swipe_id`), the append/appendFinal branches at :6701/:6719 do not match either, and
//                                   the fallthrough at :6738 `const newMessage = {}; chat.push(newMessage);` PUSHES A NEW
//                                   MESSAGE. Regenerate does NOT grow a `swipes` array -- `sameMessageGrown` in the
//                                   continue comparator would be the WRONG shape here, and the reverse is equally true.
//   src/endpoints/backends/chat-completions.js:2652-2670
//                                the generic OpenAI/Custom provider body has NO `type` member, so the provider-visible
//                                difference between regenerate and a normal turn is ONLY the prompt.
//
// So: message count UNCHANGED, the last message REPLACED by a new one at the same index, `swipes` UNTOUCHED, and the
// request history one message shorter than the swipe-shaped second turn would have been.
//
// THE GUARDS, and the failure each one is designed to catch:
//   legsPresent              a leg report is missing (named, never an ENOENT stack)
//   legsDrove                every step of both legs passed -- in particular the drive REACHED the control
//                            (`regenerate-control-reached`), which is what separates "the product did not regenerate"
//                            from "the driver never pressed the thing" (AGENTS rule 10)
//   sameChat                 both subjects acted on a chat with the SAME chat identity and the SAME message count
//                            before the press. Without this the request comparison compares two conversations.
//   controlCounted           exactly ONE provider request was issued per press, on both subjects. A count of 0 is a
//                            failed drive; a count of 2 is a product/driver disagreement worth failing on.
//   requestDropsReplacedReply the regenerated request's message list ENDS AT THE USER TURN and does not contain the
//                            reply text that was on screen before the press -- the deletion at :4399-4406, observed at
//                            the provider rather than inferred from the file.
//   nodeEqualsGoRegenerate   the regenerated request is byte-identical across subjects (sha256 + length)
//   goRegenerateDiffersFromGoTurn  the regenerated request DIFFERS from the request that produced the reply being
//                            replaced, from the SAME backend -- otherwise "equal across subjects" is satisfied by two
//                            requests that did not change at all
//   diskHeldALeast        after the save, both subjects' files hold the same number of lines as before the press
//                            (:6738 pushes, the deletion removed one -> net zero)
//   diskHeldTheNewReply   the LAST message in the file is the new reply on both, and it is not the old text
//   diskSwipesUntouched   the swipes array of the replaced message index is unchanged on both (:6738 does not touch it)
//   nextRequestClean      the request issued AFTER a swipe following the regenerate is byte-identical across subjects
//                            and carries no residue of the replaced reply
//   artefactsDifferPerSubject  the two subjects' requests differ BEFORE the verb (the per-subject marker), which is
//                            what makes "they are equal after it" a measurement rather than a tautology (rule 50)
//
// Usage: node tests/browser/compare-q20-regen-legs.mjs <gotavern.json> <pinned.json>
// Prints the artefact on stdout; exits non-zero unless every guard holds.

import fs from 'node:fs';
import path from 'node:path';

const [gotavernPath, pinnedPath] = process.argv.slice(2);
if (!gotavernPath || !pinnedPath) {
    // REFUSING IS PART OF THE GATE. A comparator that runs with no arguments and prints "match" would make the
    // workflow's `|| status=$?` see success on a missing leg pair -- the shape this project has shipped twice.
    console.error('usage: node compare-q20-regen-legs.mjs <gotavern-leg.json> <pinned-leg.json>');
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

const completions = report => (report?.peerRequests ?? []).filter(entry => /chat\/completions/.test(entry.path ?? ''));
const short = entry => (entry ? { sha256: entry.sha256.slice(0, 12), byteLength: entry.byteLength } : null);

/**
 * The `messages` array a request body carried, parsed from the recorded body.
 *
 * FORBIDDEN BY THE DIFFERENTIAL DOCTRINE: this parse is used ONLY to READ ONE MEASUREMENT OUT OF each side (which
 * role the last message has, and whether a given string is present). The equality judgement is `bodySha256`, still
 * byte-oriented. A parse-then-compare would make two different requests compare equal.
 */
const messagesOf = entry => {
    try {
        const body = JSON.parse(entry?.body ?? '{}');
        return Array.isArray(body.messages) ? body.messages : null;
    } catch {
        return null;
    }
};

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
            if (entry.ok !== true) problems.push(`${subject}: step ${entry.name} failed (${String(entry.detail ?? 'no detail').slice(0, 400)})`);
        }
        // THE DRIVE'S OWN FAITHFULNESS, named separately: a leg that never reached the control has no finding to make.
        if (report.regenerate?.sawRegenerateCall !== true) {
            problems.push(`${subject}: the press never reached Generate('regenerate') (calls: ${JSON.stringify(report.regenerate?.generateCalls ?? null)}); a false here is a DRIVE defect, not a product finding`);
        }
        if (report.characterOpen?.opened !== true) {
            problems.push(`${subject}: did not open the named card (wanted ${JSON.stringify(report.characterOpen?.wanted ?? null)})`);
        }
    }
    return problems;
});

guard('sameChat', () => {
    const problems = [];
    const identities = {};
    for (const [subject, report] of Object.entries(reports)) {
        if (!report) continue;
        const pre = report.preRegenerate?.page ?? null;
        const file = report.preRegenerate?.file ?? null;
        identities[subject] = { chatId: pre?.chatId ?? null, chatLength: pre?.chatLength ?? null, file: file?.file ?? null, lines: file?.lines ?? null, lastIsUser: pre?.lastIsUser ?? null };
        if (!pre) problems.push(`${subject}: no pre-regenerate page state recorded`);
        if (!file) problems.push(`${subject}: the file that will be regenerated is not identifiable (no chat file carried the leg's own marker)`);
    }
    details.beforeVerb = identities;
    const go = identities.gotavern ?? {};
    const node = identities.pinned ?? {};
    // THE CHAT IDENTITY IS THE ASSERTION, not "the card that rendered" (this lane's brief). The id is the product's
    // own name for the chat; the FILE PATH must match too, because that is what the comparison is attached to.
    if (go.chatId !== node.chatId) problems.push(`the two subjects acted on different chats: ${JSON.stringify(go.chatId)} vs ${JSON.stringify(node.chatId)}`);
    if (go.file !== node.file) problems.push(`the two subjects' chats live at different paths: ${JSON.stringify(go.file)} vs ${JSON.stringify(node.file)}`);
    if (go.chatLength !== node.chatLength) problems.push(`the two subjects started from different message counts: ${go.chatLength} vs ${node.chatLength}`);
    if (go.lastIsUser !== false || node.lastIsUser !== false) problems.push(`the message to regenerate is not an assistant reply on both (gotavern lastIsUser=${go.lastIsUser}, pinned lastIsUser=${node.lastIsUser})`);
    return problems;
});

guard('artefactsDifferPerSubject', () => {
    const problems = [];
    // THE PER-SUBJECT MARKER IS THE DISCRIMINATOR (rule 50): the two legs' second turns carry different text, so the
    // request BUILT FROM THEM must differ before the verb. If it does not, the fixture cannot tell the two subjects
    // apart and every later equality is vacuous.
    const goMarker = reports.gotavern?.markers?.second ?? null;
    const nodeMarker = reports.pinned?.markers?.second ?? null;
    details.perSubjectMarkers = { gotavern: goMarker, pinned: nodeMarker };
    if (!goMarker || !nodeMarker || goMarker === nodeMarker) {
        problems.push(`the legs did not carry distinct per-subject markers (${JSON.stringify(goMarker)} vs ${JSON.stringify(nodeMarker)}), so no later equality can discriminate`);
    }
    return problems;
});

guard('controlCounted', () => {
    const problems = [];
    for (const [subject, report] of Object.entries(reports)) {
        if (!report) continue;
        const count = Number(report.regenerateRequests ?? -1);
        details[`${subject}RegenerateRequests`] = count;
        if (count !== 1) problems.push(`${subject}: ${count} provider request(s) for one Regenerate press; exactly 1 is the contract`);
    }
    return problems;
});

guard('requestDropsReplacedReply', () => {
    const problems = [];
    for (const [subject, report] of Object.entries(reports)) {
        if (!report) continue;
        const requests = completions(report);
        const regenerated = requests[requests.length - 2] ?? null;
        const messages = messagesOf(regenerated);
        if (!messages) {
            problems.push(`${subject}: the regenerated request body has no messages array (recorded ${regenerated ? `${regenerated.byteLength} B` : 'no request'})`);
            continue;
        }
        const last = messages[messages.length - 1] ?? null;
        details[`${subject}RegeneratedTail`] = { role: last?.role ?? null, messageCount: messages.length, contentTail: String(last?.content ?? '').slice(-80) };
        // public/script.js:4400 -- the reply being replaced is removed BEFORE the prompt is assembled, so the history
        // ends at the USER turn. If the last message is an assistant turn, the deletion did not happen on this
        // subject, and every later equality would be comparing a request that still carries the reply it is replacing.
        if (last?.role !== 'user') problems.push(`${subject}: the regenerated request's last message has role ${JSON.stringify(last?.role ?? null)}, expected 'user' -- the replaced reply was not removed before the prompt was assembled`);
        // AND IT MUST NOT CONTAIN THAT REPLY. Read from the leg's own pre-press page state: the text on screen.
        const replacedText = String(report.preRegenerate?.page?.lastText ?? '');
        if (replacedText.length > 0 && JSON.stringify(messages).includes(replacedText)) {
            problems.push(`${subject}: the regenerated request still CONTAINS the reply it is replacing (${JSON.stringify(replacedText.slice(0, 60))})`);
        }
    }
    return problems;
});

guard('goRegenerateDiffersFromGoTurn', () => {
    const go = completions(reports.gotavern);
    const regenerated = go[go.length - 2] ?? null;
    const turn = go[go.length - 3] ?? null;
    details.gotavernRegenerateVsTurn = { regenerated: short(regenerated), turn: short(turn) };
    if (!regenerated || !turn) return [`the GoTavern leg produced ${go.length} completion(s); the regenerated and the preceding turn request are needed`];
    if (regenerated.sha256 === turn.sha256) return ['the regenerated request is IDENTICAL to the turn that produced the reply it replaced, so the verb changed nothing'];
    return [];
});

guard('nodeEqualsGoRegenerate', () => {
    const go = completions(reports.gotavern);
    const node = completions(reports.pinned);
    const goRegen = go[go.length - 2] ?? null;
    const nodeRegen = node[node.length - 2] ?? null;
    details.regenerate = { gotavern: short(goRegen), pinned: short(nodeRegen) };
    if (!goRegen || !nodeRegen) return ['one of the subjects produced no regenerated request'];
    if (goRegen.sha256 !== nodeRegen.sha256) return [`the regenerated request differs: gotavern ${goRegen.sha256.slice(0, 12)} (${goRegen.byteLength} B) vs pinned ${nodeRegen.sha256.slice(0, 12)} (${nodeRegen.byteLength} B)`];
    return [];
});

guard('diskHeldALeast', () => {
    const problems = [];
    for (const [subject, report] of Object.entries(reports)) {
        if (!report) continue;
        const before = report.preRegenerate?.file?.lines ?? null;
        const after = report.fileAfterRegenerate?.lines ?? null;
        details[`${subject}Lines`] = { before, after };
        // :4400 removes one message from `chat`, :6738 pushes one back -> the file must hold the same count.
        if (before === null || after === null || before !== after) problems.push(`${subject}: the file held ${before} line(s) before the Regenerate and ${after} after; pinned's deletion (:4400) plus push (:6738) is a net no-op`);
    }
    return problems;
});

guard('diskHeldTheNewReply', () => {
    const problems = [];
    const files = {};
    for (const [subject, report] of Object.entries(reports)) {
        if (!report) continue;
        const before = report.preRegenerate?.file ?? null;
        const after = report.fileAfterRegenerate ?? null;
        if (!before || !after) {
            problems.push(`${subject}: cannot compare the file before and after the Regenerate`);
            continue;
        }
        const beforeLast = before.messages?.[before.messages.length - 1] ?? null;
        const afterLast = after.messages?.[after.messages.length - 1] ?? null;
        files[subject] = { file: after.file, beforeLast: String(beforeLast?.mes ?? '').slice(0, 60), afterLast: String(afterLast?.mes ?? '').slice(0, 60), afterIndex: afterLast?.index ?? null };
        if (afterLast?.is_user !== false) problems.push(`${subject}: the file's last message after the Regenerate is not an assistant message`);
        if (String(afterLast?.mes ?? '') === String(beforeLast?.mes ?? '')) problems.push(`${subject}: the file's last message is UNCHANGED by the Regenerate (${JSON.stringify(String(afterLast?.mes ?? '').slice(0, 60))})`);
        // THE REPLACED REPLY IS GONE FROM THE FILE, at that index. The deletion is what makes the file's shape
        // different from the swipe's (which grows `swipes` instead).
        const stillThere = (after.messages ?? []).some(message => String(message?.mes ?? '') === String(beforeLast?.mes ?? '') && String(beforeLast?.mes ?? '').length > 0);
        if (stillThere) problems.push(`${subject}: the file still holds the replaced reply ${JSON.stringify(String(beforeLast?.mes ?? '').slice(0, 60))} somewhere`);
    }
    details.files = files;
    if (files.gotavern?.file !== files.pinned?.file) problems.push(`the two subjects wrote different chat files: ${JSON.stringify(files.gotavern?.file)} vs ${JSON.stringify(files.pinned?.file)}`);
    return problems;
});

guard('diskSwipesUntouched', () => {
    const problems = [];
    for (const [subject, report] of Object.entries(reports)) {
        if (!report) continue;
        const before = report.preRegenerate?.file ?? null;
        const after = report.fileAfterRegenerate ?? null;
        if (!before || !after) continue;
        const beforeLast = before.messages?.[before.messages.length - 1] ?? null;
        const afterLast = after.messages?.[after.messages.length - 1] ?? null;
        details[`${subject}Swipes`] = { before: beforeLast?.swipesCount ?? null, after: afterLast?.swipesCount ?? null };
        // :6738 push a new message -- it does not touch any `swipes` array, and neither does :4400.
        if (Number(afterLast?.swipesCount ?? 0) > Number(beforeLast?.swipesCount ?? 0)) {
            problems.push(`${subject}: the Regenerate GREW the swipes array (${beforeLast?.swipesCount} -> ${afterLast?.swipesCount}); pinned's raiseReply path pushes a NEW message (:6738) and leaves swipes alone`);
        }
    }
    return problems;
});

guard('nextRequestClean', () => {
    const problems = [];
    const go = completions(reports.gotavern);
    const node = completions(reports.pinned);
    const goNext = go[go.length - 1] ?? null;
    const nodeNext = node[node.length - 1] ?? null;
    details.nextRequest = { gotavern: short(goNext), pinned: short(nodeNext) };
    if (!goNext || !nodeNext) return ['one of the subjects produced no request after the Regenerate'];
    if (goNext.sha256 !== nodeNext.sha256) problems.push(`the request AFTER the Regenerate differs: gotavern ${goNext.sha256.slice(0, 12)} vs pinned ${nodeNext.sha256.slice(0, 12)}`);
    // RESIDUE, stated as a positive check: the replaced reply must not reappear in the next request either. A
    // continuation buffer or a stale `cyclePrompt` would put text the user can no longer see into the context.
    for (const report of [reports.gotavern]) {
        const replaced = String(report?.preRegenerate?.page?.lastText ?? '');
        if (replaced.length > 0 && JSON.stringify(messagesOf(goNext) ?? []).includes(replaced)) {
            problems.push(`the GoTavern leg's request AFTER the Regenerate still carries the replaced reply ${JSON.stringify(replaced.slice(0, 60))}`);
        }
    }
    return problems;
});

const failedGuards = Object.entries(guards).filter(([, ok]) => !ok).map(([name]) => name);
const artefact = {
    schemaVersion: 1,
    verb: 'regenerate',
    question: 'When a user regenerates the last reply of a saved, reloaded chat, does the model receive the same context as pinned, does the disk end up the same, and does the next request carry no residual state?',
    contract: {
        source: 'pinned SillyTavern 1.19.0 (06bde939)',
        deletion: 'public/script.js:4399-4406 -- the last assistant message is removed from `chat` BEFORE the prompt is assembled',
        placement: 'public/script.js:6651 + :6738 -- the coercion does not fire and the fallthrough PUSHES A NEW MESSAGE; `swipes` is untouched',
        provider: 'src/endpoints/backends/chat-completions.js:2652-2670 -- the generic OpenAI/Custom body has no `type` member, so the provider-visible difference is the prompt alone',
        therefore: 'message count unchanged, last message replaced at the same index, swipes unchanged, request history ends at the user turn',
    },
    guards,
    details,
    missingLegs: missing,
    failedGuards,
    verdict: failedGuards.length === 0 ? 'match' : 'mismatch',
    // THE LIST THIS ARTEFACT MAY NOT SHORTEN BY IMPLEMENTING SOMETHING. Each entry is a behaviour nobody has measured
    // yet; removing one requires a leg that drives it, not a comment that claims it.
    notCompared: [
        'a real provider (rule 22): the peer is a simulated backend that captures and answers',
        'streaming (Q19): this leg drives the non-streaming branch only',
        'the drag/animations of the options flyout: the control is clicked, its opening is not measured',
        'multi-swipe providers (n > 1): off for this source, so the `n` member is not exercised',
        'group chats',
        'regenerate on a USER message, which pinned converts into "generate a new message" (:11630-11632) -- a different verb',
        'the mid-generation refusal (is_send_press): asserted as a PRECONDITION the drive must satisfy, not driven as a case',
        'error/cancel mid-regenerate: no leg drives a failing provider here, so "did the product save half a message" is unanswered',
        'passing the tree to pinned Node afterwards (Q21 owns the hand-back)',
    ],
};

process.stdout.write(`${JSON.stringify(artefact, null, 2)}\n`);
if (artefact.verdict !== 'match') {
    console.error(`Q20 regenerate comparison failed: ${failedGuards.join(', ')}`);
    process.exitCode = 1;
}
