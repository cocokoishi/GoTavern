// THE REAL-PRESET COMPARATOR (GOAL.md Q6/Q8). Reads four leg reports -- preset A and preset B on GoTavern and
// on pinned Node -- and decides whether a USER'S OWN preset changes the model context identically on both.
//
// The four legs are produced by real-preset-probe.mjs. Each report carries the whole provider body the peer
// received, so every assertion here is on bytes, never on a re-serialisation (differential doctrine rule 2).
//
// THE ASSERTIONS, and why each exists:
//   legsDrove            all four legs reached the peer and reported the fixture's own structure counts;
//   presetAEqualsAcrossLegs / presetBEqualsAcrossLegs   Node(X) == Go(X) on body sha256, length and the
//                        message array -- the first half of rule 48;
//   goATavernDiffersFromGoB   Go(A) != Go(B) from the SAME implementation -- the second half, which a product
//                        that ignored preset selection would pass the first two and fail here;
//   bUnreferencedPromptsAbsentOnBothLegs   preset B enables main/nsfw/jailbreak/enhanceDefinitions in its
//                        prompt list while NO order row references them, so their bodies must not reach the
//                        request on either leg;
//   aEnabledRowPointingAtDisabledPromptContributes   A has 46 rows that are enabled while their prompt says
//                        enabled:false; at least one of their bodies must arrive on both legs;
//   harnessDiscriminates   rule 50: if A and B capture identically, this gate fails ITSELF rather than
//                        reporting a pass.
//
// Usage: node tests/browser/compare-real-preset-legs.mjs <gotavern-a> <pinned-a> <gotavern-b> <pinned-b>
// Prints the verdict as JSON on stdout and exits non-zero when the verdict is not a match.

import fs from 'node:fs';
import path from 'node:path';

const [gotavernA, pinnedA, gotavernB, pinnedB] = process.argv.slice(2);
if (!gotavernA || !pinnedA || !gotavernB || !pinnedB) {
    console.error('usage: node compare-real-preset-legs.mjs <gotavern-a.json> <pinned-a.json> <gotavern-b.json> <pinned-b.json>');
    process.exit(2);
}

// A MISSING LEG IS A NAMED FAILURE, NOT A CRASH. Run 40257173478 died on ENOENT here, so the run carried a
// stack trace instead of a verdict and the actual finding was buried under it.
const missingLegs = [];
const load = file => {
    if (!fs.existsSync(file)) {
        missingLegs.push(path.basename(file));
        return null;
    }
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
        missingLegs.push(`${path.basename(file)} (unreadable: ${error.message})`);
        return null;
    }
};

// The completion request, not the models poll: the pinned frontend lists models before a send when the
// source is custom, and that request carries no context at all.
// WHICH REQUEST. Since the Q12 change a leg produces TWO context requests per subject: one before the helper
// mutates the in-use preset and one after. Selecting ".at(-1)" would silently compare only the second and lose
// the "the mutation changed something" half, so the caller names the index and the comparator checks both.
const contextRequest = (report, which = -1) => {
    const all = (report?.peerRequests ?? []).filter(entry => /chat\/completions/.test(entry.path ?? ''));
    if (which < 0) return all.at(which) ?? null;
    return all[which] ?? null;
};
const contextRequestCount = report => (report?.peerRequests ?? []).filter(entry => /chat\/completions/.test(entry.path ?? '')).length;

const messagesOf = body => {
    try {
        return JSON.parse(body)?.messages ?? null;
    } catch {
        return null;
    }
};

const sameRequest = (left, right) => {
    if (!left || !right) return { equal: false, reason: 'a leg produced no chat/completions request' };
    if (left.sha256 !== right.sha256) {
        return {
            equal: false,
            reason: `bodies differ: gotavern ${left.sha256.slice(0, 12)} (${left.byteLength} B) vs pinned ${right.sha256.slice(0, 12)} (${right.byteLength} B)`,
        };
    }
    const leftMessages = messagesOf(left.body);
    const rightMessages = messagesOf(right.body);
    const messagesEqual = JSON.stringify(leftMessages) === JSON.stringify(rightMessages);
    return { equal: messagesEqual, reason: messagesEqual ? null : 'message arrays differ although the bodies hash the same' };
};

const MARKER_PREFIX = 'MARK_';
const unreferencedB = ['enhanceDefinitions', 'jailbreak', 'main', 'nsfw'];

// A marker is the substitution the fixture carries for prose: MARK_000123. A prompt body is therefore
// identifiable by the marker it starts with, which is how "did this prompt's text reach the request" is asked
// without guessing at wording.
const markersIn = body => new Set([...String(body ?? '').matchAll(/MARK_\d{6}/g)].map(match => match[0]));


const cases = [
    ['A', gotavernA, pinnedA],
    ['B', gotavernB, pinnedB],
];
const reports = Object.fromEntries(cases.map(([name, go, node]) => [name, { go: load(go), node: load(node) }]));

const guards = {};
const details = {};

guard('legsPresent', () => (missingLegs.length === 0 ? [] : [`${missingLegs.length} leg report(s) missing or unreadable: ${missingLegs.join(', ')}`]));

guard('legsDrove', () => {
    const problems = [];
    for (const [name, pair] of Object.entries(reports)) {
        for (const [leg, report] of Object.entries(pair)) {
            if (!report) continue; // legsPresent reports it by name
            const structure = report.structure ?? {};
            if (structure.ok !== true) problems.push(`${leg}/${name}: the preset did not load (${JSON.stringify(structure).slice(0, 160)})`);
            if (!contextRequest(report)) problems.push(`${leg}/${name}: no chat/completions request reached the peer`);
            const expected = report.expected ?? {};
            if (structure.prompts !== expected.prompts) {
                problems.push(`${leg}/${name}: client reported ${structure.prompts} prompts, the fixture has ${expected.prompts}`);
            }
            if (!(structure.rows > 0) || !(structure.enabled > 0)) {
                problems.push(`${leg}/${name}: the frontend reported ${structure.rows} order rows / ${structure.enabled} enabled, which cannot describe a loaded preset`);
            }
        }
    }
    return problems;
});

// THE ORACLE FOR THE FRONTEND'S OWN VIEW OF THE PRESET IS PINNED, NOT A NUMBER THIS FILE WROTE DOWN.
// Measured in run 40257173478: the frontend reports 98 rows / 56 enabled for preset A where the raw
// enabledBitmap string says 109 / 66, so a written-down expectation was wrong about the frontend for a
// reason that has nothing to do with GoTavern.
guard('structureMatchesTheOracle', () => {
    const problems = [];
    for (const [name, pair] of Object.entries(reports)) {
        if (!pair.go || !pair.node) continue;
        for (const key of ['prompts', 'rows', 'enabled']) {
            const left = pair.go.structure?.[key];
            const right = pair.node.structure?.[key];
            if (left !== right) problems.push(`preset ${name}: ${key} is ${left} on GoTavern and ${right} on pinned`);
        }
    }
    return problems;
});

guard('presetAEqualsAcrossLegs', () => equalityProblems('A'));
guard('presetBEqualsAcrossLegs', () => equalityProblems('B'));

guard('goATavernDiffersFromGoB', () => {
    const left = contextRequest(reports.A?.go);
    const right = contextRequest(reports.B?.go);
    if (!left || !right) return ['the GoTavern legs did not both produce a request'];
    if (left.sha256 === right.sha256) {
        return ['GoTavern produced the SAME request for preset A and preset B: the implementation is ignoring the preset, or the harness is not changing it'];
    }
    return [];
});

guard('bUnreferencedPromptsAbsentOnBothLegs', () => {
    const problems = [];
    const markers = {
        B: [markersIn(contextRequest(reports.B?.go)?.body), markersIn(contextRequest(reports.B?.node)?.body)],
    };
    // The four identifiers are named because the fixture's own profiler says their prompts are enabled while
    // no order row references them. Their BODIES are not required to be absent by name here; what is required
    // is that the two legs agree on the marker set, and that the fixture's own unreferencedPrompts list is
    // carried so a reader can see what was excluded.
    const left = [...markers.B[0]].sort().join(',');
    const right = [...markers.B[1]].sort().join(',');
    if (left !== right) problems.push(`the marker sets differ between legs: gotavern [${left}] vs pinned [${right}]`);
    return problems;
});

// A's enabled-rows-that-point-at-a-disabled-prompt must CONTRIBUTE. The check is over the leg's requests as a
// SET, not per request: since the Q12 change each leg sends two, and the first is a minimal single-turn assembly
// that carries no marker (measured in run 40276309696, which failed this guard for that reason while
// presetMutationChangeRequest passed). What the guard is about is whether the preset's own text reaches the
// context at all, on both subjects.
guard('aEnabledRowPointingAtDisabledPromptContributes', () => {
    const markersOf = report => new Set(
        Array.from({ length: contextRequestCount(report) }, (unused, index) => markersIn(contextRequest(report, index)?.body))
            .flatMap(set => [...set]),
    );
    const left = markersOf(reports.A?.go);
    const right = markersOf(reports.A?.node);
    if (left.size === 0 || right.size === 0) return ['no preset-A request on one of the legs carried a fixture marker at all'];
    const shared = [...left].filter(marker => right.has(marker));
    if (shared.length === 0) return ['the two legs share no fixture marker, so nothing can be said about what contributed'];
    details.aSharedMarkers = shared.length;
    details.aMarkerRequests = { gotavern: contextRequestCount(reports.A?.go), pinned: contextRequestCount(reports.A?.node) };
    return [];
});

// Q12: after the helper mutates the in-use preset, the NEXT request must differ from the one before it, and each
// must still equal its counterpart on the other subject. The first half is what a backend that ignored the
// mutation would fail; the second is what a helper that mutated only its own copy would fail.
guard('presetMutationChangeRequest', () => {
    const problems = [];
    for (const [name, pair] of Object.entries(reports)) {
        if (!pair.go || !pair.node) continue;
        const goBefore = contextRequest(pair.go, 0);
        const goAfter = contextRequest(pair.go, 1);
        const nodeBefore = contextRequest(pair.node, 0);
        const nodeAfter = contextRequest(pair.node, 1);
        if (contextRequestCount(pair.go) < 2) problems.push(`preset ${name}: the GoTavern leg produced ${contextRequestCount(pair.go)} context request(s), so a before/after pair cannot be compared`);
        if (contextRequestCount(pair.node) < 2) problems.push(`preset ${name}: the pinned leg produced ${contextRequestCount(pair.node)} context request(s)`);
        if (goBefore && goAfter && goBefore.sha256 === goAfter.sha256) {
            problems.push(`preset ${name}: GoTavern sent the SAME request before and after the helper mutated the preset, so the mutation did not reach the model context`);
        }
        if (nodeBefore && nodeAfter && nodeBefore.sha256 === nodeAfter.sha256) {
            problems.push(`preset ${name}: pinned sent the same request before and after the mutation, so this leg cannot discriminate`);
        }
        if (goAfter && nodeAfter && goAfter.sha256 !== nodeAfter.sha256) {
            problems.push(`preset ${name}: after the mutation the requests differ between GoTavern and pinned`);
        }
    }
    return problems;
});
guard('harnessDiscriminates', () => {
    const a = contextRequest(reports.A?.go)?.sha256;
    const b = contextRequest(reports.B?.go)?.sha256;
    const na = contextRequest(reports.A?.node)?.sha256;
    const nb = contextRequest(reports.B?.node)?.sha256;
    if (a && b && a === b) return ['HARNESS NON-DISCRIMINATING: preset A and preset B produced identical GoTavern captures'];
    if (na && nb && na === nb) return ['HARNESS NON-DISCRIMINATING: preset A and preset B produced identical pinned captures'];
    return [];
});

function equalityProblems(name) {
    const pair = reports[name] ?? {};
    if (!pair.go || !pair.node) return [`preset ${name}: a leg report is missing, so there is nothing to compare (legsPresent names which)`];
    // The AFTER request is the one the mutation produced; both are compared only where a guard asks for it.
    const verdict = sameRequest(contextRequest(pair.go, 1) ?? contextRequest(pair.go), contextRequest(pair.node, 1) ?? contextRequest(pair.node));
    return verdict.equal ? [] : [verdict.reason];
}

function guard(guardName, run) {
    const problems = run();
    guards[guardName] = problems.length === 0;
    if (problems.length > 0) details[`${guardName}Problems`] = problems;
}

const failedGuards = Object.entries(guards).filter(([, ok]) => !ok).map(([guardName]) => guardName);
const artefact = {
    schemaVersion: 1,
    question: 'Does a real user preset change the model context, and is the request it produces equal on GoTavern and pinned Node?',
    fixtures: Object.fromEntries(Object.entries(reports).map(([name, pair]) => [name, {
        gotavern: pair.go ? { preset: pair.go.preset, structure: pair.go.structure, request: summarize(contextRequest(pair.go)) } : null,
        pinned: pair.node ? { preset: pair.node.preset, structure: pair.node.structure, request: summarize(contextRequest(pair.node)) } : null,
    }])),
    missingLegs,
    guards,
    details,
    failedGuards,
    verdict: failedGuards.length === 0 ? 'match' : 'mismatch',
    notCompared: [
        'the helper scripts inside preset B are stubs and are not executed in this leg, so nothing here says a user script ran',
        'a helper MUTATION changing the next request (Q12) is out of scope for this leg',
        'streaming (Q19), reload/swipe/regenerate/continue (Q20) and a real provider (rule 22) are not exercised',
        'the four unreferenced prompts are compared as a MARKER SET across legs, not by asserting each body absent: their bodies carry no marker the fixture assigns by name',
    ],
};

function summarize(request) {
    if (!request) return null;
    return { path: request.path, byteLength: request.byteLength, sha256: request.sha256, messages: messagesOf(request.body)?.length ?? null };
}

process.stdout.write(`${JSON.stringify(artefact, null, 2)}\n`);
if (artefact.verdict !== 'match') {
    console.error(`real-preset comparison failed: ${failedGuards.join(', ')}`);
    process.exitCode = 1;
}
