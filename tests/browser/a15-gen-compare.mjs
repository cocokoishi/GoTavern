// A15-GEN-CONVERSATION COMPARATOR -- decides the differential the probe records. It defines NOTHING about the
// product's behaviour: every expected value in the report is an OBSERVATION made through the pinned frontend, and
// the only question this file answers is whether the two subjects produced the same observations.
//
// WHAT IS COMPARED, AND WHY THESE FIELDS
//   * `requests`        -- every provider request the recording peer received, in order: the raw path, the BODY
//                          LENGTH and the BODY SHA256. This is the byte-identity claim AGENTS 48 asks for and the
//                          reason a message edit, a message delete and a /sys message are worth probing at all: their
//                          only user-visible effect on the model is the next request's history.
//   * `snapshots`       -- after each mutation, the page's own rendered view (message count, last text, swipe index,
//                          whether the DOM's last bubble shows the text) AND the persisted chat projection read from
//                          the JSONL the server wrote.
//   * `finalDisk`       -- the chat projection after a SAVE + RELOAD, i.e. "the data survived".
//
// WHAT IS NOT COMPARED, with the reason recorded: clocks (`send_date`), per-run ids (`chat_metadata.chat_id`,
// `integrity`), per-generation `extra` values, and the file's byte length (line-ending/ordering noise the projection
// already linearises). The chat projection comes from `extensions/combination-journey-kit.mjs`, the same curator the
// combination-journey comparator uses, so the exclusions are declared in ONE place rather than invented here.
//
// EXIT STATUS. 0 only when both legs recorded a passing drive AND every compared field is identical. Otherwise it
// prints one line per difference naming the path and both values, and exits 1.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

function argumentValue(name) {
    const index = process.argv.indexOf(name);
    return index === -1 ? null : process.argv[index + 1];
}

const gotavernPath = argumentValue('--gotavern');
const pinnedPath = argumentValue('--pinned');
if (!gotavernPath || !pinnedPath) {
    console.error('usage: node a15-gen-compare.mjs --gotavern <json> --pinned <json>');
    process.exit(2);
}

const read = (file, label) => {
    try {
        return JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
    } catch (error) {
        console.error(`[compare] cannot read the ${label} leg report at ${file}: ${String(error?.message ?? error)}`);
        process.exit(2);
    }
};

const gotavern = read(gotavernPath, 'GoTavern');
const pinned = read(pinnedPath, 'pinned');
const problems = [];

// EXCLUSIONS, WITH THE MEASUREMENT THAT PRODUCED EACH ONE. The first two-leg run compared two reports whose every
// parsed chat message was identical and still reported a difference, twice:
//   * the chat's FILE NAME embeds a per-run timestamp (COMB_JOURNEY_CARD - 2026-11-05@01h14m47s326ms.jsonl), so a
//     path-keyed comparison compares the clock, not the state;
//   * the projection's `bytes` member is the raw JSONL byte length (2745 vs 2747) while every parsed message member
//     matched -- JSON member order/whitespace in the file is not the persisted contract (AGENTS rule 18: an unstable
//     or host-specific value must not survive in a compared field).
// Both are dropped by NAME here and the drop is printed at the end, so a reader sees the claim that was excluded
// rather than an unexplained tolerance. Every parsed message, swipe, swipe index and metadata variable is compared.
const EXCLUDED = 'chat file NAME (per-run timestamp) and raw JSONL byte length (JSON member order/whitespace); every parsed message member is compared';

function canonicalChat(chat) {
    if (chat === null || chat === undefined) return chat;
    const { bytes, ...rest } = chat;
    void bytes;
    return rest;
}

function fail(message) {
    problems.push(message);
}

for (const [label, report] of [['gotavern', gotavern], ['pinned', pinned]]) {
    if (report?.subject !== label) fail(`${label}: the report says subject=${JSON.stringify(report?.subject)}, so this is not the ${label} leg`);
    if (report?.passed !== true) {
        const failed = (report?.steps ?? []).filter(entry => entry.ok !== true).map(entry => entry.name);
        fail(`${label}: the drive itself did not pass (${failed.join(', ') || report?.failure || 'no named failing step'})`);
    }
    if (!Array.isArray(report?.requests) || report.requests.length === 0) fail(`${label}: no provider requests were recorded`);
}

// THE SHAPE CONTRACT, so "the requests are equal" cannot be satisfied by two empty arrays (AGENTS 50).
const expectedSteps = [
    'page-loaded', 'character-opened', 'turn-1-provider-request', 'swipe-right-started-a-request',
    'swipe-right-moved', 'swipe-left-moved-displayed-and-index', 'swipe-left-started-no-request',
    'edit-displayed-the-edited-text', 'edit-persisted', 'turn-2-provider-request',
    'turn-2-request-carries-edited-history', 'delete-removed-the-message', 'delete-persisted',
    'slash-executed', 'slash-persisted', 'turn-3-request-carries-the-system-message',
    'reload-reads-the-edited-history', 'final-disk-carries-all-three-turns-and-the-edit',
];
for (const [label, report] of [['gotavern', gotavern], ['pinned', pinned]]) {
    const present = new Set((report?.steps ?? []).map(entry => entry.name));
    const missing = expectedSteps.filter(name => !present.has(name));
    if (missing.length > 0) fail(`${label}: the drive did not record the step(s) ${missing.join(', ')}, so this leg cannot be evidence for them`);
}

function compareValue(label, left, right) {
    if (JSON.stringify(left) === JSON.stringify(right)) return;
    fail(`${label}: gotavern=${JSON.stringify(left)} pinned=${JSON.stringify(right)}`);
}

// 1) THE REQUESTS: order, path, byte length and sha256. Bodies are compared by digest; the digest IS the byte claim.
const requestCount = Math.max(gotavern?.requests?.length ?? 0, pinned?.requests?.length ?? 0);
if ((gotavern?.requests?.length ?? 0) !== (pinned?.requests?.length ?? 0)) {
    fail(`requests.length: gotavern=${gotavern?.requests?.length ?? 0} pinned=${pinned?.requests?.length ?? 0}`);
}
for (let index = 0; index < requestCount; index += 1) {
    const left = gotavern?.requests?.[index] ?? null;
    const right = pinned?.requests?.[index] ?? null;
    if (left === null || right === null) continue;
    compareValue(`requests[${index}].path`, left.path, right.path);
    compareValue(`requests[${index}].byteLength`, left.byteLength, right.byteLength);
    compareValue(`requests[${index}].sha256`, left.sha256, right.sha256);
}

// 2) THE PER-STEP OBSERVATIONS: page state and persisted chat after each mutation.
const snapshotNames = [...new Set([...Object.keys(gotavern?.snapshots ?? {}), ...Object.keys(pinned?.snapshots ?? {})])].sort();
for (const name of snapshotNames) {
    const left = gotavern?.snapshots?.[name] ?? null;
    const right = pinned?.snapshots?.[name] ?? null;
    if (left === null || right === null) { fail(`snapshots.${name}: absent on one leg (gotavern=${left === null ? 'absent' : 'present'}, pinned=${right === null ? 'absent' : 'present'})`); continue; }
    compareValue(`snapshots.${name}.chat`, canonicalChat(left.chat), canonicalChat(right.chat));
    // The page's live view: the rendered message count and the editable/swipe state a user sees. The last message's
    // TEXT is compared by the chat projection already (both are the same string), so only the DOM's own reading and
    // the control state are compared here.
    compareValue(`snapshots.${name}.page.chatLength`, left.page?.chatLength, right.page?.chatLength);
    compareValue(`snapshots.${name}.page.domMessageCount`, left.page?.domMessageCount, right.page?.domMessageCount);
    compareValue(`snapshots.${name}.page.last.swipeId`, left.page?.last?.swipeId, right.page?.last?.swipeId);
    compareValue(`snapshots.${name}.page.last.swipes`, left.page?.last?.swipes, right.page?.last?.swipes);
    compareValue(`snapshots.${name}.page.last.text`, left.page?.last?.text, right.page?.last?.text);
    compareValue(`snapshots.${name}.page.domLastText`, left.page?.domLastText, right.page?.domLastText);
}

// 3) THE SURVIVING DATA: the file after save + reload.
{
    const canonicalDisk = disk => {
        const chats = Object.values(disk ?? {});
        return chats.map(canonicalChat).sort((first, second) => JSON.stringify(first).localeCompare(JSON.stringify(second)));
    };
    compareValue('finalDisk.chats', canonicalDisk(gotavern?.finalDisk?.chats), canonicalDisk(pinned?.finalDisk?.chats));
    if ((gotavern?.finalDisk?.chats !== null && gotavern?.finalDisk?.chats !== undefined) && (pinned?.finalDisk?.chats !== null && pinned?.finalDisk?.chats !== undefined)) {
        const leftCount = Object.keys(gotavern.finalDisk.chats).length;
        const rightCount = Object.keys(pinned.finalDisk.chats).length;
        compareValue('finalDisk.chatCount', leftCount, rightCount);
    }
}

// 4) THE TWO LEGS MUST HAVE BEEN DRIVEN IN THE SAME SHAPE.
compareValue('requests.length', gotavern?.requests?.length ?? null, pinned?.requests?.length ?? null);
if ((gotavern?.requests?.length ?? 0) !== 4) fail(`requests.length: the drive claims four requests (turn 1, swipe-right, turn 2, turn 3) but recorded ${gotavern?.requests?.length ?? 0}`);

if (problems.length > 0) {
    console.error(`[compare] A15 generation/conversation differential FAILED with ${problems.length} difference(s):`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
}
console.log(`[compare] A15 generation/conversation differential closed: ${gotavern.requests.length} provider request(s) byte-identical, ${snapshotNames.length} per-step snapshot(s) equal, persisted chat equal after save+reload.`);
console.log(`[compare] excluded, with reason: ${EXCLUDED}`);
process.exit(0);
