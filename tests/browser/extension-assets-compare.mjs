#!/usr/bin/env node
// COMPARE THE TWO EXTENSION ASSET-SERVING LEGS: does an installed third-party extension's manifest, module, stylesheet,
// locale and SECOND-LEVEL scripts arrive with the same status, content-type and bytes from both servers?
//
// WHY NOTHING HERE PARSES OR "UNDERSTANDS" A BODY. The contract on this surface is byte-oriented by design: the browser
// acts on the status, the content type and the bytes, and it fails in a way a user cannot act on when one of those is
// wrong (a `<script type="module">` fed `text/html` dies with "Unexpected token '<'"). So the guards are
// `status-equal:<url>`, `content-type-equal:<url>` and `bytes-equal:<url>` per URL, and there is no equivalence rule
// that could make two different responses compare equal -- no JSON re-serialisation, no charset forgiveness, no
// "well-formed JSON" test.
//
// WHAT EACH GUARD IS FOR, and how each can fail:
//   legsAreOneSubjectEach            the two reports are two DIFFERENT subjects (a leg compared with itself is not a pair)
//   discriminatorsDifferPerSubject   each leg installed its own identity file and fetched it THROUGH ITS OWN SUBJECT;
//                                    the served values must DIFFER (rule 50: a harness that cannot tell its subjects
//                                    apart cannot claim agreement between them). The discriminator URL is EXCLUDED from
//                                    the byte guards BY NAME, and only that URL.
//   url-set-equal                    both legs fetched the same URL set (a subject that redirected or a probe that
//                                    derived a different set is a difference, not a missing row)
//   fixture-bytes-served:<url>       on EACH subject, the served digest equals the digest the leg installed -- so
//                                    `bytes-equal` is equality of THE FIXTURE's bytes, not of two error pages
//   status-equal:<url>               e.g. a nested asset that 404s on one side only
//   content-type-equal:<url>         e.g. a nested asset served as text/html on one side only  <- the row's failure
//   bytes-equal:<url>                same status, same type, different bytes (a truncated file, a transformed one)
//   discover-lists-fixture           both subjects list the installed extension (pinned: src/endpoints/extensions.js:514-518)
//   missing-module-is-diagnosable    on BOTH subjects a listed extension whose module is missing answers a 404-class
//                                    status and NOT a 200 carrying HTML (pinned: src/users.js:1115)
//   judge-executed:<subject>         the leg's own judge block exists and says it ran; a report that never judged is
//                                    not evidence, whatever its steps say
//
// USAGE
//   node tests/browser/extension-assets-compare.mjs <gotavern-leg.json> <pinned-leg.json> [--out <verdict.json>]
//   node tests/browser/extension-assets-compare.mjs --selftest <gotavern-leg.json> <pinned-leg.json>
//
// EXIT: 0 when every guard held, 1 when one went red (the failing guard is NAMED), 2 on a refusal (a report is absent or
// unreadable -- a comparison of one report is not a comparison).

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const DISCIPLINED_EXCLUSIONS = new Set(['discriminator']);

function argumentValue(argv, name, fallback = null) {
    const index = argv.indexOf(name);
    if (index < 0) return fallback;
    const value = argv[index + 1];
    return value === undefined ? fallback : value;
}

export function loadReport(target) {
    const absolute = path.resolve(target);
    const text = fs.readFileSync(absolute, 'utf8');
    const report = JSON.parse(text);
    if (report === null || typeof report !== 'object' || typeof report.subject !== 'string') {
        throw new Error(`${absolute} is not an extension-assets leg report (no subject)`);
    }
    return { path: absolute, report };
}

// The guards, computed from the two reports. Pure: `--selftest` drives this with mutated reports, which is how the teeth
// are demonstrated without weakening a live assertion.
export function compareLegs(gotavern, pinned) {
    const guards = {};
    const failed = [];
    const guard = (name, ok, detail = null) => {
        guards[name] = { ok: Boolean(ok), detail };
        if (!ok) failed.push(name);
        return Boolean(ok);
    };

    guard('legsAreOneSubjectEach', gotavern.subject === 'gotavern' && pinned.subject === 'pinned',
        { gotavern: gotavern.subject, pinned: pinned.subject });

    // THE DISCRIMINATOR. Both legs install and fetch their own identity file; the served values must differ.
    const goDiscriminator = gotavern.discriminator ?? null;
    const pinnedDiscriminator = pinned.discriminator ?? null;
    guard('discriminatorsDifferPerSubject',
        typeof goDiscriminator?.served?.value === 'string' && goDiscriminator.served.value.length > 0
        && typeof pinnedDiscriminator?.served?.value === 'string' && pinnedDiscriminator.served.value.length > 0
        && goDiscriminator.served.value !== pinnedDiscriminator.served.value
        && goDiscriminator.served.value.startsWith('gotavern')
        && pinnedDiscriminator.served.value.startsWith('pinned'),
        {
            gotavern: goDiscriminator?.served ?? null,
            pinned: pinnedDiscriminator?.served ?? null,
            why: 'each value must be the string THAT leg installed and the subject served; identical values mean the two artefacts cannot be told apart',
        });

    const byPathAll = report => new Map((report.assets ?? []).map(asset => [asset.path, asset]));
    const goAssets = byPathAll(gotavern);
    const pinnedAssets = byPathAll(pinned);
    const comparedPaths = [...goAssets.keys()].filter(candidate => {
        const asset = goAssets.get(candidate);
        return !DISCIPLINED_EXCLUSIONS.has(asset?.class);
    }).sort();
    const pinnedCompared = [...pinnedAssets.keys()].filter(candidate => {
        const asset = pinnedAssets.get(candidate);
        return !DISCIPLINED_EXCLUSIONS.has(asset?.class);
    }).sort();
    guard('url-set-equal', JSON.stringify(comparedPaths) === JSON.stringify(pinnedCompared),
        { gotavern: comparedPaths, pinned: pinnedCompared });

    for (const candidate of comparedPaths) {
        const goAsset = goAssets.get(candidate);
        const pinnedAsset = pinnedAssets.get(candidate);
        const expectedGo = fixtureDigest(gotavern, candidate);
        const expectedPinned = fixtureDigest(pinned, candidate);
        if (!goAsset || !pinnedAsset) continue;
        guard(`fixture-bytes-served:${candidate}`,
            expectedGo !== null && expectedPinned !== null
            && goAsset.sha256 === expectedGo && pinnedAsset.sha256 === expectedPinned,
            { gotavern: { observed: goAsset.sha256, expected: expectedGo }, pinned: { observed: pinnedAsset.sha256, expected: expectedPinned } });
        guard(`status-equal:${candidate}`, goAsset.status === pinnedAsset.status, { gotavern: goAsset.status, pinned: pinnedAsset.status });
        guard(`content-type-equal:${candidate}`, goAsset.contentType === pinnedAsset.contentType, { gotavern: goAsset.contentType, pinned: pinnedAsset.contentType });
        guard(`bytes-equal:${candidate}`, goAsset.byteLength === pinnedAsset.byteLength && goAsset.sha256 === pinnedAsset.sha256,
            { gotavern: { byteLength: goAsset.byteLength, sha256: goAsset.sha256 }, pinned: { byteLength: pinnedAsset.byteLength, sha256: pinnedAsset.sha256 } });
    }

    // THE NEGATIVE CASE, on both subjects: a listed extension whose module is missing.
    const negativeModule = report => (report.negative ?? []).find(entry => entry.class === 'negative-module') ?? null;
    const goNegative = negativeModule(gotavern);
    const pinnedNegative = negativeModule(pinned);
    const diagnosable = entry => entry !== null && entry.status === 404 && entry.bodyStartsWithHtml !== true && !/^text\/html/i.test(String(entry.contentType ?? ''));
    guard('missing-module-is-diagnosable', diagnosable(goNegative) && diagnosable(pinnedNegative),
        { gotavern: goNegative === null ? null : { status: goNegative.status, contentType: goNegative.contentType, bodyStartsWithHtml: goNegative.bodyStartsWithHtml }, pinned: pinnedNegative === null ? null : { status: pinnedNegative.status, contentType: pinnedNegative.contentType, bodyStartsWithHtml: pinnedNegative.bodyStartsWithHtml } });

    // DISCOVERY: both list the fixture. Recorded separately from the asset guards because discovery names the extension
    // and its failure mode is "not listed at all", which is a different user-visible defect from "listed, dead".
    const listsFixture = report => {
        const local = report.discovery?.entries?.local ?? null;
        return Array.isArray(local) && local.includes('third-party/gotavern-asset-probe');
    };
    guard('discover-lists-fixture', listsFixture(gotavern) && listsFixture(pinned),
        { gotavern: gotavern.discovery?.entries?.local ?? null, pinned: pinned.discovery?.entries?.local ?? null });

    for (const [phase, report] of [['gotavern', gotavern], ['pinned', pinned]]) {
        guard(`judge-executed:${phase}`, report.judge?.executed === true && report.judge?.verdict === 'match' && report.judge?.countsAreNonZero === true,
            report.judge ?? null);
    }

    // THE VERDICT IS A TAXONOMY, NOT A BOOLEAN, and its words mean different fixes:
    //   match          every guard held
    //   unreached      a leg never REACHED its own judge, so the pair says nothing about the subjects
    //   harness-error  the two reports cannot be trusted as TWO runs (one subject twice, or discriminators that cannot
    //                  be told apart) -- the harness is what is broken, not the product
    //   mismatch       two subjects were observed and judged, and they disagree -- a PRODUCT finding
    const pairIdentityBroken = guards.legsAreOneSubjectEach?.ok !== true || guards.discriminatorsDifferPerSubject?.ok !== true;
    const judgeNeverRan = ['gotavern', 'pinned'].some(phase => {
        const entry = guards[`judge-executed:${phase}`];
        return entry !== undefined && entry.ok !== true && entry.detail?.executed !== true;
    });
    const verdict = failed.length === 0 ? 'match'
        : (pairIdentityBroken ? 'harness-error' : (judgeNeverRan ? 'unreached' : 'mismatch'));
    return { verdict, guards, failedGuards: failed, comparedUrls: comparedPaths };
}

// The digest the leg INSTALLED for the file a URL serves. `report.fixture.written` is keyed by the path under the
// extension directory, and the URL's tail after `<extensionDir>/` names it -- no digest is invented here.
function fixtureDigest(report, urlPath) {
    const written = report.fixture?.written ?? {};
    const marker = `/${report.fixture?.extensionDir ?? 'gotavern-asset-probe'}/`;
    const index = urlPath.indexOf(marker);
    if (index < 0) return null;
    const relative = urlPath.slice(index + marker.length);
    return written[relative]?.sha256 ?? null;
}

function emit(verdict, outPath) {
    for (const [name, entry] of Object.entries(verdict.guards)) {
        console.log(`${entry.ok ? 'ok  ' : 'FAIL'} ${name}${entry.ok ? '' : ' -- ' + JSON.stringify(entry.detail)}`);
    }
    console.log(`extension-assets verdict: ${verdict.verdict} (${Object.keys(verdict.guards).length} guard(s), ${verdict.failedGuards.length} red)`);
    if (outPath) {
        fs.writeFileSync(path.resolve(outPath), `${JSON.stringify(verdict, null, 2)}\n`);
        console.log(`verdict written to ${path.resolve(outPath)}`);
    }
    process.exit(verdict.verdict === 'match' ? 0 : 1);
}

function main() {
    const argv = process.argv.slice(2);
    const positional = argv.filter((entry, index) => !entry.startsWith('--') && argv[index - 1] !== '--out');
    if (argv.includes('--selftest')) return selftest(positional);
    if (positional.length !== 2) {
        console.error('usage: node tests/browser/extension-assets-compare.mjs <gotavern-leg.json> <pinned-leg.json> [--out <verdict.json>]');
        process.exit(2);
    }
    const loaded = [];
    for (const target of positional) {
        try {
            loaded.push(loadReport(target));
        } catch (error) {
            console.error(`REFUSING: ${target} cannot be read as a leg report (${String(error?.message ?? error)}); a comparison of one report is not a comparison`);
            process.exit(2);
        }
    }
    const [gotavern, pinned] = loaded.map(entry => entry.report);
    const verdict = compareLegs(gotavern, pinned);
    verdict.legs = loaded.map(entry => entry.path);
    return emit(verdict, argumentValue(argv, '--out'));
}

// -----------------------------------------------------------------------------------------------------------------
// THE TEETH. Three mutations the release gap names, each applied to a COPY of the live pair, each required to turn a
// NAMED guard red -- plus two refusal cases (an absent report, and a pair that cannot be told apart).
function selftest(positional) {
    if (positional.length !== 2) {
        console.error('usage: node tests/browser/extension-assets-compare.mjs --selftest <gotavern-leg.json> <pinned-leg.json>');
        process.exit(2);
    }
    const base = positional.map(target => loadReport(target).report);
    const [gotavern, pinned] = base;
    const cases = [];
    const record = (name, ok, detail) => {
        cases.push({ name, ok, detail });
        console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : ' -- ' + JSON.stringify(detail)}`);
    };
    const reference = compareLegs(gotavern, pinned);
    record('baseline-pair-is-green', reference.verdict === 'match', reference.failedGuards.slice(0, 6));
    // A copy per case, so no mutation can leak into the next one.
    const copy = value => JSON.parse(JSON.stringify(value));
    const nestedClassUrl = report => (report.assets ?? []).find(asset => asset.class === 'nested-module')?.path ?? null;
    const stylesheetUrl = report => (report.assets ?? []).find(asset => asset.class === 'stylesheet')?.path ?? null;

    // TEETH 1: a nested asset served with the WRONG CONTENT TYPE on one subject.
    const wrongType = copy(gotavern);
    const nestedUrl = nestedClassUrl(wrongType);
    for (const asset of wrongType.assets ?? []) {
        if (asset.path === nestedUrl) asset.contentType = 'text/html; charset=UTF-8';
    }
    const typeVerdict = compareLegs(wrongType, copy(pinned));
    record('wrong-content-type-on-a-nested-asset -> content-type-equal:<nested url> red',
        typeVerdict.failedGuards.includes(`content-type-equal:${nestedUrl}`),
        { expected: `content-type-equal:${nestedUrl}`, failed: typeVerdict.failedGuards.slice(0, 6) });

    // TEETH 2: one asset 404s on one subject.
    const missing = copy(gotavern);
    const stylesheet = stylesheetUrl(missing);
    for (const asset of missing.assets ?? []) {
        if (asset.path === stylesheet) {
            asset.status = 404;
            asset.contentType = 'text/plain; charset=utf-8';
            asset.byteLength = 9;
            asset.sha256 = '0'.repeat(64);
        }
    }
    const missingVerdict = compareLegs(missing, copy(pinned));
    record('one asset 404s -> status-equal:<url> red',
        missingVerdict.failedGuards.includes(`status-equal:${stylesheet}`),
        { expected: `status-equal:${stylesheet}`, failed: missingVerdict.failedGuards.slice(0, 6) });

    // TEETH 3: the extension installed ONE DIRECTORY DEEPER, so every URL the probe derived shifts and the subject
    // answers 404 to all of them. Applied by shifting the GoTavern leg's URL KEYS (what a deep install changes) and
    // setting their observations to the answer a deep install produces -- the comparator must notice that the two legs no
    // longer describe the same URL set, and must fail on it by name rather than comparing nothing.
    const deep = copy(gotavern);
    const shifted = (deep.assets ?? []).map(asset => {
        const markerPath = `/third-party/`;
        const index = asset.path.indexOf(markerPath);
        const shiftedPath = index < 0 ? asset.path : `${asset.path.slice(0, index + markerPath.length)}nested/${asset.path.slice(index + markerPath.length)}`;
        return {
            ...asset,
            path: shiftedPath,
            status: 404,
            contentType: 'text/plain; charset=utf-8',
            byteLength: 9,
            sha256: '0'.repeat(64),
        };
    });
    deep.assets = shifted;
    const deepVerdict = compareLegs(deep, copy(pinned));
    record('extension one directory deeper -> url-set-equal red (and every per-URL guard)',
        deepVerdict.failedGuards.includes('url-set-equal'),
        { expected: 'url-set-equal', failed: deepVerdict.failedGuards.slice(0, 6) });

    // REFUSAL 1: a leg report that is absent. The comparator must exit 2, never 0.
    const absent = path.join(path.dirname(path.resolve(positional[0])), 'extension-assets-selftest-absent.json');
    try {
        fs.rmSync(absent, { force: true });
    } catch {
        // nothing to remove
    }
    record('an ABSENT leg report is refused (exit 2), not compared',
        (() => {
            try {
                loadReport(absent);
                return false;
            } catch {
                return true;
            }
        })(),
        { path: absent });

    // REFUSAL 2: two reports that cannot be told apart (the same leg twice) -- rule 50's harness check.
    const identical = compareLegs(copy(gotavern), copy(gotavern));
    record('the SAME leg twice is not a pair (discriminator/one-subject guards red)',
        identical.failedGuards.includes('legsAreOneSubjectEach') && identical.failedGuards.includes('discriminatorsDifferPerSubject'),
        { failed: identical.failedGuards.slice(0, 6) });

    const failedCases = cases.filter(entry => !entry.ok);
    console.log(`[selftest] ${cases.length - failedCases.length}/${cases.length} case(s) behaved as required`);
    if (failedCases.length > 0) {
        console.error(`[selftest] DECORATION: ${failedCases.map(entry => entry.name).join(', ')}`);
        process.exit(1);
    }
    process.exit(0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))) {
    main();
}
