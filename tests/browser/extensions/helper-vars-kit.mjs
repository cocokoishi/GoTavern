// THE PINNED TREE a variable/injection differential has to run on, the API surface it must RECORD rather than
// assume, and the REFUSALS that stop it running on anything else.
//
// WHY THIS IS A MODULE RATHER THAN PART OF THE PROBE. Several things here are preconditions in the sense AGENTS.md
// rule 7 means: if any is wrong the leg still boots, still drives a browser, still captures a provider request, and
// still looks green -- about a different preset, a different extension, or a variable nothing could ever resolve.
// Each is checked against INSTALLED BYTES before the browser starts, and the leg REFUSES rather than comparing.
//
//   1. THE EXTENSION IS THE PINNED ONE: commit from the checkout's own `git rev-parse HEAD`, version from the
//      installed `manifest.json`. Anything else is a refusal -- two different extensions are not a comparison.
//   2. THE API SURFACE IS READ, NOT ASSUMED. `readHelperApiSurface` parses the pinned `src/function/variables.ts`
//      and `src/function/index.ts` and reports exactly which names exist and which scopes have a `case`. The
//      artefact carries that list. Two consequences this repository has already paid for: there is NO `setVariables`
//      (the export is `insertOrAssignVariables`), and there is NO quiet/no-op option in the family at all -- so the
//      artefact RECORDS their absence instead of a test for a feature that does not exist.
//   3. THE TRIO IS SHAPED LIKE THE PRESET THAT IS ACTUALLY RUNNING. The stance is cloned at runtime and only prompt
//      CONTENT and one new order-row identifier change, so every member this module does not understand -- samplers,
//      vendored connection keys, order-group ids, unknown fields -- is carried through untouched. The decided group
//      id is REPORTED, never asserted from here.
//
// WHAT THE PRODUCT CLAIM ACTUALLY IS, and it has TWO halves that either alone cannot prove (a broken implementation
// satisfies one trivially): the helper writes a value, and (i) a live preset prompt's `{{getvar::x}}` resolves it
// during an ordinary Generate so the resolved text is in `messages[]` ON THE WIRE, and (ii) the value is re-readable
// FROM DISK after a fresh page and after a new server process. (i) alone is satisfied by a page-only write that is
// never saved; (ii) alone is satisfied by a write that never reaches a prompt. Neither is the claim.

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PINNED_EXTENSIONS } from '../pinned-extensions.mjs';

export const here = path.dirname(fileURLToPath(import.meta.url));
export const browserDirectory = path.resolve(here, '..');
export const repoRoot = path.resolve(here, '..', '..', '..');

export const PINNED_HELPER_COMMIT = PINNED_EXTENSIONS['tavern-helper'].commit;
export const PINNED_HELPER_VERSION = '4.11.3';
export const PINNED_BASELINE_COMMIT = '06bde939fb1e9c4c8d8641d810f0a9165b5ce127';

export const READY_PROBE_NAME = 'ready-probe';
export const TARGET_PRESET_NAME = 'probe-preset';
export const RESOLVE_IDENTIFIER = 'resolve_identity';

// The pinned sources the variable identities are read from, with the symbols each must still publish. A missing
// file, a missing symbol or a missing scope case is a refusal: this leg drives a specific API, and an API that
// moved is not the one the artefact claims to have measured.
export const VARIABLE_SEMANTICS_SOURCES = [
    {
        file: 'src/function/variables.ts',
        swift: 'variable-scopes',
        exports: [
            'registerVariableSchema', 'get_variables_without_clone', 'getVariables', '_getVariables',
            '_getAllVariables', 'replaceVariables', '_replaceVariables', 'updateVariablesWith',
            '_updateVariablesWith', 'insertOrAssignVariables', '_insertOrAssignVariables', 'insertVariables',
            '_insertVariables', 'deleteVariable', '_deleteVariable',
        ],
        scopes: ['chat', 'character', 'preset', 'global', 'message', 'script', 'extension'],
        // The absences this artefact STATES instead of testing. Each is a source-level fact at the pinned commit.
        absent: [
            { name: 'setVariables', why: 'this module exports no such function; the write API is insertOrAssignVariables / replaceVariables / updateVariablesWith' },
            { name: 'quiet option', why: 'every writer takes (variables, option) and nothing else -- there is no quiet/no-op flag in the family at the pinned commit' },
        ],
    },
    { file: 'src/function/inject.ts', exports: ['injectPrompts', 'uninjectPrompts', 'InjectionPrompt'] },
    // WHERE EACH SCOPE IS STORED. Reading these is what makes "global lives in settings, chat lives in the chat
    // file, character lives in the card, preset lives in the preset file" a measured statement.
    { file: 'src/store/settings/character.ts', exports: ['useCharacterSettingsStore', 'writeExtensionField'] },
    { file: 'src/store/settings/preset.ts', exports: ['usePresetSettingsStore', 'saveSettingsToFile'] },
    { file: 'src/type/settings.ts', exports: ['CharacterSettings', 'PresetSettings'] },
];

// THE HOST PAGE's macro surface. Both subjects serve the same pinned public/**, so this file must exist in THIS
// repository's upstream copy: the substitution the claim depends on is the frontend's `{{getvar::…}}`, not
// anything the extension adds. That distinction is the mechanism the artefact must state.
export const HOST_FILES = {
    macros: 'public/scripts/macros/definitions/variable-macros.js',
    variables: 'public/scripts/variables.js',
    context: 'public/scripts/st-context.js',
    openai: 'public/scripts/openai.js',
};
// The host macros a variable can be READ through, as `(name, promise-affected-scope)` pairs. `getvarkey` and
// `getglobalvarkey` are the nested-value readers; `message` appears in NONE, which is the finding.
export const HOST_VARIABLE_MACROS = ['getvar', 'getglobalvar', 'getvarkey', 'getglobalvarkey', 'hasvar', 'hasglobalvar'];

export const PROBE_MARKERS = {
    ready: 'HV-READY',
    first: 'HV-MARKET-ALPHA',
    second: 'HV-MARKET-BETA',
    global: 'HV-ROLE-SIGNAL',
    identity: 'HV-IDENTITY',
    injection: 'HV-INJECT-PROBE',
    charScope: 'HV-CHAR-SCOPE',
    chatTwo: 'HV-MARKET-CHAT-TWO',
    nested: 'gold',
    messageScope: 'HV-MESSAGE-SCOPE',
};

export const PROBE_CARD = {
    fileName: 'probe-vars-card',
    dataName: 'PROBE_VARS_CARD',
    chatPreset: 'probe-chat-preset',
    greeting: 'PROBE_CARD_GREETING',
    description: 'PROBE_CARD_DESCRIPTION',
    personality: 'PROBE_CARD_PERSONALITY',
    scenario: 'PROBE_CARD_SCENARIO',
};

async function readOrNull(target) {
    try {
        return await fs.readFile(target, 'utf8');
    } catch {
        return null;
    }
}

/** sha256 over a string OR a Buffer, so the same function serves a source file and a card's bytes. */
function digest(value) {
    return createHash('sha256').update(value).digest('hex');
}

/**
 * Reads the helper's variable/injection API surface out of the installed extension and REFUSES when it is not the
 * pinned one.
 *
 * The result is what the artefact carries: the exports that were found, the scopes that have a `case`, the absences
 * that were confirmed, and the digest of each file the answer came from.
 */
export async function readHelperApiSurface(installed, extensionDirectory) {
    const reasons = [];
    if (installed?.revision !== PINNED_HELPER_COMMIT) {
        reasons.push(`the installed extension is at ${installed?.revision ?? '(unknown)'}, not the pinned ${PINNED_HELPER_COMMIT}`);
    }
    const manifestText = await readOrNull(path.join(extensionDirectory, 'manifest.json'));
    let manifestVersion = null;
    if (manifestText === null) {
        reasons.push('the installed extension has no manifest.json, so its version cannot be read');
    } else {
        try {
            manifestVersion = JSON.parse(manifestText)?.version ?? null;
        } catch (error) {
            reasons.push(`the installed manifest.json is not JSON: ${error?.message ?? error}`);
        }
        if (manifestVersion !== PINNED_HELPER_VERSION) {
            reasons.push(`the installed manifest.json says version ${manifestVersion ?? '(none)'}, not the pinned ${PINNED_HELPER_VERSION}`);
        }
    }

    const sources = [];
    const found = { exports: {}, scopes: {}, absentConfirmed: [], absentUnexpected: [] };
    for (const source of VARIABLE_SEMANTICS_SOURCES) {
        const body = await readOrNull(path.join(extensionDirectory, source.file));
        if (body === null) {
            reasons.push(`${source.file} is missing from the installed extension, so the pinned variable semantics cannot be read`);
            sources.push({ file: source.file, present: false, sha256: null });
            continue;
        }
        const missing = (source.exports ?? []).filter(name => !new RegExp(`\\b${name}\\b`).test(body));
        if (missing.length > 0) {
            reasons.push(`${source.file} no longer defines ${missing.join(', ')}, so this leg would drive a different API than the one it read`);
        }
        for (const name of (source.exports ?? [])) found.exports[name] = !missing.includes(name);
        const scopes = (source.scopes ?? []).filter(scope => new RegExp(`case\\s+'${scope}'`).test(body));
        const absentScopes = (source.scopes ?? []).filter(scope => !scopes.includes(scope));
        if (absentScopes.length > 0) {
            reasons.push(`${source.file} has no ${absentScopes.map(scope => `'${scope}'`).join(' / ')} case, so the scope set this leg asserts does not exist at the pinned commit`);
        }
        for (const scope of scopes) found.scopes[scope] = true;
        // AN ABSENCE IS A MEASUREMENT TOO, AND A NEGATIVE NEEDS A POSITIVE CONTROL. `setVariables` must not exist,
        // and the assertions below would be vacuous if the reader could not find ANY name -- so the check is
        // "the known writers are present AND the named absence is not", never "the name is not there".
        for (const absence of source.absent ?? []) {
            const pattern = absence.name === 'setVariables' ? /\bsetVariables\b/ : /\bquiet\b/;
            if (pattern.test(body)) found.absentUnexpected.push({ name: absence.name, file: source.file, why: absence.why });
            else found.absentConfirmed.push({ name: absence.name, file: source.file, why: absence.why });
        }
        sources.push({ file: source.file, present: true, sha256: digest(body), byteLength: Buffer.byteLength(body), scopes, missingExports: missing });
    }

    const host = {};
    for (const [key, relative] of Object.entries(HOST_FILES)) {
        const body = await readOrNull(path.join(repoRoot, 'upstream', relative));
        if (body === null) {
            reasons.push(`the host page's ${relative} is missing from this repository's upstream copy`);
            host[key] = { file: relative, present: false, sha256: null };
            continue;
        }
        host[key] = { file: relative, present: true, sha256: digest(body), byteLength: Buffer.byteLength(body) };
        if (key === 'macros') {
            const declared = HOST_VARIABLE_MACROS.filter(name => new RegExp(`registerMacro\\('${name}'`).test(body));
            const missingMacros = HOST_VARIABLE_MACROS.filter(name => !declared.includes(name));
            host.declaredVariableMacros = declared;
            host.missingVariableMacros = missingMacros;
            if (!declared.includes('getvar') || !declared.includes('getglobalvar')) {
                reasons.push(`${relative} no longer registers getvar and getglobalvar, so a prompt cannot resolve a variable`);
            }
            // THE MESSAGE SCOPE HAS NO MACRO. This is the finding, asserted as an ABSENCE WITH A POSITIVE CONTROL:
            // the readers that must exist do exist (asserted above), and no reader mentions the message scope.
            host.messageScopeMacro = declared.some(name => /message/i.test(name)) || /message_id/.test(body);
        }
    }
    // THE HOST ACCESSOR THE MACROS CALL. `ctx.variables.local.get` reads chat_metadata.variables; that binding is
    // what makes a chat-scope helper write visible to `{{getvar}}` at all.
    const contextBody = await readOrNull(path.join(repoRoot, 'upstream', HOST_FILES.context));
    if (contextBody !== null) {
        host.variablesBinding = /variables:\s*\{[\s\S]{0,600}?local:\s*\{[\s\S]{0,300}?get:/.test(contextBody);
        if (!host.variablesBinding) reasons.push(`${HOST_FILES.context} no longer exposes variables.local.get, so a macro could not read a helper-written chat variable`);
    }

    return {
        pinned: reasons.length === 0,
        reasons,
        pinnedCommit: PINNED_HELPER_COMMIT,
        pinnedVersion: PINNED_HELPER_VERSION,
        manifestVersion,
        baselineCommit: PINNED_BASELINE_COMMIT,
        exports: found.exports,
        scopes: found.scopes,
        absentConfirmed: found.absentConfirmed,
        absentUnexpected: found.absentUnexpected,
        sources,
        host,
    };
}

/**
 * Reads the committed desensitised preset fixture. Its own prompt table is the CONTENT SOURCE for the prompts this
 * leg replaces by markers, and its digest is recorded so the derivation is named rather than implied.
 */
export async function readCommittedPreset() {
    for (const name of ['preset-a.json', 'preset-b.json']) {
        const target = path.join(browserDirectory, 'fixtures', 'real', name);
        const body = await readOrNull(target);
        if (body === null) continue;
        let parsed = null;
        try {
            parsed = JSON.parse(body);
        } catch {
            continue;
        }
        if (!Array.isArray(parsed?.prompts) || !Array.isArray(parsed?.prompt_order)) continue;
        return {
            file: `tests/browser/fixtures/real/${name}`,
            byteLength: Buffer.byteLength(body),
            sha256: digest(body),
            document: parsed,
        };
    }
    throw new Error('no committed desensitised preset under tests/browser/fixtures/real carries prompts[] and prompt_order[]');
}

/** Marker content for the prompts this leg replaces, refreshed from the fixture's own prompt table. */
export function readyMarkers(marker) {
    return {
        main: `${marker}-MAIN char={{char}} user={{user}}`,
        enhanceDefinitions: `${marker}-ENHANCE`,
        charDescription: `${marker}-CHAR {{char}}`,
        charPersonality: `${marker}-PERSONA`,
        scenario: `${marker}-SCENARIO`,
        worldInfoBefore: `${marker}-WIBEFORE`,
        worldInfoAfter: `${marker}-WIAFTER`,
        personaDescription: `${marker}-USERPERSONA`,
        new_chat_prompt: `${marker}-NEWCHAT`,
        new_example_chat_prompt: `${marker}-NEWEXAMPLE`,
        continue_nudge_prompt: `${marker}-CONTINUE`,
        impersonation_prompt: `${marker}-IMPERSONATE`,
    };
}

/**
 * Builds a derived preset FROM THE RUNTIME STANCE, changing only prompt CONTENT plus exactly one new prompt and
 * one order row. Everything else is the runtime stance's own.
 *
 * `identity` is the template for the one appended prompt. It is where the variable reads live, and it is ONE prompt
 * with all of them so a single splice point carries every assertion; `role: 'system'` + `marker: true` puts it in
 * the marker position the order row names.
 */
export function buildTrio({ stance, readyMarker, identity }) {
    const markers = readyMarkers(readyMarker);
    const document = structuredClone(stance);
    const replaced = {};
    const missing = [];
    for (const [identifier, content] of Object.entries(markers)) {
        const prompt = (document.prompts ?? []).find(entry => entry.identifier === identifier);
        if (!prompt) {
            missing.push(identifier);
            continue;
        }
        replaced[identifier] = {
            byteLengthBefore: Buffer.byteLength(String(prompt.content ?? '')),
            byteLengthAfter: Buffer.byteLength(content),
        };
        prompt.content = content;
    }
    if (!(document.prompts ?? []).some(entry => entry.identifier === RESOLVE_IDENTIFIER)) {
        document.prompts.push({
            identifier: RESOLVE_IDENTIFIER,
            name: 'Probe identity',
            system_prompt: true,
            role: 'system',
            content: identity,
            injection_position: 0,
            injection_depth: 4,
            injection_order: 100,
            enabled: true,
            marker: true,
        });
    }
    const groups = Array.isArray(document.prompt_order) ? document.prompt_order : [];
    // THE GROUP PINNED READS. `dummyId: 100001` (openai.js:696-699) matched by PromptManager.js:1207-1208; any
    // other group is dead data. The id is REPORTED, so a stance without it is visible in the artefact.
    const group = groups.find(entry => String(entry.character_id) === '100001') ?? groups[0] ?? { character_id: '100001', order: [] };
    const created = !groups.includes(group);
    if (created) groups.unshift(group);
    group.order = Array.isArray(group.order) ? group.order : [];
    if (!group.order.some(row => row.identifier === RESOLVE_IDENTIFIER)) group.order.push({ identifier: RESOLVE_IDENTIFIER, enabled: true });
    document.prompt_order = groups;
    return {
        document,
        replaced,
        missingIdentifiers: missing,
        group: {
            usedGroupId: String(group.character_id),
            rows: group.order.length,
            created,
            orderGroupIds: groups.map(entry => String(entry.character_id)),
        },
    };
}

/** Writes the derived presets and reads each back, because a preset the manager did not pick up is a leg that compared the default. */
export async function writeProbePresets(dataRoot, writes) {
    const directory = path.join(dataRoot, 'default-user', 'OpenAI Settings');
    await fs.mkdir(directory, { recursive: true });
    const files = {};
    const shapes = {};
    for (const [key, { name, document }] of Object.entries(writes)) {
        const target = path.join(directory, `${name}.json`);
        await fs.writeFile(target, `${JSON.stringify(document, null, 2)}\n`);
        const readBack = await fs.readFile(target, 'utf8');
        const parsed = JSON.parse(readBack);
        files[key] = { name: `${name}.json`, sha256: digest(readBack), byteLength: Buffer.byteLength(readBack) };
        shapes[key] = { prompts: (parsed.prompts ?? []).length, orderGroups: (parsed.prompt_order ?? []).length };
    }
    return { files, shapes };
}

function crc32(bytes) {
    const table = [];
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
    }
    let crc = 0xffffffff;
    for (const byte of bytes) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([length, body, crc]);
}

function pngTextChunk(keyword, value) {
    return pngChunk('tEXt', Buffer.concat([Buffer.from(keyword, 'latin1'), Buffer.from([0]), Buffer.from(value, 'latin1')]));
}

/** The image chunks of a PNG verbatim (IHDR…IEND), ignoring any text payload it carried. */
export function imageChunksOnly(bytes) {
    const chunks = [];
    let offset = 8;
    while (offset + 8 <= bytes.length) {
        const length = bytes.readUInt32BE(offset);
        const type = bytes.toString('latin1', offset + 4, offset + 8);
        const end = offset + 8 + length + 4;
        if (end > bytes.length) throw new Error(`the PNG is truncated at chunk ${type}`);
        if (type !== 'tEXt' && type !== 'zTXt' && type !== 'iTXt') chunks.push(bytes.subarray(offset, end));
        if (type === 'IEND') break;
        offset = end;
    }
    if (chunks.length === 0) throw new Error('the PNG had no image chunks');
    return chunks;
}

/**
 * Writes <characters>/<name>.png: the fixture's image bytes plus THIS leg's own V3 payload.
 *
 * The fixture's JSON payload is the user's card data and is not copied (AGENTS 56). `extensions.chat` is the chat
 * preset trigger (`public/scripts/preset-manager.js` `autoSelectPreset` runs on CHAT_CHANGED), which is what makes
 * a chat opened on THIS card a chat whose preset is the trio -- the observable the leak test needs.
 */
export async function stageProbeCard(dataRoot) {
    const fixturePath = path.join(browserDirectory, 'fixtures', 'real', 'card-a.png');
    const fixture = await fs.readFile(fixturePath);
    const payload = {
        spec: 'chara_card_v3',
        spec_version: '3.0',
        name: PROBE_CARD.dataName,
        description: PROBE_CARD.description,
        personality: PROBE_CARD.personality,
        scenario: PROBE_CARD.scenario,
        first_mes: PROBE_CARD.greeting,
        mes_example: '',
        creator_notes: '',
        system_prompt: '',
        post_history_instructions: '',
        alternate_greetings: [],
        tags: [],
        creator: '',
        character_version: '',
        extensions: { chat: PROBE_CARD.chatPreset, talkativeness: '0.5', fav: false, world: '' },
        group_only_greetings: [],
    };
    const base64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
    const imageChunks = imageChunksOnly(fixture);
    const png = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        imageChunks[0],
        pngTextChunk('chara', base64),
        pngTextChunk('ccv3', base64),
        ...imageChunks.slice(1),
    ]);
    const charactersDirectory = path.join(dataRoot, 'default-user', 'characters');
    await fs.mkdir(charactersDirectory, { recursive: true });
    await fs.writeFile(path.join(charactersDirectory, `${PROBE_CARD.fileName}.png`), png);
    return {
        file: `${PROBE_CARD.fileName}.png`,
        byteLength: png.length,
        sha256: digest(png),
        payloadKeys: Object.keys(payload),
        chatPreset: PROBE_CARD.chatPreset,
        derivedFrom: 'tests/browser/fixtures/real/card-a.png',
        derivedHow: 'the fixture card\'s own image chunks with THIS leg\'s V3 tEXt payload; the fixture\'s JSON payload is the user\'s card data and is not copied',
    };
}

/** One chat per name in the shape pinned reads (`chats/<avatar without .png>/<name>.jsonl`, src/endpoints/chats.js:592-614). */
export async function seedChats(dataRoot, { avatar, names, firstUser, firstAssistant }) {
    const directory = path.join(dataRoot, 'default-user', 'chats', avatar);
    await fs.mkdir(directory, { recursive: true });
    const message = (name, is_user, mes) => JSON.stringify({ name, is_user, mes, send_date: 'October 24, 2026 10:00am', extra: {} });
    const files = [];
    for (const name of names) {
        await fs.writeFile(path.join(directory, `${name}.jsonl`), [
            JSON.stringify({ user_name: 'unused', character_name: avatar, chat_metadata: {} }),
            message('Probe User', true, firstUser),
            message(avatar, false, firstAssistant),
        ].join('\n') + '\n');
        files.push(`chats/${avatar}/${name}.jsonl`);
    }
    return { files, shape: 'header + 2 messages ({name,is_user,mes,send_date,extra})', chatMetadataVariables: 'absent on purpose: the artefact reports whether the first line GAINED a variables member' };
}

/** Every file under the data root, hashed, so "nothing was written outside the chat file" is a measurement. */
export async function hashTree(root, { skip = [] } = {}) {
    const files = {};
    const walk = async directory => {
        for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch(() => [])) {
            const full = path.join(directory, entry.name);
            const relative = path.relative(root, full).split(path.sep).join('/');
            if (skip.some(prefix => relative.startsWith(prefix))) continue;
            if (entry.isDirectory()) {
                await walk(full);
                continue;
            }
            // A file that cannot be read is recorded as null, NOT skipped: a skipped file is invisible to a
            // "nothing changed outside the chat" comparison, which is the only claim the tree is hashed for.
            files[relative] = await fs.readFile(full).then(bytes => digest(bytes), () => null);
        }
    };
    await walk(root);
    return files;
}

/** The first line of every chat file: the variable record a chat-scope write must land in. */
export async function readChatRecords(root) {
    const records = {};
    const walk = async directory => {
        for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch(() => [])) {
            const full = path.join(directory, entry.name);
            const relative = path.relative(root, full).split(path.sep).join('/');
            if (entry.isDirectory()) {
                await walk(full);
                continue;
            }
            if (!entry.name.endsWith('.jsonl')) continue;
            const body = await fs.readFile(full, 'utf8');
            const first = body.split('\n').find(line => line.trim() !== '');
            let header = null;
            try {
                header = JSON.parse(first);
            } catch {
                header = null;
            }
            records[relative] = {
                sha256: digest(body),
                byteLength: Buffer.byteLength(body),
                lines: body.split('\n').filter(line => line.trim() !== '').length,
                headerUnparsable: header === null,
                chatMetadataKeys: header ? Object.keys(header.chat_metadata ?? {}) : null,
                variables: header ? (header.chat_metadata?.variables ?? null) : null,
            };
        }
    };
    await walk(path.join(root, 'default-user', 'chats'));
    return records;
}

/** The `extensions.tavern_helper` of every chat-completion preset on disk. */
export async function readPresetStance(root, presetNames) {
    const found = {};
    for (const name of presetNames) {
        const body = await readOrNull(path.join(root, 'default-user', 'OpenAI Settings', `${name}.json`));
        if (body === null) {
            found[name] = { present: false };
            continue;
        }
        let parsed = null;
        try {
            parsed = JSON.parse(body);
        } catch (error) {
            found[name] = { present: true, parseError: String(error?.message ?? error) };
            continue;
        }
        found[name] = {
            present: true,
            sha256: digest(body),
            tavernHelper: parsed?.extensions?.tavern_helper ?? null,
            promptContents: Object.fromEntries((parsed?.prompts ?? []).map(prompt => [prompt.identifier, String(prompt.content ?? '')])),
        };
    }
    return found;
}

/** The global scope's own file. `extension_settings` lives in settings.json on disk. */
export async function readSettingsFile(root) {
    const body = await readOrNull(path.join(root, 'default-user', 'settings.json'));
    if (body === null) return { present: false };
    let parsed = null;
    try {
        parsed = JSON.parse(body);
    } catch (error) {
        return { present: true, parseError: String(error?.message ?? error) };
    }
    return {
        present: true,
        sha256: digest(body),
        variablesGlobal: parsed?.extension_settings?.variables?.global ?? null,
        hasVariablesGlobal: parsed?.extension_settings?.variables !== undefined,
    };
}

/** Reads `data.extensions.tavern_helper` out of a V3 card's tEXt chunk, without ever printing the card. */
export async function readCardStance(root) {
    const charactersDirectory = path.join(root, 'default-user', 'characters');
    const found = {};
    for (const name of await fs.readdir(charactersDirectory).catch(() => [])) {
        if (!name.endsWith('.png')) continue;
        const bytes = await fs.readFile(path.join(charactersDirectory, name));
        found[name] = { sha256: digest(bytes), byteLength: bytes.length, tavernHelper: extractCardTavernHelper(bytes) };
    }
    return found;
}

export function extractCardTavernHelper(bytes) {
    let offset = 8;
    while (offset + 8 <= bytes.length) {
        const length = bytes.readUInt32BE(offset);
        const type = bytes.toString('latin1', offset + 4, offset + 8);
        if (type === 'tEXt') {
            const chunk = bytes.subarray(offset + 8, offset + 8 + length);
            const zero = chunk.indexOf(0);
            const keyword = chunk.subarray(0, zero).toString('latin1').toLowerCase();
            if (keyword === 'chara' || keyword === 'ccv3') {
                try {
                    const parsed = JSON.parse(Buffer.from(chunk.subarray(zero + 1).toString('latin1'), 'base64').toString('utf8'));
                    return {
                        keyword,
                        present: parsed?.data?.extensions?.tavern_helper !== undefined,
                        variables: parsed?.data?.extensions?.tavern_helper?.variables ?? null,
                        chatPreset: parsed?.data?.extensions?.chat ?? null,
                    };
                } catch {
                    return { keyword, present: false, error: 'unparsable card payload' };
                }
            }
        }
        if (type === 'IEND') break;
        offset = offset + 8 + length + 4;
    }
    return null;
}

export { digest };
