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
const milestones = report => {
    const events = report.events ?? [];
    const count = (name, predicate = () => true) => events.filter(event => event.name === name && predicate(event)).length;
    const isDry = event => String(event.dryRun ?? '').includes('true]') || String(event.dryRun ?? '').includes(',true]');
    return {
        realGenerationStarted: count('GENERATION_STARTED', event => !isDry(event)),
        dryGenerationStarted: count('GENERATION_STARTED', event => isDry(event)),
        realAfterData: count('GENERATE_AFTER_DATA', event => !isDry(event)),
        dryAfterData: count('GENERATE_AFTER_DATA', event => isDry(event)),
        chatCompletionSettingsReady: count('CHAT_COMPLETION_SETTINGS_READY'),
        generationEnded: count('GENERATION_ENDED'),
    };
};

const providerRequests = report => (report.recording ?? []).map(request => ({
    method: request.method,
    path: request.path,
    bodyLength: request.bodyLength,
    bodySha256: request.bodySha256,
}));

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
        postSend: { gotavern: gotavern.postSend ?? null, pinned: pinned.postSend ?? null },
        bodyDifferences: bodyDiff(postBody(gotavern), postBody(pinned)),
    };
    comparison.providerRequestEqual =
        JSON.stringify(comparison.providerRequests.gotavern) === JSON.stringify(comparison.providerRequests.pinned);
    console.log(JSON.stringify(comparison, null, 2));
};

await main();
