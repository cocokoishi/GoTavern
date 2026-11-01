// THE IN-IFRAME HALF OF THE HELPER SECOND-ORDER STATE LEG.
//
// This file is READ AS TEXT by helper-state-probe.mjs and installed through the helper's own
// 'replaceScriptTrees', so it executes inside the extension's unsandboxed script iframe with
// 'window.parent.TavernHelper' as its bridge -- i.e. every state mutation below travels
// iframe -> bridge -> host API -> host store -> disk -> next provider request. That is the closure the leg
// asserts; nothing here talks to the server directly, and no host module is imported.
//
// CONVENTIONS IMPOSED BY THE EMBEDDER (recorded because violating them is a silent harness break):
//   * no backticks and no 'script-close-tag' sequence -- the extension embeds this text in generated module source;
//   * one global: 'window.parent.__hse' carries the payload, 'window.parent.__hseDone' the result;
//   * every phase is tried in its own try/catch and a throw is RECORDED, never allowed to abort the phase
//     list (a throw that aborts mid-list is how an earlier leg assigned captures to the wrong case).
(async () => {
    const cfg = window.parent.__hse;
    const out = { runId: (cfg && cfg.runId) || null, phase: (cfg && cfg.phase) || null, cases: [], errors: [], closure: null, events: null };
    const record = (name, extra) => out.cases.push(Object.assign({ name }, extra));
    const done = () => { window.__hseDone = out; };
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    try {
        if (!cfg) { out.errors.push('no payload on window.parent.__hse'); return done(); }
        const H = window.TavernHelper || window.parent.TavernHelper;
        if (!H) { out.errors.push('TavernHelper bridge unavailable'); return done(); }
        const nonce = cfg.nonce;
        const values = {
            chat: cfg.markers.chat + nonce,
            global: cfg.markers.global + nonce,
            character: cfg.markers.character + nonce,
            preset: cfg.markers.preset + nonce,
            script: cfg.markers.script + nonce,
            message: cfg.markers.message + nonce,
        };
        const scriptId = () => (typeof getScriptId === 'function' ? getScriptId() : undefined);
        const readScopes = () => {
            const read = type => {
                try { return { ok: true, value: H.getVariables(type === 'script' ? { type: 'script', script_id: scriptId() } : { type }) }; }
                catch (error) { return { ok: false, error: String((error && error.message) || error) }; }
            };
            const scriptScopes = {};
            for (const type of cfg.scopes) scriptScopes[type] = read(type);
            return scriptScopes;
        };
        // BOUNDED READINESS FOR THE STORES A RELOAD/PAGE-SWITCH ASYNCHRONOUSLYRELOADS. A store that has not loaded yet
        // reads {} and would be recorded as "the scope did not persist"; the wait is on the PRODUCT'S OWN state
        // (any key is readable), bounded, and recorded so a timeout is visible rather than silently empty.
        const waitForScope = async (type, minKeys, limitMs) => {
            const startedAt = Date.now();
            let keys = 0;
            while (Date.now() - startedAt < limitMs) {
                try {
                    const value = H.getVariables(type === 'script' ? { type: 'script', script_id: scriptId() } : { type });
                    keys = value && typeof value === 'object' ? Object.keys(value).length : 0;
                    if (keys >= minKeys) return { ok: true, type, keys, waitedMs: Date.now() - startedAt };
                } catch (error) {
                    keys = -1;
                }
                await sleep(100);
            }
            return { ok: false, type, keys, waitedMs: Date.now() - startedAt };
        };        const injectScopes = async scopes => {
            const parts = [];
            for (const type of ['chat', 'global', 'character', 'preset']) {
                const read = scopes[type];
                const value = read && read.ok && read.value ? read.value : {};
                const picked = Object.keys(value).filter(key => key.indexOf('hs_') === 0).sort().map(key => key + '=' + JSON.stringify(value[key]));
                parts.push(cfg.markers.injected + type.toUpperCase() + '[' + type + ']=' + picked.join(';'));
            }
            await H.injectPrompts([{ id: 'hs-scope-injection', content: parts.join(' ') }]);
            return parts;
        };
        const generate = async (caseName, presetName) => {
            const before = performance.now();
            await H.generate({
                user_input: caseName,
                preset_name: presetName || cfg.presets.a,
                max_chat_history: 0,
                should_stream: false,
                should_silence: true,
                should_save: false,
            });
            return { case: caseName, ms: Math.round(performance.now() - before) };
        };

        out.closure = {
            insideIframe: window !== window.parent,
            parentHasBridge: !!(window.parent && window.parent.TavernHelper),
            bridgeFns: ['getVariables', 'insertOrAssignVariables', 'deleteVariable', 'generate', 'injectPrompts', 'getPreset', 'eventOn']
                .filter(name => typeof H[name] === 'function'),
            origin: 'script iframe installed by replaceScriptTrees (same path helper-probe.mjs uses)',
        };

        if (cfg.phase === 'write') {
            out.scopes = cfg.scopes;
            out.offControl = cfg.off === true;
            // THE IN-USE PRESET IS LOADED BEFORE THE WRITES, because the preset scope persists into THE PRESET IN
            // USE at write time; writing before the switch would land in whatever preset the fresh page loaded
            // and the generation below would read an empty projection.
            await H.loadPreset(cfg.presets.a);
            await sleep(250);
            // BOUNDED READINESS: a fresh page's stores load asynchronously after the chat/character open; reading
            // before they load records {} and would present a timing race as "the scope did not survive". The wait
            // is on the PRODUCT'S own readable state, bounded, and recorded so a timeout stays visible.
            out.waits = [await waitForScope('chat', 1, 6000), await waitForScope('character', 1, 6000), await waitForScope('preset', 1, 6000)];
            // THE WRITE MATRIX: one value per scope, plus object and list values on the chat scope, so the
            // persisted projection can be compared against the TYPE as well as the text. The 'off' variant runs
            // the SAME phase with the writes (and only the writes) removed -- the rule-50 control.
            const writes = cfg.off === true ? [] : [
                { name: 'chat-set', type: 'chat', values: { hs_chat: values.chat, hs_object: { nested: { n: 1, flag: true }, list: [1, 2, 3] }, hs_list: [1, 'two', { three: 3 }] } },
                { name: 'global-set', type: 'global', values: { hs_global: values.global } },
                { name: 'character-set', type: 'character', values: { hs_character: values.character } },
                { name: 'preset-set', type: 'preset', values: { hs_preset: values.preset } },
                { name: 'script-set', type: 'script', values: { hs_script: values.script } },
                { name: 'message-set', type: 'message', message_id: 'latest', values: { hs_message: values.message } },
            ];
            for (const write of writes) {
                try {
                    if (write.type === 'message') H.insertOrAssignVariables(write.values, { type: 'message', message_id: write.message_id });
                    else if (write.type === 'script') H.insertOrAssignVariables(write.values, { type: 'script', script_id: scriptId() });
                    else H.insertOrAssignVariables(write.values, { type: write.type });
                    record(write.name, { applied: true });
                } catch (error) {
                    record(write.name, { applied: false, refusedBy: String((error && error.message) || error) });
                }
            }
            // SIMULTANEOUS MUTATIONS: three read-modify-write increments issued without awaiting each other,
            // plus two concurrent inserts. A store that loses one of them is visible as counter != 3.
            if (cfg.off !== true) try {
                const increment = () => H.updateVariablesWith(old => Object.assign({}, old, { hs_counter: ((old && old.hs_counter) || 0) + 1 }), { type: 'chat' });
                increment(); increment(); increment();
                await Promise.all([
                    Promise.resolve().then(() => H.insertOrAssignVariables({ hs_parallel_a: 'A' }, { type: 'chat' })),
                    Promise.resolve().then(() => H.insertOrAssignVariables({ hs_parallel_b: 'B' }, { type: 'chat' })),
                ]);
                record('simultaneous', { applied: true });
            } catch (error) {
                record('simultaneous', { applied: false, refusedBy: String((error && error.message) || error) });
            }
            // DELETION: set then delete, and read back the DELETED form.
            if (cfg.off !== true) try {
                H.insertOrAssignVariables({ hs_delete_me: 'DELETE-ME' }, { type: 'chat' });
                H.deleteVariable('hs_delete_me', { type: 'chat' });
                record('delete', { applied: true });
            } catch (error) {
                record('delete', { applied: false, refusedBy: String((error && error.message) || error) });
            }
            await sleep(250);
            out.readback = readScopes();
            // THE HOST'S OWN VIEW OF THE SAME STORE, so a persistence miss is attributable: the iframe readback
            // proves the bridge call; this proves the object the host's save path would serialize carries the value.
            out.hostChatMetadataVariables = (() => { try { const context = window.parent.SillyTavern && window.parent.SillyTavern.getContext ? window.parent.SillyTavern.getContext() : null; return context && context.chatMetadata ? (context.chatMetadata.variables || null) : null; } catch (error) { return { error: String((error && error.message) || error) }; } })();
            out.injected = await injectScopes(out.readback);
            await H.loadPreset(cfg.presets.a);
            out.generated = await generate('hs-write', cfg.presets.a);
            out.presetAfter = (() => { try { return H.getPreset('in_use'); } catch (error) { return { error: String((error && error.message) || error) }; } })();
            return done();
        }

        if (cfg.phase === 'mutate') {
            await H.loadPreset(cfg.presets.a);
            out.baseline = await generate('hs-b0-baseline', cfg.presets.a);
            out.baselinePreset = (() => { try { const p = H.getPreset('in_use'); return { temperature: p.settings ? p.settings.temperature : p.temperature, promptCount: (p.prompts || []).length, contents: (p.prompts || []).map(x => x.content) }; } catch (error) { return { error: String((error && error.message) || error) }; } })();
            // MUTATION 1: append a prompt the baseline does not carry.
            await H.updatePresetWith(cfg.presets.a, old => {
                const prompts = (old.prompts || []).slice();
                prompts.push({ id: 'hs-mutated', identifier: 'hs-mutated', name: 'hs-mutated', position: 'relative', depth: 0, role: 'system', content: cfg.markers.mutation + nonce, enabled: true });
                return Object.assign({}, old, { prompts });
            });
            out.afterMutationPreset = (() => { try { const p = H.getPreset('in_use'); return { temperature: p.settings ? p.settings.temperature : p.temperature, promptCount: (p.prompts || []).length, contents: (p.prompts || []).map(x => x.content), containsMarker: (p.prompts || []).some(x => String(x.content || '').indexOf(cfg.markers.mutation) === 0) }; } catch (error) { return { error: String((error && error.message) || error) }; } })();
            out.mutated = await generate('hs-b1-mutated', cfg.presets.a);
            // MUTATION 2: change a sampler the request carries.
            await H.updatePresetWith(cfg.presets.a, old => {
                const settings = Object.assign({}, old.settings || old, { temperature: 0.42 });
                return Object.assign({}, old, { settings: settings, temperature: 0.42 });
            });
            out.samplerPreset = (() => { try { const p = H.getPreset('in_use'); return { temperature: p.settings ? p.settings.temperature : p.temperature }; } catch (error) { return { error: String((error && error.message) || error) }; } })();
            out.samplerChanged = await generate('hs-b2-sampler', cfg.presets.a);
            // MUTATION 3 (RESTORE): remove the marker prompt and restore the sampler -- the next request must
            // stop carrying both. This is the "restore, green re-observed" half of the mutation evidence.
            await H.updatePresetWith(cfg.presets.a, old => {
                const prompts = (old.prompts || []).filter(x => String(x.content || '').indexOf(cfg.markers.mutation) !== 0);
                const settings = Object.assign({}, old.settings || old, { temperature: 0.7 });
                return Object.assign({}, old, { prompts, settings, temperature: 0.7 });
            });
            out.restoredPreset = (() => { try { const p = H.getPreset('in_use'); return { temperature: p.settings ? p.settings.temperature : p.temperature, containsMarker: (p.prompts || []).some(x => String(x.content || '').indexOf(cfg.markers.mutation) === 0) }; } catch (error) { return { error: String((error && error.message) || error) }; } })();
            out.restored = await generate('hs-b3-restored', cfg.presets.a);
            return done();
        }

        if (cfg.phase === 'events') {
            const events = [];
            window.parent.__hseEvents = events;
            const state = () => {
                const chat = (window.parent.SillyTavern && window.parent.SillyTavern.getContext) ? window.parent.SillyTavern.getContext().chat || [] : [];
                const last = chat[chat.length - 1] || null;
                let presetName = null;
                try { presetName = H.getLoadedPresetName(); } catch (error) { presetName = null; }
                return { at: Date.now(), chatLength: chat.length, lastRole: last ? (last.is_user ? 'user' : last.is_system ? 'system' : 'assistant') : null, presetName: presetName };
            };
            // BOTH EVENT FAMILIES: the host names ('generation_started' ...) and the helper's iframe names
            // ('js_generation_started' ...). Which family emits for a SILENT helper generation is a pinned
            // observation the artefact records, not something the comparator may assume.
            const types = cfg.eventNames;
            for (const type of types) {
                try {
                    // eventOn IS A GLOBAL OF THE SCRIPT IFRAME (event.d.ts:42), not a TavernHelper member;
                    // the bridge fallback keeps a revision that moves it recorded rather than silently lost.
                    const subscribe = typeof eventOn === 'function' ? eventOn : (H && typeof H.eventOn === 'function' ? H.eventOn : null);
                    if (subscribe === null) throw new Error('no eventOn on the iframe global or the bridge at this revision');
                    subscribe(type, payload => events.push(Object.assign({ type: type, payloadKind: typeof payload }, state())));
                } catch (error) { events.push({ type: type, subscribeError: String((error && error.message) || error) }); }
            }
            out.subscribed = types;
            await H.loadPreset(cfg.presets.a);
            out.generated = await generate('hs-c1-event', cfg.presets.a);
            await H.loadPreset(cfg.presets.b);
            await H.loadPreset(cfg.presets.a);
            await sleep(600);
            out.eventsAtEnd = events.slice();
            out.eventTypes = Array.from(new Set(events.map(item => item.type)));
            return done();
        }

        // READ PHASE: the same reads, plus one generation carrying the injected scope clauses. Used after a
        // reload, after a restart, and after each switch -- always from a NEW script iframe, so "readable after"
        // is a property of the persisted tree, not of the iframe that wrote it. 'cfg.presetName' selects the
        // preset to load BEFORE the read, which is how the preset-SWITCH semantics are observed.
        if (cfg.phase === 'read') {
            const presetToLoad = cfg.presetName || cfg.presets.a;
            await H.loadPreset(presetToLoad);
            await sleep(250);
            out.waits = [await waitForScope('chat', 1, 6000), await waitForScope('character', 1, 6000), await waitForScope('preset', 1, 6000)];
            out.loadedPreset = presetToLoad;
            out.readback = readScopes();
            out.injected = await injectScopes(out.readback);
            out.generated = await generate(cfg.caseName || 'hs-read', presetToLoad);
            return done();
        }

        out.errors.push('unknown phase ' + cfg.phase);
        return done();
    } catch (error) {
        out.errors.push(String((error && error.stack) || error).slice(0, 1200));
        return done();
    }
})();
