// a20-backup-window.mjs -- answer ONE question with a real experiment: is a save made ~10.5 s after the
// previous save a LEADING invocation (writes a backup immediately) on BOTH subjects, or is GoTavern still
// inside its throttle window (writes the backup later as a trailing invocation)?
//
// It also records, for each subject, WHICH config file it was booted with, its sha256, and the resolved
// backups.chat values parsed from that file, so the differential's backup-scheduler row can be classified
// as a product difference or a harness-fidelity gap.
//
// RUN: node tests/browser/a20-backup-window.mjs
// EVIDENCE: docs/alpha20/oracle/backup-window/evidence.json

import fsp from 'node:fs/promises';
import path from 'node:path';
import {
    bootPinned, bootGotavern, buildGotavern, makeClient, freshDataRoot, census, sha256,
    writeEvidence, probeHeader, finishHeader, delay, PINNED_COMMIT, SCRATCH_ROOT,
} from './a20-probe-kit.mjs';

const PROBE = 'backup-window';
const header = probeHeader({
    probe: PROBE,
    purpose: 'measure the pinned vs GoTavern backup throttle window boundary with identical config files, and record each subject config path/digest/resolved backups.chat values',
});
const AVATAR = 'A20Window.png';
const CHAT = 'a20-window-chat';

function chatPayload(tag) {
    const chat = [
        { user_name: 'A20 User', character_name: 'A20 Char', chat_metadata: { integrity: `window-${tag}` }, create_date: '2026-01-01T00:00:00.000Z' },
        { name: 'A20 Char', is_user: false, send_date: '2026-01-01T00:00:00.000Z', mes: `window ${tag}`, extra: {} },
    ];
    return { chat, text: chat.map(item => JSON.stringify(item)).join('\n') };
}

function parseBackupConfig(configText) {
    const lines = String(configText).split('\n');
    const section = { file: 'config.yaml' };
    let inBackups = false;
    let inChat = false;
    for (const line of lines) {
        if (/^backups:\s*$/.test(line)) { inBackups = true; inChat = false; continue; }
        if (inBackups && /^\s+chat:\s*$/.test(line)) { inChat = true; continue; }
        if (inBackups && inChat) {
            const match = line.match(/^\s+(enabled|checkIntegrity|maxTotalBackups|throttleInterval):\s*(.+?)\s*$/);
            if (match) section[match[1]] = match[2];
            if (/^\S/.test(line)) { inBackups = false; inChat = false; }
        }
    }
    return section;
}

async function backupFiles(dir) {
    const entries = await census(dir).catch(() => []);
    return entries.filter(entry => entry.path.endsWith('.jsonl')).map(entry => ({ name: entry.path, sha256: entry.sha256, mtime: entry.mtime ?? null }));
}

async function settle(dir, { stableForMs = 2500, timeoutMs = 20000 } = {}) {
    const started = Date.now();
    let last = null;
    let lastChange = Date.now();
    while (Date.now() - started < timeoutMs) {
        const signature = JSON.stringify(await backupFiles(dir));
        if (last === null) { last = signature; lastChange = Date.now(); }
        else if (signature !== last) { last = signature; lastChange = Date.now(); }
        else if (Date.now() - lastChange >= stableForMs) return true;
        await delay(200);
    }
    return false;
}

async function runSubject(kind, binary) {
    const dataRoot = await freshDataRoot(`backup-window-${kind}`);
    const userRoot = path.join(dataRoot, 'default-user');
    const backupsDir = path.join(userRoot, 'backups');
    const configPath = path.join(dataRoot, 'config.yaml');
    const configText = await fsp.readFile(configPath, 'utf8');
    const config = parseBackupConfig(configText);
    const server = kind === 'pinned'
        ? await bootPinned({ dataRoot, label: 'pinned-window', readyTimeoutMs: 240000 })
        : await bootGotavern({ dataRoot, binary, label: 'gotavern-window' });
    const client = await makeClient(server.baseURL);
    const save = async tag => {
        const body = chatPayload(tag);
        const response = await client.request('/api/chats/save', { method: 'POST', json: { avatar_url: AVATAR, file_name: CHAT, chat: body.chat, force: true } });
        return { status: response.status, bodyText: response.bodyText, payload: body };
    };
    await settle(backupsDir);
    const timeline = {};
    const beforeFirst = await backupFiles(backupsDir);
    timeline.firstSaveAt = new Date().toISOString();
    const first = await save('first');
    await delay(500);
    const afterFirst = await backupFiles(backupsDir);
    timeline.firstLeadingBackupImmediate = afterFirst.length - beforeFirst.length;
    timeline.firstSaveStatus = first.status;
    // The measured interval: the pinned default throttle is 10000 ms; use 10500 ms so a correct leading edge
    // is unambiguously outside the window, and 1500 ms later also probe an inside-window save for contrast.
    await delay(10500);
    const beforeSecond = await backupFiles(backupsDir);
    timeline.secondSaveAt = new Date().toISOString();
    timeline.sinceFirstSaveMs = 10500;
    const second = await save('second');
    await delay(700);
    const afterSecond = await backupFiles(backupsDir);
    const secondImmediate = afterSecond.filter(file => !beforeSecond.some(previous => previous.name === file.name));
    timeline.secondLeadingBackupImmediate = secondImmediate.length;
    timeline.secondSaveStatus = second.status;
    timeline.secondImmediateShaMatchesPayload = secondImmediate.length === 1 && secondImmediate[0].sha256 === sha256(Buffer.from(second.payload.text, 'utf8'));
    await settle(backupsDir);
    const settled = await backupFiles(backupsDir);
    const trailing = settled.filter(file => !afterSecond.some(previous => previous.name === file.name));
    timeline.secondTrailingBackupAfterSettle = trailing.length;
    timeline.secondTrailingShaMatchesPayload = trailing.map(file => file.sha256).includes(sha256(Buffer.from(second.payload.text, 'utf8')));
    // Inside-window contrast: save again only 1500 ms after the second one.
    const beforeInside = await backupFiles(backupsDir);
    timeline.insideSaveAt = new Date().toISOString();
    const inside = await save('inside-window');
    await delay(700);
    const afterInside = await backupFiles(backupsDir);
    const insideImmediate = afterInside.filter(file => !beforeInside.some(previous => previous.name === file.name));
    timeline.insideLeadingBackupImmediate = insideImmediate.length;
    timeline.insideSaveStatus = inside.status;
    await settle(backupsDir);
    const afterInsideSettled = await backupFiles(backupsDir);
    const insideTrailing = afterInsideSettled.filter(file => !afterInside.some(previous => previous.name === file.name));
    timeline.insideTrailingBackupAfterSettle = insideTrailing.length;
    const exit = await server.stop();
    return {
        kind,
        configPath: 'config.yaml',
        configSha256: sha256(Buffer.from(configText, 'utf8')),
        resolvedBackupConfig: config,
        bootExit: exit,
        timeline,
        backupCount: (await backupFiles(backupsDir)).length,
        backupShas: (await backupFiles(backupsDir)).map(file => file.sha256).sort(),
    };
}

const binary = await buildGotavern({ out: path.join(SCRATCH_ROOT, 'bin', 'gotavern-window.exe') });
const pinned = await runSubject('pinned', binary.binary);
const gotavern = await runSubject('gotavern', binary.binary);
const sameConfig = pinned.configSha256 === gotavern.configSha256
    && pinned.resolvedBackupConfig.enabled === gotavern.resolvedBackupConfig.enabled
    && pinned.resolvedBackupConfig.checkIntegrity === gotavern.resolvedBackupConfig.checkIntegrity
    && pinned.resolvedBackupConfig.throttleInterval === gotavern.resolvedBackupConfig.throttleInterval;
const evidence = {
    ...finishHeader(header),
    pinned: { commit: PINNED_COMMIT },
    gotavern: { binarySha256: binary.sha256 },
    question: 'was the measured save (10500 ms after the previous save in the same throttle key) a LEADING invocation on both subjects, with the same resolved backups.chat config?',
    configIdentity: { sameConfig, pinned: { path: pinned.configPath, sha256: pinned.configSha256, resolved: pinned.resolvedBackupConfig }, gotavern: { path: gotavern.configPath, sha256: gotavern.configSha256, resolved: gotavern.resolvedBackupConfig } },
    pinnedTimeline: pinned.timeline,
    gotavernTimeline: gotavern.timeline,
    verdict: (() => {
        if (!sameConfig) return { classification: 'HARNESS-ERROR', reason: 'the two subjects did not receive the same resolved backups.chat config; the differential scheduler row must not be labelled DIFFERENT' };
        const pinnedOk = pinned.timeline.secondLeadingBackupImmediate === 1 && pinned.timeline.secondImmediateShaMatchesPayload === true;
        const goOk = gotavern.timeline.secondLeadingBackupImmediate === 1 && gotavern.timeline.secondImmediateShaMatchesPayload === true;
        if (pinnedOk && goOk) return { classification: 'MATCH', reason: 'with the same resolved config, both subjects perform a leading backup for a save 10500 ms after the previous one' };
        if (pinnedOk && !goOk) return { classification: 'DIFFERENT', reason: 'with the same resolved config, pinned performs a leading backup 10500 ms after the previous save; GoTavern does not (it must still be inside its throttle window)' };
        return { classification: 'MIXED', reason: 'neither the simple MATCH nor the simple pinned-only-leading shape holds; the timelines are recorded verbatim' };
    })(),
    note: 'The inside-window contrast save (1500 ms after the second) is recorded too; it is expected to be throttled (no immediate leading backup) on BOTH subjects and its trailing backup is measured after the window settles.',
};
const written = await writeEvidence(PROBE, evidence);
console.log(`evidence: ${written.file}`);
console.log(JSON.stringify({ sameConfig, verdict: evidence.verdict, pinned: pinned.timeline, gotavern: gotavern.timeline }, null, 1));
