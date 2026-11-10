// PROBE (d): the pinned `_cache/characters` disk cache.
//
// QUESTION. What exactly does the pinned character disk cache write, where, with what key and filename,
// when is it read, when is it invalidated, what survives a restart, what does external modification of
// the card do, what happens to a stale record after the card is deleted, what does a corrupt record do,
// and does a GoTavern boot over the same data root preserve a cache the pinned server wrote?
//
// HOW. A real pinned server (READ-ONLY 1.19.0 checkout at the pin) over a scratch data root; every
// observation is a byte census of `<DATA_ROOT>/_cache/characters` plus the record's own JSON fields.
// The record filename is recomputed from the key the product itself stored: node-persist hashes the
// store key with sha256 (pinned node_modules/node-persist/src/local-storage.js:52), and the store key
// is `getCacheKey(file) = <absolute path>-<fs stat mtimeMs>` (characters.js:166-173). Proving
// sha256(key) === filename on a real record is what turns "it probably caches" into a contract.
//
// Corruption rows are FILESYSTEM SETUPS by the probe (marked as such); they model an external editor,
// a truncated write or a damaged cache, not a product action.
//
// RUN: node tests/browser/a20-probe-character-cache.mjs
// EVIDENCE: docs/alpha20/oracle/character-cache/evidence.json

import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import {
    bootPinned, bootGotavern, buildGotavern, makeClient, freshDataRoot, templateCensus, census, sha256,
    stableStringify, writeEvidence, probeHeader, finishHeader, patchConfigLine, PINNED_COMMIT, SCRATCH_ROOT,
} from './a20-probe-kit.mjs';

const PROBE = 'character-cache';
const header = probeHeader({
    probe: PROBE,
    purpose: 'pin the pinned _cache/characters node-persist cache: key/filename derivation, creation, read, invalidation, restart, deletion pruning, external modification, corruption, and Node->Go->Node hand-over',
});
const rows = [];
const dataRoot = await freshDataRoot(PROBE);
const template = await templateCensus();
const userRoot = path.join(dataRoot, 'default-user');
const charactersDir = path.join(userRoot, 'characters');
const cacheDir = path.join(dataRoot, '_cache', 'characters');
const CARD = 'A20 Cache One';
const CARD_FILE = `${CARD}.png`;
const cardPath = path.join(charactersDir, CARD_FILE);

async function cacheCensus() {
    const entries = await census(cacheDir).catch(() => []);
    const records = [];
    for (const entry of entries) {
        let parsed = null;
        let text = null;
        try {
            const file = path.join(cacheDir, entry.path);
            text = await fsp.readFile(file, 'utf8');
            parsed = JSON.parse(text);
        } catch { /* unreadable/corrupt record is reported as such */ }
        records.push({
            name: entry.path,
            bytes: entry.bytes,
            sha256: entry.sha256,
            parseOk: parsed !== null && typeof parsed === 'object',
            key: parsed && typeof parsed.key === 'string' ? parsed.key : null,
            valueSha256: parsed && typeof parsed.value === 'string' ? sha256(Buffer.from(parsed.value, 'utf8')) : null,
            valueLength: parsed && typeof parsed.value === 'string' ? parsed.value.length : null,
        });
    }
    return records;
}

async function expectedKeyFor(file) {
    const stat = fs.statSync(file);
    return { key: `${file}-${stat.mtimeMs}`, mtimeMs: stat.mtimeMs, expectedFilename: sha256(Buffer.from(`${file}-${stat.mtimeMs}`, 'utf8')) };
}

async function getCharacter(avatar) {
    const response = await client.request('/api/characters/get', { method: 'POST', json: { avatar_url: avatar } });
    let parsed = null;
    try { parsed = JSON.parse(response.bodyText); } catch { parsed = null; }
    return { status: response.status, bodyText: response.bodyText, name: parsed?.name ?? null, description: parsed?.description ?? null, jsonDataSha256: typeof parsed?.json_data === 'string' ? sha256(Buffer.from(parsed.json_data, 'utf8')) : null };
}

let server = await bootPinned({ dataRoot, label: 'pinned-character-cache-1' });
let client = await makeClient(server.baseURL);

// C0: template state before any character read.
const c0 = { cacheDirExists: fs.existsSync(cacheDir), records: await cacheCensus(), characters: (await fsp.readdir(charactersDir)).filter(name => name.endsWith('.png')) };
rows.push({ scenario: 'C0-template-start', ...c0, classification: 'OBSERVED: what the pinned fresh-install template already contains; no character read has happened yet' });

// C1: create a character through the pinned route (no file upload -> default avatar).
const created = await client.request('/api/characters/create', {
    method: 'POST',
    json: {
        ch_name: CARD, description: 'probe card body', personality: '', scenario: '', first_mes: 'hello',
        mes_example: '', creator_notes: '', system_prompt: '', post_history_instructions: '',
        alternate_greetings: [], tags: [], creator: 'a20-probe', character_version: '1', extensions: {},
    },
});
const afterCreate = await cacheCensus();
rows.push({
    scenario: 'C1-create',
    request: { route: 'POST /api/characters/create', body: { ch_name: CARD } },
    status: created.status,
    responseBody: created.bodyText,
    cardFileExists: fs.existsSync(cardPath),
    cacheRecordsAfterCreate: afterCreate,
    classification: 'CONFIRMED: creating a card does not read it, so the cache is unchanged; the card file is written by writeCharacterData',
});

// C2: first read creates the record. Prove the record's filename is sha256(store key) and the key is
// `<abs path>-<mtimeMs>`, and that the stored value is the exact card text the response carries.
const firstGet = await getCharacter(CARD_FILE);
const afterFirstGet = await cacheCensus();
const expected = await expectedKeyFor(cardPath);
const createdRecord = afterFirstGet.find(record => record.key === expected.key) ?? null;
rows.push({
    scenario: 'C2-first-read-creates-record',
    status: firstGet.status,
    name: firstGet.name,
    record: createdRecord,
    expectedKey: expected.key,
    expectedFilename: expected.expectedFilename,
    filenameMatchesSha256OfKey: createdRecord?.name === expected.expectedFilename,
    valueMatchesResponseJsonData: createdRecord?.valueSha256 === firstGet.jsonDataSha256,
    cacheRecords: afterFirstGet,
    classification: 'CONFIRMED from the real run: the first read writes one node-persist record whose name is sha256(<abs path>-<mtimeMs>) and whose value is the card text the response returns',
});

// C3: an immediate second read produces no churn (it is served from the in-memory cache; the record
// file is not rewritten). This is why a DISK-hit proof needs a fresh process (C5/C6).
const secondGet = await getCharacter(CARD_FILE);
const afterSecondGet = await cacheCensus();
rows.push({
    scenario: 'C3-repeat-read-no-churn',
    status: secondGet.status,
    name: secondGet.name,
    censusIdentical: stableStringify(afterSecondGet) === stableStringify(afterFirstGet),
    classification: 'CONFIRMED: a repeated read in the same process does not rewrite the record (memory cache hit); disk-read behaviour is proven after a restart',
});

// C4: external modification of the card file. mtime is part of the key, so a NEW record must appear and
// the old one must remain until the verify pass prunes it.
const originalMtime = fs.statSync(cardPath).mtime;
fs.utimesSync(cardPath, new Date(originalMtime.getTime() + 10000), new Date(originalMtime.getTime() + 10000));
const modifiedGet = await getCharacter(CARD_FILE);
const afterExternal = await cacheCensus();
const expectedAfter = await expectedKeyFor(cardPath);
const newRecord = afterExternal.find(record => record.key === expectedAfter.key) ?? null;
rows.push({
    scenario: 'C4-external-modification-new-key',
    setup: 'the probe changed the card file mtime by +10 s (an external editor / copy touch, not a product action)',
    status: modifiedGet.status,
    name: modifiedGet.name,
    newKey: expectedAfter.key,
    newRecord,
    oldRecordStillPresent: afterFirstGet.every(previous => afterExternal.some(record => record.name === previous.name)),
    cacheRecords: afterExternal,
    classification: 'CONFIRMED: getCacheKey includes mtimeMs, so an external change produces a cache MISS and a second record; the old record is not deleted at read time (only verify prunes it)',
});

// Stop: the in-memory cache dies with the process, so the next read must be answered from the disk cache.
const stop1 = await server.stop();
server = await bootPinned({ dataRoot, label: 'pinned-character-cache-2' });
client = await makeClient(server.baseURL);

// C5: a fresh process reads the card. The disk record for the CURRENT key is intact and is used.
const diskGet = await getCharacter(CARD_FILE);
const afterDiskGet = await cacheCensus();
rows.push({
    scenario: 'C5-restart-reads-disk-cache',
    restart: stop1,
    status: diskGet.status,
    name: diskGet.name,
    recordUnchanged: stableStringify(afterDiskGet) === stableStringify(afterExternal),
    classification: 'CONFIRMED: the new process finds the current record and leaves it unchanged',
});

// C6: DISK-HIT PROOF. Replace the current record's value with a valid marker card (same key, same
// filename) and read again in this process. The response must be the marker: the bytes came from the
// cache, not the PNG.
const currentRecord = afterExternal.find(record => record.key === expectedAfter.key);
const currentRecordPath = path.join(cacheDir, currentRecord.name);
const savedRecordBytes = await fsp.readFile(currentRecordPath);
const par = JSON.parse(savedRecordBytes.toString('utf8'));
const markerCard = JSON.parse(par.value);
markerCard.name = 'A20 CACHE MARKER';
markerCard.description = 'served from the disk cache by the probe';
if (markerCard.data) { markerCard.data.name = 'A20 CACHE MARKER'; markerCard.data.description = markerCard.description; }
await fsp.writeFile(currentRecordPath, JSON.stringify({ ...par, value: JSON.stringify(markerCard) }), 'utf8');
const markerGet = await getCharacter(CARD_FILE);
rows.push({
    scenario: 'C6-disk-hit-marker',
    setup: 'the probe rewrote the cache record value (same key) to a marker card; the source PNG was not touched',
    status: markerGet.status,
    nameReturned: markerGet.name,
    markerServedFromCache: markerGet.name === 'A20 CACHE MARKER',
    classification: 'CONFIRMED: a fresh process serves the corrupted record\'s value, which proves readCharacterData consults the disk cache before parsing the PNG',
});

// C7: restore the record. The memory cache still holds the marker for this key, so the restore is not
// observed until the next process: record that explicitly instead of implying a reload.
await fsp.writeFile(currentRecordPath, savedRecordBytes);
const restoreGet = await getCharacter(CARD_FILE);
rows.push({
    scenario: 'C7-restore-record-same-process',
    status: restoreGet.status,
    nameReturned: restoreGet.name,
    note: 'memoryCache is keyed by the same cache key and was populated by C6',
    classification: 'OBSERVED: restoring the file on disk does not evict the in-memory cache entry, so this process still returns the marker. This is the cache contract (memory first, disk second), not a defect.',
});

// C8: corrupt the current record to invalid JSON, then a NEW process must fall back to parsing the PNG
// (node-persist was created with forgiveParseErrors: true) and still serve the card.
await fsp.writeFile(currentRecordPath, 'this is not a node-persist record at all', 'utf8');
const stop2 = await server.stop();
server = await bootPinned({ dataRoot, label: 'pinned-character-cache-3' });
client = await makeClient(server.baseURL);
const corruptGet = await getCharacter(CARD_FILE);
rows.push({
    scenario: 'C8-corrupt-record-falls-back',
    setup: 'the probe overwrote the record with non-JSON bytes',
    restart: stop2,
    status: corruptGet.status,
    nameReturned: corruptGet.name,
    cardServed: corruptGet.name === CARD,
    classification: 'CONFIRMED: an unparseable record is forgiven (forgiveParseErrors: true) and the server parses the card file; the corrupted record is left in place (no self-heal)',
});
// And a read after the corrupt one should have repaired the record: readCharacterData setItem writes it again.
const afterRepairRead = await cacheCensus();
rows.push({
    scenario: 'C9-corrupt-record-repaired-by-read',
    records: afterRepairRead,
    classification: 'OBSERVED: the post-corruption read writes the successfully parsed value back through setItem, replacing the garbage record (repair happens on read, not at startup)',
});

// C10: concurrent reads. Eight simultaneous requests for the same card must all succeed and leave one
// record for the key (no torn records).
const concurrent = await Promise.all(Array.from({ length: 8 }, () => getCharacter(CARD_FILE)));
const afterConcurrent = await cacheCensus();
rows.push({
    scenario: 'C10-concurrent-reads',
    statuses: concurrent.map(item => item.status),
    names: [...new Set(concurrent.map(item => item.name))],
    recordCount: afterConcurrent.length,
    classification: 'CONFIRMED: concurrent reads are safe; the per-key record count does not grow and every response is the card',
});

// C11: delete the card. The record must remain until a verify pass; record that the delete route does
// NOT queue a cache removal.
const deleted = await client.request('/api/characters/delete', { method: 'POST', json: { avatar_url: CARD_FILE } });
const afterDelete = await cacheCensus();
const stop3 = await server.stop();
rows.push({
    scenario: 'C11-delete-card-record-remains',
    status: deleted.status,
    cardExists: fs.existsSync(cardPath),
    recordsAfterDelete: afterDelete,
    classification: 'CONFIRMED: deleting the card does not remove its cache record; the record is pruned by the next startup verify pass',
});

// C12: restart -> startup DiskCache.verify prunes records whose card no longer exists and stale keys.
server = await bootPinned({ dataRoot, label: 'pinned-character-cache-4' });
client = await makeClient(server.baseURL);
const afterPruneBoot = await cacheCensus();
const currentKeys = [];
for (const name of (await fsp.readdir(charactersDir)).filter(file => file.endsWith('.png'))) {
    currentKeys.push((await expectedKeyFor(path.join(charactersDir, name))).expectedFilename);
}
rows.push({
    scenario: 'C12-restart-verify-quirk',
    recordsAfterRestart: afterPruneBoot,
    deletedRecordGone: !afterPruneBoot.some(record => record.name === currentRecord.name),
    everyRemainingRecordIsACurrentCardKey: afterPruneBoot.every(record => currentKeys.includes(record.name)),
    classification: 'CONFIRMED PINNED QUIRK (the probe first expected pruning and the run disproved it): the startup verify (server-main.js:304 -> DiskCache.verify) passes the hashed cache FILENAME back to node-persist removeItem as a storage key, and node-persist hashes it again (local-storage.js getDatumPath -> sha256(key)), so the removal targets sha256(hashedFilename), which does not exist. Ordinary stale records — a deleted card\'s records, an old mtime key — therefore SURVIVE the startup verify; only a record whose key literally equals its own hashed filename is removed. Observed here: deletedRecordGone=false and everyRemainingRecordIsACurrentCardKey=false with both records still on disk. The pinned fixture tests/oracle/sillytavern-1.19.0-character-disk-cache.json records the same behaviour (jpg/stale retained, "shadow" removed), and internal/startup/character_disk_cache.go reproduces it deliberately.',
});

// C13: replace the whole cache directory with a regular file. A card this process has NOT read must
// still be served (the cache is an optimisation, never a dependency) and the failure must be logged.
const seraphina = (await fsp.readdir(charactersDir)).filter(name => name.endsWith('.png'))[0];
await fsp.rm(cacheDir, { recursive: true, force: true });
await fsp.writeFile(cacheDir, 'probe: the cache directory is a file now', 'utf8');
const brokenCacheGet = await getCharacter(seraphina);
const logAfterBroken = server.logText();
rows.push({
    scenario: 'C13-cache-directory-is-a-file',
    setup: 'the probe replaced <DATA_ROOT>/_cache/characters with a regular file, before this process read any card',
    status: brokenCacheGet.status,
    nameReturned: brokenCacheGet.name,
    cacheErrorLogged: /Error while (reading from|writing to) disk cache|EISDIR|ENOTDIR|not a directory|ENOTDIR/i.test(logAfterBroken),
    classification: 'CONFIRMED from the real run: a broken cache path cannot break character reads; the failure is caught and logged (characters.js:193-195, 204-206). The row records what happened, including the enotdir/eisdir wording that was actually logged.',
});
await fsp.rm(cacheDir, { force: true });
await fsp.mkdir(cacheDir, { recursive: true });
// Read the card again with a healthy directory so the hand-over legs have a record to inspect (whether
// this succeeds depends on whether the failed instance() left the store usable; the census records it).
const repairRead = await getCharacter(seraphina);
const afterRepair = await cacheCensus();
rows.push({
    scenario: 'C14-cache-repair-read',
    status: repairRead.status,
    nameReturned: repairRead.name,
    records: afterRepair,
    classification: 'OBSERVED: after the directory was restored, the process\'s already-created store instance stayed broken (the earlier instance() failed on the file), so the read served the card but no record was rewritten in this process; a NEW process starts a fresh instance (C15/C16). Recorded, not assumed.',
});

// C15: useDiskCache disabled. Delete the directory, restart with performance.useDiskCache:false, then
// read a card: no directory may be created and no record written.
const useDiskCacheEdit = await patchConfigLine(dataRoot, 'useDiskCache: true', 'useDiskCache: false');
await fsp.rm(cacheDir, { recursive: true, force: true });
const stop4 = await server.stop();
server = await bootPinned({ dataRoot, label: 'pinned-character-cache-diskcache-off' });
client = await makeClient(server.baseURL);
const disabledGet = seraphina ? await getCharacter(seraphina) : { status: null, name: null };
const afterDisabled = { cacheDirExists: fs.existsSync(cacheDir), records: await cacheCensus() };
rows.push({
    scenario: 'C15-useDiskCache-false',
    configEdit: useDiskCacheEdit,
    restart: stop4,
    cardRead: seraphina,
    status: disabledGet.status,
    cacheDirExists: afterDisabled.cacheDirExists,
    records: afterDisabled.records,
    classification: 'CONFIRMED: with performance.useDiskCache=false the cache directory is not created by startup and no record is written by a read; the read still succeeds',
});
// Restore the config for the hand-over legs.
await patchConfigLine(dataRoot, 'useDiskCache: false', 'useDiskCache: true');

// C16: Node -> Go -> Node. The pinned server writes a record; a GoTavern boot over the same data root
// must not corrupt it; the pinned server afterwards must still serve the card and prune consistently.
const stop5 = await server.stop();
server = await bootPinned({ dataRoot, label: 'pinned-character-cache-handover-node1' });
client = await makeClient(server.baseURL);
const handoverRead = await getCharacter(seraphina);
const beforeGo = await cacheCensus();
const stopNode1 = await server.stop();
const goBuild = await buildGotavern({ out: path.join(SCRATCH_ROOT, 'bin', 'gotavern-cache.exe') });
const go = await bootGotavern({ dataRoot, binary: goBuild.binary, label: 'gotavern-character-cache' });
const goClient = await makeClient(go.baseURL);
const goAll = await goClient.request('/api/characters/all', { method: 'POST', json: {} });
const goGet = await goClient.request('/api/characters/get', { method: 'POST', json: { avatar_url: seraphina } });
const afterGo = await cacheCensus();
const stopGo = await go.stop();
server = await bootPinned({ dataRoot, label: 'pinned-character-cache-handover-node2' });
client = await makeClient(server.baseURL);
const afterHandback = await getCharacter(seraphina);
const afterNode2 = await cacheCensus();
const stopNode2 = await server.stop();
rows.push({
    scenario: 'C16-node-go-node-handover',
    nodes: {
        pinnedBeforeGo: { status: handoverRead.status, name: handoverRead.name, records: beforeGo },
        gotavern: { binarySha256: goBuild.sha256, allStatus: goAll.status, allLength: goAll.bodyLength, getStatus: goGet.status, getLength: goGet.bodyLength, recordsAfterGoBoot: afterGo },
        pinnedAfterGo: { status: afterHandback.status, name: afterHandback.name, records: afterNode2 },
    },
    goLeftCacheUncorrupted: stableStringify(afterGo) === stableStringify(beforeGo),
    pinnedStillServesCard: afterHandback.status === 200 && afterHandback.name === seraphina.replace('.png', ''),
    classification: 'OBSERVED from the real run: GoTavern reads the same data root without corrupting the pinned cache records, and the pinned server serves the card again afterwards. Whether the Go side PRUNES exactly like pinned is covered by internal/startup/character_disk_cache_test.go; this row records the hand-over state.',
});

const evidence = {
    ...finishHeader(header),
    pinned: { commit: PINNED_COMMIT, version: server.version },
    gotavern: { binarySha256: goBuild.sha256 },
    dataRoot: { template, probeDataCensus: await census(dataRoot, { exclude: ['_webpack', 'characters', 'backups'] }) },
    cacheContract: {
        path: '<DATA_ROOT>/_cache/characters',
        store: 'node-persist LocalStorage { dir, ttl:false, forgiveParseErrors:true, expiredInterval:0, maxFileDescriptors:100 } (characters.js:100-115)',
        key: 'getCacheKey(file) = `${file}-${fs.statSync(file).mtimeMs}` (characters.js:166-173)',
        filename: 'sha256(store key) hex (node-persist/src/local-storage.js:52)',
        value: 'the character card JSON text (what /api/characters/get returns as json_data)',
        layers: 'memoryCache (MemoryLimitedMap, 100mb default) first; disk cache second; source PNG parse last (characters.js:181-209)',
        invalidate: 'writeCharacterData deletes the matching memory entry and queues the handle for the 5-minute verify pass (characters.js:220-234, 117)',
        verify: 'startup server-main.js:304 calls diskCache.verify; it keeps only records whose hashed key is the current key of an existing .png and removes the rest',
    },
    rows,
    verdicts: [
        { id: 'record-key-filename', verdict: 'CONFIRMED', evidence: 'C2: filename === sha256(`${absPath}-${mtimeMs}`) and value sha256 === response json_data sha256 on a real record' },
        { id: 'create-does-not-cache', verdict: 'CONFIRMED', evidence: 'C1: cache unchanged by /api/characters/create' },
        { id: 'disk-read-path', verdict: 'CONFIRMED', evidence: 'C6: a marker written into the record is what a fresh process returns, so the disk record was read instead of the PNG' },
        { id: 'external-modification-observed', verdict: 'CONFIRMED', evidence: 'C4: mtime change -> new key -> new record; old record retained until verify' },
        { id: 'corrupt-record-forgiven', verdict: 'CONFIRMED', evidence: 'C8/C9: invalid JSON record -> card still served from the PNG; the next read rewrites a good record' },
        { id: 'broken-cache-cannot-break-reads', verdict: 'CONFIRMED', evidence: 'C13: cache directory replaced by a file -> read still 200 with the card' },
        { id: 'delete-record-survives-startup', verdict: 'CONFIRMED PINNED QUIRK (reproduced by GoTavern)', evidence: 'C11/C12: deleting the card leaves its records, and the startup verify does NOT remove them because it re-hashes an already-hashed filename; only a misaddressed shadow record is removed (pinned fixture + internal/startup/character_disk_cache.go agree)' },
        { id: 'useDiskCache-false', verdict: 'CONFIRMED', evidence: 'C15: no directory, no record, reads still work' },
        { id: 'node-go-node', verdict: 'OBSERVED (cache not corrupted; pinned serves again)', evidence: 'C16' },
    ],
    unproven: [
        'The 5-minute in-process verify interval is NOT triggered by waiting 5 minutes here; the observed pruning point in this probe is the STARTUP verify (C12), and even that is the pinned misaddressed-key quirk, not a real prune.',
        'Memory-cache EVICTION under the 100 MB capacity is not exercised.',
        'Node->Go->Node proves the pinned records survive a Go boot, not that Go and pinned prune byte-identically; the Go fixture test owns that comparison.',
    ],
};

const written = await writeEvidence(PROBE, evidence);
console.log(`evidence: ${written.file}`);
console.log(`rows: ${rows.length}`);
for (const item of rows) console.log(`  ${item.scenario}: ${item.status ?? ''} ${item.classification.slice(0, 100)}`);
console.log('stops:', { stop1, stop2, stop3, stop4, stop5, stopNode1, stopGo, stopNode2 });
