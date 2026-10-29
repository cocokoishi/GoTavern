#!/usr/bin/env node
// THE TEETH OF THE COMPARATORS AND EVIDENCE MODULES THAT HAD NO SELF-TEST VEHICLE.
//
// WHY THIS FILE EXISTS. `docs/verifier-audit.md` found guards whose name promised a check the code did not
// perform. Four of the files it named already have a vehicle (`streaming-framing-selftest.mjs`,
// `streaming-framing-verifier-selftest.mjs`, `authors-note-gate-selftest.mjs`, `asset-gate-selftest.mjs`,
// `preset-gate-selftest.mjs`); the ones below had NONE, so a fix in them could only be argued from a diff.
// Each case here is the mutation the OLD code accepted and the NEW code refuses, and each asserts the
// failure BY NAME. Nothing is stubbed: the comparators are spawned as CI spawns them, and the evidence
// modules are imported, so the code under test is the code that runs.
//
// THE CASES, and the finding each one is:
//   F6  invariants.mjs: the cancellation prefix property must be recomputed for BOTH subjects. A hand-edited
//       `abortTextIsPrefixOfStreamedReply: true` beside a PINNED aborted text that is not a prefix is the
//       input the old recompute (`abortedText(block)` twice) could not see.
//   F8  compare-startup-legs.mjs: a final-state key recorded on NEITHER leg is UNMEASURED, not equal. The old
//       fixed-list comparison put `null == null` in `equalFields` and called it compared.
//   F9  compare-helper-generation.mjs: a leg that never ran must not report `driveCompleted: true`. (The
//       `Boolean(leg) &&` this case guards is already present at HEAD; this case is what keeps it there, and
//       the finding's premise is examined in the report rather than assumed.)
//   F11 compare-helper-vars-legs.mjs / compare-helper-vars-generate-legs.mjs: `sameApiSurface` compared the
//       pinned subject against ITSELF, so two legs agreeing on a commit that is NOT the pinned revision
//       passed. Both comparators must refuse it.
//   F12 catalog-checks.mjs: `proxyCredentialRow`'s `surface` parameter must select where the field is read
//       (the old ternary had the same expression in both branches), and `artifactNamesItsSource` must FAIL
//       on an evidence field the catalogue row does not declare instead of only observing.
//   F13 compare-streaming-legs.mjs: the comparator must exit non-zero when a check is false (the workflow's
//       `|| { echo "the streaming comparison refused" }` branch was dead), and `finalTextNonEmpty` must be
//       declared once.
//
// Run: node tests/browser/verifier-guards-gate-selftest.mjs     (exit 0 = every case behaved as required)

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { artifactNamesItsSource, proxyCredentialRow } from '../../tools/browser-evidence/catalog-checks.mjs';
import { streamingSurfacesProven } from '../../tools/browser-evidence/invariants.mjs';
import { BY_ID, SOURCES } from './sources.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const work = mkdtempSync(path.join(os.tmpdir(), 'verifier-guards-selftest-'));
const write = (name, value) => {
    const file = path.join(work, name);
    writeFileSync(file, JSON.stringify(value, null, 2));
    return file;
};

const failures = [];
let cases = 0;
const record = (name, ok, detail) => {
    cases += 1;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail && !ok ? ` -- ${detail}` : ''}`);
    if (!ok) failures.push(name);
};

// ---------------------------------------------------------------------------------------------
// F6 -- THE CANCELLATION PREFIX PROPERTY, RECOMPUTED FOR BOTH SUBJECTS.
// ---------------------------------------------------------------------------------------------
const WORDS = ['Hello', ' from', ' the', ' stream'];
const renderStates = count => WORDS.slice(0, count).map((_, index) => WORDS.slice(0, index + 1).join(''));
const WHOLE = WORDS.join('');
const PARTIAL = renderStates(2).at(-1);

const streamingLeg = ({ finalText, texts, disconnected = true, stopPresent = true }) => ({
    providerRequests: [{ method: 'POST', path: '/v1/chat/completions', bodyLength: 7400, bodySha256: 'a'.repeat(64), clientDisconnected: disconnected, framesWritten: 5 }],
    renderTexts: texts,
    finalAssistantText: finalText,
    streamState: {
        sawIncremental: true,
        contentSnapshotsBeforeEnd: Math.max(1, texts.length),
        stopPresent,
        stopClickedAt: null,
        textAfterStop: finalText,
        textLater: finalText,
        snapshotsAtStopPlus1200: texts.length,
        snapshotsLater: texts.length,
    },
});

const methodAndPath = block => block.gotavern.providerRequests.map(request => `${request.method} ${request.path}`);
const digests = block => block.gotavern.providerRequests.map(request => [request.bodyLength, request.bodySha256]);

/** The `checks` a surface carries, derived from the legs so the recompute agrees with every one of them. */
function checksFor(surface, block) {
    const gotavern = block.gotavern;
    const pinned = block.pinned;
    const texts = leg => (leg.renderTexts ?? []).filter(text => text && text !== '…' && text !== 'probe user marker');
    const common = {
        requestArrivedBoth: true,
        providerRequestCountEqual: gotavern.providerRequests.length === pinned.providerRequests.length,
        providerRequestMethodsAndPathsEqual: JSON.stringify(methodAndPath(block)) === JSON.stringify(pinned.providerRequests.map(request => `${request.method} ${request.path}`)),
        providerBodyEqual: JSON.stringify(digests(block)) === JSON.stringify(pinned.providerRequests.map(request => [request.bodyLength, request.bodySha256])),
        finalTextNonEmpty: String(gotavern.finalAssistantText ?? '').length > 0 && String(pinned.finalAssistantText ?? '').length > 0,
        streamedRenderPrefixes: true,
        pagesHaveNoErrors: true,
        requestStreamFlagMatches: true,
    };
    if (surface === 'nonstream') {
        return { ...common, finalTextEqual: (gotavern.finalAssistantText ?? null) === (pinned.finalAssistantText ?? null), singleContentStateOnly: texts(gotavern).length === 1 && texts(pinned).length === 1 };
    }
    if (surface === 'streaming') {
        return {
            ...common,
            finalTextEqual: (gotavern.finalAssistantText ?? null) === (pinned.finalAssistantText ?? null),
            clientDisconnectedMatches: true,
            incrementalRenderingObserved: texts(gotavern).length >= 3 && texts(pinned).length >= 3 && gotavern.streamState.sawIncremental === true && pinned.streamState.sawIncremental === true,
            framesWrittenEqual: true,
        };
    }
    return {
        ...common,
        clientDisconnectedMatches: true,
        contentRenderedBeforeAbort: true,
        noFurtherChunksAppliedAfterAbort: true,
        abortControlUsed: true,
        // THE HAND-EDITED FLAG THIS CASE IS ABOUT: it claims the prefix property holds on both subjects.
        abortTextIsPrefixOfStreamedReply: true,
        finalTextEqualsAfterAbortState: true,
    };
}

/** A minimal streaming artefact that satisfies every other check, with the pinned aborted text chosen. */
function streamingArtifact({ pinnedAbortedText }) {
    const streaming = { gotavern: streamingLeg({ finalText: WHOLE, texts: renderStates(4) }), pinned: streamingLeg({ finalText: WHOLE, texts: renderStates(4) }) };
    const cancellation = { gotavern: streamingLeg({ finalText: PARTIAL, texts: renderStates(2) }), pinned: streamingLeg({ finalText: pinnedAbortedText, texts: renderStates(2) }) };
    const nonstream = { gotavern: streamingLeg({ finalText: WHOLE, texts: [WHOLE], disconnected: false }), pinned: streamingLeg({ finalText: WHOLE, texts: [WHOLE], disconnected: false }) };
    const blocks = { streaming, cancellation, nonstream };
    const artifact = { schemaVersion: 1, compatibleReady: true };
    for (const surface of ['streaming', 'cancellation', 'nonstream']) {
        artifact[surface] = { ...blocks[surface], checks: checksFor(surface, blocks[surface]), proven: true };
    }
    return artifact;
}

const findingsOf = artifact => {
    const findings = [];
    streamingSurfacesProven({ fail: message => findings.push(message), observe: () => {}, noteStale: () => {} }, artifact);
    return findings;
};

{
    // THE CONTROL: a pinned aborted text that IS a prefix must produce no finding, so the case below cannot
    // be passing because the recompute is simply always false.
    const healthy = findingsOf(streamingArtifact({ pinnedAbortedText: PARTIAL }));
    record('F6: a pinned aborted text that IS a prefix of the streamed reply produces no finding',
        healthy.length === 0, JSON.stringify(healthy.slice(0, 2)));
}
{
    const artifact = streamingArtifact({ pinnedAbortedText: 'something the provider never sent' });
    const findings = findingsOf(artifact);
    record('F6: a hand-edited abortTextIsPrefixOfStreamedReply beside a PINNED text that is not a prefix is named',
        findings.some(finding => finding.includes('cancellation.checks.abortTextIsPrefixOfStreamedReply is recorded true')),
        JSON.stringify(findings.slice(0, 3)));
}

// ---------------------------------------------------------------------------------------------
// F8 -- A FINAL-STATE KEY RECORDED ON NEITHER LEG IS UNMEASURED, NOT EQUAL.
// ---------------------------------------------------------------------------------------------
const runStartup = (gotavernFinalState, pinnedFinalState) => {
    const leg = finalState => ({ requests: [], finalState });
    const result = spawnSync(process.execPath, [
        path.join(here, 'compare-startup-legs.mjs'),
        write('startup-go-1.json', leg(gotavernFinalState)), write('startup-go-2.json', leg(gotavernFinalState)),
        write('startup-pin-1.json', leg(pinnedFinalState)), write('startup-pin-2.json', leg(pinnedFinalState)),
    ], { encoding: 'utf8', cwd: here });
    if (result.status !== 0) return { error: `exit ${result.status}: ${String(result.stderr).slice(0, 300)}` };
    try {
        return { finalState: JSON.parse(result.stdout).finalState };
    } catch (error) {
        return { error: `stdout was not JSON: ${String(error?.message ?? error)}` };
    }
};
{
    // THE MUTATION: the probe stopped recording every final-state field except `settingsReady` -- so
    // `quickReplyPresent` and the other 13 expected keys are absent from BOTH legs. Under the old fixed-list
    // comparison every one of them landed in `equalFields` as `null == null`, i.e. "compared and agrees".
    const { finalState, error } = runStartup({ settingsReady: true }, { settingsReady: true });
    const unmeasured = finalState?.unmeasuredFields ?? null;
    record('F8: a final-state key absent on BOTH legs is reported as unmeasured',
        Array.isArray(unmeasured) && unmeasured.includes('quickReplyPresent'),
        error ?? JSON.stringify({ unmeasuredFields: unmeasured, equalFields: finalState?.equalFields }));
    record('F8: a final-state key absent on BOTH legs is NOT counted equal',
        Array.isArray(finalState?.equalFields) && !finalState.equalFields.includes('quickReplyPresent') && !finalState.equalFields.includes('characterRows'),
        JSON.stringify(finalState?.equalFields ?? null));
    record('F8: the keys both legs DID record are still compared and still equal',
        Array.isArray(finalState?.equalFields) && finalState.equalFields.includes('settingsReady') && finalState.differences.length === 0,
        JSON.stringify({ equalFields: finalState?.equalFields ?? null, differences: finalState?.differences ?? null }));
}
{
    // A KEY PRESENT ON EXACTLY ONE LEG IS A DIFFERENCE, and it says WHICH side was absent: `null` as a value
    // and "the probe did not record this" are different facts, and only the second is a harness gap.
    const { finalState, error } = runStartup({ settingsReady: true, quickReplyPresent: true }, { settingsReady: true });
    record('F8: a key present on ONE leg is a difference that says WHICH side was absent',
        (finalState?.differences ?? []).some(entry => entry.field === 'quickReplyPresent' && entry.recorded?.pinned === false && entry.recorded?.gotavern === true),
        error ?? JSON.stringify(finalState?.differences ?? null));
}

// ---------------------------------------------------------------------------------------------
// F9 -- A LEG THAT NEVER RAN DOES NOT REPORT A COMPLETED DRIVE.
// ---------------------------------------------------------------------------------------------
{
    const result = spawnSync(process.execPath, [
        path.join(here, 'compare-helper-generation.mjs'),
        '--gotavern-on', path.join(work, 'a-leg-that-does-not-exist.json'),
        '--gotavern-off', write('helper-gen-go-off.json', {}),
        '--pinned-on', write('helper-gen-pin-on.json', {}),
        '--pinned-off', write('helper-gen-pin-off.json', {}),
    ], { encoding: 'utf8', cwd: here });
    let artifact = null;
    try { artifact = JSON.parse(result.stdout); } catch { artifact = null; }
    record('F9: a leg whose report is missing reports driveCompleted false (and does not throw)',
        artifact?.subjects?.gotavern?.legPresent === false && artifact?.subjects?.gotavern?.driveCompleted === false,
        JSON.stringify({ status: result.status, legPresent: artifact?.subjects?.gotavern?.legPresent, driveCompleted: artifact?.subjects?.gotavern?.driveCompleted, stderr: String(result.stderr).slice(0, 200) }));
}

// ---------------------------------------------------------------------------------------------
// F11 -- `sameApiSurface` COMPARES AGAINST THE PINNED REVISION, NOT AGAINST ITSELF.
// ---------------------------------------------------------------------------------------------
const helperScopes = Object.fromEntries(['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((key, index) => [key, index]));
const helperExports = Object.fromEntries(Array.from({ length: 14 }, (_, index) => [`e${index}`, index]));
const helperApiSurface = commit => ({ pinnedCommit: commit, manifestVersion: '4.11.3', scopes: helperScopes, exports: helperExports, absentConfirmed: [{ name: 'setVariables' }, { name: 'quiet option' }] });

for (const [comparator, label] of [['compare-helper-vars-legs.mjs', 'F11 (variables)'], ['compare-helper-vars-generate-legs.mjs', 'F11 (narrow/generate)']]) {
    const bothLegs = { apiSurface: helperApiSurface('a-commit-that-is-not-the-pinned-revision'), cases: [], steps: [] };
    const result = spawnSync(process.execPath, [
        path.join(here, comparator),
        '--gotavern-on', write(`${comparator}-go-on.json`, bothLegs),
        '--pinned-on', write(`${comparator}-pin-on.json`, bothLegs),
        '--gotavern-off', write(`${comparator}-go-off.json`, { cases: [], steps: [] }),
        '--pinned-off', write(`${comparator}-pin-off.json`, { cases: [], steps: [] }),
    ], { encoding: 'utf8', cwd: here });
    let artifact = null;
    try { artifact = JSON.parse(result.stdout); } catch { artifact = null; }
    record(`${label}: two legs agreeing on a commit that is NOT the pinned revision fail sameApiSurface`,
        artifact?.guards?.sameApiSurface === false && (artifact?.failedGuards ?? []).includes('sameApiSurface'),
        JSON.stringify({ status: result.status, sameApiSurface: artifact?.guards?.sameApiSurface, failedGuards: artifact?.failedGuards }));
}

// ---------------------------------------------------------------------------------------------
// F12 -- THE CATALOGUE CHECKS PERFORM THE CHECK THEIR NAMES CLAIM.
// ---------------------------------------------------------------------------------------------
const proxyCapable = SOURCES.find(source => source.proxy === 'capable-through-setting');
const seamless = SOURCES.find(source => source.id === 'custom') ?? BY_ID.get('custom');
{
    // THE TERNARY'S DEAD BRANCH, MADE LIVE: with a surface argument, the surface's own block is read. The
    // top-level field is the correct one here, so the OLD read (always top-level) passed while the nested
    // record -- the one the caller asked about -- said the credential did NOT travel.
    const nestedOnly = { proxyPasswordPresent: { gotavern: true, pinned: true }, generation: { proxyPasswordPresent: { gotavern: false, pinned: false } } };
    const findings = [];
    proxyCredentialRow({ fail: message => findings.push(message), observe: () => {} }, proxyCapable, nestedOnly, 'generation');
    record('F12: proxyCredentialRow reads the SURFACE the caller named rather than always the top level',
        findings.some(finding => finding.includes('proxyPasswordPresent.gotavern is false')),
        JSON.stringify({ source: proxyCapable?.id, findings }));
    const topLevelFindings = [];
    proxyCredentialRow({ fail: message => topLevelFindings.push(message), observe: () => {} }, proxyCapable, nestedOnly);
    record('F12: with no surface argument the top-level field is still the one read (the callers\' current shape)',
        topLevelFindings.length === 0, JSON.stringify(topLevelFindings));
}
{
    // AN ARTEFACT THAT NAMES ANOTHER SOURCE'S EVIDENCE FIELD. `custom` declares no evidence fields, so a
    // `driveParameters.seamEnvVar` in its artefact is a value that belongs to a different catalogue row --
    // the "openrouter legs written into the groq file" failure, one level over. The old function only
    // observed this.
    const foreign = { driveParameters: { seamEnvVar: 'GOTAVERN_GROQ_CHAT_URL', streamFrameCount: '14' } };
    const findings = [];
    artifactNamesItsSource({ fail: message => findings.push(message), observe: () => {} }, seamless, foreign);
    record('F12: an artefact carrying an evidence field its catalogue row does not declare is a FAILURE',
        findings.some(finding => finding.includes('names a DIFFERENT source')),
        JSON.stringify({ source: seamless?.id, findings }));
    const own = { driveParameters: { streamFrameCount: '14', customArtifactFrameCount: 'different' } };
    const ownFindings = [];
    artifactNamesItsSource({ fail: message => ownFindings.push(message), observe: () => {} }, seamless, own);
    record('F12: the same artefact without a foreign evidence field is NOT a failure',
        ownFindings.length === 0, JSON.stringify(ownFindings));
}

// ---------------------------------------------------------------------------------------------
// F13 -- THE STREAMING COMPARATOR EXITS NON-ZERO WHEN IT REFUSES.
// ---------------------------------------------------------------------------------------------
{
    const empty = write('stream-empty.json', {});
    const result = spawnSync(process.execPath, [
        path.join(here, 'compare-streaming-legs.mjs'), empty, empty, empty, empty, empty, empty,
    ], { encoding: 'utf8', cwd: here, env: { ...process.env, PROBE_SOURCE: 'custom' } });
    let artifact = null;
    try { artifact = JSON.parse(result.stdout); } catch { artifact = null; }
    record('F13: a comparison whose checks are false exits non-zero and names them on stderr',
        result.status === 1 && String(result.stderr).includes('the streaming comparison refused:'),
        JSON.stringify({ status: result.status, compatibleReady: artifact?.compatibleReady, stderr: String(result.stderr).slice(0, 240) }));
    // THE DUPLICATE KEY CANNOT BE SEEN AT RUNTIME: the later declaration silently wins, so a reintroduced
    // copy would be invisible in every artefact. The source is therefore read, and the check is the count.
    const source = readFileSync(path.join(here, 'compare-streaming-legs.mjs'), 'utf8');
    const declarations = (source.match(/^\s*finalTextNonEmpty:/gm) ?? []).length;
    record('F13: finalTextNonEmpty is declared exactly once (a duplicate key is invisible at runtime)',
        declarations === 1, `declarations=${declarations}`);
}

rmSync(work, { recursive: true, force: true });
console.log(`\n${cases - failures.length}/${cases} case(s) behaved as required`);
if (failures.length > 0) {
    console.error(`DECORATION: ${failures.join(', ')}`);
    process.exit(1);
}
