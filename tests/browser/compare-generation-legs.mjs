#!/usr/bin/env node
// Compare two generation-probe legs (GoTavern vs pinned) captured with the SAME drive.
//
// Usage: node compare-generation-legs.mjs <gotavern-report.json> <pinned-report.json>
//
// The probe already answers the harder question ("does a send produce a provider request?").
// This compares the two records the same drive produced:
//   * the provider requests (method, target, body length, body SHA-256),
//   * the chat-completions body when both legs captured it (message-by-message),
//   * the generation event sequence, normalised so prompt-manager DRY RUNS (which the frontend
//     starts on its own and which never issue a provider request) do not masquerade as a missing
//     real event,
//   * the post-send DOM state.
//
// A difference is a FINDING, not a failure of this script: it exits 0 after printing a structured
// comparison so the difference can be reported instead of being hidden behind a non-zero exit.
//
// The exception is a guard that says the differential was UNFAITHFUL -- a window that began in the
// middle of a generation, or a leg that never reached a sendable state. Such a record cannot support
// a claim about either server, so `guards` is checked and a false guard exits 1 after the comparison
// is printed (the caller redirects stdout to the artifact; the exit status is what fails the run).

import fs from 'node:fs/promises';
import process from 'node:process';

const [gotavernPath, pinnedPath] = process.argv.slice(2);
if (!gotavernPath || !pinnedPath) {
    console.error('usage: node compare-generation-legs.mjs <gotavern-report.json> <pinned-report.json>');
    process.exit(2);
}

// The probe records generation events with a JSON summary of their arguments. Only some events
// carry dryRun, and the frontend also runs a prompt-manager dry generation that never sends, so a
// flat event-name sequence is not comparable. Compare MILESTONES that a send must produce instead:
// exactly one real GENERATION_STARTED, one real GENERATE_AFTER_DATA, and the completion events.
const isDry = event => String(event.dryRun ?? '').includes('true]') || String(event.dryRun ?? '').includes(',true]');

const milestonesOf = events => {
    const count = (name, predicate = () => true) => events.filter(event => event.name === name && predicate(event)).length;
    return {
        realGenerationStarted: count('GENERATION_STARTED', event => !isDry(event)),
        dryGenerationStarted: count('GENERATION_STARTED', isDry),
        realAfterData: count('GENERATE_AFTER_DATA', event => !isDry(event)),
        dryAfterData: count('GENERATE_AFTER_DATA', isDry),
        chatCompletionSettingsReady: count('CHAT_COMPLETION_SETTINGS_READY'),
        generationEnded: count('GENERATION_ENDED'),
    };
};

// THE SEND WINDOW: the click to the send's own completion, and nothing after it.
//
// WHY THE TAIL IS CUT, with the measurement rather than an argument: the prompt manager re-renders
// itself after a send (PromptManager.js:760 now renders on MESSAGE_RECEIVED, and its `render(true)`
// runs `tryGenerate()` -> `Generate('normal', {}, true)`, openai.js:707-713). That dry assembly is a
// UI refresh, and HOW MANY of them coalesce out of the debounce is not a property of either server:
// two pinned legs recorded with the SAME probe minutes apart put 1 and then 2 dry assemblies after
// GENERATION_ENDED, and the pre-send count likewise moved between 1 and 2 on one leg. A value that
// moves on one leg run-to-run is a race, not a contract (AGENTS.md rule 18), so it is RECORDED as
// `afterSend` context and is not part of the compared milestones.
//
// The cut is exact and source-derived, not a heuristic: a generation emits GENERATE_AFTER_DATA at
// script.js:5318 and ends either at script.js:5320 (`if (dryRun) return`) or, when it is real, at
// GENERATION_ENDED (hideStopButton, script.js:3536). A dry generation cannot START inside this window
// either: `Generate` sets `is_send_press` for a real send (script.js:4400) and promptManager.render()
// waits for `!is_send_press` (PromptManager.js:868), so the next dry assembly begins only after the
// send has finished. An abort ends the window at GENERATION_STOPPED (script.js:5618) if no
// GENERATION_ENDED was recorded.
const sendWindow = report => {
    const events = report.events ?? [];
    let end = events.findIndex(event => event.name === 'GENERATION_ENDED');
    if (end === -1) {
        end = events.findIndex(event => event.name === 'GENERATION_STOPPED');
    }
    return end === -1 ? { window: events, afterSend: [] } : { window: events.slice(0, end + 1), afterSend: events.slice(end + 1) };
};

const milestones = report => milestonesOf(sendWindow(report).window);

// Context, so the excluded dry assemblies are visible in the artifact instead of hidden by the cut.
const surrounding = report => {
    const { window, afterSend } = sendWindow(report);
    const counters = events => ({
        events: events.length,
        dryGenerationStarted: events.filter(event => event.name === 'GENERATION_STARTED' && isDry(event)).length,
        dryAfterData: events.filter(event => event.name === 'GENERATE_AFTER_DATA' && isDry(event)).length,
    });
    return {
        // Recorded before the click, because the drive's own setup (selecting the chat-completion
        // source/model) starts the prompt manager's dry generation. Excluded from the window.
        beforeClick: { events: report.eventsBeforeClick?.count ?? null },
        sendWindow: counters(window),
        afterSend: counters(afterSend),
        // Whole drive, every mode: the number that says both legs ran the same NUMBER of Generate
        // invocations whatever the window did.
        wholeDrive: report.generateLifecycle ?? null,
    };
};

const providerRequests = report => (report.recording ?? []).map(request => ({
    method: request.method,
    path: request.path,
    bodyLength: request.bodyLength,
    bodySha256: request.bodySha256,
}));

// WHOLE-DRIVE Generate lifecycle, deliberately NOT windowed. The milestone counters above answer
// "what happened after the send"; this answers "how many generations did the page run in total, and
// how many of them were dry", which is the only way a reader can tell a BEHAVIOUR difference from a
// difference in where the observation window fell. A window once began a few statements before the
// send click and captured the tail of a dry generation that the drive's own setup had started, which
// made the pinned leg look like it ran one more dry assembly than GoTavern. It had not.
const invocations = report => {
    const lifecycle = report.generateLifecycle ?? null;
    if (!lifecycle) {
        return { recorded: false };
    }
    return {
        recorded: true,
        started: lifecycle.started,
        dryStarted: lifecycle.dryStarted,
        realStarted: lifecycle.realStarted,
        dryAfterData: lifecycle.dryAfterData,
        ended: lifecycle.ended,
    };
};

// WINDOW INTEGRITY. This is the property the recorded difference in the committed artifact turned
// out to be about, so it is now checked rather than assumed. Inside the reported window a generation
// that STARTED there emits exactly one GENERATE_AFTER_DATA (script.js:5318) -- a dry one ends there
// (script.js:5320), a real one continues to GENERATION_ENDED -- so a complete window holds one
// AFTER_DATA per STARTED of the same kind. A window that began while a generation was already
// running breaks that pairing: it captures the tail (AFTER_DATA) without the head (STARTED).
// Measured on the superseded legs: pinned recorded dryStarts 1 / dryAfterData 2 while GoTavern
// recorded 1 / 1, and the same 1-vs-2 asymmetry moved to the OTHER leg in other modes of the same
// harness, which is only possible if it belongs to the recording boundary and not to a server.
const windowIntegrity = report => {
    const counters = milestones(report);
    return {
        dryGenerationStarted: counters.dryGenerationStarted,
        dryAfterData: counters.dryAfterData,
        realGenerationStarted: counters.realGenerationStarted,
        realAfterData: counters.realAfterData,
        complete: counters.dryGenerationStarted === counters.dryAfterData
            && counters.realGenerationStarted === counters.realAfterData,
    };
};

// THE INVOCATION TRAIL. Every GENERATION_STARTED inside the window opens an invocation, and every
// GENERATE_AFTER_DATA is attributed to the nearest preceding one, so a dry pass that merely OVERLAPS the
// send in time is a separate invocation rather than a phantom assembly of the send. Recorded in full in
// the artifact: a reader must be able to see that the extra counting invocation exists and why it is not
// the defect.
// PAIR BY KIND, NOT BY ADJACENCY. An earlier version attributed every GENERATE_AFTER_DATA to the
// NEAREST PRECEDING GENERATION_STARTED. The groq drive proved that wrong: its counting pass starts
// between the real send's STARTED and the real send's AFTER_DATA, so the real assembly was attributed
// to the DRY invocation and the real invocation was left with NONE -- the send-window guard then
// refused a perfectly faithful drive, and the same trail read differently on the other leg purely
// because the ordering of two independent events differed. Both events carry their own dryRun flag, so
// the honest pairing is by KIND: a non-dry AFTER_DATA belongs to the last non-dry STARTED, a dry one to
// the last dry STARTED. Anything left unpaired is reported rather than dropped, so a genuinely
// unattributable assembly still fails the guard instead of disappearing.
const invocationTrail = report => {
    const events = sendWindow(report).window;
    const invocations = [];
    const unmatchedAfterData = [];
    for (const event of events) {
        if (event.name === 'GENERATION_STARTED') {
            invocations.push({ dryRun: isDry(event), t: event.t ?? null, afterData: [] });
            continue;
        }
        if (event.name === 'GENERATE_AFTER_DATA') {
            const dry = isDry(event);
            const target = [...invocations].reverse().find(invocation => invocation.dryRun === dry);
            if (target) {
                target.afterData.push(dry);
            } else {
                unmatchedAfterData.push(dry);
            }
        }
    }
    return { invocations, unmatchedAfterData };
};

// The milestones two legs must AGREE on. The independent counting invocations are excluded -- their
// number is a race (measured 1, 1 and 0 across three drives that all returned the same count), so
// comparing it would make the artifact flaky rather than faithful (rule 18). They stay recorded in
// `generationInvocations` as context a reader can inspect.
const comparableMilestones = report => {
    const { invocations } = invocationTrail(report);
    const real = invocations.filter(invocation => !invocation.dryRun);
    const counters = milestones(report);
    return {
        realInvocations: real.length,
        realAfterDataInRealInvocation: real.length === 1 ? real[0].afterData.filter(isDryValue => isDryValue === false).length : -1,
        dryAfterDataInRealInvocation: real.length === 1 ? real[0].afterData.filter(isDryValue => isDryValue === true).length : -1,
        chatCompletionSettingsReady: counters.chatCompletionSettingsReady,
        generationEnded: counters.generationEnded,
    };
};

// The guards that say the differential was FAITHFUL. A send issued while the frontend was already
// assembling a prompt interleaves two assemblies and compares a state no user can act from, and a
// window that holds half a generation cannot be compared at all.
const guards = (gotavern, pinned) => {
    const quiesced = report => report.quiescence?.quiesced === true;
    const settled = report => report.settle?.settledIdle === true;
    const complete = report => windowIntegrity(report).complete === true;
    // EXACTLY ONE NON-DRY INVOCATION IN THE WINDOW, WITH EXACTLY ONE NON-DRY AFTER_DATA AND NONE DRY;
    // INDEPENDENT COUNTING INVOCATIONS ARE RECORDED BUT NOT ATTRIBUTED.
    //
    // This used to be a WINDOW-level rule -- "no dry assembly anywhere between the click and
    // GENERATION_ENDED" -- and that was right while a token count came back instantly from the
    // guesstimate fallback. Once counts are real the frontend's counting pass takes time and can
    // interleave with the send: on three consecutive GoTavern drives that all returned the SAME correct
    // count, its invocation began 11 ms AFTER the real send started, then 401 ms BEFORE it, then not at
    // all. A window rule therefore flags whichever run happens to interleave, which is a race and not a
    // contract (rule 18), while the defect it exists for is a dry pass belonging to the REAL send -- which
    // a window cannot tell apart from a separate invocation.
    //
    // So every GENERATE_AFTER_DATA is attributed to the nearest preceding GENERATION_STARTED and the REAL
    // invocation is judged alone. The old defect still fails: a dry AFTER_DATA attributed to the real
    // invocation is precisely what `afterData` counts, and a second real invocation still fails the
    // count. The only assumption dropped is that a dry invocation cannot overlap the send in time.
    const sendOnly = report => {
        const { invocations, unmatchedAfterData } = invocationTrail(report);
        if (unmatchedAfterData.length > 0) return false;
        // NO INVOCATION MAY OWN TWO ASSEMBLIES. Pairing by kind removes the adjacency artefact, and
        // this keeps the defect that guard exists for: if the REAL send assembled dry, its dry
        // AFTER_DATA pairs with a dry invocation that already had one, so the double emission shows up
        // here instead of silently joining a counting pass. Measured both ways -- the faithful groq
        // trail (real, then a dry pass that emits its own) gives every invocation exactly one, and a
        // leg with its dry GENERATION_STARTED removed fails on `unmatchedAfterData` alone.
        if (invocations.some(invocation => invocation.afterData.length > 1)) return false;
        const real = invocations.filter(invocation => !invocation.dryRun);
        if (real.length !== 1) return false;
        const afterData = real[0].afterData;
        if (afterData.length !== 1) return false;
        return afterData[0] === false;
    };
    return {
        // EQUAL AND EMPTY IS NOT A PASS. A final text that is empty on both legs compares equal and would
        // record a vacuous success -- the same class of defect as asserting a racy tick alignment.
        finalTextNonEmpty: typeof gotavern.postSend?.finalAssistantText === 'string' && gotavern.postSend.finalAssistantText.length > 0
            && typeof pinned.postSend?.finalAssistantText === 'string' && pinned.postSend.finalAssistantText.length > 0,
        bothLegsQuiescedBeforeSend: quiesced(gotavern) && quiesced(pinned),
        bothLegsSettledAfterSend: settled(gotavern) && settled(pinned),
        bothWindowsHoldCompleteGenerations: complete(gotavern) && complete(pinned),
        sendWindowHoldsExactlyOneRealSendAndNoDryAssembly: sendOnly(gotavern) && sendOnly(pinned),
    };
};

const postBody = report => {
    const request = (report.recording ?? []).find(entry => entry.method === 'POST' && entry.body);
    if (!request) return null;
    try {
        return JSON.parse(request.body);
    } catch {
        return null;
    }
};

const bodyDiff = (left, right) => {
    const differences = [];
    if (!left || !right) return ['one leg captured no POST body'];
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    for (const key of rightKeys) {
        if (!(key in left)) differences.push(`field only in pinned: ${key}`);
    }
    for (const key of leftKeys) {
        if (!(key in right)) differences.push(`field only in GoTavern: ${key}`);
    }
    for (const key of leftKeys) {
        if (!(key in right)) continue;
        if (JSON.stringify(left[key]) !== JSON.stringify(right[key])) {
            if (key === 'messages' && Array.isArray(left[key]) && Array.isArray(right[key])) {
                const lengthNote = left[key].length === right[key].length ? `${left[key].length} messages` : `${left[key].length} vs ${right[key].length} messages`;
                for (let index = 0; index < Math.max(left[key].length, right[key].length); index++) {
                    const leftMessage = JSON.stringify(left[key][index]);
                    const rightMessage = JSON.stringify(right[key][index]);
                    if (leftMessage !== rightMessage) {
                        differences.push(`messages[${index}] differs (${lengthNote}): ` +
                            `GoTavern ${leftMessage.slice(0, 120)}... pinned ${rightMessage.slice(0, 120)}...`);
                    }
                }
            } else {
                differences.push(`field ${key} differs: GoTavern ${JSON.stringify(left[key]).slice(0, 120)} pinned ${JSON.stringify(right[key]).slice(0, 120)}`);
            }
        }
    }
    return differences;
};

// A REVERSE-PROXY DRIVE makes the frontend name the proxy URL in a confirm dialog, so the peer's
// ephemeral origin lands in a recorded dump inside postSend. A mock origin is HARNESS-derived, not
// product behaviour, and a committed artifact must not carry it: normalise rather than delete, so the
// field still compares, and let driveParameters state that the normalisation happened.
function normaliseMockOrigin(value) {
    if (value === null || value === undefined) return value ?? null;
    return JSON.parse(JSON.stringify(value, (key, inner) => (
        typeof inner === 'string' ? inner.replace(/https?:\/\/127\.0\.0\.1:\d+/g, 'http://<mock>') : inner
    )));
}

const main = async () => {
    const gotavern = JSON.parse(await fs.readFile(gotavernPath, 'utf8'));
    const pinned = JSON.parse(await fs.readFile(pinnedPath, 'utf8'));
    const comparison = {
        schemaVersion: 1,
        question: 'does the same frontend drive produce the same provider request on GoTavern and pinned?',
        // LOOPBACK, NOT THE PORTS. The legs listen on ephemeral ports, and this artifact is COMMITTED: a
    // port differs on every run and says nothing about compatibility (rule 18). What a reader needs is
    // that each leg answered on a local server, which is what this records.
    bases: { gotavern: 'loopback', pinned: 'loopback' },
        requestArrived: { gotavern: gotavern.requestArrived, pinned: pinned.requestArrived },
        providerRequests: { gotavern: providerRequests(gotavern), pinned: providerRequests(pinned) },
        milestones: { gotavern: milestones(gotavern), pinned: milestones(pinned) },
        milestoneEqual: JSON.stringify(comparableMilestones(gotavern)) === JSON.stringify(comparableMilestones(pinned)),
        // Everything the window deliberately excludes, so a reader can see it was recorded and why.
        surrounding: { gotavern: surrounding(gotavern), pinned: surrounding(pinned) },
        eventWindow: {
            gotavern: { eventsBeforeClick: gotavern.eventsBeforeClick?.count ?? null, quiescence: gotavern.quiescence ?? null, settle: gotavern.settle ?? null },
            pinned: { eventsBeforeClick: pinned.eventsBeforeClick?.count ?? null, quiescence: pinned.quiescence ?? null, settle: pinned.settle ?? null },
        },
        // DID THE CREDENTIAL TRAVEL? With a reverse proxy set the pinned server reads
        // `request.body.proxy_password` and NOT the source secret (chat-completions.js:881), and answers a bare
        // 400 {"error":true} when it is absent -- a fact this lane spent two rounds on. Recorded as a BOOLEAN
        // and never as the value, so a reader looking at a 400 knows in one glance whether the credential was
        // the problem, and the artifact cannot carry the credential itself.
        proxyPasswordPresent: {
            gotavern: (gotavern.generateCalls ?? [])[0]?.proxyPasswordPresent ?? null,
            pinned: (pinned.generateCalls ?? [])[0]?.proxyPasswordPresent ?? null,
        },
        // WHICH DRIVE PRODUCED THIS: non-stream mode paces nothing, so the frame count is not applicable here
        // and saying so is stronger than omitting the field.
        driveParameters: {
            mode: 'nonstream',
            frameCount: 'n/a (non-stream drive; the streaming artifacts carry PROBE_FRAME_COUNT)',
            // THE RULE, IN ONE LINE, because the next reader will otherwise assume nearest-preceding and
            // reintroduce exactly the bug this lane fixed.
            invocationPairing: 'a non-dry AFTER_DATA belongs to the last non-dry STARTED; a dry one to the last dry STARTED; an unmatched assembly, or two assemblies in one invocation, fails',
            // SILICONFLOW'S ENDPOINT IS A BODY FIELD, so the artifact must say which endpoint the drive
            // drove and how: the drive selects the DEFAULT through the frontend's own control, and the
            // seam aims that endpoint's host. The CN endpoint exists but is NOT exercised here.
            // WORKERS_AI'S URL IS BUILT FROM A BODY VALUE, so the artifact must say which account id the
            // drive drove and through which control, or the numbers cannot be read back against the
            // prefix the seam replaced.
            // OPENROUTER IS `proxy: false` AND ITS URL IS A PINNED LITERAL with no request member that
            // can carry a peer (unlike CUSTOM's custom_url and unlike the proxy-capable sources). The seam
            // plus the transport redirect are therefore the ONLY route to a peer, and
            // proxyPasswordPresent FALSE on both legs is the recorded evidence of that -- it is not a
            // tautology here because the field would be true if the drive had travelled as a proxy.
            // CLAUDE IS PROXY-CAPABLE AND NO-VALIDATE. Its peer travels in the frontend's own
            // reverse_proxy setting (so proxyPasswordPresent TRUE on both legs is the evidence the
            // credential went as proxy_password), and it must NEVER ask for a model list -- a CONNECT
            // button that validated would call /status, and the drive reaching /models would be the
            // harness bug this record exists to avoid.
            ...(process.env.PROBE_SOURCE === 'claude' ? {
                seamEnvVar: 'GOTAVERN_CLAUDE_CHAT_URL',
                peerRoute: 'the frontend reverse_proxy setting, followed by BOTH legs -- claude is proxy-capable, and a reverse-proxy drive is the route a user takes',
                seamUsage: 'safety net only: GOTAVERN_CLAUDE_CHAT_URL exists in the Go arm and is aimed here so a leg preferring the pinned literal cannot reach the real provider, but the route this drive took is the setting, which is why proxyPasswordPresent is TRUE on both legs',
                noValidate: 'claude is in the frontend noValidateSources list, so the CONNECT path never validates; this artifact must therefore record ZERO /models calls on BOTH legs',
            } : {}),
            ...(process.env.PROBE_SOURCE === 'openrouter' ? {
                seamEnvVar: 'GOTAVERN_OPENROUTER_CHAT_URL',
                peerRoute: 'the seam on the GoTavern leg and the https://openrouter.ai/api/v1 transport redirect on the pinned leg -- openrouter has no reverse_proxy and no custom_url, so no request member can carry a peer',
                proxyPasswordMeaning: 'proxyPasswordPresent false on BOTH legs is the EVIDENCE that the seam and the redirect were the only route; a true would mean the drive had started travelling as a proxy and the artifact would no longer describe a proxy:false source',
                pinnedRedirectRequired: 'PROBE_PINNED_REDIRECT_FILE is NOT optional: without it the pinned leg fetches the real provider and an empty peer log reads like a product hang',
            } : {}),
            ...(process.env.PROBE_SOURCE === 'workers_ai' ? {
                accountIdMode: gotavern.accountId?.mode ?? null,
                accountIdControl: gotavern.accountId?.control ?? null,
                accountIdValue: gotavern.accountId?.value ?? null,
                peerPathShape: 'the peer saw accounts-prefix + the account id + /ai/v1/chat/completions, and the model list at /<account>/ai/models/search?task=Text+Generation&per_page=1000, because the seam replaces the PREFIX only and the id stays in the path where the product puts it',
            } : {}),
            ...(process.env.PROBE_SOURCE === 'siliconflow' ? {
                endpointMode: gotavern.endpoint?.mode ?? null,
                endpointControl: gotavern.endpoint?.control ?? null,
                endpointsOffered: gotavern.endpoint?.available ?? null,
                endpointBreadth: 'the DEFAULT (global) endpoint only. The CN endpoint is a supported second host and is not measured here, so this row does not claim endpoint breadth',
            } : {}),
                ...(process.env.PROBE_SOURCE === 'chutes' ? {
                sourceShape: "CHUTES forwards messages VERBATIM, with `top_k` and `logit_bias` members no sibling source sends: the recorded provider body IS the evidence, and the artifact carries its digest rather than a re-shaped copy. This is the case that makes a shared-helper implementation look correct and be wrong: a source whose MESSAGE side has no processor at all cannot be served by a helper that quietly reshapes messages for its siblings, and the recorded body digest is what would catch it.",
            } : {}),
            ...(process.env.PROBE_SOURCE === 'electronhub' ? {
                sourceShape: "ELECTRONHUB HAS NO reverse_proxy SUPPORT AT ALL: its route is a bare literal and always reads the ELECTRONHUB secret, so a request carrying a proxy is IGNORED rather than proxied. `proxyPasswordPresent: false` on both legs therefore means UNSUPPORTED, not unused, and the artifact says so because a reader would otherwise read the false as \"proxy available and untouched\".",
            } : {}),
        ...(process.env.PROBE_SOURCE === 'groq' || process.env.PROBE_SOURCE === 'siliconflow' || process.env.PROBE_SOURCE === 'nanogpt' || process.env.PROBE_SOURCE === 'deepseek' ? {
                // NAMED PER SOURCE: a nanogpt artifact that told a reader GOTAVERN_GROQ_CHAT_URL aims
                // its GoTavern leg would be describing a drive that did not happen.
                seamEnvVar: { groq: 'GOTAVERN_GROQ_CHAT_URL', siliconflow: 'GOTAVERN_SILICONFLOW_CHAT_URL', nanogpt: 'GOTAVERN_NANOGPT_CHAT_URL', deepseek: 'GOTAVERN_DEEPSEEK_CHAT_URL', aimlapi: 'GOTAVERN_AIMLAPI_CHAT_URL', ai21: 'GOTAVERN_AI21_CHAT_URL' }[process.env.PROBE_SOURCE] ?? null,
                pinnedRedirectRequired: 'PROBE_PINNED_REDIRECT_FILE is NOT optional for a source the frontend marks proxy:false. Without it run-against-pinned.mjs installs no transport redirect hook, the pinned server fetches the REAL provider, and the peer log stays EMPTY -- which reads exactly like a product hang or a product defect, and did for two rounds in this lane. The seam named in seamEnvVar aims the GoTavern leg and the redirect aims the pinned leg; both are required, and proxyPasswordPresent false on BOTH legs is the evidence that neither leg could have reached a peer through a reverse proxy instead.',
                peerKeying: 'the mock script is POSITIONAL and fails in BOTH directions, so the COUNT of model-list answers is not the axis: with ONE entry the pinned generate never arrives (the second status call consumes it and the send is refused with online_status no_connection); with THREE the generate arrives but receives a MODELS body and renders an empty string while the other leg renders text -- an equal-empty that finalTextNonEmpty exists to catch. The peer therefore answers by REQUEST (GET -> model list, completion POST -> completion, SSE when streaming and JSON when not), which is correct for any number of status calls.',
            } : {}),
            // OPENAI IS proxy:true, WHICH IS THE FACT THAT MAKES THIS ROW DIFFERENT from the groq/siliconflow/nanogpt
            // rows: the frontend DOES offer a reverse_proxy for it, so this drive COULD have carried the peer in the
            // request. It deliberately did not, and `proxyPasswordPresent` false on BOTH legs is the evidence -- both
            // legs reached the peer through the GoTavern seam and the pinned transport redirect, not through a proxy
            // credential, so the comparison stays about the pinned provider-wire bytes rather than about which of two
            // available aiming mechanisms each leg happened to use.
            // XAI'S ROUTE IS THE SETTING, NOT THE SEAM, and the artifact must say so: for
            // groq/siliconflow/nanogpt/deepseek the seam plus the redirect are the ONLY route to a peer,
            // while xAI is proxy-capable and this drive carries the peer in `reverse_proxy` exactly as a
            // user's endpoint would. proxyPasswordPresent true on both legs is the evidence -- a
            // seam-routed leg sends no proxy_password and would record false.
            ...(process.env.PROBE_SOURCE === 'xai' ? {
                seamEnvVar: 'GOTAVERN_XAI_CHAT_URL',
                peerRoute: 'the frontend reverse_proxy setting, followed by BOTH legs (chat-completions.js:1184 `new URL(request.body.reverse_proxy || API_XAI)`), which is a path a user can take because xAI is proxy-capable',
                seamUsage: 'safety net only: GOTAVERN_XAI_CHAT_URL and the api.x.ai transport redirect are both aimed at the peer so a leg preferring the pinned literal cannot reach the real api.x.ai, but NEITHER is the route this drive took, and proxyPasswordPresent true on both legs is the evidence',
                converterNote: 'xAI runs convertXAIMessages (prompt-converters.js:785), a RENAMER that prefixes content with the character or user name and DELETES msg.name -- not the semi_tools merger. A wrong port would still produce a parseable body, so the compared provider bytes are the assertion',
            } : {}),            ...(process.env.PROBE_SOURCE === 'openai' ? {
                seamEnvVar: 'GOTAVERN_OPENAI_CHAT_URL',
                proxySettingDeliberatelyUnset: 'apiSourceConfig marks openai proxy:true (SECRET_KEYS.OPENAI, #api_key_openai), so oai_settings.reverse_proxy WAS available to this drive and was left unset on purpose; a reader must not conclude from the false that the frontend offers no proxy for openai',
                pinnedRedirectRequired: 'PROBE_PINNED_REDIRECT_FILE aims the PINNED leg (the transport hook run-against-pinned.mjs installs) at the same peer the seam aims the GoTavern leg at. Without it the pinned server fetches api.openai.com, the peer log stays EMPTY, and an empty log reads exactly like a product hang.',
                peerKeying: 'the peer answers by REQUEST (GET -> model list, POST -> completion) rather than positionally, because how many status calls the frontend makes is its own business; a positional script with one models answer let the second status call consume the completion body and the send was refused with online_status no_connection, measured on the groq leg.',
            } : {}),

        },
        guards: guards(gotavern, pinned),
        // One line, in the artifact itself, so the next reader does not assume this is the old window
        // rule: it is an INVOCATION-level assertion, and independent counting invocations are recorded
        // rather than attributed.
        guardMeaning: {
            sendWindowHoldsExactlyOneRealSendAndNoDryAssembly:
                'exactly one non-dry invocation in the window, with exactly one non-dry AFTER_DATA and none dry, and independent counting invocations recorded but not attributed',
        },
        generationInvocations: { gotavern: invocationTrail(gotavern).invocations, pinned: invocationTrail(pinned).invocations },
        generationUnmatchedAfterData: { gotavern: invocationTrail(gotavern).unmatchedAfterData, pinned: invocationTrail(pinned).unmatchedAfterData },
        // THE WHOLE-DRIVE TRAIL, including the counting invocations outside the send window. They are
        // recorded so a reader can see that an independent counting invocation exists and that it is not
        // attributed to the send; they are NOT compared, because how many coalesce out of the debounce is
        // a race (measured 0, 1 and 1 across three drives that all returned the same count).
        wholeDriveInvocations: {
            gotavern: gotavern.generateLifecycle?.invocations ?? null,
            pinned: pinned.generateLifecycle?.invocations ?? null,
        },
        comparableMilestones: { gotavern: comparableMilestones(gotavern), pinned: comparableMilestones(pinned) },
        postSend: { gotavern: normaliseMockOrigin(gotavern.postSend), pinned: normaliseMockOrigin(pinned.postSend) },
        bodyDifferences: bodyDiff(postBody(gotavern), postBody(pinned)),
    };
    comparison.providerRequestEqual =
        JSON.stringify(comparison.providerRequests.gotavern) === JSON.stringify(comparison.providerRequests.pinned);
    comparison.windowIntegrity = { gotavern: windowIntegrity(gotavern), pinned: windowIntegrity(pinned) };
    console.log(JSON.stringify(comparison, null, 2));
    // Printed to stderr so stdout stays the artifact. A false guard means the two records do not
    // describe a comparable state, and no reason recorded alongside them would make them do so.
    const failed = Object.entries(comparison.guards).filter(([, value]) => value !== true).map(([name]) => name);
    if (failed.length > 0) {
        console.error(`unfaithful generation differential, ${failed.length} guard(s) failed: ${failed.join(', ')}`);
        for (const [leg, trail] of Object.entries(comparison.generationInvocations)) {
            const real = trail.filter(invocation => !invocation.dryRun);
            if (real.length !== 1 || real[0].afterData.length !== 1 || real[0].afterData[0] !== false) {
                console.error(`  ${leg} real invocation: ${real.length} non-dry invocation(s) in the window, ` +
                    `afterData of the real one = [${real.map(invocation => invocation.afterData.join(',')).join(' | ')}] ` +
                    `(a dry AFTER_DATA attributed to the REAL invocation is the defect this guard exists for)`);
            }
        }
        for (const [leg, integrity] of Object.entries(comparison.windowIntegrity)) {
            if (integrity.complete !== true) {
                console.error(`  ${leg} window holds half a generation: dry STARTED ${integrity.dryGenerationStarted} vs dry AFTER_DATA ${integrity.dryAfterData}, ` +
                    `real STARTED ${integrity.realGenerationStarted} vs real AFTER_DATA ${integrity.realAfterData}`);
            }
        }
        process.exitCode = 1;
    }
};

await main();
