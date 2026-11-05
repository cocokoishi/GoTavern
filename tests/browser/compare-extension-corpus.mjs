#!/usr/bin/env node
// JUDGE ONE CORPUS PAIR: the SAME browser drive over a SET of pinned third-party extensions, one leg on
// stock SillyTavern and one on GoTavern.
//
// The corpus surface asks a different question from the lifecycle surface: not "does extension X activate,
// persist, disable and uninstall", but "with the WHOLE pinned set installed at once, does the pinned
// frontend load every extension's assets, produce the same API surface, reach the same final page state,
// and stay healthy under a repeated drive -- identically on both subjects?"
//
// Verdict taxonomy (AGENTS.md differential doctrine 5):
//   PASS           every applicable fact matched and the soak (when requested) was measured and not regressed
//   FAIL           a Go-only divergence, a missing extension asset on Go, or an unmeasured requested metric
//   UPSTREAM_FAIL  stock itself failed or did not load the set; the pair cannot support a Go claim
//   N/A            the mode requests no soak and the set is empty (recorded, never silently green)
//
// WHAT IS ASSERTED VS RECORDED. Status sets and JSON SHAPES are asserted for API calls both legs issued; a
// route issued by only one leg is recorded as a page-load difference (a page-load difference is not a
// server response difference). A LIVE-EGRESS route (/api/horde/) records membership and status but NOT its
// body: the pinned handler fetches the real internet, so a body difference there would be the internet
// (this exact false finding was measured on the lifecycle surface; the exclusion is inherited, not new).
// Browser errors are asserted only when GoTavern produced one stock did not; shared errors are upstream.
//
// Usage:
//   node compare-extension-corpus.mjs <go-before> <pinned-before> [--after <go-after> <pinned-after>]
//       [--expected a,b,c] [--mode load|soak] [--out <file>]

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

function argument(name, fallback = null) {
    const index = process.argv.indexOf(name);
    if (index < 0) return fallback;
    const value = process.argv[index + 1];
    return value === undefined ? fallback : value;
}

function splitSections(argv) {
    const sections = { before: [], after: [] };
    const flags = { expected: null, mode: null, out: null };
    let section = 'before';
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        if (token === '--after') { section = 'after'; continue; }
        if (token === '--before') { section = 'before'; continue; }
        if (token === '--expected' || token === '--mode' || token === '--out') {
            const value = argv[index + 1];
            index += 1;
            if (token === '--expected') flags.expected = value ?? null;
            if (token === '--mode') flags.mode = value ?? null;
            if (token === '--out') flags.out = value ?? null;
            continue;
        }
        sections[section].push(token);
    }
    return { sections, flags };
}

const { sections, flags } = splitSections(process.argv.slice(2));
if (sections.before.length !== 2 || (sections.after.length !== 0 && sections.after.length !== 2)) {
    console.error('usage: node compare-extension-corpus.mjs <go-before> <pinned-before> [--after <go-after> <pinned-after>] [--expected a,b] [--mode load|soak] [--out <file>]');
    process.exit(2);
}
const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const [goBefore, pinBefore] = await Promise.all(sections.before.map(read));
const [goAfter, pinAfter] = sections.after.length === 2 ? await Promise.all(sections.after.map(read)) : [null, null];

const guards = [];
const rows = [];
function add(name, ok, detail = null) {
    guards.push({ name, ok: ok === true, detail });
    return ok === true;
}

const mode = flags.mode ?? goBefore.mode ?? pinBefore.mode ?? 'load';
const LIVE_EGRESS_PREFIXES = ['/api/horde/'];
const isLiveEgress = pathName => LIVE_EGRESS_PREFIXES.some(prefix => pathName.startsWith(prefix));

// ---- PROVENANCE: the pair must describe the SAME set, mode, lock and metadata ------------------------
const namesOf = leg => (leg.extensions ?? []).map(entry => entry.name);
const expected = flags.expected
    ? flags.expected.split(',').map(name => name.trim()).filter(Boolean)
    : (goBefore.plan?.names ?? namesOf(goBefore));

add('legs-are-corpus-surface', goBefore.surface === 'third-party-extension-corpus' && pinBefore.surface === 'third-party-extension-corpus', { go: goBefore.surface, pinned: pinBefore.surface });
add('subjects-are-opposite', goBefore.subject === 'gotavern' && pinBefore.subject === 'pinned', { go: goBefore.subject, pinned: pinBefore.subject });
add('modes-agree', String(goBefore.mode) === String(pinBefore.mode) && String(goBefore.mode) === String(mode), { go: goBefore.mode, pinned: pinBefore.mode, compared: mode });
const goNames = new Set(namesOf(goBefore));
const pinNames = new Set(namesOf(pinBefore));
add('set-matches-between-legs', goNames.size === pinNames.size && [...goNames].every(name => pinNames.has(name)), { go: [...goNames], pinned: [...pinNames] });
const missingFromGo = expected.filter(name => !goNames.has(name));
const missingFromPinned = expected.filter(name => !pinNames.has(name));
add('expected-set-present-on-gotavern', missingFromGo.length === 0, { expected, missing: missingFromGo });
add('expected-set-present-on-stock', missingFromPinned.length === 0, { expected, missing: missingFromPinned });
// AN EMPTY CORPUS IS NOT A PASS. `expected` falls back to the leg's own plan when no --expected is supplied,
// so a leg that recorded no extensions makes every `.every(...)` below true and can reach PASS with zero
// extensions compared. This guard pins the expected count and the recorded count, so the vacuous shape is
// a named failure (F15's class, in the corpus comparator).
add('expected-set-declared', expected.length > 0, { expected, source: flags.expected ? '--expected' : 'the leg plan' });
add('corpus-recorded-extensions', goNames.size > 0 && pinNames.size > 0, { gotavern: [...goNames], pinned: [...pinNames] });
const lockHashes = [goBefore, pinBefore, ...(goAfter ? [goAfter] : []), ...(pinAfter ? [pinAfter] : [])].map(leg => leg.provenance?.lockSha256 ?? null);
add('lock-hashes-agree', new Set(lockHashes).size === 1 && lockHashes[0] !== null, { lockHashes });
const configHashes = [goBefore, pinBefore, ...(goAfter ? [goAfter] : []), ...(pinAfter ? [pinAfter] : [])].map(leg => leg.provenance?.legConfig?.sha256 ?? null);
add('config-bytes-agree', new Set(configHashes).size === 1 && configHashes[0] !== null, { configHashes });
const phaseObserved = leg => leg?.phase ?? null;
add('phases-are-distinct', phaseObserved(goBefore) === 'before' && phaseObserved(pinBefore) === 'before' && (!goAfter || (phaseObserved(goAfter) === 'after' && phaseObserved(pinAfter) === 'after')), { goBefore: phaseObserved(goBefore), pinnedBefore: phaseObserved(pinBefore), goAfter: phaseObserved(goAfter), pinnedAfter: phaseObserved(pinAfter) });

// ---- LEG FAILURES: a leg that did not measure is never a comparison ---------------------------------
const goFailure = goBefore.failure ?? null;
const pinFailure = pinBefore.failure ?? null;
const goAfterFailure = goAfter?.failure ?? null;
const pinAfterFailure = pinAfter?.failure ?? null;
add('gotavern-legs-drove', goFailure === null && goAfterFailure === null, { before: goFailure, after: goAfterFailure });
add('stock-legs-drove', pinFailure === null && pinAfterFailure === null, { before: pinFailure, after: pinAfterFailure });

// ---- PER-EXTENSION LOADED PARITY --------------------------------------------------------------------
const byName = leg => new Map((leg.extensions ?? []).map(entry => [entry.name, entry]));
const goExtensions = byName(goBefore);
const pinExtensions = byName(pinBefore);
const extensionRows = [];
for (const name of expected) {
    const go = goExtensions.get(name) ?? null;
    const pin = pinExtensions.get(name) ?? null;
    if (!go) { extensionRows.push({ name, verdict: 'FAIL', reason: 'the extension is in the expected set and absent from the GoTavern leg, so it was never driven' }); continue; }
    if (!pin) { extensionRows.push({ name, verdict: 'UPSTREAM_FAIL', reason: 'the extension is in the expected set and absent from the stock leg, so stock set cannot support the claim' }); continue; }
    const problems = [];
    if (go.loaded !== true) problems.push(`the GoTavern page never fetched a loadable asset of ${name}${go.firstFailingUrl ? ` (first failure ${go.firstFailingUrl} -> ${go.firstFailingStatus})` : ''}`);
    if (pin.loaded === true && go.loaded !== true) problems.push('the extension loads on stock and not on GoTavern');
    if (pin.loaded !== true) problems.push(`stock itself did not load ${name}${pin.firstFailingUrl ? ` (first failure ${pin.firstFailingUrl} -> ${pin.firstFailingStatus})` : ''}`);
    extensionRows.push({
        name,
        verdict: problems.length === 0 ? 'PASS' : (pin.loaded === true ? 'FAIL' : 'UPSTREAM_FAIL'),
        loaded: { gotavern: go.loaded === true, pinned: pin.loaded === true },
        firstFailing: { gotavern: go.firstFailingUrl ?? null, pinned: pin.firstFailingUrl ?? null },
        reason: problems.length === 0 ? null : problems.join('; '),
    });
}
add('every-expected-extension-loaded-on-gotavern', extensionRows.every(row => row.verdict !== 'FAIL'), { failed: extensionRows.filter(row => row.verdict === 'FAIL').map(row => row.name) });
add('stock-loaded-every-expected-extension', extensionRows.every(row => row.verdict !== 'UPSTREAM_FAIL'), { failed: extensionRows.filter(row => row.verdict === 'UPSTREAM_FAIL').map(row => row.name) });

// ---- API / ASSET ROWS -------------------------------------------------------------------------------
function groupRows(leg) {
    const groups = new Map();
    for (const row of leg.rows ?? []) {
        const key = `${row.method} ${row.path}`;
        if (!groups.has(key)) groups.set(key, { method: row.method, path: row.path, statuses: [], shapes: [], occurrences: 0 });
        const group = groups.get(key);
        group.occurrences += 1;
        group.statuses.push(row.status);
        if (row.bodyShape !== undefined) group.shapes.push(row.bodyShape);
    }
    return groups;
}
const prefixOf = name => `/scripts/extensions/third-party/${name}/`;
const isExtensionAsset = pathName => expected.some(name => pathName.startsWith(prefixOf(name)));
function comparedRows(go, pin, assertShapes = true) {
    const left = groupRows(go);
    const right = groupRows(pin);
    const keys = [...new Set([...left.keys(), ...right.keys()])]
        .filter(key => isExtensionAsset(key.split(' ')[1]) || key.split(' ')[1].startsWith('/api/'))
        .sort();
    // A 304 IS A CACHE REVALIDATION, NOT A DIFFERENT RESPONSE. During the soak the page reloads; whether a
    // given asset is served 200 or answered 304 depends on the browser's cache state at that moment, so the
    // status SETS legitimately differ between the two subjects while the bytes the server would serve are
    // identical. Measured on the Windows local soak: Dooms-Enhancement-Suite's whatsNew.js and several
    // ReMemory modules were {200,304} on one subject and {200} on the other. 304 is dropped from the
    // comparison and recorded on the row; a 4xx/5xx is still a real difference.
    const statusSet = statuses => [...new Set(statuses.filter(status => status !== null && status !== 304))].sort((a, b) => a - b);
    const conditionalRevalidations = statuses => statuses.filter(status => status === 304).length;
    return keys.map(key => {
        const a = left.get(key) ?? null;
        const b = right.get(key) ?? null;
        const row = {
            method: (a ?? b).method, path: (a ?? b).path,
            kind: isExtensionAsset((a ?? b).path) ? 'extension-asset' : 'api',
            occurrences: { gotavern: a?.occurrences ?? 0, pinned: b?.occurrences ?? 0 },
            status: { gotavern: a ? statusSet(a.statuses) : [], pinned: b ? statusSet(b.statuses) : [] },
            conditional304: { gotavern: a ? conditionalRevalidations(a.statuses) : 0, pinned: b ? conditionalRevalidations(b.statuses) : 0 },
            bodyShape: { gotavern: a?.shapes?.[0] ?? null, pinned: b?.shapes?.[0] ?? null },
            classification: 'equal', reason: null, shapeAsserted: true,
        };
        if (!a) {
            row.classification = row.kind === 'extension-asset' ? 'missing-on-gotavern' : 'issued-only-by-stock';
            row.reason = row.kind === 'extension-asset'
                ? 'stock fetched this asset of the installed extension and GoTavern never did'
                : 'only the stock page load issued this API call; recorded as a page-load difference';
        } else if (!b) {
            row.classification = row.kind === 'extension-asset' ? 'extra-on-gotavern' : 'issued-only-by-gotavern';
            row.reason = 'only the GoTavern page load issued this request; recorded as a page-load difference';
        } else if (JSON.stringify(row.status.gotavern) !== JSON.stringify(row.status.pinned)) {
            row.classification = 'different-status';
            row.reason = 'both subjects issued this request and the status sets differ';
        } else if (isLiveEgress(row.path)) {
            row.classification = 'equal'; row.shapeAsserted = false;
            row.reason = 'the pinned handler for this path makes a live third-party request, so the body is whatever the internet returned (AGENTS 14); membership and status decide the row';
        } else if (row.bodyShape.gotavern !== null && row.bodyShape.pinned !== null && JSON.stringify(row.bodyShape.gotavern) !== JSON.stringify(row.bodyShape.pinned)) {
            if (assertShapes) {
                row.classification = 'different-shape';
                row.reason = 'both subjects issued this request with the same status but the JSON response shapes differ';
            } else {
                // A SOAK IS A STABILITY MEASUREMENT, NOT A SCHEMA MEASUREMENT. The soak's page reloads and
                // repeated sends change the STATE the API returns (`/api/chats/recent` is [] before the
                // chat is saved and one entry after), so a shape difference here is state, not schema. The
                // shape is still recorded on the row; schema parity is asserted by the load drive and by
                // the per-extension lifecycle legs, where the page is in a fixed state.
                row.shapeAsserted = false;
                row.reason = 'shape recorded but not asserted in soak mode: the soak page state changes between reloads, so a list length or presence difference is state, not schema';
            }
        }
        return row;
    });
}
const phaseRows = comparedRows(goBefore, pinBefore, mode === 'load');
const afterRows = goAfter && pinAfter ? comparedRows(goAfter, pinAfter, mode === 'load') : null;
const judgedRows = [...phaseRows, ...(afterRows ?? [])];
const assetFailures = judgedRows.filter(row => row.kind === 'extension-asset' && (row.classification === 'missing-on-gotavern'));
const responseFailures = judgedRows.filter(row => row.classification === 'different-status' || row.classification === 'different-shape');
add('no-extension-asset-missing-on-gotavern', assetFailures.length === 0, { failed: assetFailures.map(row => `${row.method} ${row.path}`) });
add('api-status-sets-agree', responseFailures.filter(row => row.classification === 'different-status').length === 0, { failed: responseFailures.filter(row => row.classification === 'different-status').map(row => ({ path: row.path, status: row.status })) });
add('api-json-shapes-agree', responseFailures.filter(row => row.classification === 'different-shape').length === 0, { failed: responseFailures.filter(row => row.classification === 'different-shape').map(row => row.path) });

// ---- BROWSER INTEGRITY ------------------------------------------------------------------------------
function integrity(go, pin, label) {
    const normalize = text => String(text).replace(/:\d+:\d+/g, ':LINE:COL').replace(/\b\d{4,}\b/g, 'N');
    // THE SOAK'S OWN CANCEL PATH. The soak cancels a streaming reply every third iteration, and the pinned
    // frontend reports that as "Generation was aborted." and "Clicked stop button". Whether those two
    // messages fall inside a phase depends on where the iteration boundary lands (measured: run 41587614145,
    // the AFTER phase saw them on GoTavern only), so in soak mode they are the drive's own signal, not a
    // Go-only error. They are still recorded under sharedErrors when both sides produced them.
    const soakNoise = /^(Generation was aborted\.|Clicked stop button)$/;
    // THE SAME ABORT IN ITS SECOND COSTUME. When the probe's stop lands on the NETWORK instead of in the
    // frontend's handler, the extension's own follow-up fetch is aborted mid-flight and the browser reports
    // `TypeError: Failed to fetch`. That is the same drive signal, measured twice: runs 41780365931 and
    // 41801638163 failed this guard with exactly one entry, Dooms' generateRaw abort, while both legs recorded
    // the same abort as "Cancelled by stop event" in the phases where it landed in the frontend. It is treated
    // as noise ONLY when the leg itself observed no failed API response (apiFailures === 0): a real network
    // failure reaches failedRequests/apiFailures and still fails this guard.
    // THE SAME ABORT IN ITS TWO COSTUMES, AND BOTH ARE THE DRIVE'S SIGNAL. The soak cancels a streaming reply
    // every third iteration. When that stop lands in the frontend's handler the extension logs
    // `Cancelled by stop event`; when it lands on the NETWORK the extension's own follow-up fetch is aborted
    // mid-flight and the browser logs `TypeError: Failed to fetch`. Runs 41780365931 and 41801638163 measured the
    // network costume alone on GoTavern while both legs recorded the frontend costume in other phases, and the
    // filter was written for that one costume only. `Third-party extension compatibility` run 42035843369 then
    // measured the MIRROR case: the frontend costume appeared on GoTavern and in neither pinned phase, so the
    // same drive signal failed this guard as a "Go-only error". Excusing one costume and not the other is the
    // asymmetry, not the product:
    //   * both are the probe's own STOP, emitted by the extension's handler, not by a response the server made;
    //   * the excuse is conditional on the leg itself observing NO failed API response (apiFailures === 0), so a
    //     real network failure still fails this guard through failedRequests/apiFailures, and
    //   * `tests/browser/extension-corpus-selftest.mjs` cases 7b/7c/7d/7e pin both costumes in both directions.
    const soakAbortNoise = /(?:TypeError: Failed to fetch|Cancelled by stop event)/;
    const collect = leg => [...(leg.pageErrors ?? []), ...(leg.consoleErrors ?? [])]
        .map(normalize)
        .filter(entry => {
            if (mode !== 'soak') return true;
            if (soakNoise.test(entry)) return false;
            if (soakAbortNoise.test(entry) && Number(leg.soak?.apiFailures ?? 0) === 0) return false;
            return true;
        });
    const goErrors = collect(go);
    const pinErrors = collect(pin);
    const pinSet = new Set(pinErrors);
    const goSet = new Set(goErrors);
    return {
        label,
        goOnlyErrors: [...goSet].filter(entry => !pinSet.has(entry)),
        stockOnlyErrors: [...pinSet].filter(entry => !goSet.has(entry)),
        sharedErrors: [...goSet].filter(entry => pinSet.has(entry)),
        goHttp5xx: (go.failedRequests ?? []).filter(entry => /^5\d\d/.test(String(entry))),
        stockHttp5xx: (pin.failedRequests ?? []).filter(entry => /^5\d\d/.test(String(entry))),
    };
}
const beforeIntegrity = integrity(goBefore, pinBefore, 'before');
const afterIntegrity = goAfter && pinAfter ? integrity(goAfter, pinAfter, 'after') : null;
const goOnlyErrors = [...beforeIntegrity.goOnlyErrors, ...(afterIntegrity?.goOnlyErrors ?? [])];
add('no-gotavern-only-browser-errors', goOnlyErrors.length === 0, { errors: goOnlyErrors.slice(0, 12) });

// ---- FINAL STATE ------------------------------------------------------------------------------------
function finalStateOf(leg) { return leg.finalState ?? {}; }
function compareFinalState(go, pin, label) {
    const a = finalStateOf(go); const b = finalStateOf(pin);
    const fields = ['settingsReady', 'extensionContainerCount', 'extensionSettingsPresent', 'characterListPresent', 'sendButtonPresent'];
    const differing = fields.filter(field => a[field] !== b[field]);
    return { label, differing, gotavern: Object.fromEntries(fields.map(field => [field, a[field] ?? null])), pinned: Object.fromEntries(fields.map(field => [field, b[field] ?? null])), equal: differing.length === 0 };
}
const beforeFinal = compareFinalState(goBefore, pinBefore, 'before');
const afterFinal = goAfter && pinAfter ? compareFinalState(goAfter, pinAfter, 'after') : null;
add('final-page-state-equal', beforeFinal.equal && (afterFinal === null || afterFinal.equal), { before: beforeFinal, after: afterFinal });

// After a restart BOTH legs must have reopened the same saved chat (the corpus leg sends a turn before
// the restart; a page that comes back on a new/empty chat is a restart-survival difference).
function chatState(leg) { return leg.chat ?? {}; }
if (goAfter && pinAfter) {
    const a = chatState(goAfter); const b = chatState(pinAfter);
    // THE AFTER-PHASE CHAT IS THE LOAD DRIVE'S EVIDENCE, NOT THE SOAK'S. The load drive sends one turn and
    // restarts, so a page that comes back on a new/empty chat is a restart-survival difference and the two
    // lengths must be equal. The soak's after phase runs its own 2-minute loop, so its chat length depends
    // on how many iterations fit (91 vs 127 in run 41595903508) and on whether the last iteration's send
    // was a retry whose reply had not arrived -- GoTavern's after chat held the retry's user message only
    // (length 1, last role user) while stock's held 3 (last role assistant). Neither is a restart-persistence
    // fact: the load drive and the per-extension lifecycle legs own that claim. In soak mode the guard is
    // that the page came back with an open, non-empty chat on BOTH legs; lengths and roles are recorded.
    if (mode === 'soak') {
        add('restart-chat-present', a.opened === true && b.opened === true && Number(a.chatLength) >= 1 && Number(b.chatLength) >= 1, { go: { chatLength: a.chatLength ?? null, lastIsUser: a.lastIsUser ?? null }, pinned: { chatLength: b.chatLength ?? null, lastIsUser: b.lastIsUser ?? null }, note: 'soak after-phase chat length depends on iteration count and retry placement; recorded, not asserted equal or role-matched' });
    } else {
        add('restart-reopened-the-chat', a.opened === true && b.opened === true && Number(a.chatLength) > 1 && Number(b.chatLength) > 1, { go: a, pinned: b });
        add('restart-chat-length-equal', Number(a.chatLength) === Number(b.chatLength), { go: a.chatLength ?? null, pinned: b.chatLength ?? null });
    }
}

// ---- SOAK METRICS -----------------------------------------------------------------------------------
// THE PROBE RECORDS THE SOAK'S RSS AS AN OBJECT (`{first,last,max,samples}`) AND ITS LATENCY AS A
// DISTRIBUTION, because a 30-minute window has a series rather than one sample. A comparator that read
// `entry.rssKb` as a number therefore saw nothing and failed `soak-metrics-measured` on a run that had
// measured 88 and 103 iterations (measured: run 41587614145, both legs' RSS series present). Read the
// recorded shape, and keep the MAX as the guard's subject: a regression is a peak, not a first sample.
const rssOf = entry => typeof entry.rssKb === 'number'
    ? entry.rssKb
    : (typeof entry.rssKb?.max === 'number' ? entry.rssKb.max : (typeof entry.rssKb?.last === 'number' ? entry.rssKb.last : null));
const percentileOf = (entry, name) => (typeof entry.latencyMs?.[name] === 'number' ? entry.latencyMs[name] : (typeof entry[name] === 'number' ? entry[name] : null));
function soakOf(...legs) {
    const measured = legs.filter(Boolean).map(leg => leg.soak).filter(Boolean);
    if (measured.length === 0) return { requested: false };
    const rss = measured.map(rssOf).filter(value => typeof value === 'number');
    const p95 = measured.map(entry => percentileOf(entry, 'p95')).filter(value => typeof value === 'number');
    const iterations = measured.reduce((sum, entry) => sum + (entry.iterations ?? 0), 0);
    const apiResponses = measured.reduce((sum, entry) => sum + (entry.apiResponses ?? 0), 0);
    const failures = measured.reduce((sum, entry) => sum + (entry.apiFailures ?? 0), 0);
    const serverErrors = measured.reduce((sum, entry) => sum + (entry.serverErrors ?? 0), 0);
    return {
        requested: true,
        minutes: measured.reduce((sum, entry) => sum + (entry.minutes ?? 0), 0),
        iterations, apiResponses, apiFailures: failures, serverErrors,
        failureRate: apiResponses > 0 ? failures / apiResponses : null,
        rssKb: rss.length > 0 ? Math.max(...rss) : null,
        p50: measured.map(entry => percentileOf(entry, 'p50')).filter(value => typeof value === 'number').sort((a, b) => a - b)[0] ?? null,
        p95: p95.length > 0 ? Math.max(...p95) : null,
        unmeasured: measured.flatMap(entry => entry.unmeasured ?? []),
    };
}
const goSoak = soakOf(goBefore, goAfter);
const pinSoak = soakOf(pinBefore, pinAfter);
let soakVerdict = 'N/A';
if (mode === 'soak') {
    const goMeasured = typeof goSoak.rssKb === 'number' && typeof goSoak.p95 === 'number';
    const pinMeasured = typeof pinSoak.rssKb === 'number' && typeof pinSoak.p95 === 'number';
    const rssGuard = goMeasured && pinMeasured ? goSoak.rssKb <= 3 * pinSoak.rssKb : false;
    const p95Guard = goMeasured && pinMeasured ? goSoak.p95 <= 3 * pinSoak.p95 : false;
    const serverErrorGuard = goSoak.serverErrors === 0 || pinSoak.serverErrors > 0;
    add('soak-metrics-measured', goMeasured && pinMeasured, { gotavern: { rssKb: goSoak.rssKb, p95: goSoak.p95 }, pinned: { rssKb: pinSoak.rssKb, p95: pinSoak.p95 }, unmeasured: [...(goSoak.unmeasured ?? []), ...(pinSoak.unmeasured ?? [])] });
    add('soak-rss-not-regressed-3x', rssGuard, { gotavernMaxRssKb: goSoak.rssKb, stockMaxRssKb: pinSoak.rssKb });
    add('soak-p95-not-regressed-3x', p95Guard, { gotavernP95: goSoak.p95, stockP95: pinSoak.p95 });
    add('soak-no-gotavern-only-5xx', serverErrorGuard, { gotavernServerErrors: goSoak.serverErrors, stockServerErrors: pinSoak.serverErrors });
    soakVerdict = rssGuard && p95Guard && serverErrorGuard && goMeasured && pinMeasured ? 'PASS' : 'FAIL';
}

// ---- VERDICT ----------------------------------------------------------------------------------------
const goBroken = goFailure !== null || goAfterFailure !== null;
const stockBroken = pinFailure !== null || pinAfterFailure !== null;
const failedGuards = guards.filter(entry => !entry.ok).map(entry => entry.name);
let verdict;
if (goBroken) verdict = 'FAIL';
else if (stockBroken) verdict = 'UPSTREAM_FAIL';
else if (failedGuards.length === 0) verdict = 'PASS';
else {
    // A failure caused ONLY by the stock leg not loading an extension is UPSTREAM_FAIL, not a Go defect.
    const onlyStockExtensionFailures = extensionRows.every(row => row.verdict !== 'FAIL') && extensionRows.some(row => row.verdict === 'UPSTREAM_FAIL');
    verdict = onlyStockExtensionFailures ? 'UPSTREAM_FAIL' : 'FAIL';
}

const comparison = {
    schemaVersion: 1,
    surface: 'third-party-extension-corpus',
    question: 'With the pinned third-party set installed at once, does the pinned frontend load every extension, issue the same API surface, reach the same final state and survive a repeated drive/restart identically on stock SillyTavern and GoTavern?',
    mode,
    expected,
    captures: [...sections.before, ...sections.after].map(file => path.basename(file)),
    guards: Object.fromEntries(guards.map(entry => [entry.name, entry.ok])),
    guardDetails: guards,
    failedGuards,
    verdict,
    extensions: extensionRows,
    rows: judgedRows,
    integrity: { before: beforeIntegrity, after: afterIntegrity },
    finalState: { before: beforeFinal, after: afterFinal },
    soak: mode === 'soak' ? { verdict: soakVerdict, gotavern: goSoak, stock: pinSoak } : { verdict: 'N/A', reason: 'mode is load, so no soak metrics were requested (recorded, not silently green)' },
    notes: {
        liveEgress: 'Rows under /api/horde/ record membership and status only; the pinned handler calls the live internet, so the body is not a server property (AGENTS 14).',
        shapes: 'JSON response bodies are compared by bounded shape, never by digest',
    },
    generatedAt: new Date().toISOString(),
};
const text = `${JSON.stringify(comparison, null, 2)}\n`;
if (flags.out) {
    await fs.writeFile(flags.out, text);
    // STDOUT IS A SUMMARY WHEN A FILE IS THE ARTEFACT: the row list runs to megabytes and a caller that
    // captures stdout through a pipe (spawnSync's default maxBuffer) would die with ENOBUFS.
    process.stdout.write(`${JSON.stringify({ verdict, failedGuards, guardCount: guards.length, extensions: extensionRows.length, failedExtensions: extensionRows.filter(row => row.verdict === 'FAIL').map(row => row.name), soak: comparison.soak.verdict, out: flags.out }, null, 2)}\n`);
} else {
    process.stdout.write(text);
}
process.exit(verdict === 'PASS' ? 0 : 1);
