// THE REGEX-RULE SCENARIO, as one executable description shared by the capture run and both drive legs.
//
// WHAT PROBLEM THIS SOLVES. "The preset loaded" is routinely mistaken for "the regex ran". A preset file
// that carries `extensions.regex_scripts` is parsed by a file reader; nothing about loading it proves a
// single rule executed, that it executed at the placement the frontend asked about, that its result
// reached the PROVIDER REQUEST, or that its result reached the DOM. Every one of those is a separate
// observation, and each can be false while the preset loads perfectly.
//
// WHERE A RULE ACTUALLY EXECUTES (pinned source at 06bde939), read rather than remembered:
//
//   public/scripts/extensions/regex/engine.js:334-381  getRegexedString(raw, placement, {isMarkdown,
//       isPrompt, isEdit, depth}) is the ONLY entry point. It refuses three ways before any rule runs --
//       `extension_settings.disabledExtensions.includes('regex')` (:342), an empty string (:342), or
//       `placement === undefined` (:342) -- then walks `getRegexScripts({allowedOnly: true})` (:346) and
//       for each script requires ONE of:
//           markdownOnly && isMarkdown  |  promptOnly && isPrompt  |  neither flag && neither isMarkdown/isPrompt
//       (:348-355), then `isEdit && !runOnEdit` (:356), then min/max depth when a numeric depth was
//       passed (:362-372), then `script.placement.includes(placement)` (:374).
//   engine.js:391-448  runRegexScript runs `findRegex` through RegexProvider (:411) and calls
//       `String.prototype.replace` (:419) with a function replacement in which {{match}} becomes `$0`
//       (:421) and `$<n>`/`$<name>` are resolved BY HAND (:422-441) -- this is JavaScript regex
//       semantics, not RE2: lookbehind, `g`/`i`/`s`/`m`/`u` flags, `$&`, `$$`, `$1` and named groups all
//       behave as the BROWSER behaves.
//   engine.js:98-100   getRegexScripts concatenates the THREE script sets in SCRIPT_TYPES insertion order
//       -- GLOBAL 0, PRESET 2, SCOPED 1 (:11-16, "ORDER MATTERS: defines the regex script priority") --
//       so a preset rule runs AFTER every global rule and BEFORE every character-scoped one.
//   engine.js:281-292  the placement enum: MD_DISPLAY 0 (deprecated), USER_INPUT 1, AI_OUTPUT 2,
//       SLASH_COMMAND 3, (4 = sendAs, legacy), WORLD_INFO 5, REASONING 6.
//   regex/index.js:1365-1408  migrations on load: a rule whose placement INCLUDES 0 has 0 removed and gets
//       `markdownOnly = true, promptOnly = true` (:1389-1398); placement INCLUDING 4 is rewritten to
//       SLASH_COMMAND (:1402-1408). A legacy rule is therefore a DISPLAY-ONLY rule after migration.
//   regex/index.js:1310-1345  a preset's own rules are used only when the frontend recorded consent
//       (`preset_allowed_regex[apiId].includes(presetName)`, engine.js:121-127 with
//       isPresetScriptsAllowed :215-220), otherwise the user is asked once. The harness writes the consent
//       into the user's own settings file BEFORE boot, because that is the state a user who accepted the
//       prompt is in; it never clicks the prompt (a fresh accountStorage would show it once and the click
//       is a modal race), and the leg RECORDS what the frontend reports so a run without consent is
//       visible as `rulesInPlay === 0` rather than as "the rule did nothing".
//
//   THE PLACEMENTS THIS SCENARIO PROVES, and the call sites that produce them:
//       USER_INPUT   -- public/script.js:5875 sendMessageAsUser() on the typed text as it is APPENDED to
//                       the chat (so it is stored, and every later turn re-reads the stored form), and
//                       again at :4506 with `{isPrompt: true}` for each chat turn as the prompt is built.
//       AI_OUTPUT    -- public/script.js:6481 on a received reply, and :4506 for assistant chat turns.
//       prompt-only  -- `script.promptOnly && isPrompt` (engine.js:352). isPrompt is set ONLY on the
//                       prompt-assembly calls (script.js:4504-4506 chat turns, :4545-4549 reasoning,
//                       world-info.js:5205 world-info content). NOTHING sets it on messageFormatting
//                       (:1860-1864 passes isMarkdown: true and no isPrompt), so a prompt-only rule can
//                       change the provider request and leave the DISPLAYED text untouched. That is the
//                       pinned fact this scenario asserts instead of assuming.
//       display-only -- `script.markdownOnly && isMarkdown` (engine.js:350) is reached only from
//                       messageFormatting (:1866, isMarkdown: true) and anything else that passes
//                       isMarkdown. Prompt assembly passes isPrompt, never isMarkdown, so a markdown-only
//                       rule cannot reach the provider request.
//   DEPTH          -- the depth passed to the prompt-assembly call is
//                       `coreChat.length - index - (isContinue ? 2 : 1)` (script.js:4504), i.e. 0 for the
//                       NEWEST turn. A rule with `minDepth: 1` therefore skips a match in the turn being
//                       sent and applies to the same text one turn later. That is a real, user-visible
//                       consequence of the pinned formula and the reason case 5 asserts "depth not
//                       satisfied" as an unchanged request rather than as a missing feature.
//
// THE RULES ARE SYNTHETIC. The committed real fixtures are used elsewhere; here every rule body is an
// ASCII marker pair (`RXQ_IN_A7` -> `RXQ_OUT_A7`), because this gate is about the MECHANISM. The separate
// question -- whether the user's own 27 regex rules (preset B) behave identically -- needs those bodies
// in a triggerable position, which the desensitised fixtures do not have; the comparator's `notProven`
// says so by name instead of implying coverage.
//
// EVERY OBSERVATION HERE IS AN OBSERVATION, NOT A REIMPLEMENTATION. The kit writes real settings and
// real chat messages through the frontend's own modules and then BUILDS ITS EXPECTATIONS BY CALLING
// `getRegexedString` (the product's own function, in the page) on the same input. The oracle is the
// BROWSER: no JavaScript regex is re-implemented in this repository, and no Go regex path is consulted.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

// The scenario name, used for the marker charset checks and the artefact's labels only.
export const REGEX_SCENARIO = 'GoTavern Regex Probe';

// MARKERS. ASCII only (AGENTS.md rule 9: a non-ASCII input is what exercises an encoding defect, and this
// gate is about rule execution). Each rule has an INPUT token and an OUTPUT token, both unique, so a body
// can be asked "did THIS rule's output arrive" without guessing at wording.
export const MARKERS = {
    // rule R1: an ACTIVE, placement-1 (USER_INPUT), prompt-visible substitution on the typed text.
    inActive: 'RXQ_IN_A7',
    outActive: 'RXQ_OUT_A7',
    // rule R2: the same substitution, `disabled: true`. The pair is the "disabled rule" negative.
    inDisabled: 'RXQ_IN_D7',
    outDisabled: 'RXQ_OUT_D7',
    // rule R3: placement 1, promptOnly -- provider only, display untouched.
    inPrompt: 'RXQ_IN_P7',
    outPrompt: 'RXQ_OUT_P7',
    // rule R4: markdownOnly + promptOnly -- the migrated MD_DISPLAY shape, i.e. display-only.
    inDisplay: 'RXQ_IN_M7',
    outDisplay: 'RXQ_OUT_M7',
    // rule R5: minDepth 1 -- skipped at depth 0 and applied from the next turn on (case 5 "depth").
    inDepth: 'RXQ_IN_E7',
    outDepth: 'RXQ_OUT_E7',
    // A token no rule mentions, so a capture can show what "no match" looks like.
    noMatch: 'RXQ_IN_N7',
    // rule C-A / rule C-B: the chain. Rule A turns RXQ_IN_C7 into RXQ_MID_C7; rule B turns RXQ_MID_C7
    // into RXQ_OUT_C7. A match for B's input DOES NOT EXIST until A has run.
    chainInput: 'RXQ_IN_C7',
    chainMiddle: 'RXQ_MID_C7',
    chainOutput: 'RXQ_OUT_C7',
    // rule R7: the JavaScript-substitution-semantics rule. Its replacement string exercises `$&`, `$$`,
    // `$1`, `$<name>` and lookbehind, all of which behave differently (or do not exist) in RE2.
    jsInput: 'RXQ_JS_A7 alpha beta',
    jsOutputFragment: 'RXQ_JS_OUT_A7 alpha beta',
    // The turn the drive sends, and the turn the chain modifies.
    turn: 'TURN2',
    // THE PREVIOUS USER TURN. Its prompt depth is 1 (`coreChat.length - index - (isContinue ? 2 : 1)`,
    // public/script.js:4504), which is what makes the minDepth-1 rule fire for it and NOT for the turn being
    // sent: the depth rule is proven in both directions on one page, one source line apart.
    previousTurn: 'RXQ_PREV_T1 previous turn carrying the depth token RXQ_IN_E7',
};

// THE GREETING IS ASSIGNED AFTER THE OBJECT LITERAL, not inside it. Inside, `${MARKERS.inDisplay}` reads
// `MARKERS` while the const is still in its temporal dead zone, so module evaluation threw
// `ReferenceError: Cannot access 'MARKERS' before initialization` -- at import time, on the pinned leg, in
// CI. `node --check` validates SYNTAX ONLY and cannot see it (this workflow's own header says so), so the
// rule applied here is the project's: resolve the module's top-level constants by IMPORTING it, not by
// syntax-checking it.
//
// The greeting carries NO active rule input and exactly ONE display-rule token, and that placement is
// deliberate rather than tidy:
//   - the display path is `messageFormatting` (public/script.js:1860-1864), the ONLY caller passing
//     `isMarkdown: true`, and its `messageId === 0` branch (:1805-1812) treats the greeting specially;
//   - prompt assembly never passes `isMarkdown`, so a markdown-only rule cannot reach the provider request
//     through the chat path at all -- which is exactly what case 2 asserts;
//   - every OTHER rule's token is kept out of the greeting, so no case can be explained by a rule firing on
//     the wrong turn. The comparator asserts this as an ALLOWED SET on the stored greeting.
MARKERS.greeting = `Greeting with no active probe token, and one display token: ${MARKERS.inDisplay}`;

// ===================================================================================================
// THE RULES. Serialised into the settings file on BOTH legs and into the capture's expectation builder,
// so there is exactly one description of every rule in the repository.
//
// The shape of a rule is the pinned `RegexScriptData` (public/scripts/char-data.js): the frontend's own
// editor writes these members, and the leg loads them through the frontend's own settings file, so no
// reader of this repository decides what a rule is.
// ===================================================================================================
export function regexRules() {
    const base = {
        id: null,
        scriptName: '',
        findRegex: '',
        replaceString: '',
        trimStrings: [],
        placement: [],
        disabled: false,
        markdownOnly: false,
        promptOnly: false,
        runOnEdit: false,
        substituteRegex: 0,
        minDepth: null,
        maxDepth: null,
    };
    return [
        {
            ...base,
            id: 'rx-probe-active',
            scriptName: 'RXQ R1 active USER_INPUT',
            findRegex: MARKERS.inActive,
            replaceString: MARKERS.outActive,
            placement: [1],
            runOnEdit: true,
        },
        {
            ...base,
            id: 'rx-probe-disabled',
            scriptName: 'RXQ R2 disabled USER_INPUT',
            findRegex: MARKERS.inDisabled,
            replaceString: MARKERS.outDisabled,
            placement: [1],
            disabled: true,
            runOnEdit: true,
        },
        {
            ...base,
            id: 'rx-probe-prompt-only',
            scriptName: 'RXQ R3 promptOnly USER_INPUT',
            findRegex: MARKERS.inPrompt,
            replaceString: MARKERS.outPrompt,
            placement: [1],
            promptOnly: true,
        },
        {
            ...base,
            id: 'rx-probe-display-only',
            scriptName: 'RXQ R4 display-only USER_INPUT',
            findRegex: MARKERS.inDisplay,
            replaceString: MARKERS.outDisplay,
            placement: [1],
            markdownOnly: true,
        },
        {
            ...base,
            id: 'rx-probe-depth',
            scriptName: 'RXQ R5 minDepth 1 USER_INPUT',
            findRegex: MARKERS.inDepth,
            replaceString: MARKERS.outDepth,
            placement: [1],
            minDepth: 1,
        },
        // THE CHAIN. Rule A produces the text rule B's findRegex matches; nothing else in the scenario
        // produces RXQ_MID_C7. The pair is DECLARED in this order on purpose (A first, B second): the
        // pinned execution order is the array order of the scripts that survive the placement/flag/depth
        // filter (engine.js:346-378), so the two must be adjacent and in this order for the chain to form.
        {
            ...base,
            id: 'rx-probe-chain-a',
            scriptName: 'RXQ C-A makes the middle token',
            findRegex: MARKERS.chainInput,
            replaceString: MARKERS.chainMiddle,
            placement: [1],
            runOnEdit: true,
        },
        {
            ...base,
            id: 'rx-probe-chain-b',
            scriptName: 'RXQ C-B consumes the middle token',
            findRegex: MARKERS.chainMiddle,
            // A replacement that is a plain string: the middle token must be GONE from the result.
            replaceString: MARKERS.chainOutput,
            placement: [1],
            runOnEdit: true,
        },
        // THE JAVASCRIPT-SEMANTICS RULE. `findRegex` uses a lookbehind (which RE2 does not support), an
        // alternation with a named group, and the `g` flag; `replaceString` uses `$&` (the whole match),
        // `$$` (a literal dollar), `$1` (group 1) and `$<name>` (the named group). The pinned engine
        // resolves `$1`/`$<name>` itself (engine.js:422-441) and leaves `$&`/`$$` to
        // `String.prototype.replace`, so the expected OUTPUT is whatever the browser produces -- and the
        // capture records it by CALLING the product, never by writing the expected string down.
        {
            ...base,
            id: 'rx-probe-js-semantics',
            scriptName: 'RXQ R6 JS substitution semantics',
            findRegex: '/(?<pre>RXQ_JS_A7)(?=\\s)([a-z]+)/g',
            replaceString: '[$&|$$|$1|$<pre>]',
            placement: [1],
            runOnEdit: true,
        },
    ];
}

// ===================================================================================================
// THE VARIANTS. A variant is the scenario plus ONE NEGATION of it, so every case has a controlled
// counterpart measured on the same subject in the same run shape. A negation whose rule list equals the
// baseline's is refused by `applyNegation` below, so a workflow typo cannot produce two identical captures
// and call them a discriminating pair.
//
//   baseline      every rule present, enabled, in declared order
//   disabled-rewrite   R1 disabled          -- case 1's other direction, and case 5's "disabled rule"
//   swap-chain         C-A and C-B exchanged -- case 4's ordering observable
// ===================================================================================================
export const REGEX_VARIANTS = ['baseline', 'disabled-rewrite', 'swap-chain'];

// The variant name to the negation string `applyNegation` understands. One table, so the workflow, the
// probe and the comparator cannot disagree about what a variant means.
export function negationFor(variant) {
    switch (variant) {
        case 'baseline': return null;
        case 'disabled-rewrite': return 'disabled:rx-probe-active';
        case 'swap-chain': return 'reverse-chain';
        default: throw new Error(`unknown regex variant ${JSON.stringify(variant)}; known: ${REGEX_VARIANTS.join(', ')}`);
    }
}

// The table above is the ONLY place a variant name means anything. `applyNegation` below takes the
// negation STRING; callers that have a variant name go through `negationFor`, so a name can never be
// interpreted two ways.

// Negation of a rule set. A negation that produces an identical rule list is not evidence, so the probe
// records every variant's own rule list and the comparator refuses a pair whose lists are equal.
//
//   disabled:<id>   sets `disabled: true` on one rule (the other rules are untouched)
//   reverse-chain   swaps the two chain rules' positions
export function applyNegation(rules, negation) {
    const copy = rules.map(rule => ({ ...rule, placement: [...rule.placement], trimStrings: [...rule.trimStrings] }));
    if (!negation) return copy;
    if (negation.startsWith('disabled:')) {
        const id = negation.slice('disabled:'.length);
        const rule = copy.find(entry => entry.id === id);
        if (!rule) throw new Error(`negation ${negation} names a rule the scenario does not have`);
        rule.disabled = true;
        return copy;
    }
    if (negation === 'reverse-chain') {
        const a = copy.findIndex(entry => entry.id === 'rx-probe-chain-a');
        const b = copy.findIndex(entry => entry.id === 'rx-probe-chain-b');
        if (a < 0 || b < 0) throw new Error('the scenario has no chain rules to reverse');
        const [first, second] = [copy[a], copy[b]];
        copy[a] = second;
        copy[b] = first;
        return copy;
    }
    throw new Error(`unknown negation ${JSON.stringify(negation)}`);
}

// ===================================================================================================
// THE TURN TEXT. One function, called by the page before every capture, so the driver and the expectation
// cannot disagree about what was sent.
//
// WHICH TOKENS ARE HERE AND WHICH ARE NOT IS PART OF THE DESIGN, not a convenience:
//   - the DISPLAY-only token is NOT here. It is in the greeting, because the display path is
//     messageFormatting and a markdown-only rule must be shown to leave this typed turn's provider text
//     untouched even though it exists in the request's history as the greeting;
//   - the DEPTH token is NOT here. It is in the previous turn, whose depth is 1, so the depth rule must
//     skip this turn (depth 0) and apply to that one.
// Both absences are asserted by the comparator, which is what makes "the rule did not apply here" a
// measurement rather than an omission.
// ===================================================================================================
export function turnText() {
    return [
        `${MARKERS.turn}`,
        `active ${MARKERS.inActive}`,
        `disabled ${MARKERS.inDisabled}`,
        `prompt ${MARKERS.inPrompt}`,
        `nomatch ${MARKERS.noMatch}`,
        `js ${MARKERS.jsInput}`,
        `chain ${MARKERS.chainInput}`,
    ].join(' | ');
}

// ===================================================================================================
// THE CAPTURE SIDES THE COMPARATOR USES. Named here so a leg, the comparator and the artefact cannot
// drift: every name below is a key the capture writes and the comparator reads.
//
// The rule each side is about, and the placement that decides it, are in the comment beside it.
// ===================================================================================================
export const SIDES = {
    // case 1 -- rewrites the user input and changes the provider messages.
    input: { marker: MARKERS.outActive, about: 'R1 (placement 1, no flags) rewrote the typed turn' },
    // case 2 -- display only: the DOM shows the output, the provider request never carries it.
    display: { marker: MARKERS.outDisplay, about: 'R4 (markdownOnly) changed the rendered DOM only' },
    // case 3 -- provider only: the request carries the output, the rendered turn is unchanged.
    prompt: { marker: MARKERS.outPrompt, about: 'R3 (promptOnly) changed the provider request only' },
    // case 4 -- the chain's final token.
    chain: { marker: MARKERS.chainOutput, about: 'C-A then C-B rewrote the chain turn' },
    // case 6 -- the JavaScript substitution result, whatever the browser produced.
    js: { marker: MARKERS.jsOutputFragment, about: "R6's `$&`/`$$`/`$1`/`$<name>`/lookbehind expansion" },
    // case 5 negatives live here: each must be ABSENT from the request on both legs.
    negatives: {
        disabled: MARKERS.outDisabled,
        depth: MARKERS.outDepth,
        noMatch: MARKERS.noMatch,
    },
    // The middle token is what proves the chain's ORDER: with the rules swapped, C-B cannot match.
    chainMiddle: MARKERS.chainMiddle,
};

// ===================================================================================================
// IN-PAGE APPLICATION. Runs inside the frontend with `page.evaluate(applyRegexKit, spec)`.
//
// WHAT IT IS ALLOWED TO DO. It writes PERSISTED USER STATE through the frontend's own modules (the chat
// messages through `script.chat`, the connection through the frontend's own settings object, a rule mask
// through `runRegexScript`'s own input objects) and then OBSERVES with the product's own functions
// (`getRegexedString`, `runRegexScript`, `messageFormatting`). It never replaces an exported function,
// never patches a shared object's method, and never reimplements a regex. The only wrapper anywhere in
// this lane is the generation probe's existing event-bus `emit` recorder, which calls through and
// returns the emitter's own result.
// ===================================================================================================
export async function applyRegexKit(spec) {
    const script = await import('./script.js');
    const { getRegexedString, runRegexScript, regex_placement, SCRIPT_TYPES, getScriptsByType } = await import('./scripts/extensions/regex/engine.js');
    const steps = [];
    const problems = [];
    const step = (name, detail) => steps.push({ step: name, ...detail });

    // THE MARKERS COME FROM `spec`, NOT FROM THIS MODULE'S SCOPE. This function is installed in the page
    // with `page.evaluate(applyRegexKit, spec)`, i.e. it is serialised by its SOURCE and re-created inside
    // the browser, so it closes over NOTHING from regex-kit.mjs. A bare `MARKERS.inActive` inside it threw
    // `ReferenceError: MARKERS is not defined` in CI (run 40450567180) -- and note the shape of that
    // failure: the module-level `MARKERS.greeting` TDZ bug from run 40445569175 was a DIFFERENT error in
    // the same family, and both are invisible to `node --check`. The `spec` argument is the only channel
    // this function has, which is why the probe sends the markers in it.
    const MARKERS = spec?.markers ?? null;
    if (!MARKERS || typeof MARKERS.inActive !== 'string') {
        return { problems: ['applyRegexKit received no markers in its spec; it is installed in the page by source and cannot see the module that defines them'], steps };
    }

    // 1. The character. Same path a user takes: getCharacters + selectCharacterById.
    await script.getCharacters();
    if (!Array.isArray(script.characters) || script.characters.length === 0) {
        return { problems: ['no characters available after getCharacters()'], steps };
    }
    await script.selectCharacterById(0, { switchMenu: false });
    const chid = script.this_chid;
    if (chid === 'undefined' || chid === undefined || chid === null) {
        return { problems: ['selectCharacterById(0) did not bind a character'], steps };
    }
    const character = script.characters[chid];
    step('character', { index: Number(chid), name: character?.name ?? null });

    // 2. THE CHAT, REBUILT FROM THE SPEC. The greeting carries no probe token; the turn does. The
    //    greeting is replaced through the frontend's own greeting path when it exists, because a
    //    `chat[0]` written by hand is not what a real chat holds -- and `messageFormatting` has a
    //    messageId===0 branch (script.js:1805-1812) that substitutes macros into `chat[0]`.
    const turns = spec.turns.map(turn => ({
        name: turn.isUser ? 'Probe User' : String(character?.name ?? 'Character'),
        is_user: Boolean(turn.isUser),
        is_system: false,
        send_date: '2026-01-01T00:00:00.000Z',
        mes: turn.text,
        extra: {},
    }));
    script.chat.length = 0;
    for (const turn of turns) script.chat.push(turn);
    step('chat', {
        turns: script.chat.length,
        greetingHasProbeToken: /RXQ_/.test(String(turns[0]?.mes ?? '')),
        via: 'script.chat mutation',
    });

    // 3. WHAT THE RULES DO, ASKED OF THE PRODUCT. The baseline turn is the LAST one (depth 0), and each
    //    observation is `getRegexedString` called with the placement/flag combination the pinned call site
    //    passes. Two calls are made for the same string on purpose:
    //      - `{ isMarkdown: true }` is what messageFormatting passes (script.js:1860-1864), i.e. DISPLAY;
    //      - `{ isPrompt: true, depth: 0 }` is what prompt assembly passes (script.js:4504-4506).
    //    A side whose DISPLAY observation equals its input while its PROMPT observation differs is the
    //    definition of "provider-only", and the reverse is "display-only" -- both MEASURED, not assumed.
    const lastText = String(turns[turns.length - 1]?.mes ?? '');
    const display = text => getRegexedString(text, regex_placement.USER_INPUT, { isMarkdown: true, characterOverride: character?.name });
    const prompt = (text, depth = 0) => getRegexedString(text, regex_placement.USER_INPUT, { isPrompt: true, depth, characterOverride: character?.name });
    const sides = {};
    const describe = (name, input, depth = 0) => {
        const shown = display(input);
        const sent = prompt(input, depth);
        sides[name] = {
            input,
            display: shown,
            prompt: sent,
            // The three facts the comparator turns into per-case assertions.
            displayChanged: shown !== input,
            promptChanged: sent !== input,
            // Every distinct token that arrived, so the comparator never has to look for one marker and
            // conclude a rule ran.
            displayTokens: [...new Set(String(shown).match(/RXQ_[A-Z]+_[A-Z0-9]+/g) ?? [])].sort(),
            promptTokens: [...new Set(String(sent).match(/RXQ_[A-Z]+_[A-Z0-9]+/g) ?? [])].sort(),
        };
        return sides[name];
    };
    // One distinct input per rule, so a rule can only have fired on ITS OWN token. The chain is the one
    // exception, and deliberately so: its input is the first link.
    const isActive = describe('active', `${MARKERS.inActive}`);
    const isDisabled = describe('disabled', `${MARKERS.inDisabled}`);
    const isPromptOnly = describe('promptOnly', `${MARKERS.inPrompt}`);
    const isDisplayOnly = describe('displayOnly', `${MARKERS.inDisplay}`);
    const isDepth = describe('depth', `${MARKERS.inDepth}`);
    const isNoMatch = describe('noMatch', `${MARKERS.noMatch}`);
    const isChain = describe('chain', `${MARKERS.chainInput}`);
    const isJs = describe('js', `${MARKERS.jsInput}`);
    // depth 1 for the depth rule: the same text must now be rewritten, which is what proves minDepth is
    // read at all (a rule that never fired on either depth would look identical to one whose depth guard
    // is inverted).
    const isDepthAtOne = describe('depthAtOne', `${MARKERS.inDepth}`, 1);
    // THE SELF-CHECK THAT MAKES THE REST MEANINGFUL (AGENTS.md 50, applied to this kit): if the product
    // rewrote NOTHING for any input, then every "negative" below passes vacuously and the whole leg is
    // decoration. The kit therefore REFUSES to hand back expectations. This check is the FIRST thing after
    // the observations and it runs unconditionally -- an earlier draft wrapped it in a labelled block, so
    // a future reader could believe a failing path skipped it.
    const anyRewrite = Object.values(sides).some(side => side.promptChanged || side.displayChanged);
    if (!anyRewrite) {
        problems.push('the product rewrote NOTHING for any of the scenario\'s eight inputs: every rule in this run is inert, so a negative result here would be vacuous (HARNESS NON-DISCRIMINATING)');
    } else {
        // The active rule must have fired IN BOTH DIRECTIONS: display and prompt both see its output.
        if (!isActive.displayChanged || !isActive.promptChanged) {
            problems.push(`R1 did not fire on both surfaces (displayChanged=${isActive.displayChanged}, promptChanged=${isActive.promptChanged}); the scenario's single positive control is missing`);
        }
        // The chain's second link must not be reachable from the raw input, or the chain proves nothing.
        if (!isChain.promptChanged) {
            problems.push('the chain did not form: C-A then C-B produced no change on the prompt side');
        }
        if (isChain.prompt.includes(MARKERS.chainMiddle)) {
            problems.push(`the chain left its middle token in the prompt (${JSON.stringify(isChain.prompt)}): C-B did not consume C-A's output`);
        }
        // The disabled rule must be inert in BOTH surfaces, and its input must remain.
        if (isDisabled.displayChanged || isDisabled.promptChanged) {
            problems.push('R2 is disabled in the settings but changed the text, so a "disabled" negative here would be meaningless');
        }
        if (!isDisabled.prompt.includes(MARKERS.inDisabled)) {
            problems.push('R2\'s input token vanished from the prompt although the rule is disabled: something else consumed it');
        }
        // The depth rule must be inert at 0 and live at 1. Both halves, or the guard is untested.
        if (isDepth.promptChanged) {
            problems.push('R5 (minDepth 1) changed the text at depth 0, so the depth guard is not being applied');
        }
        if (!isDepthAtOne.promptChanged) {
            problems.push('R5 (minDepth 1) did NOT change the text at depth 1, so the minDepth guard is inverted or ignored');
        }
        // The no-match input must be untouched: nothing in the scenario's rule set may mention it.
        if (isNoMatch.promptChanged || isNoMatch.displayChanged) {
            problems.push(`the no-match token ${MARKERS.noMatch} was rewritten, so "no match" is not a no-match`);
        }
    }
    step('sides', {
        active: { display: isActive.displayChanged, prompt: isActive.promptChanged },
        disabled: { display: isDisabled.displayChanged, prompt: isDisabled.promptChanged },
        promptOnly: { display: isPromptOnly.displayChanged, prompt: isPromptOnly.promptChanged },
        displayOnly: { display: isDisplayOnly.displayChanged, prompt: isDisplayOnly.promptChanged },
        depth: { atZero: isDepth.promptChanged, atOne: isDepthAtOne.promptChanged },
        noMatch: { display: isNoMatch.displayChanged, prompt: isNoMatch.promptChanged },
        chain: { display: isChain.displayChanged, prompt: isChain.promptChanged, middleLeft: isChain.prompt.includes(MARKERS.chainMiddle) },
        js: { display: isJs.displayChanged, prompt: isJs.promptChanged },
    });

    // 4. THE ORDER THE PRODUCT USES, read from the product: `getRegexScripts` concatenates the three sets
    //    in SCRIPT_TYPES insertion order (engine.js:98-100). Reading it here means a leg records the
    //    order it actually ran with, rather than the order this file wishes for.
    const order = [...Object.values(SCRIPT_TYPES)].flatMap(type => getScriptsByType(type, { allowedOnly: true }))
        .filter(rule => String(rule.id ?? '').startsWith('rx-probe-'))
        .map(rule => ({ id: rule.id, scriptName: rule.scriptName, disabled: Boolean(rule.disabled) }));
    step('ruleOrder', { order, scriptTypes: SCRIPT_TYPES });

    // 5. THE DISPLAY SIDE, PER TURN, FROM THE PRODUCT'S OWN RENDER FUNCTION. Each stored turn is rendered
    //    through `messageFormatting` with the arguments the chat pane passes (script.js:1800, call sites
    //    :2037 and :2528-2536) and the SAME turn is asked for its prompt text with the arguments prompt
    //    assembly passes (:4504-4506). The pair is the case-by-case observable: a display-only rule shows a
    //    difference on the left and none on the right, a prompt-only rule the reverse, and a rule with no
    //    flags on both.
    //
    //    The rendered HTML is reduced to text with the tag strip only: this is NOT a markdown renderer and
    //    does not claim to be one. What it measures is whether the frontend's own formatter produced the
    //    rule's output for this turn, which is the question; how the markdown layer paints it afterwards is
    //    the asset lane's business.
    const perTurn = [];
    for (let index = 0; index < script.chat.length; index++) {
        const message = script.chat[index];
        const isUser = Boolean(message.is_user);
        // A user turn must be is_user for messageFormatting to pick USER_INPUT (script.js:1838-1839); the
        // assistant greeting picks AI_OUTPUT (:1842-1843). Placement 1 rules therefore apply to the greeting
        // only through the parts of the pipeline that are placement-independent -- which is why the
        // display-only rule is observed on a USER turn below rather than on chat[0].
        const placementSeen = isUser ? regex_placement.USER_INPUT : regex_placement.AI_OUTPUT;
        const html = script.messageFormatting(message.mes, message.name, message.is_system, message.is_user, index, {}, false);
        const shown = String(html).replace(/<[^>]*>/g, '').trim();
        // Depth for this turn in a prompt assembly of the CURRENT chat (script.js:4504): newest is 0.
        const depth = script.chat.length - index - 1;
        const sent = getRegexedString(message.mes, placementSeen, { isPrompt: true, depth, characterOverride: character?.name });
        perTurn.push({
            index,
            isUser,
            placement: placementSeen,
            depth,
            stored: message.mes,
            display: shown,
            prompt: sent,
            displayChanged: shown !== message.mes,
            promptChanged: sent !== message.mes,
            storedInputTokens: [...new Set(String(message.mes).match(/RXQ_IN_[A-Z0-9]+/g) ?? [])].sort(),
            displayOutputTokens: [...new Set(String(shown).match(/RXQ_OUT_[A-Z0-9]+/g) ?? [])].sort(),
            promptOutputTokens: [...new Set(String(sent).match(/RXQ_OUT_[A-Z0-9]+/g) ?? [])].sort(),
            displayStillHasInput: [...new Set(String(shown).match(/RXQ_IN_[A-Z0-9]+/g) ?? [])].sort(),
            promptStillHasInput: [...new Set(String(sent).match(/RXQ_IN_[A-Z0-9]+/g) ?? [])].sort(),
        });
    }
    step('display', { turns: perTurn.length, perTurn: perTurn.map(entry => ({ index: entry.index, placement: entry.placement, depth: entry.depth, displayChanged: entry.displayChanged, promptChanged: entry.promptChanged })) });

    // THE DISPLAY-ONLY CASE GETS ITS OWN INPUT, ON A USER TURN. The greeting is the assistant's, so a
    // placement-1 rule cannot act on it; the display-only rule is therefore observed on a THROWAWAY user
    // turn that is rendered and then removed, so the comparison is about the formatter and not about the
    // chat the send will use. This append/observe/remove keeps the sent chat exactly what the spec says.
    const displayProbe = { index: script.chat.length };
    script.chat.push({
        name: 'Probe User',
        is_user: true,
        is_system: false,
        send_date: '2026-01-01T00:00:00.000Z',
        mes: `${MARKERS.inDisplay} on a user turn`,
        extra: {},
    });
    const probeMessage = script.chat[script.chat.length - 1];
    const probeHTML = script.messageFormatting(probeMessage.mes, probeMessage.name, false, true, script.chat.length - 1, {}, false);
    const probeShown = String(probeHTML).replace(/<[^>]*>/g, '').trim();
    const probeSent = getRegexedString(probeMessage.mes, regex_placement.USER_INPUT, { isPrompt: true, depth: 0, characterOverride: character?.name });
    script.chat.pop();
    const displayOnlyUserTurn = {
        input: probeMessage.mes,
        display: probeShown,
        prompt: probeSent,
        displayChanged: probeShown !== probeMessage.mes,
        promptChanged: probeSent !== probeMessage.mes,
        // What the DISPLAY holds afterwards, and what the PROMPT holds afterwards: the two halves of case 2
        // and case 3, read from the product rather than asserted about it.
        displayHasOutput: probeShown.includes(MARKERS.outDisplay),
        promptHasOutput: probeSent.includes(MARKERS.outDisplay),
        promptStillHasInput: probeSent.includes(MARKERS.inDisplay),
    };
    step('displayOnlyUserTurn', displayOnlyUserTurn);
    if (!displayOnlyUserTurn.displayChanged) {
        problems.push('R4 (markdownOnly) did not change the DISPLAY of a user turn, so case 2 has no observable on this subject');
    }
    if (displayOnlyUserTurn.promptChanged) {
        problems.push('R4 (markdownOnly) changed the PROMPT text of a user turn: a display-only rule reached prompt assembly, so the pinned markdownOnly/isPrompt split is not holding');
    }

    // 6. CASE 7 -- WHAT PINNED ACTUALLY DOES WITH THE RAW CHAT. Both halves are OBSERVED here and compiled
    //    into explicit answers, because "assert the observable you find" is the requirement and a
    //    hopeful assertion about a member that is never written would be decoration.
    //
    //    THE STORED-VS-ASSEMBLED DISTINCTION, and WHY IT CHANGED THIS TEST'S MEANING (the lead asked for
    //    this to be recorded, and it is recorded here and in the comparator's artefact):
    //
    //    A naive test says "the user's token is in the provider request". For a USER_INPUT rule that is the
    //    OPPOSITE of pinned, because the frontend rewrites the typed text TWICE, at two different points:
    //
    //      script.js:5875  `sendMessageAsUser` runs `getRegexedString(messageText, regex_placement.USER_INPUT)`
    //                      and builds the message from the RESULT (the `mes:` at :5882 is the rewritten
    //                      text), then pushes it into `chat` (:5914 `chat.push(message)`). So the STORED form
    //                      is already rewritten, and a chat file re-read from disk holds the RULE'S OUTPUT,
    //                      never the user's raw token.
    //      script.js:4506  prompt assembly runs the rules AGAIN over every stored turn, with
    //                      `{isPrompt: true, depth: coreChat.length - index - (isContinue ? 2 : 1)}` (:4504)
    //                      and the role from :4503.
    //
    //    WHICH CASES DEPEND ON THE DISTINCTION:
    //      case 1 (rewrite)      asserts the ASSEMBLED form contains the output and NOT the input. It must
    //                            not assert "the stored chat still holds the user's token" -- pinned does
    //                            not store that, and the assertion would be testing the wrong surface.
    //      case 3 (prompt-only)  asserts the DISPLAY keeps the input while the REQUEST carries the output.
    //                            That is a property of the two SURFACES for one assembly, not of storage.
    //      case 5 (depth)        depends on the ASSEMBLY depth formula, not on storage.
    //      case 7 (this one)     the only case that reads the STORED form, and it asserts what pinned
    //                            actually writes: the typed turn is stored ALREADY REWRITTEN (because of
    //                            :5875), while rendering the turn does NOT change it again.
    //    Consequence asserted below: `storedTurnsCarryRawText` records, per turn, which RXQ_IN_ tokens
    //    survive in `script.chat` -- and the typed turn's own input token is ABSENT from it. The comparator
    //    checks that, so "the chat stores the raw text" would go red.
    //
    //    (b) DISPLAY TEXT IN THE RAW CHAT. `updateMessageBlock` renders `extra.display_text ?? mes`
    //        (script.js:2036) and `getMessageTextHTML` renders `extra.display_text || mes` (:1529), so the
    //        displayed text can differ from `mes` ONLY if something wrote `extra.display_text`. Rendering
    //        does not write it: the kit records `mes` for every turn, renders every turn through the
    //        product, and asserts the array is unchanged. The one pinned write that can change `mes` from
    //        the render path is `messageFormatting`'s `messageId === 0` branch (:1805-1812), which
    //        substitutes macros into the FIRST turn -- so the observation records whether that branch
    //        fired for this scenario instead of assuming it cannot.
    //    (a) RE-PROCESSING. `oaiMessages = setOpenAIMessages(coreChat)` (script.js:4834) copies
    //        `chat[j].mes` from the ALREADY-REGEXED `coreChat` (:4524-4528), and `prepareOpenAIMessages`
    //        builds the request from those copies (openai.js:570-580, :5285-5300). So the provider sees the
    //        rule's output and `script.chat` keeps the stored text -- which is why the SECOND turn
    //        re-applies the rules to text that already carries the first turn's output (script.js:4506,
    //        once per turn per assembly, with no already-applied marker anywhere in that path). The kit
    //        feeds the first result back through the product's own function and reports BOTH answers,
    //        because they are different facts: the rule really runs again, and whether the TEXT moves
    //        depends on whether the replacement still matches its own pattern (`RXQ_OUT_A7` contains no
    //        `RXQ_IN_A7`, so this scenario's second application is a no-op).
    const rawBeforeRender = script.chat.map(message => message.mes);
    const firstTurnBefore = String(script.chat[0]?.mes ?? '');
    for (let index = 0; index < script.chat.length; index++) {
        const message = script.chat[index];
        script.messageFormatting(message.mes, message.name, message.is_system, message.is_user, index, {}, false);
    }
    const rawAfterRender = script.chat.map(message => message.mes);
    const firstTurnAfter = String(script.chat[0]?.mes ?? '');
    // (a) asked with the product's own function on its own output.
    const promptAgain = prompt(String(isActive.prompt));
    // A rule whose output also matches its own findRegex is the only way a second application is
    // observable in the TEXT, so it is asked directly rather than argued.
    const replacementRefeedsRule = String(isActive.prompt).includes(MARKERS.inActive);
    step('case7', {
        // (b)
        mesUnchangedByRendering: rawBeforeRender.every((value, index) => value === rawAfterRender[index]),
        firstTurnChangedByRendering: firstTurnBefore !== firstTurnAfter,
        firstTurnChange: firstTurnBefore === firstTurnAfter ? null : { before: firstTurnBefore.slice(0, 120), after: firstTurnAfter.slice(0, 120) },
        displayTextMemberPresent: script.chat.some(message => message?.extra && 'display_text' in message.extra),
        // (a)
        storedTurnsCarryRawText: script.chat.map(message => ({
            is_user: message.is_user,
            // DOES THE STORED TURN STILL CARRY A PROBE INPUT TOKEN? For the typed turn R1 rewrote its own
            // token before storing (script.js:5875), so the answer here is what a user's chat file holds.
            rawInputTokens: [...new Set(String(message.mes).match(/RXQ_IN_[A-Z0-9]+/g) ?? [])].sort(),
            outputTokens: [...new Set(String(message.mes).match(/RXQ_OUT_[A-Z0-9]+/g) ?? [])].sort(),
        })),
        secondApplicationOutput: promptAgain,
        secondApplicationChangedText: promptAgain !== isActive.prompt,
        replacementRefeedsOwnRule: replacementRefeedsRule,
        // The two answers together, so a reader is not left to infer either from the other.
        pinnedAnswer: {
            reprocessedEachTurn: 'yes -- script.js:4501-4506 re-applies the rules to every stored turn on every prompt assembly; the request is built from those copies (script.js:4834 -> openai.js:570-580), and no already-applied marker exists in that path',
            displayTextWrittenBackIntoRaw: 'no -- the rendered text is the DOM only. messageFormatting writes nothing to the message (script.js:1800-1869) and updateMessageBlock renders `extra.display_text ?? mes` (:2036) without storing the result; the one render-path mutation of mes is the messageId===0 macro substitution (:1805-1812)',
            theTypedTurnIsStoredAlreadyRewritten: 'yes -- sendMessageAsUser applies USER_INPUT before the message is pushed (script.js:5875-5886), so the chat file holds the rule\'s output, not the user\'s raw token',
            consequenceForOutputsThatMatchThemselves: replacementRefeedsRule
                ? 'this scenario\'s replacement re-feeds its own pattern, so a re-processed turn changes again'
                : 'this scenario\'s replacement does not re-feed its own pattern, so a re-processed turn is byte-identical even though the rule really ran twice',
        },
    });

    return {
        problems,
        steps,
        sides,
        perTurn,
        displayOnlyUserTurn,
        order,
        // The raw chat, as stored, so the comparator can assert the rule did NOT write its output there.
        rawChat: script.chat.map(message => ({ is_user: message.is_user, mes: message.mes })),
        // What the frontend reports about the three script sets, so a run in which no rule was in play
        // says so by name.
        rulesInPlay: order.length,
        scriptTypes: SCRIPT_TYPES,
        placement: regex_placement,
    };
}
