// THE REGEX COMPARATOR. Reads leg reports written by regex-probe.mjs and decides whether a regex rule
// REALLY EXECUTED on both subjects, at the pinned placement, and whether its result reached the FINAL
// provider request (or deliberately did not) -- with the same answer on both.
//
// THE SHAPE OF EVERY CASE, and why it cannot pass vacuously:
//
//   Each case asserts FOUR things, not one:
//     1. the rule's OUTPUT arrived where it must (the provider request, the DOM, or both);
//     2. the rule's INPUT did not arrive there (otherwise "arrived" could be the raw text);
//     3. the counterpart variant's capture is DIFFERENT (a disabled rule, or the swapped order) -- so the
//        observation is caused by the rule and not by the harness;
//     4. the same three hold on BOTH subjects, compared by body sha256.
//   A case that cannot satisfy 3 is reported as `harness: non-discriminating` rather than as a pass, which
//   is AGENTS.md rule 50 applied per case: if disabling the rule does not change the capture, the capture
//   was never evidence about the rule.
//
// THE ORACLE IS THE BROWSER, NEVER RE2. Case 6's expected substitution is the string the PINNED LEG's own
// page produced by calling `getRegexedString` (recorded in that leg's `sides.js.prompt`), and the assertion
// is that GoTavern's page produced the SAME string and that the same string reached GoTavern's provider
// request. Nothing here derives `$&`, `$$`, `$1`, `$<name>`, a lookbehind or a flag's meaning; a Go RE2
// result is never consulted and cannot be, because no Go code computes this string.
//
// Usage: node tests/browser/compare-regex-legs.mjs <baseline-go> <baseline-pinned> [--swapped-go <swap-chain-go>] [--swapped-pinned <swap-chain-pinned>] [--disabled-go <disabled-rewrite-go>] [--disabled-pinned <disabled-rewrite-pinned>]
// Prints the artefact as JSON on stdout; exits non-zero unless the verdict is `match`.

import fs from 'node:fs';
import path from 'node:path';

import { MARKERS, SIDES } from './regex-kit.mjs';

const positional = [];
const named = {};
const argv = process.argv.slice(2);
for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token.startsWith('--')) {
        named[token.slice(2)] = argv[index + 1];
        index += 1;
    } else {
        positional.push(token);
    }
}
const [baselineGoPath, baselinePinnedPath] = positional;
if (!baselineGoPath || !baselinePinnedPath) {
    console.error('usage: node compare-regex-legs.mjs <baseline-go.json> <baseline-pinned.json> [--swapped-go <json>] [--swapped-pinned <json>] [--disabled-go <json>] [--disabled-pinned <json>]');
    process.exit(2);
}

const missingLegs = [];
const load = (file, label) => {
    if (!file) {
        missingLegs.push(`${label} (not supplied)`);
        return null;
    }
    if (!fs.existsSync(file)) {
        missingLegs.push(`${label} (${path.basename(file)} does not exist)`);
        return null;
    }
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
        missingLegs.push(`${label} (${path.basename(file)} unreadable: ${error.message})`);
        return null;
    }
};
const legs = {
    baseline: { gotavern: load(baselineGoPath, 'baseline/gotavern'), pinned: load(baselinePinnedPath, 'baseline/pinned') },
    swapped: { gotavern: load(named['swapped-go'], 'swap-chain/gotavern'), pinned: load(named['swapped-pinned'], 'swap-chain/pinned') },
    disabled: { gotavern: load(named['disabled-go'], 'disabled-rewrite/gotavern'), pinned: load(named['disabled-pinned'], 'disabled-rewrite/pinned') },
};

// ===================================================================================================
// PROVIDER-REQUEST ACCESS. The chat/completions requests, in arrival order, with the raw body kept. The
// contract is the bytes (differential doctrine 2): the sha256 is what two legs are compared on, and the
// parsed messages are only used to say WHICH statement failed.
// ===================================================================================================
const requestsOf = report => (report?.peerRequests ?? []).filter(entry => /chat\/completions/.test(entry.path ?? ''));
const messagesOf = entry => {
    try {
        const parsed = JSON.parse(entry?.body ?? 'null');
        return Array.isArray(parsed?.messages) ? parsed.messages : null;
    } catch {
        return null;
    }
};
const textOf = message => {
    const content = message?.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.map(part => (typeof part === 'string' ? part : part?.text ?? '')).join('\n');
    return '';
};
const allText = entry => (messagesOf(entry) ?? []).map(textOf).join('\n\u0000\n');
const turnContaining = (entry, needle) => (messagesOf(entry) ?? []).find(message => textOf(message).includes(needle)) ?? null;

const guards = {};
const details = {};
const guard = (name, run) => {
    const problems = run();
    guards[name] = problems.length === 0;
    if (problems.length > 0) details[`${name}Problems`] = problems;
    return problems;
};

// A GUARD MUST NEVER READ AS PASSING BECAUSE ITS SUBJECT WAS ABSENT. Every case guard iterates the two
// subjects and needs a report for each; `if (!report) continue` turns a wholly absent input into an empty
// problem list, i.e. a green that cannot fail -- the exact shape AGENTS.md 7/19/50 forbids. So the absent
// case is an explicit finding here, and it names the subject, and `legsPresent` is a second opinion rather
// than the only one.
const require = (report, subject, what, problems) => {
    if (!report) {
        problems.push(`${subject}: no leg report, so "${what}" is unverified (this is a missing measurement, not a pass)`);
        return false;
    }
    return true;
};

// ===================================================================================================
// FAITHFULNESS FIRST (differential doctrine 1): before any case is read, the legs must be legs.
// ===================================================================================================
guard('legsPresent', () => (missingLegs.length === 0 ? [] : [`${missingLegs.length} leg report(s) missing or unreadable: ${missingLegs.join(', ')}`]));

guard('legsDrove', () => {
    const problems = [];
    for (const [variant, pair] of Object.entries(legs)) {
        for (const [subject, report] of Object.entries(pair)) {
            if (!report) continue; // legsPresent names it
            if (report.failure) problems.push(`${subject}/${variant}: the leg reports failure: ${String(report.failure).slice(0, 300)}`);
            const inPlay = report.rulesInPlay ?? {};
            const declared = (report.rules ?? []).length;
            if (inPlay.count !== declared) {
                problems.push(`${subject}/${variant}: the page reported ${inPlay.count} rule(s) in play and the leg wrote ${declared}; the rules are not in the product this leg measured`);
            }
            if (inPlay.regexExtensionDisabled === true) {
                problems.push(`${subject}/${variant}: disabledExtensions contains 'regex', so getRegexedString returns its input untouched (engine.js:342) and every case here would pass for that one reason`);
            }
            const completions = requestsOf(report).length;
            if (completions < 1) problems.push(`${subject}/${variant}: no chat/completions request reached the peer`);
            if (report.variant !== variant) problems.push(`${subject}/${variant}: the report says variant ${JSON.stringify(report.variant)}`);
            if (report.subject !== subject) problems.push(`${subject}/${variant}: the report says subject ${JSON.stringify(report.subject)}`);
        }
    }
    return problems;
});

// THE VARIANTS MUST BE DIFFERENT DECLARATIONS. A workflow that ran the baseline three times would give
// three identical captures and every "different from the counterpart" assertion would fail -- which is the
// right failure, but naming it here says WHICH mistake was made.
guard('variantsAreDistinctDeclarations', () => {
    const seen = new Map();
    const problems = [];
    for (const [variant, pair] of Object.entries(legs)) {
        for (const [subject, report] of Object.entries(pair)) {
            if (!report) continue;
            const signature = JSON.stringify((report.rules ?? []).map(rule => [rule.id, Boolean(rule.disabled)]).sort());
            const key = `${subject}:${signature}`;
            if (seen.has(key)) problems.push(`${subject}/${variant} declares the identical rule set to ${seen.get(key)}; a variant that is not a negation cannot be a counterpart`);
            else seen.set(key, variant);
        }
    }
    return problems;
});

// ===================================================================================================
// CASE 1. THE REWRITE. The typed turn's token is REWRITTEN in the provider request, and with the rule
// disabled the request is DEMONSTRABLY DIFFERENT -- both directions asserted, on both subjects.
// ===================================================================================================
const CASE1_TOKENS = { input: MARKERS.inActive, output: MARKERS.outActive };

guard('case1_rewriteReachedTheProviderRequestOnBothSubjects', () => {
    const problems = [];
    for (const subject of ['gotavern', 'pinned']) {
        const report = legs.baseline[subject];
        if (!require(report, subject, "this case", problems)) continue;
        const requests = requestsOf(report);
        if (requests.length === 0) {
            problems.push(`${subject}: no chat/completions request, so case 1 has nothing to read`);
            continue;
        }
        // The SEND's request is the FIRST one: it is the assembly that contains the typed turn.
        const sent = requests[0];
        const text = allText(sent);
        if (!text.includes(CASE1_TOKENS.output)) problems.push(`${subject}: the request the send produced does not contain ${CASE1_TOKENS.output}, so R1 did not reach the provider request`);
        // THE INPUT MUST BE GONE FROM THAT TURN, or "the output is there" says nothing: a rule that appended
        // its replacement and left the input would satisfy the assertion above.
        const turn = turnContaining(sent, MARKERS.turn);
        if (!turn) problems.push(`${subject}: the sent request has no message containing the turn marker ${MARKERS.turn}`);
        else {
            const turnText = textOf(turn);
            if (turnText.includes(CASE1_TOKENS.input)) problems.push(`${subject}: the turn that carried ${CASE1_TOKENS.input} still carries it in the sent request, so the token was duplicated rather than rewritten`);
        }
    }
    return problems;
});

guard('case1_disablingTheRuleChangesTheRequestBothSubjectsBothDirections', () => {
    const problems = [];
    for (const subject of ['gotavern', 'pinned']) {
        const withRule = legs.baseline[subject];
        const withoutRule = legs.disabled[subject];
        if (!withRule || !withoutRule) {
            problems.push(`${subject}: the disabled-rewrite leg did not run, so "the rule changes the request" is unproven on this subject`);
            continue;
        }
        const withRequests = requestsOf(withRule);
        const withoutRequests = requestsOf(withoutRule);
        if (withRequests.length === 0 || withoutRequests.length === 0) {
            problems.push(`${subject}: one of the two directions produced no request (${withRequests.length} with the rule, ${withoutRequests.length} without)`);
            continue;
        }
        // BOTH DIRECTIONS on the SEND's request (index 0, the one that carries the typed turn).
        const a = withRequests[0];
        const b = withoutRequests[0];
        if (a.sha256 === b.sha256) {
            problems.push(`${subject}: disabling R1 did NOT change the provider request (both are ${String(a.sha256).slice(0, 12)}); the capture is not evidence about this rule (HARNESS NON-DISCRIMINATING)`);
            continue;
        }
        // Forward: the enabled leg carries the output and the disabled leg does not.
        if (!allText(a).includes(CASE1_TOKENS.output)) problems.push(`${subject}: the enabled leg's request lacks ${CASE1_TOKENS.output}`);
        if (allText(b).includes(CASE1_TOKENS.output)) problems.push(`${subject}: the disabled leg's request contains ${CASE1_TOKENS.output}, so the "disabled" direction is not a negation of this rule`);
        // Backward: the disabled leg still carries the input, and the enabled leg does not.
        if (!allText(b).includes(CASE1_TOKENS.input)) problems.push(`${subject}: the disabled leg's request lost ${CASE1_TOKENS.input}, so something other than R1 consumed it`);
        if (allText(a).includes(CASE1_TOKENS.input)) problems.push(`${subject}: the enabled leg's request still contains ${CASE1_TOKENS.input} somewhere; R1 did not rewrite it`);
    }
    return problems;
});

// ===================================================================================================
// CASE 2. DISPLAY-ONLY. The DOM shows the rule's output for a turn; the provider request never carries it.
// The rule is markdownOnly + promptOnly, which after the frontend's own MD_DISPLAY migration
// (regex/index.js:1389-1398) is the shape a user's legacy rule has, and which engine.js:350-355 admits only
// when `isMarkdown` is set -- a flag ONLY messageFormatting passes.
// ===================================================================================================
guard('case2_displayOnlyChangedTheDomAndNotTheProviderRequest', () => {
    const problems = [];
    for (const subject of ['gotavern', 'pinned']) {
        const report = legs.baseline[subject];
        if (!require(report, subject, "this case", problems)) continue;
        const observed = report.displayOnlyUserTurn ?? null;
        if (!observed) {
            problems.push(`${subject}: the leg recorded no display-only observation`);
            continue;
        }
        // (1) the DOM side must have changed, and to the rule's output.
        if (observed.displayChanged !== true) problems.push(`${subject}: R4 (markdownOnly) changed nothing in the rendered text, so the display-only half has no observable`);
        if (!String(observed.display ?? '').includes(SIDES.display.marker)) problems.push(`${subject}: the rendered text does not carry ${SIDES.display.marker}`);
        // (2) the PROMPT side must not have changed, and must still hold the input.
        if (observed.promptChanged !== false) problems.push(`${subject}: R4 (markdownOnly) changed the prompt text, so it is not display-only`);
        if (!String(observed.prompt ?? '').includes(MARKERS.inDisplay)) problems.push(`${subject}: the prompt text for that turn lost ${MARKERS.inDisplay}, so something rewrote it`);
        // (3) AND THE REAL REQUEST: no chat/completions body of this leg may carry the display output.
        for (const [index, request] of requestsOf(report).entries()) {
            if (allText(request).includes(SIDES.display.marker)) {
                problems.push(`${subject}: chat/completions request #${index} carries ${SIDES.display.marker}, so a display-only rule reached the provider request`);
            }
        }
        // (4) the DISPLAY output must not be the raw token, or the DOM difference is the input itself.
        if (String(observed.display ?? '').includes(MARKERS.inDisplay) && observed.displayChanged) {
            problems.push(`${subject}: the rendered text still contains the raw ${MARKERS.inDisplay} alongside a claimed change`);
        }
    }
    return problems;
});

// ===================================================================================================
// CASE 3. PROMPT-ONLY. The provider request carries the rule's output; the DISPLAYED text for that same
// input is unchanged, in the product's own display-path answer.
// ===================================================================================================
guard('case3_promptOnlyChangedTheProviderRequestAndNotTheDisplay', () => {
    const problems = [];
    for (const subject of ['gotavern', 'pinned']) {
        const report = legs.baseline[subject];
        if (!require(report, subject, "this case", problems)) continue;
        const side = report.sides?.promptOnly ?? null;
        if (!side) {
            problems.push(`${subject}: the leg recorded no promptOnly side`);
            continue;
        }
        if (side.promptChanged !== true) problems.push(`${subject}: R3 (promptOnly) did not change the prompt text, so it never reached prompt assembly`);
        if (side.displayChanged !== false) problems.push(`${subject}: R3 (promptOnly) changed the DISPLAY text, so the pinned isPrompt split does not hold on this subject`);
        if (!String(side.prompt ?? '').includes(SIDES.prompt.marker)) problems.push(`${subject}: the prompt text lacks ${SIDES.prompt.marker}`);
        if (String(side.display ?? '').includes(SIDES.prompt.marker)) problems.push(`${subject}: the display text carries ${SIDES.prompt.marker}, so the display is not in its original form`);
        // AND IN THE REAL REQUEST of the SEND (index 0), which contains the typed turn.
        const requests = requestsOf(report);
        if (requests.length === 0) problems.push(`${subject}: no request to read for case 3`);
        else if (!allText(requests[0]).includes(SIDES.prompt.marker)) problems.push(`${subject}: the sent request does not contain ${SIDES.prompt.marker}, so R3 did not reach the provider`);
        // AND IN THE RENDERED DOM of the final round: the user's typed turn must still show the raw token.
        const rendered = (report.rendered?.final ?? []).map(entry => String(entry.text ?? '')).join('\n');
        if (rendered.length === 0) problems.push(`${subject}: no rendered text was recorded, so "the display is unchanged" cannot be read`);
        else {
            if (!rendered.includes(MARKERS.inPrompt)) problems.push(`${subject}: the rendered chat no longer shows ${MARKERS.inPrompt}; the page is not displaying the input in its original form`);
            if (rendered.includes(SIDES.prompt.marker)) problems.push(`${subject}: the rendered chat shows ${SIDES.prompt.marker}, so a prompt-only rule reached the display`);
        }
    }
    return problems;
});

// ===================================================================================================
// CASE 4. THE CHAIN. Rule C-A creates the text C-B matches. The order matters: with the two exchanged,
// C-B runs first, finds nothing, and C-A's output SURVIVES. The observable is therefore the presence of the
// MIDDLE token in the swapped variant and its ABSENCE in the baseline on both subjects.
// ===================================================================================================
guard('case4_chainFormsInDeclaredOrderAndOrderMatters', () => {
    const problems = [];
    for (const subject of ['gotavern', 'pinned']) {
        const baseline = legs.baseline[subject];
        const swapped = legs.swapped[subject];
        if (!baseline || !swapped) {
            problems.push(`${subject}: the swap-chain leg did not run, so "the pinned enum allows ordering that matters" is unproven on this subject`);
            continue;
        }
        const ordered = requestsOf(baseline)[0];
        const reversed = requestsOf(swapped)[0];
        if (!ordered || !reversed) {
            problems.push(`${subject}: one of the two chain variants produced no request`);
            continue;
        }
        const orderedText = allText(ordered);
        const reversedText = allText(reversed);
        // The chain formed: the final token is there and the middle token is not.
        if (!orderedText.includes(SIDES.chain.marker)) problems.push(`${subject}: the declared order did not produce ${SIDES.chain.marker}, so the chain C-A -> C-B did not complete`);
        if (orderedText.includes(SIDES.chainMiddle)) problems.push(`${subject}: the declared order LEFT ${SIDES.chainMiddle} in the request, so C-B did not consume C-A's output`);
        // The order matters: swapped, C-B cannot match and C-A's product survives.
        if (!reversedText.includes(SIDES.chainMiddle)) problems.push(`${subject}: with the two rules exchanged, ${SIDES.chainMiddle} is absent -- so either the order does not matter or the swap did not take effect`);
        if (reversedText.includes(SIDES.chain.marker)) problems.push(`${subject}: with the rules exchanged the chain STILL completed, so the observable does not depend on the order and case 4 proves nothing`);
        if (ordered.sha256 === reversed.sha256) problems.push(`${subject}: the two orders produced the same request bytes (${String(ordered.sha256).slice(0, 12)}), so this harness cannot see the order`);
    }
    return problems;
});

// ===================================================================================================
// CASE 5. NEGATIVES, EACH WITH ITS REASON. A negative must be ABSENT and the leg must say WHY, from the
// product's own observation, rather than from the harness's intention:
//
//   disabled   R2 is disabled in the settings AND the engine skipped it (both surfaces unchanged, input
//              intact). "Disabled" is a fact the page reports, not a claim the test makes.
//   depth      R5 is minDepth 1, so depth 0 skipped it and depth 1 applied it. The leg proves BOTH halves,
//              which is what distinguishes "the depth guard works" from "the rule never fires".
//   no match   The token matches nothing in the rule set, and NOTHING may rewrite it.
//
// Each also asserts the SAME fact from the real request where the request is the surface in question.
// ===================================================================================================
guard('case5_disabledRuleIsUnchangedAndTheLegSaysWhy', () => {
    const problems = [];
    for (const subject of ['gotavern', 'pinned']) {
        const report = legs.baseline[subject];
        if (!require(report, subject, "this case", problems)) continue;
        const side = report.sides?.disabled ?? null;
        if (!side) {
            problems.push(`${subject}: no disabled side recorded`);
            continue;
        }
        const declared = (report.rules ?? []).find(rule => rule.id === 'rx-probe-disabled');
        if (!declared || declared.disabled !== true) problems.push(`${subject}: the leg did not declare R2 as disabled, so its absence cannot be attributed to the disabled flag`);
        if (side.promptChanged !== false || side.displayChanged !== false) problems.push(`${subject}: R2 is disabled yet changed the text (promptChanged=${side.promptChanged}, displayChanged=${side.displayChanged})`);
        if (!String(side.prompt ?? '').includes(MARKERS.inDisabled)) problems.push(`${subject}: R2's input ${MARKERS.inDisabled} is missing from the prompt text, so the absence of its output is not the disabled rule's doing`);
        for (const [index, request] of requestsOf(report).entries()) {
            if (allText(request).includes(SIDES.negatives.disabled)) problems.push(`${subject}: chat/completions request #${index} carries ${SIDES.negatives.disabled} although the rule is disabled`);
        }
        const sent = requestsOf(report)[0];
        if (sent && !allText(sent).includes(MARKERS.inDisabled)) problems.push(`${subject}: the sent request does not carry ${MARKERS.inDisabled}, so "the disabled rule changed nothing" cannot be read from it`);
        // THE REASON, stated in the artefact.
        details.disabledReason = details.disabledReason ?? 'R2 is written with disabled:true into the settings the page loads, the leg records that flag, and the product reports no change on either surface while its input survives -- so the absence is the flag, not an inert engine';
    }
    return problems;
});

guard('case5_depthNotSatisfiedIsUnchangedAndDepthSatisfiedApplies', () => {
    const problems = [];
    for (const subject of ['gotavern', 'pinned']) {
        const report = legs.baseline[subject];
        if (!require(report, subject, "this case", problems)) continue;
        const atZero = report.sides?.depth ?? null;
        const atOne = report.sides?.depthAtOne ?? null;
        if (!atZero || !atOne) {
            problems.push(`${subject}: the depth side was not recorded in both directions`);
            continue;
        }
        const declared = (report.rules ?? []).find(rule => rule.id === 'rx-probe-depth');
        if (!declared || declared.minDepth !== 1) problems.push(`${subject}: R5 was not declared with minDepth 1`);
        // Depth 0 (the turn being sent): unchanged, because coreChat.length - index - 1 = 0 (:4504).
        if (atZero.promptChanged !== false) problems.push(`${subject}: R5 (minDepth 1) changed the depth-0 text, so the pinend minDepth guard is not applied`);
        // Depth 1 (the previous turn): applied.
        if (atOne.promptChanged !== true) problems.push(`${subject}: R5 (minDepth 1) did not change the depth-1 text, so the depth guard is inverted or ignored and the depth-0 negative above is vacuous`);
        // AND FROM THE REAL REQUEST: the typed turn (depth 0) must not carry the depth rule's output, and the
        // previous turn (depth 1) must.
        const sent = requestsOf(report)[0];
        if (!sent) {
            problems.push(`${subject}: no request to read the depth case from`);
            continue;
        }
        const typedTurn = turnContaining(sent, MARKERS.turn);
        if (!typedTurn) problems.push(`${subject}: the sent request has no typed turn to read`);
        else if (textOf(typedTurn).includes(SIDES.negatives.depth)) problems.push(`${subject}: the typed turn (depth 0) carries ${SIDES.negatives.depth}, so the minDepth guard did not hold on the real request`);
        const previousTurn = turnContaining(sent, 'RXQ_PREV_T1');
        if (!previousTurn) problems.push(`${subject}: the sent request does not contain the previous turn, so the depth-1 positive cannot be read from the request`);
        else if (!textOf(previousTurn).includes(SIDES.negatives.depth)) problems.push(`${subject}: the previous turn (depth 1) does not carry ${SIDES.negatives.depth}, so R5 did not apply where it must`);
        details.depthReason = details.depthReason ?? 'R5 has minDepth 1. The typed turn is depth 0 in a prompt assembly (script.js:4504) so the rule is SKIPPED for it, and the turn before it is depth 1 so the rule APPLIES -- both halves are asserted, which is what makes the depth-0 absence a measurement rather than an omission';
    }
    return problems;
});

guard('case5_noMatchIsUnchangedAndSaysWhy', () => {
    const problems = [];
    for (const subject of ['gotavern', 'pinned']) {
        const report = legs.baseline[subject];
        if (!require(report, subject, "this case", problems)) continue;
        const side = report.sides?.noMatch ?? null;
        if (!side) {
            problems.push(`${subject}: no no-match side recorded`);
            continue;
        }
        if (side.promptChanged !== false || side.displayChanged !== false) problems.push(`${subject}: ${MARKERS.noMatch} was rewritten although no rule's findRegex mentions it`);
        const sent = requestsOf(report)[0];
        if (sent && !allText(sent).includes(MARKERS.noMatch)) problems.push(`${subject}: the sent request does not contain ${MARKERS.noMatch}, so "unchanged" cannot be read from it`);
        details.noMatchReason = details.noMatchReason ?? 'The no-match token appears in the typed turn and in NO rule findRegex, and the leg asserts the same string reaches the provider request untouched on both surfaces -- the reason it is unchanged is that no rule matches it, which the leg can state because it declares every rule body it planted';
    }
    return problems;
});

// ===================================================================================================
// CASE 6. JAVASCRIPT SUBSTITUTION SEMANTICS. The expected string is the PINNED LEG's own product output;
// GoTavern must produce the same string AND send it. Nothing here computes what `$&`, `$$`, `$1`, `$<name>`
// or a lookbehind means: if this repository's expectation were derived, it would be a second opinion about
// JavaScript regex, and the oracle is the browser.
// ===================================================================================================
guard('case6_jsSubstitutionMatchesTheBrowsersOwnAnswer', () => {
    const problems = [];
    const pinnedSide = legs.baseline.pinned?.sides?.js ?? null;
    const goSide = legs.baseline.gotavern?.sides?.js ?? null;
    if (!pinnedSide || !goSide) {
        problems.push('the JS-semantics side is missing from a leg, so the browser oracle does not exist for this run');
        return problems;
    }
    // THE ORACLE: what the PINNED page produced. It must be a REWRITE (if it is not, the rule never ran and
    // the comparison below would compare two unchanged strings).
    if (pinnedSide.promptChanged !== true) {
        problems.push('the PINNED page did not rewrite the JS-semantics input, so there is no browser oracle to compare against (the rule is inert on the oracle itself)');
        return problems;
    }
    const expected = String(pinnedSide.prompt ?? '');
    details.jsExpectedFromPinnedPage = expected;
    // (1) GoTavern's page must produce the SAME string. This is the whole case: equal answers, from two
    // pages, with the expectation supplied by one of them.
    if (String(goSide.prompt ?? '') !== expected) {
        problems.push(`the two subjects' pages produced DIFFERENT substitutions for the same input and the same rule: pinned ${JSON.stringify(expected)} vs gotavern ${JSON.stringify(goSide.prompt)}`);
    }
    // (2) AND that string must be what reached the provider on each subject.
    for (const subject of ['gotavern', 'pinned']) {
        const report = legs.baseline[subject];
        if (!require(report, subject, "this case", problems)) continue;
        const sent = requestsOf(report)[0];
        if (!sent) {
            problems.push(`${subject}: no request to read the JS-semantics case from`);
            continue;
        }
        const text = allText(sent);
        if (!text.includes(expected)) problems.push(`${subject}: the provider request does not contain the browser's own substitution result ${JSON.stringify(expected)}`);
    }
    details.jsSemantics = {
        input: MARKERS.jsInput,
        rule: { findRegex: '/(?<pre>RXQ_JS_A7)(?=\\s)([a-z]+)/g', replaceString: '[$&|$$|$1|$<pre>]' },
        whyItMatters: 'a lookbehind, the g flag, `$&`, `$$`, `$1` and `$<name>` are all JavaScript semantics that a Go RE2 substitution does not share; this string is the browser\'s answer, and Go RE2 was never consulted',
    };
    return problems;
});

// ===================================================================================================
// CASE 7. RE-PROCESSING AND WRITE-BACK. Both answers come from the legs' own observations; this guard
// asserts the OBSERVABLE THAT THE PINNED SOURCE PRODUCES, and the artefact states which is which.
// ===================================================================================================
guard('case7_rawChatKeepsStoredTextAndDisplayIsNotWrittenBack', () => {
    const problems = [];
    for (const subject of ['gotavern', 'pinned']) {
        const report = legs.baseline[subject];
        if (!require(report, subject, "this case", problems)) continue;
        const observed = report.case7 ?? null;
        if (!observed) {
            problems.push(`${subject}: case 7 was not observed`);
            continue;
        }
        // (b) NOTHING WRITES THE DISPLAY BACK INTO THE RAW CHAT.
        if (observed.mesUnchangedByRendering !== true) problems.push(`${subject}: rendering changed a stored message's mes, so display text IS written back into the raw chat`);
        if (observed.firstTurnChangedByRendering === true) {
            problems.push(`${subject}: rendering the greeting changed it (${JSON.stringify(observed.firstTurnChange)}); pinned substitutes macros into chat[0] at script.js:1805-1812, and this scenario must not be exercising that branch or the case 7 answer is about a different mechanism`);
        }
        // (a) RE-PROCESSING IS REAL, AND ITS TEXT CONSEQUENCE IS RECORDED. The two are separate facts:
        // the rule runs again on every assembly, and whether the text moves depends on the replacement.
        const again = observed.secondApplicationOutput;
        if (again === undefined) problems.push(`${subject}: case 7 did not record the second application's output`);
        const expectedSecondApplication = String(report.sides?.active?.prompt ?? '');
        if (String(again ?? '') !== expectedSecondApplication) {
            // The second application must be a FIXED POINT of the same call: applying the rule to its own
            // output yields that output, because `RXQ_OUT_A7` contains no `RXQ_IN_A7`. If it moved, the
            // replacement re-feeds the rule and the artefact must say so -- which is `replacementRefeedsOwnRule`.
            if (observed.replacementRefeedsOwnRule !== true) {
                problems.push(`${subject}: the second application changed the text (${JSON.stringify(expectedSecondApplication)} -> ${JSON.stringify(again)}) while the leg reports the replacement does not re-feed its own rule: one of the two observations is wrong`);
            }
        }
        // THE STORED TURNS, READ FROM THE PRODUCT. The typed turn was rewritten by sendMessageAsUser BEFORE
        // it was pushed (script.js:5875-5886), so the chat file holds the rule's output for it -- which is
        // why asserting "the raw chat holds the user's token" would be wrong about pinned. THIS IS THE
        // ASSERTION THAT MAKES THE STORED-VS-ASSEMBLED DISTINCTION MEAN SOMETHING rather than a comment: the
        // typed turn must be stored WITHOUT its own input token and WITH the rule's output.
        const stored = observed.storedTurnsCarryRawText ?? null;
        if (!Array.isArray(stored) || stored.length === 0) {
            problems.push(`${subject}: case 7 recorded no stored turns, so "the typed turn is stored already rewritten" cannot be read`);
        } else {
            // The typed turn is the LAST stored message at the time the kit ran (the send had not happened yet
            // during the pre-send application; the kit's own chat is greeting + previous + typed).
            const typed = stored[stored.length - 1] ?? null;
            if (!typed) {
                problems.push(`${subject}: no typed turn in the stored chat`);
            } else {
                const stillHasInput = (typed.rawInputTokens ?? []).includes(MARKERS.inActive);
                if (stillHasInput) {
                    problems.push(`${subject}: the STORED typed turn still carries its own input token ${MARKERS.inActive}; pinned rewrites BEFORE pushing (script.js:5875-5886), so the stored form must carry the output instead -- a leg asserting the raw token in the chat is asserting the opposite of pinned`);
                }
                if (!(typed.outputTokens ?? []).includes(SIDES.input.marker)) {
                    problems.push(`${subject}: the STORED typed turn lacks ${SIDES.input.marker}; the prefix of the pipeline that stores the rewritten text did not run`);
                }
            }
            // THE GREETING IS THE CONTROL, and it is allowed exactly ONE rule input: the DISPLAY-only token,
            // which is there on purpose so case 2 has a turn the display path can reach. Every OTHER rule's
            // input must be absent from chat[0], or a case could be explained by a rule firing on the wrong
            // turn. Asserting the ALLOWED set (rather than "no input at all") is what makes this falsifiable:
            // an extra token appearing here goes red.
            const greeting = stored[0] ?? null;
            if (!greeting) {
                problems.push(`${subject}: the stored chat has no greeting turn`);
            } else {
                const allowedInGreeting = [MARKERS.inDisplay];
                const unexpected = (greeting.rawInputTokens ?? []).filter(token => !allowedInGreeting.includes(token));
                if (unexpected.length > 0) {
                    problems.push(`${subject}: the greeting stores rule input token(s) ${unexpected.join(', ')} which the scenario keeps out of chat[0]; a rule firing on the wrong turn would then explain a case`);
                }
            }
        }
        if (observed.displayTextMemberPresent === true) {
            problems.push(`${subject}: a message carries extra.display_text after rendering; the pinned render path does not write it (script.js:2036 renders it, :10119-10131 deletes it) -- so the display WAS written back into the message object`);
        }
        details.case7Reason = details.case7Reason ?? 'pinned re-applies the rules to every stored turn on every assembly (script.js:4501-4506) and builds the request from those copies (:4834 -> openai.js:570-580), so old messages ARE re-processed; the rendered text is NOT written back (messageFormatting writes only to the DOM, script.js:1800-1869; extra.display_text is a separate member read at :2036 and deleted at :10119-10131). The TYPED turn is stored already rewritten, because sendMessageAsUser applies USER_INPUT before pushing (:5875-5886) -- so cases 1/3/5 read the ASSEMBLED surface and only case 7 reads the STORED one, where the assertion is the opposite of "the raw token survives"';
        details.storedVersusAssembled = details.storedVersusAssembled ?? {
            storedBy: 'script.js:5875-5886 -- sendMessageAsUser rewrites the typed text and pushes the RESULT into chat',
            assembledBy: 'script.js:4501-4506 -- every stored turn is re-regexed per assembly with depth coreChat.length-index-(isContinue?2:1)',
            requestBuiltFrom: 'script.js:4834 setOpenAIMessages(coreChat) -> openai.js:570-580 -> :5285-5300',
            casesReadingTheStoredSurface: ['case7'],
            casesReadingTheAssembledSurface: ['case1', 'case2', 'case3', 'case4', 'case5', 'case6'],
        };
    }
    return problems;
});

// ===================================================================================================
// CROSS-SUBJECT EQUALITY, per case-relevant surface. Rule 48's first half: Node(X) == Go(X). The comparator
// does not soften this to "similar": the bindings are the raw body digests.
// ===================================================================================================
guard('providerRequestsEqualAcrossSubjects', () => {
    const problems = [];
    for (const [variant, pair] of Object.entries(legs)) {
        if (!pair.gotavern || !pair.pinned) {
            if (!pair.gotavern) require(null, `${variant}/gotavern`, `this comparison`, problems);
            if (!pair.pinned) require(null, `${variant}/pinned`, `this comparison`, problems);
            continue;
        }
        const go = requestsOf(pair.gotavern);
        const node = requestsOf(pair.pinned);
        if (go.length !== node.length) {
            problems.push(`${variant}: GoTavern produced ${go.length} chat/completions request(s) and pinned ${node.length}`);
            continue;
        }
        for (let index = 0; index < go.length; index++) {
            if (go[index].sha256 !== node[index].sha256) {
                problems.push(`${variant}: request #${index} differs (gotavern ${String(go[index].sha256).slice(0, 12)} ${go[index].byteLength} B vs pinned ${String(node[index].sha256).slice(0, 12)} ${node[index].byteLength} B)`);
            }
        }
    }
    return problems;
});

guard('renderedTextIsTheSameOnBothSubjects', () => {
    const problems = [];
    for (const [variant, pair] of Object.entries(legs)) {
        if (!pair.gotavern || !pair.pinned) {
            if (!pair.gotavern) require(null, `${variant}/gotavern`, `this comparison`, problems);
            if (!pair.pinned) require(null, `${variant}/pinned`, `this comparison`, problems);
            continue;
        }
        for (const phase of ['final']) {
            const go = (pair.gotavern.rendered?.[phase] ?? []).map(entry => String(entry.text ?? ''));
            const node = (pair.pinned.rendered?.[phase] ?? []).map(entry => String(entry.text ?? ''));
            if (go.length === 0 || node.length === 0) {
                problems.push(`${variant}: rendered text was not recorded on both subjects (gotavern ${go.length} message(s), pinned ${node.length})`);
                continue;
            }
            if (go.length !== node.length) problems.push(`${variant}: the chat pane holds ${go.length} message(s) on GoTavern and ${node.length} on pinned`);
            const limit = Math.min(go.length, node.length);
            for (let index = 0; index < limit; index++) {
                if (go[index] !== node[index]) {
                    problems.push(`${variant}: rendered message #${index} differs: gotavern ${JSON.stringify(go[index].slice(0, 160))} vs pinned ${JSON.stringify(node[index].slice(0, 160))}`);
                }
            }
        }
    }
    return problems;
});

// ===================================================================================================
// THE HARNESS'S OWN VERDICT (rule 50). If the three variants produced identical captures, this gate fails
// ITSELF rather than reporting a match: the captures then differ for no input and the whole comparison is
// decoration.
// ===================================================================================================
guard('harnessDiscriminates', () => {
    const problems = [];
    for (const subject of ['gotavern', 'pinned']) {
        const baseline = requestsOf(legs.baseline[subject])[0];
        const disabled = requestsOf(legs.disabled[subject])[0];
        const swapped = requestsOf(legs.swapped[subject])[0];
        if (baseline && disabled && baseline.sha256 === disabled.sha256) {
            problems.push(`HARNESS NON-DISCRIMINATING (${subject}): the baseline and the disabled-rewrite captures are identical (${String(baseline.sha256).slice(0, 12)})`);
        }
        if (baseline && swapped && baseline.sha256 === swapped.sha256) {
            problems.push(`HARNESS NON-DISCRIMINATING (${subject}): the baseline and the swap-chain captures are identical (${String(baseline.sha256).slice(0, 12)})`);
        }
    }
    return problems;
});

// ===================================================================================================
// THE ARTEFACT. Named guards, the leg counts, and what is NOT proven -- by name, never by implication.
// ===================================================================================================
const failedGuards = Object.entries(guards).filter(([, ok]) => !ok).map(([name]) => name);

const summarize = entry => (entry ? { path: entry.path, byteLength: entry.byteLength, sha256: entry.sha256, arrived: entry.arrived ?? null } : null);

const artefact = {
    schemaVersion: 1,
    question: 'Does a regex rule really execute on both subjects at the pinned placement, and does its result reach the FINAL provider request -- or deliberately not?',
    pinnedSource: {
        baselineCommit: '06bde939fb1e9c4c8d8641d810f0a916b5bce127',
        entryPoint: 'public/scripts/extensions/regex/engine.js:334-381 getRegexedString(raw, placement, {isMarkdown, isPrompt, isEdit, depth})',
        placementEnum: 'engine.js:281-292 -- MD_DISPLAY 0 (deprecated), USER_INPUT 1, AI_OUTPUT 2, SLASH_COMMAND 3, (4 legacy sendAs), WORLD_INFO 5, REASONING 6',
        scriptPriority: 'engine.js:11-16 and :98-100 -- SCRIPT_TYPES GLOBAL 0, PRESET 2, SCOPED 1 in insertion order, so preset rules run after global rules',
        gates: 'engine.js:342 disabledExtensions/empty/undefined placement; :348-355 markdownOnly&&isMarkdown | promptOnly&&isPrompt | neither-flag&&neither-flag; :356 isEdit&&!runOnEdit; :362-372 minDepth/maxDepth; :374 placement.includes',
        substitution: 'engine.js:419-445 String.prototype.replace with a function replacement; {{match}} -> $0 (:421); $<n> and $<name> resolved by hand (:422-441); trimStrings applied to groups (:438); substituteParams applied to the result (:444)',
        displayCallSite: 'public/script.js:1800-1869 messageFormatting -- the ONLY caller passing isMarkdown:true (:1860-1864), placement chosen at :1833-1848',
        promptCallSite: 'public/script.js:4501-4506 per-turn getRegexedString with {isPrompt:true, depth: coreChat.length-index-(isContinue?2:1)}; :4834 setOpenAIMessages(coreChat); openai.js:570-580 and :5285-5300 build the request from those copies',
        storageCallSite: 'public/script.js:5875-5886 sendMessageAsUser applies USER_INPUT before the message is pushed, so the chat file holds the rewritten text',
        migrations: 'public/scripts/extensions/regex/index.js:1389-1398 (MD_DISPLAY -> markdownOnly+promptOnly) and :1402-1408 (legacy 4 -> SLASH_COMMAND)',
        consent: 'engine.js:114-127 + :166-220 -- preset/character script sets are returned only when the frontend recorded consent; regex/index.js:1327-1345 asks once',
    },
    legs: Object.fromEntries(Object.entries(legs).map(([variant, pair]) => [variant, Object.fromEntries(Object.entries(pair).map(([subject, report]) => [subject, report ? {
        subject: report.subject,
        variant: report.variant,
        rulesInPlay: report.rulesInPlay,
        request: summarize(requestsOf(report)[0] ?? null),
        requestCount: requestsOf(report).length,
        sides: report.sides ? Object.fromEntries(Object.entries(report.sides).map(([name, side]) => [name, {
            displayChanged: side.displayChanged,
            promptChanged: side.promptChanged,
            prompt: side.prompt,
        }])) : null,
        displayOnlyUserTurn: report.displayOnlyUserTurn,
        case7: report.case7 ? {
            mesUnchangedByRendering: report.case7.mesUnchangedByRendering,
            replacementRefeedsOwnRule: report.case7.replacementRefeedsOwnRule,
            secondApplicationChangedText: report.case7.secondApplicationChangedText,
            pinnedAnswer: report.case7.pinnedAnswer,
        } : null,
        renderedFinal: (report.rendered?.final ?? []).map(entry => ({ mesid: entry.mesid, isUser: entry.isUser, text: String(entry.text ?? '').slice(0, 400) })),
    } : null]))])),
    missingLegs,
    guards,
    details,
    failedGuards,
    verdict: failedGuards.length === 0 ? 'match' : 'mismatch',
    notProven: [
        "the committed real presets' OWN regex rules are not covered: preset A carries 0 regex scripts and preset B's 27 rules are desensitised to markers whose findRegex/replaceString mostly do not appear in any triggerable position, so their real semantics are NOT exercised here. What this gate proves is the MECHANISM (engine, placement enum, flags, depth, order, substitution); a synthetic rule set covers it",
        'preset-scoped rules (extensions.regex_scripts read through readPresetExtensionField, engine.js:121-127) are not exercised: the rules used here are the GLOBAL set, which runs through the same engine and call sites but is read from a different array',
        'character-scoped rules (SCRIPT_TYPES.SCOPED) are not exercised, including the consent prompt for them',
        'placement AI_OUTPUT (2) is observed only where it coincides with the prompt call site for assistant turns; a rule that targets ONLY AI_OUTPUT against a generated reply is not asserted',
        'placements SLASH_COMMAND (3), WORLD_INFO (5) and REASONING (6) are not exercised',
        "substituteRegex RAW/ESCAPED (engine.js:397-409) and trimStrings (:457-464) are declared in the rule shape but not varied by this scenario",
        'a real provider (rule 22) and streaming/cancellation are out of scope: the peer captures and answers',
        'the regex extension being DISABLED (extension_settings.disabledExtensions containing "regex") is asserted to be OFF, not exercised as a negative',
    ],
};

process.stdout.write(`${JSON.stringify(artefact, null, 2)}\n`);
if (artefact.verdict !== 'match') {
    console.error(`regex comparison failed: ${failedGuards.join(', ')}`);
    process.exitCode = 1;
}
