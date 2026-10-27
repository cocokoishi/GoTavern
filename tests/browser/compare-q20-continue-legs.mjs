// Q20 / CONTINUE COMPARATOR -- continue preserves equality (GOAL.md §9).
//
// Reads two leg reports produced by `q20-continue-probe.mjs`, one per backend, and decides whether pressing the real
// Continue control on the same saved chat puts the new text in the same place, sends the same continuation
// instruction to the model, leaves the same file on disk, and leaves no residual buffer for the next request.
//
// ---------------------------------------------------------------------------------------------------------------
// THE CONTINUE CONTRACT, from pinned source. It is NOT the regenerate contract and this file does not pretend it is:
//
//   public/script.js:11648-11661  the control (`#option_continue`, public/index.html:8189) refuses while a swipe-edit
//                                is in progress or the last message is being edited, then calls
//                                `Generate('continue', ...)`. Nothing is deleted: the `:4400` deletion branch is not
//                                the path this verb takes.
//   public/script.js:4450-4456    `noAttachTypes` includes 'continue' and the user-message insertion is guarded by
//                                `!noAttachTypes.includes(type)`, so NO new user message is created.
//   public/script.js:5534         `saveReply({ type: 'appendFinal', ... })`, whose branch at :6719-6737 does
//                                  `lastMessage.mes = getMessage;` and `lastMessage.extra.reasoning += reasoning;`
//                                -> THE SAME MESSAGE, its text REPLACED by (continuation + reply), its reasoning
//                                   APPENDED, and the chat length UNCHANGED. This is the pinned answer to "where does
//                                   the new text go" and every guard below is built on it.
//   public/script.js:4866         `cyclePrompt = chat2.shift()` when continuing, so the message to be continued is
//                                moved to the end of the history.
//   public/script.js:4975-4981    `if (main_api === 'openai' && !cyclePrompt.endsWith(' ')) cyclePrompt +=
//                                oai_settings.continue_postfix` (default ' ', openai.js:505) -- a byte at the tail.
//   public/scripts/openai.js:907-926, :111, :1087-1090
//                                the DEFAULT branch (`continue_prefill === false`, openai.js:501): the last
//                                non-injected message is SPLICED OUT of `messages` and re-appended at the END as part
//                                of a `continueNudge` collection, whose text is
//                                `oai_settings.continue_nudge_prompt` = '[Continue your last message without repeating
//                                its original content.]'. So the model is TOLD to continue, with the message to
//                                continue immediately before the instruction.
//   public/scripts/openai.js:1320-1331
//                                the OTHER branch (`continue_prefill === true`): the message is turned into a
//                                `continuePrefill` control prompt instead and NO nudge is built.
//   src/endpoints/backends/chat-completions.js:2652-2670
//                                no `type` member reaches the provider, so the instruction is visible ONLY as prompt
//                                shape.
//
// THE GUARDS, and the failure each one is designed to catch:
//   legsPresent                  a leg report is missing (named, never an ENOENT stack)
//   legsDrove                    every step passed, the drive REACHED the control, the page reported WHICH mechanism
//                                branch it used, and the named card was the one opened
//   sameChat                     both subjects continued the same chat identity, the same message index, from the
//                                same message count and the same last-message text length
//   mechanismNamed               both subjects ran the SAME branch of the two (`continue_prefill` false -> the nudge,
//                                true -> the prefill). A comparison whose two sides used different mechanisms is not a
//                                comparison, and an artefact that does not say which one ran cannot be read.
//   continuationMovedTheHistory  the continued request DIFFERS from the request that produced the message being
//                                continued, on the SAME backend -- the continuation actually reached the provider
//   nudgeAssemblesLast          the continued request's LAST TWO messages are, in order, the message being continued
//                                (moved to the end by :4866) and the nudge instruction (:1087-1090). This is the
//                                assertion that makes "continuation instructing the model" a measurement rather than
//                                an inference from a hash.
//   nodeEqualsGoContinue        the continued request is byte-identical across subjects
//   sameMessageGrown            the message count is UNCHANGED on both and the last message GREW from the text that
//                                was there -- pinned's appendFinal answer (:6719-6737), asserted on both subjects
//   diskHeldALeast              the FILE holds the same number of lines before and after, on both
//   diskHeldTheContinuation     the file's LAST message is the grown text and contains the peer's continuation marker
//   diskMetadataAppended        `extra.reasoning` is unchanged-or-appended, never reset (the `+=` in :6734)
//   nextRequestClean            a normal turn AFTER the continue is byte-identical across subjects AND carries no
//                                continue nudge -- the residual-buffer question, answered positively
//
// WHAT A HASH-ONLY COMPARATOR WOULD MISS, stated because this file's whole reason for the nudge guard is that it
// would: two subjects could both send a request with NO continuation instruction at all and still hash equal. The
// nudge assertion is what turns "equal" into "equally continuing".
//
// Usage: node tests/browser/compare-q20-continue-legs.mjs <gotavern.json> <pinned.json>
// Prints the artefact on stdout; exits non-zero unless every guard holds.

import fs from 'node:fs';
import path from 'node:path';

const [gotavernPath, pinnedPath] = process.argv.slice(2);
if (!gotavernPath || !pinnedPath) {
    console.error('usage: node compare-q20-continue-legs.mjs <gotavern-leg.json> <pinned-leg.json>');
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

/** READ ONE MEASUREMENT OUT OF a recorded body. Equality is still judged by `bodySha256` (doctrine rule 2). */
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
        if (report.continue?.sawContinueCall !== true) {
            problems.push(`${subject}: the press never reached Generate('continue') (calls: ${JSON.stringify(report.continue?.generateCalls ?? null)}); a false here is a DRIVE defect, not a product finding`);
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
        const pre = report.preContinue?.page ?? null;
        const file = report.preContinue?.file ?? null;
        identities[subject] = {
            chatId: pre?.chatId ?? null,
            chatLength: pre?.chatLength ?? null,
            messageIndex: file ? (file.messages?.length ?? 0) - 1 : null,
            file: file?.file ?? null,
            lines: file?.lines ?? null,
            lastTextLength: String(pre?.lastText ?? '').length,
        };
        if (!pre) problems.push(`${subject}: no pre-continue page state recorded`);
        if (!file) problems.push(`${subject}: the file that will be continued is not identifiable (no chat file carried the leg's own marker)`);
    }
    details.beforeVerb = identities;
    const go = identities.gotavern ?? {};
    const node = identities.pinned ?? {};
    if (go.chatId !== node.chatId) problems.push(`the two subjects continued different chats: ${JSON.stringify(go.chatId)} vs ${JSON.stringify(node.chatId)}`);
    if (go.file !== node.file) problems.push(`the two subjects' chats live at different paths: ${JSON.stringify(go.file)} vs ${JSON.stringify(node.file)}`);
    if (go.messageIndex !== node.messageIndex) problems.push(`the two subjects continued different message indices: ${go.messageIndex} vs ${node.messageIndex}`);
    if (go.lastTextLength !== node.lastTextLength) problems.push(`the message being continued has different lengths across subjects: ${go.lastTextLength} vs ${node.lastTextLength}`);
    return problems;
});

guard('mechanismNamed', () => {
    const problems = [];
    const seen = {};
    for (const [subject, report] of Object.entries(reports)) {
        if (!report) continue;
        const configured = report.configured ?? {};
        seen[subject] = {
            continuePrefill: configured.continuePrefill ?? null,
            continueNudgePrompt: configured.continueNudgePrompt ?? null,
            continuePostfix: configured.continuePostfix ?? null,
        };
        if (typeof configured.continuePrefill !== 'boolean') {
            problems.push(`${subject}: the leg did not report which continuation mechanism it ran (continue_prefill=${JSON.stringify(configured.continuePrefill ?? null)})`);
        }
        // The NUDGE branch is the one this leg's nudge guard is built for; if a subject ran the prefill branch the
        // artefact must say so and this guard must be read as "not exercised", never as "passed".
        if (configured.continuePrefill === false && String(configured.continueNudgePrompt ?? '').trim().length === 0) {
            problems.push(`${subject}: continue_prefill is false but the nudge prompt is empty, so the default branch cannot be identified`);
        }
    }
    details.mechanism = seen;
    if (seen.gotavern?.continuePrefill !== seen.pinned?.continuePrefill) {
        problems.push(`the two subjects ran DIFFERENT continuation mechanisms (continue_prefill ${seen.gotavern?.continuePrefill} vs ${seen.pinned?.continuePrefill}); their requests are not comparable`);
    }
    if (seen.gotavern?.continuePrefill !== false) {
        problems.push(`this leg was built for the default NUDGE branch (continue_prefill false, openai.js:501); it ran with continue_prefill=${seen.gotavern?.continuePrefill}, so the nudge guard below is not exercised`);
    }
    return problems;
});

guard('continuationMovedTheHistory', () => {
    const go = completions(reports.gotavern);
    const continued = go[go.length - 3] ?? null;
    const produced = go[go.length - 4] ?? null;
    details.gotavernContinuedVsProduced = { continued: short(continued), produced: short(produced) };
    if (!continued || !produced) return [`the GoTavern leg produced ${go.length} completion(s); the continued request and the one that produced the message are needed`];
    if (continued.sha256 === produced.sha256) return ['the continued request is IDENTICAL to the request that produced the message being continued, so the verb changed nothing'];
    return [];
});

guard('nudgeAssemblesLast', () => {
    const problems = [];
    for (const [subject, report] of Object.entries(reports)) {
        if (!report) continue;
        const requests = completions(report);
        const continued = requests[requests.length - 3] ?? null;
        const messages = messagesOf(continued);
        if (!messages) {
            problems.push(`${subject}: the continued request has no messages array`);
            continue;
        }
        const nudge = String(report.configured?.continueNudgePrompt ?? '').trim();
        const last = messages[messages.length - 1] ?? null;
        const secondLast = messages[messages.length - 2] ?? null;
        const lastContent = String(last?.content ?? '');
        const secondContent = String(secondLast?.content ?? '');
        details[`${subject}ContinuedTail`] = {
            messageCount: messages.length,
            last: { role: last?.role ?? null, content: lastContent.slice(0, 160) },
            secondLast: { role: secondLast?.role ?? null, contentTail: secondContent.slice(-160) },
            nudge,
        };
        // openai.js:907-926 + :1087-1090: the nudge is a `system_prompt: true` message whose content is the
        // substituted `continue_nudge_prompt`, and it is inserted LAST.
        if (!lastContent.includes(nudge)) {
            problems.push(`${subject}: the continued request's LAST message is not the continue nudge (expected to contain ${JSON.stringify(nudge)}; got role ${JSON.stringify(last?.role ?? null)} ${JSON.stringify(lastContent.slice(0, 120))})`);
        }
        // THE MESSAGE BEING CONTINUED IS IMMEDIATELY BEFORE IT (`chatCompletion.add(collection, -1)` after the splice
        // put it first in the collection). Its content must be the text the page had.
        const continuedText = String(report.preContinue?.page?.lastText ?? '');
        if (continuedText.length > 0 && !secondContent.includes(continuedText)) {
            problems.push(`${subject}: the message before the nudge is not the message being continued (expected ${JSON.stringify(continuedText.slice(0, 80))} inside ${JSON.stringify(secondContent.slice(-120))})`);
        }
    }
    return problems;
});

guard('nodeEqualsGoContinue', () => {
    const go = completions(reports.gotavern);
    const node = completions(reports.pinned);
    const goContinued = go[go.length - 3] ?? null;
    const nodeContinued = node[node.length - 3] ?? null;
    details.continue = { gotavern: short(goContinued), pinned: short(nodeContinued) };
    if (!goContinued || !nodeContinued) return ['one of the subjects produced no continued request'];
    if (goContinued.sha256 !== nodeContinued.sha256) return [`the continued request differs: gotavern ${goContinued.sha256.slice(0, 12)} (${goContinued.byteLength} B) vs pinned ${nodeContinued.sha256.slice(0, 12)} (${nodeContinued.byteLength} B)`];
    return [];
});

guard('sameMessageGrown', () => {
    const problems = [];
    const grown = {};
    for (const [subject, report] of Object.entries(reports)) {
        if (!report) continue;
        const pre = report.preContinue?.page ?? null;
        const after = report.pageAfter ?? null;
        if (!pre || !after) {
            problems.push(`${subject}: no before/after page state recorded`);
            continue;
        }
        grown[subject] = { chatLengthBefore: pre.chatLength, chatLengthAfter: after.chatLength, lastMessageIndex: (after.chatLength ?? 0) - 1, beforeLength: String(pre.lastText ?? '').length, afterLength: String(after.lastText ?? '').length };
        // :6719-6737 -- `lastMessage.mes = getMessage`. The array does not grow; the last message does.
        if (after.chatLength !== pre.chatLength) problems.push(`${subject}: the chat went from ${pre.chatLength} to ${after.chatLength} messages; pinned's appendFinal REPLACES the last message's text and adds none`);
        if (!String(after.lastText ?? '').startsWith(String(pre.lastText ?? ''))) problems.push(`${subject}: the last message's text does not GROW from what was there -- it was replaced by something unrelated`);
        if (String(after.lastText ?? '').length <= String(pre.lastText ?? '').length) problems.push(`${subject}: the last message did not get longer (${String(pre.lastText ?? '').length} -> ${String(after.lastText ?? '').length})`);
    }
    details.grown = grown;
    if ((grown.gotavern?.chatLengthAfter ?? null) !== (grown.pinned?.chatLengthAfter ?? null)) problems.push(`the two subjects ended with different message counts: ${grown.gotavern?.chatLengthAfter} vs ${grown.pinned?.chatLengthAfter}`);
    return problems;
});

guard('diskHeldALeast', () => {
    const problems = [];
    for (const [subject, report] of Object.entries(reports)) {
        if (!report) continue;
        const before = report.preContinue?.file?.lines ?? null;
        const after = report.fileAfterContinue?.lines ?? null;
        details[`${subject}Lines`] = { before, after };
        if (before === null || after === null || before !== after) problems.push(`${subject}: the file held ${before} line(s) before the Continue and ${after} after; appendFinal adds no message`);
    }
    return problems;
});

guard('diskHeldTheContinuation', () => {
    const problems = [];
    const files = {};
    const marker = String(reports.pinned?.markers?.continuation ?? reports.gotavern?.markers?.continuation ?? '').trim();
    if (marker.length === 0) problems.push('the legs did not record the peer\'s continuation marker, so the file cannot be judged by content');
    for (const [subject, report] of Object.entries(reports)) {
        if (!report) continue;
        const before = report.preContinue?.file ?? null;
        const after = report.fileAfterContinue ?? null;
        if (!before || !after) {
            problems.push(`${subject}: cannot compare the file before and after the Continue`);
            continue;
        }
        const beforeLast = before.messages?.[before.messages.length - 1] ?? null;
        const afterLast = after.messages?.[after.messages.length - 1] ?? null;
        files[subject] = { file: after.file, lines: after.lines, afterTail: String(afterLast?.mes ?? '').slice(-120) };
        if (String(afterLast?.mes ?? '').length <= String(beforeLast?.mes ?? '').length) {
            problems.push(`${subject}: the file's last message did not grow (${String(beforeLast?.mes ?? '').length} -> ${String(afterLast?.mes ?? '').length})`);
        }
        if (!String(afterLast?.mes ?? '').startsWith(String(beforeLast?.mes ?? '\u0000'))) {
            problems.push(`${subject}: the file's last message is not the continuation of the message that was there -- its text does not start with it`);
        }
        if (marker.length > 0 && !String(afterLast?.mes ?? '').includes(marker)) {
            problems.push(`${subject}: the file's last message does not contain the peer's continuation marker ${JSON.stringify(marker)}, so this is not the text the continue produced`);
        }
    }
    details.files = files;
    if (files.gotavern?.file !== files.pinned?.file) problems.push(`the two subjects wrote different chat files: ${JSON.stringify(files.gotavern?.file)} vs ${JSON.stringify(files.pinned?.file)}`);
    return problems;
});

guard('diskMetadataAppended', () => {
    const problems = [];
    const meta = {};
    for (const [subject, report] of Object.entries(reports)) {
        if (!report) continue;
        const beforeLast = report.preContinue?.file?.messages?.at(-1) ?? null;
        const afterLast = report.fileAfterContinue?.messages?.at(-1) ?? null;
        if (!beforeLast || !afterLast) continue;
        meta[subject] = { reasoningBefore: String(beforeLast.extra?.reasoning ?? ''), reasoningAfter: String(afterLast.extra?.reasoning ?? '') };
        // :6734 `lastMessage.extra.reasoning += reasoning;` -- an APPEND. A reset to '' would lose the reasoning the
        // user could already see; this assertion is what distinguishes the two.
        if (!String(afterLast.extra?.reasoning ?? '').startsWith(String(beforeLast.extra?.reasoning ?? ''))) {
            problems.push(`${subject}: extra.reasoning was not preserved across the append (:6734 appends; it was ${JSON.stringify(String(beforeLast.extra?.reasoning ?? '').slice(0, 40))} -> ${JSON.stringify(String(afterLast.extra?.reasoning ?? '').slice(0, 40))})`);
        }
    }
    details.metadata = meta;
    return problems;
});

guard('nextRequestClean', () => {
    const problems = [];
    const go = completions(reports.gotavern);
    const node = completions(reports.pinned);
    const goNext = go[go.length - 1] ?? null;
    const nodeNext = node[node.length - 1] ?? null;
    details.nextRequest = { gotavern: short(goNext), pinned: short(nodeNext) };
    if (!goNext || !nodeNext) return ['one of the subjects produced no request after the Continue'];
    if (goNext.sha256 !== nodeNext.sha256) problems.push(`the request AFTER the Continue differs: gotavern ${goNext.sha256.slice(0, 12)} vs pinned ${nodeNext.sha256.slice(0, 12)}`);
    // THE RESIDUE QUESTION, answered positively on BOTH: a continuation buffer left behind would put the nudge into
    // the next normal turn. `nextTurnCarriesNudge` is the leg's own measurement of exactly that.
    for (const [subject, report] of Object.entries(reports)) {
        if (!report) continue;
        if (report.nextTurnCarriesNudge !== false) {
            problems.push(`${subject}: the request after the Continue carries the continue nudge (nextTurnCarriesNudge=${JSON.stringify(report.nextTurnCarriesNudge)}), so continuation state leaked into the next turn`);
        }
    }
    return problems;
});

const failedGuards = Object.entries(guards).filter(([, ok]) => !ok).map(([name]) => name);
const artefact = {
    schemaVersion: 1,
    verb: 'continue',
    question: 'When a user continues the last reply of a saved, reloaded chat, where does the text land, what does the model receive, what does the file hold afterwards, and does the next request carry residual state?',
    contract: {
        source: 'pinned SillyTavern 1.19.0 (06bde939)',
        placement: 'public/script.js:5534 + :6719-6737 -- saveReply({type:\'appendFinal\'}) sets `lastMessage.mes = getMessage` and appends `extra.reasoning`; the message count is unchanged',
        noNewUserMessage: 'public/script.js:4450-4456 -- \'continue\' is in noAttachTypes, so no user message is created',
        mechanism: 'public/script.js:4866 (cyclePrompt shifted off the history) + :4975-4981 (continue_postfix) + public/scripts/openai.js:907-926/:1087-1090 (the message is re-appended at the end followed by the continue_nudge_prompt); the alternative prefill branch is openai.js:1320-1331 and runs only when continue_prefill is true',
        provider: 'src/endpoints/backends/chat-completions.js:2652-2670 -- no `type` member reaches the provider, so the instruction is visible only as prompt shape',
        therefore: 'same message grown in place, chat length unchanged, the file holds continuation + reply, the continued request ends with the message followed by the nudge',
    },
    guards,
    details,
    missingLegs: missing,
    failedGuards,
    verdict: failedGuards.length === 0 ? 'match' : 'mismatch',
    notCompared: [
        'a real provider (rule 22): the peer is a simulated backend that captures and answers',
        'streaming (Q19): the streaming continuation branch (`streamingProcessor.firstMessageText = \'\'`, script.js:5388-5404) is a different path and is not driven',
        'the `continue_prefill` branch (openai.js:1320-1331): the leg asserts continue_prefill is false and fails if it is not, so that branch stays unmeasured',
        'auto-continue (power_user.auto_continue, script.js:5711-5790): a different trigger that re-clicks the same control',
        'continuing a USER message, and continuing the first message (script.js:5080 isContinuingOnFirstMessage)',
        'group chats',
        'error/cancel mid-continue: no leg drives a failing provider here, so "did the product save half a message" is unanswered',
        'passing the tree to pinned Node afterwards (Q21 owns the hand-back)',
    ],
};

process.stdout.write(`${JSON.stringify(artefact, null, 2)}\n`);
if (artefact.verdict !== 'match') {
    console.error(`Q20 continue comparison failed: ${failedGuards.join(', ')}`);
    process.exitCode = 1;
}
