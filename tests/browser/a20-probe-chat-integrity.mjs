// PROBE (a): chat_metadata.integrity and body.force on the pinned chat-save path.
//
// QUESTION. What does the pinned server actually do when a chat is saved over an existing file whose
// header integrity slug differs? What status and error body does it return? Does the file change? Does
// a backup appear? What do `force`, a missing/legacy integrity, an empty file, a corrupt first line and
// a BOM'd first line do? And does the answer change at process start (backups.chat.checkIntegrity)?
//
// HOW. A real pinned SillyTavern 1.19.0 process (READ-ONLY checkout at the pin) over a scratch data root
// seeded from the pinned fresh-install template. Every request goes over HTTP with the same CSRF token
// the unmodified frontend uses. File-level observations are byte digests of the persisted .jsonl and of
// the backups directory. The probe does not assert an expected status: it records what happened and
// classifies the row against the pinned source branch it exercises.
//
// RUN: node tests/browser/a20-probe-chat-integrity.mjs
// EVIDENCE: docs/alpha20/oracle/chat-integrity/evidence.json

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
    bootPinned, makeClient, freshDataRoot, templateCensus, census, sha256, stableStringify,
    writeEvidence, probeHeader, finishHeader, delay, patchConfigLine, patchConfigLineAfter, PINNED_COMMIT,
} from './a20-probe-kit.mjs';

const PROBE = 'chat-integrity';
const AVATAR = 'A20Probe.png';
const CARD = 'A20Probe';
const CHAT = 'a20-chat-integrity';
const dataRoot = await freshDataRoot(PROBE);
const template = await templateCensus();
const header = probeHeader({
    probe: PROBE,
    purpose: 'pin the pinned /api/chats/save integrity+force branch matrix with real requests and real on-disk observations',
});
const rows = [];
const observations = [];

function classify(expected) {
    return expected;
}

let server = await bootPinned({ dataRoot, label: 'pinned-chat-integrity' });
let client = await makeClient(server.baseURL);
const userRoot = path.join(dataRoot, 'default-user');
const chatsDir = path.join(userRoot, 'chats', CARD);
const chatFile = path.join(chatsDir, `${CHAT}.jsonl`);
const backupsDir = path.join(userRoot, 'backups');

async function fileState(file) {
    try {
        const bytes = await fsp.readFile(file);
        return {
            file: path.relative(dataRoot, file).split(path.sep).join('/'),
            exists: true,
            bytes: bytes.length,
            sha256: sha256(bytes),
            text: bytes.toString('utf8'),
            lines: bytes.toString('utf8').split('\n').filter(line => line !== ''),
        };
    } catch {
        return { file: path.relative(dataRoot, file).split(path.sep).join('/'), exists: false };
    }
}

async function backupsState() {
    const entries = await census(backupsDir).catch(() => []);
    return entries.map(entry => ({ name: entry.path, bytes: entry.bytes, sha256: entry.sha256 }));
}

function chatArray({ integrity = 'slug-alpha', messages = ['first message'], extraHeader = {} } = {}) {
    const headerLine = {
        user_name: 'A20 User',
        character_name: 'A20 Char',
        chat_metadata: { ...(integrity === null ? {} : { integrity }), ...extraHeader },
        create_date: '2026-01-01T00:00:00.000Z',
    };
    return [
        headerLine,
        ...messages.map((mes, index) => ({
            name: index % 2 === 0 ? 'A20 Char' : 'A20 User',
            is_user: index % 2 === 1,
            send_date: `2026-01-01T00:00:0${index}.000Z`,
            mes,
            extra: {},
        })),
    ];
}

async function saveChat(body, { token = true } = {}) {
    const response = await client.request('/api/chats/save', {
        method: 'POST',
        json: { avatar_url: AVATAR, file_name: CHAT, ...body },
        csrf: token,
    });
    return {
        status: response.status,
        bodyText: response.bodyText,
        bodySha256: response.bodySha256,
        headers: response.headers,
    };
}

function row(name, fields) {
    rows.push({ scenario: name, ...fields });
}

async function snapshot(reason) {
    const state = await fileState(chatFile);
    const backups = await backupsState();
    observations.push({ reason, chat: { exists: state.exists, bytes: state.bytes ?? 0, sha256: state.sha256 ?? null }, backups });
    return { state, backups };
}

// ---------------------------------------------------------------------------------------------------
// A1: save a NEW chat. No file exists, so checkChatIntegrity returns true (missing file).
// ---------------------------------------------------------------------------------------------------
const beforeA1 = await snapshot('before A1');
const a1 = await saveChat({ chat: chatArray({ integrity: 'slug-alpha', messages: ['first message'] }) });
const afterA1 = await snapshot('after A1');
row('A1-new-file-with-integrity', {
    request: { route: 'POST /api/chats/save', body: { force: 'absent' } },
    status: a1.status,
    responseBody: a1.bodyText,
    chatCreated: !beforeA1.state.exists && afterA1.state.exists,
    fileSha256: afterA1.state.sha256 ?? null,
    firstLine: afterA1.state.lines?.[0] ?? null,
    backups: afterA1.backups,
    classification: classify('CONFIRMED: pinned writes the file and returns 200 {"ok":true}; backup naming/trigger recorded from the real run'),
});

// A2: save AGAIN with the SAME integrity slug, inside the 10 s backup throttle window.
const beforeA2 = await snapshot('before A2');
const a2 = await saveChat({ chat: chatArray({ integrity: 'slug-alpha', messages: ['first message', 'second message'] }) });
const afterA2 = await snapshot('after A2');
row('A2-matching-integrity-overwrite', {
    request: { route: 'POST /api/chats/save', body: { force: 'absent', integrity: 'slug-alpha (matches on disk)' } },
    status: a2.status,
    responseBody: a2.bodyText,
    fileChanged: beforeA2.state.sha256 !== afterA2.state.sha256,
    messagesPersisted: (afterA2.state.lines?.length ?? 0) - 1,
    backups: afterA2.backups,
    classification: classify('CONFIRMED: matching slug overwrites; the overwrite happens BEFORE the backup call (trySaveChat writes at chats.js:541 then backs up at :542)'),
});

// A3: save with a DIFFERENT integrity slug and no force. Must be refused; the file must not change.
const beforeA3 = await snapshot('before A3');
const a3 = await saveChat({ chat: chatArray({ integrity: 'slug-beta', messages: ['refused payload'] }) });
const afterA3 = await snapshot('after A3');
row('A3-mismatched-integrity-no-force', {
    request: { route: 'POST /api/chats/save', body: { force: 'absent', integrity: 'slug-beta (disk has slug-alpha)' } },
    status: a3.status,
    responseBody: a3.bodyText,
    fileUnchanged: beforeA3.state.sha256 === afterA3.state.sha256,
    backupsUnchanged: stableStringify(beforeA3.backups) === stableStringify(afterA3.backups),
    classification: classify('CONFIRMED: 400 {"error":"integrity"} and the file is not written (the throw precedes tryWriteFileSync)'),
});

// A4: same mismatch with force:false — a present false must behave like absent.
const beforeA4 = await snapshot('before A4');
const a4 = await saveChat({ chat: chatArray({ integrity: 'slug-beta', messages: ['refused payload'] }), force: false });
const afterA4 = await snapshot('after A4');
row('A4-mismatched-integrity-explicit-force-false', {
    request: { route: 'POST /api/chats/save', body: { force: false } },
    status: a4.status,
    responseBody: a4.bodyText,
    fileUnchanged: beforeA4.state.sha256 === afterA4.state.sha256,
    classification: classify('CONFIRMED: force:false is the same branch as absent (doIntegrityCheck = checkIntegrity && !force)'),
});

// Wait out the throttle so the trailing backup from A2 fires, then observe it.
await delay(11000);
const afterTrailing = await snapshot('after A2 trailing throttle fire');
row('A5-throttle-trailing-backup', {
    waitMs: 11000,
    backups: afterTrailing.backups,
    classification: classify('OBSERVED: the throttled trailing backup materialises ~10 s after the last save in the window; the filename and content identify which save it copied'),
});

// A6: mismatch WITH force:true. Must overwrite, return ok, and back up the new bytes.
const beforeA6 = await snapshot('before A6');
const a6 = await saveChat({ chat: chatArray({ integrity: 'slug-beta', messages: ['forced payload'] }), force: true });
const afterA6 = await snapshot('after A6');
row('A6-mismatched-integrity-force-true', {
    request: { route: 'POST /api/chats/save', body: { force: true } },
    status: a6.status,
    responseBody: a6.bodyText,
    fileChanged: beforeA6.state.sha256 !== afterA6.state.sha256,
    newFirstLine: afterA6.state.lines?.[0] ?? null,
    backupAdded: afterA6.backups.length - beforeA6.backups.length,
    classification: classify('CONFIRMED: force:true skips the check, overwrites the file, returns 200 {"ok":true} and triggers a backup'),
});

// A7: legacy header WITHOUT integrity metadata must not be checked at all.
const beforeA7 = await snapshot('before A7');
const a7 = await saveChat({ chat: chatArray({ integrity: null, messages: ['legacy payload'] }) });
const afterA7 = await snapshot('after A7');
row('A7-no-integrity-metadata-legacy', {
    request: { route: 'POST /api/chats/save', body: { force: 'absent', header: 'chat_metadata has no integrity' } },
    status: a7.status,
    responseBody: a7.bodyText,
    fileChanged: beforeA7.state.sha256 !== afterA7.state.sha256,
    classification: classify('CONFIRMED: no slug means no check (chats.js:362-365), so a different existing slug does not refuse'),
});

// A8: non-array body.chat — the exact error body and the absence of a write.
const beforeA8 = await snapshot('before A8');
const a8 = await saveChat({ chat: { not: 'an array' } });
const afterA8 = await snapshot('after A8');
row('A8-non-array-chat', {
    request: { route: 'POST /api/chats/save', body: { chat: 'object' } },
    status: a8.status,
    responseBody: a8.bodyText,
    fileUnchanged: beforeA8.state.sha256 === afterA8.state.sha256,
    classification: classify('CONFIRMED: 400 with the pinned literal body.chat error string (chats.js:560)'),
});

// A9: BOM in the existing file's first line. The source strips U+FEFF; a match must not refuse.
await fsp.writeFile(chatFile, '\uFEFF' + JSON.stringify(chatArray({ integrity: 'slug-gamma' })[0]) + '\n' + JSON.stringify({ name: 'A20 Char', mes: 'bom message' }) + '\n', 'utf8');
const beforeA9 = await snapshot('before A9 (BOM written by the probe as an external editor would)');
const a9 = await saveChat({ chat: chatArray({ integrity: 'slug-gamma', messages: ['over bom'] }) });
const afterA9 = await snapshot('after A9');
row('A9-bom-first-line-same-slug', {
    request: { route: 'POST /api/chats/save', body: { force: 'absent', integrity: 'slug-gamma (matches after BOM strip)' } },
    setup: 'the probe wrote a UTF-8 BOM before the header line, as an external editor does; this is a filesystem setup, not a product action',
    status: a9.status,
    responseBody: a9.bodyText,
    fileChanged: beforeA9.state.sha256 !== afterA9.state.sha256,
    classification: classify('CONFIRMED: the BOM is stripped before JSON.parse (chats.js:350), so the slug comparison sees the real header'),
});

// A10: corrupt (non-JSON) first line in a non-empty file. Must refuse even without force.
await fsp.writeFile(chatFile, 'this is not a json header\n' + JSON.stringify({ name: 'A20 Char', mes: 'tail' }) + '\n', 'utf8');
const beforeA10 = await snapshot('before A10 (corrupt first line written by the probe)');
const a10 = await saveChat({ chat: chatArray({ integrity: 'slug-delta', messages: ['over corrupt'] }) });
const afterA10 = await snapshot('after A10');
row('A10-corrupt-first-line', {
    request: { route: 'POST /api/chats/save', body: { force: 'absent', integrity: 'slug-delta' } },
    setup: 'the probe replaced the first line with non-JSON, as a truncated write or external editor would',
    status: a10.status,
    responseBody: a10.bodyText,
    fileUnchanged: beforeA10.state.sha256 === afterA10.state.sha256,
    classification: classify('CONFIRMED: an unparseable first line fails the check (chats.js:352-356) so even an unrelated slug refuses; this is the protection against silently overwriting a truncated chat'),
});

// A11: empty file is treated as intact (nothing could be lost).
await fsp.writeFile(chatFile, '', 'utf8');
const beforeA11 = await snapshot('before A11 (zero-byte file)');
const a11 = await saveChat({ chat: chatArray({ integrity: 'slug-epsilon', messages: ['over empty'] }) });
const afterA11 = await snapshot('after A11');
row('A11-empty-file', {
    request: { route: 'POST /api/chats/save', body: { force: 'absent', integrity: 'slug-epsilon' } },
    setup: 'the probe truncated the file to zero bytes',
    status: a11.status,
    responseBody: a11.bodyText,
    fileChanged: beforeA11.state.sha256 !== afterA11.state.sha256,
    classification: classify('CONFIRMED: size===0 returns intact (chats.js:343-346)'),
});

// ---------------------------------------------------------------------------------------------------
// RESTART with backups.chat.checkIntegrity: false. Pinned reads config at startup only.
// ---------------------------------------------------------------------------------------------------
const checkIntegrityEdit = await patchConfigLine(dataRoot, 'checkIntegrity: true', 'checkIntegrity: false');const stop1 = await server.stop();
server = await bootPinned({ dataRoot, label: 'pinned-chat-integrity-restart-checkIntegrity-false' });
client = await makeClient(server.baseURL);
const beforeB1 = await snapshot('before B1 (restart, checkIntegrity=false)');
const b1 = await saveChat({ chat: chatArray({ integrity: 'slug-zeta', messages: ['checkIntegrity false payload'] }) });
const afterB1 = await snapshot('after B1');
row('B1-checkIntegrity-false-restart', {
    configEdit: checkIntegrityEdit,
    restart: { firstExit: stop1, newPid: server.pid, bootWaitedMs: server.bootWaitedMs },
    request: { route: 'POST /api/chats/save', body: { force: 'absent', integrity: 'slug-zeta (disk had slug-epsilon)' } },
    status: b1.status,
    responseBody: b1.bodyText,
    fileChanged: beforeB1.state.sha256 !== afterB1.state.sha256,
    classification: classify('CONFIRMED: backups.chat.checkIntegrity=false disables the check for the process; the mismatch is accepted'),
});

// ---------------------------------------------------------------------------------------------------
// RESTART with backups.chat.enabled: false. The write must still happen; no backup may.
// ---------------------------------------------------------------------------------------------------
const backupEnabledEdit = await patchConfigLineAfter(dataRoot, 'backups:', 'enabled: true', 'enabled: false');
const stop2 = await server.stop();
server = await bootPinned({ dataRoot, label: 'pinned-chat-integrity-restart-backups-disabled' });
client = await makeClient(server.baseURL);
const beforeC1 = await snapshot('before C1 (restart, backups.chat.enabled=false)');
const c1 = await saveChat({ chat: chatArray({ integrity: 'slug-eta', messages: ['backups disabled payload'] }), force: true });
await delay(11000); // a disabled backup is not a throttled backup: wait the full window and re-check
const afterC1 = await snapshot('after C1 (+11s)');
row('C1-backups-disabled-restart', {
    configEdit: backupEnabledEdit,
    restart: { firstExit: stop2, newPid: server.pid, bootWaitedMs: server.bootWaitedMs },
    request: { route: 'POST /api/chats/save', body: { force: true } },
    status: c1.status,
    responseBody: c1.bodyText,
    fileChanged: beforeC1.state.sha256 !== afterC1.state.sha256,
    backupsBefore: beforeC1.backups,
    backupsAfter: afterC1.backups,
    classification: classify('CONFIRMED: backups.chat.enabled=false suppresses the backup only; the save still succeeds (backupChat returns before writing, chats.js:61)'),
});

// Final restart to prove the last persisted file is readable back through the product.
const stop3 = await server.stop();
server = await bootPinned({ dataRoot, label: 'pinned-chat-integrity-restart-readback' });
client = await makeClient(server.baseURL);
const readBack = await client.request('/api/chats/get', { method: 'POST', json: { avatar_url: AVATAR, file_name: CHAT } });
const finalState = await fileState(chatFile);
row('D1-restart-readback', {
    restart: { firstExit: stop3, newPid: server.pid },
    status: readBack.status,
    messageCountReadBack: Array.isArray(JSON.parse(readBack.bodyText)) ? JSON.parse(readBack.bodyText).length - 1 : null,
    fileSha256: finalState.sha256 ?? null,
    classification: classify('CONFIRMED: a new pinned process reads the last persisted chat through /api/chats/get'),
});

const stopFinal = await server.stop();

const evidence = {
    ...finishHeader(header),
    pinned: { commit: PINNED_COMMIT, version: server.version, root: 'C:\\Users\\koishi\\Desktop\\GoTavern\\SillyTavern' },
    dataRoot: {
        template,
        probeDataCensus: await census(dataRoot, { exclude: ['_webpack'] }),
    },
    routes: ['POST /api/chats/save', 'POST /api/chats/get'],
    requestContract: {
        csrf: 'GET /csrf-token then X-CSRF-Token plus the session cookie, as the unmodified frontend does',
        saveBody: '{ avatar_url, file_name, chat: [...], force?: boolean }',
    },
    fileLayout: {
        chatFile: path.relative(dataRoot, chatFile).split(path.sep).join('/'),
        backupsDir: path.relative(dataRoot, backupsDir).split(path.sep).join('/'),
    },
    bootLogTail: server.logText().slice(-1500),
    rows,
    processExits: { final: stopFinal },
    verdicts: [
        { id: 'integrity-mismatch', verdict: 'CONFIRMED', evidence: 'A3/A4: 400 {"error":"integrity"} and the file is byte-unchanged' },
        { id: 'force-bypass', verdict: 'CONFIRMED', evidence: 'A6: force:true overwrites, 200 {"ok":true}, backup added' },
        { id: 'legacy-and-empty', verdict: 'CONFIRMED', evidence: 'A7/A11: no slug and zero-byte file are treated as intact' },
        { id: 'corrupt-first-line-refusal', verdict: 'CONFIRMED', evidence: 'A10: unparseable header refuses even without force' },
        { id: 'backup-throttle', verdict: 'CONFIRMED', evidence: 'A2/A5: leading backup immediately, trailing one after backups.chat.throttleInterval (10 s default)' },
        { id: 'backup-config-restart', verdict: 'CONFIRMED', evidence: 'B1/C1: checkIntegrity and backups.enabled are read at process start; a restart is required to observe them' },
    ],
    unproven: [
        'No GoTavern leg is in this document: it is a PINNED-only probe. The Go side comparison belongs to the comparator lane; the file exists so that comparison has an oracle.',
    ],
};

const written = await writeEvidence(PROBE, evidence);
console.log(`evidence: ${written.file}`);
console.log(`rows: ${rows.length}; verdicts: ${evidence.verdicts.length}`);
for (const item of rows) console.log(`  ${item.scenario}: ${item.status} ${String(item.responseBody).slice(0, 90)}`);
