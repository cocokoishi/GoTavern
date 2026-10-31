// WHOLE-SESSION COMPARATOR — four artefacts, three fact classes, one verdict.
//
// WHAT IT JUDGES. Four legs come in: a `drive` leg and a `restart` leg for each subject. The drive leg performed the
// whole user journey in one runtime and one browsing context; the restart leg is a NEW process over the SAME tree that
// had to read the state the drive leg left. Together they are the session `docs/compatibility-matrix.json`'s
// `whole-session-e2e` row has always required, and this program is the only thing that turns them into a verdict.
//
// THREE KINDS OF GUARD, and the third is the one that keeps the other two honest:
//   1. EQUALITY between the two subjects, per fact class (browser observable, provider wire, disk state). Byte-oriented
//      on the wire — method, raw target, byteLength and sha256 of the raw body — because canonicalising two different
//      requests into one comparable shape is how "both equally wrong" reads as parity.
//   2. ABSOLUTE facts, read from ONE leg and never from the pair: the journey produced at least five completions, the
//      disk holds at least five messages, the setting the user chose is the value on disk, every completion was served
//      as SSE because every one asked to stream. WITHOUT THESE, A MUTATION APPLIED TO BOTH SUBJECTS IS INVISIBLE:
//      a comparator that only compares two artefacts reports `match` when both of them lost the same message, which is
//      exactly the shape of the defect this surface exists to catch (a reply that is never saved, on both backends,
//      is still a broken product).
//   3. FAITHFULNESS, which refuses a leg that did not really run: a leg with a `failure`, a leg whose steps went red,
//      two legs of the same subject, a "restart" whose pid equals the drive's (that is a re-read, not a restart), and
//      the rule-50 discriminator check that the two subjects' artefacts ACTUALLY DIFFER where they are supposed to.
//
// THE DISCRIMINATOR. Both subjects are fed byte-identical user turns, so a comparator can prove nothing about its own
// ability to tell them apart unless something differs by construction. Each leg stamps a per-subject prefix into the
// first turn's reply, which the swipe then pushes into `swipes[]`; so each leg's disk must hold ITS OWN prefix, must
// not hold the other's, and no compared provider body may contain either (the swipe and every later request carry the
// unprefixed replacement). Those three facts are `artefacts-differ-per-subject`.
//
// EXIT CODES: 0 = match, 1 = mismatch (a named guard failed), 2 = REFUSAL (an input is missing or unusable). A refusal
// is deliberately not a pass: an absent leg report is the absence of evidence, and this project has twice shipped a
// green run whose judge had nothing to read.
//
// `compare()` IS EXPORTED, and the teeth proof (`whole-session-gate-selftest.mjs`) imports it rather than
// reimplementing the rules. A selftest that re-derives the comparator's logic tests its own copy: the two drift, and
// the drift hides in whichever of the two nobody re-reads.

import fs from 'node:fs/promises';

// ----------------------------------------------------------------------------------------------------------------
// SMALL HELPERS. No canonicalisation beyond the one field path the discriminator requires.
// ----------------------------------------------------------------------------------------------------------------

const PATTERN = /WS_REPLY_\d+/;

const sameJson = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const count = value => (Array.isArray(value) ? value.length : -1);
const stepsAllOk = leg => Boolean(leg) && Array.isArray(leg.steps) && leg.steps.length > 0 && leg.steps.every(entry => entry.ok === true);
const failedSteps = leg => (leg?.steps ?? []).filter(entry => entry.ok !== true).map(entry => entry.name);
const finalChat = leg => leg?.disk?.final?.chat ?? null;
const finalState = leg => leg?.browser?.final ?? null;
const restartState = leg => leg?.browser?.reopened ?? null;

// ----------------------------------------------------------------------------------------------------------------
// THE RESUMED TURN'S ATTRIBUTION AND ITS PROMPT-ORDER CLASSIFICATION.
//
// THE OPEN ITEM THIS CLOSES. A manual run over a private tree recorded the post-restart resumed turn's request as a
// single-system-message request with no restored history, and the probe at the time selected `completions().at(-1)` --
// "the last completion when I looked", not "the completion my send produced". The probe now arms the peer ordinal
// immediately before the click and records the request at that ordinal; these guards judge THAT request, require the
// classification to be derivable from the frontend's own prompt order, and require byte equality with pinned.
//
// THE CLASSIFICATION RULE IS PINNED'S, NOT THIS FILE'S TASTE. `populateChatHistory` returns immediately when the
// prompt collection has no `chatHistory` (`public/scripts/openai.js:885-888`), and the collection is built by walking
// the prompt-order row for the active character (`PromptManager.js:1516-1541`). Under the global prompt-order strategy
// the active character is `{ id: dummyId }` with dummyId 100001 (`openai.js:696-699`; `PromptManager.js:438,1131`).
// So the runtime row is the one whose `character_id` is 100001, and whether it ENABLES chatHistory is exactly whether
// the request must carry history. The rule is recomputed here from the leg's recorded observation: the probe's own
// verdict is an observation, never the judge.
const resumedRequest = leg => leg?.browser?.resumedTurn?.request ?? null;
const resumedArmedOrdinal = leg => Number(leg?.browser?.resumedTurn?.armedOrdinal ?? -1);
const promptObservation = leg => leg?.promptOrder?.restart ?? null;
const promptClassification = leg => leg?.promptOrder?.restartClassification ?? null;

function classifyPromptOrder(observation) {
    if (!observation || observation.chatHistoryEntry === null || observation.chatHistoryEntry === undefined) {
        return { historyExpected: null, reason: 'prompt-order-observation-missing' };
    }
    const entry = observation.chatHistoryEntry;
    if (entry.present !== true) return { historyExpected: false, reason: 'prompt-order-row-omits-chatHistory' };
    if (entry.enabled !== true) return { historyExpected: false, reason: 'prompt-order-row-disables-chatHistory' };
    return { historyExpected: true, reason: 'prompt-order-row-enables-chatHistory' };
}

/** The peers' completion list, and the one request a leg's send produced (by ordinal). */
const completionAtOrdinal = (leg, ordinal) => (leg?.wire?.completions ?? [])[Number(ordinal) - 1] ?? null;
const restartOrdinal = leg => resumedArmedOrdinal(leg);
const restartRequestAtOrdinal = leg => completionAtOrdinal(leg, restartOrdinal(leg));

/** The request a helper-style quiet completion produced, if this leg injected one. */
const helperObservation = leg => leg?.helperRequest ?? null;
const helperRequest = leg => (helperObservation(leg)?.injected === true ? helperObservation(leg)?.request ?? null : null);

/**
 * The prefix a leg stamped, recovered from its own artefact rather than passed in: `replyPrefix` is what the workflow
 * gave it, and `discriminator.stampedText` is what actually reached the page. A leg that reports a prefix it never
 * applied is caught by its own `discriminator-applied-to-the-swipeable-reply` step before this program matters.
 */
const prefixOf = leg => String(leg?.replyPrefix ?? '');

/**
 * Every provider body a comparison looks at. The discriminator must appear in NONE of them; if it does, the prefix is
 * inside a compared request and every equality guard is comparing a value the harness made differ.
 */
function providerBodies(leg) {
    const bodies = (leg?.wire?.completions ?? []).map(entry => String(entry.body ?? ''));
    const resumed = leg?.browser?.resumedTurn?.request?.body;
    if (typeof resumed === 'string') bodies.push(resumed);
    return bodies;
}

// ----------------------------------------------------------------------------------------------------------------
// THE COMPARISON.
// ----------------------------------------------------------------------------------------------------------------

/**
 * @param {{goDrive: object, pinnedDrive: object, goRestart: object, pinnedRestart: object}} legs
 * @returns {{surface: string, verdict: string, guards: object, failedGuards: string[], subjects: object}}
 */
export function compare(legs) {
    const { goDrive, pinnedDrive, goRestart, pinnedRestart } = legs;
    const guards = {};
    const guard = (name, ok, detail) => {
        guards[name] = { ok: ok === true, detail: detail ?? null };
    };
    const subjects = [goDrive, pinnedDrive];

    // ---- 3. FAITHFULNESS -------------------------------------------------------------------------------------
    guard('both-drive-legs-recorded',
        stepsAllOk(goDrive) && stepsAllOk(pinnedDrive), {
            gotovern: { failure: goDrive?.failure ?? null, failedSteps: failedSteps(goDrive), steps: count(goDrive?.steps) },
            pinned: { failure: pinnedDrive?.failure ?? null, failedSteps: failedSteps(pinnedDrive), steps: count(pinnedDrive?.steps) },
        });
    guard('both-restart-legs-recorded',
        stepsAllOk(goRestart) && stepsAllOk(pinnedRestart), {
            gotovern: { failure: goRestart?.failure ?? null, failedSteps: failedSteps(goRestart), steps: count(goRestart?.steps) },
            pinned: { failure: pinnedRestart?.failure ?? null, failedSteps: failedSteps(pinnedRestart), steps: count(pinnedRestart?.steps) },
        });
    guard('legs-are-the-subjects-they-claim',
        goDrive?.subject === 'gotavern' && pinnedDrive?.subject === 'pinned'
        && goRestart?.subject === 'gotavern' && pinnedRestart?.subject === 'pinned',
        { drive: [goDrive?.subject ?? null, pinnedDrive?.subject ?? null], restart: [goRestart?.subject ?? null, pinnedRestart?.subject ?? null] });
    // A RESTART IS A NEW PROCESS. A "restart" leg that reused the drive leg's process would make every persistence
    // assertion a read of the same process's memory, which is the one thing this phase exists to rule out.
    const restartedIsNew = subject => {
        const before = subject === 'gotavern' ? goDrive?.server?.pid : pinnedDrive?.server?.pid;
        const after = subject === 'gotavern' ? goRestart?.server?.pid : pinnedRestart?.server?.pid;
        return typeof before === 'number' && typeof after === 'number' && before !== after;
    };
    guard('restart-is-a-new-process',
        restartedIsNew('gotavern') && restartedIsNew('pinned'),
        { gotavern: [goDrive?.server?.pid ?? null, goRestart?.server?.pid ?? null], pinned: [pinnedDrive?.server?.pid ?? null, pinnedRestart?.server?.pid ?? null] });
    // THE RULE-50 CHECK: the two subjects' artefacts must DIFFER in the one place the harness put a difference, and
    // no compared provider body may carry it. Without this, "equal requests" can mean "the fixture made them equal".
    const discriminator = subject => {
        const drive = subject === 'gotavern' ? goDrive : pinnedDrive;
        const other = subject === 'gotavern' ? pinnedDrive : goDrive;
        const mine = prefixOf(drive);
        const theirs = prefixOf(other);
        const swipesOf = leg => (finalChat(leg)?.messages ?? []).flatMap(message => message.rawSwipes ?? []).map(String);
        const mySwipes = swipesOf(drive);
        const theirSwipes = swipesOf(other);
        const inProviderBodies = mine === '' ? false : providerBodies(drive).some(body => body.includes(mine));
        return {
            prefix: mine,
            otherPrefix: theirs,
            appliedOnThePage: drive?.discriminator?.appliedOnThePage === true,
            presentInOwnDiskSwipes: mine !== '' && mySwipes.some(text => text.includes(mine)),
            absentFromOtherDiskSwipes: mine !== '' && !theirSwipes.some(text => text.includes(mine)),
            absentFromEveryComparedProviderBody: !inProviderBodies,
        };
    };
    const discriminators = { gotavern: discriminator('gotavern'), pinned: discriminator('pinned') };
    guard('artefacts-differ-per-subject',
        discriminators.gotavern.prefix !== '' && discriminators.pinned.prefix !== ''
        && discriminators.gotavern.prefix !== discriminators.pinned.prefix
        && discriminators.gotavern.presentInOwnDiskSwipes && discriminators.gotavern.absentFromOtherDiskSwipes
        && discriminators.gotavern.absentFromEveryComparedProviderBody
        && discriminators.pinned.presentInOwnDiskSwipes && discriminators.pinned.absentFromOtherDiskSwipes
        && discriminators.pinned.absentFromEveryComparedProviderBody,
        discriminators);

    // ---- 2. ABSOLUTE FACTS (the anti-symmetric-mutation layer) ------------------------------------------------
    guard('wire-journey-is-complete',
        Number(goDrive?.wire?.count ?? 0) >= 5 && Number(pinnedDrive?.wire?.count ?? 0) >= 5,
        { gotavern: goDrive?.wire?.count ?? null, pinned: pinnedDrive?.wire?.count ?? null, minimum: 5 });
    guard('disk-journey-is-complete',
        Number(finalChat(goDrive)?.messageCount ?? 0) >= 5 && Number(finalChat(pinnedDrive)?.messageCount ?? 0) >= 5,
        { gotavern: finalChat(goDrive)?.messageCount ?? null, pinned: finalChat(pinnedDrive)?.messageCount ?? null, minimum: 5 });
    guard('sequence-holds-both-user-turns',
        subjects.every(leg => {
            const sequence = finalState(leg)?.sequence ?? [];
            const markers = Object.values(leg?.markers ?? {});
            return sequence.some(entry => entry.text.includes(leg?.markers?.turn1 ?? 'WS_TURN_ONE_MARKER'))
                && sequence.some(entry => entry.text.includes(leg?.markers?.turn2 ?? 'WS_TURN_TWO_MARKER'))
                && markers.length === 3;
        }),
        subjects.map(leg => (finalState(leg)?.sequence ?? []).map(entry => `${entry.role}:${entry.text.slice(0, 24)}`)));
    // THE SETTING, READ FROM DISK AND FROM THE PAGE. `finalChat(leg).settings` is the DISK reading the probe attached to
    // the chat view; `disk.settings` is the earlier one. Both are accepted because the probe records both, and the
    // guard's job is the VALUE, not the path it arrived by.
    const settingsTemperature = leg => Number(leg?.disk?.final?.settings?.temperature ?? leg?.disk?.settings?.temperature ?? NaN);
    guard('settings-value-is-the-requested-value',
        subjects.every(leg => settingsTemperature(leg) === Number(leg?.temperatureRequested))
        && subjects.every(leg => Number.isFinite(settingsTemperature(leg))),
        subjects.map(leg => ({ requested: leg?.temperatureRequested ?? null, disk: settingsTemperature(leg), path: leg?.disk?.final?.settings?.temperaturePath ?? null })));
    guard('every-completion-asked-for-a-stream',
        subjects.every(leg => (leg?.wire?.completions ?? []).length > 0
            && (leg.wire.completions ?? []).every(entry => entry.requestedStream === true)),
        subjects.map(leg => (leg?.wire?.completions ?? []).map(entry => entry.requestedStream)));
    guard('every-completion-was-served-as-sse',
        subjects.every(leg => (leg?.wire?.completions ?? []).length > 0
            && (leg.wire.completions ?? []).every(entry => entry.served?.wire === 'sse' && entry.served?.terminal === true)),
        subjects.map(leg => (leg?.wire?.completions ?? []).map(entry => entry.served?.wire ?? null)));
    // REGENERATE MUST NOT CARRY THE REPLY IT REPLACED (pinned deletes the last assistant message before assembling the
    // prompt, public/script.js:4399-4406). Checked per leg, because it is a product assertion about each subject and
    // not an equality between them: two subjects that both leaked the replaced reply would compare equal and be wrong.
    guard('regenerate-request-excludes-the-replaced-reply',
        subjects.every(leg => {
            const request = leg?.browser?.regenerate?.request;
            return request !== null && request !== undefined
                && Number(request.replacedTextLength) > 0 && request.carriesReplacedText === false;
        }),
        subjects.map(leg => leg?.browser?.regenerate?.request ?? null));
    guard('regenerate-request-ordinal-equal',
        Number(goDrive?.browser?.regenerate?.request?.index ?? -1) === Number(pinnedDrive?.browser?.regenerate?.request?.index ?? -2),
        { gotavern: goDrive?.browser?.regenerate?.request?.index ?? null, pinned: pinnedDrive?.browser?.regenerate?.request?.index ?? null });
    guard('continue-request-ordinal-equal',
        Number(goDrive?.browser?.continue?.request?.index ?? -1) === Number(pinnedDrive?.browser?.continue?.request?.index ?? -2),
        { gotavern: goDrive?.browser?.continue?.request?.index ?? null, pinned: pinnedDrive?.browser?.continue?.request?.index ?? null });
    // ---- THE RESUMED TURN: ATTRIBUTION, CLASSIFICATION, AND THE TWO ASSERTIONS IT SPLITS INTO -----------------
    //
    // ONE GUARD, TWO ARMS, AND THE ARM IS DERIVED FROM THE LEG'S OWN RECORDED PROMPT ORDER -- never passed in as a
    // journey label, which would let the harness decide the answer. A required-history leg that dropped history and an
    // omission leg that carried it are both red, by name; neither can be a silent pass.
    const resumedLegs = [goRestart, pinnedRestart];
    const resumedAttribution = leg => {
        const requested = resumedRequest(leg);
        const atOrdinal = restartRequestAtOrdinal(leg);
        return {
            armedOrdinal: resumedArmedOrdinal(leg),
            requestOrdinal: Number(requested?.ordinal ?? -1),
            requestFoundAtOrdinal: atOrdinal !== null,
            shaMatchesTheRequestAtThatOrdinal: requested !== null && atOrdinal !== null && requested.bodySha256 === atOrdinal.sha256,
            clicked: leg?.browser?.resumedTurn?.sent?.clicked === true,
            settled: leg?.browser?.resumedTurn?.settled?.ok === true,
            peerCompletionsAfterTheSettle: Number(leg?.browser?.resumedTurn?.peerCompletionsAfterTheClick ?? 0),
            promptClassification: promptClassification(leg),
            observation: promptObservation(leg),
            recomputedClassification: classifyPromptOrder(promptObservation(leg)),
        };
    };
    const attributions = { gotavern: resumedAttribution(goRestart), pinned: resumedAttribution(pinnedRestart) };
    // 1. IS THE REQUEST THE SEND'S? The ordinal was armed from the peer's count immediately before the click, so the
    // request at that ordinal is the one the click produced. A later helper/title request cannot satisfy this guard.
    guard('resumed-request-attributed-to-the-send',
        resumedLegs.every(leg => {
            const requested = resumedRequest(leg);
            const atOrdinal = restartRequestAtOrdinal(leg);
            return leg?.browser?.resumedTurn?.sent?.clicked === true
                && leg?.browser?.resumedTurn?.settled?.ok === true
                && requested !== null && atOrdinal !== null
                && Number(requested.ordinal) === resumedArmedOrdinal(leg)
                && requested.bodySha256 === atOrdinal.sha256;
        }),
        attributions);
    // 2. THE CLASSIFICATION MUST FOLLOW FROM THE OBSERVED PROMPT ORDER, not merely be asserted by the leg: the
    // classification recorded beside the request must equal the rule's answer for this leg's own observation.
    guard('resumed-classification-follows-the-prompt-order',
        resumedLegs.every(leg => {
            const recorded = promptClassification(leg);
            const recomputed = classifyPromptOrder(promptObservation(leg));
            return recorded !== null && recorded.historyExpected !== null
                && recorded.historyExpected === recomputed.historyExpected
                && recorded.reason === recomputed.reason;
        }),
        Object.fromEntries(Object.entries(attributions).map(([subject, entry]) => [subject, { recorded: entry.promptClassification, recomputed: entry.recomputedClassification, observation: entry.observation ?? null }])));
    // 3. THE GUARD THE OPEN ITEM IS ABOUT. Where the structure requires history, the request at the send's ordinal MUST
    // carry it -- both user turns, every restored reply, and the typed resumed turn itself. Where the structure omits
    // it, the SAME guard requires the absence of the RESTORED HISTORY plus the structural reason, so a missing marker
    // can never pass by being absent. MEASURED on the derived control: the typed user turn can still reach the model
    // through another enabled preset prompt, so `carriesResumedUserMarker` is recorded but not asserted in this arm;
    // what the omission removes is the restored conversation. Byte equality with pinned is guard `restart-completion-equal`,
    // which applies to both arms.
    guard('restart-turn-carried-the-restored-history',
        resumedLegs.every(leg => {
            const request = resumedRequest(leg);
            const classification = promptClassification(leg);
            if (request === null || classification === null || classification.historyExpected === null) return false;
            if (classification.historyExpected === true) {
                return request.carriesFirstTurnMarker === true
                    && request.carriesSecondTurnMarker === true
                    && request.carriesRestoredReplies === true
                    && request.carriesResumedUserMarker === true;
            }
            return request.carriesFirstTurnMarker === false
                && request.carriesSecondTurnMarker === false
                && request.carriesRestoredReplies === false
                && (classification.reason === 'prompt-order-row-omits-chatHistory'
                    || classification.reason === 'prompt-order-row-disables-chatHistory');
        }),
        resumedLegs.map(leg => ({ classification: promptClassification(leg), request: resumedRequest(leg) })));
    // 4. THE OMISSION HAS TO BE THE PRESET'S, NOT THE PRODUCT'S. This guard is red for an omission leg whose recorded
    // prompt order does NOT explain the omission (a row that ENABLES chatHistory), and for an omission leg whose
    // request nonetheless carries restored history. It is the "never a silent pass" half of the classification taxonomy.
    guard('restart-history-omission-is-preset-attributable',
        resumedLegs.every(leg => {
            const classification = promptClassification(leg);
            if (classification === null || classification.historyExpected !== false) return true; // the other arm is guard 3's
            const request = resumedRequest(leg);
            const observation = promptObservation(leg);
            const structural = observation !== null && observation.chatHistoryEntry !== null
                && (observation.chatHistoryEntry.present !== true || observation.chatHistoryEntry.enabled !== true);
            return structural
                && request !== null
                && request.carriesFirstTurnMarker === false
                && request.carriesSecondTurnMarker === false
                && request.carriesRestoredReplies === false;
        }),
        resumedLegs.map(leg => ({ classification: promptClassification(leg), observation: promptObservation(leg), request: resumedRequest(leg) })));
    // 5. THE ORDINAL ITSELF EQUALS PINNED'S: a leg that took one extra request before the click would still satisfy
    // guard 1, but the two subjects would not have been driven the same way, and their byte equality would be between
    // different turns.
    guard('resumed-request-ordinal-equal',
        resumedArmedOrdinal(goRestart) > 0 && resumedArmedOrdinal(goRestart) === resumedArmedOrdinal(pinnedRestart),
        { gotavern: resumedArmedOrdinal(goRestart), pinned: resumedArmedOrdinal(pinnedRestart) });
    // 6. THE PRESET THE NEW PROCESS READ BACK. When the drive leg selected a preset, the restart leg must observe the
    // same one and the same structure WITHOUT selecting anything, and the two subjects must agree on it.
    const presetObserved = leg => ({
        name: leg?.preset?.name ?? null,
        mode: leg?.preset?.mode ?? null,
        selected: leg?.promptOrder?.restart?.presetSelected ?? null,
        prompts: leg?.promptOrder?.restart?.promptsCount ?? null,
        rows: leg?.promptOrder?.restart?.orderLength ?? null,
        enabled: leg?.promptOrder?.restart?.enabledCount ?? null,
    });
    const presetRestored = leg => {
        const requested = presetObserved(leg);
        if (requested.name === null) return requested.selected === null || requested.selected === 'Default' || typeof requested.selected === 'string';
        const structure = leg?.preset?.structure ?? {};
        const expectedEnabled = Number(structure.runtimeEnabledRows);
        return requested.selected === requested.name
            && Number(requested.prompts) === Number(structure.prompts)
            && Number(requested.rows) === Number(structure.runtimeRows)
            && Number(requested.enabled) === expectedEnabled;
    };
    guard('restart-preset-restored-without-selection',
        resumedLegs.every(presetRestored) && presetObserved(goRestart).name === presetObserved(pinnedRestart).name,
        { gotavern: presetObserved(goRestart), pinned: presetObserved(pinnedRestart), gotavernPreset: goRestart?.preset ?? null, pinnedPreset: pinnedRestart?.preset ?? null });

    // ---- 1a. BROWSER OBSERVABLE EQUALITY ---------------------------------------------------------------------
    guard('chat-id-equal',
        finalState(goDrive)?.chatId !== null && finalState(goDrive)?.chatId === finalState(pinnedDrive)?.chatId,
        { gotavern: finalState(goDrive)?.chatId ?? null, pinned: finalState(pinnedDrive)?.chatId ?? null });
    guard('message-count-equal',
        Number(finalState(goDrive)?.chatLength ?? -1) === Number(finalState(pinnedDrive)?.chatLength ?? -2)
        && Number(finalState(goDrive)?.chatLength ?? 0) > 0,
        { gotavern: finalState(goDrive)?.chatLength ?? null, pinned: finalState(pinnedDrive)?.chatLength ?? null });
    guard('sequence-equal',
        sameJson(finalState(goDrive)?.sequence ?? null, finalState(pinnedDrive)?.sequence ?? null)
        && count(finalState(goDrive)?.sequence) > 0,
        { gotavern: finalState(goDrive)?.sequence ?? null, pinned: finalState(pinnedDrive)?.sequence ?? null });
    guard('reload-state-equal',
        sameJson(goDrive?.browser?.afterReload?.state ?? null, pinnedDrive?.browser?.afterReload?.state ?? null)
        && goDrive?.browser?.afterReload?.state?.chatId !== null,
        { gotavern: goDrive?.browser?.afterReload?.state?.chatId ?? null, pinned: pinnedDrive?.browser?.afterReload?.state?.chatId ?? null });
    guard('swipe-state-equal',
        sameJson({
            before: { swipes: goDrive?.browser?.swipe?.before?.swipes ?? null, swipeId: goDrive?.browser?.swipe?.before?.swipeId ?? null },
            after: { swipes: goDrive?.browser?.swipe?.after?.swipes ?? null, swipeId: goDrive?.browser?.swipe?.after?.swipeId ?? null },
        }, {
            before: { swipes: pinnedDrive?.browser?.swipe?.before?.swipes ?? null, swipeId: pinnedDrive?.browser?.swipe?.before?.swipeId ?? null },
            after: { swipes: pinnedDrive?.browser?.swipe?.after?.swipes ?? null, swipeId: pinnedDrive?.browser?.swipe?.after?.swipeId ?? null },
        }),
        { gotavern: { before: goDrive?.browser?.swipe?.before ?? null, after: goDrive?.browser?.swipe?.after ?? null }, pinned: { before: pinnedDrive?.browser?.swipe?.before ?? null, after: pinnedDrive?.browser?.swipe?.after ?? null } });
    guard('verb-chat-lengths-equal',
        Number(goDrive?.browser?.regenerate?.before?.chatLength ?? -1) === Number(pinnedDrive?.browser?.regenerate?.before?.chatLength ?? -2)
        && Number(goDrive?.browser?.continue?.before?.chatLength ?? -1) === Number(pinnedDrive?.browser?.continue?.before?.chatLength ?? -2)
        && Number(goDrive?.browser?.continue?.after?.chatLength ?? -1) === Number(pinnedDrive?.browser?.continue?.after?.chatLength ?? -2),
        {
            regenerate: [goDrive?.browser?.regenerate?.before?.chatLength ?? null, pinnedDrive?.browser?.regenerate?.before?.chatLength ?? null],
            continue: [goDrive?.browser?.continue?.before?.chatLength ?? null, pinnedDrive?.browser?.continue?.before?.chatLength ?? null],
            continueAfter: [goDrive?.browser?.continue?.after?.chatLength ?? null, pinnedDrive?.browser?.continue?.after?.chatLength ?? null],
        });
    guard('settings-write-mechanism-equal',
        goDrive?.browser?.settingsWrite?.source === pinnedDrive?.browser?.settingsWrite?.source
        && typeof goDrive?.browser?.settingsWrite?.source === 'string',
        { gotavern: goDrive?.browser?.settingsWrite?.source ?? null, pinned: pinnedDrive?.browser?.settingsWrite?.source ?? null });
    guard('settings-temperature-equal',
        Number(goDrive?.browser?.settingsWrite?.after) === Number(pinnedDrive?.browser?.settingsWrite?.after)
        && Number(goDrive?.browser?.settingsWrite?.after) === Number(goDrive?.temperatureRequested),
        { gotavern: goDrive?.browser?.settingsWrite?.after ?? null, pinned: pinnedDrive?.browser?.settingsWrite?.after ?? null });

    // ---- 1b. PROVIDER WIRE EQUALITY (byte-oriented) ----------------------------------------------------------
    const goCompletions = goDrive?.wire?.completions ?? [];
    const pinnedCompletions = pinnedDrive?.wire?.completions ?? [];
    guard('completion-count-equal', goCompletions.length === pinnedCompletions.length && goCompletions.length > 0,
        { gotavern: goCompletions.length, pinned: pinnedCompletions.length });
    // ONE GUARD PER ORDINAL, so a red names WHICH request differs instead of "the wire differs".
    const shared = Math.min(goCompletions.length, pinnedCompletions.length);
    for (let index = 0; index < shared; index += 1) {
        const go = goCompletions[index];
        const pinned = pinnedCompletions[index];
        guard(`completion-${index + 1}-equal`,
            go?.method === pinned?.method && go?.path === pinned?.path
            && Number(go?.byteLength) === Number(pinned?.byteLength) && go?.sha256 === pinned?.sha256,
            {
                gotavern: { method: go?.method ?? null, path: go?.path ?? null, byteLength: go?.byteLength ?? null, sha256: go?.sha256 ?? null },
                pinned: { method: pinned?.method ?? null, path: pinned?.path ?? null, byteLength: pinned?.byteLength ?? null, sha256: pinned?.sha256 ?? null },
            });
    }
    // AND THE RESTART-PHASE REQUEST, AT THE SEND'S ORDINAL. This used to compare `at(-1)` on both legs, which is the
    // same selection defect the probe had: with a helper completion in the wire, `.at(-1)` compares the helper's request
    // and calls it parity. The compared unit is the request the click produced.
    const goResumed = restartRequestAtOrdinal(goRestart);
    const pinnedResumedAt = restartRequestAtOrdinal(pinnedRestart);
    guard('restart-completion-equal',
        goResumed !== null && pinnedResumedAt !== null
        && goResumed.method === pinnedResumedAt.method && goResumed.path === pinnedResumedAt.path
        && goResumed.sha256 === pinnedResumedAt.sha256
        && Number(goResumed.byteLength) === Number(pinnedResumedAt.byteLength),
        {
            gotavern: goResumed === null ? null : { ordinal: resumedArmedOrdinal(goRestart), method: goResumed.method, path: goResumed.path, sha256: goResumed.sha256, byteLength: goResumed.byteLength },
            pinned: pinnedResumedAt === null ? null : { ordinal: resumedArmedOrdinal(pinnedRestart), method: pinnedResumedAt.method, path: pinnedResumedAt.path, sha256: pinnedResumedAt.sha256, byteLength: pinnedResumedAt.byteLength },
        });
    // THE RESTART WIRE IS THE SAME LENGTH ON BOTH SUBJECTS: one resumed send, plus the helper completion when the
    // journey injected one. A leg that issued an extra request before the send would break the ordinal equality above;
    // a leg that issued one after it must issue the same shape, and the helper completion's bytes must also be equal.
    const restartCompletions = leg => leg?.wire?.completions ?? [];
    guard('restart-completion-count-equal',
        restartCompletions(goRestart).length === restartCompletions(pinnedRestart).length
        && restartCompletions(goRestart).length >= 1,
        { gotavern: restartCompletions(goRestart).length, pinned: restartCompletions(pinnedRestart).length });
    const helperLegs = [goRestart, pinnedRestart].filter(leg => helperObservation(leg)?.injected === true);
    guard('restart-helper-completion-equal',
        helperLegs.length === 0
        || (helperLegs.length === 2
            && [goRestart, pinnedRestart].every(leg => helperRequest(leg) !== null)
            && completionAtOrdinal(goRestart, helperRequest(goRestart)?.ordinal)?.sha256
                === completionAtOrdinal(pinnedRestart, helperRequest(pinnedRestart)?.ordinal)?.sha256
            && Number(completionAtOrdinal(goRestart, helperRequest(goRestart)?.ordinal)?.byteLength)
                === Number(completionAtOrdinal(pinnedRestart, helperRequest(pinnedRestart)?.ordinal)?.byteLength)),
        {
            gotavern: helperRequest(goRestart) ?? null,
            pinned: helperRequest(pinnedRestart) ?? null,
            gotavernSha: completionAtOrdinal(goRestart, helperRequest(goRestart)?.ordinal)?.sha256 ?? null,
            pinnedSha: completionAtOrdinal(pinnedRestart, helperRequest(pinnedRestart)?.ordinal)?.sha256 ?? null,
        });
    // THE HELPER REQUEST IS THE SHAPE THE OPEN OBSERVATION RECORDED, and it is NOT the send's request. The first half
    // makes the reproduction discriminating (a fixture that is not single-system proves nothing about single-system
    // captures); the second half is the mechanism the ordinal attribution exists to refuse.
    guard('helper-completion-was-not-the-resumed-request',
        helperLegs.length === 0
        || [goRestart, pinnedRestart].every(leg => {
            const helper = helperRequest(leg);
            const resumed = resumedRequest(leg);
            return helper !== null && resumed !== null
                && helper.isSingleSystemMessage === true
                && helper.carriesHelperMarker === true
                && helper.carriesRestoredMarkers === false
                && helper.ordinal !== resumed.ordinal
                && helper.bodySha256 !== resumed.bodySha256;
        }),
        [goRestart, pinnedRestart].map(leg => ({ helper: helperRequest(leg), resumed: resumedRequest(leg) })));

    // ---- 1c. DISK STATE EQUALITY -----------------------------------------------------------------------------
    guard('disk-chat-file-equal',
        typeof finalChat(goDrive)?.file === 'string' && finalChat(goDrive)?.file === finalChat(pinnedDrive)?.file,
        { gotavern: finalChat(goDrive)?.file ?? null, pinned: finalChat(pinnedDrive)?.file ?? null });
    guard('disk-header-present-both',
        finalChat(goDrive)?.hasHeader === true && finalChat(pinnedDrive)?.hasHeader === true,
        { gotavern: finalChat(goDrive)?.hasHeader ?? null, pinned: finalChat(pinnedDrive)?.hasHeader ?? null });
    guard('disk-message-count-equal',
        Number(finalChat(goDrive)?.messageCount ?? -1) === Number(finalChat(pinnedDrive)?.messageCount ?? -2),
        { gotavern: finalChat(goDrive)?.messageCount ?? null, pinned: finalChat(pinnedDrive)?.messageCount ?? null });
    const semantic = leg => (finalChat(leg)?.messages ?? []).map(message => ({
        index: message.index, is_user: message.is_user, mes: message.mes,
        swipe_id: message.swipe_id, swipesCount: message.swipesCount, name: message.name,
    }));
    guard('disk-message-fields-equal', sameJson(semantic(goDrive), semantic(pinnedDrive)) && semantic(goDrive).length > 0,
        { gotavern: semantic(goDrive), pinned: semantic(pinnedDrive) });
    const swipeArrays = leg => (finalChat(leg)?.messages ?? []).map(message => message.swipes ?? null);
    guard('disk-swipe-arrays-equal', sameJson(swipeArrays(goDrive), swipeArrays(pinnedDrive)),
        { gotavern: swipeArrays(goDrive), pinned: swipeArrays(pinnedDrive) });

    // ---- 1d. RESTART EQUALITY --------------------------------------------------------------------------------
    guard('restart-chat-id-equal',
        restartState(goRestart)?.chatId !== null && restartState(goRestart)?.chatId === restartState(pinnedRestart)?.chatId
        && restartState(goRestart)?.chatId === finalState(goDrive)?.chatId,
        {
            gotavern: [finalState(goDrive)?.chatId ?? null, restartState(goRestart)?.chatId ?? null],
            pinned: [finalState(pinnedDrive)?.chatId ?? null, restartState(pinnedRestart)?.chatId ?? null],
        });
    guard('restart-sequence-equal',
        sameJson(restartState(goRestart)?.sequence ?? null, restartState(pinnedRestart)?.sequence ?? null)
        && count(restartState(goRestart)?.sequence) > 0,
        { gotavern: restartState(goRestart)?.sequence ?? null, pinned: restartState(pinnedRestart)?.sequence ?? null });
    guard('restart-message-count-equal',
        Number(restartState(goRestart)?.chatLength ?? -1) === Number(restartState(pinnedRestart)?.chatLength ?? -2)
        && Number(restartState(goRestart)?.chatLength ?? 0) === Number(finalState(goDrive)?.chatLength ?? -3),
        {
            gotavern: { driveFinal: finalState(goDrive)?.chatLength ?? null, restart: restartState(goRestart)?.chatLength ?? null },
            pinned: { driveFinal: finalState(pinnedDrive)?.chatLength ?? null, restart: restartState(pinnedRestart)?.chatLength ?? null },
        });
    const restartDelta = legsForSubject => Number(finalChat(legsForSubject)?.messageCount ?? 0) - Number(restartState(legsForSubject)?.chatLength ?? 0);
    guard('restart-disk-growth-equal',
        restartDelta(goRestart) === restartDelta(pinnedRestart) && restartDelta(goRestart) >= 2,
        { gotavern: restartDelta(goRestart), pinned: restartDelta(pinnedRestart) });

    const failedGuards = Object.keys(guards).filter(name => guards[name].ok !== true).sort();
    return {
        surface: 'whole-session',
        schemaVersion: 1,
        verdict: failedGuards.length === 0 ? 'match' : 'mismatch',
        guardCount: Object.keys(guards).length,
        failedGuards,
        guards,
        subjects: {
            gotovern: { drivePid: goDrive?.server?.pid ?? null, restartPid: goRestart?.server?.pid ?? null, replyPrefix: prefixOf(goDrive) },
            pinned: { drivePid: pinnedDrive?.server?.pid ?? null, restartPid: pinnedRestart?.server?.pid ?? null, replyPrefix: prefixOf(pinnedDrive) },
        },
        notCompared: [
            'a real provider (AGENTS rule 22): the peer answers with markers',
            'group chats, branches and checkpoints',
            'multi-user trees',
            'chat_metadata clocks and per-message send_date (a field that carries a clock cannot be compared across two recordings)',
        ],
    };
}

// ----------------------------------------------------------------------------------------------------------------
// CLI.
// ----------------------------------------------------------------------------------------------------------------

function option(argv, name, fallback = null) {
    const index = argv.indexOf(name);
    return index === -1 ? fallback : argv[index + 1];
}

async function readLeg(target, label) {
    if (!target) {
        return { leg: null, refusal: `${label}: no path given (--${label})` };
    }
    try {
        return { leg: JSON.parse(await fs.readFile(target, 'utf8')), refusal: null };
    } catch (error) {
        return { leg: null, refusal: `${label}: cannot read ${target}: ${error?.message ?? error}` };
    }
}

const isMain = process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href.replace(/%20/g, ' ');
if (isMain || process.argv[1]?.endsWith('compare-whole-session-legs.mjs')) {
    const argv = process.argv.slice(2);
    const loaded = await Promise.all([
        readLeg(option(argv, '--drive-go'), 'drive-go'),
        readLeg(option(argv, '--drive-pinned'), 'drive-pinned'),
        readLeg(option(argv, '--restart-go'), 'restart-go'),
        readLeg(option(argv, '--restart-pinned'), 'restart-pinned'),
    ]);
    const refusals = loaded.map(entry => entry.refusal).filter(Boolean);
    if (refusals.length > 0) {
        for (const refusal of refusals) console.error(`compare-whole-session-legs.mjs: REFUSED -- ${refusal}`);
        console.error('compare-whole-session-legs.mjs: a missing leg is the ABSENCE of evidence, not a match');
        process.exit(2);
    }
    const result = compare({
        goDrive: loaded[0].leg, pinnedDrive: loaded[1].leg, goRestart: loaded[2].leg, pinnedRestart: loaded[3].leg,
    });
    const out = option(argv, '--out', null);
    if (out) await fs.writeFile(out, `${JSON.stringify(result, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    console.error(`whole-session: ${result.verdict} -- ${result.guardCount} guard(s), ${result.failedGuards.length} failed` +
        (result.failedGuards.length > 0 ? `: ${result.failedGuards.join(', ')}` : ''));
    process.exit(result.verdict === 'match' ? 0 : 1);
}
