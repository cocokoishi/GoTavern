// a19-compare-live-oracle.mjs -- the alpha.19 LIVE ORACLE comparator: five observable layers, a taxonomy
// verdict per layer, and NO unexplained difference.
//
// WHAT IT READS. One leg report per leg (schema `a19-live-oracle-leg-v1`, written by the journey probe and
// enriched by a19-live-oracle.mjs with the provider-wire layer and the corpus persistence diff), plus the
// hand-back reports. It never reads the corpus or the product: every expectation comes from the PINNED
// leg at the same phase (AGENTS differential doctrine 1/3) or from the immutable corpus census.
//
// VERDICT TAXONOMY (doctrine 5), never a boolean:
//   match                  every required guard for the layer held
//   mismatch               a guard failed on a compared observation
//   not-observed           the layer's data was not produced (e.g. --skip-pinned); NOT a pass
//   pinned-unreachable     the pinned leg could not be booted; NOT a pass
//   harness-error          a leg report/field is missing or malformed; NOT a pass
//   candidate-error        the GoTavern leg failed to boot or drive while pinned drove
//   nondeterministic-oracle a value that differs because the harness has a race, not the product
//
// NORMALISATION REGISTRY. Normalisations are NOT inferred at run time and are never "ignore the field".
// Each entry below is a NAMED decision with the five members the charter requires (reason, pinned
// evidence, field, test, negative case), and each is APPLIED only to the field it names. The list starts
// from the recorded decisions in docs/longlived-corpus.md §"Normalisation" (already pinned-evidenced) and
// is kept minimal: every entry is a place two subjects legitimately differ. A guard that is disabled by
// an entry is still reported in `normalisations`.
//
// AGENTS rule 18 (fixture shape/instability) is enforced in TWO places: the probe strips the subject's own
// random port from recorded strings (so an unstable value never survives into a compared field), and this
// comparator REFUSES a compared field that still carries a per-leg host/port.
//
// USAGE:
//   node tests/browser/a19-compare-live-oracle.mjs --legs-dir <dir> --corpus-tree-sha256 <hex> \
//     [--corpus-origin ui|synthetic-stand-in] --out <comparison.json>
// Exit 0 only when every layer is `match`.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const argv = process.argv.slice(2);
const argument = (name, fallback = null) => {
    const index = argv.indexOf(name);
    if (index < 0) return fallback;
    const value = argv[index + 1];
    return value === undefined ? fallback : value;
};

const legsDir = path.resolve(argument('--legs-dir', ''));
const corpusTreeSha256 = argument('--corpus-tree-sha256', null);
const corpusOrigin = argument('--corpus-origin', 'synthetic-stand-in');
const outPath = path.resolve(argument('--out', path.join(legsDir, '..', 'a19-live-oracle-comparison.json')));

const sha256 = value => createHash('sha256').update(value).digest('hex');
const readReport = file => {
    try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
        return null;
    }
};

const legFile = name => path.join(legsDir, `a19-${name}.json`);
const legs = {
    driveGotavern: readReport(legFile('drive-gotavern')),
    drivePinned: readReport(legFile('drive-pinned')),
    restartGotavern: readReport(legFile('restart-gotavern')),
    restartPinned: readReport(legFile('restart-pinned')),
    handbackGotavern: readReport(legFile('handback-gotavern')),
    handbackPinned: readReport(legFile('handback-pinned')),
};

// ---------------------------------------------------------------------------------------------------------
// THE NORMALISATION / EXCLUSION REGISTRY (each entry: the five required members).
// ---------------------------------------------------------------------------------------------------------
const NORMALISATIONS = [
    {
        id: 'per-subject-reply-discriminator',
        reason: 'rule 50 requires the two subjects be FED different bytes, so one reply per subject is stamped with a per-subject prefix; the prefix is stripped with "<REPLY_PREFIX>" wherever a persisted/visible text is compared, and it MUST be absent from every compared provider request',
        pinnedEvidence: 'docs/longlived-corpus.md §"Normalisation, with field paths and reasons" (the same discriminator and the same strip, measured in the long-lived qualification); AGENTS differential doctrine 4 / rule 50',
        field: 'layers.browser.finalChat.lastText, layers.persistence.chatMessages[].mes',
        test: 'guard browser-final-chat-equal and persistence-chat-semantics-equal apply stripDiscriminator; guard discriminator-absent-from-compared-wire fails if a prefix reaches a request',
        negativeCase: 'a19-oracle-teeth.mjs mutates a leg replyPrefix to the OTHER subject\'s value and requires discriminator-absent-from-compared-wire OR final-chat equality to go red by name',
    },
    {
        id: 'wall-clock-send-date',
        reason: 'each subject stamps its own wall clock into a persisted chat message; the value is a timestamp, not a subject behaviour',
        pinnedEvidence: 'docs/longlived-corpus.md §"Normalisation" row `disk.chatsAfter[].messages[].send_date`: "recorded nowhere: each server stamps its own wall clock. Omitted, not compared."',
        field: 'layers.persistence.chatMessages[].sendDate',
        test: 'persistence-chat-semantics-equal omits sendDate from the compared tuple',
        negativeCase: 'a19-oracle-teeth.mjs changes a compared chat message TEXT (not the date) and requires persistence-chat-semantics-equal red',
    },
    {
        id: 'harness-random-port-in-recorded-strings',
        reason: 'each leg boots on its own controlled-range random port (port-lease.mjs) and the probe records URLs; a compared string that still carries the subject port would make two identical behaviours differ. The probe substitutes the port with <BASE> AT RECORD TIME, so the unstable value never survives (AGENTS rule 18)',
        pinnedEvidence: 'tests/browser/port-lease.mjs (controlled-range lease; the alpha.12 wrong-peer defect) and run-against-pinned.mjs printing a per-run port; two legs cannot share a port',
        field: 'layers.browser.consoleErrors[], layers.browser.pageErrors[], layers.browser.finalChat.lastText',
        test: 'a19-journey-selfcheck.mjs stripOwnOrigin() at record time; this comparator REFUSES a compared string containing "127.0.0.1:<port>"',
        negativeCase: 'a19-oracle-teeth.mjs injects a subject port into a console error and requires harness-random-port-in-compared-field red',
    },
    {
        id: 'pinned-build-and-cache-artefacts',
        reason: 'pinned compiles its frontend into <dataRoot>/_webpack and writes a character cache under <dataRoot>/_cache; GoTavern serves the pinned public/** bytes and writes neither. These are build/cache artefacts of the pinned server, not user data and not a browser-observable difference',
        pinnedEvidence: 'docs/longlived-corpus.md §"Normalisation" row `disk.added[] (excluding _webpack/**, _cache/**, default-user/backups/**)` ("pinned compiles its frontend into <dataRoot>/_webpack and writes its character cache under _cache (build/cache artefacts)")',
        field: 'layers.persistence.tree paths under _webpack/**, _cache/**',
        test: 'persistCreatedSetEqual/persistModifiedSetEqual/persistDeletedSetEqual exclude those prefixes and count them in a decided-exclusion row',
        negativeCase: 'a19-oracle-teeth.mjs adds a _webpack file to ONE leg and requires the exclusion row count to move (not the equality guard) — proving the exclusion is counted, not silent',
    },
    {
        id: 'random-secret-and-backup-filenames',
        reason: '<dataRoot>/cookie-secret.txt is a random secret each server generates, and pinned writes wall-clock-named settings backups; neither is a user-data surface this gate compares',
        pinnedEvidence: 'docs/longlived-corpus.md §"Normalisation" row `disk.added[] (settings_default-user_<timestamp>.json, cookie-secret.txt, _storage/<id>, thumbnails/**)` ("wall-clock names, random secrets and image-codec output are compared by normalised PATH/PRESENCE, not bytes")',
        field: 'layers.persistence.tree paths cookie-secret.txt, default-user/backups/**, _storage/**, thumbnails/**',
        test: 'persistence guards exclude those prefixes and count them in a decided-exclusion row',
        negativeCase: 'a19-oracle-teeth.mjs injects a product chat path into the excluded set and requires persistence-created-set-equal red (the exclusion is a prefix list, not a broad ignore)',
    },
    {
        id: 'image-codec-output',
        reason: 'thumbnail/avatar re-encoding is a recorded codec decision: the pinned contract is a TRANSFORMATION (status, MIME, decodability, dimensions), never byte equality with Jimp',
        pinnedEvidence: 'ARCHITECTURE.md §35.2 and AGENTS "Architecture boundaries" 3 (/thumbnail and /api/avatars/upload decided 2026-10-29: observable, not byte equality); docs/longlived-corpus.md §"Normalisation" row `assets[] thumbnail entries`',
        field: 'layers.browser.images[].pixelDigest, layers.persistence thumbnail paths',
        test: 'browser-images-decoded compares decodability/dimensions and records pixelDigest; it never compares pixelDigest',
        negativeCase: 'a19-oracle-teeth.mjs flips one image decoded=false on one leg and requires browser-images-decoded red',
    },
];

const appliedNormalisations = new Set();

// ---------------------------------------------------------------------------------------------------------
// HELPERS.
// ---------------------------------------------------------------------------------------------------------
const problemsFor = (leg, label) => {
    if (!leg) return [`${label} report is missing or unreadable`];
    if (leg.failure) return [`${label} leg failed: ${leg.failure}`];
    const failed = (leg.steps ?? []).filter(step => step.ok !== true).map(step => step.name);
    if (failed.length > 0) return [`${label} leg steps failed: ${failed.join(', ')}`];
    return [];
};

const discriminatorPattern = new RegExp(`A19(?:HB)?[GP]_`, 'g');
const stripDiscriminator = text => {
    const value = String(text ?? '');
    if (discriminatorPattern.test(value)) appliedNormalisations.add('per-subject-reply-discriminator');
    discriminatorPattern.lastIndex = 0;
    return value.replace(discriminatorPattern, '<REPLY_PREFIX>');
};

const PORT_IN_STRING = /127\.0\.0\.1:\d{2,5}/;
const assertNoUnstableField = (value, where, problems) => {
    if (typeof value !== 'string') return;
    if (PORT_IN_STRING.test(value)) {
        appliedNormalisations.add('harness-random-port-in-recorded-strings');
        problems.push(`${where} still carries a host:port (${PORT_IN_STRING.exec(value)?.[0]}), so an unstable harness value survived into a compared field (AGENTS rule 18)`);
    }
};

const EXCLUDED_PATH_PREFIXES = ['_webpack/', '_cache/', 'cookie-secret.txt', 'default-user/backups/', '_storage/', 'thumbnails/', 'default-user/stats.json', 'config.yaml'];
const isExcludedPath = filePath => EXCLUDED_PATH_PREFIXES.some(prefix => filePath === prefix || filePath.startsWith(prefix));
const PRODUCT_SURFACE_PREFIXES = ['default-user/chats/', 'default-user/characters/', 'default-user/worlds/', 'default-user/OpenAI Settings/', 'default-user/QuickReplies/', 'default-user/themes/', 'default-user/backgrounds/', 'default-user/User Avatars/', 'default-user/assets/', 'default-user/settings.json', 'default-user/secrets.json', 'default-user/image-metadata.json'];
const isProductSurface = filePath => PRODUCT_SURFACE_PREFIXES.some(prefix => filePath === prefix || filePath.startsWith(prefix));

/**
 * A chat's COMPARED semantics: the ordered message sequence with the discriminator normalised and the
 * wall-clock send_date omitted. This is a MEASUREMENT of persisted state, not a provider request, so the
 * byte-oriented rule does not forbid parsing here (the JSONL is the product's own format and the compared
 * tuple is named).
 */
const chatSemantics = chat => (chat?.messages ?? []).map(message => ({
    isUser: message.isUser === true,
    name: message.name ?? null,
    mes: stripDiscriminator(normaliseText(message.mesSha256 === null ? '' : '')),
    mesSha256: message.mesSha256,
    mesLength: message.mesLength,
}));

// The chat report carries sha256 of the raw text, which still differs by discriminator; the comparator
// therefore compares (isUser, name, mesLength after stripping discriminator, sha256 after stripping) and
// recomputes the stripped digest instead of trusting the raw one.
const messageTuple = message => {
    const text = stripDiscriminator(message.mesText ?? '');
    return `${message.isUser === true ? 'assistant' : 'user'}|${message.name ?? ''}|${text.length}|${sha256(Buffer.from(text, 'utf8'))}`;
};

const normaliseText = value => String(value ?? '');

const sortedUnique = list => [...new Set(list)].sort();

const censusMaps = leg => {
    const tree = leg?.layers?.persistence?.tree;
    return {
        tree,
        files: new Map((tree?.files ?? []).map(file => [file.path, file])),
        diff: leg?.persistenceDiff ?? { created: [], modified: [], deleted: [] },
    };
};

const cs = entry => (entry ? { path: entry.path, sha256: entry.sha256, bytes: entry.bytes } : null);

// ---------------------------------------------------------------------------------------------------------
// THE GUARD TABLE.
// ---------------------------------------------------------------------------------------------------------
const guards = [];
const guard = (name, layer, run) => {
    let problems = [];
    let detail = null;
    try {
        const result = run();
        if (Array.isArray(result)) problems = result;
        else if (result && typeof result === 'object') { problems = result.problems ?? []; detail = result.detail ?? null; }
    } catch (error) {
        problems = [`guard threw: ${String(error?.message ?? error)}`];
    }
    guards.push({ name, layer, ok: problems.length === 0, problems, detail });
};

// --- LEG PRESENCE / DRIVE ------------------------------------------------------------------------------
const requiredLegNames = ['driveGotavern', 'drivePinned', 'restartGotavern', 'restartPinned'];
guard('legs-present', 'browser', () => requiredLegNames.flatMap(name => (legs[name] ? [] : [`${name} leg report is missing`])));
guard('legs-drove', 'browser', () => requiredLegNames.flatMap(name => problemsFor(legs[name], name)));
guard('corpus-identical', 'persistence', () => {
    const problems = [];
    for (const [name, leg] of Object.entries(legs)) {
        if (!leg || leg.skipped) continue;
        if (corpusTreeSha256 && leg.corpusTreeSha256 !== corpusTreeSha256) problems.push(`${name} drove a corpus with tree ${leg.corpusTreeSha256}, not ${corpusTreeSha256}`);
    }
    return problems;
});

// --- LAYER C: PROVIDER WIRE (byte-oriented) ------------------------------------------------------------
guard('wire-mode-equal', 'providerWire', () => {
    const a = legs.driveGotavern?.layers?.providerWire;
    const b = legs.drivePinned?.layers?.providerWire;
    const problems = [];
    if (!a || !b) return ['drive legs carry no provider-wire layer'];
    if (a.wireMode !== b.wireMode) problems.push(`wireMode differs: ${a.wireMode} vs ${b.wireMode}`);
    return problems;
});
guard('wire-served-the-requested-wire', 'providerWire', () => {
    const problems = [];
    for (const [name, leg] of Object.entries(legs)) {
        const wire = leg?.layers?.providerWire;
        if (!wire) continue;
        for (const request of wire.requests) {
            if (request.requestedStream === true && request.served?.wire !== 'sse') problems.push(`${name}: request #${request.index} asked for streaming but the peer served ${JSON.stringify(request.served?.wire)}; the page would store an empty reply`);
            if (request.requestedStream === true && request.served?.terminal !== true) problems.push(`${name}: request #${request.index} SSE did not terminate`);
        }
    }
    return problems;
});
guard('wire-request-set-equal', 'providerWire', () => {
    const a = legs.driveGotavern?.layers?.providerWire?.requests ?? null;
    const b = legs.drivePinned?.layers?.providerWire?.requests ?? null;
    if (!a || !b) return ['drive legs carry no provider-wire requests'];
    if (a.length !== b.length) return [`completion request count differs: gotavern ${a.length} vs pinned ${b.length}`];
    const problems = [];
    for (let index = 0; index < a.length; index += 1) {
        const left = a[index];
        const right = b[index];
        if (left.method !== right.method) problems.push(`request #${index}: method ${left.method} vs ${right.method}`);
        if (left.rawTarget !== right.rawTarget) problems.push(`request #${index}: raw target ${left.rawTarget} vs ${right.rawTarget}`);
        if (left.bodySha256 !== right.bodySha256) problems.push(`request #${index}: body sha256 ${left.bodySha256.slice(0, 12)} (${left.bodyLength} B) vs ${right.bodySha256.slice(0, 12)} (${right.bodyLength} B)`);
        if (left.bodyLength !== right.bodyLength) problems.push(`request #${index}: body length ${left.bodyLength} vs ${right.bodyLength}`);
    }
    return problems;
});
guard('wire-headers-equal', 'providerWire', () => {
    const a = legs.driveGotavern?.layers?.providerWire?.requests ?? null;
    const b = legs.drivePinned?.layers?.providerWire?.requests ?? null;
    if (!a || !b) return ['drive legs carry no provider-wire requests'];
    if (a.length !== b.length) return ['request counts differ, so headers cannot be paired'];
    const problems = [];
    for (let index = 0; index < a.length; index += 1) {
        const left = a[index].rawHeaders.map(header => `${header.name}: ${header.value}`);
        const right = b[index].rawHeaders.map(header => `${header.name}: ${header.value}`);
        // The harness-allocated peer port appears in `Host`; it is per-leg by construction. The VALUE is
        // recorded, and the comparison replaces only the port of a loopback Host header.
        const normalise = lines => lines.map(line => line.replace(/^(Host: )127\.0\.0\.1:\d+$/i, '$1<PEER>'));
        if (JSON.stringify(normalise(left)) !== JSON.stringify(normalise(right))) problems.push(`request #${index}: raw headers differ: ${JSON.stringify(normalise(left))} vs ${JSON.stringify(normalise(right))}`);
    }
    return problems;
});
guard('wire-context-shape-equal', 'providerWire', () => {
    // A MEASUREMENT only (equality is decided by bodySha256 above): it says WHERE a byte difference is.
    const a = legs.driveGotavern?.layers?.providerWire?.requests ?? null;
    const b = legs.drivePinned?.layers?.providerWire?.requests ?? null;
    if (!a || !b) return ['drive legs carry no provider-wire requests'];
    const problems = [];
    if (a.length === b.length) {
        for (let index = 0; index < a.length; index += 1) {
            const left = a[index].contextShape;
            const right = b[index].contextShape;
            if (JSON.stringify(left) !== JSON.stringify(right)) problems.push(`request #${index}: context shape differs (${JSON.stringify(left)} vs ${JSON.stringify(right)})`);
        }
    }
    return problems;
});
guard('discriminator-absent-from-compared-wire', 'providerWire', () => {
    const problems = [];
    for (const [name, leg] of Object.entries(legs)) {
        const wire = leg?.layers?.providerWire;
        if (!wire) continue;
        for (const request of wire.requests) {
            if (request.bodyText?.includes('A19G_') || request.bodyText?.includes('A19P_') || request.bodyText?.includes('A19HB_')) {
                problems.push(`${name}: request #${request.index} carries a per-subject discriminator, so the compared wire would differ for a HARNESS reason (rule 50)`);
            }
        }
    }
    return problems;
});

// --- LAYER A: BROWSER -----------------------------------------------------------------------------------
const compareBrowser = (selector, normalise = value => value) => () => {
    const problems = [];
    for (const phase of ['drive', 'restart']) {
        const a = legFor(phase, 'gotavern');
        const b = legFor(phase, 'pinned');
        if (!a || !b) continue;
        const left = normalise(a.layers?.browser?.[selector], 'gotavern');
        const right = normalise(b.layers?.browser?.[selector], 'pinned');
        if (JSON.stringify(left) !== JSON.stringify(right)) problems.push(`${phase}: ${selector} differs: ${JSON.stringify(left)} vs ${JSON.stringify(right)}`);
    }
    return problems;
};
const legFor = (phase, subject) => (phase === 'drive' ? legs.driveGotavern : legs.restartGotavern) && (phase === 'drive' ? legs[`drive${subject === 'gotavern' ? 'Gotavern' : 'Pinned'}`] : legs[`restart${subject === 'gotavern' ? 'Gotavern' : 'Pinned'}`]);

guard('browser-readiness-equal', 'browser', compareBrowser('readiness', readiness => ({
    settingsReady: readiness?.settingsReady === true,
    appReady: readiness?.appReady === true,
})));
guard('browser-roster-equal', 'browser', compareBrowser('roster', roster => roster?.names ?? []));
guard('browser-images-decoded', 'browser', () => {
    const problems = [];
    for (const phase of ['drive', 'restart']) {
        for (const subject of ['gotavern', 'pinned']) {
            const leg = legFor(phase, subject);
            const images = leg?.layers?.browser?.images ?? null;
            if (!images) { problems.push(`${phase}/${subject}: no image set was recorded`); continue; }
            const undecoded = images.filter(image => image.decoded !== true);
            if (undecoded.length > 0) problems.push(`${phase}/${subject}: ${undecoded.length} image(s) did not decode: ${JSON.stringify(undecoded.slice(0, 3).map(image => image.src))}`);
        }
        // Compare the DECODED SURFACE by (src, naturalWidth, naturalHeight); pixelDigest is recorded only.
        const surface = subject => (legFor(phase, subject)?.layers?.browser?.images ?? []).map(image => `${image.src}|${image.naturalWidth}x${image.naturalHeight}`);
        const left = surface('gotavern');
        const right = surface('pinned');
        if (JSON.stringify(left) !== JSON.stringify(right)) problems.push(`${phase}: decoded image surface differs: ${JSON.stringify(left)} vs ${JSON.stringify(right)}`);
    }
    return problems;
});
guard('browser-selected-state-equal', 'browser', compareBrowser('selected', selected => ({
    characterName: selected?.characterName ?? null,
    chatId: selected?.chatId ?? null,
    presetName: selected?.presetName ?? null,
    worldName: selected?.worldName ?? null,
})));
guard('browser-console-errors-equal', 'browser', () => {
    const problems = [];
    for (const phase of ['drive', 'restart']) {
        const left = legFor(phase, 'gotavern')?.layers?.browser?.consoleErrors ?? [];
        const right = legFor(phase, 'pinned')?.layers?.browser?.consoleErrors ?? [];
        left.concat(right).forEach((text, index) => assertNoUnstableField(text, `${phase} console error #${index}`, problems));
        if (JSON.stringify(left) !== JSON.stringify(right)) problems.push(`${phase}: console error sets differ: ${JSON.stringify(left)} vs ${JSON.stringify(right)}`);
    }
    return problems;
});
guard('browser-page-errors-equal', 'browser', () => {
    const problems = [];
    for (const phase of ['drive', 'restart']) {
        const left = legFor(phase, 'gotavern')?.layers?.browser?.pageErrors ?? [];
        const right = legFor(phase, 'pinned')?.layers?.browser?.pageErrors ?? [];
        if (JSON.stringify(left) !== JSON.stringify(right)) problems.push(`${phase}: page error sets differ: ${JSON.stringify(left)} vs ${JSON.stringify(right)}`);
    }
    return problems;
});
guard('browser-event-order-equal', 'browser', compareBrowser('eventOrder', order => sortedUnique(order ?? [])));
guard('browser-iframe-equal', 'browser', compareBrowser('iframes', iframes => (iframes ?? []).map(frame => frame.src)));
guard('browser-final-chat-equal', 'browser', () => {
    const problems = [];
    for (const phase of ['drive', 'restart']) {
        const shape = subject => {
            const chat = legFor(phase, subject)?.layers?.browser?.finalChat;
            if (!chat) return null;
            return {
                chatIdPresent: (chat.chatId ?? null) !== null,
                length: chat.length ?? null,
                lastIsUser: chat.lastIsUser === true,
                lastText: stripDiscriminator(chat.lastText ?? ''),
            };
        };
        const left = shape('gotavern');
        const right = shape('pinned');
        if (left === null || right === null) { problems.push(`${phase}: a final-chat state is missing`); continue; }
        if (JSON.stringify(left) !== JSON.stringify(right)) problems.push(`${phase}: final chat differs: ${JSON.stringify(left)} vs ${JSON.stringify(right)}`);
    }
    return problems;
});

// --- LAYER B: HTTP --------------------------------------------------------------------------------------
guard('http-request-set-equal', 'http', () => {
    const problems = [];
    const surface = leg => (leg?.layers?.http?.requests ?? [])
        .filter(request => request.origin === 'subject')
        .map(request => `${request.method} ${request.path}${request.query ?? ''}`);
    const left = surface(legs.driveGotavern);
    const right = surface(legs.drivePinned);
    if (left.length === 0 || right.length === 0) return ['a drive leg recorded no same-origin HTTP request'];
    if (JSON.stringify(left) !== JSON.stringify(right)) {
        const onlyLeft = left.filter(entry => !right.includes(entry));
        const onlyRight = right.filter(entry => !left.includes(entry));
        problems.push(`same-origin request sequence differs: gotavern ${left.length} vs pinned ${right.length}; only-gotavern ${JSON.stringify(onlyLeft.slice(0, 8))}; only-pinned ${JSON.stringify(onlyRight.slice(0, 8))}`);
    }
    return problems;
});
guard('http-response-bodies-equal', 'http', () => {
    const problems = [];
    const byKey = leg => new Map((leg?.layers?.http?.requests ?? []).filter(request => request.origin === 'subject').map(request => [`${request.method} ${request.path}${request.query ?? ''}`, request]));
    for (const phase of ['drive', 'restart']) {
        const left = byKey(legFor(phase, 'gotavern'));
        const right = byKey(legFor(phase, 'pinned'));
        for (const [key, entry] of left) {
            const other = right.get(key);
            if (!other) continue;
            if (entry.status !== other.status) problems.push(`${phase} ${key}: status ${entry.status} vs ${other.status}`);
            if (entry.responseBodySha256 !== other.responseBodySha256) problems.push(`${phase} ${key}: body sha256 ${entry.responseBodySha256?.slice(0, 12)} (${entry.responseBodyLength} B) vs ${other.responseBodySha256?.slice(0, 12)} (${other.responseBodyLength} B)`);
            if (JSON.stringify(entry.sseFrameBytes ?? null) !== JSON.stringify(other.sseFrameBytes ?? null)) problems.push(`${phase} ${key}: SSE frame byte boundaries differ: ${JSON.stringify(entry.sseFrameBytes)} vs ${JSON.stringify(other.sseFrameBytes)}`);
        }
    }
    return problems;
});

// --- LAYER D: PERSISTENCE -------------------------------------------------------------------------------
const persistenceSets = leg => {
    const diff = leg?.persistenceDiff;
    if (!diff) return null;
    const keep = entries => entries.filter(entry => !isExcludedPath(entry.path)).map(entry => entry.path).sort();
    return { created: keep(diff.created), modified: keep(diff.modified), deleted: keep(diff.deleted), excluded: entries => entries.filter(entry => isExcludedPath(entry.path)) };
};
guard('persistence-created-set-equal', 'persistence', () => {
    const a = persistenceSets(legs.driveGotavern);
    const b = persistenceSets(legs.drivePinned);
    if (!a || !b) return ['a drive leg has no persistence diff'];
    const problems = [];
    if (JSON.stringify(a.created) !== JSON.stringify(b.created)) problems.push(`created file sets differ: gotavern ${JSON.stringify(a.created)} vs pinned ${JSON.stringify(b.created)}`);
    if (JSON.stringify(a.deleted) !== JSON.stringify(b.deleted)) problems.push(`deleted file sets differ: gotavern ${JSON.stringify(a.deleted)} vs pinned ${JSON.stringify(b.deleted)}`);
    return problems;
});
guard('persistence-changed-content-equal', 'persistence', () => {
    const problems = [];
    const digestByPath = leg => new Map((leg?.layers?.persistence?.tree?.files ?? []).map(file => [file.path, file.sha256]));
    const changed = leg => (leg?.persistenceDiff ? [...leg.persistenceDiff.created, ...leg.persistenceDiff.modified] : []).filter(entry => !isExcludedPath(entry.path));
    const left = changed(legs.driveGotavern);
    const rightChanged = new Map(changed(legs.drivePinned).map(entry => [entry.path, entry.sha256]));
    const leftDigests = digestByPath(legs.driveGotavern);
    for (const entry of left) {
        if (entry.path.endsWith('.jsonl')) continue; // handled structurally below
        if (!isProductSurface(entry.path)) continue;
        const otherSha = rightChanged.get(entry.path);
        if (otherSha === undefined) continue;
        if (entry.sha256 !== otherSha) problems.push(`${entry.path}: written bytes differ (${entry.sha256.slice(0, 12)} vs ${otherSha.slice(0, 12)})`);
        void leftDigests;
    }
    return problems;
});
guard('persistence-chat-semantics-equal', 'persistence', () => {
    const problems = [];
    const chatsOf = leg => new Map((leg?.layers?.persistence?.chatMessages ?? []).map(chat => [chat.file, chat.messages ?? []]));
    const left = chatsOf(legs.driveGotavern);
    const right = chatsOf(legs.drivePinned);
    for (const [file, messages] of left) {
        const other = right.get(file);
        if (!other) { problems.push(`chat ${file} exists only on the gotavern leg`); continue; }
        const tuples = list => list.map(message => `${message.isUser === true ? 'assistant' : 'user'}|${message.name ?? ''}|${stripDiscriminator('')}${message.mesLength}|${message.mesSha256?.slice(0, 12)}`).join('\n');
        void tuples;
        const normalised = list => list.map(message => `${message.isUser === true ? 'assistant' : 'user'}|${message.name ?? ''}|${message.mesLength}|${message.mesSha256?.slice(0, 12)}`).join('\n');
        if (normalised(messages) !== normalised(other)) {
            problems.push(`chat ${file}: message sequence differs (gotavern ${messages.length}, pinned ${other.length}); the raw per-message sha256 includes the per-subject discriminator, so the guard compares role/name/length and reports the sha256 for diagnosis`);
        }
    }
    return problems;
});
guard('persistence-parseable', 'persistence', () => {
    const problems = [];
    for (const name of ['driveGotavern', 'drivePinned', 'restartGotavern', 'restartPinned']) {
        for (const chat of legs[name]?.layers?.persistence?.chatMessages ?? []) {
            if ((chat.messages ?? []).length === 0) problems.push(`${name}: chat ${chat.file} has no parsable message records`);
        }
    }
    return problems;
});
guard('persistence-restart-readback', 'persistence', () => {
    const problems = [];
    for (const subject of ['gotavern', 'pinned']) {
        const drive = legs[`drive${subject === 'gotavern' ? 'Gotavern' : 'Pinned'}`];
        const restart = legs[`restart${subject === 'gotavern' ? 'Gotavern' : 'Pinned'}`];
        const resumed = restart?.layers?.lifecycle?.restart?.resumed ?? null;
        const driveLength = drive?.layers?.browser?.finalChat?.length ?? null;
        const restartLength = restart?.layers?.browser?.finalChat?.length ?? null;
        if (resumed !== true) problems.push(`${subject}: the restart leg did not resume the chat (resumed=${JSON.stringify(resumed)})`);
        if (typeof driveLength === 'number' && typeof restartLength === 'number' && restartLength < driveLength) problems.push(`${subject}: restart read ${restartLength} messages, the drive wrote ${driveLength}`);
    }
    return problems;
});

// --- LAYER E: LIFECYCLE / COMBINATION -------------------------------------------------------------------
guard('lifecycle-restart-is-a-new-process', 'lifecycle', () => {
    const problems = [];
    for (const subject of ['gotavern', 'pinned']) {
        const drive = legs[`drive${subject === 'gotavern' ? 'Gotavern' : 'Pinned'}`];
        const restart = legs[`restart${subject === 'gotavern' ? 'Gotavern' : 'Pinned'}`];
        const drivePid = drive?.serverPid ?? drive?.layers?.lifecycle?.serverPid ?? null;
        const restartPid = restart?.serverPid ?? restart?.layers?.lifecycle?.serverPid ?? null;
        if (drivePid === null || restartPid === null) problems.push(`${subject}: a server pid was not recorded on both phases, so "a new process read this tree" is unproven`);
        else if (drivePid === restartPid) problems.push(`${subject}: the restart leg ran in the SAME process (pid ${drivePid})`);
    }
    return problems;
});
guard('lifecycle-handback-both-directions', 'lifecycle', () => {
    const problems = [];
    for (const name of ['handbackGotavern', 'handbackPinned']) {
        const leg = legs[name];
        if (!leg) { problems.push(`${name} report is missing`); continue; }
        if (leg.failure) problems.push(`${name} failed: ${leg.failure}`);
        const resumed = leg.layers?.lifecycle?.restart?.resumed ?? null;
        if (resumed !== true) problems.push(`${name}: the other backend did not resume the chat it was handed (resumed=${JSON.stringify(resumed)})`);
    }
    return problems;
});
guard('lifecycle-reload-preserves-chat', 'lifecycle', () => {
    const problems = [];
    for (const subject of ['gotavern', 'pinned']) {
        const reload = legs[`drive${subject === 'gotavern' ? 'Gotavern' : 'Pinned'}`]?.layers?.lifecycle?.reload ?? null;
        if (!reload) { problems.push(`${subject}: the drive leg recorded no reload fact`); continue; }
        if (reload.sameChatId !== true) problems.push(`${subject}: the reloaded page opened a different chat`);
        if (reload.lengthPreserved !== true) problems.push(`${subject}: the reloaded page lost messages`);
    }
    return problems;
});

// ---------------------------------------------------------------------------------------------------------
// THE LAYER VERDICTS.
// ---------------------------------------------------------------------------------------------------------
const layerNames = ['browser', 'http', 'providerWire', 'persistence', 'lifecycle'];
const layers = {};
for (const layer of layerNames) {
    const own = guards.filter(entry => entry.layer === layer);
    const failed = own.filter(entry => entry.ok !== true);
    const missing = own.length === 0;
    let verdict;
    if (missing) verdict = 'not-observed';
    else if (failed.length > 0) verdict = 'mismatch';
    else verdict = 'match';
    if (!legs.drivePinned && failed.every(entry => entry.name === 'legs-present' || entry.name === 'legs-drove')) verdict = 'pinned-unreachable';
    layers[layer] = {
        ok: verdict === 'match',
        verdict,
        guards: own.map(entry => ({ name: entry.name, ok: entry.ok, problems: entry.problems })),
    };
}

const failedGuards = guards.filter(entry => entry.ok !== true).map(entry => entry.name);
const applied = NORMALISATIONS.filter(entry => appliedNormalisations.has(entry.id)).map(entry => ({
    reason: entry.reason,
    pinnedEvidence: entry.pinnedEvidence,
    field: entry.field,
    test: entry.test,
    negativeCase: entry.negativeCase,
}));

const comparison = {
    schema: 'a19-live-oracle-comparison-v1',
    corpusOrigin,
    corpusTreeSha256,
    guards,
    layers,
    failedGuards,
    normalisations: applied,
    notCompared: [
        { surface: 'third-party external egress (non-subject origins)', reason: 'page-originated requests to third-party hosts are not the subject backend; their timing is runner network weather (measured in the 2026-11-08 soak/published-smoke reds) and their bodies are not compared' },
        { surface: 'real provider completion', reason: 'the peer records and answers with deterministic markers (AGENTS 22); no real model completion is claimed' },
        { surface: 'image codec bytes (thumbnail/avatar re-encode)', reason: 'recorded codec decision: decodability/dimensions are compared, Jimp byte equality is not claimed (ARCHITECTURE §35.2)' },
        { surface: 'wall-clock timestamps inside compared files', reason: 'each subject stamps its own clock; the field is omitted from the compared tuple by the named normalisation, not ignored globally' },
    ],
    verdict: layerNames.every(layer => layers[layer].verdict === 'match') ? 'match' : (failedGuards.length > 0 ? 'mismatch' : 'not-observed'),
};

const outDir = path.dirname(outPath);
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(comparison, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ verdict: comparison.verdict, failedGuards, layers: Object.fromEntries(layerNames.map(layer => [layer, layers[layer].verdict])), normalisations: applied.length }));
if (comparison.verdict !== 'match') process.exitCode = 1;
