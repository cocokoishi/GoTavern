// Compare the COMPLEX-PRESET legs: same scenario, two context boundaries, both servers.
//
// THE CONTRACT IS BYTES, THE DIAGNOSIS IS PARSED (AGENTS.md "Differential-testing doctrine" 2). The
// compared observation is the provider request the drive actually produced: `bodySha256` and
// `bodyLength` for each leg, in both boundary variants. Parsing the body afterwards only answers "which
// message index moved", which is a diagnosis; it never stands in for the byte comparison and nothing is
// canonicalised, re-marshalled or dropped.
//
// WHY TWO VARIANTS. `openai_max_context` is the only knob that decides whether the pinned frontend keeps
// the oldest history turn (public/scripts/openai.js:3982-4089). VestigialContext is
// the smallest value at which the pinned trimmer KEEPS that turn; dropContext is one less, at which it
// drops it. Both were measured by bisecting the pinned frontend in CI (capture-preset.mjs). The pair is
// therefore a real boundary: if GoTavern's tokenizer count differs by one, its trimmer retains a
// different SET and the byte digest differs. A single-context drive cannot show this, which is why the
// previous generation artefacts could not fail on a count error.
//
// THE TOKENIZER COUNTS ARE COMPARED DIRECTLY TOO. Every message count the frontend needs comes from
// POST /api/tokenizers/openai/count (public/scripts/tokenizers.js:846-897), so each leg records the
// pinned frontend asking ITS OWN server. The pinned leg's sequence is the oracle; a difference names the
// first message whose count disagrees. That is the anchor: never a number derived from GoTavern.
//
// Usage: node compare-preset-legs.mjs <keep-gotavern.json> <keep-pinned.json> <drop-gotavern.json> <drop-pinned.json> [--fixture <path>]
// Exit:  0 faithful and equal; 1 unfaithful (a guard failed) or unequal (the differential's finding).

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { MARKERS, PRESET_FIXTURE, findMessage, messageText, parseProviderBody } from './preset-kit.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const FORBIDDEN = [/127\.0\.0\.1/, /localhost:\d+/, /\[::1\]/, /[A-Za-z]:\\\\/, /AppData/i, /\/home\//, /\/tmp\//, /\/Users\//, /\/root\//];

function readJSON(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// summariseBody is everything the artefact may say about a request: the bytes and the shape. The raw
// body is deliberately NOT copied into a committed file (it is large, and the legs that carry it are the
// per-run evidence); the digest is the contract.
function summariseBody(report) {
    const parsed = parseProviderBody(report);
    if (!parsed) {
        return { present: false, bodyLength: null, bodySha256: null, messageCount: null, memberOrder: null, stream: null, maxTokens: null, stop: null, model: null, names: null };
    }
    const body = parsed.body;
    return {
        present: true,
        bodyLength: parsed.bodyLength ?? parsed.raw.length,
        bodySha256: parsed.bodySha256 ?? null,
        messageCount: Array.isArray(body?.messages) ? body.messages.length : null,
        // MEMBER ORDER IS PART OF THE BYTES, so it is recorded: a body with the same members in another
        // order has a different digest, and a reader who sees equal digests can see why.
        memberOrder: Object.keys(body ?? {}),
        stream: body?.stream ?? null,
        maxTokens: body?.max_tokens ?? null,
        stop: body?.stop ?? null,
        model: body?.model ?? null,
        names: Array.isArray(body?.messages) ? body.messages.map(message => message?.name ?? null).filter(value => value !== null) : [],
    };
}

// messageDiff names the first differing message, index, role and a bounded excerpt of each side. A
// difference in the member set is reported first, because it explains a message diff that follows from a
// source-level omission rather than from the trimmer.
function messageDiff(govern, pinned) {
    const differences = [];
    if (!govern.present || !pinned.present) {
        differences.push('one leg produced no provider request body');
        return { differences, first: null };
    }
    const left = govern.body ?? {};
    const right = pinned.body ?? {};
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    for (const key of rightKeys) {
        if (!leftKeys.includes(key)) differences.push(`top-level member only in pinned: ${key}`);
    }
    for (const key of leftKeys) {
        if (!rightKeys.includes(key)) differences.push(`top-level member only in GoTavern: ${key}`);
    }
    const leftMessages = Array.isArray(left.messages) ? left.messages : null;
    const rightMessages = Array.isArray(right.messages) ? right.messages : null;
    if (leftMessages && rightMessages) {
        const total = Math.max(leftMessages.length, rightMessages.length);
        if (leftMessages.length !== rightMessages.length) {
            differences.push(`messages length: GoTavern ${leftMessages.length}, pinned ${rightMessages.length}`);
        }
        for (let index = 0; index < total; index++) {
            const mine = leftMessages[index];
            const theirs = rightMessages[index];
            if (!mine || !theirs) {
                differences.push(`messages[${index}] present only in ${mine ? 'GoTavern' : 'pinned'}`);
                if (!mine || !theirs) {
                    return {
                        differences,
                        first: {
                            index,
                            presentOnlyIn: mine ? 'GoTavern' : 'pinned',
                            pinned: theirs ? { role: theirs.role ?? null, textHead: messageText(theirs).slice(0, 160) } : null,
                            gotavern: mine ? { role: mine.role ?? null, textHead: messageText(mine).slice(0, 160) } : null,
                        },
                    };
                }
            }
            const mineText = messageText(mine);
            const theirsText = messageText(theirs);
            if (mine.role !== theirs.role || mineText !== theirsText || (mine.name ?? null) !== (theirs.name ?? null)) {
                differences.push(`messages[${index}] differs (pinned ${JSON.stringify(theirs.role)}, GoTavern ${JSON.stringify(mine.role)}, ${theirsText.length} vs ${mineText.length} chars)`);
                return {
                    differences,
                    first: {
                        index,
                        pinned: { role: theirs.role ?? null, name: theirs.name ?? null, textHead: theirsText.slice(0, 160) },
                        gotavern: { role: mine.role ?? null, name: mine.name ?? null, textHead: mineText.slice(0, 160) },
                    },
                };
            }
        }
    }
    for (const key of rightKeys) {
        if (['messages'].includes(key)) continue;
        const mine = JSON.stringify(left[key]);
        const theirs = JSON.stringify(right[key]);
        if (mine !== theirs) {
            differences.push(`field ${key} differs: GoTavern ${mine?.slice(0, 120)} pinned ${theirs?.slice(0, 120)}`);
        }
    }
    return { differences, first: null };
}

// tokenizerCounts reads the frontend's own count traffic. `postData` is the exact body the pinned
// frontend posted for ONE message (public/scripts/tokenizers.js:878-890), and `responseBody` is what the
// server answered, so a 9-vs-10 can be attributed to a message rather than guessed at.
function tokenizerCounts(report) {
    const calls = Array.isArray(report.tokenizerCalls) ? report.tokenizerCalls : [];
    return calls
        .filter(call => String(call.path ?? '').includes('/api/tokenizers/openai/count') || String(call.path ?? '').includes('/api/tokenizers/'))
        .map(call => {
            let count = null;
            try {
                const payload = JSON.parse(call.responseBody ?? 'null');
                count = payload?.token_count ?? (Array.isArray(payload?.ids) ? payload.ids.length : null);
            } catch {
                count = null;
            }
            let requestText = null;
            try {
                const body = JSON.parse(call.postData ?? 'null');
                const first = Array.isArray(body) ? body[0] : null;
                requestText = first ? String(first.content ?? '').slice(0, 120) : null;
            } catch {
                requestText = null;
            }
            return { path: call.path ?? null, status: call.status ?? null, count, requestText };
        });
}

function compareTokenizers(gotavernCounts, pinnedCounts) {
    const total = Math.max(gotavernCounts.length, pinnedCounts.length);
    for (let index = 0; index < total; index++) {
        const mine = gotavernCounts[index];
        const theirs = pinnedCounts[index];
        if (!mine || !theirs) {
            return { equal: false, firstDifference: { index, note: `GoTavern made ${gotavernCounts.length} count calls, pinned made ${pinnedCounts.length}` } };
        }
        if (mine.count !== theirs.count) {
            return {
                equal: false,
                firstDifference: {
                    index,
                    pinnedCount: theirs.count,
                    gotavernCount: mine.count,
                    requestText: theirs.requestText ?? mine.requestText,
                    note: 'the same message counted differently by the two servers; the pinned count is the oracle',
                },
            };
        }
    }
    return { equal: true, firstDifference: null };
}

function legPreset(report) {
    const preset = report.preset ?? null;
    return {
        variant: preset?.variant ?? null,
        maxContext: preset?.maxContext ?? null,
        // WHAT THE LEG ACTUALLY RAN AT, recorded next to what it was asked for: a budget the frontend
        // replaced is then visible in the artefact instead of being indistinguishable from a correct
        // drive that happened to agree on both legs (run 40073821604 recorded two identical variants).
        maxContextApplied: preset?.maxContextApplied ?? null,
        maxContextUnlocked: preset?.maxContextUnlocked ?? null,
        chatTurns: preset?.chatTurns ?? null,
        typedMessage: preset?.typedMessage ?? null,
        problems: preset?.problems ?? [],
        steps: Array.isArray(preset?.steps) ? preset.steps.length : 0,
        settings: preset?.settings ?? null,
        tokenizerAnchor: preset?.tokenizerAnchor ?? null,
        // THE STATE THIS LEG STARTED ITS SEND FROM, read by the probe at the click: chat turns, outgoing
        // text, applied context and one dry assembly taken immediately before it.
        preSend: report.presetPreSend ?? null,
    };
}

export function compare({ gotavernKeep, pinnedKeep, gotavernDrop, pinnedDrop, fixture, inputs, boundaryFile = null }) {
    const scenario = fixture?.capture?.spec ?? null;
    let boundary = fixture?.capture?.boundary ?? {};
    // THE MEASURED PAIR COMES FROM THE PINNED LEG'S OWN DRIVES when a boundary file is supplied: the
    // same program, arguments and clean state as the compared leg, so the pair is reproducible by
    // construction. The fixture's numbers remain the capture's hint and are used only when no search ran.
    if (boundaryFile) {
        boundary = {
            ...boundary,
            keepContext: boundaryFile.keepContext,
            dropContext: boundaryFile.dropContext,
            keepMessages: boundaryFile.keep?.total ?? null,
            dropMessages: boundaryFile.drop?.total ?? null,
            keepHistoryMessages: boundaryFile.keep?.history ?? null,
            dropHistoryMessages: boundaryFile.drop?.history ?? null,
            measuredBy: boundaryFile.measuredBy ?? null,
            searchTable: Array.isArray(boundaryFile.search) ? boundaryFile.search : null,
            bracket: boundaryFile.bracket ?? null,
        };
    }
    const variants = {
        keep: { gotavern: gotavernKeep, pinned: pinnedKeep, context: boundary.keepContext, expectedMessages: boundary.keepMessages },
        drop: { gotavern: gotavernDrop, pinned: pinnedDrop, context: boundary.dropContext, expectedMessages: boundary.dropMessages },
    };

    const legs = {};
    const providerRequests = {};
    const bodyDifferences = {};
    const firstDifferences = {};
    const tokenizer = {};
    const keepDrop = {};
    const guards = {};

    for (const [variant, set] of Object.entries(variants)) {
        const govern = { label: 'gotavern', report: set.gotavern };
        const pinned = { label: 'pinned', report: set.pinned };
        const governBody = parseProviderBody(set.gotavern);
        const pinnedBody = parseProviderBody(set.pinned);
        const governSummary = summariseBody(set.gotavern);
        const pinnedSummary = summariseBody(set.pinned);
        const diff = messageDiff({ present: governSummary.present, body: governBody?.body ?? null }, { present: pinnedSummary.present, body: pinnedBody?.body ?? null });
        bodyDifferences[variant] = diff.differences;
        firstDifferences[variant] = diff.first;

        providerRequests[variant] = { gotavern: governSummary, pinned: pinnedSummary };
        legs[variant] = { gotavern: legPreset(set.gotavern), pinned: legPreset(set.pinned) };

        const oldest = boundary.oldestMarker ?? MARKERS.history;
        const governOldest = governBody ? findMessage(governBody.body, String(oldest).slice(0, 40)) : -1;
        const pinnedOldest = pinnedBody ? findMessage(pinnedBody.body, String(oldest).slice(0, 40)) : -1;
        // HOW MANY HISTORY TURNS SURVIVED, computed from the BODY rather than from the probe's claim:
        // this is the count the boundary is about. The TOTAL message count also moves when the frontend
        // drops its own example/world-info messages at a tight budget (run 40073802369: keep=15, drop=17),
        // so a total-count comparison is not a boundary assertion.
        const historyMarker = scenario?.markers?.history ?? MARKERS.history;
        const countHistory = body => (Array.isArray(body?.messages) ? body.messages.filter(message => messageText(message).includes(historyMarker)).length : null);
        keepDrop[variant] = {
            oldestMarker: String(oldest).slice(0, 40),
            gotavernPresent: governOldest >= 0,
            pinnedPresent: pinnedOldest >= 0,
            // RECORDED, NOT ASSERTED: the index of the oldest turn depends on the frontend's own layout
            // around the history block (its index moved from 6 to 10 between two contexts in the first
            // run, because example messages were added ahead of it). Presence and the history COUNT are
            // the assertions.
            gotavernOldestIndex: governOldest,
            pinnedOldestIndex: pinnedOldest,
            gotavernMessages: governSummary.messageCount,
            pinnedMessages: pinnedSummary.messageCount,
            gotavernHistoryMessages: countHistory(governBody?.body ?? null),
            pinnedHistoryMessages: countHistory(pinnedBody?.body ?? null),
        };

        const governCounts = tokenizerCounts(set.gotavern);
        const pinnedCounts = tokenizerCounts(set.pinned);
        tokenizer[variant] = {
            gotavernCalls: governCounts.length,
            pinnedCalls: pinnedCounts.length,
            gotavern: governCounts.map(entry => entry.count),
            pinned: pinnedCounts.map(entry => entry.count),
            ...compareTokenizers(governCounts, pinnedCounts),
        };
    }

    // ---- guards: is this differential FAITHFUL? ---------------------------------------------------
    //
    // THE MARKER CLAIM IS SPLIT ALONG WHAT THE FRONTEND ACTUALLY DOES, because one list could not be true.
    // The trimmer sheds the preset's OWN example (and world-info) entries as the budget tightens, before it
    // touches the oldest history turn: the measured search table shows 28 messages at 4382, 24 at
    // 4262/4260 and 26 at 4259, and the example block is gone by 4260 while the oldest turn survives until
    // 4259. So no context can hold BOTH the example and the boundary, and "every marker arrived" asked for
    // a state the frontend never produces.
    //
    //   boundaryMarkers      must be present at the measured boundary, on BOTH legs;
    //   budgetTrimmedMarkers must be present in the SCENARIO (the kit applied it) and ABSENT at the
    //                        boundary on BOTH legs -- absence observed, not assumed, and recorded with the
    //                        budget evidence beside it so "missing example" cannot be read as a harness
    //                        failure.
    const allMarkers = Object.entries(scenario?.markers ?? MARKERS).filter(([name]) => name !== 'userMarker');
    const TRIMMED = ['example'];
    const boundaryMarkers = allMarkers.filter(([name]) => !TRIMMED.includes(name));
    const budgetTrimmedMarkers = allMarkers.filter(([name]) => TRIMMED.includes(name));
    const hasMarker = (body, marker) => Boolean(body) && findMessage(body, marker) >= 0;
    for (const [variant, set] of Object.entries(variants)) {
        const pinnedBody = parseProviderBody(set.pinned)?.body ?? null;
        const governBody = parseProviderBody(set.gotavern)?.body ?? null;
        const missingPinned = boundaryMarkers.filter(([, marker]) => !hasMarker(pinnedBody, marker)).map(([name]) => name);
        const missingGotavern = boundaryMarkers.filter(([, marker]) => !hasMarker(governBody, marker)).map(([name]) => name);
        const trimmedStillPinned = budgetTrimmedMarkers.filter(([, marker]) => hasMarker(pinnedBody, marker)).map(([name]) => name);
        const trimmedStillGotavern = budgetTrimmedMarkers.filter(([, marker]) => hasMarker(governBody, marker)).map(([name]) => name);
        if (variant === 'keep') {            guards.bothLegsProducedAProviderRequest = Boolean(set.gotavern?.requestArrived && set.pinned?.requestArrived);
            guards.boundaryMarkersArrivedOnBothLegs = missingPinned.length === 0 && missingGotavern.length === 0;
            guards.missingBoundaryMarkers = missingPinned.length === 0 ? null : missingPinned;
            guards.budgetTrimmedMarkersAbsentOnBothLegs = trimmedStillPinned.length === 0 && trimmedStillGotavern.length === 0;
            guards.budgetTrimmedMarkersPresentInTheScenario = budgetTrimmedMarkers.every(([, marker]) => JSON.stringify(scenario ?? {}).includes(marker));
            guards.trimmedAtBoundary = {
                markers: budgetTrimmedMarkers.map(([name]) => name),
                stillPresentPinned: trimmedStillPinned,
                stillPresentGotavern: trimmedStillGotavern,
                measuredTotals: (boundary.searchTable ?? []).map(entry => ({ context: entry.context, total: entry.total, history: entry.history, oldestPresent: entry.oldestPresent })),
                why: 'the frontend sheds its own example and world-info prompt entries as the budget tightens, before the oldest history turn: the search table records 28 messages at the largest probed context, 24 at the boundary and 26 one token below, and the example is absent from every request at the boundary. Its absence is therefore an observed property of the pinned trimmer, not a missing kit step',
            };
            // The two per-leg guards now mean the split claim, per leg.
            guards.scenarioAppliedOnThePinnedLeg = guards.boundaryMarkersArrivedOnBothLegs && trimmedStillPinned.length === 0;
            guards.scenarioAppliedOnTheGotavernLeg = guards.boundaryMarkersArrivedOnBothLegs && trimmedStillGotavern.length === 0;
            guards.everyMarkerArrived = guards.boundaryMarkersArrivedOnBothLegs && guards.budgetTrimmedMarkersAbsentOnBothLegs;
            guards.stopStringsArrived = JSON.stringify(providerRequests.keep.pinned.stop) === JSON.stringify(scenario?.stops ?? null);
            guards.samplersArrived = providerRequests.keep.pinned.maxTokens === scenario?.maxTokens
                && providerRequests.keep.pinned.stream === false;
            guards.nonStreamingOnBothLegs = providerRequests.keep.pinned.stream === false && providerRequests.keep.gotavern.stream === false;
            guards.presetAppliedOnBothLegs = (legs.keep.gotavern.problems ?? []).length === 0 && (legs.keep.pinned.problems ?? []).length === 0;
            // EACH VARIANT MUST HAVE RUN AT THE CONTEXT THE CAPTURE MEASURED FOR IT. Without this the
            // differential can compare two runs of the SAME budget and report agreement: run 40073821604
            // recorded keep and drop as identical (26 messages, 11 history turns, oldest absent on both),
            // which the boundary guards below caught but could not name. The value is read back from the
            // leg after the drive set it, so a frontend clamp is a named failure here.
            guards.keepVariantRanAtTheCapturedContext =
                legs.keep.gotavern.maxContextApplied === variants.keep.context
                && legs.keep.pinned.maxContextApplied === variants.keep.context;
            guards.dropVariantRanAtTheCapturedContext =
                legs.drop.gotavern.maxContextApplied === variants.drop.context
                && legs.drop.pinned.maxContextApplied === variants.drop.context;
            guards.variantsUsedDifferentContexts = variants.keep.context !== variants.drop.context;
            // THE VARIANT MUST START FROM THE STATE THE CAPTURE MEASURED. Run 40087218275 assembled 26
            // messages in the drive at max_context 4253, where the capture's own send assembled 24 with
            // 12 history turns: same server, same context, different state at send time. The capture gives
            // every probe a fresh page and records the chat it sent from; each leg records the same
            // values at its click, and a mismatch is REFUSED by name here rather than being reported as a
            // boundary difference. `preSend.dryAssembly` is recorded alongside so the next reader can tell
            // "the page's state had already grown" from "the send path added messages".
            const expectedPreSend = boundary.preSend ?? null;
            const preSendMatches = leg => Boolean(expectedPreSend) && Boolean(leg.preSend)
                && leg.preSend.chatTurns === expectedPreSend.chatTurns
                && String(leg.preSend.outgoingText ?? '') === String(expectedPreSend.outgoingText ?? '');
            guards.variantStartedFromTheCapturedState = preSendMatches(legs.keep.gotavern)
                && preSendMatches(legs.keep.pinned)
                && preSendMatches(legs.drop.gotavern)
                && preSendMatches(legs.drop.pinned);
            guards.preSendState = {
                expected: expectedPreSend,
                keepGotavern: legs.keep.gotavern.preSend,
                keepPinned: legs.keep.pinned.preSend,
                dropGotavern: legs.drop.gotavern.preSend,
                dropPinned: legs.drop.pinned.preSend,
            };
            // THE PAIR MUST SAY WHICH ASSEMBLY IT BELONGS TO, AND THE DRIVE IS WHAT PROVES IT BINDS.
            //
            // History: run 40082539457 drove a pair bisected on a DRY assembly and BOTH variants produced
            // the drop shape on BOTH legs, because a dry assembly costs a few tokens less than the send it
            // predicts; the capture then bisected by SENDING, and run 40087218275 showed even that could
            // disagree with the drive at the same context (capture 24/12, drive 26/11). The capture now
            // measures the pair on the PRE-SEND assembly -- the same `Generate(..., true)` pass the drive
            // uses to record `preSend` -- and records the state each variant must start from. What keeps a
            // wrong pair from passing is no longer the capture's method but the guards below: the pair must
            // BIND (oldest turn present at keep, absent at drop, exactly one history message apart) and the
            // drive must START FROM THE CAPTURED STATE (`variantStartedFromTheCapturedState`). A pair that
            // does not bind is refused by name, whichever way it was measured.
            guards.boundaryDeclaresItsAssembly = ['pre-send-assembly', 'real-send'].includes(boundary.assemblyMode ?? null);
            // AND IT MUST HAVE BEEN MEASURED BY THE LEG THAT PRODUCES THE COMPARED REQUEST. Seven runs
            // measured a merely similar procedure; when a search file is supplied its table is the pair and
            // this guard says so.
            guards.boundaryMeasuredByThePinnedLegItself = (boundary.measuredBy ?? null) === 'pinned-leg';
            // THE BOUNDARY BINDS: this is the property that makes the pair a measurement. If the pinned
            // trimmer does not keep at `keepContext`, the capture's bisect and the drive disagree and the
            // scenario proves nothing, so the differential refuses instead of passing vacuously.
            guards.boundaryBindsOnThePinnedLeg = keepDrop.keep.pinnedPresent === true && keepDrop.drop.pinnedPresent === false;
            // THE COUNT THAT IS THE BOUNDARY: exactly one MORE HISTORY TURN is retained at keep than at
            // drop, on both legs. This replaces any assertion on the TOTAL message count, which is not
            // monotone in openai_max_context: the frontend emits its own example and world-info messages
            // as the budget allows, independently of the trimmer. Measured at the boundary this lane
            // recorded: 26 total messages holding 11 history turns one token below keep, and 24 total
            // messages holding 12 history turns at keep. A total-count assertion therefore rejects real
            // boundaries -- it did, twice. The totals stay recorded (see `keepDrop`) so a reader who sees
            // them differ finds the reason here instead of re-deriving it.
            guards.boundaryRetainsExactlyOneMoreTurnOnThePinnedLeg = keepDrop.keep.pinnedHistoryMessages === keepDrop.drop.pinnedHistoryMessages + 1;
            guards.boundaryRetainsExactlyOneMoreTurnOnTheGotavernLeg = keepDrop.keep.gotavernHistoryMessages === keepDrop.drop.gotavernHistoryMessages + 1;
            // CONSISTENCY WITH THE CAPTURE, not monotonicity: the drive must have assembled the same two
            // lists the boundary was measured on. Both totals and both history counts have to match the
            // fixture, whatever their values are.
            guards.boundaryMatchesTheCapture = keepDrop.keep.pinnedMessages === variants.keep.expectedMessages
                && keepDrop.drop.pinnedMessages === variants.drop.expectedMessages
                && keepDrop.keep.pinnedHistoryMessages === (boundary.keepHistoryMessages ?? keepDrop.keep.pinnedHistoryMessages)
                && keepDrop.drop.pinnedHistoryMessages === (boundary.dropHistoryMessages ?? keepDrop.drop.pinnedHistoryMessages);
            // THE TOKENIZER MUST BE REAL. `resolved` is a filesystem observation made by the probe; the
            // anchor is the pinned count of a fixed body (tests/oracle/sillytavern-1.19.0-tokenizers.json,
            // openai/count#llama#simple = 7). A server on the Guesstimate path answers something else and
            // the whole boundary is meaningless, so this refuses rather than compares.
            const root = set.gotavern?.tokenizerRoot ?? null;
            guards.tokenizerTreeResolvedOnTheGotavernLeg = Boolean(root?.resolved);
            guards.tokenizerTreeResolvedOnThePinnedLeg = Boolean(set.pinned?.tokenizerRoot?.resolved);
            const expectedAnchor = fixture?.capture?.tokenizerAnchor?.pinnedCount ?? null;
            guards.tokenizerAnchorExactOnBothLegs = legs.keep.gotavern.tokenizerAnchor?.count === expectedAnchor
                && legs.keep.pinned.tokenizerAnchor?.count === expectedAnchor
                && legs.drop.gotavern.tokenizerAnchor?.count === expectedAnchor
                && legs.drop.pinned.tokenizerAnchor?.count === expectedAnchor;
            guards.tokenizerTree = {
                gotavern: root?.resolved ?? null,
                pinned: set.pinned?.tokenizerRoot?.resolved ?? null,
                anchorExpected: expectedAnchor,
                anchors: {
                    keepGotavern: legs.keep.gotavern.tokenizerAnchor?.count ?? null,
                    keepPinned: legs.keep.pinned.tokenizerAnchor?.count ?? null,
                    dropGotavern: legs.drop.gotavern.tokenizerAnchor?.count ?? null,
                    dropPinned: legs.drop.pinned.tokenizerAnchor?.count ?? null,
                },
            };
        }
        // The DROP variant must carry every OTHER marker too: if it lost the world info or the author's
        // note as well as the oldest turn, its body would differ for a reason that is not the boundary.
        const dropPinnedBody = variant === 'drop' ? parseProviderBody(variants.drop.pinned)?.body ?? null : null;
        const dropGotavernBody = variant === 'drop' ? parseProviderBody(variants.drop.gotavern)?.body ?? null : null;
        if (variant === 'drop') {
            guards.dropVariantCarriesEveryOtherMarker = boundaryMarkers.every(([, marker]) => dropPinnedBody && findMessage(dropPinnedBody, marker) >= 0)
                && boundaryMarkers.every(([, marker]) => dropGotavernBody && findMessage(dropGotavernBody, marker) >= 0);
        }
    }

    const providerRequestEqual = ['keep', 'drop'].every(variant => {
        const pair = providerRequests[variant];
        return pair.gotavern.bodySha256 !== null
            && pair.gotavern.bodySha256 === pair.pinned.bodySha256
            && pair.gotavern.bodyLength === pair.pinned.bodyLength;
    });

    const artifact = {
        schemaVersion: 1,
        surface: 'preset',
        question: 'does the SAME complex preset, at the measured context boundary, produce byte-identical provider requests on both servers?',
        scenario: {
            name: scenario?.name ?? null,
            markers: scenario?.markers ?? MARKERS,
            samplers: scenario?.samplers ?? null,
            stops: scenario?.stops ?? null,
            maxTokens: scenario?.maxTokens ?? null,
            namesBehavior: scenario?.namesBehavior ?? null,
            authorsNote: scenario?.authorsNote ?? null,
            world: scenario?.world ?? null,
            historyTurns: Array.isArray(scenario?.history) ? scenario.history.length : null,
            typedMessage: scenario?.send ?? null,
        },
        boundary: {
            keepContext: boundary.keepContext ?? null,
            measuredBy: boundary.measuredBy ?? null,
            // EVERY CANDIDATE THE SEARCH DROVE, with its numbers: (max_context/total/history/oldestPresent).
            searchTable: boundary.searchTable ?? null,
            dropContext: boundary.dropContext ?? null,
            keepMessages: boundary.keepMessages ?? null,
            dropMessages: boundary.dropMessages ?? null,
            keepHistoryMessages: boundary.keepHistoryMessages ?? null,
            dropHistoryMessages: boundary.dropHistoryMessages ?? null,
            assemblyMode: boundary.assemblyMode ?? null,
            dryPreScanFlip: boundary.dryPreScanFlip ?? null,
            // THE STATE EACH VARIANT WAS REQUIRED TO START FROM (recorded by the capture) and the state
            // each leg reported at its click (in `legs.*.preSend`).
            preSend: boundary.preSend ?? null,
            bracket: boundary.bracket ?? null,
            // THE CONTRACT TRAVELS WITH THE NUMBERS. Carried verbatim from the capture, which wrote the
            // reason the two TOTALS differ beside their values (the frontend's own example/world-info
            // messages are emitted as the budget allows, so the total is not monotone and is not asserted).
            contract: boundary.contract ?? null,
            method: 'capture-preset.mjs bisects openai_max_context with the pinned frontend dry assembly; the predicate is "the oldest history marker is in the assembled messages"',
        },
        inputs,
        legs,
        providerRequests,
        keepDrop,
        tokenizer,
        // AN OBSERVATION, NOT A GUARD. A count difference is the product finding this lane exists to
        // surface, so it must not be reported as harness unfaithfulness (doctrine 5). The body comparison
        // is the verdict; this says where to look first when the verdict is a mismatch.
        tokenizerCountsAgree: tokenizer.keep.equal && tokenizer.drop.equal,
        bodyDifferences,
        firstDifferences,
        providerRequestEqual,
        guards,
        verdict: providerRequestEqual ? 'match' : 'mismatch',
    };

    // RULE 18: a committed artefact must not carry a host-derived value. The sweep above is the same
    // one the verifier runs, applied here so a comparator that leaks a path fails its own run.
    const text = JSON.stringify(artifact);
    const leaked = FORBIDDEN.filter(pattern => pattern.test(text)).map(pattern => String(pattern));
    artifact.guards.noHostDerivedValue = leaked.length === 0;
    if (leaked.length > 0) {
        artifact.guards.hostDerivedPatterns = leaked;
    }
    return artifact;
}

const main = () => {
    const args = process.argv.slice(2);
    const fixtureIndex = args.indexOf('--fixture');
    const boundaryIndex = args.indexOf('--boundary');
    const boundaryPath = boundaryIndex >= 0 ? path.resolve(args[boundaryIndex + 1]) : null;
    const files = args.filter((value, index) => !value.startsWith('--') && !(fixtureIndex >= 0 && index === fixtureIndex + 1) && !(boundaryIndex >= 0 && index === boundaryIndex + 1));
    if (files.length !== 4) {
        console.error('usage: node compare-preset-legs.mjs <keep-gotavern.json> <keep-pinned.json> <drop-gotavern.json> <drop-pinned.json> [--fixture <path>]');
        process.exit(2);
    }
    const fixturePath = fixtureIndex >= 0 ? path.resolve(args[fixtureIndex + 1]) : PRESET_FIXTURE;
    const fixture = readJSON(fixturePath);
    if (!boundaryPath) {
        console.error('compare-preset-legs needs --boundary <preset-boundary.json>: the pair must be measured by the pinned leg itself (preset-boundary-search.mjs), not inferred from the capture');
        process.exit(2);
    }
    const inputNames = Object.fromEntries(['gotavernKeep', 'pinnedKeep', 'gotavernDrop', 'pinnedDrop'].map((name, index) => [name, path.basename(files[index])]));
    const artifact = compare({
        gotavernKeep: readJSON(files[0]),
        pinnedKeep: readJSON(files[1]),
        gotavernDrop: readJSON(files[2]),
        pinnedDrop: readJSON(files[3]),
        fixture,
        boundaryFile: boundaryPath ? readJSON(boundaryPath) : null,
        inputs: inputNames,
    });
    console.log(JSON.stringify(artifact, null, 2));

    const failed = Object.entries(artifact.guards).filter(([, value]) => value === false).map(([name]) => name);
    if (failed.length > 0) {
        console.error(`unfaithful preset differential, ${failed.length} guard(s) failed: ${failed.join(', ')}`);
        if (failed.includes('variantStartedFromTheCapturedState')) {
            // NAME THE DIVERGENCE, not just the guard. This is the case where a leg measured a page state
            // the capture never measured, so every boundary difference below it is unattributable.
            const expected = artifact.boundary?.preSend ?? null;
            const observed = artifact.guards?.preSendState ?? null;
            for (const [where, leg] of Object.entries(observed ?? {})) {
                if (where === 'expected' || !leg) continue;
                if (leg.chatTurns !== expected?.chatTurns) {
                    console.error(`  ${where} started from ${leg.chatTurns} chat turns but the capture measured ${expected?.chatTurns}, so this leg did not run the boundary that was measured`);
                }
                if (String(leg.outgoingText ?? '') !== String(expected?.outgoingText ?? '')) {
                    console.error(`  ${where} typed ${JSON.stringify(String(leg.outgoingText ?? ''))} but the capture typed ${JSON.stringify(String(expected?.outgoingText ?? ''))}`);
                }
            }
        }
        console.error(JSON.stringify({ guards: artifact.guards, firstDifferences: artifact.firstDifferences, keepDrop: artifact.keepDrop }, null, 2));
        process.exit(1);
    }
    if (!artifact.providerRequestEqual) {
        console.error('the complex preset did NOT produce equal provider requests: this is the differential\'s finding');
        console.error(JSON.stringify({ firstDifferences: artifact.firstDifferences, tokenizer: artifact.tokenizer, keepDrop: artifact.keepDrop }, null, 2));
        process.exit(1);
    }
    console.error(`preset differential equal: ${artifact.providerRequests.keep.pinned.bodyLength} B keep / ${artifact.providerRequests.drop.pinned.bodyLength} B drop, ${artifact.keepDrop.keep.pinnedMessages} vs ${artifact.keepDrop.drop.pinnedMessages} messages`);
};

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
    main();
}
