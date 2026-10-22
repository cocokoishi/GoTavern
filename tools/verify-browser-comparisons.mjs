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
for (const artifactName of ['streaming-mistral-comparison.json', 'streaming-claude-comparison.json', 'streaming-groq-comparison.json']) {
    const streamingArtifact = read(artifactName);
    if (!streamingArtifact) continue;
    const isMistral = artifactName.includes('mistral');
    const isGroq = artifactName.includes('groq');
    // groq and mistralai are both OpenAI-shaped (completion POST plus a model-list status call); claude
    // is the Anthropic one and must never ask for a model list.
    const isOpenAI = isMistral || isGroq;
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
    const groqLine = 'groq (OpenAI-shaped like mistralai, but proxy:false): both legs GET /models then POST /chat/completions, 15 paced frames, abort recorded at ' + JSON.stringify(abortState?.gotavern?.framesWritten) + '/' + JSON.stringify(abortState?.pinned?.framesWritten) + ' frames; proxyPasswordPresent false on both legs, because the seam and the redirect are the ONLY route to a peer';
    console.log('  ' + artifactName + ' ' + (isGroq ? groqLine : isMistral
        ? 'mistralai (OpenAI-shaped, no new machinery): both legs POST ' + completionSuffix + ', 15 paced frames, abort recorded at ' + JSON.stringify(abortState?.gotavern?.framesWritten) + '/' + JSON.stringify(abortState?.pinned?.framesWritten) + ' frames'
        : 'claude (Anthropic framing, the only source that required new code): both legs POST ' + completionSuffix + ' with NO /models call, 15 paced frames, abort recorded at ' + JSON.stringify(abortState?.gotavern?.framesWritten) + '/' + JSON.stringify(abortState?.pinned?.framesWritten) + ' frames'));
}
// EVERY COMMITTED ARTIFACT IS SWEPT FOR HOST-DERIVED VALUES, not only the fields this file knows about.
// A loopback port was found in five artifacts while only the comparison fields were being checked, and two
// more carried it INSIDE a recorded popup HTML -- a field nobody compares, which is exactly where a
// host-derived value survives review. Only `*-comparison.json` is swept: the per-run leg captures beside them
// are gitignored by design and legitimately carry the ports of their own run.
const hostDerivedPatterns = [/127\.0\.0\.1/, /localhost:\d+/, /\[::1\]/];
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
