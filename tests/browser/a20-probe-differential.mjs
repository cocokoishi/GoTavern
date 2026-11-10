// a20-probe-differential.mjs -- run the (a) chat-integrity and (b) group-save/backup scenario matrices
// against BOTH subjects and diff the observable tuple.
//
// The two pinned probes (a20-probe-chat-integrity.mjs, a20-probe-group-backup.mjs) established WHAT pinned
// does. This driver re-runs the same scenarios on the READ-ONLY pinned checkout AND on the current
// worktree's GoTavern binary over two fresh data roots (each seeded from the recorded pinned
// fresh-install template), and compares the tuple that a user can observe:
//
//   status, exact response body, persisted chat-file bytes, backup file names (timestamp-normalised) and
//   backup bytes, plus the restart/flush/retention outcomes.
//
// A field is MATCH only when both subjects' recorded values are equal after the DOCUMENTED normalisation
// (the backup filename timestamp, which is wall-clock by design). Nothing else is normalised: the response
// body is compared as bytes, and the chat file is compared by sha256.
//
// RUN: node tests/browser/a20-probe-differential.mjs
// EVIDENCE: docs/alpha20/oracle/chat-integrity/differential.json and
//           docs/alpha20/oracle/group-save-backup/differential.json

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
    bootPinned, bootGotavern, buildGotavern, makeClient, freshDataRoot, templateCensus, census, sha256,
    stableStringify, writeDocument, probeHeader, finishHeader, delay, patchConfigLine, patchConfigLineAfter,
    PINNED_COMMIT, SCRATCH_ROOT,
} from './a20-probe-kit.mjs';

const AVATAR = 'A20Diff.png';
const CARD = 'A20Diff';
const CHAT = 'a20-diff-chat';
const GROUP_ID = 'A20 Diff Group 1';
const TS = /_\d{8}-\d{6}\.jsonl$/;

const header = probeHeader({
    probe: 'chat-integrity+group-save-backup',
    purpose: 'run the pinned chat-integrity and group-save/backup matrices on BOTH subjects and diff the observable tuple, so the two closed alpha.20 gaps have a real Go-vs-pinned differential rather than a pinned-only oracle',
});

const sha = value => sha256(Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8'));

function chatArray({ integrity = 'diff-slug-alpha', messages = ['diff first message'], extraHeader = {} } = {}) {
    return [
        { user_name: 'A20 User', character_name: 'A20 Char', chat_metadata: { ...(integrity === null ? {} : { integrity }), ...extraHeader }, create_date: '2026-01-01T00:00:00.000Z' },
        ...messages.map((mes, index) => ({ name: index % 2 === 0 ? 'A20 Char' : 'A20 User', is_user: index % 2 === 1, send_date: `2026-01-01T00:00:0${index}.000Z`, mes, extra: {} })),
    ];
}

function groupArray({ integrity = 'diff-group-slug', messages = ['diff group message'] } = {}) {
    return [
        { chat_metadata: { ...(integrity === null ? {} : { integrity }), world_info: 'A20DiffWorld' }, user_name: 'unused', character_name: 'unused' },
        ...messages.map((mes, index) => ({ name: `Member ${index % 2}`, is_user: index % 2 === 1, send_date: `2026-01-02T00:00:0${index}.000Z`, mes, extra: {} })),
    ];
}

async function fileState(file) {
    try {
        const bytes = await fsp.readFile(file);
        return { exists: true, bytes: bytes.length, sha256: sha256(bytes), text: bytes.toString('utf8') };
    } catch {
        return { exists: false };
    }
}

/** Backup names with the wall-clock timestamp normalised; content digests kept (they must be equal). */
async function backupsState(dir) {
    const entries = await census(dir).catch(() => []);
    return entries
        .filter(entry => entry.path.endsWith('.jsonl'))
        .map(entry => ({ name: entry.path.replace(TS, '_<TS>.jsonl'), sha256: entry.sha256, bytes: entry.bytes }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

async function stopAndReboot(subject, dataRoot, binary) {
    const exit = await subject.server.stop();
    const server = subject.kind === 'pinned'
        ? await bootPinned({ dataRoot, label: `${subject.kind}-reboot` })
        : await bootGotavern({ dataRoot, binary, label: `${subject.kind}-reboot` });
    const client = await makeClient(server.baseURL);
    return { kind: subject.kind, server, client, exit };
}

// ---------------------------------------------------------------------------------------------------
// CHAT MATRIX (the scenario order and payloads are those of a20-probe-chat-integrity.mjs)
// ---------------------------------------------------------------------------------------------------
async function runChatLeg(kind, binary) {
    const dataRoot = await freshDataRoot(`differential-${kind}-chat`);
    const userRoot = path.join(dataRoot, 'default-user');
    const chatsDir = path.join(userRoot, 'chats', CARD);
    const chatFile = path.join(chatsDir, `${CHAT}.jsonl`);
    const backupsDir = path.join(userRoot, 'backups');
    const server = kind === 'pinned' ? await bootPinned({ dataRoot, label: 'diff-pinned-chat' }) : await bootGotavern({ dataRoot, binary, label: 'diff-gotavern-chat' });
    let client = await makeClient(server.baseURL);
    const subject = { kind, server, client };
    const rows = [];
    const save = async body => {
        const response = await client.request('/api/chats/save', { method: 'POST', json: { avatar_url: AVATAR, file_name: CHAT, ...body } });
        return { status: response.status, bodyText: response.bodyText };
    };
    const row = async (id, fields) => {
        const state = await fileState(chatFile);
        rows.push({ id, ...fields, chatFile: { exists: state.exists, bytes: state.bytes ?? 0, sha256: state.sha256 ?? null }, backups: await backupsState(backupsDir) });
    };

    const a1 = await save({ chat: chatArray() });
    await row('A1-new-file', { status: a1.status, bodyText: a1.bodyText });
    const a2 = await save({ chat: chatArray({ messages: ['diff first message', 'diff second message'] }) });
    await row('A2-matching-overwrite', { status: a2.status, bodyText: a2.bodyText });
    const a3 = await save({ chat: chatArray({ integrity: 'diff-slug-beta', messages: ['refused'] }) });
    await row('A3-mismatch-no-force', { status: a3.status, bodyText: a3.bodyText });
    const a4 = await save({ chat: chatArray({ integrity: 'diff-slug-beta' }), force: false });
    await row('A4-force-false', { status: a4.status, bodyText: a4.bodyText });
    await delay(11000); // let the trailing throttle backup fire so the next row's census is stable
    await row('A5-throttle-settled', { status: null, bodyText: null });
    const a6 = await save({ chat: chatArray({ integrity: 'diff-slug-beta', messages: ['forced'] }), force: true });
    await row('A6-force-true', { status: a6.status, bodyText: a6.bodyText });
    const a7 = await save({ chat: chatArray({ integrity: null, messages: ['legacy'] }) });
    await row('A7-legacy-no-slug', { status: a7.status, bodyText: a7.bodyText });
    const a8 = await save({ chat: { not: 'an array' } });
    await row('A8-non-array', { status: a8.status, bodyText: a8.bodyText });
    await fsp.mkdir(chatsDir, { recursive: true });
    await fsp.writeFile(chatFile, '\uFEFF' + JSON.stringify({ chat_metadata: { integrity: 'diff-bom' }, user_name: 'x', character_name: 'y' }) + '\n', 'utf8');
    const a9 = await save({ chat: chatArray({ integrity: 'diff-bom', messages: ['over bom'] }) });
    await row('A9-bom-header', { status: a9.status, bodyText: a9.bodyText });
    await fsp.writeFile(chatFile, 'not a json header\n{}\n', 'utf8');
    const a10 = await save({ chat: chatArray({ integrity: 'diff-corrupt' }) });
    await row('A10-corrupt-first-line', { status: a10.status, bodyText: a10.bodyText });
    await fsp.writeFile(chatFile, '', 'utf8');
    const a11 = await save({ chat: chatArray({ integrity: 'diff-empty', messages: ['over empty'] }) });
    await row('A11-empty-file', { status: a11.status, bodyText: a11.bodyText });

    // restart: backups.chat.checkIntegrity=false -> the mismatch is accepted by BOTH subjects
    const checkEdit = await patchConfigLine(dataRoot, 'checkIntegrity: true', 'checkIntegrity: false');
    let reboot = await stopAndReboot(subject, dataRoot, binary);
    client = reboot.client;
    const b1 = await save({ chat: chatArray({ integrity: 'diff-zeta', messages: ['checkIntegrity false'] }) });
    await row('B1-checkIntegrity-false', { status: b1.status, bodyText: b1.bodyText, configEdit: checkEdit });
    // restart: backups.chat.enabled=false -> save succeeds, no backup
    const backupEdit = await patchConfigLineAfter(dataRoot, 'backups:', 'enabled: true', 'enabled: false');
    reboot = await stopAndReboot({ ...subject, server: reboot.server, client: reboot.client }, dataRoot, binary);
    client = reboot.client;
    const c1 = await save({ chat: chatArray({ integrity: 'diff-eta', messages: ['backups disabled'] }), force: true });
    await delay(11000);
    await row('C1-backups-disabled', { status: c1.status, bodyText: c1.bodyText, configEdit: backupEdit });
    // restart: read back through the product
    reboot = await stopAndReboot({ ...subject, server: reboot.server, client: reboot.client }, dataRoot, binary);
    client = reboot.client;
    const readBack = await client.request('/api/chats/get', { method: 'POST', json: { avatar_url: AVATAR, file_name: CHAT } });
    let parsed = null;
    try { parsed = JSON.parse(readBack.bodyText); } catch { parsed = null; }
    rows.push({ id: 'D1-restart-readback', status: readBack.status, bodyText: null, messageCount: Array.isArray(parsed) ? parsed.length - 1 : null, firstLine: null, chatFile: null, backups: null });
    await reboot.server.stop();
    return rows;
}

// ---------------------------------------------------------------------------------------------------
// GROUP MATRIX (the scenario order and payloads are those of a20-probe-group-backup.mjs)
// ---------------------------------------------------------------------------------------------------
async function runGroupLeg(kind, binary) {
    const dataRoot = await freshDataRoot(`differential-${kind}-group`);
    const userRoot = path.join(dataRoot, 'default-user');
    const groupChatsDir = path.join(userRoot, 'group chats');
    const backupsDir = path.join(userRoot, 'backups');
    const groupFile = path.join(groupChatsDir, `${GROUP_ID}.jsonl`);
    const server = kind === 'pinned' ? await bootPinned({ dataRoot, label: 'diff-pinned-group' }) : await bootGotavern({ dataRoot, binary, label: 'diff-gotavern-group' });
    let client = await makeClient(server.baseURL);
    const subject = { kind, server, client };
    const rows = [];
    const save = async body => {
        const response = await client.request('/api/chats/group/save', { method: 'POST', json: body });
        return { status: response.status, bodyText: response.bodyText };
    };
    const row = async (id, fields) => {
        const state = await fileState(groupFile);
        rows.push({ id, ...fields, chatFile: { exists: state.exists, bytes: state.bytes ?? 0, sha256: state.sha256 ?? null }, backups: await backupsState(backupsDir) });
    };

    const g1 = await save({ chat: groupArray() });
    rows.push({ id: 'G1-missing-id', status: g1.status, bodyText: g1.bodyText, chatFile: null, backups: null });
    const g2 = await save({ id: GROUP_ID, chat: { not: 'array' } });
    rows.push({ id: 'G2-non-array', status: g2.status, bodyText: g2.bodyText, chatFile: null, backups: null });
    const g3 = await save({ id: GROUP_ID, chat: groupArray() });
    await row('G3-new-group', { status: g3.status, bodyText: g3.bodyText });
    const g4 = await save({ id: GROUP_ID, chat: groupArray({ messages: ['diff group message', 'second'] }) });
    await row('G4-matching-overwrite', { status: g4.status, bodyText: g4.bodyText });
    const g5 = await save({ id: GROUP_ID, chat: groupArray({ integrity: 'diff-group-beta', messages: ['refused'] }) });
    await row('G5-mismatch', { status: g5.status, bodyText: g5.bodyText });
    await delay(11000);
    await row('G6-throttle-settled', { status: null, bodyText: null });
    const g7 = await save({ id: GROUP_ID, chat: groupArray({ integrity: 'diff-group-beta', messages: ['forced'] }), force: true });
    await row('G7-force', { status: g7.status, bodyText: g7.bodyText });

    // flush-on-close: two forced saves then a graceful stop; the pending trailing backup must appear ACROSS
    // the stop boundary with the last payload's bytes.
    await delay(11000);
    const beforeFlush = await backupsState(backupsDir);
    const f1 = await save({ id: GROUP_ID, chat: groupArray({ integrity: 'diff-group-beta', messages: ['flush one'] }), force: true });
    const f2 = await save({ id: GROUP_ID, chat: groupArray({ integrity: 'diff-group-beta', messages: ['flush two'] }), force: true });
    const beforeStop = await backupsState(backupsDir);
    const stopResult = await subject.server.stop();
    const afterFlush = await backupsState(backupsDir);
    rows.push({
        id: 'G8-flush-on-close',
        status: [f1.status, f2.status],
        bodyText: [f1.bodyText, f2.bodyText],
        backupsAddedBeforeStop: beforeStop.length - beforeFlush.length,
        backupsFlushedAcrossExit: afterFlush.length - beforeStop.length,
        flushedBackup: afterFlush.find(entry => !beforeStop.some(previous => previous.name === entry.name)) ?? null,
        exit: stopResult,
        chatFile: null,
        backups: afterFlush,
    });

    // restart: read back + retention (maxTotalBackups=2, throttle 1500) across group and character chats
    const server2 = kind === 'pinned' ? await bootPinned({ dataRoot, label: 'diff-reboot' }) : await bootGotavern({ dataRoot, binary, label: 'diff-reboot' });
    client = await makeClient(server2.baseURL);
    subject.server = server2;
    subject.client = client;
    const readBack = await client.request('/api/chats/group/get', { method: 'POST', json: { id: GROUP_ID } });
    let parsed = null;
    try { parsed = JSON.parse(readBack.bodyText); } catch { parsed = null; }
    rows.push({ id: 'G9-restart-readback', status: readBack.status, bodyText: null, messageCount: Array.isArray(parsed) ? parsed.length - 1 : null, firstMessage: Array.isArray(parsed) ? parsed[1]?.mes ?? null : null, chatFile: null, backups: null });

    // retention: the quota is shared with character chats
    const maxEdit = await patchConfigLine(dataRoot, 'maxTotalBackups: -1', 'maxTotalBackups: 2');
    const throttleEdit = await patchConfigLine(dataRoot, 'throttleInterval: 10000', 'throttleInterval: 1500');
    const stopRetention = await subject.server.stop();
    const server3 = kind === 'pinned' ? await bootPinned({ dataRoot, label: 'diff-retention' }) : await bootGotavern({ dataRoot, binary, label: 'diff-retention' });
    client = await makeClient(server3.baseURL);
    subject.server = server3;
    subject.client = client;
    const retentionBackups = [];
    for (const [index, delayMs] of [[1, 0], [2, 2000], [3, 2000], [4, 2000]]) {
        if (delayMs) await delay(delayMs);
        if (index === 4) {
            const response = await client.request('/api/chats/save', { method: 'POST', json: { avatar_url: AVATAR, file_name: CHAT, chat: groupArray({ messages: [`retention normal ${index}`] }), force: true } });
            retentionBackups.push({ index, kind: 'character-chat', status: response.status, backups: await backupsState(backupsDir) });
        } else {
            const response = await save({ id: GROUP_ID, chat: groupArray({ messages: [`retention group ${index}`] }), force: true });
            retentionBackups.push({ index, kind: 'group-chat', status: response.status, backups: await backupsState(backupsDir) });
        }
    }
    rows.push({ id: 'G10-retention-shared-quota', status: retentionBackups.map(entry => entry.status), bodyText: null, configEdits: [maxEdit, throttleEdit], restart: stopRetention, retention: retentionBackups, chatFile: null, backups: null });

    // broken backup directory: save must still succeed and persist
    await fsp.rename(backupsDir, path.join(userRoot, 'backups.diff-renamed'));
    await fsp.writeFile(backupsDir, 'probe: a file where the backups directory should be', 'utf8');
    const g12 = await save({ id: GROUP_ID, chat: groupArray({ messages: ['broken backups dir'] }), force: true });
    const stateAfter = await fileState(groupFile);
    await fsp.rm(backupsDir, { force: true });
    await fsp.rename(path.join(userRoot, 'backups.diff-renamed'), backupsDir);
    rows.push({ id: 'G11-broken-backups-dir', status: g12.status, bodyText: g12.bodyText, chatFile: { exists: stateAfter.exists, bytes: stateAfter.bytes ?? 0, sha256: stateAfter.sha256 ?? null }, backups: null });
    await subject.server.stop();
    return rows;
}

// ---------------------------------------------------------------------------------------------------
// COMPARISON
// ---------------------------------------------------------------------------------------------------
const IGNORED_FIELDS = new Set(['id']);
function compareRows(pinnedRows, gotavernRows, label) {
    const comparisons = [];
    for (const pinned of pinnedRows) {
        const gotavern = gotavernRows.find(entry => entry.id === pinned.id);
        if (!gotavern) {
            comparisons.push({ scenario: pinned.id, match: false, reason: 'missing on the GoTavern leg' });
            continue;
        }
        const fields = [...new Set([...Object.keys(pinned), ...Object.keys(gotavern)])].filter(field => !IGNORED_FIELDS.has(field));
        const differences = [];
        for (const field of fields) {
            const left = stableStringify(pinned[field] ?? null);
            const right = stableStringify(gotavern[field] ?? null);
            if (left !== right) differences.push({ field, pinned: pinned[field] ?? null, gotavern: gotavern[field] ?? null });
        }
        comparisons.push({ scenario: pinned.id, match: differences.length === 0, differences });
    }
    const mismatches = comparisons.filter(entry => !entry.match);
    return {
        matrix: label,
        scenarios: comparisons.length,
        matches: comparisons.length - mismatches.length,
        mismatches: mismatches.length,
        verdict: mismatches.length === 0 ? 'MATCH' : 'DIFFERENT',
        rowsWithMismatch: mismatches,
    };
}

let binary = null;
const results = {};
try {
    binary = await buildGotavern({ out: path.join(SCRATCH_ROOT, 'bin', 'gotavern-differential.exe') });
    const pinnedChat = await runChatLeg('pinned', binary.binary);
    const goChat = await runChatLeg('gotavern', binary.binary);
    results.chat = compareRows(pinnedChat, goChat, 'chat-integrity');
    const pinnedGroup = await runGroupLeg('pinned', binary.binary);
    const goGroup = await runGroupLeg('gotavern', binary.binary);
    results.group = compareRows(pinnedGroup, goGroup, 'group-save-backup');

    const doc = {
        ...finishHeader(header),
        pinned: { commit: PINNED_COMMIT },
        gotavern: { binarySha256: binary.sha256, binary: path.basename(binary.binary) },
        dataRootTemplate: await templateCensus(),
        method: {
            subjects: 'the READ-ONLY pinned checkout and the current worktree GoTavern binary, each over its own fresh data-root copy of the recorded pinned template',
            tuple: 'status, exact response body bytes, persisted chat-file sha256/bytes, backup file names with the wall-clock timestamp normalised to <TS>, backup content sha256, restart/read-back outcomes, flush/retention outcomes',
            normalisation: 'ONLY the backup filename timestamp `_YYYYMMDD-HHMMSS` is replaced with `_<TS>` (wall-clock by design, pinned source generateTimestamp). Response bodies are compared as bytes; chat files by sha256.',
            pinnedLegRows: pinnedChat,
            gotavernLegRows: goChat,
            pinnedGroupRows: pinnedGroup,
            gotavernGroupRows: goGroup,
        },
        results,
        verdict: results.chat.verdict === 'MATCH' && results.group.verdict === 'MATCH' ? 'MATCH' : 'DIFFERENT',
    };
    const chatDoc = { ...doc, matrix: results.chat, pinnedLegRows: pinnedChat, gotavernLegRows: goChat, results: { chat: results.chat } };
    const groupDoc = { ...doc, matrix: results.group, pinnedGroupRows: pinnedGroup, gotavernGroupRows: goGroup, results: { group: results.group } };
    const chatFile = await writeDocument('chat-integrity', 'differential.json', chatDoc);
    const groupFile = await writeDocument('group-save-backup', 'differential.json', groupDoc);
    console.log(`chat differential: ${results.chat.verdict} (${results.chat.matches}/${results.chat.scenarios}) -> ${chatFile.file}`);
    console.log(`group differential: ${results.group.verdict} (${results.group.matches}/${results.group.scenarios}) -> ${groupFile.file}`);
    if (results.chat.mismatches > 0) console.log(JSON.stringify(results.chat.rowsWithMismatch, null, 1).slice(0, 4000));
    if (results.group.mismatches > 0) console.log(JSON.stringify(results.group.rowsWithMismatch, null, 1).slice(0, 4000));
} finally {
    if (binary) { /* binary stays in scratch; the sha256 is the evidence */ }
}
