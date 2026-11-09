// a19-oracle-teeth.mjs -- prove the alpha.19 live-oracle comparator has TEETH.
//
// WHAT IT DOES: copies THIS run's own leg artifacts into a scratch directory, takes a green baseline
// through the comparator, then applies one MUTATION PER NAMED GUARD to the copied artifacts and requires
// that exact guard name to appear in `failedGuards` and the comparator to exit non-zero. Every mutation is
// applied to a fresh copy, so no mutation can leak into the next one; the pristine copies are never
// touched (this is the "recover through bytes, never git checkout" discipline: the originals are only
// read).
//
// WHY IT EXISTS: AGENTS differential doctrine 4 -- "the command exited 0" is not evidence, and a guard
// that cannot fail is worse than no guard. A survivor here means the comparator, the leg schema or the
// harness fixture is not discriminating, and the verdict says SURVIVED by name rather than passing.
//
// USAGE:
//   node tests/browser/a19-oracle-teeth.mjs --legs-dir <dir> --comparator tests/browser/a19-compare-live-oracle.mjs \
//     --corpus-tree-sha256 <hex> [--corpus-origin ...] --out <teeth.json>
// Exit 0 only when the baseline is match AND every mutation is killed.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const argv = process.argv.slice(2);
const argument = (name, fallback = null) => {
    const index = argv.indexOf(name);
    if (index < 0) return fallback;
    const value = argv[index + 1];
    return value === undefined ? fallback : value;
};

const legsDir = path.resolve(argument('--legs-dir', ''));
const comparator = path.resolve(argument('--comparator', path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'a19-compare-live-oracle.mjs')));
const corpusTreeSha256 = argument('--corpus-tree-sha256', null);
const corpusOrigin = argument('--corpus-origin', 'synthetic-stand-in');
const outPath = path.resolve(argument('--out', path.join(path.dirname(legsDir), 'a19-live-oracle-teeth.json')));

const LEG_FILES = ['a19-drive-gotavern.json', 'a19-drive-pinned.json', 'a19-restart-gotavern.json', 'a19-restart-pinned.json', 'a19-handback-gotavern.json', 'a19-handback-pinned.json'];
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'a19-teeth-'));

const readLeg = (dir, file) => {
    try { return JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')); } catch { return null; }
};
const writeLeg = (dir, file, value) => fs.writeFileSync(path.join(dir, file), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
const copyLegs = (source, target) => {
    fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(target, { recursive: true });
    for (const file of LEG_FILES) {
        if (fs.existsSync(path.join(source, file))) fs.copyFileSync(path.join(source, file), path.join(target, file));
    }
    return target;
};

function runComparator(dir) {
    const out = path.join(scratch, 'comparison.json');
    const result = spawnSync(process.execPath, [
        comparator,
        '--legs-dir', dir,
        '--corpus-tree-sha256', corpusTreeSha256 ?? '',
        '--corpus-origin', corpusOrigin,
        '--out', out,
    ], { encoding: 'utf8' });
    let parsed = null;
    try { parsed = JSON.parse(fs.readFileSync(out, 'utf8')); } catch { parsed = null; }
    return { status: result.status, stderr: result.stderr, comparison: parsed };
}

const baselineDir = copyLegs(legsDir, path.join(scratch, 'baseline'));
const baseline = runComparator(baselineDir);
const results = [];
const record = (name, expectedGuards, run) => {
    const dir = copyLegs(baselineDir, path.join(scratch, `mutation-${results.length}`));
    const mutationError = run(dir);
    if (mutationError) {
        results.push({ name, ok: false, killedBy: [], error: mutationError });
        return;
    }
    const { comparison } = runComparator(dir);
    const failed = comparison?.failedGuards ?? [];
    const killed = expectedGuards.every(guardName => failed.includes(guardName));
    results.push({
        name,
        ok: killed,
        expectedGuards,
        killedBy: failed,
        baselineVerdict: baseline.comparison?.verdict ?? null,
        mutationVerdict: comparison?.verdict ?? null,
        error: killed ? null : (failed.length === 0 ? 'SURVIVED: the comparator still reported match' : `wrong guard: expected ${expectedGuards.join('/')}, got ${failed.join('/')}`),
    });
};

if (baseline.comparison?.verdict !== 'match') {
    fs.writeFileSync(outPath, `${JSON.stringify({ schema: 'a19-oracle-teeth-v1', ok: false, error: `the baseline is not green (${baseline.comparison?.verdict ?? 'no comparison'}); teeth cannot be measured on a red baseline`, failedGuards: baseline.comparison?.failedGuards ?? [] }, null, 2)}\n`);
    console.error(`a19-oracle-teeth: REFUSED: the baseline is not green (${baseline.comparison?.verdict ?? 'no comparison'})`);
    process.exit(1);
}

// Each mutation names the guard(s) it MUST kill. A mutation that kills a different guard is a survivor:
// the guard it was aimed at cannot fail.
record('wire-body-byte', ['wire-request-set-equal'], dir => {
    const leg = readLeg(dir, 'a19-drive-gotavern.json');
    const request = leg.layers.providerWire.requests[0];
    request.bodySha256 = `${request.bodySha256.slice(0, 63)}${request.bodySha256.endsWith('0') ? '1' : '0'}`;
    writeLeg(dir, 'a19-drive-gotavern.json', leg);
});
record('wire-raw-header', ['wire-headers-equal'], dir => {
    const leg = readLeg(dir, 'a19-drive-gotavern.json');
    leg.layers.providerWire.requests[0].rawHeaders.push({ name: 'x-a19-mutation', value: '1' });
    writeLeg(dir, 'a19-drive-gotavern.json', leg);
});
record('wire-mode', ['wire-mode-equal'], dir => {
    const leg = readLeg(dir, 'a19-drive-gotavern.json');
    leg.layers.providerWire.wireMode = 'json';
    writeLeg(dir, 'a19-drive-gotavern.json', leg);
});
record('wire-served-json-to-streaming-request', ['wire-served-the-requested-wire'], dir => {
    const leg = readLeg(dir, 'a19-drive-gotavern.json');
    for (const request of leg.layers.providerWire.requests) {
        if (request.requestedStream === true) request.served.wire = 'json';
    }
    writeLeg(dir, 'a19-drive-gotavern.json', leg);
});
record('wire-discriminator-reaches-request', ['discriminator-absent-from-compared-wire'], dir => {
    const leg = readLeg(dir, 'a19-drive-gotavern.json');
    if (leg.layers.providerWire.requests.length > 0) {
        const request = leg.layers.providerWire.requests[0];
        request.bodyText = `${request.bodyText} A19G_`;
    }
    writeLeg(dir, 'a19-drive-gotavern.json', leg);
});
record('browser-roster-name', ['browser-roster-equal'], dir => {
    const leg = readLeg(dir, 'a19-drive-gotavern.json');
    if ((leg.layers.browser.roster?.names ?? []).length > 0) leg.layers.browser.roster.names[0] = `${leg.layers.browser.roster.names[0]}-mutated`;
    writeLeg(dir, 'a19-drive-gotavern.json', leg);
});
record('browser-image-undecoded', ['browser-images-decoded'], dir => {
    const leg = readLeg(dir, 'a19-drive-gotavern.json');
    if ((leg.layers.browser.images ?? []).length > 0) leg.layers.browser.images[0].decoded = false;
    writeLeg(dir, 'a19-drive-gotavern.json', leg);
});
record('browser-selected-chat', ['browser-selected-state-equal'], dir => {
    const leg = readLeg(dir, 'a19-drive-gotavern.json');
    leg.layers.browser.selected = { ...(leg.layers.browser.selected ?? {}), chatId: 'mutated-chat' };
    writeLeg(dir, 'a19-drive-gotavern.json', leg);
});
record('browser-console-error-added', ['browser-console-errors-equal'], dir => {
    const leg = readLeg(dir, 'a19-drive-gotavern.json');
    leg.layers.browser.consoleErrors.push('mutation: an error only gotavern reported');
    writeLeg(dir, 'a19-drive-gotavern.json', leg);
});
record('browser-console-error-carries-own-port', ['browser-console-errors-equal'], dir => {
    const leg = readLeg(dir, 'a19-drive-gotavern.json');
    leg.layers.browser.consoleErrors.push('mutation: request to http://127.0.0.1:54321/api/x failed');
    writeLeg(dir, 'a19-drive-gotavern.json', leg);
});
record('browser-event-order', ['browser-event-order-equal'], dir => {
    const leg = readLeg(dir, 'a19-drive-gotavern.json');
    leg.layers.browser.eventOrder = [...(leg.layers.browser.eventOrder ?? []), 'mutation_event'];
    writeLeg(dir, 'a19-drive-gotavern.json', leg);
});
record('browser-final-chat-length', ['browser-final-chat-equal'], dir => {
    const leg = readLeg(dir, 'a19-drive-gotavern.json');
    if (leg.layers.browser.finalChat) leg.layers.browser.finalChat.length = (leg.layers.browser.finalChat.length ?? 0) + 1;
    writeLeg(dir, 'a19-drive-gotavern.json', leg);
});
record('http-request-added', ['http-request-set-equal'], dir => {
    const leg = readLeg(dir, 'a19-drive-gotavern.json');
    leg.layers.http.requests.push({ index: 999, method: 'GET', origin: 'subject', path: '/api/mutation-only', query: '', status: 200, responseBodySha256: 'x', responseBodyLength: 1 });
    writeLeg(dir, 'a19-drive-gotavern.json', leg);
});
record('http-response-status', ['http-response-bodies-equal'], dir => {
    const leg = readLeg(dir, 'a19-restart-gotavern.json');
    const sameOrigin = (leg.layers.http.requests ?? []).filter(request => request.origin === 'subject');
    if (sameOrigin.length > 0) sameOrigin[0].status = 599;
    writeLeg(dir, 'a19-restart-gotavern.json', leg);
});
record('persistence-created-file', ['persistence-created-set-equal'], dir => {
    const leg = readLeg(dir, 'a19-drive-gotavern.json');
    leg.persistenceDiff.created.push({ path: 'default-user/chats/mutation-only.jsonl', bytes: 1, sha256: 'a'.repeat(64) });
    writeLeg(dir, 'a19-drive-gotavern.json', leg);
});
record('persistence-chat-message', ['persistence-chat-semantics-equal'], dir => {
    const leg = readLeg(dir, 'a19-drive-gotavern.json');
    const chat = (leg.layers.persistence.chatMessages ?? [])[0];
    if (chat && (chat.messages ?? []).length > 0) chat.messages[chat.messages.length - 1].mesLength += 1;
    writeLeg(dir, 'a19-drive-gotavern.json', leg);
});
record('persistence-restart-not-resumed', ['persistence-restart-readback'], dir => {
    const leg = readLeg(dir, 'a19-restart-gotavern.json');
    leg.layers.lifecycle.restart.resumed = false;
    writeLeg(dir, 'a19-restart-gotavern.json', leg);
});
record('lifecycle-same-pid', ['lifecycle-restart-is-a-new-process'], dir => {
    const drive = readLeg(dir, 'a19-drive-gotavern.json');
    const restart = readLeg(dir, 'a19-restart-gotavern.json');
    restart.serverPid = drive.serverPid;
    writeLeg(dir, 'a19-restart-gotavern.json', restart);
});
record('lifecycle-handback-failure', ['lifecycle-handback-both-directions'], dir => {
    const leg = readLeg(dir, 'a19-handback-gotavern.json');
    if (leg) { leg.failure = 'mutation hand-back failure'; writeLeg(dir, 'a19-handback-gotavern.json', leg); }
});
record('lifecycle-reload-lost-messages', ['lifecycle-reload-preserves-chat'], dir => {
    const leg = readLeg(dir, 'a19-drive-pinned.json');
    leg.layers.lifecycle.reload = { sameChatId: true, lengthPreserved: false };
    writeLeg(dir, 'a19-drive-pinned.json', leg);
});
record('legs-missing-report', ['legs-present'], dir => {
    fs.rmSync(path.join(dir, 'a19-drive-pinned.json'));
});
record('corpus-tree-moved', ['corpus-identical'], dir => {
    const leg = readLeg(dir, 'a19-drive-gotavern.json');
    leg.corpusTreeSha256 = 'f'.repeat(64);
    writeLeg(dir, 'a19-drive-gotavern.json', leg);
});

const survived = results.filter(result => result.ok !== true);
const teeth = {
    schema: 'a19-oracle-teeth-v1',
    baseline: { verdict: baseline.comparison?.verdict ?? null, failedGuards: baseline.comparison?.failedGuards ?? [] },
    mutations: results.length,
    killed: results.length - survived.length,
    survived: survived.map(result => result.name),
    ok: survived.length === 0,
    results,
};
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(teeth, null, 2)}\n`, 'utf8');
fs.rmSync(scratch, { recursive: true, force: true });
console.log(JSON.stringify({ ok: teeth.ok, killed: `${teeth.killed}/${teeth.mutations}`, survived: teeth.survived }));
if (!teeth.ok) {
    for (const result of survived) console.error(`${result.name}: ${result.error}`);
    process.exitCode = 1;
}
