#!/usr/bin/env node
// NODE -> GO -> NODE ROUND-TRIP QUALIFICATION over a Node-originated stock tree.
//
// THE QUESTION. `tools/build-node-stock-tree.mjs` records a tree the PINNED Node server wrote. This driver asks
// the only question that makes that tree evidence: does GoTavern open it, read every surface, write it back, and
// does the ORIGINAL pinned Node server then open GoTavern's output, read what Go wrote, and write again -- and
// does a final GoTavern boot read THAT? A round trip that loses one unknown key, re-encodes one filename, drops
// one swipe, truncates one JSONL file or rewrites one unrelated file is a failure here, named.
//
// THE SEQUENCE (every read is compared against the tree, not against a hand-written expectation):
//   0. generate the tree (unless --tree is supplied) and copy it into the qualification workspace;
//   1. GOTAVERN BOOTS AND READS: settings, characters (incl. alternate greetings, scoped regex, unknown
//      extensions), chats (message count, swipes/swipe_id, chat variables, unknown metadata), world book, group,
//      group chat, preset list + preset document, Quick Replies -- each compared to the recorded bytes;
//   2. GOTAVERN MUTATES through its own routes: append a chat message, add a swipe and select it, settings save
//      (new top-level key + a nested unknown key edited), character edit (description marker, preserving
//      alternates/extensions/chat binding), world-info edit (new entry);
//   3. TREE PRESERVATION after Go wrote: every file other than the declared mutation targets is byte-identical,
//      no file is added outside the declared boot allowlist, nothing is deleted, modes unchanged, no file that
//      had bytes is now empty, every JSON/JSONL file parses;
//   4. GOTAVERN RESTARTS, re-reads its mutations, mutates again, stops;
//   5. PINNED NODE BOOTS ON THE SAME TREE: reads back what Go wrote (chat messages + swipes + chat variables,
//      card edit, world entry, settings keys), then MUTATES (appends a message, saves a settings key) -- the
//      "continue" half is pinned's own chat-save route, the same route the frontend uses;
//   6. GOTAVERN BOOTS AGAIN and reads the Node mutation.
//
// HONEST LIMITS, stated where they apply rather than at the end:
//   - The stop is GRACEFUL on POSIX (SIGTERM, bounded) and is NOT on Windows: Windows cannot deliver SIGTERM to
//     a console process, so the Windows stop is abrupt and the restart is a crash-recovery restart. The report
//     records which mode ran; the Linux CI job is where the graceful claim is produced.
//   - No generation/provider request is made. The tree pins its provider at a closed loopback port on purpose;
//     "continue" means pinned's own chat-save route appended a persisted turn, not that a model answered.
//   - A pinned boot writes its regenerable caches under the data root (`_webpack`, `_cache`); they are excluded
//     from the comparison and COUNTED in the report, never silently ignored.
//
// USAGE
//   node tools/qualify-node-stock-tree.mjs --pinned ../SillyTavern --gotavern ./gotavern [--work DIR]
//        [--tree DIR --manifest FILE] [--report FILE] [--keep]
//   scripts/qualify-node-stock-tree.sh --pinned ../SillyTavern ...   (builds the binary, then calls this)

import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
    MARKERS, PINNED_COMMIT, PINNED_VERSION, PinnedSession, TREE_USER,
    cardDocument, choosePort, copyTree, diffEntries, fixedIso, formFromObject, globToRegExp, normalisedTreeDigest,
    readJSON, removeWithRetries, sha256, startPinnedServer, tempRoot, treeDigest, walkTreeDetailed, writeJSON,
} from './node-stock-tree/lib.mjs';
import { buildNodeStockTree, CHARACTERS, CHAT_NAME } from './build-node-stock-tree.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, '..');
const QUALIFIER = 'tools/qualify-node-stock-tree.mjs';

const GO_MARKERS = Object.freeze({
    append1: 'GO_NODE_STOCK_APPEND_ONE',
    append2: 'GO_NODE_STOCK_APPEND_TWO',
    swipe: 'GO_NODE_STOCK_SWIPE_ADDED',
    settingsKey: 'node_stock_go_write',
    settingsNested: 'GO_NODE_STOCK_NESTED_WRITE',
    characterEdit: 'GO_NODE_STOCK_DESCRIPTION_EDIT',
    worldEntry: 'GO_NODE_STOCK_WORLD_ENTRY',
    nodeAppend: 'NODE_NODE_STOCK_APPEND_AFTER_GO',
    nodeSettingsKey: 'node_stock_node_write',
});

// Files a boot or a mutation is ALLOWED to change. Each entry is a path pattern plus the reason; an unexpected
// change is a failure that names the path, so this list is the gate's whole permission model and is printed.
const GO_BOOT_CREATED = [
    ['data/_storage/*', 'GoTavern rewrites the node-persist account record it read (lastLogin/version fields)'],
    ['data/**/backups/*', "a settings save writes the pinned snapshot (settings_<handle>_<timestamp>.json) and a boot may take one"],
    ['data/**/stats.json', 'a boot may create or update the per-user statistics file pinned creates on first boot'],
    ['data/**/access.log', 'only written when listen mode is on; listed so a future change is visible rather than silent'],
    ['data/**/content.log', 'the content-seeding log is rewritten by a boot that checks for new default content'],
    ['data/**/.migrated', 'the system-prompt migration marker; GoTavern writes it per user (internal/startup/system_prompts.go:81), exactly as pinned does'],
    ['data/**/.gotavern-*', 'a temporary file from the settings writer; must not survive a stop, so a surviving one is reported below'],
];
const PINNED_BOOT_CREATED = [
    ['data/_webpack/**', "the pinned server's webpack build cache under <dataRoot>/_webpack (webpack.config.js)"],
    ['data/_cache/**', 'the pinned server\'s disk cache under <dataRoot>/_cache'],
    ['data/**/backups/*', 'pinned src/endpoints/settings.js init() backs up settings at every boot, named with generateTimestamp()'],
    ['data/**/stats.json', 'pinned collects per-user stats at boot'],
    ['data/**/.migrated', 'the system-prompt migration marker pinned also writes per user at boot'],
];
const RUNTIME_CACHES = [
    ['data/_webpack', "the pinned server's webpack build cache (regenerated by any pinned boot; excluded and counted)"],
    ['data/_cache', "the pinned server's disk cache (regenerated; excluded and counted)"],
    ['data/_uploads', "multer's temporary upload directory (regenerated; excluded and counted)"],
];

// Files whose CONTENT is a runtime stamp rather than user data. They are the same declarations the generator
// masks from its normalised digest, with the same reasons, and they are allowed to change (as well as appear)
// across a boot. Everything else that changes is a failure.
const BOOT_VOLATILE_CHANGED = [
    ['data/**/stats.json', 'the per-user statistics file carries a wall-clock collection time'],
    ['data/**/image-metadata.json', 'the background metadata index carries a wall-clock addedTimestamp'],
    ['data/**/.migrated', 'a one-time system-prompt migration marker'],
    ['data/**/backups/*', 'settings backups are named with generateTimestamp() and a settings save may take one'],
    ['data/_storage/*', 'the node-persist account record is rewritten by either runtime'],
];

// Immutable after generation: the directory names pinned wrote for the seeded installation assets.
const INSTALLATION_ASSETS = ['public', 'default', 'src', 'plugins'];

function parseArguments(argv) {
    const value = (name, fallback = null) => {
        const index = argv.indexOf(name);
        if (index < 0) return fallback;
        return argv[index + 1] ?? fallback;
    };
    return {
        pinned: value('--pinned'),
        tree: value('--tree'),
        manifest: value('--manifest'),
        report: value('--report'),
        work: value('--work'),
        gotavern: value('--gotavern'),
        repo: path.resolve(value('--repo', REPO_ROOT)),
        keep: argv.includes('--keep'),
        quiet: argv.includes('--quiet'),
        pinnedBootSeconds: Number(value('--pinned-boot-seconds', '900')),
        goBootSeconds: Number(value('--go-boot-seconds', '120')),
    };
}

class Report {
    constructor(options) {
        this.options = options;
        this.report = {
            schemaVersion: 1,
            qualifier: QUALIFIER,
            question: 'Does GoTavern read, mutate and preserve a tree the PINNED Node server wrote, and does pinned Node then read and continue what GoTavern wrote?',
            pinned: { commit: PINNED_COMMIT, version: PINNED_VERSION },
            platform: process.platform,
            gracefulStop: process.platform !== 'win32',
            phases: [],
            steps: [],
            conditions: [],
            tree: {},
            failure: null,
            startedAt: new Date().toISOString(),
        };
        this.phaseName = null;
        this.failed = [];
    }

    phase(name, detail = null) {
        this.phaseName = name;
        this.report.phases.push({ name, detail, startedAt: new Date().toISOString() });
        this.say(`\n=== ${name}${detail ? `: ${detail}` : ''}`);
    }

    say(message) {
        if (!this.options.quiet) process.stderr.write(`${message}\n`);
    }

    step(name, ok, detail = null) {
        const entry = { phase: this.phaseName, name, ok, detail };
        this.report.steps.push(entry);
        this.say(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail === null ? '' : ` -- ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 600)}`}`);
        return ok;
    }

    // An assertion that THROWS. Every red names the assertion, and the failure text carries the observed value, so
    // a red run is read from the log without opening the report.
    assert(name, ok, detail = null) {
        this.step(name, ok, detail);
        if (!ok) {
            const rendered = typeof detail === 'string' ? detail : JSON.stringify(detail);
            this.report.failure = `${name}: ${rendered}`;
            this.failed.push({ name, detail });
            throw new Error(`${name}: ${rendered}`);
        }
    }

    condition(name, ok, detail) {
        this.report.conditions.push({ phase: this.phaseName, name, ok, detail });
        return ok;
    }

    finish() {
        this.report.finishedAt = new Date().toISOString();
        this.report.ok = this.report.failure === null && this.failed.length === 0;
        return this.report;
    }
}

// ---------------------------------------------------------------------------------------------------------------
// SERVER LIFECYCLE
// ---------------------------------------------------------------------------------------------------------------
function goArgv({ binary, port, treeRoot }) {
    return [
        'start',
        '--port', String(port),
        '--dataRoot', path.join(treeRoot, 'data'),
        '--configPath', path.join(treeRoot, 'config.yaml'),
        // NEVER OPEN A BROWSER. This flag is mandatory for every GoTavern boot in this repository, and the
        // packaged gates pass it for exactly this reason.
        '--browserLaunchEnabled', 'false',
        '--listen', 'false',
        '--enableIPv4', 'true',
        '--enableIPv6', 'false',
        '--listenAddressIPv4', '127.0.0.1',
        '--heartbeatInterval', '0',
    ];
}

async function waitForLoginPage(origin, { seconds, label }) {
    const deadline = Date.now() + seconds * 1000;
    let last = null;
    while (Date.now() < deadline) {
        try {
            const response = await fetch(`${origin}/login?noauto=1`);
            if (response.status === 200) return { ready: true, waitedMs: seconds * 1000 - (deadline - Date.now()) };
            last = `GET /login answered ${response.status}`;
        } catch (error) {
            last = error?.message ?? String(error);
        }
        await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error(`${label} did not become ready within ${seconds}s: ${last}`);
}

async function startGotavern({ binary, treeRoot, report, label }) {
    const port = await choosePort();
    const origin = `http://127.0.0.1:${port}`;
    const logs = [];
    const started = Date.now();
    const child = spawn(binary, goArgv({ binary, port, treeRoot }), {
        cwd: treeRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: { ...process.env, GOTAVERN_STARTUP_TRACE: '1' },
    });
    child.stdout.on('data', chunk => logs.push(chunk.toString('utf8')));
    child.stderr.on('data', chunk => logs.push(chunk.toString('utf8')));
    try {
        const readiness = await waitForLoginPage(origin, { seconds: report.options.goBootSeconds, label: `${label} GoTavern` });
        report.step(`${label}.ready`, true, { port, waitedMs: readiness.waitedMs });
        return {
            origin, port, logs, child, started,
            stop: () => stopGotavern(child, logs, report),
        };
    } catch (error) {
        try { child.kill(); } catch { /* already gone */ }
        throw new Error(`${error.message}\n--- ${label} log tail ---\n${logs.join('').slice(-6000)}`);
    }
}

async function stopGotavern(child, logs, report) {
    if (!child || child.exitCode !== null) return { mode: 'already-exited', exitCode: child?.exitCode ?? null };
    // Windows has no deliverable SIGTERM for a console process: `child.kill()` is TerminateProcess. This is a
    // platform limit recorded in docs/dropin-qualification.md, and the report says which mode ran.
    if (process.platform === 'win32') {
        child.kill();
        const exited = await Promise.race([
            new Promise(resolve => child.once('exit', (code, signal) => resolve({ mode: 'abrupt-windows', exitCode: code, signal }))),
            new Promise(resolve => setTimeout(() => resolve(null), 15000)),
        ]);
        if (!exited) throw new Error(`the GoTavern process did not exit after TerminateProcess:\n${logs.join('').slice(-4000)}`);
        return exited;
    }
    child.kill('SIGTERM');
    const exited = await Promise.race([
        new Promise(resolve => child.once('exit', (code, signal) => resolve({ mode: 'SIGTERM', exitCode: code, signal }))),
        new Promise(resolve => setTimeout(() => resolve(null), 20000)),
    ]);
    if (exited) return exited;
    child.kill('SIGKILL');
    const forced = await Promise.race([
        new Promise(resolve => child.once('exit', (code, signal) => resolve({ mode: 'SIGKILL', exitCode: code, signal }))),
        new Promise(resolve => setTimeout(() => resolve(null), 5000)),
    ]);
    if (!forced) throw new Error(`the GoTavern process did not exit after SIGKILL:\n${logs.join('').slice(-4000)}`);
    return forced;
}

function assertGracefulStop(report, label, stop) {
    if (process.platform === 'win32') {
        // Declared limitation, not a pass: the process is gone and the data is durable, but no signal handler ran.
        report.condition(`${label}.gracefulStop`, false, { mode: stop.mode, note: 'Windows cannot deliver SIGTERM to a console process; the restart is a crash-recovery restart' });
        report.step(`${label}.stopped`, stop.exitCode !== null || stop.mode === 'abrupt-windows', stop);
        return;
    }
    report.assert(`${label}.gracefulStop`, stop.mode === 'SIGTERM' && (stop.exitCode === 0 || stop.exitCode === null), stop);
}

async function buildGotavernBinary({ repo, work, explicit, report }) {
    if (explicit) {
        const resolved = path.resolve(explicit);
        const stat = await fs.stat(resolved).catch(() => null);
        if (!stat?.isFile()) throw new Error(`--gotavern ${resolved} is not a readable file`);
        report.step('binary.explicit', true, resolved);
        return resolved;
    }
    const target = path.join(work, process.platform === 'win32' ? 'gotavern.exe' : 'gotavern');
    await new Promise((resolve, reject) => {
        execFile('go', ['build', '-trimpath', '-o', target, './cmd/gotavern'], { cwd: repo, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
            if (error) return reject(new Error(`go build ./cmd/gotavern failed: ${error.message}\n${stdout}\n${stderr}`));
            resolve();
        });
    });
    report.step('binary.built', true, target);
    return target;
}

// ---------------------------------------------------------------------------------------------------------------
// READS AND EXPECTATIONS DERIVED FROM THE RECORDED TREE
// ---------------------------------------------------------------------------------------------------------------
async function readTreeJSON(treeRoot, relative) {
    return JSON.parse(await fs.readFile(path.join(treeRoot, relative), 'utf8'));
}

async function readTreeJSONL(treeRoot, relative) {
    const body = await fs.readFile(path.join(treeRoot, relative), 'utf8');
    return body.split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(line));
}

function isDeepEqual(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
}

// Resolve the paths the generator report says it wrote, so the driver names no file the generator did not record.
function resolveExpected(report) {
    const surfaces = Object.fromEntries(report.surfaces.map(surface => [surface.id, surface.expected]));
    const characters = surfaces.characters;
    const primary = characters[0];
    const userRoot = `data/${TREE_USER.handle}`;
    return {
        surfaces,
        userRoot,
        primaryCharacter: {
            name: primary.name,
            avatar: primary.avatar,
            chat: primary.chat,
            card: `${userRoot}/characters/${primary.avatar}`,
            chatFile: `${userRoot}/chats/${primary.avatar.replace(/\.png$/, '')}/${primary.chat}.jsonl`,
        },
        secondCharacter: {
            name: characters[1].name,
            avatar: characters[1].avatar,
            card: `${userRoot}/characters/${characters[1].avatar}`,
        },
        worldFile: `${userRoot}/worlds/${surfaces['world-info'].name}.json`,
        presetFile: `${userRoot}/OpenAI Settings/${surfaces.presets.name}.json`,
        quickReplyFile: `${userRoot}/QuickReplies/${surfaces['quick-replies'].name}.json`,
        settingsFile: `${userRoot}/settings.json`,
        groupFile: `${userRoot}/groups/${surfaces.groups.id}.json`,
        groupChatFile: `${userRoot}/group chats/${surfaces.groups.chatId}.jsonl`,
        extensionDir: 'public/scripts/extensions/third-party/node-origin-extension',
    };
}

// ---------------------------------------------------------------------------------------------------------------
// TREE PRESERVATION
// ---------------------------------------------------------------------------------------------------------------
function patternToRegExp(pattern) {
    return globToRegExp(pattern);
}

function matchesAny(relative, patterns) {
    return patterns.some(entry => {
        const pattern = Array.isArray(entry) ? entry[0] : entry;
        return patternToRegExp(pattern).test(relative);
    });
}

function allowedCreated(relative, patterns) {
    return patterns.some(([pattern]) => patternToRegExp(pattern).test(relative));
}

/**
 * Compare the tree against the recorded manifest and return every difference, classified.
 *
 * `allowChanged` and `allowDeleted` are the mutation targets; anything else that changed is `unexpected`.
 * `allowCreated` entries carry their reason, so the report shows the permission model rather than only its answer.
 */
async function compareTree(treeRoot, beforeEntries, { allowChanged = [], allowCreated = [], allowDeleted = [], excluded = [] } = {}) {
    const { entries: afterEntries, skipped } = await walkTreeDetailed(treeRoot, { skip: excluded.map(([pattern]) => pattern) });
    const diff = diffEntries(beforeEntries, afterEntries);
    const classify = (list, allowed, isAllowed) => list.filter(entry => !isAllowed(entry.path, allowed));
    const allowChangedMatch = (relative, list) => list.some(entry => Array.isArray(entry) ? patternToRegExp(entry[0]).test(relative) : patternToRegExp(entry).test(relative));
    const unexpectedChanged = classify(diff.changed, allowChanged, allowChangedMatch);
    const unexpectedDeleted = classify(diff.deleted, allowDeleted, allowChangedMatch);
    const unexpectedCreated = diff.created.filter(entry => !allowedCreated(entry.path, allowCreated));
    const zeroByte = afterEntries.filter(entry => entry.bytes === 0 && !/(^|\/)(\.gitkeep|\.migrated|\.keep)$/.test(entry.path));
    const modes = diff.changed.filter(entry => {
        const previous = beforeEntries.find(candidate => candidate.path === entry.path);
        return previous && previous.mode !== entry.mode && previous.sha256 === entry.sha256;
    });
    return {
        afterEntries,
        created: diff.created,
        deleted: diff.deleted,
        changed: diff.changed,
        unexpectedCreated,
        unexpectedDeleted,
        unexpectedChanged,
        zeroByte,
        modeOnlyChanges: modes,
        excludedSkipped: skipped,
    };
}

async function assertTreeIntegrity(report, treeRoot, phaseName, excluded) {
    const { entries } = await walkTreeDetailed(treeRoot, { skip: excluded.map(([pattern]) => pattern) });
    const invalidJSON = [];
    const invalidJSONL = [];
    for (const entry of entries) {
        if (entry.path.endsWith('.json')) {
            try {
                JSON.parse(await fs.readFile(path.join(treeRoot, entry.path), 'utf8'));
            } catch (error) {
                invalidJSON.push({ path: entry.path, error: String(error.message).slice(0, 120) });
            }
        } else if (entry.path.endsWith('.jsonl')) {
            const body = await fs.readFile(path.join(treeRoot, entry.path), 'utf8');
            const lines = body.split('\n').filter(line => line.trim() !== '');
            for (const [index, line] of lines.entries()) {
                try {
                    JSON.parse(line);
                } catch (error) {
                    invalidJSONL.push({ path: entry.path, line: index + 1, error: String(error.message).slice(0, 120) });
                }
            }
        }
    }
    report.assert(`${phaseName}.everyJSONFileParses`, invalidJSON.length === 0, invalidJSON.slice(0, 10));
    report.assert(`${phaseName}.everyJSONLLineParses`, invalidJSONL.length === 0, invalidJSONL.slice(0, 10));

    // NO FILE THAT HAD BYTES MAY BECOME EMPTY. A truncated write is the failure this catches; the zero-byte
    // marker files the pinned server itself writes are excluded by name (they are recorded as empty).
    const empty = [];
    for (const entry of entries) {
        if (entry.bytes !== 0) continue;
        if (/(^|\/)(\.gitkeep|\.migrated|\.keep)$/.test(entry.path)) continue;
        empty.push(entry.path);
    }
    report.assert(`${phaseName}.noEmptyFiles`, empty.length === 0, empty.slice(0, 10));
}

// ---------------------------------------------------------------------------------------------------------------
// PHASE 1: GO READS
// ---------------------------------------------------------------------------------------------------------------
async function goLogin(session, label, report) {
    await session.login(TREE_USER.handle, TREE_USER.password);
    // `/api/users/me` is a GET route in pinned (src/endpoints/users-private.js) and in GoTavern; a POST is a
    // 404 on both and would make the login assertion vacuous, so this is the same read the frontend makes.
    const me = await session.getJSON('/api/users/me').catch(() => null);
    report.assert(`${label}.login`, me?.handle === TREE_USER.handle, { handle: me?.handle ?? null });
    return me;
}

async function gotavernReads({ session, treeRoot, expected, report, label, mutateFrom = null }) {
    // ---- settings: the whole document, compared field by field to the recorded file.
    const settingsOnDisk = await readTreeJSON(treeRoot, expected.settingsFile);
    const envelope = await session.postJSON('/api/settings/get', {});
    report.assert(`${label}.settingsIsJSONString`, typeof envelope?.settings === 'string', typeof envelope?.settings);
    const settingsRead = JSON.parse(envelope.settings);
    report.assert(`${label}.settingsUsername`, settingsRead.username === settingsOnDisk.username, { read: settingsRead.username, disk: settingsOnDisk.username });
    report.assert(`${label}.settingsPersona`, settingsRead.power_user?.default_persona === settingsOnDisk.power_user?.default_persona, { read: settingsRead.power_user?.default_persona, disk: settingsOnDisk.power_user?.default_persona });
    report.assert(`${label}.settingsPresetSelection`, settingsRead.oai_settings?.preset_settings_openai === settingsOnDisk.oai_settings?.preset_settings_openai, { read: settingsRead.oai_settings?.preset_settings_openai, disk: settingsOnDisk.oai_settings?.preset_settings_openai });
    report.assert(`${label}.settingsBackground`, settingsRead.background?.name === settingsOnDisk.background?.name, { read: settingsRead.background?.name, disk: settingsOnDisk.background?.name });
    report.assert(`${label}.settingsTheme`, settingsRead.power_user?.theme === settingsOnDisk.power_user?.theme, { read: settingsRead.power_user?.theme, disk: settingsOnDisk.power_user?.theme });
    // Unknown keys and an extension state subtree: the preservation claim starts here.
    report.assert(`${label}.settingsLegacyKey`, isDeepEqual(settingsRead[MARKERS.legacySetting], settingsOnDisk[MARKERS.legacySetting]), settingsRead[MARKERS.legacySetting] ?? null);
    report.assert(`${label}.settingsExtensionState`, isDeepEqual(settingsRead.extension_settings?.[MARKERS.extensionSetting], settingsOnDisk.extension_settings?.[MARKERS.extensionSetting]), settingsRead.extension_settings?.[MARKERS.extensionSetting] ?? null);
    report.assert(`${label}.settingsGlobalRegex`, isDeepEqual(settingsRead.extension_settings?.regex, settingsOnDisk.extension_settings?.regex), { read: settingsRead.extension_settings?.regex?.length ?? null });
    report.assert(`${label}.settingsGlobalVariables`, isDeepEqual(settingsRead.extension_settings?.variables?.global, settingsOnDisk.extension_settings?.variables?.global), settingsRead.extension_settings?.variables?.global ?? null);
    // Preset list and Quick Replies come from the directories, through the same route the frontend uses.
    // PINNED'S settings/get ANSWERS PRESET FILES AS JSON STRINGS, not objects: readPresetsFromDirectory pushes
    // `file` (the raw text) while readAndParseFromDirectory (themes/Quick Replies) parses. A driver that assumes
    // objects reports "count: 2" and never reads a preset, so each entry is parsed here and a parse failure is the
    // assertion instead of a silently skipped comparison.
    const presetDocuments = (Array.isArray(envelope.openai_settings) ? envelope.openai_settings : []).map(entry => {
        if (typeof entry === 'string') {
            try {
                return JSON.parse(entry);
            } catch {
                return null;
            }
        }
        return entry;
    });
    report.assert(`${label}.presetListed`, Array.isArray(envelope.openai_setting_names) && envelope.openai_setting_names.includes(expected.surfaces.presets.name), envelope.openai_setting_names ?? null);
    report.assert(`${label}.presetDocumentRead`, presetDocuments.some(preset => preset?.temperature === expected.surfaces.presets.temperature && Array.isArray(preset?.prompts) && preset.prompts.length === expected.surfaces.presets.prompts), { count: presetDocuments.length, temperatures: presetDocuments.map(preset => preset?.temperature ?? null) });
    report.assert(`${label}.quickRepliesListed`, Array.isArray(envelope.quickReplyPresets) && envelope.quickReplyPresets.some(preset => preset?.name === expected.surfaces['quick-replies'].name && preset?.qrList?.length === expected.surfaces['quick-replies'].items), (envelope.quickReplyPresets ?? []).map(preset => preset?.name ?? null));
    report.assert(`${label}.worldListed`, Array.isArray(envelope.world_names) && envelope.world_names.includes(expected.surfaces['world-info'].name), envelope.world_names ?? null);

    // ---- characters: every recorded card, its tracked fields, and the two surfaces a projection could drop.
    const roster = await session.postJSON('/api/characters/all', {});
    const rosterNames = (Array.isArray(roster) ? roster : []).map(entry => entry?.name ?? entry?.data?.name ?? null);
    for (const character of expected.surfaces.characters) {
        report.assert(`${label}.characterListed.${character.name}`, rosterNames.includes(character.name), rosterNames);
        const card = await session.postJSON('/api/characters/get', { avatar_url: character.avatar });
        const document = card?.data ? card : (card?.character ?? card);
        report.assert(`${label}.characterName.${character.name}`, document?.data?.name === character.name || document?.name === character.name, { read: document?.data?.name ?? document?.name });
        report.assert(`${label}.characterDescription.${character.name}`, typeof document?.description === 'string' && document.description.includes(character.description.slice(0, 32)), (document?.description ?? '').slice(0, 80));
        report.assert(`${label}.characterChatBinding.${character.name}`, document?.chat === character.chat, { read: document?.chat ?? null, disk: character.chat });
        report.assert(`${label}.characterAlternateGreetings.${character.name}`, Array.isArray(document?.data?.alternate_greetings) && document.data.alternate_greetings.length === character.alternateGreetings, { read: document?.data?.alternate_greetings?.length ?? null, disk: character.alternateGreetings });
        report.assert(`${label}.characterScopedRegex.${character.name}`, Array.isArray(document?.data?.extensions?.regex_scripts) && document.data.extensions.regex_scripts.length === 1, { read: document?.data?.extensions?.regex_scripts?.length ?? null });
        report.assert(`${label}.characterUnknownExtension.${character.name}`, document?.data?.extensions?.node_origin_unknown_character_extension?.keep === true, document?.data?.extensions?.node_origin_unknown_character_extension ?? null);
    }
    report.assert(`${label}.rosterIncludesSeededDefault`, rosterNames.includes('Seraphina'), rosterNames);

    // ---- the primary chat: message count, swipes/swipe_id, chat variables, unknown metadata.
    const chatOnDisk = await readTreeJSONL(treeRoot, expected.primaryCharacter.chatFile);
    const chatRead = await session.postJSON('/api/chats/get', {
        avatar_url: expected.primaryCharacter.avatar,
        file_name: expected.primaryCharacter.chat,
    });
    report.assert(`${label}.chatReadable`, Array.isArray(chatRead), { readType: typeof chatRead, length: Array.isArray(chatRead) ? chatRead.length : null });
    report.assert(`${label}.chatMessageCount`, chatRead.length === chatOnDisk.length, { read: chatRead.length, disk: chatOnDisk.length });
    report.assert(`${label}.chatHeaderMetadata`, isDeepEqual(chatRead[0]?.chat_metadata, chatOnDisk[0]?.chat_metadata), { read: chatRead[0]?.chat_metadata ?? null });
    // The swiped message: find it on disk rather than assuming an index, so a generator change cannot silently
    // move the assertion off the message it is about.
    const swipedOnDisk = chatOnDisk.find(message => Array.isArray(message?.swipes));
    const swipedRead = chatRead.find(message => Array.isArray(message?.swipes));
    report.assert(`${label}.chatSwipePresent`, Boolean(swipedRead), { messages: chatRead.length });
    report.assert(`${label}.chatSwipeAlternatives`, Array.isArray(swipedRead?.swipes) && swipedRead.swipes.length === swipedOnDisk.swipes.length, { read: swipedRead?.swipes?.length ?? null, disk: swipedOnDisk?.swipes?.length ?? null });
    report.assert(`${label}.chatSwipeSelection`, swipedRead?.swipe_id === swipedOnDisk.swipe_id && swipedRead?.mes === swipedOnDisk.swipes[swipedOnDisk.swipe_id], { readId: swipedRead?.swipe_id ?? null, diskId: swipedOnDisk?.swipe_id ?? null });
    report.assert(`${label}.chatUnknownMetadata`, isDeepEqual(chatRead[0]?.chat_metadata?.node_origin_unknown_chat_metadata, chatOnDisk[0]?.chat_metadata?.node_origin_unknown_chat_metadata), chatRead[0]?.chat_metadata?.node_origin_unknown_chat_metadata ?? null);
    const listedChats = await session.postJSON('/api/characters/chats', { avatar_url: expected.primaryCharacter.avatar });
    report.assert(`${label}.chatListedUnderCharacter`, JSON.stringify(listedChats ?? {}).includes(expected.primaryCharacter.chat), { count: Array.isArray(listedChats) ? listedChats.length : null });

    // ---- world book: entries and the unknown per-entry extension.
    const worldOnDisk = await readTreeJSON(treeRoot, expected.worldFile);
    const worldRead = await session.postJSON('/api/worldinfo/get', { name: expected.surfaces['world-info'].name });
    report.assert(`${label}.worldEntries`, Object.keys(worldRead?.entries ?? {}).length === Object.keys(worldOnDisk.entries).length, { read: Object.keys(worldRead?.entries ?? {}).length, disk: Object.keys(worldOnDisk.entries).length });
    report.assert(`${label}.worldUnknownEntryExtension`, isDeepEqual(worldRead?.entries?.['0']?.extensions, worldOnDisk.entries['0'].extensions), worldRead?.entries?.['0']?.extensions ?? null);
    report.assert(`${label}.worldUnknownTopLevel`, isDeepEqual(worldRead?.node_origin_unknown_world_field, worldOnDisk.node_origin_unknown_world_field), worldRead?.node_origin_unknown_world_field ?? null);

    // ---- group and its transcript.
    const groupsOnDisk = await readTreeJSON(treeRoot, expected.groupFile);
    const groupsRead = await session.postJSON('/api/groups/all', {});
    const groupRead = Array.isArray(groupsRead) ? groupsRead.find(entry => entry?.id === expected.surfaces.groups.id) : null;
    report.assert(`${label}.groupListed`, Boolean(groupRead), (Array.isArray(groupsRead) ? groupsRead : []).map(entry => entry?.id ?? null));
    report.assert(`${label}.groupMembers`, isDeepEqual(groupRead?.members, expected.surfaces.groups.members), { read: groupRead?.members ?? null });
    report.assert(`${label}.groupUnknownField`, isDeepEqual(groupRead?.node_origin_unknown_group_field, groupsOnDisk.node_origin_unknown_group_field), groupRead?.node_origin_unknown_group_field ?? null);
    const groupChatOnDisk = await readTreeJSONL(treeRoot, expected.groupChatFile);
    const groupChatRead = await session.postJSON('/api/chats/group/get', { id: expected.surfaces.groups.chatId });
    report.assert(`${label}.groupChatReadable`, Array.isArray(groupChatRead) && groupChatRead.length === groupChatOnDisk.length, { read: Array.isArray(groupChatRead) ? groupChatRead.length : typeof groupChatRead, disk: groupChatOnDisk.length });

    void mutateFrom;
}

async function goReads(ctx) {
    const { report, treeRoot, expected } = ctx;
    report.phase('1-gotavern-reads', 'GoTavern boots on the Node-written tree and reads every surface');
    const server = await startGotavern({ binary: ctx.binary, treeRoot, report, label: 'goRead' });
    ctx.servers.push({ name: 'goRead', server });
    try {
        const session = new PinnedSession(server.origin, 'gotavern-read');
        await goLogin(session, 'goRead', report);
        await gotavernReads({ session, treeRoot, expected, report, label: 'goRead' });
        return server;
    } finally {
        const stop = await server.stop();
        assertGracefulStop(report, 'goRead', stop);
    }
}

// ---------------------------------------------------------------------------------------------------------------
// PHASE 2+4: GO MUTATES (and restarts and mutates again)
// ---------------------------------------------------------------------------------------------------------------
async function mutateChat({ session, treeRoot, expected, report, label, marker, swipeMarker }) {
    const before = await session.postJSON('/api/chats/get', {
        avatar_url: expected.primaryCharacter.avatar,
        file_name: expected.primaryCharacter.chat,
    });
    report.assert(`${label}.chatReadBeforeMutate`, Array.isArray(before) && before.length > 0, { length: Array.isArray(before) ? before.length : null });
    const messages = structuredClone(before);
    messages.push({
        name: TREE_USER.name,
        is_user: true,
        is_system: false,
        send_date: fixedIso(600000),
        mes: marker,
        extra: { node_stock_go_append: true },
    });
    // A SWIPE WRITE, as the frontend persists it: append an alternative, select it, and make `mes` the selected
    // alternative. This is the field a naive "save the visible text" implementation loses.
    const swiped = messages.find(message => Array.isArray(message?.swipes));
    report.assert(`${label}.swipedMessageStillPresent`, Boolean(swiped), { messages: messages.length });
    swiped.swipes.push(swipeMarker);
    swiped.swipe_id = swiped.swipes.length - 1;
    swiped.mes = swipeMarker;
    const save = await session.post('/api/chats/save', {
        avatar_url: expected.primaryCharacter.avatar,
        file_name: expected.primaryCharacter.chat,
        chat: messages,
    });
    report.assert(`${label}.chatSaveAccepted`, save.status === 200, { status: save.status });
    const after = await session.postJSON('/api/chats/get', {
        avatar_url: expected.primaryCharacter.avatar,
        file_name: expected.primaryCharacter.chat,
    });
    report.assert(`${label}.chatAppendReadBack`, Array.isArray(after) && after.some(message => message?.mes === marker), { length: Array.isArray(after) ? after.length : null });
    const swipedAfter = after.find(message => Array.isArray(message?.swipes));
    report.assert(`${label}.chatSwipeReadBack`, swipedAfter?.swipes?.includes(swipeMarker) === true && swipedAfter?.mes === swipeMarker, { swipeId: swipedAfter?.swipe_id ?? null, alternatives: swipedAfter?.swipes?.length ?? null });
    return after.length;
}

async function mutateSettings({ session, treeRoot, expected, report, label, tag }) {
    const envelope = await session.postJSON('/api/settings/get', {});
    const settings = JSON.parse(envelope.settings);
    settings[GO_MARKERS.settingsKey] = { at: tag, phase: label };
    // A NESTED unknown key, edited rather than replaced: if the writer re-serialises through a schema, this is
    // the field that disappears first.
    settings[MARKERS.legacySetting] = { ...(settings[MARKERS.legacySetting] ?? {}), goWrite: `${GO_MARKERS.settingsNested}:${tag}` };
    settings.extension_settings = settings.extension_settings ?? {};
    settings.extension_settings[MARKERS.extensionSetting] = {
        ...(settings.extension_settings[MARKERS.extensionSetting] ?? {}),
        goWrite: `${GO_MARKERS.settingsNested}:${tag}`,
    };
    const save = await session.post('/api/settings/save', settings);
    report.assert(`${label}.settingsSaveAccepted`, save.status === 200, { status: save.status });
    const reread = JSON.parse((await session.postJSON('/api/settings/get', {})).settings);
    report.assert(`${label}.settingsGoKeyReadBack`, reread[GO_MARKERS.settingsKey]?.phase === label, reread[GO_MARKERS.settingsKey] ?? null);
    report.assert(`${label}.settingsNestedUnknownKeyRetained`, reread[MARKERS.legacySetting]?.goWrite === `${GO_MARKERS.settingsNested}:${tag}`, reread[MARKERS.legacySetting] ?? null);
    report.assert(`${label}.settingsExtensionStateRetained`, reread.extension_settings?.[MARKERS.extensionSetting]?.unknown_member?.keep === true && reread.extension_settings?.[MARKERS.extensionSetting]?.goWrite === `${GO_MARKERS.settingsNested}:${tag}`, reread.extension_settings?.[MARKERS.extensionSetting] ?? null);
    // Everything the node-origin generator wrote must still be there after Go's write.
    const onDisk = await readTreeJSON(treeRoot, expected.settingsFile);
    for (const key of ['firstRun', 'username', 'user_avatar', 'main_api', 'preset_settings', 'amount_gen', 'max_context', MARKERS.legacySetting]) {
        report.assert(`${label}.settingsOriginalField.${key}`, JSON.stringify(reread[key]) === JSON.stringify(onDisk[key]) || key === MARKERS.legacySetting, { read: typeof reread[key] === 'object' ? 'object' : reread[key], disk: typeof onDisk[key] === 'object' ? 'object' : onDisk[key] });
    }
    report.assert(`${label}.settingsPersonaRetained`, reread.power_user?.default_persona === onDisk.power_user?.default_persona, { read: reread.power_user?.default_persona, disk: onDisk.power_user?.default_persona });
    report.assert(`${label}.settingsPresetPromptsRetained`, Array.isArray(reread.oai_settings?.prompts) && reread.oai_settings.prompts.length === onDisk.oai_settings.prompts.length, { read: reread.oai_settings?.prompts?.length ?? null, disk: onDisk.oai_settings?.prompts?.length ?? null });
    report.assert(`${label}.settingsGlobalRegexRetained`, JSON.stringify(reread.extension_settings?.regex) === JSON.stringify(onDisk.extension_settings?.regex), { read: reread.extension_settings?.regex?.length ?? null });
    return reread;
}

async function mutateCharacter({ session, treeRoot, expected, report, label }) {
    const cardOnDisk = cardDocument(await fs.readFile(path.join(treeRoot, expected.primaryCharacter.card)));
    const cardRead = await session.postJSON('/api/characters/get', { avatar_url: expected.primaryCharacter.avatar });
    const document = cardRead?.data ? cardRead : (cardRead?.character ?? cardRead);
    report.assert(`${label}.characterReadBeforeEdit`, document?.data?.name === expected.primaryCharacter.name, { read: document?.data?.name ?? null });
    const data = document.data ?? {};
    const extensions = data.extensions ?? {};
    const depth = extensions.depth_prompt ?? {};
    const editedDescription = `${document.description}\n\n${GO_MARKERS.characterEdit}`;
    const fields = {
        avatar_url: expected.primaryCharacter.avatar,
        ch_name: data.name ?? document.name,
        description: editedDescription,
        personality: document.personality ?? data.personality ?? '',
        scenario: document.scenario ?? data.scenario ?? '',
        first_mes: document.first_mes ?? data.first_mes ?? '',
        mes_example: document.mes_example ?? data.mes_example ?? '',
        creator_notes: document.creatorcomment ?? data.creator_notes ?? '',
        system_prompt: data.system_prompt ?? '',
        post_history_instructions: data.post_history_instructions ?? '',
        creator: data.creator ?? '',
        character_version: data.character_version ?? '',
        talkativeness: String(document.talkativeness ?? extensions.talkativeness ?? 0.5),
        fav: document.fav === true || extensions.fav === true ? 'true' : 'false',
        world: extensions.world ?? '',
        depth_prompt_prompt: depth.prompt ?? '',
        depth_prompt_depth: String(depth.depth ?? 4),
        depth_prompt_role: depth.role ?? 'system',
        tags: Array.isArray(data.tags) ? data.tags.join(', ') : '',
        // The frontend's hidden #character_json_data carries the whole card so unknown fields survive an edit.
        json_data: JSON.stringify(document),
        // The extension document is deep-merged by the pinned route; sending back what it read is a no-op merge
        // that proves the round trip does not replace the extensions object.
        extensions: JSON.stringify(extensions),
        chat: document.chat,
        create_date: document.create_date,
        alternate_greetings: data.alternate_greetings ?? [],
    };
    // NO AVATAR FILE IS SENT. The pinned edit route only reads `request.file` when one is present; sending an
    // invalid image would make the route reject the edit for a reason that has nothing to do with persistence,
    // and sending a valid one would re-encode the avatar this test wants untouched.
    const edit = await session.postForm('/api/characters/edit', formFromObject(fields, null));
    report.assert(`${label}.characterEditAccepted`, edit.status === 200, { status: edit.status, body: edit.text.slice(0, 200) });
    const reread = await session.postJSON('/api/characters/get', { avatar_url: expected.primaryCharacter.avatar });
    const after = reread?.data ? reread : (reread?.character ?? reread);
    report.assert(`${label}.characterEditReadBack`, typeof after?.description === 'string' && after.description.includes(GO_MARKERS.characterEdit), { read: (after?.description ?? '').slice(-80) });
    report.assert(`${label}.characterAlternateGreetingsRetained`, isDeepEqual(after?.data?.alternate_greetings, cardOnDisk.data.alternate_greetings), { read: after?.data?.alternate_greetings?.length ?? null, disk: cardOnDisk.data.alternate_greetings.length });
    report.assert(`${label}.characterScopedRegexRetained`, isDeepEqual(after?.data?.extensions?.regex_scripts, cardOnDisk.data.extensions.regex_scripts), { read: after?.data?.extensions?.regex_scripts?.length ?? null });
    report.assert(`${label}.characterUnknownExtensionRetained`, isDeepEqual(after?.data?.extensions?.node_origin_unknown_character_extension, cardOnDisk.data.extensions.node_origin_unknown_character_extension), after?.data?.extensions?.node_origin_unknown_character_extension ?? null);
    report.assert(`${label}.characterChatBindingRetained`, after?.chat === cardOnDisk.chat, { read: after?.chat ?? null, disk: cardOnDisk.chat });
    return after;
}

async function mutateWorld({ session, treeRoot, expected, report, label }) {
    const worldOnDisk = await readTreeJSON(treeRoot, expected.worldFile);
    const world = await session.postJSON('/api/worldinfo/get', { name: expected.surfaces['world-info'].name });
    report.assert(`${label}.worldReadBeforeEdit`, Object.keys(world?.entries ?? {}).length === Object.keys(worldOnDisk.entries).length, { read: Object.keys(world?.entries ?? {}).length });
    const uid = String(Object.keys(world.entries).length + 100);
    world.entries[uid] = {
        uid: Number(uid),
        key: [GO_MARKERS.worldEntry],
        keysecondary: [],
        comment: GO_MARKERS.worldEntry,
        content: `${GO_MARKERS.worldEntry}_CONTENT`,
        constant: true,
        selective: false,
        order: 999,
        position: 0,
        disable: false,
        depth: 4,
        extensions: { node_origin_unknown_entry_extension: 'go-wrote-this' },
    };
    const edit = await session.post('/api/worldinfo/edit', { name: expected.surfaces['world-info'].name, data: world });
    report.assert(`${label}.worldEditAccepted`, edit.status === 200, { status: edit.status });
    const reread = await session.postJSON('/api/worldinfo/get', { name: expected.surfaces['world-info'].name });
    report.assert(`${label}.worldEntryReadBack`, reread?.entries?.[uid]?.content === `${GO_MARKERS.worldEntry}_CONTENT`, reread?.entries?.[uid] ?? null);
    report.assert(`${label}.worldExistingEntriesRetained`, Object.keys(reread?.entries ?? {}).length === Object.keys(worldOnDisk.entries).length + 1, { read: Object.keys(reread?.entries ?? {}).length, disk: Object.keys(worldOnDisk.entries).length });
    return reread;
}

async function goMutatesAndRestarts(ctx) {
    const { report, treeRoot, expected, binary } = ctx;
    report.phase('2-gotavern-mutates', 'GoTavern writes through its own API, restarts, and writes again');
    const server = await startGotavern({ binary, treeRoot, report, label: 'goWrite1' });
    try {
        const session = new PinnedSession(server.origin, 'gotavern-write');
        await goLogin(session, 'goWrite1', report);
        await mutateChat({ session, treeRoot, expected, report, label: 'goWrite1', marker: GO_MARKERS.append1, swipeMarker: GO_MARKERS.swipe });
        await mutateSettings({ session, treeRoot, expected, report, label: 'goWrite1', tag: 'one' });
        await mutateCharacter({ session, treeRoot, expected, report, label: 'goWrite1' });
        await mutateWorld({ session, treeRoot, expected, report, label: 'goWrite1' });
    } finally {
        ctx.goWrite1Stop = await server.stop();
        assertGracefulStop(report, 'goWrite1', ctx.goWrite1Stop);
    }
    await assertTreeIntegrity(report, treeRoot, 'afterGoWrite1', RUNTIME_CACHES);
    ctx.preservationAfterGo = await compareTree(treeRoot, ctx.pristineEntries, {
        allowChanged: [
            [expected.primaryCharacter.chatFile, 'the chat this phase appends to and swipes'],
            [expected.primaryCharacter.card, 'the card this phase edits'],
            [expected.worldFile, 'the world book this phase edits'],
            [expected.settingsFile, 'the settings this phase saves'],
            ...BOOT_VOLATILE_CHANGED,
        ],
        allowCreated: GO_BOOT_CREATED,
        allowDeleted: [],
        excluded: RUNTIME_CACHES,
    });
    reportPreservation(report, 'afterGoWrite1', ctx.preservationAfterGo);

    // ---- restart: the mutations must be durable across a process boundary, and a second boot must accept the
    // tree its predecessor wrote.
    report.phase('2b-gotavern-restarts', 'a second GoTavern boot reads the first boot\'s writes and writes again');
    const second = await startGotavern({ binary, treeRoot, report, label: 'goWrite2' });
    try {
        const session = new PinnedSession(second.origin, 'gotavern-write-2');
        await goLogin(session, 'goWrite2', report);
        const chat = await session.postJSON('/api/chats/get', {
            avatar_url: expected.primaryCharacter.avatar,
            file_name: expected.primaryCharacter.chat,
        });
        report.assert('goWrite2.appendSurvivedRestart', Array.isArray(chat) && chat.some(message => message?.mes === GO_MARKERS.append1), { length: Array.isArray(chat) ? chat.length : null });
        report.assert('goWrite2.swipeSurvivedRestart', chat.some(message => Array.isArray(message?.swipes) && message.swipes.includes(GO_MARKERS.swipe)), null);
        const settings = JSON.parse((await session.postJSON('/api/settings/get', {})).settings);
        report.assert('goWrite2.settingsSurvivedRestart', settings[GO_MARKERS.settingsKey]?.phase === 'goWrite1', settings[GO_MARKERS.settingsKey] ?? null);
        const card = await session.postJSON('/api/characters/get', { avatar_url: expected.primaryCharacter.avatar });
        const document = card?.data ? card : (card?.character ?? card);
        report.assert('goWrite2.characterEditSurvivedRestart', String(document?.description ?? '').includes(GO_MARKERS.characterEdit), (document?.description ?? '').slice(-60));
        const world = await session.postJSON('/api/worldinfo/get', { name: expected.surfaces['world-info'].name });
        report.assert('goWrite2.worldEditSurvivedRestart', Object.values(world?.entries ?? {}).some(entry => entry?.content === `${GO_MARKERS.worldEntry}_CONTENT`), null);
        await mutateChat({ session, treeRoot, expected, report, label: 'goWrite2', marker: GO_MARKERS.append2, swipeMarker: `${GO_MARKERS.swipe}_TWO` });
        await mutateSettings({ session, treeRoot, expected, report, label: 'goWrite2', tag: 'two' });
    } finally {
        ctx.goWrite2Stop = await second.stop();
        assertGracefulStop(report, 'goWrite2', ctx.goWrite2Stop);
    }
    await assertTreeIntegrity(report, treeRoot, 'afterGoWrite2', RUNTIME_CACHES);
    ctx.preservationAfterGo2 = await compareTree(treeRoot, ctx.pristineEntries, {
        allowChanged: [
            [expected.primaryCharacter.chatFile, 'the chat both Go phases write'],
            [expected.primaryCharacter.card, 'the card Go edits'],
            [expected.worldFile, 'the world book Go edits'],
            [expected.settingsFile, 'the settings both Go phases save'],
            ...BOOT_VOLATILE_CHANGED,
        ],
        allowCreated: GO_BOOT_CREATED,
        allowDeleted: [],
        excluded: RUNTIME_CACHES,
    });
    reportPreservation(report, 'afterGoWrite2', ctx.preservationAfterGo2);
}

// The preservation verdict, as assertions. Each list is named, so a red says "created X that was not declared"
// rather than "the tree changed".
function reportPreservation(report, label, comparison) {
    // The comparison is recorded BEFORE the assertions, so a red run's report still carries the whole difference
    // list a reader needs to decide whether the permission model or the product is wrong.
    report.report.preservation = report.report.preservation ?? {};
    report.report.preservation[label] = summariseComparison(comparison);
    report.assert(`${label}.noUnexpectedCreatedFile`, comparison.unexpectedCreated.length === 0, comparison.unexpectedCreated.slice(0, 10).map(entry => entry.path));
    report.assert(`${label}.noUnexpectedDeletedFile`, comparison.unexpectedDeleted.length === 0, comparison.unexpectedDeleted.slice(0, 10).map(entry => entry.path));
    report.assert(`${label}.noUnexpectedChangedFile`, comparison.unexpectedChanged.length === 0, comparison.unexpectedChanged.slice(0, 10).map(entry => `${entry.path} ${entry.sha256.slice(0, 12)}`));
    report.assert(`${label}.noEmptyFiles`, comparison.zeroByte.length === 0, comparison.zeroByte.slice(0, 10).map(entry => entry.path));
    report.assert(`${label}.noModeOnlyChanges`, comparison.modeOnlyChanges.length === 0, comparison.modeOnlyChanges.slice(0, 10).map(entry => entry.path));
    report.step(`${label}.declaredCreates`, true, comparison.created.map(entry => entry.path).slice(0, 40));
    report.step(`${label}.declaredChanges`, true, comparison.changed.map(entry => entry.path).slice(0, 40));
    // The extension tree is checked as its own claim: it must be untouched by both runtimes.
    const extensionChanges = comparison.changed.filter(entry => entry.path.startsWith('public/scripts/extensions/'));
    report.assert(`${label}.extensionTreeUntouched`, extensionChanges.length === 0, extensionChanges.map(entry => entry.path));
}

// ---------------------------------------------------------------------------------------------------------------
// PHASE 3: PINNED NODE READS AND CONTINUES WHAT GO WROTE
// ---------------------------------------------------------------------------------------------------------------
async function pinnedReadsAndMutates(ctx) {
    const { report, treeRoot, expected } = ctx;
    report.phase('3-pinned-reads-go', 'the pinned Node server boots on the SAME tree and reads what GoTavern wrote');
    const port = await choosePort();
    const runtime = await startPinnedServer({
        sourceRoot: ctx.pinnedRoot,
        runtimeRoot: treeRoot,
        dataRoot: path.join(treeRoot, 'data'),
        configPath: path.join(treeRoot, 'config.yaml'),
        port,
        logSink: message => { if (process.env.NODE_STOCK_TREE_BOOT_LOG === '1') process.stderr.write(message); },
        readinessSeconds: ctx.options.pinnedBootSeconds,
    });
    try {
        const session = new PinnedSession(runtime.origin, 'pinned-read');
        await session.login(TREE_USER.handle, TREE_USER.password);
        report.step('pinned.ready', true, { port });

        const chat = await session.postJSON('/api/chats/get', {
            avatar_url: expected.primaryCharacter.avatar,
            file_name: expected.primaryCharacter.chat,
        });
        report.assert('pinned.readsGoChat', Array.isArray(chat) && chat.length > 0, { length: Array.isArray(chat) ? chat.length : typeof chat });
        report.assert('pinned.readsGoAppendOne', chat.some(message => message?.mes === GO_MARKERS.append1), { messages: chat.length });
        report.assert('pinned.readsGoAppendTwo', chat.some(message => message?.mes === GO_MARKERS.append2), { messages: chat.length });
        const swiped = chat.find(message => Array.isArray(message?.swipes));
        report.assert('pinned.readsGoSwipe', swiped?.swipes?.includes(GO_MARKERS.swipe) === true, { alternatives: swiped?.swipes?.length ?? null });
        report.assert('pinned.readsGoSwipeSelection', typeof swiped?.swipe_id === 'number' && swiped.mes === swiped.swipes[swiped.swipe_id], { swipeId: swiped?.swipe_id ?? null });
        report.assert('pinned.readsChatVariables', chat[0]?.chat_metadata?.variables?.[MARKERS.chatVariable] !== undefined, chat[0]?.chat_metadata?.variables ?? null);
        report.assert('pinned.readsUnknownChatMetadata', chat[0]?.chat_metadata?.node_origin_unknown_chat_metadata?.preserved === true, chat[0]?.chat_metadata?.node_origin_unknown_chat_metadata ?? null);

        const card = await session.postJSON('/api/characters/get', { avatar_url: expected.primaryCharacter.avatar });
        const document = card?.data ? card : (card?.character ?? card);
        report.assert('pinned.readsGoCharacterEdit', String(document?.description ?? '').includes(GO_MARKERS.characterEdit), (document?.description ?? '').slice(-60));
        report.assert('pinned.readsCharacterAlternateGreetings', Array.isArray(document?.data?.alternate_greetings) && document.data.alternate_greetings.length === expected.surfaces.characters[0].alternateGreetings, { read: document?.data?.alternate_greetings?.length ?? null });
        report.assert('pinned.readsCharacterScopedRegex', Array.isArray(document?.data?.extensions?.regex_scripts) && document.data.extensions.regex_scripts.length === 1, { read: document?.data?.extensions?.regex_scripts?.length ?? null });
        report.assert('pinned.readsCharacterUnknownExtension', document?.data?.extensions?.node_origin_unknown_character_extension?.keep === true, null);

        const world = await session.postJSON('/api/worldinfo/get', { name: expected.surfaces['world-info'].name });
        report.assert('pinned.readsGoWorldEntry', Object.values(world?.entries ?? {}).some(entry => entry?.content === `${GO_MARKERS.worldEntry}_CONTENT`), { entries: Object.keys(world?.entries ?? {}).length });

        const settings = JSON.parse((await session.postJSON('/api/settings/get', {})).settings);
        report.assert('pinned.readsGoSettingsKey', settings[GO_MARKERS.settingsKey]?.phase === 'goWrite2', settings[GO_MARKERS.settingsKey] ?? null);
        report.assert('pinned.readsSettingsOriginalUnknownKey', settings[MARKERS.legacySetting]?.goWrite === `${GO_MARKERS.settingsNested}:two`, settings[MARKERS.legacySetting] ?? null);
        report.assert('pinned.readsSettingsExtensionState', settings.extension_settings?.[MARKERS.extensionSetting]?.unknown_member?.keep === true, settings.extension_settings?.[MARKERS.extensionSetting] ?? null);

        const presetEnvelope = await session.postJSON('/api/settings/get', {});
        const presetDocuments = (Array.isArray(presetEnvelope.openai_settings) ? presetEnvelope.openai_settings : []).map(entry => {
            if (typeof entry === 'string') {
                try {
                    return JSON.parse(entry);
                } catch {
                    return null;
                }
            }
            return entry;
        });
        report.assert('pinned.readsPresetDocument', presetDocuments.some(preset => preset?.temperature === expected.surfaces.presets.temperature && preset?.prompts?.length === expected.surfaces.presets.prompts), { count: presetDocuments.length });

        // ---- PINNED WRITES. The "continue" half: the same chat-save route the frontend calls appends a turn,
        // and a settings save writes a key. That is what "the Go-written chat can be loaded and continued" means
        // in persistence terms.
        report.phase('3b-pinned-continues', 'the pinned Node server appends a turn to the Go-written chat and saves settings');
        const messages = structuredClone(chat);
        messages.push({
            name: CHARACTERS[0].name,
            is_user: false,
            is_system: false,
            send_date: fixedIso(900000),
            mes: GO_MARKERS.nodeAppend,
            extra: { node_stock_node_append: true },
        });
        const save = await session.post('/api/chats/save', {
            avatar_url: expected.primaryCharacter.avatar,
            file_name: expected.primaryCharacter.chat,
            chat: messages,
        });
        report.assert('pinned.chatContinueSaveAccepted', save.status === 200, { status: save.status });
        const after = await session.postJSON('/api/chats/get', {
            avatar_url: expected.primaryCharacter.avatar,
            file_name: expected.primaryCharacter.chat,
        });
        report.assert('pinned.chatContinueReadBack', after.some(message => message?.mes === GO_MARKERS.nodeAppend), { length: after.length });

        const settingsAfter = JSON.parse((await session.postJSON('/api/settings/get', {})).settings);
        settingsAfter[GO_MARKERS.nodeSettingsKey] = { by: 'pinned-node', at: 'phase-3' };
        const settingsSave = await session.post('/api/settings/save', settingsAfter);
        report.assert('pinned.settingsSaveAccepted', settingsSave.status === 200, { status: settingsSave.status });
        const settingsRead = JSON.parse((await session.postJSON('/api/settings/get', {})).settings);
        report.assert('pinned.settingsReadBack', settingsRead[GO_MARKERS.nodeSettingsKey]?.by === 'pinned-node', settingsRead[GO_MARKERS.nodeSettingsKey] ?? null);
        report.assert('pinned.settingsKeepsGoKey', settingsRead[GO_MARKERS.settingsKey]?.phase === 'goWrite2', settingsRead[GO_MARKERS.settingsKey] ?? null);
        report.assert('pinned.settingsKeepsUnknownKeys', settingsRead[MARKERS.legacySetting]?.schema === 2 && settingsRead[MARKERS.legacySetting]?.goWrite === `${GO_MARKERS.settingsNested}:two`, settingsRead[MARKERS.legacySetting] ?? null);
        ctx.pinnedChatLength = after.length;
    } finally {
        ctx.pinnedStop = await runtime.stop();
        report.step('pinned.stopped', true, ctx.pinnedStop);
    }
    await assertTreeIntegrity(report, treeRoot, 'afterPinnedWrite', RUNTIME_CACHES);
    // After a pinned boot the tree additionally gains pinned's caches and a boot-time settings backup. Those are
    // declared in PINNED_BOOT_CREATED, with the reason, and everything else must be unchanged.
    ctx.preservationAfterPinned = await compareTree(treeRoot, ctx.pristineEntries, {
        allowChanged: [
            [expected.primaryCharacter.chatFile, 'pinned appended a continuation turn (and Go wrote the same chat earlier in this run)'],
            [expected.settingsFile, 'pinned added a settings key, and Go saved settings earlier in this run'],
            [expected.primaryCharacter.card, 'Go edited the card earlier in this run'],
            [expected.worldFile, 'Go edited the world book earlier in this run'],
            ...BOOT_VOLATILE_CHANGED,
        ],
        allowCreated: [...GO_BOOT_CREATED, ...PINNED_BOOT_CREATED],
        allowDeleted: [],
        excluded: RUNTIME_CACHES,
    });
    reportPreservation(report, 'afterPinnedWrite', ctx.preservationAfterPinned);
}

// ---------------------------------------------------------------------------------------------------------------
// PHASE 4: GO READS THE NODE MUTATION
// ---------------------------------------------------------------------------------------------------------------
async function goReadsNodeMutation(ctx) {
    const { report, treeRoot, expected, binary } = ctx;
    report.phase('4-gotavern-reads-node', 'GoTavern boots again on the tree pinned Node wrote and reads the Node mutation');
    const server = await startGotavern({ binary, treeRoot, report, label: 'goFinal' });
    try {
        const session = new PinnedSession(server.origin, 'gotavern-final');
        await goLogin(session, 'goFinal', report);
        const chat = await session.postJSON('/api/chats/get', {
            avatar_url: expected.primaryCharacter.avatar,
            file_name: expected.primaryCharacter.chat,
        });
        report.assert('goFinal.readsNodeAppend', Array.isArray(chat) && chat.some(message => message?.mes === GO_MARKERS.nodeAppend), { length: Array.isArray(chat) ? chat.length : null });
        report.assert('goFinal.readsItsOwnEarlierAppends', chat.some(message => message?.mes === GO_MARKERS.append1) && chat.some(message => message?.mes === GO_MARKERS.append2), null);
        report.assert('goFinal.readsNodeWrittenSwipes', chat.some(message => Array.isArray(message?.swipes) && message.swipes.includes(GO_MARKERS.swipe)), null);
        const settings = JSON.parse((await session.postJSON('/api/settings/get', {})).settings);
        report.assert('goFinal.readsNodeSettingsKey', settings[GO_MARKERS.nodeSettingsKey]?.by === 'pinned-node', settings[GO_MARKERS.nodeSettingsKey] ?? null);
        report.assert('goFinal.readsItsOwnSettingsKey', settings[GO_MARKERS.settingsKey]?.phase === 'goWrite2', settings[GO_MARKERS.settingsKey] ?? null);
        report.assert('goFinal.settingsOriginalUnknownKeysRetained', settings[MARKERS.legacySetting]?.schema === 2 && settings[MARKERS.legacySetting]?.goWrite === `${GO_MARKERS.settingsNested}:two`, settings[MARKERS.legacySetting] ?? null);
    } finally {
        ctx.goFinalStop = await server.stop();
        assertGracefulStop(report, 'goFinal', ctx.goFinalStop);
    }
    await assertTreeIntegrity(report, treeRoot, 'final', RUNTIME_CACHES);
}

// ---------------------------------------------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------------------------------------------
async function main() {
    const options = parseArguments(process.argv.slice(2));
    const report = new Report(options);
    ctx.report = report;
    ctx.servers = [];
    let work = null;
    let keep = options.keep;
    try {
        if (!options.pinned) throw new Error('--pinned <SillyTavern checkout> is required');
        const pinnedRoot = path.resolve(options.pinned);
        const pinnedHead = await new Promise((resolve, reject) => {
            execFile('git', ['rev-parse', 'HEAD'], { cwd: pinnedRoot, encoding: 'utf8' }, (error, stdout) => (error ? reject(new Error(`the pinned checkout is not a git checkout: ${error.message}`)) : resolve(stdout.trim())));
        });
        report.assert('precondition.pinnedCommit', pinnedHead === PINNED_COMMIT, { head: pinnedHead, pinned: PINNED_COMMIT });
        ctx.pinnedRoot = pinnedRoot;
        ctx.options = options;

        work = path.resolve(options.work ?? await tempRoot('gotavern-node-stock-qualify-'));
        await fs.mkdir(work, { recursive: true });
        report.report.work = work;
        ctx.work = work;

        // ---- 0. THE TREE. Either the caller supplies one (with its manifest) or this driver generates it.
        report.phase('0-tree', 'obtain the Node-originated tree and its recorded manifest');
        if (options.tree) {
            const treeRoot = path.resolve(options.tree);
            const manifest = await readJSON(path.resolve(options.manifest ?? `${treeRoot}.manifest.json`));
            const { entries } = await walkTreeDetailed(treeRoot);
            report.assert('tree.matchesItsManifest', treeDigest(entries) === manifest.tree.sha256, { tree: treeDigest(entries), manifest: manifest.tree.sha256 });
            ctx.generatorReport = await readJSON(path.resolve(`${treeRoot}.report.json`));
            ctx.pristineEntries = manifest.entries;
            ctx.sourceTree = treeRoot;
        } else {
            const generated = path.join(work, 'generated');
            const result = await buildNodeStockTree({
                pinned: pinnedRoot,
                out: path.join(generated, 'tree'),
                report: path.join(generated, 'report.json'),
                manifest: path.join(generated, 'manifest.json'),
                quiet: options.quiet,
            });
            ctx.generatorReport = result.report;
            ctx.pristineEntries = result.manifest.entries;
            report.step('tree.generated', true, { files: result.manifest.entries.length, sha256: result.manifest.tree.sha256 });
            ctx.sourceTree = result.report.tree.root;
        }
        report.report.tree.recorded = {
            sha256: ctx.generatorReport.tree.sha256,
            normalisedSha256: ctx.generatorReport.tree.normalisedSha256,
            files: ctx.generatorReport.tree.fileCount,
            bytes: ctx.generatorReport.tree.bytes,
            volatilePathPatterns: ctx.generatorReport.tree.volatilePathPatterns,
            seeded: ctx.generatorReport.seeded,
            prepared: ctx.generatorReport.prepared,
            apiCreated: ctx.generatorReport.apiCreated,
        };
        // THE GENERATOR'S OWN CLAIMS ARE CHECKED HERE, because the round trip is only evidence if the tree really
        // is what the generator says it is: API-created surfaces present, every seeded item carrying its reason,
        // every prepared asset carrying its reason, and the pinned checkout untouched by generation.
        const requiredSurfaces = ['account', 'settings', 'characters', 'chats', 'groups', 'world-info', 'presets', 'quick-replies', 'avatars', 'backgrounds', 'themes', 'thumbnails'];
        report.assert('tree.apiCreatedCoversRequiredSurfaces', requiredSurfaces.every(surfaceId => (ctx.generatorReport.apiCreated ?? []).includes(surfaceId)), { required: requiredSurfaces, present: ctx.generatorReport.apiCreated ?? [] });
        report.assert('tree.seededItemsAreLabelled', Array.isArray(ctx.generatorReport.seeded) && ctx.generatorReport.seeded.length > 0 && ctx.generatorReport.seeded.every(entry => typeof entry.path === 'string' && typeof entry.why === 'string' && entry.why.length > 20), (ctx.generatorReport.seeded ?? []).map(entry => entry?.path ?? null));
        report.assert('tree.preparedItemsAreLabelled', Array.isArray(ctx.generatorReport.prepared) && ctx.generatorReport.prepared.length > 0 && ctx.generatorReport.prepared.every(entry => typeof entry.path === 'string' && typeof entry.why === 'string'), (ctx.generatorReport.prepared ?? []).map(entry => entry?.path ?? null));
        report.assert('tree.pinnedCheckoutReadOnly', Array.isArray(ctx.generatorReport.pinned?.checkoutCleanAfter) && ctx.generatorReport.pinned.checkoutCleanAfter.length === 0, ctx.generatorReport.pinned?.checkoutCleanAfter ?? null);
        ctx.expected = resolveExpected(ctx.generatorReport);

        // The qualification runs on a COPY, so the recorded tree stays pristine and a re-run compares the same
        // input bytes.
        const treeRoot = path.join(work, 'roundtrip', 'tree');
        await removeWithRetries(path.join(work, 'roundtrip'));
        await copyTree(ctx.sourceTree, treeRoot);
        const copied = await walkTreeDetailed(treeRoot);
        report.assert('tree.workspaceCopiedByteForByte', treeDigest(copied.entries) === ctx.generatorReport.tree.sha256, { copied: treeDigest(copied.entries) });
        ctx.treeRoot = treeRoot;
        report.report.tree.workspaceCopySha256 = treeDigest(copied.entries);

        // ---- THE BINARY.
        ctx.binary = await buildGotavernBinary({ repo: options.repo, work, explicit: options.gotavern, report });

        // ---- PHASES 1-4.
        await goReads(ctx);
        await goMutatesAndRestarts(ctx);
        await pinnedReadsAndMutates(ctx);
        await goReadsNodeMutation(ctx);

        // ---- FINAL VERDICT: everything the two runtimes wrote is still readable, and the recorded tree's
        // unrelated bytes are intact.
        report.phase('5-verdict', 'the full round trip');
        report.assert('verdict.roundTripComplete', true, {
            goWrites: [GO_MARKERS.append1, GO_MARKERS.append2, GO_MARKERS.swipe],
            nodeWrites: [GO_MARKERS.nodeAppend, GO_MARKERS.nodeSettingsKey],
            chatLength: ctx.pinnedChatLength,
        });
        const finalEntries = (await walkTreeDetailed(treeRoot, { skip: RUNTIME_CACHES.map(([pattern]) => pattern) })).entries;
        report.report.tree.finalSha256 = treeDigest(finalEntries);
        report.report.preservation = {
            afterGoWrite1: summariseComparison(ctx.preservationAfterGo),
            afterGoWrite2: summariseComparison(ctx.preservationAfterGo2),
            afterPinnedWrite: summariseComparison(ctx.preservationAfterPinned),
        };
        report.report.stops = {
            goWrite1: ctx.goWrite1Stop,
            goWrite2: ctx.goWrite2Stop,
            goFinal: ctx.goFinalStop,
            pinned: ctx.pinnedStop,
        };
    } catch (error) {
        report.report.failure = report.report.failure ?? String(error?.message ?? error);
        report.say(`\nFAILED: ${error?.stack ?? error}`);
        process.exitCode = 1;
    } finally {
        const finished = report.finish();
        const reportPath = path.resolve(options.report ?? path.join(work ?? REPO_ROOT, 'node-stock-tree-roundtrip.report.json'));
        await writeJSON(reportPath, finished).catch(() => {});
        if (finished.ok) {
            report.say(`\nROUND TRIP: match -- ${finished.steps.length} assertion(s), 0 failed`);
            report.say(`recorded tree sha256 ${finished.tree.recorded?.sha256}`);
            report.say(`report: ${reportPath}`);
        } else {
            report.say(`\nROUND TRIP: MISMATCH -- ${finished.failure}`);
            report.say(`report: ${reportPath}`);
        }
        if (!keep && work) {
            await removeWithRetries(work).catch(() => {});
        } else if (work) {
            report.say(`work directory kept: ${work}`);
        }
    }
}

function summariseComparison(comparison) {
    if (!comparison) return null;
    return {
        created: comparison.created.map(entry => entry.path),
        changed: comparison.changed.map(entry => entry.path),
        deleted: comparison.deleted.map(entry => entry.path),
        unexpectedCreated: comparison.unexpectedCreated.map(entry => entry.path),
        unexpectedChanged: comparison.unexpectedChanged.map(entry => entry.path),
        unexpectedDeleted: comparison.unexpectedDeleted.map(entry => entry.path),
        excludedSkippedCount: comparison.excludedSkipped.length,
        excludedSkippedPrefixes: [...new Set(comparison.excludedSkipped.map(relative => relative.split('/').slice(0, 2).join('/')))].sort(),
    };
}

const ctx = {};
await main();
