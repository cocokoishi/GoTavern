// THE JUDGE FOR THE COMBINATION JOURNEY.
//
// Inputs: the journey probe's report for the GoTavern drive leg, the pinned drive leg, their restart legs over the
// SAME trees, and (optionally) pinned's HAND-BACK leg over the GoTavern-written tree.
//
// TWO KINDS OF GUARD, and the verdict needs both:
//   1. WIRE — per-capture equality of method + raw target + byteLength + sha256 of the raw body (no canonicalisation).
//   2. OBSERVED FACTS — the per-subject steps the probe itself recorded. A step is `ok` only where THAT subject's
//      own observations satisfied it: the preset pieces, the three world-info slots, the three variable scopes, the QR
//      injection, the author's note, the regex-rewritten reply, the verbs, the branch, the group turn, the durable
//      chat, and the reload/restart survival. Cross-subject equality of these steps is the differential: GoTavern is
//      only credited for a fact pinned Node also observed.
//
// TWO-SUBJECT ASYMMETRY IS A FAILED GUARD even when each leg's own step list is green: a guard is true only when
// BOTH subjects observed it, and `asymmetries` names every pair that disagreed.
//
// REFUSAL: a restart pair or hand-back leg that is not supplied makes its guards false — NOT-OBSERVED, never green.
//
// Usage:
//   node tests/browser/compare-combination-journey.mjs <go-drive> <pinned-drive>
//     [--restart <go-restart> <pinned-restart>] [--handback <pinned-handback>] [--out <json>]

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createHash } from 'node:crypto';

import { canonicalJson as canonicalE03E04Json, sha256 as e03E04Sha256, TIERS as E03E04_TIERS } from './extensions/e03e04-profile-kit.mjs';
import { EXTENSION_TIERS } from './extensions/extension-install-batch.mjs';

// The pinned baseline the artifact's `pinnedSha` must name (AGENTS rule 1; the workflow passes the same value).
export const PINNED_BASELINE_COMMIT = '06bde939fb1e9c4c8d8641d810f0a916b5bce127';
export const EVIDENCE_ARTIFACT_KIND = 'combination-journey-evidence';
export const EVIDENCE_SCHEMA_VERSION = 1;

const read = target => JSON.parse(fs.readFileSync(path.resolve(target), 'utf8'));
const byCase = report => {
    const map = {};
    for (const request of report.requests ?? []) {
        if (!request.case) continue;
        (map[request.case] ?? (map[request.case] = [])).push(request);
    }
    return map;
};
const shaList = entries => (entries ?? []).map(entry => entry.sha256);
const stepValue = (report, name) => (report.steps ?? []).find(entry => entry.name === name) ?? null;
const stepOk = (report, name) => stepValue(report, name)?.ok === true;
const firstRequest = (report, caseName) => (byCase(report)[caseName] ?? [])[0] ?? null;
const bodyOf = request => String(request?.body ?? '');
const detailOf = (report, name) => stepValue(report, name)?.detail ?? null;

/**
 * BOUNDED BODY-DIFFERENCE DIAGNOSTICS (task-18a): a capture mismatch must NAME the first differing member/offset and
 * carry an informative but bounded excerpt, so a red is readable from comparison.json without downloading 18 KB
 * bodies by hand. Dispatch 42178757887's 16-byte difference was `.messages[16].content` gaining " COMB_REGEX_OK_5";
 * the diagnostic below turns that class of red into one line. Bodies are synthetic markers, but every excerpt is
 * capped so the artifact does not grow with body size.
 */
function firstBodyDifference(gotavernBody, pinnedBody, { maxValueChars = 160, maxDifferences = 3, maxExcerpt = 120 } = {}) {
    const go = String(gotavernBody ?? '');
    const pinned = String(pinnedBody ?? '');
    let offset = 0;
    while (offset < Math.min(go.length, pinned.length) && go[offset] === pinned[offset]) offset += 1;
    const excerpt = (text, at) => {
        const start = Math.max(0, at - Math.floor(maxExcerpt / 3));
        return text.slice(start, start + maxExcerpt);
    };
    const summary = {
        gotavernChars: go.length,
        pinnedChars: pinned.length,
        firstDifferingCharOffset: offset === Math.min(go.length, pinned.length) && go.length === pinned.length ? null : offset,
        gotavernExcerpt: excerpt(go, offset),
        pinnedExcerpt: excerpt(pinned, offset),
        differences: [],
        path: null,
    };
    const parse = text => { try { return { ok: true, value: JSON.parse(text) }; } catch { return { ok: false, value: null }; } };
    const goJson = parse(go);
    const pinJson = parse(pinned);
    if (goJson.ok !== true || pinJson.ok !== true) {
        summary.note = 'at least one body is not JSON; only the byte offset/excerpt are available';
        return summary;
    }
    const clip = value => (typeof value === 'string' ? value.slice(0, maxValueChars) : value);
    const walk = (a, b, at, depth) => {
        if (summary.differences.length >= maxDifferences || depth > 14) return;
        if (a === b) return;
        const type = value => (value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value);
        const ta = type(a);
        const tb = type(b);
        if (ta !== tb) { summary.differences.push({ path: at, kind: 'type', gotavern: ta, pinned: tb }); return; }
        if (ta === 'array') {
            if (a.length !== b.length) summary.differences.push({ path: at, kind: 'array-length', gotavern: a.length, pinned: b.length });
            for (let index = 0; index < Math.min(a.length, b.length); index += 1) walk(a[index], b[index], `${at}[${index}]`, depth + 1);
            return;
        }
        if (ta === 'object') {
            for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])]) {
                if (!Object.hasOwn(a, key)) { summary.differences.push({ path: `${at}.${key}`, kind: 'missing-in-gotavern', pinned: clip(b[key]) }); continue; }
                if (!Object.hasOwn(b, key)) { summary.differences.push({ path: `${at}.${key}`, kind: 'missing-in-pinned', gotavern: clip(a[key]) }); continue; }
                walk(a[key], b[key], `${at}.${key}`, depth + 1);
            }
            return;
        }
        summary.differences.push({ path: at, kind: 'value', gotavern: clip(a), pinned: clip(b), gotavernChars: String(a).length, pinnedChars: String(b).length });
    };
    walk(goJson.value, pinJson.value, '$', 0);
    summary.path = summary.differences[0]?.path ?? null;
    return summary;
}


const guard = (name, go, pinned, detail = null) => ({ name, go, pinned, ok: go === true && pinned === true, detail });

// =================================================================================================================
// THE E03+E04 PROFILE CONTRACT (design sections 5-6; task-14).
//
// WHAT THIS IS. When the legs carry `e03e04` records (staged by `combination-journey-probe.mjs --profile e03e04`),
// this section asserts the ORDERED MARKER CONTRACT on the recorded provider body, per subject, and then requires
// BOTH subjects. The expected order is the RECORDED `expectedOrder` manifest (the kit's deterministic output), never
// a hand-written body: the comparator only locates markers in the bytes the product actually sent.
//
// A REFUSAL, NOT A DEGRADATION. A requested profile whose record is missing/ill-formed, whose manifest digest does
// not match, or whose two subjects recorded different recipes is a REFUSED run: the guards are false and the
// verdict is mismatch. It never silently downgrades to the legacy guard set (which could be green on a body that
// lost the whole profile).
//
// MARKER GRAMMAR. `MARKER_Pnnnn` = one preset block; `MARKER_W[ABC]nnnn` = one world entry of book A/B/C.
// =================================================================================================================

const E03E04_MARKER_PATTERN = /MARKER_(?:P\d{4}|W[A-C]\d{4})/g;
const E03E04_ABSENT_STATUSES = new Set(['capability-relevant-unproven', 'no-wire-effect']);

function parseBodyMessages(bodyText) {
    try {
        const parsed = JSON.parse(String(bodyText ?? ''));
        const messages = Array.isArray(parsed?.messages) ? parsed.messages : null;
        if (!messages) return null;
        return messages.map((message, index) => ({
            index,
            role: typeof message?.role === 'string' ? message.role : null,
            content: typeof message?.content === 'string' ? message.content : JSON.stringify(message?.content ?? ''),
        }));
    } catch {
        return null;
    }
}

/** Every marker occurrence in the body: which message, which role, and the marker's character offset in the raw body. */
function markerOccurrences(bodyText) {
    const messages = parseBodyMessages(bodyText);
    const occurrences = new Map();
    if (messages === null) return { messages: null, occurrences };
    for (const message of messages) {
        E03E04_MARKER_PATTERN.lastIndex = 0;
        let match;
        while ((match = E03E04_MARKER_PATTERN.exec(message.content)) !== null) {
            const list = occurrences.get(match[0]) ?? [];
            list.push({ messageIndex: message.index, role: message.role, bodyIndex: String(bodyText).indexOf(match[0]) });
            occurrences.set(match[0], list);
        }
    }
    return { messages, occurrences };
}

function markerPresent(occurrences, marker, expectedRole = null) {
    const list = occurrences.get(marker) ?? [];
    if (list.length !== 1) return { ok: false, count: list.length, marker };
    if (expectedRole !== null && list[0].role !== expectedRole) return { ok: false, count: 1, marker, role: list[0].role, expectedRole };
    return { ok: true, count: 1, marker, index: list[0].bodyIndex, role: list[0].role };
}

function markerAbsent(occurrences, marker) {
    const list = occurrences.get(marker) ?? [];
    return { ok: list.length === 0, count: list.length, marker };
}

/** Structural validation of a leg's recorded manifest. Returns null when usable, or a refusal reason. */
function expectedOrderRefusal(leg) {
    const record = leg?.e03e04?.record ?? null;
    if (!record) return 'the leg has no e03e04 profile record';
    const expectedOrder = record.expectedOrder;
    if (!expectedOrder || expectedOrder.kind !== 'e03e04-expected-order' || expectedOrder.schemaVersion !== 1) return 'the record has no e03e04 expectedOrder manifest';
    if (!Array.isArray(expectedOrder.sequence)) return 'expectedOrder.sequence is not an array';
    if (!Array.isArray(expectedOrder.absent)) return 'expectedOrder.absent is not an array';
    if (!expectedOrder.blocks || !Array.isArray(expectedOrder.blocks.enabledRelative) || !Array.isArray(expectedOrder.blocks.enabledAbsolute) || !Array.isArray(expectedOrder.blocks.disabled) || !Array.isArray(expectedOrder.blocks.triggerExcluded)) return 'expectedOrder.blocks is not the four arrays the contract needs';
    if (!expectedOrder.worldBooks || typeof expectedOrder.worldBooks !== 'object') return 'expectedOrder.worldBooks is missing';
    if (!expectedOrder.history || !Array.isArray(expectedOrder.history.depthEntries) || !Array.isArray(expectedOrder.history.absoluteBlocks)) return 'expectedOrder.history is missing';
    const recomputed = e03E04Sha256(canonicalE03E04Json(expectedOrder));
    if (typeof record.expectedOrderSha256 !== 'string' || recomputed !== record.expectedOrderSha256) {
        return `expectedOrder digest mismatch (recomputed ${recomputed}, recorded ${String(record.expectedOrderSha256)})`;
    }
    if (!Object.hasOwn(E03E04_TIERS, String(record.tier)) || typeof record.seed !== 'string') return 'the record does not name a valid tier/seed';
    if (!Number.isInteger(record.blockCount)) return 'the record does not name an integer blockCount';
    return null;
}

function legIdentity(leg) {
    const identity = leg?.identity ?? null;
    if (!identity) return { ok: false, problems: ['identity is missing'] };
    const problems = [];
    if (identity.kind !== 'combination-journey-leg') problems.push(`identity.kind is ${JSON.stringify(identity.kind)}`);
    if (identity.schemaVersion !== 1) problems.push(`identity.schemaVersion is ${JSON.stringify(identity.schemaVersion)}`);
    for (const field of ['headSha', 'pinnedSha']) {
        if (typeof identity[field] !== 'string' || !/^[0-9a-f]{40}$/.test(identity[field])) problems.push(`identity.${field} is not a 40-hex commit`);
    }
    if (identity.pinnedSha !== PINNED_BASELINE_COMMIT) problems.push(`identity.pinnedSha is ${identity.pinnedSha}, not the baseline ${PINNED_BASELINE_COMMIT}`);
    for (const field of ['profile', 'tier', 'seed']) {
        if (typeof identity[field] !== 'string' || identity[field] === '') problems.push(`identity.${field} is not a non-empty string`);
    }
    if (identity.digests !== null && identity.digests !== undefined) {
        for (const [key, value] of Object.entries(identity.digests)) {
            if (value !== null && !/^[0-9a-f]{64}$/.test(String(value))) problems.push(`identity.digests.${key} is not a sha256 hex digest`);
        }
    }
    return { ok: problems.length === 0, problems };
}

/**
 * The ordered-marker contract for ONE recorded body. Returns a list of named observations (not guards yet), so the
 * comparator can pair them across subjects and the gate self-test can observe each named assertion.
 */
function markerContract(bodyText, expectedOrder) {
    const { messages, occurrences } = markerOccurrences(bodyText);
    const observations = [];
    if (messages === null) {
        observations.push({ name: 'e03e04-body-is-json', ok: false, detail: 'the recorded body is not JSON with a messages[] array' });
        return { observations, occurrences, messages };
    }
    const sequence = expectedOrder.sequence.filter(item => item.kind === 'preset-block');
    for (const item of sequence) {
        const result = markerPresent(occurrences, item.marker, item.role);
        observations.push({ name: `preset-block-present-${item.marker}`, ok: result.ok === true, detail: result });
    }
    for (const item of expectedOrder.history.absoluteBlocks.flatMap(group => group.markers.map(marker => ({ marker, role: group.role })))) {
        const result = markerPresent(occurrences, item.marker, item.role === 'system' ? 'system' : item.role);
        observations.push({ name: `preset-block-present-${item.marker}`, ok: result.ok === true, detail: result });
    }
    for (const marker of expectedOrder.blocks.disabled) observations.push({ name: `preset-block-absent-${marker}`, ok: markerAbsent(occurrences, marker).ok, detail: markerAbsent(occurrences, marker) });
    for (const marker of expectedOrder.blocks.triggerExcluded) observations.push({ name: `preset-block-absent-${marker}`, ok: markerAbsent(occurrences, marker).ok, detail: markerAbsent(occurrences, marker) });
    for (const marker of expectedOrder.absent.map(item => item.marker).filter(marker => marker.startsWith('MARKER_W'))) {
        observations.push({ name: `worldbook-absent-${marker}`, ok: markerAbsent(occurrences, marker).ok, detail: markerAbsent(occurrences, marker) });
    }

    // preset-block-order: the enabled relative markers are strictly increasing in the body, in prompt_order order.
    const ordered = sequence.map(item => ({ marker: item.marker, index: (occurrences.get(item.marker) ?? [{ bodyIndex: -1 }])[0].bodyIndex })).filter(item => item.index >= 0);
    const strictlyIncreasing = ordered.every((entry, position) => position === 0 || entry.index > ordered[position - 1].index);
    observations.push({ name: 'preset-block-order', ok: ordered.length === sequence.length && strictlyIncreasing, detail: { observed: ordered.length, expected: sequence.length, strictlyIncreasing } });

    // worldbook-order: each slot class's expected marker list appears ascending in the body. A marker the manifest
    // itself declares ABSENT (an entry the activation recipe excludes) is not part of the observed order: including it
    // made `worldbook-order-*-after` fail on BOTH subjects in dispatch 42178757887 for markers the contract's own
    // `absent` list says must be absent (fast tier: MARKER_WB0004/MARKER_WC0006). The absence is still asserted by the
    // `worldbook-absent-*` observations below, so filtering it here strengthens nothing away.
    const declaredAbsent = new Set((expectedOrder.absent ?? []).map(item => item.marker));
    for (const [bookKey, book] of Object.entries(expectedOrder.worldBooks)) {
        for (const slot of ['before', 'after']) {
            const markers = (book.slots?.[slot] ?? []).filter(marker => !declaredAbsent.has(marker));
            const indexes = markers.map(marker => (occurrences.get(marker) ?? [])[0]?.bodyIndex ?? -1);
            const ascending = indexes.every((value, position) => value >= 0 && (position === 0 || value > indexes[position - 1]));
            observations.push({ name: `worldbook-order-${bookKey}-${slot}`, ok: markers.length > 0 && ascending, detail: { markers, indexes, ascending, declaredAbsentOmitted: (book.slots?.[slot] ?? []).filter(marker => declaredAbsent.has(marker)) } });
        }
    }
    // worldbook-depth-<depth>-<role>: each expected depth group is present; its distance from the end is recorded so a
    // parity guard can compare the two subjects without inventing an offset.
    const depthObservations = [];
    for (const group of expectedOrder.history.depthEntries) {
        for (const marker of group.markers) {
            const list = occurrences.get(marker) ?? [];
            depthObservations.push({ marker, depth: group.depth, role: group.role, book: group.book, present: list.length > 0, fromEnd: list.length > 0 ? messages.length - 1 - list[0].messageIndex : null, messageRole: list[0]?.role ?? null });
        }
        const groupOk = group.markers.length > 0 && group.markers.every(marker => (occurrences.get(marker) ?? []).length > 0);
        observations.push({ name: `worldbook-depth-${group.depth}-${group.role}`, ok: groupOk, detail: { depth: group.depth, role: group.role, markers: group.markers, present: group.markers.map(marker => (occurrences.get(marker) ?? []).length) } });
    }
    // card-character-book-marker: the embedded book's expected-present markers are in the body.
    const embedded = expectedOrder.worldBooks.cardEmbedded;
    if (embedded) {
        const absentForCard = new Set((expectedOrder.absent ?? []).map(item => item.marker));
        const expectedPresent = (embedded.markers ?? []).map(item => item.marker).filter(marker => !absentForCard.has(marker));
        const present = expectedPresent.filter(marker => (occurrences.get(marker) ?? []).length > 0);
        observations.push({ name: 'card-character-book-marker', ok: expectedPresent.length > 0 && present.length === expectedPresent.length, detail: { expected: expectedPresent, present } });
    }
    return { observations, occurrences, messages, depthObservations };
}

/** Add the profile guards to the comparator's guard list. A refusal is a named false guard, never a silent skip. */
function addE03E04Guards({ add, goDrive, pinnedDrive, goRestart, pinnedRestart, handback, expectProfile }) {
    const legs = { gotavern: goDrive, pinned: pinnedDrive };
    const anyProfile = Boolean(expectProfile) || Boolean(goDrive?.e03e04) || Boolean(pinnedDrive?.e03e04);
    if (!anyProfile) return { requested: false };
    const refusals = [];
    if (expectProfile && !goDrive?.e03e04) refusals.push(`the GoTavern leg does not carry a ${expectProfile} record`);
    if (expectProfile && !pinnedDrive?.e03e04) refusals.push(`the pinned leg does not carry a ${expectProfile} record`);
    for (const [subject, leg] of Object.entries(legs)) {
        const refusal = expectedOrderRefusal(leg);
        if (refusal) refusals.push(`${subject}: ${refusal}`);
    }
    add('e03e04-profile-recorded', refusals.length === 0, refusals.length === 0, { refused: refusals.length > 0, refusals });
    if (refusals.length > 0) return { requested: true, refused: true, refusals, guardCount: 1 };

    const goExpected = goDrive.e03e04.record.expectedOrder;
    const pinExpected = pinnedDrive.e03e04.record.expectedOrder;
    // Both subjects must have measured the SAME recipe: same seed/tier/blockCount and the same manifest digest.
    const goRecord = goDrive.e03e04.record;
    const pinRecord = pinnedDrive.e03e04.record;
    add('e03e04-profile-identical',
        goRecord.seed === pinRecord.seed && goRecord.tier === pinRecord.tier && goRecord.blockCount === pinRecord.blockCount
        && goDrive.e03e04.expectedOrderSha256 === pinnedDrive.e03e04.expectedOrderSha256,
        goRecord.seed === pinRecord.seed && goRecord.tier === pinRecord.tier && goRecord.blockCount === pinRecord.blockCount
        && goDrive.e03e04.expectedOrderSha256 === pinnedDrive.e03e04.expectedOrderSha256,
        { gotavern: { seed: goRecord.seed, tier: goRecord.tier, blockCount: goRecord.blockCount, sha: goDrive.e03e04.expectedOrderSha256 }, pinned: { seed: pinRecord.seed, tier: pinRecord.tier, blockCount: pinRecord.blockCount, sha: pinnedDrive.e03e04.expectedOrderSha256 } });
    // The staged extension tier is a COST tier: a narrowed run says so and must not claim full coverage.
    add('e03e04-extension-tier-recorded',
        extensionTierOf(goDrive) !== null && extensionTierOf(pinnedDrive) !== null,
        extensionTierOf(goDrive) !== null && extensionTierOf(pinnedDrive) !== null,
        { gotavern: extensionTierOf(goDrive), pinned: extensionTierOf(pinnedDrive), narrowed: extensionTierOf(goDrive) !== 'full' });
    add('e03e04-extensions-installed',
        extensionBatchOk(goDrive), extensionBatchOk(pinnedDrive),
        { gotavern: extensionBatchDetail(goDrive), pinned: extensionBatchDetail(pinnedDrive) });

    // ---- THE APPLIED-STATE GUARDS (added after dispatch 42173399186) ------------------------------------------
    // A selected preset is not an applied preset. The leg records `browser.presetApplied` (declared prompts + the
    // ACTIVE order row for the live character id + the collection markers the assembly uses); these guards require
    // both subjects to show it, and require the artifact to keep the STAGED and KIT preset digests apart.
    const stagedPresetEvidence = leg => {
        const record = leg?.e03e04?.record ?? null;
        const preset = record?.preset ?? null;
        const digests = leg?.identity?.digests ?? null;
        const expectedTotal = record?.expectedOrder?.totalPromptCount ?? null;
        const problems = [];
        if (!preset) problems.push('the record carries no preset member');
        if (!digests) problems.push('the leg identity carries no digests');
        if (preset) {
            if (!/^[0-9a-f]{64}$/.test(String(preset.sha256 ?? ''))) problems.push('record.preset.sha256 is not a sha256');
            if (!/^[0-9a-f]{64}$/.test(String(preset.kitSha256 ?? ''))) problems.push('record.preset.kitSha256 is not a sha256');
            if (preset.transformation?.kind !== 'add-active-prompt-order-row') problems.push('record.preset.transformation is not the active-order-row fix');
            if (!Array.isArray(preset.promptOrderCharacterIds) || !preset.promptOrderCharacterIds.map(String).includes(String(preset.activePromptOrderCharacterId))) problems.push('the staged prompt_order does not carry its own active row id');
            if (!Number.isInteger(preset.activePromptOrderCharacterId)) problems.push('record.preset.activePromptOrderCharacterId is not an integer');
            if (Number.isInteger(expectedTotal) && preset.declaredPrompts !== expectedTotal) problems.push(`record.preset.declaredPrompts ${preset.declaredPrompts} != expectedOrder.totalPromptCount ${expectedTotal}`);
            if (Number.isInteger(preset.declaredPrompts) && preset.activeOrderLength !== preset.declaredPrompts) problems.push(`the active order length ${preset.activeOrderLength} != declared prompts ${preset.declaredPrompts}`);
        }
        if (preset && digests) {
            if (digests.preset !== preset.sha256) problems.push('the identity preset digest is not the STAGED preset digest');
            if (digests.kitPreset !== preset.kitSha256) problems.push('the identity kitPreset digest is not the KIT preset digest');
        }
        return { ok: problems.length === 0, problems, digests: digests ? { preset: digests.preset, kitPreset: digests.kitPreset } : null };
    };
    const goStagedPreset = stagedPresetEvidence(goDrive);
    const pinStagedPreset = stagedPresetEvidence(pinnedDrive);
    add('e03e04-preset-document-recorded', goStagedPreset.ok, pinStagedPreset.ok, { gotavern: goStagedPreset, pinned: pinStagedPreset });

    const appliedEvidence = leg => {
        const applied = leg?.browser?.presetApplied ?? null;
        if (!applied) return { ok: false, reason: 'the leg records no browser.presetApplied' };
        const observed = applied.observed ?? null;
        return {
            ok: applied.ok === true,
            problems: applied.problems ?? null,
            activeCharacterId: observed?.activeCharacterId ?? null,
            declaredPrompts: observed?.declaredPrompts ?? null,
            orderRowFound: observed?.orderRowFound ?? null,
            orderLength: observed?.orderLength ?? null,
            collectionMarkers: [...new Set(observed?.collectionMarkers ?? [])].sort(),
        };
    };
    const goApplied = appliedEvidence(goDrive);
    const pinApplied = appliedEvidence(pinnedDrive);
    const appliedParity = goApplied.ok === true && pinApplied.ok === true
        && goApplied.activeCharacterId === pinApplied.activeCharacterId
        && goApplied.declaredPrompts === pinApplied.declaredPrompts
        && goApplied.orderLength === pinApplied.orderLength
        && JSON.stringify(goApplied.collectionMarkers) === JSON.stringify(pinApplied.collectionMarkers);
    add('e03e04-preset-applied', goApplied.ok === true && appliedParity, pinApplied.ok === true && appliedParity, { gotavern: goApplied, pinned: pinApplied });

    const embeddedEvidence = leg => {
        const embedded = leg?.browser?.embeddedBook ?? null;
        if (!embedded) return { ok: false, reason: 'the leg records no browser.embeddedBook' };
        const verified = embedded.verified ?? null;
        return {
            ok: embedded.ok === true && verified?.ok === true && String(verified?.bound ?? '') === String(embedded.bookName ?? '\u0000') && Array.isArray(embedded.via) && embedded.via.length > 0,
            bookName: embedded.bookName ?? null,
            bound: verified?.bound ?? null,
            worldListed: Array.isArray(verified?.names) ? verified.names.includes(embedded.bookName) : null,
            via: embedded.via ?? null,
            saved: embedded.save?.saved === true,
            populated: embedded.save?.evidence?.populated === true,
        };
    };
    const goEmbedded = embeddedEvidence(goDrive);
    const pinEmbedded = embeddedEvidence(pinnedDrive);
    add('e03e04-embedded-book-imported', goEmbedded.ok === true, pinEmbedded.ok === true, { gotavern: goEmbedded, pinned: pinEmbedded });

    // THE ORDERED MARKER CONTRACT, per subject, then required on both.
    const goContract = markerContract(bodyOf(firstRequest(goDrive, 'turn-1-armed')), goExpected);
    const pinContract = markerContract(bodyOf(firstRequest(pinnedDrive, 'turn-1-armed')), pinExpected);
    const goByName = new Map(goContract.observations.map(item => [item.name, item]));
    const pinByName = new Map(pinContract.observations.map(item => [item.name, item]));
    const names = [...new Set([...goByName.keys(), ...pinByName.keys()])].sort();
    for (const name of names) {
        const goObs = goByName.get(name);
        const pinObs = pinByName.get(name);
        add(name, goObs?.ok === true, pinObs?.ok === true, { gotavern: goObs?.detail ?? null, pinned: pinObs?.detail ?? null });
    }
    // worldbook-depth-from-end-parity: both subjects splice the same depth group to the same distance from the end.
    // This is a PARITY assertion: it does not invent an offset, it requires the two subjects to agree on the measured
    // one (the three-slot kit's measured offset is the precedent).
    const goDepth = new Map((goContract.depthObservations ?? []).map(item => [item.marker, item]));
    const pinDepth = new Map((pinContract.depthObservations ?? []).map(item => [item.marker, item]));
    const depthParity = [...goDepth.keys()].filter(marker => pinDepth.has(marker)).map(marker => ({ marker, gotavern: goDepth.get(marker).fromEnd, pinned: pinDepth.get(marker).fromEnd }));
    add('worldbook-depth-from-end-parity', depthParity.length > 0 && depthParity.every(item => item.gotavern !== null && item.gotavern === item.pinned), depthParity.length > 0 && depthParity.every(item => item.gotavern !== null && item.gotavern === item.pinned), { pairs: depthParity });

    // qr-to-helper-chain: the page-level chain ran on both subjects (recorded) AND the body carries the QR-written
    // value inside the helper's readback, before/with the QR injection marker.
    const chainFor = leg => {
        const chain = leg?.browser?.profileChain ?? null;
        const body = bodyOf(firstRequest(leg, 'turn-1-armed'));
        const writeMarker = 'COMB_QR_WROTE_MARKER';
        const helperReadbackLine = String(body).split('\n').find(line => line.includes('COMB_VAR_CHAT')) ?? '';
        return {
            recorded: chain?.readbackCarriesWrite === true,
            helperReadbackCarriesWrite: helperReadbackLine.includes(writeMarker),
            qrInjectionPresent: String(body).includes('COMB_QR_INJECTED_MARKER'),
            helperReadbackPresent: helperReadbackLine.length > 0,
        };
    };
    const goChain = chainFor(goDrive);
    const pinChain = chainFor(pinnedDrive);
    const chainOk = value => value.recorded && value.helperReadbackCarriesWrite && value.qrInjectionPresent && value.helperReadbackPresent;
    add('qr-to-helper-chain', chainOk(goChain), chainOk(pinChain), { gotavern: goChain, pinned: pinChain });
    // helper-variable-marker: the helper's readback reached the body (the helper is not silently off).
    add('helper-variable-marker', goChain.helperReadbackPresent, pinChain.helperReadbackPresent, { gotavern: goChain.helperReadbackPresent, pinned: pinChain.helperReadbackPresent });

    // extension-effect-<name>: every installed extension has its wire-effect classification AND was served by the
    // product's static mount. No provider marker is invented (design section 8).
    const extensionNames = [...new Set([
        ...((goDrive.extensions?.installed ?? []).map(entry => entry.name)),
        ...((pinnedDrive.extensions?.installed ?? []).map(entry => entry.name)),
    ])].sort();
    const effectFor = (leg, name) => {
        const entry = (leg.extensions?.installed ?? []).find(item => item.name === name) ?? null;
        const served = (leg.extensions?.serveEvidence ?? []).find(item => item.name === name) ?? null;
        return { entry: Boolean(entry), commit: entry?.commit ?? null, status: entry?.wireEffect?.status ?? null, evidence: Boolean(entry?.wireEffect?.evidence), served: served?.ok === true };
    };
    for (const name of extensionNames) {
        const goEffect = effectFor(goDrive, name);
        const pinEffect = effectFor(pinnedDrive, name);
        const effectOk = effect => effect.entry && effect.served && E03E04_ABSENT_STATUSES.has(String(effect.status)) && effect.evidence;
        add(`extension-effect-${name}`, effectOk(goEffect), effectOk(pinEffect), { gotavern: goEffect, pinned: pinEffect });
    }

    // ordered-message-ids: the rendered ids are unique and cover the chat array on both subjects, and the ordered
    // user-message markers are IDENTICAL (a duplicated user message would break the sequence).
    const messageIdsFor = leg => {
        const record = leg?.browser?.orderedMessageIds ?? null;
        return {
            present: Boolean(record),
            domIdsUnique: record?.domIdsUnique === true,
            domIdsCoverChat: record?.domIdsCoverChat === true,
            userMarkers: (record?.userMarkers ?? []).map(item => item.marker),
        };
    };
    const goIds = messageIdsFor(goDrive);
    const pinIds = messageIdsFor(pinnedDrive);
    add('ordered-message-ids',
        goIds.present && goIds.domIdsUnique && goIds.domIdsCoverChat && goIds.userMarkers.length > 0 && JSON.stringify(goIds.userMarkers) === JSON.stringify(pinIds.userMarkers),
        pinIds.present && pinIds.domIdsUnique && pinIds.domIdsCoverChat && pinIds.userMarkers.length > 0 && JSON.stringify(goIds.userMarkers) === JSON.stringify(pinIds.userMarkers),
        { gotavern: goIds, pinned: pinIds });

    // HARNESS-NON-DISCRIMINATING (AGENTS 50): the harness's capture must MOVE when the knobs move. With every knob
    // off both subjects producing the armed body is the exact failure this guard names.
    //
    // WHAT DISPATCH 42178757887 MEASURED, and why the expectation changed: the WOLRD-INFO-OFF arm deliberately keeps
    // the complex preset applied - it turns off world info only - so its body MUST still carry the enabled preset
    // markers (both subjects recorded 6). The old clause `wiOffPresetMarkers === 0` asserted the opposite and was red
    // on both subjects with a correct harness. The discriminating claims are now:
    //   * preset-off arm: 0 preset markers (knob moved);
    //   * world-info-off arm: the SAME preset markers as the armed body (its knob did not move);
    //   * each control body differs from the armed body AND from the other control body (the two knobs are distinct).
    const harnessFor = leg => {
        const armed = firstRequest(leg, 'turn-1-armed');
        const presetOff = firstRequest(leg, 'control-preset-off');
        const wiOff = firstRequest(leg, 'control-wi-off');
        const armedBody = bodyOf(armed);
        const presetOffBody = bodyOf(presetOff);
        const wiOffBody = bodyOf(wiOff);
        const enabled = leg?.e03e04?.record?.expectedOrder?.blocks?.enabledRelative ?? [];
        const count = body => enabled.filter(marker => body.includes(marker)).length;
        return {
            armed: Boolean(armed), presetOff: Boolean(presetOff), wiOff: Boolean(wiOff),
            armedDiffersFromPresetOff: Boolean(armed && presetOff) && armed.sha256 !== presetOff.sha256,
            armedDiffersFromWiOff: Boolean(armed && wiOff) && armed.sha256 !== wiOff.sha256,
            presetOffDiffersFromWiOff: Boolean(presetOff && wiOff) && presetOff.sha256 !== wiOff.sha256,
            armedPresetMarkers: count(armedBody),
            presetOffPresetMarkers: count(presetOffBody),
            wiOffPresetMarkers: count(wiOffBody),
        };
    };
    const goHarness = harnessFor(goDrive);
    const pinHarness = harnessFor(pinnedDrive);
    const harnessOk = value => value.armed && value.presetOff && value.wiOff
        && value.armedDiffersFromPresetOff && value.armedDiffersFromWiOff && value.presetOffDiffersFromWiOff
        && value.armedPresetMarkers > 0 && value.presetOffPresetMarkers === 0 && value.wiOffPresetMarkers === value.armedPresetMarkers;
    add('HARNESS-NON-DISCRIMINATING', harnessOk(goHarness), harnessOk(pinHarness), {
        gotavern: goHarness,
        pinned: pinHarness,
        rule: 'AGENTS 50: identical captures when the knobs move means the harness cannot discriminate; the verdict is red by this name',
    });

    // THE RESTART / HAND-BACK CAPTURES CARRY THE SAME CONTRACT (design section 5.8). The manifest is the SAME record
    // the drive staged (the record file is read back and digest-verified by those legs).
    const restartContract = (restartLeg, bodyCaseName, expected) => {
        const body = bodyOf(firstRequest(restartLeg, bodyCaseName));
        const { occurrences } = markerOccurrences(body);
        const enabled = (expected?.sequence ?? []).filter(item => item.kind === 'preset-block').map(item => item.marker);
        const absentWorld = (expected?.absent ?? []).map(item => item.marker).filter(marker => marker.startsWith('MARKER_W'));
        return {
            captured: Boolean(body),
            present: enabled.filter(marker => (occurrences.get(marker) ?? []).length === 1).length,
            expected: enabled.length,
            absentWorldLeaked: absentWorld.filter(marker => (occurrences.get(marker) ?? []).length > 0),
        };
    };
    if (goRestart && pinnedRestart) {
        const goRestartContract = restartContract(goRestart, 'turn-after-restart', goExpected);
        const pinRestartContract = restartContract(pinnedRestart, 'turn-after-restart', pinExpected);
        const restartOk = value => value.captured && value.expected > 0 && value.present === value.expected && value.absentWorldLeaked.length === 0;
        add('e03e04-restart-marker-contract', restartOk(goRestartContract), restartOk(pinRestartContract), { gotavern: goRestartContract, pinned: pinRestartContract });
    }
    if (handback) {
        const handbackContract = restartContract(handback, 'turn-handback', goExpected);
        const handbackOk = handbackContract.captured && handbackContract.expected > 0 && handbackContract.present === handbackContract.expected && handbackContract.absentWorldLeaked.length === 0;
        add('e03e04-handback-marker-contract', handbackOk, handbackOk, { handback: handbackContract });
    }

    // ---- ARTIFACT IDENTITY (design section 6: "record an artifact with a wrong head SHA" must fail closed) ----
    const goIdentity = legIdentity(goDrive);
    const pinIdentity = legIdentity(pinnedDrive);
    add('artifact-identity-complete', goIdentity.ok, pinIdentity.ok, { gotavern: goIdentity.problems, pinned: pinIdentity.problems });
    const parityProblems = [];
    if (goDrive.identity && pinnedDrive.identity) {
        if (goDrive.identity.headSha !== pinnedDrive.identity.headSha) parityProblems.push('the two legs name different head SHAs');
        if (goDrive.identity.pinnedSha !== pinnedDrive.identity.pinnedSha) parityProblems.push('the two legs name different pinned SHAs');
        if (goDrive.identity.tier !== pinnedDrive.identity.tier || goDrive.identity.seed !== pinnedDrive.identity.seed) parityProblems.push('the two legs name different tier/seed');
    } else {
        parityProblems.push('an identity is missing');
    }
    add('artifact-identity-parity', parityProblems.length === 0, parityProblems.length === 0, { problems: parityProblems });

    return { requested: true, refused: false, guardCount: names.length + 16 };
}

function extensionTierOf(leg) {
    const tier = leg?.extensions?.tier ?? leg?.identity?.extensionTier ?? null;
    return Object.hasOwn(EXTENSION_TIERS, String(tier)) ? tier : null;
}

function extensionBatchOk(leg) {
    const record = leg?.extensions ?? null;
    if (!record) return false;
    const expected = EXTENSION_TIERS[record.tier];
    return Number.isInteger(expected) && record.installedCount === expected && record.expected === expected
        && Array.isArray(record.installed) && record.installed.length === expected;
}

function extensionBatchDetail(leg) {
    return leg?.extensions ? { tier: leg.extensions.tier, installedCount: leg.extensions.installedCount, expected: leg.extensions.expected } : null;
}

/**
 * FAIL-CLOSED ARTIFACT VERIFIER (design section 6: a wrong head SHA must be refused, not warned about).
 * `identity` is the small evidence descriptor the workflow writes beside the legs; `documents` maps a label to
 * `{ path, sha256 }`. Every required field is checked, every digest is RE-DERIVED from the file on disk, and the
 * pinned baseline is required exactly. Returns `{ ok, problems }`; the CLI mode exits 1 when it is not ok.
 */
export function verifyArtifactIdentity(identity, { documents = null } = {}) {
    const problems = [];
    if (!identity || typeof identity !== 'object' || Array.isArray(identity)) return { ok: false, problems: ['the identity is not a JSON object'] };
    if (identity.kind !== EVIDENCE_ARTIFACT_KIND) problems.push(`identity.kind is ${JSON.stringify(identity.kind)}, expected ${JSON.stringify(EVIDENCE_ARTIFACT_KIND)}`);
    if (identity.schemaVersion !== EVIDENCE_SCHEMA_VERSION) problems.push(`identity.schemaVersion is ${JSON.stringify(identity.schemaVersion)}, expected ${EVIDENCE_SCHEMA_VERSION}`);
    if (typeof identity.headSha !== 'string' || !/^[0-9a-f]{40}$/.test(identity.headSha)) problems.push('identity.headSha is not a 40-hex commit');
    if (identity.pinnedSha !== PINNED_BASELINE_COMMIT) problems.push(`identity.pinnedSha is ${JSON.stringify(identity.pinnedSha)}, not the baseline ${PINNED_BASELINE_COMMIT}`);
    for (const field of ['profile', 'tier', 'seed']) {
        if (typeof identity[field] !== 'string' || identity[field] === '') problems.push(`identity.${field} is not a non-empty string`);
    }
    const docs = documents ?? identity.documents ?? null;
    if (docs === null || typeof docs !== 'object' || Array.isArray(docs) || Object.keys(docs).length === 0) {
        problems.push('identity.documents is missing or empty');
    } else {
        for (const [label, entry] of Object.entries(docs)) {
            if (!entry || typeof entry !== 'object' || typeof entry.path !== 'string' || !/^[0-9a-f]{64}$/.test(String(entry.sha256 ?? ''))) {
                problems.push(`document ${label} does not name a path and sha256`);
                continue;
            }
            try {
                const bytes = fs.readFileSync(path.resolve(entry.path));
                const actual = createHash('sha256').update(bytes).digest('hex');
                if (actual !== entry.sha256) problems.push(`document ${label} digest is ${actual}, recorded ${entry.sha256}`);
            } catch (error) {
                problems.push(`document ${label} cannot be read: ${String(error?.message ?? error)}`);
            }
        }
    }
    return { ok: problems.length === 0, problems };
}

export function compareCombinationJourney({ goDrive, pinnedDrive, goRestart = null, pinnedRestart = null, handback = null, expectProfile = null }) {
    const guards = [];
    const asymmetries = [];
    const add = (name, goValue, pinValue, detail = null) => {
        const go = goValue === true;
        const pinned = pinValue === true;
        guards.push(guard(name, go, pinned, detail));
        if (go !== pinned) asymmetries.push({ guard: name, gotavern: go, pinned });
    };
    const observed = (name, detail = null) => add(name, stepOk(goDrive, name), stepOk(pinnedDrive, name),
        detail ?? { gotavern: detailOf(goDrive, name), pinned: detailOf(pinnedDrive, name) });

    // ---- faithfulness ---------------------------------------------------------------------------------
    add('go-leg-is-a-gotavern-drive', goDrive.phase === 'drive' && goDrive.subject === 'gotavern',
        pinnedDrive.phase === 'drive' && pinnedDrive.subject === 'pinned');
    add('both-legs-have-no-failed-step', (goDrive.steps ?? []).every(entry => entry.ok === true), (pinnedDrive.steps ?? []).every(entry => entry.ok === true),
        { gotavern: (goDrive.steps ?? []).filter(entry => !entry.ok).map(entry => entry.name), pinned: (pinnedDrive.steps ?? []).filter(entry => !entry.ok).map(entry => entry.name) });
    // PAGE ERRORS ARE JUDGED AS A PARITY PROPERTY, NOT AS "ZERO ON BOTH". The pinned frontend raises its own
    // endSwipe TypeError under a swipe/generation race, and it appears IDENTICALLY on both subjects (same stack,
    // same script line numbers; only the ephemeral port differs). A drop-in cannot be required to remove an error
    // the oracle itself raises -- what it MUST NOT do is add one of its own. This guard therefore fails when the
    // GoTavern leg raises an error the pinned leg does not, and the inherited ones are recorded (not dropped) in
    // the guard detail and in the comparison's captures. It was "zero on both" until run 41369042127, where the
    // only red was that inherited error on a five-leg-green run; recording it as inherited is the honest parity
    // claim, and the stricter-than-before asymmetry rule is what keeps it discriminating.
    const normalizePageError = entry => String(entry).replace(/https?:\/\/127\.0\.0\.1:\d+/g, '[origin]');
    const goPageErrors = (goDrive.pageErrors ?? []).map(normalizePageError);
    const pinnedPageErrors = (pinnedDrive.pageErrors ?? []).map(normalizePageError);
    const pinnedPageErrorSet = new Set(pinnedPageErrors);
    const inheritedPageErrors = goPageErrors.filter(entry => pinnedPageErrorSet.has(entry));
    const asymmetricPageErrors = goPageErrors.filter(entry => !pinnedPageErrorSet.has(entry));
    add('page-errors-are-not-gotavern-specific', asymmetricPageErrors.length === 0, asymmetricPageErrors.length === 0,
        { gotavern: (goDrive.pageErrors ?? []).slice(0, 4), pinned: (pinnedDrive.pageErrors ?? []).slice(0, 4), inherited: inheritedPageErrors.length, asymmetric: asymmetricPageErrors.slice(0, 4) });
    add('fixture-and-extension-recorded',
        Boolean(goDrive.fixture?.card?.sha256) && goDrive.fixture?.apiSurface?.pinned === true,
        Boolean(pinnedDrive.fixture?.card?.sha256) && pinnedDrive.fixture?.apiSurface?.pinned === true);

    // ---- WIRE: per-capture byte equality --------------------------------------------------------------
    const goCases = byCase(goDrive);
    const pinCases = byCase(pinnedDrive);
    const common = Object.keys(goCases).filter(name => name in pinCases).sort();
    const missingPairs = Object.keys(goCases).filter(name => !(name in pinCases)).concat(Object.keys(pinCases).filter(name => !(name in goCases)));
    const mismatches = common
        .filter(name => JSON.stringify(shaList(goCases[name])) !== JSON.stringify(shaList(pinCases[name])))
        .map(name => {
            const goRequests = goCases[name] ?? [];
            const pinnedRequests = pinCases[name] ?? [];
            const pairs = Math.min(goRequests.length, pinnedRequests.length);
            const differences = [];
            for (let index = 0; index < pairs; index += 1) {
                if (goRequests[index].sha256 === pinnedRequests[index].sha256) continue;
                differences.push({
                    index,
                    gotavernSha: goRequests[index].sha256,
                    pinnedSha: pinnedRequests[index].sha256,
                    ...firstBodyDifference(goRequests[index].body, pinnedRequests[index].body),
                });
            }
            return {
                case: name,
                gotavern: shaList(goRequests),
                pinned: shaList(pinnedRequests),
                gotavernBytes: goRequests.map(entry => entry.byteLength),
                pinnedBytes: pinnedRequests.map(entry => entry.byteLength),
                // BOUNDED DIAGNOSIS: path + char offset + capped excerpts of the first differing body pair.
                firstDifference: differences[0] ?? null,
                differences,
            };
        });
    add('both-subjects-captured-the-same-turns', missingPairs.length === 0, missingPairs.length === 0, { missingPairs });
    add('nodeEqualsGo-per-capture', common.length >= 5 && mismatches.length === 0, common.length >= 5 && mismatches.length === 0,
        {
            commonCases: common.length,
            mismatchCases: mismatches.map(entry => entry.case),
            firstDifference: mismatches[0]?.firstDifference ?? null,
            mismatches,
        });
    add('all-captures-were-streamed', (goDrive.requests ?? []).every(entry => entry.requestedStream === true), (pinnedDrive.requests ?? []).every(entry => entry.requestedStream === true));
    add('peer-served-sse', (goDrive.requests ?? []).every(entry => entry.served?.wire === 'sse'), (pinnedDrive.requests ?? []).every(entry => entry.served?.wire === 'sse'));

    // ---- the armed journey, fact by fact, from each subject's OWN steps --------------------------------
    for (const name of [
        'world-info-selected-after-boot', 'world-info-persisted-after-boot', 'user-name-set', 'drive-injections-active-in-page',
        'character-opened', 'character-scoped-regex-allowed-and-visible', 'complex-preset-selected',
        'authors-note-applied', 'helper-variables-written', 'helper-closure-inside-iframe',
        'quick-reply-created-and-executed', 'turn-1-request-captured', 'turn-1-streaming-requested',
        'turn-1-preset-pieces-in-request', 'turn-1-world-info-three-slots-placed', 'turn-1-variables-in-request',
        'turn-1-quick-reply-in-request', 'turn-1-authors-note-in-request', 'regex-rewrote-visible-message',
        'turn-2-history-carries-regex-rewritten-text', 'turn-2-history-carries-turn-1',
    ]) observed(name);

    // The verbs are only claimed where their own step fired on both subjects. A verb the harness could not drive
    // (a send swallowed by a page left busy by a PRESET SWITCH) is red here by name, never skipped.
    for (const name of ['swipe-produced-a-request', 'swipe-state-moved', 'regenerate-produced-a-request', 'continue-produced-a-request',
        'branch-created-through-frontend-bookmarks', 'group-chat-opened', 'group-turn-produced-request',
        'returned-to-journey-chat', 'final-turn-earned-request', 'journey-chat-written',
        'disk-chat-carries-regex-rewritten-reply', 'disk-chat-carries-branch-metadata']) observed(name);

    // ---- the GROUP CHAT is a PERSISTED artifact too (task-19; dispatch 42182251438) --------------------
    // The probe flushes the group turn through the product's own `saveChatConditional` (which routes to
    // `saveGroupChat` while `selected_group` is set) and records the GROUP-CHAT file that carried it -- group chats
    // live in `<user>/group chats/<id>.jsonl` (pinned src/endpoints/chats.js:922-947, constants.js:16-25; Go
    // internal/startup/storage.go:68 mirrors it), NOT in `<user>/chats`. The previous assertion polled only `chats`,
    // so a successful save still produced `filesCarrying: []` on both subjects: a reader-scope defect. This guard
    // requires BOTH subjects to have persisted the group turn AND the persisted message projections to be equal
    // (the group request bytes are already compared by nodeEqualsGo-per-capture; this is the durable side).
    const groupPersistFor = leg => {
        const persisted = leg?.browser?.groupTurnPersist ?? null;
        if (!persisted) return { ok: false, reason: 'the leg records no browser.groupTurnPersist' };
        const files = Array.isArray(persisted.filesCarrying) ? persisted.filesCarrying.map(String) : [];
        const projection = (persisted.persisted ?? []).map(entry => ({ file: entry.file ?? null, messageCount: entry.messageCount ?? null, messages: entry.messages ?? [] }));
        const groupChatFile = files.find(name => name.startsWith('group chats/')) ?? null;
        return {
            ok: persisted.ok === true
                && files.length > 0
                && groupChatFile !== null
                && projection.length > 0
                && projection.every(entry => entry.messages.some(message => String(message.mes ?? '').includes('COMB_GROUP_TURN'))),
            expected: persisted.expected ?? null,
            saved: persisted.saved?.ok === true,
            filesCarrying: files,
            groupChatFile,
            messageCounts: projection.map(entry => entry.messageCount),
            messages: projection.map(entry => entry.messages),
        };
    };
    const goGroupPersist = groupPersistFor(goDrive);
    const pinGroupPersist = groupPersistFor(pinnedDrive);
    const groupPersistParity = goGroupPersist.ok === true && pinGroupPersist.ok === true
        && JSON.stringify(goGroupPersist.messages) === JSON.stringify(pinGroupPersist.messages)
        && JSON.stringify(goGroupPersist.expected) === JSON.stringify(pinGroupPersist.expected);
    add('group-chat-persisted-parity', goGroupPersist.ok === true && groupPersistParity, pinGroupPersist.ok === true && groupPersistParity,
        { gotavern: goGroupPersist, pinned: pinGroupPersist });

    // ---- discrimination (AGENTS 50): the harness's captures move when its knobs move -------------------
    observed('preset-off-turn-captured');
    observed('preset-off-request-lacks-preset-markers');
    observed('wi-off-turn-captured');
    observed('wi-off-request-lacks-world-info');
    observed('preset-restored-after-control');
    observed('world-info-restored-after-control');
    observed('world-info-selection-persisted-to-disk');
    add('control-captures-differ-from-armed',
        Boolean(firstRequest(goDrive, 'control-preset-off')) && firstRequest(goDrive, 'control-preset-off').sha256 !== firstRequest(goDrive, 'turn-1-armed')?.sha256,
        Boolean(firstRequest(pinnedDrive, 'control-preset-off')) && firstRequest(pinnedDrive, 'control-preset-off').sha256 !== firstRequest(pinnedDrive, 'turn-1-armed')?.sha256);

    // ---- reload survival ------------------------------------------------------------------------------
    for (const name of ['chat-saved-and-reloaded', 'reload-chat-reopened', 'reload-preserved-history', 'reload-world-info-persisted-from-disk', 'reload-ready-to-send', 'reload-prompt-manager-armed', 'after-reload-turn-captured',
        'reload-helper-reran-and-reinjected-variables', 'reload-injections-active-in-page',
        'after-reload-request-carries-surviving-state', 'after-reload-request-carries-preset-and-regex',
        'after-reload-request-carries-variables-and-qr']) observed(name);

    // ---- restart survival (over the SAME trees) -------------------------------------------------------
    let restartReport = null;
    if (goRestart && pinnedRestart) {
        add('restart-legs-are-restart-phase', goRestart.phase === 'restart', pinnedRestart.phase === 'restart');
        for (const name of ['restart-found-the-journey-chat', 'restart-reopened-the-saved-chat', 'restart-chat-ready', 'restart-prompt-manager-armed', 'restart-world-info-selected',
            'after-restart-helper-reran', 'restart-injections-active-in-page',
            'after-restart-request-captured', 'after-restart-request-carries-preset-and-world-info',
            'after-restart-request-carries-history', 'after-restart-request-carries-variables-and-qr',
            'after-restart-request-carries-authors-note', 'after-restart-request-carries-regex-rewritten-history']) {
            add(name, stepOk(goRestart, name), stepOk(pinnedRestart, name), { gotavern: detailOf(goRestart, name), pinned: detailOf(pinnedRestart, name) });
        }
        const restartPairs = Object.keys(byCase(goRestart)).filter(name => name in byCase(pinnedRestart)).sort();
        const restartMismatch = restartPairs.filter(name => JSON.stringify(shaList(byCase(goRestart)[name])) !== JSON.stringify(shaList(byCase(pinnedRestart)[name])));
        const restartDiff = restartMismatch.map(name => {
            const goReq = (byCase(goRestart)[name] ?? [])[0] ?? null;
            const pinnedReq = (byCase(pinnedRestart)[name] ?? [])[0] ?? null;
            return {
                case: name,
                gotavernBytes: goReq?.byteLength ?? null,
                pinnedBytes: pinnedReq?.byteLength ?? null,
                firstDifference: goReq && pinnedReq ? firstBodyDifference(goReq.body, pinnedReq.body) : null,
            };
        });
        add('restart-capture-equality', restartPairs.length >= 1 && restartMismatch.length === 0, restartPairs.length >= 1 && restartMismatch.length === 0,
            { pairs: restartPairs, mismatch: restartMismatch, differences: restartDiff });
        // Recorded in the artifact so the restart red is readable: `restart-capture-equality` is a per-subject pair
        // guard, and the body diff names the differing member exactly like the drive captures do.
        restartReport = { pairs: restartPairs, mismatch: restartMismatch, differences: restartDiff, firstDifference: restartDiff.find(entry => entry.firstDifference)?.firstDifference ?? null };
    } else {
        add('restart-legs-supplied', false, false, { reason: 'no restart pair supplied: the restart claim is NOT-OBSERVED' });
    }

    // ---- hand-back: pinned Node over the GoTavern-written tree ------------------------------------------
    if (handback) {
        add('handback-world-info-selected', stepOk(handback, 'handback-world-info-selected'), stepOk(handback, 'handback-world-info-selected'));
        add('handback-pinned-read-the-gotavern-chat', stepOk(handback, 'handback-tree-has-the-journey-chat') && stepOk(handback, 'handback-opened-the-gotavern-chat') && stepOk(handback, 'handback-chat-ready') && stepOk(handback, 'handback-prompt-manager-armed'),
            stepOk(handback, 'handback-tree-has-the-journey-chat') && stepOk(handback, 'handback-opened-the-gotavern-chat'));
        add('handback-pinned-continued-and-persisted', stepOk(handback, 'handback-continued-and-reached-provider') && stepOk(handback, 'handback-persisted-its-turn'),
            stepOk(handback, 'handback-continued-and-reached-provider') && stepOk(handback, 'handback-persisted-its-turn'));
    } else {
        add('handback-leg-supplied', false, false, { reason: 'no hand-back leg supplied: the Node -> Go -> Node claim is NOT-OBSERVED' });
    }

    // ---- THE E03+E04 PROFILE CONTRACT (only when a leg carries a profile record) ----------------------
    const profileResult = addE03E04Guards({ add, goDrive, pinnedDrive, goRestart, pinnedRestart, handback, expectProfile });

    // ---- the durable chat -----------------------------------------------------------------------------
    // THE DURABLE CHAT, NORMALISED ONLY FOR THE FILENAME AND THE BRANCH *NAMES*:
    //   * chat FILE names carry the chat's creation timestamp (one per run), so the file NAME is not part of the
    //     product contract; the file's message sequence is;
    //   * `extra.branches` stores the branch CHAT NAMES, which embed that same timestamp. The BRANCH EXISTENCE and
    //     COUNT are the product fact; the generated name is volatile by construction and is declared here rather than
    //     compared. Everything else (name, is_user, mes, swipes, swipe_id) is compared verbatim.
    const messageShape = file => ({
        messages: (file.messages ?? []).map(message => ({
            name: message.name ?? null,
            is_user: message.is_user === true,
            mes: String(message.mes ?? ''),
            swipes: Array.isArray(message.swipes) ? message.swipes.map(String) : null,
            swipe_id: message.swipe_id ?? null,
            branchCount: Array.isArray(message.branches) ? message.branches.length : null,
        })),
    });
    const journeyFiles = report => Object.values(report.disk?.projection ?? {})
        .filter(file => (file.messages ?? []).some(message => String(message.mes).includes('COMB_')))
        .map(messageShape)
        // THE SORT KEY IS THE MESSAGE CONTENT, NOT THE FIRST MESSAGE OR THE FILE NAME. Two journey files (the main
        // chat and its branch) legitimately start with the SAME greeting, and the file names carry the creation
        // timestamp, so sorting by either left the pair order dependent on the directory listing (measured in
        // dispatch 42178757887: the branch/main order differed between trees while the content was equal). Sorting on
        // the projected content makes equal trees compare equal and keeps unequal trees deterministic.
        .sort((first, second) => JSON.stringify(first.messages).localeCompare(JSON.stringify(second.messages)));
    const goDisk = journeyFiles(goDrive);
    const pinDisk = journeyFiles(pinnedDrive);
    add('both-subjects-wrote-a-journey-chat', goDisk.length > 0, pinDisk.length > 0);
    const diskEqual = JSON.stringify(goDisk) === JSON.stringify(pinDisk);
    const projectionDifference = (() => {
        if (diskEqual) return null;
        const limit = Math.max(goDisk.length, pinDisk.length);
        for (let index = 0; index < limit; index += 1) {
            const goFile = goDisk[index] ?? null;
            const pinnedFile = pinDisk[index] ?? null;
            if (JSON.stringify(goFile) === JSON.stringify(pinnedFile)) continue;
            return {
                fileIndex: index,
                gotavernMessages: goFile?.messages?.length ?? null,
                pinnedMessages: pinnedFile?.messages?.length ?? null,
                firstDifference: firstBodyDifference(JSON.stringify(goFile ?? null), JSON.stringify(pinnedFile ?? null)),
            };
        }
        return null;
    })();
    add('journey-chat-projection-equal-modulo-declared-volatile', diskEqual, diskEqual,
        { gotavernFiles: goDisk.length, pinnedFiles: pinDisk.length, firstDifference: projectionDifference });

    const failedGuards = guards.filter(entry => entry.ok !== true).map(entry => entry.name);
    const verdict = failedGuards.length === 0 && asymmetries.length === 0 ? 'match' : 'mismatch';
    return {
        schemaVersion: 1,
        question: 'Does the full combination journey produce the same provider requests, browser state and durable chat on both subjects in ONE session, and does pinned Node continue the GoTavern-written chat?',
        verdict,
        guards: Object.fromEntries(guards.map(entry => [entry.name, entry.ok])),
        failedGuards,
        asymmetries,
        subjectGuards: guards.map(entry => ({ name: entry.name, gotavern: entry.go, pinned: entry.pinned })),
        captures: { commonCases: common, missingPairs, mismatches, firstDifference: mismatches[0]?.firstDifference ?? null },
        // The durable-chat red names its own cause (file count and the first differing projected message), so a
        // projection failure is not a bare boolean in the artifact.
        durable: { gotavernFiles: goDisk.length, pinnedFiles: pinDisk.length, equal: diskEqual, firstDifference: projectionDifference },
        restart: restartReport,
        profile: profileResult,
        subjects: {
            gotavern: { steps: (goDrive.steps ?? []).length, failedSteps: (goDrive.steps ?? []).filter(entry => !entry.ok).map(entry => entry.name), requestCount: (goDrive.requests ?? []).length, cases: Object.keys(goCases).sort(), profile: goDrive.e03e04 ? { tier: goDrive.e03e04.tier, seed: goDrive.e03e04.seed, expectedOrderSha256: goDrive.e03e04.expectedOrderSha256 } : null },
            pinned: { steps: (pinnedDrive.steps ?? []).length, failedSteps: (pinnedDrive.steps ?? []).filter(entry => !entry.ok).map(entry => entry.name), requestCount: (pinnedDrive.requests ?? []).length, cases: Object.keys(pinCases).sort(), profile: pinnedDrive.e03e04 ? { tier: pinnedDrive.e03e04.tier, seed: pinnedDrive.e03e04.seed, expectedOrderSha256: pinnedDrive.e03e04.expectedOrderSha256 } : null },
        },
        unproven: [
            'a real provider: the peer is an in-process recording backend (AGENTS 22); every wire observation here is unverified for PRODUCTION.',
            "multi-user and a real user's card/preset prose (committed derivations only, AGENTS 56).",
            'text-completion instruct/context templates do not enter a chat-completion request; recorded from the planted preset file, not claimed on the wire.',
            "the group turn's multi-member fan-out is recorded as however many requests the product made rather than asserted to a number.",
            ...(profileResult.requested ? [
                'the E03+E04 profile is a GENERATED recipe, not a recorded pinned capture: the marker contract locates WHO moved, it does not define the expected body (the recorded bytes are the oracle).',
                'per-extension provider effects are CLASSIFIED, not fabricated: extensions whose capability set touches the request are recorded capability-relevant-unproven rather than given an invented marker (design section 8).',
                'a narrowed tier (fast/medium block counts or extension tiers) is recorded in the identity and must not be reported as full coverage (design section 7).',
            ] : []),
        ],
    };
}

function main() {
    const argv = process.argv.slice(2);
    const positional = [];
    const sections = { restart: [], handback: [] };
    let current = null;
    let out = null;
    let expectProfile = null;
    let verifyArtifact = null;
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        if (token === '--restart' || token === '--handback') { current = token.slice(2); continue; }
        if (token === '--out') { out = argv[index + 1]; index += 1; current = null; continue; }
        if (token === '--expect-profile') { expectProfile = argv[index + 1]; index += 1; current = null; continue; }
        if (token === '--verify-artifact') { verifyArtifact = argv[index + 1]; index += 1; current = null; continue; }
        if (current === null) positional.push(token);
        else sections[current].push(token);
    }
    // FAIL-CLOSED ARTIFACT VERIFICATION (design section 6): a wrong head SHA / missing identity / digest mismatch is
    // a refusal with a nonzero exit, and it never reads the legs' verdicts as evidence.
    if (verifyArtifact) {
        const identity = read(verifyArtifact);
        const verified = verifyArtifactIdentity(identity);
        console.log(`${JSON.stringify(verified, null, 2)}\n`);
        console.error(`artifact identity: ${verified.ok ? 'verified' : 'REFUSED'}${verified.ok ? '' : ` -- ${verified.problems.join('; ')}`}`);
        process.exit(verified.ok ? 0 : 1);
    }
    if (positional.length !== 2) {
        console.error('usage: node compare-combination-journey.mjs <go-drive> <pinned-drive> [--restart <go-restart> <pinned-restart>] [--handback <pinned-handback>] [--expect-profile e03e04] [--out <json>]');
        console.error('       node compare-combination-journey.mjs --verify-artifact <identity.json>');
        process.exit(2);
    }
    const result = compareCombinationJourney({
        goDrive: read(positional[0]),
        pinnedDrive: read(positional[1]),
        goRestart: sections.restart[0] ? read(sections.restart[0]) : null,
        pinnedRestart: sections.restart[1] ? read(sections.restart[1]) : null,
        handback: sections.handback[0] ? read(sections.handback[0]) : null,
        expectProfile,
    });
    for (const entry of result.subjectGuards) console.error(`${entry.gotavern === true && entry.pinned === true ? 'ok  ' : 'FAIL'} ${entry.name} -- gotavern=${entry.gotavern} pinned=${entry.pinned}`);
    console.log(`${JSON.stringify(result, null, 2)}\n`);
    if (out) fs.writeFileSync(path.resolve(out), `${JSON.stringify(result, null, 2)}\n`);
    console.error(`verdict: ${result.verdict}${result.failedGuards.length ? ` -- failed guards: ${result.failedGuards.join(', ')}` : ''}`);
    process.exit(result.verdict === 'match' ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))) main();
