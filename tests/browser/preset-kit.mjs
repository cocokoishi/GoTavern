// The COMPLEX PRESET, as one executable scenario shared by the capture run and both drive legs.
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

// THE SPEC. One object, serialised into the page and into the fixture, so the capture and both legs
// cannot drift apart: there is exactly one description of the scenario in the repository.
export function presetSpec() {
    const history = [];
    // The OLDEST turn is the discriminator: it is the message the budget drops when the count grows
    // by a token, so its marker is what the boundary assertion looks for.
    history.push({ isUser: true, text: `${MARKERS.history} TURN_00 oldest ${padding('older', 900)}` });
    for (let turn = 1; turn <= 6; turn++) {
        const index = String(turn).padStart(2, '0');
        history.push({
            isUser: turn % 2 === 0,
            text: `${MARKERS.history} TURN_${index} ${padding(`turn-${index}`, 260)}`,
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
            // TWO books' worth of entries in one world: a char-position entry and a depth-0 entry, so
            // both the prompt-block path and the in-chat injection path are exercised, and their
            // ORDER is observable (a depth-0 injection lands after the newest chat message).
            name: 'GoTavern Probe Lore',
            entries: [
                {
                    uid: 0,
                    comment: 'after-character anchor',
                    key: ['glade'],
                    content: `${MARKERS.wiAfter} The glade answers to whoever speaks its name.`,
                    position: 'after',
                    depth: 4,
                    constant: true,
                    order: 100,
                },
                {
                    uid: 1,
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
    step('character', { index: Number(chid), name: script.characters[chid]?.name ?? null });

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

    // 4. World info. Created through world-info.js's own save path so the entry shape, uid handling and
    //    position constants are the frontend's, not ours. `createWorldInfoEntry(name, data)` assigns the
    //    uid from the world's existing entries and returns the LIVE entry object inside `data.entries`,
    //    which is why the fields are set on the returned object and the world is saved afterwards.
    const positions = worldInfo.world_info_position;
    const worldName = spec.world.name;
    if (typeof worldInfo.createNewWorldInfo === 'function') {
        await worldInfo.createNewWorldInfo(worldName, { interactive: false });
    }
    const worldData = worldInfo.world_info?.[worldName];
    if (!worldData || typeof worldData.entries !== 'object') {
        problems.push(`createNewWorldInfo("${worldName}") left no world to add entries to (worlds: ${JSON.stringify(Object.keys(worldInfo.world_info ?? {}))})`);
    } else {
        for (const entry of spec.world.entries) {
            const target = worldInfo.createWorldInfoEntry(worldName, worldData);
            if (!target) {
                problems.push(`world-info entry ${entry.uid} could not be created (createWorldInfoEntry returned nothing)`);
                continue;
            }
            target.comment = entry.comment;
            target.key = entry.key;
            target.keysecondary = [];
            target.content = entry.content;
            target.constant = entry.constant;
            target.selective = false;
            target.disable = false;
            target.position = entry.position === 'after' ? positions.after : positions.atDepth;
            target.depth = entry.depth;
            target.order = entry.order;
            target.probability = 100;
            target.useProbability = false;
            target.role = entry.position === 'after' ? null : 0;
        }
        // IMMEDIATE save: the default is a debounced write, and a capture that reads the world back
        // before the debounce fires would record an empty book.
        await worldInfo.saveWorldInfo(worldName, worldData, true);
    }
    const savedEntries = Object.keys(worldInfo.world_info?.[worldName]?.entries ?? {});
    if (savedEntries.length < spec.world.entries.length) {
        problems.push(`world "${worldName}" has ${savedEntries.length} entries after save, expected ${spec.world.entries.length}`);
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
    });

    // 5. Author's note. Written into chat metadata and pushed through the extension's own
    //    `setFloatingPrompt()`, which is the function the depth/position controls call.
    const keys = authorsNote.metadata_keys;
    script.chat_metadata[keys.prompt] = spec.authorsNote.text;
    script.chat_metadata[keys.depth] = spec.authorsNote.depth;
    script.chat_metadata[keys.position] = script.extension_prompt_types[spec.authorsNote.position];
    if (keys.role) {
        script.chat_metadata[keys.role] = 0;
    }
    if (typeof authorsNote.setFloatingPrompt === 'function') {
        authorsNote.setFloatingPrompt();
    } else {
        problems.push('authors-note.js does not export setFloatingPrompt');
    }
    const floating = script.extension_prompts?.[`2_floating_prompt`];
    if (!floating || !String(floating.value ?? '').includes(spec.markers.authorsNote)) {
        problems.push(`the author's note did not reach extension_prompts["2_floating_prompt"] (got ${JSON.stringify(floating?.value ?? null)})`);
    }
    step('authors note', {
        depth: script.chat_metadata[keys.depth],
        position: script.chat_metadata[keys.position],
        keys: { prompt: keys.prompt, depth: keys.depth, position: keys.position, role: keys.role ?? null },
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

export { here as presetKitDirectory };
