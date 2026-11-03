#!/usr/bin/env node
// JUDGE ONE THIRD-PARTY EXTENSION'S LIFECYCLE PAIR: four leg files from one extension.
//
// Usage:
//   node compare-extension-lifecycle.mjs <gotavern-before> <pinned-before> <gotavern-after> <pinned-after> [--out <file>]
//
// The verdict is a TAXONOMY, not a boolean (AGENTS.md differential doctrine 5):
//   PASS           every applicable Go leg matches the stock oracle
//   FAIL           a Go-only divergence: the same drive succeeded on stock and did not on GoTavern
//   UPSTREAM_FAIL  stock itself deterministically failed, so the pair cannot support a Go compatibility claim
//   N/A            the capability does not apply to this extension (recorded with the reason)
//
// A difference is not hidden: the comparison prints the rows, and the runner records FAIL with the named
// guards so the release gate cannot pass over it.
//
// WHAT IS ASSERTED AND WHAT IS MERELY RECORDED:
//   * request rows: method+path membership and status sets are asserted. A route BOTH drives issued with
//     different statuses is a server response difference and fails. A row only one drive issued is a
//     page-load difference: recorded with its reason, and it fails only when it is the extension's OWN
//     asset (a module that did not arrive is the "extension looks dead" failure this surface exists for).
//   * JSON bodies are compared by bounded SHAPE, never by digest: one run per leg cannot distinguish a
//     real difference from a nondeterministic body, and this project already recorded that mistake.
//   * browser integrity: an error the Go leg produced and stock did not is a Go-only error and fails;
//     an error both legs produced is the extension's own and is recorded as upstream.

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const outPath = outIndex === -1 ? null : args[outIndex + 1];
const files = args.filter((argument, index) => !argument.startsWith('--') && (outIndex === -1 || index !== outIndex + 1));
if (files.length !== 4) {
    console.error('usage: node compare-extension-lifecycle.mjs <gotavern-before> <pinned-before> <gotavern-after> <pinned-after> [--out <file>]');
    process.exit(2);
}

const [goBeforePath, pinBeforePath, goAfterPath, pinAfterPath] = files;
const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const [goBefore, pinBefore, goAfter, pinAfter] = await Promise.all(files.map(read));

const extensionName = goBefore.provenance?.extension?.name ?? pinBefore.provenance?.extension?.name ?? null;
const extensionPrefix = extensionName === null ? null : `/scripts/extensions/third-party/${extensionName}/`;

const statusSet = statuses => [...new Set(statuses.filter(status => status !== null))].sort((left, right) => left - right);

// Routes whose pinned handler makes a LIVE third-party request, so the recorded body is whatever the
// internet returned rather than a property of the server (AGENTS.md rule 14). Membership and status are
// asserted; the BODY is recorded but not asserted, and the row says why. This is the same exclusion the
// committed extension comparison already uses, and it was measured here: LittleWhiteBox's load makes the
// page POST /api/horde/text-models, and comparing that body's shape across two live responses reported a
// "difference" that was the internet, not GoTavern.
const LIVE_EGRESS_PREFIXES = ['/api/horde/'];
const isLiveEgress = pathName => LIVE_EGRESS_PREFIXES.some(prefix => pathName.startsWith(prefix));

function groupRows(report) {
    const groups = new Map();
    for (const row of report.rows ?? []) {
        const key = `${row.method} ${row.path}`;
        if (!groups.has(key)) groups.set(key, { method: row.method, path: row.path, statuses: [], shapes: [], occurrences: 0 });
        const group = groups.get(key);
        group.occurrences += 1;
        group.statuses.push(row.status);
        if (row.bodyShape !== null && row.bodyShape !== undefined) group.shapes.push(row.bodyShape);
    }
    return groups;
}

// The rows a comparison judges: the backend API and the extension's own assets. Everything else the page
// fetched belongs to the frontend-startup surface and is already compared by that lane.
function comparedRows(gotavern, pinned) {
    const left = groupRows(gotavern);
    const right = groupRows(pinned);
    const keys = [...new Set([...left.keys(), ...right.keys()])]
        .filter(key => key.split(' ')[1].startsWith('/api/') || (extensionPrefix !== null && key.split(' ')[1].startsWith(extensionPrefix)))
        .sort();
    const rows = [];
    for (const key of keys) {
        const a = left.get(key) ?? null;
        const b = right.get(key) ?? null;
        const row = {
            method: (a ?? b).method,
            path: (a ?? b).path,
            kind: (a ?? b).path.startsWith('/api/') ? 'api' : 'extension-asset',
            occurrences: { gotavern: a?.occurrences ?? 0, pinned: b?.occurrences ?? 0 },
            status: { gotavern: a ? statusSet(a.statuses) : [], pinned: b ? statusSet(b.statuses) : [] },
            bodyShape: { gotavern: a?.shapes?.[0] ?? null, pinned: b?.shapes?.[0] ?? null },
            classification: 'equal',
            reason: null,
        };
        if (!a) {
            row.classification = row.kind === 'extension-asset' ? 'missing-on-gotavern' : 'issued-only-by-pinned';
            row.reason = row.kind === 'extension-asset'
                ? 'the pinned drive fetched this asset of the installed extension and the GoTavern drive never did, so the extension did not request its own module/asset on GoTavern'
                : 'only the pinned page load issued this API call; recorded as a page-load difference, not asserted';
        } else if (!b) {
            row.classification = row.kind === 'extension-asset' ? 'extra-on-gotavern' : 'issued-only-by-gotavern';
            row.reason = 'only the GoTavern page load issued this call; recorded as a page-load difference, not asserted';
        } else if (JSON.stringify(row.status.gotavern) !== JSON.stringify(row.status.pinned)) {
            row.classification = 'different-status';
            row.reason = 'both drives issued this request and the status sets differ, which is a server response difference';
        } else if (isLiveEgress(row.path)) {
            row.classification = 'equal';
            row.shapeAsserted = false;
            row.reason = 'the pinned handler for this path makes a live third-party request, so the recorded body is whatever the internet returned and is not a property of the server; status and membership decide this row';
        } else if (row.bodyShape.gotavern !== null && row.bodyShape.pinned !== null
            && JSON.stringify(row.bodyShape.gotavern) !== JSON.stringify(row.bodyShape.pinned)) {
            row.classification = 'different-shape';
            row.reason = 'both drives issued this request with the same status but the JSON response shapes differ';
        }
        rows.push(row);
    }
    return rows;
}

const extensionAssetFailures = rows => rows.filter(row => row.kind === 'extension-asset' && row.classification !== 'equal');
const serverResponseFailures = rows => rows.filter(row => row.classification === 'different-status' || row.classification === 'different-shape');

function browserIntegrity(gotavern, pinned) {
    const normalize = text => String(text).replace(/:\d+:\d+/g, ':LINE:COL').replace(/\b\d{4,}\b/g, 'N');
    const goErrors = [...(gotavern.pageErrors ?? []), ...(gotavern.consoleErrors ?? [])].map(normalize);
    const pinErrors = [...(pinned.pageErrors ?? []), ...(pinned.consoleErrors ?? [])].map(normalize);
    const pinSet = new Set(pinErrors);
    const goSet = new Set(goErrors);
    const goOnly = [...goSet].filter(entry => !pinSet.has(entry));
    const pinnedOnly = [...pinSet].filter(entry => !goSet.has(entry));
    const shared = [...goSet].filter(entry => pinSet.has(entry));
    return {
        // A Go-only page error / console error is a Go divergence; a shared one is the extension's own.
        goOnlyErrors: goOnly,
        pinnedOnlyErrors: pinnedOnly,
        sharedErrors: shared,
        goHttpFailures: (gotavern.httpFailures ?? []).filter(entry => /^5\d\d/.test(entry) || entry.startsWith('FAILED')),
        pinnedHttpFailures: (pinned.httpFailures ?? []).filter(entry => /^5\d\d/.test(entry) || entry.startsWith('FAILED')),
        pass: goOnly.length === 0,
    };
}

function phasePair(gotavern, pinned, label) {
    const rows = comparedRows(gotavern, pinned);
    const assetFailures = extensionAssetFailures(rows);
    const responseFailures = serverResponseFailures(rows);
    const integrity = browserIntegrity(gotavern, pinned);
    return {
        label,
        rows,
        extensionAssetFailures: assetFailures,
        serverResponseFailures: responseFailures,
        browserIntegrity: integrity,
        gotavernLoaded: gotavern.extensionLoaded === true,
        pinnedLoaded: pinned.extensionLoaded === true,
        gotavernSettingsReady: gotavern.reachedUserState?.settingsReady === true,
        pinnedSettingsReady: pinned.reachedUserState?.settingsReady === true,
        settle: { gotavern: gotavern.settle ?? null, pinned: pinned.settle ?? null },
        pass: assetFailures.length === 0 && responseFailures.length === 0 && integrity.pass,
    };
}

const before = phasePair(goBefore.phases.activation ?? {}, pinBefore.phases.activation ?? {}, 'before-restart');
const after = phasePair(goAfter.phases.activationAfterRestart ?? {}, pinAfter.phases.activationAfterRestart ?? {}, 'after-restart');

// The four leg files must describe the SAME extension at the SAME pinned revision, or the pair is a
// comparison of two different things.
const revisions = [goBefore, pinBefore, goAfter, pinAfter].map(report => report.provenance?.installedRevision ?? null);
const lockHashes = [goBefore, pinBefore, goAfter, pinAfter].map(report => report.provenance?.extension?.lockSha256 ?? null);
const configHashes = [goBefore, pinBefore, goAfter, pinAfter].map(report => report.provenance?.configFile?.sha256 ?? null);
const guards = {
    legFailures: {
        gotavernBefore: goBefore.failure ?? null,
        pinnedBefore: pinBefore.failure ?? null,
        gotavernAfter: goAfter.failure ?? null,
        pinnedAfter: pinAfter.failure ?? null,
    },
    extensionRevisionsMatch: new Set(revisions).size === 1 && revisions[0] !== null,
    revisions,
    lockHashesMatch: new Set(lockHashes).size === 1 && lockHashes[0] !== null,
    lockSha256: lockHashes[0] ?? null,
    configsMatch: new Set(configHashes).size === 1 && configHashes[0] !== null,
    configSha256: configHashes[0] ?? null,
};
// A GO LEG THAT DID NOT MEASURE IS A FAIL, and the pair's provenance must still agree. A PINNED leg that
// did not measure is NOT a Go defect: the stock oracle itself failed, which is UPSTREAM_FAIL below. The
// distinction is the whole taxonomy: folding both into "unfaithful" would report a broken stock server as
// a GoTavern failure (measured: the first version of this guard did exactly that, and the self-test that
// forces a stock failure caught it).
const goLegFailure = (goBefore.failure ?? null) !== null || (goAfter.failure ?? null) !== null;
const pinnedLegFailure = (pinBefore.failure ?? null) !== null || (pinAfter.failure ?? null) !== null;
guards.faithful = !goLegFailure && guards.extensionRevisionsMatch && guards.lockHashesMatch && guards.configsMatch;
guards.stockMeasured = !pinnedLegFailure;

// STOCK ITSELF BROKEN IS NOT A GO DEFECT. If stock did not reach user state or did not load the
// extension, the pair cannot support a compatibility claim: the verdict is UPSTREAM_FAIL, which the
// release gate refuses as evidence just like a FAIL.
const stockBeforeBroken = before.pinnedSettingsReady !== true || before.pinnedLoaded !== true || (pinBefore.failure ?? null) !== null;
const stockAfterBroken = after.pinnedSettingsReady !== true || after.pinnedLoaded !== true || (pinAfter.failure ?? null) !== null;
const goBeforeBroken = before.gotavernSettingsReady !== true || before.gotavernLoaded !== true || (goBefore.failure ?? null) !== null;
const goAfterBroken = after.gotavernSettingsReady !== true || after.gotavernLoaded !== true || (goAfter.failure ?? null) !== null;

// THE LIFECYCLE ASSERTIONS, per subject, from the after-restart legs.
const lifecycleOf = report => ({
    settingPersisted: report.phases?.settingPersisted?.probe !== null && report.phases?.settingPersisted?.probe !== undefined,
    settingsAvailable: report.phases?.settingPersisted?.available === true,
    disabledNotLoaded: report.phases?.disabledDrive?.extensionLoaded === false,
    reEnabledLoaded: report.phases?.enabledDrive?.extensionLoaded === true,
    uninstallStatus: report.phases?.uninstall?.status ?? null,
    uninstallDirectoryGone: report.phases?.uninstalledDirectoryGone === true,
    pageHealthyAfterUninstall: report.phases?.uninstalledDrive?.reachedUserState?.settingsReady === true,
});
const gotavernLifecycle = lifecycleOf(goAfter);
const pinnedLifecycle = lifecycleOf(pinAfter);

const lifecycleProblems = [];
if (pinnedLifecycle.settingsAvailable && gotavernLifecycle.settingsAvailable) {
    if (pinnedLifecycle.settingPersisted && !gotavernLifecycle.settingPersisted) {
        lifecycleProblems.push('the extension setting survived the restart on stock but not on GoTavern');
    }
    if (!pinnedLifecycle.settingPersisted && gotavernLifecycle.settingPersisted) {
        lifecycleProblems.push('the extension setting survived the restart on GoTavern but not on stock (stock is the oracle; this is a divergence)');
    }
}
if (pinnedLifecycle.disabledNotLoaded && !gotavernLifecycle.disabledNotLoaded) lifecycleProblems.push('the extension still loaded while disabled on GoTavern');
if (pinnedLifecycle.reEnabledLoaded && !gotavernLifecycle.reEnabledLoaded) lifecycleProblems.push('the extension did not load after re-enabling on GoTavern');
if (pinnedLifecycle.uninstallStatus !== null && gotavernLifecycle.uninstallStatus !== pinnedLifecycle.uninstallStatus) {
    lifecycleProblems.push(`uninstall answered ${JSON.stringify(gotavernLifecycle.uninstallStatus)} on GoTavern and ${JSON.stringify(pinnedLifecycle.uninstallStatus)} on stock`);
}
if (pinnedLifecycle.uninstallDirectoryGone && !gotavernLifecycle.uninstallDirectoryGone) lifecycleProblems.push('the extension directory survived the uninstall on GoTavern');
if (pinnedLifecycle.pageHealthyAfterUninstall && !gotavernLifecycle.pageHealthyAfterUninstall) lifecycleProblems.push('the page did not reach settingsReady after the uninstall on GoTavern');

// The settings capability is N/A when the extension keeps no per-extension state in extension_settings.
const settingsApplicable = pinnedLifecycle.settingsAvailable === true;
const capabilities = {
    activation: {
        applicable: true,
        stock: { loaded: before.pinnedLoaded, settingsReady: before.pinnedSettingsReady },
        gotavern: { loaded: before.gotavernLoaded, settingsReady: before.gotavernSettingsReady },
        verdict: stockBeforeBroken ? 'UPSTREAM_FAIL' : (goBeforeBroken ? 'FAIL' : (before.pass ? 'PASS' : 'FAIL')),
        reasons: [
            ...before.extensionAssetFailures.map(row => `extension asset ${row.method} ${row.path}: ${row.classification}`),
            ...before.serverResponseFailures.map(row => `server response ${row.method} ${row.path}: ${row.classification}`),
            ...before.browserIntegrity.goOnlyErrors.map(error => `Go-only browser error: ${error}`),
        ],
    },
    settings: {
        applicable: settingsApplicable,
        reason: settingsApplicable ? null : 'the extension keeps no object entry in extension_settings, so there is no per-extension setting to persist (recorded, not skipped silently)',
        stock: pinnedLifecycle,
        gotavern: gotavernLifecycle,
        verdict: !settingsApplicable ? 'N/A' : (stockBeforeBroken ? 'UPSTREAM_FAIL' : (lifecycleProblems.length > 0 ? 'FAIL' : 'PASS')),
        reasons: lifecycleProblems,
    },
    disable: {
        applicable: true,
        stock: { disabledNotLoaded: pinnedLifecycle.disabledNotLoaded },
        gotavern: { disabledNotLoaded: gotavernLifecycle.disabledNotLoaded },
        verdict: stockBeforeBroken ? 'UPSTREAM_FAIL' : (gotavernLifecycle.disabledNotLoaded ? 'PASS' : 'FAIL'),
    },
    reenable: {
        applicable: true,
        stock: { loaded: pinnedLifecycle.reEnabledLoaded },
        gotavern: { loaded: gotavernLifecycle.reEnabledLoaded },
        verdict: stockBeforeBroken ? 'UPSTREAM_FAIL' : (gotavernLifecycle.reEnabledLoaded ? 'PASS' : 'FAIL'),
    },
    uninstall: {
        applicable: true,
        stock: { status: pinnedLifecycle.uninstallStatus, directoryGone: pinnedLifecycle.uninstallDirectoryGone },
        gotavern: { status: gotavernLifecycle.uninstallStatus, directoryGone: gotavernLifecycle.uninstallDirectoryGone },
        verdict: stockBeforeBroken ? 'UPSTREAM_FAIL'
            : (gotavernLifecycle.uninstallStatus === pinnedLifecycle.uninstallStatus && gotavernLifecycle.uninstallDirectoryGone === pinnedLifecycle.uninstallDirectoryGone && gotavernLifecycle.pageHealthyAfterUninstall === pinnedLifecycle.pageHealthyAfterUninstall ? 'PASS' : 'FAIL'),
    },
    activationAfterRestart: {
        applicable: true,
        stock: { loaded: after.pinnedLoaded, settingsReady: after.pinnedSettingsReady },
        gotavern: { loaded: after.gotavernLoaded, settingsReady: after.gotavernSettingsReady },
        verdict: stockAfterBroken ? 'UPSTREAM_FAIL' : (goAfterBroken ? 'FAIL' : (after.pass ? 'PASS' : 'FAIL')),
        reasons: [
            ...after.extensionAssetFailures.map(row => `extension asset ${row.method} ${row.path}: ${row.classification}`),
            ...after.serverResponseFailures.map(row => `server response ${row.method} ${row.path}: ${row.classification}`),
            ...after.browserIntegrity.goOnlyErrors.map(error => `Go-only browser error: ${error}`),
        ],
    },
};

const verdicts = Object.values(capabilities).map(capability => capability.verdict);
const overall = !guards.faithful ? 'FAIL'
    : verdicts.includes('FAIL') ? 'FAIL'
        : verdicts.includes('UPSTREAM_FAIL') ? 'UPSTREAM_FAIL'
            : verdicts.filter(verdict => verdict === 'PASS' || verdict === 'N/A').length === verdicts.length ? 'PASS' : 'FAIL';

const comparison = {
    schemaVersion: 1,
    surface: 'third-party-extension-lifecycle',
    question: 'Does the pinned real extension activate, persist, disable, re-enable and uninstall identically on stock SillyTavern and GoTavern?',
    extension: {
        name: extensionName,
        repo: goBefore.provenance?.extension?.repo ?? null,
        commit: goBefore.provenance?.extension?.commit ?? null,
        capabilities: goBefore.provenance?.extension?.capabilities ?? [],
    },
    captures: files.map(file => path.basename(file)),
    guards,
    verdict: overall,
    verdicts,
    capabilities,
    phases: { before, after },
    lifecycle: { stock: pinnedLifecycle, gotavern: gotavernLifecycle },
    rowsNote: 'API and extension-asset calls are compared by method+path membership and status sets; JSON bodies by bounded shape. A route both drives issued with different statuses is a server response difference. A one-sided page-load request is recorded, not asserted; a one-sided extension asset fails.',
    generatedAt: new Date().toISOString(),
};

const text = `${JSON.stringify(comparison, null, 2)}\n`;
if (outPath) await fs.writeFile(outPath, text);
process.stdout.write(text);

// The exit status is the verdict: 0 only for PASS. UPSTREAM_FAIL is not a pass -- it is evidence that
// the pair cannot support a compatibility claim, which is exactly what the runner must not count.
process.exit(overall === 'PASS' ? 0 : 1);
