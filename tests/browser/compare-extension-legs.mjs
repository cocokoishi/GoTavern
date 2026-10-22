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
import path from 'node:path';
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

// A reason per non-row path difference, naming what actually differs. `/thumbnail` is the one
// EXPECTED divergence and the only one this project has decided: GoTavern does not re-encode images
// with a Jimp-compatible codec (AGENTS.md, architecture boundary 3), so it answers 404 where pinned
// builds a thumbnail. Everything else is a page-load difference between two separate loads of the
// same document; the reason names which leg issued the request and how each drive ended.
const NON_ROW_PATH_REASONS = {
    '/thumbnail': 'the documented Jimp codec boundary (AGENTS.md architecture boundary 3): GoTavern answers 404 where pinned re-encodes the image with Jimp; recorded, not asserted',
};

function nonRowPathReason(path, gotavernStatuses, pinnedStatuses) {
    if (NON_ROW_PATH_REASONS[path]) return NON_ROW_PATH_REASONS[path];
    // A status set that differs on BOTH legs is a SERVER RESPONSE difference, not a page-load one:
    // the same request was issued by both drives and answered differently. Writing that as "timing"
    // is how a defect becomes a baseline, so it gets a reason the gate refuses (verify-browser-
    // comparisons.mjs requires a reason naming a decided mechanism) and the artifact cannot be
    // committed until the difference is fixed or explicitly decided.
    if (gotavernStatuses.length > 0 && pinnedStatuses.length > 0) {
        return 'SERVER RESPONSE DIFFERENCE, not decided: both drives issued this request (GoTavern answered '
            + JSON.stringify(gotavernStatuses) + ', pinned answered ' + JSON.stringify(pinnedStatuses)
            + '); this is a product difference to be fixed, and an artifact recording it cannot pass the gate';
    }
    const parts = [];
    if (gotavernStatuses.length === 0) parts.push('the GoTavern drive never issued this request');
    else if (gotavernStatuses.includes(null)) parts.push('the GoTavern drive left it unresolved');
    else parts.push('GoTavern answered ' + JSON.stringify(gotavernStatuses));
    if (pinnedStatuses.length === 0) parts.push('the pinned drive never issued it');
    else if (pinnedStatuses.includes(null)) parts.push('the pinned drive left it unresolved');
    else parts.push('pinned answered ' + JSON.stringify(pinnedStatuses));
    return 'frontend asset fetched by only one of the two page loads (' + parts.join('; ') + '); '
        + 'both drives ended on the page\'s own network-quiet signal, recorded in captureQuiet, so this is a '
        + 'difference between two independent loads of the same document rather than a server response difference';
}

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
    // The legs must also have STARTED from the same state. Two legs sharing one
    // data root produced a /css/user.css difference that was purely the order the
    // legs ran in, because the first leg created <dataRoot>/_css/user.css and the
    // second leg's server then served it. Reporting that as a product finding is
    // the shared-state hazard, so it is a guard rather than a row.
    const startingStateMatches = JSON.stringify(gotavern.provenance?.startingState ?? null) === JSON.stringify(pinned.provenance?.startingState ?? null);
    // Both legs must also have been given the SAME config file. Until this was recorded, each server
    // resolved config.yaml against its own checkout, so accounts on/off — and therefore the anonymity
    // of every request the pair measures — was a property of two different files.
    const configSha256 = { gotavern: gotavern.provenance?.configFile?.sha256 ?? null, pinned: pinned.provenance?.configFile?.sha256 ?? null };
    const configMatches = configSha256.gotavern !== null && configSha256.gotavern === configSha256.pinned;
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
        startingStateMatches,
        configMatches,
        configFile: configSha256,
        startingState: { gotavern: gotavern.provenance?.startingState ?? null, pinned: pinned.provenance?.startingState ?? null },
    };
    guards.faithful = !guards.gotavernFailure && !guards.pinnedFailure
        && guards.gotavernReachedUserState && guards.pinnedReachedUserState
        && guards.gotavernExtensionLoaded && guards.pinnedExtensionLoaded
        && guards.extensionRevisionMatches && guards.startingStateMatches && guards.configMatches;

    // WHAT THE EXTENSION WROTE, and how it is compared. Presence and size are asserted; the JSON
    // SKELETON is asserted for a JSON file; the SHA-256 is classified, because the content carries a
    // per-run random transaction id (measured on LittleWhiteBox: two runs of the same server produced
    // different digests at the same size). Stating this in the artifact is the point: "the extension
    // wrote a file" is only evidence if the artifact says what about it was compared.
    const userFiles = (leg, other) => {
        const mine = leg.writtenUserFiles ?? [];
        const theirs = other.writtenUserFiles ?? [];
        const entries = [];
        const byPath = new Map(theirs.map(entry => [entry.path, entry]));
        for (const entry of mine) {
            const matched = byPath.get(entry.path) ?? null;
            entries.push({
                path: entry.path,
                gotavern: { size: entry.size, sha256: entry.sha256, bodyShape: entry.bodyShape },
                pinned: matched ? { size: matched.size, sha256: matched.sha256, bodyShape: matched.bodyShape } : null,
                presenceMatches: matched !== null,
                sizeMatches: matched !== null && matched.size === entry.size,
                bodyShapeMatches: matched !== null && JSON.stringify(matched.bodyShape) === JSON.stringify(entry.bodyShape),
            });
            byPath.delete(entry.path);
        }
        for (const extra of byPath.values()) {
            entries.push({ path: extra.path, gotavern: null, pinned: { size: extra.size, sha256: extra.sha256, bodyShape: extra.bodyShape }, presenceMatches: false, sizeMatches: false, bodyShapeMatches: false });
        }
        return entries;
    };
    const userFileEntries = userFiles(gotavern, pinned);
    const userFilesBlock = {
        compared: ['path', 'size', 'bodyShape'],
        shape: ['sha256'],
        shapeReason: {
            sha256: 'the file the extension writes carries a per-run random transaction id (LittleWhiteBox writes one into every recorded transaction), so two runs of the SAME server differ; size, presence and the JSON skeleton are what this pair asserts',
        },
        matches: userFileEntries.every(entry => entry.presenceMatches && entry.sizeMatches && entry.bodyShapeMatches),
        // An empty list must SAY it is empty: "matches: true" over nothing is the vacuous pass this
        // project keeps finding, and a reader must not conclude that bytes were compared.
        note: userFileEntries.length === 0
            ? 'the extension wrote no files under <dataRoot>/<handle>/user/files during this drive, so nothing about them is asserted'
            : null,
        entries: userFileEntries,
    };

    // NON-ROW PATH DIFFERENCES. The row set is /api/* plus the installed extension's prefix, which is
    // where a server difference would show. Every other path the page fetched is compared here instead
    // of being dropped, because "not a row" is not the same as "we did not look": two frontend assets
    // that only one leg fetched are a fact about this pair, and an artifact that stayed silent about
    // them would be the reason-less divergence this project's gate exists to reject.
    //
    // Every entry carries a reason that names the MECHANISM, and the mechanism available to the harness
    // is stated exactly: which leg issued the request, which leg left it unresolved, and how each
    // drive ended (captureQuiet: the page's own network-quiet signal with its wait time).
    const pathStatusSets = report => {
        const map = new Map();
        for (const entry of report.requests ?? []) {
            const path = entry.path.split('?')[0];
            if (!map.has(path)) map.set(path, new Set());
            map.get(path).add(entry.status);
        }
        return map;
    };
    const isRowPath = path => path.startsWith('/api/') || (extensionPrefix !== null && path.startsWith(extensionPrefix));
    const extensionPrefix = extensionName !== null ? '/scripts/extensions/third-party/' + extensionName + '/' : null;
    const gotavernPaths = pathStatusSets(gotavern);
    const pinnedPaths = pathStatusSets(pinned);
    const allPaths = new Set([...gotavernPaths.keys(), ...pinnedPaths.keys()]);
    const sortStatuses = statuses => [...(statuses ?? [])].sort((left, right) => (left ?? -1) - (right ?? -1));
    const pathDifferences = [];
    for (const path of [...allPaths].sort()) {
        if (isRowPath(path)) continue;
        const gotavernStatuses = sortStatuses(gotavernPaths.get(path));
        const pinnedStatuses = sortStatuses(pinnedPaths.get(path));
        if (JSON.stringify(gotavernStatuses) === JSON.stringify(pinnedStatuses)) continue;
        pathDifferences.push({
            path,
            gotavern: gotavernStatuses,
            pinned: pinnedStatuses,
            knownReason: nonRowPathReason(path, gotavernStatuses, pinnedStatuses),
        });
    }

    const comparison = {
        schemaVersion: 1,
        question: gotavern.question ?? pinned.question,
        // The leg FILE NAMES, not their paths: this artifact is committed, and an absolute path
        // carries the developer's home directory into the repository.
        captures: { gotavern: path.basename(gotavernPath), pinned: path.basename(pinnedPath) },
        provenance: {
            extension: {
                name: extensionName,
                commit: gotavern.provenance?.extension?.commit ?? null,
                gotavernInstalledRevision: gotavern.provenance?.extension?.installedRevision ?? null,
                pinnedInstalledRevision: pinned.provenance?.extension?.installedRevision ?? null,
                gotavernManifestVersion: gotavern.provenance?.extension?.manifestVersion ?? null,
                pinnedManifestVersion: pinned.provenance?.extension?.manifestVersion ?? null,
                // How the extension tree got there, and whether its remote is the local seed: a
                // github origin would make /api/extensions/update depend on the network (and one run
                // PULLED the checkout off its pinned revision), so the artifact states it.
                gotavernInstallSource: gotavern.provenance?.extension?.installSource ?? null,
                pinnedInstallSource: pinned.provenance?.extension?.installSource ?? null,
                gotavernRemoteKind: gotavern.provenance?.extension?.remoteKind ?? null,
                pinnedRemoteKind: pinned.provenance?.extension?.remoteKind ?? null,
            },
        },
        guards,
        summary,
        pathDifferences,
        userFiles: userFilesBlock,
        captureQuiet: { gotavern: gotavern.settle ?? null, pinned: pinned.settle ?? null },
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
