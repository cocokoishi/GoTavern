// DOES THE Q20 CONTINUE GATE HAVE TEETH? Mutate a synthetic leg pair and require the REAL comparator to go
// red AT A NAMED GUARD, then require it to be green on the untouched pair.
//
// WHY THIS FILE EXISTS (AGENTS.md "Differential-testing doctrine" 4, and the doctrine's first rule: a
// difference is answered by asking whether the GATE has teeth before asking whether the product is wrong).
// `tests/browser/compare-q20-continue-legs.mjs` is the judge for Q20 continue (GOAL.md §9) and it carried
// FOURTEEN guards with no teeth test at all: nothing in this repository had ever demonstrated that any one of
// them can go red. It is also the gate that held `main`'s Browser differential red (run 40837309332 on
// 292905f, failedGuards: ["nextRequestClean"]), so its correctness is load-bearing.
//
// THE TWO DEFECTS THAT RUN EXPOSED, because three of the cases below exist for them:
//   1. the peer's continuation marker embedded the peer's ARRIVAL ORDINAL, which is leg-specific by design:
//      the producer drives two setup turns, so its continue is arrival 3 -> `_3`, while the consumer is handed
//      the finished handoff tree, correctly finds the turns already present, skips them, and its continue is
//      arrival 1 -> `_1`. The marker is persisted into the chat, so it travels inside the NEXT request's
//      messages array, and the two subjects' next requests differed by ONE BYTE. `nextRequestClean` was
//      unsatisfiable by construction. The marker now counts CONTINUATIONS, so both legs emit `_1`.
//   2. `nextRequestClean` selected "the request after the continue" POSITIONALLY, as the last completion. A
//      leg that drove no turn after the verb has the CONTINUE as its last completion, so the old expression
//      handed the guard the continue request and compared it against the other subject's next turn --
//      reporting "the request AFTER the Continue differs" while comparing two different objects. It now
//      selects the completion immediately after the one carrying the product's own nudge marker
//      (`nextRequestOf`), and answers `null` -- named, not invented -- when there is none.
//
// WHY SYNTHETIC RATHER THAN THE LEGS FROM THE LAST RUN: this file must be runnable before any browser has
// started. It is the cheap proof that the judge works, so the expensive legs are only paid for once, and it
// cannot be satisfied by re-reading a previous run's artefacts. No Playwright, no browser, no network, and no
// dependency on any file outside this repository.
//
// HOW THE REAL COMPARATOR IS EXERCISED. `compare-q20-continue-legs.mjs` is a CLI: it reads two leg report
// paths from argv, prints the artefact on stdout and exits non-zero when a guard fails. It exports nothing and
// this file must not edit it, so it is run AS A PROCESS -- the same argv shape, the same stdout artefact, the
// same exit status and the same stderr the CI step reads -- against synthetic reports written into a scratch
// directory under the OS temp root. Nothing is written beside the recorded evidence and nothing under
// tests/browser is touched.
//
// THE MUTATIONS, one real way the product or the harness could be wrong per case, each of which must be killed
// BY THE GUARD THAT OWNS THE OBSERVATION. "The verdict is mismatch" is not the requirement: a mutation that
// dies at some OTHER guard means the targeted guard cannot fail, which is the "survived in the assertion that
// matters" case this file exists to catch. Where the isolation is exact it is asserted as such
// (`killedByExactly`), so a case that starts bleeding into a second guard fails here instead of passing.
//
//   legsPresent                  an absent pinned leg report is named, not dereferenced
//   legsDrove                    the press was never delivered; the named card was never opened
//   peerServedTheRequestedWire   the peer answered JSON to a request that asked for streaming
//   sameChat                     two subjects on different chats; a pinned leg that did not start from the
//                                producer's pre-continue bytes (the handoff taken on the wrong side of the verb)
//   mechanismNamed               the two subjects ran different continuation mechanisms
//   continuationMovedTheHistory  the continue request is byte-identical to the request that produced the
//                                message (the verb reached no provider); and a continue digest that is a copy
//                                of the produced request's digest, which is the field the guard actually reads
//   nudgeAssemblesLast           the nudge is last but the message before it is not the one being continued;
//                                and BOTH subjects drop the nudge, leaving two byte-identical requests with no
//                                continuation instruction at all -- the case a hash-only comparator calls equal
//   sameSetup                    the consumer did not find the predecessor it was handed; the consumer sent
//                                MORE completions than the producer
//   nodeEqualsGoContinue         one byte changed in the continued request, away from the nudge tail
//   sameMessageGrown             a new message appended instead of the text growing in place; the last message
//                                REPLACED by something unrelated
//   diskHeldALeast               the file gained a line
//   diskHeldTheContinuation      the file's last message did not grow; the legs recorded no continuation marker
//   diskMetadataAppended         extra.reasoning RESET instead of appended
//   nextRequestClean             THE ONE-BYTE ORDINAL (defect 1): the two next requests differ by exactly one
//                                byte, inside the text the continuation persisted into the chat
//   nextRequestClean             NO REQUEST AFTER THE CONTINUE (defect 2): the guard must name the absence and
//                                must NOT compare the continue against the other leg's next turn
//   nextRequestClean             the residue: the next turn carries the continue nudge
//
// THREE NEGATIVE CONTROLS, because a teeth test that can only answer "caught" is itself decoration:
//   1. a change the comparator legitimately tolerates (an unknown member; doctrine 11) must be reported as a
//      MISS rather than counted as a catch;
//   2. the same detection predicate must report a MISS when a mutation dies at a DIFFERENT guard than the one
//      it targets -- the "BY A NAMED GUARD" requirement, shown to have teeth;
//   3. a broken baseline must fail the baseline check rather than pass it.
//
// Usage: node tests/browser/q20-continue-comparator-selftest.mjs [--comparator <path>]
//        `--comparator` exists so this file's OWN teeth can be demonstrated against a deliberately weakened
//        COPY of the comparator, without editing the real one: a guard made vacuous in the copy must turn the
//        case that needed it into a MISS. CI passes no arguments, so the real file is what the gate judges.
// Exit:  0 when every mutation was caught by its named guard AND the baseline is green; 1 naming what was
//        missed. A survivor is REPORTED, never silently removed, and the comparator is never weakened to make
//        a case catchable.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const comparatorArgument = process.argv.indexOf('--comparator');
const comparator = comparatorArgument >= 0
    ? path.resolve(process.argv[comparatorArgument + 1] ?? '')
    : path.join(here, 'compare-q20-continue-legs.mjs');
if (!fs.existsSync(comparator)) {
    console.error(`q20 continue comparator self-test REFUSES: there is no comparator at ${comparator}`);
    process.exit(1);
}

const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex');

// THE FOURTEEN GUARDS THIS FILE MUST BE ABLE TO TAKE DOWN, read out of the comparator's own header comment and
// its `guard(...)` calls. The baseline asserts every one of them is PRESENT and true, so a guard deleted from
// the comparator fails here rather than quietly reducing the gate, and the coverage line at the end is computed
// from the mutation table rather than from prose.
const REQUIRED_GUARDS = [
    'legsPresent',
    'legsDrove',
    'peerServedTheRequestedWire',
    'sameChat',
    'mechanismNamed',
    'continuationMovedTheHistory',
    'nudgeAssemblesLast',
    'sameSetup',
    'nodeEqualsGoContinue',
    'sameMessageGrown',
    'diskHeldALeast',
    'diskHeldTheContinuation',
    'diskMetadataAppended',
    'nextRequestClean',
];

// The observations the real probe records, at the values a faithful run produces. Taken from
// `q20-continue-probe.mjs` (the field names) and `q20-persistence-drive.mjs:86-108` (the chat-file shape) so a
// synthetic leg cannot be a state the comparator could never see.
const NUDGE = '[Continue your last message without repeating its original content.]';
const CONTINUATION_MARKER = 'Q20_CONTINUATION_APPENDED';
const FIRST_TURN_MARKER = 'Q20_CONTINUE_FIRST_TURN_MARKER';
const SECOND_TURN_MARKER = 'Q20_CONTINUE_SECOND_TURN_MARKER';
const CHAT_ID = 'Q20 Continue Chat';
const CHAT_FILE = path.posix.join('chats', 'Q20 Card', `${CHAT_ID}.jsonl`);
const REPLY_2 = 'Q20_REPLY_2';
const PRE_CONTINUE_SHA = sha256('Q20 pre-continue chat bytes: the state the handoff copied');
const POST_CONTINUE_SHA = sha256('Q20 post-continue chat bytes: the same file, one message grown');

// THE SYNTHETIC PAIR. It models the producer/consumer asymmetry the surface is built on:
//   * the GoTavern leg is the PRODUCER: it starts from a two-line chat, drives the two setup turns (four
//     completions) and writes the handoff;
//   * the pinned leg is the CONSUMER: it is handed the finished handoff tree, correctly finds the setup turns
//     already present, skips them (two completions) and continues the same message.
// The CONTINUE REQUEST ITSELF IS THE SAME BYTES ON BOTH SUBJECTS -- that is the claim of this surface -- so a
// mutation that changes it is a product/harness difference and not an artefact of the two roles.
//
// The continuation ordinal is a BUILDER OPTION rather than a post-hoc edit, because in the real defect it is
// per-subject from the start: the peer's marker carries it, it is persisted into the chat, and it is re-sent
// inside the NEXT request. A mutation that only rewrote the next body would not model the defect.
function buildLegs(options = {}) {
    const gotavernOrdinal = Number.isInteger(options.gotavernContinuationOrdinal) ? options.gotavernContinuationOrdinal : 1;
    const pinnedOrdinal = Number.isInteger(options.pinnedContinuationOrdinal) ? options.pinnedContinuationOrdinal : 1;

    const system = { role: 'system', content: 'Q20 continue probe system prompt' };
    const firstUser = { role: 'user', name: 'Probe User', content: `Q20 continuable first turn ${FIRST_TURN_MARKER}` };
    const firstReply = { role: 'assistant', name: 'Q20 Card', content: 'Q20_REPLY_1' };
    const secondUser = { role: 'user', name: 'Probe User', content: `Q20 continuable second turn ${SECOND_TURN_MARKER}` };
    const continuedMessage = { role: 'assistant', name: 'Q20 Card', content: REPLY_2 };
    const history = [system, firstUser, firstReply, secondUser];

    const continuedText = ordinal => `${REPLY_2} ${CONTINUATION_MARKER}_${ordinal}`;

    // The chat file's messages, in the shape `chatCarrying` returns (header already stripped, page indices).
    const fileMessages = (lastText, lastReasoning) => [
        { index: 0, is_user: false, mes: 'Q20 greeting', swipe_id: null, swipes: null, swipesCount: null, extra: null, name: 'Q20 Card' },
        { index: 1, is_user: true, mes: firstUser.content, swipe_id: null, swipes: null, swipesCount: null, extra: null, name: 'Probe User' },
        { index: 2, is_user: false, mes: firstReply.content, swipe_id: null, swipes: null, swipesCount: null, extra: null, name: 'Q20 Card' },
        { index: 3, is_user: true, mes: secondUser.content, swipe_id: null, swipes: null, swipesCount: null, extra: null, name: 'Probe User' },
        { index: 4, is_user: false, mes: lastText, swipe_id: null, swipes: null, swipesCount: null, extra: { reasoning: lastReasoning }, name: 'Q20 Card' },
    ];

    const subject = (name, ordinal, carriesPredecessor) => {
        const grown = continuedText(ordinal);
        return {
            schemaVersion: 1,
            verb: 'continue',
            subject: name,
            markers: { first: FIRST_TURN_MARKER, second: SECOND_TURN_MARKER, continuation: CONTINUATION_MARKER },
            wireMode: 'honour',
            steps: [
                { name: 'page-loaded', ok: true, detail: 'settingsReady=true' },
                { name: 'character-opened', ok: true, detail: '{"opened":true}' },
                { name: 'continue-control-reached', ok: true, detail: '{"pressed":true,"sawBusy":true}' },
                { name: 'next-turn-issued-one-request', ok: true, detail: '1 request(s) after the continue' },
            ],
            failure: null,
            configured: {
                source: 'custom',
                url: 'http://127.0.0.1:9999/v1',
                model: 'probe-model',
                continuePrefill: false,
                continueNudgePrompt: NUDGE,
                continuePostfix: ' ',
            },
            characterOpen: { opened: true, wanted: 'Q20 Card', characterName: 'Q20 Card' },
            continue: {
                pressed: true,
                sawBusy: true,
                // RECORDED, NOT ASSERTED, by the comparator: a browser ES-module export is a live binding, so
                // the wrapper may never bind and this field is expected to say so on every real run.
                generateWrapStatus: 'defineProperty-threw: Cannot redefine property: Generate',
                generateCalls: [],
                before: { lastMessage: { mes: REPLY_2 }, chatLength: 5 },
                after: { lastText: grown, lastIsUser: false, chatLength: 5 },
            },
            preContinue: {
                page: { chatId: CHAT_ID, chatLength: 5, lastIsUser: false, lastText: REPLY_2 },
                file: { file: CHAT_FILE, sha256: PRE_CONTINUE_SHA, lines: 5, messages: fileMessages(REPLY_2, 'Q20_REASONING_1') },
            },
            // Only the producer takes a handoff; the guard requires the producer to have recorded the hash the
            // pinned leg must then be shown to have read.
            handoffTree: carriesPredecessor
                ? null
                : { path: 'q20-continue-tree-handoff', at: 'pre-continue state, before the press', preContinueSha256: PRE_CONTINUE_SHA },
            pageAfter: { chatId: CHAT_ID, chatLength: 5, lastText: grown, lastIsUser: false },
            fileAfterContinue: {
                file: CHAT_FILE,
                sha256: POST_CONTINUE_SHA,
                lines: 5,
                messages: fileMessages(grown, 'Q20_REASONING_1 Q20_REASONING_2'),
            },
            setupDecision: {
                openChat: CHAT_FILE,
                source: 'file',
                lines: 5,
                messages: 5,
                carriesPredecessor,
                openedContextChatLength: 5,
                filesOnDisk: [`${CHAT_FILE}:5`],
                rule: 'the two setup turns are driven only when the open chat does NOT already carry the second-turn marker',
            },
            nextTurnCarriesNudge: false,
            disconnectDuringContinue: {
                outcome: 'kept-partial',
                abortedRequests: 1,
                newPeerRequests: 1,
                before: { lastIsUser: false, lastText: grown, chatLength: 5 },
                afterChatLength: 5,
                afterLastIsUser: false,
                afterLastText: grown,
                sawBusy: false,
            },
            continueRequests: 1,
            nextTurnRequests: 1,
            peerRequests: carriesPredecessor
                ? [
                    // The consumer SKIPPED the two setup turns as requests, but the chat it was handed already
                    // carries them, so the request it assembles is the same request the producer assembled.
                    completion({ messages: [system, firstUser, firstReply, secondUser, continuedMessage, { role: 'system', content: NUDGE }] }),
                    completion({ messages: [...history, { role: 'assistant', name: 'Q20 Card', content: grown }, { role: 'user', name: 'Probe User', content: 'Q20 continue residual probe turn' }] }),
                ]
                : [
                    completion({ messages: [system, firstUser] }),
                    completion({ messages: [system, firstUser, firstReply, secondUser] }),
                    completion({ messages: [system, firstUser, firstReply, secondUser, continuedMessage, { role: 'system', content: NUDGE }] }),
                    completion({ messages: [...history, { role: 'assistant', name: 'Q20 Card', content: grown }, { role: 'user', name: 'Probe User', content: 'Q20 continue residual probe turn' }] }),
                ],
        };
    };

    return { gotavern: subject('gotavern', gotavernOrdinal, false), pinned: subject('pinned', pinnedOrdinal, true) };
}

// A recorded completion, in the shape `q20-continue-probe.mjs:616` writes: the digest and length are the
// contract (doctrine 2 -- provider-wire stays byte-oriented), so every mutation that touches a body must
// re-hash through `rewriteBody` or it would be invisible to the guards that compare bytes.
function completion(body) {
    const text = JSON.stringify(body);
    return {
        method: 'POST',
        path: '/v1/chat/completions',
        byteLength: Buffer.byteLength(text, 'utf8'),
        sha256: sha256(text),
        body: text,
        requestedStream: true,
        served: { wire: 'sse' },
    };
}

// THE BY-CONSTRUCTION INDICES OF THE SYNTHETIC PAIR. This file may use them because it BUILT the arrays; the
// comparator may not, and that is exactly the defect the Lead fixed (a positional index is a derivation about
// how many turns a leg drove).
const GOTAVERN_CONTINUE = 2;
const GOTAVERN_NEXT = 3;
const PINNED_CONTINUE = 0;
const PINNED_NEXT = 1;

const clone = value => JSON.parse(JSON.stringify(value));
const completionsOf = report => (report?.peerRequests ?? []).filter(entry => /chat\/completions/.test(entry.path ?? ''));

function rewriteBody(entry, body) {
    entry.body = JSON.stringify(body);
    entry.byteLength = Buffer.byteLength(entry.body, 'utf8');
    entry.sha256 = sha256(entry.body);
    return entry;
}

// ---- RUN THE REAL COMPARATOR, AS A PROCESS ----------------------------------------------------------------
// A scratch directory under the OS temp root, never beside the recorded evidence: the synthetic legs must not be
// mistakable for a run's own legs, and the comparator reads its inputs from paths.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'q20-continue-comparator-selftest-'));
let caseCounter = 0;

function judge(legs) {
    caseCounter += 1;
    const tag = String(caseCounter).padStart(3, '0');
    const files = { gotavern: path.join(scratch, `${tag}-gotavern.json`), pinned: path.join(scratch, `${tag}-pinned.json`) };
    for (const subject of ['gotavern', 'pinned']) {
        const report = legs?.[subject] ?? null;
        // AN ABSENT LEG IS MODELLED BY NOT WRITING THE FILE, because `legsPresent` is the guard that must name
        // it; writing a file the comparator cannot parse would model a different defect.
        if (report === null) {
            fs.rmSync(files[subject], { force: true });
            continue;
        }
        fs.writeFileSync(files[subject], `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    }
    const run = spawnSync(process.execPath, [comparator, files.gotavern, files.pinned], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    let artefact = null;
    try {
        artefact = JSON.parse(String(run.stdout ?? ''));
    } catch {
        artefact = null;
    }
    return {
        executed: !run.error,
        error: run.error ? String(run.error.message ?? run.error) : null,
        status: run.status,
        artefact,
        stderr: String(run.stderr ?? '').trim(),
    };
}

const failedGuardsOf = artefact => Object.entries(artefact?.guards ?? {}).filter(([, ok]) => ok !== true).map(([name]) => name);
const problemsOf = (artefact, guard) => artefact?.details?.[`${guard}Problems`] ?? [];
const sameSet = (left, right) => left.length === right.length && left.every(name => right.includes(name));

// THE DETECTION PREDICATE, used by every mutation case AND by the negative controls. It is a separate function
// so the controls can prove it can return "miss": a predicate that can only answer "caught" would make every
// row below vacuous.
function detection(run, expected, options = {}) {
    const failed = failedGuardsOf(run.artefact);
    const missing = expected.filter(name => !failed.includes(name));
    const problemText = (options.problemIncludes ?? []).every(entry => problemsOf(run.artefact, entry.guard).some(problem => String(problem).includes(entry.includes)));
    const absentText = (options.problemExcludes ?? []).every(entry => !problemsOf(run.artefact, entry.guard).some(problem => String(problem).includes(entry.includes)));
    return {
        caught: run.executed === true
            && run.artefact !== null
            && run.artefact.verdict !== 'match'
            && missing.length === 0
            && problemText
            && absentText
            && (options.killedByExactly === undefined || sameSet(failed, options.killedByExactly))
            && (options.premise === undefined || options.premise === true),
        failed,
        missing,
        problemText,
        absentText,
        verdict: run.artefact?.verdict ?? null,
        exit: run.status,
    };
}

// The printed detail carries the guard that ACTUALLY fired and the first problem text it recorded, so a reader
// can see the cause rather than infer it from a boolean.
function detailOf(run, outcome, expected, extra) {
    const firstProblem = {};
    for (const guard of new Set([...expected, ...outcome.failed])) {
        const problem = problemsOf(run.artefact, guard)[0];
        if (problem !== undefined) firstProblem[guard] = String(problem).slice(0, 220);
    }
    return JSON.stringify({
        expected,
        killedBy: outcome.failed,
        verdict: outcome.verdict,
        exit: outcome.exit,
        ...(run.executed ? {} : { harnessError: run.error, stderr: run.stderr.slice(0, 200) }),
        ...(Object.keys(firstProblem).length > 0 ? { firstProblem } : {}),
        ...(extra ?? {}),
    });
}

const failures = [];
const table = [];
let MUTATION_COUNT = 0;
const record = (name, ok, detail) => {
    console.log(`${ok ? 'ok  ' : 'MISS'} ${name}${detail ? ` -- ${detail}` : ''}`);
    if (!ok) failures.push(name);
};
const mutation = (name, ok, detail, killedBy) => {
    MUTATION_COUNT += 1;
    table.push({ name, ok, killedBy: killedBy ?? [] });
    record(name, ok, detail);
};

function mutationCase(name, legs, expected, options = {}) {
    const run = judge(legs);
    const outcome = detection(run, expected, options);
    const extra = typeof options.detail === 'function' ? options.detail(run, legs) : options.detail;
    mutation(name, outcome.caught, detailOf(run, outcome, expected, extra), outcome.failed);
    return { run, outcome };
}

function baselineVerdict(legs) {
    const run = judge(legs);
    const guards = run.artefact?.guards ?? {};
    const missing = REQUIRED_GUARDS.filter(name => !(name in guards));
    const failed = failedGuardsOf(run.artefact);
    return {
        run,
        guards,
        missing,
        failed,
        green: run.executed === true && run.artefact !== null && run.status === 0 && run.artefact.verdict === 'match' && failed.length === 0 && missing.length === 0,
    };
}

// WHICH COMPARATOR IS UNDER TEST, printed because `--comparator` can point at a weakened copy: a run that
// judged a copy has to be visible in its own log rather than inferred from the argument list.
console.log(`comparator under test: ${comparator}`);

// 0. THE BASELINE MUST BE GREEN. A comparator that is red on a faithful pair would "catch" every mutation below
//    for the wrong reason, so the unmutated pair is judged first and nothing below runs if it is not green.
//    IF IT IS NOT GREEN, THAT IS A FINDING: a guard is not weakened and the comparator is not edited to make
//    this pass -- the synthetic pair is the thing to re-read.
const baseline = baselineVerdict(buildLegs());
const extraGuards = Object.keys(baseline.guards).filter(name => !REQUIRED_GUARDS.includes(name));
record(
    `baseline is green (verdict match, all ${REQUIRED_GUARDS.length} named guards present and true, comparator exit 0)`,
    baseline.green,
    JSON.stringify({
        comparator,
        verdict: baseline.run.artefact?.verdict ?? null,
        exit: baseline.run.status,
        failedGuards: baseline.failed,
        missingGuards: baseline.missing,
        ...(baseline.run.executed ? {} : { harnessError: baseline.run.error, stderr: baseline.run.stderr.slice(0, 200) }),
        ...(extraGuards.length > 0 ? { guardsBeyondTheNamedList: extraGuards } : {}),
    }),
);

if (!baseline.green) {
    console.error('q20 continue comparator self-test REFUSES: the synthetic baseline is not green, so no mutation below could be attributed to a mutation.');
    console.error('the comparator (or this synthetic pair) is wrong; a guard is NOT weakened and compare-q20-continue-legs.mjs is NOT edited to make this pass.');
} else {
    // 1. legsPresent -- an absent leg report is named, never dereferenced.
    {
        const legs = buildLegs();
        mutationCase('an absent pinned leg report is caught by legsPresent', { gotavern: legs.gotavern, pinned: null }, ['legsPresent']);
    }

    // 2. legsDrove -- the drive never reached the control.
    {
        const legs = clone(buildLegs());
        legs.gotavern.continue.pressed = false;
        mutationCase('a continue control that was never reached is caught by legsDrove', legs, ['legsDrove'], { killedByExactly: ['legsDrove'] });
    }

    // 3. legsDrove -- the leg did not open the named card, so it continued something else.
    {
        const legs = clone(buildLegs());
        legs.pinned.characterOpen.opened = false;
        mutationCase('a leg that did not open the named card is caught by legsDrove', legs, ['legsDrove'], { killedByExactly: ['legsDrove'] });
    }

    // 4. peerServedTheRequestedWire -- the page streams by default, so a peer answering JSON yields an empty
    //    reply while every structural guard still passes.
    {
        const legs = clone(buildLegs());
        completionsOf(legs.pinned)[PINNED_CONTINUE].served = { wire: 'json' };
        mutationCase('a peer that answered JSON to a request asking for streaming is caught by peerServedTheRequestedWire', legs, ['peerServedTheRequestedWire'], { killedByExactly: ['peerServedTheRequestedWire'] });
    }

    // 5. sameChat -- the two subjects continued different conversations.
    {
        const legs = clone(buildLegs());
        legs.pinned.preContinue.page.chatId = 'Q20 A Different Chat';
        mutationCase('two subjects continuing different chats is caught by sameChat', legs, ['sameChat'], { killedByExactly: ['sameChat'] });
    }

    // 6. sameChat -- the handoff was taken on the wrong side of the verb, so the pinned leg started from bytes
    //    the producer never copied (run 40589750993: the pinned last message was already grown).
    {
        const legs = clone(buildLegs());
        legs.pinned.preContinue.file.sha256 = sha256('Q20 a different pre-continue state: the handoff taken after the continuation');
        mutationCase('a pinned leg that did not start from the producer\'s pre-continue bytes is caught by sameChat', legs, ['sameChat'], { killedByExactly: ['sameChat'] });
    }

    // 7. mechanismNamed -- the two sides used different branches, so their requests are not comparable.
    {
        const legs = clone(buildLegs());
        legs.pinned.configured.continuePrefill = true;
        mutationCase('two subjects running different continuation mechanisms is caught by mechanismNamed', legs, ['mechanismNamed'], { killedByExactly: ['mechanismNamed'] });
    }

    // 8. continuationMovedTheHistory -- the continue request is the request that produced the message: the verb
    //    reached no provider. This is the faithful shape of the defect (a continue that sends the pre-continue
    //    context carries no nudge, so the continue request is not identifiable at all).
    {
        const legs = clone(buildLegs());
        const go = completionsOf(legs.gotavern);
        rewriteBody(go[GOTAVERN_CONTINUE], JSON.parse(go[GOTAVERN_CONTINUE - 1].body));
        mutationCase('a continue request byte-identical to the request that produced the message is caught by continuationMovedTheHistory', legs, ['continuationMovedTheHistory']);
    }

    // 9. continuationMovedTheHistory -- the DIGEST is the contract (doctrine 2), so a leg report whose continue
    //    digest is a copy of the produced request's digest is exactly what the guard reads. This case exists
    //    because case 8 dies on the guard's "cannot identify the continue" branch; this one reaches the
    //    "IDENTICAL to the request that produced the message" branch by name.
    {
        const legs = clone(buildLegs());
        const go = completionsOf(legs.gotavern);
        go[GOTAVERN_CONTINUE].sha256 = go[GOTAVERN_CONTINUE - 1].sha256;
        go[GOTAVERN_CONTINUE].byteLength = go[GOTAVERN_CONTINUE - 1].byteLength;
        mutationCase('a continue digest copied from the produced request is caught by continuationMovedTheHistory naming the identity', legs, ['continuationMovedTheHistory'], {
            problemIncludes: [{ guard: 'continuationMovedTheHistory', includes: 'IDENTICAL to the request that produced' }],
        });
    }

    // 10. nudgeAssemblesLast -- the nudge is present and LAST, but the message before it is not the message being
    //     continued: the structural assertion the guard exists for, on the request the guard can still identify.
    {
        const legs = clone(buildLegs());
        const entry = completionsOf(legs.gotavern)[GOTAVERN_CONTINUE];
        const body = JSON.parse(entry.body);
        body.messages[body.messages.length - 2].content = 'Q20 a message that is NOT the one being continued';
        rewriteBody(entry, body);
        mutationCase('a nudge whose preceding message is not the one being continued is caught by nudgeAssemblesLast', legs, ['nudgeAssemblesLast'], {
            problemIncludes: [{ guard: 'nudgeAssemblesLast', includes: 'the message before the nudge is not the message being continued' }],
        });
    }

    // 11. nudgeAssemblesLast -- BOTH subjects drop the nudge, leaving two BYTE-IDENTICAL requests that carry no
    //     continuation instruction at all. This is the case the comparator's own header says a hash-only
    //     comparator would miss, and the case's premise (the two requests really are byte-identical) is
    //     asserted, so the case fails here rather than passing for a reason it did not name.
    {
        const legs = clone(buildLegs());
        for (const [report, index] of [[legs.gotavern, GOTAVERN_CONTINUE], [legs.pinned, PINNED_CONTINUE]]) {
            const entry = completionsOf(report)[index];
            const body = JSON.parse(entry.body);
            body.messages = body.messages.slice(0, -1);
            rewriteBody(entry, body);
        }
        const goEntry = completionsOf(legs.gotavern)[GOTAVERN_CONTINUE];
        const nodeEntry = completionsOf(legs.pinned)[PINNED_CONTINUE];
        mutationCase('two byte-identical continue requests carrying NO continuation instruction are caught by nudgeAssemblesLast', legs, ['nudgeAssemblesLast'], {
            premise: goEntry.sha256 === nodeEntry.sha256,
            detail: {
                theTwoContinueRequestsAreByteIdentical: goEntry.sha256 === nodeEntry.sha256,
                note: 'a hash-only comparator would call these two requests equal; the nudge assertion is what refuses them',
            },
        });
    }

    // 12. sameSetup -- the CONSUMER did not find the predecessor it was handed, so the handoff did not carry the
    //     setup turns (the asymmetry the guard's own comment describes, in the direction that is a defect).
    {
        const legs = clone(buildLegs());
        legs.pinned.setupDecision.carriesPredecessor = false;
        mutationCase('a consumer that did not find the predecessor it was handed is caught by sameSetup', legs, ['sameSetup'], { killedByExactly: ['sameSetup'] });
    }

    // 13. sameSetup -- the CONSUMER sent MORE completions than the producer: it drove setup turns the finished
    //     handoff already carried. The extra requests are PREPENDED so the continue stays identifiable and the
    //     only observation that moves is the completion count the guard reads.
    {
        const legs = clone(buildLegs());
        legs.pinned.peerRequests = [
            completion({ messages: [{ role: 'user', content: 'Q20 a setup turn the handoff already carried (1)' }] }),
            completion({ messages: [{ role: 'user', content: 'Q20 a setup turn the handoff already carried (2)' }] }),
            completion({ messages: [{ role: 'user', content: 'Q20 a setup turn the handoff already carried (3)' }] }),
            ...legs.pinned.peerRequests,
        ];
        mutationCase('a consumer that sent MORE completions than the producer is caught by sameSetup', legs, ['sameSetup'], { killedByExactly: ['sameSetup'] });
    }

    // 14. nodeEqualsGoContinue -- ONE byte changed in the continued request, in its FIRST message so the nudge
    //     tail (which identifies the request) is untouched: the guard that must name the byte difference.
    {
        const legs = clone(buildLegs());
        const entry = completionsOf(legs.pinned)[PINNED_CONTINUE];
        const body = JSON.parse(entry.body);
        body.messages[0].content = `${body.messages[0].content}Z`;
        rewriteBody(entry, body);
        mutationCase('one byte changed in the continued request is caught by nodeEqualsGoContinue', legs, ['nodeEqualsGoContinue'], { killedByExactly: ['nodeEqualsGoContinue'] });
    }

    // 15. sameMessageGrown -- a new message was appended instead of the text growing in place (:6719-6737).
    {
        const legs = clone(buildLegs());
        legs.pinned.pageAfter.chatLength = 6;
        mutationCase('a continue that appended a new message instead of growing the last one is caught by sameMessageGrown', legs, ['sameMessageGrown'], { killedByExactly: ['sameMessageGrown'] });
    }

    // 16. sameMessageGrown -- the last message was REPLACED by something unrelated (it did not grow FROM the text
    //     that was there), which the length comparison alone would not catch.
    {
        const legs = clone(buildLegs());
        legs.pinned.pageAfter.lastText = 'Q20 a replacement that does not start with the message being continued';
        mutationCase('a last message replaced by something unrelated is caught by sameMessageGrown', legs, ['sameMessageGrown'], { killedByExactly: ['sameMessageGrown'] });
    }

    // 17. diskHeldALeast -- the file gained a line, i.e. the subject appended a message to disk.
    {
        const legs = clone(buildLegs());
        legs.gotavern.fileAfterContinue.lines = 6;
        mutationCase('a chat file that gained a line is caught by diskHeldALeast', legs, ['diskHeldALeast'], { killedByExactly: ['diskHeldALeast'] });
    }

    // 18. diskHeldTheContinuation -- the file's last message did not grow: the write happened but not the append.
    {
        const legs = clone(buildLegs());
        const messages = legs.pinned.fileAfterContinue.messages;
        messages[messages.length - 1].mes = REPLY_2;
        mutationCase('a file whose last message did not grow is caught by diskHeldTheContinuation', legs, ['diskHeldTheContinuation'], { killedByExactly: ['diskHeldTheContinuation'] });
    }

    // 19. diskHeldTheContinuation -- the legs recorded no continuation marker, so the file cannot be judged by
    //     content and the guard must say that rather than pass on the growth check alone.
    {
        const legs = clone(buildLegs());
        delete legs.gotavern.markers.continuation;
        delete legs.pinned.markers.continuation;
        mutationCase('a leg pair that recorded no continuation marker is caught by diskHeldTheContinuation', legs, ['diskHeldTheContinuation'], { killedByExactly: ['diskHeldTheContinuation'] });
    }

    // 20. diskMetadataAppended -- extra.reasoning RESET rather than appended (:6734 is a `+=`), which loses
    //     reasoning the user could already see.
    {
        const legs = clone(buildLegs());
        const messages = legs.pinned.fileAfterContinue.messages;
        messages[messages.length - 1].extra = { reasoning: '' };
        mutationCase('extra.reasoning RESET instead of appended is caught by diskMetadataAppended', legs, ['diskMetadataAppended'], { killedByExactly: ['diskMetadataAppended'] });
    }

    // 21. THE ONE-BYTE ORDINAL -- the defect the Lead just fixed. The peer's marker counts ARRIVALS, which is
    //     leg-specific by role (the producer's continue is arrival 3, the consumer's is arrival 1), the marker is
    //     persisted into the chat, and it is re-sent inside the NEXT request. So the two next requests differ by
    //     exactly one byte and `nextRequestClean` was unsatisfiable by construction. The mutation is applied
    //     through the BUILDER, so the ordinal really propagates from the peer's reply into the page, the file and
    //     the next body -- and the case asserts that the difference IS exactly one byte, that the continue
    //     request itself is byte-identical on both subjects, and that NO OTHER GUARD moves.
    {
        const legs = buildLegs({ gotavernContinuationOrdinal: 3, pinnedContinuationOrdinal: 1 });
        const goNext = completionsOf(legs.gotavern)[GOTAVERN_NEXT].body;
        const nodeNext = completionsOf(legs.pinned)[PINNED_NEXT].body;
        const offsets = [...goNext].map((char, index) => (char === nodeNext[index] ? null : index)).filter(index => index !== null);
        const oneByteApart = goNext.length === nodeNext.length && offsets.length === 1 && goNext[offsets[0]] === '3' && nodeNext[offsets[0]] === '1';
        const run = judge(legs);
        const outcome = detection(run, ['nextRequestClean'], {
            killedByExactly: ['nextRequestClean'],
            premise: oneByteApart,
            problemIncludes: [{ guard: 'nextRequestClean', includes: 'the request AFTER the Continue differs' }],
        });
        mutation(
            'the leg-specific continuation ordinal (the two next requests differ by exactly one byte) is caught by nextRequestClean',
            outcome.caught,
            detailOf(run, outcome, ['nextRequestClean'], {
                differingByteOffsets: offsets,
                differingByte: offsets.length === 1 ? { gotavern: goNext[offsets[0]], pinned: nodeNext[offsets[0]] } : null,
                nextBodyByteLength: { gotavern: Buffer.byteLength(goNext, 'utf8'), pinned: Buffer.byteLength(nodeNext, 'utf8') },
                continueRequestsIdentical: completionsOf(legs.gotavern)[GOTAVERN_CONTINUE].sha256 === completionsOf(legs.pinned)[PINNED_CONTINUE].sha256,
                note: 'the ordinal lives in the chat text the continuation persisted, so it is invisible to every other guard and visible to this one',
            }),
            outcome.failed,
        );
    }

    // 22. NO REQUEST AFTER THE CONTINUE -- the second half of the Lead's fix, and it needs its own case because
    //     the old positional selection (`completions[length - 1]`) would have handed this guard the CONTINUE
    //     request and compared it against the other leg's next turn, reporting a difference between two
    //     different objects. The assertions below are: the pinned side selected NOTHING (null), the gotavern
    //     side WAS found, the guard names the absence, and the wrong-comparison message is absent.
    {
        const legs = clone(buildLegs());
        const pinnedContinue = completionsOf(legs.pinned)[PINNED_CONTINUE];
        legs.pinned.peerRequests = [pinnedContinue];
        const gotavernNext = completionsOf(legs.gotavern)[GOTAVERN_NEXT];
        const run = judge(legs);
        const outcome = detection(run, ['nextRequestClean'], {
            killedByExactly: ['nextRequestClean'],
            problemIncludes: [{ guard: 'nextRequestClean', includes: 'one of the subjects produced no request after the Continue' }],
            problemExcludes: [{ guard: 'nextRequestClean', includes: 'the request AFTER the Continue differs' }],
            // THE DISCRIMINATOR BETWEEN THE FIX AND THE OLD POSITIONAL SELECTION, measured rather than argued:
            //   * the pinned side selected NOTHING here, where the old `completions[length - 1]` would have
            //     returned the CONTINUE request (a non-null object) -- that is what "comparing the wrong
            //     objects" means;
            //   * and the continue's digest really does differ from the gotavern next request's digest, so
            //     under the old selection this guard would have gone red with the WRONG message ("the request
            //     AFTER the Continue differs") instead of naming the absence. If those two digests were equal
            //     the old selection would have passed VACUOUSLY and this case would prove nothing.
            premise: run.artefact?.details?.nextRequest?.pinned === null
                && run.artefact?.details?.nextRequest?.gotavern !== null
                && pinnedContinue.sha256 !== gotavernNext.sha256,
        });
        mutation(
            'a leg that produced NO request after the Continue is caught by nextRequestClean naming the absence, not by comparing the wrong objects',
            outcome.caught,
            detailOf(run, outcome, ['nextRequestClean'], {
                nextRequestSelected: run.artefact?.details?.nextRequest ?? null,
                theContinueTheOldPositionalSelectionWouldHaveReturned: { sha256: pinnedContinue.sha256.slice(0, 12), byteLength: pinnedContinue.byteLength },
                gotavernNextRequest: { sha256: gotavernNext.sha256.slice(0, 12), byteLength: gotavernNext.byteLength },
                note: 'the pinned side selected null while the gotavern side was found, so the guard refused by name instead of inventing a comparison between the continue and the other leg\'s next turn',
            }),
            outcome.failed,
        );
    }

    // 23. THE RESIDUE -- the next turn carries the continue nudge: continuation state leaked into a normal turn.
    //     The two next requests are still byte-identical, so this is the guard's second half (the residue
    //     question) and not its hash comparison.
    {
        const legs = clone(buildLegs());
        legs.pinned.nextTurnCarriesNudge = true;
        const run = judge(legs);
        const outcome = detection(run, ['nextRequestClean'], {
            killedByExactly: ['nextRequestClean'],
            problemIncludes: [{ guard: 'nextRequestClean', includes: 'carries the continue nudge' }],
            premise: completionsOf(legs.gotavern)[GOTAVERN_NEXT].sha256 === completionsOf(legs.pinned)[PINNED_NEXT].sha256,
        });
        mutation(
            'a next turn that carries the continue nudge (residual continuation state) is caught by nextRequestClean',
            outcome.caught,
            detailOf(run, outcome, ['nextRequestClean'], {
                theTwoNextRequestsAreByteIdentical: completionsOf(legs.gotavern)[GOTAVERN_NEXT].sha256 === completionsOf(legs.pinned)[PINNED_NEXT].sha256,
            }),
            outcome.failed,
        );
    }

    // ---- NEGATIVE CONTROLS: the self-test itself must be able to fail ------------------------------------
    // Without these, every "ok" above could come from a predicate that can only answer "caught".

    // NC1. A change the comparator legitimately tolerates: an unknown member is preserved (doctrine 11) and no
    //      guard reads it, so the pair must stay a match and the detection predicate must report a MISS.
    {
        const legs = clone(buildLegs());
        legs.gotavern.serverLog = 'noise the comparator does not read';
        legs.pinned.consoleDiagnostics = [{ type: 'error', text: 'noise the comparator does not read' }];
        const run = judge(legs);
        const outcome = detection(run, ['legsDrove']);
        record(
            'negative control: a change the comparator legitimately tolerates is reported as a MISS, not counted as a catch',
            outcome.caught === false && failedGuardsOf(run.artefact).length === 0,
            JSON.stringify({ demanded: ['legsDrove'], verdict: outcome.verdict, failedGuards: outcome.failed, note: 'unknown members are preserved and no guard reads them, so this pair is still a match' }),
        );
    }

    // NC2. The "BY A NAMED GUARD" requirement shown to have teeth: the one-byte ordinal really does go red, but
    //      NOT at legsDrove. The predicate must report a MISS rather than being satisfied by "some guard fired".
    {
        const run = judge(buildLegs({ gotavernContinuationOrdinal: 3, pinnedContinuationOrdinal: 1 }));
        const outcome = detection(run, ['legsDrove']);
        record(
            'negative control: a mutation killed by a DIFFERENT guard than the one it targets is reported as a MISS',
            outcome.caught === false && outcome.failed.includes('nextRequestClean'),
            JSON.stringify({ demanded: ['legsDrove'], killedBy: outcome.failed, missing: outcome.missing, note: 'the predicate requires the NAMED guard, not merely a mismatch' }),
        );
    }

    // NC3. A broken baseline must fail the baseline check rather than pass it: if this returned green, the
    //      baseline assertion at the top of this file would be decoration.
    {
        const broken = clone(buildLegs());
        broken.pinned.configured.continuePrefill = true;
        const verdict = baselineVerdict(broken);
        record(
            'negative control: a broken baseline fails the baseline check rather than passing it',
            verdict.green === false,
            JSON.stringify({ verdict: verdict.run.artefact?.verdict ?? null, failedGuards: verdict.failed, missingGuards: verdict.missing }),
        );
    }

    // THE GUARD COVERAGE, COMPUTED FROM THE TABLE rather than from prose: every one of the fourteen guards must
    // have been the killer of at least one case above, or a guard exists that nothing here has ever taken down.
    const killedGuards = new Set(table.flatMap(row => row.killedBy));
    const neverKilled = REQUIRED_GUARDS.filter(name => !killedGuards.has(name));
    record(
        `every one of the ${REQUIRED_GUARDS.length} named guards was killed by at least one case (computed from the table)`,
        neverKilled.length === 0,
        JSON.stringify({ killedBy: [...killedGuards].sort(), neverKilled }),
    );
}

fs.rmSync(scratch, { recursive: true, force: true });

// THE MUTATION TABLE, printed so a CI log carries the case -> guard mapping without a reader having to
// reconstruct it from the artefact.
console.log('');
console.log('mutation table (case -> guard that killed it):');
for (const row of table) {
    console.log(`  ${row.ok ? 'killed  ' : 'SURVIVED'} ${(row.killedBy.join(', ') || '(no guard went red)').padEnd(46)} <- ${row.name}`);
}

console.log(failures.length === 0
    ? `q20 continue comparator self-test: ${MUTATION_COUNT} mutations caught, baseline green (${REQUIRED_GUARDS.length} guards present and true)`
    : `q20 continue comparator self-test: ${failures.length} case(s) NOT caught: ${failures.join(', ')}`);
process.exitCode = failures.length === 0 ? 0 : 1;
