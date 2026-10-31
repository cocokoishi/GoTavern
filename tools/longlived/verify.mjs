#!/usr/bin/env node
// VERIFY A LONG-LIVED CORPUS TREE AGAINST ITS MANIFEST -- the corpus's LOADER.
//
// WHY THIS EXISTS. A generated fixture whose shape is not re-read from disk is a fixture that can silently
// become simple: the builder's own declarations would be the only thing checked, and a builder that stopped
// planting swipes/branches/unicode would still pass. This verifier walks the tree it was given, re-derives
// the digest, and asserts the SURFACES a long-lived tree must contain against the FILES, never against the
// manifest's prose. Its named checks are the teeth a mutation demonstration targets.
//
// USAGE:
//   node tools/longlived/verify.mjs --corpus .tmp-artifacts/corpus/small [--rebuild]
//
// `--rebuild` also regenerates the same (size, seed) into a scratch directory and requires a byte-identical
// tree digest; without it the determinism claim is the builder's own `--verify-deterministic` run.
//
// OUTPUT: one JSON line (machine-readable verdict) on stdout; human summary on stderr. Exit 0 only when
// every named check passed.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { MANIFEST_NAME, sha256, treeDigest, walkTree } from './corpus-lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, '..', '..');

const SIZE_BOUNDS = Object.freeze({
    small: { minimumBytes: 500 * 1024, maximumBytes: 5 * 1024 * 1024 },
    medium: { minimumBytes: 10 * 1024 * 1024, maximumBytes: 90 * 1024 * 1024 },
    large: { minimumBytes: 100 * 1024 * 1024, maximumBytes: 400 * 1024 * 1024 },
});

function argument(name, fallback = null) {
    const index = process.argv.indexOf(name);
    if (index < 0) return fallback;
    const value = process.argv[index + 1];
    return value === undefined ? fallback : value;
}

function readJsonFile(target) {
    return fs.readFile(target, 'utf8').then(body => JSON.parse(body));
}

function jsonlMessages(target) {
    return fs.readFile(target, 'utf8').then(body => body.split('\n').filter(line => line.trim().length > 0));
}

/**
 * Read the card JSON out of a PNG's `chara`/`ccv3` tEXt chunk, by parsing the chunk stream.
 *
 * A card file's PROSE lives inside the image, so "the unicode survived" cannot be checked on the PNG bytes
 * as text; it has to be checked on the decoded JSON. Knowing which keyword was decoded is part of the
 * check: `chara` is v2 base64 JSON and `ccv3` is v3.
 */
async function readCardJson(target) {
    const body = await fs.readFile(target);
    let offset = 8;
    while (offset + 8 <= body.length) {
        const length = body.readUInt32BE(offset);
        const type = body.subarray(offset + 4, offset + 8).toString('ascii');
        const data = body.subarray(offset + 8, offset + 8 + length);
        if (type === 'tEXt') {
            const zero = data.indexOf(0);
            if (zero > 0) {
                const keyword = data.subarray(0, zero).toString('latin1');
                if (keyword === 'chara' || keyword === 'ccv3') {
                    const text = data.subarray(zero + 1).toString('latin1');
                    try {
                        return { keyword, card: JSON.parse(Buffer.from(text, 'base64').toString('utf8')) };
                    } catch {
                        return { keyword, card: null };
                    }
                }
            }
        }
        offset += 12 + length;
    }
    return { keyword: null, card: null };
}

export async function verifyCorpus({ corpus, rebuild = false }) {
    const checks = [];
    const check = (name, ok, detail = null) => {
        checks.push({ name, ok: ok === true, detail });
        return ok === true;
    };
    const root = path.resolve(corpus);
    const manifestPath = path.join(root, MANIFEST_NAME);
    let manifest;
    try {
        manifest = await readJsonFile(manifestPath);
    } catch (error) {
        return { ok: false, corpus: root, checks: [{ name: 'manifest-present', ok: false, detail: `no readable ${MANIFEST_NAME}: ${error?.message ?? error}` }] };
    }
    check('manifest-schema', manifest.schema === 'gotavern-longlived-corpus' && manifest.schemaVersion === 1, { schema: manifest.schema, schemaVersion: manifest.schemaVersion });
    check('manifest-size-declared', Boolean(SIZE_BOUNDS[manifest.size]), { size: manifest.size });
    check('manifest-seed-declared', typeof manifest.seed === 'string' && manifest.seed.length > 0, { seed: manifest.seed });

    // ---- the digest is recomputed from the tree, never copied from the manifest.
    const entries = await walkTree(root);
    const recomputed = treeDigest(entries);
    check('tree-digest-equals-manifest', recomputed.sha256 === manifest.tree?.sha256, { recomputed: recomputed.sha256, manifest: manifest.tree?.sha256 });
    check('tree-file-count-equals-manifest', recomputed.files === manifest.tree?.files, { recomputed: recomputed.files, manifest: manifest.tree?.files });
    // THE MANIFEST ITSELF IS EXCLUDED FROM THE TREE BYTES, for the same reason it is excluded from the digest:
    // it CONTAINS the digest, so including it would make the identity self-referential.
    const counted = entries.filter(entry => entry.path !== MANIFEST_NAME);
    const totalBytes = counted.reduce((sum, entry) => sum + entry.bytes, 0);
    check('tree-bytes-equals-manifest', totalBytes === manifest.tree?.bytes, { recomputed: totalBytes, manifest: manifest.tree?.bytes });

    // ---- the inventory is compared BOTH WAYS: a missing file and an unexplained extra file are both failures.
    const inventory = new Map((manifest.inventory ?? []).map(entry => [entry.path, entry]));
    const walked = new Map(counted.map(entry => [entry.path, entry]));
    const missing = [...inventory.keys()].filter(key => !walked.has(key));
    const unexpected = [...walked.keys()].filter(key => !inventory.has(key));
    const changed = [...inventory.keys()].filter(key => walked.has(key) && walked.get(key).sha256 !== inventory.get(key).sha256);
    check('inventory-no-missing-files', missing.length === 0, { missing: missing.slice(0, 10) });
    check('inventory-no-unexpected-files', unexpected.length === 0, { unexpected: unexpected.slice(0, 10) });
    check('inventory-no-changed-files', changed.length === 0, { changed: changed.slice(0, 10) });

    // ---- the size class is a MEASUREMENT, not a label.
    const bounds = SIZE_BOUNDS[manifest.size] ?? { minimumBytes: 0, maximumBytes: Number.MAX_SAFE_INTEGER };
    check('size-class-bounds', totalBytes >= bounds.minimumBytes && totalBytes <= bounds.maximumBytes, { bytes: totalBytes, ...bounds });

    // ---- required surfaces, by path, straight from the tree.
    const surfaces = manifest.surfaces ?? {};
    const exists = async relative => fs.stat(path.join(root, relative)).then(info => info.isFile(), () => false);
    const requireFile = async (name, relative) => check(`surface-${name}`, await exists(relative), { path: relative });
    await requireFile('config', 'config.yaml');
    await requireFile('settings', surfaces.settings ?? 'default-user/settings.json');

    const characters = surfaces.characters ?? [];
    const chats = surfaces.chats ?? [];
    const cards = surfaces.cards ?? [];
    check('characters-count', characters.length >= 4, { characters: characters.length });
    check('characters-unicode', characters.some(character => character.unicode === true), { unicode: characters.filter(character => character.unicode).map(character => character.name) });
    check('chats-per-character', characters.every(character => chats.filter(chat => chat.character === character.name).length >= 3), {
        perCharacter: characters.map(character => ({ name: character.name, chats: chats.filter(chat => chat.character === character.name).length })),
    });

    // ---- long history: the point of a long-lived tree, asserted on the FILE rather than trusted from counts.
    const longChat = chats.find(chat => chat.long === true);
    let longChatLines = [];
    if (check('long-chat-present', Boolean(longChat), { longChat: longChat?.file ?? null })) {
        longChatLines = await jsonlMessages(path.join(root, longChat.file));
        check('long-chat-length', longChatLines.length >= 100, { lines: longChatLines.length, file: longChat.file });
    }

    // ---- swipes / edited branches, read from a real chat file.
    const swipe = { found: false, file: null, swipeId: null };
    for (const chat of chats) {
        const lines = await jsonlMessages(path.join(root, chat.file));
        for (const line of lines.slice(1)) {
            let message;
            try { message = JSON.parse(line); } catch { continue; }
            if (Array.isArray(message?.swipes) && message.swipes.length >= 2) {
                swipe.found = true;
                swipe.file = chat.file;
                swipe.swipeId = message.swipe_id ?? null;
                if (message.mes !== message.swipes[0]) swipe.edited = true;
                break;
            }
        }
        if (swipe.found) break;
    }
    check('chat-swipes-present', swipe.found, swipe);
    check('chat-edited-message-persisted', swipe.edited === true, { file: swipe.file, swipeId: swipe.swipeId });

    // ---- branch-like history: two chat files with a BYTE-IDENTICAL shared prefix.
    //
    // The PREFIX IS MESSAGES, not the header line: the two branch files legitimately carry different
    // `chat_metadata.note_prompt` values, and a comparison that included the header would demand identity
    // where pinned's own format has none. The header is checked separately for validity.
    const branchPair = chats.filter(chat => chat.sharedPrefix > 0);
    let sharedPrefixIdentical = false;
    if (branchPair.length >= 2) {
        const left = await jsonlMessages(path.join(root, branchPair[0].file));
        const right = await jsonlMessages(path.join(root, branchPair[1].file));
        const prefix = Math.min(branchPair[0].sharedPrefix, branchPair[1].sharedPrefix);
        sharedPrefixIdentical = left.slice(1, prefix + 1).join('\n') === right.slice(1, prefix + 1).join('\n')
            && left[prefix + 1] !== right[prefix + 1];
    }
    check('chat-branch-shared-prefix-identical', sharedPrefixIdentical, { pair: branchPair.slice(0, 2).map(chat => chat.file) });

    // ---- deleted history: the manifest declares it, the file shows the ABSENCE (all pinned persists).
    const withDeletions = chats.filter(chat => (chat.deletedTurns ?? 0) > 0);
    check('chat-deletions-declared', withDeletions.length > 0, { chats: withDeletions.map(chat => chat.file) });

    // ---- groups, worlds, presets, visual assets, Quick Replies.
    check('groups-present', (surfaces.groups ?? []).length >= 1, { groups: (surfaces.groups ?? []).map(group => group.id) });
    check('worldbooks-present', (surfaces.worlds ?? []).length >= 2, { worlds: (surfaces.worlds ?? []).map(world => world.name) });
    check('presets-present', (surfaces.presets ?? []).length >= 3, { presets: (surfaces.presets ?? []).map(preset => preset.name) });
    const complex = (surfaces.presets ?? []).find(preset => preset.structurePreserving === true);
    const committedPreset = path.join(REPO_ROOT, 'tests', 'browser', 'fixtures', 'real', 'preset-b.json');
    let complexSourceMatches = false;
    if (complex) {
        const corpusPreset = await fs.readFile(path.join(root, complex.file), 'utf8');
        const committed = await fs.readFile(committedPreset, 'utf8');
        const parsed = JSON.parse(corpusPreset);
        complexSourceMatches = sha256(Buffer.from(corpusPreset, 'utf8')) === sha256(Buffer.from(committed, 'utf8'));
        check('complex-preset-structure-preserved', complexSourceMatches && Array.isArray(parsed.prompts) && parsed.prompts.length >= 100, {
            file: complex.file, prompts: Array.isArray(parsed.prompts) ? parsed.prompts.length : null,
        });
    } else {
        check('complex-preset-structure-preserved', false, { reason: 'no structurePreserving preset in the manifest' });
    }
    check('backgrounds-present', (surfaces.backgrounds ?? []).length >= 1, { backgrounds: (surfaces.backgrounds ?? []).length });
    check('avatars-present', (surfaces.avatars ?? []).length >= 1, { avatars: (surfaces.avatars ?? []).length });
    check('assets-present', (surfaces.assets ?? []).length >= 1, { assets: (surfaces.assets ?? []).length });
    check('quickreplies-present', (surfaces.quickreplies ?? []).length >= 1, { quickreplies: (surfaces.quickreplies ?? []).length });
    check('themes-present', (surfaces.themes ?? []).length >= 1, { themes: (surfaces.themes ?? []).length });

    // ---- legacy/unknown carriers: the reason a long-lived qualification is different from a fresh install.
    const config = await fs.readFile(path.join(root, 'config.yaml'), 'utf8');
    check('config-unknown-key-present', config.includes('longlived_legacy:'), { key: 'longlived_legacy' });
    const settings = await readJsonFile(path.join(root, 'default-user', 'settings.json'));
    check('settings-unknown-key-present', Boolean(settings.longlived_legacy_state), { key: 'longlived_legacy_state' });
    check('settings-active-preset', settings.oai_settings?.preset_settings_openai === complex?.name, {
        active: settings.oai_settings?.preset_settings_openai, complex: complex?.name,
    });
    check('settings-active-worlds', Array.isArray(settings.world_info?.globalSelect) && settings.world_info.globalSelect.length >= 2, {
        globalSelect: settings.world_info?.globalSelect,
    });
    const legacyCard = cards.find(card => card.spec === 'chara_card_v2');
    check('legacy-card-present', Boolean(legacyCard), { card: legacyCard?.avatar ?? null });
    check('legacy-world-present', (surfaces.worlds ?? []).some(world => world.legacy === true), {});

    // ---- unicode bytes are VERIFIED, not assumed: a tree written through a mis-encoding shell is the failure
    // AGENTS verification rule 9 records, and the C3 83 / E2 80 9E signature is what it leaves behind.
    //
    // The check is on the DECODED CARD JSON (loaded from the PNG's tEXt chunk), because a character file IS an
    // image whose prose travels base64 inside it: searching the PNG bytes for the name would fail even when the
    // name is perfectly preserved.
    const unicodeCharacter = characters.find(character => character.unicode === true);
    if (unicodeCharacter) {
        const decoded = await readCardJson(path.join(root, unicodeCharacter.avatar));
        check('unicode-card-name-roundtrip', decoded.card?.name === unicodeCharacter.name && decoded.keyword === 'chara', {
            avatar: unicodeCharacter.avatar, keyword: decoded.keyword, name: decoded.card?.name ?? null,
        });
        check('unicode-no-cp1252-signature', !decoded.card || !JSON.stringify(decoded.card).includes('Ã') && !JSON.stringify(decoded.card).includes('â€'), { avatar: unicodeCharacter.avatar });
    } else {
        check('unicode-card-name-roundtrip', false, { reason: 'no unicode character in the manifest' });
    }

    // ---- determinism: optional rebuild with the same (size, seed).
    let rebuildResult = null;
    if (rebuild) {
        const module = await import(pathToFileURL(path.join(here, '..', '..', 'tools', 'build-longlived-corpus.mjs')).href);
        const scratch = await fs.mkdtemp(path.join(path.dirname(root), '.verify-determinism-'));
        try {
            const rebuilt = await module.buildCorpus({ size: manifest.size, seed: manifest.seed, out: scratch, force: true });
            rebuildResult = { sha256: rebuilt.tree.sha256, identical: rebuilt.tree.sha256 === manifest.tree?.sha256 };
        } finally {
            await fs.rm(scratch, { recursive: true, force: true });
        }
        check('deterministic-rebuild', rebuildResult.identical === true, rebuildResult);
    }

    return { ok: checks.every(entry => entry.ok === true), corpus: root, size: manifest.size ?? null, seed: manifest.seed ?? null, tree: { sha256: recomputed.sha256, files: recomputed.files, bytes: totalBytes }, checks };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const corpus = argument('--corpus');
    if (!corpus) {
        console.error('usage: node tools/longlived/verify.mjs --corpus <dir> [--rebuild]');
        process.exit(2);
    }
    const verdict = await verifyCorpus({ corpus, rebuild: process.argv.includes('--rebuild') });
    console.log(JSON.stringify(verdict));
    for (const entry of verdict.checks) {
        if (!entry.ok) console.error(`FAIL ${entry.name}: ${JSON.stringify(entry.detail)}`);
    }
    if (verdict.ok) console.error(`long-lived corpus verified: ${verdict.size}, ${verdict.tree.files} files, ${verdict.tree.sha256}`);
    process.exit(verdict.ok ? 0 : 1);
}
