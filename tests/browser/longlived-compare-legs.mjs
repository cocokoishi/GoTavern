// JUDGE THE LONG-LIVED QUALIFICATION: GoTavern's legs versus pinned Node SillyTavern's legs.
//
// INPUTS are the four reports `longlived-corpus-probe.mjs` writes: drive and restart for each subject, over two
// COPIES of the same generated corpus. Every check below has a NAME, and a check that cannot be evaluated is
// `not-observed` rather than `match` -- the taxonomy is the differential doctrine's (AGENTS): match, mismatch,
// not-observed, pinned-unreachable, decided-exclusion, harness-error.
//
// THE THREE FACT CLASSES (AGENTS 7):
//   1. browser observable  -- readiness, roster, resumed chat identity, markers, the changed setting/preset/world,
//      the state after each reload, and the restart's read-back of what the first process wrote.
//   2. provider wire       -- BYTE-ORIENTED: method, raw target, byte length and sha256 of the raw body, for every
//      completion request in order. No canonicalising, no re-marshalling, no dropping members.
//   3. disk state          -- the planted corpus versus after the journey (changed/deleted/added sets), the final
//      messages of the resumed chat, and the settings the user changed.
//
// NORMALISATION. There is no global normalisation here. Every accommodation is a NAMED check with its field path
// and reason, and the artefact carries the list under `normalisations` so a reader can audit it. The two
// DECIDED-exclusion classes are:
//   * thumbnail IMAGE BYTES are not compared (status/content-type/decodability are): the pure-Go codec serving
//     `/thumbnail` is a recorded product decision and byte equality with Jimp is explicitly not claimed
//     (AGENTS architecture boundary 3, ARCHITECTURE Â§35.2);
//   * `config.yaml` and wall-clock-named files (settings backups, cookie secret, boot storage id) are compared as
//     PATHS/PRESENCE, not bytes: both legs are booted by the harness with the same seeded config, the config
//     rewrite is the startup differential's subject, and the names carry a clock by design.
// `stats.json` is compared as CHANGED (both servers updated it) but not by digest: its counters are derived from
// the same chat and asserted equal through the chat/changed-set checks.
//
// USAGE:
//   node tests/browser/longlived-compare-legs.mjs \
//     --drive-go drive-gotavern.json --drive-pinned drive-pinned.json \
//     --restart-go restart-gotavern.json --restart-pinned restart-pinned.json \
//     --out tests/browser/.tmp-artifacts/longlived-comparison.json

import fs from 'node:fs/promises';
import path from 'node:path';

const NORMALISATIONS = [
    {
        field: 'disk.chatsAfter[].messages[].swipes[]',
        reason: 'AGENTS 50 per-subject discriminator: one reply is stamped with the subject prefix (LLG_/LLP_), the user SWIPES it away (so no later provider request carries it), and the prefixed text survives on disk inside that message\'s swipes[] array. The two subjects MUST differ here; the prefix is replaced with <REPLY_PREFIX> before the sequences are compared.',
    },
    {
        field: 'disk.chatsAfter[].messages[].send_date',
        reason: 'recorded nowhere: each server stamps its own wall clock on the messages it writes. The field is omitted by the probe rather than compared, so no unstable value can be equal by luck or unequal by clock.',
    },
    {
        field: 'disk.changed[] (config.yaml)',
        reason: 'harness-seeded, not corpus data: both browser legs are handed the same pinned fresh-install config by seedLegConfig, and startup config mutation is the startup differential\'s subject (docs/startup-inventory.md). The check requires BOTH legs to show it changed, not to have the same bytes.',
    },
    {
        field: 'disk.added[] (settings_default-user_<timestamp>.json, cookie-secret.txt, _storage/<id>, thumbnails/**)',
        reason: 'wall-clock names, random secrets and image-codec output are not compared by bytes: backup file names carry a timestamp, the cookie secret is random by design, the boot storage id is random, and thumbnail bytes are a DECIDED codec difference (pure-Go codec vs Jimp; byte equality is not claimed). Presence and the normalised path set are compared.',
    },
    {
        field: 'disk.added[] (excluding _webpack/**, _cache/**, default-user/backups/**)',
        reason: 'SCOPE, recorded rather than silent: pinned compiles its frontend libraries into <dataRoot>/_webpack and writes its character disk cache under <dataRoot>/_cache (both are build/cache artefacts, not user data -- the character cache has its own differential probe, tools/probe-character-disk-cache.mjs); automatic chat/settings backup files are housekeeping of the backup surface (docs/compat-matrix.md records chat save/load as partial and the /api/backups/* routes separately). This gate compares the CHAT THE USER RESUMED and the SETTINGS THE USER CHANGED; the excluded paths are counted in a decided-exclusion entry so the difference is visible, never asserted away.',
    },
    {
        field: 'browser.turnOne.last.mes',
        reason: 'the per-subject discriminator (AGENTS 50) is stamped into the FIRST reply and that first reply IS turn one, so the two subjects necessarily differ in this one browser field before it is swiped away. The prefix is replaced with <REPLY_PREFIX>; no other browser text is normalised.',
    },
    {
        field: 'disk.changed[] (stats.json)',
        reason: 'GoTavern writes the boot wall-clock timestamp into stats.json at startup, while pinned writes that file through its stats routes; the difference is recorded as a decided-exclusion check with both legs\' digests, and the startup write itself belongs to the startup surface (docs/startup-inventory.md, data_maid/startup probes). This gate compares the user\'s resumed chat and changed settings.',
    },
    {
        field: 'settings (selected paths only)',
        reason: 'comparison SCOPE, not normalisation: the user-visible changed state (active preset, temperature, selected worlds, world list, unknown-key presence) is compared. Every other settings field is written by both subjects\' own migration/startup paths, which the settings and startup probes cover; comparing the entire document here would turn those probes into a weaker duplicate.',
    },
    {
        field: 'assets[] (thumbnail entries)',
        reason: 'the same decided codec difference as above: status, content-type and non-empty bytes are compared; sha256 is compared only for assets that are stored bytes (character image, background, persona avatar, user asset).',
    },
];

const THUMBNAIL_ASSETS = new Set(['character-thumbnail', 'background-thumbnail']);
const REPLY_PREFIX_PATTERN = /LL[GP]_/;
// Build/cache artefacts and backup housekeeping that live in the data root but are NOT the user's resumed chat or
// changed settings. They are REPORTED as a decided-exclusion (see NORMALISATIONS) and excluded from the added-set
// equality; every other added path is compared.
const EXCLUDED_ADDED_PATH = /^(_webpack|_cache)\//;

const isExcludedAddedPath = value => EXCLUDED_ADDED_PATH.test(value) || value.startsWith('default-user/backups/');

const sameJson = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const sortedUnique = values => [...new Set(values)].sort();

async function readLeg(target, label) {
    const body = await fs.readFile(target, 'utf8');
    const leg = JSON.parse(body);
    return { label, path: target, leg };
}

function failedSteps(leg) {
    return (leg?.steps ?? []).filter(entry => entry.ok !== true).map(entry => entry.name);
}

function completionRequests(leg) {
    return (leg?.provider?.requests ?? []).filter(entry => /chat\/completions/.test(entry.path ?? ''));
}

function normaliseSwipes(swipes, prefixes) {
    if (!Array.isArray(swipes)) return null;
    return swipes.map(value => {
        let text = String(value);
        for (const prefix of prefixes) {
            if (prefix) text = text.split(prefix).join('<REPLY_PREFIX>');
        }
        return text;
    });
}

function normaliseAddedPath(value) {
    return String(value)
        .replace(/settings_default-user_\d{8}-\d{6}\.json/g, 'settings_default-user_<timestamp>.json')
        .replace(/^_storage\/[0-9a-f]{64}$/g, '_storage/<id>');
}

function normaliseChatSequence(chat, prefixes) {
    return {
        file: chat.file,
        header: chat.header,
        messages: (chat.messages ?? []).map(message => ({
            isUser: message.isUser,
            name: message.name,
            mes: normaliseSwipes([message.mes], prefixes)?.[0] ?? message.mes,
            swipeId: message.swipeId,
            swipesCount: message.swipesCount,
            swipes: normaliseSwipes(message.swipes, prefixes),
            forceAvatar: message.forceAvatar,
            extraKeys: message.extraKeys,
        })),
    };
}

function selectedSettings(settings) {
    if (!settings) return null;
    return {
        preset: settings.oai_settings?.preset_settings_openai ?? null,
        temperature: settings.oai_settings?.temp_openai ?? null,
        worldSelection: settings.world_info?.globalSelect ?? null,
        worldNames: sortedUnique(settings.world_names ?? []),
        unknownTopLevelPresent: Object.prototype.hasOwnProperty.call(settings, 'longlived_legacy_state'),
        unknownExtensionPresent: Object.prototype.hasOwnProperty.call(settings.extension_settings ?? {}, 'longlived_legacy_extension'),
        activeCharacter: settings.active_character ?? null,
    };
}

export function compareLegs({ driveGo, drivePinned, restartGo, restartPinned }) {
    const checks = [];
    const report = (name, verdict, detail = null) => {
        checks.push({ name, verdict, ok: verdict === 'match' || verdict === 'decided-exclusion', detail });
        return verdict;
    };
    const mismatchIfNotEqual = (name, left, right, detail = null) => {
        if (sameJson(left, right)) return report(name, 'match', detail);
        return report(name, 'mismatch', { ...(detail ?? {}), go: left, pinned: right });
    };

    const goPrefix = String(driveGo.leg.replyPrefix ?? '');
    const pinnedPrefix = String(drivePinned.leg.replyPrefix ?? '');
    const prefixes = [goPrefix, pinnedPrefix].filter(Boolean);

    // ---- 0. ARE BOTH LEGS EVIDENCE? A leg that failed to drive is a harness/problem report, not a product finding.
    const completeness = {
        'leg-go-drive-complete': failedSteps(driveGo.leg),
        'leg-pinned-drive-complete': failedSteps(drivePinned.leg),
        'leg-go-restart-complete': failedSteps(restartGo?.leg ?? {}),
        'leg-pinned-restart-complete': failedSteps(restartPinned?.leg ?? {}),
    };
    let evidenceComplete = true;
    for (const [name, failed] of Object.entries(completeness)) {
        const leg = name.includes('pinned') ? (name.includes('drive') ? drivePinned.leg : restartPinned?.leg) : (name.includes('drive') ? driveGo.leg : restartGo?.leg);
        const verdict = leg && failed.length === 0 && !leg.failure ? 'match' : 'harness-error';
        if (verdict !== 'match') evidenceComplete = false;
        report(name, verdict, { failedSteps: failed, failure: leg?.failure ?? null, subject: leg?.subject ?? null, phase: leg?.phase ?? null });
    }
    report('leg-subjects-and-phases', 'match', {
        go: [driveGo.leg.subject, driveGo.leg.phase, restartGo?.leg?.phase],
        pinned: [drivePinned.leg.subject, drivePinned.leg.phase, restartPinned?.leg?.phase],
    });

    // ---- 1. THE INPUT IS THE SAME CORPUS ON BOTH SIDES. If it is not, nothing below is a comparison.
    mismatchIfNotEqual('same-corpus-tree', driveGo.leg.corpus?.treeSha256 ?? null, drivePinned.leg.corpus?.treeSha256 ?? null, {
        go: driveGo.leg.corpus, pinned: drivePinned.leg.corpus,
    });
    mismatchIfNotEqual('same-seeded-config', driveGo.leg.server?.configSha256 ?? null, drivePinned.leg.server?.configSha256 ?? null);
    mismatchIfNotEqual('both-subjects-booted', driveGo.leg.server?.bootRefusal ?? null, drivePinned.leg.server?.bootRefusal ?? null);
    mismatchIfNotEqual('restart-both-subjects-booted', restartGo?.leg?.server?.bootRefusal ?? null, restartPinned?.leg?.server?.bootRefusal ?? null);

    // ---- 2. RESTART IS A NEW PROCESS, per subject. A restart that reused the process proves nothing about reading
    // disk state in a new process.
    for (const [label, drive, restart] of [['go', driveGo.leg, restartGo?.leg], ['pinned', drivePinned.leg, restartPinned?.leg]]) {
        const drivePid = drive?.server?.pid ?? null;
        const restartPid = restart?.server?.pid ?? null;
        report(`restart-is-a-new-process-${label}`, drivePid !== null && restartPid !== null && drivePid !== restartPid ? 'match' : 'not-observed', { drivePid, restartPid });
    }

    // ---- 3. BROWSER-OBSERVABLE STATE.
    mismatchIfNotEqual('roster-equal', sortedUnique(driveGo.leg.browser?.roster?.names ?? []), sortedUnique(drivePinned.leg.browser?.roster?.names ?? []));
    mismatchIfNotEqual('resumed-chat-identity', driveGo.leg.browser?.baseline?.chatId ?? null, drivePinned.leg.browser?.baseline?.chatId ?? null);
    mismatchIfNotEqual('resumed-chat-length', driveGo.leg.browser?.baseline?.chatLength ?? null, drivePinned.leg.browser?.baseline?.chatLength ?? null);
    mismatchIfNotEqual('resumed-chat-markers', driveGo.leg.browser?.baseline?.markers ?? null, drivePinned.leg.browser?.baseline?.markers ?? null);
    mismatchIfNotEqual('turn-one-reply-text', normaliseSwipes([driveGo.leg.browser?.turnOne?.last?.mes ?? null], prefixes)?.[0] ?? null, normaliseSwipes([drivePinned.leg.browser?.turnOne?.last?.mes ?? null], prefixes)?.[0] ?? null, {
        normalised: true, note: 'the per-subject discriminator is stamped into the first reply, which IS turn one; see NORMALISATIONS',
    });
    mismatchIfNotEqual('turn-two-reply-text', driveGo.leg.browser?.turnTwo?.last?.mes ?? null, drivePinned.leg.browser?.turnTwo?.last?.mes ?? null);
    mismatchIfNotEqual('preset-switch-applied', {
        switched: driveGo.leg.browser?.presetSwitch?.switched ?? null,
        preset: driveGo.leg.browser?.presetSwitch?.preset ?? null,
    }, {
        switched: drivePinned.leg.browser?.presetSwitch?.switched ?? null,
        preset: drivePinned.leg.browser?.presetSwitch?.preset ?? null,
    });
    mismatchIfNotEqual('world-switch-applied', driveGo.leg.browser?.worldSwitch?.selectedWorlds ?? null, drivePinned.leg.browser?.worldSwitch?.selectedWorlds ?? null);
    mismatchIfNotEqual('temperature-change-applied', driveGo.leg.browser?.temperatureChange?.runtimeTemperature ?? null, drivePinned.leg.browser?.temperatureChange?.runtimeTemperature ?? null);
    mismatchIfNotEqual('temperature-persisted', driveGo.leg.browser?.settingsPersisted ?? null, drivePinned.leg.browser?.settingsPersisted ?? null);
    mismatchIfNotEqual('character-switch-applied', driveGo.leg.browser?.characterSwitch?.characterName ?? null, drivePinned.leg.browser?.characterSwitch?.characterName ?? null);
    mismatchIfNotEqual('restart-reads-changed-settings', {
        temperature: restartGo?.leg?.browser?.baseline?.temperature ?? null,
        preset: restartGo?.leg?.browser?.baseline?.preset ?? null,
    }, {
        temperature: restartPinned?.leg?.browser?.baseline?.temperature ?? null,
        preset: restartPinned?.leg?.browser?.baseline?.preset ?? null,
    });

    const reloadStates = leg => (leg?.browser?.reloads ?? []).map(state => ({ reload: state.reload, reopened: state.reopened, chatId: state.chatId, chatLength: state.chatLength, markers: state.markers }));
    mismatchIfNotEqual('reloads-resume-the-chat', reloadStates(driveGo.leg), reloadStates(drivePinned.leg));
    mismatchIfNotEqual('restart-final-markers', restartGo?.leg?.browser?.final?.markers ?? null, restartPinned?.leg?.browser?.final?.markers ?? null);
    mismatchIfNotEqual('restart-continue-reached-provider', {
        clicked: restartGo?.leg?.browser?.continue?.clicked?.clicked ?? null,
        reachedPeer: (restartGo?.leg?.browser?.continue?.newCompletions ?? 0) > 0,
    }, {
        clicked: restartPinned?.leg?.browser?.continue?.clicked?.clicked ?? null,
        reachedPeer: (restartPinned?.leg?.browser?.continue?.newCompletions ?? 0) > 0,
    });

    // ---- 4. PROVIDER WIRE, BYTE-ORIENTED. Every completion request, in order, raw.
    const wire = leg => completionRequests(leg).map(entry => ({
        method: entry.method,
        path: entry.path,
        byteLength: entry.byteLength,
        sha256: entry.sha256,
        body: entry.body,
        served: entry.served,
    }));
    const goWire = wire(driveGo.leg);
    const pinnedWire = wire(drivePinned.leg);
    mismatchIfNotEqual('drive-provider-request-count', goWire.length, pinnedWire.length);
    for (let index = 0; index < Math.max(goWire.length, pinnedWire.length); index++) {
        const left = goWire[index] ?? null;
        const right = pinnedWire[index] ?? null;
        if (left === null || right === null) {
            report(`drive-provider-request-${index + 1}`, 'not-observed', { go: left, pinned: right });
            continue;
        }
        const firstDifference = (() => {
            if (left.path !== right.path) return 'path';
            if (left.method !== right.method) return 'method';
            if (left.byteLength !== right.byteLength) return 'byteLength';
            if (left.sha256 !== right.sha256) return 'sha256';
            return null;
        })();
        report(`drive-provider-request-${index + 1}-bytes`, firstDifference === null ? 'match' : 'mismatch', firstDifference === null
            ? { path: left.path, byteLength: left.byteLength, sha256: left.sha256 }
            : {
                difference: firstDifference,
                go: { path: left.path, byteLength: left.byteLength, sha256: left.sha256, bodyPrefix: String(left.body ?? '').slice(0, 400) },
                pinned: { path: right.path, byteLength: right.byteLength, sha256: right.sha256, bodyPrefix: String(right.body ?? '').slice(0, 400) },
            });
    }
    const restartWireGo = wire(restartGo?.leg ?? {});
    const restartWirePinned = wire(restartPinned?.leg ?? {});
    if (!restartGo?.leg || !restartPinned?.leg) {
        report('restart-provider-request-count', 'not-observed', { go: restartWireGo.length, pinned: restartWirePinned.length, reason: 'a restart leg is absent, so there is nothing to count' });
    } else {
        mismatchIfNotEqual('restart-provider-request-count', restartWireGo.length, restartWirePinned.length);
    }
    if (restartWireGo.length > 0 && restartWirePinned.length > 0) {
        const left = restartWireGo[0];
        const right = restartWirePinned[0];
        report('restart-continue-request-bytes', left.sha256 === right.sha256 && left.byteLength === right.byteLength && left.path === right.path ? 'match' : 'mismatch', {
            go: { sha256: left.sha256, byteLength: left.byteLength, path: left.path },
            pinned: { sha256: right.sha256, byteLength: right.byteLength, path: right.path },
            goBodyPrefix: left.sha256 === right.sha256 ? undefined : String(left.body ?? '').slice(0, 400),
            pinnedBodyPrefix: left.sha256 === right.sha256 ? undefined : String(right.body ?? '').slice(0, 400),
        });
    } else {
        report('restart-continue-request-bytes', 'not-observed', { go: restartWireGo.length, pinned: restartWirePinned.length });
    }

    // ---- 4b. THE FIXTURE IS DISCRIMINATING (AGENTS 50). The discriminator must be PRESENT in each leg's own disk
    // data and ABSENT from the other's, and absent from every compared provider body. Otherwise a "match" would be
    // a statement about a harness that fed both subjects identical bytes.
    const swipesText = leg => (leg?.disk?.chatsAfter ?? []).flatMap(chat => (chat.messages ?? []).flatMap(message => message.swipes ?? [])).join('\n');
    const goSwipes = swipesText(driveGo.leg);
    const pinnedSwipes = swipesText(drivePinned.leg);
    // AN EMPTY PREFIX IS NOT A DISCRIMINATOR. `''.includes(...)` is true for everything, so a leg recorded without
    // `--reply-prefix` made both "present" and "absent" checks pass vacuously (observed in the comparator's first
    // dry run). The missing prefix is reported as a harness error on its own check.
    if (!goPrefix || !pinnedPrefix) {
        report('discriminator-configured', 'harness-error', { goPrefix, pinnedPrefix });
    } else {
        report('discriminator-present-in-own-disk-data', goSwipes.includes(goPrefix) && pinnedSwipes.includes(pinnedPrefix) ? 'match' : 'mismatch', {
            goOwn: goSwipes.includes(goPrefix), pinnedOwn: pinnedSwipes.includes(pinnedPrefix),
        });
        report('discriminator-absent-from-other-subject', !goSwipes.includes(pinnedPrefix) && !pinnedSwipes.includes(goPrefix) ? 'match' : 'mismatch', {
            goCarriesPinned: goSwipes.includes(pinnedPrefix), pinnedCarriesGo: pinnedSwipes.includes(goPrefix),
        });
    }
    const providerBodies = [...goWire, ...restartWireGo].map(entry => String(entry.body ?? '')).join('\n');
    const providerBodiesPinned = [...pinnedWire, ...restartWirePinned].map(entry => String(entry.body ?? '')).join('\n');
    report('discriminator-absent-from-provider-wire', !REPLY_PREFIX_PATTERN.test(providerBodies) && !REPLY_PREFIX_PATTERN.test(providerBodiesPinned) ? 'match' : 'mismatch', {
        goCarriesAnyPrefix: REPLY_PREFIX_PATTERN.test(providerBodies), pinnedCarriesAnyPrefix: REPLY_PREFIX_PATTERN.test(providerBodiesPinned),
    });

    // ---- 5. DISK STATE.
    const changedPaths = leg => sortedUnique((leg?.disk?.changed ?? []).map(entry => entry.path).filter(value => value !== 'config.yaml' && value !== 'default-user/stats.json'));
    mismatchIfNotEqual('changed-planted-files', changedPaths(driveGo.leg), changedPaths(drivePinned.leg));
    report('stats-json-write-decided-exclusion', 'decided-exclusion', {
        normalisation: 'default-user/stats.json changed: GoTavern writes the boot timestamp at startup, pinned writes it through its stats routes; the startup write is the startup surface\'s subject (docs/startup-inventory.md), recorded here with both digests instead of asserted equal',
        goChanged: (driveGo.leg.disk?.changed ?? []).find(entry => entry.path === 'default-user/stats.json') ?? null,
        pinnedChanged: (drivePinned.leg.disk?.changed ?? []).find(entry => entry.path === 'default-user/stats.json') ?? null,
    });
    mismatchIfNotEqual('deleted-planted-files', sortedUnique(driveGo.leg.disk?.deleted ?? []), sortedUnique(drivePinned.leg.disk?.deleted ?? []));
    const addedPaths = leg => sortedUnique((leg?.disk?.added ?? []).map(entry => normaliseAddedPath(entry.path)));
    const addedCompared = leg => addedPaths(leg).filter(value => !isExcludedAddedPath(value));
    const addedExcluded = leg => addedPaths(leg).filter(value => isExcludedAddedPath(value));
    mismatchIfNotEqual('added-files-normalised', addedCompared(driveGo.leg), addedCompared(drivePinned.leg), {
        note: 'wall-clock names, the random cookie secret/storage id and thumbnail codec output are compared by normalised PATH/PRESENCE only (see normalisations)',
    });
    report('build-cache-backup-additions-decided-exclusion', 'decided-exclusion', {
        normalisation: 'added paths under _webpack/**, _cache/** and default-user/backups/** are reported here and excluded from the added-set equality (build/cache artefacts and backup housekeeping; see NORMALISATIONS)',
        goExcluded: addedExcluded(driveGo.leg),
        pinnedExcluded: addedExcluded(drivePinned.leg),
    });
    const thumbnailHashes = leg => (leg?.disk?.added ?? []).filter(entry => /thumbnails\//.test(entry.path)).map(entry => entry.sha256).sort();
    report('thumbnail-bytes-decided-exclusion', 'decided-exclusion', {
        normalisation: 'assets[] thumbnail entries + thumbnails/** added files: status/content-type/presence compared; bytes not claimed (pure-Go codec vs Jimp)',
        goThumbnailHashes: thumbnailHashes(driveGo.leg).slice(0, 3),
        pinnedThumbnailHashes: thumbnailHashes(drivePinned.leg).slice(0, 3),
    });
    mismatchIfNotEqual('settings-selected-state', selectedSettings(driveGo.leg.disk?.settingsAfter), selectedSettings(drivePinned.leg.disk?.settingsAfter));

    const sequence = (leg, fileNamePart) => {
        const chat = (leg?.disk?.chatsAfter ?? []).find(candidate => String(candidate.file ?? '').includes(fileNamePart)) ?? null;
        return chat ? normaliseChatSequence(chat, prefixes) : null;
    };
    const goFile = (driveGo.leg.disk?.chatsAfter ?? []).find(chat => /2026-09-14/.test(chat.file ?? ''))?.file ?? null;
    const pinnedFile = (drivePinned.leg.disk?.chatsAfter ?? []).find(chat => /2026-09-14/.test(chat.file ?? ''))?.file ?? null;
    if (goFile && pinnedFile && path.basename(goFile) === path.basename(pinnedFile)) {
        mismatchIfNotEqual('resumed-chat-sequence', sequence(driveGo.leg, path.basename(goFile)), sequence(drivePinned.leg, path.basename(pinnedFile)), {
            file: path.basename(goFile),
            note: 'send_date is not recorded; swipes[] carry <REPLY_PREFIX> (see normalisations)',
        });
    } else {
        report('resumed-chat-sequence', 'mismatch', { goFile, pinnedFile });
    }
    const restartChat = leg => {
        const chat = (leg?.disk?.chatsAfter ?? [])[0] ?? null;
        return chat ? { file: chat.file, header: chat.header, messageCount: chat.messages?.length ?? 0, last: normaliseChatSequence(chat, prefixes).messages.at(-1) ?? null } : null;
    };
    mismatchIfNotEqual('restart-resumed-chat-message-count', restartChat(restartGo)?.messageCount ?? null, restartChat(restartPinned)?.messageCount ?? null);
    mismatchIfNotEqual('restart-resumed-chat-last-message', restartChat(restartGo)?.last ?? null, restartChat(restartPinned)?.last ?? null);

    // ---- 6. ASSETS: stored bytes are compared; thumbnails by status/content-type only (decided codec boundary).
    const assetMap = leg => new Map((leg.assets ?? []).map(asset => [asset.name, asset]));
    const goAssets = assetMap(driveGo.leg);
    const pinnedAssets = assetMap(drivePinned.leg);
    const assetNames = sortedUnique([...goAssets.keys(), ...pinnedAssets.keys()]);
    const assetProblems = [];
    for (const name of assetNames) {
        const left = goAssets.get(name);
        const right = pinnedAssets.get(name);
        if (!left || !right) {
            assetProblems.push({ name, reason: 'missing on one side', go: Boolean(left), pinned: Boolean(right) });
            continue;
        }
        if (left.status !== right.status) assetProblems.push({ name, reason: 'status', go: left.status, pinned: right.status });
        if (String(left.contentType ?? '').split(';')[0] !== String(right.contentType ?? '').split(';')[0]) {
            assetProblems.push({ name, reason: 'content-type', go: left.contentType, pinned: right.contentType });
        }
        if (!((left.bytes ?? 0) > 0 && (right.bytes ?? 0) > 0)) assetProblems.push({ name, reason: 'empty body' });
        if (!THUMBNAIL_ASSETS.has(name) && left.sha256 !== right.sha256) assetProblems.push({ name, reason: 'bytes', go: left.sha256, pinned: right.sha256 });
    }
    report('assets-served-equivalently', assetProblems.length === 0 ? 'match' : 'mismatch', { problems: assetProblems });

    const mismatches = checks.filter(entry => entry.verdict === 'mismatch');
    const harnessErrors = checks.filter(entry => entry.verdict === 'harness-error');
    return {
        schema: 'gotavern-longlived-comparison',
        schemaVersion: 1,
        ok: mismatches.length === 0 && harnessErrors.length === 0,
        evidenceComplete,
        verdict: mismatches.length === 0 && harnessErrors.length === 0 ? 'match' : (mismatches.length > 0 ? 'mismatch' : 'harness-error'),
        summary: {
            checks: checks.length,
            match: checks.filter(entry => entry.verdict === 'match').length,
            mismatch: mismatches.length,
            notObserved: checks.filter(entry => entry.verdict === 'not-observed').length,
            harnessError: harnessErrors.length,
            decidedExclusion: checks.filter(entry => entry.verdict === 'decided-exclusion').length,
        },
        normalisations: NORMALISATIONS,
        checks,
        input: {
            driveGo: driveGo.path, drivePinned: drivePinned.path,
            restartGo: restartGo?.path ?? null, restartPinned: restartPinned?.path ?? null,
        },
    };
}

function option(argv, name, fallback = null) {
    const index = argv.indexOf(name);
    return index < 0 ? fallback : argv[index + 1];
}

const isMain = process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href.replace(/%20/g, ' ');
if (isMain) {
    const argv = process.argv.slice(2);
    const driveGoPath = option(argv, '--drive-go');
    const drivePinnedPath = option(argv, '--drive-pinned');
    const restartGoPath = option(argv, '--restart-go');
    const restartPinnedPath = option(argv, '--restart-pinned');
    const out = option(argv, '--out', path.join(process.cwd(), 'longlived-comparison.json'));
    if (!driveGoPath || !drivePinnedPath) {
        console.error('usage: node longlived-compare-legs.mjs --drive-go <json> --drive-pinned <json> [--restart-go <json>] [--restart-pinned <json>] --out <json>');
        process.exit(2);
    }
    const [driveGo, drivePinned, restartGo, restartPinned] = await Promise.all([
        readLeg(driveGoPath, 'go-drive'),
        readLeg(drivePinnedPath, 'pinned-drive'),
        restartGoPath ? readLeg(restartGoPath, 'go-restart') : null,
        restartPinnedPath ? readLeg(restartPinnedPath, 'pinned-restart') : null,
    ]);
    const comparison = compareLegs({ driveGo, drivePinned, restartGo, restartPinned });
    await fs.mkdir(path.dirname(path.resolve(out)), { recursive: true });
    await fs.writeFile(path.resolve(out), `${JSON.stringify(comparison, null, 2)}\n`, 'utf8');
    for (const entry of comparison.checks) {
        if (entry.verdict === 'mismatch' || entry.verdict === 'harness-error') {
            console.error(`FAIL ${entry.name} [${entry.verdict}]: ${JSON.stringify(entry.detail).slice(0, 900)}`);
        }
    }
    for (const entry of comparison.checks) {
        if (entry.verdict === 'not-observed') console.error(`NOT-OBSERVED ${entry.name}: ${JSON.stringify(entry.detail).slice(0, 400)}`);
    }
    console.error(`long-lived comparison: ${comparison.verdict} (${JSON.stringify(comparison.summary)}) -> ${path.resolve(out)}`);
    process.exit(comparison.ok ? 0 : 1);
}
