// THE THIRD-PARTY EXTENSION CORPUS, loaded from its committed lock file.
//
// The corpus is a PINNED SET: every selected extension names a 40-hex commit, and CI checks that exact
// commit out into a temporary data root. Nothing in the harness may read a moving branch, because a
// release gate that changes when a third party pushes to `main` is not a gate.
//
// The lock file is the single source of truth for: which extensions exist (exactly 20), what they are
// called on disk (the directory the pinned frontend fetches), which commit is pinned, what the
// selection recorded about them (stars/forks snapshot, license, capabilities, safety review) and the
// hash CI reports so an artifact can say WHICH corpus it measured.
//
// THIS MODULE VALIDATES BEFORE ANYTHING BOOTS. A malformed lock (19 entries, a duplicate name, a short
// SHA, an unknown capability) throws here, so a shard cannot silently run a subset and call it green.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const LOCK_PATH = path.join(here, 'third-party-extensions.lock.json');
export const EXPECTED_SELECTED = 20;
export const EXPECTED_MIN_CANDIDATES = 40;
export const SCHEMA_VERSION = 1;

// The capability vocabulary the lock may use. Kept here so a typo ('chat-events' vs 'chat_events')
// cannot quietly make a capability leg not run: an unknown capability is a lock validation failure.
export const CAPABILITIES = new Set([
    'DOM', 'chat-events', 'generation', 'prompt-injection', 'world-info', 'character',
    'group-chat', 'quick-replies', 'macros', 'files', 'fetch', 'websocket', 'SSE',
    'tokenizer', 'settings', 'slash-command', 'prompt-format', 'message-render',
    'markdown', 'audio', 'image', 'remote-network',
]);

// Capabilities whose leg needs a configured provider peer. These are the only extensions for which a
// generation drive runs, and the artifact says so per row.
export const GENERATION_CAPABILITIES = new Set(['generation', 'prompt-injection', 'prompt-format', 'world-info', 'chat-events']);

export function sha256(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
}

export function validateLock(lock) {
    const problems = [];
    if (!lock || typeof lock !== 'object' || Array.isArray(lock)) return ['lock is not a JSON object'];
    if (lock.schemaVersion !== SCHEMA_VERSION) problems.push(`schemaVersion is ${JSON.stringify(lock.schemaVersion)}, expected ${SCHEMA_VERSION}`);
    if (typeof lock.snapshotAt !== 'string' || Number.isNaN(Date.parse(lock.snapshotAt))) problems.push('snapshotAt must be an ISO-8601 timestamp');
    if (typeof lock.methodology !== 'string' || lock.methodology.trim().length < 80) problems.push('methodology must be a substantive string (>=80 chars)');
    if (!Array.isArray(lock.candidates) || lock.candidates.length < EXPECTED_MIN_CANDIDATES) {
        problems.push(`candidates must contain at least ${EXPECTED_MIN_CANDIDATES} real repositories; got ${Array.isArray(lock.candidates) ? lock.candidates.length : 'not an array'}`);
    }
    if (!Array.isArray(lock.selected)) {
        problems.push('selected is not an array');
        return problems;
    }
    if (lock.selected.length !== EXPECTED_SELECTED) problems.push(`selected must contain exactly ${EXPECTED_SELECTED} extensions; got ${lock.selected.length}`);

    const candidateRepos = new Set();
    for (const [index, candidate] of (lock.candidates ?? []).entries()) {
        if (!candidate || typeof candidate.repo !== 'string' || !/^[^/\s]+\/[^/\s]+$/.test(candidate.repo)) {
            problems.push(`candidates[${index}].repo is not owner/name`);
            continue;
        }
        if (candidateRepos.has(candidate.repo.toLowerCase())) problems.push(`candidates[${index}] duplicates repo ${candidate.repo}`);
        candidateRepos.add(candidate.repo.toLowerCase());
        if (!Number.isInteger(candidate.stars) || candidate.stars < 0) problems.push(`candidates[${index}].stars must be a non-negative integer`);
        if (!Number.isInteger(candidate.forks) || candidate.forks < 0) problems.push(`candidates[${index}].forks must be a non-negative integer`);
    }

    const names = new Set();
    const repos = new Set();
    const commits = new Set();
    for (const [index, extension] of lock.selected.entries()) {
        const where = `selected[${index}]`;
        if (!extension || typeof extension !== 'object') {
            problems.push(`${where} is not an object`);
            continue;
        }
        if (typeof extension.name !== 'string' || extension.name.trim() === '') problems.push(`${where}.name is required`);
        else if (names.has(extension.name)) problems.push(`${where}.name ${JSON.stringify(extension.name)} is duplicated`);
        else names.add(extension.name);
        if (typeof extension.repo !== 'string' || !/^[^/\s]+\/[^/\s]+$/.test(extension.repo)) problems.push(`${where}.repo is not owner/name`);
        else if (repos.has(extension.repo.toLowerCase())) problems.push(`${where}.repo ${JSON.stringify(extension.repo)} is duplicated`);
        else repos.add(extension.repo.toLowerCase());
        if (typeof extension.commit !== 'string' || !/^[0-9a-f]{40}$/.test(extension.commit)) problems.push(`${where}.commit must be a full 40-hex SHA`);
        else if (commits.has(extension.commit)) problems.push(`${where}.commit is duplicated`);
        else commits.add(extension.commit);
        if (!Number.isInteger(extension.starsSnapshot) || extension.starsSnapshot < 0) problems.push(`${where}.starsSnapshot must be a non-negative integer`);
        if (!Number.isInteger(extension.forksSnapshot) || extension.forksSnapshot < 0) problems.push(`${where}.forksSnapshot must be a non-negative integer`);
        if (typeof extension.snapshotAt !== 'string' || Number.isNaN(Date.parse(extension.snapshotAt))) problems.push(`${where}.snapshotAt must be an ISO-8601 timestamp`);
        if (typeof extension.license !== 'string' || extension.license.trim() === '') problems.push(`${where}.license is required (use NOASSERTION when GitHub reports none)`);
        if (extension.extensionType !== 'client') problems.push(`${where}.extensionType must be "client" (server plugins are out of scope for this gate)`);
        if (!Array.isArray(extension.capabilities) || extension.capabilities.length === 0) problems.push(`${where}.capabilities must be a non-empty array`);
        else for (const capability of extension.capabilities) {
            if (!CAPABILITIES.has(capability)) problems.push(`${where}.capabilities contains unknown capability ${JSON.stringify(capability)}`);
        }
        if (typeof extension.installMethod !== 'string' || extension.installMethod.trim() === '') problems.push(`${where}.installMethod is required`);
        if (typeof extension.networkRequired !== 'boolean') problems.push(`${where}.networkRequired must be a boolean`);
        if (typeof extension.credentialsRequired !== 'boolean') problems.push(`${where}.credentialsRequired must be a boolean`);
        if (typeof extension.safetyReview !== 'string' || extension.safetyReview.trim().length < 40) problems.push(`${where}.safetyReview must be a concrete string (>=40 chars)`);
        if (typeof extension.selectionReason !== 'string' || extension.selectionReason.trim() === '') problems.push(`${where}.selectionReason is required`);
        if (extension.manifestPath !== undefined && extension.manifestPath !== 'manifest.json') problems.push(`${where}.manifestPath must be "manifest.json" when present`);
        // A selected repo must appear in the candidate pool: the ranking is reproducible only if the
        // selected row is one of the rows the snapshot measured.
        if (typeof extension.repo === 'string' && !candidateRepos.has(extension.repo.toLowerCase())) {
            problems.push(`${where}.repo ${JSON.stringify(extension.repo)} is not present in candidates, so its popularity snapshot cannot be checked`);
        }
        if (extension.name === 'JS-Slash-Runner' || /tavern[- ]?helper/i.test(`${extension.name} ${extension.repo}`) || /酒馆助手/.test(`${extension.name} ${extension.repo}`)) {
            problems.push(`${where} is Tavern Helper / 酒馆助手, which this corpus must exclude`);
        }
    }
    return problems;
}

export function loadLock(file = LOCK_PATH) {
    const bytes = fs.readFileSync(file);
    const lock = JSON.parse(bytes.toString('utf8'));
    const problems = validateLock(lock);
    if (problems.length > 0) {
        throw new Error(`third-party extension lock ${file} is invalid:\n- ${problems.join('\n- ')}`);
    }
    return { lock, sha256: sha256(bytes), path: file, bytes: bytes.length };
}

export function extensionByKey(lock, key) {
    const extension = lock.selected.find(entry => entry.name === key || entry.repo === key);
    if (!extension) throw new Error(`unknown extension ${JSON.stringify(key)}; known: ${lock.selected.map(entry => entry.name).join(', ')}`);
    return extension;
}

export function needsGenerationLeg(extension) {
    return (extension.capabilities ?? []).some(capability => GENERATION_CAPABILITIES.has(capability));
}

export function capabilitySummary(lock) {
    const counts = {};
    for (const extension of lock.selected) {
        for (const capability of extension.capabilities) counts[capability] = (counts[capability] ?? 0) + 1;
    }
    return counts;
}

// A deterministic shard plan over the lock order, so a workflow's shard N is the same set of
// extensions on every run and the aggregator can check expected-vs-observed without guessing.
export function shard(lock, { index, count }) {
    if (!Number.isInteger(index) || index < 1 || index > count) throw new Error(`shard index ${index} is outside 1..${count}`);
    return lock.selected.filter((_, position) => position % count === index - 1);
}

if (process.argv[1] && process.argv[1].endsWith('third-party-extensions.mjs')) {
    const loaded = loadLock();
    console.log(JSON.stringify({
        lock: path.basename(loaded.path),
        sha256: loaded.sha256,
        selected: loaded.lock.selected.length,
        candidates: loaded.lock.candidates.length,
        snapshotAt: loaded.lock.snapshotAt,
        capabilities: capabilitySummary(loaded.lock),
        names: loaded.lock.selected.map(extension => extension.name),
    }, null, 2));
}
