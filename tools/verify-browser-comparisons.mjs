#!/usr/bin/env node
// Verifies the committed browser-comparison artifacts against their own claims.
//
// WHAT THIS CAN AND CANNOT DO, stated first because the difference matters. The per-run leg files
// (startup-*.json, stream-*.json, gen-*.json) are gitignored ON PURPOSE: tests/browser/.gitignore
// records the reason -- "a committed leg invites someone to treat a known divergence as the expected
// value". So a job CANNOT recompute a comparison from its legs in CI, and an earlier attempt at that
// failed with ENOENT. It passed when tried by hand only because the untracked legs happened to be on
// that machine: the working tree, not the repository. That is rule 5 ("verify committed bytes, not
// working-tree bytes") in its most literal form.
//
// What the committed artifacts CAN support is a check that they are coherent with themselves and with
// the compatibility claim they underwrite:
//
//   1. a comparison may not record an UNEXPLAINED divergence -- every difference must carry a reason;
//   2. a `compatible` area may not rest on an artifact whose core claim is false (for generation that
//      is the provider request, which is the thing this project promises to reproduce);
//   3. the guards that say the differential was FAITHFUL must still hold, because a differential that
//      never reached the state it compares proves nothing.
//
// Exit code 1 with a named finding, never a bare failure: "which claim is unsupported" is the only
// useful output of a gate like this.

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const browserDir = path.resolve(here, '..', 'tests', 'browser');

const findings = [];

function fail(artifact, message) {
    findings.push(`${artifact}: ${message}`);
}

function read(artifact) {
    const file = path.join(browserDir, artifact);
    try {
        return JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
        fail(artifact, `cannot be read as JSON (${error.message})`);
        return null;
    }
}

function requireReason(where, entry) {
    const reason = entry?.knownReason;
    if (typeof reason !== 'string' || reason.trim() === '') {
        fail(where, `records a divergence with no knownReason: ${JSON.stringify(entry).slice(0, 300)}`);
    }
}

// ---- startup-comparison.json ----------------------------------------------------------------
const startup = read('startup-comparison.json');
if (startup) {
    if (startup.unexpectedCount !== 0) {
        fail('startup-comparison.json', `unexpectedCount is ${startup.unexpectedCount}, must be 0`);
    }
    if (Array.isArray(startup.unexpected) && startup.unexpected.length !== 0) {
        fail('startup-comparison.json', `unexpected[] holds ${startup.unexpected.length} entr(ies)`);
    }
    const guards = startup.guards ?? {};
    for (const guard of ['faithful', 'gotavernReachedUserState', 'pinnedReachedUserState']) {
        if (guards[guard] !== true) {
            fail('startup-comparison.json', `guards.${guard} is ${JSON.stringify(guards[guard])}, must be true`);
        }
    }
    const rows = Array.isArray(startup.rows) ? startup.rows : [];
    if (rows.length === 0) {
        fail('startup-comparison.json', 'rows[] is empty, so the comparison compared nothing');
    }
    for (const row of rows) {
        if (row.classification === 'equal') {
            continue;
        }
        requireReason(`startup-comparison.json ${row.method} ${row.path}`, row);
        if (row.needsAttention === true && row.unexpected !== false) {
            fail('startup-comparison.json', `${row.method} ${row.path} needsAttention without being classified unexpected:false`);
        }
    }
}

// ---- generation-openrouter-comparison.json ----------------------------------------------------
//
// The SECOND source measured end to end. It is a separate artifact because the two sources reach the
// recording peer differently (custom_url in the request body for `custom`, a pinned literal plus a seam
// for `openrouter`), and one artifact carrying both would have to say which mechanism produced which
// bytes. The checks are the same ones, deliberately, so neither source can be held to a weaker standard.
const openrouterGeneration = read('generation-openrouter-comparison.json');
if (openrouterGeneration) {
    if (openrouterGeneration.providerRequestEqual !== true) {
        fail('generation-openrouter-comparison.json', 'providerRequestEqual is not true, so the openrouter provider-wire claim is unsupported');
    }
    if (openrouterGeneration.requestArrived?.gotavern !== true || openrouterGeneration.requestArrived?.pinned !== true) {
        fail('generation-openrouter-comparison.json', 'requestArrived is not true on both legs, so a leg was never driven');
    }
    if (openrouterGeneration.milestoneEqual !== true) {
        fail('generation-openrouter-comparison.json', 'milestoneEqual is not true; an interleaved counting invocation that changes a compared milestone is a divergence, not context');
    }
    for (const [name, value] of Object.entries(openrouterGeneration.guards ?? {})) {
        if (value !== true) fail('generation-openrouter-comparison.json', `guard ${name} is not true`);
    }
    // The guard's MEANING must be recorded with it, or the next reader assumes the old window rule.
    const meaning = openrouterGeneration.guardMeaning?.sendWindowHoldsExactlyOneRealSendAndNoDryAssembly;
    if (typeof meaning !== 'string' || !meaning.includes('non-dry invocation')) {
        fail('generation-openrouter-comparison.json', 'guardMeaning for the send-window guard is missing or does not state the invocation-level rule');
    }
    // Every invocation trail must be present, so a reader can see the counting invocations that were
    // recorded and deliberately not attributed.
    if (!Array.isArray(openrouterGeneration.wholeDriveInvocations?.gotavern) || !Array.isArray(openrouterGeneration.wholeDriveInvocations?.pinned)) {
        fail('generation-openrouter-comparison.json', 'wholeDriveInvocations is missing a leg, so the counting invocations were not recorded');
    }
    // Say what was checked. A gate that reads an artifact silently gives a reader no way to tell a
    // passing check from an artifact the gate never opened.
    const openrouterPost = (openrouterGeneration.providerRequests?.gotavern ?? []).find((entry) => entry.method === 'POST');
    const openrouterBytes = openrouterPost?.bodyLength ?? 'unknown';
    const openrouterDiffs = Array.isArray(openrouterGeneration.bodyDifferences) ? openrouterGeneration.bodyDifferences.length : 0;
    console.log(`  generation-openrouter-comparison.json providerRequestEqual true, ${openrouterDiffs} documented body difference(s), ${openrouterBytes} B per leg`);
}
// ---- generation-claude-comparison.json --------------------------------------------------------
//
// The CLAUDE source measured end to end. Same checks as mistralai, plus the one this lane earned twice:
// EQUAL AND EMPTY IS NOT A PASS, so the final text must be non-empty on both legs. Claude is a no-validate
// source, so its script carries no /models entry, and the Anthropic body's text is deliberately distinct
// from the OpenAI one -- a mis-ordered script then shows as a DIFFERENT final text rather than an equal empty.
const claudeGeneration = read('generation-claude-comparison.json');
if (claudeGeneration) {
    if (claudeGeneration.providerRequestEqual !== true) fail('generation-claude-comparison.json', 'providerRequestEqual is not true');
    if (claudeGeneration.requestArrived?.gotavern !== true || claudeGeneration.requestArrived?.pinned !== true) fail('generation-claude-comparison.json', 'requestArrived is not true on both legs');
    if (claudeGeneration.milestoneEqual !== true) fail('generation-claude-comparison.json', 'milestoneEqual is not true');
    for (const [name, value] of Object.entries(claudeGeneration.guards ?? {})) {
        if (value !== true) fail('generation-claude-comparison.json', `guard ${name} is not true`);
    }
    if (claudeGeneration.guards?.finalTextNonEmpty !== true) fail('generation-claude-comparison.json', 'the finalTextNonEmpty guard is missing, so an empty-equals-empty artifact could pass');
    if (claudeGeneration.proxyPasswordPresent?.gotavern !== true || claudeGeneration.proxyPasswordPresent?.pinned !== true) fail('generation-claude-comparison.json', 'proxyPasswordPresent is not true on both legs');
    for (const leg of ['gotavern', 'pinned']) {
        const text = claudeGeneration.postSend?.[leg]?.finalAssistantText;
        if (typeof text !== 'string' || text.trim() === '') fail('generation-claude-comparison.json', `${leg}.finalAssistantText is empty, so the send rendered nothing`);
    }
    if (typeof claudeGeneration.driveParameters?.mode !== 'string') fail('generation-claude-comparison.json', 'driveParameters.mode is missing, so the artifact does not say which drive it describes');
}
// ---- generation-mistral-comparison.json -------------------------------------------------------
//
// The MISTRALAI source measured end to end in the browser. Same checks as the OpenRouter generation
// artifact, deliberately: a second source must not be held to a weaker standard.
const mistralGeneration = read('generation-mistral-comparison.json');
if (mistralGeneration) {
    if (mistralGeneration.providerRequestEqual !== true) {
        fail('generation-mistral-comparison.json', 'providerRequestEqual is not true, so the mistralai provider-wire claim is unsupported');
    }
    if (mistralGeneration.requestArrived?.gotavern !== true || mistralGeneration.requestArrived?.pinned !== true) {
        fail('generation-mistral-comparison.json', 'requestArrived is not true on both legs, so a leg was never driven');
    }
    if (mistralGeneration.milestoneEqual !== true) {
        const reason = mistralGeneration.milestoneDifferenceReason;
        if (typeof reason !== 'string' || reason.trim() === '') {
            fail('generation-mistral-comparison.json', 'milestoneEqual is false with NO milestoneDifferenceReason recorded');
        }
    }
    for (const [name, value] of Object.entries(mistralGeneration.guards ?? {})) {
        if (value !== true) fail('generation-mistral-comparison.json', `guard ${name} is not true`);
    }
    // THE CREDENTIAL TRAVELLED, stated without carrying it: with a reverse proxy set the pinned route reads
    // request.body.proxy_password and NOT the source secret, and answers a bare 400 {error:true} when it is
    // absent. A reader looking at a future 400 needs this in one glance.
    if (typeof mistralGeneration.proxyPasswordPresent?.gotavern !== 'boolean' || typeof mistralGeneration.proxyPasswordPresent?.pinned !== 'boolean') {
        fail('generation-mistral-comparison.json', 'proxyPasswordPresent is not recorded as a boolean for both legs');
    }
    if (mistralGeneration.proxyPasswordPresent.gotavern !== true || mistralGeneration.proxyPasswordPresent.pinned !== true) {
        fail('generation-mistral-comparison.json', 'proxyPasswordPresent is not true on both legs, so the credential did not travel and any 400 is about the credential');
    }
}
// ---- streaming-openrouter-comparison.json -----------------------------------------------------
//
// The OpenRouter source's C surface: a streamed reply, a cancellation, and the non-stream control, each
// driven on both legs. `compatibleReady` is the conjunction the row's claim rests on, so it must be TRUE
// here for a `compatible` claim to be possible at all; a missing leg or a missing cancellation proof is a
// FAILURE, never a vacuous pass.
const openrouterStreaming = read('streaming-openrouter-comparison.json');
if (openrouterStreaming) {
    for (const surface of ['streaming', 'cancellation', 'nonstream']) {
        const block = openrouterStreaming[surface];
        if (!block || typeof block !== 'object') {
            fail('streaming-openrouter-comparison.json', `the ${surface} block is missing, so that surface was never compared`);
            continue;
        }
        if (block.proven !== true) {
            const falseChecks = Object.entries(block.checks ?? {}).filter(([, value]) => value !== true).map(([name]) => name);
            fail('streaming-openrouter-comparison.json', `${surface}.proven is not true; failing checks: ${falseChecks.join(', ') || '(none isolated)'}`);
        }
        for (const leg of ['gotavern', 'pinned']) {
            const requests = block[leg]?.providerRequests;
            if (!Array.isArray(requests) || requests.length === 0) {
                fail('streaming-openrouter-comparison.json', `${surface}.${leg} records no provider request, so that leg was never driven`);
            }
        }
    }
    // CANCELLATION IS PROVED AT THE PROVIDER, not by the page stopping to render.
    for (const leg of ['gotavern', 'pinned']) {
        const requests = openrouterStreaming.cancellation?.[leg]?.providerRequests ?? [];
        if (!requests.some(request => request.clientDisconnected === true)) {
            fail('streaming-openrouter-comparison.json', `cancellation.${leg} does not record clientDisconnected true, so the teardown never reached the provider on that leg`);
        }
    }
    // THE TICK-ALIGNMENT REPLACEMENT: alignment is recorded, and the properties asserted in its place must
    // be present and boolean, so a future edit cannot quietly drop them and leave `proven` computed from
    // fewer claims than the artifact documents.
    for (const name of ['finalTextEqual', 'streamedRenderPrefixes', 'framesWrittenEqual', 'incrementalRenderingObserved']) {
        if (typeof openrouterStreaming.streaming?.checks?.[name] !== 'boolean') {
            fail('streaming-openrouter-comparison.json', `streaming.checks.${name} is missing or not boolean`);
        }
    }
    if (typeof openrouterStreaming.streaming?.renderTickAlignment?.tickByTickEqual !== 'boolean') {
        fail('streaming-openrouter-comparison.json', 'streaming.renderTickAlignment is missing, so the recorded (unasserted) tick alignment was not carried');
    }
    if (typeof openrouterStreaming.driveParameters?.streamFrameCount !== 'string') {
        fail('streaming-openrouter-comparison.json', 'driveParameters.streamFrameCount is missing, so the artifact does not say which drive it describes');
    }
    console.log(`  streaming-openrouter-comparison.json compatibleReady true, three surfaces proven, cancellation clientDisconnected on both legs`);
    if (openrouterStreaming.compatibleReady !== true) {
        fail('streaming-openrouter-comparison.json', 'compatibleReady is not true, so no compatible claim may cite this artifact');
    }
}
// ---- generation-comparison.json --------------------------------------------------------------
const generation = read('generation-comparison.json');
if (generation) {
    // The provider request is the promise (hard rule 7: "HTTP parity alone is insufficient").
    if (generation.providerRequestEqual !== true) {
        fail('generation-comparison.json', 'providerRequestEqual is not true, so the provider-wire claim is unsupported');
    }
    if (generation.requestArrived?.gotavern !== true || generation.requestArrived?.pinned !== true) {
        fail('generation-comparison.json', 'requestArrived is not true on both legs, so a leg was never driven');
    }
    const differences = Array.isArray(generation.bodyDifferences) ? generation.bodyDifferences : [];
    for (const entry of differences) {
        requireReason('generation-comparison.json bodyDifferences[]', entry);
    }
    // A milestone counter that differs is a divergence like any other, and until this check existed
    // `milestoneEqual: false` sat inside a `compatible` claim with no recorded reason anywhere.
    if (generation.milestoneEqual !== true) {
        const reason = generation.milestoneDifferenceReason;
        if (typeof reason !== 'string' || reason.trim() === '') {
            const left = generation.milestones?.gotavern ?? {};
            const right = generation.milestones?.pinned ?? {};
            const differing = [...new Set([...Object.keys(left), ...Object.keys(right)])]
                .filter(key => left[key] !== right[key])
                .map(key => `${key} gotavern=${JSON.stringify(left[key])} pinned=${JSON.stringify(right[key])}`);
            fail('generation-comparison.json',
                `milestoneEqual is false with NO milestoneDifferenceReason recorded; differing counters: ${differing.join('; ') || '(none isolated)'}`);
        }
    }
    // THE WINDOW GUARDS, checked HERE and not only in the compare script.
    //
    // compare-generation-legs.mjs exits 1 on a false guard, but that runs on the machine that
    // produces the artifact; this job reads the COMMITTED artifact. Until this block existed a false
    // guard could be committed and CI would stay green, because the only generation fields checked
    // were providerRequestEqual and milestoneEqual -- the "an artifact that cannot fail" pattern this
    // file exists to prevent. The finding that motivated them: `dryAfterData` gotavern=1 / pinned=2
    // was a recording window that began mid-dry-run, not a server difference.
    const generationGuards = [
        'bothLegsQuiescedBeforeSend',
        'bothLegsSettledAfterSend',
        'bothWindowsHoldCompleteGenerations',
        'sendWindowHoldsExactlyOneRealSendAndNoDryAssembly',
    ];
    if (!generation.guards || typeof generation.guards !== 'object') {
        fail('generation-comparison.json', 'has no guards block, so a recording-window divergence cannot be told apart from a product one');
    } else {
        for (const guard of generationGuards) {
            if (generation.guards[guard] !== true) {
                fail('generation-comparison.json', `guards.${guard} is ${JSON.stringify(generation.guards[guard])}, must be true`);
            }
        }
    }
    // The whole-drive invocation count is what makes the windowed counters readable: without it a
    // reader cannot tell a behaviour difference from a difference in where the window fell.
    for (const leg of ['gotavern', 'pinned']) {
        const whole = generation.surrounding?.[leg]?.wholeDrive;
        if (!whole || typeof whole.started !== 'number') {
            fail('generation-comparison.json', `surrounding.${leg}.wholeDrive is missing, so the windowed counters cannot be checked against the whole drive`);
            continue;
        }
        if (typeof whole.realStarted !== 'number' || whole.realStarted < 1) {
            fail('generation-comparison.json', `surrounding.${leg}.wholeDrive.realStarted is ${JSON.stringify(whole.realStarted)}, so that leg never ran a real generation`);
        }
    }
}

// ---- streaming-comparison.json ---------------------------------------------------------------
const streaming = read('streaming-comparison.json');
if (streaming) {
    if (streaming.compatibleReady !== true) {
        fail('streaming-comparison.json', 'compatibleReady is not true, so the streaming/cancel claim is unsupported');
    }
    for (const block of ['streaming', 'cancellation', 'nonstream']) {
        if (!streaming[block] || typeof streaming[block] !== 'object') {
            fail('streaming-comparison.json', `${block} block is missing, so that surface was not compared`);
        }
    }
}

// ---- data-domain-comparison.json -------------------------------------------------------------
// Carries the same guard shape as the others, so it gets the same treatment. The extra rule here is
// the one that makes an E promotion honest: a promoted cell must have demonstrated a WRITE in its own
// domain on both legs, because a drive that only reads cannot fail on a difference and would move a
// cell on the strength of "nothing went wrong".
const dataDomain = read('data-domain-comparison.json');
if (dataDomain) {
    if (dataDomain.unexpectedCount !== 0) {
        fail('data-domain-comparison.json', `unexpectedCount is ${dataDomain.unexpectedCount}, must be 0`);
    }
    if (Array.isArray(dataDomain.unexpected) && dataDomain.unexpected.length !== 0) {
        fail('data-domain-comparison.json', `unexpected[] holds ${dataDomain.unexpected.length} entr(ies)`);
    }
    for (const guard of ['faithful', 'gotavernReachedUserState', 'pinnedReachedUserState', 'bothLegsCompletedDrive', 'observedStableAcrossTwoRunsPerLeg']) {
        if (dataDomain.guards?.[guard] !== true) {
            fail('data-domain-comparison.json', `guards.${guard} is ${JSON.stringify(dataDomain.guards?.[guard])}, must be true`);
        }
    }
    const rows = Array.isArray(dataDomain.rows) ? dataDomain.rows : [];
    if (rows.length === 0) {
        fail('data-domain-comparison.json', 'rows[] is empty, so no domain was compared');
    }
    let promoted = 0;
    for (const row of rows) {
        if (row.promotable !== true) {
            continue;
        }
        promoted += 1;
        if (row.writeDemonstrated !== true) {
            fail('data-domain-comparison.json', `${row.domain}: promotable without writeDemonstrated -- a read-only drive cannot fail on a difference`);
        }
    }
    // A promotion count of zero is legitimate (nothing measured yet) but a claim of promotions with no
    // promotable row is not, so the two numbers are cross-checked instead of trusted separately.
    const claimed = Array.isArray(dataDomain.promotable) ? dataDomain.promotable.length : 0;
    if (claimed !== promoted) {
        fail('data-domain-comparison.json', `promotable[] lists ${claimed} domains but ${promoted} row(s) are promotable`);
    }
}

// ---- extension-tavern-helper-comparison.json -------------------------------------------------
// The extension pair is the only artifact whose CLAIM is about a frontend extension loading on a
// release-shaped install: the pinned Tavern Helper revision loads, discovers the same built-ins in
// the same order, and makes the same backend calls. What makes that checkable rather than asserted
// is the row set, the guards, and the two reasons a reader needs: one per divergent row, and one per
// DIVERGENT PATH THAT IS NOT A ROW (those are otherwise invisible to the row comparison).
for (const extensionArtifact of ['extension-tavern-helper-comparison.json', 'extension-littlewhitebox-comparison.json']) {
const extensionComparison = read(extensionArtifact);
if (extensionComparison) {
    const label = extensionArtifact;
    for (const guard of ['faithful', 'gotavernReachedUserState', 'pinnedReachedUserState', 'gotavernExtensionLoaded', 'pinnedExtensionLoaded', 'extensionRevisionMatches', 'startingStateMatches', 'configMatches']) {
        if (extensionComparison.guards?.[guard] !== true) {
            fail(label, `guards.${guard} is ${JSON.stringify(extensionComparison.guards?.[guard])}, so the pair does not support a claim`);
        }
    }
    if (!Array.isArray(extensionComparison.rows) || extensionComparison.rows.length === 0) {
        fail(label, 'has no rows');
    }
    for (const row of extensionComparison.rows ?? []) {
        if (row.classification !== 'equal') requireReason(`${label} ${row.method} ${row.path}`, row);
    }
    // A path difference without a reason is the reason-less divergence this gate exists to reject,
    // and a reason that does not name a mechanism is the same shape. The mechanism here is one of two
    // decided things: the Jimp codec boundary, or a page-load difference where the reason states which
    // leg issued the request and how both drives ended.
    for (const difference of extensionComparison.pathDifferences ?? []) {
        requireReason(`${label} pathDifferences ${difference.path}`, difference);
        const reason = difference.knownReason ?? '';
        const namesMechanism = reason.includes('Jimp') || (reason.includes('drive') && reason.includes('network-quiet'));
        if (!namesMechanism) {
            fail(label, `pathDifferences ${difference.path} has a reason that names no mechanism: ${JSON.stringify(reason)}`);
        }
    }
    // Both drives must have ended on the page's own quiet signal: a difference between two page loads
    // is only interpretable if neither leg was cut off mid-request.
    for (const leg of ['gotavern', 'pinned']) {
        if (extensionComparison.captureQuiet?.[leg]?.quiet !== true) {
            fail(label, `captureQuiet.${leg} is ${JSON.stringify(extensionComparison.captureQuiet?.[leg])}; a drive that ended without network quiet cannot be compared`);
        }
        if (Array.isArray(extensionComparison.captureQuiet?.[leg]?.unresolved) && extensionComparison.captureQuiet[leg].unresolved.length > 0) {
            fail(label, `captureQuiet.${leg} ended with unresolved requests: ${JSON.stringify(extensionComparison.captureQuiet[leg].unresolved)}`);
        }
    }
    // The extension's written user data: a `shape` field must not be recorded without a reason, and a
    // size or skeleton that does not match the other leg is a product difference, not a note.
    if (extensionComparison.userFiles?.shape?.length) {
        for (const key of extensionComparison.userFiles.shape) {
            const reason = extensionComparison.userFiles.shapeReason?.[key];
            if (typeof reason !== 'string' || reason.trim() === '') {
                fail(label, `userFiles.shape.${key} is classified shape with no reason`);
            }
        }
        if (extensionComparison.userFiles.matches !== true) {
            fail(label, 'userFiles entries differ in presence, size or JSON skeleton between the legs');
        }
    } else if (!Array.isArray(extensionComparison.userFiles?.entries) || extensionComparison.userFiles.entries.length === 0) {
        if (typeof extensionComparison.userFiles?.note !== 'string' || extensionComparison.userFiles.note.trim() === '') {
            fail(label, 'userFiles records no entries and no note saying so');
        }
    }

    // A committed artifact carries no host paths.
    const serialized = JSON.stringify(extensionComparison);
    for (const needle of ['C:\\', 'AppData', '/home/', '/Users/', '127.0.0.1', '/tmp/']) {
        if (serialized.includes(needle)) fail(label, `records host-derived value ${JSON.stringify(needle)}`);
    }
}

    console.log('  ' + extensionArtifact + ' ' + extensionComparison.rows.length + ' rows, ' + (extensionComparison.pathDifferences ?? []).length + ' non-row path difference(s), guards faithful');
}
// ---- generation-groq-comparison.json ----------------------------------------------------------

//

// The GROQ source measured end to end, and the one fact that makes its row different from every other

// generation row: groq is `proxy: false` in apiSourceConfig (openai.js:6050), so the frontend cannot be

// aimed at a recording peer through reverse_proxy AT ALL -- claude and mistralai carry the peer in that

// setting and their drive therefore submits a proxy_password. groq cannot, and the seam

// (GOTAVERN_GROQ_CHAT_URL) plus the pinned transport redirect are the ONLY way both legs reach one peer.

// `proxyPasswordPresent` is therefore recorded FALSE on both legs and ASSERTED here: the false is the

// evidence for the row's shape, not an absence of evidence.

const groqGeneration = read('generation-groq-comparison.json');

if (groqGeneration) {

    if (groqGeneration.providerRequestEqual !== true) {

        fail('generation-groq-comparison.json', 'providerRequestEqual is not true, so the groq provider-wire claim is unsupported');

    }

    if (groqGeneration.requestArrived?.gotavern !== true || groqGeneration.requestArrived?.pinned !== true) {

        fail('generation-groq-comparison.json', 'requestArrived is not true on both legs, so a leg was never driven');

    }

    if (groqGeneration.milestoneEqual !== true) {

        fail('generation-groq-comparison.json', 'milestoneEqual is not true; an interleaved counting invocation that changes a compared milestone is a divergence, not context');

    }

    for (const [name, value] of Object.entries(groqGeneration.guards ?? {})) {

        if (value !== true) fail('generation-groq-comparison.json', `guard ${name} is not true`);

    }

    const groqGuardMeaning = groqGeneration.guardMeaning?.sendWindowHoldsExactlyOneRealSendAndNoDryAssembly;
    if (typeof groqGuardMeaning !== 'string' || !groqGuardMeaning.includes('non-dry invocation')) {

        fail('generation-groq-comparison.json', 'guardMeaning for the send-window guard is missing or does not state the invocation-level rule');

    }

    if (!Array.isArray(groqGeneration.wholeDriveInvocations?.gotavern) || groqGeneration.wholeDriveInvocations.gotavern.length === 0

        || !Array.isArray(groqGeneration.wholeDriveInvocations?.pinned) || groqGeneration.wholeDriveInvocations.pinned.length === 0) {

        fail('generation-groq-comparison.json', 'wholeDriveInvocations is missing a leg or is empty, so the send window was judged on a trail nobody recorded');

    }

    // THE PAIRING RULE MUST BE IN THE ARTIFACT, and no assembly may be left unattributed.

    if (typeof groqGeneration.driveParameters?.invocationPairing !== 'string' || !groqGeneration.driveParameters.invocationPairing.includes('last non-dry STARTED')) {

        fail('generation-groq-comparison.json', 'driveParameters.invocationPairing does not state the kind-based rule, so a reader would assume nearest-preceding again');

    }

    for (const leg of ['gotavern', 'pinned']) {

        if (!Array.isArray(groqGeneration.generationUnmatchedAfterData?.[leg]) || groqGeneration.generationUnmatchedAfterData[leg].length !== 0) {

            fail('generation-groq-comparison.json', `generationUnmatchedAfterData.${leg} is not empty, so an assembly had no STARTED of its kind`);

        }

        if (groqGeneration.proxyPasswordPresent?.[leg] !== false) {

            fail('generation-groq-comparison.json', `proxyPasswordPresent.${leg} is ${JSON.stringify(groqGeneration.proxyPasswordPresent?.[leg])}, but groq is proxy:false and the drive must reach the peer by seam and redirect, never by a reverse-proxy credential`);

        }

        const requests = groqGeneration.providerRequests?.[leg] ?? [];

        // The model-list call lives in the leg captures; the streaming artifact proves the two-call sequence.

        const hasCompletion = requests.some(request => request.method === 'POST' && String(request.path ?? '').endsWith('/chat/completions'));

        if (!hasCompletion) {

            fail('generation-groq-comparison.json', `${leg} records ${JSON.stringify(requests.map(request => request.method + ' ' + request.path))}; groq's drive must show its status call (GET /models) and the completion (POST /chat/completions)`);

        }

    }

    const groqPost = (groqGeneration.providerRequests?.gotavern ?? []).find(entry => entry.method === 'POST');

    const groqDiffs = Array.isArray(groqGeneration.bodyDifferences) ? groqGeneration.bodyDifferences.length : 0;

    console.log(`  generation-groq-comparison.json providerRequestEqual true, ${groqDiffs} documented body difference(s), ${groqPost?.bodyLength ?? 'unknown'} B per leg, proxyPasswordPresent false on both legs (proxy:false source: seam + redirect only)`);

}
// ---- generation-nanogpt-comparison.json -------------------------------------------------------
//
// NANOGPT is the THIRD source in the same class as groq and siliconflow, and the class is what makes
// its row different from every reverse-proxy row: openai.js:6053 marks it `proxy: false` with selector
// '#api_key_nanogpt', so the frontend cannot be aimed at a recording peer through reverse_proxy AT ALL.
// The seam (GOTAVERN_NANOGPT_CHAT_URL) plus the pinned transport redirect are the ONLY way both legs
// reach one peer, which is why proxyPasswordPresent is recorded FALSE on both legs and ASSERTED here:
// the false is the evidence for the row's shape, not an absence of evidence.
//
// It also has to say WHICH seam aimed its GoTavern leg (seamEnvVar), because a nanogpt artifact that
// named the groq variable would describe a drive that did not happen.
const nanogptGeneration = read('generation-nanogpt-comparison.json');
if (nanogptGeneration) {
    const label = 'generation-nanogpt-comparison.json';
    if (nanogptGeneration.providerRequestEqual !== true) {
        fail(label, 'providerRequestEqual is not true, so the nanogpt provider-wire claim is unsupported');
    }
    if (nanogptGeneration.requestArrived?.gotavern !== true || nanogptGeneration.requestArrived?.pinned !== true) {
        fail(label, 'requestArrived is not true on both legs, so a leg was never driven');
    }
    if (nanogptGeneration.milestoneEqual !== true) {
        fail(label, 'milestoneEqual is not true; an interleaved counting invocation that changes a compared milestone is a divergence, not context');
    }
    for (const [name, value] of Object.entries(nanogptGeneration.guards ?? {})) {
        if (value !== true) fail(label, `guard ${name} is not true`);
    }
    if (typeof nanogptGeneration.driveParameters?.invocationPairing !== 'string' || !nanogptGeneration.driveParameters.invocationPairing.includes('last non-dry STARTED')) {
        fail(label, 'driveParameters.invocationPairing does not state the kind-based rule, so a reader would assume nearest-preceding again');
    }
    if (nanogptGeneration.driveParameters?.seamEnvVar !== 'GOTAVERN_NANOGPT_CHAT_URL') {
        fail(label, `driveParameters.seamEnvVar is ${JSON.stringify(nanogptGeneration.driveParameters?.seamEnvVar)}, but this artifact must say which seam aimed its GoTavern leg`);
    }
    for (const leg of ['gotavern', 'pinned']) {
        if (nanogptGeneration.proxyPasswordPresent?.[leg] !== false) {
            fail(label, `proxyPasswordPresent.${leg} is ${JSON.stringify(nanogptGeneration.proxyPasswordPresent?.[leg])}, but nanogpt is proxy:false and the drive must reach the peer by seam and redirect, never by a reverse-proxy credential`);
        }
        if (!Array.isArray(nanogptGeneration.generationUnmatchedAfterData?.[leg]) || nanogptGeneration.generationUnmatchedAfterData[leg].length !== 0) {
            fail(label, `generationUnmatchedAfterData.${leg} is not empty, so an assembly had no STARTED of its kind`);
        }
        const requests = nanogptGeneration.providerRequests?.[leg] ?? [];
        if (!requests.some(request => request.method === 'POST' && String(request.path ?? '').endsWith('/chat/completions'))) {
            fail(label, `${leg} records ${JSON.stringify(requests.map(request => request.method + ' ' + request.path))}; nanogpt's drive must show its status call (GET /models) and the completion (POST /chat/completions)`);
        }
    }
    const post = (nanogptGeneration.providerRequests?.gotavern ?? []).find(entry => entry.method === 'POST');
    console.log(`  generation-nanogpt-comparison.json providerRequestEqual true, ${post?.bodyLength ?? 'unknown'} B per leg, proxyPasswordPresent false on both legs, seam ${nanogptGeneration.driveParameters.seamEnvVar} (proxy:false source: seam + redirect only)`);
}

// ---- generation-deepseek-comparison.json ------------------------------------------------------
//
// DEEPSEEK is the first source whose provider path carries a SUFFIX the seam must preserve. Pinned's
// generate URL is `API_DEEPSEEK` = https://api.deepseek.com/beta (:86) plus /chat/completions, while its
// status call strips /beta (:1823) and asks the host root for /models. The Go seam REPLACES the whole
// base rather than its origin (deepseek_chat.go:58), so the first recording of this drive aimed it at the
// bare peer and produced `/chat/completions` on the Go leg against `/beta/chat/completions` on the pinned
// leg. That difference was the HARNESS, not the product, and the probe now aims
// GOTAVERN_DEEPSEEK_CHAT_URL at `<peer>/beta` so both legs record the production path.
//
// It also HONOURS reverse_proxy, unlike groq/siliconflow/nanogpt. This drive deliberately sets none, so
// proxyPasswordPresent false on both legs is a measured fact about the route taken rather than a
// tautology about a source that could not use a proxy at all.
const deepseekGeneration = read('generation-deepseek-comparison.json');
if (deepseekGeneration) {
    const label = 'generation-deepseek-comparison.json';
    if (deepseekGeneration.providerRequestEqual !== true) {
        fail(label, 'providerRequestEqual is not true, so the deepseek provider-wire claim is unsupported');
    }
    if (deepseekGeneration.requestArrived?.gotavern !== true || deepseekGeneration.requestArrived?.pinned !== true) {
        fail(label, 'requestArrived is not true on both legs, so a leg was never driven');
    }
    if (deepseekGeneration.milestoneEqual !== true) {
        fail(label, 'milestoneEqual is not true; an interleaved counting invocation that changes a compared milestone is a divergence, not context');
    }
    for (const [name, value] of Object.entries(deepseekGeneration.guards ?? {})) {
        if (value !== true) fail(label, `guard ${name} is not true`);
    }
    if (typeof deepseekGeneration.driveParameters?.invocationPairing !== 'string' || !deepseekGeneration.driveParameters.invocationPairing.includes('last non-dry STARTED')) {
        fail(label, 'driveParameters.invocationPairing does not state the kind-based rule, so a reader would assume nearest-preceding again');
    }
    if (deepseekGeneration.driveParameters?.seamEnvVar !== 'GOTAVERN_DEEPSEEK_CHAT_URL') {
        fail(label, `driveParameters.seamEnvVar is ${JSON.stringify(deepseekGeneration.driveParameters?.seamEnvVar)}, but this artifact must say which seam aimed its GoTavern leg`);
    }
    for (const leg of ['gotavern', 'pinned']) {
        if (deepseekGeneration.proxyPasswordPresent?.[leg] !== false) {
            fail(label, `proxyPasswordPresent.${leg} is ${JSON.stringify(deepseekGeneration.proxyPasswordPresent?.[leg])}, but this drive reaches the peer by seam and redirect and sets no reverse proxy; a true would mean the recorded route is not the route described`);
        }
        if (!Array.isArray(deepseekGeneration.generationUnmatchedAfterData?.[leg]) || deepseekGeneration.generationUnmatchedAfterData[leg].length !== 0) {
            fail(label, `generationUnmatchedAfterData.${leg} is not empty, so an assembly had no STARTED of its kind`);
        }
        const requests = deepseekGeneration.providerRequests?.[leg] ?? [];
        // THE /beta PREFIX IS ASSERTED, not merely recorded: it is the one path element that separates
        // this source from every other OpenAI-shaped row, and an aim that lost it would still produce a
        // 200 from a permissive peer.
        if (!requests.some(request => request.method === 'POST' && String(request.path ?? '').endsWith('/beta/chat/completions'))) {
            fail(label, `${leg} records ${JSON.stringify(requests.map(request => request.method + ' ' + request.path))}; deepseek's completion must be POST /beta/chat/completions`);
        }
    }
    const post = (deepseekGeneration.providerRequests?.gotavern ?? []).find(entry => entry.method === 'POST');
    console.log(`  generation-deepseek-comparison.json providerRequestEqual true, ${post?.bodyLength ?? 'unknown'} B per leg, POST /beta/chat/completions on both legs, proxyPasswordPresent false on both (reverse_proxy honoured by the source, unused by the drive), seam ${deepseekGeneration.driveParameters.seamEnvVar}`);
}

// ---- generation-siliconflow-comparison.json ------------------------------------------------
//
// The SILICONFLOW source measured end to end. Same checks as groq, because it is the same class of
// source (apiSourceConfig proxy:false, host a pinned literal, reachable only through the seam plus
// the pinned transport redirect, so proxyPasswordPresent must be FALSE on both legs). It adds the
// one thing siliconflow does differently: its HOST is chosen by a BODY field, so the artifact must
// say which endpoint the drive drove and the gate must see that, or a reader cannot tell which
// host the numbers belong to.
const siliconflowGeneration = read('generation-siliconflow-comparison.json');
if (siliconflowGeneration) {
    const label = 'generation-siliconflow-comparison.json';
    if (siliconflowGeneration.providerRequestEqual !== true) {
        fail(label, 'providerRequestEqual is not true, so the siliconflow provider-wire claim is unsupported');
    }
    if (siliconflowGeneration.requestArrived?.gotavern !== true || siliconflowGeneration.requestArrived?.pinned !== true) {
        fail(label, 'requestArrived is not true on both legs, so a leg was never driven');
    }
    if (siliconflowGeneration.milestoneEqual !== true) {
        fail(label, 'milestoneEqual is not true; an interleaved counting invocation that changes a compared milestone is a divergence, not context');
    }
    for (const [name, value] of Object.entries(siliconflowGeneration.guards ?? {})) {
        if (value !== true) fail(label, `guard ${name} is not true`);
    }
    // THE ONE THING THAT IS NOT A COPY OF GROQ: which endpoint was driven, and through what.
    if (typeof siliconflowGeneration.driveParameters?.endpointMode !== 'string' || siliconflowGeneration.driveParameters.endpointMode.length === 0) {
        fail(label, 'driveParameters.endpointMode is missing, so the artifact does not say which endpoint these numbers belong to');
    }
    if (siliconflowGeneration.driveParameters?.endpointControl !== '#siliconflow_endpoint') {
        fail(label, 'driveParameters.endpointControl does not name the frontend control the drive used');
    }
    if (typeof siliconflowGeneration.driveParameters?.endpointBreadth !== 'string' || !siliconflowGeneration.driveParameters.endpointBreadth.includes('CN')) {
        fail(label, 'driveParameters.endpointBreadth does not state that the CN endpoint is unmeasured');
    }
    for (const leg of ["gotavern", "pinned"]) {
        if (siliconflowGeneration.proxyPasswordPresent?.[leg] !== false) {
            fail(label, `proxyPasswordPresent.${leg} is ${JSON.stringify(siliconflowGeneration.proxyPasswordPresent?.[leg])}, but siliconflow is proxy:false and the drive must reach the peer by seam and redirect`);
        }
        const requests = siliconflowGeneration.providerRequests?.[leg] ?? [];
        if (!requests.some(request => request.method === 'POST' && String(request.path ?? '').endsWith('/chat/completions'))) {
            fail(label, `${leg} records ${JSON.stringify(requests.map(request => request.method + " " + request.path))}; the completion POST /chat/completions is missing`);
        }
    }
    const post = (siliconflowGeneration.providerRequests?.gotavern ?? []).find(entry => entry.method === "POST");
    console.log(`  generation-siliconflow-comparison.json providerRequestEqual true, ${post?.bodyLength ?? "unknown"} B per leg, proxyPasswordPresent false on both legs, endpoint ${JSON.stringify(siliconflowGeneration.driveParameters.endpointMode)} via ${siliconflowGeneration.driveParameters.endpointControl} (CN endpoint unmeasured)`);
}

// ---- generation-openai-comparison.json --------------------------------------------------------
//
// OPENAI, THE MOST IMPORTANT SOURCE, and the first one whose row had to state the OPPOSITE of the
// groq/siliconflow/nanogpt class: apiSourceConfig marks openai `proxy: true` with selector
// `#api_key_openai`, so the frontend DOES offer a reverse_proxy for it and this drive COULD have carried
// the peer in the request. It deliberately did not -- the peer is reached by GOTAVERN_OPENAI_CHAT_URL on
// the GoTavern leg and by PROBE_PINNED_REDIRECT_FILE on the pinned leg -- and `proxyPasswordPresent`
// FALSE on both legs is the MEASUREMENT that says so, not an absence of evidence. The artifact must
// therefore say `proxySettingDeliberatelyUnset`, because a reader who saw only the false would conclude
// that openai has no proxy control at all.
const openaiGeneration = read('generation-openai-comparison.json');
if (openaiGeneration) {
    const label = 'generation-openai-comparison.json';
    if (openaiGeneration.providerRequestEqual !== true) {
        fail(label, 'providerRequestEqual is not true, so the openai provider-wire claim is unsupported');
    }
    if (openaiGeneration.requestArrived?.gotavern !== true || openaiGeneration.requestArrived?.pinned !== true) {
        fail(label, 'requestArrived is not true on both legs, so a leg was never driven');
    }
    if (openaiGeneration.milestoneEqual !== true) {
        fail(label, 'milestoneEqual is not true; an interleaved counting invocation that changes a compared milestone is a divergence, not context');
    }
    for (const [name, value] of Object.entries(openaiGeneration.guards ?? {})) {
        if (value !== true) fail(label, `guard ${name} is not true`);
    }
    const guardMeaning = openaiGeneration.guardMeaning?.sendWindowHoldsExactlyOneRealSendAndNoDryAssembly;
    if (typeof guardMeaning !== 'string' || !guardMeaning.includes('non-dry invocation')) {
        fail(label, 'guardMeaning for the send-window guard is missing or does not state the invocation-level rule');
    }
    if (!Array.isArray(openaiGeneration.wholeDriveInvocations?.gotavern) || openaiGeneration.wholeDriveInvocations.gotavern.length === 0
        || !Array.isArray(openaiGeneration.wholeDriveInvocations?.pinned) || openaiGeneration.wholeDriveInvocations.pinned.length === 0) {
        fail(label, 'wholeDriveInvocations is missing a leg or is empty, so the send window was judged on a trail nobody recorded');
    }

    // ---- driveParameters: PRINTED for a reader and ENFORCED for the gate ----------------------
    // The requirement this lane was given is that both artifacts CARRY driveParameters and that the
    // gate both prints and enforces them. Each field below is a fact a reader cannot reconstruct from
    // the numbers, so a missing one makes the artifact unreadable rather than merely terse.
    const drive = openaiGeneration.driveParameters ?? {};
    if (typeof drive.mode !== 'string') {
        fail(label, 'driveParameters.mode is missing, so the artifact does not say which drive it describes');
    }
    if (typeof drive.invocationPairing !== 'string' || !drive.invocationPairing.includes('last non-dry STARTED')) {
        fail(label, 'driveParameters.invocationPairing does not state the kind-based rule, so a reader would assume nearest-preceding again');
    }
    if (drive.seamEnvVar !== 'GOTAVERN_OPENAI_CHAT_URL') {
        fail(label, `driveParameters.seamEnvVar is ${JSON.stringify(drive.seamEnvVar)}, but the seam that aimed this leg is GOTAVERN_OPENAI_CHAT_URL; an artifact naming another source\'s seam describes a drive that did not happen`);
    }
    if (typeof drive.proxySettingDeliberatelyUnset !== 'string' || !drive.proxySettingDeliberatelyUnset.includes('proxy:true')) {
        fail(label, 'driveParameters.proxySettingDeliberatelyUnset is missing or does not say that openai IS proxy:true, so a reader would read proxyPasswordPresent false as "openai has no proxy control"');
    }
    if (typeof drive.pinnedRedirectRequired !== 'string' || drive.pinnedRedirectRequired.trim() === '') {
        fail(label, 'driveParameters.pinnedRedirectRequired is missing, so the artifact does not say how the pinned leg reached the peer');
    }
    if (typeof drive.peerKeying !== 'string' || drive.peerKeying.trim() === '') {
        fail(label, 'driveParameters.peerKeying is missing, so the artifact does not say how the peer chose its answers');
    }

    for (const leg of ['gotavern', 'pinned']) {
        if (openaiGeneration.proxyPasswordPresent?.[leg] !== false) {
            fail(label, `proxyPasswordPresent.${leg} is ${JSON.stringify(openaiGeneration.proxyPasswordPresent?.[leg])}, but this drive reaches the peer by seam and redirect; a true means a reverse-proxy credential travelled, which is a different path than the one this row claims`);
        }
        if (!Array.isArray(openaiGeneration.generationUnmatchedAfterData?.[leg]) || openaiGeneration.generationUnmatchedAfterData[leg].length !== 0) {
            fail(label, `generationUnmatchedAfterData.${leg} is not empty, so an assembly had no STARTED of its kind`);
        }
        const requests = openaiGeneration.providerRequests?.[leg] ?? [];
        if (!requests.some(request => request.method === 'POST' && String(request.path ?? '').endsWith('/chat/completions'))) {
            fail(label, `${leg} records ${JSON.stringify(requests.map(request => request.method + ' ' + request.path))}; openai\'s drive must show its status call (GET /models) and the completion (POST /chat/completions)`);
        }
    }
    const openaiPost = (openaiGeneration.providerRequests?.gotavern ?? []).find(entry => entry.method === 'POST');
    const openaiDiffs = Array.isArray(openaiGeneration.bodyDifferences) ? openaiGeneration.bodyDifferences.length : 0;
    console.log(`  generation-openai-comparison.json providerRequestEqual true, ${openaiDiffs} documented body difference(s), ${openaiPost?.bodyLength ?? 'unknown'} B per leg, proxyPasswordPresent false on both legs, drive mode ${JSON.stringify(drive.mode)}, seam ${drive.seamEnvVar} (openai IS proxy:true; the proxy setting was deliberately left unset)`);
}

// ---- streaming-openai-comparison.json ---------------------------------------------------------
//
// The STREAMED drive for the same source, and the non-stream control that proves the stream is not the
// only path. `compatibleReady` is the artifact\'s own verdict; the drive parameters are enforced here
// for the same reason as in the generation artifact.
const openaiStreaming = read('streaming-openai-comparison.json');
if (openaiStreaming) {
    const label = 'streaming-openai-comparison.json';
    if (openaiStreaming.compatibleReady !== true) {
        fail(label, 'compatibleReady is not true, so the streaming/cancellation claim for openai is unsupported');
    }
    const drive = openaiStreaming.driveParameters ?? {};
    if (typeof drive.streamFrameCount !== 'string') {
        fail(label, 'driveParameters.streamFrameCount is missing, so the artifact does not say which drive it describes');
    }
    if (drive.seamEnvVar !== 'GOTAVERN_OPENAI_CHAT_URL') {
        fail(label, `driveParameters.seamEnvVar is ${JSON.stringify(drive.seamEnvVar)}, but the seam that aimed this leg is GOTAVERN_OPENAI_CHAT_URL`);
    }
    if (typeof drive.proxySettingDeliberatelyUnset !== 'string' || !drive.proxySettingDeliberatelyUnset.includes('proxy:true')) {
        fail(label, 'driveParameters.proxySettingDeliberatelyUnset is missing or does not say that openai IS proxy:true');
    }
    if (typeof drive.pinnedRedirectRequired !== 'string' || drive.pinnedRedirectRequired.trim() === '') {
        fail(label, 'driveParameters.pinnedRedirectRequired is missing');
    }
    for (const leg of ['gotavern', 'pinned']) {
        if (openaiStreaming.proxyPasswordPresent?.[leg] !== false) {
            fail(label, `proxyPasswordPresent.${leg} is ${JSON.stringify(openaiStreaming.proxyPasswordPresent?.[leg])}, but this drive reaches the peer by seam and redirect`);
        }
    }
    console.log(`  streaming-openai-comparison.json compatibleReady true, frames ${JSON.stringify(drive.streamFrameCount)}, seam ${drive.seamEnvVar}, proxyPasswordPresent false on both legs`);
}

// ---- generation-chutes-comparison.json ----------------------------
//
// CHUTES measured end to end. Both legs reach one peer through the seam plus the pinned
// transport redirect (proxy:false), so proxyPasswordPresent must be FALSE on both legs.
const chutesGeneration = read('generation-chutes-comparison.json');
if (chutesGeneration) {
    const label = 'generation-chutes-comparison.json';
    if (chutesGeneration.providerRequestEqual !== true) fail(label, 'providerRequestEqual is not true');
    if (chutesGeneration.requestArrived?.gotavern !== true || chutesGeneration.requestArrived?.pinned !== true) fail(label, 'requestArrived is not true on both legs');
    if (chutesGeneration.milestoneEqual !== true) fail(label, 'milestoneEqual is not true');
    for (const [guard, value] of Object.entries(chutesGeneration.guards ?? {})) {
        if (value !== true) fail(label, `guard ${guard} is not true`);
    }
    if (typeof chutesGeneration.driveParameters?.sourceShape !== 'string' || chutesGeneration.driveParameters.sourceShape.length === 0) {
        fail(label, 'driveParameters.sourceShape is missing, so the artifact does not state what this source is recorded for');
    }
    for (const leg of ["gotavern", "pinned"]) {
        if (chutesGeneration.proxyPasswordPresent?.[leg] !== false) {
            fail(label, `proxyPasswordPresent.${leg} is ${JSON.stringify(chutesGeneration.proxyPasswordPresent?.[leg])}, but this source is proxy:false and the peer is reachable only by seam and redirect`);
        }
    }
    console.log(`  generation-chutes-comparison.json providerRequestEqual true, ${(chutesGeneration.providerRequests?.gotavern ?? []).find(entry => entry.method === 'POST')?.bodyLength ?? 'unknown'} B per leg, proxyPasswordPresent false on both legs`);
}

// ---- generation-electronhub-comparison.json -----------------------
//
// ELECTRONHUB measured end to end. Both legs reach one peer through the seam plus the pinned
// transport redirect (proxy:false), so proxyPasswordPresent must be FALSE on both legs.
const electronhubGeneration = read('generation-electronhub-comparison.json');
if (electronhubGeneration) {
    const label = 'generation-electronhub-comparison.json';
    if (electronhubGeneration.providerRequestEqual !== true) fail(label, 'providerRequestEqual is not true');
    if (electronhubGeneration.requestArrived?.gotavern !== true || electronhubGeneration.requestArrived?.pinned !== true) fail(label, 'requestArrived is not true on both legs');
    if (electronhubGeneration.milestoneEqual !== true) fail(label, 'milestoneEqual is not true');
    for (const [guard, value] of Object.entries(electronhubGeneration.guards ?? {})) {
        if (value !== true) fail(label, `guard ${guard} is not true`);
    }
    if (typeof electronhubGeneration.driveParameters?.sourceShape !== 'string' || electronhubGeneration.driveParameters.sourceShape.length === 0) {
        fail(label, 'driveParameters.sourceShape is missing, so the artifact does not state what this source is recorded for');
    }
    for (const leg of ["gotavern", "pinned"]) {
        if (electronhubGeneration.proxyPasswordPresent?.[leg] !== false) {
            fail(label, `proxyPasswordPresent.${leg} is ${JSON.stringify(electronhubGeneration.proxyPasswordPresent?.[leg])}, but this source is proxy:false and the peer is reachable only by seam and redirect`);
        }
    }
    console.log(`  generation-electronhub-comparison.json providerRequestEqual true, ${(electronhubGeneration.providerRequests?.gotavern ?? []).find(entry => entry.method === 'POST')?.bodyLength ?? 'unknown'} B per leg, proxyPasswordPresent false on both legs`);
}

// ---- generation-aimlapi-comparison.json -------------------------------------------------------
//
// AIMLAPI, and the fact that makes its row different from the proxy:true rows: apiSourceConfig marks it
// `proxy: false` (SECRET_KEYS.AIMLAPI, #api_key_aimlapi) AND its key guard is `!apiKey` with NO
// reverse_proxy escape -- the route never reads that member at all (aimlapi_chat.go:24,152). So the peer
// is UNREACHABLE through a reverse proxy for this source: the seam and the pinned redirect are the only
// route, and `proxyPasswordPresent` false on both legs is a statement about the SOURCE, not a choice this
// drive made. The artifact must say `proxyMemberSupport` for that reason: a reader who saw only the false
// could not tell "unsupported" from "unused here".
const aimlapiGeneration = read('generation-aimlapi-comparison.json');
if (aimlapiGeneration) {
    const label = 'generation-aimlapi-comparison.json';
    if (aimlapiGeneration.providerRequestEqual !== true) {
        fail(label, 'providerRequestEqual is not true, so the aimlapi provider-wire claim is unsupported');
    }
    if (aimlapiGeneration.requestArrived?.gotavern !== true || aimlapiGeneration.requestArrived?.pinned !== true) {
        fail(label, 'requestArrived is not true on both legs, so a leg was never driven');
    }
    if (aimlapiGeneration.milestoneEqual !== true) {
        fail(label, 'milestoneEqual is not true; an interleaved counting invocation that changes a compared milestone is a divergence, not context');
    }
    for (const [name, value] of Object.entries(aimlapiGeneration.guards ?? {})) {
        if (value !== true) fail(label, `guard ${name} is not true`);
    }
    const guardMeaning = aimlapiGeneration.guardMeaning?.sendWindowHoldsExactlyOneRealSendAndNoDryAssembly;
    if (typeof guardMeaning !== 'string' || !guardMeaning.includes('non-dry invocation')) {
        fail(label, 'guardMeaning for the send-window guard is missing or does not state the invocation-level rule');
    }
    const drive = aimlapiGeneration.driveParameters ?? {};
    if (typeof drive.mode !== 'string') {
        fail(label, 'driveParameters.mode is missing, so the artifact does not say which drive it describes');
    }
    if (typeof drive.invocationPairing !== 'string' || !drive.invocationPairing.includes('last non-dry STARTED')) {
        fail(label, 'driveParameters.invocationPairing does not state the kind-based rule');
    }
    if (drive.seamEnvVar !== 'GOTAVERN_AIMLAPI_CHAT_URL') {
        fail(label, `driveParameters.seamEnvVar is ${JSON.stringify(drive.seamEnvVar)}, but the seam that aimed this leg is GOTAVERN_AIMLAPI_CHAT_URL`);
    }
    if (typeof drive.proxyMemberSupport !== 'string' || !drive.proxyMemberSupport.includes('UNSUPPORTED') || !drive.proxyMemberSupport.includes('reverse_proxy')) {
        fail(label, 'driveParameters.proxyMemberSupport is missing or does not state that the route NEVER READS reverse_proxy, so proxyPasswordPresent false cannot be read as "unused here"');
    }
    for (const leg of ['gotavern', 'pinned']) {
        if (aimlapiGeneration.proxyPasswordPresent?.[leg] !== false) {
            fail(label, `proxyPasswordPresent.${leg} is ${JSON.stringify(aimlapiGeneration.proxyPasswordPresent?.[leg])}, but aimlapi has no reverse_proxy escape and the drive must reach the peer by seam and redirect`);
        }
        if (!Array.isArray(aimlapiGeneration.generationUnmatchedAfterData?.[leg]) || aimlapiGeneration.generationUnmatchedAfterData[leg].length !== 0) {
            fail(label, `generationUnmatchedAfterData.${leg} is not empty, so an assembly had no STARTED of its kind`);
        }
        const requests = aimlapiGeneration.providerRequests?.[leg] ?? [];
        if (!requests.some(request => request.method === 'POST' && String(request.path ?? '').endsWith('/chat/completions'))) {
            fail(label, `${leg} records ${JSON.stringify(requests.map(request => request.method + ' ' + request.path))}; aimlapi's drive must show its status call and the completion (POST /chat/completions)`);
        }
    }
    const post = (aimlapiGeneration.providerRequests?.gotavern ?? []).find(entry => entry.method === 'POST');
    console.log(`  generation-aimlapi-comparison.json providerRequestEqual true, ${(aimlapiGeneration.bodyDifferences ?? []).length} documented body difference(s), ${post?.bodyLength ?? 'unknown'} B per leg, proxyPasswordPresent false on both legs (proxy:false source with NO reverse_proxy escape: seam + redirect only), seam ${drive.seamEnvVar}`);
}

// ---- streaming-aimlapi-comparison.json --------------------------------------------------------
const aimlapiStreaming = read('streaming-aimlapi-comparison.json');
if (aimlapiStreaming) {
    const label = 'streaming-aimlapi-comparison.json';
    if (aimlapiStreaming.compatibleReady !== true) {
        fail(label, 'compatibleReady is not true, so the streaming/cancellation claim for aimlapi is unsupported');
    }
    const drive = aimlapiStreaming.driveParameters ?? {};
    if (typeof drive.streamFrameCount !== 'string') {
        fail(label, 'driveParameters.streamFrameCount is missing, so the artifact does not say which drive it describes');
    }
    if (drive.seamEnvVar !== 'GOTAVERN_AIMLAPI_CHAT_URL') {
        fail(label, `driveParameters.seamEnvVar is ${JSON.stringify(drive.seamEnvVar)}, but the seam that aimed this leg is GOTAVERN_AIMLAPI_CHAT_URL`);
    }
    if (typeof drive.proxyMemberSupport !== 'string' || !drive.proxyMemberSupport.includes('UNSUPPORTED')) {
        fail(label, 'driveParameters.proxyMemberSupport is missing from the streaming artifact');
    }
    for (const leg of ['gotavern', 'pinned']) {
        if (aimlapiStreaming.proxyPasswordPresent?.[leg] !== false) {
            fail(label, `proxyPasswordPresent.${leg} is ${JSON.stringify(aimlapiStreaming.proxyPasswordPresent?.[leg])}, but aimlapi has no reverse_proxy escape`);
        }
    }
    console.log(`  streaming-aimlapi-comparison.json compatibleReady true, frames ${JSON.stringify(drive.streamFrameCount)}, seam ${drive.seamEnvVar}, proxyPasswordPresent false on both legs`);
}

// ---- generation-ai21-comparison.json ----------------------------------------------------------
//
// AI21, and the fact the ai21 lane paid for: ITS HEADER SET IS NOT THE THREE HEADERS ITS OWN CODE NAMES.
// The pinned request carries accept, content-type and authorization -- PLUS the accept-encoding and
// user-agent node-fetch adds itself, PLUS a COMPUTED content-length, PLUS Host and Connection from the Go
// client (ai21_chat.go:281-304). A comparison that diffed BODIES ONLY was green while the framed request
// still differed, so this artifact records the FRAMING and this block ENFORCES it: the header NAME set of
// each leg, the content-length each received, and whether it matches the body -- and never a header VALUE,
// because `authorization` carries the key. `authorizationPresent` is a boolean for that reason.
const ai21Generation = read('generation-ai21-comparison.json');
if (ai21Generation) {
    const label = 'generation-ai21-comparison.json';
    if (ai21Generation.providerRequestEqual !== true) {
        fail(label, 'providerRequestEqual is not true, so the ai21 provider-wire claim is unsupported');
    }
    if (ai21Generation.requestArrived?.gotavern !== true || ai21Generation.requestArrived?.pinned !== true) {
        fail(label, 'requestArrived is not true on both legs, so a leg was never driven');
    }
    if (ai21Generation.milestoneEqual !== true) {
        fail(label, 'milestoneEqual is not true; an interleaved counting invocation that changes a compared milestone is a divergence, not context');
    }
    for (const [name, value] of Object.entries(ai21Generation.guards ?? {})) {
        if (value !== true) fail(label, `guard ${name} is not true`);
    }
    const guardMeaning = ai21Generation.guardMeaning?.sendWindowHoldsExactlyOneRealSendAndNoDryAssembly;
    if (typeof guardMeaning !== 'string' || !guardMeaning.includes('non-dry invocation')) {
        fail(label, 'guardMeaning for the send-window guard is missing or does not state the invocation-level rule');
    }
    const drive = ai21Generation.driveParameters ?? {};
    if (typeof drive.mode !== 'string') fail(label, 'driveParameters.mode is missing');
    if (typeof drive.invocationPairing !== 'string' || !drive.invocationPairing.includes('last non-dry STARTED')) {
        fail(label, 'driveParameters.invocationPairing does not state the kind-based rule');
    }
    if (drive.seamEnvVar !== 'GOTAVERN_AI21_CHAT_URL') {
        fail(label, `driveParameters.seamEnvVar is ${JSON.stringify(drive.seamEnvVar)}, but the seam that aimed this leg is GOTAVERN_AI21_CHAT_URL`);
    }

    // ---- THE FRAMING, RECOMPUTED RATHER THAN TRUSTED -------------------------------------------
    // requestFramingEqual is a RECORDED flag; a stale true next to a changed header list is exactly the
    // failure this block exists to catch, so the two legs are compared here and the recorded flag must
    // agree with the recomputation.
    const framing = ai21Generation.requestFraming ?? {};
    for (const leg of ['gotavern', 'pinned']) {
        const entry = framing[leg];
        if (!entry || !Array.isArray(entry.headerNames) || entry.headerNames.length === 0) {
            fail(label, `requestFraming.${leg} is missing or names no header, so the request FRAMING was not recorded`);
            continue;
        }
        if (entry.authorizationPresent !== true) {
            fail(label, `requestFraming.${leg} does not record that authorization reached the peer, but ai21 sends its key as a bearer header`);
        }
        if (entry.contentLengthMatchesBody !== true) {
            fail(label, `requestFraming.${leg} records content-length ${JSON.stringify(entry.receivedContentLength)} for a ${JSON.stringify(entry.bodyLength)}-byte body, so node-fetch\'s computed framing is not what arrived`);
        }
        // node-fetch adds these; a leg missing one is a framing difference the old body-only diff could not see.
        for (const expected of ['accept', 'content-type', 'authorization', 'accept-encoding', 'user-agent', 'content-length']) {
            if (!entry.headerNames.includes(expected)) {
                fail(label, `requestFraming.${leg} does not carry ${JSON.stringify(expected)}; the pinned framing is the three headers ai21 names plus node-fetch\'s defaults plus a computed content-length`);
            }
        }
    }
    const left = framing.gotavern;
    const right = framing.pinned;
    if (left && right) {
        const recomputed = JSON.stringify(left.headerNames) === JSON.stringify(right.headerNames)
            && String(left.receivedContentLength) === String(right.receivedContentLength);
        if (ai21Generation.requestFramingEqual !== recomputed) {
            fail(label, `requestFramingEqual is ${JSON.stringify(ai21Generation.requestFramingEqual)} but the two legs recompute to ${JSON.stringify(recomputed)} -- the recorded flag disagrees with the recorded framing`);
        }
        if (!recomputed) {
            fail(label, `the two legs were framed differently: ${JSON.stringify(left.headerNames)} / cl ${JSON.stringify(left.receivedContentLength)} against ${JSON.stringify(right.headerNames)} / cl ${JSON.stringify(right.receivedContentLength)}`);
        }
    }
    if (typeof ai21Generation.framingNote !== 'string' || !ai21Generation.framingNote.includes('content-length')) {
        fail(label, 'framingNote is missing or does not name the computed content-length, so a reader cannot tell what the framing comparison covered');
    }
    // THE CREDENTIAL MUST NOT BE IN THE ARTIFACT. A recorded Authorization value would be a leaked key in a
    // committed file, so the block refuses one rather than trusting the recorder not to do it.
    const serialized = JSON.stringify(ai21Generation);
    if (/Bearer\s/i.test(serialized)) {
        fail(label, 'records an Authorization VALUE (Bearer ...); the framing records header NAMES and a boolean, never a credential');
    }
    for (const leg of ['gotavern', 'pinned']) {
        if (ai21Generation.generationUnmatchedAfterData?.[leg]?.length !== 0) {
            fail(label, `generationUnmatchedAfterData.${leg} is not empty, so an assembly had no STARTED of its kind`);
        }
    }
    const post = (ai21Generation.providerRequests?.gotavern ?? []).find(entry => entry.method === 'POST');
    console.log(`  generation-ai21-comparison.json providerRequestEqual true, ${(ai21Generation.bodyDifferences ?? []).length} documented body difference(s), ${post?.bodyLength ?? 'unknown'} B per leg, requestFramingEqual ${ai21Generation.requestFramingEqual} over ${(left?.headerNames ?? []).length} header names with content-length ${left?.receivedContentLength ?? 'unknown'} matching the body on both legs (authorization present on both, its value never recorded)`);
}

// ---- streaming-ai21-comparison.json -----------------------------------------------------------
const ai21Streaming = read('streaming-ai21-comparison.json');
if (ai21Streaming) {
    const label = 'streaming-ai21-comparison.json';
    if (ai21Streaming.compatibleReady !== true) {
        fail(label, 'compatibleReady is not true, so the streaming/cancellation claim for ai21 is unsupported');
    }
    const drive = ai21Streaming.driveParameters ?? {};
    if (typeof drive.streamFrameCount !== 'string') fail(label, 'driveParameters.streamFrameCount is missing');
    if (drive.seamEnvVar !== 'GOTAVERN_AI21_CHAT_URL') {
        fail(label, `driveParameters.seamEnvVar is ${JSON.stringify(drive.seamEnvVar)}, but the seam that aimed this leg is GOTAVERN_AI21_CHAT_URL`);
    }
    for (const leg of ['gotavern', 'pinned']) {
        if (ai21Streaming.proxyPasswordPresent?.[leg] !== false) {
            fail(label, `proxyPasswordPresent.${leg} is ${JSON.stringify(ai21Streaming.proxyPasswordPresent?.[leg])}, but ai21 is proxy:false and reaches the peer by seam and redirect`);
        }
    }
    console.log(`  streaming-ai21-comparison.json compatibleReady true, frames ${JSON.stringify(drive.streamFrameCount)}, seam ${drive.seamEnvVar}, proxyPasswordPresent false on both legs`);
}

// ---- streaming-{mistral,claude}-comparison.json ------------------------------------------------
//
// The two C-surface artifacts this lane recorded, enforced the way the OpenRouter block enforces its
// own: a missing surface, a surface that is not proven, a leg that never reached the provider, or a
// cancellation that did not reach the provider is a FAILURE, never a vacuous pass. Beyond that, each
// artifact's own recorded provider paths are ASSERTED against the protocol its source uses, so the
// prose printed below is a statement about measured data rather than a caption:
//   - mistralai is OpenAI-shaped: a status call (GET /models) then POST /chat/completions, `data:`
//     chunks and a `[DONE]` sentinel. It needed NO new machinery -- the same peer that drove the
//     custom and openrouter sources drove it, and every leg wrote the same 15 paced frames.
//   - claude is the only source whose framing required NEW code: Anthropic events (message_start,
//     content_block_delta, message_delta, message_stop), reached by POST /messages with NO status
//     call at all (it is a no-validate source: openai.js never asks for /models).
for (const artifactName of ['streaming-mistral-comparison.json', 'streaming-claude-comparison.json', 'streaming-groq-comparison.json', 'streaming-siliconflow-comparison.json', 'streaming-nanogpt-comparison.json', 'streaming-deepseek-comparison.json', 'streaming-chutes-comparison.json', 'streaming-electronhub-comparison.json']) {
    const streamingArtifact = read(artifactName);
    if (!streamingArtifact) continue;
    const isMistral = artifactName.includes('mistral');
    const isGroq = artifactName.includes('groq');
    const isChutes = artifactName.includes('chutes');
    const isElectronhub = artifactName.includes('electronhub');
    const isSiliconflow = artifactName.includes('siliconflow');
    // nanogpt is OpenAI-shaped like mistralai/groq/siliconflow: a model-list status call and a
    // POST /chat/completions completion, served by the same request-keyed peer.
    const isNanogpt = artifactName.includes('nanogpt');
    // deepseek is OpenAI-shaped like the rest, with /beta kept on the completion path.
    const isDeepseek = artifactName.includes('deepseek');
    // groq and mistralai are both OpenAI-shaped (completion POST plus a model-list status call); claude
    // is the Anthropic one and must never ask for a model list.
    const isOpenAI = isMistral || isGroq || isSiliconflow || isNanogpt || isDeepseek || isChutes || isElectronhub;
    if (isNanogpt) {
        // NANOGPT'S proxy:false CLAIM IS CHECKED AGAINST A MEASURED BOOLEAN, not against this file's own
        // prose: false on both legs is the evidence that neither leg reached the peer through a
        // reverse-proxy credential.
        for (const leg of ['gotavern', 'pinned']) {
            if (streamingArtifact.proxyPasswordPresent?.[leg] !== false) {
                fail(artifactName, `proxyPasswordPresent.${leg} is ${JSON.stringify(streamingArtifact.proxyPasswordPresent?.[leg])}, but nanogpt is proxy:false and both legs must reach the peer by seam and redirect`);
            }
        }
    }
    const completionSuffix = isOpenAI ? '/chat/completions' : '/messages';
    for (const surface of ['streaming', 'cancellation', 'nonstream']) {
        const block = streamingArtifact[surface];
        if (!block || typeof block !== 'object') {
            fail(artifactName, `the ${surface} block is missing, so that surface was never compared`);
            continue;
        }
        if (block.proven !== true) {
            const falseChecks = Object.entries(block.checks ?? {}).filter(([, value]) => value !== true).map(([name]) => name);
            fail(artifactName, `${surface}.proven is not true; failing checks: ${falseChecks.join(', ') || '(none isolated)'}`);
        }
        for (const leg of ['gotavern', 'pinned']) {
            const requests = block[leg]?.providerRequests;
            if (!Array.isArray(requests) || requests.length === 0) {
                fail(artifactName, `${surface}.${leg} records no provider request, so that leg was never driven`);
                continue;
            }
            // THE SOURCE'S OWN WIRE SHAPE, read back from the recording.
            for (const request of requests) {
                const requestPath = String(request.path ?? '');
                // mistralai is OpenAI-shaped, so its NON-STREAM control legitimately asks for the model
                // list first (GET /models) and then posts the completion; claude never asks at all.
                const isStatusCall = isOpenAI && request.method === 'GET' && requestPath.endsWith('/models');
                if (!isStatusCall && !requestPath.endsWith(completionSuffix)) {
                    fail(artifactName, `${surface}.${leg} records ${request.method} ${request.path}, which is neither this source's completion route (${completionSuffix}) nor, for mistralai, its model-list call`);
                }
            }
            const statusCalls = requests.filter(request => String(request.path ?? '').includes('/models'));
            if (isOpenAI) {
                // OpenAI-shaped: the non-stream control asks for the model list first; the streamed and
                // cancelled drives go straight to the completion route after the frontend's own status
                // call. Either way the completion route is reached.
                if (!requests.some(request => request.method === 'POST')) {
                    fail(artifactName, `${surface}.${leg} never issued the completion POST`);
                }
            } else if (statusCalls.length !== 0) {
                fail(artifactName, `${surface}.${leg} issued ${statusCalls.length} /models request(s); claude is a no-validate source and must reach the provider with POST /messages only`);
            }
        }
    }
    if (streamingArtifact.compatibleReady !== true) {
        fail(artifactName, 'compatibleReady is not true, so no `compatible` claim may rest on it');
    }
    // CANCELLATION MUST HAVE REACHED THE PROVIDER ON BOTH LEGS: that is the surface's whole point.
    for (const leg of ['gotavern', 'pinned']) {
        const requests = streamingArtifact.cancellation?.[leg]?.providerRequests ?? [];
        if (!requests.length || requests.some(request => request.clientDisconnected !== true)) {
            fail(artifactName, `cancellation.${leg} does not record clientDisconnected true, so the teardown never reached the provider on that leg`);
        }
    }
    // THE PACED FRAME COUNT IS DETERMINISTIC FOR A COMPLETED STREAM (the peer writes every frame and
    // then closes), so it is asserted; the CANCELLED count is timing and stays recorded only.
    for (const leg of ['gotavern', 'pinned']) {
        const frames = (streamingArtifact.streaming?.[leg]?.providerRequests ?? []).map(request => request.framesWritten);
        if (JSON.stringify(frames) !== '[15]') {
            fail(artifactName, `streaming.${leg} wrote ${JSON.stringify(frames)} frames, not the 15 the peer paced`);
        }
    }
    const abortState = streamingArtifact.cancellation?.abortRenderState;
    if (!abortState || abortState.gotavern?.framesWritten === undefined || abortState.pinned?.framesWritten === undefined || typeof abortState.note !== 'string') {
        fail(artifactName, 'cancellation.abortRenderState does not record both legs and its reason');
    }
    const siliconflowLine = 'siliconflow (OpenAI-shaped like groq, proxy:false, endpoint chosen by a body field): both legs GET /models then POST /chat/completions, 15 paced frames; DEFAULT (global) endpoint only, CN unmeasured';
    // NANOGPT IS OPENAI-SHAPED AND proxy:false, and its caption says so rather than falling through to
    // the claude line, which would claim no /models call for a source that makes one.
    const nanogptLine = 'nanogpt (OpenAI-shaped like groq and siliconflow, proxy:false, credential typed into #api_key_nanogpt): both legs GET /models?detailed=true then POST /chat/completions, 15 paced frames, abort recorded at ' + JSON.stringify(abortState?.gotavern?.framesWritten) + '/' + JSON.stringify(abortState?.pinned?.framesWritten) + ' frames; proxyPasswordPresent false on both legs, because the seam and the redirect are the ONLY route to a peer';
    const deepseekLine = 'deepseek (OpenAI-shaped, /beta kept on the completion path, credential typed into #api_key_deepseek): both legs GET /models then POST /beta/chat/completions, 15 paced frames, abort recorded at ' + JSON.stringify(abortState?.gotavern?.framesWritten) + '/' + JSON.stringify(abortState?.pinned?.framesWritten) + ' frames; proxyPasswordPresent false on both legs even though the source HONOURS reverse_proxy, because this drive sets none';
    const chutesLine = 'chutes (OpenAI-shaped, proxy:false, messages forwarded verbatim with top_k/logit_bias): both legs GET /models then POST /chat/completions, 15 paced frames, cancellation reached the provider';
    const electronhubLine = 'electronhub (OpenAI-shaped, NO reverse_proxy support at all): both legs GET /models then POST /chat/completions, 15 paced frames; proxyPasswordPresent false because the route never consults the setting';
    const groqLine = 'groq (OpenAI-shaped like mistralai, but proxy:false): both legs GET /models then POST /chat/completions, 15 paced frames, abort recorded at ' + JSON.stringify(abortState?.gotavern?.framesWritten) + '/' + JSON.stringify(abortState?.pinned?.framesWritten) + ' frames; proxyPasswordPresent false on both legs, because the seam and the redirect are the ONLY route to a peer';
    console.log('  ' + artifactName + ' ' + (isChutes ? chutesLine : isElectronhub ? electronhubLine : isDeepseek ? deepseekLine : isNanogpt ? nanogptLine : isGroq ? groqLine : isSiliconflow ? siliconflowLine : isMistral
        ? 'mistralai (OpenAI-shaped, no new machinery): both legs POST ' + completionSuffix + ', 15 paced frames, abort recorded at ' + JSON.stringify(abortState?.gotavern?.framesWritten) + '/' + JSON.stringify(abortState?.pinned?.framesWritten) + ' frames'
        : 'claude (Anthropic framing, the only source that required new code): both legs POST ' + completionSuffix + ' with NO /models call, 15 paced frames, abort recorded at ' + JSON.stringify(abortState?.gotavern?.framesWritten) + '/' + JSON.stringify(abortState?.pinned?.framesWritten) + ' frames'));
}
// EVERY COMMITTED ARTIFACT IS SWEPT FOR HOST-DERIVED VALUES, not only the fields this file knows about.
// A loopback port was found in five artifacts while only the comparison fields were being checked, and two
// more carried it INSIDE a recorded popup HTML -- a field nobody compares, which is exactly where a
// host-derived value survives review. Only `*-comparison.json` is swept: the per-run leg captures beside them
// are gitignored by design and legitimately carry the ports of their own run.
// A LOOPBACK ADDRESS IS NOT THE ONLY HOST-DERIVED VALUE A RECORDING CAN CARRY. The first nanogpt
// streaming artifact recorded its six INPUT paths, which on the machine that produced it read
// `C:\Users\<user>\AppData\Local\Temp\...` -- a value that differs on every host and that no
// loopback pattern sees. The sweep therefore covers the path classes AGENTS.md rule 18 names for
// exactly this reason, and the artifacts are recorded with BARE input names so the paths never
// appear in the first place.
const hostDerivedPatterns = [/127\.0\.0\.1/, /localhost:\d+/, /\[::1\]/, /[A-Za-z]:\\\\/, /AppData/i, /\/home\//, /\/tmp\//, /\/Users\//, /\/root\//];
for (const artifactFile of readdirSync(browserDir).filter((name) => name.endsWith("-comparison.json"))) {
    const artifactText = readFileSync(path.join(browserDir, artifactFile), "utf8");
    for (const hostDerivedPattern of hostDerivedPatterns) {
        if (hostDerivedPattern.test(artifactText)) {
            fail(artifactFile, `records a host-derived address matching ${hostDerivedPattern}; a committed artifact must normalise it to a marker such as <peer-origin> or loopback, because the port belongs to the run that produced it and not to the product`);
        }
    }
}

if (findings.length > 0) {
    console.error('browser comparison artifacts do not support their claims:');
    for (const finding of findings) {
        console.error('  - ' + finding);
    }
    console.error(`\n${findings.length} finding(s).`);
    process.exit(1);
}

console.log('browser comparison artifacts are coherent with their claims');
console.log(`  startup-comparison.json    ${startup.rows.length} rows, unexpectedCount 0, guards faithful`);
console.log(`  generation-comparison.json providerRequestEqual true, ${generation.bodyDifferences?.length ?? 0} documented body difference(s)`);
console.log('  streaming-comparison.json  compatibleReady true, three surface blocks present');
console.log(`  data-domain-comparison.json ${dataDomain.rows.length} rows, ${Array.isArray(dataDomain.promotable) ? dataDomain.promotable.length : 0} promoted domain(s), ${dataDomain.unexpectedCount} unexpected`);
