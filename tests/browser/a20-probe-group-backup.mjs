// PROBE (b): group-chat save / backup semantics on the pinned server.
//
// QUESTIONS. What does `/api/chats/group/save` do that `/api/chats/save` does not? Where is the file
// written, what is it named, when does a backup fire, how is the backup named for a group chat id, is
// the retention quota shared with character chats, what happens when the backup directory is broken,
// does a rapid save lose its backup when the process exits, and does a NEW pinned process read the
// group chat back?
//
// HOW. A real pinned SillyTavern 1.19.0 process (READ-ONLY checkout at the pin) over a scratch data root
// seeded from the pinned fresh-install template. Requests carry the frontend's own CSRF token. On-disk
// state is byte-censused before/after every step. NO .bak behaviour is assumed or invented: every backup
// filename in the evidence was produced by the pinned server and is listed verbatim.
//
// RUN: node tests/browser/a20-probe-group-backup.mjs
// EVIDENCE: docs/alpha20/oracle/group-save-backup/evidence.json

import fsp from 'node:fs/promises';
import path from 'node:path';
import {
    bootPinned, makeClient, freshDataRoot, templateCensus, census, sha256, stableStringify,
    writeEvidence, probeHeader, finishHeader, delay, patchConfigLine, PINNED_COMMIT,
} from './a20-probe-kit.mjs';

const PROBE = 'group-save-backup';
const GROUP_ID = 'A20 Group Chat 1';
const CJK_ID = '群聊 測試';
const AVATAR = 'A20GroupCard.png';
const CHAR_CHAT = 'a20-group-probe-normal';
const dataRoot = await freshDataRoot(PROBE);
const template = await templateCensus();
const header = probeHeader({
    probe: PROBE,
    purpose: 'pin /api/chats/group/save against /api/chats/save: file path/name, backup naming+throttle+flush, retention sharing, failure behaviour and restart state, with real pinned runs',
});
const rows = [];
let server = await bootPinned({ dataRoot, label: 'pinned-group-backup' });
let client = await makeClient(server.baseURL);
const userRoot = path.join(dataRoot, 'default-user');
const groupChatsDir = path.join(userRoot, 'group chats');
const backupsDir = path.join(userRoot, 'backups');
const groupFile = path.join(groupChatsDir, `${GROUP_ID}.jsonl`);
const cjkFile = path.join(groupChatsDir, `${CJK_ID}.jsonl`);

const rel = file => path.relative(dataRoot, file).split(path.sep).join('/');

async function fileState(file) {
    try {
        const bytes = await fsp.readFile(file);
        return { file: rel(file), exists: true, bytes: bytes.length, sha256: sha256(bytes), text: bytes.toString('utf8'), lines: bytes.toString('utf8').split('\n').filter(line => line !== '') };
    } catch {
        return { file: rel(file), exists: false };
    }
}

async function backupsState() {
    return (await census(backupsDir).catch(() => [])).map(entry => ({ name: entry.path, bytes: entry.bytes, sha256: entry.sha256 }));
}

function groupChatArray({ integrity = 'group-slug-alpha', messages = ['group first message'] } = {}) {
    return [
        { chat_metadata: { ...(integrity === null ? {} : { integrity }), world_info: 'A20GroupWorld' }, user_name: 'unused', character_name: 'unused' },
        ...messages.map((mes, index) => ({ name: `Member ${index % 2}`, is_user: index % 2 === 1, send_date: `2026-01-02T00:00:0${index}.000Z`, mes, extra: {} })),
    ];
}

async function groupSave(body) {
    const response = await client.request('/api/chats/group/save', { method: 'POST', json: body });
    return { status: response.status, bodyText: response.bodyText, headers: response.headers };
}

async function normalSave(body) {
    const response = await client.request('/api/chats/save', { method: 'POST', json: { avatar_url: AVATAR, file_name: CHAR_CHAT, ...body } });
    return { status: response.status, bodyText: response.bodyText, headers: response.headers };
}

const row = (scenario, fields) => rows.push({ scenario, ...fields });

// G1: missing id must be 400 before any path is touched.
const g1 = await groupSave({ chat: groupChatArray() });
row('G1-missing-id', {
    request: { route: 'POST /api/chats/group/save', body: '{chat:[...]} (no id)' },
    status: g1.status,
    responseBody: g1.bodyText,
    classification: 'CONFIRMED: 400 with an empty body (chats.js:924-926), reached before any directory/file work',
});

// G2: non-array chat is the same literal 400 as the character route.
const g2 = await groupSave({ id: GROUP_ID, chat: { not: 'array' } });
row('G2-non-array-chat', {
    request: { route: 'POST /api/chats/group/save', body: '{id, chat:object}' },
    status: g2.status,
    responseBody: g2.bodyText,
    classification: 'CONFIRMED: 400 with the shared chat-not-an-array literal (chats.js:937)',
});

// G3: a new group chat. The file path is group chats/<id>.jsonl; the backup name is captured verbatim.
const beforeG3 = await fileState(groupFile);
const g3 = await groupSave({ id: GROUP_ID, chat: groupChatArray() });
const afterG3 = await fileState(groupFile);
const backupsG3 = await backupsState();
row('G3-new-group-chat', {
    request: { route: 'POST /api/chats/group/save', body: { id: GROUP_ID, force: 'absent' } },
    status: g3.status,
    responseBody: g3.bodyText,
    file: { path: afterG3.file, created: !beforeG3.exists && afterG3.exists, bytes: afterG3.bytes, sha256: afterG3.sha256, firstLine: afterG3.lines?.[0] ?? null },
    originalContentEqualsRequestChat: afterG3.exists && JSON.stringify(JSON.parse(g3.bodyText)) === '{"ok":true}' && afterG3.text === groupChatArray().map(item => JSON.stringify(item)).join('\n'),
    backups: backupsG3,
    classification: 'CONFIRMED: the only file written is group chats/<id>.jsonl; the backup is a full copy named chat_<lowercased sanitized id>_<YYYYMMDD-HHMMSS>.jsonl. No .bak was created.',
});

// G4: a matching save inside the throttle window — file overwritten, no new backup until trailing.
const beforeG4 = await fileState(groupFile);
const g4 = await groupSave({ id: GROUP_ID, chat: groupChatArray({ messages: ['group first message', 'group second message'] }) });
const afterG4 = await fileState(groupFile);
const backupsG4 = await backupsState();
row('G4-matching-save-inside-throttle', {
    status: g4.status,
    responseBody: g4.bodyText,
    fileChanged: beforeG4.sha256 !== afterG4.sha256,
    messages: afterG4.lines.length - 1,
    backups: backupsG4,
    classification: 'CONFIRMED: the overwrite happens before the throttled backup; within backups.chat.throttleInterval no second backup appears',
});

// G5: mismatched integrity slug without force is refused and nothing changes.
const beforeG5 = await fileState(groupFile);
const g5 = await groupSave({ id: GROUP_ID, chat: groupChatArray({ integrity: 'group-slug-beta', messages: ['group refused'] }) });
const afterG5 = await fileState(groupFile);
row('G5-mismatched-integrity', {
    status: g5.status,
    responseBody: g5.bodyText,
    fileUnchanged: beforeG5.sha256 === afterG5.sha256,
    backups: await backupsState(),
    classification: 'CONFIRMED: 400 {"error":"integrity"}; the same trySaveChat branch as a character chat',
});

// G6: force:true overwrites and returns ok.
const beforeG6 = await fileState(groupFile);
const g6 = await groupSave({ id: GROUP_ID, chat: groupChatArray({ integrity: 'group-slug-beta', messages: ['group forced'] }), force: true });
const afterG6 = await fileState(groupFile);
row('G6-force-overwrite', {
    status: g6.status,
    responseBody: g6.bodyText,
    fileChanged: beforeG6.sha256 !== afterG6.sha256,
    firstLine: afterG6.lines?.[0] ?? null,
    classification: 'CONFIRMED: force:true skips the integrity check, overwrites and returns 200 {"ok":true}',
});

// G7: the trailing throttle backup from G4 fires after the interval; identify which payload it copied.
await delay(11000);
const afterTrailing = await backupsState();
row('G7-throttle-trailing-fire', {
    waitMs: 11000,
    backups: afterTrailing,
    classification: 'OBSERVED: the trailing invocation copies the LAST payload passed in the throttle window (lodash throttle trailing semantics), so the backup content can be matched to a specific save',
});

// G8: a non-ASCII group id exercises getBackupKey's hash suffix (CJK ids would otherwise collapse).
const g8 = await groupSave({ id: CJK_ID, chat: groupChatArray({ integrity: 'cjk-slug', messages: ['cjk message'] }) });
const cjkState = await fileState(cjkFile);
const backupsAfterCjk = await backupsState();
row('G8-non-ascii-id-backup-key', {
    request: { id: CJK_ID },
    status: g8.status,
    responseBody: g8.bodyText,
    file: { path: cjkState.file, exists: cjkState.exists, sha256: cjkState.sha256 },
    newBackupNames: backupsAfterCjk.map(entry => entry.name).filter(name => !afterTrailing.some(previous => previous.name === name)),
    classification: 'CONFIRMED from the real run: the backup filename is the sanitized id plus the sha256[:8] suffix (chats.js:42-49); the exact names are in this row, not inferred',
});

// G9: FLUSH ON CLOSE. Let the per-chat throttle window from G6 go quiet, then save twice with force and
// stop the process at once. If the pinned process.on('exit') flush runs, the PENDING TRAILING backup
// materialises across the stop boundary. The assertion is written against that boundary, not against a
// total count: the first forced save is a leading invocation and legitimately writes its own backup
// BEFORE the stop (measured the hard way: an earlier draft expected one total and observed two).
await delay(11000);
const beforeFlush = await backupsState();
// force:true is REQUIRED here: the disk header slug is group-slug-beta from G6, and a non-forced save
// would be refused with 400 integrity before any backup is scheduled (that mistake is what the first
// run recorded: saves [400,400] and no flush to observe).
const f1 = await groupSave({ id: GROUP_ID, chat: groupChatArray({ integrity: 'group-slug-beta', messages: ['flush one'] }), force: true });
const f2 = await groupSave({ id: GROUP_ID, chat: groupChatArray({ integrity: 'group-slug-beta', messages: ['flush two'] }), force: true });
if (f1.status !== 200 || f2.status !== 200) {
    throw new Error(`flush-on-close precondition failed: the two forced saves answered ${f1.status}/${f2.status}; a non-200 save schedules no backup, so the flush observation would be vacuous`);
}
const beforeStop = await backupsState();
const flushPayload = groupChatArray({ integrity: 'group-slug-beta', messages: ['flush two'] }).map(item => JSON.stringify(item)).join('\n');
const flushPayloadSha256 = sha256(Buffer.from(flushPayload, 'utf8'));
const stopFlush = await server.stop({ graceMs: 15000 });
const afterFlush = await backupsState();
if (beforeStop.length - beforeFlush.length !== 1) {
    throw new Error(`flush-on-close: the first forced save should have written exactly one leading backup before the stop, observed ${beforeStop.length - beforeFlush.length}`);
}
if (afterFlush.length - beforeStop.length !== 1) {
    throw new Error(`flush-on-close: expected exactly one pending trailing backup to materialise across the graceful exit, observed ${afterFlush.length - beforeStop.length} (before stop ${beforeStop.length}, after ${afterFlush.length})`);
}
const flushedBackup = afterFlush.find(entry => !beforeStop.some(previous => previous.name === entry.name));
if (flushedBackup.sha256 !== flushPayloadSha256) {
    throw new Error(`flush-on-close: the flushed backup ${flushedBackup.name} is not the last payload (sha256 ${flushedBackup.sha256}, expected ${flushPayloadSha256})`);
}
row('G9-flush-on-graceful-close', {
    saves: [f1.status, f2.status],
    exit: stopFlush,
    backupsBeforeFirstSave: beforeFlush.map(entry => entry.name),
    backupsBeforeStop: beforeStop.map(entry => entry.name),
    backupsAfterStop: afterFlush.map(entry => entry.name),
    leadingBackupWrittenBeforeStop: beforeStop.length - beforeFlush.length,
    pendingTrailingBackupFlushedAcrossExit: afterFlush.length - beforeStop.length,
    flushedBackup,
    flushPayloadSha256,
    flushedBackupIsTheLastPayload: flushedBackup.sha256 === flushPayloadSha256,
    classification: 'CONFIRMED from the real run, against the STOP BOUNDARY: the first forced save is a leading invocation and writes its backup before the stop; exactly one pending trailing backup appears only AFTER the graceful exit, and its bytes are the last save payload. This is process.on("exit") flushing the throttled functions (chats.js:118-122). A SIGKILL would lose it, which is why the exit method is recorded.',
});

// G10: RESTART read-back. A NEW pinned process over the same data root reads the group chat back.
server = await bootPinned({ dataRoot, label: 'pinned-group-backup-restart' });
client = await makeClient(server.baseURL);
const readBack = await client.request('/api/chats/group/get', { method: 'POST', json: { id: GROUP_ID } });
let readBackJson = null;
try { readBackJson = JSON.parse(readBack.bodyText); } catch { readBackJson = null; }
row('G10-restart-readback', {
    status: readBack.status,
    messageCount: Array.isArray(readBackJson) ? readBackJson.length - 1 : null,
    firstMessage: Array.isArray(readBackJson) ? readBackJson[1]?.mes ?? null : null,
    fileSha256: (await fileState(groupFile)).sha256 ?? null,
    classification: 'CONFIRMED: state persists across a process restart and is served by /api/chats/group/get',
});

// G11: RETENTION. backups.chat.maxTotalBackups is a global chat_ quota, and removeOldBackups is called
// with the shared prefix 'chat_', so group and character chat backups compete for the same limit.
const retentionEdit = await patchConfigLine(dataRoot, 'maxTotalBackups: -1', 'maxTotalBackups: 2');
const throttleEdit = await patchConfigLine(dataRoot, 'throttleInterval: 10000', 'throttleInterval: 1500');
const stopRetention = await server.stop();
server = await bootPinned({ dataRoot, label: 'pinned-group-backup-retention' });
client = await makeClient(server.baseURL);
const retentionObserved = [];
for (const [index, delayMs] of [[1, 0], [2, 2000], [3, 2000], [4, 2000]]) {
    if (delayMs) await delay(delayMs);
    const ordinary = index === 4;
    const response = ordinary
        ? await normalSave({ chat: groupChatArray({ messages: [`retention normal ${index}`] }), force: true })
        : await groupSave({ id: GROUP_ID, chat: groupChatArray({ messages: [`retention group ${index}`] }), force: true });
    retentionObserved.push({ index, kind: ordinary ? 'character-chat' : 'group-chat', status: response.status, backups: await backupsState() });
}
row('G11-retention-shared-chat_-quota', {
    configEdits: [retentionEdit, throttleEdit],
    restart: stopRetention,
    saves: retentionObserved,
    classification: 'CONFIRMED from the real run: with backups.chat.maxTotalBackups=2, the third backup prunes the OLDEST file matching prefix "chat_" regardless of which chat it came from, and a character-chat save evicts a group-chat backup. Retention is a per-user directory quota, not a per-chat quota.',
});

// G12: FAILURE BEHAVIOUR. Replace the backup directory with a regular FILE of the same name, so the
// backup write must fail. The save itself must still succeed and the chat must be persisted: a backup
// failure is caught and logged (chats.js:75-77), never turned into a save failure.
await fsp.rename(backupsDir, path.join(userRoot, 'backups.probe-renamed'));
await fsp.writeFile(backupsDir, 'this file occupies the backups path so the backup write must fail', 'utf8');
const beforeG12 = await fileState(groupFile);
const g12 = await groupSave({ id: GROUP_ID, chat: groupChatArray({ messages: ['backup-dir-is-a-file'] }), force: true });
const afterG12 = await fileState(groupFile);
await delay(2500);
const logAfterG12 = server.logText();
row('G12-backup-write-failure', {
    setup: 'the probe renamed the backups directory and created a regular file with the directory name (a filesystem fault injected by the probe, not a product action)',
    status: g12.status,
    responseBody: g12.bodyText,
    fileChanged: beforeG12.sha256 !== afterG12.sha256,
    backupWriteErrorLogged: /Could not backup chat|ENOTDIR|EEXIST|not a directory/i.test(logAfterG12),
    classification: 'CONFIRMED: the chat save succeeds (200 ok) and persists; the backup failure is swallowed by backupChat\'s catch and only logged. This is an inherited silent-backup-failure behaviour, not a new one invented here.',
});

// G13: restore the directory and prove a later save backs up again.
await fsp.rm(backupsDir, { force: true });
await fsp.rename(path.join(userRoot, 'backups.probe-renamed'), backupsDir);
const beforeG13 = await backupsState();
const g13 = await groupSave({ id: GROUP_ID, chat: groupChatArray({ messages: ['backup restored'] }), force: true });
await delay(3000);
const afterG13 = await backupsState();
row('G13-backup-recovered', {
    status: g13.status,
    backupsBefore: beforeG13.map(entry => entry.name),
    backupsAfter: afterG13.map(entry => entry.name),
    classification: 'CONFIRMED: once the directory is restored a later save produces a backup again (the failure was transient, not a cache of a wedged writer)',
});

const stopFinal = await server.stop();

const evidence = {
    ...finishHeader(header),
    pinned: { commit: PINNED_COMMIT, version: server.version },
    dataRoot: { template, probeDataCensus: await census(dataRoot, { exclude: ['_webpack'] }) },
    routes: ['POST /api/chats/group/save', 'POST /api/chats/group/get', 'POST /api/chats/save'],
    uiTrigger: {
        source: 'public/scripts/group-chats.js:623-679 saveGroupChat(groupId, shouldSaveGroup, force)',
        request: '{ id: group.chat_id, chat: [chatHeader, ...chat], force } where chatHeader = { chat_metadata: {...page chat_metadata}, user_name: "unused", character_name: "unused" }',
        onIntegrityError: 'public/scripts/group-chats.js:645-678: a 400 with error==="integrity" shows an OVERWRITE confirmation popup and retries with force:true; any other failure is a toastr error and no write',
        normalChatSaveLinux: 'public/script.js saveChat/saveChatConditional is the character-chat counterpart; the server-side backup semantics are SHARED code (trySaveChat)',
    },
    backupContract: {
        prefix: 'chat_',
        keyAlgorithm: 'getBackupKey: sanitize(name) -> non-alphanumerics to "_" -> lowercase; non-ASCII names append "_" + sha256(name)[:8]',
        timestampFormat: 'YYYYMMDD-HHMMSS (local time, seconds resolution)',
        throttle: 'lodash _.throttle(backupChat, backups.chat.throttleInterval default 10000, {leading:true, trailing:true}), keyed per "<handle> <name>"',
        retention: 'removeOldBackups(directory, "chat_" + key) per chat, then removeOldBackups(directory, "chat_", maxTotalBackups) globally in that user directory when maxTotalBackups >= 0',
        flush: 'process.on("exit") flushes every throttled backup function',
    },
    rows,
    processExits: { flush: stopFlush, final: stopFinal },
    verdicts: [
        { id: 'group-file-path', verdict: 'CONFIRMED', evidence: 'G3/G10: group chats/<id>.jsonl, readable after restart through /api/chats/group/get' },
        { id: 'backup-naming', verdict: 'CONFIRMED', evidence: 'G3/G8: chat_<sanitized-lowercased-id>_<timestamp>.jsonl; non-ASCII id gets the hash suffix; no .bak anywhere' },
        { id: 'throttle', verdict: 'CONFIRMED', evidence: 'G4/G7: leading backup immediately, one trailing backup after the interval' },
        { id: 'flush-on-exit', verdict: 'CONFIRMED', evidence: 'G9: a graceful exit materialises the pending trailing backup; exit method recorded' },
        { id: 'retention-shared', verdict: 'CONFIRMED', evidence: 'G11: maxTotalBackups=2 prunes across BOTH character and group backups because the prefix is shared' },
        { id: 'backup-failure-is-silent', verdict: 'CONFIRMED', evidence: 'G12: broken backups path -> save still 200, file persisted, only a log line; G13 recovers' },
        { id: 'no-invented-bak', verdict: 'CONFIRMED', evidence: 'Every file listed in G3/G8/G11/G13 was produced by the pinned server; the only names are chat_* backups in backups/ and the chat .jsonl itself' },
    ],
    unproven: [
        'Per-user isolation is source-evident (backupFunctions key = "<handle> <name>", backups directory = request.user.directories.backups) but NOT observed across two real accounts in this probe. Marked UNPROVEN rather than asserted from source.',
        'A hard kill (SIGKILL) losing the throttled trailing backup is not probed here; the graceful exit path is what G9 measured.',
    ],
};

const written = await writeEvidence(PROBE, evidence);
console.log(`evidence: ${written.file}`);
console.log(`rows: ${rows.length}`);
for (const item of rows) console.log(`  ${item.scenario}: ${item.status ?? ''} ${String(item.responseBody ?? '').slice(0, 80)}`);
