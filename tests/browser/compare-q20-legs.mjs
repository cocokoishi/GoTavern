// Q20 COMPARATOR — save / reload / swipe preserve equality (GOAL.md §9).
//
// Reads two leg reports produced by q20-persistence-probe.mjs, one per backend, and decides whether a chat the
// product SAVED is READ BACK by a fresh page, and whether the requests that follow -- a second turn and a swipe on
// the same chat -- are equal on GoTavern and pinned Node.
//
// The guards, and the failure each one is designed to catch:
//   legsPresent            a leg report is missing (named, never an ENOENT stack -- run 40257173478's lesson)
//   legsDrove              every leg step passed and the peer was reached
//   saveWroteTheChat       the file on disk contains the marker the leg sent, on both subjects. A backend that
//                          answered 200 and wrote nothing fails here.
//   reloadReadsTheChat     a FRESH page load has that marker in its in-memory chat, on both subjects. A save that
//                          is not readable back is the failure Q1 cannot see (the bytes can be intact on disk).
//   nodeEqualsGoAfterReload the second turn's provider request is byte-identical across subjects
//   goSwipeDiffersFromGoTurn  the swipe produced a DIFFERENT request from the second turn from the SAME backend,
//                          so the swipe actually extended/shortened the context rather than repeating it
//   nodeEqualsGoAfterSwipe the swipe's provider request is byte-identical across subjects
//
// Usage: node tests/browser/compare-q20-legs.mjs <gotavern.json> <pinned.json>
// Prints the artefact on stdout; exits non-zero unless every guard holds.

import fs from 'node:fs';
import path from 'node:path';

const [gotavernPath, pinnedPath] = process.argv.slice(2);
if (!gotavernPath || !pinnedPath) {
    console.error('usage: node compare-q20-legs.mjs <gotavern-leg.json> <pinned-leg.json>');
    process.exit(2);
}

const missing = [];
const load = file => {
    if (!fs.existsSync(file)) {
        missing.push(path.basename(file));
        return null;
    }
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
        missing.push(`${path.basename(file)} (unreadable: ${error.message})`);
        return null;
    }
};

const reports = { gotavern: load(gotavernPath), pinned: load(pinnedPath) };
const guards = {};
const details = {};

const contextRequests = report => (report?.peerRequests ?? []).filter(entry => /chat\/completions/.test(entry.path ?? ''));
const marker = report => report?.markers?.first ?? null;

function guard(name, run) {
    const problems = run();
    guards[name] = problems.length === 0;
    if (problems.length > 0) details[`${name}Problems`] = problems;
}

guard('legsPresent', () => (missing.length === 0 ? [] : [`leg report(s) missing or unreadable: ${missing.join(', ')}`]));

guard('legsDrove', () => {
    const problems = [];
    for (const [subject, report] of Object.entries(reports)) {
        if (!report) continue;
        for (const entry of report.steps ?? []) {
            if (entry.ok !== true) problems.push(`${subject}: step ${entry.name} failed (${entry.detail ?? 'no detail'})`);
        }
    }
    return problems;
});

guard('saveWroteTheChat', () => {
    const problems = [];
    for (const [subject, report] of Object.entries(reports)) {
        if (!report) continue;
        const want = marker(report);
        const files = report.afterFirstSave ?? [];
        const found = files.some(file => (file.messages ?? []).some(message => String(message?.mes ?? '').includes(want)));
        if (!found) problems.push(`${subject}: no chat file on disk carries ${want} (files: ${files.map(file => `${file.file}:${file.lines}`).join(', ') || 'none'})`);
        details[`${subject}SaveFiles`] = files.map(file => ({ file: file.file, lines: file.lines, sha256: file.sha256.slice(0, 12) }));
    }
    return problems;
});

guard('reloadReadsTheChat', () => {
    const problems = [];
    for (const [subject, report] of Object.entries(reports)) {
        if (!report) continue;
        const reload = report.afterReload ?? {};
        if (reload.carriesMarker !== true) {
            problems.push(`${subject}: a fresh page load did not have ${marker(report)} in its chat (messages=${reload.messages}, chatLength=${reload.chatLength})`);
        }
    }
    return problems;
});

guard('nodeEqualsGoAfterReload', () => {
    const go = contextRequests(reports.gotavern)[0] ?? null;
    const node = contextRequests(reports.pinned)[0] ?? null;
    if (!go || !node) return ['one of the subjects produced no context request for the second turn'];
    details.secondTurn = { gotavern: { sha256: go.sha256.slice(0, 12), byteLength: go.byteLength }, pinned: { sha256: node.sha256.slice(0, 12), byteLength: node.byteLength } };
    if (go.sha256 !== node.sha256) return [`the second turn's request differs: gotavern ${go.sha256.slice(0, 12)} (${go.byteLength} B) vs pinned ${node.sha256.slice(0, 12)} (${node.byteLength} B)`];
    return [];
});

guard('goSwipeDiffersFromGoTurn', () => {
    const first = contextRequests(reports.gotavern)[0] ?? null;
    const swipe = contextRequests(reports.gotavern)[1] ?? null;
    if (!first || !swipe) return [`the GoTavern leg produced ${contextRequests(reports.gotavern).length} context request(s), so turn and swipe cannot be compared`];
    details.swipe = { gotavern: { sha256: swipe.sha256.slice(0, 12), byteLength: swipe.byteLength }, pinned: (contextRequests(reports.pinned)[1] ?? null) ? { sha256: contextRequests(reports.pinned)[1].sha256.slice(0, 12), byteLength: contextRequests(reports.pinned)[1].byteLength } : null };
    if (first.sha256 === swipe.sha256) return ['the swipe produced the SAME request as the second turn, so it did not change the context'];
    return [];
});

guard('nodeEqualsGoAfterSwipe', () => {
    const go = contextRequests(reports.gotavern)[1] ?? null;
    const node = contextRequests(reports.pinned)[1] ?? null;
    if (!go || !node) return ['one of the subjects produced no context request for the swipe'];
    if (go.sha256 !== node.sha256) return [`the swipe's request differs: gotavern ${go.sha256.slice(0, 12)} (${go.byteLength} B) vs pinned ${node.sha256.slice(0, 12)} (${node.byteLength} B)`];
    return [];
});

const failedGuards = Object.entries(guards).filter(([, ok]) => !ok).map(([name]) => name);
const artefact = {
    schemaVersion: 1,
    question: 'Does a chat the product SAVED read back on a fresh page load, and do a second turn and a swipe reach the model with the same context as pinned?',
    guards,
    details,
    missingLegs: missing,
    failedGuards,
    verdict: failedGuards.length === 0 ? 'match' : 'mismatch',
    notCompared: [
        'a real provider (rule 22): the peer is a simulated backend that captures and answers',
        'the swipe BUTTON wiring: the swipe is a generation on the existing chat through the same entry the preset leg uses',
        'group chats, branch/checkpoint, message editing and deletion',
        'streaming (Q19)',
    ],
};

process.stdout.write(`${JSON.stringify(artefact, null, 2)}\n`);
if (artefact.verdict !== 'match') {
    console.error(`Q20 comparison failed: ${failedGuards.join(', ')}`);
    process.exitCode = 1;
}
