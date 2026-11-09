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
const record = (name, expectedGuards, run, { survivor = false } = {}) => {
    const dir = copyLegs(baselineDir, path.join(scratch, `mutation-${results.length}`));
    const mutationError = run(dir);
    if (mutationError) {
        results.push({ name, survivor, ok: false, killedBy: [], error: mutationError });
        return;
    }
    const { comparison } = runComparator(dir);
    const failed = comparison?.failedGuards ?? [];
    const guardStatus = Object.fromEntries((comparison?.guards ?? []).map(entry => [entry.name, entry.ok]));
    // A NORMAL mutation must turn each named guard red. A SURVIVOR mutation proves a normalisation is NARROW: the
    // named guard must stay green even though the mutated field changed (and a normalisation must be recorded).
    const ok = survivor
        ? expectedGuards.every(guardName => guardStatus[guardName] === true)
        : expectedGuards.every(guardName => failed.includes(guardName));
    results.push({
        name,
        survivor,
        ok,
        expectedGuards,
        killedBy: failed,
        guardStatus,
        baselineVerdict: baseline.comparison?.verdict ?? null,
        mutationVerdict: comparison?.verdict ?? null,
        error: ok ? null : (survivor
            ? `mutated field was NOT normalised away: expected ${expectedGuards.join('/')} to stay green, got ${JSON.stringify(expectedGuards.map(guardName => [guardName, guardStatus[guardName]]))}`
            : (failed.length === 0 ? 'SURVIVED: the comparator still reported match' : `wrong guard: expected ${expectedGuards.join('/')}, got ${failed.join('/')}`)),
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
record('http-live-egress-etag-differs-survives', ['http-bodies-equal'], dir => {
    // A live third-party passthrough body is not a subject observation, and its byte-derived ETag therefore moves
    // with it; both rules must survive together (and the same mutation on a NON-horde route still reds -- see the
    // body mutations above).
    const leg = readLeg(dir, 'a19-drive-pinned.json');
    const horde = (leg.layers.http.requests ?? []).find(request => String(request.path ?? '').startsWith('/api/horde/') && request.responseHeaders);
    if (horde) {
        horde.responseBodyText = '{"models":[99]}';
        horde.responseBodySha256 = 'f'.repeat(64);
        horde.responseHeaders = { ...horde.responseHeaders, etag: 'W/"mutated-live"' };
    }
    writeLeg(dir, 'a19-drive-pinned.json', leg);
}, { survivor: true });
record('http-tokenizer-body-unread-is-a-harness-error', ['http-bodies-equal'], dir => {
    // An unreadable body must NOT be normalised away: it flows into the comparison as a NAMED harness error and reds.
    // The recorder settles HTTP before navigating, so this state should be unreachable; the tooth proves the red.
    const leg = readLeg(dir, 'a19-drive-gotavern.json');
    const entry = (leg.layers.http.requests ?? []).find(request => String(request.path) === '/api/tokenizers/openai/count');
    if (entry) { entry.responseBodyText = null; entry.responseBodySha256 = null; }
    writeLeg(dir, 'a19-drive-gotavern.json', leg);
});record('http-tokenizer-scheduling-survives', ['http-bodies-equal'], dir => {
    // A tokenizer count request present on only one leg is load-timing (which messages each pass held); the shared
    // identities' counts are still compared by the tokenizer-count-body tooth.
    const leg = readLeg(dir, 'a19-drive-pinned.json');
    leg.layers.http.requests = (leg.layers.http.requests ?? []).filter(request => !(String(request.path) === '/api/tokenizers/openai/count' && String(request.query ?? '').includes('model=')));
    writeLeg(dir, 'a19-drive-pinned.json', leg);
}, { survivor: true });
record('http-char-list-chat-size-survives', ['http-bodies-equal'], dir => {
    // chat_size is derived from the chat JSONL, whose wall-clock members have variable digit counts; the chat
    // semantics are compared separately, so a size-only change survives.
    const leg = readLeg(dir, 'a19-drive-gotavern.json');
    const entry = (leg.layers.http.requests ?? []).find(request => request.path === '/api/characters/all' && typeof request.responseBodyText === 'string');
    if (entry) {
        const body = JSON.parse(entry.responseBodyText);
        body[0].chat_size = (body[0].chat_size ?? 0) + 2;
        entry.responseBodyText = JSON.stringify(body);
        entry.responseBodySha256 = 'e'.repeat(64);
    }
    writeLeg(dir, 'a19-drive-gotavern.json', leg);
}, { survivor: true });
record('persistence-chat-text-changed', ['persistence-chat-semantics-equal'], dir => {
    const leg = readLeg(dir, 'a19-drive-gotavern.json');
    const chat = (leg.layers.persistence.chatMessages ?? [])[0];
    if (chat && chat.messages && chat.messages.length > 0) chat.messages[0].mesSha256Stripped = 'f'.repeat(64);
    writeLeg(dir, 'a19-drive-gotavern.json', leg);
});record('http-tokenizer-exactness-headers-survives', ['http-bodies-equal'], dir => {
    // The two RECORDED GoTavern-only headers may differ when pinned lacks them (the decision removes only those).
    const leg = readLeg(dir, 'a19-drive-gotavern.json');
    const entry = (leg.layers.http.requests ?? []).find(request => request.path === '/api/tokenizers/openai/count');
    if (entry) entry.responseHeaders = { ...(entry.responseHeaders ?? {}), 'x-gotavern-tokenizer-exact': 'true', 'x-gotavern-tokenizer-layout': 'src/tokenizers' };
    writeLeg(dir, 'a19-drive-gotavern.json', leg);
}, { survivor: true });
record('http-tokenizer-exactness-on-pinned', ['http-bodies-equal'], dir => {
    // The delta is one-directional: pinned must NEVER carry these (if it does, it is a product difference).
    const leg = readLeg(dir, 'a19-drive-pinned.json');
    const entry = (leg.layers.http.requests ?? []).find(request => request.path === '/api/tokenizers/openai/count');
    if (entry) entry.responseHeaders = { ...(entry.responseHeaders ?? {}), 'x-gotavern-tokenizer-exact': 'true' };
    writeLeg(dir, 'a19-drive-pinned.json', leg);
});
record('http-other-gotavern-only-header', ['http-bodies-equal'], dir => {
    // "GoTavern-only headers are fine" is NOT a general rule: any OTHER name still reds.
    const leg = readLeg(dir, 'a19-drive-gotavern.json');
    const entry = (leg.layers.http.requests ?? []).find(request => request.path === '/api/tokenizers/openai/count');
    if (entry) entry.responseHeaders = { ...(entry.responseHeaders ?? {}), 'x-gotavern-something-else': 'true' };
    writeLeg(dir, 'a19-drive-gotavern.json', leg);
});record('browser-event-causal-order', ['browser-event-order-equal'], dir => {
    // The claim is the causal ordering inside one generation lifecycle: moving message_sent AFTER generation_ended
    // must red (GENERATION_STARTED precedes MESSAGE_SENT on both subjects; see a19-compare-live-oracle.mjs).
    const leg = readLeg(dir, 'a19-drive-gotavern.json');
    const order = (leg.layers.browser.eventOrder ?? []).filter(name => name !== 'message_sent');
    const endIndex = order.indexOf('generation_ended');
    order.splice(endIndex < 0 ? order.length : endIndex + 1, 0, 'message_sent');
    leg.layers.browser.eventOrder = order;
    writeLeg(dir, 'a19-drive-gotavern.json', leg);
});
record('browser-event-core-missing', ['browser-event-order-equal'], dir => {
    const leg = readLeg(dir, 'a19-drive-gotavern.json');
    leg.layers.browser.eventOrder = (leg.layers.browser.eventOrder ?? []).filter(name => name !== 'chat_completion_prompt_ready');
    writeLeg(dir, 'a19-drive-gotavern.json', leg);
});
record('http-char-list-content', ['http-bodies-equal'], dir => {
    // characters/all date_added is a route-scoped run clock (the journey edits one card); a NON-clock member of the
    // same response must still red.
    const leg = readLeg(dir, 'a19-drive-gotavern.json');
    const entry = (leg.layers.http.requests ?? []).find(request => request.path === '/api/characters/all' && typeof request.responseBodyText === 'string');
    if (entry) {
        const body = JSON.parse(entry.responseBodyText);
        body[0].name = 'mutated-character-name';
        entry.responseBodyText = JSON.stringify(body);
        entry.responseBodySha256 = 'e'.repeat(64);
    }
    writeLeg(dir, 'a19-drive-gotavern.json', leg);
});
record('http-char-list-run-clock-survives', ['http-bodies-equal'], dir => {
    // The edited card's mtime-derived date_added IS the leg clock (measured 239 s apart in the release run), so a
    // changed whole-millisecond timestamp on this route survives; the identity pairing and every other field remain
    // compared.
    const leg = readLeg(dir, 'a19-drive-gotavern.json');
    const entry = (leg.layers.http.requests ?? []).find(request => request.path === '/api/characters/all' && typeof request.responseBodyText === 'string');
    if (entry) {
        const body = JSON.parse(entry.responseBodyText);
        body[0].date_added = body[0].date_added + 1000;
        entry.responseBodyText = JSON.stringify(body);
        entry.responseBodySha256 = 'e'.repeat(64);
    }
    writeLeg(dir, 'a19-drive-gotavern.json', leg);
}, { survivor: true });
record('http-char-list-submillisecond-survives', ['http-bodies-equal'], dir => {
    const leg = readLeg(dir, 'a19-drive-gotavern.json');
    const entry = (leg.layers.http.requests ?? []).find(request => request.path === '/api/characters/all' && typeof request.responseBodyText === 'string');
    if (entry) {
        const body = JSON.parse(entry.responseBodyText);
        // +0.5 ms is representable in float64 at this magnitude (0.9999 rounds UP to the next integer).
        body[0].date_added = Math.floor(body[0].date_added) + 0.5;
        entry.responseBodyText = JSON.stringify(body);
        entry.responseBodySha256 = 'd'.repeat(64);
    }
    writeLeg(dir, 'a19-drive-gotavern.json', leg);
}, { survivor: true });
record('http-autosave-request-body-survives', ['http-bodies-equal'], dir => {
    const leg = readLeg(dir, 'a19-drive-gotavern.json');
    const entry = (leg.layers.http.requests ?? []).find(request => request.path === '/api/settings/save');
    if (entry) { entry.requestBodyText = '{"power_user":{"persona_descriptions":{"y":{"depth":9}}}}'; entry.requestBodySha256 = 'c'.repeat(64); }
    writeLeg(dir, 'a19-drive-gotavern.json', leg);
}, { survivor: true });
record('http-tokenizer-count-body', ['http-bodies-equal'], dir => {
    const leg = readLeg(dir, 'a19-drive-gotavern.json');
    const entry = (leg.layers.http.requests ?? []).find(request => request.path === '/api/tokenizers/openai/count');
    if (entry) { entry.responseBodyText = '{"token_count":10}'; entry.responseBodySha256 = 'b'.repeat(64); }
    writeLeg(dir, 'a19-drive-gotavern.json', leg);
});record('browser-event-unrelated-addition-survives', ['browser-event-order-equal'], dir => {
    // An EXTRA unrelated event does not violate the claim (core set + causal ordering); it must survive, which is
    // what makes the claim falsifiable by ordering rather than by "the streams are not equal".
    const leg = readLeg(dir, 'a19-drive-gotavern.json');
    leg.layers.browser.eventOrder = ['mutation_event', ...(leg.layers.browser.eventOrder ?? [])];
    writeLeg(dir, 'a19-drive-gotavern.json', leg);
}, { survivor: true });
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
record('http-response-status', ['http-bodies-equal'], dir => {
    const leg = readLeg(dir, 'a19-restart-gotavern.json');
    const sameOrigin = (leg.layers.http.requests ?? []).filter(request => request.origin === 'subject');
    if (sameOrigin.length > 0) sameOrigin[0].status = 599;
    writeLeg(dir, 'a19-restart-gotavern.json', leg);
});
record('http-request-body', ['http-bodies-equal'], dir => {
    // A BODY VALUE change, not whitespace: JSON parsing tolerates added whitespace, so a whitespace-only mutation
    // would survive for the wrong reason (the projection would be unchanged). Adding a member changes the projected
    // digest and must red.
    const leg = readLeg(dir, 'a19-drive-gotavern.json');
    const sameOrigin = (leg.layers.http.requests ?? []).filter(request => request.origin === 'subject');
    const withBody = sameOrigin.find(request => typeof request.requestBodyText === 'string') ?? sameOrigin[0];
    if (withBody) {
        try { const parsed = JSON.parse(withBody.requestBodyText); parsed.a19Mutation = true; withBody.requestBodyText = JSON.stringify(parsed); }
        catch { withBody.requestBodyText = `${withBody.requestBodyText ?? ''}x`; }
    }
    writeLeg(dir, 'a19-drive-gotavern.json', leg);
});
record('http-compared-header', ['http-bodies-equal'], dir => {
    const leg = readLeg(dir, 'a19-drive-gotavern.json');
    const sameOrigin = (leg.layers.http.requests ?? []).filter(request => request.origin === 'subject');
    if (sameOrigin.length > 0) {
        sameOrigin[0].requestHeaders = { ...(sameOrigin[0].requestHeaders ?? {}), 'content-type': 'application/x-mutation' };
    }
    writeLeg(dir, 'a19-drive-gotavern.json', leg);
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
record('wire-accept-encoding-value-survives', ['wire-headers-equal'], dir => {
    // The ONE named value delta: Go advertises gzip, node-fetch advertised gzip, deflate, br. This mutation puts
    // the captured value on the GoTavern leg and the guard must STAY GREEN (the normalisation is narrow).
    const leg = readLeg(dir, 'a19-drive-gotavern.json');
    for (const header of leg.layers.providerWire.requests[0].rawHeaders) {
        if (String(header.name).toLowerCase() === 'accept-encoding') header.value = 'gzip, deflate, br';
    }
    writeLeg(dir, 'a19-drive-gotavern.json', leg);
}, { survivor: true });
record('wire-compared-header-value', ['wire-headers-equal'], dir => {
    const leg = readLeg(dir, 'a19-drive-gotavern.json');
    for (const header of leg.layers.providerWire.requests[0].rawHeaders) {
        if (String(header.name).toLowerCase() === 'authorization') header.value = 'Bearer mutation-token';
    }
    writeLeg(dir, 'a19-drive-gotavern.json', leg);
});
record('wire-header-name-removed', ['wire-headers-equal'], dir => {
    const leg = readLeg(dir, 'a19-drive-gotavern.json');
    leg.layers.providerWire.requests[0].rawHeaders = leg.layers.providerWire.requests[0].rawHeaders.filter(header => String(header.name).toLowerCase() !== 'content-type');
    writeLeg(dir, 'a19-drive-gotavern.json', leg);
});
record('http-duplicate-get-survives', ['http-request-set-equal', 'http-bodies-equal'], dir => {
    // Duplicate idempotent GETs are browser scheduling (the token-count cache race). The guard must stay green and
    // the normalisation must be recorded; a UNIQUE extra GET is separately required to red (http-request-added).
    const leg = readLeg(dir, 'a19-drive-gotavern.json');
    const get = leg.layers.http.requests.find(request => request.method === 'GET');
    if (get) leg.layers.http.requests.push({ ...get, index: 999 });
    writeLeg(dir, 'a19-drive-gotavern.json', leg);
}, { survivor: true });
record('http-post-multiplicity', ['http-request-set-equal'], dir => {
    // A WRITE route's multiplicity must stay exact; `/api/worldinfo/get` is a named read-only route and is covered
    // by `http-readonly-multiplicity`, so the mutation targets the chat save.
    const leg = readLeg(dir, 'a19-drive-gotavern.json');
    const post = leg.layers.http.requests.find(request => request.method === 'POST' && request.path === '/api/chats/save');
    if (post) leg.layers.http.requests.push({ ...post, index: 998 });
    writeLeg(dir, 'a19-drive-gotavern.json', leg);
});

record('http-static-body-changed', ['http-bodies-equal'], dir => {
    const leg = readLeg(dir, 'a19-drive-gotavern.json');
    const get = leg.layers.http.requests.find(request => request.method === 'GET');
    if (get) get.responseBodySha256 = 'f'.repeat(64);
    writeLeg(dir, 'a19-drive-gotavern.json', leg);
});
record('http-static-revalidation-status-survives', ['http-bodies-equal'], dir => {
    // The RECORDED static divergence: pinned answers a conditional 304 where the embedded-asset install answers 200
    // for the same stored resource. The guard must accept the 200/304 pair and record the decision.
    const leg = readLeg(dir, 'a19-drive-pinned.json');
    const get = leg.layers.http.requests.find(request => request.method === 'GET');
    if (get) { get.status = 304; get.responseBodySha256 = null; get.responseBodyText = null; }
    writeLeg(dir, 'a19-drive-pinned.json', leg);
}, { survivor: true });
record('persistence-image-metadata-timestamp-survives', ['persistence-changed-content-equal'], dir => {
    // PINNED-RUNS-TWICE evidence (self-check run 1 vs run 2) shows addedTimestamp is nondeterministic within pinned, so
    // its mutation must SURVIVE; the file's pointers are still compared.
    const leg = readLeg(dir, 'a19-drive-gotavern.json');
    const metadata = (leg.layers.persistence.jsonFiles ?? []).find(file => file.path === 'default-user/image-metadata.json');
    if (metadata) metadata.text = metadata.text.replace('"addedTimestamp":111', '"addedTimestamp":999');
    writeLeg(dir, 'a19-drive-gotavern.json', leg);
}, { survivor: true });
record('persistence-image-metadata-added-image', ['persistence-changed-content-equal'], dir => {
    const leg = readLeg(dir, 'a19-drive-gotavern.json');
    const metadata = (leg.layers.persistence.jsonFiles ?? []).find(file => file.path === 'default-user/image-metadata.json');
    if (metadata) metadata.text = metadata.text.replace('"folders":[]', '"folders":[],"mutation":true');
    writeLeg(dir, 'a19-drive-gotavern.json', leg);
});
record('persistence-final-setting-value', ['persistence-changed-content-equal'], dir => {
    const leg = readLeg(dir, 'a19-drive-gotavern.json');
    const settings = (leg.layers.persistence.jsonFiles ?? []).find(file => file.path === 'default-user/settings.json');
    if (settings) settings.text = settings.text.replace('"depth":4', '"depth":5');
    writeLeg(dir, 'a19-drive-gotavern.json', leg);
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
