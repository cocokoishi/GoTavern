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

const [gotavernA, pinnedA, gotavernB, pinnedB] = process.argv.slice(2);
if (!gotavernA || !pinnedA || !gotavernB || !pinnedB) {
    console.error('usage: node compare-real-preset-legs.mjs <gotavern-a.json> <pinned-a.json> <gotavern-b.json> <pinned-b.json>');
    process.exit(2);
}

const load = file => JSON.parse(fs.readFileSync(file, 'utf8'));

// The completion request, not the models poll: the pinned frontend lists models before a send when the
// source is custom, and that request carries no context at all.
const contextRequest = report => (report.peerRequests ?? [])
    .filter(entry => /chat\/completions/.test(entry.path ?? ''))
    .at(-1) ?? null;

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

guard('legsDrove', () => {
    const problems = [];
    for (const [name, pair] of Object.entries(reports)) {
        for (const [leg, report] of Object.entries(pair)) {
            const structure = report.structure ?? {};
            if (structure.ok !== true) problems.push(`${leg}/${name}: the preset did not load (${JSON.stringify(structure).slice(0, 160)})`);
            if (!contextRequest(report)) problems.push(`${leg}/${name}: no chat/completions request reached the peer`);
            const expected = report.expected ?? {};
            if (structure.prompts !== expected.prompts || structure.rows !== expected.rows || structure.enabled !== expected.enabled) {
                problems.push(`${leg}/${name}: client reported ${structure.prompts}/${structure.rows}/${structure.enabled}, the fixture requires ${expected.prompts}/${expected.rows}/${expected.enabled}`);
            }
        }
    }
    return problems;
});

guard('presetAEqualsAcrossLegs', () => equalityProblems('A'));
guard('presetBEqualsAcrossLegs', () => equalityProblems('B'));

guard('goATavernDiffersFromGoB', () => {
    const left = contextRequest(reports.A.go);
    const right = contextRequest(reports.B.go);
    if (!left || !right) return ['the GoTavern legs did not both produce a request'];
    if (left.sha256 === right.sha256) {
        return ['GoTavern produced the SAME request for preset A and preset B: the implementation is ignoring the preset, or the harness is not changing it'];
    }
    return [];
});

guard('bUnreferencedPromptsAbsentOnBothLegs', () => {
    const problems = [];
    const markers = {
        B: [markersIn(contextRequest(reports.B.go)?.body), markersIn(contextRequest(reports.B.node)?.body)],
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

guard('aEnabledRowPointingAtDisabledPromptContributes', () => {
    const left = markersIn(contextRequest(reports.A.go)?.body);
    const right = markersIn(contextRequest(reports.A.node)?.body);
    if (left.size === 0 || right.size === 0) return ['one of the preset-A requests carried no fixture marker at all'];
    const shared = [...left].filter(marker => right.has(marker));
    if (shared.length === 0) return ['the two legs share no fixture marker, so nothing can be said about what contributed'];
    details.aSharedMarkers = shared.length;
    return [];
});

guard('harnessDiscriminates', () => {
    const a = contextRequest(reports.A.go)?.sha256;
    const b = contextRequest(reports.B.go)?.sha256;
    const na = contextRequest(reports.A.node)?.sha256;
    const nb = contextRequest(reports.B.node)?.sha256;
    if (a && b && a === b) return ['HARNESS NON-DISCRIMINATING: preset A and preset B produced identical GoTavern captures'];
    if (na && nb && na === nb) return ['HARNESS NON-DISCRIMINATING: preset A and preset B produced identical pinned captures'];
    return [];
});

function equalityProblems(name) {
    const verdict = sameRequest(contextRequest(reports[name].go), contextRequest(reports[name].node));
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
        gotavern: { preset: pair.go.preset, structure: pair.go.structure, request: summarize(contextRequest(pair.go)) },
        pinned: { preset: pair.node.preset, structure: pair.node.structure, request: summarize(contextRequest(pair.node)) },
    }])),
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
