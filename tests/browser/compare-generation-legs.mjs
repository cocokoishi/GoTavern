#!/usr/bin/env node
// Compare two generation-probe legs (GoTavern vs pinned) captured with the SAME drive.
//
// Usage: node compare-generation-legs.mjs <gotavern-report.json> <pinned-report.json>
//
// The probe already answers the harder question ("does a send produce a provider request?").
// This compares the two records the same drive produced:
//   * the provider requests (method, target, body length, body SHA-256),
//   * the chat-completions body when both legs captured it (message-by-message),
//   * the generation event sequence, normalised so prompt-manager DRY RUNS (which the frontend
//     starts on its own and which never issue a provider request) do not masquerade as a missing
//     real event,
//   * the post-send DOM state.
//
// A difference is a FINDING, not a failure of this script: it exits 0 after printing a structured
// comparison so the difference can be reported instead of being hidden behind a non-zero exit.
//
// The exception is a guard that says the differential was UNFAITHFUL -- a window that began in the
// middle of a generation, or a leg that never reached a sendable state. Such a record cannot support
// a claim about either server, so `guards` is checked and a false guard exits 1 after the comparison
// is printed (the caller redirects stdout to the artifact; the exit status is what fails the run).

import fs from 'node:fs/promises';
import process from 'node:process';

const [gotavernPath, pinnedPath] = process.argv.slice(2);
if (!gotavernPath || !pinnedPath) {
    console.error('usage: node compare-generation-legs.mjs <gotavern-report.json> <pinned-report.json>');
    process.exit(2);
}

// The probe records generation events with a JSON summary of their arguments. Only some events
// carry dryRun, and the frontend also runs a prompt-manager dry generation that never sends, so a
// flat event-name sequence is not comparable. Compare MILESTONES that a send must produce instead:
// exactly one real GENERATION_STARTED, one real GENERATE_AFTER_DATA, and the completion events.
const isDry = event => String(event.dryRun ?? '').includes('true]') || String(event.dryRun ?? '').includes(',true]');

const milestonesOf = events => {
    const count = (name, predicate = () => true) => events.filter(event => event.name === name && predicate(event)).length;
    return {
        realGenerationStarted: count('GENERATION_STARTED', event => !isDry(event)),
        dryGenerationStarted: count('GENERATION_STARTED', isDry),
        realAfterData: count('GENERATE_AFTER_DATA', event => !isDry(event)),
        dryAfterData: count('GENERATE_AFTER_DATA', isDry),
        chatCompletionSettingsReady: count('CHAT_COMPLETION_SETTINGS_READY'),
        generationEnded: count('GENERATION_ENDED'),
    };
};

// THE SEND WINDOW: the click to the send's own completion, and nothing after it.
//
// WHY THE TAIL IS CUT, with the measurement rather than an argument: the prompt manager re-renders
// itself after a send (PromptManager.js:760 now renders on MESSAGE_RECEIVED, and its `render(true)`
// runs `tryGenerate()` -> `Generate('normal', {}, true)`, openai.js:707-713). That dry assembly is a
// UI refresh, and HOW MANY of them coalesce out of the debounce is not a property of either server:
// two pinned legs recorded with the SAME probe minutes apart put 1 and then 2 dry assemblies after
// GENERATION_ENDED, and the pre-send count likewise moved between 1 and 2 on one leg. A value that
// moves on one leg run-to-run is a race, not a contract (AGENTS.md rule 18), so it is RECORDED as
// `afterSend` context and is not part of the compared milestones.
//
// The cut is exact and source-derived, not a heuristic: a generation emits GENERATE_AFTER_DATA at
// script.js:5318 and ends either at script.js:5320 (`if (dryRun) return`) or, when it is real, at
// GENERATION_ENDED (hideStopButton, script.js:3536). A dry generation cannot START inside this window
// either: `Generate` sets `is_send_press` for a real send (script.js:4400) and promptManager.render()
// waits for `!is_send_press` (PromptManager.js:868), so the next dry assembly begins only after the
// send has finished. An abort ends the window at GENERATION_STOPPED (script.js:5618) if no
// GENERATION_ENDED was recorded.
const sendWindow = report => {
    const events = report.events ?? [];
    let end = events.findIndex(event => event.name === 'GENERATION_ENDED');
    if (end === -1) {
        end = events.findIndex(event => event.name === 'GENERATION_STOPPED');
    }
    return end === -1 ? { window: events, afterSend: [] } : { window: events.slice(0, end + 1), afterSend: events.slice(end + 1) };
};

const milestones = report => milestonesOf(sendWindow(report).window);

// Context, so the excluded dry assemblies are visible in the artifact instead of hidden by the cut.
const surrounding = report => {
    const { window, afterSend } = sendWindow(report);
    const counters = events => ({
        events: events.length,
        dryGenerationStarted: events.filter(event => event.name === 'GENERATION_STARTED' && isDry(event)).length,
        dryAfterData: events.filter(event => event.name === 'GENERATE_AFTER_DATA' && isDry(event)).length,
    });
    return {
        // Recorded before the click, because the drive's own setup (selecting the chat-completion
        // source/model) starts the prompt manager's dry generation. Excluded from the window.
        beforeClick: { events: report.eventsBeforeClick?.count ?? null },
        sendWindow: counters(window),
        afterSend: counters(afterSend),
        // Whole drive, every mode: the number that says both legs ran the same NUMBER of Generate
        // invocations whatever the window did.
        wholeDrive: report.generateLifecycle ?? null,
    };
};

const providerRequests = report => (report.recording ?? []).map(request => ({
    method: request.method,
    path: request.path,
    bodyLength: request.bodyLength,
    bodySha256: request.bodySha256,
}));

// WHOLE-DRIVE Generate lifecycle, deliberately NOT windowed. The milestone counters above answer
// "what happened after the send"; this answers "how many generations did the page run in total, and
// how many of them were dry", which is the only way a reader can tell a BEHAVIOUR difference from a
// difference in where the observation window fell. A window once began a few statements before the
// send click and captured the tail of a dry generation that the drive's own setup had started, which
// made the pinned leg look like it ran one more dry assembly than GoTavern. It had not.
const invocations = report => {
    const lifecycle = report.generateLifecycle ?? null;
    if (!lifecycle) {
        return { recorded: false };
    }
    return {
        recorded: true,
        started: lifecycle.started,
        dryStarted: lifecycle.dryStarted,
        realStarted: lifecycle.realStarted,
        dryAfterData: lifecycle.dryAfterData,
        ended: lifecycle.ended,
    };
};

// WINDOW INTEGRITY. This is the property the recorded difference in the committed artifact turned
// out to be about, so it is now checked rather than assumed. Inside the reported window a generation
// that STARTED there emits exactly one GENERATE_AFTER_DATA (script.js:5318) -- a dry one ends there
// (script.js:5320), a real one continues to GENERATION_ENDED -- so a complete window holds one
// AFTER_DATA per STARTED of the same kind. A window that began while a generation was already
// running breaks that pairing: it captures the tail (AFTER_DATA) without the head (STARTED).
// Measured on the superseded legs: pinned recorded dryStarts 1 / dryAfterData 2 while GoTavern
// recorded 1 / 1, and the same 1-vs-2 asymmetry moved to the OTHER leg in other modes of the same
// harness, which is only possible if it belongs to the recording boundary and not to a server.
const windowIntegrity = report => {
    const counters = milestones(report);
    return {
        dryGenerationStarted: counters.dryGenerationStarted,
        dryAfterData: counters.dryAfterData,
        realGenerationStarted: counters.realGenerationStarted,
        realAfterData: counters.realAfterData,
        complete: counters.dryGenerationStarted === counters.dryAfterData
            && counters.realGenerationStarted === counters.realAfterData,
    };
};

// The guards that say the differential was FAITHFUL. A send issued while the frontend was already
// assembling a prompt interleaves two assemblies and compares a state no user can act from, and a
// window that holds half a generation cannot be compared at all.
const guards = (gotavern, pinned) => {
    const quiesced = report => report.quiescence?.quiesced === true;
    const settled = report => report.settle?.settledIdle === true;
    const complete = report => windowIntegrity(report).complete === true;
    // Exactly one real send inside the window, and NO dry assembly inside it: a dry one there would
    // mean the send forked into a second prompt assembly while it was running.
    const sendOnly = report => {
        const counters = milestones(report);
        return counters.realGenerationStarted === 1
            && counters.realAfterData === 1
            && counters.dryGenerationStarted === 0
            && counters.dryAfterData === 0;
    };
    return {
        bothLegsQuiescedBeforeSend: quiesced(gotavern) && quiesced(pinned),
        bothLegsSettledAfterSend: settled(gotavern) && settled(pinned),
        bothWindowsHoldCompleteGenerations: complete(gotavern) && complete(pinned),
        sendWindowHoldsExactlyOneRealSendAndNoDryAssembly: sendOnly(gotavern) && sendOnly(pinned),
    };
};

const postBody = report => {
    const request = (report.recording ?? []).find(entry => entry.method === 'POST' && entry.body);
    if (!request) return null;
    try {
        return JSON.parse(request.body);
    } catch {
        return null;
    }
};

const bodyDiff = (left, right) => {
    const differences = [];
    if (!left || !right) return ['one leg captured no POST body'];
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    for (const key of rightKeys) {
        if (!(key in left)) differences.push(`field only in pinned: ${key}`);
    }
    for (const key of leftKeys) {
        if (!(key in right)) differences.push(`field only in GoTavern: ${key}`);
    }
    for (const key of leftKeys) {
        if (!(key in right)) continue;
        if (JSON.stringify(left[key]) !== JSON.stringify(right[key])) {
            if (key === 'messages' && Array.isArray(left[key]) && Array.isArray(right[key])) {
                const lengthNote = left[key].length === right[key].length ? `${left[key].length} messages` : `${left[key].length} vs ${right[key].length} messages`;
                for (let index = 0; index < Math.max(left[key].length, right[key].length); index++) {
                    const leftMessage = JSON.stringify(left[key][index]);
                    const rightMessage = JSON.stringify(right[key][index]);
                    if (leftMessage !== rightMessage) {
                        differences.push(`messages[${index}] differs (${lengthNote}): ` +
                            `GoTavern ${leftMessage.slice(0, 120)}... pinned ${rightMessage.slice(0, 120)}...`);
                    }
                }
            } else {
                differences.push(`field ${key} differs: GoTavern ${JSON.stringify(left[key]).slice(0, 120)} pinned ${JSON.stringify(right[key]).slice(0, 120)}`);
            }
        }
    }
    return differences;
};

const main = async () => {
    const gotavern = JSON.parse(await fs.readFile(gotavernPath, 'utf8'));
    const pinned = JSON.parse(await fs.readFile(pinnedPath, 'utf8'));
    const comparison = {
        schemaVersion: 1,
        question: 'does the same frontend drive produce the same provider request on GoTavern and pinned?',
        bases: { gotavern: gotavern.gotavern, pinned: pinned.gotavern },
        requestArrived: { gotavern: gotavern.requestArrived, pinned: pinned.requestArrived },
        providerRequests: { gotavern: providerRequests(gotavern), pinned: providerRequests(pinned) },
        milestones: { gotavern: milestones(gotavern), pinned: milestones(pinned) },
        milestoneEqual: JSON.stringify(milestones(gotavern)) === JSON.stringify(milestones(pinned)),
        // Everything the window deliberately excludes, so a reader can see it was recorded and why.
        surrounding: { gotavern: surrounding(gotavern), pinned: surrounding(pinned) },
        eventWindow: {
            gotavern: { eventsBeforeClick: gotavern.eventsBeforeClick?.count ?? null, quiescence: gotavern.quiescence ?? null, settle: gotavern.settle ?? null },
            pinned: { eventsBeforeClick: pinned.eventsBeforeClick?.count ?? null, quiescence: pinned.quiescence ?? null, settle: pinned.settle ?? null },
        },
        guards: guards(gotavern, pinned),
        postSend: { gotavern: gotavern.postSend ?? null, pinned: pinned.postSend ?? null },
        bodyDifferences: bodyDiff(postBody(gotavern), postBody(pinned)),
    };
    comparison.providerRequestEqual =
        JSON.stringify(comparison.providerRequests.gotavern) === JSON.stringify(comparison.providerRequests.pinned);
    comparison.windowIntegrity = { gotavern: windowIntegrity(gotavern), pinned: windowIntegrity(pinned) };
    console.log(JSON.stringify(comparison, null, 2));
    // Printed to stderr so stdout stays the artifact. A false guard means the two records do not
    // describe a comparable state, and no reason recorded alongside them would make them do so.
    const failed = Object.entries(comparison.guards).filter(([, value]) => value !== true).map(([name]) => name);
    if (failed.length > 0) {
        console.error(`unfaithful generation differential, ${failed.length} guard(s) failed: ${failed.join(', ')}`);
        for (const [leg, integrity] of Object.entries(comparison.windowIntegrity)) {
            if (integrity.complete !== true) {
                console.error(`  ${leg} window holds half a generation: dry STARTED ${integrity.dryGenerationStarted} vs dry AFTER_DATA ${integrity.dryAfterData}, ` +
                    `real STARTED ${integrity.realGenerationStarted} vs real AFTER_DATA ${integrity.realAfterData}`);
            }
        }
        process.exitCode = 1;
    }
};

await main();
