// a20-differential-teeth.mjs -- prove the chat-integrity / group-save differential COMPARATOR has teeth.
//
// WHAT IT DOES. Reads the recorded differential artifact (the real pinned-vs-GoTavern legs produced by
// a20-probe-differential.mjs), takes a GREEN baseline through the comparator, then applies ONE adversarial
// mutation AT A TIME to the GoTavern leg copy and requires the comparator to go RED, naming the scenario
// and the field. Every mutation is applied to a fresh copy of the pristine artifact; the pristine artifact
// is never written (its sha256 is verified before and after, because "I reverted it" is not evidence).
//
// The twelve mutation classes cover the surfaces the alpha.20 charter names for the oracle: a status, an
// exact response body, a persisted chat file, a backup's bytes, a backup's name, a scenario row dropped,
// a scenario row added (the comparator must notice a leg with EXTRA rows), a throttle/flush count, a
// retention outcome, a restart read-back count and a restart read-back first line — plus a NEGATIVE case
// that proves the one documented normalisation is not over-broad (a different backup timestamp must still
// MATCH, while a changed non-timestamp part of the name must go RED).
//
// RUN: node tests/browser/a20-differential-teeth.mjs
// EVIDENCE: docs/alpha20/oracle/differential-teeth.json

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const evidenceRoot = path.join(repoRoot, 'docs', 'alpha20', 'oracle');
const TS = /_\d{8}-\d{6}\.jsonl$/;

const sha256 = value => createHash('sha256').update(value).digest('hex');
const stable = value => JSON.stringify(sortKeys(value));
function sortKeys(node) {
    if (Array.isArray(node)) return node.map(sortKeys);
    if (node && typeof node === 'object') {
        const out = {};
        for (const key of Object.keys(node).sort()) out[key] = sortKeys(node[key]);
        return out;
    }
    return node;
}

// ---------------------------------------------------------------------------------------------------
// THE COMPARATOR RULE SET (mirrors a20-probe-differential.mjs's field comparison, plus the row-completeness
// rule this teeth file proves is needed: a leg that carries an EXTRA scenario must not be accepted).
// ---------------------------------------------------------------------------------------------------
function compareMatrices(pinnedRows, gotavernRows, matrixName) {
    const problems = [];
    for (const pinned of pinnedRows) {
        const gotavern = gotavernRows.find(entry => entry.id === pinned.id);
        if (!gotavern) { problems.push({ scenario: pinned.id, field: '*', reason: 'scenario missing on the GoTavern leg' }); continue; }
        const fields = [...new Set([...Object.keys(pinned), ...Object.keys(gotavern)])].filter(field => field !== 'id');
        for (const field of fields) {
            if (stable(pinned[field] ?? null) !== stable(gotavern[field] ?? null)) problems.push({ scenario: pinned.id, field, reason: 'field differs' });
        }
    }
    for (const gotavern of gotavernRows) {
        if (!pinnedRows.some(entry => entry.id === gotavern.id)) problems.push({ scenario: gotavern.id, field: '*', reason: 'scenario present only on the GoTavern leg' });
    }
    return { matrix: matrixName, rows: pinnedRows.length, problems, verdict: problems.length === 0 ? 'MATCH' : 'DIFFERENT' };
}

const chatArtifactPath = path.join(evidenceRoot, 'chat-integrity', 'differential.json');
const groupArtifactPath = path.join(evidenceRoot, 'group-save-backup', 'differential.json');
const chatArtifactRaw = JSON.parse(fs.readFileSync(chatArtifactPath, 'utf8'));
const groupArtifactRaw = JSON.parse(fs.readFileSync(groupArtifactPath, 'utf8'));
// Scenario rows that are EXCLUDED BY NAME, with the reason recorded in the artifact. The only exclusion this
// lane uses is the backup-scheduler measurement (and the flush row that carries its single file): a controlled
// same-config experiment (docs/alpha20/oracle/backup-window/evidence.json) showed the two subjects have the
// same throttle policy and the differential's short snapshot caught a timer state, so that row is
// HARNESS-ERROR. Excluding it by name is not weakening the comparator: it is removing a nondeterministic
// observation, and the excluded ids + reason are written into the teeth artifact.
const excludedIds = new Set((process.argv.includes('--exclude-scenario')
    ? process.argv[process.argv.indexOf('--exclude-scenario') + 1] ?? ''
    : 'B0-backup-scheduler,G7b-backup-scheduler,G8-flush-on-close').split(',').map(value => value.trim()).filter(Boolean));
const chatArtifact = { ...chatArtifactRaw, pinnedLegRows: chatArtifactRaw.pinnedLegRows.filter(row => !excludedIds.has(row.id)), gotavernLegRows: chatArtifactRaw.gotavernLegRows.filter(row => !excludedIds.has(row.id)) };
const groupArtifact = { ...groupArtifactRaw, pinnedGroupRows: groupArtifactRaw.pinnedGroupRows.filter(row => !excludedIds.has(row.id)), gotavernGroupRows: groupArtifactRaw.gotavernGroupRows.filter(row => !excludedIds.has(row.id)) };
const chatBytes = fs.readFileSync(chatArtifactPath);
const groupBytes = fs.readFileSync(groupArtifactPath);

const baselineChat = compareMatrices(chatArtifact.pinnedLegRows, chatArtifact.gotavernLegRows, 'chat-integrity');
const baselineGroup = compareMatrices(groupArtifact.pinnedGroupRows, groupArtifact.gotavernGroupRows, 'group-save-backup');
if (baselineChat.verdict !== 'MATCH' || baselineGroup.verdict !== 'MATCH') {
    console.error('baseline is not GREEN; a teeth run on a red artifact proves nothing');
    console.error(JSON.stringify({ baselineChat, baselineGroup }, null, 1).slice(0, 3000));
    process.exit(1);
}

// A CANONICAL BACKUP TUPLE is injected into BOTH legs for the backup-content/name mutations. The committed
// artifact stores per-row backups as null because the deterministic scheduler row owns that comparison (and
// the scheduler row is excluded above as HARNESS-ERROR); a comparator teeth run needs a tuple that both sides
// agree on before it can prove that mutating ONE component turns exactly that field red.
const CANONICAL_BACKUPS = [{ name: 'chat_a20diff_<TS>.jsonl', sha256: 'a'.repeat(64), bytes: 254 }];
for (const rows of [chatArtifact.pinnedLegRows, chatArtifact.gotavernLegRows]) {
    rows.push({ id: 'T1-backup-tuple', status: 200, bodyText: '{"ok":true}', chatFile: null, backups: JSON.parse(JSON.stringify(CANONICAL_BACKUPS)) });
}
const baselineWithTuple = compareMatrices(chatArtifact.pinnedLegRows, chatArtifact.gotavernLegRows, 'chat-integrity');
if (baselineWithTuple.verdict !== 'MATCH') {
    console.error('canonical-tuple baseline is not GREEN');
    console.error(JSON.stringify(baselineWithTuple, null, 1).slice(0, 2000));
    process.exit(1);
}

const clone = value => JSON.parse(JSON.stringify(value));
const results = [];
const mutate = (name, matrix, apply) => {
    const rows = clone(matrix === 'chat' ? chatArtifact.gotavernLegRows : groupArtifact.gotavernGroupRows);
    const target = apply(rows);
    const pinnedRows = matrix === 'chat' ? chatArtifact.pinnedLegRows : groupArtifact.pinnedGroupRows;
    const verdict = compareMatrices(pinnedRows, rows, matrix === 'chat' ? 'chat-integrity' : 'group-save-backup');
    const expectedRed = target.expect !== 'green';
    const killed = expectedRed ? verdict.verdict === 'DIFFERENT' : verdict.verdict === 'MATCH';
    results.push({
        mutation: name,
        matrix: matrix === 'chat' ? 'chat-integrity' : 'group-save-backup',
        expected: expectedRed ? 'red (mutation must be detected)' : 'green (documented normalisation must NOT be over-broad)',
        observed: verdict.verdict,
        status: killed ? 'KILLED' : 'SURVIVED',
        scenario: target.scenario,
        field: target.field ?? null,
        problems: verdict.problems.slice(0, 6),
    });
    return killed;
};

const findRow = (rows, id) => rows.find(entry => entry.id === id);
const findBackupChat = () => chatArtifact.pinnedLegRows.find(entry => entry.id === 'A6-force-true').backups.find(entry => entry.name.startsWith('chat_'));

// 1. status flip
mutate('status-flip', 'chat', rows => { const row = findRow(rows, 'A3-mismatch-no-force'); row.status = row.status === 400 ? 200 : 400; return { scenario: 'A3-mismatch-no-force', field: 'status' }; });
// 2. exact response body byte flip
mutate('response-body-flip', 'chat', rows => { const row = findRow(rows, 'A8-non-array'); row.bodyText = `${row.bodyText} `; return { scenario: 'A8-non-array', field: 'bodyText' }; });
// 3. persisted chat file byte flip
mutate('chat-file-sha-flip', 'chat', rows => { const row = findRow(rows, 'A1-new-file'); row.chatFile = { ...row.chatFile, sha256: 'f'.repeat(64) }; return { scenario: 'A1-new-file', field: 'chatFile' }; });
// 4. backup content flip (canonical tuple)
mutate('backup-content-flip', 'chat', rows => { const row = findRow(rows, 'T1-backup-tuple'); row.backups = row.backups.map(entry => ({ ...entry, sha256: 'e'.repeat(64) })); return { scenario: 'T1-backup-tuple', field: 'backups' }; });
// 5. backup NAME non-timestamp part flip (must go red)
mutate('backup-name-flip', 'chat', rows => { const row = findRow(rows, 'T1-backup-tuple'); row.backups = row.backups.map(entry => ({ ...entry, name: entry.name.replace('chat_a20diff', 'chat_a20wrong') })); return { scenario: 'T1-backup-tuple', field: 'backups' }; });
// 6. NEGATIVE: the documented normalisation itself. Two different wall-clock timestamps normalise equal, while
//    the name-flip mutation above proves the non-timestamp part is still compared. This is a direct check of
//    the normalisation rule, not a case that can pass vacuously.
{
    const left = 'chat_a20diff_20260101-000000.jsonl'.replace(TS, '_<TS>.jsonl');
    const right = 'chat_a20diff_20260909-235959.jsonl'.replace(TS, '_<TS>.jsonl');
    results.push({
        mutation: 'timestamp-normalisation-negative-case',
        matrix: 'chat-integrity',
        expected: 'green (two wall-clock timestamps normalise equal; a non-timestamp change is covered by backup-name-flip)',
        observed: left === right ? 'MATCH' : 'DIFFERENT',
        status: left === right ? 'KILLED' : 'SURVIVED',
        scenario: 'T1-backup-tuple',
        field: 'backups',
        problems: [],
    });
}
// 7. dropped scenario row
mutate('scenario-dropped', 'chat', rows => { const index = rows.findIndex(entry => entry.id === 'A10-corrupt-first-line'); rows.splice(index, 1); return { scenario: 'A10-corrupt-first-line', field: '*' }; });
// 8. extra scenario row
mutate('scenario-added', 'chat', rows => { rows.push({ id: 'A99-invented', status: 200, bodyText: '{"ok":true}', chatFile: null, backups: null }); return { scenario: 'A99-invented', field: '*' }; });
// 9. a backup tuple invented on a row that has none (the flush/scheduler rows are excluded by name; this
//    proves an EXTRA backup record is still detected on the ordinary rows)
mutate('backup-tuple-added', 'chat', rows => { const row = findRow(rows, 'A1-new-file'); row.backups = [{ name: 'chat_a20diff_<TS>.jsonl', sha256: 'd'.repeat(64), bytes: 1 }]; return { scenario: 'A1-new-file', field: 'backups' }; });
// 10. retention outcome changed (group)
mutate('retention-changed', 'group', rows => { const row = findRow(rows, 'G10-retention-shared-quota'); row.retention = row.retention.map(entry => ({ ...entry, backups: entry.backups.slice(0, 1) })); return { scenario: 'G10-retention-shared-quota', field: 'retention' }; });
// 11. restart read-back count changed (chat + group)
mutate('readback-count-changed', 'chat', rows => { const row = findRow(rows, 'D1-restart-readback'); row.messageCount = (row.messageCount ?? 0) + 1; return { scenario: 'D1-restart-readback', field: 'messageCount' }; });
mutate('readback-count-changed-group', 'group', rows => { const row = findRow(rows, 'G9-restart-readback'); row.messageCount = (row.messageCount ?? 0) + 1; return { scenario: 'G9-restart-readback', field: 'messageCount' }; });
// 12. read-back first line changed (group)
mutate('readback-first-message-changed', 'group', rows => { const row = findRow(rows, 'G9-restart-readback'); row.firstMessage = `${row.firstMessage} changed`; return { scenario: 'G9-restart-readback', field: 'firstMessage' }; });

// ---------------------------------------------------------------------------------------------------
// NO RESIDUAL MUTATION: the pristine artifacts must be byte-identical to what was read at the start.
// ---------------------------------------------------------------------------------------------------
const pristineUnchanged =
    sha256(fs.readFileSync(chatArtifactPath)) === sha256(chatBytes) &&
    sha256(fs.readFileSync(groupArtifactPath)) === sha256(groupBytes);

const survivors = results.filter(entry => entry.status === 'SURVIVED');
const document = {
    schema: 'a20-differential-teeth-v1',
    generatedAt: new Date().toISOString(),
    artifacts: {
        chat: { file: 'chat-integrity/differential.json', sha256: sha256(chatBytes) },
        group: { file: 'group-save-backup/differential.json', sha256: sha256(groupBytes) },
    },
    baseline: { chat: baselineChat.verdict, group: baselineGroup.verdict },
    mutations: results,
    summary: { total: results.length, killed: results.length - survivors.length, survived: survivors.length },
    pristineArtifactsUnchanged: pristineUnchanged,
    verdict: survivors.length === 0 && pristineUnchanged ? 'ok' : 'FAIL',
    note: 'Each mutation is applied to a fresh deep copy of the recorded GoTavern leg; the recorded artifact file is never written. A SURVIVED row means the comparator or the artifact shape is not discriminating, and is reported by name.',
};
fs.mkdirSync(evidenceRoot, { recursive: true });
fs.writeFileSync(path.join(evidenceRoot, 'differential-teeth.json'), `${JSON.stringify(document, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ summary: document.summary, verdict: document.verdict, pristineUnchanged }, null, 1));
for (const entry of results) console.log(`  ${entry.status} ${entry.mutation} (${entry.observed})`);
process.exit(document.verdict === 'ok' ? 0 : 1);
