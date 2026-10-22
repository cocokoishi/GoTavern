#!/usr/bin/env node
// Compare two extension-probe legs (GoTavern vs pinned) captured with the SAME
// drive and the SAME installed extension revision.
//
// Usage: node compare-extension-legs.mjs <gotavern-leg.json> <pinned-leg.json>
//
// A difference is a FINDING, not a failure of this script: it exits 0 after
// printing a structured comparison, so the difference is reported rather than
// hidden behind a non-zero exit. The `browser-evidence` CI job recomputes this
// from the committed legs and requires the committed comparison to be what those
// legs produce.
//
// WHY THE COMPARISON IS BY SHAPE, NOT BY DIGEST:
//   Each leg is a single run, so a body digest cannot be told apart from a
//   nondeterministic body (timestamps, ids, CSRF tokens, poll state). The probe
//   therefore records a bounded structural skeleton for JSON responses, and a
//   JSON row is asserted on that skeleton. A route that answers 200 with the
//   wrong SHAPE is the failure this probe exists to catch, because the extension
//   proceeds and fails later with an unexplainable error.
//
//   For a body with no skeleton (HTML, script, image) the digest is recorded but
//   NOT asserted, and the row says so: with one run per leg there is no way to
//   distinguish a real difference from a nondeterministic one, and asserting it
//   would turn render state into a compatibility finding.

import fs from 'node:fs/promises';
import process from 'node:process';

const [gotavernPath, pinnedPath] = process.argv.slice(2);
if (!gotavernPath || !pinnedPath) {
    console.error('usage: node compare-extension-legs.mjs <gotavern-leg.json> <pinned-leg.json>');
    process.exit(2);
}

// Routes whose pinned handler makes a LIVE third-party request, so the recorded
// body is whatever the internet returned rather than a property of the server.
// Rule 14: a probe must not reach the live network, and a body that did is not
// evidence. These rows keep their status and membership, and their body is
// recorded but never asserted, with the reason named in the row.
const LIVE_EGRESS_PREFIXES = ['/api/horde/'];

const isLiveEgress = path => LIVE_EGRESS_PREFIXES.some(prefix => path.startsWith(prefix));

// Only the calls this probe is about are rowed: the extension's own static files
// and the backend API the frontend and the extension call. Frontend asset traffic
// is already covered by the startup comparison and would swamp this one.
const isExtensionAsset = (entry, name) => entry.path.startsWith(`/scripts/extensions/third-party/${name}/`);
const isApiCall = entry => entry.path.startsWith('/api/');

// Request repeat counts vary with rendering and polling (the startup comparator
// records counts rather than asserting them), so statuses are compared as a
// unique sorted SET. Comparing the sequence flagged POST /api/settings/get as a
// difference purely because pinned called it twice and GoTavern once.
const statusSet = statuses => [...new Set(statuses)].sort((left, right) => left - right);

const summarize = report => {
    const groups = new Map();
    for (const entry of report.requests ?? []) {
        const key = `${entry.method} ${entry.path.split('?')[0]}`;
        if (!groups.has(key)) {
            groups.set(key, { method: entry.method, path: entry.path.split('?')[0], occurrences: 0, statuses: [], entry: null });
        }
        const group = groups.get(key);
        group.occurrences += 1;
        if (entry.status !== null) group.statuses.push(entry.status);
        // Keep the first entry that actually produced a body, so a shape or digest
        // is available for the row.
        if (!group.entry || group.entry.bodyShape === null) group.entry = entry;
    }
    return groups;
};

const rowsFor = (gotavernReport, pinnedReport, name) => {
    const gotavern = summarize(gotavernReport);
    const pinned = summarize(pinnedReport);
    const keys = [...new Set([...gotavern.keys(), ...pinned.keys()])]
        .filter(key => isApiCall({ path: key.split(' ')[1] }) || isExtensionAsset({ path: key.split(' ')[1] }, name))
        .sort();
    const rows = [];
    for (const key of keys) {
        const left = gotavern.get(key) ?? null;
        const right = pinned.get(key) ?? null;
        const representative = left ?? right;
        const row = {
            method: representative.method,
            path: representative.path,
            kind: isApiCall(representative) ? 'api' : 'extension-asset',
            occurrences: { gotavern: left?.occurrences ?? 0, pinned: right?.occurrences ?? 0 },
            status: { gotavern: left?.statuses ?? [], pinned: right?.statuses ?? [] },
            classification: null,
            body: null,
        };
        if (!left) {
            row.classification = 'missing-on-gotavern';
        } else if (!right) {
            row.classification = 'extra-on-gotavern';
        } else if (JSON.stringify(statusSet(left.statuses)) !== JSON.stringify(statusSet(right.statuses))) {
            row.classification = 'different-status';
        } else if (isLiveEgress(representative.path)) {
            row.classification = 'equal';
            row.body = {
                shape: true,
                reason: 'the pinned handler for this path makes a live third-party request, so the recorded body is whatever the internet returned and is not a property of the server; status and membership decide this row',
                gotavernShape: left.entry?.bodyShape ?? null,
                pinnedShape: right.entry?.bodyShape ?? null,
            };
        } else if (left.entry?.bodyShape && right.entry?.bodyShape) {
            if (JSON.stringify(left.entry.bodyShape) === JSON.stringify(right.entry.bodyShape)) {
                row.classification = 'equal';
                row.body = 'equal-shape';
            } else {
                row.classification = 'different-shape';
                row.body = { gotavernShape: left.entry.bodyShape, pinnedShape: right.entry.bodyShape };
            }
        } else if (left.entry?.bodySha256 && right.entry?.bodySha256 && left.entry.bodySha256 === right.entry.bodySha256) {
            row.classification = 'equal';
            row.body = 'equal-bytes';
        } else {
            // No skeleton on one side, or the digests differ with nothing to
            // assert against. Recorded, not asserted, with the reason.
            row.classification = 'equal';
            row.body = {
                shape: true,
                reason: 'body has no JSON skeleton and each leg is a single run, so a digest difference here cannot be told apart from a nondeterministic body; status and membership decide this row',
                gotavernSha256: left.entry?.bodySha256 ?? null,
                pinnedSha256: right.entry?.bodySha256 ?? null,
            };
        }
        rows.push(row);
    }
    return rows;
};

const finalStateDiff = (gotavern, pinned) => {
    const keys = [...new Set([...Object.keys(gotavern ?? {}), ...Object.keys(pinned ?? {})])].sort();
    const equal = [];
    const differences = [];
    for (const key of keys) {
        const left = gotavern?.[key] ?? null;
        const right = pinned?.[key] ?? null;
        if (JSON.stringify(left) === JSON.stringify(right)) equal.push(key);
        else differences.push({ field: key, gotavern: left, pinned: right });
    }
    return { equalFields: equal, differences };
};

const main = async () => {
    const [gotavern, pinned] = await Promise.all([
        fs.readFile(gotavernPath, 'utf8').then(JSON.parse),
        fs.readFile(pinnedPath, 'utf8').then(JSON.parse),
    ]);
    const extensionName = gotavern.provenance?.extension?.name ?? pinned.provenance?.extension?.name ?? null;
    const rows = rowsFor(gotavern, pinned, extensionName);
    const summary = {};
    for (const row of rows) summary[row.classification] = (summary[row.classification] ?? 0) + 1;
    const differences = rows.filter(row => row.classification !== 'equal');

    const extensionRevisionMatches = gotavern.provenance?.extension?.installedRevision === pinned.provenance?.extension?.installedRevision;
    const guards = {
        // A leg that never reached a state a user can act from, or never loaded the
        // extension, measured nothing: saying so is the difference between a
        // comparison and two idle page loads.
        gotavernFailure: gotavern.failure ?? null,
        pinnedFailure: pinned.failure ?? null,
        gotavernReachedUserState: Boolean(gotavern.reachedUserState?.settingsReady),
        pinnedReachedUserState: Boolean(pinned.reachedUserState?.settingsReady),
        gotavernExtensionLoaded: Boolean(gotavern.extensionLoaded),
        pinnedExtensionLoaded: Boolean(pinned.extensionLoaded),
        extensionRevisionMatches,
    };
    guards.faithful = !guards.gotavernFailure && !guards.pinnedFailure
        && guards.gotavernReachedUserState && guards.pinnedReachedUserState
        && guards.gotavernExtensionLoaded && guards.pinnedExtensionLoaded
        && guards.extensionRevisionMatches;

    const comparison = {
        schemaVersion: 1,
        question: gotavern.question ?? pinned.question,
        captures: { gotavern: gotavernPath, pinned: pinnedPath },
        provenance: {
            extension: {
                name: extensionName,
                commit: gotavern.provenance?.extension?.commit ?? null,
                gotavernInstalledRevision: gotavern.provenance?.extension?.installedRevision ?? null,
                pinnedInstalledRevision: pinned.provenance?.extension?.installedRevision ?? null,
                gotavernManifestVersion: gotavern.provenance?.extension?.manifestVersion ?? null,
                pinnedManifestVersion: pinned.provenance?.extension?.manifestVersion ?? null,
            },
        },
        guards,
        summary,
        differenceCount: differences.length,
        // The leg that differs is named per row, so a failure says which side moved
        // rather than only that the two disagree.
        differences,
        finalState: {
            gotavern: gotavern.finalState,
            pinned: pinned.finalState,
            ...finalStateDiff(gotavern.finalState, pinned.finalState),
        },
        consoleErrors: {
            gotavern: (gotavern.console ?? []).filter(entry => entry.type === 'error').map(entry => entry.text).slice(0, 20),
            pinned: (pinned.console ?? []).filter(entry => entry.type === 'error').map(entry => entry.text).slice(0, 20),
        },
        pageErrors: { gotavern: gotavern.pageErrors ?? [], pinned: pinned.pageErrors ?? [] },
        rowsNote: 'API and extension-asset calls are compared by method+path membership and status; JSON bodies are asserted on a bounded SHAPE skeleton, and a body with no skeleton is recorded but not asserted because each leg is a single run.',
        rows,
    };
    console.log(JSON.stringify(comparison, null, 2));
};

await main();
