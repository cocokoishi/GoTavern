// The COMPLEX PRESET, as one executable scenario shared by the capture run and both drive legs.
//
// A COMMITTED ORACLE IS NOT AN `inputs` ENTRY, AND THIS IS THE RULE FOR EVERY LANE THAT ADDS ONE.
// `tests/browser/catalog.test.mjs` reads every string in a committed artefact's `captures`/`inputs` and
// requires `tests/browser/.gitignore` to ignore it, because a name there is what the harness WROTE for one
// run. So a COMMITTED golden (an oracle a reader can open, which must never be ignored) has to be declared
// somewhere else -- here that is `expectsPinnedRecording`. Recording it in `inputs` failed Browser
// differential 40456523411 step 12 with "the harness wrote authors-note-pinned.json and
// tests/browser/.gitignore does not ignore it", and the test was right. The next lane to commit an oracle
// will hit the same wall; this paragraph is the one line that saves it the run.
//
// THIS KIT NEVER SELECTS A PRESET BY NAME, DELIBERATELY. `autoSelectPreset`
// (public/scripts/preset-manager.js:49-76) runs on CHAT_CHANGED and selects the preset whose NAME equals the
// character's, so a name-based selection here could be silently replaced by opening a character -- and both
// subjects would then agree on an input nobody chose. Selecting by name is what CREATES that hazard, so the
// kit edits the live `promptManager` instead, and the identity is asserted after the open and again before
// the click (see step 1b and the comparator's `*PresetIsNotNamedAfterTheCharacter`).
//
// WHAT PROBLEM THIS SOLVES. Every committed browser artefact before this file drives ONE captured
// configuration (tests/browser/fixtures/custom-source-settings.json: the Default prompt preset, an
// empty Auxiliary Prompt, no world info, no author's note, no stop strings, a 4096-token context and
// a prompt of ~1.9 k tokens). That request therefore cannot distinguish two servers whose token
// counts differ, cannot show whether world info reaches the provider at the right depth, and has no
// author's note or stop strings at all. AGENTS.md rule 8 asks for the opposite: a complex preset must
// produce the same FINAL provider request, and rule 9 makes the context boundary mandatory.
//
// THE SCENARIO IS APPLIED, THEN READ BACK. Nothing in fixtures/preset-*.json is hand-authored: the
// capture run drives the pinned frontend, reads `oai_settings`/`power_user`/the assembled messages
// OUT of it, and writes what it read (capture-preset.mjs). The constants below are the drive's own
// inputs -- marker strings and non-default values a human would type -- and every one of them is
// asserted to have taken effect before anything is measured. If a step silently does nothing, the
// capture fails by name instead of recording a smaller preset and calling it complex.
//
// WHY MARKERS. Each piece of the preset carries a unique ASCII marker, so the comparator can say
// WHICH piece moved (a system prompt, the description, one world-info entry, the author's note, one
// history turn) instead of "the body differs". The comparator also REQUIRES every marker to be
// present in the pinned leg's provider body: a preset that failed to apply is a harness defect, not
// a passing differential (AGENTS.md rule 7 -- an assertion that cannot fail is decoration).
//
// Q17 -- THE AUTHOR'S NOTE OVERLAY (GOAL.md Q17, docs/goal-scorecard.md). The same kit is the ONE
// definition of the scenario for the depth sweep: `applyAuthorsNoteOverlay` writes the note's
// position/depth/interval/role through the SAME frontend state the preset's step 5 uses, and
// `prepare-authors-note.mjs` runs it against the PINNED leg to derive the expectation. Nothing in this
// file decides what the right layout is: the pinned frontend's own request is the oracle, and the
// predicates below only describe what that request must look like for the comparison to mean anything.
// The semantics this sweep is built on, read from the PINNED SOURCE (commit 06bde939):
//   * `setFloatingPrompt` (public/scripts/authors-note.js:324-392) reads the note text from the
//     DOM field, writes `extension_prompts['2_floating_prompt']` with `chat_metadata`'s position,
//     depth, interval-derived value and role; interval <= 0 or no chat => position NONE (disabled).
//   * the note's POSITION decides the mechanism, not the depth
//     (`extension_prompt_types`, public/script.js:484-489):
//       1 IN_CHAT      -> `populationInjectionPrompts` (scripts/openai.js:810-875) splices an
//                         `injected: true` message at index `depth + totalInserted`;
//       0 IN_PROMPT    -> `preparePromptsForChatCompletion` (scripts/openai.js:1397-1404) pushes it
//                         with `position: 'end'`, and `populateChatCompletion`'s `injectToMain`
//                         (scripts/openai.js:1265-1284, 1295-1302) inserts it into the PROMPT BLOCK
//                         after the main prompt, where the depth is NOT read at all;
//       2 BEFORE_PROMPT-> the same push with `position: 'start'` (before the main prompt).
//     So "deeper than the history" is only observable in the IN_CHAT position, and the sweep records
//     IN_PROMPT separately as "this control does not read depth" rather than pretending otherwise.
//   * DEPTH BEYOND THE CHAT clamps at the oldest message:
//     `const injectIdx = Math.min(depth + totalInsertedMessages, messages.length);`
//     (scripts/openai.js:866-868) -- so an over-deep note lands at index 0 of the assembled list and
//     is indistinguishable from the deepest useful depth. That is a pinned property, and the sweep's
//     predicate says so instead of asserting "still deeper".
//   * the note carries NO `injected` member into the body: `MessageCollection.getChat`
//     (scripts/openai.js:3832-3847) builds {role, content, name?, tool_calls?, ...}, so the ONLY
//     observable difference between an injected note and a chat turn is its position and text.
//
// THE BUDGET IS MEASURED, NOT DERIVED. The pinned frontend trims history client-side, inside
// `populateChatHistory` (public/scripts/openai.js:951-1078): it walks the chat newest-first and stops
// at the first message that does not fit `openai_max_context - openai_max_tokens`
// (`setTokenBudget`, openai.js:3982-3989; `canAfford`, openai.js:4084). The capture therefore BINARY
// SEARCHES `openai_max_context` over the pinned frontend's own dry assembly, until it finds the
// smallest context at which the oldest history turn is still kept. That value and the one below it
// are the boundary pair, recorded as PINNED observations -- never as a number derived from Go.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const PRESET_FIXTURE = path.join(here, 'fixtures', 'preset-complex-settings.json');

// A name that cannot collide with a shipped preset, so a stale file in a data root can never be
// mistaken for this scenario's capture.
export const PRESET_NAME = 'GoTavern Complex Probe';

// MARKERS. ASCII only, so no encoding trap can hide a difference (AGENTS.md rule 9) and so the
// comparison is about prompt assembly rather than about how bytes happen to be encoded.
export const MARKERS = {
    main: 'PRESET_MAIN_7F',
    nsfw: 'PRESET_AUX_7F',
    description: 'PRESET_DESC_7F',
    personality: 'PRESET_PERS_7F',
    scenario: 'PRESET_SCEN_7F',
    example: 'PRESET_EXAMPLE_7F',
    jailbreak: 'PRESET_JAIL_7F',
    wiBefore: 'PRESET_WI_BEFORE_7F',
    wiAfter: 'PRESET_WI_AFTER_7F',
    wiDepth: 'PRESET_WI_DEPTH_7F',
    authorsNote: 'PRESET_AN_7F',
    history: 'PRESET_HIST_7F',
    userMarker: 'probe user marker',
    // THE TYPED MESSAGE. The drive types this into the composer and clicks send, so it becomes the
    // newest chat turn. The capture appends the SAME text to the chat before it bisects, because the
    // boundary is a property of the whole assembled message list and a capture that measured a
    // shorter chat would record a boundary the drive never reaches.
    send: 'PRESET_SEND_7F',
};

// Pad a marked line to a requested size. The history needs long, deterministic text so the context
// budget binds on HISTORY rather than on the system prompt, and so a one-token miscount by the
// server changes whether the oldest turn is kept.
export function padding(seed, characters) {
    const block = `${seed} `;
    return block.repeat(Math.ceil(characters / block.length)).slice(0, characters);
}

// Q17'S NOTE MARKER LIVES OUTSIDE `MARKERS`, DELIBERATELY, AND THIS IS A MEASURED CORRECTION.
//
// `compare-preset-legs.mjs` derives the set of markers the plain preset scenario MUST produce from
// `Object.entries(MARKERS)` (`const allMarkers = Object.entries(scenario?.markers ?? MARKERS)`), and
// requires every one of them in BOTH legs' provider bodies. Putting Q17's overlay marker into that map
// made it a required marker for the PLAIN preset legs, where the overlay is -- correctly -- not applied:
// run 40444046677 (Browser differential, mode=preset) failed with
//   unfaithful preset differential, 5 guard(s) failed: boundaryMarkersArrivedOnBothLegs,
//   scenarioAppliedOnThePinnedLeg, scenarioAppliedOnTheGOTavernLeg, everyMarkerArrived,
//   dropVariantCarriesEveryOtherMarker      missingBoundaryMarkers: ["authorsNote_DEPTH"]
// i.e. the Q17 sweep broke the preset gate it was supposed to run beside, and the failure named a marker
// that no plain preset leg could ever produce.
//
// A marker the OVERLAY produces is not a marker the SCENARIO produces, so it is a separate export with
// its own name. The Q17 layout code reads it by name (`layoutOf`'s `noteMarker` option), never by iterating
// `MARKERS`, so nothing about Q17 depends on this map.
export const AUTHORS_NOTE_OVERLAY_MARKER = 'PRESET_AN_DEPTH_7F';

// THE SPEC. One object, serialised into the page and into the fixture, so the capture and both legs
// cannot drift apart: there is exactly one description of the scenario in the repository.
//
// WHY THE HISTORY IS THIS LONG. The first version used 900 + 6*260 characters and its measured flip
// point sat at max_context 1099/1100, right where the FRONTEND is also dropping its own example and
// world-info messages as the budget shrinks: the run recorded keep=15 messages and drop=17, so the
// variant that keeps fewer history turns had MORE messages in total. Total message count is therefore
// not a discriminator at a tight budget; the number of HISTORY messages is. A history of ~2 k tokens
// puts the flip point far above that churn, where exactly one history turn changes per token step.
export function presetSpec() {
    const history = [];
    // The OLDEST turn is the discriminator: it is the message the trimmer drops first, so its marker is
    // what the boundary assertion looks for. It is deliberately the LONGEST turn, so dropping it frees
    // far more than one token and the flip cannot be produced by any other message.
    history.push({ isUser: true, text: `${MARKERS.history} TURN_00 oldest ${padding('older', 1600)}` });
    for (let turn = 1; turn <= 11; turn++) {
        const index = String(turn).padStart(2, '0');
        history.push({
            isUser: turn % 2 === 0,
            text: `${MARKERS.history} TURN_${index} ${padding(`turn-${index}`, 600)}`,
        });
    }
    return {
        name: PRESET_NAME,
        markers: MARKERS,
        // The message the drive types. Kept in the spec so the capture and the drive cannot disagree.
        send: `${MARKERS.userMarker} ${MARKERS.send}`,
        character: {
            description: `${MARKERS.description} A guardian of the glade who remembers every visitor.`,
            personality: `${MARKERS.personality} caring, watchful, precise about her own lore.`,
            scenario: `${MARKERS.scenario} A lantern-lit glade at the edge of an old forest.`,
            examples: `<START>\n{{user}}: Tell me about the glade.\n{{char}}: ${MARKERS.example} It keeps its own history, and so do I.`,
        },
        prompts: {
            // A text-completion/prompt-manager entry that must survive at a known position.
            main: `${MARKERS.main} Write {{char}}'s next reply in a fictional chat between {{char}} and {{user}}.`,
            nsfw: `${MARKERS.nsfw} auxiliary instruction that must appear once.`,
            jailbreak: `${MARKERS.jailbreak} post-history instruction that must stay last in the prompt block.`,
        },
        world: {
            // THREE ENTRIES, ONE PER POSITION CLASS the comparator checks: before the prompt block,
            // after it, and injected at depth. The `before` entry was MISSING while `MARKERS.wiBefore`
            // was declared and the comparator required every marker -- so `wiBefore` could never arrive
            // and `everyMarkerArrived` was false by construction (run 40073821604). A marker with no
            // producer is the same class of defect as an artefact field with no producer.
            name: 'GoTavern Probe Lore',
            entries: [
                {
                    uid: 0,
                    comment: 'before-character anchor',
                    key: ['glade'],
                    content: `${MARKERS.wiBefore} The glade remembers every name spoken in it.`,
                    position: 'before',
                    depth: 4,
                    constant: true,
                    order: 50,
                },
                {
                    uid: 1,
                    comment: 'after-character anchor',
                    key: ['glade'],
                    content: `${MARKERS.wiAfter} The glade answers to whoever speaks its name.`,
                    position: 'after',
                    depth: 4,
                    constant: true,
                    order: 100,
                },
                {
                    uid: 2,
                    comment: 'in-chat depth zero',
                    key: ['lantern'],
                    content: `${MARKERS.wiDepth} The lantern burns without fuel.`,
                    position: 'atDepth',
                    depth: 0,
                    constant: true,
                    order: 200,
                },
            ],
        },
        authorsNote: {
            text: `${MARKERS.authorsNote} Keep the reply under four sentences.`,
            // NOT the default depth (4), and IN_CHAT so the note competes with history for budget.
            depth: 3,
            position: 'IN_CHAT',
            role: 'system',
        },
        history,
        samplers: {
            temperature: 0.42,
            top_p: 0.81,
            presence_penalty: 0.35,
            frequency_penalty: 0.17,
            top_k: 0,
            seed: 424242,
        },
        stops: ['STOP_A_7F', 'STOP_B_7F'],
        // A SMALL response budget, so context - response leaves room for the history but not for all
        // of it: the boundary is then a property of the history length rather than of the system
        // prompt. `openai_max_context` is NOT in the spec -- the capture measures it (below).
        maxTokens: 64,
        // A non-default names_behavior so a `name` member (or a name prefix) is part of the request.
        namesBehavior: 1,
        // Instruct/context templates are TEXT-COMPLETION settings. They are set to a non-default
        // value here so the artefact can record that a chat-completion request does not change when
        // they do -- the invariant is asserted by comparing this drive against the same drive with
        // the default templates, not assumed.
        templates: { instruct: 'ChatML', context: 'ChatML' },
        defaultTemplates: { instruct: 'Neutral', context: 'Default' },
    };
}

// ---------------------------------------------------------------------------------------------
// In-page application. Runs inside the PINNED frontend with `page.evaluate(applyPresetKit, spec)`,
// so it must be self-contained: no imports from this module, no closures. Everything it touches is
// a frontend module the UI itself uses.
// ---------------------------------------------------------------------------------------------
export async function applyPresetKit(spec) {
    const script = await import('./script.js');
    const openai = await import('./scripts/openai.js');
    const worldInfo = await import('./scripts/world-info.js');
    const authorsNote = await import('./scripts/authors-note.js');
    const powerUser = await import('./scripts/power-user.js');
    const steps = [];
    const problems = [];

    const settle = async (predicate, label, attempts = 60) => {
        for (let attempt = 0; attempt < attempts; attempt++) {
            if (predicate()) return true;
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        problems.push(`${label} never became true`);
        return false;
    };
    const step = (name, detail) => steps.push({ step: name, ...detail });

    // 1. A character must be bound: prompt assembly reads characters[this_chid].
    await script.getCharacters();
    if (!Array.isArray(script.characters) || script.characters.length === 0) {
        return { problems: ['no characters available after getCharacters()'], steps };
    }
    await script.selectCharacterById(0, { switchMenu: false });
    const chid = script.this_chid;
    if (chid === 'undefined' || chid === undefined || chid === null) {
        return { problems: ['selectCharacterById(0) did not bind a character'], steps };
    }
    const boundName = String(script.characters[chid]?.name ?? '');
    step('character', { index: Number(chid), name: boundName || null });

    // 1b. THE PRESET IDENTITY, ASSERTED AFTER THE CHARACTER IS OPEN -- the hazard another lane measured today.
    //
    // `autoSelectPreset` (public/scripts/preset-manager.js:49-76) runs on CHAT_CHANGED and does
    // `const name = characters[this_chid]?.name; const preset = presetManager.findPreset(name);
    // if (preset !== selected) presetManager.selectPreset(preset);` -- i.e. OPENING A CHARACTER silently
    // replaces the preset with one whose NAME EQUALS THE CHARACTER'S. If that fires here, the depth settings
    // this kit applies afterwards would be applied on top of a preset the leg did not choose, and both
    // subjects would be wrong the same way: Node == Go on the WRONG input, which is the one failure shape a
    // differential cannot see.
    //
    // THIS KIT'S ORDER, stated so the answer does not have to be re-derived: it opens the character (above)
    // and never selects a preset by name at all -- `applyPresetKit` only edits the LIVE `promptManager`'s
    // prompt contents (step 8 below) and the note/samplers. So there is no "staged preset" for the hook to
    // steal: the kit mutates whatever preset is already active. The residual risk is a preset whose name
    // MATCHES the card, which would make the page select it and change `activeCharacter` mid-kit; that is
    // exactly what is measured below rather than assumed away.
    let presetIdentity = null;
    try {
        const presetManager = script.getPresetManager?.();
        if (presetManager) {
            const selected = presetManager.getSelectedPresetName?.() ?? null;
            presetIdentity = {
                afterCharacterOpen: selected,
                characterName: boundName,
                // THE HAZARD CONDITION ITSELF: a preset named after the character exists and is what the page
                // now reports. Either fact alone is benign; together they mean the hook fired.
                matchesCharacter: selected !== null && boundName !== '' && String(selected).trim() === boundName.trim(),
                activeCharacter: presetManager.activeCharacter ?? null,
            };
            if (presetIdentity.matchesCharacter) {
                problems.push(`autoSelectPreset fired: the page reports preset ${JSON.stringify(selected)}, which IS the character's name, so the preset under test is not the one the leg chose -- every depth below would be measured on a preset nobody selected`);
            }
        } else {
            // Recorded as a fact, not a failure: the manager exists only for APIs that have one, and the
            // `custom` source the sweep drives may not expose it. A missing manager means this guard could not
            // run, which the artefact must say rather than let it read as "checked and fine".
            presetIdentity = { managerPresent: false };
        }
    } catch (error) {
        presetIdentity = { error: String(error?.message ?? error).slice(0, 200) };
    }
    step('preset identity after character open', presetIdentity ?? {});

    // 2. Character fields. These are read by prompt assembly from the in-memory card, and the marker
    //    guard in the comparator is what proves they reached the request.
    const card = script.characters[chid];
    card.description = spec.character.description;
    card.personality = spec.character.personality;
    card.scenario = spec.character.scenario;
    card.mes_example = spec.character.examples;
    for (const field of ['description', 'personality', 'scenario', 'mes_example']) {
        if (!String(card[field] ?? '').includes('PRESET_')) {
            problems.push(`character.${field} did not take the scenario text`);
        }
    }
    step('character fields', { fields: ['description', 'personality', 'scenario', 'mes_example'], via: 'in-memory card' });

    // 3. Chat history. `chat` is a module-level array; it is MUTATED, never replaced, so the
    //    frontend's own references see the turns. Turn 0 is the greeting, which is the character's
    //    first message and is kept by the same budget rule as any other turn.
    const charName = String(card.name ?? 'Character');
    script.chat.length = 0;
    script.chat.push({
        name: charName,
        is_user: false,
        is_system: false,
        send_date: '2026-01-01T00:00:00.000Z',
        mes: `${spec.markers.example} *She looks up as you approach the lantern.*`,
        extra: {},
    });
    for (const turn of spec.history) {
        script.chat.push({
            name: turn.isUser ? 'Probe User' : charName,
            is_user: turn.isUser,
            is_system: false,
            send_date: '2026-01-01T00:00:00.000Z',
            mes: turn.text,
            extra: {},
        });
    }
    const oldest = spec.history[0].text;
    if (script.chat.length !== spec.history.length + 1) {
        problems.push(`chat has ${script.chat.length} turns, expected ${spec.history.length + 1}`);
    }
    step('chat history', { turns: script.chat.length, via: 'script.chat mutation' });

    // 4. World info. `createNewWorldInfo` does NOT populate `world_info[name]` (measured in run
    //    40073802369: the map held only `globalSelect` afterwards), so the book is built in a local data
    //    object, written through world-info.js's own `saveWorldInfo` and then READ BACK from the server
    //    with `loadWorldInfo` -- which is also the round trip that proves the two servers stored it.
    //    Entries are created by the frontend's `createWorldInfoEntry`, so the uid and the entry template
    //    are the frontend's rather than ours.
    const positions = worldInfo.world_info_position;
    const worldName = spec.world.name;
    const worldData = { entries: {} };
    for (const entry of spec.world.entries) {
        const live = worldInfo.createWorldInfoEntry(worldName, worldData);
        if (!live) {
            problems.push(`world-info entry ${entry.uid} could not be created (createWorldInfoEntry returned nothing)`);
            continue;
        }
        live.comment = entry.comment;
        live.key = entry.key;
        live.keysecondary = [];
        live.content = entry.content;
        live.constant = entry.constant;
        live.selective = false;
        live.disable = false;
        // POSITION IS MAPPED BY NAME, NOT BY "after OR ELSE". The previous form was
        // `entry.position === 'after' ? positions.after : positions.atDepth`, so a `before` entry would
        // have silently become an IN-CHAT injection -- the same slot as the depth-0 entry, which would
        // have made the `before` marker arrive in the wrong place even after the entry existed.
        const positionNames = { before: 'before', after: 'after', atDepth: 'atDepth' };
        const positionValue = positions[positionNames[entry.position]];
        if (typeof positionValue !== 'number') {
            problems.push(`world-info entry ${entry.uid} wants position ${JSON.stringify(entry.position)} but world_info_position exposes no ${JSON.stringify(positionNames[entry.position])} slot (it holds ${JSON.stringify(Object.keys(positions ?? {}))})`);
            continue;
        }
        live.position = positionValue;
        live.depth = entry.depth;
        live.order = entry.order;
        live.probability = entry.probability ?? 100;
        live.useProbability = Boolean(entry.useProbability);
        // A role belongs to the IN-CHAT path only; before/after entries carry no role. Same name-based
        // reasoning as the position mapping above -- "not after" is not "in chat".
        live.role = entry.position === 'atDepth' ? 0 : null;
    }
    // IMMEDIATE save: the default is a debounced write, and a capture that read the world back before
    // the debounce fired would record an empty book.
    await worldInfo.saveWorldInfo(worldName, worldData, true);
    if (typeof worldInfo.updateWorldInfoList === 'function') {
        await worldInfo.updateWorldInfoList();
    }
    const loadedWorld = await worldInfo.loadWorldInfo(worldName);
    const savedEntries = Object.keys(loadedWorld?.entries ?? {});
    if (savedEntries.length !== spec.world.entries.length) {
        problems.push(`world "${worldName}" has ${savedEntries.length} entries after the server round trip, expected ${spec.world.entries.length}`);
    }
    if (!Array.isArray(worldInfo.selected_world_info)) {
        problems.push('selected_world_info is not an array');
    } else if (!worldInfo.selected_world_info.includes(worldName)) {
        worldInfo.selected_world_info.push(worldName);
    }
    step('world info', {
        world: worldName,
        entries: savedEntries.length,
        positions: { after: positions.after, atDepth: positions.atDepth },
        activated: worldInfo.selected_world_info.includes(worldName),
        via: 'createWorldInfoEntry -> saveWorldInfo(immediate) -> loadWorldInfo round trip',
    });

    // 5. Author's note. THE INTERVAL MATTERS AND THE VALUE COMES FROM THE DOM. `setFloatingPrompt`
    //    (authors-note.js:324-395) disables the note when `note_interval` is 0 or unset, and it reads the
    //    TEXT from `$('#extension_floating_prompt').val()`, not from chat_metadata -- measured in run
    //    40073802369, where an unset interval left `extension_prompts['2_floating_prompt'].value` empty.
    //    So: interval 1 (every user message), the field typed the way a user types it, the metadata
    //    written, then the extension's own function called.
    const keys = authorsNote.metadata_keys;
    script.chat_metadata[keys.prompt] = spec.authorsNote.text;
    script.chat_metadata[keys.depth] = spec.authorsNote.depth;
    script.chat_metadata[keys.position] = script.extension_prompt_types[spec.authorsNote.position];
    script.chat_metadata[keys.interval] = 1;
    if (keys.role) {
        script.chat_metadata[keys.role] = 0;
    }
    const promptField = document.querySelector('#extension_floating_prompt');
    if (promptField) {
        promptField.value = spec.authorsNote.text;
        promptField.dispatchEvent(new Event('input', { bubbles: true }));
    }
    const intervalField = document.querySelector('#extension_floating_interval');
    if (intervalField) {
        intervalField.value = '1';
        intervalField.dispatchEvent(new Event('input', { bubbles: true }));
    }
    if (typeof authorsNote.setFloatingPrompt === 'function') {
        authorsNote.setFloatingPrompt();
    } else {
        problems.push('authors-note.js does not export setFloatingPrompt');
    }
    const floating = script.extension_prompts?.[`2_floating_prompt`];
    if (!floating || !String(floating.value ?? '').includes(spec.markers.authorsNote)) {
        problems.push(`the author's note did not reach extension_prompts["2_floating_prompt"] (got ${JSON.stringify(floating?.value ?? null)}; interval field present: ${Boolean(intervalField)}, prompt field present: ${Boolean(promptField)})`);
    }
    step('authors note', {
        depth: script.chat_metadata[keys.depth],
        position: script.chat_metadata[keys.position],
        interval: script.chat_metadata[keys.interval],
        keys: { prompt: keys.prompt, depth: keys.depth, position: keys.position, interval: keys.interval, role: keys.role ?? null },
        fieldsPresent: { prompt: Boolean(promptField), interval: Boolean(intervalField) },
        present: Boolean(floating?.value),
    });

    // 6. Stop strings, through the getter the request builder itself calls
    //    (`getCustomStoppingStrings(4)`, openai.js:2814).
    powerUser.power_user.custom_stopping_strings = JSON.stringify(spec.stops);
    const effectiveStops = powerUser.getCustomStoppingStrings(4);
    if (JSON.stringify(effectiveStops) !== JSON.stringify(spec.stops)) {
        problems.push(`custom stopping strings read back as ${JSON.stringify(effectiveStops)}, expected ${JSON.stringify(spec.stops)}`);
    }
    step('stop strings', { value: effectiveStops, via: 'power_user.custom_stopping_strings + getCustomStoppingStrings()' });

    // 7. Samplers and limits on oai_settings. These are the numbers createGenerationParameters copies
    //    into the request body.
    const settings = openai.oai_settings;
    settings.temp_openai = spec.samplers.temperature;
    settings.top_p_openai = spec.samplers.top_p;
    settings.pres_openai = spec.samplers.presence_penalty;
    settings.freq_openai = spec.samplers.frequency_penalty;
    settings.top_k_openai = spec.samplers.top_k;
    settings.seed = spec.samplers.seed;
    settings.n = 1;
    settings.openai_max_tokens = spec.maxTokens;
    settings.names_behavior = spec.namesBehavior;
    step('samplers and limits', {
        via: 'oai_settings assignment',
        values: {
            temperature: settings.temp_openai,
            top_p: settings.top_p_openai,
            presence_penalty: settings.pres_openai,
            frequency_penalty: settings.freq_openai,
            max_tokens: settings.openai_max_tokens,
            names_behavior: settings.names_behavior,
            seed: settings.seed,
        },
    });

    // 8. The prompt text itself, through the Prompt Manager that owns it. `getPromptById` returns the
    //    live Prompt, and assembly reads the same object.
    const promptManager = openai.promptManager;
    const applied = {};
    const edits = [
        ['main', spec.prompts.main],
        ['nsfw', spec.prompts.nsfw],
        ['jailbreak', spec.prompts.jailbreak],
    ];
    for (const [identifier, content] of edits) {
        const prompt = promptManager?.getPromptById?.(identifier);
        if (!prompt) {
            problems.push(`promptManager has no prompt "${identifier}"`);
            continue;
        }
        prompt.content = content;
        prompt.system_prompt = true;
        prompt.marker = false;
        applied[identifier] = prompt.content;
        if (!String(promptManager.getPromptById(identifier).content).includes('PRESET_')) {
            problems.push(`prompt "${identifier}" did not take the scenario text`);
        }
    }
    // The order entry decides whether a prompt is included at all; assert the ones this scenario
    // depends on are enabled, because a disabled prompt would silently shrink the preset.
    const order = promptManager?.getPromptOrderForCharacter?.(promptManager.activeCharacter);
    const enabled = new Map((order ?? []).map(entry => [entry.identifier, entry.enabled]));
    for (const identifier of ['main', 'nsfw', 'jailbreak', 'charDescription', 'charPersonality', 'scenario', 'dialogueExamples', 'chatHistory', 'worldInfoBefore', 'worldInfoAfter']) {
        if (enabled.has(identifier) && enabled.get(identifier) === false) {
            problems.push(`prompt "${identifier}" is disabled in the prompt order, so the preset would not be complex`);
        }
    }
    step('prompts', { edited: Object.keys(applied), orderEntries: enabled.size });

    // 9. Instruct/context templates: recorded, and the comparator proves they do not reach a
    //    chat-completion request (they are text-completion settings).
    if (powerUser.power_user?.instruct && spec.templates) {
        powerUser.power_user.instruct.name = spec.templates.instruct;
        powerUser.power_user.context.name = spec.templates.context;
    }
    step('templates', {
        instruct: powerUser.power_user?.instruct?.name ?? null,
        context: powerUser.power_user?.context?.name ?? null,
        note: 'text-completion settings; a chat-completion request must be identical with different templates',
    });

    return {
        problems,
        steps,
        oldestMarker: oldest,
        // The captured state, read back from the frontend rather than written by the harness.
        oaiSettings: JSON.parse(JSON.stringify(openai.oai_settings)),
        powerUser: JSON.parse(JSON.stringify({
            custom_stopping_strings: powerUser.power_user.custom_stopping_strings,
            instruct: powerUser.power_user.instruct,
            context: powerUser.power_user.context,
        })),
        prompts: applied,
        chatTurns: script.chat.length,
    };
}

// ---------------------------------------------------------------------------------------------
// Q17: THE AUTHOR'S NOTE OVERLAY. One definition, used by the pinned preparation drive and by both
// compared legs, so the oracle and the subject cannot be given two different scenarios.
//
// The overlay is applied ON TOP of the preset kit (`applyPresetKit` step 5), which is what gives the
// sweep its world-info and history context: the note then has competitors at known positions and a
// history long enough for a depth of 6 and a depth of 20 to produce different requests.
//
// WHICH MECHANISM PLACES THE NOTE, STATED ONCE WITH ITS LINES (this decides what every case MEANS):
//
//   `scripts/openai.js:810-875`  `populationInjectionPrompts` is the mechanism for an IN_CHAT note. It
//                                walks `for (let i = 0; i <= maxDepth; i++)` (:820), groups the prompts at
//                                that depth by `injection_order` and then by role in the order
//                                `['system','user','assistant']` (:847), and splices each depth's group at
//                                `const injectIdx = i + totalInsertedMessages` (:867) -- a per-depth
//                                counter that grows as earlier depths insert -- then reverses the list back
//                                at :873.
//   `scripts/openai.js:578`      THE ARRAY IT SPLICES INTO IS NEWEST-FIRST: `setOpenAIMessages` loops
//                                `for (let i = chat.length - 1; i >= 0; i--)`. Therefore **depth 0 is the
//                                LAST message sent**, and depth N is N messages above the end. A test that
//                                assumed "depth 0 = the first message" would assert the OPPOSITE of pinned;
//                                `depthZeroIsTheNewestPosition` in authors-note-sweep-kit.mjs asserts the
//                                count of history turns BELOW the note is exactly 0 at depth 0, which is
//                                that fact in a form that can fail.
//   `scripts/openai.js:866-868`  the `Math.min(depth + totalInserted, messages.length)` clamp: a depth
//                                deeper than the conversation lands at the top of the list, so
//                                "deeper-than-history" is only observable as "at least as deep as the
//                                oldest turn", never as "strictly deeper".
//   `scripts/openai.js:1136-1150`, `:1265-1302`, `:1397-1404`
//                                the IN_PROMPT position is a DIFFERENT mechanism: the note becomes a
//                                `position: 'end'` prompt, `injectToMain` inserts it around the `main`
//                                prompt, and the depth is never read. That is why `in-prompt-depth6` asserts
//                                "the note sits above the chat region", not "the note is at depth 6".
//
// REGEX IS DELIBERATELY OUT OF SCOPE FOR THIS NOTE, and saying so is a decision rather than an omission:
// the regex lane established that user INPUT is rewritten twice in pinned (`script.js:5875` before the text
// is pushed into `chat`, then `script.js:4506` during assembly). This scenario installs NO regex ruleset on
// either subject -- the note's text is a plain ASCII marker and the drives apply no `regex_scripts` -- so
// the note cannot be rewritten between application and the request, and a difference in the note's text can
// only come from the product. If a future case adds regex, it must revisit this paragraph.
// ---------------------------------------------------------------------------------------------
export function authorsNoteOverlaySpec() {
    return {
        // ASCII only, so no encoding trap can hide a difference.
        text: `${AUTHORS_NOTE_OVERLAY_MARKER} Keep the reply under four sentences.`,
        // THE HISTORY IS LONG ENOUGH THAT DEPTH DISCRIMINATES, AND THE BUDGET IS THE LIMIT. At the keep
        // context the pinned trimmer (openai.js:949-1075) holds 12 history turns only when the note is absent,
        // so the deepest depth that still delivers the note is 8. Measured on the pinned leg: depths 0, 4, 6
        // and 8 arrive; 14 and 20 do not (see `depth-deeper-than-history`'s retirement note below).
        parityDepth: 6,
        // RETIRED, AND KEPT ONLY AS THE RECORD OF WHAT WAS TRIED. Two runs measured a deep case (depth 20 in
        // 40447689701, depth 14 in 40451173262) and produced IDENTICAL pinned numbers with the note absent, so
        // no value in this class can measure depth against this fixture. `resolveAuthorsNoteCase` can still
        // resolve the intent (a future fixture with a larger budget may re-use it); no case in `cases` below
        // declares it, and both the sweep and the self-checks treat its absence as a stated gap.
        deeperThanHistoryDepth: 14,
        depth: 6,
        cases: [
            // THE VERIFICATION CASE. Same text, same history, same budget on both subjects: the
            // provider request must be byte-identical. Everything else is measured against it, and it is
            // the case that would catch a product change unrelated to the note.
            { id: 'parity', role: 'system', enabled: true, depthIntent: 'item', depthFromParity: 0 },
            // THE REQUIRED DEPTH CASES (Q17 in docs/goal-scorecard.md) -- depth 0 (the NEWEST position,
            // openai.js:578+867), a non-zero depth, and a depth deeper than the history.
            { id: 'depth0', role: 'system', enabled: true, depthIntent: 'zero' },
            { id: 'depth4', role: 'system', enabled: true, depthIntent: 'item', depthFromParity: -2 },
            { id: 'depth8', role: 'system', enabled: true, depthIntent: 'item', depthFromParity: 2 },
            // RETIRED: `depth-deeper-than-history`. READ THIS BEFORE RE-ADDING A DEEP CASE.
            //
            // Two preset runs measured it and both said the same thing, which is why it is gone rather than
            // tuned again. Browser differential 40447689701 at depth 20 and 40451173262 at depth 14 produced
            // IDENTICAL pinned numbers -- noteIndex -1, historyBelow 12, messages 23, bodyLength 14501 -- with
            // the note ABSENT from the request. Comparing the two depths that DO work, from the same run's
            // legs:
            //     depth 8   -> 26 messages, 11 history turns, TURN_00 absent, note PRESENT at index 15
            //     depth 14  -> 23 messages, 12 history turns, TURN_00 present, note ABSENT
            // Raised past what the budget can hold, the trimmer (`populateChatHistory`, openai.js:949-1075)
            // releases older turns, which frees tokens, which lets the frontend emit MORE messages, which moves
            // the list the injection is placed against (`injectIdx = Math.min(depth + totalInserted,
            // messages.length)`, openai.js:866-868). At this keep context (4260) the note arrives at depths 0,
            // 4, 6 and 8 and does not arrive at 14 or 20.
            //
            // DEPTH PAST THE BUDGET IS A TRUNCATION FACT, NOT A DEPTH FACT. A case whose observation is "the
            // note vanished" measures the trimmer, which Q18 already owns with a measured boundary; worse, the
            // depth-20 form collapsed onto the DISABLED case's exact bytes (`c94a514779239e5d`), i.e. two
            // different intents, one observation. A fourth value would be a guess dressed as a measurement.
            //
            // WHAT IS THEREFORE UNPROVEN AND IS NOT CLAIMED: there is NO depth at this budget that keeps the
            // note AND every declared turn, so "an implementation clamps depth to the history length" is
            // UNTESTED. The artefact records that as `pastHistoryInsideBudget: null` with these measurements
            // beside it, rather than implying coverage. Depth 8 is the deepest point this fixture can still
            // say something about DEPTH.
            //
            // DISABLED BY THE PRODUCT'S OWN GATE: `setFloatingPrompt` writes position NONE when the
            // interval is <= 0 (authors-note.js:351-356), which is what the UI's "(0 = Disable)" label
            // promises. The note must be absent from the request -- and the request must still exist,
            // which the leg asserts separately so "no note" cannot be confused with "no send".
            { id: 'disabled-interval0', role: 'system', enabled: false, depthIntent: 'parity', disabledBy: 'interval' },
            // POSITION IS NOT DEPTH (openai.js:1397-1404 + :1136-1150): recorded as its own case so the
            // sweep states that the IN_PROMPT position ignores the depth instead of quietly dropping the
            // position axis.
            { id: 'in-prompt-depth6', role: 'system', position: 'IN_PROMPT', enabled: true, depthIntent: 'item', depthFromParity: 0 },
        ],
    };
}

// Per-case resolution: which concrete numbers this case runs at. `parityDepth` is the anchor, so a
// case described as "two deeper than parity" stays two deeper if the anchor ever has to move, and the
// recorded intent ("this case must place the note deeper than the parity case did") travels with it.
export function resolveAuthorsNoteCase(overlay, id) {
    const entry = (overlay?.cases ?? []).find(candidate => candidate.id === id);
    if (!entry) throw new Error(`authors-note overlay has no case ${JSON.stringify(id)}`);
    const parity = Number(overlay.parityDepth);
    const depth = entry.depthIntent === 'zero' ? 0
        : entry.depthIntent === 'deeper-than-history' ? Number(overlay.deeperThanHistoryDepth)
            : entry.depthIntent === 'item' ? parity + Number(entry.depthFromParity ?? 0)
                : parity;
    return {
        ...entry,
        depth: Number.isInteger(depth) ? depth : null,
        position: entry.position ?? 'IN_CHAT',
        // Interval 1 = "insert on every user message", the value the preset's own step 5 writes and the
        // only value that inserts on the first turn (authors-note.js:347-349).
        interval: entry.enabled === false && entry.disabledBy === 'interval' ? 0 : 1,
        text: overlay.text,
        caseId: entry.id,
    };
}

// Applies ONE overlay case through the frontend's own state and its own function. Runs inside the
// page (`page.evaluate`), so it must be self-contained. It never calls the author's-note module
// directly: `Generate` does that itself (`script.js:4619 setFloatingPrompt()`), which is the user's
// path and therefore the one that must be observed.
export async function applyAuthorsNoteOverlay(resolved) {
    const script = await import('./script.js');
    const authorsNote = await import('./scripts/authors-note.js');
    const problems = [];
    const keys = authorsNote.metadata_keys;
    const position = script.extension_prompt_types?.[resolved.position];
    if (typeof position !== 'number') {
        return { problems: [`extension_prompt_types exposes no ${JSON.stringify(resolved.position)} (it holds ${JSON.stringify(Object.keys(script.extension_prompt_types ?? {}))})`] };
    }
    const roleValue = script.extension_prompt_roles?.[String(resolved.role ?? 'system').toUpperCase()];
    if (typeof roleValue !== 'number') {
        return { problems: [`extension_prompt_roles exposes no role ${JSON.stringify(resolved.role)}`] };
    }
    // METADATA FIRST (the state `setFloatingPrompt` reads), then the DOM fields (the state it also reads
    // for the TEXT and the interval), then the product's own re-derivation. Order matters: loadSettings()
    // would overwrite the metadata from the DOM, so the metadata is written after any earlier apply and
    // the fields are typed last.
    script.chat_metadata[keys.prompt] = resolved.text;
    script.chat_metadata[keys.depth] = resolved.depth;
    script.chat_metadata[keys.position] = position;
    script.chat_metadata[keys.interval] = resolved.interval;
    if (keys.role) {
        script.chat_metadata[keys.role] = roleValue;
    }
    const typeInto = (selector, value) => {
        const field = document.querySelector(selector);
        if (!field) return false;
        field.value = String(value);
        field.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
    };
    const promptField = typeInto('#extension_floating_prompt', resolved.text);
    const intervalField = typeInto('#extension_floating_interval', resolved.interval);
    const depthField = typeInto('#extension_floating_depth', resolved.depth);
    const roleField = typeInto('#extension_floating_role', roleValue);
    if (!promptField) problems.push('#extension_floating_prompt is not present, so the note text cannot be typed the way a user types it');
    if (!intervalField) problems.push('#extension_floating_interval is not present, so the frequency cannot be typed');
    // THE POSITION RADIOS ARE THE THIRD COPY the frontend keeps: `loadSettings` reads
    // `input[name="extension_floating_position"][value=N]` (authors-note.js:303) and an `input` handler
    // writes the metadata back from `e.target.value` (:162-166). Setting the radio and firing the SAME
    // events the browser fires for a click is the user's path; assigning the metadata directly would be
    // overwritten the next time `loadSettings()` ran.
    const radio = document.querySelector(`input[name="extension_floating_position"][value="${position}"]`);
    if (radio) {
        radio.checked = true;
        radio.dispatchEvent(new Event('input', { bubbles: true }));
        radio.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
        problems.push(`no input[name="extension_floating_position"][value="${position}"] radio is rendered, so the position cannot be set the way a user sets it`);
    }
    // The DOM handlers are debounced in places; the product's own function is then called explicitly so
    // the state is settled before the send rather than racing a timer (the preset kit's step 5 does the
    // same, and does it for the same reason).
    if (typeof authorsNote.setFloatingPrompt === 'function') {
        authorsNote.setFloatingPrompt();
    } else {
        problems.push('authors-note.js does not export setFloatingPrompt');
    }
    const floating = script.extension_prompts?.['2_floating_prompt'] ?? null;
    return {
        problems,
        applied: {
            caseId: resolved.caseId ?? null,
            depth: script.chat_metadata[keys.depth],
            position: script.chat_metadata[keys.position],
            interval: script.chat_metadata[keys.interval],
            role: keys.role ? script.chat_metadata[keys.role] : null,
            fieldsPresent: { prompt: promptField, interval: intervalField, depth: depthField, role: roleField, positionRadio: Boolean(radio) },
            extensionPrompt: floating ? { value: String(floating.value ?? ''), position: floating.position, depth: floating.depth, role: floating.role, scan: floating.scan } : null,
            counter: document.querySelector('#extension_floating_counter')?.textContent ?? null,
        },
    };
}

// ---------------------------------------------------------------------------------------------
// Reading the provider request. Shared by the comparator and by capture, so "which message is the
// oldest history turn" has exactly one definition.
// ---------------------------------------------------------------------------------------------
export function parseProviderBody(report) {
    const post = (report.recording ?? []).find(entry => entry.method === 'POST' && entry.body);
    if (!post) return null;
    try {
        return { body: JSON.parse(post.body), raw: post.body, bodyLength: post.bodyLength, bodySha256: post.bodySha256 };
    } catch {
        return null;
    }
}

export function messageText(message) {
    const content = message?.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content.map(part => (typeof part === 'string' ? part : part?.text ?? '')).join('\n');
    }
    return '';
}

// findMessage returns the index of the first message whose text contains `needle`, or -1.
export function findMessage(body, needle) {
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    return messages.findIndex(message => messageText(message).includes(needle));
}

// ---------------------------------------------------------------------------------------------
// Q17: WHERE THINGS SIT IN THE ASSEMBLED REQUEST. The measurement has to be positional, not
// presence-based: "the note is in the body" is true at every depth, so it cannot answer Q17. What
// changes with depth is WHERE the note sits, relative to the history turns, the world-info entries and
// the other injections, and `index` alone is not enough because the frontend's own example/world-info
// messages shift the whole list as the budget changes.
//
// So the NEWEST-FIRST measured position is `historyBelow`: how many of the scenario's own history
// markers sit AFTER the note in the list. That number is what `injectIdx = depth + totalInserted`
// (scripts/openai.js:867) produces in the unclamped case, it does not move when unrelated messages are
// added ahead of the history, and it is directly comparable to what the PINNED leg measured.
// ---------------------------------------------------------------------------------------------
export function layoutOf(body, options) {
    const messages = Array.isArray(body?.messages) ? body.messages : null;
    if (!messages) return null;
    const historyMarker = options?.historyMarker ?? MARKERS.history;
    const noteMarker = options?.noteMarker ?? AUTHORS_NOTE_OVERLAY_MARKER;
    const worldMarkers = options?.worldMarkers ?? { before: MARKERS.wiBefore, after: MARKERS.wiAfter, depth: MARKERS.wiDepth };
    const chatMarkers = Array.isArray(options?.chatMarkers) ? options.chatMarkers : [];
    const at = needle => findMessage(body, needle);
    const noteIndex = at(noteMarker);
    const historyIndices = [];
    for (let index = 0; index < messages.length; index++) {
        if (messageText(messages[index]).includes(historyMarker)) historyIndices.push(index);
    }
    // The OLDEST and NEWEST history turns by POSITION in the assembled list, not by marker text: the
    // scenario's turns are ordered, so "after the note" counts the ones below it.
    const historyAbove = historyIndices.filter(index => noteIndex >= 0 && index < noteIndex).length;
    const historyBelow = historyIndices.filter(index => index > noteIndex).length;
    const countAbove = (needle) => {
        const index = at(needle);
        return index >= 0 && noteIndex >= 0 && index < noteIndex;
    };
    return {
        messageCount: messages.length,
        noteIndex,
        noteRole: noteIndex >= 0 ? (messages[noteIndex]?.role ?? null) : null,
        noteTextHead: noteIndex >= 0 ? messageText(messages[noteIndex]).slice(0, 160) : null,
        noteMemberNames: noteIndex >= 0 ? Object.keys(messages[noteIndex] ?? {}).sort() : null,
        historyCount: historyIndices.length,
        historyAbove,
        historyBelow,
        historyIndices,
        // The neighbours, recorded so a reader can see what the note displaced or followed rather than
        // inferring it from an index.
        above: noteIndex > 0 ? { index: noteIndex - 1, role: messages[noteIndex - 1]?.role ?? null, textHead: messageText(messages[noteIndex - 1]).slice(0, 120) } : null,
        below: noteIndex >= 0 && noteIndex + 1 < messages.length ? { index: noteIndex + 1, role: messages[noteIndex + 1]?.role ?? null, textHead: messageText(messages[noteIndex + 1]).slice(0, 120) } : null,
        oldestHistoryIndex: historyIndices.length ? historyIndices[0] : -1,
        newestHistoryIndex: historyIndices.length ? historyIndices[historyIndices.length - 1] : -1,
        // THE COMPETITORS, each a boolean: is it ABOVE the note (earlier in the list) or below it?
        aboveNote: {
            worldBefore: countAbove(worldMarkers.before),
            worldAfter: countAbove(worldMarkers.after),
            worldDepth: countAbove(worldMarkers.depth),
            // The scenario's own chat turns carry markers too (the greeting is the example marker); they
            // are counted as a set so "the note sits between two chat turns" is a fact rather than a guess.
            chatTurns: chatMarkers.filter(marker => countAbove(marker)).length,
        },
        chatTurnsAbove: chatMarkers.filter(marker => countAbove(marker)).length,
        chatTurnsBelow: chatMarkers.filter(marker => !countAbove(marker) && at(marker) >= 0).length,
        // THE NOTE'S TEXT IS PRESENT OR IT IS NOT -- and this is deliberately NOT `noteIndex >= 0`.
        //
        // The measured data from Browser differential 40447689701 forced this distinction: the depth-20
        // ("deeper than history") case carried the note (`historyBelow = 12`, every declared turn below it)
        // but `noteIndex = -1`, because `injectIdx = Math.min(depth + totalInserted, messages.length)`
        // (openai.js:866-868) can place the note where `findMessage` cannot point at a SEPARATE message.
        // Meanwhile the DISABLED case must carry no note at all. With `carriesNoteMarker` defined as
        // "indexable", those two collapsed to the SAME observation -- an enabled case and a disabled case
        // reported identically, which is the one thing the disable switch must never do.
        //
        // So presence is measured over the WHOLE body, and "is it its own message" is kept separately.
        carriesNoteMarker: messages.some(message => messageText(message).includes(noteMarker)),
        hasItsOwnMessage: noteIndex >= 0,
        // A scenario that applied the preset's note instead of the overlay must be visible here rather than
        // folded into a position that happens to agree: the preset's marker present while the overlay's is
        // absent is exactly that state.
        carriesPresetNoteInsteadOfOverlay: !messages.some(message => messageText(message).includes(noteMarker))
            && findMessage(body, String(options?.presetNoteMarker ?? MARKERS.authorsNote)) >= 0,
        // WHERE THE NOTE'S TEXT SITS INSIDE ANOTHER MESSAGE, if it has no message of its own: the IN_PROMPT
        // position folds the note into the prompt block, so a presence-only check would find it there and
        // call it "deeper". Recorded so the comparator can refuse that reading.
        insideSomeOtherMessage: noteIndex < 0
            ? messages.findIndex(message => messageText(message).includes(noteMarker))
            : -1,
    };
}

export { here as presetKitDirectory };
