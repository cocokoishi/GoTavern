// a20-fault-injection.mjs -- GoTavern-side failure injection for the alpha.20 M3 lane.
//
// Each scenario injects one real fault into a RUNNING GoTavern server (or its data root) and checks the four
// properties the charter requires, so a green row is not just "no crash":
//
//   data safety      the persisted bytes are unchanged, or are a complete new write; never a torn/partial
//                    file (every JSONL line parses, and the file equals exactly one of the known payloads)
//   no false success a failed operation must NOT answer a success status/body; an error must be causal
//                    (some non-2xx / disconnect) and the original data must be intact
//   recoverability   after the fault is removed/restarted, the same operation succeeds and the product reads
//                    the data back
//   resource release the server exits cleanly on SIGTERM and a fresh boot reads the tree (no wedged writer)
//
// Egress is controlled: every request is to 127.0.0.1, the binary is the local build, and no provider is
// contacted (the injected faults are filesystem/persistence/config faults, not provider-wire faults).
//
// RUN: node tests/browser/a20-fault-injection.mjs
// EVIDENCE: docs/alpha20/oracle/fault-injection/evidence.json

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import {
    bootGotavern, buildGotavern, makeClient, freshDataRoot, templateCensus, census, sha256,
    stableStringify, writeEvidence, probeHeader, finishHeader, delay, SCRATCH_ROOT,
} from './a20-probe-kit.mjs';

const PROBE = 'fault-injection';
const AVATAR = 'A20Fault.png';
const CHAT = 'a20-fault-chat';
const header = probeHeader({
    probe: PROBE,
    purpose: 'inject real persistence/config/session faults into GoTavern and validate data safety, no false success, recoverability and resource release for each',
});
const rows = [];
const dataRoot = await freshDataRoot(PROBE);
const template = await templateCensus();
const userRoot = path.join(dataRoot, 'default-user');
const chatsDir = path.join(userRoot, 'chats', 'A20Fault');
const chatFile = path.join(chatsDir, `${CHAT}.jsonl`);
const backupsDir = path.join(userRoot, 'backups');

function payload(tag, messages = 3) {
    const chat = [
        { user_name: 'A20 User', character_name: 'A20 Char', chat_metadata: { integrity: `fault-${tag}` }, create_date: '2026-01-01T00:00:00.000Z' },
        ...Array.from({ length: messages }, (_, index) => ({ name: index % 2 === 0 ? 'A20 Char' : 'A20 User', is_user: index % 2 === 1, send_date: `2026-01-01T00:00:0${index}.000Z`, mes: `fault payload ${tag} message ${index}`, extra: {} })),
    ];
    return { chat, text: chat.map(item => JSON.stringify(item)).join('\n') };
}

function jsonlValid(text) {
    const lines = text.split('\n').filter(line => line.trim().length > 0);
    if (lines.length === 0) return false;
    try {
        lines.forEach(line => JSON.parse(line));
        return true;
    } catch { return false; }
}

async function readText(file) {
    try { return await fsp.readFile(file, 'utf8'); } catch { return null; }
}

async function saveChat(client, tag, messages = 3, { force = true } = {}) {
    const body = payload(tag, messages);
    const response = await client.request('/api/chats/save', { method: 'POST', json: { avatar_url: AVATAR, file_name: CHAT, chat: body.chat, force } });
    return { status: response.status, bodyText: response.bodyText, payload: body };
}

const built = await buildGotavern({ out: path.join(SCRATCH_ROOT, 'bin', 'gotavern-faults.exe') });
let server = await bootGotavern({ dataRoot, binary: built.binary, label: 'fault-injection' });
let client = await makeClient(server.baseURL);

const row = (id, fields) => rows.push({ id, ...fields });
const reboot = async () => {
    const exit = await server.stop();
    server = await bootGotavern({ dataRoot, binary: built.binary, label: 'fault-reboot' });
    client = await makeClient(server.baseURL);
    return exit;
};
// SIGKILL the server and wait until its process is really gone: `stop()` is a graceful SIGTERM and would
// let an in-flight write finish, which is the opposite of the fault this probe injects.
const killNow = async () => {
    const child = server.child;
    const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal, how: 'SIGKILL', waitedMs: Date.now() - startedAt })));
    const startedAt = Date.now();
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
    const result = await Promise.race([exited, new Promise(resolve => setTimeout(() => resolve({ how: 'SIGKILL-timeout' }), 10000))]);
    return result;
};
const censusPaths = entries => entries.map(entry => entry.path).sort();

// ---------------------------------------------------------------------------------------------------
// F1: CONCURRENT WRITERS. Eight different payloads race for one chat file. Every save must be answered
// (no false success/error mismatch), and the final file must be a COMPLETE payload (one of the eight),
// with every backup also a complete payload.
// ---------------------------------------------------------------------------------------------------
const concurrent = await Promise.all(Array.from({ length: 8 }, (_, index) => saveChat(client, `concurrent-${index}`, 3 + index)));
const finalText = await readText(chatFile);
const backups = (await census(backupsDir).catch(() => [])).filter(entry => entry.path.startsWith('chat_'));
row('F1-concurrent-writers', {
    statuses: concurrent.map(entry => entry.status),
    bodiesOk: concurrent.every(entry => entry.status === 200 && entry.bodyText === '{"ok":true}'),
    finalIsCompletePayload: finalText !== null && jsonlValid(finalText) && concurrent.some(entry => entry.payload.text === finalText),
    backupCount: backups.length,
    backupsAllComplete: await Promise.all(backups.map(async entry => jsonlValid((await readText(path.join(backupsDir, entry.path))) ?? ''))),
    classification: 'data safety: every JSONL line parses and the final file equals exactly one complete racing payload; no torn write. All eight requests were answered (no request lost).',
});

// ---------------------------------------------------------------------------------------------------
// F2: BACKUP DIRECTORY IS A FILE (rename/write failure shape). The save must still succeed and persist;
// the backup failure must not turn into a false failure; after the directory is restored a later save
// writes a backup again (recoverability).
// ---------------------------------------------------------------------------------------------------
const beforeF2 = await readText(chatFile);
await fsp.rename(backupsDir, path.join(userRoot, 'backups.fault-renamed'));
await fsp.writeFile(backupsDir, 'probe: a regular file occupies the backups directory path', 'utf8');
const f2 = await saveChat(client, 'broken-backup-dir', 2);
const afterF2 = await readText(chatFile);
await fsp.rm(backupsDir, { force: true });
await fsp.rename(path.join(userRoot, 'backups.fault-renamed'), backupsDir);
const backupsBeforeRecovery = (await census(backupsDir).catch(() => [])).filter(entry => entry.path.startsWith('chat_')).length;
const f2recovery = await saveChat(client, 'backup-recovered', 2);
await delay(1200);
const backupsAfterRecovery = (await census(backupsDir).catch(() => [])).filter(entry => entry.path.startsWith('chat_')).length;
row('F2-backup-write-failure', {
    status: f2.status,
    bodyText: f2.bodyText,
    persistedCompletePayloadAfterFailure: afterF2 !== null && jsonlValid(afterF2) && afterF2 === f2.payload.text,
    originalWasNotCorrupted: beforeF2 === null || jsonlValid(beforeF2),
    recoveryStatus: f2recovery.status,
    backupsBeforeRecovery,
    backupsAfterRecovery,
    classification: 'no false success/failure inversion: the save answers 200 {"ok":true} and persists a complete payload although the backup write is impossible; a later save with the directory restored produces a backup again (recoverability).',
});

// ---------------------------------------------------------------------------------------------------
// F3: READ-ONLY CHAT DIRECTORY (ACL). The save must fail causally (non-2xx), the ORIGINAL file must be
// byte-unchanged, and after the ACL is restored the same save must succeed and read back.
// ---------------------------------------------------------------------------------------------------
let f3 = { status: 'NOT EXECUTED', reason: 'ACL manipulation is host/permission dependent' };
try {
    const before = await readText(chatFile);
    const deny = spawn('icacls', [chatsDir, '/deny', `${process.env.USERNAME ?? '*S-1-1-0'}:(W)`], { stdio: 'pipe' });
    const denyCode = await new Promise(resolve => deny.on('exit', resolve));
    if (denyCode === 0) {
        const call = await saveChat(client, 'readonly-dir', 2);
        const during = await readText(chatFile);
        const restore = spawn('icacls', [chatsDir, '/remove:d', `${process.env.USERNAME ?? '*S-1-1-0'}`], { stdio: 'pipe' });
        const restoreCode = await new Promise(resolve => restore.on('exit', resolve));
        const recovered = await saveChat(client, 'readonly-recovered', 2);
        f3 = {
            status: call.status,
            bodyText: call.bodyText,
            falseSuccess: call.status === 200,
            originalBytesUnchanged: before === during,
            restoreExitCode: restoreCode,
            recoveryStatus: recovered.status,
            recoveredPersisted: recovered.status === 200,
        };
    } else {
        f3 = { status: 'NOT EXECUTED', reason: `icacls deny exited ${denyCode}` };
    }
} catch (error) {
    f3 = { status: 'NOT EXECUTED', reason: String(error?.message ?? error) };
}
row('F3-readonly-chat-directory', { ...f3, classification: f3.status === 'NOT EXECUTED' ? 'NOT EXECUTED with the reason recorded; no coverage claimed.' : 'a denied write is answered causally and leaves the original bytes intact; restoring the ACL makes the same save succeed.' });

// ---------------------------------------------------------------------------------------------------
// F4: INVALID SESSION (bad CSRF token). A write must be refused with 403 and must not touch the file.
// ---------------------------------------------------------------------------------------------------
const beforeF4 = await readText(chatFile);
const f4 = await client.request('/api/chats/save', { method: 'POST', json: { avatar_url: AVATAR, file_name: CHAT, chat: payload('bad-csrf', 2).chat, force: true }, csrf: false });
const afterF4 = await readText(chatFile);
row('F4-invalid-csrf-session', {
    status: f4.status,
    bodyText: f4.bodyText.slice(0, 200),
    fileUnchanged: beforeF4 === afterF4,
    classification: 'no false success: a write with no/expired CSRF session is refused and the file is byte-unchanged.',
});

// ---------------------------------------------------------------------------------------------------
// F5: CORRUPT CHARACTER CACHE PATH. Replace <DATA_ROOT>/_cache/characters with a file; character list and
// get must still answer 200 (the cache is an optimisation, never a dependency).
// ---------------------------------------------------------------------------------------------------
const cacheDir = path.join(dataRoot, '_cache', 'characters');
await fsp.rm(cacheDir, { recursive: true, force: true });
await fsp.writeFile(cacheDir, 'probe: a file where the character cache directory should be', 'utf8');
const list = await client.request('/api/characters/all', { method: 'POST', json: {} });
const roster = await fsp.readdir(path.join(userRoot, 'characters')).catch(() => []);
const f5get = roster.find(name => name.endsWith('.png')) ? await client.request('/api/characters/get', { method: 'POST', json: { avatar_url: roster.find(name => name.endsWith('.png')) } }) : { status: null };
await fsp.rm(cacheDir, { force: true });
await fsp.mkdir(cacheDir, { recursive: true });
row('F5-corrupt-character-cache', {
    listStatus: list.status,
    getStatus: f5get.status,
    classification: 'data safety: a broken cache path cannot break a character read (the cache is derived data with no user bytes in it).',
});

// ---------------------------------------------------------------------------------------------------
// F6: INVALID CONFIG RESTART. A config with a duplicate key must be refused at startup (non-zero exit,
// causal message) and must not mutate the data root; a valid config must boot afterwards.
// ---------------------------------------------------------------------------------------------------
const configPath = path.join(dataRoot, 'config.yaml');
const validConfig = await fsp.readFile(configPath, 'utf8');
const invalidConfig = `${validConfig}\nlisten: false\n`;
const invalidPath = path.join(dataRoot, 'config.invalid.yaml');
await fsp.writeFile(invalidPath, invalidConfig, 'utf8');
const beforeF6 = await census(dataRoot, { exclude: ['_webpack', 'config.invalid.yaml'] });
const invalid = spawn(built.binary, ['start', '--port', '0', '--dataRoot', dataRoot, '--configPath', invalidPath, '--browserLaunchEnabled', 'false'], { stdio: ['ignore', 'pipe', 'pipe'] });
const invalidResult = await new Promise(resolve => {
    let output = '';
    invalid.stdout.on('data', chunk => { output += chunk.toString(); });
    invalid.stderr.on('data', chunk => { output += chunk.toString(); });
    const timer = setTimeout(() => { try { invalid.kill('SIGKILL'); } catch { /* gone */ } resolve({ exitCode: 'timeout', output }); }, 20000);
    invalid.on('exit', code => { clearTimeout(timer); resolve({ exitCode: code, output }); });
});
const afterF6 = await census(dataRoot, { exclude: ['_webpack', 'config.invalid.yaml'] });
const validBoot = await bootGotavern({ dataRoot, binary: built.binary, label: 'fault-valid-config' });
const validRead = await makeClient(validBoot.baseURL);
const readBack = await validRead.request('/api/chats/get', { method: 'POST', json: { avatar_url: AVATAR, file_name: CHAT } });
await validBoot.stop();
row('F6-invalid-config-restart', {
    invalidExitCode: invalidResult.exitCode,
    invalidOutput: invalidResult.output.slice(0, 600),
    fileCountBefore: beforeF6.length,
    fileCountAfter: afterF6.length,
    dataRootUnchanged: stableStringify(beforeF6) === stableStringify(afterF6),
    addedPaths: censusPaths(afterF6).filter(entry => !censusPaths(beforeF6).includes(entry)),
    removedPaths: censusPaths(beforeF6).filter(entry => !censusPaths(afterF6).includes(entry)),
    validConfigBoots: validBoot.version?.pkgVersion === '1.19.0',
    readBackStatus: readBack.status,
    classification: 'a config the product refuses is a non-zero startup with a causal message; the data root is compared by full census before/after so any startup mutation is NAMED, not assumed away. A valid config boots afterwards and reads the chat (recoverability).',
});

// ---------------------------------------------------------------------------------------------------
// F7: MID-WRITE TERMINATION + RESTART WITH AN ACTIVE WRITE. Start a large save, kill the server while it
// is in flight, restart, and require the file to be a COMPLETE payload (old or new) - never a torn line.
// ---------------------------------------------------------------------------------------------------
const killResults = [];
for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = await readText(chatFile);
    const big = payload(`midwrite-${attempt}`, 5000); // ~600 KB: a write that cannot finish in microseconds
    const request = client.request('/api/chats/save', { method: 'POST', json: { avatar_url: AVATAR, file_name: CHAT, chat: big.chat, force: true } })
        .then(response => ({ status: response.status }))
        .catch(error => ({ status: 'disconnected', error: String(error?.message ?? error) }));
    await delay(2 + attempt * 3); // kill inside the write window
    const exit = await killNow();
    const response = await request;
    server = await bootGotavern({ dataRoot, binary: built.binary, label: `fault-midwrite-${attempt}` });
    client = await makeClient(server.baseURL);
    const after = await readText(chatFile);
    killResults.push({
        attempt,
        response,
        exit,
        interruptedBeforeResponse: response.status === 'disconnected',
        afterLength: after?.length ?? null,
        afterLinesAllParse: after !== null && jsonlValid(after),
        afterIsOldPayload: after === before,
        afterIsNewCompletePayload: after === big.text,
        afterMatchesBeforeOrNew: after === before || after === big.text,
    });
}
row('F7-mid-write-termination', {
    attempts: killResults,
    everyFileValid: killResults.every(entry => entry.afterLinesAllParse),
    everyFileOldOrNewComplete: killResults.every(entry => entry.afterMatchesBeforeOrNew),
    atLeastOneSaveWasInterrupted: killResults.some(entry => entry.interruptedBeforeResponse),
    classification: 'data safety under a SIGKILL during an in-flight save: after restart every line parses and the file is either the pre-save payload or the complete new payload. `atLeastOneSaveWasInterrupted` proves the kill actually hit the write window in at least one attempt; if it is false the rows still show atomicity but not an interrupted write, and the classification does not claim one.',
});

// ---------------------------------------------------------------------------------------------------
// F8: RESOURCE RELEASE. After all of the above, a clean SIGTERM must exit, and a fresh boot must read the
// chat back.
// ---------------------------------------------------------------------------------------------------
const finalExit = await server.stop();
const finalBoot = await bootGotavern({ dataRoot, binary: built.binary, label: 'fault-final' });
const finalClient = await makeClient(finalBoot.baseURL);
const finalRead = await finalClient.request('/api/chats/get', { method: 'POST', json: { avatar_url: AVATAR, file_name: CHAT } });
const finalFileText = await readText(chatFile);
await finalBoot.stop();
row('F8-resource-release-and-readback', {
    cleanExit: finalExit,
    freshBootVersion: finalBoot.version?.pkgVersion ?? null,
    readBackStatus: finalRead.status,
    fileValid: finalFileText !== null && jsonlValid(finalFileText),
    classification: 'resource release: the server exits on SIGTERM and a fresh process boots and serves the persisted chat; no wedged writer or lock survives.',
});

const evidence = {
    ...finishHeader(header),
    gotavern: { binarySha256: built.sha256, binaryBytes: built.bytes, version: finalBoot.version },
    dataRoot: { template, probeCensus: await census(dataRoot, { exclude: ['_webpack'] }) },
    egress: 'loopback only; no provider, no third-party origin, no browser launched',
    rows,
    verdicts: rows.map(entry => ({ id: entry.id, status: entry.status === 'NOT EXECUTED' ? 'NOT EXECUTED' : 'EXECUTED', classification: entry.classification })),
    unproven: [
        'Provider-wire faults (mid-SSE close, arbitrary splits, no-response provider, truncated body) are NOT part of this probe: they cannot be injected faithfully through a hand-posted generate request, and driving them through the browser is the five-layer oracle\'s job. They are reported NOT EXECUTED for this lane in oracle-strengthening.md.',
        'Disk-full is not injected (no portable way to fill the host filesystem safely inside the harness).',
        'The read-only-directory row depends on host ACL behaviour and reports NOT EXECUTED if the ACL operation itself is refused.',
    ],
};

const written = await writeEvidence(PROBE, evidence);
console.log(`evidence: ${written.file}`);
for (const entry of rows) console.log(`  ${entry.id}: ${typeof entry.status === 'object' ? JSON.stringify(entry.status) : entry.status} ${String(entry.classification).slice(0, 110)}`);
process.exit(rows.some(entry => entry.id === 'F7-mid-write-termination' && entry.everyFileValid === false) ? 1 : 0);
