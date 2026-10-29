#!/usr/bin/env node
// Compare the startup differential reports from both legs (two runs per leg).
//
//   node compare-startup-legs.mjs startup-gotavern-1.json startup-gotavern-2.json \
//        startup-pinned-1.json startup-pinned-2.json
//
// Every startup request (method + path) is classified as exactly one of:
//   equal | missing-on-gotavern | extra-on-gotavern | different-status | different-body
//
// Response bodies are compared only where the TWO RUNS OF EACH LEG produced the same digest: a body
// that changes between two identical drives is not a compatibility signal (timestamps, ids, tokens,
// poll timing), so it is recorded as `bodyComparison: nondeterministic` with the reason and the
// status equality still decides the row. Repeated requests for the same method+path vary with
// rendering/polling; membership is compared, counts are recorded, not asserted.
//
// A non-equal row also records the inventory status of the route, read from docs/api-inventory.md, so
// `known-unimplemented` differences are cited rather than assumed. A difference whose route has no
// inventory row is marked UNEXPECTED (the most valuable output).

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const [gotavernFirstPath, gotavernSecondPath, pinnedFirstPath, pinnedSecondPath] = process.argv.slice(2);
if (!gotavernFirstPath || !gotavernSecondPath || !pinnedFirstPath || !pinnedSecondPath) {
    console.error('usage: node compare-startup-legs.mjs <gotavern-1.json> <gotavern-2.json> <pinned-1.json> <pinned-2.json>');
    process.exit(2);
}

const load = async file => JSON.parse(await fs.readFile(file, 'utf8'));

const groupRequests = report => {
    const groups = new Map();
    for (const entry of report.requests ?? []) {
        const key = `${entry.method} ${entry.path}`;
        if (!groups.has(key)) {
            groups.set(key, { key, method: entry.method, path: entry.path, resourceType: entry.resourceType, entries: [] });
        }
        groups.get(key).entries.push(entry);
    }
    return groups;
};

const summarizeLeg = report => {
    const groups = groupRequests(report);
    const summary = new Map();
    for (const [key, group] of groups) {
        const statuses = group.entries.map(entry => entry.status).filter(status => status !== null);
        const shas = group.entries.map(entry => entry.bodySha256).filter(sha => sha !== null && sha !== undefined);
        summary.set(key, {
            method: group.method,
            path: group.path,
            resourceType: group.resourceType,
            occurrences: group.entries.length,
            status: statuses.length ? statuses[statuses.length - 1] : null,
            statuses,
            bodySha256: shas.length ? shas[shas.length - 1] : null,
            bodyShas: shas,
        });
    }
    return summary;
};

// A body is deterministic for a leg when both runs observed the same digest for every occurrence.
const deterministicBody = (first, second) => {
    if (!first || !second) return false;
    if (!first.bodySha256 || !second.bodySha256) return false;
    return first.bodySha256 === second.bodySha256;
};

// Inventory rows are `| Method | Full path | Upstream declaration | Current status |`; the status cell
// starts with the status word followed by a colon and prose, so match the leading token rather than
// the whole cell. Sources are returned separately so a row can cite WHICH document classified it.
const parseInventory = async () => {
    const statuses = new Map();
    try {
        const text = await fs.readFile(path.resolve('docs', 'api-inventory.md'), 'utf8');
        for (const line of text.split('\n')) {
            if (!line.trim().startsWith('|')) continue;
            const cells = line.split('|').map(cell => cell.trim());
            if (cells.length < 5) continue;
            const pathCell = cells[2].replaceAll('`', '').trim();
            if (!pathCell.startsWith('/')) continue;
            const statusMatch = /^(compatible|partial|not implemented|unsupported)\b/i.exec(cells[4]);
            if (!statusMatch) continue;
            // Computed paths (`/thumbnail/<computed: Identifier>`) cannot be matched exactly; record
            // the literal prefix so a request under it can cite the same inventory row.
            const computed = /^(\/[^<]+)<computed:/.exec(pathCell);
            if (computed) {
                statuses.set(`prefix:${computed[1].replace(/\/$/, '')}`, statusMatch[1].toLowerCase());
            } else {
                statuses.set(pathCell.split('?')[0], statusMatch[1].toLowerCase());
            }
        }
    } catch {
        // no inventory available: every API difference stays UNEXPECTED
    }
    return statuses;
};

// The startup-call enumeration already classified each static/public request; reuse it as the source
// for non-API rows (a 404 on an image, stylesheet, font or template is a known asset gap there).
const parseStartupDoc = async () => {
    const classifications = new Map();
    try {
        const text = await fs.readFile(path.resolve('docs', 'frontend-startup-calls.md'), 'utf8');
        for (const line of text.split('\n')) {
            if (!line.trim().startsWith('|')) continue;
            const cells = line.split('|').map(cell => cell.trim());
            if (cells.length < 6) continue;
            const method = cells[1];
            const requestPath = cells[2].replaceAll('`', '').trim();
            const classification = cells[5];
            if (requestPath.startsWith('/') && /^(ok|missing|misbehaving|cosmetic|no-response)$/.test(classification)) {
                classifications.set(`${method} ${requestPath}`, classification);
            }
        }
    } catch {
        // no enumeration available
    }
    return classifications;
};

// THE FINAL PAGE STATE THE PROBE IS EXPECTED TO RECORD. Kept as the EXPECTED set so that a key which
// disappears from BOTH legs is still visible: it is reported as UNMEASURED rather than silently dropped.
const EXPECTED_FINAL_STATE_KEYS = ['settingsReady', 'onlineStatus', 'characterRows', 'mainApiValue', 'sendButtonPresent', 'sendButtonDisabled', 'topBarPresent', 'apiPanelPresent', 'toastr', 'bodyGenerating', 'title', 'extensionPanels', 'promptManagerPresent', 'characterListPresent', 'quickReplyPresent'];

// A FIXED KEY LIST WITH `?? null` ON BOTH SIDES CALLED "NOT RECORDED" EQUAL. A key the probe stopped
// recording is `null` on both legs, so `null === null` put it in `equalFields` and the artefact read as
// "this field was compared and agrees" when nothing had been observed at all. The keys are now the UNION of
// the expected set and both legs' own keys, and a key that is ABSENT ON BOTH is reported in
// `unmeasuredFields` instead of `equalFields` -- the shape compare-extension-legs.mjs:169 already uses for
// the union half. A key present on exactly one leg is a difference, and it records WHICH side was absent,
// because `null` as a value and "not recorded" are different facts.
const finalStateDiff = (gotavern, pinned) => {
    const keys = [...new Set([...EXPECTED_FINAL_STATE_KEYS, ...Object.keys(gotavern ?? {}), ...Object.keys(pinned ?? {})])].sort();
    const equal = [];
    const unmeasured = [];
    const differences = [];
    for (const key of keys) {
        const recordedOnGotavern = Object.prototype.hasOwnProperty.call(gotavern ?? {}, key);
        const recordedOnPinned = Object.prototype.hasOwnProperty.call(pinned ?? {}, key);
        if (!recordedOnGotavern && !recordedOnPinned) {
            unmeasured.push(key);
            continue;
        }
        const left = gotavern?.[key] ?? null;
        const right = pinned?.[key] ?? null;
        if (JSON.stringify(left) === JSON.stringify(right)) equal.push(key);
        else differences.push({ field: key, gotavern: left, pinned: right, recorded: { gotavern: recordedOnGotavern, pinned: recordedOnPinned } });
    }
    return { equalFields: equal, unmeasuredFields: unmeasured, differences };
};

const main = async () => {
    const [gotavernFirst, gotavernSecond, pinnedFirst, pinnedSecond] = await Promise.all([
        load(gotavernFirstPath), load(gotavernSecondPath), load(pinnedFirstPath), load(pinnedSecondPath),
    ]);
    const inventory = await parseInventory();
    const startupDoc = await parseStartupDoc();
    const legs = {
        gotavern: [summarizeLeg(gotavernFirst), summarizeLeg(gotavernSecond)],
        pinned: [summarizeLeg(pinnedFirst), summarizeLeg(pinnedSecond)],
    };
    if (process.env.DEBUG_STARTUP_INVENTORY) { console.error("inventory size", inventory.size, "prefix keys", [...inventory.keys()].filter(key => key.startsWith("prefix:"))); }
    const keys = [...new Set([...legs.gotavern[0].keys(), ...legs.pinned[0].keys()])].sort();

    const rows = [];
    for (const key of keys) {
        const gotavernEntries = legs.gotavern.map(leg => leg.get(key)).filter(Boolean);
        const pinnedEntries = legs.pinned.map(leg => leg.get(key)).filter(Boolean);
        const representative = gotavernEntries[0] ?? pinnedEntries[0];
        const gotavernDeterministic = deterministicBody(gotavernEntries[0], gotavernEntries[1]);
        const pinnedDeterministic = deterministicBody(pinnedEntries[0], pinnedEntries[1]);
        const row = {
            method: representative.method,
            path: representative.path,
            resourceType: representative.resourceType,
            occurrences: {
                gotavern: gotavernEntries.map(entry => entry.occurrences),
                pinned: pinnedEntries.map(entry => entry.occurrences),
            },
            status: {
                gotavern: gotavernEntries.map(entry => entry.status),
                pinned: pinnedEntries.map(entry => entry.status),
            },
            bodyComparison: null,
            classification: null,
            knownInventoryStatus: (() => {
                const basePath = representative.path.split('?')[0];
                if (inventory.has(basePath)) return inventory.get(basePath);
                for (const [key, status] of inventory) {
                    if (key.startsWith('prefix:') && (basePath === key.slice('prefix:'.length) || basePath.startsWith(`${key.slice('prefix:'.length)}/`))) {
                        return status;
                    }
                }
                return null;
            })(),
            knownStaticClassification: representative.path.startsWith('/api/') ? null : (() => {
                const exact = startupDoc.get(`${representative.method} ${representative.path}`);
                if (exact) return exact;
                const basePath = representative.path.split('?')[0];
                for (const [key, classification] of startupDoc) {
                    if (key === `${representative.method} ${basePath}` || key.startsWith(`${representative.method} ${basePath}?`)) return classification;
                }
                return null;
            })(),
            knownSource: null,
            knownReason: null,
            unexpected: false,
            needsAttention: false,
        };
        if (row.knownInventoryStatus) {
            row.knownSource = 'docs/api-inventory.md';
            row.knownReason = `route inventory status: ${row.knownInventoryStatus}`;
        } else if (row.knownStaticClassification) {
            row.knownSource = 'docs/frontend-startup-calls.md';
            row.knownReason = `startup-call enumeration classification: ${row.knownStaticClassification}`;
        }
        if (gotavernEntries.length === 0) {
            row.classification = 'missing-on-gotavern';
        } else if (pinnedEntries.length === 0) {
            row.classification = 'extra-on-gotavern';
        } else {
            const gotavernStatuses = [...new Set(gotavernEntries.map(entry => entry.status))];
            const pinnedStatuses = [...new Set(pinnedEntries.map(entry => entry.status))];
            if (JSON.stringify(gotavernStatuses) !== JSON.stringify(pinnedStatuses)) {
                row.classification = 'different-status';
            } else if (gotavernDeterministic && pinnedDeterministic) {
                const gotavernSha = gotavernEntries[0].bodySha256;
                const pinnedSha = pinnedEntries[0].bodySha256;
                if (gotavernSha === pinnedSha) {
                    row.classification = 'equal';
                    row.bodyComparison = 'equal';
                } else {
                    row.classification = 'different-body';
                    row.bodyComparison = { gotavern: gotavernSha, pinned: pinnedSha };
                }
            } else {
                // One or both legs produce a body that changes between two identical runs (timestamps,
                // ids, CSRF tokens, render/poll state). That is not a compatibility signal; record it
                // as shape instead of asserting it.
                row.classification = 'equal';
                row.bodyComparison = {
                    shape: true,
                    reason: 'response body differs between two identical runs of the same leg (timestamps, ids, tokens or poll/render state), so it is not asserted; status equality decides this row',
                    gotavernDeterministic,
                    pinnedDeterministic,
                };
            }
        }
        row.unexpected = row.classification !== 'equal' && row.knownInventoryStatus === null && row.knownStaticClassification === null;
        row.needsAttention = row.classification !== 'equal'
            && (row.knownInventoryStatus === 'compatible' || row.knownStaticClassification === 'ok');
        rows.push(row);
    }

    const summary = {};
    for (const row of rows) {
        summary[row.classification] = (summary[row.classification] ?? 0) + 1;
    }
    const unexpected = rows.filter(row => row.unexpected);
    const guards = {
        gotavernFailure: gotavernFirst.failure ?? gotavernSecond.failure ?? null,
        pinnedFailure: pinnedFirst.failure ?? pinnedSecond.failure ?? null,
        gotavernReachedUserState: Boolean(gotavernFirst.reachedUserState?.settingsReady && gotavernFirst.reachedUserState?.connectStatusRequestObserved),
        pinnedReachedUserState: Boolean(pinnedFirst.reachedUserState?.settingsReady && pinnedFirst.reachedUserState?.connectStatusRequestObserved),
        onboardingCompletedBoth: Boolean(gotavernFirst.reachedUserState?.onboardingCompleted && pinnedFirst.reachedUserState?.onboardingCompleted),
    };
    guards.faithful = !guards.gotavernFailure && !guards.pinnedFailure && guards.gotavernReachedUserState && guards.pinnedReachedUserState && guards.onboardingCompletedBoth;

    const comparison = {
        schemaVersion: 1,
        question: 'does the pinned frontend make the same startup requests and reach the same final page state on GoTavern and pinned?',
        captures: { gotavernFirst: gotavernFirstPath, gotavernSecond: gotavernSecondPath, pinnedFirst: pinnedFirstPath, pinnedSecond: pinnedSecondPath },
        provenance: { gotavern: gotavernFirst.provenance, pinned: pinnedFirst.provenance },
        guards,
        summary,
        unexpectedCount: unexpected.length,
        unexpected: unexpected.map(row => ({ method: row.method, path: row.path, classification: row.classification, status: row.status })),
        finalState: {
            gotavern: gotavernFirst.finalState,
            pinned: pinnedFirst.finalState,
            ...finalStateDiff(gotavernFirst.finalState, pinnedFirst.finalState),
        },
        requestsNote: 'Request repeat counts vary with rendering/polling timing; the comparison is by method+path membership. Response bodies are compared only where TWO RUNS OF EACH LEG agree on the digest.',
        rows,
    };
    console.log(JSON.stringify(comparison, null, 2));
};

await main();
