// THE WORLD-INFO SLOT-ORDER SURFACE: the shared half of the probe, the comparator and the gate self-test.
//
// THE CLAIM. World-info ACTIVATION is already proven (the preset and Author's-Note differentials show lore reaching an
// assembled prompt). What is NOT proven is that the three SLOT POSITIONS land where pinned puts them: an entry with
// position `before`, one with position `after`, and one with position `atDepth`. "The request can go out but the prompt
// order differs" is still a severe parity bug, so this surface asks a question about ORDER and POSITION inside the
// FINAL PROVIDER REQUEST, and nothing else.
//
// =====================================================================================================================
// THE PINNED SEMANTICS, READ FROM SOURCE (SillyTavern 1.19.0 @ 06bde939fb1e9c4c8d8641d810f0a9165b5ce127). Every guard
// in the comparator cites one of these; `PINNED_FACTS` below is the single place they live so a reader can check the
// code against the pin instead of against this paragraph.
//
//   F1  THE POSITION ENUM. public/scripts/world-info.js:855-864
//         world_info_position = { before: 0, after: 1, ANTop: 2, ANBottom: 3, atDepth: 4, EMTop: 5, EMBottom: 6,
//                                 outlet: 7 }
//       So `position` is a NUMBER in the world-book file, and this fixture uses 0, 1 and 4.
//
//   F2  THE THREE CHANNELS OUT OF ACTIVATION. public/scripts/world-info.js:5281
//         return { worldInfoBefore, worldInfoAfter, EMEntries, WIDepthEntries, ANBeforeEntries, ANAfterEntries,
//                  outletEntries, ... }
//       `before` accumulates into `worldInfoBefore`, `after` into `worldInfoAfter`, and `atDepth` into
//       `WIDepthEntries`, which is GROUPED BY `{depth, role}` at :5236-5242 -- a group per distinct (depth, role) pair,
//       with later entries UNSHIFTED to the front of that group's `entries` array.
//
//   F3  WHERE before/after BECOME MESSAGES ON THE CHAT-COMPLETION PATH.
//       public/scripts/openai.js:1376-1377 (inside `preparePromptsForChatCompletion`, :1367)
//         { role: 'system', content: formatWorldInfo(worldInfoBefore), identifier: 'worldInfoBefore' },
//         { role: 'system', content: formatWorldInfo(worldInfoAfter),  identifier: 'worldInfoAfter'  },
//       and public/scripts/openai.js:1212/1214 pushes them in that order:
//         await addToChatCompletion('worldInfoBefore');  ... await addToChatCompletion('worldInfoAfter');
//       `formatWorldInfo` is :789-800 and defaults the wrapper to `{0}` (public/scripts/openai.js:107
//       `default_wi_format = '{0}'`), so a slot's message content is the entries joined by '\n' -- the marker text
//       itself, with no framing to strip.
//
//   F4  WHERE atDepth BECOMES AN IN-CHAT INJECTION.
//       public/script.js:4635 destructures `worldInfoDepth` from `getWorldInfoPrompt`, and :4668-4672 turns each
//       (depth, role) group into an extension prompt:
//         worldInfoDepth.forEach((e) => {
//             const joinedEntries = e.entries.join('\n');
//             setExtensionPrompt(inject_ids.CUSTOM_WI_DEPTH_ROLE(e.depth, e.role), joinedEntries,
//                                extension_prompt_types.IN_CHAT, e.depth, false, e.role);
//         });
//       which the chat-completion assembly splices into the history by public/scripts/openai.js:819-875
//       (`populationInjectionPrompts`): the loop is `for (let i = 0; i <= maxDepth; i++)`, depth prompts are selected
//       by `prompt.injection_depth === i`, and the splice index is computed on the REVERSED history, so depth 0 is the
//       NEWEST position and depth N is N positions back from the end.
//
//   F5  THE ORDER THE THREE CHANNELS REACH THE WIRE. before/after are system messages added BEFORE the chat history
//       (F3, :1212/:1214), while an atDepth entry is spliced INTO the history (F4). So the readable expectation is:
//         index(before) < index(after) < index(history begins) <= index(depth entry)
//       and the depth entry's distance from the END is its `depth`.
//
// WHAT THIS SURFACE DOES **NOT** ESTABLISH, carried with the evidence rather than in a commit message: the legs drive
// the `custom` chat-completion source, whose pinned branch is a SERVER-SIDE PASSTHROUGH
// (src/endpoints/backends/chat-completions.js:2394-2421 never reads `messages`). A green here therefore compares the
// pinned FRONTEND assembling a prompt against two servers; it is not evidence about either server's prompt handling.
// =====================================================================================================================

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const PINNED_BASELINE = 'SillyTavern 1.19.0 @ 06bde939fb1e9c4c8d8641d810f0a9165b5ce127';

/** Every guard in the comparator names one of these by `id`; the comparator refuses to judge a guard with no fact. */
export const PINNED_FACTS = {
    F1: { id: 'F1', file: 'public/scripts/world-info.js', lines: '855-864', what: 'world_info_position = { before: 0, after: 1, ANTop: 2, ANBottom: 3, atDepth: 4, EMTop: 5, EMBottom: 6, outlet: 7 }' },
    F2: { id: 'F2', file: 'public/scripts/world-info.js', lines: '5281 (grouping at 5236-5242)', what: 'getWorldInfoPrompt returns { worldInfoBefore, worldInfoAfter, WIDepthEntries, ... }; WIDepthEntries is grouped by {depth, role}' },
    F3: { id: 'F3', file: 'public/scripts/openai.js', lines: '1376-1377 (added at 1212/1214, wrapped by 789-800)', what: "worldInfoBefore and worldInfoAfter become role 'system' messages, in that order, before the chat history" },
    F4: { id: 'F4', file: 'public/script.js', lines: '4635, 4668-4672 -> public/scripts/openai.js:819-875', what: 'an atDepth entry becomes an IN_CHAT extension prompt at its own depth and role, spliced into the history so depth N is N positions from the end' },
    F5: { id: 'F5', file: 'public/scripts/openai.js', lines: '1212, 1214 (composition) + 819-875 (splice)', what: 'the wire order is index(before) < index(after) < first history message <= index(depth entry)' },
};

export const WORLD_NAME = 'wi-slots-probe';
export const INPUT_TEXT = 'WI_SLOTS_INPUT';
export const DEPTH = 2;
// extension_prompt_roles (public/scripts/extensions.js): SYSTEM 0, USER 1, ASSISTANT 2. USER is chosen on purpose: a
// SYSTEM depth entry would be indistinguishable from the system block by ROLE alone, and this leg asserts the role.
export const DEPTH_ROLE = 1;
export const DEPTH_ROLE_NAME = 'user';
// THE ONE NUMBER IN THIS FIXTURE THAT IS AN ORACLE MEASUREMENT RATHER THAN A SOURCE READING.
//
// A parity guard alone cannot see a depth that is wrong on BOTH subjects, and the first version of this surface had
// exactly that hole: the selftest's `move-depth-one-position` mutation (applied to both recorded legs, so the byte and
// parity guards stay green) SURVIVED it. Pinned's splice (openai.js:819-875) makes the measured distance from the end
// an observable, so the pinned leg's own value is recorded here as the expectation, with the leg that produced it, and
// the comparator REFUSES when the fresh pinned leg disagrees with it -- a stale baseline is a failed check, not a
// silent pass.
export const PINNED_DEPTH_OFFSET = {
    requestedDepth: DEPTH,
    offsetFromEnd: 1,
    measuredBy: 'the pinned leg of this surface (run-against-pinned.mjs worldinfo-slots-probe.mjs), 2026-10-29, request sha256 0422801bd299fe5115c264d20f748abec68a714c2b220e80082a37b2e0bd4bcb',
    what: 'a world-info entry with position atDepth (4) and depth 2 lands ONE position from the end of messages[] on the chat-completion path',
    whyNotDepthMinusOne: 'depth 2 -> offset 1 was MEASURED, not derived; deriving offset === depth called a correct layout a defect on the first recording',
};

/** Unique marker strings: their ORDER and POSITION in the final request are what the guards read. */
export const MARKERS = {
    before: 'WI-SLOT-BEFORE-a41c',
    after: 'WI-SLOT-AFTER-b72e',
    depth: 'WI-SLOT-DEPTH-c93f',
};

/**
 * THE WORLD BOOK. Three entries, one per slot, all `constant: true` so activation does not depend on key matching
 * against the chat text (a key that silently fails to match is exactly the "probe defect presenting as a product
 * finding" shape AGENTS.md 10 warns about). `order` is set so the file itself has a deterministic content order.
 */
export function buildWorldBook() {
    const entry = (uid, position, content, extra = {}) => ({
        uid,
        key: [MARKERS.before, MARKERS.after, MARKERS.depth][uid],
        keysecondary: [],
        comment: `slot ${uid}`,
        content,
        constant: true,
        vectorized: false,
        selective: false,
        selectiveLogic: 0,
        addMemo: false,
        order: 100,
        position,
        disable: false,
        excludeRecursion: false,
        preventRecursion: false,
        delayUntilRecursion: false,
        probability: 100,
        useProbability: true,
        depth: 4,
        group: '',
        groupOverride: false,
        groupWeight: 100,
        scanDepth: null,
        caseSensitive: null,
        matchWholeWords: null,
        useGroupScoring: null,
        automationId: '',
        role: 0,
        sticky: null,
        cooldown: null,
        delay: null,
        ...extra,
    });
    return {
        entries: {
            0: entry(0, 0, MARKERS.before),
            1: entry(1, 1, MARKERS.after),
            // F4: the depth entry carries its own `depth` and `role`; `position: 4` is what routes it to WIDepthEntries.
            2: entry(2, 4, MARKERS.depth, { depth: DEPTH, role: DEPTH_ROLE }),
        },
    };
}

/** Writes the world book where BOTH subjects read world books from, before the page reads the list. */
export async function stageWorldBook(dataRoot) {
    const directory = path.join(dataRoot, 'default-user', 'worlds');
    await fs.mkdir(directory, { recursive: true });
    const file = path.join(directory, `${WORLD_NAME}.json`);
    const document = buildWorldBook();
    await fs.writeFile(file, `${JSON.stringify(document, null, 2)}\n`);
    return { file: `worlds/${WORLD_NAME}.json`, sha256: createHash('sha256').update(await fs.readFile(file)).digest('hex'), entries: Object.keys(document.entries).length, markers: MARKERS, depth: DEPTH, depthRole: DEPTH_ROLE };
}

/**
 * SELECT THE WORLD THE WAY THE PRODUCT PERSISTS IT, BEFORE THE PAGE READS ITS SETTINGS.
 *
 * MEASURED, and it cost a leg: the first version drove `<select id="world_info">` with `val([...]) + trigger('change')`
 * and read the effect back through `selected_world_info` -- which stayed EMPTY (`world-selected: {"selected":false,
 * "selectedWorldInfo":[]}`) while the drive itself was healthy (page loaded, request captured). The reason is in the
 * pin: `#world_info`'s `change` handler is not what rebinds the selection on this version. The SELECTION is restored at
 * startup from persisted settings, `public/scripts/world-info.js:995-998`:
 *     world_names = data.world_names?.length ? data.world_names : [];
 *     selected_world_info = selected_world_info.concat(settings.world_info?.globalSelect?.filter(...) ?? []);
 * so `settings.world_info.globalSelect` IS the product's own storage for "these worlds are active". Writing it before
 * the page loads is therefore not a shortcut around the UI -- it is the same state the UI writes, applied to the input
 * the frontend reads. `world-info.js:965` (`world_info = settings.world_info ?? {}`) confirms the shape.
 *
 * The page-side read-back stays: a selection that is on disk and NOT in `selected_world_info` still fails by name.
 */
export async function stageSelection(dataRoot) {
    const file = path.join(dataRoot, 'default-user', 'settings.json');
    let settings = {};
    try {
        settings = JSON.parse(await fs.readFile(file, 'utf8'));
    } catch {
        // A fresh tree has no settings.json yet; the frontend merges its defaults over whatever is here, and
        // `world_info.globalSelect` is the only member this fixture needs to state.
        settings = {};
    }
    const previous = settings.world_info;
    settings.world_info = { ...(previous && typeof previous === 'object' && !Array.isArray(previous) ? previous : {}), globalSelect: [WORLD_NAME] };
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `${JSON.stringify(settings, null, 2)}\n`);
    return {
        file: 'settings.json',
        worldInfo: settings.world_info,
        previousWorldInfo: previous ?? null,
        mechanism: 'settings.world_info.globalSelect, the member public/scripts/world-info.js:995-998 restores selected_world_info from',
    };
}

/**
 * WHAT THE BODY SAYS, extracted for ATTRIBUTION ONLY.
 *
 * The compared contract between the subjects stays the raw bytes (`bodySha256`, `byteLength`, method, raw target,
 * headers). This function exists so a red can name WHERE a marker sat rather than only that two digests differed: it is
 * recorded in the leg and read by the guards' diagnostics, and no guard treats it as the product contract.
 */
export function extractLayout(bodyText) {
    let parsed = null;
    try {
        parsed = JSON.parse(bodyText);
    } catch {
        return { parsable: false, messages: null, reason: 'the captured body is not JSON, so no slot layout exists to read' };
    }
    const messages = Array.isArray(parsed?.messages) ? parsed.messages : null;
    if (messages === null) {
        return { parsable: true, messages: null, reason: 'the captured body has no messages[] member, so this leg cannot read a slot layout' };
    }
    const contentOf = message => (typeof message?.content === 'string' ? message.content : JSON.stringify(message?.content ?? ''));
    const indexOfMarker = marker => messages.findIndex(message => contentOf(message).includes(marker));
    const positions = {};
    for (const [slot, marker] of Object.entries(MARKERS)) {
        const index = indexOfMarker(marker);
        positions[slot] = index < 0 ? null : {
            index,
            role: messages[index]?.role ?? null,
            // DISTANCE FROM THE END, which is what "depth" means on this path (F4): `messages.length - 1 - index`.
            fromEnd: messages.length - 1 - index,
            occurrences: messages.filter(message => contentOf(message).includes(marker)).length,
        };
    }
    const historyIndex = indexOfMarker(INPUT_TEXT);
    return {
        parsable: true,
        messages: messages.length,
        roles: messages.map(message => message.role ?? null),
        historyInputIndex: historyIndex < 0 ? null : historyIndex,
        positions,
        // THE FIRST SYSTEM-BLOCK MESSAGE AFTER which history begins, as an attribution anchor for a reader.
        slotsPresent: Object.values(positions).filter(entry => entry !== null).length,
    };
}

/** The comparator's ordering observation, from a leg record. Kept here so probe, comparator and self-test agree. */
export function layoutOfLeg(leg, caseName = 'slots') {
    const entry = (leg?.cases ?? []).find(item => item.case === caseName) ?? null;
    return {
        caseName,
        present: Boolean(entry),
        request: entry?.request ?? null,
        layout: entry?.layout ?? null,
        wire: entry?.wire ?? null,
    };
}
