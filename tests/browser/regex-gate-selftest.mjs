// DOES THE REGEX GATE HAVE TEETH? Mutate the recorded legs and require the comparator to go RED at a
// NAMED guard, then require it to be GREEN on the untouched legs.
//
// WHY THIS FILE EXISTS (AGENTS 4, and the differential doctrine's "every gate has teeth, and the teeth are
// demonstrated"): a comparator whose failure has never been observed is a gate nobody can trust, and this
// repository has shipped greens whose assertions could not fail. Two properties are demonstrated here, in
// this order:
//
//   1. GREEN FIRST, ON THE REAL LEGS. If the untouched legs do not produce a `match` verdict, then every
//      red below is meaningless -- a comparator that fails on everything also "catches" every mutation.
//      So the unmutated run is asserted to be green before any mutation is applied.
//   2. EACH MUTATION DIES AT A NAMED GUARD. Every mutation below deletes or corrupts ONE observation that
//      a specific case depends on, and the self-test requires that case's own guard to be the one that went
//      red -- not merely "the verdict is mismatch". A mutation that goes red at a DIFFERENT guard than the
//      one it targets means the guard it targeted cannot fail, which is the failure this file exists to
//      catch (a mutation surviving, or surviving in the assertion that matters).
//
// THE MUTATIONS, and the guard each must take down:
//
//   drop-baseline-gotavern        remove the whole GoTavern baseline leg
//                                 -> legsPresent AND case1, case2, case3, case5, case7, case6 (an absent
//                                    subject must be a finding in EVERY case that needs it, which is what
//                                    the eleven silent-skip fixes were for; a single guard catching it
//                                    would leave the other cases passing on absent evidence)
//   disable-output                remove the rewrite rule's OUTPUT from the GoTavern baseline request body
//                                 (and re-hash it) -> case1_rewriteReachedTheProviderRequestOnBothSubjects
//   make-disabled-leg-equal       make the disabled-rewrite leg's request byte-identical to the baseline's
//                                 -> case1_disablingTheRuleChangesTheRequestBothSubjectsBothDirections
//                                    (this is the HARNESS NON-DISCRIMINATING path)
//   put-display-output-in-request inject the display-only rule's output into the baseline request body
//                                 -> case2_displayOnlyChangedTheDomAndNotTheProviderRequest
//   show-prompt-output-in-display make the recorded DISPLAY carry the prompt-only rule's output
//                                 -> case3_promptOnlyChangedTheProviderRequestAndNotTheDisplay
//   collapse-the-swap             make the swap-chain leg's request equal to the baseline's
//                                 -> case4_chainFormsInDeclaredOrderAndOrderMatters
//   let-the-depth-rule-fire-at-0  make the depth-0 observation show a change
//                                 -> case5_depthNotSatisfiedIsUnchangedAndDepthSatisfiedApplies
//   change-the-js-answer          change the recorded substitution string on ONE subject
//                                 -> case6_jsSubstitutionMatchesTheBrowsersOwnAnswer
//   write-display-back            set the write-back observation true
//                                 -> case7_rawChatKeepsStoredTextAndDisplayIsNotWrittenBack
//
// A mutation is applied to an IN-MEMORY copy of the leg objects; no leg file and no artefact is written, so
// this cannot corrupt the evidence it is auditing.
//
// Usage:
//   node tests/browser/regex-gate-selftest.mjs <baseline-go> <baseline-pinned> \
//        --disabled-go <json> --disabled-pinned <json> --swapped-go <json> --swapped-pinned <json>

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { MARKERS, SIDES } from './regex-kit.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const comparator = path.join(here, 'compare-regex-legs.mjs');

// --- argument parsing: two positionals, then --name <value> pairs -----------------------------------
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
const [baselineGo, baselinePinned] = positional;
const required = {
    'disabled-go': named['disabled-go'],
    'disabled-pinned': named['disabled-pinned'],
    'swapped-go': named['swapped-go'],
    'swapped-pinned': named['swapped-pinned'],
};
if (!baselineGo || !baselinePinned) {
    console.error('usage: node regex-gate-selftest.mjs <baseline-go.json> <baseline-pinned.json> --disabled-go <json> --disabled-pinned <json> --swapped-go <json> --swapped-pinned <json>');
    process.exit(2);
}

// A MISSING INPUT IS NAMED, NOT AN ENOENT. The parent step already refuses absent legs; this refusal is for
// a self-test run by hand against a directory that does not hold them.
const absent = Object.entries({ 'baseline-go': baselineGo, 'baseline-pinned': baselinePinned, ...required })
    .filter(([, file]) => !file || !fs.existsSync(file))
    .map(([name]) => name);
if (absent.length > 0) {
    console.error(`regex gate self-test: these leg files are missing, so no mutation can be judged against them: ${absent.join(', ')}`);
    process.exit(2);
}

const readJSON = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const clone = value => JSON.parse(JSON.stringify(value));

// A WRITE TO DISK WOULD DEFEAT THE PURPOSE. The comparator is a child process, so the mutated legs are
// written to a scratch directory that is removed afterwards -- never beside the recorded evidence.
const scratch = fs.mkdtempSync(path.join(process.env.TEMP ?? '/tmp', 'regex-selftest-'));

// Rehash: every mutation that touches a provider body must update byteLength/sha256, because the comparator
// compares BYTES. Without this a mutation would be invisible to the equality guards and would "survive" for
// a reason that has nothing to do with the guard under test.
function rehash(entry) {
    entry.byteLength = Buffer.byteLength(entry.body, 'utf8');
    entry.sha256 = createHash('sha256').update(entry.body).digest('hex');
    return entry;
}

const requestsOf = report => (report?.peerRequests ?? []).filter(entry => /chat\/completions/.test(entry.path ?? ''));
const bodyOfFirst = report => {
    const entry = requestsOf(report)[0];
    return entry ?? null;
};

// --- the mutations ---------------------------------------------------------------------------------
// Each returns a leg map {baseline:{gotavern,pinned}, disabled:{...}, swapped:{...}} with ONE observation
// removed or corrupted, plus the name of the guard that must go red.
function loadLegs() {
    return {
        baseline: { gotavern: readJSON(baselineGo), pinned: readJSON(baselinePinned) },
        disabled: { gotavern: readJSON(required['disabled-go']), pinned: readJSON(required['disabled-pinned']) },
        swapped: { gotavern: readJSON(required['swapped-go']), pinned: readJSON(required['swapped-pinned']) },
    };
}

const MUTATIONS = [
    {
        name: 'drop-baseline-gotavern',
        // An absent subject must be a FINDING in every case that needs it, not a silent skip.
        expectedGuards: ['legsPresent', 'case1_rewriteReachedTheProviderRequestOnBothSubjects', 'case2_displayOnlyChangedTheDomAndNotTheProviderRequest', 'case3_promptOnlyChangedTheProviderRequestAndNotTheDisplay'],
        apply: legs => {
            legs.baseline.gotavern = null;
            return legs;
        },
    },
    {
        name: 'disable-output',
        // Remove the rewrite rule's OUTPUT from the sent body: the case's forward direction must die.
        expectedGuards: ['case1_rewriteReachedTheProviderRequestOnBothSubjects'],
        apply: legs => {
            const entry = bodyOfFirst(legs.baseline.gotavern);
            entry.body = entry.body.split(SIDES.input.marker).join(MARKERS.inActive);
            rehash(entry);
            return legs;
        },
    },
    {
        name: 'make-disabled-leg-equal',
        // The disabled-rewrite leg made byte-identical to the baseline: "disabling changes the request" must
        // die, and it must be reported as HARNESS NON-DISCRIMINATING rather than as a quiet difference.
        expectedGuards: ['case1_disablingTheRuleChangesTheRequestBothSubjectsBothDirections'],
        apply: legs => {
            const entry = bodyOfFirst(legs.disabled.gotavern);
            const baselineEntry = bodyOfFirst(legs.baseline.gotavern);
            entry.body = baselineEntry.body;
            rehash(entry);
            return legs;
        },
    },
    {
        name: 'put-display-output-in-request',
        // A display-only rule's output appearing in the provider request must fail case 2.
        expectedGuards: ['case2_displayOnlyChangedTheDomAndNotTheProviderRequest'],
        apply: legs => {
            const entry = bodyOfFirst(legs.baseline.gotavern);
            const parsed = JSON.parse(entry.body);
            parsed.messages = parsed.messages ?? [];
            parsed.messages.push({ role: 'system', content: `leaked ${SIDES.display.marker}` });
            entry.body = JSON.stringify(parsed);
            rehash(entry);
            return legs;
        },
    },
    {
        name: 'show-prompt-output-in-display',
        // A prompt-only rule's output reaching the DISPLAY must fail case 3.
        expectedGuards: ['case3_promptOnlyChangedTheProviderRequestAndNotTheDisplay'],
        apply: legs => {
            const report = legs.baseline.gotavern;
            report.rendered = report.rendered ?? {};
            report.rendered.final = [...(report.rendered.final ?? []), { mesid: '0', isUser: 'true', text: `leaked ${SIDES.prompt.marker}` }];
            return legs;
        },
    },
    {
        name: 'collapse-the-swap',
        // The swapped chain made equal to the declared order: order-independence must fail case 4.
        expectedGuards: ['case4_chainFormsInDeclaredOrderAndOrderMatters'],
        apply: legs => {
            const entry = bodyOfFirst(legs.swapped.gotavern);
            const baselineEntry = bodyOfFirst(legs.baseline.gotavern);
            entry.body = baselineEntry.body;
            rehash(entry);
            return legs;
        },
    },
    {
        name: 'let-the-depth-rule-fire-at-0',
        // The depth-0 observation made to show a change: the minDepth guard must be visible as failing.
        expectedGuards: ['case5_depthNotSatisfiedIsUnchangedAndDepthSatisfiedApplies'],
        apply: legs => {
            const report = legs.baseline.gotavern;
            report.sides = report.sides ?? {};
            report.sides.depth = { ...(report.sides.depth ?? {}), promptChanged: true };
            return legs;
        },
    },
    {
        name: 'change-the-js-answer',
        // One subject's substitution string changed: the two pages disagree, which is the whole of case 6.
        expectedGuards: ['case6_jsSubstitutionMatchesTheBrowsersOwnAnswer'],
        apply: legs => {
            const report = legs.baseline.gotavern;
            report.sides = report.sides ?? {};
            const js = report.sides.js ?? {};
            report.sides.js = { ...js, prompt: `${String(js.prompt ?? '')} MUTATED` };
            return legs;
        },
    },
    {
        name: 'write-display-back',
        // Rendering reported as having changed the stored message: case 7's write-back half must fail.
        expectedGuards: ['case7_rawChatKeepsStoredTextAndDisplayIsNotWrittenBack'],
        apply: legs => {
            const report = legs.baseline.gotavern;
            report.case7 = { ...(report.case7 ?? {}), mesUnchangedByRendering: false };
            return legs;
        },
    },
    {
        // THE STORED-FORM CASE, which is the one no request-level comparison can see. A subject that
        // applied the rule ONLY at assembly time would have an identical provider request, an identical
        // DOM, and a chat file still holding the user's raw token. This mutation reproduces exactly that
        // subject by rewriting the recorded stored chat back to its pre-rule form.
        name: 'store-the-raw-token',
        expectedGuards: ['case8_storedChatHoldsTheRewrittenTextOnBothSubjects'],
        apply: legs => {
            const report = legs.baseline.gotavern;
            const stored = report.storedChat;
            if (!stored) return legs;
            stored.messages = stored.messages.map(message => {
                if (message.is_user !== true) return message;
                // Put the input token back and remove the output, i.e. the file a "rewrite at assembly
                // only" implementation would have left on disk.
                message.mes = String(message.mes ?? '').split(SIDES.input.marker).join(MARKERS.inActive);
                message.inputTokens = [...new Set(String(message.mes).match(/RXQ_IN_[A-Z0-9]+/g) ?? [])].sort();
                message.outputTokens = [...new Set(String(message.mes).match(/RXQ_OUT_[A-Z0-9]+/g) ?? [])].sort();
                return message;
            });
            return legs;
        },
    },
    {
        // The observation REMOVED rather than corrupted: "we did not look" must not read as "it agreed".
        name: 'skip-the-stored-read',
        expectedGuards: ['case8_storedChatHoldsTheRewrittenTextOnBothSubjects'],
        apply: legs => {
            legs.baseline.gotavern.storedChat = null;
            return legs;
        },
    },
];

// --- run the comparator over a leg map -------------------------------------------------------------
// The comparator reads files, so a mutated map is written to the scratch directory and passed as paths. The
// unmutated control run uses the REAL files, so "green on the real legs" is about the recorded evidence and
// not about a round trip through JSON.stringify.
function runComparator(paths) {
    const args = [comparator, paths.baselineGo, paths.baselinePinned];
    if (paths.disabledGo) args.push('--disabled-go', paths.disabledGo);
    if (paths.disabledPinned) args.push('--disabled-pinned', paths.disabledPinned);
    if (paths.swappedGo) args.push('--swapped-go', paths.swappedGo);
    if (paths.swappedPinned) args.push('--swapped-pinned', paths.swappedPinned);
    const result = spawnSync(process.execPath, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    let verdict = null;
    try {
        verdict = JSON.parse(result.stdout);
    } catch {
        verdict = null;
    }
    return { status: result.status, verdict, stderr: String(result.stderr ?? ''), stdout: String(result.stdout ?? '') };
}

const writeLeg = (name, report) => {
    const file = path.join(scratch, `${name}.json`);
    if (report === null) return file; // the caller passes a path that does not exist for an absent leg
    fs.writeFileSync(file, JSON.stringify(report, null, 2));
    return file;
};

const problems = [];
const outcomes = [];

// ---- 1. GREEN FIRST, ON THE REAL LEGS -------------------------------------------------------------
const control = runComparator({
    baselineGo, baselinePinned,
    disabledGo: required['disabled-go'], disabledPinned: required['disabled-pinned'],
    swappedGo: required['swapped-go'], swappedPinned: required['swapped-pinned'],
});
outcomes.push({ step: 'control-green', verdict: control.verdict?.verdict ?? null, status: control.status, failedGuards: control.verdict?.failedGuards ?? null });
if (!control.verdict) {
    problems.push(`the control run produced no parseable verdict (exit ${control.status}); the comparator is not usable, so no mutation can be judged. stderr: ${control.stderr.slice(0, 400)}`);
} else if (control.verdict.verdict !== 'match') {
    // THIS IS THE MOST IMPORTANT ASSERTION IN THE FILE. If the real legs do not pass, every red below is
    // worthless, because a comparator that fails on everything "catches" every mutation.
    problems.push(`the REAL legs did not produce a match verdict (failed guards: ${(control.verdict.failedGuards ?? []).join(', ')}), so no mutation below can be attributed to the mutation`);
}

// ---- 2. EACH MUTATION DIES AT THE GUARD IT TARGETS ------------------------------------------------
if (control.verdict?.verdict === 'match') {
    for (const mutation of MUTATIONS) {
        const legs = mutation.apply(clone(loadLegs()));
        const paths = {
            baselineGo: writeLeg(`${mutation.name}-baseline-go`, legs.baseline.gotavern),
            baselinePinned: writeLeg(`${mutation.name}-baseline-pinned`, legs.baseline.pinned),
            disabledGo: writeLeg(`${mutation.name}-disabled-go`, legs.disabled.gotavern),
            disabledPinned: writeLeg(`${mutation.name}-disabled-pinned`, legs.disabled.pinned),
            swappedGo: writeLeg(`${mutation.name}-swapped-go`, legs.swapped.gotavern),
            swappedPinned: writeLeg(`${mutation.name}-swapped-pinned`, legs.swapped.pinned),
        };
        const result = runComparator(paths);
        const failed = result.verdict?.failedGuards ?? [];
        const verdict = result.verdict?.verdict ?? null;
        outcomes.push({ mutation: mutation.name, verdict, status: result.status, failedGuards: failed, expected: mutation.expectedGuards });
        if (!result.verdict) {
            problems.push(`${mutation.name}: the comparator produced no parseable verdict (exit ${result.status}); stderr: ${result.stderr.slice(0, 300)}`);
            continue;
        }
        if (verdict === 'match') {
            problems.push(`${mutation.name}: the mutation SURVIVED -- the comparator still reports match, so the guard it targets cannot fail`);
            continue;
        }
        // THE GUARD THAT MATTERS. Going red at some other guard means the targeted one did not notice, which
        // is the "survived in the assertion that matters" case this file exists to catch.
        const missing = mutation.expectedGuards.filter(name => !failed.includes(name));
        if (missing.length > 0) {
            problems.push(`${mutation.name}: the comparator went red, but NOT at ${missing.join(', ')} (it failed: ${failed.join(', ') || 'none'}); the targeted guard cannot fail`);
        }
    }
}

fs.rmSync(scratch, { recursive: true, force: true });


// --- the serialisation check, which must run BEFORE any mutation ------------------------------------
// `page.addScriptTag({ content: fn.toString() })` installs `applyRegexKit` by SOURCE, so it has NO closure.
// A module-level constant referenced inside it is a FREE IDENTIFIER and dies at the `page.evaluate`, after the
// whole leg has booted a server and a browser. Measured in run 40487920106: `PROBE_USER_NAME is not defined`
// at regex-probe.mjs:377, one dispatch after the persona pin introduced it. Two consequences, both applied:
// the name now travels in the SPEC (like `markers`), and this check makes the whole class fail HERE, in the
// self-test, instead of in a recorded run.
const KIT = await import("./regex-kit.mjs");
const serialised = KIT.applyRegexKit.toString().split("\n").map(line => line.replace(/\/\/.*$/, "")).join("\n");
const moduleLevel = [];
for (const [exportedName, exportedValue] of Object.entries(KIT)) {
    if (typeof exportedValue !== "function" && typeof exportedValue !== "object") {
        if (new RegExp(`\\b${exportedName}\\b`).test(serialised)) moduleLevel.push(exportedName);
    }
}
if (moduleLevel.length > 0) {
    problems.push(`applyRegexKit reads ${moduleLevel.join(", ")} from its module scope, but it is installed in the page by SOURCE and cannot see that scope; pass the value through the spec instead (this is the exact failure that killed run 40487920106)`);
} else {
    outcomes.push({ step: "serialisation-carries-no-module-state", ok: true });
    console.log("ok serialisation-carries-no-module-state: applyRegexKit references no module-level constant, so it is installable by source");
}

// --- the report -------------------------------------------------------------------------------------
const report = {
    schemaVersion: 1,
    question: 'Does the regex comparator actually fail when a rule observation is removed, one guard at a time?',
    control: outcomes.find(outcome => outcome.step === 'control-green') ?? null,
    mutations: outcomes.filter(outcome => outcome.mutation),
    problems,
    verdict: problems.length === 0 ? 'teeth-demonstrated' : 'teeth-not-demonstrated',
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (problems.length > 0) {
    console.error(`regex gate self-test FAILED: ${problems.length} problem(s)`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exitCode = 1;
} else {
    console.log(`regex gate self-test: ${report.mutations.length} mutation(s) each died at their named guard, and the real legs are green`);
}
